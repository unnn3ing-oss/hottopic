# 熱門新聞庫 設計 Spec

日期：2026-10-11　修訂：2026-10-12（改為 GitHub Pages 前端 + Apps Script API；併入跨網站冒煙測試的實測結論）　狀態：**使用者已確認（2026-10-12）**（§3、§5「設定與連線」「自動抓標題」、§6、§7、§8、§9、§10 有改動；§4 與其餘 §5 沿用已核准內容）。冒煙測試 T1–T6 已完成（T6 的閒置時間未達標，見 §10）。

## 1. 目的與使用者

- **使用者**：單一使用者（社群小編本人）。
- **目的**：把挑好的熱門新聞集中管理，每則記錄原文連結、改過的標題、小編文，以及「上次什麼時候用來發文、用過幾次」，讓挑題時一眼看出哪些很久沒用、哪些剛用過。
- **成功標準**
  1. 能手動新增、編輯新聞，並看到完整保留換行的改標標題。
  2. 每則都有「複製標題」「複製留言」，換行與格式不跑掉。
  3. 能標記已使用，並看到上次使用時間與使用次數。
  4. 資料存在使用者自己的私人 Google 試算表，不公開；沒有密碼的人讀不到也改不了。
  5. 網頁用 GitHub Pages 發布，手機與電腦都能開。

## 2. 範圍

**包含**：新聞列表（搜尋、分類篩選、排序）、新增、編輯、刪除、複製標題、複製留言、標記已使用、貼網址自動帶入原始標題、分類清單維護（在試算表內）、設定視窗（API 網址與密碼）。

**不包含**（YAGNI）：自動撈新聞、多人協作、使用紀錄歷史、冷卻天數與顏色警示（使用者已明確不要）、垃圾桶／復原刪除（誤刪時用試算表的版本記錄還原）、瀏覽器外掛一鍵加入、密碼錯誤鎖定計數、請求簽章／nonce、Origin 白名單（Apps Script 讀不到 Origin，做不到）、Google 帳號登入驗證（見 §3 備註）。

## 3. 已確認的決策

| 項目 | 決定 |
|---|---|
| 儲存 | 私人 Google 試算表（使用者雲端硬碟），不公開、不用 SQL |
| 前端 | 靜態網頁，發布在 GitHub Pages：`https://unnn3ing-oss.github.io/hottopic/`。repo 為公開（免費方案要求），**網頁與 repo 內不放任何機密** |
| 後端 | Google Apps Script Web App 當 JSON API：執行身分＝部署者（使用者本人），存取權＝「任何人」。只提供 `doGet`（固定回傳 `ok`）與 `doPost` |
| 試算表連結與授權範圍 | 指令碼屬性 `SHEET_ID` 記試算表 ID，程式一律 `SpreadsheetApp.openById`，**不依賴專案是否綁定在試算表上**（獨立專案與從試算表開的專案都能跑）。資訊清單範圍為 `spreadsheets` 與 `script.external_request`（`openById` 需要完整的 `spreadsheets`；較窄的 `spreadsheets.currentonly` 只適用綁定專案，未測試也不採用，理由見 §8）。已實測此組合可用 |
| 存取控制 | **（已由 `2026-10-13-cloudflare-worker-auth-design.md` 取代：瀏覽器改對 Cloudflare Worker 登入，`API_TOKEN` 只存在 Worker 與 Apps Script。）** 原做法：共用密碼（token）：至少 32 字元的隨機字串，存在 Apps Script 的「指令碼屬性」`API_TOKEN`，隨每次請求放在 POST 內文。使用者在網頁「設定」貼一次；**密碼預設只留在記憶體**，勾「在這台裝置記住」才存進瀏覽器 |
| 分支與發布 | 預設分支 `main`；開發在功能分支，經 PR 併入 `main` 才算正式；GitHub Pages **只從 `main` 部署**，部署前先跑測試（細節見 §6） |
| 編號 | 取網址中最長的一串數字；重複編號視為已存在 |
| 複製留言格式 | `小編文` 換一行 `https://news.tvbs.com.tw/news/編號`（不空行） |
| 時間與次數 | 只在按「標記已使用」時更新；次數 +1 |
| 多版改標 | 一則新聞可有多個改標，用左右滑動切換；使用紀錄同時記在整則新聞與被標記的那一版（預設做法，待使用者確認） |
| 小編文 | 整則新聞共用一份，不隨改標版本變化（預設做法，待使用者確認） |
| 自動抓標題 | 要。瀏覽器網頁直接 `fetch` 已實測被 TVBS 的 CORS 擋下，所以由 Apps Script 伺服器端抓取，已實測可取得 TVBS 文章的 `og:title`（HTTP 200）；解析沿用使用者外掛的做法（讀 meta、依序找標題來源），不用 AI、爬蟲 API 或第三方中繼；抓不到就手動輸入（細節見 §5） |
| 預覽 | 互動預覽（含多版改標、刪除）：https://claude.ai/artifact/QegKJLLiAjEfG1R1qwsHU9；原始檔已存進 `docs/superpowers/previews/`，實作時沿用其版面與輪播互動 |

**備註（曾評估、未採用）**
- **Apps Script 全包（方案 A）**：網頁也由 Apps Script 代管，只有本人的 Google 帳號能開，安全模型最簡單；使用者選擇 B，換取 GitHub Pages 網址、更新靠 `git push`、剪貼簿在頂層網頁較穩。
- **Google 帳號登入（OAuth ID token）取代共用密碼**：沒有長期密碼、外洩視窗較短，但要建立 Google Cloud OAuth 用戶端、處理授權與到期，對單人工具過重。日後若覺得共用密碼不夠，可作為升級方向。

## 4. 資料模型（試算表）

### 分頁「新聞」（第 1 列為標題列，一列一則）

| 欄 | 欄位 | 說明 |
|---|---|---|
| A | `id` | 網址數字；抓不到數字時為 `N` 加流水號 |
| B | `分類` | 必填，值來自「分類」分頁 |
| C | `原始標題` | 必填，建立後 UI 不可改 |
| D | `原文連結` | 必填 |
| E | `小編文` | 可空白，可含換行；整則新聞共用一份 |
| F | `上次使用時間` | 整則新聞的總計，空白代表從未使用 |
| G | `使用次數` | 整則新聞的總計，整數，預設 0 |
| H | `建立時間` | 自動 |

### 分頁「改標」（一列＝一則新聞的一個改標版本）

| 欄 | 欄位 | 說明 |
|---|---|---|
| A | `新聞id` | 對應「新聞」分頁的 `id` |
| B | `版本號` | 該則新聞內遞增的流水號，同時決定左右滑動的順序 |
| C | `標題` | 可含換行，必填（空白版本不儲存） |
| D | `上次使用時間` | 該版本的最近使用時間，空白代表未用過 |
| E | `使用次數` | 該版本被標記使用的次數，預設 0 |
| F | `建立時間` | 自動 |

一則新聞可有 0 個、1 個或多個改標版本。整則新聞的「上次使用時間」「使用次數」是所有版本的總計，每次標記時一起更新。

### 分頁「分類」
單欄清單，預設：社會、生活、健康、政治、國際、娛樂。使用者在試算表增刪即同步到介面。某分類被刪掉後，已使用該分類的新聞仍照常顯示與編輯。

### 儲存格格式
文字欄位（編號、分類、原始標題、原文連結、小編文、改標的新聞id與標題）一律設為純文字格式，**每次寫入前對實際寫入的範圍設定**（新增的列不一定繼承格式）。這樣以 `=`、`+`、`-`、`@` 開頭的標題不會被試算表當成公式，開頭為 0 的編號也不會被吃掉。

### 時區
專案時區設為 `Asia/Taipei`，時間以試算表日期格式儲存，畫面顯示 `yyyy/MM/dd HH:mm`。

## 5. 功能行為

### 設定與連線
- 第一次開啟（沒有 API 網址或沒有密碼）自動跳出「設定」視窗：**Apps Script 網址**（須是 `https://script.google.com/macros/s/…/exec` 格式）、**密碼**（隱藏輸入）、**在這台裝置記住密碼**（預設不勾，旁註：勾選後密碼會存在這個瀏覽器，同一個 `github.io` 網域下的其他網頁也讀得到）。
- 按「儲存並連線」：只送一次 `ping`（POST）。成功才儲存並載入列表；失敗時依原因顯示：讀不到回應＝網址或部署存取權不對（附檢查清單）、`unauthorized`＝密碼不對、`server_error`＝伺服器端設定問題（例如 `SHEET_ID`）。**不做 GET 預檢**：2026-10-12 實測從其他網站對 `/exec` 發 GET 會被 CORS 擋下（302 沒有 `Access-Control-Allow-Origin`），POST 才是已驗證可用的路徑（2026-10-12 修訂，取代原本「先 GET 再 ping」）。
- API 網址存在瀏覽器的 localStorage（不算機密，沒有密碼時只能消耗額度）；密碼預設只留在記憶體，重新整理要重新輸入，勾「記住」才寫入 localStorage。儲存鍵名統一加 `hotnews.v1.` 前綴。
- 任何請求收到 `unauthorized`：清掉已存的密碼並重新開啟設定視窗。設定視窗另有「清除這台裝置的設定」。
- 讀不到回應（網路中斷、被擋、網址錯、存取權不是「任何人」、程式改過但沒有建立新版本，這些在瀏覽器端看起來都一樣）：顯示固定訊息與檢查清單，不顯示技術細節。
- **新增、編輯、刪除、標記已使用不自動重試**：Apps Script 在第一個請求就已執行，回應遺失時重試可能重複寫入（例如多算一次使用）。遇到連線中斷或逾時，畫面提示「連線中斷，結果不確定，已重新載入列表」並重新讀取列表呈現實際狀態。

### 列表
- 每則顯示：`#編號`、分類、**改標區（完整顯示、保留換行）**、小編文（最多 3 行）、整則新聞的上次使用時間與「N 天前」、總使用次數。
- **原始標題預覽與「原文」連結在同一排**，位於卡片最下方、與四個操作按鈕同排：`[原始] 標題（單行，過長以 … 截斷，滑鼠停留顯示全文）　原文 ↗`。畫面太窄放不下時，這一組整個換到下一行，仍保持並排。「原文」連結只在網址是 http／https 時才可點，並帶 `rel="noopener noreferrer"`。
- **改標區是可左右滑動的輪播**，有多版時顯示圓點、‹ › 按鈕與「第 N / M 版」，每一版下方顯示該版本自己的上次使用時間與次數。可用以下方式切換，一次動作只換一版：
  - 手機、平板：手指左右滑動（瀏覽器原生捲動並自動對齊）。
  - 電腦滑鼠：在改標區**按住左鍵左右拖曳**，拖過約 15%（最多 60px）就換版，沒拖過則彈回；拖曳時不會選取文字。
  - 觸控板或橫向滾輪：橫向滑動換一版；以直向為主的滾動仍交給頁面捲動。
  - 鍵盤：焦點在改標區時按 ← / →。
  - 只有一個版本的新聞不顯示輪播控制，也不能拖曳。
- 預設顯示第 1 版；重新整理列表（搜尋、篩選、標記後）時，每則會停留在使用者上次看的那一版。
- 沒有任何改標的新聞顯示「（尚未改標）」，「複製標題」停用。
- 搜尋範圍：編號、原始標題、所有改標版本、小編文。
- 排序：最久未用優先（預設，從未使用者排最前）、最近使用優先、使用次數多到少、最新新增。
- 分類篩選：全部 + 各分類（含已從分類清單移除、但仍有新聞使用的分類），並顯示筆數。
- 載入中顯示「載入中…」；沒有任何新聞時顯示空狀態與「＋ 新增新聞」引導；載入失敗顯示訊息與「重試」。

### 新增
1. 貼上原文網址，網頁抽出編號並檢查重複；重複時顯示提示並可一鍵轉為編輯該則。
2. 自動帶入原始標題（見下），使用者可修改；選分類；改標標題與小編文可稍後補。
3. 必填：網址、原始標題、分類。
4. 按「儲存」後按鈕停用直到完成，避免連點重複送出。

### 編輯
編號、網址、原始標題唯讀；分類、小編文可改。改標區是一個清單：每個版本一個輸入框，可「＋ 新增一個改標」或「移除這版」（只剩一版時不顯示移除）。按「儲存」才一次寫入，按「取消」全部放棄；空白版本在儲存時自動略過。已存在版本的使用紀錄會保留。移除版本以「明確的移除清單」送給伺服器，不是「沒送就刪」，所以別的裝置剛新增的版本不會被這次儲存誤刪。

### 刪除
- 入口在「編輯」視窗左下角的「刪除這則」，列表上不放刪除鈕，避免誤觸。
- 第一次按變成紅底「再按一次刪除（無法復原）」，4 秒內再按才生效；逾時恢復原狀。
- 伺服器端在鎖內依 `id` 找到該列並刪除整列，同時刪除「改標」分頁中屬於該則的所有版本；找不到時回傳「這則已不存在」，畫面重新整理列表。
- 刪除是永久的，不做垃圾桶。誤刪可在 Google 試算表的「版本記錄」還原。

### 複製標題
把**目前顯示的那一版**改標原樣（含換行）寫入剪貼簿。有多版時提示「已複製第 N 版標題」。

### 複製留言
輸出 `小編文 + "\n" + "https://news.tvbs.com.tw/news/" + id`。小編文為空時只輸出網址。若 id 是 `N` 開頭（網址沒有數字），網址改用該則的原文連結。由網頁用與後端共用的 `lib.js` 即時組出，不需等待伺服器（剪貼簿要在使用者點擊的當下寫入）。

### 標記已使用
按第一下按鈕變為「再按一次確認」（有多版時註明「第 N 版」），3 秒內再按才生效；期間若滑到別的版本，確認狀態取消。伺服器端在鎖內同時更新：整則新聞的 `上次使用時間` 設為現在、`使用次數` +1，以及**目前顯示那一版**的 `上次使用時間` 與 `使用次數`。沒有任何改標的新聞只更新整則新聞。回傳更新後的新聞與其所有版本。

### 自動抓標題

**實測結論一（2026-10-11）**：使用者在 `https://example.com` 的瀏覽器 Console 對 `https://news.tvbs.com.tw/cars/4032757` 執行 `fetch`，得到 `blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource`。因此**任何一般網頁（包含 GitHub Pages）都無法在瀏覽器端直接讀取 TVBS 文章**；使用者的外掛抓得到，是因為外掛有額外的網站存取權。瀏覽器端 `fetch` + `DOMParser` 這條路不納入設計。

**實測結論二（2026-10-12）**：使用者在自己的 Apps Script 編輯器以 `UrlFetchApp.fetch` 抓同一篇文章（帶一般瀏覽器 `User-Agent`、`Accept-Language: zh-TW`、`muteHttpExceptions: true`），結果 `status=200`、內容長度 215,916 字元，並取得 `<meta property="og:title" content="買二手車別只看外觀、里程數！「4大陷阱」小心、這些地方要檢查">`。確認：
- Apps Script 伺服器端**抓得到** TVBS 文章，沒有被防機器人頁面攔下（這一次）。
- `og:title` 這一篇**沒有網站名稱後綴**；標題含全形標點（`！`、`「」`、`、`），沒有 HTML 實體。
- meta 屬性順序是 `property` 在前、`content` 在後（解析仍不依賴順序，因為其他網站可能相反）。
- 整頁約 216 KB，但標題在 `<head>`。

**實測結論三（2026-10-12，部署成網頁應用程式後從 `https://example.com` 經 `fetch` POST 呼叫 `fetchTitle`）**：`status=200`、內容 217,690 字元、取得與上列完全相同的 `og:title`，整趟（含轉址）約 2.4 秒。`UrlFetchApp.fetch` 帶 `timeoutSeconds: 8` **沒有丟錯**（選項被接受；**是否真的生效未驗證**，所以 8 秒保證仍靠網頁計時）。

**做法：由 Apps Script 伺服器端抓取，解析沿用外掛的邏輯**

1. `fetchTitle` 動作用 `UrlFetchApp.fetch` 下載原始碼：`muteHttpExceptions: true`、跟隨轉址、帶一般瀏覽器的 `User-Agent` 與 `Accept-Language: zh-TW`，以 UTF-8 解碼。`<meta>` 與 `<title>` 只看 `</head>` 之前的內容（找不到 `</head>` 時取前 300 KB）；`<h1>` 在內文，取前 300 KB 內的第一個。
2. 解析（Apps Script 沒有 `DOMParser`，改用規則運算式）：找出所有 `<meta>` 標籤並讀取屬性（不依賴屬性順序，單雙引號皆可，`property` 或 `name` 都認），依序找標題來源，取第一個非空值，並還原 HTML 實體（`&amp;`、`&quot;`、`&#39;`、數字實體，只還原一次）。先移除註解、`<script>`、`<style>` 區塊，避免假標籤誤判。
   - **來源順序（預設，待使用者的外掛順序確認）**：`og:title`（TVBS 已實測有值）→ `twitter:title` → `<title>` → 第一個 `<h1>`。
3. 清理：去除前後空白、把連續空白與換行壓成單一空白、移除控制字元與雙向文字控制字元；去除結尾的網站名稱後綴，格式為「分隔符號（`｜`、`|`、`-`、`–`、`—`）＋已知網站名稱」，已知名稱清單（`SITE_SUFFIXES`）寫在 `lib.js`。沒有符合已知名稱的後綴就不動，以免誤刪標題本身的內容。實測的 `og:title` 沒有後綴，所以這一步對 TVBS 的 `og:title` 是空操作，主要保護退回 `<title>`／`<h1>` 時的情況；`<title>` 的後綴格式待使用者提供實際標記後再補進清單，不先猜。
4. 網頁收到結果後帶入「原始標題」，標示來源（例如「來自 og:title」），使用者可直接修改；使用者在等待期間已自己輸入就不覆蓋。

**網址限制（只擋明顯不該抓的，不另做轉址檢查）**：只允許 `http`／`https`；不允許帶帳號密碼的網址（`user:pass@`）、IP 位址當主機、`localhost`、80／443 以外的連接埠。伺服器只回傳整理後的標題文字與來源名稱，不回傳原始網頁。

**失敗處理**：狀態碼不是 200、抓取丟出例外、回傳的是驗證或防機器人頁面（標題為「Just a moment…」之類）、找不到任何標題來源時，回傳空值並提示「抓不到標題，請手動輸入」，不阻擋儲存。**8 秒逾時由網頁計時**（超過就放棄並顯示同樣的提示，晚到的結果丟棄、不覆蓋使用者已輸入的內容）；後端的 `UrlFetchApp.fetch` 也帶 `timeoutSeconds: 8`（冒煙測試顯示選項被接受，但不當作保證，見 §10）。非 UTF-8 的網頁可能亂碼，需手動修正。

**備案（目前不做；只有日後伺服器端常被 TVBS 擋下時才另案討論）**：沿用使用者現有的外掛，在文章頁一鍵把網址與標題送進熱門新聞庫。這需要外掛的程式碼，不在本次範圍內。

## 6. 架構

```
手機／電腦瀏覽器
   │ 開啟 https://unnn3ing-oss.github.io/hottopic/（GitHub Pages，靜態網頁）
   │ fetch POST（text/plain 的 JSON：{ token, action, args }）
   ▼
Apps Script Web App（doPost）── 先驗 token ──┬──▶ SpreadsheetApp ──▶ 私人 Google 試算表
                                              └──▶ UrlFetchApp ──▶ 文章網頁（只為了抓標題）
```

### 檔案（repo）
```
apps-script/
  appsscript.json   時區 Asia/Taipei；webapp: executeAs USER_DEPLOYING, access ANYONE_ANONYMOUS；
                    oauthScopes 只列 spreadsheets 與 script.external_request
  Code.gs           doGet、doPost（驗 token、派送動作）；sheet_() 以指令碼屬性 SHEET_ID 開啟試算表；
                    動作：ping、listItems、addItem、updateItem、markUsed、deleteItem、fetchTitle
  lib.js            純函式與常數：extractId、nextSerialId、normalizeUrl、normalizeText、buildComment、
                    titleFromHtml、cleanTitle、TITLE_SOURCES、SITE_SUFFIXES（同一份檔案被 Apps Script、
                    網頁、node 測試共用）
web/
  index.html        CSP meta 放在 <head> 最前面；沒有行內 script 或 style
  app.css
  app.js            畫面、輪播、對話框（沿用已核准預覽的版面與互動；拿掉 Google 字型，改系統字型）
  api.js            連線層：設定、fetch、錯誤對應、逾時
scripts/build-site.js    把 web/* 與 apps-script/lib.js 複製到 _site/，資源網址加上 ?v=<commit sha>
.github/workflows/pages.yml
test/                    單元測試、後端測試（假的 Apps Script 物件）、e2e（Playwright）
docs/superpowers/        spec、plan、previews
```

### 單元職責
- `lib.js`：不碰 Google API、也不碰 DOM 的純邏輯，可獨立測試。
- `Code.gs`：唯一接觸試算表與外部網址的地方；`doPost` 先驗 token 才分派動作；每個動作檢查輸入並回傳 `{ ok, data | code }`。以底線結尾的輔助函式不對外。
- `api.js`：唯一呼叫伺服器的地方，負責設定、逾時、把各種失敗轉成固定錯誤。
- `app.js`：只負責呈現與互動，不含資料規則；所有來自伺服器或使用者的文字一律以 `textContent` 輸出。

### 分支與發布
- 功能分支開發 → 開 PR 併入 `main`（由使用者說「發布」才開 PR）→ `main` 收到推送後 `pages.yml` 依序執行：測試 → 建置 `_site/`（只含 `index.html`、`app.css`、`app.js`、`api.js`、`lib.js` 五個執行檔）→ 部署到 GitHub Pages。PR 只跑測試，不部署。
- 一次性設定（使用者）：Settings → Pages → Source 選「GitHub Actions」；預設分支已是 `main`。
- Pages 的 `github-pages` 環境預設只允許預設分支部署，所以只有 `main` 能發布。
- 發布後約 1–10 分鐘生效；資源檔以 `?v=<commit sha>` 避免舊快取，`index.html` 本身可能快取約 10 分鐘（未能確認），所以後端 API 對舊版網頁至少相容 10 分鐘（不刪動作、不改欄位名稱）。
- Apps Script 端改了程式要在「管理部署作業」建立新版本才會生效（網址不變）；網頁改動則靠上述流程。

## 7. API 協定、錯誤處理與一致性

- **請求**：`POST <Web App 網址>`，`Content-Type: text/plain;charset=utf-8`（Apps Script 無法回應預檢請求，所以必須是「簡單請求」，不能加自訂標頭，也不能用 `application/json`），內文為 JSON：`{ token, action, args }`。`fetch` 參數：`credentials: 'omit'`、`referrerPolicy: 'no-referrer'`、`redirect: 'follow'`（Apps Script 會先 302 再由瀏覽器 GET 取回輸出，`doPost` 在第一個請求就已執行）。一般動作 30 秒逾時，`fetchTitle` 8 秒。
- **回應**：`{ ok: true, data }` 或 `{ ok: false, code, error?, existing? }`。**HTTP 狀態永遠是 200**（ContentService 設不了狀態），網頁一律看 `ok`。`code` 只會是這幾個固定值：`unauthorized`、`bad_request`、`duplicate`、`not_found`、`stale`、`busy`、`server_error`；`error` 只放事先寫好的繁體中文訊息，不放例外內容或堆疊。
- **伺服器處理順序**：解析 JSON（失敗→`bad_request`）→ **驗 token** → 動作白名單 → 寫入類動作取鎖 → 執行。token 驗證完成前不碰試算表與外部網址。驗證**一律失敗關閉**：`API_TOKEN` 未設定、長度不足 32、請求沒帶或不相等，都回同一個 `unauthorized`。不記錄請求內文。
- **併發**：所有寫入使用 `LockService.getScriptLock()`（等待 10 秒），逾時回傳 `busy`。
- **重複編號**：伺服器端再次檢查，回傳 `duplicate` 與既有那則，網頁轉為編輯。
- **過期資料**：更新或標記時指定的改標版本已不存在 → `stale`；新聞已不存在 → `not_found`。網頁都會重新載入列表。
- **輸入驗證**：必填欄位、網址格式、分類必須存在於清單（但已存在於該則新聞的分類不變時放行），伺服器端與網頁都驗證。
- **剪貼簿**：先用 `navigator.clipboard.writeText`，失敗時退回隱藏 `textarea` + `execCommand('copy')`；仍失敗則提示手動選取。
- **失敗呈現**：所有錯誤以畫面內訊息顯示，不使用 `alert`／`confirm`。

## 8. 安全與隱私

**威脅模型**：GitHub repo 與 Pages 網頁是公開的，Apps Script 網址遲早會被別人知道；Apps Script 讀不到請求的來源網站，所以**唯一的關卡是密碼**。

| 風險 | 作法 |
|---|---|
| 猜密碼 | 至少 32 字元、由密碼學隨機產生（README 附產生指令）。不做鎖定計數（別人能反過來把你鎖死），不做常數時間比較、簽章、nonce（對單人工具不降低實際風險） |
| 密碼外洩 | 密碼放在 POST 內文，不放網址；預設只在記憶體；伺服器不記錄內文；改 Script Property 的值即輪替（已實測免重新部署，舊密碼立即失效），舊瀏覽器收到 `unauthorized` 自動清除；若 Apps Script 網址外洩，「新增部署作業」換新網址 |
| 同網域共用儲存 | 同一個 `unnn3ing-oss.github.io` 網域下所有專案網頁共用 localStorage，所以「記住密碼」預設關閉且寫明風險；建議不要在這個網域放不可信的第三方腳本，或日後綁自訂網域；瀏覽器外掛讀得到網頁內容，建議用沒有可疑外掛的瀏覽器個人檔案 |
| XSS | 所有文字以 `textContent` 輸出；連結只允許 http／https；不用資料當 `id`／`name`／`class`；`<head>` 最前面放 CSP：`default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://script.google.com https://script.googleusercontent.com; img-src 'self' data:; base-uri 'none'; form-action 'none'`（兩個 Google 網域都要列，因為轉址每一跳都會檢查）；不用行內 style 屬性、不載入第三方字型或程式庫；另加 `<meta name="referrer" content="no-referrer">` 與 `<meta name="robots" content="noindex">` |
| 後端被濫用 | token 先驗；`fetchTitle` 只回標題文字，並限制網址（見 §5） |
| 試算表公式注入 | 文字欄位設為純文字格式，每次寫入前設定（見 §4） |
| 權限範圍 | `appsscript.json` 只宣告 `spreadsheets` 與 `script.external_request`。**誠實說明**：`spreadsheets` 讓這支程式在授權上能開啟你帳號下任何試算表，但程式只會開 `SHEET_ID` 那一份，網頁能觸發的只有白名單內的幾個動作，沒有任意執行或任意讀檔的路徑；真正擋住外人的是密碼與動作白名單，不是範圍。選擇較窄的 `spreadsheets.currentonly` 需要專案綁定在試算表上、改用 `getActiveSpreadsheet()`，換來的保護只在「程式本身有漏洞」這種情境才有意義，因此不採用 |
| 發布管線 | Actions 最小權限（`contents: read`、`pages: write`、`id-token: write`）；只發布五個執行檔；測試中加一項掃描，repo 內出現真實的 `/macros/s/<部署ID>/exec` 網址或疑似密碼就失敗 |
| 無法防的 | 同一瀏覽器上的惡意外掛；密碼在你自己手上被偷。對策是可隨時輪替 |

## 9. 測試策略

- **單元測試（node:test，`lib.js`）**：`extractId`（含 `cars/4032757`、多段數字、無數字、帶 query 與 hash 的網址、主機名稱含數字、開頭為 0 的編號）、`nextSerialId`、`normalizeUrl`（含 `ftp:`、`javascript:`、帶帳密、IP 位址、非 80/443 埠）、`normalizeText`、`buildComment`（有／無小編文、結尾換行不產生空行、`N` 開頭編號）、`cleanTitle`（各種後綴、全形與半形分隔符號、標題本身含 `｜` 時不誤刪、控制字元）、`titleFromHtml`（`og:title` 優先並依序退回、屬性順序顛倒的 meta、單雙引號、HTML 實體只還原一次、前後空白與換行、`</head>` 之後與註解／script 內的假標籤不誤判、`<h1>` 內含標籤、防機器人頁面的標題不當成標題）。另加入使用者實測取得的 **TVBS 真實標記**作為測試資料（`test/fixtures`）：`<meta property="og:title" content="買二手車別只看外觀、里程數！「4大陷阱」小心、這些地方要檢查">`，預期解析結果與原文完全相同；若使用者再提供 `<title>`／`<h1>` 的實際標記，一併加入。
- **後端測試（node:test，`Code.gs`）**：Apps Script 無法在本機執行，改在 node 內以假的 `SpreadsheetApp`／`LockService`／`UrlFetchApp`／`PropertiesService`／`ContentService` 載入 `lib.js` + `Code.gs`，並**一律經由 `doPost`** 呼叫，所以密碼驗證、動作分派、回應格式也一起測：未設定／過短／錯誤密碼的 `unauthorized`（且驗證前不碰試算表與外部網址）、各動作的成功與錯誤情境、刪除連帶改標、標記已使用、重複編號、鎖逾時、文字格式在寫入前已設定、抓標題各情境。假物件會檢查回傳值不含 `Date` 等無法序列化的型別。假物件與真實 API 的差異仍由手動驗證清單覆蓋。
- **前端 e2e（Playwright + Chromium）**：以本機靜態伺服器載入建置後的 `_site/`，攔截對 Apps Script 網址的 `fetch`，轉給上述後端測試用的假後端（所以 `api.js` 的真實程式路徑、設定視窗、錯誤處理都被測到）。涵蓋列表、搜尋、排序、篩選、複製、標記已使用、新增（含重複與自動抓標題成功／失敗／逾時）、編輯、刪除、設定與 `unauthorized` 處理、連線中斷不重試並重新載入、HTML 文字不被當成標籤、頁面沒有 CSP 違規。**輪播互動測試**沿用預覽版已通過的 23 項（手指逐點觸控、滑鼠拖曳、橫向滾輪、鍵盤、按鈕，拖曳不選取文字，直向滾輪不誤換版，桌面與手機版面無橫向溢出、原始標題與「原文」同排）。
- **手動驗證清單**（部署後在實機執行）：Apps Script 部署與跨網站呼叫、密碼輪替、新增／重複／編輯／刪除／標記已使用、兩種複製（含換行貼到 IG、Threads 檢查）、自動抓標題成功與失敗、手機版面、GitHub Pages 上的 CSP 與剪貼簿。

## 10. 已知風險與待驗證

1. **跨網站讀取 Apps Script 的回應是「事實上的行為」，不是 Google 的正式承諾**。冒煙測試（`docs/apps-script-smoke-test.md`，使用者在自己的帳號執行）結果，2026-10-12：
   - **T1 通過**：從 `https://example.com` 以 `text/plain` 的 `fetch` POST 呼叫，`status 200`、`redirected true`、最終網址在 `script.googleusercontent.com`、`application/json`，中文不亂碼；`openById` 讀到試算表（`ok:1`）。另發現：**綁定在試算表上的專案，`getActiveSpreadsheet()` 在網頁應用程式內也可用（`ok:1`）；先前的 `null` 是因為當時是獨立專案**。
   - **T2 通過**：錯誤密碼回 `{"ok":false,"code":"unauthorized"}`，HTTP 仍是 200。
   - **T3 通過**：見 §5「實測結論三」。
   - **T4 符合預期**：以 `application/json` 呼叫在預檢階段被 CORS 擋下（`Failed to fetch`），證實必須用 `text/plain`。
   - **T5 通過**：只在指令碼屬性把 `API_TOKEN` 改成新值並儲存、**沒有重新部署**，舊密碼立刻回 `unauthorized`，新密碼立刻成功。所以輪替密碼＝改屬性值＋在網頁設定貼新密碼，不需要動部署。
   - **T6 有數字但不算冷啟動**：`ping` 2.08 秒、與暖啟動的 1.7–2.4 秒同一範圍；但這次與前一次呼叫的間隔不到 10 分鐘，不能證明是冷啟動。
   - 這項依賴 Google 沒有公開承諾的行為，所以保留冒煙測試文件，日後出現「連不上」時可重跑，分辨是 Google 端變了還是程式的問題。
2. **與 CSP 的互動**：`connect-src` 需同時允許 `script.google.com` 與 `script.googleusercontent.com`；Console 在 `example.com` 的測試沒有 CSP，抓不到這類問題，所以首次部署到 GitHub Pages 後要在真實頁面再測一次。
3. **Apps Script 伺服器端抓 TVBS 標題的穩定度**：已實測一次成功。尚未確認的是長期穩定度：TVBS 或其防護日後可能對來自 Google 的請求出現驗證頁、限流或封鎖。被擋時退回手動輸入，不影響其他功能。
4. **延遲**：實測連續呼叫約 0.8–2.0 秒（`ping` 1.7–2.0 秒、錯誤密碼 0.8 秒、含抓取 TVBS 的 `fetchTitle` 2.4 秒）。這些都不是確認過的冷啟動數字（T6 閒置時間不足）；規格以「每次操作約 2 秒、偶爾更久」設計：列表載入顯示「載入中」、操作按鈕有處理中狀態、不假設即時回應。
5. **配額**：消費者帳號每日 `UrlFetchApp` 約 2 萬次（二手資料，且配額可能調整）；沒有密碼的人仍可送請求消耗執行額度，影響是暫時性錯誤，不會外洩或改動資料。
6. **同網域 localStorage 共用**：見 §8。
7. **Pages 快取**：以 `?v=<commit sha>` 與 API 向下相容處理，實際快取時間於首次部署後以 `curl -I` 確認。
8. **部署與設定需要使用者操作**：Claude 在此環境無法登入使用者的 Google 帳號，也不能改 repo 設定。使用者要做：建立 Apps Script 專案並貼入程式與資訊清單、設定指令碼屬性 `API_TOKEN` 與 `SHEET_ID`、執行一次授權、部署為網頁應用程式、Settings → Pages 選「GitHub Actions」。我會提供逐步說明（冒煙測試已走過同一條路）。
9. **效能**：資料量預期為數百到數千列，整表讀取即可；若超過約 5,000 列再考慮分頁。
