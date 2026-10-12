const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 在沒有 URL / TextEncoder / DOM 的沙箱載入 lib.js，等同 Apps Script 環境
function createLibContext() {
  const ctx = vm.createContext({ module: { exports: {} } });
  const file = path.join(__dirname, '..', '..', 'apps-script', 'lib.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return ctx;
}

function loadLib() {
  return createLibContext().module.exports;
}

module.exports = { loadLib, createLibContext };
