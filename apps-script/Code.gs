/* 熱門新聞庫 後端：Google Apps Script Web App（JSON API）。
 * 協定：POST text/plain 的 JSON {token, action, args}；回應 HTTP 永遠 200：{ok:true,data} 或 {ok:false,code,error?,existing?}。
 * 純函式與常數在 lib.js（Apps Script 檔案載入順序不保證，所以載入時不讀 lib.js 的全域值，只在函式內讀）。
 * 指令碼屬性：API_TOKEN（至少 32 字元）、SHEET_ID（試算表 ID）。 */

var SHEET = { news: '新聞', edits: '改標', cats: '分類' };
var HEADERS = {
  news: ['id', '分類', '原始標題', '原文連結', '小編文', '上次使用時間', '使用次數', '建立時間'],
  edits: ['新聞id', '版本號', '標題', '上次使用時間', '使用次數', '建立時間'],
  cats: ['分類']
};
var DEFAULT_CATS = ['社會', '生活', '健康', '政治', '國際', '娛樂'];
var DATE_FORMAT = 'yyyy/MM/dd HH:mm';

var ERROR_MESSAGES = {
  unauthorized: '密碼不正確或尚未設定。',
  bad_request: '請求內容不正確。',
  duplicate: '這則新聞已經存在。',
  not_found: '這則已不存在。',
  stale: '這則的改標已被其他裝置更新，請重新整理。',
  busy: '系統忙碌中，請稍後再試。',
  server_error: '伺服器發生錯誤，請稍後再試。'
};

function failure_(code, extra) {
  var e = new Error(code);
  e.hotCode = code;
  e.extra = extra || null;
  throw e;
}

/* ---------- 入口 ---------- */
function doGet() {
  return ContentService.createTextOutput('ok');
}

function doPost(e) {
  var ctx = { authed: false, action: '' };
  var out;
  try {
    out = { ok: true, data: handle_(e, ctx) };
  } catch (err) {
    out = toFailure_(err, ctx);
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(e, ctx) {
  var req;
  try { req = JSON.parse(e && e.postData && e.postData.contents); } catch (x) { failure_('bad_request'); }
  if (!req || typeof req !== 'object' || Array.isArray(req)) failure_('bad_request');
  var tok = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!(tok && tok.length >= 32 && typeof req.token === 'string' && req.token === tok)) failure_('unauthorized');
  ctx.authed = true;
  if (typeof req.action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, req.action)) failure_('bad_request');
  ctx.action = req.action;
  var args = req.args;
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) failure_('bad_request');
  return ACTIONS[req.action](args);
}

function toFailure_(err, ctx) {
  var code = err && err.hotCode;
  if (!code) {
    code = 'server_error';
    if (ctx.authed) {   // 驗證通過後才記錄，且只記錄動作名稱、例外名稱與訊息前 200 字
      console.error(ctx.action + ' ' + (err && err.name) + ' ' + String(err && err.message).slice(0, 200));
    }
  }
  var out = { ok: false, code: code, error: ERROR_MESSAGES[code] };
  if (err && err.extra && err.extra.existing) out.existing = err.extra.existing;
  return out;
}

/* ---------- 試算表層 ---------- */
function sheetId_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('指令碼屬性 SHEET_ID 未設定');
  return id;
}

// 文字欄位一律先設純文字格式再寫入（避免 =、+、-、@ 開頭被當公式、0042 被吃掉前導零）
function writeText_(sheet, row, col, values) {
  var range = sheet.getRange(row, col, values.length, values[0].length);
  range.setNumberFormat('@');
  range.setValues(values);
}
function writeNumber_(sheet, row, col, value) {
  var range = sheet.getRange(row, col, 1, 1);
  range.setNumberFormat('0');
  range.setValues([[value]]);
}
function writeTime_(sheet, row, col, date) {
  var range = sheet.getRange(row, col, 1, 1);
  range.setNumberFormat(DATE_FORMAT);
  range.setValues([[date === null ? '' : date]]);
}

function ensureSheet_(ss, name, headers, defaults) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  try {
    sh = ss.insertSheet(name);
  } catch (e) {
    sh = ss.getSheetByName(name);   // 另一個請求剛建好
    if (!sh) throw e;
    return sh;
  }
  writeText_(sh, 1, 1, [headers]);
  if (defaults) writeText_(sh, 2, 1, defaults.map(function (c) { return [c]; }));
  return sh;
}

function db_() {
  var ss = SpreadsheetApp.openById(sheetId_());
  return {
    ss: ss,
    news: ensureSheet_(ss, SHEET.news, HEADERS.news),
    edits: ensureSheet_(ss, SHEET.edits, HEADERS.edits),
    cats: ensureSheet_(ss, SHEET.cats, HEADERS.cats, DEFAULT_CATS)
  };
}

function str_(v) { return v === null || v === undefined ? '' : String(v); }
function toInt_(v) { var n = Number(v); return isFinite(n) && n >= 0 ? Math.floor(n) : 0; }
function toMs_(v) { return v instanceof Date && !isNaN(v.getTime()) ? v.getTime() : null; }
function rows_(sheet, cols) {
  var last = sheet.getLastRow();
  return last < 2 ? [] : sheet.getRange(2, 1, last - 1, cols).getValues();
}

// 讀整份資料；手動編輯造成的壞資料（空白列、孤兒改標、非數字版本號…）略過而不是整個失敗
function readAll_(db) {
  var items = [], byId = {}, newsRow = {}, editRows = {}, verRow = {};
  rows_(db.news, 8).forEach(function (r, i) {
    var id = str_(r[0]).trim();
    if (!id || byId[id]) return;
    var item = { id: id, cat: str_(r[1]).trim(), orig: str_(r[2]), url: str_(r[3]), note: str_(r[4]),
      last: toMs_(r[5]), count: toInt_(r[6]), created: toMs_(r[7]) || 0, titles: [] };
    byId[id] = item; newsRow[id] = i + 2; items.push(item);
  });
  rows_(db.edits, 6).forEach(function (r, i) {
    var id = str_(r[0]).trim();
    if (!byId[id]) return;
    (editRows[id] = editRows[id] || []).push(i + 2);
    var ver = Number(r[1]), t = str_(r[2]);
    if (r[1] === '' || !isFinite(ver) || Math.floor(ver) !== ver || ver < 1 || !t) return;
    verRow[id] = verRow[id] || {};
    if (verRow[id][ver]) return;
    verRow[id][ver] = i + 2;
    byId[id].titles.push({ ver: ver, t: t, last: toMs_(r[3]), count: toInt_(r[4]) });
  });
  items.forEach(function (it) { it.titles.sort(function (a, b) { return a.ver - b.ver; }); });
  var cats = [];
  rows_(db.cats, 1).forEach(function (r) {
    var c = str_(r[0]).trim();
    if (c && cats.indexOf(c) === -1) cats.push(c);
  });
  return { items: items, byId: byId, cats: cats, newsRow: newsRow, editRows: editRows, verRow: verRow };
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { failure_('busy'); }
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) { /* ignore */ } }
}

function appendEditRows_(db, id, vers, now) {   // vers: [{ver, t}]
  var row = db.edits.getLastRow() + 1;
  vers.forEach(function (v, i) {
    var r = row + i;
    writeText_(db.edits, r, 1, [[id]]);
    writeNumber_(db.edits, r, 2, v.ver);
    writeText_(db.edits, r, 3, [[v.t]]);
    writeTime_(db.edits, r, 4, null);
    writeNumber_(db.edits, r, 5, 0);
    writeTime_(db.edits, r, 6, now);
  });
}

/* ---------- 輸入驗證 ---------- */
function reqString_(v) { if (typeof v !== 'string') failure_('bad_request'); return v; }
function textList_(v, limits) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) failure_('bad_request');
  var out = [];
  v.forEach(function (t) {
    var n = normalizeText(reqString_(t));
    if (!n) return;
    if (n.length > LIMITS.title) failure_('bad_request');
    out.push(n);
  });
  return out;
}
function optNote_(v) {
  if (v === undefined) return '';
  var n = normalizeText(reqString_(v));
  if (n.length > LIMITS.note) failure_('bad_request');
  return n;
}

/* ---------- 動作 ---------- */
function ping_() {
  db_();   // 順便驗證 SHEET_ID 設對了
  return { pong: true };
}

function listItems_() {
  var all = readAll_(db_());
  return { items: all.items, cats: all.cats };
}

function addItem_(args) {
  var url = normalizeUrl(reqString_(args.url));
  var orig = normalizeLine(reqString_(args.orig));
  var cat = reqString_(args.cat).trim();
  var note = optNote_(args.note);
  var titles = textList_(args.titles);
  if (!url || !orig || !cat || orig.length > LIMITS.orig || titles.length > LIMITS.variants) failure_('bad_request');
  var db = db_();
  if (readAll_(db).cats.indexOf(cat) === -1) failure_('bad_request');
  return withLock_(function () {
    var all = readAll_(db);
    var id = extractId(url) || nextSerialId(all.items.map(function (i) { return i.id; }));
    if (all.byId[id]) failure_('duplicate', { existing: all.byId[id] });
    var now = new Date(), row = db.news.getLastRow() + 1;
    writeText_(db.news, row, 1, [[id, cat, orig, url, note]]);
    writeTime_(db.news, row, 6, null);
    writeNumber_(db.news, row, 7, 0);
    writeTime_(db.news, row, 8, now);
    appendEditRows_(db, id, titles.map(function (t, i) { return { ver: i + 1, t: t }; }), now);
    return { item: readAll_(db).byId[id] };
  });
}

function updateItem_(args) {
  var id = reqString_(args.id), cat = reqString_(args.cat).trim(), note = optNote_(args.note);
  var edit = args.edit === undefined ? [] : args.edit, remove = args.remove === undefined ? [] : args.remove;
  if (!Array.isArray(edit) || !Array.isArray(remove) || !cat) failure_('bad_request');
  var seen = {};
  var edits = edit.map(function (e) {
    if (!e || typeof e !== 'object' || typeof e.ver !== 'number' || Math.floor(e.ver) !== e.ver || seen[e.ver]) failure_('bad_request');
    seen[e.ver] = true;
    var t = normalizeText(reqString_(e.t));
    if (!t || t.length > LIMITS.title) failure_('bad_request');
    return { ver: e.ver, t: t };
  });
  remove.forEach(function (v) {
    if (typeof v !== 'number' || Math.floor(v) !== v || seen[v]) failure_('bad_request');
    seen[v] = true;
  });
  var add = textList_(args.add);
  var db = db_();
  return withLock_(function () {
    var all = readAll_(db), item = all.byId[id];
    if (!item) failure_('not_found');
    var has = function (v) { return !!(all.verRow[id] && all.verRow[id][v]); };
    if (edits.some(function (e) { return !has(e.ver); }) || remove.some(function (v) { return !has(v); })) failure_('stale');
    if (item.titles.length - remove.length + add.length > LIMITS.variants) failure_('bad_request');
    if (cat !== item.cat && all.cats.indexOf(cat) === -1) failure_('bad_request');
    var maxVer = item.titles.reduce(function (m, v) { return Math.max(m, v.ver); }, 0);
    var row = all.newsRow[id];
    writeText_(db.news, row, 2, [[cat]]);
    writeText_(db.news, row, 5, [[note]]);
    edits.forEach(function (e) { writeText_(db.edits, all.verRow[id][e.ver], 3, [[e.t]]); });
    remove.map(function (v) { return all.verRow[id][v]; }).sort(function (a, b) { return b - a; })
      .forEach(function (r) { db.edits.deleteRow(r); });
    appendEditRows_(db, id, add.map(function (t, i) { return { ver: maxVer + 1 + i, t: t }; }), new Date());
    return { item: readAll_(db).byId[id] };
  });
}

function deleteItem_(args) {
  var id = reqString_(args.id);
  var db = db_();
  return withLock_(function () {
    var all = readAll_(db);
    if (!all.byId[id]) failure_('not_found');
    (all.editRows[id] || []).slice().sort(function (a, b) { return b - a; }).forEach(function (r) { db.edits.deleteRow(r); });
    db.news.deleteRow(all.newsRow[id]);
    return { id: id };
  });
}

function markUsed_(args) {
  var id = reqString_(args.id);
  var ver = args.ver;
  if (ver !== undefined && (typeof ver !== 'number' || Math.floor(ver) !== ver)) failure_('bad_request');
  var db = db_();
  return withLock_(function () {
    var all = readAll_(db), item = all.byId[id];
    if (!item) failure_('not_found');
    var variant = null;
    if (item.titles.length) {
      if (ver === undefined) failure_('bad_request');
      variant = item.titles.filter(function (v) { return v.ver === ver; })[0];
      if (!variant) failure_('stale');
    }
    var now = new Date(), row = all.newsRow[id];
    writeTime_(db.news, row, 6, now);
    writeNumber_(db.news, row, 7, item.count + 1);
    if (variant) {
      var vr = all.verRow[id][ver];
      writeTime_(db.edits, vr, 4, now);
      writeNumber_(db.edits, vr, 5, variant.count + 1);
    }
    return { item: readAll_(db).byId[id] };
  });
}

function fetchTitle_(args) {
  var url = normalizeUrl(reqString_(args.url));
  if (!url) failure_('bad_request');
  var empty = { title: null, source: null };
  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true, timeoutSeconds: 8,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9'
      }
    });
    if (res.getResponseCode() !== 200) return empty;
    var found = titleFromHtml(res.getContentText('UTF-8'));
    return found ? { title: found.title, source: found.source } : empty;
  } catch (e) {
    return empty;   // 失敗不阻擋儲存，網頁會提示手動輸入
  }
}

var ACTIONS = {
  ping: ping_, listItems: listItems_, addItem: addItem_, updateItem: updateItem_,
  deleteItem: deleteItem_, markUsed: markUsed_, fetchTitle: fetchTitle_
};

/* ---------- 編輯器內手動執行：授權與初始化（不印出密碼與 ID 的值） ---------- */
function setup() {
  var db = db_();
  db.ss.setSpreadsheetTimeZone('Asia/Taipei');
  var props = PropertiesService.getScriptProperties();
  var tok = props.getProperty('API_TOKEN');
  Logger.log('API_TOKEN：' + (tok ? (tok.length >= 32 ? '已設定' : '已設定但長度不足 32') : '尚未設定'));
  Logger.log('SHEET_ID：' + (props.getProperty('SHEET_ID') ? '已設定' : '尚未設定'));
  UrlFetchApp.fetch('https://example.com', { muteHttpExceptions: true });   // 觸發外部請求授權
  LockService.getScriptLock();
  Logger.log('完成：分頁已就緒（' + SHEET.news + '、' + SHEET.edits + '、' + SHEET.cats + '）。下一步：部署 → 新增部署作業 → 網頁應用程式。');
}
