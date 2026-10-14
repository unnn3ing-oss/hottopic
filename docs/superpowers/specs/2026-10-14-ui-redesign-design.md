# 熱門新聞庫介面改版設計規格

日期：2026-10-14　範圍：只動 `unnn3ing-oss/hottopic` 的 `web/`（前端），Worker、Apps Script、QuickPatterntool 都不改。

## 目標

1. 列表可選「顯示則數」5／10／15／20，並有分頁。
2. 頂欄改成 QPT 網頁版的樣式（半透明白底加模糊、膠囊按鈕），固定在頂端。
3. 桌機版右側卡片一直固定在視窗內，列表捲動時它不動。
4. 全站按鈕、卡片、文字，統一採用 QPT「全螢幕安裝教學」與 LinePushPatternTool「推播精靈」的設計語言。

不做：新增任何資料欄位、改後端、改卡片內容（改標輪播、小編文、操作按鈕維持現有功能與文案）。

## 1. 版面

### 桌機（視窗寬度 > 820px）

```
┌ 頂欄 sticky ─────────────────────────────────────────┐
│ 熱門新聞庫        [ 🔍 搜尋標題、小編文、編號 ]   設定  ＋新增新聞 │
└──────────────────────────────────────────────────────┘
┌ 左：列表 ─────────────────────┐ ┌ 右：卡片（固定）──────┐
│ 分類 chips                    │ │ 編號・使用情形          │
│ 共 128 則・第 1／13 頁  [排序▾][顯示▾] │ │ 原標題                 │
│ 列 × 當頁則數                  │ │ 改標輪播               │
│ 分頁列 ‹ 1 2 3 … 13 ›          │ │ 小編文                 │
└───────────────────────────────┘ │ 操作按鈕                │
                                  └────────────────────────┘
```

- 取消外層 `.app` 大卡片（它的 `overflow:hidden` 會讓 sticky 失效）；頁面背景為淡藍雙層 radial gradient，左側列表與右側卡片各自是獨立的白色圓角卡。
- 頁面容器 `max-width:1400px`；兩欄 `grid-template-columns:minmax(0,1fr) 500px`，欄距 24px；寬度 ≤ 940px 時右欄 440px。
- **頂欄**：`position:sticky; top:0; z-index:40`，高度固定 64px（`--topbar-h`），背景 `rgba(255,255,255,.86)` 加 `backdrop-filter:blur(14px)`，下緣 1px 邊線；左標題、中搜尋（pill 形，`max-width:360px`）、右 `設定`（次要 pill）與 `＋ 新增新聞`（主要 pill）。深色模式用對應的半透明深色底。
- **右側卡片固定**：`.pane-r` 為 `position:sticky; top:calc(var(--topbar-h) + 16px); height:calc(100dvh - var(--topbar-h) - 32px)`（不支援 `dvh` 的瀏覽器退回 `vh`）。卡片內容超出時，卡片內部 `overflow-y:auto` 自己捲，頁面本身不捲到卡片。

### 手機（≤ 820px）

- 維持現行行為：只顯示列表，點一列才顯示卡片，`返回` 回列表；`body.detail` 時隱藏頂欄與列表。
- 頂欄：標題在左，右側三顆圖示按鈕 `搜尋`（切換第二列搜尋框）、`設定`（齒輪）、`＋`（新增）。搜尋框預設收起，點圖示展開並聚焦；有搜尋字時圖示呈選中狀態。圖示用靜態 inline SVG（CSP 允許），按鈕帶 `aria-label`。
- 排序與則數膠囊維持在列表上方，分類 chips 單行可橫向滑動。

## 2. 排序與顯示則數（展開式選擇器）

兩個元件同一個樣式，並排在「共 N 則・第 p／P 頁」右側。取代現有的 `<select id="sort">`。

- **收合**：一顆白色膠囊，內容 `排序 久未用 ▾`、`顯示 10 則 ▾`（標籤灰、值藍粗體）。選項平時不顯示。
- **點一下**：膠囊向左右展開成膠囊分段列（軌道 `rgba(0,74,173,.07)`、4px 內距、選中項白底加陰影，同 QPT `.func-switch`），標籤留在左側。
- **關閉**：選了一項、按 Esc、點元件外面、或展開另一個選擇器時，立即收回並把焦點還給膠囊按鈕。同一時間只會有一個展開。
- 排序選項（值 → 顯示字）：`oldest` 久未用、`recent` 最近用、`count` 次數、`created` 最新。預設 `oldest`，行為與現在的排序邏輯相同。
- 則數選項：`5`、`10`、`15`、`20`。預設 `10`。
- 無障礙：膠囊是 `<button aria-haspopup="true" aria-expanded>`；選項是 `role="radiogroup"` 內的 `role="radio"` 按鈕並帶 `aria-checked`；方向鍵左右移動焦點。
- 減少動態偏好（`prefers-reduced-motion`）下不做展開動畫。

## 3. 分頁行為

純函式放在新檔 `web/paging.js`（不碰 DOM，可在 Node 單測）：

| 函式 | 行為 |
|---|---|
| `PAGE_SIZES` | `[5,10,15,20]` |
| `normalizeSize(v)` | 接受數字或數字字串；不在 `PAGE_SIZES` 內一律回 `10` |
| `pageCount(total, size)` | `max(1, ceil(total/size))` |
| `clampPage(page, pages)` | 取整並夾在 `1..pages`；非數字回 `1` |
| `slicePage(list, page, size)` | 回傳該頁的子陣列 |
| `pageOf(list, id, size)` | 回傳 id 所在頁碼，找不到回 `0` |
| `pageWindow(page, pages)` | 回傳頁碼列：永遠含第 1 頁、最後一頁、目前頁±1，之間不連續處用 `'…'`；`pages ≤ 7` 時全部列出 |

`app.js` 的行為：

- `state.size`（預設 10）與 `state.page`（預設 1）。則數選擇存到 `localStorage['hottopic.pageSize']`；讀寫都包 try/catch，失敗就用預設值，頁面照常運作。
- **回到第 1 頁並把選中項改成該頁第一則**：換分類、搜尋、排序、則數、翻頁（翻頁時同樣選該頁第一則）。
- **資料變動後重繪**（標記已使用、編輯、刪除、新增）：頁碼夾回有效範圍；若目前選中的新聞仍在篩選結果內，頁碼跳到它所在的頁，使列表與卡片一致；不在結果內才改選當頁第一則。
- 分頁列在列表底部，總頁數 ≤ 1 時不顯示。按鈕為 `‹`、頁碼、`…`（不可點）、`›`；目前頁 `aria-current="page"`；首頁時 `‹` 與末頁時 `›` 為 `disabled`。翻頁後捲到頁面頂端（`window.scrollTo(0,0)`）。
- 「共 N 則」文字改為 `共 N 則・第 p／P 頁`；搜尋無結果、載入中、錯誤、尚未連線等狀態維持現有訊息，這些狀態下不顯示分頁列與兩個選擇器的頁碼文字。

## 4. 視覺規範

來源：QPT `deploy.css`（全螢幕安裝教學）、`segmented.css`、`style.css` 的頂欄；LinePushPatternTool 的 `.lw-op`、`.lw-box`。全部寫在 `web/app.css`，不使用行內樣式或 `<style>`（CSP 限制 `style-src 'self'`）。

**色彩 token**（淺色／深色）

| token | 淺色 | 深色 |
|---|---|---|
| `--accent` | `#004aad` | `#5b9bff` |
| `--accent-soft` | `#e8f0fc` | `#1c2744` |
| `--text` | `#1f2a3d` | `#e6ecfa` |
| `--muted` | `#6b7890` | `#93a3c7` |
| `--border` | `rgba(0,74,173,.12)` | `rgba(120,160,255,.18)` |
| `--track` | `rgba(0,74,173,.07)` | `rgba(120,160,255,.12)` |
| `--shadow` | `0 24px 60px -30px rgba(0,43,102,.35)` | `0 24px 60px -30px rgba(0,0,0,.6)` |
| `--ok` | `#16a34a` | `#6fd49a` |
| 選中 chip | 底 `#dbeafe`、框 `#93c5fd`、字 `#1e40af` | 底 `#1e3a6e`、框 `#3b5aa0`、字 `#bcd4ff` |

現有 token 名稱（`--bg --surface --ink --line --edge --soft --blue --glow` 等）改為指向新 token，避免彈窗等未改動的規則壞掉。

**元件**

- 字型：`system-ui, "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif`。標題 `800`，內文 15px。
- 按鈕（全站只有三種，皆為 pill）：
  - 次要 `.btn`：padding `10px 20px`（卡片內小按鈕 `8px 16px`）、底 `--track`、無邊框、hover 變白底＋accent 字（同 `.help-btn`）。
  - 主要 `.btn.primary`：accent 底白字，hover 變 `--accent-dark`（`#003a87`），帶柔和陰影。
  - 危險 `.btn.danger`：紅字紅框透明底；`.armed` 為紅底。
  - `.btn.confirm`（標記二次確認）沿用現有警示色。
- 列表列：白底、`--border` 邊、圓角 16px、淡陰影；選中時 accent 邊加 `0 0 0 4px var(--accent-soft)` 外圈；次數徽章為 accent-soft 方塊圓角 10px。
- 右側卡片 `.item`：圓角 22px、`--shadow`；內部區塊（改標輪播、小編文）用 `.lw-box` 的樣式（圓角 14px、`--border` 邊）。
- 分類 chips：pill、白底、`--border` 邊；選中用上表「選中 chip」色。
- 彈窗（設定、新增／編輯）：圓角 22px、輸入框圓角 14px、`--accent` focus 外圈；按鈕沿用上面三種。
- 頁面背景：`radial-gradient(900px 500px at 8% -10%, #dce8ff, transparent 60%), radial-gradient(800px 500px at 100% 0, #e4eeff, transparent 60%), #f4f7fd`；深色模式用深藍底，不用漸層高光。
- 動畫尊重 `prefers-reduced-motion`。

## 5. 檔案

| 檔案 | 變動 |
|---|---|
| `web/paging.js` | 新增，第 3 節的純函式，以全域 `HotNewsPaging` 暴露（同 `qpt.js`：頂層 `var` 加 `module.exports` 判斷，Node 與瀏覽器共用） |
| `web/index.html` | 頂欄結構、兩個展開式選擇器、分頁列容器、手機圖示按鈕、載入 `paging.js`（順序：`lib → api → qpt → paging → app`） |
| `web/app.css` | 依第 1、2、4 節重寫 |
| `web/app.js` | 分頁狀態、選擇器、分頁列、手機搜尋切換、選中項與頁碼的同步 |
| `scripts/build-site.js` | `FILES` 加入 `web/paging.js`；`?v=` 正則加入 `paging` |
| `test/site.test.js` | 檔案數與資源參照數、載入順序 |
| `test/paging.test.js` | 新增，單元測試 |
| `test/e2e/smoke.e2e.js` | 取代舊的 `#sort` 下拉操作；新增第 6 節的情境 |
| `docs/manual-checklist.md`、`README.md` | 補新介面與分頁的手動驗證項目 |

## 6. 測試

**單元（`test/paging.test.js`）**：`normalizeSize` 對 `5/'10'/15/20/7/0/null/'abc'`；`pageCount` 對 `0/1/10/11/128`；`clampPage` 對超出、`0`、負數、`NaN`、小數；`slicePage` 的首頁、末頁（不足一頁）、空陣列；`pageOf` 找到與找不到；`pageWindow` 對 `pages` 為 1、7、8、13 且 page 在頭、中、尾。

**E2E（Playwright，擴充現有 `smoke.e2e.js`，需先種入超過 20 則新聞的資料）**：

1. 預設每頁 10 則、分頁列與「第 1／N 頁」文字正確；總頁數 1 時沒有分頁列。
2. 排序與則數選項平時不可見；點膠囊才出現；選一項後收合並生效；Esc、點外面、展開另一個都會收合；同時只有一個展開。
3. 選 5／15／20 後列數與頁數正確；重新整理後仍是所選則數；`localStorage` 被禁用時頁面仍可用、回預設 10。
4. 換分類、搜尋、排序、則數都回到第 1 頁；翻頁後選中項為該頁第一則且卡片同步。
5. 標記已使用導致該新聞排到別頁（排序為 `oldest`）時，頁碼跟著跳到該新聞所在頁，列表與卡片一致。
6. 桌機視窗 1280×800：往下捲動後，頂欄 `getBoundingClientRect().top === 0`，右側卡片的 `top` 與捲動前相同；卡片內容很長時卡片自己可捲。
7. 手機視窗 390×844：初始只見列表；搜尋圖示展開搜尋框並可輸入過濾；點一列顯示卡片，`返回` 回列表；設定與新增圖示按鈕可開啟對應彈窗。
8. 既有 24 個情境（設定、列表、輪播、複製、標記、新增、編輯、刪除、送到套版）全部維持通過，必要時只改選擇器。
9. 全程無 `pageerror`、無原生對話框、無 CSP 違規（監看 console 的 `Content Security Policy` 訊息）。

**手動**：在實機 Chrome 與手機各看一次淺色與深色，確認頂欄模糊效果、卡片固定、展開動畫與觸控操作。

## 7. 風險與取捨

- 拿掉 `.app` 外框後，彈窗與頁面其他規則可能依賴它的背景／圓角；改版時逐一檢查，由 E2E 與第 6 節的手動目視把關。
- `backdrop-filter` 在少數舊瀏覽器不支援，退回不透明白底，不影響功能。
- 固定高度卡片在視窗很矮（< 500px）時內部捲動區變小；此時改為 `position:static`（媒體查詢 `max-height:500px`），回到隨頁面捲動。
