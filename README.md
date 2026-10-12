# 熱門新聞庫

把挑好的熱門新聞集中管理：原文連結、多版改標（左右滑動）、小編文、上次使用時間與次數；一鍵複製標題與留言，貼網址自動帶入原始標題。

**目前進度**：前端（GitHub Pages 網頁）與後端（Google Apps Script API）程式都已完成並通過自動測試；剩下在你的 Google 帳號部署後端、設定密碼（見下方「後端部署」）。

## 架構

```
手機／電腦瀏覽器
   │ 開啟 https://unnn3ing-oss.github.io/hottopic/（GitHub Pages，靜態網頁）
   │ fetch POST（text/plain 的 JSON：{ token, action, args }）
   ▼
Apps Script Web App（doPost）── 先驗密碼 ──┬──▶ 私人 Google 試算表
                                           └──▶ 文章網頁（只為了抓標題）
```

| 路徑 | 內容 |
|---|---|
| `web/` | `index.html`、`app.css`、`app.js`（畫面與互動）、`api.js`（連線層） |
| `apps-script/lib.js` | 網頁、Apps Script、測試共用的純函式（編號、網址檢查、文字整理、留言組合） |
| `apps-script/` 其餘 | **待寫**：`Code.gs`、`appsscript.json` 與標題抽取 |
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
6. 開網頁，在設定貼上 `/exec` 網址與密碼，按「儲存並連線」。

之後修改程式要「管理部署作業 → 編輯 → 新版本」才會生效（網址不變）。冒煙測試的做法見 `docs/apps-script-smoke-test.md`。

產生 48 字元隨機密碼（在任一網頁的 Console 貼上，會自動複製）：

```js
copy(Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join(''))
```

## 日常使用

- 第一次開啟會跳出「設定」：貼上 Apps Script 網址與密碼，按「儲存並連線」（只送一次 `ping` 驗證）。
- 密碼預設只留在記憶體，重新整理要重新輸入；勾「在這台裝置記住密碼」才會存進瀏覽器。
- **換密碼**：只改 Apps Script 的指令碼屬性 `API_TOKEN`（不用重新部署），再到網頁設定貼新密碼；舊瀏覽器會收到 `unauthorized` 並自動清除舊密碼。
- 程式（`Code.gs`）改版後，要「管理部署作業 → 編輯 → 新版本」才會生效，網址不變。

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

- repo 與網頁是公開的，**不放任何機密**（密碼、真實部署網址、試算表 ID）；測試內有機密掃描。
- 唯一的關卡是密碼：至少 32 字元的隨機字串，放在 POST 內文，不放網址。
- 「記住密碼」會存在瀏覽器 localStorage；同一個 `github.io` 網域下的其他網頁讀得到，所以預設關閉。建議用沒有可疑外掛的瀏覽器個人檔案。
- 網頁用嚴格 CSP（只允許自己的檔案與 Google 的兩個網域），所有文字以 `textContent` 輸出。
