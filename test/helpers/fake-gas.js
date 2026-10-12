// 假的 Google Apps Script 物件，只模擬測試需要的行為（含幾項真實 API 的保真規則）
const TOKEN = 't'.repeat(48);
const SHEET_ID = 'TEST_SHEET';
const DATE_FMT = 'yyyy/MM/dd HH:mm';

function createFakeGas(opts = {}) {
  const gas = {
    now: opts.now || Date.UTC(2026, 9, 12, 4, 0, 0),
    props: { API_TOKEN: TOKEN, SHEET_ID },
    lockHeld: false,
    urlFetch: () => ({ code: 200, text: '' }),
    spreadsheetThrows: null,
    calls: { spreadsheetOpens: 0, urlFetches: [], logs: [], timezone: null },
    opLog: [],
    setNow(ms) { gas.now = ms; },
    setProperty(k, v) { if (v === null) delete gas.props[k]; else gas.props[k] = v; }
  };
  const sheets = new Map();   // name -> { rows: any[][], fmt: Map('r,c' -> format) }

  function makeSheet(name) {
    const data = { rows: [], fmt: new Map() };
    sheets.set(name, data);
    const cell = (r, c) => (data.rows[r - 1] && data.rows[r - 1][c - 1] !== undefined ? data.rows[r - 1][c - 1] : '');
    const sheet = {
      getName: () => name,
      getLastRow() {
        for (let i = data.rows.length - 1; i >= 0; i--) if (data.rows[i].some((v) => v !== '' && v != null)) return i + 1;
        return 0;
      },
      getRange(r, c, nr = 1, nc = 1) {
        if (nr < 1 || nc < 1 || r < 1 || c < 1) throw new Error('範圍無效');   // 真實 API 如此
        return {
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(cell(r + i, c + j)); out.push(row); }
            return out;
          },
          setNumberFormat(f) {
            gas.opLog.push({ op: 'setNumberFormat', sheet: name, r, c, nr, nc, fmt: f });
            for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) data.fmt.set((r + i) + ',' + (c + j), f);
            return this;
          },
          setValues(vals) {
            if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error('值的大小與範圍不符');
            gas.opLog.push({ op: 'setValues', sheet: name, r, c, nr, nc });
            vals.forEach((row, i) => row.forEach((v, j) => {
              while (data.rows.length < r + i) data.rows.push([]);
              const rr = data.rows[r + i - 1]; while (rr.length < c + j) rr.push('');
              const f = data.fmt.get((r + i) + ',' + (c + j));
              let stored = v;
              if (f === '@') stored = v instanceof Date ? v : String(v);
              else if (typeof v === 'string' && v.startsWith('=')) stored = '#FORMULA';
              else if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) stored = Number(v);
              rr[c + j - 1] = stored;
            }));
            return this;
          },
          setValue(v) { return this.setValues([[v]]); }
        };
      },
      deleteRow(row) { gas.opLog.push({ op: 'deleteRow', sheet: name, row }); data.rows.splice(row - 1, 1); }
    };
    return sheet;
  }
  const sheetObjs = new Map();
  const ss = {
    getSheetByName: (n) => (sheets.has(n) ? sheetObjs.get(n) : null),
    getSheets: () => [...sheetObjs.values()],
    insertSheet(n) {
      if (sheets.has(n)) throw new Error('同名分頁已存在');
      const s = makeSheet(n); sheetObjs.set(n, s); return s;
    },
    setSpreadsheetTimeZone(tz) { gas.calls.timezone = tz; },
    getName: () => '測試試算表'
  };
  gas.deleteSheet = (n) => { sheets.delete(n); sheetObjs.delete(n); };
  gas.dump = (n) => sheets.get(n).rows.map((r) => r.slice());
  // 模擬使用者在試算表手動編輯：把列接在現有內容後面（不經過格式與驗證）
  gas.seedRows = (n, rows) => {
    const s = sheetObjs.get(n), d = sheets.get(n);
    let at = s.getLastRow();
    rows.forEach((row) => { d.rows[at++] = row.slice(); });
  };
  gas.spreadsheet = ss;

  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(gas.now); else super(...a); }
    static now() { return gas.now; }
    static [Symbol.hasInstance](v) { return Date[Symbol.hasInstance](v); }   // 測試端建立的真 Date 也要被視為 Date
  }
  const FakeJSON = {
    parse: (s, r) => JSON.parse(s, r),
    stringify(v, replacer, space) {
      return JSON.stringify(v, function (k, val) {
        if (this[k] instanceof Date) throw new Error('回應含有 Date，無法序列化：' + k);
        return replacer ? replacer.call(this, k, val) : val;
      }, space);
    }
  };
  const log = (...a) => gas.calls.logs.push(a.map(String).join(' '));
  gas.globals = () => ({
    SpreadsheetApp: {
      openById(id) {
        gas.calls.spreadsheetOpens++;
        if (gas.spreadsheetThrows) throw new Error(gas.spreadsheetThrows);
        if (id !== SHEET_ID) throw new Error('找不到試算表');
        return ss;
      }
    },
    LockService: { getScriptLock: () => ({
      waitLock() { if (gas.lockHeld) throw new Error('Lock timeout'); },
      releaseLock() {}
    }) },
    UrlFetchApp: { fetch(url, o) {
      gas.calls.urlFetches.push({ url, opts: o });
      const r = gas.urlFetch(url, o);
      return { getResponseCode: () => r.code, getContentText: () => r.text };
    } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in gas.props ? gas.props[k] : null),
      getKeys: () => Object.keys(gas.props)
    }) },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput(s) {
      return { content: s, mime: null, setMimeType(m) { this.mime = m; return this; }, getContent() { return this.content; } };
    } },
    Logger: { log },
    console: { log, error: log, warn: log },
    Date: FakeDate,
    JSON: FakeJSON
  });
  return gas;
}

module.exports = { createFakeGas, TOKEN, SHEET_ID, DATE_FMT };
