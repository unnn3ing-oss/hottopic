# 登入方式改為 Cloudflare Worker 驗證 設計 Spec

日期：2026-10-13　狀態：**設計已由使用者核可（2026-10-13）**，本檔待使用者審閱。
前置規格：`2026-10-11-hot-news-library-design.md`（本檔取代其 §3「存取控制」的做法，其餘不變）。

## 1. 目的與成功標準

**目的**：把「瀏覽器貼 Apps Script 網址＋共用密碼」的登入方式，換成「通過 Cloudflare Worker 驗證」，做法與使用者的「LINE 推播套版產生器」一致（驗證用的值放在 Worker 的 Variables and Secrets）。

**成功標準**
1. 瀏覽器端不再持有 Apps Script 的 `/exec` 網址與 `API_TOKEN`。
2. 沒通過驗證的人打不到 API（Worker 擋在前面），Apps Script 仍保留 `API_TOKEN` 檢查當第二道鎖。
3. 登入一次後 12 小時內不必重輸密碼；到期後要重新輸入。
4. 使用者的操作與資料行為不變（新增、編輯、複製、標記已使用等）。
5. 全部可用自動測試驗證（Worker 以 Node 跑單元測試）。

## 2. 範圍

**包含**：新增 Cloudflare Worker（驗證閘道＋轉送）、前端連線層與設定視窗改版、CSP 調整、測試、README／手動清單更新。

**不包含**（YAGNI）：網頁本身的存取保護（網頁仍是不含資料的公開空殼）、Cloudflare Access、自訂網域、多使用者帳號、密碼雜湊儲存（Secret 本身已加密保存）、Apps Script 程式變更。

## 3. 已確認的決策

| 項目 | 決定 |
|---|---|
| 驗證方式 | 使用者在網頁輸入密碼 → Worker 與 Secret `APP_PASSWORD` 定時比對 → 通過後簽發憑證 |
| 憑證 | `base64url(payload).base64url(HMAC-SHA256(SESSION_SECRET, payload))`；payload 只含到期時間；**有效 12 小時**；無狀態，不用資料庫 |
| 架構 | 網頁維持在 GitHub Pages；瀏覽器 → Worker → Apps Script；Worker 保管 `API_TOKEN` 與 `/exec` 網址 |
| 憑證傳遞 | 放在 POST 內文（不用標頭、不用 cookie）。理由：網頁在 `github.io`、Worker 在 `workers.dev` 屬跨站，cookie 會被第三方 cookie 限制擋掉；內文方式也讓請求維持「簡單請求」，不觸發預檢 |
| 「記住」的語意 | 勾選後記住的是**憑證**（最多 12 小時），不是密碼；密碼不存在瀏覽器 |
| 後端（Apps Script） | **程式不變**；仍檢查 `API_TOKEN`；只是 `API_TOKEN` 現在只有 Worker 知道 |
| 網域 | 不需要自有網域，使用 `*.workers.dev` |

## 4. 架構與資料流

```
瀏覽器（https://unnn3ing-oss.github.io/hottopic/）
   │ ① POST {Worker}/login   {password}
   │ ← {ok:true,data:{session,exp}}
   │ ② POST {Worker}/api     {session, action, args}
   ▼
Cloudflare Worker ── 驗憑證 ──▶ Apps Script /exec  {token:API_TOKEN, action, args}
        ▲ Secrets：APP_PASSWORD、SESSION_SECRET、API_TOKEN、APPS_SCRIPT_URL
        ▲ Variable：ALLOWED_ORIGIN = https://unnn3ing-oss.github.io
```

## 5. Worker（新檔 `worker/index.js`）

單一檔案、ES module（`export default { fetch }`），可直接貼進 Cloudflare 儀表板；不引用任何套件。

### 5.1 端點

| 端點 | 請求（`Content-Type: text/plain;charset=utf-8` 的 JSON） | 行為 | 回應（HTTP 一律 200，與現有協定一致） |
|---|---|---|---|
| `POST /login` | `{password}` | 以 HMAC 雙方比對（定時）檢查 `APP_PASSWORD`；通過則簽發憑證 | 成功 `{ok:true,data:{session,exp,ttl}}`（`ttl` 固定 43200 秒；前端以「本機時鐘＋ttl」判斷到期，不拿 `exp` 與本機時鐘比，避免本機時鐘不準時一登入就過期）；失敗 `{ok:false,code:'unauthorized'}` |
| `POST /api` | `{session, action, args}` | 驗憑證（簽章正確且未過期）→ 以 `{token:API_TOKEN, action, args}` POST 到 `APPS_SCRIPT_URL`（跟隨轉址）→ 原樣回傳 Apps Script 的 JSON | 同現有協定 `{ok:true,data}`／`{ok:false,code,…}` |
| `OPTIONS *` | — | 回 CORS 預檢所需標頭 | 204 |
| 其他路徑／方法 | — | — | `{ok:false,code:'bad_request'}` |

### 5.2 CORS

- 只回 `Access-Control-Allow-Origin: <ALLOWED_ORIGIN>`（不使用 `*`）。請求的 `Origin` 不符時，不附 CORS 標頭（瀏覽器端即讀不到回應）。
- 另回 `Vary: Origin`、`Access-Control-Allow-Methods: POST, OPTIONS`、`Access-Control-Allow-Headers: Content-Type`。

### 5.3 憑證細節

- `payload = {"exp": <到期的 Unix 秒>}`，`exp = now + 12 * 3600`。
- 簽章用 Web Crypto `HMAC-SHA256`，金鑰為 `SESSION_SECRET`；驗證用 `crypto.subtle.verify`（定時比較）。
- 驗證失敗、格式不對、已過期，一律回 `unauthorized`。
- 更換 `SESSION_SECRET` 會使所有已發出的憑證立即失效（用於懷疑外流時）。
- `SESSION_SECRET`、`API_TOKEN` 要求至少 32 字元；`APP_PASSWORD` 因為是給人輸入的，要求至少 8 字元（2026-10-13 依使用者決定放寬）；缺少或過短時，`/login`、`/api` 一律回 `server_error`（訊息：Worker 尚未設定完成），不降級放行。

### 5.4 錯誤對應

| 情況 | 回應 code | 說明 |
|---|---|---|
| 密碼錯、憑證過期／竄改／缺少 | `unauthorized` | 前端清除憑證並回登入畫面 |
| Apps Script 回 `unauthorized` | `server_error`＋訊息「Worker 與後端的密碼設定不一致」 | 避免被誤認成使用者登入過期 |
| Apps Script 回非 JSON、連不到、逾時 | `server_error`（訊息分別註明） | 前端既有的 `unreachable`／`timeout` 仍由瀏覽器端判斷 |
| 登入太頻繁 | `rate_limited` | 見 §5.5 |
| Secret 未設定或過短 | `server_error` | 見 §5.3 |
| 請求不是合法 JSON、缺欄位、body 過大（上限 64 KB） | `bad_request` | — |
| 其餘 Apps Script 回應 | 原樣轉回 | 包含 `existing` 等欄位 |

### 5.5 暴力猜密碼防護

- 目標：限制 `/login` 的失敗頻率。**實作前先查證**：Workers 的 Rate Limiting 綁定在使用者的方案上是否可用。
  - 可用 → 以請求來源 IP 為鍵，限制每分鐘登入次數，超過回 `rate_limited`。
  - 不可用 → 退而求其次：登入失敗時固定延遲約 1 秒再回應，並在 README 寫明殘餘風險；`APP_PASSWORD` 經使用者決定放寬為至少 8 字元，因此線上猜測不再「實務上不可行」，殘餘風險在 README 明示，並建議啟用限流。
- 不記錄密碼、憑證或 Secret 到日誌。

## 6. 前端

| 檔案 | 變動 |
|---|---|
| `web/api.js` | `API_URL_PATTERN` 改為 `^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$`（不含路徑，由程式加上 `/login`、`/api`）；新增 `login(url, password)`，成功後把 `{session, exp}` 存在記憶體；`remember` 勾選時另存 localStorage；`call` 帶 `session`；`unauthorized` 或本機判斷已過期 → 清除憑證 |
| `web/app.js`、`web/index.html` | 設定視窗改為「Worker 網址」＋「密碼」，按鈕「登入」；「記住」文案改為「在這台裝置記住登入（最多 12 小時，不存密碼）」；載入時若沒有可用憑證就開啟登入視窗 |
| CSP（`index.html`） | `connect-src` 由 `https://script.google.com https://script.googleusercontent.com` 改為 `https://*.workers.dev` |
| `scripts/build-site.js`、`test/site.test.js` | 若有檢查舊 CSP 字串或元素 ID，同步調整 |

- 憑證儲存鍵沿用 `hotnews.v1.*` 命名；舊的 `hotnews.v1.token`（密碼）首次載入時一併清除，避免舊密碼殘留在瀏覽器。
- 本機以 `exp` 判斷是否過期（提前 30 秒視為過期），以減少一趟無效請求；伺服器端仍是最終判斷。

## 7. Apps Script

- `Code.gs`、`lib.js` **不修改**。
- `API_TOKEN` 的角色：Worker → Apps Script 的內部密碼，使用者不再需要記或貼。
- `/exec` 網址仍為「任何人」可存取，但沒有 `API_TOKEN` 打不進去（第二道鎖）。

## 8. 測試

| 層級 | 內容 |
|---|---|
| Worker 單元測試（Node，新檔 `test/worker.test.js`） | 登入成功／密碼錯誤／缺欄位；憑證有效、過期、竄改、缺少；CORS（符合與不符的 Origin、OPTIONS）；轉送內容含 `API_TOKEN` 且不含 `session`；Apps Script 回 `unauthorized` 的轉譯；回非 JSON；Secret 未設定或過短；body 過大；回應中不出現任何 Secret |
| 前端單元測試（`test/api.test.js` 更新） | `login()`、憑證過期處理、記住與不記住、舊密碼鍵清除、網址格式檢查 |
| E2E（`test/e2e/*`、`test/helpers/fake-api.js` 更新） | 假 API 改為模擬 Worker 的 `/login`、`/api`；登入流程、過期後被要求重新登入、其餘既有流程不變 |
| 靜態檢查 | CSP 更新後的站台測試；機密掃描（`worker/` 內不得出現真實值） |

## 9. 部署與上線順序（由使用者在 Cloudflare 操作）

1. Cloudflare → Workers → 建立 Worker，貼入 `worker/index.js`。
2. Settings → Variables and Secrets 設定：Secrets `APP_PASSWORD`、`SESSION_SECRET`、`API_TOKEN`（與 Apps Script 指令碼屬性中的相同）、`APPS_SCRIPT_URL`；Variable `ALLOWED_ORIGIN`。
3. 部署，取得 `https://<名稱>.<帳號>.workers.dev`。
4. 用 README 提供的 `curl` 指令驗證 `/login`、`/api` 的 `ping`。
5. **驗證通過後**才把前端 PR 併入 `main`（併入後網站即換成新登入方式）。
6. 之後換密碼：改 Worker 的 `APP_PASSWORD`；要讓所有登入立即失效：改 `SESSION_SECRET`。

## 10. 風險與限制

| 項目 | 說明 |
|---|---|
| 憑證外流 | 12 小時內有效；放在記憶體或勾「記住」的 localStorage，同網域 JS 可讀。應對：預設不記住；嚴格 CSP；必要時更換 `SESSION_SECRET` |
| 網頁仍公開 | 靜態檔案任何人看得到，但沒有資料；若要連網頁也保護，需改為方案 B（Worker 同時提供網頁），本次不做 |
| 單點依賴 | 多一個 Cloudflare Worker；其免費額度與狀態影響服務。目前流量遠低於額度 |
| 暴力猜密碼 | 見 §5.5；殘餘風險依 Rate Limiting 綁定是否可用而定 |
| 延遲 | 多一跳 Worker，預期增加數十毫秒，相較 Apps Script 本身的延遲可忽略 |
| 轉址行為 | Apps Script 的 `/exec` 回應會 302 轉址；Worker 端 `fetch` 需跟隨轉址，實作時以測試或實測確認 |
