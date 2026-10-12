/* 純函式與常數：Apps Script、瀏覽器、node 測試共用同一份。
 * 限制：不得使用 URL、URLSearchParams、DOMParser、window、document、TextEncoder；
 * 頂層只用 var 與 function；語法限 ES2019 以內。 */

var COMMENT_BASE_URL = 'https://news.tvbs.com.tw/news/';
var LIMITS = { url: 2000, orig: 500, title: 500, note: 5000, variants: 20 };

// 編號 = 網址路徑中最長的一串數字（同長取先出現者）；忽略主機、帳密、埠、query、hash
function extractId(url) {
  var s = String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^\/]*/i, '').replace(/[?#].*$/, '');
  var runs = s.match(/\d+/g);
  if (!runs) return null;
  var best = runs[0];
  for (var i = 1; i < runs.length; i++) if (runs[i].length > best.length) best = runs[i];
  return best;
}

function isHttpUrl(s) {
  return /^https?:\/\/[^\s]+$/i.test(String(s || ''));
}

// 去頭尾空白後回傳；不合規回 null（只允許 http/https、無帳密、非 IP、非 localhost、埠 80/443）
function normalizeUrl(s) {
  if (typeof s !== 'string') return null;
  var u = s.replace(/^\s+|\s+$/g, '');
  if (!u || u.length > LIMITS.url || /\s/.test(u)) return null;
  var m = /^https?:\/\/([^\/?#]*)(?:[\/?#]|$)/i.exec(u);
  if (!m) return null;
  var authority = m[1];
  if (!authority || authority.indexOf('@') !== -1 || authority.charAt(0) === '[') return null;
  var host = authority, port = '';
  var colon = authority.lastIndexOf(':');
  if (colon !== -1) { host = authority.slice(0, colon); port = authority.slice(colon + 1); }
  if (port !== '' && port !== '80' && port !== '443') return null;
  if (!host || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return null;
  var h = host.toLowerCase();
  if (h === 'localhost' || /\.localhost$/.test(h)) return null;
  return u;
}

// 沒有數字的網址用 N + 流水號作編號
function nextSerialId(ids) {
  var max = 0;
  for (var i = 0; i < ids.length; i++) {
    var m = /^N(\d+)$/.exec(String(ids[i]));
    if (m && Number(m[1]) > max) max = Number(m[1]);
  }
  return 'N' + (max + 1);
}

// 換行統一 \n、去控制字元（保留 \n 與 \t）、去頭部空白行與尾部空白
function normalizeText(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '');
}

// 單行文字（原始標題用）：換行壓成單一空格
function normalizeLine(s) {
  return normalizeText(s).replace(/\s*\n\s*/g, ' ').replace(/^\s+|\s+$/g, '');
}

// 留言 = 小編文 + "\n" + 網址；小編文為空只輸出網址；N 開頭編號改用原文連結
function buildComment(item) {
  var note = normalizeText(item.note);
  var link = /^N/.test(String(item.id)) ? String(item.url) : COMMENT_BASE_URL + item.id;
  return note ? note + '\n' + link : link;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    COMMENT_BASE_URL: COMMENT_BASE_URL, LIMITS: LIMITS, extractId: extractId, isHttpUrl: isHttpUrl,
    normalizeUrl: normalizeUrl, nextSerialId: nextSerialId, normalizeText: normalizeText,
    normalizeLine: normalizeLine, buildComment: buildComment
  };
}
