const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadLib, createLibContext } = require('./helpers/load-lib.js');

const lib = loadLib();

test('測試沙箱沒有 URL / TextEncoder / document（等同 Apps Script）', () => {
  const ctx = createLibContext();
  for (const name of ['URL', 'URLSearchParams', 'TextEncoder', 'document', 'window']) {
    assert.equal(vm.runInContext('typeof ' + name, ctx), 'undefined', name);
  }
});

test('常數', () => {
  assert.equal(lib.COMMENT_BASE_URL, 'https://news.tvbs.com.tw/news/');
  assert.deepEqual(JSON.parse(JSON.stringify(lib.LIMITS)), { url: 2000, orig: 500, title: 500, note: 5000, variants: 20 });
});

test('extractId', () => {
  const cases = [
    ['https://news.tvbs.com.tw/cars/4032757', '4032757'],
    ['https://news.tvbs.com.tw/politics/2024/10/4032757', '4032757'],
    ['https://news.tvbs.com.tw/local/0042', '0042'],
    ['https://news.tvbs.com.tw/local/abc', null],
    ['https://news.tvbs.com.tw/cars/4032757?from=line&utm=2025101299999', '4032757'],
    ['https://news.tvbs.com.tw/cars/4032757#c20251012999999', '4032757'],
    ['https://news2024.example.com:8080/a/77', '77'],
    ['https://u:p@h123456789.com/x/5', '5'],
    ['https://news.tvbs.com.tw/a/111/b/222', '111']
  ];
  for (const [input, want] of cases) assert.equal(lib.extractId(input), want, input);
});

test('isHttpUrl', () => {
  for (const s of ['http://a.b', 'HTTPS://a.b/x']) assert.equal(lib.isHttpUrl(s), true, s);
  for (const s of ['javascript:alert(1)', 'ftp://a.b', '//a.b', '', 'https://a b']) assert.equal(lib.isHttpUrl(s), false, s);
});

test('normalizeUrl 接受', () => {
  assert.equal(lib.normalizeUrl(' https://news.tvbs.com.tw/cars/4032757 \n'), 'https://news.tvbs.com.tw/cars/4032757');
  assert.equal(lib.normalizeUrl('https://x.com:443/a'), 'https://x.com:443/a');
});

test('normalizeUrl 拒絕', () => {
  const bad = ['ftp://x.com/1', 'javascript:alert(1)', 'https://user:pw@x.com/1', 'http://127.0.0.1/1',
    'http://192.168.0.1/x', 'http://2130706433/', 'http://[::1]/1', 'http://localhost/1', 'http://foo.localhost/1',
    'https://x.com:8443/1', 'news.tvbs.com.tw/cars/1', 'https://x.com/a b', 'https://x.com/' + 'a'.repeat(2000)];
  for (const s of bad) assert.equal(lib.normalizeUrl(s), null, s);
});

test('nextSerialId', () => {
  assert.equal(lib.nextSerialId([]), 'N1');
  assert.equal(lib.nextSerialId(['4032757']), 'N1');
  assert.equal(lib.nextSerialId(['N1', 'N7', 'N3', '4032757']), 'N8');
  assert.equal(lib.nextSerialId(['N2', 'n9']), 'N3');
});

test('normalizeText', () => {
  assert.equal(lib.normalizeText('a\r\nb\r\n\r\n'), 'a\nb');
  assert.equal(lib.normalizeText(' \n  標題\n第二行  \n\n'), '  標題\n第二行');
  assert.equal(lib.normalizeText('   '), '');
  assert.equal(lib.normalizeText('a\u0000b\u0007c'), 'abc');
  assert.equal(lib.normalizeText('a\tb'), 'a\tb');
  assert.equal(lib.normalizeText('你好 👇'), '你好 👇');
});

test('normalizeLine', () => {
  assert.equal(lib.normalizeLine('a\n b \r\n c'), 'a b c');
  assert.equal(lib.normalizeLine(' x '), 'x');
});

test('buildComment', () => {
  const note = '你多久保養一次車？\n留言分享你的習慣 👇';
  const base = 'https://news.tvbs.com.tw/news/4032757';
  assert.equal(lib.buildComment({ id: '4032757', url: 'https://news.tvbs.com.tw/cars/4032757', note }), note + '\n' + base);
  for (const empty of ['', ' \n ']) {
    assert.equal(lib.buildComment({ id: '4032757', url: 'https://news.tvbs.com.tw/cars/4032757', note: empty }), base);
  }
  const noBlank = lib.buildComment({ id: '4032757', url: 'x', note: '留言\n\n' });
  assert.equal(noBlank.includes('\n\n'), false);
  assert.equal(noBlank, '留言\n' + base);
  assert.equal(lib.buildComment({ id: 'N3', url: 'https://example.com/a', note: 'hi' }), 'hi\nhttps://example.com/a');
  assert.equal(lib.buildComment({ id: 'N3', url: 'https://example.com/a', note: '' }), 'https://example.com/a');
});
