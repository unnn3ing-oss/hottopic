const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite } = require('../scripts/build-site.js');

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://*.workers.dev; img-src 'self' data:; base-uri 'none'; form-action 'none'";
const IDS = ['settingsBtn', 'addBtn', 'q', 'sort', 'chips', 'cnt', 'list', 'card', 'settingsDlg', 'settingsForm', 'sUrl', 'sToken',
  'sRemember', 'sMsg', 'sSteps', 'sClear', 'sSave', 'dlg', 'form', 'dlgTitle', 'fUrl', 'idHint', 'fCat', 'fOrig',
  'titleHint', 'vars', 'addVar', 'fNote', 'err', 'del', 'cancel', 'save', 'toast'];

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
const sha = 'abcdef0123456789abcdef0123456789abcdef01';
const built = buildSite({ outDir: out, sha });
const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
const html = read('index.html');

test('輸出恰為五個檔，lib.js 與 apps-script/lib.js 相同', () => {
  assert.deepEqual(fs.readdirSync(out).sort(), ['api.js', 'app.css', 'app.js', 'index.html', 'lib.js']);
  assert.deepEqual(built.files.slice().sort(), ['api.js', 'app.css', 'app.js', 'index.html', 'lib.js']);
  assert.ok(fs.readFileSync(path.join(out, 'lib.js')).equals(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'lib.js'))));
});

test('head 第一個元素是 CSP meta，內容完全相符；有 referrer 與 robots', () => {
  const head = /<head>\s*([\s\S]*?)<\/head>/i.exec(html)[1];
  const first = /^<meta\b[^>]*>/i.exec(head.trim())[0];
  assert.match(first, /http-equiv="Content-Security-Policy"/);
  assert.equal(/content="([^"]*)"/.exec(first)[1], CSP);
  assert.match(head, /<meta name="referrer" content="no-referrer">/);
  assert.match(head, /<meta name="robots" content="noindex">/);
  assert.match(head, /<meta charset="utf-8">/i);
  assert.match(html, /<html lang="zh-Hant-TW">/);
});

test('沒有行內 script/style/事件屬性，資源皆為相對路徑並帶 ?v=', () => {
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son\w+=/i);
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) assert.match(m[0], /\ssrc="/);
  const refs = [...html.matchAll(/\s(?:src|href)="([^"]*)"/gi)].map((m) => m[1]).filter((v) => v !== 'data:,');
  assert.equal(refs.length, 4, refs.join(','));
  for (const r of refs) assert.match(r, /^(app\.css|lib\.js|api\.js|app\.js)\?v=abcdef012345$/);
  assert.doesNotMatch(html, /(?:src|href|action)="(?:https?:)?\/\//i);
  const order = refs.filter((r) => r.endsWith('.js') || /\.js\?/.test(r)).map((r) => r.split('?')[0]);
  assert.deepEqual(order, ['lib.js', 'api.js', 'app.js']);
});

test('DOM 契約的 id 都存在，排序選項值正確', () => {
  for (const id of IDS) assert.match(html, new RegExp('\\sid="' + id + '"'), id);
  assert.match(html, /<input[^>]*id="sToken"[^>]*type="password"|<input[^>]*type="password"[^>]*id="sToken"/);
  const sort = /<select[^>]*id="sort"[\s\S]*?<\/select>/.exec(html)[0];
  assert.deepEqual([...sort.matchAll(/value="([^"]+)"/g)].map((m) => m[1]), ['oldest', 'recent', 'count', 'created']);
});

test('app.css 沒有 @import / @font-face / url(', () => {
  const css = read('app.css');
  assert.doesNotMatch(css, /@import|@font-face|url\(/);
});

test('sha 格式不合時退回 dev', () => {
  const o2 = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  buildSite({ outDir: o2, sha: '$(rm -rf)' });
  assert.match(fs.readFileSync(path.join(o2, 'index.html'), 'utf8'), /app\.css\?v=dev/);
});
