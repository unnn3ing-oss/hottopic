const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const qpt = createRequire(__filename)('../web/qpt.js');

const ORIGIN = 'https://unnn3ing-oss.github.io';

// 假 window：記錄監聽與 postMessage，可手動 emit；假計時器可手動觸發
function fakeWin() {
  const listeners = [];
  const win = {
    location: { origin: ORIGIN },
    posted: [],
    removed: [],
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    removeEventListener(type, fn) { win.removed.push(fn); const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    postMessage(msg, target) { win.posted.push({ msg, target }); },
    emit(event) { listeners.slice().forEach(fn => fn(event)); },
    listenerCount() { return listeners.length; }
  };
  return win;
}
function fakeTimers() {
  const pending = [];
  return {
    setTimeout(fn, ms) { pending.push({ fn, ms, live: true }); return pending.length - 1; },
    clearTimeout(id) { if (pending[id]) pending[id].live = false; },
    fire() { pending.filter(p => p.live).forEach(p => { p.live = false; p.fn(); }); },
    pending
  };
}
const ack = (win, nonce, extra) => ({ source: win, origin: ORIGIN, data: Object.assign({ source: 'quickpattern', type: 'ack', nonce: nonce, ok: true, opened: true }, extra) });
const item = { url: 'https://news.tvbs.com.tw/x', titles: [{ t: 'A' }, { t: 'B' }] };

test('buildMessage 取目前輪播的那版', () => {
  const m = qpt.buildMessage(item, 1, 'n1');
  assert.deepEqual(m, { source: 'hottopic', type: 'send-to-quickpattern', v: 1, nonce: 'n1', url: item.url, title: 'B' });
});

test('buildMessage 沒有改標時省略 title', () => {
  const m = qpt.buildMessage({ url: item.url, titles: [] }, 0, 'n1');
  assert.equal('title' in m, false);
  assert.equal('title' in qpt.buildMessage({ url: item.url }, 0, 'n1'), false);
});

test('send：ack ok+opened → opened', async () => {
  const win = fakeWin(), t = fakeTimers();
  const p = qpt.send({ win, item, pos: 0, nonce: 'n1', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  win.emit(ack(win, 'n1'));
  assert.deepEqual(await p, { status: 'opened' });
});

test('send：ack ok 但 opened:false → not_opened', async () => {
  const win = fakeWin(), t = fakeTimers();
  const p = qpt.send({ win, item, pos: 0, nonce: 'n1', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  win.emit(ack(win, 'n1', { opened: false }));
  assert.deepEqual(await p, { status: 'not_opened' });
});

test('send：ack ok:false → rejected 且帶 error', async () => {
  const win = fakeWin(), t = fakeTimers();
  const p = qpt.send({ win, item, pos: 0, nonce: 'n1', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  win.emit(ack(win, 'n1', { ok: false, opened: false, error: 'bad_url' }));
  assert.deepEqual(await p, { status: 'rejected', error: 'bad_url' });
});

test('send：沒有 ack，逾時（800 毫秒）→ no_extension', async () => {
  const win = fakeWin(), t = fakeTimers();
  const p = qpt.send({ win, item, pos: 0, nonce: 'n1', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  assert.equal(t.pending[0].ms, 800);
  t.fire();
  assert.deepEqual(await p, { status: 'no_extension' });
});

test('send 忽略別人的 ack（nonce／source／origin／data.source 不符）', async () => {
  const win = fakeWin(), t = fakeTimers();
  const p = qpt.send({ win, item, pos: 0, nonce: 'n1', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  win.emit(ack(win, 'other'));
  win.emit(Object.assign(ack(win, 'n1'), { source: {} }));
  win.emit(Object.assign(ack(win, 'n1'), { origin: 'https://evil.example' }));
  win.emit({ source: win, origin: ORIGIN, data: { source: 'hottopic', type: 'ack', nonce: 'n1', ok: true, opened: true } });
  win.emit({ source: win, origin: ORIGIN, data: null });
  t.fire();
  assert.deepEqual(await p, { status: 'no_extension' });
});

test('send 結束後移除同一個監聽（成功與逾時兩條路徑）', async () => {
  for (const mode of ['ack', 'timeout']) {
    const win = fakeWin(), t = fakeTimers();
    const p = qpt.send({ win, item, pos: 0, nonce: 'n1', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
    assert.equal(win.listenerCount(), 1);
    if (mode === 'ack') win.emit(ack(win, 'n1')); else t.fire();
    await p;
    assert.equal(win.listenerCount(), 0, mode);
    assert.equal(win.removed.length, 1, mode);
  }
});

test('連按兩次互不干擾', async () => {
  const win = fakeWin(), t = fakeTimers();
  const p1 = qpt.send({ win, item, pos: 0, nonce: 'n1', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  const p2 = qpt.send({ win, item, pos: 1, nonce: 'n2', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  win.emit(ack(win, 'n2', { opened: false }));
  win.emit(ack(win, 'n1', { opened: true }));
  assert.deepEqual(await p2, { status: 'not_opened' });
  assert.deepEqual(await p1, { status: 'opened' });
});

test('postMessage 的目標 origin 是 win.location.origin，不是 *', async () => {
  const win = fakeWin(), t = fakeTimers();
  const p = qpt.send({ win, item, pos: 1, nonce: 'n1', setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  assert.equal(win.posted.length, 1);
  assert.equal(win.posted[0].target, ORIGIN);
  assert.equal(win.posted[0].msg.title, 'B');
  t.fire();
  await p;
});
