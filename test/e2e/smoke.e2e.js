// 精簡冒煙測試：用記憶體假 API 走過主要流程（設定 → 列表 → 輪播 → 複製 → 標記 → 新增 → 編輯 → 刪除）
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSite } = require('../../scripts/build-site.js');
const { createFakeApi, seedSample, TOKEN } = require('../helpers/fake-api.js');

const API_URL = 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
let server, origin, browser, outDir;

test.before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-site-'));
  buildSite({ outDir, sha: 'abcdef0123456789' });
  server = http.createServer((req, res) => {
    const f = path.join(outDir, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!f.startsWith(outDir) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'text/plain' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch();
});
test.after(async () => { await browser.close(); server.close(); });

async function open(t, { sample = true } = {}) {
  const api = createFakeApi();
  if (sample) seedSample(api);
  const ctx = await browser.newContext({ timezoneId: 'Asia/Taipei', locale: 'zh-TW', viewport: { width: 900, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { problems.push('native dialog: ' + d.type()); d.dismiss(); });
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => { (window.__csp = window.__csp || []).push(e.violatedDirective); }));
  const requests = [];
  await page.route(API_URL, async (route) => {
    const r = route.request();
    requests.push({ method: r.method(), type: r.headers()['content-type'] });
    await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' },
      body: r.method() === 'POST' ? api.raw(r.postData()) : 'ok' });
  });
  await page.goto(origin + '/');
  t.after(async () => {
    const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
    await ctx.close();
    assert.deepEqual(problems, []);
    assert.deepEqual(csp, []);
    assert.ok(requests.every((x) => x.method === 'POST' && x.type === 'text/plain;charset=utf-8'), 'only simple POST requests');
  });
  return { page, api, requests };
}

async function connect(page, remember = false) {
  await page.fill('#sUrl', ' ' + API_URL + '\n');
  await page.fill('#sToken', '  ' + TOKEN + '\n');
  if (remember) await page.check('#sRemember');
  await page.click('#sSave');
  await page.waitForSelector('#settingsDlg', { state: 'hidden' });
}

test('首次開啟跳出設定；連線後載入列表；密碼預設不寫入 localStorage', async (t) => {
  const { page } = await open(t);
  await page.waitForSelector('#settingsDlg[open]');
  assert.equal(await page.getAttribute('#sToken', 'type'), 'password');
  await connect(page);
  assert.equal(await page.locator('.item').count(), 3);
  assert.equal(await page.evaluate(() => localStorage.getItem('hotnews.v1.token')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('hotnews.v1.url')), API_URL);
  await page.reload();
  await page.waitForSelector('#settingsDlg[open]');
  assert.equal(await page.inputValue('#sUrl'), API_URL);
  assert.equal(await page.inputValue('#sToken'), '');
});

test('密碼錯誤顯示訊息、網址格式錯誤不送出請求', async (t) => {
  const { page, requests } = await open(t);
  await page.waitForSelector('#settingsDlg[open]');
  await page.fill('#sUrl', 'https://example.com'); await page.fill('#sToken', TOKEN); await page.click('#sSave');
  await page.waitForSelector('#sMsg:not([hidden])');
  assert.equal(requests.length, 0);
  await page.fill('#sUrl', API_URL); await page.fill('#sToken', 'x'.repeat(48)); await page.click('#sSave');
  await page.waitForFunction(() => document.getElementById('sMsg').textContent.includes('密碼不正確'));
});

test('列表、排序、搜尋、分類篩選與安全輸出', async (t) => {
  const { page, api } = await open(t);
  api.seed({ id: '777', cat: '財經', url: 'javascript:alert(1)', orig: '<img src=x onerror="window.__pwned=1">', note: '</script><b>x</b>',
    titles: [{ ver: 1, t: '<b>粗體</b>', last: null, count: 0 }], created: api.st.now });
  await connect(page);
  assert.deepEqual(await page.$$eval('.item', (els) => els.map((e) => e.dataset.id)), ['4031880', '4028301', '777', '4032757']);   // 最久未用優先
  assert.equal(await page.locator('.item[data-id="4032757"] .cat').textContent(), '生活');
  assert.equal(await page.locator('img, .item b:not(.used b)').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('.item[data-id="777"] a.link').getAttribute('href'), null);
  assert.match(await page.locator('#chips').textContent(), /財經1/);
  await page.fill('#q', '(');
  assert.match(await page.locator('#list').textContent(), /沒有符合的新聞/);
  await page.fill('#q', '行家');
  assert.deepEqual(await page.$$eval('.item', (els) => els.map((e) => e.dataset.id)), ['4032757']);
  await page.fill('#q', '');
  await page.click('.chip[data-cat="社會"]');
  assert.equal(await page.locator('.item').count(), 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});

test('輪播按鈕換版、複製標題與留言、兩段式標記已使用', async (t) => {
  const { page, api } = await open(t);
  await connect(page);
  const card = page.locator('.item[data-id="4032757"]');
  assert.equal((await card.locator('.cnt').textContent()), '第 1 / 3 版');
  await card.locator('[data-act=next]').click();
  await page.waitForFunction(() => document.querySelector('.item[data-id="4032757"] .cnt').textContent === '第 2 / 3 版');
  await card.locator('[data-act=ctitle]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '愛車多久該保養一次？\n行家：別等警示燈亮');
  await card.locator('[data-act=cnote]').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '你多久保養一次車？\n留言分享你的習慣 👇\nhttps://news.tvbs.com.tw/news/4032757');
  await card.locator('[data-act=mark]').click();
  assert.match(await card.locator('[data-act=mark]').textContent(), /再按一次確認（第 2 版）/);
  assert.equal(api.st.calls.filter((c) => c.action === 'markUsed').length, 0);
  await card.locator('[data-act=mark]').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已記錄第 2 版使用'));
  assert.deepEqual(api.st.calls.filter((c) => c.action === 'markUsed').map((c) => c.args), [{ id: '4032757', ver: 2 }]);
  assert.equal(await card.locator('.cnt').textContent(), '第 2 / 3 版');
});

test('新增（自動帶入標題）→ 編輯 → 兩段式刪除', async (t) => {
  const { page, api } = await open(t);
  await connect(page);
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/4040001');
  await page.waitForFunction(() => document.getElementById('fOrig').value === '自動帶入的原始標題');
  assert.match(await page.textContent('#idHint'), /編號 4040001/);
  assert.match(await page.textContent('#titleHint'), /來自 og:title/);
  await page.fill('#vars textarea', '第一版\r\n第二行 \r\n');
  await page.fill('#fNote', '小編文\r\n\r\n');
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.deepEqual(api.st.items.find((i) => i.id === '4040001').titles.map((v) => v.t), ['第一版\n第二行']);
  assert.equal(api.st.items.find((i) => i.id === '4040001').note, '小編文');

  await page.fill('#q', '4040001');
  await page.click('.item[data-id="4040001"] [data-act=edit]');
  assert.equal(await page.getAttribute('#fUrl', 'readonly'), '');
  await page.click('#addVar');
  await page.locator('#vars textarea').last().fill('第二版');
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.deepEqual(api.st.items.find((i) => i.id === '4040001').titles.map((v) => [v.ver, v.t]), [[1, '第一版\n第二行'], [2, '第二版']]);

  await page.click('.item[data-id="4040001"] [data-act=edit]');
  await page.click('#del');
  assert.equal(api.st.calls.filter((c) => c.action === 'deleteItem').length, 0);
  assert.match(await page.textContent('#del'), /再按一次刪除/);
  await page.click('#del');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.equal(api.st.items.some((i) => i.id === '4040001'), false);
});

test('重複網址提示並可轉為編輯；連點儲存只送一次', async (t) => {
  const { page, api } = await open(t);
  await connect(page);
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/cars/4032757');
  await page.click('#dlgTitle');
  await page.waitForFunction(() => document.getElementById('idHint').textContent.includes('已存在'));
  await page.click('#idHint button');
  assert.equal(await page.textContent('#dlgTitle'), '編輯 #4032757');
  await page.click('#cancel');
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/5000001');
  await page.fill('#fOrig', '手動標題');
  await page.evaluate(() => { for (let i = 0; i < 5; i++) document.getElementById('save').click(); });
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.equal(api.st.calls.filter((c) => c.action === 'addItem').length, 1);
});
