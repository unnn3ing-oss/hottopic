# 卡片「送到套版」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 熱門新聞庫的卡片按「送到套版」，把網址與目前改標送進 Chrome 擴充功能「圖片套版產生器」側邊欄並自動快速產圖。

**Architecture:** 卡片以 `window.postMessage` 送訊息 → 擴充功能新增的內容腳本 `bridge.js`（只注入熱門新聞庫頁面）驗證後轉給 `background.js` → 暫存 `chrome.storage.session` 並嘗試打開側邊欄 → 側邊欄讀到暫存後呼叫 `QuickFill.run({titleOverride})`。驗證邏輯寫成純函式，可用 Node 單元測試。

**Tech Stack:** 熱門新聞庫：原生 JS（ES2019 以內）、`node:test`、Playwright。QuickPatterntool：Chrome MV3 擴充功能、原生 JS、`node --test`（該 repo 沒有 package.json，不新增相依套件）。

**Spec:** `docs/superpowers/specs/2026-10-14-send-to-quickpattern-design.md`

**Repos 與路徑：** 熱門新聞庫 = `/home/user/hottopic`（簡稱 HT）；QuickPatterntool = `/home/user/quickpatterntool`（簡稱 QPT）。兩個 repo 都在分支 `claude/funny-cori-751vpr` 上開發，**Task 1–3 在 QPT，Task 4–5 在 HT**。

## Global Constraints

- 網址驗證：長度 ≤ 2000；`new URL()` 可解析；`https:`；主機名等於 `tvbs.com.tw` 或以 `.tvbs.com.tw` 結尾；不含帳號密碼。
- `title`（可省略）：字串，長度 ≤ 200，去掉控制字元後非空。
- 暫存有效期 2 分鐘（`PENDING_TTL_MS = 120000`）；卡片等 ack 最多 800 毫秒。
- 訊息：頁面→bridge `{source:'hottopic', type:'send-to-quickpattern', v:1, nonce, url, title?}`；bridge→頁面 `{source:'quickpattern', type:'ack', nonce, ok, opened, error?}`；bridge→background `{type:'hottopic:send', url, title}`，回覆 `{ok, opened, error?}`。
- 只信任 `https://unnn3ing-oss.github.io` 且路徑以 `/hottopic/` 開頭的頁面。
- QPT 版本 `4.40 → 4.50`，`changelog.json` 補 `"4.50"`；圖示提示 badge 文字 `'1'`、顏色 `#1a73e8`（不與更新提示的紅色「新」混用）。
- toast 文字（完全照抄）：「已送到套版」、「已傳給套版，請點一下工具列圖示打開側邊欄」、「沒偵測到套版擴充功能（需 v4.50 以上，並重新整理本頁），已複製網址」。
- 「送到套版」不呼叫 `markUsed`、不改任何資料；不自動下載圖片。
- HT 不改 CSP、Worker、Apps Script；不新增網路請求。
- 驗證指令：HT `npm test`、`npm run test:e2e`；QPT `node --test test/`。

## Review Focus

1. **網域偽裝**：`https://news.tvbs.com.tw.evil.com/`、`https://eviltvbs.com.tw/`、`https://news.tvbs.com.tw@evil.com/` 必須被拒（Task 1）。
2. **過期暫存**：超過 2 分鐘的 `pending` 不得被執行；剛好 2 分鐘整視為過期（Task 1、Task 3）。
3. **改標原樣傳遞**：標題含全形空格、「！」「？」「：」時，不在途中被改動，換行交給 `breakTitle`（Task 3）。
4. **連按兩次**：兩次送出各自以 nonce 配對 ack，互不干擾（Task 4）。
5. **沒有網址或沒有改標的新聞**：沒有網址時按鈕停用；沒有改標時只送網址、不送 `title`（Task 4、Task 5）。

---

### Task 1 [QPT]: `bridge.js` 的驗證純函式

**Files:**
- Create: `/home/user/quickpatterntool/bridge.js`
- Test: `/home/user/quickpatterntool/test/bridge.test.js`

**Interfaces:**
- Produces（UMD：`module.exports` 與 `self.QptBridge` 都要有，風格同 `quickfill.js` 的 `root.QuickFill`）：
  - `validateSend(msg: unknown): { ok: true, url: string, title: string | null } | { ok: false, error: string }` — `msg` 是 `{url, title?}` 形狀；`url` 回傳 `new URL(...).href`。
  - `senderAllowed(sender: { id?: string, url?: string } | null, selfId: string): boolean`
  - `isFresh(pending: { at: number } | null, now: number): boolean`
  - 常數 `PENDING_TTL_MS = 120000`、`PAGE_ORIGIN = 'https://unnn3ing-oss.github.io'`、`PAGE_PATH_PREFIX = '/hottopic/'`。

- [ ] **Step 1: 寫失敗測試** `test/bridge.test.js`（`node:test` + `require('../bridge.js')`），測試名稱與斷言：
  - `validateSend 接受 TVBS 網址`：`https://news.tvbs.com.tw/cars/4032757` 與 `https://tvbs.com.tw/x` → `ok:true`；`title` 省略時回傳 `title:null`。
  - `validateSend 拒絕偽裝網域`：Review Focus 1 的三個網址 ＋ `http://news.tvbs.com.tw/x`、`javascript:alert(1)`、`'not a url'`、長度 2001 的網址 → 全部 `ok:false`。
  - `validateSend 檢查 title`：數字、陣列 → 拒絕；201 字 → 拒絕；只有控制字元（`'\u0000\u0007'`）→ 拒絕；`'平均爽領315萬！勞退 結清潮'` 原樣回傳（含全形空格與「！」）。
  - `validateSend 拒絕非物件`：`null`、`undefined`、字串、陣列 → `ok:false`。
  - `senderAllowed`：`{id:'me', url:'https://unnn3ing-oss.github.io/hottopic/'}` 且 `selfId:'me'` → true；`id` 不同 → false；`https://unnn3ing-oss.github.io/QuickPatterntool/` → false；`https://unnn3ing-oss.github.io.evil.com/hottopic/` → false；`null` → false。
  - `isFresh`：`at = now - 119999` → true；`at = now - 120000` → false；`null`、缺 `at` → false。
- [ ] **Step 2: 執行確認失敗**：`cd /home/user/quickpatterntool && node --test test/`；預期因找不到 `bridge.js` 而失敗。
- [ ] **Step 3: 實作** `bridge.js`：只放上述純函式與常數（本 Task 不寫 `chrome.*` 相關程式）。網域比對用 `host === 'tvbs.com.tw' || host.endsWith('.tvbs.com.tw')`；帳密以 `u.username || u.password` 判斷；控制字元以 `/[\u0000-\u001f\u007f]/g` 去除後再判斷非空，**回傳的 `title` 是去除控制字元後的字串**。
- [ ] **Step 4: 執行確認通過**：同 Step 2 指令；預期全部 pass。
- [ ] **Step 5: Commit**：`git add bridge.js test/bridge.test.js && git commit -m "feat: bridge.js 的驗證純函式（網址、標題、sender、暫存時效）"`

---

### Task 2 [QPT]: bridge 接線、background、manifest 4.50

**Files:**
- Modify: `bridge.js`（加接線）、`background.js`、`manifest.json`、`changelog.json`、`updater.js:13`（`SKIP` 清單）
- Test: `test/manifest.test.js`（新）

**Interfaces:**
- Consumes: Task 1 的 `QptBridge.validateSend`、`senderAllowed`。
- Produces：頁面→bridge→background 的訊息鏈（協定見 Global Constraints）；`chrome.storage.session` 的 key `pending` = `{url: string, title: string | null, at: number}`；成功暫存後若 `sidePanel.open` 失敗，badge 顯示 `'1'`。

- [ ] **Step 1: 寫失敗測試** `test/manifest.test.js`：
  - `manifest 版本是 4.50`。
  - `content_scripts 只注入熱門新聞庫`：恰好一筆，`matches` 為 `['https://unnn3ing-oss.github.io/hottopic/*']`，`js` 為 `['bridge.js']`，`run_at` 為 `'document_idle'`。
  - `permissions 仍含 storage 與 sidePanel`，且 `host_permissions` 沒有變動（仍為 `['<all_urls>']`）。
  - `changelog 有 4.50 且有 summary 與 items`。
  - `updater SKIP 會略過 test/ 但不略過 bridge.js`：讀 `updater.js` 原始碼，用正規表示式取出 `SKIP` 陣列後逐一比對路徑 `test/bridge.test.js`（略過）與 `bridge.js`（不略過）。
- [ ] **Step 2: 執行確認失敗**：`node --test test/`；預期 manifest 相關測試失敗。
- [ ] **Step 3: `manifest.json`**：`version` 改 `"4.50"`，新增 `content_scripts`；`changelog.json` 最上方新增 `"4.50"`（summary：「新增從熱門新聞庫一鍵送進側邊欄快速產圖」；items 說明：新增橋接腳本、暫存與圖示提示、更新後需重新整理熱門新聞庫分頁、第一次更新會多一個權限確認）；`updater.js` 的 `SKIP` 陣列加入 `/^test\//`。
- [ ] **Step 4: 實作 `bridge.js` 接線**：僅在 `typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id` 時註冊 `window.addEventListener('message', ...)`。只處理 `event.source === window`、`event.origin === location.origin`、`data.source === 'hottopic'`、`data.type === 'send-to-quickpattern'`、`data.v === 1`、`typeof data.nonce === 'string'`（長度 ≤ 64）的訊息；驗證不過 → 直接回 `ack{ok:false, opened:false, error}`；通過 → `chrome.runtime.sendMessage({type:'hottopic:send', url, title})`，把回覆包成 ack 以 `window.postMessage(ack, location.origin)` 送回；`sendMessage` 失敗（例如擴充功能剛重新載入）→ `ack{ok:false, opened:false, error:'extension_unavailable'}`。
- [ ] **Step 5: 實作 `background.js`**：頂端 `importScripts('updater.js', 'bridge.js')`；`chrome.runtime.onMessage` 收到 `type === 'hottopic:send'` 時：`QptBridge.senderAllowed(sender, chrome.runtime.id)` 不過 → `sendResponse({ok:false, opened:false, error:'sender_not_allowed'})`；`validateSend` 不過 → 同樣回 `ok:false`；通過 → `await chrome.storage.session.set({pending:{url, title, at: Date.now()}})`，再 `try { await chrome.sidePanel.open({windowId: sender.tab.windowId}); opened = true } catch { opened = false }`；`opened` 為 false 時 `chrome.action.setBadgeText({text:'1'})` 與 `setBadgeBackgroundColor({color:'#1a73e8'})`；回 `{ok:true, opened}`。listener 要回傳 `true` 以保持非同步回覆通道。
- [ ] **Step 6: 執行確認通過**：`node --test test/`；預期全部 pass（含 Task 1）。
- [ ] **Step 7: Commit**：`git add -A && git commit -m "feat: 橋接內容腳本、background 暫存與開啟側邊欄、版本 4.50"`

---

### Task 3 [QPT]: 側邊欄自動快速產圖（改標覆蓋）

**Files:**
- Modify: `quickfill.js`（`run` 約在 507 行、匯出在 359 行）、`sidepanel.js`、`sidepanel.html`（`<script>` 區，約 200–204 行）、`README.md`
- Test: `test/quickfill.test.js`（新）

**Interfaces:**
- Consumes: Task 1 的 `QptBridge.isFresh`、`PENDING_TTL_MS`；Task 2 寫入的 `chrome.storage.session.pending`。
- Produces:
  - `QuickFill.resolveTitle(override: string | null | undefined, articleTitle: string | null | undefined): string` — `override` 去頭尾空白後非空就用它，否則用 `articleTitle`，兩者都沒有回 `''`。純函式，加進 359 行的匯出。
  - `run(opts?: { titleOverride?: string })`（`quickfill.js` 內部）。
  - `QuickFill.applyPending(p: { url: string, title: string | null }): void`（互動區段內定義後掛到 `root.QuickFill`；`qfUrl` 不存在的頁面不需存在）。

- [ ] **Step 1: 寫失敗測試** `test/quickfill.test.js`（在 Node 以 `global.window = global` 之類方式載入 `quickfill.js`；`quickfill.js` 的互動區段有 `if (!urlInput) return` 保護，需確認 `document` 不存在時不會丟例外，必要時在測試中提供最小的 `document.getElementById = () => null`）：
  - `resolveTitle：override 優先`：`('卡片改標', '文章標題')` → `'卡片改標'`。
  - `resolveTitle：override 空白退回文章標題`：`('  ', '文章標題')`、`(null, '文章標題')`、`(undefined, '文章標題')` → `'文章標題'`。
  - `resolveTitle：都沒有回空字串`：`(null, null)` → `''`。
  - `resolveTitle：不改動內容`：`'平均爽領315萬！勞退　結清潮湧現：6百名勞工'` 原樣回傳（Review Focus 3）。
  - `override 經 breakTitle 後與原本行為一致`：`QuickFill.breakTitle('蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始')` 仍是 3 行（防止回歸）。
- [ ] **Step 2: 執行確認失敗**：`node --test test/`；預期 `resolveTitle` 未定義。
- [ ] **Step 3: 實作 `resolveTitle` 並加進 `root.QuickFill` 匯出**。
- [ ] **Step 4: 修改 `run(opts)`**（依 spec §5）：
  ① 有 `opts.titleOverride` 時，在讀文章**之前**就用 `breakTitle(override)` 填進 `titleEl` 並 `dispatchEvent(new Event('input'))`、`learnSeps(override, broken)`；
  ② 文章抓到後，標題一律用 `resolveTitle(opts.titleOverride, article.title)`；有 override 時**不再**覆寫 `titleEl`，`formatCopy` 的 `title` 用同一個值；
  ③ 有 override 時，`!article.title` 不再丟「這個網頁抓不到標題」；沒有 override 時行為不變。
- [ ] **Step 5: 實作 `applyPending(p)`**：`urlInput.value = p.url; hideTip(); disarm(); return run({ titleOverride: p.title || undefined })`，並掛到 `root.QuickFill.applyPending`。
- [ ] **Step 6: `sidepanel.html` 在 `sidepanel.js` 之前加 `<script src="bridge.js"></script>`；`sidepanel.js` 新增 `consumePending()`**：讀 `chrome.storage.session.get('pending')`；`QptBridge.isFresh(pending, Date.now())` 為 false → 刪除並結束；為 true → 先 `chrome.storage.session.remove('pending')`，若目前 badge 文字是 `'1'` 就清成空字串，再 `QuickFill.applyPending(pending)`。載入時呼叫一次，並註冊 `chrome.storage.onChanged`（`area === 'session'` 且 `changes.pending` 有新值）時再呼叫。
- [ ] **Step 7: README**：功能特色加一小段「從熱門新聞庫送到套版」（需 4.50 以上、更新後重新整理熱門新聞庫分頁、備案行為、圖上標題用卡片改標）；檔案結構表加 `bridge.js` 與 `test/`。
- [ ] **Step 8: 執行確認通過**：`node --test test/`；預期全部 pass。
- [ ] **Step 9: Commit 並推送**：`git add -A && git commit -m "feat: 側邊欄收到暫存後自動快速產圖，標題用卡片改標" && git push -u origin claude/funny-cori-751vpr`（**不開 PR**，等使用者說「發布」）。

---

### Task 4 [HT]: `web/qpt.js` 傳送器

**Files:**
- Create: `/home/user/hottopic/web/qpt.js`
- Modify: `scripts/build-site.js`（`FILES` 與 `src` 正規表示式）、`web/index.html`（`<script>` 區，約 12–14 行，順序 `lib.js`、`api.js`、`qpt.js`、`app.js`）、`test/site.test.js`（約 20、21、46 行的檔案清單與順序）
- Test: `test/qpt.test.js`（新）

**Interfaces:**
- Produces（UMD：全域 `HotNewsQpt`，並 `module.exports`，風格同 `web/api.js`）：
  - `buildMessage(item: { url: string, titles: { t: string }[] }, pos: number, nonce: string): { source: 'hottopic', type: 'send-to-quickpattern', v: 1, nonce: string, url: string, title?: string }` — `title` 取 `item.titles[pos].t`；`titles` 為空或該位置沒有字串時省略 `title`。
  - `send(opts: { win: Window, item, pos: number, nonce: string, timeoutMs?: number /* 預設 800 */, setTimeout?, clearTimeout? }): Promise<{ status: 'opened' | 'not_opened' | 'no_extension' | 'rejected', error?: string }>` — 先註冊 `message` 監聽再 `win.postMessage(msg, win.location.origin)`；只接受 `event.source === win`、`event.origin === win.location.origin`、`data.source === 'quickpattern'`、`data.type === 'ack'`、`data.nonce === nonce` 的訊息；ack `ok && opened` → `opened`；`ok && !opened` → `not_opened`；`!ok` → `rejected`（帶 `error`）；逾時 → `no_extension`；結束時一定移除監聽。

- [ ] **Step 1: 寫失敗測試** `test/qpt.test.js`，以假 `win`（有 `addEventListener`、`removeEventListener`、`postMessage`、`location.origin`，並能手動 `emit(event)`）與可控的假計時器：
  - `buildMessage 取目前輪播的那版`：`titles=[{t:'A'},{t:'B'}]`、`pos=1` → `title:'B'`。
  - `buildMessage 沒有改標時省略 title`：`titles=[]` → 結果沒有 `title` 屬性。
  - `send：ack ok+opened → opened`；`ack ok 但 opened:false → not_opened`；`ack ok:false → rejected 且帶 error`。
  - `send：沒有 ack，逾時 → no_extension`。
  - `send 忽略別人的 ack`：nonce 不符、`event.source` 不是 `win`、`event.origin` 不同、`data.source` 不是 `'quickpattern'` 各一例，均不得結案（最後仍逾時）。
  - `send 結束後移除監聽`：成功與逾時兩條路徑，`removeEventListener` 都被呼叫且對象是同一個函式。
  - `連按兩次互不干擾`：兩次 `send`（nonce `n1`、`n2`），先送 `n2` 的 ack 再送 `n1` 的 → 各自拿到自己的結果（Review Focus 4）。
  - `postMessage 的目標 origin 是 win.location.origin`，不是 `'*'`。
- [ ] **Step 2: 執行確認失敗**：`cd /home/user/hottopic && node --test test/qpt.test.js`；預期找不到 `web/qpt.js`。
- [ ] **Step 3: 實作 `web/qpt.js`**（ES2019 以內，不用可選串接與 `??`）。
- [ ] **Step 4: 更新站台清單**：`build-site.js` 的 `FILES` 加 `['web/qpt.js', 'qpt.js']`，`src` 正規表示式加入 `qpt\.js`；`index.html` 加 `<script src="qpt.js" defer></script>`（在 `api.js` 與 `app.js` 之間）；`test/site.test.js` 的輸出檔案清單加 `qpt.js`，順序斷言改為 `['lib.js', 'api.js', 'qpt.js', 'app.js']`。
- [ ] **Step 5: 執行確認通過**：`npm test`；預期全部 pass（含 `site.test.js`）。
- [ ] **Step 6: Commit**：`git add -A && git commit -m "feat(web): 送到套版的傳送器 qpt.js 與站台清單"`

---

### Task 5 [HT]: 卡片按鈕、提示、e2e、文件

**Files:**
- Modify: `web/app.js`（卡片動作列約 212–216 行；點擊處理約 397 行；`copyText` 在約 70–80 行）、`docs/manual-checklist.md`、`README.md`
- Test: `test/e2e/smoke.e2e.js`（新增測試）

**Interfaces:**
- Consumes: Task 4 的 `HotNewsQpt.send`；既有 `posOf(it)`、`copyText(text, okMsg, cb)`、`toast(msg)`、`byId`。
- Produces: 卡片動作列的 `<button class="btn" data-act="qpt">送到套版</button>`，位在「複製留言」之後；`it.url` 為空時 `disabled`。

- [ ] **Step 1: 寫失敗的 e2e 測試**（`test/e2e/smoke.e2e.js`，沿用該檔既有的登入與假 API 輔助函式；以 `page.addInitScript` 注入一個模擬 bridge：監聽 `window` 的 `message`，依 `window.__bridgeMode` 回覆 ack 或不回覆，並把收到的訊息記在 `window.__sent`）：
  - `送到套版：ack opened → 顯示「已送到套版」`，且 `window.__sent` 恰好一筆、`url` 與該則相同、`title` 等於卡片目前顯示的改標。
  - `送到套版：ack 未打開側邊欄 → 顯示「已傳給套版，請點一下工具列圖示打開側邊欄」`。
  - `送到套版：沒有 ack → 800 毫秒後顯示「沒偵測到套版擴充功能（需 v4.50 以上，並重新整理本頁），已複製網址」，且剪貼簿內容是該則網址`（沿用既有 e2e 讀剪貼簿的輔助函式）。
  - `送到套版：輪播到第 2 版後送出的是第 2 版標題`。
  - `送到套版：不會把新聞標記為已使用`：送出前後 `markCalls(api)` 都是空。
  - `送到套版：沒有網址的新聞，按鈕是停用的`（以假 API 種一則沒有網址的資料；若既有資料結構不允許無網址，改為直接檢查 `it.url` 為空字串的渲染路徑）。
- [ ] **Step 2: 執行確認失敗**：`npm run test:e2e`；預期新測試失敗（找不到按鈕）。
- [ ] **Step 3: 實作按鈕與處理器**：動作列新增按鈕；`act === 'qpt'` 時呼叫 `HotNewsQpt.send({win: window, item: it, pos: p, nonce: <隨機字串>})`，依結果：`opened` → `toast('已送到套版')`；`not_opened` → `toast('已傳給套版，請點一下工具列圖示打開側邊欄')`；`no_extension` 與 `rejected` → `copyText(it.url, '沒偵測到套版擴充功能（需 v4.50 以上，並重新整理本頁），已複製網址')`。nonce 用 `crypto.getRandomValues` 產生十六進位字串。處理期間不修改 `state.copied`（避免影響「複製標題→複製留言自動標記」）。
- [ ] **Step 4: 文件**：`docs/manual-checklist.md` 新增「送到套版（需 Chrome 實機）」一節，逐項列出：① 擴充功能更新到 4.50（會跳權限確認）並重新整理熱門新聞庫；② 側邊欄開著時按鈕 → 自動帶入並產圖，圖上標題是卡片當前改標，停在「直接下載」；③ 側邊欄關著時 → 觀察是自動打開，還是圖示出現藍色 `1` 並在點圖示後自動產圖（**這是 spec §11 的未驗證項，結果請回報**）；④ 沒裝擴充功能的瀏覽器按按鈕 → 出現提示並複製網址；⑤ 非 TVBS 網址的新聞按鈕 → 提示並複製網址。`README.md` 加一小段使用說明與需求（擴充功能 4.50 以上）。
- [ ] **Step 5: 執行確認通過**：`npm test && npm run test:e2e`；預期全部 pass。
- [ ] **Step 6: Commit 並推送**：`git add -A && git commit -m "feat(web): 卡片「送到套版」按鈕與提示" && git push -u origin claude/funny-cori-751vpr`（**不開 PR**，等使用者說「發布」）。

---

## Self-Review 結果

- **Spec 覆蓋**：§4 協定與驗證 → Task 1、2、4；§5 擴充功能 → Task 1–3；§6 卡片端 → Task 4、5；§7 邊界情況 → Task 1（過期、偽裝網域）、Task 3（抓取失敗仍有標題）、Task 4（連按）、Task 5（無網址）；§8 測試 → 各 Task 的測試步驟，實機項目 → Task 5 Step 4；§9 部署順序 → 本計畫 Task 順序與「不開 PR」的規定；§10 不做 → Global Constraints。
- **型別一致**：`validateSend`、`senderAllowed`、`isFresh`、`PENDING_TTL_MS`、`resolveTitle`、`applyPending`、`buildMessage`、`send` 在各 Task 的 Interfaces 與步驟中名稱一致；訊息欄位名稱與 Global Constraints 一致。
- **已知取捨**：QPT 的 DOM 互動（`run` 與 `applyPending` 的實際運作）沒有自動化測試，因為該 repo 沒有瀏覽器測試環境；以純函式 `resolveTitle` 與 `breakTitle` 回歸測試涵蓋可測的部分，其餘列入 Task 5 的實機清單。
