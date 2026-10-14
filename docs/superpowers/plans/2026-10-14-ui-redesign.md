# 介面改版 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 熱門新聞庫網頁加上「顯示則數＋分頁」、固定頂欄、桌機版固定右側卡片，並把全站視覺統一成 QPT 安裝教學／推播精靈的設計語言。

**Architecture:** 分頁邏輯抽成不碰 DOM 的 `web/paging.js`（Node 與瀏覽器共用，仿 `qpt.js`）；`app.js` 的 `render()` 改為「篩選排序 → 分頁 → 渲染當頁」，並新增展開式選擇器與分頁列；版面與視覺全部在 `app.css`（外部樣式，遵守 CSP）。後端、Worker、QPT 不動。

**Tech Stack:** 純 HTML/CSS/ES2019 JavaScript、`node:test`、Playwright 1.56.1（既有）。

**Spec:** `docs/superpowers/specs/2026-10-14-ui-redesign-design.md`（以下「規格 §n」指其章節）

## Global Constraints

- CSP 不可改：`default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://*.workers.dev; img-src 'self' data:; base-uri 'none'; form-action 'none'`。HTML 不得有 `<style>`、`style=`、`on*=`；`app.css` 不得有 `@import`、`@font-face`、`url(`（`test/site.test.js` 會檢查）。圖示只用靜態 inline SVG（`fill`/`stroke` 屬性，不用 `style`）。
- 所有伺服器或使用者文字一律 `textContent`／`h()` 輸出，不用 `innerHTML`。
- 語法限 ES2019；不引入新依賴。
- 分支 `claude/funny-cori-751vpr`；commit 結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`、`Claude-Session: https://claude.ai/code/session_01YYz5CvaogW7L7c5XETUQhB`。不開 PR（使用者說「發布」才開、說「推」才合併）。
- 預設則數 `10`；localStorage 鍵 `hottopic.pageSize`；排序預設 `oldest`；斷點：手機 `≤820px`、桌機兩欄 `500px`（`≤940px` 時 `440px`）。
- 中間狀態（Task 2 結束時分頁列、選擇器尚未套新樣式）不會發布，只有整個分支完成後才合併。

## Review Focus

1. `localStorage` 被禁用（讀寫都丟例外）或存了壞值（`"7"`、`"abc"`）→ 回預設 10，頁面照常運作。
2. 載入中／連線錯誤／尚未連線／搜尋無結果時：不出現分頁列，不丟例外，`#cnt` 不顯示頁碼。
3. 刪除當頁最後一則（且為最後一頁）→ 頁碼夾回前一頁，不顯示空白頁。
4. 標記已使用讓選中的新聞排到別頁 → 頁碼跟著跳，列表選中列與右側卡片一致。
5. 選擇器展開時開啟設定／新增彈窗、或重新整理資料 → 選擇器收合，不殘留；Esc 只在展開時被選擇器吃掉，不影響彈窗關閉。
6. 視窗高度 < 500px 的桌機寬度 → 卡片改為隨頁面捲動（不被截斷）。

## File Structure

| 檔案 | 責任 |
|---|---|
| `web/paging.js`（新） | 分頁純函式，全域 `HotNewsPaging`＋`module.exports` |
| `test/paging.test.js`（新） | 上述函式單元測試 |
| `web/index.html` | 頂欄、展開式選擇器、分頁列、手機圖示按鈕、載入 `paging.js` |
| `web/app.js` | 分頁狀態、`makeXsel`、`renderPager`、選中項與頁碼同步、手機搜尋切換 |
| `web/app.css` | 依規格 §1、§2、§4 重寫 |
| `scripts/build-site.js`、`test/site.test.js` | 把 `paging.js` 納入建置與契約檢查 |
| `test/e2e/smoke.e2e.js` | 新增規格 §6 的情境 |
| `README.md`、`docs/manual-checklist.md` | 檔案表與手動驗證項目 |

---

### Task 1: 分頁純函式 `paging.js` 並納入建置

**Files:**
- Create: `web/paging.js`、`test/paging.test.js`
- Modify: `scripts/build-site.js`（`FILES` 加 `['web/paging.js','paging.js']`；`?v=` 正則加 `paging\.js`）、`web/index.html`（在 `qpt.js` 與 `app.js` 之間加 `<script src="paging.js" defer></script>`）、`test/site.test.js`

**Interfaces:**
- Produces（`HotNewsPaging`）：
  - `PAGE_SIZES: number[]` = `[5,10,15,20]`
  - `normalizeSize(v: unknown): number` — 只接受數字型別或全數字字串且在 `PAGE_SIZES` 內，否則 `10`
  - `pageCount(total: number, size: number): number` — `max(1, ceil(total/size))`
  - `clampPage(page: unknown, pages: number): number` — 取整、夾在 `1..pages`、非數字回 `1`
  - `slicePage<T>(list: T[], page: number, size: number): T[]`
  - `pageOf(list: {id:string}[], id: string, size: number): number` — 所在頁碼，找不到回 `0`
  - `pageWindow(page: number, pages: number): (number|'…')[]` — `pages ≤ 7` 全列；否則取 `{1, pages, page-1, page, page+1}` 去除超出範圍者排序，相鄰差 > 1 處插入 `'…'`

- [ ] **Step 1: 寫失敗測試 `test/paging.test.js`**（用 `require('../web/paging.js')`），斷言：
  - `normalizeSize`：`5→5`、`'10'→10`、`15→15`、`20→20`；`7、0、-5、null、undefined、''、'abc'、'1e1'、NaN→10`。
  - `pageCount`：`(0,10)→1`、`(1,10)→1`、`(10,10)→1`、`(11,10)→2`、`(128,10)→13`、`(128,20)→7`。
  - `clampPage`：`(0,5)→1`、`(9,5)→5`、`(-3,5)→1`、`(NaN,5)→1`、`('3',5)→3`、`(2.7,5)→2`。
  - `slicePage`：1..25 以 size 10 取第 1、3 頁為 `[1..10]`、`[21..25]`；空陣列回 `[]`。
  - `pageOf`：25 筆 id 為 `'1'..'25'`，`pageOf(list,'11',10)→2`、`'25'→3`、`'x'→0`。
  - `pageWindow`：`(1,1)→[1]`、`(3,7)→[1..7]`、`(1,13)→[1,2,'…',13]`、`(7,13)→[1,'…',6,7,8,'…',13]`、`(13,13)→[1,'…',12,13]`、`(4,8)→[1,'…',3,4,5,'…',8]`。
- [ ] **Step 2: 執行 `node --test test/paging.test.js`，確認因找不到模組而失敗**
- [ ] **Step 3: 實作 `web/paging.js`**：寫法同 `web/qpt.js`（頂層 `var HotNewsPaging = (function(){…})();`，末尾 `if (typeof module !== 'undefined' && module.exports) { module.exports = HotNewsPaging; }`），簽名見 Interfaces。
- [ ] **Step 4: 更新 `scripts/build-site.js`、`index.html`、`test/site.test.js`**：輸出檔為七個（排序後 `['api.js','app.css','app.js','index.html','lib.js','paging.js','qpt.js']`）；資源參照數 6；`?v=` 正則與載入順序 `['lib.js','api.js','qpt.js','paging.js','app.js']`。
- [ ] **Step 5: 執行 `npm test`**，預期全數通過（含新的 paging 測試）。
- [ ] **Step 6: Commit** `feat: 分頁純函式 paging.js 並納入建置`

---

### Task 2: 展開式選擇器與分頁行為（app.js＋index.html）

**Files:**
- Modify: `web/index.html`（`.sortrow` 內以兩個 `.xsel` 取代 `<select id="sort">`；`.rows` 之後加分頁列）、`web/app.js`、`test/site.test.js`（`IDS` 去掉 `'sort'`、加入 `'sortX','sizeX','pager'`；刪除檢查 `<select id="sort">` 選項的斷言，改為檢查 `app.js` 內 `oldest,recent,count,created` 四個值仍存在）、`test/e2e/smoke.e2e.js`

**Interfaces:**
- Consumes: Task 1 的 `HotNewsPaging.*`。
- Produces（HTML 契約，Task 3 的 CSS 依此）：

```html
<div class="xsel" id="sortX">           <!-- sizeX 同結構；展開時加 data-open="true" -->
  <button type="button" class="xsel-btn" aria-haspopup="true" aria-expanded="false">
    <span class="xsel-lbl">排序</span><span class="xsel-val"></span><span class="xsel-caret" aria-hidden="true">▾</span>
  </button>
  <div class="xsel-opts" role="radiogroup" aria-label="排序" hidden></div>   <!-- 內容由 JS 以 <button role="radio" aria-checked data-v> 產生 -->
</div>
<nav class="pager" id="pager" aria-label="分頁" hidden></nav>               <!-- 子元素：<button data-page="n">；目前頁 aria-current="page"；'…' 為 <span class="gap"> -->
```

- 排序選項（值→字）：`oldest 久未用`、`recent 最近用`、`count 次數`、`created 最新`；收合時 `.xsel-val` 顯示當前字（排序）或 `N 則`（則數，例如 `10 則`），選項字只有數字 `5/10/15/20`。
- `app.js` 內新增：`makeXsel(rootId: string, cfg: {options:{v:string,label:string}[], get:()=>string, set:(v:string)=>void, valueText:(v:string)=>string})`、`renderPager(pages: number): void`、`loadSize(): number`、`saveSize(n: number): void`、`goView(page?: number): void`（使用者操作改變檢視：`state.sel=null; state.page=page||1; render()`）。`state` 新增 `size`（初值 `loadSize()`）與 `page`（初值 1）。

- [ ] **Step 1: 在 `smoke.e2e.js` 加輔助與失敗測試**。輔助 `seedMany(api, n)`：種 n 筆 `{id:String(5000+i), cat:'生活', url:'https://news.tvbs.com.tw/local/'+(5000+i), orig:'測試新聞 '+i, titles:[{ver:1,t:'標題 '+i,last:null,count:0}], created: api.st.now - i}`（`last` 皆為 null，`oldest` 排序維持種入順序）。以下每項各一個 `test(...)`，皆先 `open(t)`（`seedSample` 的 3 則加 `seedMany(api,25)` 共 28 則）→ `connect(page)`：
  1. 預設 10 列；`#cnt` 為 `共 28 則・第 1／3 頁`；`#pager` 可見、含 `button[data-page="3"]`；`‹` 為 disabled。只有 3 則樣本時 `#pager` 為 hidden。
  2. `#sortX .xsel-opts`、`#sizeX .xsel-opts` 初始皆不可見；點 `#sizeX .xsel-btn` → 選項可見、`aria-expanded="true"`；點 `#sizeX [data-v="5"]` → 列數 5、`#cnt` 為 `共 28 則・第 1／6 頁`、選項收合、按鈕值文字 `5 則`、焦點回到按鈕。
  3. 展開 `#sizeX` 後按 Esc、點頁面空白處、點 `#sortX .xsel-btn` 各自會收合（後者同時只剩 sortX 展開）。展開時按 `ArrowRight` 焦點移到下一個 radio。
  4. 選 15 → `reload`（`page.reload()` 後 `connect` 並勾記住或用 `init` 保持登入，沿用既有「勾記住」測試手法）→ 仍是 15 則；`localStorage['hottopic.pageSize']==='15'`。
  5. 用 `init` 腳本讓 `localStorage.getItem/setItem` 一律丟例外 → 頁面仍可載入、顯示 10 列、切換則數不當掉（Review Focus 1）；另一個測試先寫入 `hottopic.pageSize='7'` → 回 10。
  6. 翻頁：點 `#pager [data-page="2"]` → `#cnt` 為 `第 2／3 頁`、選中列與 `#card .item` 的 `data-id` 都是第 2 頁第一則、`window.scrollY===0`；換分類 chip、`#q` 輸入、換排序、換則數都回第 1 頁且選中該頁第一則。
  7. 資料變動跟頁碼：預設 `oldest`：樣本中只有 `4032757` 有 `last`，其餘 27 則 `last` 皆為 null，所以第 1 頁選中的第一則是 `4031880`（記為 `X`，有 1 個改標）。在卡片連按兩次 `[data-act=mark]` 完成標記 → `X` 排到最後一頁，`#cnt` 變 `第 3／3 頁`，`.row[data-id=X][aria-selected=true]` 存在且 `#card .item` 的 `data-id===X`。
  8. 刪除夾回：`seedMany` 改種 21 筆（共 24 筆、size 10 → 3 頁），翻到第 3 頁、刪除當頁全部 4 筆（用既有兩段式刪除手法逐筆）後，`#cnt` 顯示 `第 2／2 頁`，`.row` 非空。
  9. 空狀態：`#q` 輸入 `(` → 列表為「沒有符合的新聞」、`#pager` hidden、`#cnt` 為 `共 0 則`（不含頁碼）；重新連線前（尚未設定）`#pager` hidden（Review Focus 2）。
  10. 展開 `#sortX` 後點 `#settingsBtn` → 設定彈窗開啟且 `#sortX` 已收合；彈窗內按 Esc 能關閉彈窗（Review Focus 5）。
- [ ] **Step 2: 執行 `node --test --test-concurrency=1 test/e2e/smoke.e2e.js`**，確認新增項目失敗（既有項目維持通過；失敗的項目各會等 30 秒逾時，屬預期）。
- [ ] **Step 3: 改 `web/index.html`**：依 Interfaces 的契約加入 `#sortX`、`#sizeX`（放在原 `.sortrow` 內，`#cnt` 在左、兩個選擇器包成 `.ctl` 在右）、`#pager`（緊接 `#list` 之後，同在 `.pane-l` 內）。移除 `<select id="sort">`。
- [ ] **Step 4: 實作 `web/app.js`**：
  - `visibleItems()` 的排序邏輯不變；`state.sort` 由 `sortX` 的 `set` 寫入並呼叫 `goView()`。
  - `render()`：算出 `r` 與 `pages = pageCount(r.length, state.size)`；若 `state.sel` 在 `r` 內 → `state.page = pageOf(r, state.sel, state.size)`；否則 `state.page = clampPage(state.page, pages)`，改選 `slicePage(r, state.page, state.size)[0]`（沿用原本重設 `copied/pendingMark/showDetail(false)` 的程式）；只渲染當頁的列；`#cnt` 為 `'共 ' + r.length + ' 則・第 ' + page + '／' + pages + ' 頁'`；`renderPager(pages)`。`plain()` 與「沒有符合」分支把 `#pager.hidden = true`，且 `#cnt` 為空或 `共 0 則`（無頁碼）。
  - `renderPager(pages)`：`pages ≤ 1` 時 `hidden`；否則以 `pageWindow` 產生 `‹`、頁碼、`…`、`›`；`‹`/`›` 在首／末頁 `disabled`；目前頁 `aria-current="page"`。事件委派：點 `button[data-page]` → `goView(n)` 並 `window.scrollTo(0, 0)`。
  - chips 點擊與 `#q` 輸入改呼叫 `goView()`（取代原本直接 `render()`）。
  - `makeXsel`：點按鈕切換展開（先收合另一個）；展開時 `hidden=false`、`aria-expanded=true`、`data-open="true"`；選項 `click` → `set(v)`、收合、焦點回按鈕；`document` 的 `click`（元件外）與 `keydown Escape`（僅在有展開時 `preventDefault` 並收合）收合；`ArrowLeft/ArrowRight` 在 radio 間移動焦點。`openDialog`、`openSettings` 開頭先呼叫 `closeXsels()`；`loadItems()` 重新載入時也呼叫。
  - `loadSize()`/`saveSize()`：包 `try/catch`，用 `HotNewsPaging.normalizeSize`；`sizeX` 的 `set` 存檔並 `goView()`。
- [ ] **Step 5: 執行整套 e2e**（`npm run test:e2e`），預期含新增共約 34 個情境全數通過。
- [ ] **Step 6: 執行 `npm test`**，預期通過。
- [ ] **Step 7: Commit** `feat(web): 顯示則數、排序展開式選擇器與分頁`

---

### Task 3: 版面與視覺統一（頂欄、固定卡片、手機圖示、app.css 重寫）

**Files:**
- Modify: `web/index.html`（頂欄結構、拿掉 `.app` 外框）、`web/app.css`（整份依規格 §1、§2、§4 重寫）、`web/app.js`（手機搜尋切換）、`test/e2e/smoke.e2e.js`

**Interfaces:**
- Consumes: Task 2 的 `.xsel`、`#pager` 契約與 ids。
- Produces（HTML 契約）：

```html
<header class="topbar">
  <h1>熱門新聞庫</h1>
  <div class="search"><input type="search" id="q" ...></div>
  <div class="tools">
    <button class="btn icon-only-sm" id="searchBtn" type="button" aria-label="搜尋" aria-expanded="false"><svg class="ico" ...></svg></button>
    <button class="btn" id="settingsBtn" type="button" aria-label="設定"><svg class="ico" ...></svg><span class="lbl">設定</span></button>
    <button class="btn primary" id="addBtn" type="button" aria-label="新增新聞"><svg class="ico" ...></svg><span class="lbl">＋ 新增新聞</span></button>
  </div>
</header>
<div class="wrap"><div class="split"><section class="pane-l">…</section><section class="pane-r"><div id="card"></div></section></div><p class="foot">…</p></div>
```

  `#searchBtn` 只在 ≤820px 顯示；點擊切換 `body.searching`（顯示第二列搜尋框並聚焦 `#q`，`aria-expanded` 同步；`#q` 有字時按鈕加 `.on`）。桌機 `.ico` 隱藏、`.lbl` 顯示；手機相反。
- CSS 變數：`--topbar-h:64px`；新 token 依規格 §4 表（`--accent --accent-dark --accent-soft --text --muted --border --track --shadow --ok`＋選中 chip 三色）；舊名稱（`--bg --surface --ink --line --edge --soft --blue --blue-fg --glow --fg --accent-fg --accent-soft`）保留並指向新 token。

- [ ] **Step 1: 寫失敗 e2e**（視窗 1280×800，種 `seedMany(api,25)`＋樣本，在 `connect` 之後）：
  1. 頂欄固定：`window.scrollTo(0, 600)` 後，`page.evaluate(() => document.querySelector('.topbar').getBoundingClientRect().top)` 為 `0`；`getComputedStyle(.topbar).position==='sticky'`。
  2. 卡片固定：捲動前記錄 `#card .item` 的 `getBoundingClientRect().top`，`scrollTo(0,600)` 後 `top` 相同（誤差 ≤ 1px）；卡片底部 `≤ window.innerHeight`。
  3. 卡片內部可捲：對選中新聞 `openDialog` 編輯加入一則很長的小編文（> 3000 字、換行多）後卡片 `scrollHeight > clientHeight` 且 `overflow-y` 為 `auto`；頁面本身 `scrollWidth ≤ innerWidth`。
  4. 矮視窗：視窗 1280×450 時 `.pane-r` 的 `position` 為 `static`（Review Focus 6）。
  5. 手機 390×844：頂欄只見標題與三顆圖示按鈕，`.lbl` 不可見；`#q` 初始不可見；點 `#searchBtn` → `#q` 可見且為 `document.activeElement`、輸入 `行家` 後只剩 1 列；點列才顯示卡片，`返回` 回列表（沿用既有手機測試的斷言）；`#settingsBtn`、`#addBtn` 點擊分別開啟對應彈窗；無橫向溢出。
  6. 既有「手機寬度」測試不修改仍通過。
- [ ] **Step 2: 執行 e2e，確認新項目失敗**。
- [ ] **Step 3: 改 `web/index.html`**：照 Interfaces 重排頂欄（`header.topbar` 移到 `.wrap` 之外並拿掉 `.app` 外框，`.split` 與 `.foot` 留在 `.wrap`）；SVG 圖示 24×24 viewBox，`fill="none" stroke="currentColor" stroke-width="2"`，三個：放大鏡、齒輪（簡化為圓＋短線亦可）、加號。
- [ ] **Step 4: 重寫 `web/app.css`**，逐項對照規格：
  - §1：頂欄 sticky（`top:0; z-index:40; height:var(--topbar-h)`；`grid-template-columns:1fr minmax(0,360px) 1fr`；半透明底＋`backdrop-filter:blur(14px)`＋`@supports not (backdrop-filter:blur(1px))` 退回不透明）；`.wrap{max-width:1400px}`；`.split{grid-template-columns:minmax(0,1fr) 500px;gap:24px}`（`≤940px` 為 440px）；`.pane-r{position:sticky; top:calc(var(--topbar-h) + 16px); height:calc(100vh - var(--topbar-h) - 32px); height:calc(100dvh - var(--topbar-h) - 32px)}`，其內 `.item{max-height:100%; overflow-y:auto}`；`@media (min-width:821px) and (max-height:500px)` 改 `position:static;height:auto`。手機 `≤820px`：單欄、圖示按鈕、`body.searching` 顯示搜尋列、`body.detail` 隱藏頂欄與列表、卡片靜態。
  - §2：`.xsel` 與 `.xsel-opts` 的軌道／選中樣式（軌道 `--track`、4px 內距、選中白底加 `0 4px 14px -6px rgba(0,74,173,.5)`；展開時 `.xsel-val`、`.xsel-caret` 隱藏、焦點環 `0 0 0 3px var(--accent-soft)`）；`prefers-reduced-motion` 下不加動畫。
  - §4：三種按鈕、列表列、卡片、`.lw-box` 樣式區塊、chips、彈窗、頁面背景漸層（深色模式用深藍底）、`.pager` 圓形頁碼按鈕。深色 token 依規格表。
- [ ] **Step 5: 改 `web/app.js`**：`#searchBtn` 點擊切換 `body.searching`、同步 `aria-expanded` 與聚焦；`#q` 的 `input` 事件順便切換 `#searchBtn.on`；視窗放寬到 >820px 時清掉 `body.searching`（監聽 `MOBILE` 的 `change`）。
- [ ] **Step 6: 執行 `npm test && npm run test:e2e`**，預期全數通過。
- [ ] **Step 7: 目視檢查**：用 Playwright 對 1440×900（淺色、深色）與 390×844 各截一張圖（存在 scratchpad，不入庫），確認頂欄、卡片、展開／收合狀態與規格 §1、§2、§4 一致；有落差就回 Step 4 修。
- [ ] **Step 8: Commit** `feat(web): 固定頂欄、固定右側卡片與統一視覺`

---

### Task 4: 文件與最終驗證

**Files:**
- Modify: `README.md`（`web/` 那列加入 `paging.js`，輸出檔數改為七個；`pages.yml` 說明處的「五個檔」改「七個檔」）、`docs/manual-checklist.md`（新增「介面改版」小節，項目見下）

- [ ] **Step 1: 更新 README 與手動清單**。手動項目：實機 Chrome 與手機各看淺色／深色；頂欄模糊與固定；桌機列表往下捲時右側卡片不動、卡片過長時卡片內部可捲；排序與顯示則數膠囊點一下才展開、選完收合；換則數後重新整理仍保留；翻頁後回到頁面頂端、選中該頁第一則；手機版搜尋與設定圖示可用；視窗縮到很矮時卡片隨頁面捲動。
- [ ] **Step 2: 執行 `npm run test:all`** 與 `npm run build`，預期全數通過、`_site/` 內為七個檔。
- [ ] **Step 3: 檢查 CSP**：e2e 已逐測試斷言無 `securitypolicyviolation`；另手動確認 `grep -n "style=\|<style\|url(" web/index.html web/app.css` 無輸出。
- [ ] **Step 4: Commit** `docs: 介面改版的檔案表與手動驗證清單`，推送到 `claude/funny-cori-751vpr`。
