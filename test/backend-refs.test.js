const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeGas } = require('./helpers/fake-gas.js');
const { loadBackend } = require('./helpers/load-backend.js');

const HEADER = ['id', '分類', '原始標題', '原文連結', '改標', '參考誰', '建立時間'];
function setup(opts) {
  const gas = createFakeGas(opts);
  const be = loadBackend({ gas });
  return { gas, be, call: be.call, list: () => be.call('listRefs').data };
}
const URL1 = 'https://news.tvbs.com.tw/local/4031880';
const addRef = (s, o = {}) => s.call('addRef', Object.assign({ url: URL1, orig: '原標', cat: '社會', title: '改標', who: '小明' }, o));
const code = (r) => (r.ok ? 'ok' : r.code);

test('listRefs 空表：回空陣列與預設分類，並建立「參考」分頁與標題列', () => {
  const s = setup();
  const r = s.call('listRefs');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.items, []);
  assert.deepEqual(r.data.cats, ['社會', '生活', '健康', '政治', '國際', '娛樂']);
  assert.deepEqual(s.gas.dump('參考')[0], HEADER);
});

test('沒用參考動作就不建「參考」分頁', () => {
  const s = setup();
  s.call('ping'); s.call('listItems');
  assert.equal(s.gas.spreadsheet.getSheetByName('參考'), null);
});

test('addRef 基本：編號 R1、R2，欄位完整，listRefs 讀得回來', () => {
  const s = setup();
  const a = addRef(s);
  assert.equal(a.ok, true);
  assert.equal(a.data.item.id, 'R1');
  assert.deepEqual({ ...a.data.item, created: typeof a.data.item.created },
    { id: 'R1', cat: '社會', orig: '原標', url: URL1, title: '改標', who: '小明', created: 'number' });
  const b = addRef(s, { who: '小華', title: '另一版' });
  assert.equal(b.data.item.id, 'R2');
  const items = s.list().items;
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => [i.id, i.who, i.title]), [['R1', '小明', '改標'], ['R2', '小華', '另一版']]);
});

test('同網址不同人允許（Review Focus 1）', () => {
  const s = setup();
  assert.equal(addRef(s, { who: '小明' }).ok, true);
  assert.equal(addRef(s, { who: '小華' }).ok, true);
  assert.equal(s.list().items.length, 2);
});

test('同篇同人重複：回 duplicate 並附既有那筆；網址帶參數、人名前後空白換行也算同一人（Review Focus 1）', () => {
  const s = setup();
  addRef(s);
  const d = addRef(s);
  assert.equal(d.code, 'duplicate');
  assert.equal(d.existing.id, 'R1');
  const d2 = addRef(s, { url: URL1 + '?from=x', who: ' 小明\n' });
  assert.equal(d2.code, 'duplicate');
  assert.equal(d2.existing.id, 'R1');
  assert.equal(s.list().items.length, 1);
});

test('addRef 驗證與邊界（Review Focus 3）', () => {
  const s = setup();
  const bad = [{ title: '' }, { title: '  \n ' }, { title: 'x'.repeat(501) }, { who: '' }, { who: ' \n ' }, { who: '字'.repeat(31) },
    { cat: '不存在' }, { url: 'ftp://x' }, { url: 'localhost' }, { orig: '' }, { title: 123 }, { who: null }, { orig: 5 }, { cat: {} }];
  bad.forEach((o, i) => assert.equal(code(addRef(s, o)), 'bad_request', JSON.stringify(o) + ' #' + i));
  assert.equal(s.list().items.length, 0);
  assert.equal(code(addRef(s, { who: '字'.repeat(30), title: 'x'.repeat(500), url: 'https://news.tvbs.com.tw/local/1' })), 'ok');
});

test('改標以 = 開頭：存成文字，不被當公式（Review Focus 3）', () => {
  const s = setup();
  addRef(s, { title: '=1+1' });
  assert.equal(s.list().items[0].title, '=1+1');
  const row = s.gas.dump('參考')[1];
  assert.equal(row[4], '=1+1');
  assert.equal(typeof row[4], 'string');
});

test('updateRef：改分類／改標／人；原標與網址不變', () => {
  const s = setup();
  addRef(s);
  const u = s.call('updateRef', { id: 'R1', cat: '生活', title: '新改標', who: '小華' });
  assert.equal(u.ok, true);
  assert.deepEqual({ ...u.data.item, created: 0 }, { id: 'R1', cat: '生活', orig: '原標', url: URL1, title: '新改標', who: '小華', created: 0 });
  const it = s.list().items[0];
  assert.deepEqual([it.cat, it.title, it.who, it.orig, it.url], ['生活', '新改標', '小華', '原標', URL1]);
});

test('updateRef：改成同篇已有的人 → duplicate；不存在 → not_found；新分類不在清單 → bad_request；舊分類已不在清單但沒改 → 成功', () => {
  const s = setup();
  addRef(s, { who: '小明' }); addRef(s, { who: '小華' });
  const d = s.call('updateRef', { id: 'R2', cat: '社會', title: 't', who: '小明' });
  assert.equal(d.code, 'duplicate');
  assert.equal(s.call('updateRef', { id: 'R9', cat: '社會', title: 't', who: 'x' }).code, 'not_found');
  assert.equal(s.call('updateRef', { id: 'R1', cat: '亂寫', title: 't', who: '小明' }).code, 'bad_request');
  assert.equal(s.call('updateRef', { id: 'R1', cat: '社會', title: '', who: '小明' }).code, 'bad_request');
  const sheet = s.gas.spreadsheet.getSheetByName('分類');
  sheet.deleteRow(2);           // 刪掉「社會」，讓既有資料的分類不在清單
  assert.equal(code(s.call('updateRef', { id: 'R1', cat: '社會', title: '還是能改', who: '小明' })), 'ok');
});

test('deleteRef：刪指定列、其他保留；再刪一次 not_found', () => {
  const s = setup();
  addRef(s, { who: '甲' }); addRef(s, { who: '乙' }); addRef(s, { who: '丙' });
  assert.deepEqual(s.call('deleteRef', { id: 'R2' }), { ok: true, data: { id: 'R2' } });
  assert.deepEqual(s.list().items.map((i) => i.id), ['R1', 'R3']);
  assert.equal(s.call('deleteRef', { id: 'R2' }).code, 'not_found');
});

test('手動改亂的「參考」分頁：略過空 id、重複 id、空改標、空參考誰，created 為數字（Review Focus 4）', () => {
  const s = setup();
  s.call('listRefs');
  const d = new Date(Date.UTC(2026, 9, 12, 1, 0, 0));
  s.gas.seedRows('參考', [
    ['R1', '社會', '原A', 'https://x.tw/a/1', '改A', '小明', d],
    ['', '社會', '原', 'https://x.tw/a/2', '空id', '小明', d],
    ['R1', '社會', '原', 'https://x.tw/a/3', '重複id', '小華', d],
    ['R4', '社會', '原', 'https://x.tw/a/4', '', '小明', d],
    ['R5', '社會', '原', 'https://x.tw/a/5', '空人', '', d],
    ['R6', '生活', '原F', 'https://x.tw/a/6', '改F', '阿美', '不是日期']
  ]);
  const items = s.list().items;
  assert.deepEqual(items.map((i) => i.id), ['R1', 'R6']);
  assert.equal(items[0].created, d.getTime());
  assert.equal(typeof items[1].created, 'number');
  assert.equal(addRef(s, { url: 'https://x.tw/a/9', who: '新人' }).data.item.id, 'R7');
});

test('addRef：鎖被占用回 busy', () => {
  const s = setup();
  s.call('listRefs');
  s.gas.lockHeld = true;
  assert.equal(addRef(s).code, 'busy');
});

test('編號不重複使用：刪掉最新一筆後再新增，拿到新編號（避免別台舊畫面改到另一筆）', () => {
  const s = setup();
  addRef(s, { who: '甲' }); addRef(s, { who: '乙' }); addRef(s, { who: '丙' });
  assert.equal(s.call('deleteRef', { id: 'R3' }).ok, true);
  assert.equal(addRef(s, { who: '丁' }).data.item.id, 'R4');
});

test('編號不重複使用：被略過的列（參考誰空白）的編號也算在內，之後補回也不會撞號', () => {
  const s = setup();
  addRef(s);
  s.gas.seedRows('參考', [['R7', '社會', '原', 'https://x.tw/a/7', '改', '', new Date(Date.UTC(2026, 9, 12, 1, 0, 0))]]);
  assert.equal(addRef(s, { who: '小華' }).data.item.id, 'R8');
});
