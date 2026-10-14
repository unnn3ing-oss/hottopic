/* 「送到套版」傳送器：用 window.postMessage 把新聞網址與目前顯示的改標交給
 * Chrome 擴充功能「圖片套版產生器」（v4.50 以上）的橋接腳本，並用 nonce 配對它的回覆。
 * 沒有網路請求、不改任何資料。語法限 ES2019 以內。 */
var HotNewsQpt = (function () {
  var ACK_TIMEOUT_MS = 800;

  // 目前輪播到第 pos 版的改標；沒有改標就不帶 title（只送網址）
  function buildMessage(item, pos, nonce) {
    var msg = { source: 'hottopic', type: 'send-to-quickpattern', v: 1, nonce: nonce, url: item.url };
    var t = item.titles && item.titles[pos];
    if (t && typeof t.t === 'string' && t.t) msg.title = t.t;
    return msg;
  }

  // → Promise<{status:'opened'|'not_opened'|'no_extension'|'rejected', error?}>
  function send(opts) {
    var win = opts.win;
    var st = opts.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    var ct = opts.clearTimeout || function (id) { clearTimeout(id); };
    var origin = win.location.origin;
    return new Promise(function (resolve) {
      var timer = null;
      function done(result) {
        win.removeEventListener('message', onMessage);
        if (timer !== null) ct(timer);
        resolve(result);
      }
      function onMessage(event) {
        var d = event.data;
        if (event.source !== win || event.origin !== origin) return;
        if (!d || d.source !== 'quickpattern' || d.type !== 'ack' || d.nonce !== opts.nonce) return;
        if (!d.ok) return done({ status: 'rejected', error: d.error });
        done({ status: d.opened ? 'opened' : 'not_opened' });
      }
      win.addEventListener('message', onMessage);
      timer = st(function () { timer = null; done({ status: 'no_extension' }); }, opts.timeoutMs || ACK_TIMEOUT_MS);
      win.postMessage(buildMessage(opts.item, opts.pos, opts.nonce), origin);
    });
  }

  return { ACK_TIMEOUT_MS: ACK_TIMEOUT_MS, buildMessage: buildMessage, send: send };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = HotNewsQpt; }
