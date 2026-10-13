# 熱門新聞庫

把挑好的熱門新聞集中管理：原文連結、多版改標（左右滑動）、小編文、上次使用時間與次數；一鍵複製標題與留言（先複製標題、再複製留言會自動記為已使用），貼網址自動帶入原始標題。

**目前進度**：前端（GitHub Pages 網頁）、後端（Google Apps Script API）與登入閘道（Cloudflare Worker）程式都已完成並通過自動測試；剩下在你的 Google 與 Cloudflare 帳號部署、設定密碼（見下方「後端部署」「Cloudflare Worker 部署」）。

## 架構

```
手機／電腦瀏覽器
   │ 開啟 https://unnn3ing-oss.github.io/hottopic/（GitHub Pages，靜態網頁）
   │ ① POST {Worker}/login  {password}            → 取得 12 小時憑證
   │ ② POST {Worker}/api    {session, action, args}（text/plain 的 JSON）
   ▼
Cloudflare Worker（worker/index.js）── 驗憑證，加上 API_TOKEN ──▶ Apps Script Web App（doPost）
                                                                   ── 再驗 API_TOKEN ─┬▶ 私人 Google 試算表
                                                                                      └▶ 文章網頁（只為了抓標題）
```

瀏覽器只認識 Worker：Apps Script 的 `/exec` 網址與 `API_TOKEN` 都只存在 Worker 的 Secrets 裡。

| 路徑 | 內容 |
|---|---|
| `web/` | `index.html`、`app.css`、`app.js`（畫面與互動）、`api.js`（連線層） |
| `apps-script/lib.js` | 網頁、Apps Script、測試共用的純函式（編號、網址檢查、文字整理、留言組合） |
| `apps-script/` 其餘 | `Code.gs`、`appsscript.json` 與標題抽取 |
| `worker/` | `index.js`（Cloudflare Worker：登入、憑證、轉送）、`package.json`（讓 Node 以 ES module 載入，只給測試用） |
| `scripts/` | `build-site.js`（輸出 `_site/`）、`scan-secrets.js`（機密掃描） |
| `test/` | 單元測試與 Playwright 冒煙測試（以記憶體假 API 取代真後端） |
| `docs/` | 規格、計畫、互動預覽、Apps Script 冒煙測試 |

規格：`docs/superpowers/specs/2026-10-11-hot-news-library-design.md`；實作計畫：`docs/superpowers/plans/2026-10-12-hot-news-library.md`。

## 一次性設定

### 發布網頁（前端已完成，可先做）

1. 把功能分支經 PR 併入 `main`（**併入 `main` 才算正式發布**；PR 只跑測試，不部署）。
2. GitHub repo → Settings → Pages → **Source 選「GitHub Actions」**。
3. `main` 收到推送後，`pages.yml` 會依序：測試 → 建置 `_site/`（五個檔）→ 部署。約 1–10 分鐘生效，網址 `https://unnn3ing-oss.github.io/hottopic/`。

### 後端部署（約 10 分鐘，一次性）

1. 建一份**私人** Google 試算表（空白即可，分頁程式會自動建立），網址中 `/d/` 與 `/edit` 之間那串就是 `SHEET_ID`。
2. 試算表 → 擴充功能 → Apps Script。專案設定勾「顯示 appsscript.json」，貼入 `apps-script/appsscript.json` 與 `apps-script/Code.gs`；再新增一個指令碼檔案（名稱 `lib`），貼入 `apps-script/lib.js`。
3. 專案設定 → 指令碼屬性：新增 `API_TOKEN`（至少 32 字元，產生方式見下）與 `SHEET_ID`。
4. 在編輯器選函式 `setup` → 執行，完成授權（試算表與對外連線）。執行記錄只會顯示屬性是否存在，不會印出內容。
5. 部署 → 新增部署作業 → 網頁應用程式：執行身分「我」、存取權「任何人」。複製 `/exec` 結尾的網址。
6. 把 `/exec` 網址與 `API_TOKEN` 帶到下一節，設定在 Cloudflare Worker 的 Secrets（**不要**貼進網頁）。

之後修改程式要「管理部署作業 → 編輯 → 新版本」才會生效（網址不變）。冒煙測試的做法見 `docs/apps-script-smoke-test.md`。

### Cloudflare Worker 部署（約 10 分鐘，一次性）

1. Cloudflare 儀表板 → Workers & Pages → Create → Worker，建立後 Edit code，把 `worker/index.js` 整份貼進去並 Deploy。
2. Worker → Settings → Variables and Secrets，新增：

   | 名稱 | 類型 | 內容 |
   |---|---|---|
   | `APP_PASSWORD` | Secret | 網頁登入密碼（至少 8 字元，自己好記即可；越長越安全） |
   | `SESSION_SECRET` | Secret | 簽憑證用的另一組隨機字串（至少 32 字元，不要與密碼相同） |
   | `API_TOKEN` | Secret | 與 Apps Script 指令碼屬性 `API_TOKEN` **完全相同** |
   | `APPS_SCRIPT_URL` | Secret | Apps Script 的 `/exec` 網址 |
   | `ALLOWED_ORIGIN` | Variable | `https://unnn3ing-oss.github.io`（結尾不要斜線） |

3. 取得 Worker 網址（`https://〈名稱〉.〈帳號〉.workers.dev`），用 `curl` 驗證（請把 `W`、密碼換成自己的）：

   ```bash
   W=https://〈名稱〉.〈帳號〉.workers.dev
   curl -s -X POST "$W/login" -H 'Content-Type: text/plain' -d '{"password":"你的登入密碼"}'
   # 預期：{"ok":true,"data":{"session":"…","exp":…}}
   curl -s -X POST "$W/api" -H 'Content-Type: text/plain' -d '{"session":"上一步的 session","action":"ping","args":{}}'
   # 預期：{"ok":true,"data":{"pong":true}}
   ```

   `/api` 回 `server_error` 且訊息是「Worker 與後端的密碼設定不一致」，代表 Worker 的 `API_TOKEN` 與 Apps Script 的不同。
4. 驗證通過後，才把網頁的 PR 併入 `main`（併入後網站就改成新登入方式）；開網頁，在設定貼上 Worker 網址與登入密碼，按「登入」。

**防暴力猜密碼**：Worker 登入失敗會固定延遲約 1 秒再回應，但這**擋不了同時多線程猜**；登入密碼只要求 8 字元，所以**強烈建議啟用下面的限流**，並把密碼設成不易猜的組合（英數混合、避開生日與帳號名）。Worker 也支援選用的 Rate Limiting 綁定（綁定名稱 `LOGIN_LIMITER`，有綁定才會用，超過頻率回 `rate_limited`）。**這個綁定在免費方案是否可用、能不能在儀表板設定，我在撰寫時無法連上 Cloudflare 文件查證**；請到 Cloudflare 文件的「Workers → Bindings → Rate Limiting」自行確認，需要時用 `wrangler` 設定。沒有綁定時，只靠上述延遲與密碼強度，8 字元的密碼有被線上暴力猜中的風險；也可以改用較長的密碼來補強。

產生 48 字元隨機字串（在任一網頁的 Console 貼上，會自動複製；`SESSION_SECRET` 要產生一組；`API_TOKEN` 若沿用 Apps Script 現有值則不必；`APP_PASSWORD` 自己決定即可）：

```js
copy(Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join(''))
```

## 日常使用

- 第一次開啟會跳出「設定」：貼上 Worker 網址與登入密碼，按「登入」。登入後 **12 小時內**不必重輸；到期後下一個操作會跳回登入畫面。
- 憑證預設只留在記憶體，重新整理要重新登入；勾「在這台裝置記住登入」才會把**憑證**（不是密碼）存進瀏覽器，到期時間不變。
- **換登入密碼**：只改 Worker 的 Secret `APP_PASSWORD`（不用重新部署程式）。已登入的人到期前不受影響；要讓所有人立刻登出，另外更換 `SESSION_SECRET`。
- **換 `API_TOKEN`**：Apps Script 的指令碼屬性與 Worker 的 Secret 兩邊都要改成同一個值。
- 程式（`Code.gs`）改版後，要「管理部署作業 → 編輯 → 新版本」才會生效，網址不變。`worker/index.js` 改版後，重新貼上並 Deploy。

## 開發

```bash
npm install
npm test            # 單元測試（lib、api、站台靜態檢查、workflow、機密掃描）
npm run test:e2e    # Playwright 冒煙測試（需要 Chromium）
npm run build       # 輸出 _site/
```

## 發布規則

功能分支開發 → PR → 併入 `main` 才算正式發布。Pages 只從 `main` 部署，且測試通過才會部署。

## 安全注意事項

- repo 與網頁是公開的，**不放任何機密**（密碼、Worker 與 Apps Script 的真實網址、試算表 ID）；測試內有機密掃描。
- 關卡有兩道：Worker 的登入密碼（至少 8 字元，放在 POST 內文，不放網址），以及 Apps Script 的 `API_TOKEN`（只有 Worker 知道）。網頁本身仍是不含資料的公開空殼。
- 登入憑證是有效 12 小時的簽章字串；「記住登入」會存在瀏覽器 localStorage，同一個 `github.io` 網域下的其他網頁讀得到，所以預設關閉。建議用沒有可疑外掛的瀏覽器個人檔案。懷疑外流時，更換 `SESSION_SECRET` 即可讓所有憑證失效。
- Worker 只允許 `ALLOWED_ORIGIN` 這一個網站讀取回應；沒設定好 Secrets 時一律拒絕，不會放行。
- 網頁用嚴格 CSP（只允許自己的檔案與 `*.workers.dev`），所有文字以 `textContent` 輸出。
