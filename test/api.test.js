const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const api = createRequire(__filename)('../web/api.js');

const URL_OK = 'https://hotnews.test-account.workers.dev';
const PASSWORD = 'p'.repeat(48);
const NOW = 1_800_000_000_000;   // ms
const SEC = NOW / 1000;
const SESSION = 'payload.signature';

function memStorage(throwing) {
  const m = new Map();
  const guard = () => { if (throwing) throw new Error('blocked'); };
  return { m, getItem: (k) => { guard(); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { guard(); m.set(k, String(v)); }, removeItem: (k) => { guard(); m.delete(k); } };
}
function setup(respond, opts = {}) {
  const calls = [], timers = [];
  const storage = opts.storage || memStorage();
  const clock = { ms: NOW };
  const fetch = (url, init) => { calls.push({ url, init }); return respond(url, init); };
  const aborts = [];
  class AC { constructor() { this.signal = {}; aborts.push(this); } abort() { this.aborted = true; } }
  const client = api.createClient({ fetch, storage, AbortController: AC, now: () => clock.ms,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} });
  return { client, calls, timers, storage, aborts, clock };
}
const json = (o) => Promise.resolve({ text: () => Promise.resolve(JSON.stringify(o)) });
const loginOk = (exp) => json({ ok: true, data: { session: SESSION, exp: exp === undefined ? SEC + 43200 : exp } });
const router = (login, apiRes) => (url) => (url.endsWith('/login') ? login : apiRes);

test('login：POST {url}/login，body 只有 {password}，標頭只有 text/plain，credentials omit、no-referrer、follow', async () => {
  const s = setup(() => loginOk());
  await s.client.login(' ' + URL_OK + '/\n', '  ' + PASSWORD + '\n', false);
  const { url, init } = s.calls[0];
  assert.equal(url, URL_OK + '/login');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.deepEqual(JSON.parse(init.body), { password: PASSWORD });
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.redirect, 'follow');
  assert.ok(init.signal);
  assert.deepEqual(s.client.getConfig(), { url: URL_OK, session: SESSION, remember: false });
});

test('call：POST {url}/api，body 為 {session, action, args}，不含 token／password', async () => {
  const s = setup(router(loginOk(), json({ ok: true, data: { pong: true } })));
  await s.client.login(URL_OK, PASSWORD, false);
  assert.deepEqual(await s.client.call('ping'), { pong: true });
  const { url, init } = s.calls[1];
  assert.equal(url, URL_OK + '/api');
  assert.deepEqual(JSON.parse(init.body), { session: SESSION, action: 'ping', args: {} });
  assert.equal(init.body.includes(PASSWORD), false);
});

test('login 失敗不寫入任何儲存，也不覆蓋先前的設定', async () => {
  const s = setup(router(loginOk(), null));
  await s.client.login(URL_OK, PASSWORD, true);
  const before = JSON.stringify([...s.storage.m]);
  for (const code of ['unauthorized', 'rate_limited', 'server_error']) {
    const bad = setup(() => json({ ok: false, code, error: 'x' }), { storage: s.storage });
    await assert.rejects(bad.client.login('https://other.test-account.workers.dev', 'nope', true), { code });
  }
  assert.equal(JSON.stringify([...s.storage.m]), before);
});

test('記住：remember 才寫 session 與 remember 鍵；儲存內容不含密碼；取消記住會移除', async () => {
  const s = setup(() => loginOk());
  await s.client.login(URL_OK, PASSWORD, false);
  assert.equal(s.storage.m.has('hotnews.v1.session'), false);
  assert.equal(s.storage.m.get('hotnews.v1.url'), URL_OK);
  await s.client.login(URL_OK, PASSWORD, true);
  assert.deepEqual(JSON.parse(s.storage.m.get('hotnews.v1.session')), { s: SESSION, exp: SEC + 43200 });
  assert.equal(s.storage.m.get('hotnews.v1.remember'), '1');
  assert.equal([...s.storage.m.values()].some((v) => v.includes(PASSWORD)), false);
  await s.client.login(URL_OK, PASSWORD, false);
  assert.equal(s.storage.m.has('hotnews.v1.session'), false);
  assert.equal(s.storage.m.has('hotnews.v1.remember'), false);
});

test('記住的憑證可在新的 client 載入使用', async () => {
  const first = setup(() => loginOk());
  await first.client.login(URL_OK, PASSWORD, true);
  const second = setup(() => json({ ok: true, data: 1 }), { storage: first.storage });
  assert.deepEqual(second.client.getConfig(), { url: URL_OK, session: SESSION, remember: true });
  assert.equal(await second.client.call('ping'), 1);
});

test('本機過期：exp 距現在不足 30 秒 → call 不送請求、拒絕 unauthorized 並清掉憑證', async () => {
  for (const exp of [SEC + 29, SEC + 30, SEC - 5]) {   // 恰等於 +30 也算過期
    const s = setup(router(loginOk(exp), json({ ok: true, data: 1 })));
    await s.client.login(URL_OK, PASSWORD, true);
    await assert.rejects(s.client.call('ping'), { code: 'unauthorized' });
    assert.equal(s.calls.length, 1);   // 只有 login
    assert.equal(s.storage.m.has('hotnews.v1.session'), false);
    assert.equal(s.client.getConfig().session, null);
    assert.equal(s.client.getConfig().url, URL_OK);
  }
  const live = setup(router(loginOk(SEC + 31), json({ ok: true, data: 1 })));
  await live.client.login(URL_OK, PASSWORD, false);
  assert.equal(await live.client.call('ping'), 1);
});

test('時間流逝：登入後 12 小時再呼叫 → unauthorized，不送請求', async () => {
  const s = setup(router(loginOk(), json({ ok: true, data: 1 })));
  await s.client.login(URL_OK, PASSWORD, false);
  s.clock.ms += 43200 * 1000;
  await assert.rejects(s.client.call('ping'), { code: 'unauthorized' });
  assert.equal(s.calls.length, 1);
});

test('時鐘偏差：本機時鐘比伺服器快很多時，仍依 ttl 判斷（不依賴伺服器的 exp 絕對時間）', async () => {
  // 伺服器發的 exp 以本機時鐘看已經過去 13 小時，但 ttl 說還有 12 小時
  const s = setup(router(json({ ok: true, data: { session: SESSION, exp: SEC - 13 * 3600, ttl: 43200 } }), json({ ok: true, data: 1 })));
  await s.client.login(URL_OK, PASSWORD, true);
  assert.equal(s.client.getConfig().session, SESSION);
  assert.equal(await s.client.call('ping'), 1);
  assert.equal(JSON.parse(s.storage.m.get('hotnews.v1.session')).exp, SEC + 43200);   // 存的是本機時鐘的到期時間
  s.clock.ms += 43200 * 1000;
  await assert.rejects(s.client.call('ping'), { code: 'unauthorized' });                // 仍會在 12 小時後到期
});

test('載入時儲存的憑證已過期 → session 為 null 且該鍵被移除', () => {
  const storage = memStorage();
  storage.m.set('hotnews.v1.url', URL_OK);
  storage.m.set('hotnews.v1.remember', '1');
  storage.m.set('hotnews.v1.session', JSON.stringify({ s: SESSION, exp: SEC - 1 }));
  const s = setup(() => json({}), { storage });
  assert.deepEqual(s.client.getConfig(), { url: URL_OK, session: null, remember: true });
  assert.equal(storage.m.has('hotnews.v1.session'), false);
  storage.m.set('hotnews.v1.session', 'not json');
  assert.equal(s.client.getConfig().session, null);
  assert.equal(storage.m.has('hotnews.v1.session'), false);
});

test('舊版殘留：建立 client 時移除 hotnews.v1.token；舊的 script.google.com 網址視為未設定', () => {
  const storage = memStorage();
  storage.m.set('hotnews.v1.token', PASSWORD);
  storage.m.set('hotnews.v1.url', 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec');
  const s = setup(() => json({}), { storage });
  assert.equal(storage.m.has('hotnews.v1.token'), false);
  assert.equal(s.client.getConfig().url, null);
});

test('unauthorized 回應清除憑證，但保留網址', async () => {
  const s = setup(router(loginOk(), json({ ok: false, code: 'unauthorized', error: 'x' })));
  await s.client.login(URL_OK, PASSWORD, true);
  await assert.rejects(s.client.call('listItems'), { code: 'unauthorized' });
  assert.equal(s.storage.m.has('hotnews.v1.session'), false);
  assert.deepEqual(s.client.getConfig(), { url: URL_OK, session: null, remember: true });
});

test('沒登入：缺網址 → no_config 不送請求；有網址沒憑證 → unauthorized', async () => {
  const s = setup(router(loginOk(), json({ ok: true, data: 1 })));
  await assert.rejects(s.client.call('ping'), { code: 'no_config' });
  assert.equal(s.calls.length, 0);
  await s.client.login(URL_OK, PASSWORD, false);
  s.client.logout();
  s.calls.length = 0;
  await assert.rejects(s.client.call('ping'), { code: 'unauthorized' });
  assert.equal(s.calls.length, 0);
});

test('網址格式：去前後空白與結尾斜線；非 workers.dev、帶路徑、http:// 皆 bad_request 且不送請求', async () => {
  const s = setup(() => loginOk());
  for (const bad of ['https://example.com', URL_OK + '/api', 'http://hotnews.test-account.workers.dev',
    'https://script.google.com/macros/s/X/exec', 'https://evil.com/.workers.dev', '']) {
    await assert.rejects(s.client.login(bad, PASSWORD, false), { code: 'bad_request' }, bad);
  }
  assert.equal(s.calls.length, 0);
  await s.client.login('  ' + URL_OK + '///', PASSWORD, false);
  assert.equal(s.calls[0].url, URL_OK + '/login');
});

test('ok:false 轉成 ApiError，duplicate 帶 existing', async () => {
  const s = setup(router(loginOk(), json({ ok: false, code: 'duplicate', error: '這則新聞已經存在。', existing: { id: '1' } })));
  await s.client.login(URL_OK, PASSWORD, false);
  await assert.rejects(s.client.call('addItem', {}), (e) =>
    e instanceof api.ApiError && e.code === 'duplicate' && e.message === '這則新聞已經存在。' && e.existing.id === '1' && !e.unknown);
});

test('讀不到回應 → unreachable/unknown，且不重試（含寫入）', async () => {
  for (const respond of [
    () => Promise.reject(new TypeError('Failed to fetch')),
    () => Promise.resolve({ text: () => Promise.resolve('<html>login</html>') }),
    () => json({ nope: 1 })]) {
    const s = setup((u) => (u.endsWith('/login') ? loginOk() : respond()));
    await s.client.login(URL_OK, PASSWORD, false);
    await assert.rejects(s.client.call('addItem', {}), { code: 'unreachable', unknown: true });
    assert.equal(s.calls.length, 2);   // login + 一次 /api，沒有重試
  }
});

test('逾時：fetchTitle 20000ms、其他 30000ms，逾時即 abort', async () => {
  const pending = new Promise(() => {});
  const s = setup((u) => (u.endsWith('/login') ? loginOk() : pending));
  await s.client.login(URL_OK, PASSWORD, false);
  s.timers.length = 0;
  const p1 = s.client.call('fetchTitle', {}); await Promise.resolve();
  assert.equal(s.timers[0].ms, 20000);
  s.timers[0].fn();
  await assert.rejects(p1, { code: 'timeout', unknown: true });
  assert.equal(s.aborts[s.aborts.length - 1].aborted, true);
  const p2 = s.client.call('listItems', {}); await Promise.resolve();
  assert.equal(s.timers[1].ms, 30000);
  s.timers[1].fn();
  await assert.rejects(p2, { code: 'timeout' });
});

test('storage 存取丟例外時仍可運作（只在記憶體）', async () => {
  const s = setup(router(loginOk(), json({ ok: true, data: 1 })), { storage: memStorage(true) });
  await s.client.login(URL_OK, PASSWORD, true);
  assert.equal(await s.client.call('ping'), 1);
});

test('clearConfig 清空所有鍵（含舊鍵）；logout 只清憑證', async () => {
  const s = setup(() => loginOk());
  await s.client.login(URL_OK, PASSWORD, true);
  s.client.logout();
  assert.deepEqual(s.client.getConfig(), { url: URL_OK, session: null, remember: true });
  await s.client.login(URL_OK, PASSWORD, true);
  s.client.clearConfig();
  assert.equal(s.storage.m.size, 0);
  assert.deepEqual(s.client.getConfig(), { url: null, session: null, remember: false });
});
