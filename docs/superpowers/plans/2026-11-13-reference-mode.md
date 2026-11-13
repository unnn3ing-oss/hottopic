# 參考模式 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 熱門新聞庫加上「參考模式」：同一頁切換，收集「某人對某篇新聞的改標」，可依人與主題分類篩選，新增時有「本班預設人選」記憶。

**Architecture:** 試算表新增獨立分頁「參考」＋ Apps Script 四個新動作（`listRefs`／`addRef`／`updateRef`／`deleteRef`）；前端 `app.js` 新增 `state.mode`，參考模式重用列表、分頁、搜尋、新增視窗，各自的渲染與送出邏輯獨立成函式，不動新聞庫路徑。班段、文章比對等純函式放 `apps-script/lib.js`（可測）。Worker 不動。

**Tech Stack:** 純 HTML/CSS/ES2019 JavaScript、Google Apps Script、`node:test`、Playwright 1.56.1（既有）。

**Spec:** `docs/superpowers/specs/2026-11-13-reference-mode-design.md`（以下「規格」）

## Global Constraints

- CSP 不可改：`default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://*.workers.dev; img-src 'self' data:; base-uri 'none'; form-action 'none'`。HTML 不得有 `<style>`、`style=`、`on*=`；`app.css` 不得有 `@import`、`@font-face`、`url(`（`test/site.test.js` 檢查）。
- 伺服器與使用者文字一律 `textContent`／`h()` 輸出，不用 `innerHTML`。語法限 ES2019；不引入新依賴；不新增 `web/` 檔案（`build-site.js` 與「十個檔」檢查不變）。
- `apps-script/lib.js`：頂層只用 `var` 與 `function`，不得用 `window`、`document`、`URL` 等（Apps Script 與瀏覽器共用）。
- 分頁名「參考」，欄位順序固定：`id`、`分類`、`原始標題`、`原文連結`、`改標`、`參考誰`、`建立時間`；編號 `R` + 流水號（R1、R2…）。
- 限制：參考誰 ≤ 30 字（單行，換行壓成空格）、改標 ≤ 500 字（沿用 `LIMITS.title`，可換行）、原始標題 ≤ 500 字。
- 班段（台北時間）：00:00–08:00、08:00–16:00、16:00–24:00；預設人選存 localStorage 鍵 `hottopic.refWho`，內容 `{ who, shift }`；上次模式存鍵 `hottopic.mode`（`'lib'`／`'ref'`）。localStorage 讀寫一律 try/catch，失敗就當沒有。
- 重複判斷：「同一篇」（`articleKey`）＋「同一人」才重複；同篇不同人允許。
- 新聞庫模式的資料、行為、畫面不得有任何退步：既有 `npm test` 與 `npm run test:e2e` 每個 task 結束都要全綠。
- 分支 `claude/upbeat-bell-kp5rqh`；commit 結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`、`Claude-Session: https://claude.ai/code/session_01T1bNur85XSnYVqitxbznFv`。不開 PR。
- 中間狀態（Task 3 結束時還不能新增）不會發布，整個分支完成後才合併。

## Review Focus

1. **同網址多人**：同篇不同人可並存；同篇同人（含網址帶 `?from=x`、人名前後空白／換行）被擋並回既有那筆。→ Task 2、Task 4。
2. **舊後端**：`listRefs` 回 `bad_request` 時，參考模式顯示「後端還沒更新」，新聞庫完全正常。→ Task 3。
3. **人名與改標邊界**：人名 30 字可、31 字不可；全空白人名／改標被拒；以 `=` 開頭的改標存成文字不被當公式。→ Task 2、Task 4。
4. **試算表被手動改亂**：「參考」分頁出現空 id、重複 id、改標或參考誰空白的列 → 略過，不讓整頁載入失敗。→ Task 2。
5. **班段邊界與時區**：07:59:59 與 08:00:00 不同班；23:59:59 與隔天 00:00:00 不同班；瀏覽器時區不是台北時照台北算；localStorage 壞掉／被禁用不當機。→ Task 1、Task 5。

## File Structure

| 檔案 | 責任 |
|---|---|
| `apps-script/lib.js` | 新增 `LIMITS.who`、`shiftKey`、`articleKey`、`nextRefId` |
| `apps-script/Code.gs` | 「參考」分頁、四個新動作、抽出 `readCats_` |
| `web/index.html` | 模式開關、人那排篩選、參考專用排序選單、對話框的參考欄位 |
| `web/app.js` | `state.mode`、參考列表／卡片／篩選、參考新增編輯刪除、班段預設 |
| `web/app.css` | 模式開關、兩排篩選、參考卡片樣式、對話框依模式隱藏欄位 |
| `test/helpers/fake-api.js` | 假 API 補參考動作與範例資料 |
| `test/lib.test.js`、`test/backend-refs.test.js`（新）、`test/site.test.js`、`test/e2e/smoke.e2e.js` | 測試 |
| `README.md`、`docs/manual-checklist.md` | 說明與重新部署提醒 |

---

### Task 1: lib.js 純函式（班段、文章比對、編號）

**Files:**
- Modify: `apps-script/lib.js`（`LIMITS`、新函式、`module.exports`）
- Test: `test/lib.test.js`（沿用該檔既有的 require 方式）

**Interfaces:**
- Produces:
  - `LIMITS.who = 30`
  - `shiftKey(ms: number): string` → `'YYYY-MM-DD#n'`，日期為台北日期，`n` = 0（00–08）、1（08–16）、2（16–24）
  - `articleKey(url: string): string` → `extractId(url) || String(url).trim()`
  - `nextRefId(ids: string[]): string` → `'R' + (符合 /^R(\d+)$/ 的最大數字 + 1)`，沒有則 `'R1'`

- [ ] **Step 1: 寫失敗測試**（`test/lib.test.js`）
  - `shiftKey 班段邊界`：`Date.parse('2026-11-13T07:59:59+08:00')` → `'2026-11-13#0'`；`08:00:00+08:00` → `'2026-11-13#1'`；`15:59:59+08:00` → `'2026-11-13#1'`；`16:00:00+08:00` → `'2026-11-13#2'`；`23:59:59+08:00` → `'2026-11-13#2'`；`2026-11-14T00:00:00+08:00` → `'2026-11-14#0'`。
  - `shiftKey 不受執行環境時區影響`：`Date.parse('2026-11-13T16:00:00Z')`（台北 11-14 00:00）→ `'2026-11-14#0'`。
  - `articleKey`：`'https://news.tvbs.com.tw/local/4031880?from=x'` → `'4031880'`；`' https://example.com/abc '` → `'https://example.com/abc'`。
  - `nextRefId`：`[]` → `'R1'`；`['R1','R9','N5','R10']` → `'R11'`；`['N7']` → `'R1'`。
  - `LIMITS.who === 30`。
- [ ] **Step 2: 執行確認失敗**：`node --test test/lib.test.js`，預期新測試 FAIL（函式未定義）。
- [ ] **Step 3: 實作**上述簽名於 `apps-script/lib.js`；`shiftKey` 用既有 `dateStrTaipei` 與 `TAIPEI_OFFSET_MS` 取得台北日期與小時；三個函式加進 `module.exports`。
- [ ] **Step 4: 執行確認通過**：`node --test test/lib.test.js` 全 PASS；再跑 `npm test` 確認沒有其他測試壞掉。
- [ ] **Step 5: Commit**：`git add apps-script/lib.js test/lib.test.js && git commit -m "feat: lib 新增班段、文章比對與參考編號函式"`（加結尾標註）

---

### Task 2: 後端「參考」分頁與四個動作

**Files:**
- Modify: `apps-script/Code.gs`
- Test: `test/backend-refs.test.js`（新；自備 `setup()`：`createFakeGas` + `loadBackend`，寫法同 `test/backend.test.js` 開頭）

**Interfaces:**
- Consumes: Task 1 的 `LIMITS.who`、`articleKey`、`nextRefId`。
- Produces（API，回應格式與既有動作相同 `{ok, data}`／`{ok:false, code}`）：
  - `listRefs {}` → `{ items: Ref[], cats: string[] }`
  - `addRef {url, orig, cat, title, who}` → `{ item: Ref }`；重複回 `duplicate` 並附 `existing`
  - `updateRef {id, cat, title, who}` → `{ item: Ref }`；錯誤碼 `not_found`、`bad_request`、`duplicate`
  - `deleteRef {id}` → `{ id }`；`not_found`
  - `Ref = { id: string, cat: string, orig: string, url: string, title: string, who: string, created: number(ms) }`
- 內部：`readCats_(db)`（把 `readAll_` 內讀分類的迴圈原樣抽出，`readAll_` 改呼叫它，行為不變）；`refsSheet_(db)`（用 `ensureSheet_` 取得／建立「參考」；**只有四個參考動作會呼叫，`db_()` 不變**，所以沒用參考模式就不會多出分頁）；`readRefs_(db)` → `{ items, byId, rowOf }`。

- [ ] **Step 1: 寫失敗測試**（`test/backend-refs.test.js`）
  - `listRefs 空表`：`ok`，`items` 為 `[]`，`cats` 為六個預設分類；建出的「參考」分頁第 1 列為上列欄位；`gas.dump('參考')[0]` 逐欄相等。
  - `沒用參考動作就不建分頁`：只呼叫 `ping`、`listItems` 後，`gas.spreadsheet.getSheetByName('參考')` 為 `null`。
  - `addRef 基本`：回 `item.id === 'R1'`、`created` 為數字；第二筆為 `'R2'`；`listRefs` 回兩筆且欄位完整。
  - `同網址不同人允許`（Review Focus 1）：同網址 who 分別為 `'小明'`、`'小華'` 都成功。
  - `同篇同人重複`（Review Focus 1）：再用同網址同 who → `code === 'duplicate'` 且 `existing.id` 為第一筆；網址改成 `...4031880?from=x`、who 改成 `' 小明\n'` 仍 `duplicate`。
  - `驗證`（Review Focus 3）：缺／全空白改標、改標 501 字、who 空白、who 31 字、分類不在清單、網址不合規、原標空白、欄位型別非字串 → 各自 `bad_request`；who 剛好 30 字、改標剛好 500 字成功。
  - `公式字元`（Review Focus 3）：改標 `'=1+1'` 存入後 `listRefs` 回 `'=1+1'`，`gas.dump('參考')` 該格為字串 `'=1+1'`。
  - `updateRef`：可改分類／改標／參考誰；`orig`、`url` 不變；改成同篇已存在的人 → `duplicate`；不存在的 id → `not_found`；分類不在清單且與原分類不同 → `bad_request`；分類沒改但已不在清單 → 成功。
  - `deleteRef`：刪掉指定那列、其他列保留；再刪一次 → `not_found`。
  - `手動改亂的資料`（Review Focus 4）：用 `gas.seedRows('參考', ...)` 補入空 id 列、重複 id 列、改標空白列、參考誰空白列、`建立時間`為 `Date` 的列 → `listRefs` 只回合法且不重複的列，`created` 為數字，不丟例外。
  - `忙碌`：`gas.lockHeld = true` 時 `addRef` 回 `busy`。
- [ ] **Step 2: 執行確認失敗**：`node --test test/backend-refs.test.js`，預期 FAIL（`bad_request`：動作未註冊）。
- [ ] **Step 3: 實作**
  - `SHEET.refs = '參考'`、`HEADERS.refs`；`refFormats_()` = 前六欄文字格式、第七欄 `DATE_FORMAT`。
  - `readRefs_`：略過空 id、重複 id、改標或參考誰空白的列；`created` 用 `toMs_`。
  - `addRef_`／`updateRef_`／`deleteRef_` 驗證與寫入沿用 `addItem_` 等既有寫法：`normalizeUrl`、`normalizeLine`（原標、參考誰）、`normalizeText`（改標）、`withLock_`、`writeBlock_`／`writeText_`；重複判斷用 `articleKey(r.url) === articleKey(url) && r.who === who`；id 用 `nextRefId`；更新時第 2–6 欄一次寫回（原標與網址寫原值）。
  - 四個動作加進 `ACTIONS`。
- [ ] **Step 4: 執行確認通過**：`node --test test/backend-refs.test.js` 全 PASS；`npm test` 全綠（確認 `readCats_` 抽出沒改變既有行為）。
- [ ] **Step 5: Commit**：`git add apps-script/Code.gs test/backend-refs.test.js && git commit -m "feat: 後端新增「參考」分頁與 listRefs／addRef／updateRef／deleteRef"`

---

### Task 3: 前端模式開關與參考列表（唯讀）

**Files:**
- Modify: `web/index.html`、`web/app.js`、`web/app.css`、`test/helpers/fake-api.js`、`test/site.test.js`、`test/e2e/smoke.e2e.js`

**Interfaces:**
- Consumes: Task 2 的 `listRefs`；Task 1 的 `articleKey`。
- Produces（供 Task 4、5 使用）：
  - `fake-api`：`st.refs: Ref[]`、`st.noRefs: boolean`（true 時四個參考動作視為未知動作，回 `bad_request`，模擬舊後端）、`api.seedRef(partial)`、`seedRefSample(api)`（匯出）；登入回應補 `ttl: 43200`（讓 Task 5 固定瀏覽器時間時，憑證不會因本機與伺服器時鐘不同而判為過期）。
  - `index.html`：`#modeLib`、`#modeRef`（`button`，`aria-pressed`）、`#whoChips`（人那排，`hidden`）、`#refSortX`（結構同 `#sortX`，選項「最新 `created`」「最舊 `oldest`」）。
  - `app.js` 狀態：`state.mode: 'lib'|'ref'`、`state.refs: Ref[]`、`state.refStatus: 'idle'|'loading'|'ready'|'error'|'legacy'`、`state.who: string`（預設 `'全部'`）、`state.refCat: string`（預設 `'全部'`）、`state.refSort: 'created'|'oldest'`。
  - `app.js` 函式：`setMode(mode)`、`loadRefs(): Promise`、`reload()`（依模式呼叫 `loadRefs` 或 `loadItems`；`mutate` 內原本呼叫 `loadItems()` 處改呼叫 `reload()`）、`byRef(id): Ref|undefined`、`replaceRef(ref)`、`visibleRefs(): Ref[]`、`renderRefChips()`、`buildRefRow(ref)`、`buildRefCard(ref)`、`renderRef()`。
  - 參考卡片：`article.item.ref[data-id]`；按鈕 `data-act`：`rcopy`（複製標題）、`redit`（編輯，Task 4 接）、`rother`（點同篇其他人的改標，帶 `data-id`，選中該筆）。

**行為（規格「前端」「畫面草圖」）：**
- 頂欄標題旁的開關：「新聞庫」「參考」。`setMode` 會：存 `hottopic.mode`、`body` 切換 `refmode` class、清空搜尋框與 `state.q`、`state.sel = null`、`state.page = 1`、新增按鈕文字改為「＋ 新增參考」（`aria-label` 同步；回新聞庫改回「＋ 新增新聞」）、顯示對應的排序選單（參考模式藏 `#sortX`、顯示 `#refSortX`）、顯示／隱藏 `#whoChips`；切進參考模式且 `refStatus` 為 `idle` 或 `error` 時呼叫 `loadRefs()`。啟動時讀 `hottopic.mode`，登入成功與「重試」「清除設定」也要依模式處理（`sClear` 要清 `state.refs` 並設 `refStatus='idle'`）。
- `loadRefs()`：`refStatus='loading'` → `callApi('listRefs', {})` → 成功時設 `state.refs`、`state.cats`、`refStatus='ready'`；失敗時 `e.code === 'bad_request'` 設 `'legacy'`，其他設 `'error'`。
- 狀態文字：legacy →「後端還沒更新，請重新部署（見 README）。」（附「重試」）；ready 且無資料 →「還沒有任何參考。」＋按鈕「＋ 新增參考」（`data-act="add-first"`）；篩選後無結果 →「沒有符合的參考。調整搜尋、人或分類，或按「＋ 新增參考」。」；其餘沿用既有「載入中…」「尚未連線…」。
- 篩選：人那排（`#whoChips`，前置小標「人」）＝「全部」＋ 資料中不重複的人，依筆數降冪、同數依 Unicode 排序；分類那排（`#chips`，前置小標「分類」）＝「全部」＋ `allCats()`（需把 `state.refs` 的分類也納入）。**沒有「已到期」chip**。兩排取交集；數字連動（人那排的數字依目前分類算、分類那排依目前選的人算）。`state.who` 指向已不存在的人時退回「全部」（同現有分類做法）。`#chips` 的點擊處理在參考模式改寫 `state.refCat`。
- 搜尋範圍：改標、原標、參考誰、編號（不分大小寫）。排序：`created`（預設，新到舊）、`oldest`；`#refSortX` 選擇時同 `goView()`。
- 列：`h3` 為改標（換行換成空格），`.sub` 顯示人（class `who`）、分類、編號。
- 卡片：頂部「參考 `#R12`」、分類、人；`原始` 標籤＋原標；`改標` 區塊顯示改標與「參考：小明」；「同一篇其他人的改標」區塊列出同 `articleKey` 的其他筆（人＋改標單行，每筆為 `rother` 按鈕，沒有其他人就不顯示區塊）；按鈕「複製標題」「編輯」。複製不會標記使用。
- `renderCard`、`selectItem`、列表點擊與鍵盤處理都要依 `state.mode` 找對的資料（`byRef` 或 `byId`）；參考模式的卡片點擊走獨立分支（`b.closest('.item.ref')`），不經過新聞庫的 `ctitle`／`mark` 等處理。
- `.foot` 說明文字在 `refmode` 時隱藏。

- [ ] **Step 1: 寫失敗測試**
  - `site.test.js`：`IDS` 補 `modeLib`、`modeRef`、`whoChips`、`refSortX`；執行 `node --test test/site.test.js` 預期 FAIL。
  - `fake-api.js`：實作上述 `st.refs`／`noRefs`／`seedRef`／`seedRefSample`／`listRefs`／登入 `ttl`。`seedRefSample` 四筆（`created` 由舊到新 R1→R4，每筆含 `id`,`cat`,`orig`,`url`,`title`,`who`,`created`）：R1 `4031880` 社會 小明、R2 同網址 社會 小華、R3 `4032757` 生活 小明、R4 `4035001` 健康 阿美；標題各不同且含可辨識字樣（例如「小明版」「小華版」）。
  - `smoke.e2e.js`（先新增一個以 `seedRefSample` 開場的小 helper，沿用 `open`／`connect`）：
    - `參考模式：切換、列表與兩排篩選`：點 `#modeRef` → 4 列；人那排為「全部 4、小明 2、小華 1、阿美 1」且依序；點「小明」→ 2 列，分類那排數字變成 社會 1、生活 1、健康 0；再點「社會」→ 1 列（R1）；點人那排「全部」→ 2 列（社會）；沒有「已到期」chip；切回新聞庫 → 有「已到期」chip、列數回 3。
    - `參考模式：搜尋與排序`：搜「阿美」→ 1 列；搜「小華版」→ 1 列；清空後 `#refSortX` 選「最舊」→ 第一列是 R1；切模式後搜尋框被清空。
    - `參考模式：卡片`：選 R1 → 卡片含原標、改標、「參考：小明」、區塊「同一篇其他人的改標」內有小華那筆；點該筆 → 卡片換成 R2；R3（同篇只有一人）沒有該區塊；「複製標題」→ 剪貼簿為改標原文，toast「已複製標題」，且沒有送出 `markUsed`。
    - `參考模式：新增按鈕文字與排序選單切換`：進參考模式按鈕為「＋ 新增參考」、`#sortX` 隱藏、`#refSortX` 顯示；回新聞庫還原。
    - `舊後端`（Review Focus 2）：`api.st.noRefs = true` 後切到參考模式 → 顯示「後端還沒更新」；切回新聞庫列表與卡片正常。
    - `記住模式`：勾記住登入、切到參考、`reload` → 直接是參考模式且 4 列；`localStorage` 對 `hottopic.mode` 讀寫丟例外時頁面仍正常（新聞庫模式）。
    - `參考模式：內容以文字輸出`：種一筆改標為 `<img src=x onerror=alert(1)>` 的參考 → 畫面顯示為文字，`#card img` 為 0，`open` helper 的 problems 保持空（沒有原生對話框）。
    - `手機寬度（390px）`：頂欄的模式開關可見且完整落在視窗寬度內（`boundingBox.x + width ≤ 390`），進參考模式點一列 → 看到卡片，返回回列表。
- [ ] **Step 2: 執行確認失敗**：`node --test test/site.test.js` 與 `npm run test:e2e`（可用 `-- --test-name-pattern 參考` 縮小），預期新測試 FAIL。
- [ ] **Step 3: 實作** `index.html`（開關、`#whoChips`、`#refSortX`）、`app.js`（上列狀態、函式與行為；`#refSortX` 以 `makeXsel('refSortX', ...)` 建立，選項 `[['created','最新'],['oldest','最舊']]`）、`app.css`（`.modesw`／`.mode`、人那排與小標、`.item.ref`、`.who`、`.others`、手機版頂欄容納開關；風格沿用既有 `.chip`／`.btn`／`.tag`）。
- [ ] **Step 4: 執行確認通過**：`npm test` 與 `npm run test:e2e` 全綠（含既有 e2e，確認新聞庫無退步）。
- [ ] **Step 5: Commit**：`git add web test && git commit -m "feat: 前端參考模式開關與唯讀列表、兩排篩選、卡片"`

---

### Task 4: 參考的新增、編輯、刪除

**Files:**
- Modify: `web/index.html`、`web/app.js`、`web/app.css`、`test/helpers/fake-api.js`、`test/site.test.js`、`test/e2e/smoke.e2e.js`

**Interfaces:**
- Consumes: Task 3 的 `state.mode`、`state.refs`、`byRef`、`replaceRef`、`reload`、`renderRef`、卡片 `redit`；Task 2 的 `addRef`／`updateRef`／`deleteRef`；Task 1 的 `articleKey`、`LIMITS.who`。
- Produces（供 Task 5 使用）：
  - `index.html`：`#fWho`（`input`，`list="whoList"`，`maxlength="30"`）、`#whoList`（`datalist`）、`#whoHint`（`div.hint`，預設隱藏）、`#whoSet`（`button.btn.small`，預設隱藏）、`#fTitle`（改標 `textarea`，`maxlength` 為 `LIMITS.title`）。欄位順序（參考模式）：分類、參考誰（`#fWho`＋`#whoHint`＋`#whoSet`）、原始標題（＋重新讀取、膠囊）、原文網址、`#idHint`、改標（`#fTitle`）。
  - 新聞庫專用元素加 class `libonly`：`#vars`、`#addVar`、小編文 label、`#usedBox`、到期日那個 `.exprow`、`#expHint`；參考專用元素加 class `refonly`：參考誰那組、改標 label。`#dlg` 在參考模式加 class `ref`；CSS：`#dlg.ref .libonly{display:none}`、`#dlg:not(.ref) .refonly{display:none}`。
  - `app.js`：`state.dlgRef: boolean`、`openRefDialog(ref|null)`、`submitRef()`、`refPeople(): string[]`（目前資料中不重複的人）。`openDialog(item)` 開頭要設 `state.dlgRef = false` 並移除 `#dlg` 的 `ref` class。
  - `fake-api`：`addRef`／`updateRef`／`deleteRef`，行為與 Task 2 後端一致（編號 `R`＋流水號、重複判斷用 `articleKey` 的等價實作、同篇同人回 `duplicate` 並附 `existing`）。

**行為：**
- 頂欄「＋ 新增參考」與空狀態的 `add-first`（參考模式）開 `openRefDialog(null)`；卡片「編輯」開 `openRefDialog(ref)`。標題：「新增參考」／「編輯 #R12」。
- 新增：分類自動依網址猜、原標自動抓、重新讀取、冷卻重試、貼上網址等**沿用既有邏輯**（`checkUrl` 的共用尾段：猜分類與 `autofillTitle`；dup 提示改走參考版）。編輯：網址、原標唯讀、不顯示「重新讀取」、顯示「刪除這則」。
- `#idHint`（新增時，網址或 `#fWho` 變動就更新）：網址空 →「貼上網址後會自動抓出原標。」；同篇有他人 →「這篇已有 N 個人的改標：A、B」；同篇同人 →「這篇已有「小明」的改標。」＋按鈕「改為編輯這則」（`setIdHint` 的按鈕依 `state.dlgRef` 呼叫 `openRefDialog`）。編輯時：「編號 R12（編輯時不可更改）」。
- `#whoList` 的選項為 `refPeople()`。
- `submitRef()`：`normalizeLine` 處理人、原標，`normalizeText` 處理改標；缺網址或原標→「網址和原始標題必填。」；缺人→「請填參考誰。」；缺改標→「請填改標。」；網址不合規沿用既有訊息；驗證失敗不送請求。新增送 `{url, orig, cat, title, who}`，編輯送 `{id, cat, title, who}`。成功：`replaceRef`、`state.sel` 設為該筆、關窗、`render()`、toast「已儲存 #R12」。新增遇 `duplicate` 且有 `existing`：`replaceRef(existing)`、`openRefDialog(existing)`；編輯遇 `duplicate`：保留視窗，`setErr('「' + who + '」對這篇已經有改標了。')`。`unauthorized` 的處理同新聞庫（保留視窗與草稿）。
- 刪除：同既有兩段式；呼叫 `deleteRef`，成功後移出 `state.refs`、關窗、`render()`、toast「已刪除 #R12」。
- 儲存後若 `state.who`（篩選）指向的人已不存在，`render` 內退回「全部」。

- [ ] **Step 1: 寫失敗測試**
  - `site.test.js`：`IDS` 補 `fWho`、`whoList`、`whoHint`、`whoSet`、`fTitle`；確認 FAIL。
  - `smoke.e2e.js`：
    - `參考新增：欄位、自動帶入原標、送出內容`：參考模式按新增 → 標題「新增參考」，`#fNote`、`#usedBox`、`#fExp`、`#addVar` 不可見，`#fWho`、`#fTitle` 可見；`#fWho` 的 `maxlength` 為 `30`；`#whoList option` 為 小明、小華、阿美；貼新網址（`https://news.tvbs.com.tw/health/4040001`）→ `#fOrig` 自動帶入、分類自動選「健康」；人填 `'  阿美\n '`、改標填內容 → 儲存 → `requests` 中 `addRef` 的 args 恰為 `{url, orig, cat:'健康', title, who:'阿美'}`（人已正規化）；列表多一列、toast「已儲存 #R5」、阿美的 chip 變 2。
    - `參考新增：同篇提示與重複`（Review Focus 1）：貼 `4031880` 的網址 → `#idHint` 含「這篇已有 2 個人的改標：小明、小華」；`#fWho` 填 `'小明'` → 出現「改為編輯這則」，點下 → 標題變「編輯 #R1」；另一次：不點提示、直接填滿並按儲存 → 伺服器回 `duplicate` → 開啟 `R1` 的編輯視窗。
    - `參考驗證`（Review Focus 3）：缺人 → 「請填參考誰。」；缺改標 → 「請填改標。」；兩者都沒有送出請求（`requests` 沒有新增 `addRef`）；改標 `'=1+1'` 正常送出並原樣顯示。
    - `參考編輯`：開 R2 → `#fUrl`、`#fOrig` 唯讀、「重新讀取」隱藏、「刪除這則」可見；改標題、人、分類 → 送出的 args 恰為 `{id:'R2', cat, title, who}`；列表與卡片更新；篩選停在「小華」（只有 R2）並把 R2 的人改成「小明」→ 篩選退回「全部」。
    - `參考編輯：改成同篇已有的人`：R2（小華）改成「小明」且 R1 已是小明（同篇）→ 視窗保留並顯示「「小明」對這篇已經有改標了。」。
    - `參考刪除`：兩段式（第一下按鈕變「再按一次刪除（無法復原）」）→ 送出 `deleteRef`、列消失、toast「已刪除 #R1」、人那排數字更新。
    - `切回新聞庫後新增視窗`：`#fNote`、`#usedBox` 可見，`#fWho`、`#fTitle` 不可見；既有新聞庫新增／編輯測試維持通過。
- [ ] **Step 2: 執行確認失敗**：`node --test test/site.test.js` 與 `npm run test:e2e -- --test-name-pattern 參考`，預期 FAIL。
- [ ] **Step 3: 實作** `index.html`、`app.js`（含 `fake-api` 的三個動作）、`app.css`；`checkUrl`、`setIdHint`、表單 `submit`、`del` 點擊處理依 `state.dlgRef` 分流，新聞庫路徑的行為不變。
- [ ] **Step 4: 執行確認通過**：`npm test` 與 `npm run test:e2e` 全綠。
- [ ] **Step 5: Commit**：`git add web test && git commit -m "feat: 參考模式的新增、編輯、刪除與同篇他人提示"`

---

### Task 5: 本班預設人選、文件與整體驗證

**Files:**
- Modify: `web/app.js`、`web/app.css`、`test/e2e/smoke.e2e.js`（`open` helper 新增選項 `now`：有值時在 `page.goto` 前呼叫 `page.clock.setFixedTime(now)`）、`README.md`、`docs/manual-checklist.md`

**Interfaces:**
- Consumes: Task 1 的 `shiftKey`；Task 4 的 `#fWho`、`#whoHint`、`#whoSet`、`openRefDialog`、`submitRef`。
- Produces:
  - `loadShiftWho(): string`：讀 `hottopic.refWho`；`stored.shift === shiftKey(Date.now())` 回 `stored.who`，否則（含壞資料、跨班）移除該鍵並回 `''`；任何例外回 `''`。
  - `saveShiftWho(who: string): void`：存 `{ who, shift: shiftKey(Date.now()) }`；例外忽略。
  - `state.shiftWho: string`：開啟新增視窗當下的預設人選。

**行為（規格「班段記憶」）：**
- `openRefDialog(null)`（新增）：`state.shiftWho = loadShiftWho()`；有值就預填 `#fWho` 並在 `#whoHint` 顯示「本班預設：小明」；沒有就隱藏。編輯不套用。
- `#fWho` 輸入時：若為新增、正規化後的人非空且不等於 `state.shiftWho` → 顯示 `#whoSet`「設為本班預設」；否則隱藏。點擊 → `saveShiftWho(人)`、更新 `state.shiftWho` 與提示、toast「已設為本班預設」、按鈕隱藏。
- **記錄時機**：`addRef` 成功後，若 `loadShiftWho()` 為空，`saveShiftWho(該筆的人)`；`updateRef` 成功不記錄；逐篇改人不改變預設。

- [ ] **Step 1: 寫失敗測試**（`smoke.e2e.js`；以 `now` 選項固定時間，`timezoneId` 維持 `Asia/Taipei`，另一個案例用 `America/New_York`）
  - `班段預設：第一次成功儲存後預填`：`now = 2026-11-13T07:50+08:00`；新增視窗一開始 `#fWho` 為空、`#whoHint` 隱藏；新增一筆（人「小明」）→ 再開新增視窗 → `#fWho` 為「小明」、`#whoHint` 含「本班預設：小明」；`localStorage['hottopic.refWho']` 解析後 `who === '小明'`、`shift === '2026-11-13#0'`。
  - `班段預設：打到一半不記錄`：只填人但取消 → 再開仍為空。
  - `班段預設：逐篇改人不影響預設，可用按鈕改預設`：預設為「小明」；本篇人改填「小華」→ 出現「設為本班預設」；儲存後再開仍預填「小明」；再開、改填「小華」、點「設為本班預設」→ toast「已設為本班預設」，再開預填「小華」；人等於預設時按鈕隱藏。
  - `班段預設：編輯不預填`：編輯 R2 時 `#fWho` 為 R2 的人。
  - `班段交界`（Review Focus 5）：`07:59:59+08:00` 存下預設 → `page.clock.setFixedTime('2026-11-13T08:00:00+08:00')` → 再開新增視窗 → `#fWho` 為空，`hottopic.refWho` 已被移除；同樣驗證 `23:59:59` → 隔天 `00:00:00` 失效；同一班內（08:00–15:59）不失效。
  - `班段：瀏覽器時區非台北`：`timezoneId: 'America/New_York'`、`now = 2026-11-13T07:59:59+08:00` 存下預設，`2026-11-13T08:00:00+08:00` 起失效（仍照台北時間）。
  - `班段：localStorage 壞掉不當機`：`hottopic.refWho` 預先放入非 JSON 字串、或 `getItem`／`setItem` 丟例外 → 新增視窗正常開啟且 `#fWho` 為空、儲存照常成功。
- [ ] **Step 2: 執行確認失敗**：`npm run test:e2e -- --test-name-pattern 班段`，預期 FAIL。
- [ ] **Step 3: 實作** `loadShiftWho`／`saveShiftWho`／`state.shiftWho`、`#whoHint`／`#whoSet` 的顯示邏輯與 `app.css` 樣式。
- [ ] **Step 4: 文件**
  - `README.md`：功能簡介加一句參考模式；新增一節「**參考模式升級注意**」：試算表自動出現「參考」分頁；後端要「管理部署作業 → 編輯 → 新版本」才有 `listRefs` 等動作，沒更新時參考模式顯示「後端還沒更新」；說明班段預設（00:00／08:00／16:00 台北時間交班、存在這台瀏覽器）。「日常使用」補一段參考模式用法。
  - `docs/manual-checklist.md`：補參考模式手動檢查項目（切換、兩排篩選、同篇多人、班段預設、舊後端提示）。
- [ ] **Step 5: 整體驗證**：`npm test`、`npm run test:e2e`、`npm run build` 全部通過（`build` 輸出仍為十個檔）；`git status` 確認沒有多餘檔案。
- [ ] **Step 6: Commit**：`git add web test README.md docs && git commit -m "feat: 參考模式本班預設人選、README 與手動檢查項目"`

---

## Self-Review 紀錄

- **規格涵蓋**：目的／目標（開關、列表、新增流程、單一改標、同篇多人、兩排篩選）→ Task 3、4；班段記憶 → Task 1、5；資料與後端（分頁、編號、共用分類、動作、驗證、重複、舊後端提示）→ Task 2、3；非目標與反目標（新聞庫無退步、不污染正式資料）→ Global Constraints、Task 2「沒用參考動作就不建分頁」、每個 task 全綠要求。
- **型別一致**：`Ref` 欄位 `id/cat/orig/url/title/who/created`、`shiftKey`/`articleKey`/`nextRefId`、`state.dlgRef`、`state.shiftWho` 在各 task 名稱一致。
- **比例**：計畫以介面、行為與測試斷言為主，沒有貼函式本體。
