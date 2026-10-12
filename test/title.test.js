const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./helpers/load-lib.js').loadLib();

const TVBS = fs.readFileSync(path.join(__dirname, 'fixtures', 'tvbs-head.html'), 'utf8');
const plain = (x) => JSON.parse(JSON.stringify(x));   // 跨 vm 領域的物件先轉成本地物件再比較
const og = (t) => '<head><meta property="og:title" content="' + t + '"></head>';

test('TVBS 實測標記解析結果與原文相同', () => {
  assert.deepEqual(plain(lib.titleFromHtml(TVBS)), { title: '買二手車別只看外觀、里程數！「4大陷阱」小心、這些地方要檢查', source: 'og:title' });
});

test('來源順序與退回', () => {
  assert.equal(lib.titleFromHtml('<head><meta name="twitter:title" content="T"></head>').source, 'twitter:title');
  assert.deepEqual(plain(lib.titleFromHtml('<head><title>只有 title</title></head>')), { title: '只有 title', source: 'title' });
  assert.deepEqual(plain(lib.titleFromHtml('<head></head><body><h1>只有 <span>h1</span></h1></body>')), { title: '只有 h1', source: 'h1' });
  assert.equal(lib.titleFromHtml('<head><meta property="og:title" content="  "><title>退回</title></head>').title, '退回');
  assert.equal(lib.titleFromHtml('<head></head><body>沒有標題</body>'), null);
});

test('meta 變形：屬性順序、單引號、name、大小寫', () => {
  assert.equal(lib.titleFromHtml('<head><meta content="A" property="og:title"></head>').title, 'A');
  assert.equal(lib.titleFromHtml("<head><meta property='og:title' content='B'></head>").title, 'B');
  assert.equal(lib.titleFromHtml('<head><meta name="og:title" content="C"></head>').title, 'C');
  assert.equal(lib.titleFromHtml('<HEAD><META PROPERTY="OG:TITLE" CONTENT="D"></HEAD>').title, 'D');
});

test('實體只還原一次，非法實體不丟例外', () => {
  assert.equal(lib.titleFromHtml(og('&amp;lt;')).title, '&lt;');
  assert.equal(lib.titleFromHtml(og('&quot;a&quot; &#39;b&#39; &#x27;c&#x27; &apos;d&apos;&nbsp;e')).title, '"a" \'b\' \'c\' \'d\' e');
  assert.doesNotThrow(() => lib.titleFromHtml(og('x&#99999999;y')));
});

test('空白與控制字元清理', () => {
  assert.equal(lib.titleFromHtml(og('a\n  b\t c')).title, 'a b c');
  assert.equal(lib.titleFromHtml(og('a‮b‏c\u0007d')).title, 'abcd');
});

test('範圍：</head> 之後、註解、script、style 內的假標籤被忽略', () => {
  assert.equal(lib.titleFromHtml('<head></head><body><meta property="og:title" content="假"></body>'), null);
  assert.equal(lib.titleFromHtml('<head><!-- <meta property="og:title" content="假"> --><script>var a=\'<meta property="og:title" content="假2">\'</script><style>/*<title>假3</title>*/</style><title>真</title></head>').title, '真');
  const big = '<html>' + 'x'.repeat(lib.HTML_SCAN_LIMIT) + '<meta property="og:title" content="太遠">';
  assert.equal(lib.titleFromHtml(big), null);
});

test('防機器人頁面不當成標題', () => {
  for (const t of ['Just a moment...', 'Attention Required! | Cloudflare', 'Access denied', 'Verify you are human', '請稍候…']) {
    assert.equal(lib.titleFromHtml('<head><title>' + t + '</title></head><body><h1>內文</h1></body>'), null, t);
  }
});

test('cleanTitle 只裁掉已知網站後綴', () => {
  assert.equal(lib.cleanTitle('台灣新聞 ｜ TVBS新聞網', ['TVBS新聞網']), '台灣新聞');
  assert.equal(lib.cleanTitle('台灣新聞|TVBS新聞網', ['TVBS新聞網']), '台灣新聞');
  assert.equal(lib.cleanTitle('台灣新聞 - TVBS新聞網', ['TVBS新聞網']), '台灣新聞');
  assert.equal(lib.cleanTitle('TVBS新聞網是好網站', ['TVBS新聞網']), 'TVBS新聞網是好網站');
  assert.equal(lib.cleanTitle('A｜B', ['TVBS新聞網']), 'A｜B');
  assert.equal(lib.cleanTitle('台灣新聞 ｜ TVBS新聞網'), '台灣新聞 ｜ TVBS新聞網');   // 預設後綴清單為空
  assert.deepEqual(plain(lib.SITE_SUFFIXES), []);
});
