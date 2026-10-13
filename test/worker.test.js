const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGIN = 'https://unnn3ing-oss.github.io';
const ENV = {
  APP_PASSWORD: 'p'.repeat(40), SESSION_SECRET: 's'.repeat(40), API_TOKEN: 'k'.repeat(40),
  APPS_SCRIPT_URL: 'https://upstream.test/exec', ALLOWED_ORIGIN: ORIGIN, FAIL_DELAY_MS: '0'
};
const SECRETS = [ENV.APP_PASSWORD, ENV.SESSION_SECRET, ENV.API_TOKEN];
let mod;
const load = async () => (mod = mod || await import('../worker/index.js'));

async function call(path, body, opts = {}) {
  const { default: worker } = await load();
  const init = { method: opts.method || 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' } };
  if (opts.origin !== null) init.headers.origin = opts.origin || ORIGIN;
  Object.assign(init.headers, opts.headers || {});
  if (init.method !== 'GET' && init.method !== 'OPTIONS') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request('https://w.test' + path, init), opts.env || ENV);
}
const text = (res) => res.text();
const parse = async (res) => JSON.parse(await res.text());
const login = (password, opts) => call('/login', { password }, opts);

test('login 成功：回 session 與約 12 小時後的 exp', async () => {
  const { verifySession } = await load();
  const res = await login(ENV.APP_PASSWORD);
  assert.equal(res.status, 200);
  const body = await parse(res);
  assert.equal(body.ok, true);
  assert.equal(body.data.ttl, 43200);   // 讓用戶端不必依賴自己的時鐘去比 exp
  const now = Math.floor(Date.now() / 1000);
  assert.ok(body.data.exp - now >= 43199 && body.data.exp - now <= 43201, String(body.data.exp - now));
  assert.equal(await verifySession(ENV.SESSION_SECRET, body.data.session, now), true);
});

test('login 密碼錯誤 → unauthorized；缺欄位／非字串／非 JSON／非物件 → bad_request', async () => {
  const code = async (b) => { const r = await call('/login', b); assert.equal(r.status, 200); return (await parse(r)).code; };
  assert.equal(await code({ password: 'wrong' }), 'unauthorized');
  assert.equal(await code({ password: '' }), 'unauthorized');
  assert.equal(await code({}), 'bad_request');
  assert.equal(await code({ password: 123 }), 'bad_request');
  assert.equal(await code('not json'), 'bad_request');
  assert.equal(await code('[1]'), 'bad_request');
  assert.equal(await code('null'), 'bad_request');
});

test('login 非 ASCII 與 10000 字元密碼不丟例外', async () => {
  for (const pw of ['密碼🔒', 'x'.repeat(10000)]) {
    const r = await parse(await login(pw));
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'unauthorized' });
  }
});

test('verifySession：有效、邊界、竄改與壞格式', async () => {
  const { signSession, verifySession } = await load();
  const S = ENV.SESSION_SECRET, now = 1_000_000;
  const good = await signSession(S, now + 100);
  assert.equal(await verifySession(S, good, now), true);
  assert.equal(await verifySession(S, await signSession(S, now), now), false);   // exp == now 視為過期
  assert.equal(await verifySession(S, await signSession(S, now - 1), now), false);
  assert.equal(await verifySession('z'.repeat(40), good, now), false);
  const [p, sig] = good.split('.');
  const forged = btoa(JSON.stringify({ exp: now + 999999 })).replace(/=+$/, '');
  assert.equal(await verifySession(S, forged + '.' + sig, now), false);
  assert.equal(await verifySession(S, p + '.' + sig.slice(0, -2) + 'AA', now), false);
  for (const bad of ['nodot', good + '.x', '', undefined, null, 5, {}, '.', 'a.b']) assert.equal(await verifySession(S, bad, now), false);
});

test('CORS：允許的 Origin 有標頭，其他沒有；OPTIONS 回 204', async () => {
  const ok = await login(ENV.APP_PASSWORD);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(ok.headers.get('vary'), /Origin/);
  assert.equal((await login(ENV.APP_PASSWORD, { origin: 'https://evil.test' })).headers.get('access-control-allow-origin'), null);
  assert.equal((await login(ENV.APP_PASSWORD, { origin: null })).headers.get('access-control-allow-origin'), null);
  const pre = await call('/login', '', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(pre.headers.get('access-control-allow-headers'), 'Content-Type');
  const badPre = await call('/login', '', { method: 'OPTIONS', origin: 'https://evil.test' });
  assert.equal(badPre.status, 204);
  assert.equal(badPre.headers.get('access-control-allow-origin'), null);
});

test('Secret 缺少或過短 → server_error，絕不放行', async () => {
  const bad = [['APP_PASSWORD', undefined], ['APP_PASSWORD', ''], ['APP_PASSWORD', 'p'.repeat(7)],
    ['SESSION_SECRET', 's'.repeat(31)], ['API_TOKEN', undefined], ['API_TOKEN', 'k'.repeat(31)]];
  for (const [key, val] of bad) {
    const env = Object.assign({}, ENV, { [key]: val });
    if (key === 'API_TOKEN') delete env.SESSION_SECRET;   // 簽章金鑰會退回 API_TOKEN，兩者都壞才該擋
    const r = await parse(await login(ENV.APP_PASSWORD, { env }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'server_error', key + '=' + String(val));
  }
});

test('沒設 SESSION_SECRET 與 ALLOWED_ORIGIN 也能運作（簽章用 API_TOKEN，Origin 用預設）', async () => {
  const { verifySession } = await load();
  const env = { APP_PASSWORD: ENV.APP_PASSWORD, API_TOKEN: ENV.API_TOKEN, APPS_SCRIPT_URL: ENV.APPS_SCRIPT_URL, FAIL_DELAY_MS: '0' };
  const res = await login(ENV.APP_PASSWORD, { env });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const body = await parse(res);
  assert.equal(body.ok, true);
  assert.equal(await verifySession(ENV.API_TOKEN, body.data.session, Math.floor(Date.now() / 1000)), true);
  assert.equal((await login(ENV.APP_PASSWORD, { env, origin: 'https://evil.test' })).headers.get('access-control-allow-origin'), null);
});

test('APP_PASSWORD 剛好 8 字元可以登入；SESSION_SECRET 仍要 32', async () => {
  const env = Object.assign({}, ENV, { APP_PASSWORD: 'abcd1234' });
  assert.equal((await parse(await login('abcd1234', { env }))).ok, true);
  assert.equal((await parse(await login('abcd123', { env }))).code, 'unauthorized');
});

test('body 超過 64KB、未知路徑、GET → bad_request', async () => {
  assert.equal((await parse(await call('/login', JSON.stringify({ password: 'x'.repeat(70000) })))).code, 'bad_request');
  assert.equal((await parse(await call('/nope', {}))).code, 'bad_request');
  assert.equal((await parse(await call('/login', '', { method: 'GET' }))).code, 'bad_request');
});

test('失敗登入延遲 FAIL_DELAY_MS，成功不延遲', async () => {
  const env = Object.assign({}, ENV, { FAIL_DELAY_MS: '40' });
  let t = Date.now();
  await login('wrong', { env });
  assert.ok(Date.now() - t >= 35, 'fail delay');
  t = Date.now();
  await login(ENV.APP_PASSWORD, { env });
  assert.ok(Date.now() - t < 35, 'success no delay');
});

test('LOGIN_LIMITER 回 success:false → rate_limited，key 為 cf-connecting-ip', async () => {
  const keys = [];
  const mk = (success) => Object.assign({}, ENV, { LOGIN_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success }; } } });
  const blocked = await parse(await login(ENV.APP_PASSWORD, { env: mk(false), headers: { 'cf-connecting-ip': '203.0.113.9' } }));
  assert.deepEqual({ ok: blocked.ok, code: blocked.code }, { ok: false, code: 'rate_limited' });
  assert.equal(keys[0], '203.0.113.9');
  assert.equal((await parse(await login(ENV.APP_PASSWORD, { env: mk(true) }))).ok, true);
  assert.equal(keys[1], 'unknown');
});

test('/login 回應文字不含任何 Secret 值', async () => {
  for (const pw of [ENV.APP_PASSWORD, 'wrong']) {
    const body = await text(await login(pw));
    // 成功時 session 是簽章，不應含明文 Secret
    for (const s of SECRETS) assert.equal(body.includes(s), false);
  }
});

/* ---------- /api ---------- */
function upstream(t, impl) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}
const reply200 = (s) => new Response(s, { status: 200 });
async function goodSession() {
  const { signSession } = await load();
  return signSession(ENV.SESSION_SECRET, Math.floor(Date.now() / 1000) + 600);
}
const api = async (body, opts) => call('/api', Object.assign({ session: await goodSession() }, body), opts);

test('/api 轉送內容：上游收到 {token:API_TOKEN, action, args}，不含 session，忽略用戶端的 token', async (t) => {
  const calls = upstream(t, () => reply200('{"ok":true,"data":{"pong":true}}'));
  const res = await api({ action: 'ping', args: { a: 1 }, token: 'attacker' });
  assert.equal(await text(res), '{"ok":true,"data":{"pong":true}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENV.APPS_SCRIPT_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.equal(calls[0].init.redirect, 'follow');
  assert.deepEqual(JSON.parse(calls[0].init.body), { token: ENV.API_TOKEN, action: 'ping', args: { a: 1 } });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('/api session 缺少／非字串／過期／竄改／多餘點號 → unauthorized，且不呼叫上游', async (t) => {
  const calls = upstream(t, () => reply200('{"ok":true,"data":1}'));
  const { signSession } = await load();
  const expired = await signSession(ENV.SESSION_SECRET, Math.floor(Date.now() / 1000) - 1);
  const good = await goodSession();
  for (const session of [undefined, null, 5, {}, '', 'a.b', expired, good + 'x', good + '.extra', good.split('.')[0] + '.AAAA']) {
    const r = await parse(await call('/api', { session, action: 'ping' }));
    assert.deepEqual({ ok: r.ok, code: r.code }, { ok: false, code: 'unauthorized' }, String(session));
  }
  assert.equal(calls.length, 0);
});

test('/api action 缺少或非字串、args 非物件 → bad_request；args 省略 → {}', async (t) => {
  const calls = upstream(t, () => reply200('{"ok":true,"data":1}'));
  for (const b of [{}, { action: 5 }, { action: 'ping', args: 'x' }, { action: 'ping', args: [1] }, { action: 'ping', args: null }]) {
    assert.equal((await parse(await api(b))).code, 'bad_request', JSON.stringify(b));
  }
  assert.equal(calls.length, 0);
  await api({ action: 'ping' });
  assert.deepEqual(JSON.parse(calls[0].init.body).args, {});
});

test('/api 上游 ok:false 原樣轉回（含 existing）', async (t) => {
  const raw = '{"ok":false,"code":"duplicate","error":"已存在","existing":{"id":"1"}}';
  upstream(t, () => reply200(raw));
  assert.equal(await text(await api({ action: 'addItem', args: {} })), raw);
});

test('/api 上游回 unauthorized → server_error「Worker 與後端的密碼設定不一致。」', async (t) => {
  upstream(t, () => reply200('{"ok":false,"code":"unauthorized","error":"x"}'));
  const r = await parse(await api({ action: 'ping' }));
  assert.deepEqual(r, { ok: false, code: 'server_error', error: 'Worker 與後端的密碼設定不一致。' });
});

test('/api 上游回 HTML、空字串、缺 ok、連線失敗、逾時 → server_error，不洩漏上游內容', async (t) => {
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  const cases = [
    [() => reply200('<html>Sign in to Google SECRETPAGE</html>'), '後端沒有回傳正確的資料。'],
    [() => reply200(''), '後端沒有回傳正確的資料。'],
    [() => reply200('{"nope":1}'), '後端沒有回傳正確的資料。'],
    [() => { throw new TypeError('fetch failed https://upstream.test/exec'); }, '連不上後端。'],
    [() => { throw timeout; }, '後端沒有在時間內回應。']
  ];
  for (const [impl, error] of cases) {
    const real = globalThis.fetch;
    globalThis.fetch = async () => impl();
    try {
      const body = await text(await api({ action: 'ping' }));
      assert.deepEqual(JSON.parse(body), { ok: false, code: 'server_error', error });
      assert.equal(body.includes('SECRETPAGE') || body.includes('upstream.test'), false);
    } finally { globalThis.fetch = real; }
  }
});

test('/api API_TOKEN 或 APPS_SCRIPT_URL 缺少或過短 → server_error，不呼叫上游', async (t) => {
  const calls = upstream(t, () => reply200('{"ok":true,"data":1}'));
  for (const [key, val] of [['API_TOKEN', undefined], ['API_TOKEN', 'k'.repeat(31)], ['APPS_SCRIPT_URL', undefined], ['APPS_SCRIPT_URL', '']]) {
    const env = Object.assign({}, ENV, { [key]: val });
    assert.equal((await parse(await api({ action: 'ping' }, { env }))).code, 'server_error', key);
  }
  assert.equal(calls.length, 0);
});

test('/api 回應不含 Secret 值；Origin 不符時無 allow-origin', async (t) => {
  upstream(t, () => reply200('{"ok":true,"data":{"x":1}}'));
  const res = await api({ action: 'ping' }, { origin: 'https://evil.test' });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const body = await text(res);
  for (const s of SECRETS) assert.equal(body.includes(s), false);
});
