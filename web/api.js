/* 連線層：唯一呼叫伺服器（Cloudflare Worker）的地方。登入、憑證、逾時、錯誤對應都在這裡。
 * 所有依賴由 createClient 注入，方便測試。語法限 ES2019 以內。 */
var HotNewsApi = (function () {
  var API_URL_PATTERN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/;
  var KEYS = { url: 'hotnews.v1.url', session: 'hotnews.v1.session', remember: 'hotnews.v1.remember' };
  var LEGACY_TOKEN_KEY = 'hotnews.v1.token';   // 舊版存的是密碼本身，一律清掉
  var SKEW_SEC = 30;                           // 憑證剩不到 30 秒就視為過期
  var MESSAGES = {
    unreachable: '讀不到伺服器的回應。',
    timeout: '伺服器沒有在時間內回應。',
    no_config: '尚未設定。',
    bad_request: '網址要是 https://〈名稱〉.workers.dev 的格式。',
    unauthorized: '密碼不正確或登入已過期。',
    rate_limited: '登入太頻繁，請稍後再試。',
    server_error: '伺服器發生錯誤，請稍後再試。'
  };

  class ApiError extends Error {
    constructor(code, message, extra) {
      super(message || MESSAGES[code] || MESSAGES.server_error);
      this.name = 'ApiError';
      this.code = code;
      this.existing = extra && extra.existing;
      // 連線中斷／逾時／讀不到回應：不知道伺服器有沒有執行
      this.unknown = code === 'unreachable' || code === 'timeout';
    }
  }

  function createClient(deps) {
    var fetchFn = deps.fetch, storage = deps.storage;
    var nowMs = deps.now || function () { return Date.now(); };
    var memSession = null, memUrl = null;   // memSession: { s, exp }

    function read(key) { try { return storage.getItem(key); } catch (e) { return null; } }
    function write(key, value) { try { storage.setItem(key, value); } catch (e) { /* 只在記憶體 */ } }
    function remove(key) { try { storage.removeItem(key); } catch (e) { /* ignore */ } }
    function clean(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
    function normalizeUrl(url) { return clean(url).replace(/\/+$/, ''); }
    function checkUrl(url) { if (!API_URL_PATTERN.test(url)) throw new ApiError('bad_request'); }

    remove(LEGACY_TOKEN_KEY);

    function alive(sess) {
      return !!sess && typeof sess.s === 'string' && sess.s !== '' && typeof sess.exp === 'number' && sess.exp - SKEW_SEC > nowMs() / 1000;
    }
    function storedSession() {
      var raw = read(KEYS.session), v = null;
      if (raw === null) return null;
      try { v = JSON.parse(raw); } catch (e) { v = null; }
      return v;
    }
    function currentSession(remember) {
      if (memSession && !alive(memSession)) memSession = null;
      if (memSession) return memSession;
      if (!remember) return null;
      var v = storedSession();
      if (alive(v)) return v;
      remove(KEYS.session);
      return null;
    }

    function getConfig() {
      var remember = read(KEYS.remember) === '1';
      var url = memUrl;
      if (!url) {
        var stored = read(KEYS.url);
        if (stored && API_URL_PATTERN.test(stored)) url = stored;
        else if (stored) remove(KEYS.url);
      }
      var sess = currentSession(remember);
      return { url: url || null, session: sess ? sess.s : null, remember: remember };
    }

    function logout() { memSession = null; remove(KEYS.session); }
    function clearConfig() {
      memSession = null; memUrl = null;
      remove(KEYS.url); remove(KEYS.session); remove(KEYS.remember); remove(LEGACY_TOKEN_KEY);
    }

    function request(base, path, body, ms) {
      var ctl = new deps.AbortController();
      var timer;
      var timeout = new Promise(function (_, reject) {
        timer = deps.setTimeout(function () {
          try { ctl.abort(); } catch (e) { /* ignore */ }
          reject(new ApiError('timeout'));
        }, ms);
      });
      var work = Promise.resolve().then(function () {
        return fetchFn(base + path, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body),
          credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal: ctl.signal
        });
      }).then(function (res) { return res.text(); }).then(function (text) {
        var parsed;
        try { parsed = JSON.parse(text); } catch (e) { throw new ApiError('unreachable'); }
        if (!parsed || typeof parsed.ok !== 'boolean') throw new ApiError('unreachable');
        if (parsed.ok) return parsed.data;
        throw new ApiError(parsed.code || 'server_error', parsed.error, parsed);
      }).catch(function (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError('unreachable');
      });
      return Promise.race([work, timeout]).then(function (v) { deps.clearTimeout(timer); return v; },
        function (e) { deps.clearTimeout(timer); throw e; });
    }

    // 登入成功才寫入網址與憑證；失敗不動任何已儲存的設定
    function login(url, password, remember) {
      var base;
      try { base = normalizeUrl(url); checkUrl(base); } catch (e) { return Promise.reject(e); }
      return request(base, '/login', { password: clean(password) }, 30000).then(function (data) {
        if (!data || typeof data.session !== 'string' || typeof data.exp !== 'number') throw new ApiError('server_error');
        // 有 ttl 就以本機時鐘 + ttl 當到期時間，不拿伺服器的絕對時間跟本機時鐘比（本機時鐘不準會一登入就過期）
        memSession = { s: data.session, exp: typeof data.ttl === 'number' && data.ttl > 0 ? nowMs() / 1000 + data.ttl : data.exp };
        memUrl = base;
        write(KEYS.url, base);
        if (remember) { write(KEYS.session, JSON.stringify(memSession)); write(KEYS.remember, '1'); }
        else { remove(KEYS.session); remove(KEYS.remember); }
      });
    }

    function call(action, args) {
      var cfg = getConfig();
      if (!cfg.url) return Promise.reject(new ApiError('no_config'));
      if (!cfg.session) return Promise.reject(new ApiError('unauthorized'));
      var ms = action === 'fetchTitle' ? 20000 : 30000;
      return request(cfg.url, '/api', { session: cfg.session, action: action, args: args || {} }, ms).catch(function (e) {
        if (e.code === 'unauthorized') logout();
        throw e;
      });
    }

    return { getConfig: getConfig, login: login, call: call, logout: logout, clearConfig: clearConfig };
  }

  return { API_URL_PATTERN: API_URL_PATTERN, ApiError: ApiError, createClient: createClient };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = HotNewsApi; }
