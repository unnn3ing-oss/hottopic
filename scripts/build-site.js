// 把 web/* 與 apps-script/lib.js 複製到輸出目錄，資源網址加上 ?v=<sha 前 12 碼>
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FILES = [
  ['web/index.html', 'index.html'], ['web/app.css', 'app.css'], ['web/app.js', 'app.js'],
  ['web/api.js', 'api.js'], ['web/qpt.js', 'qpt.js'], ['apps-script/lib.js', 'lib.js']
];

function resolveSha(sha) {
  let v = sha || process.env.GITHUB_SHA;
  if (!v) { try { v = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch (e) { v = ''; } }
  return /^[0-9a-f]{7,40}$/.test(v) ? v.slice(0, 12) : 'dev';
}

function buildSite(opts) {
  const outDir = path.resolve(opts.outDir);
  const v = resolveSha(opts.sha);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const [from, to] of FILES) {
    let data = fs.readFileSync(path.join(ROOT, from));
    if (to === 'index.html') {
      data = data.toString('utf8').replace(/(href|src)="(app\.css|lib\.js|api\.js|qpt\.js|app\.js)"/g, '$1="$2?v=' + v + '"');
    }
    fs.writeFileSync(path.join(outDir, to), data);
  }
  return { outDir, files: FILES.map((f) => f[1]) };
}

if (require.main === module) {
  const r = buildSite({ outDir: process.argv[2] || '_site' });
  console.log('built ' + r.files.length + ' files into ' + r.outDir);
}

module.exports = { buildSite };
