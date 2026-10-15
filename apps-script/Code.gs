/* 熱門新聞庫 後端：Google Apps Script Web App（JSON API）。
 * 協定：POST text/plain 的 JSON {token, action, args}；回應 HTTP 永遠 200：{ok:true,data} 或 {ok:false,code,error?,existing?}。
 * 純函式與常數在 lib.js（Apps Script 檔案載入順序不保證，所以載入時不讀 lib.js 的全域值，只在函式內讀）。
 * 指令碼屬性：API_TOKEN（至少 32 字元）、SHEET_ID（試算表 ID）。 */

var SHEET = { news: '新聞', edits: '改標', cats: '分類' };
var HEADERS = {
  news: ['id', '分類', '原始標題', '原文連結', '小編文', '上次使用時間', '使用次數', '建立時間', '到期日'],
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

// 試算表每次呼叫都是一次網路往返（約 0.1–0.3 秒），所以一律「整塊範圍一次寫入」：
// 先 setNumberFormats（文字欄 '@'，避免 =、+、-、@ 開頭被當公式、0042 被吃掉前導零），再 setValues。
var FMT_TEXT = '@', FMT_NUM = '0';
function writeBlock_(sheet, row, col, formats, rows) {
  var range = sheet.getRange(row, col, rows.length, formats.length);
  range.setNumberFormats(rows.map(function () { return formats; }));
  range.setValues(rows);
}
function writeText_(sheet, row, col, values) {
  writeBlock_(sheet, row, col, values[0].map(function () { return FMT_TEXT; }), values);
}
function newsFormats_() { return [FMT_TEXT, FMT_TEXT, FMT_TEXT, FMT_TEXT, FMT_TEXT, DATE_FORMAT, FMT_NUM, DATE_FORMAT, FMT_TEXT]; }
function editFormats_() { return [FMT_TEXT, FMT_NUM, FMT_TEXT, DATE_FORMAT, FMT_NUM, DATE_FORMAT]; }

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
function rows_(sheet, cols) {   // 一次呼叫讀整頁（含標題列），去掉標題後補齊欄數
  var all = sheet.getDataRange().getValues();
  var out = all.slice(1).map(function (r) { while (r.length < cols) r.push(''); return r; });
  out.header = all[0] || [];
  return out;
}

// 到期日欄：文字 'YYYY-MM-DD'；手動輸入成日期儲存格時換算成台北日期；其他（空白、亂填）一律當作沒設
function expiresOf_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : dateStrTaipei(v.getTime());
  var t = str_(v).trim();
  return isDateStr(t) ? t : null;
}

// 讀整份資料；手動編輯造成的壞資料（空白列、孤兒改標、非數字版本號…）略過而不是整個失敗
function readAll_(db, light) {   // light：只讀新聞與分類（新增時只需要編號與分類，不讀改標）
  var items = [], byId = {}, newsRow = {}, editRows = {}, verRow = {};
  var newsRows = rows_(db.news, 9);
  if (str_(newsRows.header[8]).trim() !== HEADERS.news[8]) writeText_(db.news, 1, 9, [[HEADERS.news[8]]]);   // 舊試算表補上「到期日」標題
  newsRows.forEach(function (r, i) {
    var id = str_(r[0]).trim();
    if (!id || byId[id]) return;
    var item = { id: id, cat: str_(r[1]).trim(), orig: str_(r[2]), url: str_(r[3]), note: str_(r[4]),
      last: toMs_(r[5]), count: toInt_(r[6]), created: toMs_(r[7]) || 0, expires: expiresOf_(r[8]), titles: [] };
    byId[id] = item; newsRow[id] = i + 2; items.push(item);
  });
  (light ? [] : rows_(db.edits, 6)).forEach(function (r, i) {
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

function appendEditRows_(db, id, vers, now) {   // vers: [{ver, t}]；整批一次寫入
  if (!vers.length) return;
  writeBlock_(db.edits, db.edits.getLastRow() + 1, 1, editFormats_(),
    vers.map(function (v) { return [id, v.ver, v.t, '', 0, now]; }));
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

var MIN_LAST_MS = Date.UTC(2000, 0, 1), CLOCK_SKEW_MS = 5 * 60 * 1000;
// 到期日：沒填（undefined／null／空字串）回 null；有填必須是真實存在的 YYYY-MM-DD
function optExpires_(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!isDateStr(v)) failure_('bad_request');
  return v;
}
// 新增時就已使用過的時間（毫秒）：不得早於 2000 年，也不得晚於現在超過 5 分鐘（容許本機時鐘誤差）
function optLast_(v, nowMs) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v || v < MIN_LAST_MS || v > nowMs + CLOCK_SKEW_MS) failure_('bad_request');
  return v;
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
  var expires = optExpires_(args.expires), last = optLast_(args.last, new Date().getTime());
  if (!url || !orig || !cat || orig.length > LIMITS.orig || titles.length > LIMITS.variants) failure_('bad_request');
  var db = db_();
  return withLock_(function () {
    var all = readAll_(db, true);   // 只需要編號與分類；改標只在重複時才讀
    if (all.cats.indexOf(cat) === -1) failure_('bad_request');
    var id = extractId(url) || nextSerialId(all.items.map(function (i) { return i.id; }));
    if (all.byId[id]) failure_('duplicate', { existing: readAll_(db).byId[id] });
    var now = new Date();
    writeBlock_(db.news, db.news.getLastRow() + 1, 1, newsFormats_(), [[id, cat, orig, url, note, last === null ? '' : new Date(last), last === null ? 0 : 1, now, expires || '']]);
    var vers = titles.map(function (t, i) { return { ver: i + 1, t: t }; });
    appendEditRows_(db, id, vers, now);
    return { item: { id: id, cat: cat, orig: orig, url: url, note: note, last: last, count: last === null ? 0 : 1, created: now.getTime(), expires: expires,
      titles: vers.map(function (v) { return { ver: v.ver, t: v.t, last: null, count: 0 }; }) } };   // 直接組出結果，不再重讀整份資料
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
  var setExpires = args.expires !== undefined, expires = optExpires_(args.expires);
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
    writeText_(db.news, row, 2, [[cat, item.orig, item.url, note]]);   // 第 2–5 欄一次寫入（原始標題與網址原值寫回）
    if (setExpires) { writeText_(db.news, row, 9, [[expires || '']]); item.expires = expires; }
    edits.forEach(function (e) { writeText_(db.edits, all.verRow[id][e.ver], 3, [[e.t]]); });
    remove.map(function (v) { return all.verRow[id][v]; }).sort(function (a, b) { return b - a; })
      .forEach(function (r) { db.edits.deleteRow(r); });
    var added = add.map(function (t, i) { return { ver: maxVer + 1 + i, t: t }; });
    appendEditRows_(db, id, added, new Date());
    var edited = {}; edits.forEach(function (e) { edited[e.ver] = e.t; });
    var removed = {}; remove.forEach(function (v) { removed[v] = true; });
    item.cat = cat; item.note = note;   // 直接組出結果回傳，不再重讀整份
    item.titles = item.titles.filter(function (v) { return !removed[v.ver]; })
      .map(function (v) { return { ver: v.ver, t: edited[v.ver] !== undefined ? edited[v.ver] : v.t, last: v.last, count: v.count }; })
      .concat(added.map(function (v) { return { ver: v.ver, t: v.t, last: null, count: 0 }; }));
    return { item: item };
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
    writeBlock_(db.news, row, 6, [DATE_FORMAT, FMT_NUM], [[now, item.count + 1]]);
    if (variant) writeBlock_(db.edits, all.verRow[id][ver], 4, [DATE_FORMAT, FMT_NUM], [[now, variant.count + 1]]);
    item.last = now.getTime(); item.count += 1;   // 直接更新手上的資料回傳，不再重讀整份
    if (variant) { variant.last = now.getTime(); variant.count += 1; }
    return { item: item };
  });
}

// 回 {title, source, reason}；reason 只在失敗時有值：http_<狀態碼>、no_title、fetch_error（只給網頁顯示原因，不含例外內容）
var FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-TW,zh;q=0.9'
};
function fetchTitle_(args) {
  var url = normalizeUrl(reqString_(args.url));
  if (!url) failure_('bad_request');
  var res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: FETCH_HEADERS });
  } catch (e) {
    return { title: null, source: null, reason: 'fetch_error' };   // 失敗不阻擋儲存，網頁會提示手動輸入
  }
  var code = res.getResponseCode();
  if (code !== 200) return { title: null, source: null, reason: 'http_' + code };
  var found = null;
  try { found = titleFromHtml(res.getContentText('UTF-8')); } catch (e) { /* 解析失敗視為抓不到 */ }
  return found ? { title: found.title, source: found.source, reason: null } : { title: null, source: null, reason: 'no_title' };
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


/* 編輯器內手動執行：改下面的網址，看 Apps Script 對該網站實際抓到什麼（狀態碼、長度、前 300 字、解析結果） */
function debugFetchTitle() {
  var url = 'https://news.tvbs.com.tw/';   // ← 換成要測的新聞網址
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: FETCH_HEADERS });
  var text = res.getContentText('UTF-8');
  Logger.log('狀態碼：' + res.getResponseCode() + '，長度：' + text.length);
  Logger.log('開頭：' + text.slice(0, 300).replace(/\s+/g, ' '));
  Logger.log('解析結果：' + JSON.stringify(titleFromHtml(text)));
}
