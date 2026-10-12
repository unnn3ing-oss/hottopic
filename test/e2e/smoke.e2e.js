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
  assert.equal(await page.locator('.row').count(), 3);
  assert.equal(await page.locator('#card .item').count(), 1);   // 右側只有一張卡片
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
  const ids = () => page.$$eval('.row', (els) => els.map((e) => e.dataset.id));
  assert.deepEqual(await ids(), ['4031880', '4028301', '777', '4032757']);   // 最久未用優先
  assert.equal(await page.getAttribute('.row[aria-selected=true]', 'data-id'), '4031880');   // 預設選第一則
  assert.equal(await page.locator('.row[data-id="4032757"] .cat').textContent(), '生活');
  await page.click('.row[data-id="777"]');
  assert.equal(await page.getAttribute('#card .item', 'data-id'), '777');
  assert.equal(await page.locator('img, #list b, #card b:not(.used b)').count(), 0);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#card a').count(), 0);              // 不顯示原始網址連結
  assert.match(await page.locator('#card .orig').textContent(), /<img src=x/);
  assert.match(await page.locator('#chips').textContent(), /財經1/);
  await page.fill('#q', '(');
  assert.match(await page.locator('#list').textContent(), /沒有符合的新聞/);
  await page.fill('#q', '行家');
  assert.deepEqual(await ids(), ['4032757']);
  assert.equal(await page.getAttribute('#card .item', 'data-id'), '4032757');   // 選取跟著清單走
  await page.fill('#q', '');
  await page.click('.chip[data-cat="社會"]');
  assert.equal(await page.locator('.row').count(), 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});

const dotIndex = (page) => page.evaluate(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')));
const clip = (page) => page.evaluate(() => navigator.clipboard.readText());
const markCalls = (api) => api.st.calls.filter((c) => c.action === 'markUsed').map((c) => c.args);
async function pick(page, id) { await page.click('.row[data-id="' + id + '"]'); await page.waitForSelector('#card .item[data-id="' + id + '"]'); }

test('改標：箭頭（懸停才出現）、圓點、複製保留換行；兩段式手動標記', async (t) => {
  const { page, api } = await open(t);
  await connect(page);
  await pick(page, '4032757');
  const card = page.locator('#card .item');
  assert.equal(await card.locator('.dot').count(), 3);
  assert.equal(await dotIndex(page), 0);
  assert.equal(await card.locator('.arrow.r').evaluate((e) => getComputedStyle(e).opacity), '0');   // 平常隱藏
  await card.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#card .arrow.r')).opacity === '1');
  await card.locator('[data-act=next]').click();
  await page.waitForFunction(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')) === 1);
  await card.locator('.dot').nth(2).click();
  await page.waitForFunction(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')) === 2);
  await card.locator('.dot').nth(1).click();
  await page.waitForFunction(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')) === 1);
  await card.locator('[data-act=ctitle]').click();
  assert.equal(await clip(page), '愛車多久該保養一次？\n行家：別等警示燈亮');
  await card.locator('[data-act=mark]').click();                       // 手動：第一下只進入確認
  assert.match(await card.locator('[data-act=mark]').textContent(), /再按一次確認（第 2 版）/);
  assert.equal(markCalls(api).length, 0);
  await card.locator('[data-act=mark]').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已記錄第 2 版使用'));
  assert.deepEqual(markCalls(api), [{ id: '4032757', ver: 2 }]);
  assert.equal(await dotIndex(page), 1);                               // 標記後仍停在第 2 版
});

test('先複製標題、再複製留言 → 自動記為已使用（記在複製的那一版）', async (t) => {
  const { page, api } = await open(t);
  await connect(page);
  await pick(page, '4032757');
  const card = page.locator('#card .item');
  await card.hover();
  await card.locator('[data-act=next]').click();
  await page.waitForFunction(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')) === 1);
  await card.locator('[data-act=ctitle]').click();
  assert.equal(await clip(page), '愛車多久該保養一次？\n行家：別等警示燈亮');
  assert.equal(markCalls(api).length, 0);                              // 只複製標題不算使用
  await card.locator('[data-act=cnote]').click();
  assert.equal(await clip(page), '你多久保養一次車？\n留言分享你的習慣 👇\nhttps://news.tvbs.com.tw/news/4032757');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已複製留言，並記錄第 2 版使用'));
  assert.deepEqual(markCalls(api), [{ id: '4032757', ver: 2 }]);
  await page.locator('#card [data-act=cnote]').click();                // 已觸發過：再複製留言不會重複計次
  await page.waitForTimeout(300);
  assert.equal(markCalls(api).length, 1);
});

test('自動記為已使用：只複製留言、換文章、順序相反都不觸發；標題換版以最後複製的為準', async (t) => {
  const { page, api } = await open(t);
  await connect(page);
  await pick(page, '4032757');
  const card = () => page.locator('#card .item');
  await card().locator('[data-act=cnote]').click();                    // 只複製留言
  await page.waitForTimeout(300);
  assert.equal(markCalls(api).length, 0);
  await card().locator('[data-act=cnote]').click();                    // 順序相反：先留言再標題
  await card().locator('[data-act=ctitle]').click();
  await page.waitForTimeout(300);
  assert.equal(markCalls(api).length, 0);
  await pick(page, '4031880');                                         // 複製標題後換到別篇，再複製別篇留言
  await card().locator('[data-act=ctitle]').click();
  await pick(page, '4028301');
  await card().locator('[data-act=cnote]').click();
  await page.waitForTimeout(300);
  assert.equal(markCalls(api).length, 0);
  await pick(page, '4031880');                                         // 換回來也不能沿用先前複製的標題
  await card().locator('[data-act=cnote]').click();
  await page.waitForTimeout(300);
  assert.equal(markCalls(api).length, 0);
  await pick(page, '4032757');                                         // 複製第 1 版標題後滑到第 3 版，改複製第 3 版標題再留言 → 第 3 版
  await card().locator('[data-act=ctitle]').click();
  await card().hover();
  await card().locator('.dot').nth(2).click();
  await page.waitForFunction(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')) === 2);
  await card().locator('[data-act=ctitle]').click();
  await card().locator('[data-act=cnote]').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已複製留言，並記錄第 3 版使用'));
  assert.deepEqual(markCalls(api), [{ id: '4032757', ver: 3 }]);
});

test('改標可用滑鼠拖曳與鍵盤切換', async (t) => {
  const { page } = await open(t);
  await connect(page);
  await pick(page, '4032757');
  const box = await page.locator('#card .car').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * 0.8 - i * box.width * 0.05, y);
  await page.mouse.up();
  await page.waitForFunction(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')) === 1);
  await page.focus('#card .car');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')) === 2);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')) === 1);
  await page.waitForFunction(() => { const c = document.querySelector('#card .car'); return Math.abs(c.scrollLeft - (c.children[1].offsetLeft - c.children[0].offsetLeft)) < 1; });   // 正好停在整版位置
});

test('手機寬度：先看清單，點一則進卡片，返回回清單', async (t) => {
  const { page } = await open(t);
  await page.setViewportSize({ width: 390, height: 800 });
  await connect(page);
  assert.equal(await page.locator('#card .item').isVisible().catch(() => false), false);
  assert.ok(await page.locator('.row').first().isVisible());
  await page.click('.row[data-id="4032757"]');
  await page.waitForSelector('#card .item[data-id="4032757"]', { state: 'visible' });
  assert.equal(await page.locator('.row').first().isVisible(), false);
  assert.ok(await page.locator('#card [data-act=back]').isVisible());
  await page.click('#card [data-act=back]');
  assert.ok(await page.locator('.row').first().isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
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
  await page.click('#card .item[data-id="4040001"] [data-act=edit]');
  assert.equal(await page.getAttribute('#fUrl', 'readonly'), '');
  await page.click('#addVar');
  await page.locator('#vars textarea').last().fill('第二版');
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.deepEqual(api.st.items.find((i) => i.id === '4040001').titles.map((v) => [v.ver, v.t]), [[1, '第一版\n第二行'], [2, '第二版']]);

  await page.click('#card .item[data-id="4040001"] [data-act=edit]');
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

test('新增：依網址自動選分類；手動改過分類就不再覆蓋', async (t) => {
  const { page } = await open(t);
  await connect(page);
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/health/1358062');
  await page.waitForFunction(() => document.getElementById('fCat').value === '健康');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/world/1358063');
  await page.waitForFunction(() => document.getElementById('fCat').value === '國際');
  await page.selectOption('#fCat', '娛樂');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/health/1358064');
  await page.waitForFunction(() => document.getElementById('idHint').textContent.includes('1358064'));
  assert.equal(await page.inputValue('#fCat'), '娛樂');
});
