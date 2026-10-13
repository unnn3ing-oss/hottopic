# 登入改為 Cloudflare Worker 驗證 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「貼 Apps Script 網址＋共用密碼」換成「Worker 網址＋登入密碼」，由 Cloudflare Worker 驗證並代為呼叫 Apps Script。

**Architecture:** 新增單檔 Worker（`/login` 簽發 12 小時 HMAC 憑證、`/api` 驗憑證後加上 `API_TOKEN` 轉送 Apps Script）；前端連線層 `api.js` 改為對 Worker 登入並帶憑證；Apps Script 程式不動。

**Tech Stack:** Cloudflare Workers（ES module、Web Crypto、無套件）、現有純 JS 前端（ES2019 以內）、`node --test`、Playwright 1.56.1。

**Spec:** `docs/superpowers/specs/2026-10-13-cloudflare-worker-auth-design.md`

## Global Constraints

- 開發在分支 `claude/funny-cori-751vpr`；commit 訊息用繁體中文、`type(scope): 摘要` 格式，結尾附本 repo 近期 commit 同樣的兩行 `Co-Authored-By` 與 `Claude-Session`。
- 憑證有效期 **12 小時（43200 秒）**；前端本機提前 **30 秒**視為過期。
- Worker：單一檔案 `worker/index.js`（ES module，`export default { fetch }`），不引用任何套件；`worker/package.json` 內容 `{"type":"module"}` 讓 Node 以 ESM 載入它。
- Secrets 長度：`APP_PASSWORD`、`SESSION_SECRET`、`API_TOKEN` 至少 32 字元；缺少或過短一律回 `server_error`，不放行。
- 協定：請求 `Content-Type: text/plain;charset=utf-8` 的 JSON；Worker 回應 HTTP 一律 200（`OPTIONS` 為 204）；成功 `{ok:true,data}`、失敗 `{ok:false,code,error}`。body 上限 **64 KB**。
- CORS：只回 `ALLOWED_ORIGIN` 單一值，不用 `*`，並帶 `Vary: Origin`。
- 前端：`api.js` 語法 ES2019 以內；CSP 禁止行內 script／style；DOM 一律 `textContent`；`connect-src` 只留 `https://*.workers.dev`。
- repo 內不得出現機密：測試用假值不可命中 `scripts/scan-secrets.js` 的規則（48 位十六進位、真實 `/macros/s/AKfycb…` 網址）；假 Secret 用 `'p'.repeat(40)` 這類非十六進位字元。
- 每個 Task 結束時 `npm test` 必須全綠；Task 4 結束時 `npm run test:e2e` 也要全綠。

## Review Focus

1. `/api` 的 `session` 缺少、不是字串、含多餘點號時 → `unauthorized`，不丟例外（Task 2）。
2. 上游（Apps Script）回 HTML、非 JSON、缺 `ok` 欄位、`fetch` 丟例外或逾時 → `server_error`，不洩漏上游內容（Task 2）。
3. 密碼含非 ASCII、表情符號或 10000 字元長 → 比對不丟例外，回 `unauthorized`（Task 1）。
4. `Origin` 不在白名單：不附 `Access-Control-Allow-Origin`，OPTIONS 也一樣；且任何回應都不含 Secret 值（Task 1、2）。
5. 憑證 `exp` 恰等於現在視為過期；瀏覽器「記住」存的憑證載入時已過期 → 視同未登入並清掉；舊版殘留的 `hotnews.v1.token` 與 `script.google.com` 網址被忽略／清除（Task 3）。

---

### Task 1: Worker 骨架、憑證與 `/login`

**Files:**
- Create: `worker/index.js`、`worker/package.json`
- Test: `test/worker.test.js`

**Interfaces:**
- Produces（`worker/index.js` 的具名匯出）：
  - `export const SESSION_TTL_SEC = 43200`
  - `export async function signSession(secret: string, exp: number): Promise<string>` → `base64url(JSON {exp}) + '.' + base64url(HMAC-SHA256)`
  - `export async function verifySession(secret: string, session: unknown, nowSec: number): Promise<boolean>`（非字串、格式錯、簽章錯、`exp <= nowSec` 皆 false）
  - `export default { fetch(request: Request, env: Env): Promise<Response> }`
- `Env`：`APP_PASSWORD`、`SESSION_SECRET`、`API_TOKEN`、`APPS_SCRIPT_URL`、`ALLOWED_ORIGIN`；選用 `FAIL_DELAY_MS`（字串，預設 `'1000'`）與 `LOGIN_LIMITER`（Rate Limiting 綁定，有 `limit({key}) → Promise<{success:boolean}>`）。
- Task 2 在同一支 `fetch` 內新增 `/api` 分支，並重用本 Task 的路由、CORS、錯誤回應與設定檢查輔助函式。

- [ ] **Step 1: 寫失敗的測試 `test/worker.test.js`**（頂部以 `await import('../worker/index.js')` 載入；`ENV` 假值：三個 Secret 皆 `'p'/'s'/'k'.repeat(40)`、`APPS_SCRIPT_URL: 'https://upstream.test/exec'`、`ALLOWED_ORIGIN: 'https://unnn3ing-oss.github.io'`、`FAIL_DELAY_MS: '0'`；輔助 `post(path, body, {origin, env})` 以 `new Request('https://w.test'+path, …)` 呼叫 `worker.fetch`）。測試名稱與斷言：
  - `login 成功：回 session 與約 12 小時後的 exp`：`ok===true`；`exp - floor(Date.now()/1000)` 介於 43199 與 43201；`verifySession(ENV.SESSION_SECRET, data.session, now)` 為 true。
  - `login 密碼錯誤 → unauthorized；缺欄位／非字串／非 JSON／非物件 → bad_request`，HTTP 狀態皆 200。
  - `login 非 ASCII 與 10000 字元密碼不丟例外`：`'密碼🔒'` 與 `'x'.repeat(10000)` 皆回 `{ok:false,code:'unauthorized'}`。
  - `verifySession`：有效 true；`exp == nowSec` false；竄改 payload、竄改簽章、沒有 `.`、多個 `.`、`undefined`、數字皆 false。
  - `CORS`：允許的 Origin → `access-control-allow-origin` 等於該值且 `vary` 含 `Origin`；其他 Origin 與無 Origin → 沒有該標頭；`OPTIONS /login` → 204，帶 `access-control-allow-methods: POST, OPTIONS` 與 `access-control-allow-headers: Content-Type`（Origin 不符則無 allow-origin）。
  - `Secret 缺少或過短 → server_error`：對 `APP_PASSWORD`、`SESSION_SECRET` 各測缺少與 31 字元，`/login` 回 `{ok:false,code:'server_error'}`，且絕不回 `ok:true`。
  - `body 超過 64KB、未知路徑、GET → bad_request`。
  - `失敗登入延遲 FAIL_DELAY_MS，成功不延遲`：`FAIL_DELAY_MS:'40'` 時失敗耗時 ≥ 35ms；成功 < 35ms。
  - `LOGIN_LIMITER 回 success:false → rate_limited`，且 `limit` 收到的 key 為請求標頭 `cf-connecting-ip`（缺少時用 `'unknown'`）；`success:true` 時照常登入。
  - `任何 /login 回應文字都不含三個 Secret 的值`。

- [ ] **Step 2: 執行確認失敗** — `node --test test/worker.test.js`，預期失敗（找不到 `worker/index.js`）。

- [ ] **Step 3: 實作 `worker/index.js` 與 `worker/package.json`**。以 `crypto.subtle` 的 HMAC-SHA256 簽章，`verify` 用 `crypto.subtle.verify`（定時比較）；密碼比對：用 `SESSION_SECRET` 之外的固定隨機鹽對雙方各做一次 HMAC 後以 `crypto.subtle.verify` 比較，確保長度不同也定時；base64url 自行以 `btoa`／`atob` 轉換；錯誤訊息文案：`unauthorized`「密碼不正確或登入已過期。」、`rate_limited`「登入太頻繁，請稍後再試。」、`bad_request`「要求格式不正確。」、`server_error`（未設定）「Worker 尚未設定完成。」。成功登入才不延遲；失敗時 `await` 一個 `FAIL_DELAY_MS` 的 `setTimeout`。

- [ ] **Step 4: 執行確認通過** — `node --test test/worker.test.js` 全綠；再跑 `npm test` 確認機密掃描與其餘測試仍綠。

- [ ] **Step 5: Commit** — `git add worker test/worker.test.js && git commit -m "feat(worker): 新增登入端點與 12 小時簽章憑證"`

---

### Task 2: Worker `/api` 轉送

**Files:**
- Modify: `worker/index.js`
- Test: `test/worker.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `signSession`、`verifySession`、`SESSION_TTL_SEC`、路由／CORS／錯誤回應輔助函式與 `Env`。
- Produces: `POST /api`，請求 `{session, action, args?}`；回應為上游 JSON 文字原樣（`ok:false` 也原樣，含 `existing`）。

- [ ] **Step 1: 追加失敗的測試**（測試中暫時替換 `globalThis.fetch` 為記錄請求的假上游，`t.after` 還原；憑證用 `signSession(ENV.SESSION_SECRET, nowSec + 600)` 產生）：
  - `轉送內容：上游收到 {token:API_TOKEN, action, args}`：方法 POST、`Content-Type: text/plain;charset=utf-8`、`redirect:'follow'`、body 不含 `session`；用戶端自帶的 `token` 欄位被忽略（上游收到的仍是 `ENV.API_TOKEN`）；回應文字與上游回的文字完全相同。
  - `session 缺少／非字串／過期／竄改／帶多餘點號 → unauthorized，且完全不呼叫上游`。
  - `action 缺少或非字串、args 非物件 → bad_request`；`args` 省略時上游收到 `{}`。
  - `上游 ok:false 原樣轉回`：以 `{ok:false,code:'duplicate',existing:{id:'1'}}` 驗證欄位不被吃掉。
  - `上游回 unauthorized → 轉成 server_error，error 為「Worker 與後端的密碼設定不一致。」`。
  - `上游回 HTML、空字串、JSON 但沒有布林 ok、fetch 丟 TypeError、丟 TimeoutError → server_error`，各有不同的 `error` 文案（「後端沒有回傳正確的資料。」「連不上後端。」「後端沒有在時間內回應。」），回應中不含上游內容。
  - `API_TOKEN 或 APPS_SCRIPT_URL 缺少（含 API_TOKEN 過短）→ server_error`，即使憑證有效也不呼叫上游。
  - `/api 回應文字不含任何 Secret 值`；Origin 不符時無 allow-origin 標頭。

- [ ] **Step 2: 執行確認失敗** — `node --test test/worker.test.js`，預期新測試失敗。

- [ ] **Step 3: 實作 `/api` 分支**。上游呼叫用 `fetch(env.APPS_SCRIPT_URL, {method:'POST', headers, body, redirect:'follow', signal: AbortSignal.timeout(25000)})`；解析上游文字失敗或缺 `ok` 布林一律 `server_error`；只有「解析成功且 `ok===false` 且 `code==='unauthorized'`」才轉譯，其餘原文字回傳。

- [ ] **Step 4: 執行確認通過** — `node --test test/worker.test.js` 與 `npm test` 全綠。

- [ ] **Step 5: Commit** — `git commit -am "feat(worker): 新增 /api 驗憑證並轉送 Apps Script"`

---

### Task 3: 前端連線層 `web/api.js`

**Files:**
- Modify: `web/api.js`
- Test: `test/api.test.js`（改寫）

**Interfaces:**
- Produces（Task 4 的 `app.js` 使用）：
  - `API_URL_PATTERN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/`
  - `createClient(deps)`：`deps` 同現有（`fetch, storage, AbortController, setTimeout, clearTimeout`）再加選用 `now?: () => number`（毫秒，預設 `Date.now`）。
  - `client.getConfig(): {url: string|null, session: string|null, remember: boolean}`（`session` 已過期或缺少為 `null`；儲存的網址不符 `API_URL_PATTERN` 視為 `null`）。
  - `client.login(url: string, password: string, remember: boolean): Promise<void>` — 對 `url + '/login'` POST `{password}`；成功才寫入網址與憑證（記憶體；`remember` 為真另寫 localStorage）。
  - `client.call(action: string, args?: object): Promise<any>` — 對 `url + '/api'` POST `{session, action, args}`；沒設定或本機判斷已過期 → 拒絕 `no_config`／`unauthorized`（不送請求）；收到 `unauthorized` 清除憑證。
  - `client.logout(): void`（只清憑證）、`client.clearConfig(): void`（清網址、憑證、remember、舊鍵）。
  - 儲存鍵：`hotnews.v1.url`、`hotnews.v1.session`（JSON `{s, exp}`）、`hotnews.v1.remember`；建立 client 時就移除舊鍵 `hotnews.v1.token`。
  - `ApiError` 與錯誤碼沿用，新增 `rate_limited` 訊息「登入太頻繁，請稍後再試。」；`unauthorized` 訊息改「密碼不正確或登入已過期。」；網址格式錯誤訊息「網址要是 https://〈名稱〉.workers.dev 的格式。」。

- [ ] **Step 1: 改寫 `test/api.test.js`**（沿用既有 `memStorage`／`setup`／`json` 輔助，`setup` 可注入 `now`；`URL_OK = 'https://hotnews.test-account.workers.dev'`）。測試名稱與斷言：
  - `login：POST {url}/login，body 只有 {password}，標頭只有 text/plain，credentials omit、no-referrer、follow`；成功後 `getConfig()` 為 `{url, session, remember:false}`。
  - `call：POST {url}/api，body 為 {session, action, args}，不含 token／password`。
  - `login 失敗（unauthorized／rate_limited／server_error）不寫入任何儲存，且不覆蓋先前的設定`。
  - `記住：remember=true 才寫 session 與 remember 鍵；兩種情況下儲存內容都不含密碼字串`；`remember=false` 時移除先前殘留。
  - `本機過期：exp 距現在不足 30 秒 → call 不送請求、拒絕 unauthorized 並清掉憑證`；`exp` 恰等於 `now/1000 + 30` 視為過期。
  - `載入時儲存的憑證已過期 → getConfig().session 為 null 且該鍵被移除`。
  - `舊版殘留：建立 client 時移除 hotnews.v1.token；儲存的 script.google.com 網址 → getConfig().url 為 null`。
  - `unauthorized 回應清除記憶體與儲存的憑證，但保留網址`。
  - `網址格式：去前後空白與結尾斜線；https://example.com、帶路徑、http:// 皆 bad_request 且不送請求`。
  - 保留既有：`ok:false 轉成 ApiError（duplicate 帶 existing）`、`讀不到回應 → unreachable/unknown 且不重試`、`逾時 20000/30000ms`、`storage 丟例外仍可運作`。

- [ ] **Step 2: 執行確認失敗** — `node --test test/api.test.js`，預期失敗。

- [ ] **Step 3: 改寫 `web/api.js`**：`request(url, path, bodyObj, ms)` 取代原 `request`；逾時規則不變（`fetchTitle` 20000、其餘 30000；`login` 用 30000）；移除 `checkConnection` 與 `saveConfig`。

- [ ] **Step 4: 執行確認通過** — `node --test test/api.test.js`。（此時 `npm test` 的站台測試與 e2e 尚未跟上，e2e 留到 Task 4。）

- [ ] **Step 5: Commit** — `git add web/api.js test/api.test.js && git commit -m "feat(web): 連線層改為對 Worker 登入並帶 12 小時憑證"`

---

### Task 4: 介面接線、CSP、假 Worker 與 e2e

**Files:**
- Modify: `web/app.js`、`web/index.html`、`test/site.test.js`、`test/helpers/fake-api.js`、`test/e2e/smoke.e2e.js`

**Interfaces:**
- Consumes: Task 3 的 `getConfig()`、`login()`、`call()`、`logout()`、`clearConfig()`。
- Produces（供 e2e）：`fake-api.js` 匯出 `createFakeApi()`，其回傳物件改為 `{ st, handle(path, body): string, seed, PASSWORD, DAY, expireSessions() }`；`handle('/login'|'/api', bodyText)` 模擬 Worker（登入成功發 `{session, exp}`，`exp` 以真實時間 `Date.now()/1000 + 43200`；`/api` 驗 `st.sessions` 後交給既有 `actions`；移除 `token` 檢查）；`PASSWORD = 'p'.repeat(48)`（取代 `TOKEN`）。

- [ ] **Step 1: 先改測試**
  - `test/site.test.js`：`CSP` 常數的 `connect-src` 改為 `https://*.workers.dev`。
  - `test/e2e/smoke.e2e.js`：`API_URL` 改 `'https://hotnews.test-account.workers.dev'`；`page.route(API_URL + '/**')` 以 `api.handle(new URL(r.url()).pathname, r.postData())` 回應（OPTIONS 不應出現，既有「只有簡單 POST」斷言保留）；`connect()` 改填 `#sUrl`／`#sToken`（ID 不變）。新增或改寫：
    - `首次開啟跳出設定；登入後載入列表；localStorage 不含密碼與 session（未勾記住）`；重新整理後再次跳出設定、網址預填、密碼欄空白。
    - `密碼錯誤顯示「密碼不正確」；網址格式錯誤不送請求`。
    - `勾記住：重新整理後不用輸入密碼直接載入列表；localStorage 沒有密碼字串；舊鍵 hotnews.v1.token（以 addInitScript 預先寫入）被清掉`。
    - `憑證在伺服器端失效（api.expireSessions()）→ 下一次操作跳出設定並顯示「登入已過期」`。
    - 其餘既有流程的 `connect` 呼叫維持，預期不需其他改動。

- [ ] **Step 2: 執行確認失敗** — `npm test` 的 `site.test.js` 與 `npm run test:e2e` 預期失敗。

- [ ] **Step 3: 實作**
  - `web/index.html`：CSP 的 `connect-src` 改 `https://*.workers.dev`（與測試常數逐字相同）；設定視窗標籤「Worker 網址」、placeholder `https://名稱.帳號.workers.dev`、「密碼」；「記住」文案「在這台裝置記住登入（最多 12 小時，不存密碼）」；送出鈕「登入」；`.foot` 與設定視窗內提到「Apps Script 網址」的文字改為 Worker。
  - `web/app.js`：設定送出改 `api.login(url, token, remember)` 後關閉視窗並 `loadItems()`；錯誤分支：`unauthorized`「密碼不正確。」、`bad_request` 與 `rate_limited` 用 `err.message`、`server_error` 用 `err.message`（含「請確認 Worker 的 Secrets 都已設定」提示）、其餘列出檢查清單 `STEPS`（網址完整為 `https://….workers.dev`；Worker 已部署且 `ALLOWED_ORIGIN` 為 `https://unnn3ing-oss.github.io`；網路正常）；`init()` 與 `loadItems` 中以 `cfg.session` 取代 `cfg.token` 判斷是否已登入；`unauthorized` 開設定時的提示改「登入已過期或密碼已更換，請重新登入。」；尚未連線的空狀態文字改「請先到「設定」輸入 Worker 網址與密碼。」。
  - `test/helpers/fake-api.js`：依 Interfaces 改寫。

- [ ] **Step 4: 執行確認通過** — `npm test`、`npm run test:e2e` 全綠；`npm run build` 成功且輸出仍為五個檔。

- [ ] **Step 5: Commit** — `git add -A web test && git commit -m "feat(web): 登入畫面改為 Worker 網址與密碼，CSP 與測試同步更新"`

---

### Task 5: 文件與交接

**Files:**
- Modify: `README.md`、`docs/manual-checklist.md`、`docs/superpowers/specs/2026-10-11-hot-news-library-design.md`（§3「存取控制」列加一行註記：已由 2026-10-13 規格取代）

- [ ] **Step 1: 查證 Rate Limiting**：用 WebFetch 讀 Cloudflare 官方文件「Workers → Bindings → Rate Limiting」，確認免費方案可否使用，以及能否在儀表板設定（或只能用 `wrangler.toml`）。把結論寫進 README；若不能在儀表板設定，README 說明目前只靠「失敗延遲＋32 字元密碼」，並附 `wrangler` 的綁定範例供日後啟用。
- [ ] **Step 2: 改寫 README**：架構圖換成瀏覽器 → Worker → Apps Script；新增「Cloudflare Worker 部署」章節（建立 Worker、貼 `worker/index.js`、設定 4 個 Secrets 與 `ALLOWED_ORIGIN`、取得 `workers.dev` 網址）、`curl` 驗證指令（`/login` 取得 session，再以 `/api` 送 `ping`，預期 `{"ok":true,"data":{"pong":true}}`）、換密碼（改 `APP_PASSWORD`）與讓所有登入失效（改 `SESSION_SECRET`）；日常使用與安全注意事項改成新做法；說明 Apps Script 的 `API_TOKEN` 現在只貼進 Worker。
- [ ] **Step 3: 更新 `docs/manual-checklist.md`**：登入、12 小時到期、換密碼、記住登入、手機實機登入。
- [ ] **Step 4: 驗證** — `npm test`、`npm run test:e2e` 全綠。
- [ ] **Step 5: Commit** — `git add README.md docs && git commit -m "docs: Worker 部署、驗證與日常使用說明"`

---

### 交接（非程式）

- 推上 `claude/funny-cori-751vpr` 後，**只開 PR（「發布」），不要併入**。
- 請使用者依 README 在 Cloudflare 部署 Worker，並用 `curl` 驗證 `/login`、`/api ping` 都通。
- 使用者確認通過、說「推」之後才併入 `main`（併入即換成新登入方式）。
