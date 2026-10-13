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
  for (const key of ['APP_PASSWORD', 'SESSION_SECRET']) {
    for (const val of [undefined, '', 'p'.repeat(31)]) {
      const env = Object.assign({}, ENV, { [key]: val });
      const r = await parse(await login(ENV.APP_PASSWORD, { env }));
      assert.equal(r.ok, false);
      assert.equal(r.code, 'server_error', key + '=' + String(val));
    }
  }
  const noOrigin = await parse(await login(ENV.APP_PASSWORD, { env: Object.assign({}, ENV, { ALLOWED_ORIGIN: undefined }) }));
  assert.equal(noOrigin.code, 'server_error');
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
