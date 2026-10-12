const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeGas, TOKEN } = require('./helpers/fake-gas.js');
const { loadBackend } = require('./helpers/load-backend.js');

const TVBS = fs.readFileSync(path.join(__dirname, 'fixtures', 'tvbs-head.html'), 'utf8');
const TVBS_TITLE = '買二手車別只看外觀、里程數！「4大陷阱」小心、這些地方要檢查';
const MSG = { unauthorized: '密碼不正確或尚未設定。', bad_request: '請求內容不正確。', duplicate: '這則新聞已經存在。',
  not_found: '這則已不存在。', stale: '這則的改標已被其他裝置更新，請重新整理。', busy: '系統忙碌中，請稍後再試。',
  server_error: '伺服器發生錯誤，請稍後再試。' };

function setup(opts) {
  const gas = createFakeGas(opts);
  const be = loadBackend({ gas });
  return { gas, be, call: be.call, list: () => be.call('listItems').data };
}
const add = (s, o = {}) => s.call('addItem', Object.assign({ url: 'https://news.tvbs.com.tw/cars/4032757', orig: '原始', cat: '生活' }, o));
const code = (r) => (r.ok ? 'ok' : r.code);

/* ---------- 資訊清單與關卡 ---------- */
test('appsscript.json 符合規格', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'appsscript.json'), 'utf8'));
  assert.equal(m.timeZone, 'Asia/Taipei');
  assert.equal(m.runtimeVersion, 'V8');
  assert.equal(m.exceptionLogging, 'STACKDRIVER');
  assert.deepEqual(m.oauthScopes.slice().sort(), ['https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/spreadsheets']);
  assert.deepEqual(m.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
});

test('doGet 回 ok', () => { assert.equal(setup().be.doGet().getContent(), 'ok'); });

test('unauthorized：五種情況回應逐字相同，且驗證前不碰試算表與外部網址', () => {
  const bodies = [];
  const cases = [
    (s) => { s.gas.setProperty('API_TOKEN', null); return JSON.stringify({ token: TOKEN, action: 'ping' }); },
    (s) => { s.gas.setProperty('API_TOKEN', 't'.repeat(31)); return JSON.stringify({ token: 't'.repeat(31), action: 'ping' }); },
    () => JSON.stringify({ action: 'ping' }),
    () => JSON.stringify({ token: 'x'.repeat(48), action: 'ping' }),
    () => JSON.stringify({ token: 123, action: 'fetchTitle', args: { url: 'https://x.com/a' } })
  ];
  for (const mk of cases) {
    const s = setup();
    bodies.push(s.be.raw(mk(s)));
    assert.equal(s.gas.calls.spreadsheetOpens, 0);
    assert.equal(s.gas.calls.urlFetches.length, 0);
  }
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(JSON.parse(bodies[0]), { ok: false, code: 'unauthorized', error: MSG.unauthorized });
});

test('bad_request：非 JSON、非物件、缺 action、非白名單動作', () => {
  const s = setup();
  for (const body of ['nope', 'null', '[]', '"x"']) assert.equal(JSON.parse(s.be.raw(body)).code, 'bad_request', body);
  assert.equal(code(s.call('')), 'bad_request');
  for (const a of ['nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(code(s.call(a)), 'bad_request', a);
  assert.equal(JSON.parse(s.be.raw(JSON.stringify({ token: TOKEN }))).code, 'bad_request');
});

test('ping 開啟試算表；SHEET_ID 未設定 → server_error 固定訊息', () => {
  const s = setup();
  assert.deepEqual(s.call('ping'), { ok: true, data: { pong: true } });
  assert.equal(s.gas.calls.spreadsheetOpens, 1);
  const t = setup(); t.gas.setProperty('SHEET_ID', null);
  assert.deepEqual(t.call('ping'), { ok: false, code: 'server_error', error: MSG.server_error });
});

test('不洩漏：例外訊息不進回應，日誌不含密碼與請求內文', () => {
  const s = setup(); s.gas.spreadsheetThrows = 'SECRET-MSG';
  const body = s.be.raw(JSON.stringify({ token: TOKEN, action: 'ping', args: { note: 'PRIVATE-BODY' } }));
  assert.ok(!body.includes('SECRET-MSG'));
  const logs = s.gas.calls.logs.join('\n');
  assert.ok(!logs.includes(TOKEN) && !logs.includes('PRIVATE-BODY'));
  const bad = setup(); bad.be.raw('{"token":"' + 'z'.repeat(48) + '"'); bad.be.raw(JSON.stringify({ token: 'z'.repeat(48), action: 'ping' }));
  assert.ok(!bad.gas.calls.logs.join('\n').includes('z'.repeat(48)));
});

test('測試台自檢：回應含 Date 會丟例外', () => {
  const g = createFakeGas().globals();
  assert.throws(() => g.JSON.stringify({ data: { at: new g.Date() } }));
});

/* ---------- 試算表層、setup、listItems ---------- */
test('setup：建出三個分頁與標題列、預設分類、時區；重跑不覆蓋；日誌不含密碼值', () => {
  const s = setup();
  s.be.setup();
  assert.deepEqual(s.gas.dump('新聞')[0], ['id', '分類', '原始標題', '原文連結', '小編文', '上次使用時間', '使用次數', '建立時間']);
  assert.deepEqual(s.gas.dump('改標')[0], ['新聞id', '版本號', '標題', '上次使用時間', '使用次數', '建立時間']);
  assert.deepEqual(s.gas.dump('分類').map((r) => r[0]), ['分類', '社會', '生活', '健康', '政治', '國際', '娛樂']);
  assert.equal(s.gas.calls.timezone, 'Asia/Taipei');
  assert.equal(s.gas.calls.urlFetches.length, 1);
  assert.ok(!s.gas.calls.logs.join('\n').includes(TOKEN));
  assert.ok(s.gas.calls.logs.join('\n').includes('API_TOKEN'));
  s.gas.seedRows('分類', [['財經']]);
  s.be.setup();
  assert.deepEqual(s.gas.dump('分類').map((r) => r[0]).slice(-1), ['財經']);
  assert.equal(s.gas.dump('分類').length, 8);
});

test('listItems：空試算表回預設分類；欄位對應、排序、型別', () => {
  const s = setup();
  assert.deepEqual(s.list(), { items: [], cats: ['社會', '生活', '健康', '政治', '國際', '娛樂'] });
  const t1 = new Date(Date.UTC(2026, 9, 1)), t0 = new Date(Date.UTC(2026, 8, 1));
  s.gas.seedRows('新聞', [[4032757, '生活', '原始', 'https://a.b/4032757', '小編', t1, 2, t0], ['N1', '社會', 'o2', 'https://c.d/x', '', '', 0, t0]]);
  s.gas.seedRows('改標', [['4032757', 3, '三', '', 0, t0], ['4032757', 1, '一', t1, 2, t0], ['4032757', 2, '二', '', 0, t0]]);
  const { items } = s.list();
  assert.equal(items.length, 2);
  assert.equal(items[0].id, '4032757');
  assert.deepEqual(items[0].titles.map((v) => v.ver), [1, 2, 3]);
  assert.deepEqual([items[0].last, items[0].count, items[0].created, items[0].titles[0].last], [t1.getTime(), 2, t0.getTime(), t1.getTime()]);
  assert.equal(items[1].last, null);
  assert.deepEqual(items[1].titles, []);
});

test('listItems：使用者手動編輯造成的髒資料被略過而不是整個失敗', () => {
  const s = setup(); s.call('ping');
  const t0 = new Date(Date.UTC(2026, 8, 1));
  s.gas.seedRows('新聞', [['', '', '', '', '', '', '', ''], ['A1', '生活', 'o', 'https://a.b/1', '', '昨天', 'abc', t0], ['A2', '生活', 'o2', 'https://a.b/2', '', '', '', t0]]);
  s.gas.seedRows('改標', [['孤兒', 1, 'x', '', 0, t0], ['A1', 'abc', 'bad ver', '', 0, t0], ['A1', 1, '好', '', 0, t0], ['A1', 1, '重複版本', '', 0, t0]]);
  s.gas.seedRows('分類', [[''], ['  生活 '], ['財經'], ['財經']]);
  const r = s.list();
  assert.deepEqual(r.items.map((i) => i.id), ['A1', 'A2']);
  assert.equal(r.items[0].last, null);
  assert.equal(r.items[0].count, 0);
  assert.equal(r.items[1].count, 0);
  assert.deepEqual(r.items[0].titles.map((v) => v.t), ['好']);
  assert.deepEqual(r.cats, ['社會', '生活', '健康', '政治', '國際', '娛樂', '生活', '財經']
    .filter((c, i, a) => a.indexOf(c) === i));
});

test('分頁被刪掉後下一次呼叫自動補建', () => {
  const s = setup(); s.call('ping'); s.gas.deleteSheet('改標');
  assert.equal(code(s.call('listItems')), 'ok');
  assert.ok(s.gas.spreadsheet.getSheetByName('改標'));
});

/* ---------- addItem ---------- */
test('addItem 成功：編號由伺服器算、版本、時間、文字欄位為字串', () => {
  const s = setup();
  const r = add(s, { orig: ' 原始\n標題 ', note: '你多久保養一次車？\r\n留言 👇\r\n', titles: ['A\nB', '  \n', 'C\r\n'] });
  assert.equal(r.ok, true);
  const it = r.data.item;
  assert.equal(it.id, '4032757');
  assert.equal(it.orig, '原始 標題');
  assert.equal(it.note, '你多久保養一次車？\n留言 👇');
  assert.equal(it.created, s.gas.now);
  assert.deepEqual([it.last, it.count], [null, 0]);
  assert.deepEqual(it.titles.map((v) => [v.ver, v.t, v.count]), [[1, 'A\nB', 0], [2, 'C', 0]]);
  assert.equal(s.gas.dump('新聞')[1][0], '4032757');
});

test('addItem 先設純文字格式再寫入：公式字元與前導零原樣保存', () => {
  const s = setup();
  ['=1+1', '+1', '-1', '@SUM(1)'].forEach((t, n) => assert.equal(add(s, { url: 'https://x.com/a/' + (n + 100), orig: t, titles: [t], note: t }).ok, true));
  assert.equal(add(s, { url: 'https://news.tvbs.com.tw/local/0042' }).data.item.id, '0042');
  const { items } = s.list();
  assert.deepEqual(items.filter((i) => i.id !== '0042').map((i) => [i.orig, i.note, i.titles[0].t]), [['=1+1', '=1+1', '=1+1'], ['+1', '+1', '+1'], ['-1', '-1', '-1'], ['@SUM(1)', '@SUM(1)', '@SUM(1)']]);
  const log = s.gas.opLog;
  const fmts = log.filter((x) => x.op === 'setNumberFormat' && x.fmt === '@');
  assert.ok(fmts.length > 0);
  fmts.forEach((f) => {   // 每次設純文字格式後，同一範圍的下一個寫入必須是 setValues（先格式後值）
    const i = log.indexOf(f), next = log.slice(i + 1).find((x) => x.sheet === f.sheet && x.r === f.r && x.c === f.c);
    assert.ok(next && next.op === 'setValues', JSON.stringify(f));
  });
});

test('addItem：無數字網址用 N 流水號；重複回 duplicate 且不新增', () => {
  const s = setup();
  assert.equal(add(s, { url: 'https://example.com/a' }).data.item.id, 'N1');
  assert.equal(add(s, { url: 'https://example.com/b' }).data.item.id, 'N2');
  add(s, { url: 'https://news.tvbs.com.tw/cars/4032757' });
  const rowsBefore = s.gas.dump('新聞').length;
  const d = add(s, { url: 'https://news.tvbs.com.tw/local/4032757' });
  assert.equal(d.code, 'duplicate');
  assert.equal(d.error, MSG.duplicate);
  assert.equal(d.existing.id, '4032757');
  assert.equal(s.gas.dump('新聞').length, rowsBefore);
});

test('addItem 驗證失敗一律 bad_request 且不寫入', () => {
  const s = setup(); s.call('ping');
  const L = { orig: 'a'.repeat(501), note: 'n'.repeat(5001) };
  const bads = [{ url: undefined }, { orig: undefined }, { cat: undefined }, { url: 'ftp://x.com/1' }, { url: 'http://localhost/1' }, { cat: '不存在' },
    { orig: L.orig }, { note: L.note }, { note: 5 }, { titles: 'x' }, { titles: Array(21).fill('x') }, { titles: ['x'.repeat(501)] }, { orig: '  \n ' }];
  for (const b of bads) assert.equal(code(add(s, b)), 'bad_request', JSON.stringify(b).slice(0, 40));
  assert.equal(s.gas.dump('新聞').length, 1);
  assert.equal(s.gas.dump('改標').length, 1);
});

test('寫入類動作取不到鎖 → busy，鎖釋放後恢復', () => {
  const s = setup();
  s.gas.lockHeld = true;
  assert.equal(code(add(s)), 'busy');
  assert.equal(code(s.call('deleteItem', { id: 'x' })), 'busy');
  assert.equal(code(s.call('markUsed', { id: 'x' })), 'busy');
  assert.equal(code(s.call('updateItem', { id: 'x', cat: '生活', note: '' })), 'busy');
  s.gas.lockHeld = false;
  assert.equal(add(s).ok, true);
});

/* ---------- updateItem ---------- */
function seeded() {
  const s = setup();
  add(s, { titles: ['一', '二', '三'], note: 'n' });
  return s;
}
const upd = (s, o) => s.call('updateItem', Object.assign({ id: '4032757', cat: '生活', note: 'n' }, o));

test('updateItem：分類、小編文、edit 保留使用紀錄、add 版本號不重用', () => {
  const s = seeded();
  s.call('markUsed', { id: '4032757', ver: 2 });
  const r = upd(s, { cat: '社會', note: '', edit: [{ ver: 2, t: '二改' }], remove: [3], add: ['新'] });
  assert.equal(r.ok, true);
  const it = r.data.item;
  assert.deepEqual([it.cat, it.note], ['社會', '']);
  assert.deepEqual(it.titles.map((v) => [v.ver, v.t, v.count]), [[1, '一', 0], [2, '二改', 1], [4, '新', 0]]);
  assert.equal(it.titles[1].last, s.gas.now);
});

test('updateItem：沒列在 remove 的版本不會被刪（別台裝置新增的不會被誤刪）', () => {
  const s = seeded();
  upd(s, { add: ['別台新增'] });
  const it = upd(s, { note: 'n2' }).data.item;
  assert.deepEqual(it.titles.map((v) => v.t), ['一', '二', '三', '別台新增']);
});

test('updateItem：分類規則、stale、not_found、bad_request', () => {
  const s = seeded();
  assert.equal(code(upd(s, { cat: '不存在' })), 'bad_request');
  s.gas.seedRows('新聞', [['Z9', '已刪分類', 'o', 'https://a.b/9', '', '', 0, new Date(s.gas.now)]]);
  assert.equal(upd(s, { id: 'Z9', cat: '已刪分類', note: 'x' }).ok, true);   // 未變動的舊分類放行
  const writes = () => s.gas.opLog.length;
  const before = writes();
  assert.equal(code(upd(s, { edit: [{ ver: 9, t: 'x' }] })), 'stale');
  assert.equal(code(upd(s, { remove: [9] })), 'stale');
  assert.equal(writes(), before);
  assert.equal(code(upd(s, { id: 'nope' })), 'not_found');
  for (const b of [{ edit: [{ ver: 1, t: 'a' }], remove: [1] }, { edit: [{ ver: 1, t: 'a' }, { ver: 1, t: 'b' }] }, { edit: [{ ver: 1, t: ' ' }] },
    { add: Array(18).fill('x') }, { edit: [{ ver: 1, t: 'x'.repeat(501) }] }, { add: 'x' }]) {
    assert.equal(code(upd(s, b)), 'bad_request', JSON.stringify(b).slice(0, 40));
  }
  assert.equal(upd(s, { add: ['  ', '\n'] }).ok, true);   // 空白新增被略過，不是錯誤
});

test('updateItem 改成公式字元仍原樣保存', () => {
  const s = seeded();
  assert.equal(upd(s, { edit: [{ ver: 1, t: '=2+2' }] }).data.item.titles[0].t, '=2+2');
});

/* ---------- deleteItem / markUsed ---------- */
test('deleteItem 連帶刪除改標，不影響其他新聞', () => {
  const s = setup();
  add(s, { url: 'https://a.b/1', titles: ['a1', 'a2'] }); add(s, { url: 'https://a.b/2', titles: ['b1'] }); add(s, { url: 'https://a.b/3', titles: ['c1', 'c2'] });
  assert.deepEqual(s.call('deleteItem', { id: '2' }), { ok: true, data: { id: '2' } });
  const { items } = s.list();
  assert.deepEqual(items.map((i) => i.id), ['1', '3']);
  assert.deepEqual(items.map((i) => i.titles.map((v) => v.t)), [['a1', 'a2'], ['c1', 'c2']]);
  assert.equal(s.gas.dump('改標').length, 5);
  assert.equal(code(s.call('deleteItem', { id: '2' })), 'not_found');
  assert.equal(code(s.call('deleteItem', {})), 'bad_request');
});

test('markUsed：整則與該版本更新，其他版本不變；沒有改標只更新整則', () => {
  const s = seeded();
  s.gas.setNow(s.gas.now + 1000);
  let it = s.call('markUsed', { id: '4032757', ver: 2 }).data.item;
  assert.deepEqual([it.last, it.count], [s.gas.now, 1]);
  assert.deepEqual(it.titles.map((v) => [v.count, v.last]), [[0, null], [1, s.gas.now], [0, null]]);
  it = s.call('markUsed', { id: '4032757', ver: 2 }).data.item;
  assert.deepEqual([it.count, it.titles[1].count], [2, 2]);
  add(s, { url: 'https://a.b/55' });
  const plain = s.call('markUsed', { id: '55' }).data.item;
  assert.deepEqual([plain.count, plain.last], [1, s.gas.now]);
  assert.equal(code(s.call('markUsed', { id: '4032757', ver: 9 })), 'stale');
  assert.equal(code(s.call('markUsed', { id: 'nope' })), 'not_found');
  assert.equal(code(s.call('markUsed', { id: '4032757' })), 'bad_request');
  assert.equal(code(s.call('markUsed', { id: '4032757', ver: 1.5 })), 'bad_request');
  assert.ok(s.gas.opLog.some((o) => o.op === 'setNumberFormat' && o.fmt === 'yyyy/MM/dd HH:mm'));
});

/* ---------- fetchTitle ---------- */
test('fetchTitle 成功：只回 title 與 source，請求選項符合規格，不取鎖不開試算表', () => {
  const s = setup(); s.gas.urlFetch = () => ({ code: 200, text: TVBS }); s.gas.lockHeld = true;
  const r = s.call('fetchTitle', { url: ' https://news.tvbs.com.tw/cars/4032757 ' });
  assert.deepEqual(r, { ok: true, data: { title: TVBS_TITLE, source: 'og:title', reason: null } });
  assert.equal(s.gas.calls.urlFetches.length, 1);
  const o = s.gas.calls.urlFetches[0].opts;
  assert.deepEqual([o.muteHttpExceptions, o.followRedirects], [true, true]);
  assert.match(o.headers['User-Agent'], /Mozilla\/5\.0/);
  assert.equal(o.headers['Accept-Language'], 'zh-TW,zh;q=0.9');
  assert.equal(s.gas.calls.spreadsheetOpens, 0);
});

test('fetchTitle 失敗都回空結果與原因；不合規網址不發出請求', () => {
  const cases = [[() => ({ code: 403, text: TVBS }), 'http_403'], [() => { throw new Error('SECRET-FETCH'); }, 'fetch_error'],
    [() => ({ code: 200, text: '<head><title>Just a moment...</title></head>' }), 'no_title'], [() => ({ code: 200, text: '<p>無</p>' }), 'no_title']];
  for (const [f, reason] of cases) {
    const s = setup(); s.gas.urlFetch = f;
    const raw = s.be.raw(JSON.stringify({ token: TOKEN, action: 'fetchTitle', args: { url: 'https://x.com/a' } }));
    assert.deepEqual(JSON.parse(raw), { ok: true, data: { title: null, source: null, reason } });
    assert.ok(!raw.includes('SECRET-FETCH'));
  }
  const s = setup();
  for (const url of ['ftp://x.com/a', 'https://user:pw@x.com/a', 'http://127.0.0.1/a', 'http://localhost/a', 'https://x.com:8443/a', undefined]) assert.equal(code(s.call('fetchTitle', { url })), 'bad_request', String(url));
  assert.equal(s.gas.calls.urlFetches.length, 0);
});
