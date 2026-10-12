// 用法: NODE_PATH=/opt/node22/lib/node_modules node swipe-test.js <html檔>
const { chromium } = require('playwright');
const fs = require('fs');
const SRC = process.argv[2];
// 套上與 Artifact 發布相同的外殼（viewport meta、[hidden] 規則、body 邊距歸零）
const WRAPPED = SRC.replace(/\.html$/, '') + '.wrapped.html';
fs.writeFileSync(WRAPPED, '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>:root{color-scheme:light}body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>' +
  fs.readFileSync(SRC, 'utf8') + '</body></html>');

const SEL = '.item[data-id="4032757"]';   // 範例資料裡有 3 個版本的那一則
const DESKTOP = { viewport: { width: 1000, height: 900 } };
const MOBILE = { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
let browser; const results = [];

async function fresh(opts) {
  const ctx = await browser.newContext(opts), page = await ctx.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  page.on('pageerror', e => console.log('   [pageerror]', e.message));
  await page.goto('file://' + WRAPPED, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.item');
  return { ctx, page };
}
const read = (page) => page.evaluate((sel) => {
  const it = document.querySelector(sel), car = it.querySelector('.car'), slides = [...car.querySelectorAll('.slide')];
  const offs = slides.map(s => s.offsetLeft - slides[0].offsetLeft), step = offs[1];
  return { left: Math.round(car.scrollLeft), idx: Math.round(car.scrollLeft / step),
           snapped: offs.some(o => Math.abs(o - car.scrollLeft) < 2), cnt: it.querySelector('.cnt').textContent,
           dots: [...it.querySelectorAll('.dot')].map(d => d.classList.contains('on') ? 1 : 0).join('') };
}, SEL);
const box = (page) => page.locator(SEL + ' .car').boundingBox();
const settle = (page) => page.waitForTimeout(900);
async function go(page, n) { for (let i = 0; i < n; i++) { await page.click(SEL + ' [data-act=next]'); await settle(page); } }

async function scenario(name, opts, fn, wantIdx) {
  const { ctx, page } = await fresh(opts);
  let got, ok;
  try { await fn(page, ctx); got = await read(page);
        ok = got.idx === wantIdx && got.snapped && got.cnt.includes(`${wantIdx + 1} / 3`) && got.dots[wantIdx] === '1'; }
  catch (e) { got = { err: e.message.split('\n')[0] }; ok = false; }
  results.push(ok);
  console.log((ok ? 'PASS' : 'FAIL'), name.padEnd(26),
    got.err ? got.err : `left=${got.left} 第${got.idx + 1}版 對齊=${got.snapped} 「${got.cnt}」圓點=${got.dots}`);
  await ctx.close();
}
const drag = (frac, dx) => async (page) => {
  const b = await box(page), y = b.y + 30, x = b.x + b.width * frac;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 }); await page.mouse.up(); await settle(page);
};
const swipe = (dx) => async (page, ctx) => {
  // 逐點送出觸控事件，模擬真實手指（touchStart → 多次 touchMove → touchEnd）
  await page.locator(SEL + ' .car').evaluate(e => e.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const cdp = ctx.__cdp || (ctx.__cdp = await ctx.newCDPSession(page)), b = await box(page);
  const x0 = Math.round(b.x + b.width * (dx < 0 ? 0.8 : 0.2)), y = Math.round(b.y + 30), steps = 12;
  let t = Date.now() / 1000; const pt = (x) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0), timestamp: t });
  for (let i = 1; i <= steps; i++) {
    t += 0.016;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x0 + dx * i / steps), timestamp: t });
    await new Promise(r => setTimeout(r, 16));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: t + 0.016 });
  await settle(page);
};


async function scenarioBool(name, opts, fn) {
  const { ctx, page } = await fresh(opts);
  let ok, info;
  try { [ok, info] = await fn(page, ctx); } catch (e) { ok = false; info = e.message.split('\n')[0]; }
  results.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name.padEnd(26), info); await ctx.close();
}

(async () => {
  browser = await chromium.launch();
  console.log('— 桌面：滑鼠拖曳 —');
  await scenario('往左拖 → 第2版', DESKTOP, drag(0.7, -160), 1);
  await scenario('第2版往右拖 → 第1版', DESKTOP, async (p) => { await go(p, 1); await drag(0.3, +160)(p); }, 0);
  await scenario('只拖一小段 → 不換頁', DESKTOP, drag(0.5, -15), 0);
  await scenario('大力拖 → 只前進1版', DESKTOP, drag(0.9, -700), 1);
  await scenario('最後一版再往左拖 → 不動', DESKTOP, async (p) => { await go(p, 2); await drag(0.7, -200)(p); }, 2);
  await scenario('第1版再往右拖 → 不動', DESKTOP, drag(0.3, +200), 0);
  console.log('— 桌面：其他方式 —');
  await scenario('滾輪橫向一格 → 第2版', DESKTOP, async (p) => { const b = await box(p); await p.mouse.move(b.x + 100, b.y + 30); await p.mouse.wheel(120, 0); await settle(p); }, 1);
  await scenario('鍵盤 → 第2版', DESKTOP, async (p) => { await p.locator(SEL + ' .car').focus(); await p.keyboard.press('ArrowRight'); await settle(p); }, 1);
  await scenario('鍵盤 → ← 回第1版', DESKTOP, async (p) => { await p.locator(SEL + ' .car').focus(); await p.keyboard.press('ArrowRight'); await settle(p); await p.keyboard.press('ArrowLeft'); await settle(p); }, 0);
  await scenario('按 › 兩次 → 第3版', DESKTOP, (p) => go(p, 2), 2);
  await scenario('按 › › ‹ → 第2版', DESKTOP, async (p) => { await go(p, 2); await p.click(SEL + ' [data-act=prev]'); await settle(p); }, 1);
  await scenario('觸控板連續橫滑 → 只前進1版', DESKTOP, async (p) => { const b = await box(p); await p.mouse.move(b.x + 100, b.y + 30); for (let i = 0; i < 25; i++) { await p.mouse.wheel(18, 0); await p.waitForTimeout(16); } await settle(p); }, 1);
  await scenario('觸控板往回橫滑 → 第1版', DESKTOP, async (p) => { await go(p, 1); const b = await box(p); await p.mouse.move(b.x + 100, b.y + 30); await p.mouse.wheel(-120, 0); await settle(p); }, 0);
  await scenario('直向滾輪 → 不換版', { viewport: { width: 1000, height: 420 } }, async (p) => { const b = await box(p); await p.mouse.move(b.x + 100, b.y + 30); await p.mouse.wheel(0, 200); await settle(p); }, 0);
  await scenarioBool('直向滾輪 → 頁面照常捲動', { viewport: { width: 1000, height: 420 } }, async (p) => {
    const b = await box(p); await p.mouse.move(b.x + 100, b.y + 30); await p.mouse.wheel(0, 200); await p.waitForTimeout(500);
    const y = await p.evaluate(() => window.scrollY); return [y > 0, 'scrollY=' + y]; });
  await scenarioBool('拖曳後沒有誤選取文字', DESKTOP, async (p) => {
    await drag(0.7, -160)(p); const t = await p.evaluate(() => String(getSelection())); return [t === '', JSON.stringify(t.slice(0, 20))]; });
  await scenarioBool('拖曳結束後恢復可對齊(無殘留dragging)', DESKTOP, async (p) => {
    await drag(0.7, -160)(p); const c = await p.evaluate((sel) => document.querySelector(sel + ' .car').className, SEL); return [!c.includes('dragging'), c]; });
  await scenarioBool('單版新聞不會被拖動', DESKTOP, async (p) => {
    const one = p.locator('.item[data-id="4031880"] .car'); const b = await one.boundingBox();
    await p.mouse.move(b.x + b.width * 0.7, b.y + 30); await p.mouse.down(); await p.mouse.move(b.x + 100, b.y + 30, { steps: 8 }); await p.mouse.up(); await p.waitForTimeout(400);
    const l = await one.evaluate(e => [e.scrollLeft, e.className]); return [l[0] === 0 && !l[1].includes('multi'), JSON.stringify(l)]; });
  console.log('— 手機：真實觸控手勢 —');
  await scenario('手指往左滑 → 第2版', MOBILE, swipe(-200), 1);
  await scenario('連滑兩次 → 第3版', MOBILE, async (p, c) => { await swipe(-200)(p, c); await swipe(-200)(p, c); }, 2);
  await scenario('第3版往右滑 → 第2版', MOBILE, async (p, c) => { await go(p, 2); await swipe(+200)(p, c); }, 1);

  console.log('— 版面 —');
  for (const [label, opts] of [['桌面', DESKTOP], ['手機', MOBILE]]) {
    const { ctx, page } = await fresh(opts);
    const m = await page.evaluate((sel) => {
      const it = document.querySelector(sel), r = (e) => e && e.getBoundingClientRect();
      const link = r(it.querySelector('a.link')), ot = r(it.querySelector('.ot')), btn = r(it.querySelector('[data-act=ctitle]'));
      const otEl = it.querySelector('.ot'), tag = it.querySelector('.src .tag');
      return { sameRowAsLink: ot && link && Math.abs((ot.top + ot.bottom) / 2 - (link.top + link.bottom) / 2) < 6,
               sameRowAsButtons: ot && btn && Math.abs((ot.top + ot.bottom) / 2 - (btn.top + btn.bottom) / 2) < 20,
               origBeforeNote: !!document.querySelector(sel + ' .orig'),
               truncated: otEl && otEl.scrollWidth > otEl.clientWidth, tag: !!tag,
               noPageOverflow: document.documentElement.scrollWidth <= window.innerWidth,
               otW: ot && Math.round(ot.width) };
    }, SEL);
    const ok = m.sameRowAsLink && m.noPageOverflow && !m.origBeforeNote && m.tag && (label === '手機' || m.sameRowAsButtons); results.push(ok);
    console.log(ok ? 'PASS' : 'FAIL', `${label}版面`, JSON.stringify(m));
    await ctx.close();
  }
  await browser.close();
  console.log(results.every(Boolean) ? '\n全部通過' : `\n${results.filter(x => !x).length} 項失敗 / 共 ${results.length} 項`);
})().catch(e => { console.error(e); process.exit(1); });
