# Apps Script 冒煙測試（跨網站呼叫）

用途：確認「GitHub Pages 網頁 → Apps Script Web App」這條路在你的帳號上真的通。實作前先做一次；日後網頁出現「連不上」時可重跑，分辨是 Google 端變了還是程式的問題。

> 測試用一份**拋棄式**的試算表、**拋棄式**的密碼與部署。正式版另外產生新的密碼與新的部署網址。

## 1. 建立測試用 Apps Script

專案可以是「從試算表開的」（擴充功能 → Apps Script），也可以是「在 script.google.com 直接新增的獨立專案」，**兩種都行**。程式一律用試算表 ID（`SHEET_ID`）開啟試算表，不依賴「綁定」。

1. 新增一份空白 Google 試算表，記下網址中的 ID：`https://docs.google.com/spreadsheets/d/`**`這一段`**`/edit`。
2. 開啟 Apps Script 專案 → 專案設定 → 勾選「在編輯器中顯示 appsscript.json 資訊清單檔案」，把內容換成：

```json
{
  "timeZone": "Asia/Taipei",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
}
```

> 為什麼不是 `spreadsheets.currentonly`：那個範圍只適用「綁定在試算表上」的專案；用 `openById` 開檔需要完整的 `spreadsheets` 範圍。改過範圍後，下面的 `authorize` 要重新執行一次。

3. 專案設定 → 指令碼屬性，新增兩個：
   - `API_TOKEN`：48 個字元的隨機字串。在任何網頁的 Console 貼這行就能產生：

     ```js
     Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')
     ```

   - `SHEET_ID`：第 1 步記下的試算表 ID。

4. 把 `Code.gs` 整份換成下面這段：

```js
function doGet() { return ContentService.createTextOutput('ok'); }

function sheet_() {   // 一律用 ID 開試算表，獨立專案與綁定專案都適用
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('指令碼屬性 SHEET_ID 未設定');
  return SpreadsheetApp.openById(id);
}

function authorize() {   // 執行一次，讓 Google 跳出授權畫面
  Logger.log('試算表名稱：' + sheet_().getName());
  UrlFetchApp.fetch('https://example.com', { muteHttpExceptions: true });
  PropertiesService.getScriptProperties().getKeys();
  LockService.getScriptLock();
}

function doPost(e) {
  var out, lock = LockService.getScriptLock();
  try {
    var req = JSON.parse(e.postData.contents);
    var tok = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
    if (!tok || tok.length < 32 || req.token !== tok) {
      out = { ok: false, code: 'unauthorized' };
    } else if (req.action === 'fetchTitle') {
      out = { ok: true, data: fetchTitleSpike_(req.args.url) };
    } else {
      lock.waitLock(5000);
      out = { ok: true, data: {
        action: req.action, args: req.args,
        contentType: e.postData.type, length: e.postData.length,
        sheets: sheetProbe_(),
        at: new Date().toISOString()
      } };
    }
  } catch (err) {
    out = { ok: false, code: 'server_error', detail: String(err) };   // 只有測試版才回傳細節
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function sheetProbe_() {   // 診斷：getActive 為 null = 獨立專案；openById 才是正式版要用的方式
  var r = {};
  try {
    var a = SpreadsheetApp.getActiveSpreadsheet();
    r.getActive = a ? 'ok:' + a.getSheets().length : 'null';
  } catch (e) { r.getActive = 'error: ' + e; }
  try {
    r.openById = 'ok:' + sheet_().getSheets().length;
  } catch (e) { r.openById = 'error: ' + e; }
  return r;
}

function fetchTitleSpike_(url) {
  var opts = {
    muteHttpExceptions: true, followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'zh-TW,zh;q=0.9'
    }
  };
  var timeoutOption, res;
  try {                                   // 看 timeoutSeconds 這個選項會不會被接受
    var withTimeout = JSON.parse(JSON.stringify(opts)); withTimeout.timeoutSeconds = 8;
    res = UrlFetchApp.fetch(url, withTimeout); timeoutOption = 'accepted';
  } catch (err) {
    timeoutOption = 'rejected or failed: ' + err;
    res = UrlFetchApp.fetch(url, opts);
  }
  var html = res.getContentText('UTF-8');
  var m = html.match(/<meta[^>]+property=["']og:title["'][^>]*>/i);
  return { status: res.getResponseCode(), length: html.length, ogTitle: m ? m[0] : null, timeoutOption: timeoutOption };
}
```

5. 編輯器上方選函式 `authorize` → 執行 → 依畫面完成授權（會看到「Google 尚未驗證這個應用程式」，選進階 → 前往，這是你自己的程式）。執行記錄應出現「試算表名稱：…」。
6. 部署 → 新增部署作業 → 類型選「網頁應用程式」→ 執行身分：**我** → 誰可以存取：**任何人** → 部署，複製 `/exec` 結尾的網址。
   - 已經有部署的話：部署 → 管理部署作業 → 鉛筆 → 版本選「新版本」→ 部署（網址不變）。**改過程式或資訊清單都要做這步**，`/exec` 只會跑最後一次部署的版本。

## 2. 從瀏覽器測試

開啟 `https://example.com`，按 F12 開 Console，先貼這段定義（填入你的網址與密碼）：

```js
const URL_ = 'PASTE_EXEC_URL', TOKEN = 'PASTE_TOKEN';
async function call(action, args, token = TOKEN, contentType = 'text/plain;charset=utf-8') {
  const t0 = performance.now();
  const r = await fetch(URL_, { method: 'POST', redirect: 'follow', credentials: 'omit',
    headers: { 'Content-Type': contentType }, body: JSON.stringify({ token, action, args }) });
  const txt = await r.text(), ms = Math.round(performance.now() - t0);
  let body; try { body = JSON.parse(txt); } catch (e) { body = 'NOT JSON: ' + txt.slice(0, 200); }
  return { status: r.status, redirected: r.redirected, finalUrl: r.url.slice(0, 70), type: r.headers.get('content-type'), ms, body };
}
```

再逐項執行並記下結果：

| # | 指令 | 預期 |
|---|---|---|
| T1 | `await call('ping', { msg: '台灣 ✓' })` | `status 200`、`redirected true`、`finalUrl` 在 `script.googleusercontent.com`、`body.ok true`、`msg` 中文沒亂碼、`data.sheets.openById` 為 `ok:1`（試算表有幾個分頁就是幾）。`getActive` 為 `null` 代表獨立專案，不影響結果 |
| T2 | `await call('ping', {}, 'wrong-token')` | `body` 為 `{ ok: false, code: 'unauthorized' }`，仍是 HTTP 200 |
| T3 | `await call('fetchTitle', { url: 'https://news.tvbs.com.tw/cars/4032757' })` | `status 200`、有 `ogTitle`；記下 `timeoutOption` 是 `accepted` 還是 `rejected…` |
| T4 | `await call('ping', {}, TOKEN, 'application/json')` | 預期**失敗**（CORS 或 `Failed to fetch`），證明一定要用 `text/plain` |
| T5 | 到指令碼屬性把 `API_TOKEN` 改成別的 48 字元字串（**不要重新部署**），再 `await call('ping', {})` | `unauthorized`（舊密碼立刻失效）；用新密碼 `await call('ping', {}, 'NEW_TOKEN')` 成功 |
| T6 | 隔約 10 分鐘後再執行 T1 | 記下 `ms`（冷啟動 vs 暖啟動） |

**把 T1、T3、T5、T6 的輸出貼回來即可（不要貼密碼與試算表 ID）。** T1 失敗（`Failed to fetch`）的常見原因：存取權不是「任何人」、貼的不是 `/exec` 結尾的網址、改過程式或資訊清單後沒有「管理部署作業 → 編輯 → 新版本」。`openById` 出現 `error: …` 則多半是授權範圍沒更新，重跑 `authorize` 並建立新版本。

## 3. 測完之後

刪掉測試用的部署（部署 → 管理部署作業 → 封存）與試算表，或保留作為日後的冒煙測試環境。正式版會用新的密碼與新的部署網址。
