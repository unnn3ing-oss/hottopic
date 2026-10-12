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

/* ---------- 標題抽取（Apps Script 伺服器端用；沒有 DOMParser，改用規則運算式） ---------- */
var TITLE_SOURCES = ['og:title', 'twitter:title', 'title', 'h1'];
var SITE_SUFFIXES = [];                 // 已知網站名稱後綴；預設空（規格：不先猜）
var HTML_SCAN_LIMIT = 300 * 1024;
var BLOCKED_TITLE_PATTERNS = [/^just a moment/i, /attention required/i, /^access denied/i, /verify you are human/i,
  /checking your browser/i, /are you a robot/i, /請稍候/];

function escapeRegExp_(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 單次 replace 還原實體（&amp;lt; → &lt;，不會二次還原）；非法數字實體移除
function decodeEntities_(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, function (m, dec, hex, name) {
    if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[name.toLowerCase()];
    var code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (!isFinite(code) || code < 1 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '';
    return String.fromCodePoint(code);
  });
}

// 壓空白、去控制字元與雙向控制字元，並裁掉「分隔符號＋已知網站名稱」的結尾
function cleanTitle(s, suffixes) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/^ +| +$/g, '');
  var list = suffixes || SITE_SUFFIXES;
  for (var i = 0; i < list.length; i++) {
    var m = new RegExp('^(.*\\S)\\s*[｜|\\-–—]\\s*' + escapeRegExp_(list[i]) + '$').exec(t);
    if (m) { t = m[1]; break; }
  }
  return t;
}

function isBlockedTitle_(t) {
  for (var i = 0; i < BLOCKED_TITLE_PATTERNS.length; i++) if (BLOCKED_TITLE_PATTERNS[i].test(t)) return true;
  return false;
}

// 回傳 { title, source } 或 null；遇到防機器人頁面的標題一律回 null
function titleFromHtml(html, suffixes) {
  var s = String(html || '').slice(0, HTML_SCAN_LIMIT)
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  var end = /<\/head\s*>/i.exec(s);
  var head = end ? s.slice(0, end.index) : s;
  var metas = {};
  var tags = head.match(/<meta\b[^>]*>/gi) || [];
  for (var i = 0; i < tags.length; i++) {
    var attrs = {}, re = /([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, m;
    while ((m = re.exec(tags[i]))) attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    var key = String(attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in metas)) metas[key] = attrs.content;
  }
  var tm = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  var hm = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(s);
  var raw = { 'og:title': metas['og:title'], 'twitter:title': metas['twitter:title'],
    'title': tm && tm[1], 'h1': hm && hm[1].replace(/<[^>]+>/g, '') };
  for (var j = 0; j < TITLE_SOURCES.length; j++) {
    var v = raw[TITLE_SOURCES[j]];
    if (v === undefined || v === null) continue;
    var t = cleanTitle(decodeEntities_(String(v)), suffixes);
    if (!t) continue;
    if (isBlockedTitle_(t)) return null;
    return { title: t, source: TITLE_SOURCES[j] };
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    COMMENT_BASE_URL: COMMENT_BASE_URL, LIMITS: LIMITS, extractId: extractId, isHttpUrl: isHttpUrl,
    normalizeUrl: normalizeUrl, nextSerialId: nextSerialId, normalizeText: normalizeText,
    normalizeLine: normalizeLine, buildComment: buildComment,
    TITLE_SOURCES: TITLE_SOURCES, SITE_SUFFIXES: SITE_SUFFIXES, HTML_SCAN_LIMIT: HTML_SCAN_LIMIT,
    cleanTitle: cleanTitle, titleFromHtml: titleFromHtml
  };
}
