// 掃描疑似機密：真實的 Apps Script 部署網址、48 字元十六進位密碼、寫死的 API_TOKEN
const RULES = [
  ['deployment-url', /\/macros\/s\/AKfycb[\w-]{20,}/],
  ['token-hex48', /\b[0-9a-f]{48}\b/i],
  ['token-assignment', /API_TOKEN['"]?\s*[:=]\s*['"][^'"\s]{16,}['"]/]
];

function findSecrets(text) {
  return RULES.filter(function (r) { return r[1].test(text); }).map(function (r) { return r[0]; });
}

module.exports = { findSecrets };
