/* 分頁純函式：不碰 DOM，Node 與瀏覽器共用。語法限 ES2019 以內。 */
var HotNewsPaging = (function () {
  var PAGE_SIZES = [5, 10, 15, 20];
  var DEFAULT_SIZE = 10;

  // 只接受數字或全數字字串，且要在 PAGE_SIZES 內；其餘（含壞掉的儲存值）一律用預設
  function normalizeSize(v) {
    var n;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && /^\d+$/.test(v)) n = Number(v);
    else return DEFAULT_SIZE;
    return PAGE_SIZES.indexOf(n) === -1 ? DEFAULT_SIZE : n;
  }

  function pageCount(total, size) { return Math.max(1, Math.ceil(total / size)); }

  function clampPage(page, pages) {
    var n = Math.trunc(Number(page));
    if (!isFinite(n)) return 1;
    return Math.min(Math.max(n, 1), pages);
  }

  function slicePage(list, page, size) { return list.slice((page - 1) * size, page * size); }

  function pageOf(list, id, size) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return Math.floor(i / size) + 1;
    return 0;
  }

  // 頁碼列：第 1 頁、最後一頁、目前頁±1；不連續處放 '…'；7 頁以內全列
  function pageWindow(page, pages) {
    var out = [], i;
    if (pages <= 7) { for (i = 1; i <= pages; i++) out.push(i); return out; }
    var keep = [1, pages, page - 1, page, page + 1].filter(function (n) { return n >= 1 && n <= pages; });
    keep = keep.filter(function (n, k) { return keep.indexOf(n) === k; }).sort(function (a, b) { return a - b; });
    keep.forEach(function (n, k) {
      if (k && n - keep[k - 1] > 1) out.push('…');
      out.push(n);
    });
    return out;
  }

  return { PAGE_SIZES: PAGE_SIZES, normalizeSize: normalizeSize, pageCount: pageCount, clampPage: clampPage,
    slicePage: slicePage, pageOf: pageOf, pageWindow: pageWindow };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = HotNewsPaging; }
