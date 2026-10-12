const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'pages.yml'), 'utf8');
const deployBlock = yml.slice(yml.indexOf('\n  deploy:'));
const testBlock = yml.slice(yml.indexOf('\n  test:'), yml.indexOf('\n  deploy:'));

test('只有 main 的 push 會部署，且部署前必須先通過測試', () => {
  assert.match(yml, /branches: \[main\]/);
  assert.match(deployBlock, /needs: test/);
  assert.match(deployBlock, /github\.event_name == 'push'/);
  assert.match(deployBlock, /refs\/heads\/main/);
  assert.doesNotMatch(yml, /pull_request_target/);
});

test('寫入權限只出現在 deploy job', () => {
  assert.doesNotMatch(testBlock, /pages: write|id-token: write/);
  assert.match(deployBlock, /pages: write/);
  assert.match(deployBlock, /id-token: write/);
  assert.match(yml, /^permissions:\n  contents: read/m);
});

test('使用的 action 版本', () => {
  for (const a of ['actions/checkout@v7', 'actions/setup-node@v7', 'actions/configure-pages@v6',
    'actions/upload-pages-artifact@v5', 'actions/deploy-pages@v5']) assert.ok(yml.includes(a), a);
});

test('test job 跑單元與 e2e 測試', () => {
  assert.match(testBlock, /npm test/);
  assert.match(testBlock, /npm run test:e2e/);
});
