const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const api = createRequire(__filename)('../web/api.js');

const URL_OK = 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec';
const TOKEN = 't'.repeat(48);

function memStorage(throwing) {
  const m = new Map();
  const guard = () => { if (throwing) throw new Error('blocked'); };
  return { m, getItem: (k) => { guard(); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { guard(); m.set(k, String(v)); }, removeItem: (k) => { guard(); m.delete(k); } };
}
function setup(respond, opts = {}) {
  const calls = [], timers = [];
  const storage = opts.storage || memStorage();
  const fetch = (url, init) => { calls.push({ url, init }); return respond(url, init); };
  const aborts = [];
  class AC { constructor() { this.signal = {}; aborts.push(this); } abort() { this.aborted = true; } }
  const client = api.createClient({ fetch, storage, AbortController: AC,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} });
  return { client, calls, timers, storage, aborts };
}
const json = (o) => Promise.resolve({ text: () => Promise.resolve(JSON.stringify(o)) });

test('請求形狀：POST text/plain、omit、no-referrer、follow，無自訂標頭', async () => {
  const s = setup(() => json({ ok: true, data: { pong: true } }));
  s.client.saveConfig({ url: URL_OK, token: TOKEN, remember: false });
  assert.deepEqual(await s.client.call('ping'), { pong: true });
  const { url, init } = s.calls[0];
  assert.equal(url, URL_OK);
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.deepEqual(JSON.parse(init.body), { token: TOKEN, action: 'ping', args: {} });
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.redirect, 'follow');
  assert.ok(init.signal);
});

test('ok:false 轉成 ApiError，duplicate 帶 existing', async () => {
  const s = setup(() => json({ ok: false, code: 'duplicate', error: '這則新聞已經存在。', existing: { id: '1' } }));
  s.client.saveConfig({ url: URL_OK, token: TOKEN, remember: false });
  await assert.rejects(s.client.call('addItem', {}), (e) =>
    e instanceof api.ApiError && e.code === 'duplicate' && e.message === '這則新聞已經存在。' && e.existing.id === '1' && !e.unknown);
});

test('unauthorized 清掉記憶體與儲存的密碼', async () => {
  const s = setup(() => json({ ok: false, code: 'unauthorized', error: 'x' }));
  s.client.saveConfig({ url: URL_OK, token: TOKEN, remember: true });
  assert.equal(s.storage.m.get('hotnews.v1.token'), TOKEN);
  await assert.rejects(s.client.call('listItems'), { code: 'unauthorized' });
  assert.equal(s.storage.m.has('hotnews.v1.token'), false);
  assert.equal(s.client.getConfig().token, null);
});

test('讀不到回應 → unreachable/unknown，且不重試（含寫入）', async () => {
  for (const respond of [
    () => Promise.reject(new TypeError('Failed to fetch')),
    () => Promise.resolve({ text: () => Promise.resolve('<html>login</html>') }),
    () => json({ nope: 1 })]) {
    const s = setup(respond);
    s.client.saveConfig({ url: URL_OK, token: TOKEN, remember: false });
    await assert.rejects(s.client.call('addItem', {}), { code: 'unreachable', unknown: true });
    assert.equal(s.calls.length, 1);
  }
});

test('逾時：fetchTitle 8000ms、其他 30000ms，逾時即 abort', async () => {
  const s = setup(() => new Promise(() => {}));
  s.client.saveConfig({ url: URL_OK, token: TOKEN, remember: false });
  const p1 = s.client.call('fetchTitle', {});
  const p2 = s.client.call('listItems', {});
  assert.deepEqual(s.timers.map((t) => t.ms), [8000, 30000]);
  s.timers[0].fn();
  await assert.rejects(p1, { code: 'timeout', unknown: true });
  assert.equal(s.aborts[0].aborted, true);
  s.timers[1].fn();
  await assert.rejects(p2, { code: 'timeout' });
});

test('設定：缺設定不呼叫 fetch；去前後空白；remember 控制是否寫入密碼', async () => {
  const s = setup(() => json({ ok: true, data: 1 }));
  await assert.rejects(s.client.call('ping'), { code: 'no_config' });
  assert.equal(s.calls.length, 0);
  s.client.saveConfig({ url: ' ' + URL_OK + ' \n', token: '  ' + TOKEN + '\n', remember: false });
  assert.deepEqual(s.client.getConfig(), { url: URL_OK, token: TOKEN, remember: false });
  assert.equal(s.storage.m.get('hotnews.v1.url'), URL_OK);
  assert.equal(s.storage.m.has('hotnews.v1.token'), false);
  s.client.saveConfig({ url: URL_OK, token: TOKEN, remember: true });
  assert.equal(s.storage.m.get('hotnews.v1.token'), TOKEN);
  assert.equal(s.storage.m.get('hotnews.v1.remember'), '1');
  s.client.saveConfig({ url: URL_OK, token: TOKEN, remember: false });
  assert.equal(s.storage.m.has('hotnews.v1.token'), false);   // 移除先前殘留
  assert.throws(() => s.client.saveConfig({ url: 'https://example.com', token: TOKEN }), { code: 'bad_request' });
  s.client.clearConfig();
  assert.equal(s.storage.m.size, 0);
});

test('storage 存取丟例外時仍可運作（只在記憶體）', async () => {
  const s = setup(() => json({ ok: true, data: 1 }), { storage: memStorage(true) });
  s.client.saveConfig({ url: URL_OK, token: TOKEN, remember: true });
  assert.equal(await s.client.call('ping'), 1);
});

test('checkConnection：單一 POST ping，不寫入也不清除設定', async () => {
  const good = setup(() => json({ ok: true, data: { pong: true } }));
  await good.client.checkConnection(' ' + URL_OK + '\n', TOKEN + '\n');
  assert.equal(good.calls.length, 1);
  assert.equal(JSON.parse(good.calls[0].init.body).action, 'ping');
  assert.equal(good.storage.m.size, 0);

  const bad = setup(() => json({ ok: false, code: 'unauthorized', error: 'x' }));
  bad.client.saveConfig({ url: URL_OK, token: 'keep-me-' + TOKEN, remember: true });
  await assert.rejects(bad.client.checkConnection(URL_OK, 'wrong'), { code: 'unauthorized' });
  assert.equal(bad.storage.m.get('hotnews.v1.token'), 'keep-me-' + TOKEN);
  await assert.rejects(bad.client.checkConnection('https://example.com', TOKEN), { code: 'bad_request' });
});
