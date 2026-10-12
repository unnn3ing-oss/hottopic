# 熱門新聞庫 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做出「熱門新聞庫」：GitHub Pages 靜態網頁當介面、Google Apps Script Web App 當 JSON API、私人 Google 試算表存資料，可新增／編輯／刪除新聞、多版改標輪播、複製標題與留言、標記已使用、自動帶入原始標題。

**Architecture:** `apps-script/lib.js`（純函式，Apps Script、瀏覽器、node 三處共用）＋ `apps-script/Code.gs`（`doGet`/`doPost`，先驗密碼再分派動作）＋ `web/`（`index.html`、`app.css`、`api.js`、`app.js`，無框架、無打包）。測試分三層：`lib.js` 單元測試（在沒有 `URL`／DOM 的 `vm` 沙箱內執行，模擬 Apps Script 環境）、`Code.gs` 後端測試（假的 Google 物件，一律經由 `doPost`）、Playwright e2e（載入建置後的 `_site/`，攔截 Apps Script 網址並轉給同一份後端測試用假物件）。

**Tech Stack:** Node 22（`node:test`）、Playwright 1.56.1（釘死，與環境預裝的 Chromium 相符）、原生 JS/CSS、Google Apps Script（V8）、GitHub Actions + Pages。

**Spec:** `docs/superpowers/specs/2026-10-11-hot-news-library-design.md`（使用者已於 2026-10-12 確認；以下簡稱「規格」，以 §N 引用章節）。互動預覽原始檔：`docs/superpowers/previews/hot-news-preview.html`（版面與輪播互動的視覺與行為依據）、`docs/superpowers/previews/swipe-test.js`（23 項輪播測試）。冒煙測試紀錄：`docs/apps-script-smoke-test.md`。

## Global Constraints

每個任務的要求都隱含本節。數值皆抄自規格。

- **分支與發布**：只在 `claude/funny-cori-751vpr` 開發與推送；**不開 PR**（使用者說「發布」才開，併入 `main` 才是正式發布）；Pages 只從 `main` 部署。commit 結尾附上本 session 提供的 Co-Authored-By／Claude-Session 行。
- **repo 為公開**：不得出現真實 `/macros/s/<部署ID>/exec` 網址、密碼、試算表 ID。測試用假值：網址 `https://script.google.com/macros/s/TEST_DEPLOYMENT/exec`、密碼 `'t'.repeat(48)`、試算表 ID `TEST_SHEET`。
- **`lib.js` 執行環境**：必須能在 Apps Script V8、瀏覽器、node 執行 → 不得使用 `URL`、`URLSearchParams`、`DOMParser`、`window`、`document`、`TextEncoder`；頂層只用 `var` 與 `function` 宣告（Apps Script 檔案載入順序不保證，`Code.gs` 不得在載入時讀 `lib.js` 的全域值，只能在函式內讀）；檔尾以 `if (typeof module !== 'undefined' && module.exports) { module.exports = {...}; }` 匯出。`lib.js`、`Code.gs`、`api.js` 語法限 ES2019 以內。
- **試算表**：分頁 `新聞`（A–H：`id`、`分類`、`原始標題`、`原文連結`、`小編文`、`上次使用時間`、`使用次數`、`建立時間`）、`改標`（A–F：`新聞id`、`版本號`、`標題`、`上次使用時間`、`使用次數`、`建立時間`）、`分類`（單欄；預設 社會、生活、健康、政治、國際、娛樂）。第 1 列為標題列。文字欄位（`新聞` A–E、`改標` A、C）**每次寫入前對實際寫入的範圍 `setNumberFormat('@')`**；時間欄格式 `yyyy/MM/dd HH:mm`；時區 `Asia/Taipei`。回給網頁的時間一律是 epoch 毫秒數字或 `null`，不得出現 `Date`。
- **API 協定（規格 §7）**：`POST`，`Content-Type: text/plain;charset=utf-8`，內文 `{token, action, args}`；`fetch` 參數 `credentials:'omit'`、`referrerPolicy:'no-referrer'`、`redirect:'follow'`；不加任何自訂標頭。回應 HTTP 永遠 200：`{ok:true,data}` 或 `{ok:false,code,error?,existing?}`；`code` 只能是 `unauthorized|bad_request|duplicate|not_found|stale|busy|server_error`；`error` 只放固定繁體中文訊息，不放例外內容。伺服器順序：解析 JSON（失敗→`bad_request`）→ 驗密碼 → 動作白名單 → 寫入類動作取 `LockService.getScriptLock()`（`waitLock(10000)`，逾時→`busy`）→ 執行。驗密碼**失敗關閉**：`API_TOKEN` 未設定、長度 < 32、未帶、不相等，一律同一個 `unauthorized`，且驗證前不碰試算表與外部網址。逾時：一般動作 30 秒，`fetchTitle` 8 秒。**新增、編輯、刪除、標記已使用不自動重試。**
- **資訊清單**：`timeZone` `Asia/Taipei`、`runtimeVersion` `V8`、`exceptionLogging` `STACKDRIVER`、`oauthScopes` 只有 `https://www.googleapis.com/auth/spreadsheets` 與 `https://www.googleapis.com/auth/script.external_request`、`webapp` `executeAs: USER_DEPLOYING`／`access: ANYONE_ANONYMOUS`。指令碼屬性：`API_TOKEN`、`SHEET_ID`。
- **網頁安全（規格 §8）**：`<head>` 第一個元素是 CSP meta，內容完全等於 `default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://script.google.com https://script.googleusercontent.com; img-src 'self' data:; base-uri 'none'; form-action 'none'`；另有 `<meta name="referrer" content="no-referrer">`、`<meta name="robots" content="noindex">`。沒有行內 script／style／事件屬性／`style=`、沒有第三方資源與字型；所有來自伺服器或使用者的文字只用 `textContent` 輸出（不用 `innerHTML`）；連結只允許 http／https，`rel="noopener noreferrer"`；不使用 `alert`／`confirm`／`prompt`。localStorage 鍵名前綴 `hotnews.v1.`（`url`、`token`、`remember`），密碼預設只在記憶體，勾「在這台裝置記住」才寫入；所有 localStorage 存取包 try/catch。
- **發布**：`scripts/build-site.js` 只輸出 `index.html`、`app.css`、`app.js`、`api.js`、`lib.js` 五個檔，資源網址加 `?v=<sha 前 12 碼>`；`pages.yml`：PR 只跑測試，`main` 的 push 才部署，權限最小（`contents: read`、`pages: write`、`id-token: write`）。
- **規格值（原樣）**：留言 = `小編文 + "\n" + "https://news.tvbs.com.tw/news/" + id`（小編文為空只輸出網址；`id` 以 `N` 開頭改用原文連結；不空行）；編號 = 網址路徑中最長的一串數字（忽略主機、埠、query、hash；無數字則 `N` + 流水號）；標記已使用確認 3 秒、刪除確認 4 秒、標題抓取 8 秒；拖曳換版門檻 `min(60px, 版寬 15%)`；排序預設「最久未用優先」（從未使用者最前）。
- **語言**：UI 文字一律繁體中文（台灣用語）。

## Review Focus

規格沒寫、但使用者最可能碰到的情境（每條的測試放在括號內的任務）：

1. **從 LINE／Word 貼上的標題與小編文**：含 `\r\n`、結尾多餘空行、整段只有空白；預期存入後換行統一為 `\n`、頭尾空白行被去掉、只有空白的改標版本被略過（Task 2、6、16）。
2. **使用者直接在試算表手動改資料**（規格明講可在試算表增刪分類）：空白列、改標指向不存在的新聞、版本號或次數被改成文字、分類分頁有空白或重複、整個分頁被刪掉；預期列表照常載入，壞資料被略過而不是整個 500（Task 5）。
3. **貼上網址或密碼時帶前後空白／換行**（從 Apps Script 畫面複製很常見）；預期自動去掉空白後連線（Task 10、12）。
4. **連點**：「標記已使用」第二下之後再連按、儲存連按；預期只送出一次，次數不會多算（Task 15、16）。
5. **emoji 與超長無空白字串**（`👇` 在規格範例就有；網址式長標題）；預期試算表往返不變、複製出來原樣、手機寬度無橫向溢出（Task 6、13、15）。

## 本計畫補上的決定（規格沒寫，覆核時可否決）

| 項目 | 決定 |
|---|---|
| 欄位長度上限 | `url` 2000、`原始標題` 500、單一改標 500、`小編文` 5000、單則最多 20 個改標；超過 → `bad_request`（試算表單格上限 5 萬字，避免被塞爆） |
| `ping` | 驗證密碼後會開啟試算表並補建缺少的分頁，所以「連線測試」同時驗證 `SHEET_ID` 設對了 |
| 初始化 | 另有編輯器內執行的 `setup()`：授權、補建分頁與預設分類、設定試算表時區 `Asia/Taipei`、在執行記錄顯示 `API_TOKEN`／`SHEET_ID` 是否已設定（**不印值**）。動作執行時也會自動補建分頁，所以漏跑 `setup()` 不會壞 |
| 文字正規化 | `normalizeText`：換行統一 `\n`、去控制字元（保留 `\n`、`\t`）、去頭部空白行與尾部空白；`normalizeLine`（原始標題用）再把換行壓成單一空格 |
| 版本號 | 新增改標的 `版本號` = 該則現有最大版本號（含同一請求中被移除的）+ 1，不重用 |
| `markUsed` | 該則有改標卻沒帶 `ver` → `bad_request`；沒有改標則只更新整則 |
| `updateItem` 協定 | `{id, cat, note, edit:[{ver,t}], add:[t], remove:[ver]}`；`edit` 的 `t` 空白 → `bad_request`（網頁把清空的既有版本改放進 `remove`）；任何指到不存在版本 → `stale`，整筆不寫入 |
| 日誌 | 驗證通過後的例外只記錄 `動作名稱 + 例外名稱 + 訊息前 200 字`；JSON 解析失敗與驗證失敗不記錄任何內容 |

## File Structure

```
package.json / package-lock.json / .gitignore
apps-script/
  appsscript.json     資訊清單（Task 4）
  lib.js              純函式與常數（Task 2、3）
  Code.gs             doGet/doPost/setup 與各動作（Task 4–9）
web/
  index.html          靜態骨架與全部對話框（Task 11）
  app.css             由預覽 CSS 改寫（Task 11、各任務補樣式）
  api.js              連線層 HotNewsApi（Task 10）
  app.js              畫面與互動（Task 12–16）
scripts/
  build-site.js       複製五個檔並加 ?v=（Task 11）
  scan-secrets.js     疑似機密掃描（Task 1）
test/
  helpers/{load-lib,fake-gas,load-backend,e2e}.js
  fixtures/{tvbs-head.html,sample-items.js}
  *.test.js           單元與後端測試（node --test test/*.test.js）
  e2e/*.e2e.js        Playwright（node --test test/e2e/*.e2e.js）
.github/workflows/pages.yml   Task 17
README.md, docs/manual-checklist.md   Task 17
```

---

### Task 1: 專案骨架與機密掃描

**Files:**
- Create: `package.json`、`.gitignore`、`scripts/scan-secrets.js`、`test/repo-scan.test.js`
- Generated: `package-lock.json`

**Interfaces:**
- Produces: `findSecrets(text: string): string[]`（回傳命中的規則名稱：`'deployment-url' | 'token-hex48' | 'token-assignment'`，無則 `[]`）；npm scripts `test`（`node --test test/*.test.js`）、`test:e2e`（`node --test --test-concurrency=1 test/e2e/*.e2e.js`）、`build`（`node scripts/build-site.js`）、`test:all`。

- [ ] **Step 1: 建立 `package.json`**：`private: true`、`engines.node: ">=22"`、上述 scripts、`devDependencies: { "playwright": "1.56.1" }`（精確版本）；`.gitignore` 含 `node_modules/`、`_site/`、`test-results/`、`*.wrapped.html`。執行 `npm install` 產生 `package-lock.json`。
- [ ] **Step 2: 寫失敗的測試 `test/repo-scan.test.js`**。陽性樣本**在執行時用字串相加組出**（測試檔本身不得含樣本字面值）：

```js
// 規則命中
assert.deepEqual(findSecrets('https://script.google.com/macros/s/' + 'AKfycb' + 'x'.repeat(30) + '/exec'), ['deployment-url']);
assert.deepEqual(findSecrets('a'.repeat(48)), ['token-hex48']);
assert.deepEqual(findSecrets("API_TOKEN = '" + 'z'.repeat(20) + "'"), ['token-assignment']);
// 不誤判
assert.deepEqual(findSecrets('https://script.google.com/macros/s/TEST_DEPLOYMENT/exec'), []);
assert.deepEqual(findSecrets('PASTE_EXEC_URL'), []);
assert.deepEqual(findSecrets('a'.repeat(40)), []);   // git sha
assert.deepEqual(findSecrets('a'.repeat(64)), []);   // sha-256
```

另一個測試：對 `git ls-files` 列出的每個文字檔（排除 `package-lock.json`、二進位檔）執行 `findSecrets`，必須全部為 `[]`。
- [ ] **Step 3: 執行 `npm test`，預期失敗**（`scripts/scan-secrets.js` 不存在）。
- [ ] **Step 4: 實作 `scripts/scan-secrets.js`**，規則：`deployment-url` = `/\/macros\/s\/AKfycb[\w-]{20,}/`；`token-hex48` = `/\b[0-9a-f]{48}\b/i`；`token-assignment` = `/API_TOKEN['"]?\s*[:=]\s*['"][^'"\s]{16,}['"]/`。以 `module.exports = { findSecrets }` 匯出。
- [ ] **Step 5: 執行 `npm test`，預期全部通過。**
- [ ] **Step 6: Commit** `chore: scaffold project with node:test, pinned playwright, secret scan`

---

### Task 2: `lib.js` — 網址、編號、文字、留言

**Files:**
- Create: `apps-script/lib.js`、`test/helpers/load-lib.js`、`test/lib.test.js`

**Interfaces:**
- Produces（`lib.js` 頂層全域，也在 `module.exports`）：
  - `var COMMENT_BASE_URL = 'https://news.tvbs.com.tw/news/'`
  - `var LIMITS = { url: 2000, orig: 500, title: 500, note: 5000, variants: 20 }`
  - `extractId(url: string): string | null`
  - `isHttpUrl(s: string): boolean`（只檢查 `^https?://` 且無空白，給畫面決定連結可否點）
  - `normalizeUrl(s: string): string | null`（去頭尾空白後回傳；不合規回 `null`）
  - `nextSerialId(ids: string[]): string`
  - `normalizeText(s: string): string`、`normalizeLine(s: string): string`
  - `buildComment(item: { id: string, url: string, note: string }): string`
- Produces: `loadLib(): object`（`test/helpers/load-lib.js`；用 `vm.createContext({ module: { exports: {} } })` 載入 `apps-script/lib.js` 並回傳 `module.exports`，沙箱內沒有 `URL`／`TextEncoder`／DOM）。

- [ ] **Step 1: 寫失敗的測試 `test/lib.test.js`**（先加一個測試確認沙箱沒有 `URL`：`vm.runInContext('typeof URL', ctx) === 'undefined'`，證明測試環境等同 Apps Script）。表格驅動，值如下：

| 函式 | 輸入 → 預期 |
|---|---|
| `extractId` | `https://news.tvbs.com.tw/cars/4032757` → `'4032757'`；`.../politics/2024/10/4032757` → `'4032757'`；`.../local/0042` → `'0042'`；`.../local/abc` → `null`；`.../cars/4032757?from=line&utm=2025101299999` → `'4032757'`；`.../cars/4032757#c20251012999999` → `'4032757'`；`https://news2024.example.com:8080/a/77` → `'77'`；`https://u:p@h123456789.com/x/5` → `'5'`；`.../a/111/b/222` → `'111'`（同長取第一個） |
| `isHttpUrl` | `http://a.b`、`HTTPS://a.b/x` → true；`javascript:alert(1)`、`ftp://a.b`、`//a.b`、`''`、`https://a b` → false |
| `normalizeUrl` | `' https://news.tvbs.com.tw/cars/4032757 \n'` → 去空白後原字串；`https://x.com:443/a` → 原字串；`null` 的：`ftp://x.com/1`、`javascript:alert(1)`、`https://user:pw@x.com/1`、`http://127.0.0.1/1`、`http://192.168.0.1/x`、`http://2130706433/`、`http://[::1]/1`、`http://localhost/1`、`http://foo.localhost/1`、`https://x.com:8443/1`、`news.tvbs.com.tw/cars/1`、含內部空白、長度 > `LIMITS.url` |
| `nextSerialId` | `[]` → `'N1'`；`['4032757']` → `'N1'`；`['N1','N7','N3','4032757']` → `'N8'`；`['N2','n9']` → `'N3'` |
| `normalizeText` | `'a\r\nb\r\n\r\n'` → `'a\nb'`；`' \n  標題\n第二行  \n\n'` → `'  標題\n第二行'`；`'   '` → `''`；`'a\u0000b\u0007c'` → `'abc'`；`'a\tb'` 不變；`'你好 👇'` 不變 |
| `normalizeLine` | `'a\n b \r\n c'` → `'a b c'`；`' x '` → `'x'` |
| `buildComment` | 有小編文 `'你多久保養一次車？\n留言分享你的習慣 👇'` + id `4032757` → `小編文 + '\n' + 'https://news.tvbs.com.tw/news/4032757'`；小編文 `''` 或 `' \n '` → 只有網址；小編文結尾 `'\n\n'` → 結果沒有空行（`!result.includes('\n\n')`）；id `'N3'`、url `https://example.com/a` → 用原文連結（有小編文為 `note + '\n' + url`，無則只有 url） |

- [ ] **Step 2: 執行 `npm test`，預期失敗**（`lib.js` 不存在）。
- [ ] **Step 3: 實作 `apps-script/lib.js` 上述介面與匯出守衛。** `extractId`：先去掉 `^[a-z][a-z0-9+.-]*://[^/]*` 再去掉 `[?#].*$`，取最長連續數字（同長取先出現者）。`normalizeUrl` 以規則運算式解析 scheme、authority（含 `@`→拒絕、IPv4／IPv6／純數字主機→拒絕、`localhost` 與 `*.localhost`→拒絕、埠只允許空／80／443）。
- [ ] **Step 4: 執行 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(lib): url, id, text normalization and comment builder`

---

### Task 3: `lib.js` — 標題抽取

**Files:**
- Modify: `apps-script/lib.js`
- Create: `test/fixtures/tvbs-head.html`、`test/title.test.js`

**Interfaces:**
- Consumes: Task 2 的 `loadLib()`。
- Produces：
  - `var TITLE_SOURCES = ['og:title','twitter:title','title','h1']`
  - `var SITE_SUFFIXES = []`（預設空：規格明訂不先猜）
  - `var HTML_SCAN_LIMIT = 300 * 1024`
  - `cleanTitle(s: string, suffixes?: string[]): string`（預設用 `SITE_SUFFIXES`）
  - `titleFromHtml(html: string, suffixes?: string[]): { title: string, source: string } | null`

- [ ] **Step 1: 建立 `test/fixtures/tvbs-head.html`**：一個合成的 `<head>`（含 `og:description`、`twitter:card`、`<title>` 等雜訊），其中**必須逐字包含**使用者實測的標記：`<meta property="og:title" content="買二手車別只看外觀、里程數！「4大陷阱」小心、這些地方要檢查">`。
- [ ] **Step 2: 寫失敗的測試 `test/title.test.js`**：
  - TVBS fixture → `{ title: '買二手車別只看外觀、里程數！「4大陷阱」小心、這些地方要檢查', source: 'og:title' }`。
  - 來源順序：只有 `twitter:title` → source `'twitter:title'`；只有 `<title>`；只有 `<h1>`；全都有 → `og:title`；`og:title` 為空白時退回下一個。
  - meta 變形：`content` 在 `property` 前；單引號；`name="og:title"`；大小寫不同的標籤與屬性名。
  - 實體只還原一次：`&amp;lt;` → `&lt;`；`&quot;`、`&#39;`、`&#x27;`、`&apos;`、`&nbsp;`；非法數字實體（`&#99999999;`）不丟例外。
  - 空白：標題含換行與連續空白 → 壓成單一空格；含控制字元與雙向控制字元（U+202E、U+200F）→ 移除。
  - 範圍：`</head>` 之後的 meta／`<title>` 被忽略；`<!-- <meta property="og:title" content="假"> -->`、`<script>` 與 `<style>` 內的假標籤被忽略；`<h1>` 內含 `<span>` 取純文字；沒有 `</head>` 時只看前 `HTML_SCAN_LIMIT` 字元（標題在 300 KB 之後 → `null`）。
  - 防機器人頁面：`<title>Just a moment...</title>`、`Attention Required! | Cloudflare`、`Access denied`、`Verify you are human`、`請稍候…` → `null`。
  - `cleanTitle`：`('台灣新聞 ｜ TVBS新聞網', ['TVBS新聞網'])` → `'台灣新聞'`（`｜ | - – —` 前後有無空白都處理）；`('TVBS新聞網是好網站', ['TVBS新聞網'])` 不變；標題本身含 `｜` 但後段不是已知名稱 → 不變；預設 `SITE_SUFFIXES` 為空時任何標題都不變。
  - 沒有任何來源 → `null`。
- [ ] **Step 3: 執行 `npm test`，預期失敗。**
- [ ] **Step 4: 實作。** 流程：取前 `HTML_SCAN_LIMIT` 字元 → 移除註解、`<script>`、`<style>` 區塊 → `<meta>` 與 `<title>` 只看 `</head>` 之前（找不到時看整段已截斷內容）、`<h1>` 取截斷內容中的第一個 → 依 `TITLE_SOURCES` 取第一個 `cleanTitle` 後非空且非防機器人標題者。防機器人標題用 `BLOCKED_TITLE_PATTERNS`（陣列，與上列樣本對應）。實體以單一次 `replace` 還原（`String.fromCodePoint`，超出範圍者略過）。
- [ ] **Step 5: 執行 `npm test`，預期全部通過。**
- [ ] **Step 6: Commit** `feat(lib): title extraction with ordered sources and challenge-page guard`

---

### Task 4: 後端測試台與 `doPost` 關卡

**Files:**
- Create: `apps-script/Code.gs`、`apps-script/appsscript.json`、`test/helpers/fake-gas.js`、`test/helpers/load-backend.js`、`test/backend.gate.test.js`

**Interfaces:**
- Produces（測試台，Task 5–9、12–16 都用）：
  - `createFakeGas(opts?: { now?: number }): gas`，`gas` 具有：`setProperty(k, v)`、`setNow(ms)`、`now`、`lockHeld: boolean`（為 true 時 `waitLock` 丟例外）、`urlFetch: (url, opts) => { code: number, text: string }`（可丟例外）、`spreadsheetThrows: string | null`、`calls: { spreadsheetOpens: number, urlFetches: {url, opts}[], logs: string[] }`、`spreadsheet`（Task 5 補完）、`globals(): object`（`SpreadsheetApp`、`LockService`、`UrlFetchApp`、`PropertiesService`、`ContentService`、`Logger`、`console`、`Date`、`JSON`）；其中 `Date` 是子類別：無參數建構與 `Date.now()` 都回傳 `gas.now`。預設已設 `API_TOKEN = 't'.repeat(48)`、`SHEET_ID = 'TEST_SHEET'`；`openById` 只認 `'TEST_SHEET'`，否則丟例外。
  - `loadBackend({ gas }): { raw(body: string): string, call(action: string, args?: object, o?: { token?: string }): object, gas }`——以 `new Function(...Object.keys(globals), libSource + '\n' + codeSource + '\nreturn { doGet, doPost };')` 載入 `lib.js`＋`Code.gs`；`call` 用預設密碼組出 `{token, action, args}`，經 `doPost` 並解析回應；`raw` 回傳原始字串（e2e 轉接用）。
  - 測試台提供的 `JSON` 是包裝版：`stringify` 的 replacer 以 `this[key] instanceof Date` 偵測並丟例外（防止 `Date` 漏進回應）。
- Produces（`Code.gs`）：`doGet(): TextOutput`（內容 `ok`）、`doPost(e): TextOutput`（MIME JSON）、固定訊息表 `ERROR_MESSAGES`、`failure_(code, extra?)`（丟出受控失敗）、動作表 `ACTIONS`（只能用 `Object.prototype.hasOwnProperty.call` 查，擋 `__proto__`／`constructor`）。固定訊息：`unauthorized` 密碼不正確或尚未設定。／`bad_request` 請求內容不正確。／`duplicate` 這則新聞已經存在。／`not_found` 這則已不存在。／`stale` 這則的改標已被其他裝置更新，請重新整理。／`busy` 系統忙碌中，請稍後再試。／`server_error` 伺服器發生錯誤，請稍後再試。

- [ ] **Step 1: 寫失敗的測試 `test/backend.gate.test.js`**（先建好 `fake-gas.js`／`load-backend.js` 的最小版本使測試能載入，`Code.gs` 先放空殼）：
  - 資訊清單：`JSON.parse(appsscript.json)` 的 `timeZone`、`runtimeVersion`、`exceptionLogging`、`oauthScopes`（**完全等於**兩個值，順序不拘）、`webapp` 皆符合 Global Constraints。
  - `doGet()` 內容為 `ok`。
  - `unauthorized`：`API_TOKEN` 未設定／長度 31／請求沒帶 token／錯誤 token／token 為數字 `123` → 五種回應**逐字相同**，等於 `{ok:false,code:'unauthorized',error:'密碼不正確或尚未設定。'}`，且每次都 `gas.calls.spreadsheetOpens === 0 && gas.calls.urlFetches.length === 0`。
  - `bad_request`：內文不是 JSON、是 `null`、是陣列、缺 `action`、驗證後 `action` 為 `'nope'`／`'__proto__'`／`'constructor'`／`'toString'`。
  - `ping`：回 `{ok:true,data:{pong:true}}` 且 `spreadsheetOpens === 1`；`SHEET_ID` 未設定 → `server_error`、訊息為固定訊息。
  - 不洩漏：令 `gas.spreadsheetThrows = 'SECRET-MSG'` 後呼叫 `ping`，回應字串不含 `SECRET-MSG`；`gas.calls.logs` 不含密碼、不含請求內文。
  - 測試台自檢：回應 `data` 內含 `Date` 時 `stringify` 會丟例外。
- [ ] **Step 2: 執行 `npm test`，預期新測試失敗。**
- [ ] **Step 3: 實作 `Code.gs`**：`doPost` 依序 解析→驗密碼（`tok && tok.length >= 32 && req.token === tok`）→ 白名單 → `ACTIONS[action](args)`；最外層 `try/catch`：受控失敗轉成對應 `code`＋固定訊息，其他例外轉 `server_error` 並依「日誌」決定記錄內容；回應一律 `ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON)`。`ping` 先以 `db_()` 的占位（Task 5 實作）開啟試算表：此任務中 `db_()` 只做 `SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'))`，`SHEET_ID` 為空就丟錯。`appsscript.json` 內容照 Global Constraints。
- [ ] **Step 4: 執行 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(backend): doPost gate with fail-closed auth, fake Google test harness, manifest`

---

### Task 5: 試算表層、`listItems`、`setup()`

**Files:**
- Modify: `apps-script/Code.gs`、`test/helpers/fake-gas.js`
- Create: `test/backend.sheet.test.js`

**Interfaces:**
- Consumes: Task 4 的測試台與 `failure_`。
- Produces（線路型別，後續任務與網頁共用）：
  - `Variant = { ver: number, t: string, last: number | null, count: number }`
  - `Item = { id: string, cat: string, orig: string, url: string, note: string, last: number | null, count: number, created: number, titles: Variant[] }`（`titles` 依 `ver` 由小到大）
  - 動作 `listItems`（`args: {}`）→ `{ items: Item[], cats: string[] }`（`items` 依試算表列順序）
- Produces（`Code.gs` 內部，後續任務使用）：`db_(): { ss, news, edits, cats }`（開啟 `SHEET_ID`、補建缺少的分頁與標題列、預設分類）、`readAll_(db): { items: Item[], cats: string[] }`、`setup(): void`、`SHEET = { news: '新聞', edits: '改標', cats: '分類' }`、欄位索引常數。
- Produces（假試算表的保真規則，後續寫入類任務依賴）：`getRange` 的列數／欄數 < 1 丟例外（真實 API 如此）；對格式為 `'@'` 的儲存格寫入的值一律存成字串；對其他格式寫入以 `=` 開頭的字串會被當公式（讀回 `'#FORMULA'`）、看起來像數字的字串（含 `'0042'`）被轉成數字；`getValues` 對日期格式且存了 `Date` 的格 回傳 `Date`；`deleteRow` 後下方列上移；`insertSheet` 同名丟例外；`getSheetByName` 找不到回 `null`；另提供 `gas.dump(sheetName): any[][]` 與 `gas.seedRows(sheetName, rows)`（直接塞資料，模擬使用者手動編輯）和 `gas.opLog`（依序記錄 `{op:'setNumberFormat'|'setValues'|'deleteRow', sheet, range, ...}`）。

- [ ] **Step 1: 寫失敗的測試 `test/backend.sheet.test.js`**：
  1. `setup()`：空試算表 → 建出三個分頁，標題列與規格 §4 逐字相同、分類為預設六個、`setSpreadsheetTimeZone('Asia/Taipei')` 被呼叫；再跑一次不重複建立、不覆蓋已被使用者改過的分類；執行記錄（`gas.calls.logs`）有 `API_TOKEN` 與 `SHEET_ID` 狀態，但不含密碼值；`setup()` 會呼叫一次 `UrlFetchApp.fetch('https://example.com', …)`（觸發外部請求授權，與冒煙測試相同）。
  2. `listItems`：空試算表 → `{items:[], cats:[六個預設]}`。
  3. 對應：用 `seedRows` 放入 2 則新聞與 3 個改標（版本號故意亂序）→ 欄位對應正確、時間為 epoch 毫秒數字、`titles` 依 `ver` 排序、沒有改標者 `titles: []`、`id` 一律字串（儲存格是數字 `4032757` 也回 `'4032757'`）。
  4. **髒資料（Review Focus 2）**：`id` 空白的列略過；改標列的 `新聞id` 找不到新聞 → 略過；`版本號` 非數字 → 略過；`使用次數` 為 `''` 或 `'abc'` → `0`；`上次使用時間` 為文字 `'昨天'` → `null`；分類分頁含空白、重複、前後空格 → 清理後去重保持順序；新聞列後面有多餘空白列；`改標` 分頁被刪掉 → 下一次呼叫自動補建、`listItems` 仍成功。
- [ ] **Step 2: 執行 `npm test`，預期失敗。**
- [ ] **Step 3: 實作** `db_`、`readAll_`、`setup`、`listItems`，並補完假試算表（含上列保真規則）。`readAll_` 在 `lastRow < 2` 時不呼叫 `getRange`。每次動作都重新讀取（不跨請求快取）。
- [ ] **Step 4: 執行 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(backend): sheet layer, tolerant listItems, setup()`

---

### Task 6: `addItem` 與鎖

**Files:**
- Modify: `apps-script/Code.gs`
- Create: `test/backend.add.test.js`

**Interfaces:**
- Consumes: `Item`、`db_()`、`readAll_`、`gas.opLog`、`failure_`。
- Produces：
  - `withLock_(fn: () => any): any`（`getScriptLock().waitLock(10000)`，取不到 → `failure_('busy')`；`finally` 一定 `releaseLock`）
  - 動作 `addItem`：`args: { url: string, orig: string, cat: string, note?: string, titles?: string[] }` → `{ item: Item }`；重複 → `{ok:false, code:'duplicate', error, existing: Item}`
  - 內部 `writeText_(sheet, row, col, values2d)`：先 `setNumberFormat('@')` 再 `setValues`，對**實際寫入範圍**。

- [ ] **Step 1: 寫失敗的測試 `test/backend.add.test.js`**：
  - 成功：`call('addItem', {url:'https://news.tvbs.com.tw/cars/4032757', orig:'原始', cat:'生活', note:'n', titles:['A\nB','C']})` → `item.id === '4032757'`、`created === gas.now`、`last === null`、`count === 0`、`titles` 為 `[{ver:1,t:'A\nB',last:null,count:0},{ver:2,t:'C',...}]`；`gas.dump('新聞')` 該列 A 欄為字串 `'4032757'`。
  - 正規化：`note:'你多久保養一次車？\r\n留言 👇\r\n'` → 存入 `'你多久保養一次車？\n留言 👇'`（emoji 往返不變；Review Focus 1、5）；`titles:['  \n', '標題\r\n']` → 只存 `['標題']`；`orig:' 原始\n標題 '` → `'原始 標題'`。
  - **先設格式再寫入**：對 `gas.opLog` 檢查，每個文字欄位的 `setValues` 之前都有涵蓋同一範圍的 `setNumberFormat('@')`；標題 `'=1+1'`、`'+1'`、`'-1'`、`'@SUM(1)'` 經 `listItems` 讀回逐字不變；網址 `…/local/0042` → `id` 為 `'0042'` 且保留前導零。
  - 無數字網址 → `id` 為 `'N1'`，再新增一則 → `'N2'`。
  - 重複：同一網址再 `addItem` → `code:'duplicate'`，`existing.id` 正確，兩個分頁都沒有新增列。
  - `bad_request`：缺 `url`／`orig`／`cat`；`url` 為 `ftp://…`、`http://localhost/1`；`cat` 不在分類分頁；`orig` 超過 `LIMITS.orig`；`titles` 超過 `LIMITS.variants` 個、單一標題超過 `LIMITS.title`；`note` 超過 `LIMITS.note`；`titles` 不是陣列；`note` 不是字串。以上都不得寫入任何列。
  - `busy`：`gas.lockHeld = true` → `code:'busy'`；之後把它設回 `false`，下一次呼叫成功（鎖在例外後仍被釋放）。
- [ ] **Step 2: 執行 `npm test`，預期失敗。**
- [ ] **Step 3: 實作 `withLock_`、`writeText_`、`addItem`。** 驗證順序：型別與長度 → `normalizeUrl` → 分類存在 → 取鎖 → 重新讀取現況檢查重複 → 寫入 `新聞` 一列與 `改標` 多列（時間欄 `setNumberFormat('yyyy/MM/dd HH:mm')`、次數欄 `'0'`）。`id` 由伺服器自己算（`extractId(normalizedUrl)` 或 `nextSerialId`），不信任客戶端。
- [ ] **Step 4: 執行 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(backend): addItem with lock, text-format-first writes, duplicate and validation`

---

### Task 7: `updateItem`

**Files:**
- Modify: `apps-script/Code.gs`
- Create: `test/backend.update.test.js`

**Interfaces:**
- Consumes: `withLock_`、`writeText_`、`readAll_`、`Item`。
- Produces：動作 `updateItem`：`args: { id: string, cat: string, note: string, edit?: {ver: number, t: string}[], add?: string[], remove?: number[] }` → `{ item: Item }`；`id` 不存在 → `not_found`；任何 `ver` 指到不存在的版本 → `stale`（整筆不寫入）。

- [ ] **Step 1: 寫失敗的測試 `test/backend.update.test.js`**（每個測試先用 `addItem` 建資料）：
  - 分類：改成存在的分類 OK；改成不存在 → `bad_request`；該分類事後從分類分頁刪掉，但請求帶著**未變動**的原分類 → 放行。
  - `note` 可改可清空；正規化規則同 Task 6。
  - `edit` 改既有版本文字：`ver`、`last`、`count` 不變（先用 `seedRows` 把該版本設成 `count 2`、`last` 某時間，改完仍是）。
  - `add` 的新版本 `ver = 現有最大 + 1`；`[1,2,3]` 且 `remove:[3]`、`add:['x']` → 新版本是 `4`（不重用）。
  - **只刪明確列出的**：新增後（模擬別的裝置先加了 `ver 4`），用只知道 `[1,2,3]` 的請求更新且不含 `remove` → `ver 4` 仍在。
  - `stale`：`edit` 指到 `ver 9`、或 `remove` 指到不存在的版本 → `code:'stale'`，且 `gas.opLog` 沒有任何寫入。
  - `not_found`：未知 `id`。
  - `bad_request`：同一個 `ver` 同時出現在 `edit` 與 `remove`（或在 `edit` 內重複）；`edit` 的 `t` 為空白；`add` 之後版本總數超過 `LIMITS.variants`；`edit`／`add` 單筆超過 `LIMITS.title`；`add` 內的空白字串被略過（不是錯誤）。
  - 先設格式再寫入：把版本標題改成 `'=2+2'` 讀回逐字不變。
  - `busy`。
- [ ] **Step 2: 執行 `npm test`，預期失敗。**
- [ ] **Step 3: 實作 `updateItem`。** 在鎖內重新讀取，先**完整驗證**（分類、`ver` 皆存在、長度）再寫入，確保失敗時不留下半套寫入；移除版本時由下往上刪列。
- [ ] **Step 4: 執行 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(backend): updateItem with explicit remove list and stale detection`

---

### Task 8: `deleteItem` 與 `markUsed`

**Files:**
- Modify: `apps-script/Code.gs`
- Create: `test/backend.delete-mark.test.js`

**Interfaces:**
- Consumes: `withLock_`、`readAll_`、`Item`。
- Produces：`deleteItem`：`args: { id: string }` → `{ id: string }`（不存在 → `not_found`）；`markUsed`：`args: { id: string, ver?: number }` → `{ item: Item }`。

- [ ] **Step 1: 寫失敗的測試 `test/backend.delete-mark.test.js`**：
  - 刪除：新聞列與它所有 `改標` 列都消失、其他新聞的列不受影響（先建 3 則，改標交錯排列，刪中間那則）；未知 `id` → `not_found`；刪除後 `listItems` 少一則；`busy`。
  - 標記（有 `gas.setNow` 控制時間）：有改標的新聞 `markUsed({id, ver:2})` → 整則 `last === now`、`count 1`，版本 2 的 `last === now`、`count 1`，版本 1 不變；再標一次 → 整則 2、版本 2 為 2；回傳的 `item` 含所有版本。
  - 沒有改標的新聞：`markUsed({id})` 只更新整則。
  - `stale`：`ver` 不存在；`not_found`：`id` 不存在；`bad_request`：該則有改標卻沒帶 `ver`、`ver` 不是整數。
  - 寫入的時間格有 `yyyy/MM/dd HH:mm` 格式（從 `gas.opLog` 驗證）；回應無 `Date`（測試台自動檢查）；`busy`。
- [ ] **Step 2: 執行 `npm test`，預期失敗。**
- [ ] **Step 3: 實作兩個動作**（皆在鎖內重新讀取；`markUsed` 的時間用伺服器的 `new Date()`）。
- [ ] **Step 4: 執行 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(backend): deleteItem cascade and markUsed on item and variant`

---

### Task 9: `fetchTitle`

**Files:**
- Modify: `apps-script/Code.gs`
- Create: `test/backend.fetch-title.test.js`

**Interfaces:**
- Consumes: `normalizeUrl`、`titleFromHtml`（Task 2、3）、`gas.urlFetch`。
- Produces：`fetchTitle`：`args: { url: string }` → `{ title: string | null, source: string | null }`（資料只有這兩個鍵）。不取鎖、不開試算表。

- [ ] **Step 1: 寫失敗的測試 `test/backend.fetch-title.test.js`**：
  - 成功：`gas.urlFetch` 回 `{code:200, text: tvbs-head.html 內容}` → `{title:'買二手車別只看外觀、里程數！「4大陷阱」小心、這些地方要檢查', source:'og:title'}`；`gas.calls.urlFetches` 恰一筆，且 `opts` 含 `muteHttpExceptions: true`、`followRedirects: true`、`timeoutSeconds: 8`、`headers['User-Agent']` 含 `Mozilla/5.0`、`headers['Accept-Language'] === 'zh-TW,zh;q=0.9'`；回應物件的 `data` 鍵集合恰為 `['source','title']`（不含原始網頁）。
  - 失敗都回 `ok:true` 與 `{title:null, source:null}`：狀態碼 403／500；`urlFetch` 丟例外（回應字串不含例外訊息）；防機器人頁面（`<title>Just a moment...</title>`）；完全沒有標題。
  - `bad_request` 且**沒有發出請求**：`ftp://x.com/a`、`https://user:pw@x.com/a`、`http://127.0.0.1/a`、`http://localhost/a`、`https://x.com:8443/a`、缺 `url`。
  - 不依賴鎖與試算表：`gas.lockHeld = true` 仍成功；`gas.calls.spreadsheetOpens === 0`。
  - 密碼錯誤時不發出請求（沿用 Task 4 關卡，這裡用真實動作再驗一次）。
  - 預設 `SITE_SUFFIXES` 為空 → 帶後綴的 `<title>` 不被裁切。
- [ ] **Step 2: 執行 `npm test`，預期失敗。**
- [ ] **Step 3: 實作 `fetchTitle`**：`normalizeUrl` → `UrlFetchApp.fetch(url, opts)`（選項如上，與冒煙測試的 `fetchTitleSpike_` 相同）→ 狀態碼非 200 或例外 → 空結果；`getContentText('UTF-8')` → `titleFromHtml`。
- [ ] **Step 4: 執行 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(backend): fetchTitle with URL restrictions and graceful failure`

---

### Task 10: `api.js` 連線層

**Files:**
- Create: `web/api.js`、`test/api.test.js`

**Interfaces:**
- Produces（`var HotNewsApi`，頂層全域；node 以 `module.exports` 匯出同一物件）：
  - `HotNewsApi.API_URL_PATTERN: RegExp`（`/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/`）
  - `HotNewsApi.ApiError`（`extends Error`；欄位 `code`、`message`、`existing?`、`step?: 'get'|'ping'`、`unknown: boolean`——連線中斷／逾時／讀不到回應時為 `true`）
  - `HotNewsApi.createClient({ fetch, storage, setTimeout, clearTimeout, AbortController }): client`
  - `client.getConfig(): { url: string|null, token: string|null, remember: boolean }`
  - `client.saveConfig({ url, token, remember }): void`（去前後空白；網址不符 `API_URL_PATTERN` → 丟 `ApiError('bad_request')`）
  - `client.clearToken(): void`、`client.clearConfig(): void`
  - `client.call(action: string, args?: object): Promise<any>`（回傳 `data`；逾時：`fetchTitle` 8000 ms，其餘 30000 ms）
  - `client.checkConnection(url: string, token: string): Promise<void>`（失敗時 `ApiError.step` 為 `'get'` 或 `'ping'`；**不**寫入或清除任何已儲存設定）
- 客戶端專用 `code`：`unreachable`（連不上、回應不是 JSON、形狀不對）、`timeout`、`no_config`；固定訊息：讀不到伺服器的回應。／伺服器沒有在時間內回應。／尚未設定。伺服器端錯誤沿用回應的 `error` 欄位。

- [ ] **Step 1: 寫失敗的測試 `test/api.test.js`**（在 `vm` 沙箱載入 `web/api.js`，注入假 `fetch`、假 `storage`（可設定為存取即丟例外）、可手動推進的假計時器與假 `AbortController`）：
  - 請求形狀：`call('ping')` 的 `fetch` 引數為 POST、`headers` 恰為 `{'Content-Type':'text/plain;charset=utf-8'}`、`body` 解析後等於 `{token, action:'ping', args:{}}`、`credentials:'omit'`、`referrerPolicy:'no-referrer'`、`redirect:'follow'`、有 `signal`。
  - 成功回傳 `data`；`ok:false` → `ApiError`，`code`、`message`（取回應的 `error`）、`existing`（`duplicate` 時）。
  - `unauthorized`：記憶體與儲存的密碼都被清掉，再丟 `ApiError('unauthorized')`。
  - 讀不到回應：假 `fetch` 拒絕（`TypeError`）、回應是 HTML 登入頁、回應 JSON 缺 `ok` → `code:'unreachable'`、`unknown:true`；不重試（`fetch` 只被呼叫一次，連 `addItem` 這類寫入也一樣）。
  - 逾時：`fetch` 永不回應 → 推進 8000 ms 後 `fetchTitle` 以 `timeout` 失敗（`AbortController.abort` 被呼叫）；其他動作在 29999 ms 時仍等待、30000 ms 時失敗。
  - 設定：沒有網址或密碼 → `call` 丟 `no_config` 且不呼叫 `fetch`；`saveConfig` 去前後空白與換行（`'  token\n'`、`' https://…/exec \n'`；Review Focus 3）；`remember:false` → 儲存中**沒有** `hotnews.v1.token`（並移除先前殘留）、記憶體取得得到密碼；`remember:true` → 寫入；鍵名 `hotnews.v1.url`／`token`／`remember`；`storage` 存取丟例外時仍能運作（只在記憶體）；`clearConfig` 清光三個鍵。
  - `checkConnection`：第一步 GET（`credentials:'omit'`、`redirect:'follow'`、`referrerPolicy:'no-referrer'`），文字為 `ok` 或 `'ok\n'` 才算過；HTML、拒絕、非 `ok` → `step:'get'`；第二步 `ping`：`unauthorized` → `step:'ping'`、`code:'unauthorized'` 且**不清除**已儲存的密碼；全過則 resolve。
- [ ] **Step 2: 執行 `npm test`，預期失敗。**
- [ ] **Step 3: 實作 `web/api.js`**（ES2019 以內；依賴全由 `createClient` 注入；檔尾匯出守衛）。
- [ ] **Step 4: 執行 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(web): api client with fixed error mapping, timeouts and no mutating retry`

---

### Task 11: 網站骨架、建置腳本與靜態檢查

**Files:**
- Create: `web/index.html`、`web/app.css`、`web/app.js`（暫時只有檔頭註解）、`scripts/build-site.js`、`test/site.test.js`

**Interfaces:**
- Produces：`buildSite({ outDir: string, sha?: string }): { outDir: string, files: string[] }`（CLI：`node scripts/build-site.js [outDir=_site]`，`sha` 取 `GITHUB_SHA` 或 `git rev-parse HEAD`，須符合 `/^[0-9a-f]{7,40}$/` 否則用 `'dev'`，取前 12 碼）。
- Produces（`index.html` 的 DOM 契約，Task 12–16 與 e2e 依賴）：
  - 標頭：`#settingsBtn`、`#addBtn`；工具列：`#q`（`type=search`）、`#sort`（`option` 值 `oldest|recent|count|created`，文字：最久未用優先／最近使用優先／使用次數多到少／最新新增）；`#chips`、`#list`；`<p class="foot">`。
  - 設定對話框 `<dialog id="settingsDlg">`＋`<form id="settingsForm" method="dialog">`：`#sUrl`、`#sToken`（`type=password`）、`#sRemember`（`checkbox`，旁註說明共用 `github.io` 網域）、`#sMsg`（`role=alert` 訊息區）、`#sSteps`（檢查清單區）、`#sClear`（清除這台裝置的設定）、`#sSave`（儲存並連線）。
  - 新增／編輯對話框 `<dialog id="dlg">`＋`<form id="form" method="dialog">`：`#dlgTitle`、`#fUrl`、`#idHint`、`#fCat`、`#fOrig`、`#titleHint`、`#vars`、`#addVar`、`#fNote`、`#err`、`#del`、`#cancel`、`#save`。
  - `<div id="toast" role="status" hidden>`。
  - `<html lang="zh-Hant-TW">`、viewport meta（含 `viewport-fit=cover`）、`<link rel="icon" href="data:,">`；`<script src="lib.js" defer>`、`api.js`、`app.js`（此順序）。
  - 資源參照格式：`href="app.css"`、`src="lib.js"` 等純相對路徑（建置時加 `?v=`）。

- [ ] **Step 1: 寫失敗的測試 `test/site.test.js`**（`buildSite` 到暫存目錄後檢查）：輸出檔案恰為五個；`lib.js` 與 `apps-script/lib.js` 位元組相同；`index.html`：`<head>` 的第一個元素是 CSP meta 且內容**完全等於** Global Constraints 的字串、有 referrer 與 robots meta；每個 `<script>` 都有 `src`、沒有 `<style>` 標籤、沒有 `style=` 與 `on\w+=` 屬性；所有 `src`／`href` 都是相對路徑且四個資源都帶 `?v=<12 碼>`；沒有任何 `http://`、`https://`、`//` 開頭的屬性值；上列所有 id 都存在；`sort` 的四個選項值；`app.css` 沒有 `@import`、`@font-face`、`url(`；`sha` 不合格式（如 `'$(rm -rf)'`）時退回 `dev`。
- [ ] **Step 2: 執行 `npm test`，預期失敗。**
- [ ] **Step 3: 實作。** `app.css`：以預覽（`hot-news-preview.html` 的 `<style>`）為基底，改動只有：移除 Google 字型連結，`--font-body` 改 `"PingFang TC","Microsoft JhengHei","Noto Sans TC",system-ui,sans-serif`、`--font-mono` 改 `ui-monospace,Menlo,Consolas,monospace`；移除 `.badge` 與 `data-theme` 相關規則（保留 `prefers-color-scheme: dark`）；加入 `[hidden]{display:none!important}`、`body{margin:0}`、`.sr-copy`（剪貼簿後備 textarea 用的離螢幕樣式）、設定對話框與 `.hdr-actions` 所需樣式。`index.html` 依上述契約，頁尾說明文字改成正式版用語（刪「預覽版」字樣，保留操作提示與留言網址格式）。`build-site.js` 複製五個檔並改寫資源網址。
- [ ] **Step 4: 執行 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(web): static shell with strict CSP, css port, and site build script`

---

### Task 12: e2e 測試台與應用外殼（設定、連線、載入狀態）

**Files:**
- Create: `test/helpers/e2e.js`、`test/fixtures/sample-items.js`、`test/e2e/shell.e2e.js`
- Modify: `web/app.js`

**Interfaces:**
- Consumes: Task 4 的 `createFakeGas`／`loadBackend`、Task 11 的 `buildSite` 與 DOM 契約、Task 10 的 `HotNewsApi`。
- Produces（測試台）：
  - `API_URL = 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec'`、`TOKEN = 't'.repeat(48)`
  - `startSite(): Promise<{ origin: string, close(): Promise<void> }>`（建置到暫存目錄，用 node `http` 提供靜態檔）
  - `openApp(site, opts?: { gas?, preconfigure?: boolean (預設 true，經 init script 預先寫入 url／token／remember=1), viewport?, mobile?: boolean, seed?: boolean }): Promise<{ page, ctx, backend, close() }>`
  - `backend`：`{ gas, calls: {method, action?, args?, contentType?}[], failNext(kind: 'drop'|'hang'|'html'), delayMs: number, call(action, args) }`；路由 `API_URL`：GET 回文字 `ok`，POST 轉給 `loadBackend().raw`，回應帶 `access-control-allow-origin: *`（模擬 Google 的行為，否則跨網域讀取會被擋）；`drop` = `route.abort()`、`hang` = 不回應、`html` = 回 HTML 登入頁。
  - `openApp` 建立的 context 固定 `timezoneId: 'Asia/Taipei'`、`locale: 'zh-TW'`，並對該 origin 授權 `clipboard-read`／`clipboard-write`。
  - 每個 `openApp` 自動掛上：原生對話框偵測（任何 `alert`／`confirm`／`prompt` 都記錄，`assertNoNativeDialogs()`）、`securitypolicyviolation` 收集（`assertNoCspViolations()`）、`pageerror` 收集；e2e 檔的 `afterEach` 必須呼叫這三個斷言。
  - `seedSample(backend): void`：以 `addItem`＋`markUsed`（用 `gas.setNow` 控制時間，以 `NOW` 為基準）重現預覽的五則範例（`hot-news-preview.html` 第 161–184 行）。順序、建立時間與使用紀錄如下：

| id | 建立 | 改標（版本 1…） | 使用紀錄（舊→新） |
|---|---|---|---|
| 4032757（生活） | 30 天前 | 3 版（預覽原文） | v1：25 天前、20 天前；v2：9 天前 |
| 4031880（社會） | 2 天前 | 1 版 | 無 |
| 4030112（健康） | 12 天前 | 2 版 | v1：1 天又 1 小時前 |
| 4029554（生活） | 40 天前 | 1 版 | v1：30 天前、21 天前 |
| 4028301（社會） | 1 天前 | 0 版 | 無 |

  　小編文、標題文字、網址、原始標題一律照預覽原文；`NOW` 固定為 `Date.UTC(2026,9,12,4,0,0)`（e2e 以 `page.clock.setFixedTime(NOW)` 對齊瀏覽器時間）。
- Produces（`app.js` 外殼）：`state`（`items`、`cats`、`status: 'idle'|'loading'|'error'|'ready'`、`cat`、`q`、`sort`、`pos`、…）、`api`（`HotNewsApi.createClient` 實例）、`h(tag, props, ...children)`（建立 DOM，文字一律 `textContent`）、`toast(msg)`、`loadItems()`、`openSettings(reason?: string)`、`callApi(action, args)`（集中處理：`unauthorized` → `api.clearToken()` 並開設定對話框顯示「密碼不正確或已更換，請重新輸入。」、再丟出讓呼叫端中止）、`mutate(action, args)`（寫入類動作專用：`unknown` 失敗 → 提示「連線中斷，結果不確定，已重新載入列表」並 `loadItems()`；`stale`／`not_found` → 顯示訊息並 `loadItems()`）、`renderCards()`（本任務為空實作，Task 13 實作）。

- [ ] **Step 1: 寫失敗的測試 `test/e2e/shell.e2e.js`**（`node:test`；`before` 啟動站台與瀏覽器）：
  - 首次開啟（`preconfigure:false`）自動跳出設定對話框；`#sToken` 為 `type=password`。
  - 儲存並連線的流程（觀察 `backend.calls`）：先 GET 再 `ping` 再 `listItems`；成功後對話框關閉、列表區沒有「載入中…」。
  - 輸入的網址與密碼帶前後空白與換行（`' …/exec\n'`、`'  ' + TOKEN + '\n'`）仍連線成功（Review Focus 3）。
  - 失敗訊息分步：GET 失敗（`failNext('html')`）→ `#sMsg` 說明「網址或部署存取權不對」、`#sSteps` 列出檢查清單（網址以 `/exec` 結尾、存取權「任何人」、改過程式要建立新版本）；密碼錯誤 → 「密碼不正確」；網址格式不符（`https://example.com`）→ 不送出任何請求。兩種失敗都不寫入 localStorage。
  - 密碼預設只在記憶體：成功連線後 `localStorage` 沒有 `hotnews.v1.token`、有 `hotnews.v1.url`；重新整理頁面 → 再次跳出設定對話框（網址已預填、密碼空白）；勾「記住」後重新整理 → 直接載入列表。
  - 任何請求收到 `unauthorized`（`gas.setProperty('API_TOKEN', 'x'.repeat(48))` 後觸發 `loadItems`）→ 清掉已存密碼並開啟設定對話框；「清除這台裝置的設定」清光三個鍵。
  - 載入狀態：延遲回應時顯示「載入中…」；`failNext('drop')` → 列表區顯示固定錯誤訊息與「重試」，按下後恢復；空試算表 → 空狀態顯示「＋ 新增新聞」引導。
  - 所有請求只有 GET／POST，POST 的 `Content-Type` 是 `text/plain;charset=utf-8`（沒有 OPTIONS，證明沒有觸發預檢）。
  - `afterEach`：無原生對話框、無 CSP 違規、無 `pageerror`。
- [ ] **Step 2: 實作測試台**（`e2e.js`、`sample-items.js`）。執行 `npm run test:e2e`，預期新測試失敗（`app.js` 尚未實作）。
- [ ] **Step 3: 實作 `app.js` 外殼**：啟動流程 `init()`＝讀設定，缺網址或缺密碼 → `openSettings()`，否則 `loadItems()`；設定表單送出走 `api.checkConnection`，失敗依 `step` 與 `code` 顯示訊息與清單；成功才 `saveConfig` 並 `loadItems()`；密碼欄位在已記住時不回填；`#sSave` 進行中停用。
- [ ] **Step 4: 執行 `npm run test:e2e` 與 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(web): app shell with settings, connection check and e2e harness`

---

### Task 13: 列表、搜尋、排序、分類篩選

**Files:**
- Modify: `web/app.js`、`web/app.css`
- Create: `test/e2e/list.e2e.js`

**Interfaces:**
- Consumes: Task 12 的 `state`、`h`、`renderCards()` 占位、`openApp`/`seedSample`。
- Produces（DOM 契約，Task 14–16 與 e2e 依賴）：每則 `<article class="item" data-id="…">`，內含：`.meta`（`.id`、`.cat`、`.used`／`.used.never`）；改標區（有改標：`.car`＋每版 `.slide`＞`p.title`＋`.vinfo`；無改標：`p.title.empty` 文字「（尚未改標）」）；`.note`（無小編文：`.note.empty`「（尚無小編文）」）；`.acts`：`[data-act=ctitle]`（複製標題，無改標時 `disabled`）、`[data-act=cnote]`（複製留言）、`[data-act=mark]`（標記已使用）、`[data-act=edit]`（編輯）、`.src[title=原始標題全文]`（內含 `.tag`「原始」、`.ot` 單行截斷原始標題、`a.link`「原文 ↗」）。`a.link` 只在 `isHttpUrl(url)` 時有 `href`（帶 `target="_blank"`、`rel="noopener noreferrer"`）。
- Produces（函式）：`render()`（依 `state.status` 與目前篩選重畫 `#chips` 與 `#list`）、`visibleItems(): Item[]`、`byId(id): Item | undefined`、`posOf(item): number`、`fmt(ms): string`（`yyyy/MM/dd HH:mm`）、`ago(ms): string`（`今天` 或 `N 天前`，24 小時為一天）。

- [ ] **Step 1: 寫失敗的測試 `test/e2e/list.e2e.js`**（`seedSample`＋`page.clock.setFixedTime(NOW)`）：
  - 範例卡片 4032757：`.id` 為 `#4032757`、`.cat` 為「生活」、`.used` 文字符合 `上次使用 {fmt}（9 天前）· 共 3 次`（`fmt` 用 `Asia/Taipei` 計算，測試以 `page.emulateTimezone`／context `timezoneId: 'Asia/Taipei'` 固定）；從未使用者顯示「從未使用 · 使用 0 次」；第一版標題 `.title` 的 `textContent` 含 `\n` 且 computed `white-space` 為 `pre-wrap`；`.note` computed `-webkit-line-clamp` 為 `3`。
  - 原始標題列：`.src .tag` 為「原始」、`.ot` 文字為原始標題、`.src` 的 `title` 屬性為全文、`a.link` 的 `href` 等於原文連結、`rel` 含 `noopener` 與 `noreferrer`、`target` 為 `_blank`；以 `gas.seedRows` 塞一則網址為 `javascript:alert(1)` 的新聞 → 該則 `a.link` 沒有 `href`。
  - 4028301：標題區文字「（尚未改標）」、`[data-act=ctitle]` 為 `disabled`。
  - 搜尋（不分大小寫、`.includes`）：用編號片段、原始標題片段、非第一版的改標片段、小編文片段各找得到對應那一則；輸入 `(`、`[`、`.*` 不丟例外、顯示「沒有符合的新聞…」。
  - 排序（以 `.item` 的 `data-id` 順序比對）：`oldest` → `[4031880, 4028301, 4029554, 4032757, 4030112]`；`recent` → `[4030112, 4032757, 4029554, 4031880, 4028301]`；`count` → `[4032757, 4029554, 4030112, 4031880, 4028301]`；`created` → `[4028301, 4031880, 4030112, 4032757, 4029554]`；預設為 `oldest`。
  - 分類篩選：`#chips` 依序為 全部（5）、社會（2）、生活（2）、健康（1）、政治（0）、國際（0）、娛樂（0），各帶筆數；點「社會」後只剩兩則且 `aria-pressed="true"`；用 `gas.seedRows` 加一則分類為「財經」（不在分類分頁）的新聞 → `#chips` 末尾多出「財經 1」且可篩選。
  - 安全：標題 `<img src=x onerror="window.__pwned=1">`、小編文 `</script><b>x</b>` 的新聞 → 頁面上 `img` 與 `b` 元素為 0 個、`window.__pwned` 為 `undefined`、畫面顯示原文字。
  - 版面（Review Focus 5）：標題、原始標題、小編文都放 300 字元無空白字串，在 400 px 寬的手機視窗下 `document.documentElement.scrollWidth <= window.innerWidth`。
  - `afterEach` 三項斷言。
- [ ] **Step 2: 執行 `npm run test:e2e`，預期失敗。**
- [ ] **Step 3: 實作 `render()` 與卡片建構**（全部用 `h()`／`textContent`；版面與樣式以預覽為準，`renderCards` 占位替換為實作）。搜尋、排序、篩選邏輯沿用預覽 `visible()`（`hot-news-preview.html:210-226`）。
- [ ] **Step 4: 執行 `npm run test:e2e` 與 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(web): list rendering with search, sort and category filter`

---

### Task 14: 改標輪播

**Files:**
- Modify: `web/app.js`、`web/app.css`
- Create: `test/e2e/carousel.e2e.js`

**Interfaces:**
- Consumes: Task 13 的卡片 DOM 契約、`state.pos`、`posOf`、`byId`。
- Produces：`.carnav`（`[data-act=prev]`、`.dots`＞`.dot`（目前版本 `.on`）、`[data-act=next]`、`.cnt`「第 N / M 版」）只在版本數 > 1 時存在；`.car.multi` 只在版本數 > 1 時存在；`syncNav(itemEl, idx, n)`、`goTo(car, i)`、`stepOf(car)`、`idxOf(car)`；重畫列表後每則回到 `state.pos[id]` 那一版。

- [ ] **Step 1: 把 `docs/superpowers/previews/swipe-test.js` 的 23 項改寫成 `test/e2e/carousel.e2e.js`**：每項一個 `test()`，行為與判定條件**逐項保留**（桌面拖曳 6 項、滾輪／鍵盤／按鈕／觸控板／直向滾輪 8 項、拖曳不選取／無殘留 `dragging`／直向滾輪頁面照捲／單版新聞不可拖 4 項、手機真實觸控 3 項、桌面與手機版面 2 項）。改動只有：`fresh()` 換成 `openApp(site, { seed: true, viewport|mobile })`、不再使用 `file://` 與外殼包裝；選擇器與 `swipe-test.js` 相同（`.item[data-id="4032757"]`、`.car`、`.slide`、`.dot`、`.cnt`、`[data-act=next|prev]`、`.src .ot`、`a.link`、`[data-act=ctitle]`）。另加：
  - 重畫後停留：滑到第 2 版後在 `#q` 輸入文字再清空 → 該則仍在第 2 版（`.cnt` 為「第 2 / 3 版」）。
  - 每版下方顯示該版自己的使用資訊（第 3 版「此版本尚未使用」；第 1 版含「此版本上次使用」與「2 次」）。
  - `afterEach` 三項斷言。
- [ ] **Step 2: 執行 `npm run test:e2e`，預期輪播測試失敗。**
- [ ] **Step 3: 實作**：把預覽的輪播邏輯（`hot-news-preview.html:279-362` 的 scroll 同步、`pointerdown/move/up`、`wheel`、`keydown`）移植進 `app.js`，行為不變（拖曳門檻 `Math.min(60, 版寬 × 0.15)`、滾輪累積 30、120 ms 判定同一次橫滑、`prefers-reduced-motion` 時不做動畫）；DOM 用 `h()` 建立，狀態存 `state.pos`，事件委派在 `#list`。
- [ ] **Step 4: 執行 `npm run test:e2e`，預期 23 項加新增項全部通過。**
- [ ] **Step 5: Commit** `feat(web): swipeable headline carousel ported from approved preview`

---

### Task 15: 複製標題／留言與標記已使用

**Files:**
- Modify: `web/app.js`
- Create: `test/e2e/copy-mark.e2e.js`

**Interfaces:**
- Consumes: `renderCards`、`posOf`、`mutate`、`toast`、`buildComment`、`state.pos`。
- Produces：`copyText(text: string, okMsg: string): void`（先 `navigator.clipboard.writeText`，失敗退回 `.sr-copy` textarea＋`document.execCommand('copy')`，仍失敗 toast「複製失敗，請手動選取」）、`state.pendingMark: { id, idx } | null`、`state.busy: Set<string>`（請求進行中的 `id`）。

- [ ] **Step 1: 寫失敗的測試 `test/e2e/copy-mark.e2e.js`**（`seedSample`；需要跳過 3 秒計時的測試在 `goto` 之前呼叫 `page.clock.install({ time: NOW })`，其餘不裝假時鐘，以免干擾捲動動畫）：
  - 複製標題：4032757 在第 1 版時剪貼簿內容**等於**第一版標題原文（含 `\n`）；滑到第 2 版後複製 → 第二版；toast 為「已複製第 2 版標題」；單版新聞為「已複製標題」。
  - 複製留言：4032757 → `小編文 + '\n' + 'https://news.tvbs.com.tw/news/4032757'`（小編文含 `👇`，逐字比對，Review Focus 5）；小編文為空（4031880 先改成空）→ 只有網址；`N` 編號新聞（新增一則無數字網址）→ 結尾是原文連結而不是 `news/N1`。
  - 後備路徑：用 init script 移除 `navigator.clipboard` 並攔截 `document.execCommand`（記下被選取 textarea 的值）→ 複製標題仍得到正確文字；`execCommand` 回 `false` → toast「複製失敗，請手動選取」。
  - 標記已使用：第一下按鈕變「再按一次確認」（多版時「再按一次確認（第 N 版）」），**沒有**送出 `markUsed`；3 秒內第二下送出 `markUsed` 且 `args` 為 `{id:'4032757', ver:<目前版本的 ver>}`；成功後 `.used` 的時間與次數、該版 `.vinfo` 都更新，toast 為「已記錄第 N 版使用，此版本共 X 次」（無改標新聞：「已標記使用，共 X 次」，且 `args` 沒有 `ver`）；用 `clock.fastForward(3000)` 後確認狀態自動還原；確認中滑到別的版本 → 確認取消。
  - **連點（Review Focus 4）**：把回應延遲 500 ms，第二下之後連按 4 次 → `backend.calls` 中 `markUsed` 恰 1 筆；完成後次數只 +1。
  - 失敗：`failNext('drop')` → toast「連線中斷，結果不確定，已重新載入列表」且 `listItems` 被再次呼叫、畫面與試算表實際狀態一致；以另一個「裝置」先刪除該則（`backend.call('deleteItem', …)`）再標記 → `not_found` 訊息並重新載入。
  - `afterEach` 三項斷言。
- [ ] **Step 2: 執行 `npm run test:e2e`，預期失敗。**
- [ ] **Step 3: 實作**：卡片按鈕事件委派；`copyText`；標記的兩段式流程（3 秒計時用 `setTimeout`，捲動同步時比對 `pendingMark.idx`）；請求中以 `state.busy` 擋住重入並讓該則按鈕 `disabled`；寫入一律走 `mutate`，成功後以回傳的 `item` 取代 `state.items` 中該則並 `render()`。
- [ ] **Step 4: 執行 `npm run test:e2e` 與 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(web): copy actions and two-step mark-used with duplicate-submit guard`

---

### Task 16: 新增、編輯、刪除與自動帶入標題

**Files:**
- Modify: `web/app.js`、`web/app.css`
- Create: `test/e2e/dialog.e2e.js`

**Interfaces:**
- Consumes: `mutate`、`callApi`、`h`、`extractId`、`normalizeUrl`、`normalizeText`、`normalizeLine`、`LIMITS`、`state.items`/`state.cats`。
- Produces：`openDialog(item?: Item)`；`state.draft: { ver: number|null, t: string }[]`、`state.removed: number[]`、`state.saving: boolean`；送出時由草稿算出 `updateItem` 的 `edit`／`add`／`remove`（既有版本被清空 → 放進 `remove`；既有版本文字有變 → `edit`；新草稿非空白 → `add`；只有空白者略過）。`dialog` 的 `cancel`（Esc）事件在 `state.saving` 為 true 時被攔下。

- [ ] **Step 1: 寫失敗的測試 `test/e2e/dialog.e2e.js`**（`seedSample`；同上，需要跳過 4 秒／8 秒計時的測試在 `goto` 之前 `page.clock.install({ time: NOW })`）：
  - 新增（成功）：貼上新網址 `https://news.tvbs.com.tw/local/4040001`：`#idHint` 顯示「編號 4040001」；`gas.urlFetch` 回 TVBS fixture → `#fOrig` 自動帶入、`#titleHint` 顯示「來自 og:title」；選分類、輸入兩個改標（第二個含換行）與小編文，儲存 → 對話框關閉、列表出現該則、`#chips` 計數 +1、試算表資料正確；儲存鈕在請求進行中 `disabled`。
  - 自動帶入的邊界：抓取期間使用者已自己輸入 `#fOrig` → 回來後不覆蓋；抓不到（`urlFetch` 回 403）→ `#titleHint`「抓不到標題，請手動輸入」且仍可儲存；抓取超過 8 秒（`failNext('hang')`＋`clock.fastForward(8000)`）→ 同樣提示，晚到的結果被丟棄。
  - 重複：貼上已存在網址（4032757）→ `#idHint` 顯示「編號 4032757 已存在」與「改為編輯這則」；按下後轉為該則的編輯對話框；直接送出時伺服器回 `duplicate`（先用另一裝置 `addItem` 再送出）→ 同樣轉為編輯。
  - 必填：缺網址／原始標題 → `#err` 顯示「網址和原始標題必填。」且不送出請求；網址不合規（`ftp://x.com/1`）→ 錯誤訊息。
  - **貼上髒文字（Review Focus 1）**：小編文貼 `'留言\r\n\r\n'`、改標貼 `'  \n'` 與 `'標題\r\n'` → 試算表只存 `'留言'` 與 `['標題']`；全空白的改標版本被略過。
  - 編輯：4032757 開啟後 `#fUrl`、`#fOrig` 為 `readonly`；改分類與小編文、修改第 1 版、新增第 4 版、移除第 3 版、儲存 → `updateItem` 的 `args` 為 `{id, cat, note, edit:[{ver:1,t}], add:[…], remove:[3]}`；既有版本的使用紀錄（v1 次數 2、v2 次數 1）保留；只剩一版時沒有「移除這版」鈕；取消則完全不送出請求且資料不變；清空既有版本 → 放進 `remove`。
  - **不誤刪別台裝置的新增**：開啟 4032757 編輯 → 用 `backend.call('updateItem', {id, cat, note, add:['別台新增']})` 模擬另一裝置加版本 → 本機儲存（不動版本）→ 試算表仍有「別台新增」。
  - 編輯時其版本被他處刪除（`stale`）→ 顯示訊息並重新載入列表。
  - 刪除：編輯對話框左下「刪除這則」第一下變紅底「再按一次刪除（無法復原）」、**不送請求**；4 秒後（`clock.fastForward(4000)`）還原；4 秒內第二下 → `deleteItem`，列表少一則並 toast「已刪除 #4032757」；試算表兩個分頁都清掉；列表上沒有任何刪除鈕；該則已被他處刪除 → `not_found` 訊息並重新載入。
  - 連點儲存（Review Focus 4）：儲存請求延遲 500 ms，連按 5 次 → `addItem` 恰 1 筆；進行中按 Esc 不會關閉對話框。
  - 長度：`maxlength` 屬性與 `LIMITS` 一致（`#fOrig` 500、改標 500、小編文 5000）。
  - `afterEach` 三項斷言。
- [ ] **Step 2: 執行 `npm run test:e2e`，預期失敗。**
- [ ] **Step 3: 實作對話框**：版面與流程沿用預覽（`hot-news-preview.html:393-461`），但資料送伺服器、DOM 全用 `h()`；網址欄在 `change` 與 `paste` 時算編號、查本機重複、呼叫 `fetchTitle`（以遞增請求序號丟棄晚到結果；使用者動過 `#fOrig` 就不覆蓋）；儲存前套用 `normalizeUrl`／`normalizeLine`／`normalizeText`；儲存中 `state.saving = true` 並停用按鈕。
- [ ] **Step 4: 執行 `npm run test:e2e` 與 `npm test`，預期全部通過。**
- [ ] **Step 5: Commit** `feat(web): add/edit/delete dialog with title autofill and race-safe edits`

---

### Task 17: Pages 部署流程、說明文件與最終驗證

**Files:**
- Create: `.github/workflows/pages.yml`、`README.md`、`docs/manual-checklist.md`、`test/workflow.test.js`
- Modify: `docs/apps-script-smoke-test.md`（頂端加一行說明：正式版程式在 `apps-script/`，這份只用於診斷「連不上」）

**Interfaces:**
- Consumes: `npm test`、`npm run test:e2e`、`npm run build`。
- Produces：`pages.yml` 兩個 job：`test`（所有 push 與對 `main` 的 PR；`actions/checkout@v7`、`actions/setup-node@v7`（node 22、npm 快取）、`npm ci`、`npx playwright install --with-deps chromium`、`npm test`、`npm run test:e2e`）與 `deploy`（`needs: test`，`if: github.event_name == 'push' && github.ref == 'refs/heads/main'`，`environment: github-pages`，權限 `contents: read`、`pages: write`、`id-token: write`，步驟 `checkout@v7`、`setup-node@v7`、`npm ci`、`npm run build`、`actions/configure-pages@v6`、`actions/upload-pages-artifact@v5`（`path: _site`）、`actions/deploy-pages@v5`）。頂層 `permissions: contents: read`、`concurrency` 群組 `pages`（不取消進行中的部署）。

- [ ] **Step 1: 寫失敗的測試 `test/workflow.test.js`**（對 `pages.yml` 做文字斷言）：含 `branches: [main]`；`deploy` 的條件含 `refs/heads/main` 與 `github.event_name == 'push'`；`deploy` 有 `needs: test`；沒有 `pull_request_target`；`pages: write` 與 `id-token: write` 只出現在 `deploy` job 區塊；用到的五個 action 版本分別是 `checkout@v7`、`setup-node@v7`、`configure-pages@v6`、`upload-pages-artifact@v5`、`deploy-pages@v5`（實作前先以 `git ls-remote --tags --refs https://github.com/actions/<name>` 重新確認這些主版本仍是最新）；`test` job 執行 `npm test` 與 `npm run test:e2e`。
- [ ] **Step 2: 執行 `npm test`，預期失敗。**
- [ ] **Step 3: 實作 `pages.yml`、`README.md`、`docs/manual-checklist.md`。** README（繁體中文）涵蓋：專案簡介與架構圖（規格 §6）；**一次性設定**（對照冒煙測試走過的路：建試算表 → 擴充功能 → Apps Script → 貼 `appsscript.json`、`Code.gs` 與另一個名為 `lib` 的檔案貼 `lib.js` → 指令碼屬性 `API_TOKEN`（附 Console 產生指令）與 `SHEET_ID` → 執行 `setup` 授權 → 部署為網頁應用程式（執行身分：我、存取：任何人）→ 複製 `/exec` 網址；GitHub Settings → Pages → Source 選「GitHub Actions」）；日常使用；**換密碼**（只改指令碼屬性，不用重新部署，再到網頁設定貼新密碼）；程式改版後要「管理部署作業 → 編輯 → 新版本」；開發指令；**發布規則**（功能分支 → PR → `main` 才算正式）；安全注意事項（規格 §8 摘要，含「記住密碼」風險與同網域共用儲存）。`manual-checklist.md` 抄自規格 §9「手動驗證清單」並補上：設定視窗的 GET 連線測試（`/exec` 跨網域 GET 回 `ok`，冒煙測試只測過 POST）、GitHub Pages 上的 CSP 無違規（開發者工具 Console 無 `Refused to…`）、`curl -I` 確認 Pages 快取時間、手機版面、貼到 IG／Threads 檢查換行、冷啟動延遲。
- [ ] **Step 4: 執行 `npm test && npm run test:e2e`，預期全部通過；`npm run build` 後 `ls _site` 恰為五個檔；`git status` 乾淨（`_site/` 已忽略）。**
- [ ] **Step 5: Commit 並推送到 `claude/funny-cori-751vpr`**：`ci: pages workflow, README and manual checklist`。**不要開 PR**；回報使用者：全部完成，說「發布」才開 PR 併入 `main`，合併後到 Settings → Pages 完成一次性設定並依 `docs/manual-checklist.md` 在實機驗收。
