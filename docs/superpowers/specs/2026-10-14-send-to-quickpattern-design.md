# 卡片「送到套版」設計 Spec

日期：2026-10-14　狀態：**設計已由使用者核可（2026-10-14）**，本檔待使用者審閱。
範圍：本 repo（熱門新聞庫網頁）＋ `unnn3ing-oss/QuickPatterntool`（Chrome 擴充功能「圖片套版產生器」，版本 4.40）。

## 1. 目的與成功標準

**目的**：在熱門新聞庫的卡片按一個鈕，就把這則新聞的網址與**目前輪播顯示的那版改標**送進 Chrome 擴充功能的側邊欄，並自動執行該擴充功能原有的「快速產圖」（抓首圖、圖說、hashtag），省去複製網址、切換視窗、貼上、按快速產圖的步驟。

**成功標準**
1. 卡片按「送到套版」後，側邊欄（開著時）自動帶入網址並完成快速產圖，圖上標題是卡片當前改標。
2. 側邊欄沒開著時，不丟失資料：Chrome 允許就自動打開，不允許就在圖示提示，使用者點圖示後自動帶入並產圖。
3. 沒裝擴充功能或版本過舊時，卡片明確提示並把網址複製到剪貼簿備用，不會靜默失敗。
4. 產圖完成後停在「直接下載」待確認，**不會自動下載**。
5. 「送到套版」不改變新聞的已使用狀態。

## 2. 已確認的決策

| 項目 | 決定 |
|---|---|
| 做法 | 只做擴充功能這條路；網頁版套版不動（網頁沒有 CORS 豁免，抓不到文章圖） |
| 圖上標題 | **用卡片目前顯示的改標**；換行規則沿用擴充功能現有的 `breakTitle`。圖片、圖說、hashtag 仍由快速產圖自動抓 |
| 自動程度 | 自動執行快速產圖到「直接下載」待確認；不自動下載 |
| 通道 | 擴充功能新增橋接內容腳本，只注入熱門新聞庫頁面；不需要擴充功能 ID，不經過 Worker 或 Apps Script |
| 備案 | 側邊欄沒開且 Chrome 不允許自動打開時，暫存請求並在圖示顯示提示，使用者點圖示後自動處理 |
| QuickPatterntool 的修改方式 | 在該 repo 開功能分支與 PR，不直接推 `main` |

## 3. 架構與資料流

```
熱門新聞庫卡片
  │ window.postMessage {source:'hottopic', type:'send-to-quickpattern', url, title, nonce}
  ▼
bridge.js（內容腳本，只在 https://unnn3ing-oss.github.io/hottopic/* ）
  │ 驗證 → chrome.runtime.sendMessage {type:'hottopic:send', url, title}
  ▼
background.js ── 驗證 sender ── 存 chrome.storage.session.pending ── 嘗試 sidePanel.open
  │ 回覆 {ok, opened}                                          │
  ▲（經 bridge 轉成 ack，postMessage 回頁面）                    ▼
                                           sidepanel.js：讀到 pending → quickfill.run({titleOverride})
```

## 4. 訊息協定

**頁面 → bridge**（`window.postMessage(msg, location.origin)`）

| 欄位 | 說明 |
|---|---|
| `source` | 固定 `'hottopic'` |
| `type` | 固定 `'send-to-quickpattern'` |
| `v` | 協定版本，目前 `1` |
| `nonce` | 隨機字串，用來配對回覆 |
| `url` | 新聞網址 |
| `title` | 卡片目前顯示的改標（單行純文字，可省略） |

**bridge → 頁面**（`window.postMessage(ack, location.origin)`）：`{source:'quickpattern', type:'ack', nonce, ok:boolean, opened:boolean, error?:string}`。

**驗證規則（bridge 與 background 各做一次）**
- `url`：長度 ≤ 2000；`new URL()` 可解析；協定必須是 `https:`；主機名等於 `tvbs.com.tw` 或以 `.tvbs.com.tw` 結尾；不含帳密。
- `title`：若有，必須是字串，長度 ≤ 200，去掉控制字元後非空。
- 不合規：回 `ok:false`、不暫存、不打開側邊欄。
- bridge 只處理 `event.source === window`、`event.origin === location.origin` 且 `source`/`type` 相符的訊息。
- background 只接受 `sender.id` 為自己，且 `sender.url` 的 origin 是 `https://unnn3ing-oss.github.io`、路徑以 `/hottopic/` 開頭。

## 5. 擴充功能端（QuickPatterntool）

| 檔案 | 變動 |
|---|---|
| `bridge.js`（新） | 上述訊息處理與驗證。驗證函式以 UMD 方式匯出（同 `quickfill.js` 的 `root.QuickFill` 做法）以便 Node 單元測試 |
| `manifest.json` | 新增 `content_scripts`：`matches: ["https://unnn3ing-oss.github.io/hottopic/*"]`、`js: ["bridge.js"]`、`run_at: "document_idle"`；`permissions` 加 `"storage"` 已有，不新增；版本 `4.40 → 4.50` |
| `background.js` | `onMessage` 處理 `hottopic:send`：驗證 sender → `chrome.storage.session.set({pending:{url,title,at}})` → `try { chrome.sidePanel.open({windowId: sender.tab.windowId}) }`，成功回 `opened:true`；失敗則 `action.setBadgeText({text:'1'})`（顏色與「新版」紅點區分，用藍色）並回 `opened:false` |
| `sidepanel.js` | 載入時與 `chrome.storage.onChanged`（session 區）時檢查 `pending`；有效期 2 分鐘，逾期丟棄。取出即刪除並清掉圖示提示，再呼叫 `QuickFill.applyPending({url,title})` |
| `quickfill.js` | `run(opts)` 新增 `opts.titleOverride`：<br>① 一開始就把 override 經 `breakTitle` 後填進標題欄（即使之後抓文章失敗，圖上也有標題）；<br>② 文章抓到後**不覆蓋**標題，`learnSeps` 與 `formatCopy` 都用 override 當標題；<br>③ 文章沒標題但有 override 時不再報「抓不到標題」。<br>新增 `applyPending`：把網址填進 `qfUrl` 並呼叫 `run({titleOverride})` |
| `updater.js` | `SKIP` 加入 `/^test\//`，避免測試檔被同步進擴充功能資料夾 |
| `changelog.json`、`README.md` | 補 4.50 的版本說明；README 補「從熱門新聞庫送到套版」的說明與檔案結構表 |
| `test/bridge.test.js`（新） | `node --test` 執行，涵蓋驗證函式（見 §8） |

**第一次升級的注意事項（事實）**：`manifest.json` 新增 `content_scripts` 會讓側邊欄的更新流程跳出「這次更新會增加權限」確認；更新後要把已開著的熱門新聞庫分頁**重新整理一次**，內容腳本才會注入。

## 6. 熱門新聞庫端（本 repo）

| 檔案 | 變動 |
|---|---|
| `web/app.js` | 卡片動作列在「複製留言」旁新增「送到套版」按鈕（`data-act="qpt"`）。處理流程：取該則 `it.url` 與目前輪播顯示的改標（`it.titles[posOf(it)]`，沒有改標則省略 `title`）→ 產生 nonce → `postMessage` → 等 ack 最多 800 毫秒 → 依結果提示 |
| 提示文字（toast） | ack `ok` 且 `opened`：「已送到套版」。<br>ack `ok` 但 `!opened`：「已傳給套版，請點一下工具列圖示打開側邊欄」。<br>ack `ok:false`：顯示錯誤並複製網址。<br>逾時沒 ack：「沒偵測到套版擴充功能（需 v4.50 以上，並重新整理本頁），已複製網址」，同時 `clipboard.writeText(url)` |
| 行為界線 | 不呼叫 `markUsed`，不改任何資料；沒有網址的新聞，按鈕停用 |
| `web/index.html` | 不需改 CSP（`postMessage` 是同源行為，不發網路請求） |
| 測試 | 見 §8 |

## 7. 錯誤與邊界情況

| 情況 | 行為 |
|---|---|
| 沒安裝擴充功能、或舊版（沒有 bridge） | 800 毫秒沒 ack → 提示並複製網址 |
| 連續快速按兩則 | 後者覆蓋 `pending`；側邊欄取最新的；`run()` 本來就會中止上一次 |
| 側邊欄開著、快速產圖執行中又收到新的 | `run()` 中止舊的、改跑新的 |
| `pending` 超過 2 分鐘才被讀到 | 丟棄，避免很久以前的請求突然被執行 |
| 文章抓取失敗（逾時、HTTP 錯誤） | 標題仍是卡片改標，狀態列顯示原有的失敗原因，使用者可手動放圖 |
| 卡片改標含全形空格、「！」「？」「：」 | 與原本快速產圖相同，由 `breakTitle` 換行 |
| 網址不是 tvbs.com.tw | 拒絕（`ok:false`），並複製網址 |

## 8. 測試

| 層級 | 內容 |
|---|---|
| QuickPatterntool 單元測試（Node，`node --test test/`） | 驗證函式：合法 TVBS 網址；非 https、非 tvbs（含 `tvbs.com.tw.evil.com`、`eviltvbs.com.tw`）、帶帳密、超長、無法解析；`title` 為非字串、超長、全控制字元；`pending` 過期判斷 |
| 本 repo 單元測試 | 「組出要送的訊息」的純函式（挑目前改標、無改標時省略 `title`）；逾時與 ack 的狀態處理 |
| 本 repo e2e（Playwright） | 在假頁面注入一個模擬 bridge：① 回 ack `opened:true` 顯示「已送到套版」；② 回 `opened:false` 顯示點圖示提示；③ 不回 ack，800 毫秒後出現提示並把網址放進剪貼簿；④ 按鈕不會觸發「已使用」；⑤ 輪播到第 2 版後送出的是第 2 版標題 |
| **無法自動化、要實機驗證** | Chrome 是否允許自動打開側邊欄、內容腳本實際注入、整條鏈在真實擴充功能的行為。會列在 `docs/manual-checklist.md`，由使用者在 Chrome 實測 |

## 9. 部署順序

1. 在 `QuickPatterntool` 開 PR（含 `bridge.js`、`manifest.json` 4.50、`changelog.json`、README、測試），**併入 `main` 之前不要併本 repo 的 PR**。
2. 使用者在擴充功能側邊欄按「更新」（會跳權限確認），並重新整理熱門新聞庫分頁。
3. 在本 repo 開 PR 加入按鈕，併入 `main` 後 GitHub Pages 自動部署。
4. 使用者實機驗證 §8 最後一列的項目。

## 10. 不做（YAGNI）

- 不改 Worker、Apps Script、套版網頁版。
- 不自動下載圖片。
- 不把改標以外的資料（小編文、分類）送進擴充功能。
- 不支援非 TVBS 網域。
- 不做「從擴充功能反向讀取熱門新聞庫」。

## 11. 風險與限制

| 項目 | 說明 |
|---|---|
| 自動打開側邊欄 | **未驗證**：`sidePanel.open` 需要使用者操作，經訊息鏈轉送後 Chrome 是否承認尚不確定。已備有備案（§2） |
| 權限增加 | 新增只對 `…github.io/hottopic/*` 注入的內容腳本；`host_permissions` 本來就是 `<all_urls>`，沒有擴大實際權限範圍 |
| 同網域其他頁面 | `github.io` 是共用網域，但內容腳本只注入 `/hottopic/` 路徑，且 background 會再檢查 `sender.url`；訊息內容仍須通過 §4 驗證 |
| 兩個 repo 要配合 | 順序與升級注意事項見 §5、§9 |
