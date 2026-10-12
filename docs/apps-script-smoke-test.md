# Apps Script 冒煙測試（跨網站呼叫）

用途：確認「GitHub Pages 網頁 → Apps Script Web App」這條路在你的帳號上真的通。實作前先做一次；日後網頁出現「連不上」時可重跑，分辨是 Google 端變了還是程式的問題。

> 測試用一份**拋棄式**的試算表、**拋棄式**的密碼與部署。正式版另外產生新的密碼與新的部署網址。

## 1. 建立測試用 Apps Script

1. 新增一份空白 Google 試算表 → 擴充功能 → Apps Script。
2. 專案設定 → 勾選「在編輯器中顯示 appsscript.json 資訊清單檔案」，把內容換成：

```json
{
  "timeZone": "Asia/Taipei",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets.currentonly",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
}
```

3. 把 `Code.gs` 整份換成下面這段：

```js
function doGet() { return ContentService.createTextOutput('ok'); }

function authorize() {   // 執行一次，讓 Google 跳出授權畫面
  SpreadsheetApp.getActiveSpreadsheet().getName();
  UrlFetchApp.fetch('https://example.com', { muteHttpExceptions: true });
  PropertiesService.getScriptProperties().getKeys();
  LockService.getScriptLock();
}

function setupSpike() {   // 在編輯器執行一次：記下這份試算表的 ID
  var id = SpreadsheetApp.getActiveSpreadsheet().getId();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', id);
  Logger.log('SHEET_ID 已儲存，長度 ' + id.length);
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

function sheetProbe_() {   // 比較兩種取得試算表的方式
  var r = {};
  try {
    var a = SpreadsheetApp.getActiveSpreadsheet();
    r.getActive = a ? 'ok:' + a.getSheets().length : 'null';
  } catch (e) { r.getActive = 'error: ' + e; }
  try {
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    r.openById = 'ok:' + SpreadsheetApp.openById(id).getSheets().length;
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

4. 專案設定 → 指令碼屬性 → 新增 `API_TOKEN`，值為 48 個字元的隨機字串。在任何網頁的 Console 貼這行就能產生：

```js
Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')
```

5. 編輯器上方選函式 `authorize` → 執行 → 依畫面完成授權（會看到「Google 尚未驗證這個應用程式」，選進階 → 前往，這是你自己的程式）。
6. 再選函式 `setupSpike` → 執行，看到「SHEET_ID 已儲存」即可。這一步是因為**網頁應用程式裡 `getActiveSpreadsheet()` 取不到試算表**（2026-10-12 實測回傳 `null`），改用記下 ID 再 `openById` 的方式。
7. 部署 → 新增部署作業 → 類型選「網頁應用程式」→ 執行身分：**我** → 誰可以存取：**任何人** → 部署，複製 `/exec` 結尾的網址。

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
| T1 | `await call('ping', { msg: '台灣 ✓' })` | `status 200`、`redirected true`、`finalUrl` 在 `script.googleusercontent.com`、`body.ok true`、`msg` 中文沒亂碼、`data.sheets` 為 `{ getActive: 'null', openById: 'ok:1' }`（`getActive` 實測為 `null`；`openById` 若出現權限錯誤，把資訊清單的 `spreadsheets.currentonly` 換成 `https://www.googleapis.com/auth/spreadsheets`，重跑 `authorize`、建立新版本再測） |
| T2 | `await call('ping', {}, 'wrong-token')` | `body` 為 `{ ok: false, code: 'unauthorized' }`，仍是 HTTP 200 |
| T3 | `await call('fetchTitle', { url: 'https://news.tvbs.com.tw/cars/4032757' })` | `status 200`、有 `ogTitle`；記下 `timeoutOption` 是 `accepted` 還是 `rejected…` |
| T4 | `await call('ping', {}, TOKEN, 'application/json')` | 預期**失敗**（CORS 或 `Failed to fetch`），證明一定要用 `text/plain` |
| T5 | 到指令碼屬性把 `API_TOKEN` 改成別的 48 字元字串（**不要重新部署**），再 `await call('ping', {})` | `unauthorized`（舊密碼立刻失效）；用新密碼 `await call('ping', {}, 'NEW_TOKEN')` 成功 |
| T6 | 隔約 10 分鐘後再執行 T1 | 記下 `ms`（冷啟動 vs 暖啟動） |

**把 T1、T3、T5、T6 的輸出貼回來即可。** T1 失敗（`Failed to fetch`）的常見原因：存取權不是「任何人」、貼的不是 `/exec` 結尾的網址、改過程式後沒有「管理部署作業 → 編輯 → 新版本」。

## 3. 測完之後

刪掉測試用的部署（部署 → 管理部署作業 → 封存）與試算表，或保留作為日後的冒煙測試環境。正式版會用新的密碼與新的部署網址。
