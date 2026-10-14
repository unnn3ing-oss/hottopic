/* 熱門新聞庫：畫面與互動。所有來自伺服器或使用者的文字一律以 textContent 輸出。
 * 依賴 lib.js（extractId、normalizeUrl、buildComment…）與 api.js（HotNewsApi）。 */
(function () {
  'use strict';

  var DAY = 864e5;
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var state = {
    items: [], cats: [], status: 'idle', error: '', cat: '全部', q: '', sort: 'oldest',
    pos: {}, pendingMark: null, markTimer: null, busy: new Set(),
    editing: null, draft: [], removed: [], saving: false, delTimer: null,
    fetchSeq: 0, lastFetchUrl: null, origTouched: false, catTouched: false,
    sel: null, copied: null
  };
  var MOBILE = window.matchMedia ? window.matchMedia('(max-width: 820px)') : { matches: false };

  var api = HotNewsApi.createClient({
    fetch: function (u, i) { return window.fetch(u, i); },
    storage: {
      getItem: function (k) { return window.localStorage.getItem(k); },
      setItem: function (k, v) { window.localStorage.setItem(k, v); },
      removeItem: function (k) { window.localStorage.removeItem(k); }
    },
    setTimeout: function (f, ms) { return window.setTimeout(f, ms); },
    clearTimeout: function (t) { window.clearTimeout(t); },
    AbortController: window.AbortController
  });

  function $(id) { return document.getElementById(id); }

  // 建立 DOM：文字一律 textContent；函式屬性用 addEventListener（不產生行內事件屬性）
  function h(tag, props) {
    var el = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === false || v == null) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (typeof v === 'function') el.addEventListener(k, v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function ago(ms) { var d = Math.floor((Date.now() - ms) / DAY); return d <= 0 ? '今天' : d + ' 天前'; }
  function byId(id) { return state.items.filter(function (i) { return i.id === id; })[0]; }
  function posOf(it) { return Math.min(state.pos[it.id] || 0, Math.max(it.titles.length - 1, 0)); }
  function replaceItem(item) {
    var i = state.items.findIndex(function (x) { return x.id === item.id; });
    if (i === -1) state.items.push(item); else state.items[i] = item;
  }

  /* ---------- 提示、複製 ---------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  // 複製成功才顯示 okMsg 並呼叫 onOk（例如記下「已複製標題」）
  function copyText(text, okMsg, onOk) {
    function done(ok) {
      if (!ok) { toast('複製失敗，請手動選取'); return; }
      toast(okMsg);
      if (onOk) onOk();
    }
    function fallback() {
      var ta = h('textarea', { class: 'sr-copy', 'aria-hidden': 'true' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else fallback();
  }

  /* ---------- 呼叫伺服器 ---------- */
  function callApi(action, args) {
    return api.call(action, args).catch(function (e) {
      if (e.code === 'unauthorized' || e.code === 'no_config') openSettings(e.code === 'unauthorized' ? '登入已過期或密碼已更換，請重新登入。' : '');
      throw e;
    });
  }
  function fail(e) {
    if (e && (e.code === 'unauthorized' || e.code === 'no_config')) return;
    toast((e && e.message) || '發生錯誤，請稍後再試。');
  }
  // 寫入類動作：連線中斷／逾時不確定結果 → 重新載入；stale／not_found → 顯示訊息並重新載入。成功回傳資料，已處理的失敗回傳 undefined
  function mutate(action, args) {
    return callApi(action, args).catch(function (e) {
      if (e.unknown) { toast('連線中斷，結果不確定，已重新載入列表'); loadItems(); return undefined; }
      if (e.code === 'stale' || e.code === 'not_found') { toast(e.message); loadItems(); return undefined; }
      throw e;
    });
  }

  function loadItems() {
    state.status = 'loading';
    render();
    return callApi('listItems', {}).then(function (data) {
      state.items = data.items || [];
      state.cats = data.cats || [];
      state.status = 'ready';
      render();
    }).catch(function (e) {
      state.status = 'error';
      state.error = e && e.message ? e.message : '載入失敗。';
      render();
    });
  }

  /* ---------- 列表 ---------- */
  function allCats() {
    var out = state.cats.slice();
    state.items.forEach(function (i) { if (i.cat && out.indexOf(i.cat) === -1) out.push(i.cat); });
    return out;
  }

  function visibleItems() {
    var q = state.q.trim().toLowerCase();
    var r = state.items.filter(function (it) {
      if (state.cat !== '全部' && it.cat !== state.cat) return false;
      if (!q) return true;
      var all = it.id + ' ' + it.orig + ' ' + it.note + ' ' + it.titles.map(function (v) { return v.t; }).join(' ');
      return all.toLowerCase().indexOf(q) > -1;
    });
    var s = state.sort;
    r.sort(function (a, b) {
      if (s === 'oldest') return (a.last == null ? -1 : a.last) - (b.last == null ? -1 : b.last);
      if (s === 'recent') return (b.last || 0) - (a.last || 0);
      if (s === 'count') return b.count - a.count;
      return b.created - a.created;
    });
    return r;
  }

  function renderChips() {
    var box = $('chips');
    var names = ['全部'].concat(allCats());
    if (state.cat !== '全部' && names.indexOf(state.cat) === -1) state.cat = '全部';
    box.replaceChildren.apply(box, names.map(function (c) {
      var n = c === '全部' ? state.items.length : state.items.filter(function (i) { return i.cat === c; }).length;
      return h('button', { type: 'button', class: 'chip', 'data-cat': c, 'aria-pressed': String(state.cat === c) },
        c, h('small', { text: String(n) }));
    }));
  }

  function markLabel(confirming, n, p) { return confirming ? '再按一次確認' + (n > 1 ? '（第 ' + (p + 1) + ' 版）' : '') : '標記已使用'; }

  function rowTitle(it) { return it.titles.length ? it.titles[0].t.replace(/\s*\n\s*/g, ' ') : it.orig; }

  function buildRow(it) {
    var n = it.titles.length;
    return h('div', { class: 'row', role: 'option', tabindex: '0', 'data-id': it.id, 'aria-selected': String(it.id === state.sel) },
      h('h3', { text: rowTitle(it) }),
      it.last == null ? h('span', { class: 'badge fresh', text: '從未使用' }) : h('span', { class: 'badge', text: ago(it.last) }),
      h('div', { class: 'sub' }, h('span', { class: 'cat', text: it.cat }), h('span', { class: 'id', text: it.id }),
        n > 1 ? h('span', { class: 'vcount', text: n + ' 版' }) : null));
  }

  function buildCard(it) {
    var n = it.titles.length, p = posOf(it);
    var confirming = !!(state.pendingMark && state.pendingMark.id === it.id && state.pendingMark.idx === p);
    var used = it.last == null
      ? h('span', { class: 'used never' }, h('b', { text: '從未使用' }), ' · 使用 0 次')
      : h('span', { class: 'used' }, '上次使用 ', h('b', { text: fmt(it.last) }), '（' + ago(it.last) + '）· 共 ' + it.count + ' 次');
    var titles, dots = null;
    if (!n) titles = h('div', { class: 'car' }, h('p', { class: 'title empty', text: '（尚未改標）' }));
    else {
      var car = h('div', { class: 'car' + (n > 1 ? ' multi' : ''), tabindex: '0', 'aria-label': n > 1 ? '改標，可左右滑動或用方向鍵切換' : '改標' });
      it.titles.forEach(function (v) {
        var info = v.last == null ? '此版本尚未使用' : '此版本上次使用 ' + fmt(v.last) + ' · ' + v.count + ' 次';
        car.appendChild(h('div', { class: 'slide' }, h('p', { class: 'title', text: v.t }), h('div', { class: 'vinfo', text: info })));
      });
      titles = h('div', { class: 'carwrap' }, car);
      if (n > 1) {
        titles.appendChild(h('button', { type: 'button', class: 'arrow l', 'data-act': 'prev', 'aria-label': '上一個改標', disabled: p === 0 }, '‹'));
        titles.appendChild(h('button', { type: 'button', class: 'arrow r', 'data-act': 'next', 'aria-label': '下一個改標', disabled: p === n - 1 }, '›'));
        dots = h('div', { class: 'dots', role: 'group', 'aria-label': '切換改標' });
        it.titles.forEach(function (_, i) {
          dots.appendChild(h('button', { type: 'button', class: 'dot' + (i === p ? ' on' : ''), 'data-act': 'dot', 'data-i': String(i), 'aria-label': '第 ' + (i + 1) + ' 版' }));
        });
      }
    }
    return h('article', { class: 'item', 'data-id': it.id },
      h('div', { class: 'chead' },
        h('button', { type: 'button', class: 'back', 'data-act': 'back', 'aria-label': '返回列表' }, '‹'),
        h('span', { class: 'ctitle' }, '新聞', h('small', { text: '#' + it.id })),
        h('span', { class: 'cat', text: it.cat }), used),
      h('div', { class: 'orig', title: it.orig }, h('span', { class: 'tag', text: '原始' }), h('span', { class: 'ot', text: it.orig })),
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: '改標' }), titles, dots),
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: '小編文' }),
        it.note ? h('p', { class: 'note', text: it.note }) : h('p', { class: 'note empty', text: '（尚無小編文）' })),
      h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'btn', 'data-act': 'ctitle', disabled: !n || state.busy.has(it.id) }, '複製標題'),
        h('button', { type: 'button', class: 'btn', 'data-act': 'cnote' }, '複製留言'),
        h('button', { type: 'button', class: 'btn', 'data-act': 'qpt', disabled: !it.url }, '送到套版'),
        h('button', { type: 'button', class: 'btn primary' + (confirming ? ' confirm' : ''), 'data-act': 'mark', disabled: state.busy.has(it.id) }, markLabel(confirming, n, p)),
        h('button', { type: 'button', class: 'btn', 'data-act': 'edit' }, '編輯')));
  }

  function stateBox(text, btnText, act) {
    var box = h('div', { class: 'state' }, h('div', { text: text }));
    if (btnText) box.appendChild(h('button', { type: 'button', class: 'btn primary', 'data-act': act }, btnText));
    return box;
  }

  function showDetail(on) { document.body.classList.toggle('detail', !!on); }

  function renderCard(empty) {
    var box = $('card'), it = !empty && state.sel ? byId(state.sel) : null;
    drag = null;
    box.replaceChildren(it ? buildCard(it) : h('div', { class: 'card-empty', text: '從左邊選一則新聞，這裡會顯示改標、小編文和複製按鈕。' }));
    var car = box.querySelector('.car');
    if (it && car && it.titles.length) car.scrollLeft = posOf(it) * stepOf(car);
  }

  function render() {
    var list = $('list');
    renderChips();
    function plain(node) { list.replaceChildren(node); $('cnt').textContent = ''; showDetail(false); renderCard(true); }
    if (state.status === 'loading') { plain(stateBox('載入中…')); return; }
    if (state.status === 'error') { plain(stateBox(state.error || '載入失敗。', '重試', 'retry')); return; }
    if (state.status === 'idle') { plain(stateBox('尚未連線。請先到「設定」輸入 Worker 網址與密碼。', '開啟設定', 'settings')); return; }
    if (!state.items.length) { plain(stateBox('還沒有任何新聞。', '＋ 新增新聞', 'add-first')); return; }
    var r = visibleItems();
    $('cnt').textContent = '共 ' + r.length + ' 則';
    if (!r.length) { list.replaceChildren(h('div', { class: 'none', text: '沒有符合的新聞。調整搜尋或分類，或按「＋ 新增新聞」。' })); state.sel = null; showDetail(false); renderCard(true); return; }
    if (!r.some(function (i) { return i.id === state.sel; })) {   // 目前選的不在清單裡：改選第一則
      state.sel = r[0].id; state.copied = null; state.pendingMark = null; showDetail(false);
    }
    list.replaceChildren.apply(list, r.map(buildRow));
    renderCard();
  }

  function selectItem(id) {
    if (state.sel !== id) { state.sel = id; state.copied = null; clearPending(); }
    Array.prototype.forEach.call($('list').querySelectorAll('.row'), function (r) { r.setAttribute('aria-selected', String(r.getAttribute('data-id') === id)); });
    if (MOBILE.matches) { showDetail(true); window.scrollTo(0, 0); }
    renderCard();
  }

  /* ---------- 改標輪播（移植自已核准的預覽） ---------- */
  var drag = null;
  function stepOf(car) { return car.children.length > 1 ? car.children[1].offsetLeft - car.children[0].offsetLeft : car.clientWidth; }
  function idxOf(car) { return Math.max(0, Math.min(car.children.length - 1, Math.round(car.scrollLeft / (stepOf(car) || 1)))); }
  function goTo(car, i) {
    i = Math.max(0, Math.min(car.children.length - 1, i));
    car._anim = (car._anim || 0) + 1;                        // 取消還在跑的拖曳回彈動畫，避免它把位置拉回去
    car._busy = false; car.classList.remove('dragging');
    car.scrollTo({ left: i * stepOf(car), behavior: REDUCED ? 'auto' : 'smooth' });
  }
  function animateScroll(car, to, done) {
    var from = car.scrollLeft, t0 = performance.now(), dur = REDUCED ? 0 : 220, token = car._anim = (car._anim || 0) + 1;
    if (!dur || Math.abs(to - from) < 1) { car.scrollLeft = to; done(); return; }
    (function tick(now) {
      if (car._anim !== token) return;                       // 被 goTo 取消
      var k = Math.min(1, (now - t0) / dur);
      car.scrollLeft = from + (to - from) * (1 - Math.pow(1 - k, 3));
      if (k < 1) requestAnimationFrame(tick); else done();
    })(t0);
  }
  function syncNav(itemEl, idx, n) {
    Array.prototype.forEach.call(itemEl.querySelectorAll('.dot'), function (d, i) { d.classList.toggle('on', i === idx); });
    var prev = itemEl.querySelector('[data-act=prev]'), next = itemEl.querySelector('[data-act=next]');
    if (prev) prev.disabled = idx === 0;
    if (next) next.disabled = idx === n - 1;
  }
  function clearPending() {
    state.pendingMark = null;
    clearTimeout(state.markTimer);
    var b = $('card').querySelector('[data-act=mark]');
    if (b) { b.textContent = markLabel(false); b.classList.remove('confirm'); }
  }

  var cardBox = $('card');
  cardBox.addEventListener('scroll', function (e) {
    var car = e.target;
    if (!car.classList || !car.classList.contains('car')) return;
    cancelAnimationFrame(car._r);
    car._r = requestAnimationFrame(function () {
      if (!car.clientWidth) return;
      var itemEl = car.closest('.item'), id = itemEl.getAttribute('data-id'), it = byId(id);
      if (!it) return;
      var idx = idxOf(car);
      state.pos[id] = idx;
      syncNav(itemEl, idx, it.titles.length);
      var pm = state.pendingMark;
      if (pm && pm.id === id && pm.idx !== idx) clearPending();
    });
  }, true);
  window.addEventListener('resize', function () {   // 斷點切換後把改標位置補回來
    var car = cardBox.querySelector('.car'), it = state.sel && byId(state.sel);
    if (car && it && it.titles.length && car.clientWidth) car.scrollLeft = posOf(it) * stepOf(car);
  });

  cardBox.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    var car = e.target.closest('.car');
    if (!car || car.children.length < 2 || car._busy) return;
    drag = { car: car, x: e.clientX, left: car.scrollLeft, start: idxOf(car) };
    car.classList.add('dragging');
    var sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();
    try { car.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
  cardBox.addEventListener('pointermove', function (e) { if (drag) drag.car.scrollLeft = drag.left - (e.clientX - drag.x); });
  function endDrag(e) {
    if (!drag) return;
    var car = drag.car, step = stepOf(car), moved = drag.x - e.clientX, target = drag.start;
    drag = null;
    if (Math.abs(moved) > Math.min(60, step * 0.15)) target += moved > 0 ? 1 : -1;
    target = Math.max(0, Math.min(car.children.length - 1, target));
    car._busy = true;
    animateScroll(car, target * step, function () { car._busy = false; car.classList.remove('dragging'); });
  }
  cardBox.addEventListener('pointerup', endDrag);
  cardBox.addEventListener('pointercancel', endDrag);
  cardBox.addEventListener('wheel', function (e) {
    var car = e.target.closest && e.target.closest('.car');
    if (!car || car.children.length < 2) return;
    var k = e.deltaMode === 1 ? 16 : 1, dx = e.deltaX * k, dy = e.deltaY * k;
    if (e.shiftKey && Math.abs(dy) > Math.abs(dx)) { dx = dy; dy = 0; }
    if (Math.abs(dx) <= Math.abs(dy)) return;          // 以直向為主就交給頁面捲動
    e.preventDefault();
    var now = performance.now();
    if (now - (car._lastWheel || 0) > 120) { car._done = false; car._acc = 0; }
    car._lastWheel = now;
    if (car._done) return;                              // 同一次橫滑（含觸控板慣性）只換一版
    car._acc += dx;
    if (Math.abs(car._acc) < 30) return;
    car._done = true;
    goTo(car, idxOf(car) + (car._acc > 0 ? 1 : -1));
  }, { passive: false });
  cardBox.addEventListener('keydown', function (e) {
    var car = e.target.closest && e.target.closest('.car');
    if (!car || car.children.length < 2 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    goTo(car, idxOf(car) + (e.key === 'ArrowRight' ? 1 : -1));
  });

  /* ---------- 清單：選取一則；載入失敗／空白時的按鈕 ---------- */
  var list = $('list');
  list.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (b) {
      var act = b.getAttribute('data-act');
      if (act === 'retry') loadItems();
      else if (act === 'settings') openSettings();
      else if (act === 'add-first') openDialog(null);
      return;
    }
    var row = e.target.closest('.row');
    if (row) selectItem(row.getAttribute('data-id'));
  });
  list.addEventListener('keydown', function (e) {
    var row = e.target.closest && e.target.closest('.row');
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectItem(row.getAttribute('data-id')); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
    if (!next || !next.classList.contains('row')) return;
    e.preventDefault();
    selectItem(next.getAttribute('data-id'));
    var again = list.querySelector('.row[data-id="' + next.getAttribute('data-id') + '"]');
    if (again) again.focus();
  });

  /* ---------- 卡片上的按鈕 ---------- */
  cardBox.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'back') { showDetail(false); return; }
    var itemEl = b.closest('.item');
    if (!itemEl) return;
    var id = itemEl.getAttribute('data-id'), it = byId(id);
    if (!it) return;
    var p = posOf(it), n = it.titles.length;
    if (act === 'ctitle') {
      var ver = it.titles[p].ver;
      copyText(it.titles[p].t, n > 1 ? '已複製第 ' + (p + 1) + ' 版標題' : '已複製標題', function () { state.copied = { id: id, ver: ver }; });
    } else if (act === 'cnote') {
      copyText(buildComment(it), '已複製留言', function () {
        var c = state.copied;
        if (c && c.id === id) { state.copied = null; autoMark(c); }   // 先複製標題、再複製同一篇的留言 → 視為已使用
      });
    } else if (act === 'qpt') sendToQpt(it, p);
    else if (act === 'edit') openDialog(it);
    else if (act === 'prev' || act === 'next' || act === 'dot') {
      var car = itemEl.querySelector('.car');
      if (car) goTo(car, act === 'dot' ? +b.getAttribute('data-i') : p + (act === 'next' ? 1 : -1));
    } else if (act === 'mark') markUsed(it, b, p);
  });

  // 把網址與目前顯示的改標交給 Chrome 擴充功能「圖片套版產生器」；不改任何資料、不標記已使用
  function qptNonce() {
    var a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }
  function sendToQpt(it, p) {
    HotNewsQpt.send({ win: window, item: it, pos: p, nonce: qptNonce() }).then(function (r) {
      if (r.status === 'opened') toast('已送到套版');
      else if (r.status === 'not_opened') toast('已傳給套版，請點一下工具列圖示打開側邊欄');
      else if (r.status === 'rejected') copyText(it.url, '套版擴充功能不接受這個網址（只收 tvbs.com.tw），已複製網址');
      else copyText(it.url, '沒偵測到套版擴充功能（需 v4.50 以上，並重新整理本頁），已複製網址');
    });
  }

  // 實際送出「已使用」。lead：提示文字的開頭（手動：已；複製留言觸發：已複製留言，並）
  function doMark(it, p, lead) {
    var n = it.titles.length;
    if (state.busy.has(it.id)) return;
    clearPending();
    if (state.copied && state.copied.id === it.id) state.copied = null;
    state.busy.add(it.id);
    var mb = $('card').querySelector('[data-act=mark]');
    if (mb) mb.disabled = true;
    var args = { id: it.id };
    if (n) args.ver = it.titles[p].ver;
    mutate('markUsed', args).then(function (data) {
      if (!data) return;
      replaceItem(data.item);
      var v = n ? data.item.titles.filter(function (x) { return x.ver === args.ver; })[0] : null;
      toast(v ? lead + '記錄第 ' + (p + 1) + ' 版使用，此版本共 ' + v.count + ' 次' : lead + '標記使用，共 ' + data.item.count + ' 次');
    }).catch(fail).then(function () { state.busy.delete(it.id); render(); });
  }

  function autoMark(c) {
    var it = byId(c.id);
    if (!it) return;
    var p = it.titles.findIndex(function (v) { return v.ver === c.ver; });
    if (p === -1) return;                                   // 那一版已被刪掉
    doMark(it, p, '已複製留言，並');
  }

  function markUsed(it, btn, p) {
    var n = it.titles.length, pm = state.pendingMark;
    if (state.busy.has(it.id)) return;
    if (!(pm && pm.id === it.id && pm.idx === p)) {       // 第一下：進入確認狀態，3 秒後還原
      clearPending();
      state.pendingMark = { id: it.id, idx: p };
      btn.textContent = markLabel(true, n, p);
      btn.classList.add('confirm');
      state.markTimer = setTimeout(clearPending, 3000);
      return;
    }
    doMark(it, p, '已');
  }

  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b) return;
    state.cat = b.getAttribute('data-cat');
    render();
  });
  $('q').addEventListener('input', function (e) { state.q = e.target.value; render(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  $('addBtn').addEventListener('click', function () { openDialog(null); });
  $('settingsBtn').addEventListener('click', function () { openSettings(); });

  /* ---------- 設定 ---------- */
  var STEPS = ['網址要完整複製（https://〈名稱〉.〈帳號〉.workers.dev）', 'Worker 已部署，且變數 ALLOWED_ORIGIN 設為 https://unnn3ing-oss.github.io', '確認網路連線正常'];
  function showSettingsMsg(msg, steps) {
    var m = $('sMsg'), s = $('sSteps');
    m.textContent = msg || ''; m.hidden = !msg;
    s.replaceChildren.apply(s, (steps || []).map(function (t) { return h('li', { text: t }); }));
    s.hidden = !(steps && steps.length);
  }
  function openSettings(reason) {
    var cfg = api.getConfig();
    $('sUrl').value = cfg.url || '';
    $('sToken').value = '';
    $('sRemember').checked = cfg.remember;
    $('sSave').disabled = false;
    showSettingsMsg(reason || '', null);
    if (!$('settingsDlg').open) $('settingsDlg').showModal();
  }
  $('settingsForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var url = $('sUrl').value, token = $('sToken').value, remember = $('sRemember').checked;
    $('sSave').disabled = true;
    showSettingsMsg('連線中…', null);
    api.login(url, token, remember).then(function () {
      $('sToken').value = '';
      $('settingsDlg').close();
      return loadItems();
    }).catch(function (err) {
      if (err.code === 'unauthorized') showSettingsMsg('密碼不正確。', null);
      else if (err.code === 'bad_request' || err.code === 'rate_limited') showSettingsMsg(err.message, null);
      else if (err.code === 'server_error') showSettingsMsg(err.message + '（請確認 Worker 的 Secrets 都已設定，且 Apps Script 的 API_TOKEN 與 Worker 一致。）', null);
      else showSettingsMsg('連不上伺服器：網址或部署的存取權可能不對。請檢查：', STEPS);
    }).then(function () { $('sSave').disabled = false; });
  });
  $('sClear').addEventListener('click', function () {
    api.clearConfig();
    $('sUrl').value = ''; $('sToken').value = ''; $('sRemember').checked = false;
    state.items = []; state.cats = []; state.status = 'idle';
    showSettingsMsg('已清除這台裝置的設定。', null);
    render();
  });

  /* ---------- 新增／編輯／刪除 ---------- */
  function fillCats(selected) {
    var sel = $('fCat'), names = allCats();
    if (selected && names.indexOf(selected) === -1) names.push(selected);
    sel.replaceChildren.apply(sel, names.map(function (c) { return h('option', { value: c, text: c }); }));
    if (selected) sel.value = selected;
  }

  function renderVars() {
    var box = $('vars'), d = state.draft;
    box.replaceChildren.apply(box, d.map(function (v, i) {
      var ta = h('textarea', { 'data-i': String(i), maxlength: String(LIMITS.title) });
      ta.value = v.t;
      return h('div', { class: 'v' },
        h('label', { text: '改標 ' + (i + 1) + '（可換行，顯示和複製都會保留）' }, ta),
        h('div', { class: 'vrow' },
          h('span', { class: 'vinfo', text: v.count ? '已使用 ' + v.count + ' 次' : '尚未使用' }),
          d.length > 1 ? h('button', { type: 'button', class: 'btn small', 'data-rm': String(i) }, '移除這版') : null));
    }));
  }
  $('vars').addEventListener('input', function (e) {
    var i = e.target.getAttribute('data-i');
    if (i !== null) state.draft[+i].t = e.target.value;
  });
  $('vars').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rm]');
    if (!b) return;
    var removed = state.draft.splice(+b.getAttribute('data-rm'), 1)[0];
    if (removed && removed.ver != null) state.removed.push(removed.ver);
    renderVars();
  });
  $('addVar').addEventListener('click', function () {
    state.draft.push({ ver: null, t: '', count: 0 });
    renderVars();
    var t = $('vars').querySelectorAll('textarea');
    t[t.length - 1].focus();
  });

  function resetDel() {
    var b = $('del');
    b.textContent = '刪除這則'; b.classList.remove('armed');
    clearTimeout(state.delTimer);
  }
  function setErr(msg) { var e = $('err'); e.textContent = msg || ''; e.hidden = !msg; }

  function openDialog(item) {
    state.editing = item || null;
    state.removed = [];
    state.saving = false;
    state.fetchSeq++;
    state.lastFetchUrl = null;
    state.origTouched = false;
    state.catTouched = false;
    state.draft = item && item.titles.length
      ? item.titles.map(function (v) { return { ver: v.ver, t: v.t, orig: v.t, count: v.count }; })
      : [{ ver: null, t: '', count: 0 }];
    $('dlgTitle').textContent = item ? '編輯 #' + item.id : '新增新聞';
    $('fUrl').value = item ? item.url : ''; $('fUrl').readOnly = !!item;
    $('fOrig').value = item ? item.orig : ''; $('fOrig').readOnly = !!item;
    fillCats(item ? item.cat : allCats()[0]);
    $('fNote').value = item ? item.note : '';
    $('titleHint').textContent = '';
    setErr('');
    resetDel();
    $('del').hidden = !item;
    $('save').disabled = false;
    renderVars();
    checkUrl();
    if (!$('dlg').open) $('dlg').showModal();
  }

  function setIdHint(text, dup) {
    var hint = $('idHint');
    hint.className = dup ? 'hint warn' : 'hint';
    hint.replaceChildren();
    hint.appendChild(document.createTextNode(text));
    if (dup) {
      hint.appendChild(document.createTextNode(' '));
      hint.appendChild(h('button', { type: 'button', click: function () { openDialog(dup); } }, '改為編輯這則'));
    }
  }

  function checkUrl() {
    if (state.editing) { setIdHint('編號 ' + state.editing.id + '（編輯時不可更改）'); return; }
    var raw = $('fUrl').value.trim();
    if (!raw) { setIdHint('貼上網址後會自動抓出編號。'); return; }
    var id = extractId(raw);
    var dup = id ? byId(id) : null;
    if (dup) { setIdHint('編號 ' + id + ' 已存在。', dup); return; }
    setIdHint(id ? '編號 ' + id : '網址裡找不到數字，將使用流水號作為編號。');
    var url = normalizeUrl(raw);
    var guess = url && !state.catTouched ? guessCategory(url, allCats()) : null;
    if (guess) $('fCat').value = guess;
    if (url && url !== state.lastFetchUrl && !state.origTouched && !$('fOrig').value.trim()) autofillTitle(url);
  }

  function titleFailText(reason) {
    var r = String(reason || '');
    if (/^http_(401|403|429)$/.test(r)) return '對方網站擋下自動抓取（' + r.slice(5) + '），請手動輸入';
    if (/^http_/.test(r)) return '對方網站回應異常（' + r.slice(5) + '），請手動輸入';
    if (r === 'timeout') return '抓取逾時，請手動輸入或稍後再貼一次網址';
    if (r === 'no_title') return '頁面抓到了但找不到標題，請手動輸入';
    return '抓不到標題，請手動輸入';
  }

  function autofillTitle(url) {
    var seq = ++state.fetchSeq;
    state.lastFetchUrl = url;
    $('titleHint').textContent = '正在抓取標題…';
    callApi('fetchTitle', { url: url }).then(function (data) { return data || { title: null, reason: 'fetch_error' }; }, function (e) { return { title: null, reason: e && e.code === 'timeout' ? 'timeout' : 'fetch_error' }; })
      .then(function (data) {
        if (seq !== state.fetchSeq) return;                    // 晚到的結果丟棄
        if (!data.title) { $('titleHint').textContent = titleFailText(data.reason); return; }
        if (state.origTouched || $('fOrig').value.trim()) { $('titleHint').textContent = ''; return; }
        $('fOrig').value = data.title;
        $('titleHint').textContent = '來自 ' + (data.source || '網頁');
      });
  }

  var urlTimer = null;
  $('fUrl').addEventListener('input', function () { clearTimeout(urlTimer); urlTimer = setTimeout(checkUrl, 400); });
  $('fUrl').addEventListener('change', function () { clearTimeout(urlTimer); checkUrl(); });
  $('fUrl').addEventListener('paste', function () { setTimeout(checkUrl, 0); });
  $('fOrig').addEventListener('input', function () { state.origTouched = true; });
  $('fCat').addEventListener('change', function () { state.catTouched = true; });

  $('cancel').addEventListener('click', function () { if (!state.saving) $('dlg').close(); });
  $('dlg').addEventListener('cancel', function (e) { if (state.saving) e.preventDefault(); });
  $('dlg').addEventListener('close', function () { state.fetchSeq++; resetDel(); });

  $('del').addEventListener('click', function () {
    var it = state.editing, b = $('del');
    if (!it || state.saving) return;
    if (!b.classList.contains('armed')) {
      b.textContent = '再按一次刪除（無法復原）'; b.classList.add('armed');
      clearTimeout(state.delTimer);
      state.delTimer = setTimeout(resetDel, 4000);
      return;
    }
    resetDel();
    state.saving = true; b.disabled = true; $('save').disabled = true;
    mutate('deleteItem', { id: it.id }).then(function (data) {
      if (!data) { $('dlg').close(); return; }
      state.items = state.items.filter(function (x) { return x.id !== it.id; });
      $('dlg').close(); render(); toast('已刪除 #' + it.id);
    }).catch(function (e) { setErr(e.message); }).then(function () { state.saving = false; b.disabled = false; $('save').disabled = false; });
  });

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (state.saving) return;
    var it = state.editing;
    var rawUrl = $('fUrl').value, orig = normalizeLine($('fOrig').value);
    var note = normalizeText($('fNote').value), cat = $('fCat').value;
    var url = it ? it.url : normalizeUrl(rawUrl);
    if (!rawUrl.trim() || !orig) { setErr('網址和原始標題必填。'); return; }
    if (!url) { setErr('網址格式不正確（需為 http 或 https 的完整網址）。'); return; }
    if (!cat) { setErr('請選擇分類。'); return; }
    setErr('');

    var req, action;
    if (!it) {
      action = 'addItem';
      req = { url: url, orig: orig, cat: cat, note: note,
        titles: state.draft.map(function (v) { return normalizeText(v.t); }).filter(Boolean) };
    } else {
      action = 'updateItem';
      var edit = [], add = [], remove = state.removed.slice();
      state.draft.forEach(function (v) {
        var t = normalizeText(v.t);
        if (v.ver == null) { if (t) add.push(t); }
        else if (!t) remove.push(v.ver);
        else if (t !== v.orig) edit.push({ ver: v.ver, t: t });
      });
      req = { id: it.id, cat: cat, note: note, edit: edit, add: add, remove: remove };
    }
    state.saving = true; $('save').disabled = true; $('save').textContent = '儲存中…';
    mutate(action, req).then(function (data) {
      if (!data) { $('dlg').close(); return; }
      replaceItem(data.item);
      state.pos[data.item.id] = Math.min(state.pos[data.item.id] || 0, Math.max(data.item.titles.length - 1, 0));
      $('dlg').close(); render(); toast('已儲存 #' + data.item.id);
    }).catch(function (err) {
      if (err.code === 'duplicate' && err.existing) { replaceItem(err.existing); render(); state.saving = false; openDialog(err.existing); return; }
      if (err.code === 'unauthorized') return;   // 登入視窗已由 callApi 開啟；保留編輯視窗與草稿，重新登入後再按儲存
      setErr(err.message);
    }).then(function () { state.saving = false; $('save').disabled = false; $('save').textContent = '儲存'; });
  });

  /* ---------- 啟動 ---------- */
  function init() {
    var cfg = api.getConfig();
    if (!cfg.url || !cfg.session) { render(); openSettings(); return; }
    loadItems();
  }
  init();
})();
