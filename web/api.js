/* 連線層：唯一呼叫伺服器的地方。設定、逾時、錯誤對應都在這裡。
 * 所有依賴由 createClient 注入，方便測試。語法限 ES2019 以內。 */
var HotNewsApi = (function () {
  var API_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
  var KEYS = { url: 'hotnews.v1.url', token: 'hotnews.v1.token', remember: 'hotnews.v1.remember' };
  var MESSAGES = {
    unreachable: '讀不到伺服器的回應。',
    timeout: '伺服器沒有在時間內回應。',
    no_config: '尚未設定。',
    bad_request: '網址格式不符。',
    unauthorized: '密碼不正確或尚未設定。',
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
    var memToken = null, memUrl = null;

    function read(key) { try { return storage.getItem(key); } catch (e) { return null; } }
    function write(key, value) { try { storage.setItem(key, value); } catch (e) { /* 只在記憶體 */ } }
    function remove(key) { try { storage.removeItem(key); } catch (e) { /* ignore */ } }
    function clean(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

    function getConfig() {
      var remember = read(KEYS.remember) === '1';
      var token = memToken !== null ? memToken : (remember ? read(KEYS.token) : null);
      return { url: memUrl || read(KEYS.url) || null, token: token || null, remember: remember };
    }

    function checkUrl(url) {
      if (!API_URL_PATTERN.test(url)) throw new ApiError('bad_request', '網址要是 https://script.google.com/macros/s/…/exec 的格式。');
    }

    function saveConfig(cfg) {
      var url = clean(cfg.url), token = clean(cfg.token);
      checkUrl(url);
      write(KEYS.url, url);
      memUrl = url;
      memToken = token;
      if (cfg.remember) { write(KEYS.token, token); write(KEYS.remember, '1'); }
      else { remove(KEYS.token); remove(KEYS.remember); }
    }

    function clearToken() { memToken = null; remove(KEYS.token); }
    function clearConfig() { memToken = null; memUrl = null; remove(KEYS.url); remove(KEYS.token); remove(KEYS.remember); }

    function request(url, token, action, args) {
      var ms = action === 'fetchTitle' ? 20000 : 30000;
      var ctl = new deps.AbortController();
      var timer;
      var timeout = new Promise(function (_, reject) {
        timer = deps.setTimeout(function () {
          try { ctl.abort(); } catch (e) { /* ignore */ }
          reject(new ApiError('timeout'));
        }, ms);
      });
      var work = Promise.resolve().then(function () {
        return fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ token: token, action: action, args: args || {} }),
          credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal: ctl.signal
        });
      }).then(function (res) { return res.text(); }).then(function (text) {
        var body;
        try { body = JSON.parse(text); } catch (e) { throw new ApiError('unreachable'); }
        if (!body || typeof body.ok !== 'boolean') throw new ApiError('unreachable');
        if (body.ok) return body.data;
        throw new ApiError(body.code || 'server_error', body.error, body);
      }).catch(function (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError('unreachable');
      });
      return Promise.race([work, timeout]).then(function (v) { deps.clearTimeout(timer); return v; },
        function (e) { deps.clearTimeout(timer); throw e; });
    }

    function call(action, args) {
      var cfg = getConfig();
      if (!cfg.url || !cfg.token) return Promise.reject(new ApiError('no_config'));
      return request(cfg.url, cfg.token, action, args).catch(function (e) {
        if (e.code === 'unauthorized') clearToken();
        throw e;
      });
    }

    // 只送一次 ping 驗證網址與密碼；不寫入也不清除任何已儲存設定
    function checkConnection(url, token) {
      try { var u = clean(url); checkUrl(u); } catch (e) { return Promise.reject(e); }
      return request(u, clean(token), 'ping', {}).then(function () { return undefined; });
    }

    return { getConfig: getConfig, saveConfig: saveConfig, clearToken: clearToken, clearConfig: clearConfig,
      call: call, checkConnection: checkConnection };
  }

  return { API_URL_PATTERN: API_URL_PATTERN, ApiError: ApiError, createClient: createClient };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = HotNewsApi; }
