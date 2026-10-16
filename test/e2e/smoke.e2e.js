// 精簡冒煙測試：用記憶體假 API 走過主要流程（設定 → 列表 → 輪播 → 複製 → 標記 → 新增 → 編輯 → 刪除）
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSite } = require('../../scripts/build-site.js');
const { createFakeApi, seedSample, PASSWORD } = require('../helpers/fake-api.js');
const lib = require('../../apps-script/lib.js');

const API_URL = 'https://hotnews.test-account.workers.dev';
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

async function open(t, { sample = true, init = null } = {}) {
  const api = createFakeApi();
  if (sample) seedSample(api);
  const ctx = await browser.newContext({ timezoneId: 'Asia/Taipei', locale: 'zh-TW', viewport: { width: 900, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { problems.push('native dialog: ' + d.type()); d.dismiss(); });
  if (init) await page.addInitScript(init);
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => { (window.__csp = window.__csp || []).push(e.violatedDirective); }));
  const requests = [];
  await page.route(API_URL + '/**', async (route) => {
    const r = route.request();
    const path = new URL(r.url()).pathname;
    requests.push({ method: r.method(), type: r.headers()['content-type'], path });
    await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' },
      body: r.method() === 'POST' ? api.handle(path, r.postData()) : 'ok' });
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
  await page.fill('#sToken', '  ' + PASSWORD + '\n');
  if (remember) await page.check('#sRemember');
  await page.click('#sSave');
  await page.waitForSelector('#settingsDlg', { state: 'hidden' });
}

test('首次開啟跳出設定；登入後載入列表；未勾記住時 localStorage 不含密碼與憑證', async (t) => {
  const { page, requests } = await open(t);
  await page.waitForSelector('#settingsDlg[open]');
  assert.equal(await page.getAttribute('#sToken', 'type'), 'password');
  await connect(page);
  await page.waitForSelector('.row');   // 彈窗關閉時列表可能還在載入
  assert.equal(await page.locator('.row').count(), 3);
  assert.equal(await page.locator('#card .item').count(), 1);   // 右側只有一張卡片
  assert.equal(requests[0].path, '/login');
  assert.ok(requests.slice(1).every((x) => x.path === '/api'));
  assert.equal(await page.evaluate(() => localStorage.getItem('hotnews.v1.session')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('hotnews.v1.url')), API_URL);
  assert.equal(await page.evaluate((pw) => Object.keys(localStorage).some((k) => localStorage.getItem(k).includes(pw)), PASSWORD), false);
  await page.reload();
  await page.waitForSelector('#settingsDlg[open]');
  assert.equal(await page.inputValue('#sUrl'), API_URL);
  assert.equal(await page.inputValue('#sToken'), '');
});

test('密碼錯誤顯示訊息、網址格式錯誤不送出請求', async (t) => {
  const { page, requests } = await open(t);
  await page.waitForSelector('#settingsDlg[open]');
  await page.fill('#sUrl', 'https://example.com'); await page.fill('#sToken', PASSWORD); await page.click('#sSave');
  await page.waitForSelector('#sMsg:not([hidden])');
  assert.equal(requests.length, 0);
  await page.fill('#sUrl', API_URL); await page.fill('#sToken', 'x'.repeat(48)); await page.click('#sSave');
  await page.waitForFunction(() => document.getElementById('sMsg').textContent.includes('密碼不正確'));
  assert.equal(await page.locator('.row').count(), 0);
});

test('勾記住：重新整理後不用輸入密碼；儲存內容不含密碼；舊的密碼鍵被清掉', async (t) => {
  const { page } = await open(t, { init: () => {
    if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('hotnews.v1.token', 'old-password'); }
  } });
  await page.waitForSelector('#settingsDlg[open]');
  await connectRows(page, true);
  assert.equal(await page.locator('.row').count(), 3);
  await page.reload();
  await page.waitForSelector('.row');
  assert.equal(await page.locator('#settingsDlg[open]').count(), 0);
  assert.equal(await page.locator('.row').count(), 3);
  assert.equal(await page.evaluate(() => localStorage.getItem('hotnews.v1.token')), null);
  assert.equal(await page.evaluate((pw) => Object.keys(localStorage).some((k) => localStorage.getItem(k).includes(pw)), PASSWORD), false);
});

test('憑證在伺服器端失效 → 下一次操作跳出設定並提示登入已過期', async (t) => {
  const { page, api } = await open(t);
  await connect(page);
  api.expireSessions();
  await page.click('#card [data-act=mark]');
  await page.click('#card [data-act=mark]');
  await page.waitForSelector('#settingsDlg[open]');
  assert.match(await page.locator('#sMsg').textContent(), /登入已過期/);
  await connectRows(page);
  assert.equal(await page.locator('.row').count(), 3);
});

test('編輯到一半憑證失效：編輯視窗與草稿保留，重新登入後可再儲存', async (t) => {
  const { page, api } = await open(t);
  await connect(page);
  await page.click('#card [data-act=edit]');
  await page.waitForSelector('#dlg[open]');
  await page.fill('#fNote', '寫到一半的小編文');
  api.expireSessions();
  await page.click('#save');
  await page.waitForSelector('#settingsDlg[open]');
  assert.equal(await page.locator('#dlg[open]').count(), 1);
  assert.equal(await page.inputValue('#fNote'), '寫到一半的小編文');
  await connect(page);
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.ok(api.st.items.some((i) => i.note === '寫到一半的小編文'));
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

// ---- 送到套版：用假的橋接取代真的 Chrome 擴充功能（真實擴充功能只能在 Chrome 實機驗證，見 docs/manual-checklist.md）----
const FAKE_BRIDGE = () => {
  window.__sent = [];
  window.__bridgeMode = 'opened';   // 'opened' | 'not_opened' | 'silent'，或下面 __errors 的 key（ok:false）
  window.__errors = { rejected: 'bad_url', bad_title: 'bad_title', unavailable: 'extension_unavailable' };
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== 'hottopic' || d.type !== 'send-to-quickpattern') return;
    window.__sent.push(d);
    if (window.__bridgeMode === 'silent') return;
    window.postMessage({ source: 'quickpattern', type: 'ack', nonce: d.nonce, ok: !window.__errors[window.__bridgeMode], opened: window.__bridgeMode === 'opened', error: window.__errors[window.__bridgeMode] }, location.origin);
  });
};
const toastText = (page) => page.evaluate(() => document.getElementById('toast').textContent);
const waitToast = (page, text) => page.waitForFunction((x) => document.getElementById('toast').textContent === x, text);
const sent = (page) => page.evaluate(() => window.__sent);

test('送到套版：橋接回報已打開 → 顯示「已送到套版」，送出網址與卡片目前的改標', async (t) => {
  const { page } = await open(t, { init: FAKE_BRIDGE });
  await connect(page);
  await pick(page, '4032757');
  await page.click('#card [data-act=qpt]');
  await waitToast(page, '已送到套版');
  const msgs = await sent(page);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].url, 'https://news.tvbs.com.tw/cars/4032757');
  assert.equal(msgs[0].title, '定期保養的 5 個重點\n第 3 項最多人漏掉');
  assert.equal(msgs[0].v, 1);
  assert.match(msgs[0].nonce, /^[0-9a-f]{16,}$/);
});

test('送到套版：橋接沒能打開側邊欄 → 提示點工具列圖示', async (t) => {
  const { page } = await open(t, { init: FAKE_BRIDGE });
  await connect(page);
  await pick(page, '4032757');
  await page.evaluate(() => { window.__bridgeMode = 'not_opened'; });
  await page.click('#card [data-act=qpt]');
  await waitToast(page, '已傳給套版，請點一下工具列圖示打開側邊欄');
});

test('送到套版：沒有橋接回應 → 800 毫秒後提示沒偵測到擴充功能，並把網址複製起來', async (t) => {
  const { page } = await open(t, { init: FAKE_BRIDGE });
  await connect(page);
  await pick(page, '4032757');
  await page.evaluate(() => { window.__bridgeMode = 'silent'; });
  const t0 = Date.now();
  await page.click('#card [data-act=qpt]');
  await waitToast(page, '沒偵測到套版擴充功能（需 v4.50 以上，並重新整理本頁），已複製網址');
  assert.ok(Date.now() - t0 >= 700, '不應在等待時間內就判定沒有擴充功能');
  assert.equal(await clip(page), 'https://news.tvbs.com.tw/cars/4032757');
});

test('送到套版：輪播到第 2 版後，送出的是第 2 版標題', async (t) => {
  const { page } = await open(t, { init: FAKE_BRIDGE });
  await connect(page);
  await pick(page, '4032757');
  await page.locator('#card .dot').nth(1).click();
  await page.waitForFunction(() => [].findIndex.call(document.querySelectorAll('#card .dot'), (d) => d.classList.contains('on')) === 1);
  await page.click('#card [data-act=qpt]');
  await waitToast(page, '已送到套版');
  assert.equal((await sent(page))[0].title, '愛車多久該保養一次？\n行家：別等警示燈亮');
});

test('送到套版：沒有改標的新聞只送網址、不帶 title', async (t) => {
  const { page } = await open(t, { init: FAKE_BRIDGE });
  await connect(page);
  await pick(page, '4028301');
  await page.click('#card [data-act=qpt]');
  await waitToast(page, '已送到套版');
  const m = (await sent(page))[0];
  assert.equal(m.url, 'https://news.tvbs.com.tw/local/4028301');
  assert.equal('title' in m, false);
});

test('送到套版：不會把新聞標記為已使用，也不影響「先複製標題、再複製留言」的自動標記', async (t) => {
  const { page, api } = await open(t, { init: FAKE_BRIDGE });
  await connect(page);
  await pick(page, '4032757');
  const card = page.locator('#card .item');
  await card.locator('[data-act=ctitle]').click();
  await card.locator('[data-act=qpt]').click();
  await waitToast(page, '已送到套版');
  assert.equal(markCalls(api).length, 0);
  await card.locator('[data-act=cnote]').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('記錄第 1 版使用'));
  assert.deepEqual(markCalls(api), [{ id: '4032757', ver: 1 }]);
});

test('送到套版：沒有網址的新聞，按鈕是停用的', async (t) => {
  const { page, api } = await open(t, { init: FAKE_BRIDGE });
  api.seed({ id: 'N9', cat: '生活', url: '', orig: '沒有網址的新聞', titles: [], note: '' });
  await connect(page);
  await pick(page, 'N9');
  assert.equal(await page.locator('#card [data-act=qpt]').isDisabled(), true);
});

test('送到套版：擴充功能拒絕這個網址 → 另外提示原因，並把網址複製起來', async (t) => {
  const { page } = await open(t, { init: FAKE_BRIDGE });
  await connect(page);
  await pick(page, '4032757');
  await page.evaluate(() => { window.__bridgeMode = 'rejected'; });
  await page.click('#card [data-act=qpt]');
  await waitToast(page, '套版擴充功能不接受這個網址（只收 tvbs.com.tw），已複製網址');
  assert.equal(await clip(page), 'https://news.tvbs.com.tw/cars/4032757');
});

test('送到套版：擴充功能剛更新、內容腳本失效（extension_unavailable）→ 提示重新整理本頁，不能說成網址被拒', async (t) => {
  const { page } = await open(t, { init: FAKE_BRIDGE });
  await connect(page);
  await pick(page, '4032757');
  await page.evaluate(() => { window.__bridgeMode = 'unavailable'; });
  await page.click('#card [data-act=qpt]');
  await waitToast(page, '套版擴充功能連不上（可能剛更新過），請重新整理本頁再試，已複製網址');
  assert.equal(await clip(page), 'https://news.tvbs.com.tw/cars/4032757');
});

test('送到套版：改標被拒（bad_title）→ 提示改標的問題，不是網址', async (t) => {
  const { page } = await open(t, { init: FAKE_BRIDGE });
  await connect(page);
  await pick(page, '4032757');
  await page.evaluate(() => { window.__bridgeMode = 'bad_title'; });
  await page.click('#card [data-act=qpt]');
  await waitToast(page, '套版擴充功能不接受這個改標（超過 500 字或沒有內容），已複製網址');
});

/* ---------- 顯示則數、排序選擇器與分頁 ---------- */
function seedMany(api, n) {
  for (let i = 0; i < n; i++) {
    api.seed({ id: String(5000 + i), cat: '生活', url: 'https://news.tvbs.com.tw/local/' + (5000 + i), orig: '測試新聞 ' + i,
      titles: [{ ver: 1, t: '標題 ' + i, last: null, count: 0 }], created: api.st.now - i });
  }
}
async function openMany(t, n = 25, opts = {}) {
  const r = await open(t, opts);
  seedMany(r.api, n);
  return r;
}
async function connectRows(page, remember) { await connect(page, remember); await page.waitForSelector('.row'); }   // 彈窗關閉時列表可能還在載入
const cntText = (page) => page.locator('#cnt').textContent();
const rowIds = (page) => page.$$eval('.row', (els) => els.map((e) => e.dataset.id));

test('分頁：預設每頁 10 則，顯示「第 p／P 頁」與分頁列；單頁時不顯示分頁列', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page);
  assert.equal(await page.locator('.row').count(), 10);
  assert.equal(await cntText(page), '共 28 則・第 1／3 頁');
  assert.ok(await page.locator('#pager').isVisible());
  assert.ok(await page.locator('#pager [data-page="3"]').isVisible());
  assert.equal(await page.locator('#pager [data-page="0"]').isDisabled(), true);   // 首頁的「‹」
  assert.equal(await page.getAttribute('#pager [aria-current=page]', 'data-page'), '1');
  const r2 = await open(t);   // 只有 3 則樣本
  await connectRows(r2.page);
  assert.equal(await r2.page.locator('#pager').isHidden(), true);
  assert.equal(await cntText(r2.page), '共 3 則・第 1／1 頁');
});

test('顯示則數：選項平時收合，點一下才展開，選完收合並生效', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page);
  assert.equal(await page.locator('#sizeX .xsel-opts').isHidden(), true);
  assert.equal(await page.locator('#sortX .xsel-opts').isHidden(), true);
  assert.match(await page.locator('#sizeX .xsel-val').textContent(), /10 則/);
  await page.click('#sizeX .xsel-btn');
  await page.locator('#sizeX .xsel-opts').waitFor({ state: 'visible' });
  assert.equal(await page.getAttribute('#sizeX .xsel-btn', 'aria-expanded'), 'true');
  assert.equal(await page.getAttribute('#sizeX [data-v="10"]', 'aria-checked'), 'true');
  await page.click('#sizeX [data-v="5"]');
  assert.equal(await page.locator('.row').count(), 5);
  assert.equal(await cntText(page), '共 28 則・第 1／6 頁');
  await page.locator('#sizeX .xsel-opts').waitFor({ state: 'hidden' });   // 收合有轉場，等它收完
  assert.match(await page.locator('#sizeX .xsel-val').textContent(), /5 則/);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('xsel-btn')), true);
});

test('選擇器：Esc、點外面、展開另一個都會收合；方向鍵移動焦點', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page);
  await page.click('#sizeX .xsel-btn');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-v')), '15');
  await page.keyboard.press('Escape');
  await page.locator('#sizeX .xsel-opts').waitFor({ state: 'hidden' });   // 收合有轉場，等它收完
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('xsel-btn')), true);
  await page.click('#sizeX .xsel-btn');
  await page.click('#cnt');
  await page.locator('#sizeX .xsel-opts').waitFor({ state: 'hidden' });   // 收合有轉場，等它收完
  await page.click('#sizeX .xsel-btn');
  await page.click('#sortX .xsel-btn');
  await page.locator('#sizeX .xsel-opts').waitFor({ state: 'hidden' });   // 收合有轉場，等它收完
  await page.locator('#sortX .xsel-opts').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.row').count(), 10);   // 只是展開，沒有改任何設定
});

test('排序選擇器：改成「最近用」「次數」後列表順序改變，並回到第 1 頁', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page);
  await page.click('#pager [data-page="2"]');
  await page.click('#sortX .xsel-btn');
  await page.click('#sortX [data-v="recent"]');
  assert.equal(await page.getAttribute('.row', 'data-id'), '4032757');   // 唯一用過的排最前
  assert.match(await cntText(page), /第 1／3 頁/);
  assert.match(await page.locator('#sortX .xsel-val').textContent(), /最近用/);
  await page.click('#sortX .xsel-btn');
  await page.click('#sortX [data-v="count"]');
  assert.equal(await page.getAttribute('.row', 'data-id'), '4032757');
  await page.click('#sortX .xsel-btn');
  await page.click('#sortX [data-v="created"]');
  assert.equal(await page.getAttribute('.row', 'data-id'), '5000');   // 最新新增（seedMany 的 created 比樣本都新）
});

test('顯示則數：重新整理後仍保留；localStorage 壞值或不能用時回到 10 且頁面照常', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page, true);
  await page.click('#sizeX .xsel-btn');
  await page.click('#sizeX [data-v="15"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('hottopic.pageSize')), '15');
  await page.reload();
  await page.waitForSelector('.row');
  assert.equal(await page.locator('.row').count(), 15);
  assert.match(await page.locator('#sizeX .xsel-val').textContent(), /15 則/);
});

test('顯示則數：儲存值是壞的（7）→ 10', async (t) => {
  const { page } = await openMany(t, 25, { init: () => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('hottopic.pageSize', '7'); } } });
  await connectRows(page);
  assert.equal(await page.locator('.row').count(), 10);
  assert.match(await page.locator('#sizeX .xsel-val').textContent(), /10 則/);
});

test('顯示則數：localStorage 讀寫該鍵都丟例外 → 仍是 10、切換不當掉', async (t) => {
  const { page } = await openMany(t, 25, { init: () => {
    const g = Storage.prototype.getItem, s = Storage.prototype.setItem;
    Storage.prototype.getItem = function (k) { if (k === 'hottopic.pageSize') throw new Error('denied'); return g.apply(this, arguments); };
    Storage.prototype.setItem = function (k) { if (k === 'hottopic.pageSize') throw new Error('denied'); return s.apply(this, arguments); };
  } });
  await connectRows(page);
  assert.equal(await page.locator('.row').count(), 10);
  await page.click('#sizeX .xsel-btn');
  await page.click('#sizeX [data-v="20"]');
  assert.equal(await page.locator('.row').count(), 20);
});

test('翻頁與回到第 1 頁：選中該頁第一則；換分類、搜尋、排序、則數都回第 1 頁', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page);
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.click('#pager [data-page="2"]');
  assert.match(await cntText(page), /第 2／3 頁/);
  assert.equal(await page.getAttribute('.row', 'data-id'), '5008');
  assert.equal(await page.getAttribute('.row[aria-selected=true]', 'data-id'), '5008');
  assert.equal(await page.getAttribute('#card .item', 'data-id'), '5008');
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.click('.chip[data-cat="生活"]');
  assert.match(await cntText(page), /第 1／3 頁/);
  await page.click('#pager [data-page="2"]');
  await page.fill('#q', '測試');
  assert.match(await cntText(page), /共 25 則・第 1／3 頁/);
  await page.fill('#q', '');
  await page.click('#pager [data-page="3"]');
  await page.click('#sizeX .xsel-btn');
  await page.click('#sizeX [data-v="20"]');
  assert.match(await cntText(page), /第 1／2 頁/);
});

test('標記已使用讓新聞排到別頁：頁碼跟著跳，列表選中列與卡片一致', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page);
  assert.equal(await page.getAttribute('.row[aria-selected=true]', 'data-id'), '4031880');
  const card = page.locator('#card .item');
  await card.locator('[data-act=mark]').click();
  await card.locator('[data-act=mark]').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('已記錄'));
  assert.match(await cntText(page), /第 3／3 頁/);
  assert.equal(await page.getAttribute('.row[aria-selected=true]', 'data-id'), '4031880');
  assert.equal(await page.getAttribute('#card .item', 'data-id'), '4031880');
});

test('刪光最後一頁的新聞：頁碼夾回前一頁、不出現空白頁', async (t) => {
  const { page } = await openMany(t, 21);   // 3 + 21 = 24 則，每頁 10 → 3 頁，最後一頁 4 則
  await connectRows(page);
  await page.click('#pager [data-page="3"]');
  assert.equal(await page.locator('.row').count(), 4);
  for (let i = 0; i < 4; i++) {
    await page.click('#card .item [data-act=edit]');
    await page.click('#del');
    await page.click('#del');
    await page.waitForSelector('#dlg', { state: 'hidden' });
  }
  assert.match(await cntText(page), /共 20 則・第 2／2 頁/);
  assert.ok((await page.locator('.row').count()) > 0);
});

test('沒有結果、載入前：不顯示分頁列，計數不帶頁碼', async (t) => {
  const { page } = await openMany(t);
  assert.equal(await page.locator('#pager').isHidden(), true);   // 尚未連線
  await connectRows(page);
  await page.fill('#q', '(');
  assert.match(await page.locator('#list').textContent(), /沒有符合的新聞/);
  assert.equal(await page.locator('#pager').isHidden(), true);
  assert.equal(await cntText(page), '共 0 則');
});

test('選擇器展開時開啟設定：選擇器收合，Esc 可關閉彈窗', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page);
  await page.click('#sortX .xsel-btn');
  await page.locator('#sortX .xsel-opts').waitFor({ state: 'visible' });
  await page.evaluate(() => document.getElementById('settingsBtn').click());
  await page.waitForSelector('#settingsDlg[open]');
  await page.locator('#sortX .xsel-opts').waitFor({ state: 'hidden' });   // 收合有轉場，等它收完
  await page.keyboard.press('Escape');
  await page.waitForSelector('#settingsDlg', { state: 'hidden' });
});

/* ---------- 版面：固定頂欄、固定右側卡片、手機圖示按鈕 ---------- */
const top = (page, sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().top, sel);

test('桌機：往下捲動時頂欄固定在最上方、右側卡片不動', async (t) => {
  const { page } = await openMany(t);
  await page.setViewportSize({ width: 1280, height: 800 });
  await connectRows(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).position), 'sticky');
  const cardTop = await top(page, '#card .item');
  const barH = await page.evaluate(() => document.querySelector('.topbar').getBoundingClientRect().height);
  assert.ok(cardTop >= barH, '卡片在頂欄下方');
  await page.evaluate(() => window.scrollTo(0, 600));
  assert.ok(await page.evaluate(() => window.scrollY) > 0, '頁面確實有捲動');
  assert.equal(await top(page, '.topbar'), 0);
  assert.ok(Math.abs((await top(page, "#card .item")) - cardTop) <= 1, "卡片位置不變 before=" + cardTop + " after=" + (await top(page, "#card .item")));
  assert.ok(await page.evaluate(() => document.querySelector('#card .item').getBoundingClientRect().bottom <= window.innerHeight));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});

test('桌機：卡片內容很長時，卡片自己可捲，頁面不被撐開', async (t) => {
  const { page, api } = await open(t, { sample: false });
  api.seed({ id: '6000', cat: '生活', url: 'https://news.tvbs.com.tw/local/6000', orig: '很長的小編文', created: api.st.now,
    titles: [{ ver: 1, t: '標題', last: null, count: 0 }], note: '很長的小編文內容\n'.repeat(150) });
  seedSample(api); seedMany(api, 25);
  await page.setViewportSize({ width: 1280, height: 800 });
  await connectRows(page);
  assert.equal(await page.getAttribute('#card .item', 'data-id'), '6000');
  const m = await page.evaluate(() => { const e = document.querySelector('#card .item'); return { sh: e.scrollHeight, ch: e.clientHeight, oy: getComputedStyle(e).overflowY, bottom: e.getBoundingClientRect().bottom, vh: window.innerHeight }; });
  assert.ok(m.sh > m.ch, '內容比卡片高');
  assert.equal(m.oy, 'auto');
  assert.ok(m.bottom <= m.vh);
});

test('矮視窗的桌機寬度：卡片改為隨頁面捲動', async (t) => {
  const { page } = await openMany(t);
  await page.setViewportSize({ width: 1280, height: 450 });
  await connectRows(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.pane-r')).position), 'static');
});

test('手機：頂欄只有圖示按鈕，搜尋點開才出現，點一列看卡片，返回回列表', async (t) => {
  const { page } = await openMany(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await connectRows(page);
  assert.equal(await page.locator('#settingsBtn .lbl').isHidden(), true);
  assert.equal(await page.locator('#addBtn .lbl').isHidden(), true);
  assert.ok(await page.locator('#settingsBtn .ico').isVisible());
  assert.equal(await page.locator('#q').isHidden(), true);
  await page.click('#searchBtn');
  assert.ok(await page.locator('#q').isVisible());
  assert.equal(await page.getAttribute('#searchBtn', 'aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
  await page.fill('#q', '標題 3');
  assert.equal(await page.locator('.row').count(), 1);
  await page.fill('#q', '');
  await page.click('.row >> nth=0');
  await page.waitForSelector('#card .item', { state: 'visible' });
  await page.click('#card [data-act=back]');
  assert.ok(await page.locator('.row').first().isVisible());
  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsDlg[open]');
  await page.keyboard.press('Escape');
  await page.click('#addBtn');
  await page.waitForSelector('#dlg[open]');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});

test('桌機：圖示隱藏、文字標籤顯示，搜尋框一直可見', async (t) => {
  const { page } = await openMany(t);
  await page.setViewportSize({ width: 1280, height: 800 });
  await connectRows(page);
  assert.ok(await page.locator('#settingsBtn .lbl').isVisible());
  assert.equal(await page.locator('#settingsBtn .ico').isHidden(), true);
  assert.equal(await page.locator('#searchBtn').isHidden(), true);
  assert.ok(await page.locator('#q').isVisible());
});

test('鍵盤翻頁：按 Enter 換頁後焦點仍在分頁列內，且頁碼變動會被朗讀', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page);
  assert.equal(await page.getAttribute('#cnt', 'aria-live'), 'polite');
  await page.focus('#pager [aria-label="下一頁"]');
  await page.keyboard.press('Enter');
  assert.equal(await cntText(page), '共 28 則・第 2／3 頁');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('#pager')), true);
  await page.keyboard.press('Enter');
  assert.equal(await cntText(page), '共 28 則・第 3／3 頁');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('#pager')), true);
});

for (const w of [834, 320]) {
  test('窄視窗 ' + w + 'px：頂欄按鈕與展開的選項文字不斷行', async (t) => {
    const { page } = await openMany(t);
    await page.setViewportSize({ width: w, height: 800 });
    await connectRows(page);
    await page.click('#sortX .xsel-btn');
    const h = await page.evaluate(() => {
      const hs = (sel) => Math.max(...[...document.querySelectorAll(sel)].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height));
      return { btn: hs('.tools .btn'), radio: hs('#sortX [role=radio]') };
    });
    assert.ok(h.btn <= 44, '頂欄按鈕高度 ' + h.btn);
    assert.ok(h.radio <= 36, '選項高度 ' + h.radio);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const who = sw > 0 ? await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > window.innerWidth + 0.5 && e.parentElement.getBoundingClientRect().right <= window.innerWidth + 0.5).map((e) => e.tagName + '#' + e.id + '.' + e.className + ' r=' + e.getBoundingClientRect().right).slice(0, 5)) : [];
    const dbg = await page.evaluate(() => ['#sortX', '#sortX .xsel-opts', '#sortX .xsel-btn', '.ctl', '.sortrow', '.filters', '.pane-l', '.wrap'].map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return q + ' ' + Math.round(r.left) + '-' + Math.round(r.right); }));
    assert.ok(sw <= 0, '頁面橫向溢出 ' + sw + 'px ' + who.join(' | ') + ' // ' + dbg.join(' | '));
  });
}

// ---- 第二輪調整：搜尋不含小編文、選單滑動動畫、「直接產圖」綠色按鈕 ----
test('搜尋不比對小編文：只在小編文裡出現的字搜不到，標題與原標題仍可搜到', async (t) => {
  const { page, api } = await open(t);
  api.st.items.find((i) => i.id === '4031880').note = '只出現在小編文的獨特詞彙';
  await connectRows(page);
  await page.fill('#q', '獨特詞彙');
  assert.equal(await page.locator('.row').count(), 0);
  assert.match(await page.locator('#list').textContent(), /沒有符合的新聞/);
  await page.fill('#q', '');
  const first = await page.locator('.row >> nth=0').innerText();
  const word = first.replace(/\s+/g, ' ').split(' ').find((w) => w.length >= 2);
  await page.fill('#q', word);
  assert.ok(await page.locator('.row').count() >= 1);
});

test('「送到套版」按鈕改名「直接產圖」並套用綠底白字', async (t) => {
  const { page } = await open(t, { init: FAKE_BRIDGE });
  await connectRows(page);
  const btn = page.locator('#card [data-act=qpt]');
  assert.equal((await btn.textContent()).trim(), '直接產圖');
  const bg = await btn.evaluate((e) => getComputedStyle(e).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  assert.ok(g > r + 40 && g > b + 40, '背景應為綠色，實際 ' + bg);
  assert.equal(await btn.evaluate((e) => getComputedStyle(e).color), 'rgb(255, 255, 255)');
});

const thumbBox = (page, id) => page.evaluate((x) => {
  const th = document.querySelector(x + ' .xsel-thumb').getBoundingClientRect();
  const on = document.querySelector(x + ' [aria-checked=true]').getBoundingClientRect();
  return { dl: Math.abs(th.left - on.left), dw: Math.abs(th.width - on.width), w: th.width };
}, id);

test('選單滑動：展開時白色圓塊就位在目前選項；換選項時圓塊滑過去（有轉場），再收合', async (t) => {
  const { page } = await openMany(t);
  await connectRows(page);
  await page.click('#sizeX .xsel-btn');
  await page.waitForTimeout(450);
  let b = await thumbBox(page, '#sizeX');
  assert.ok(b.w > 10 && b.dl <= 1 && b.dw <= 1, '圓塊應對齊 10 則 ' + JSON.stringify(b));
  const tr = await page.evaluate(() => ({
    thumb: getComputedStyle(document.querySelector('#sizeX .xsel-thumb')).transitionProperty,
    slide: getComputedStyle(document.querySelector('#sizeX .xsel-slide')).transitionProperty,
    dur: getComputedStyle(document.querySelector('#sizeX .xsel-thumb')).transitionDuration,
  }));
  assert.match(tr.thumb, /transform/);
  assert.match(tr.slide, /grid-template-columns/);
  assert.notEqual(tr.dur, '0s');
  await page.click('#sizeX [data-v="20"]');
  // 剛點下去的瞬間，圓塊還在路上：沒有對齊 20 則，但選項已經是 20 則
  const mid = await thumbBox(page, '#sizeX');
  assert.ok(mid.dl > 1, '圓塊不該瞬移 ' + JSON.stringify(mid));
  await page.waitForSelector('#sizeX .xsel-slide', { state: 'hidden' });
  assert.match(await page.locator('#sizeX .xsel-val').textContent(), /20 則/);
  // 再展開：圓塊直接在 20 則上，不從舊位置滑過來
  await page.click('#sizeX .xsel-btn');
  b = await thumbBox(page, '#sizeX');
  assert.ok(b.dl <= 1, '重新展開時圓塊直接就位 ' + JSON.stringify(b));
});

test('選單滑動：系統設定「減少動態效果」時不做動畫，點選項立刻收合', async (t) => {
  const { page } = await openMany(t);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await connectRows(page);
  await page.click('#sortX .xsel-btn');
  await page.locator('#sortX .xsel-opts').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#sortX .xsel-thumb')).transitionDuration), '0s');
  await page.click('#sortX [data-v="recent"]');
  assert.equal(await page.locator('#sortX .xsel-slide').isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('xsel-btn')), true);
});

/* ---------- 到期日與「新增時就已使用過」 ---------- */
// 瀏覽器用真實時鐘判斷到期，所以日期一律以「現在」往前後推，不依賴假 API 的固定時間
const dayStr = (offset) => lib.dateStrTaipei(Date.now() + offset * 864e5);
function seedExpiry(api) {
  api.seed({ id: '6000001', cat: '社會', url: 'https://news.tvbs.com.tw/local/6000001', orig: '補助申請即將截止的舊聞', expires: dayStr(-5),
    titles: [{ ver: 1, t: '過期補助改標', last: null, count: 0 }], created: api.st.now });
  api.seed({ id: '6000002', cat: '生活', url: 'https://news.tvbs.com.tw/life/6000002', orig: '罰款新制今天到期的新聞', expires: dayStr(0), created: api.st.now });
  api.seed({ id: '6000003', cat: '生活', url: 'https://news.tvbs.com.tw/life/6000003', orig: '還有效的熱門罰款新聞', expires: dayStr(5), created: api.st.now });
}

test('到期日：到期當天起不在主列表與搜尋，集中在「已到期」；分類數量不含到期文章', async (t) => {
  const { page, api } = await open(t);
  seedExpiry(api);
  await connectRows(page);
  const main = await rowIds(page);
  assert.ok(main.includes('6000003'));
  assert.ok(!main.includes('6000001') && !main.includes('6000002'));
  assert.equal(await page.locator('.chip[data-cat="全部"] small').textContent(), '4');       // 3 則範例 + 1 則有效
  assert.equal(await page.locator('.chip[data-cat="社會"] small').textContent(), '2');       // 到期的 6000001 不算
  assert.equal(await page.locator('.chip[data-expired] small').textContent(), '2');
  await page.fill('#q', '補助');
  assert.match(await page.locator('#list').textContent(), /沒有符合的新聞/);                  // 主列表搜不到過期文章
  await page.fill('#q', '');
  await page.click('.chip[data-expired]');
  assert.deepEqual((await rowIds(page)).sort(), ['6000001', '6000002']);
  assert.equal(await page.getAttribute('.chip[data-expired]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('.chip[data-cat="全部"]', 'aria-pressed'), 'false');
  await page.fill('#q', '補助');
  assert.deepEqual(await rowIds(page), ['6000001']);                                         // 在「已到期」裡搜尋只找到期文章
  await page.fill('#q', '');
  await page.click('.chip[data-cat="全部"]');
  assert.ok(!(await rowIds(page)).includes('6000001'));
  assert.equal(await page.getAttribute('.chip[data-expired]', 'aria-pressed'), 'false');
});

test('到期日：卡片顯示到期日；已到期的文章標示「已到期」', async (t) => {
  const { page, api } = await open(t);
  seedExpiry(api);
  await connectRows(page);
  await pick(page, '6000003');
  assert.match(await page.locator('#card .expiry').textContent(), new RegExp(dayStr(5).replace(/-/g, '/')));
  assert.equal(await page.locator('#card .expiry.over').count(), 0);
  await page.click('.chip[data-expired]');
  await pick(page, '6000001');
  assert.match(await page.locator('#card .expiry.over').textContent(), /已到期/);
  await page.fill('#q', '');
  await page.click('.chip[data-cat="全部"]');
  await pick(page, '4032757');
  assert.equal(await page.locator('#card .expiry').count(), 0);                              // 沒設到期日就不顯示
});

test('到期日：沒有任何到期文章時「已到期」仍在，點進去顯示說明', async (t) => {
  const { page } = await open(t);
  await connectRows(page);
  assert.equal(await page.locator('.chip[data-expired] small').textContent(), '0');
  await page.click('.chip[data-expired]');
  assert.match(await page.locator('#list').textContent(), /沒有已到期的文章/);
});

test('到期日：編輯時改成未來日期就回到主列表；清除也可以', async (t) => {
  const { page, api } = await open(t);
  seedExpiry(api);
  await connectRows(page);
  await page.click('.chip[data-expired]');
  await pick(page, '6000001');
  await page.click('#card [data-act=edit]');
  assert.equal(await page.inputValue('#fExp'), dayStr(-5));
  assert.equal(await page.locator('#usedBox').isVisible(), true);                            // 從未使用的新聞，編輯時可補記「使用狀態」
  await page.fill('#fExp', dayStr(30));
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.equal(api.st.items.find((i) => i.id === '6000001').expires, dayStr(30));
  assert.deepEqual(await rowIds(page), ['6000002']);                                         // 離開「已到期」
  await page.click('.chip[data-cat="全部"]');
  assert.ok((await rowIds(page)).includes('6000001'));
  await pick(page, '6000001');
  await page.click('#card [data-act=edit]');
  await page.click('#fExpClear');
  assert.equal(await page.inputValue('#fExp'), '');
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.equal(api.st.items.find((i) => i.id === '6000001').expires, null);
  assert.equal(await page.locator('#card .expiry').count(), 0);
});

test('到期日：新增視窗的提示——今天或更早會直接進「已到期」，未來日期不提示', async (t) => {
  const { page } = await open(t);
  await connectRows(page);
  await page.click('#addBtn');
  assert.equal(await page.locator('#expHint').isHidden(), true);
  await page.fill('#fExp', dayStr(0));
  assert.match(await page.textContent('#expHint'), /已到期/);
  await page.fill('#fExp', dayStr(-3));
  assert.match(await page.textContent('#expHint'), /已到期/);
  await page.fill('#fExp', dayStr(3));
  assert.equal(await page.locator('#expHint').isHidden(), true);
  await page.fill('#fExp', dayStr(0));
  await page.click('#fExpClear');
  assert.equal(await page.locator('#expHint').isHidden(), true);
});

test('新增：預設「未使用」，不送 last 也不送 expires', async (t) => {
  const { page, api } = await open(t);
  await connectRows(page);
  await page.click('#addBtn');
  assert.equal(await page.isChecked('#fUsed0'), true);
  assert.equal(await page.locator('#lastRow').isHidden(), true);
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/6100001');
  await page.fill('#fOrig', '一般新增');
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  const args = api.st.calls.filter((c) => c.action === 'addItem')[0].args;
  assert.ok(!('last' in args) && !('expires' in args), JSON.stringify(args));
  assert.equal(api.st.items.find((i) => i.id === '6100001').last, null);
});

test('新增：選「已使用過」填上次使用時間與到期日 → 記為已使用 1 次，卡片顯示該時間', async (t) => {
  const { page, api } = await open(t);
  await connectRows(page);
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/6100002');
  await page.fill('#fOrig', '同事發過的新聞');
  await page.check('#fUsed1');
  assert.equal(await page.locator('#lastRow').isVisible(), true);
  assert.match(await page.inputValue('#fLast'), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);          // 預設帶入現在（24 小時制），免得每次都要填
  const past = new Date(Date.now() - 2 * 864e5);
  const local = lib.dateStrTaipei(past.getTime()) + 'T09:30';
  await page.fill('#fLast', local.slice(0, 4) + local.slice(5, 7) + local.slice(8, 10) + '0930');   // 直接輸入 12 碼
  assert.equal(await page.inputValue('#fLast'), local.slice(0, 4) + '/' + local.slice(5, 7) + '/' + local.slice(8, 10) + ' 09:30');
  await page.fill('#fExp', dayStr(10));
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  const args = api.st.calls.filter((c) => c.action === 'addItem')[0].args;
  assert.equal(args.last, Date.UTC(+local.slice(0, 4), +local.slice(5, 7) - 1, +local.slice(8, 10), 1, 30));   // 台北 09:30 = UTC 01:30
  assert.equal(args.expires, dayStr(10));
  await page.fill('#q', '6100002');
  assert.match(await page.locator('#card .used').textContent(), /共 1 次/);
  assert.match(await page.locator('#card .used').textContent(), new RegExp(local.slice(0, 4) + '/' + local.slice(5, 7) + '/' + local.slice(8, 10) + ' 09:30'));
  assert.equal(await page.locator('.row[data-id="6100002"] .badge.fresh').count(), 0);        // 不再是「從未使用」
});

test('新增：選「已使用過」但時間留空或在未來 → 顯示錯誤、不送出', async (t) => {
  const { page, api } = await open(t);
  await connectRows(page);
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/6100003');
  await page.fill('#fOrig', '時間不合規');
  await page.check('#fUsed1');
  await page.fill('#fLast', '');
  await page.click('#save');
  assert.match(await page.textContent('#err'), /上次使用時間/);
  await page.fill('#fLast', dayStr(3).replace(/-/g, '') + '0900');
  await page.click('#save');
  assert.match(await page.textContent('#err'), /未來/);
  await page.fill('#fLast', '202613011200');                                                 // 13 月不存在
  await page.click('#save');
  assert.match(await page.textContent('#err'), /格式/);
  await page.fill('#fLast', '2026121921');                                                   // 位數不足
  await page.click('#save');
  assert.match(await page.textContent('#err'), /格式/);
  assert.equal(api.st.calls.filter((c) => c.action === 'addItem').length, 0);
  await page.check('#fUsed0');                                                               // 改回「未使用」就不檢查時間
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.equal(api.st.calls.filter((c) => c.action === 'addItem').length, 1);
});

test('新增：每次開啟都回到「未使用」，不帶上一次的選擇', async (t) => {
  const { page } = await open(t);
  await connectRows(page);
  await page.click('#addBtn');
  await page.check('#fUsed1');
  await page.fill('#fExp', dayStr(3));
  await page.click('#cancel');
  await page.click('#addBtn');
  assert.equal(await page.isChecked('#fUsed0'), true);
  assert.equal(await page.inputValue('#fExp'), '');
  assert.equal(await page.locator('#lastRow').isHidden(), true);
});

test('後端還沒更新：照樣存下新聞，但明確提示到期日／使用紀錄沒有存到', async (t) => {
  const { page, api } = await open(t);
  api.st.legacyBackend = true;
  await connectRows(page);
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/6100004');
  await page.fill('#fOrig', '舊後端');
  await page.fill('#fExp', dayStr(10));
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.match(await page.textContent('#toast'), /後端還沒更新/);
  assert.ok(api.st.items.some((i) => i.id === '6100004'));
  await page.fill('#q', '6100004');
  assert.deepEqual(await rowIds(page), ['6100004']);                                         // 沒有 expires 欄位的資料照常顯示在主列表
});

const order = (page, ids) => page.evaluate((list) => {
  const els = list.map((id) => document.getElementById(id));
  return els.every((e, i) => i === 0 || (els[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
}, ids);

test('新增／編輯視窗欄位順序：分類 → 原始標題 → 網址 → 改標 → 小編文 → 使用狀態 → 到期日', async (t) => {
  const { page } = await open(t);
  await connectRows(page);
  await page.click('#addBtn');
  assert.equal(await order(page, ['fCat', 'fOrig', 'fUrl', 'vars', 'fNote', 'usedBox', 'fExp']), true);
  await page.click('#cancel');
  await pick(page, '4031880');
  await page.click('#card [data-act=edit]');
  assert.equal(await order(page, ['fCat', 'fOrig', 'fUrl', 'vars', 'fNote', 'usedBox', 'fExp']), true);
});

test('新增：開啟後游標停在網址欄；貼網址仍自動帶入標題與分類', async (t) => {
  const { page } = await open(t);
  await connectRows(page);
  await page.click('#addBtn');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'fUrl');
  await page.keyboard.type('https://news.tvbs.com.tw/health/6200001');
  await page.waitForFunction(() => document.getElementById('fOrig').value === '自動帶入的原始標題');
  assert.equal(await page.inputValue('#fCat'), '健康');
});

test('上次使用時間：輸入 12 碼數字，離開欄位或滿 12 碼就轉成 YYYY/MM/DD HH:mm（24 小時制），並以台北時間送出', async (t) => {
  const { page, api } = await open(t);
  await connectRows(page);
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/6200002');
  await page.fill('#fOrig', '24 小時制');
  await page.check('#fUsed1');
  assert.equal(await page.getAttribute('#fLast', 'type'), 'text');
  const y = new Date(Date.now() - 864e5);
  const ds = lib.dateStrTaipei(y.getTime()), digits = ds.replace(/-/g, '');
  await page.fill('#fLast', '');
  await page.type('#fLast', digits + '2105');                                                // 逐字輸入，滿 12 碼自動轉
  assert.equal(await page.inputValue('#fLast'), ds.replace(/-/g, '/') + ' 21:05');
  await page.fill('#fLast', digits + '0000');
  await page.locator('#fExp').focus();                                                        // 離開欄位也會轉
  assert.equal(await page.inputValue('#fLast'), ds.replace(/-/g, '/') + ' 00:00');
  await page.fill('#fLast', digits + '2105');
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  const args = api.st.calls.filter((c) => c.action === 'addItem')[0].args;
  const [yy, mm, dd] = ds.split('-').map(Number);
  assert.equal(args.last, Date.UTC(yy, mm - 1, dd, 21 - 8, 5));
  await page.fill('#q', '6200002');
  assert.match(await page.locator('#card .used').textContent(), new RegExp(ds.replace(/-/g, '/') + ' 21:05'));
});

test('編輯：從未使用的新聞可補記「已使用過」，記為 1 次；已有使用紀錄的新聞不顯示這個區塊', async (t) => {
  const { page, api } = await open(t);
  await connectRows(page);
  await pick(page, '4032757');                                                               // 已用過
  await page.click('#card [data-act=edit]');
  assert.equal(await page.locator('#usedBox').isHidden(), true);
  await page.click('#cancel');
  await pick(page, '4031880');                                                               // 從未使用
  await page.click('#card [data-act=edit]');
  assert.equal(await page.locator('#usedBox').isVisible(), true);
  assert.equal(await page.isChecked('#fUsed0'), true);
  await page.click('#save');                                                                 // 維持「未使用」：不送 last
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.ok(!('last' in api.st.calls.filter((c) => c.action === 'updateItem')[0].args));
  await pick(page, '4031880');
  await page.click('#card [data-act=edit]');
  await page.check('#fUsed1');
  const ds = lib.dateStrTaipei(Date.now() - 2 * 864e5);
  await page.fill('#fLast', ds.replace(/-/g, '') + '0930');
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  const upd = api.st.calls.filter((c) => c.action === 'updateItem')[1].args;
  const [yy, mm, dd] = ds.split('-').map(Number);
  assert.equal(upd.last, Date.UTC(yy, mm - 1, dd, 1, 30));
  const saved = api.st.items.find((i) => i.id === '4031880');
  assert.deepEqual([saved.count, saved.last], [1, upd.last]);
  assert.match(await page.locator('#card .used').textContent(), /共 1 次/);
  await page.click('#card [data-act=edit]');                                                  // 已有紀錄後不再顯示
  assert.equal(await page.locator('#usedBox').isHidden(), true);
});

test('編輯補記「已使用過」：時間格式不對或在未來 → 顯示錯誤、不送出', async (t) => {
  const { page, api } = await open(t);
  await connectRows(page);
  await pick(page, '4031880');
  await page.click('#card [data-act=edit]');
  await page.check('#fUsed1');
  await page.fill('#fLast', '99999999');
  await page.click('#save');
  assert.match(await page.textContent('#err'), /格式/);
  await page.fill('#fLast', dayStr(2).replace(/-/g, '') + '1000');
  await page.click('#save');
  assert.match(await page.textContent('#err'), /未來/);
  assert.equal(api.st.calls.filter((c) => c.action === 'updateItem').length, 0);
});

test('編輯補記「已使用過」遇到舊後端：明確提示使用紀錄沒有存到', async (t) => {
  const { page, api } = await open(t);
  api.st.legacyBackend = true;
  await connectRows(page);
  await pick(page, '4031880');
  await page.click('#card [data-act=edit]');
  await page.check('#fUsed1');
  await page.click('#save');
  await page.waitForSelector('#dlg', { state: 'hidden' });
  assert.match(await page.textContent('#toast'), /後端還沒更新/);
});

test('標題旁的「重新讀取」：用目前網址重抓並覆蓋標題；網址空白或不合規會提示；編輯時不顯示', async (t) => {
  const { page, api } = await open(t);
  await connectRows(page);
  const fetches = () => api.st.calls.filter((c) => c.action === 'fetchTitle');
  await page.click('#addBtn');
  assert.equal(await page.locator('#reTitle').isVisible(), true);
  await page.click('#reTitle');                                                               // 空網址
  assert.match(await page.textContent('#titleHint'), /網址/);
  assert.equal(fetches().length, 0);
  await page.fill('#fUrl', 'not a url');
  await page.click('#reTitle');
  assert.match(await page.textContent('#titleHint'), /網址/);
  assert.equal(fetches().length, 0);
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/6200003');
  await page.waitForFunction(() => document.getElementById('fOrig').value === '自動帶入的原始標題');
  assert.equal(fetches().length, 1);
  await page.fill('#fOrig', '我手動改過的標題');
  api.st.titleResult = { title: '重新抓到的新標題', source: 'og:title' };
  await page.click('#reTitle');
  await page.waitForFunction(() => document.getElementById('fOrig').value === '重新抓到的新標題');   // 覆蓋手動輸入
  assert.equal(fetches().length, 2);
  api.st.titleResult = { title: null, reason: 'http_403' };
  await page.click('#reTitle');
  await page.waitForFunction(() => /403/.test(document.getElementById('titleHint').textContent));
  assert.equal(await page.inputValue('#fOrig'), '重新抓到的新標題');                              // 抓失敗不清掉原本的
  await page.click('#cancel');
  await pick(page, '4031880');
  await page.click('#card [data-act=edit]');
  assert.equal(await page.locator('#reTitle').isHidden(), true);
});

test('新增：只在第一次貼網址時自動讀一次標題；失敗後不再自動重抓，提示改按「重新讀取」，按了用目前網址再試', async (t) => {
  const { page, api } = await open(t);
  api.st.titleResult = { title: null, reason: 'http_403' };
  await connectRows(page);
  const fetches = () => api.st.calls.filter((c) => c.action === 'fetchTitle');
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/6300001');
  await page.waitForFunction(() => /403/.test(document.getElementById('titleHint').textContent));
  assert.equal(fetches().length, 1);
  assert.match(await page.textContent('#titleHint'), /重新讀取/);                              // 失敗提示指向重試的方法
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/6300002');                        // 改網址不會自動再抓
  await page.waitForTimeout(900);
  assert.equal(fetches().length, 1);
  assert.equal(await page.inputValue('#fOrig'), '');
  api.st.titleResult = { title: '重試成功的標題', source: 'og:title' };
  await page.click('#reTitle');
  await page.waitForFunction(() => document.getElementById('fOrig').value === '重試成功的標題');
  assert.equal(fetches().length, 2);
  assert.equal(fetches()[1].args.url, 'https://news.tvbs.com.tw/local/6300002');
  await page.click('#cancel');                                                                // 重新開啟視窗又是新的一次
  api.st.titleResult = { title: '第二次開啟', source: 'og:title' };
  await page.click('#addBtn');
  await page.fill('#fUrl', 'https://news.tvbs.com.tw/local/6300003');
  await page.waitForFunction(() => document.getElementById('fOrig').value === '第二次開啟');
  assert.equal(fetches().length, 3);
});
