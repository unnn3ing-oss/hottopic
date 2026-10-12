const fs = require('node:fs');
const path = require('node:path');
const { TOKEN } = require('./fake-gas.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', f), 'utf8');

// 以 lib.js + Code.gs 組成與 Apps Script 相同的全域範圍；測試一律經由 doPost
function loadBackend({ gas }) {
  const globals = gas.globals();
  const names = Object.keys(globals);
  const src = read('lib.js') + '\n' + read('Code.gs') + '\nreturn { doGet: doGet, doPost: doPost, setup: setup };';
  const fns = new Function(...names, src)(...names.map((n) => globals[n]));
  function raw(body) { return fns.doPost({ postData: { contents: body, type: 'text/plain' } }).getContent(); }
  function call(action, args, o = {}) {
    const token = 'token' in o ? o.token : TOKEN;
    return JSON.parse(raw(JSON.stringify({ token, action, args: args || {} })));
  }
  return { raw, call, gas, doGet: fns.doGet, setup: fns.setup };
}

module.exports = { loadBackend };
