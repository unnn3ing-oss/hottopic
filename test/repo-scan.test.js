const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { findSecrets } = require('../scripts/scan-secrets.js');

// 陽性樣本在執行時組出，測試檔本身不含樣本字面值
test('findSecrets 命中疑似機密', () => {
  assert.deepEqual(findSecrets('https://script.google.com/macros/s/' + 'AKfycb' + 'x'.repeat(30) + '/exec'), ['deployment-url']);
  assert.deepEqual(findSecrets('a'.repeat(48)), ['token-hex48']);
  assert.deepEqual(findSecrets("API_TOKEN = '" + 'z'.repeat(20) + "'"), ['token-assignment']);
});

test('findSecrets 不誤判測試假值與雜湊', () => {
  assert.deepEqual(findSecrets('https://script.google.com/macros/s/TEST_DEPLOYMENT/exec'), []);
  assert.deepEqual(findSecrets('PASTE_EXEC_URL'), []);
  assert.deepEqual(findSecrets('a'.repeat(40)), []);   // git sha
  assert.deepEqual(findSecrets('a'.repeat(64)), []);   // sha-256
});

test('repo 內所有受版控文字檔都沒有疑似機密', () => {
  const root = path.join(__dirname, '..');
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .toString('utf8').split('\0').filter(Boolean);
  const hits = [];
  for (const f of files) {
    if (f === 'package-lock.json') continue;
    const buf = fs.readFileSync(path.join(root, f));
    if (buf.includes(0)) continue;   // 二進位
    const found = findSecrets(buf.toString('utf8'));
    if (found.length) hits.push(f + ': ' + found.join(','));
  }
  assert.deepEqual(hits, []);
});
