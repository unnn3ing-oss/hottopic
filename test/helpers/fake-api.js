// 記憶體版假 API：實作與 Code.gs 相同的線路協定（只供前端 e2e 使用）。
// 後端完成後，e2e 可改為轉給真正的 Code.gs（loadBackend）。
const TOKEN = 't'.repeat(48);
const DAY = 864e5;

function createFakeApi(opts = {}) {
  const st = { now: opts.now || Date.UTC(2026, 9, 12, 4, 0, 0), items: [], cats: ['社會', '生活', '健康', '政治', '國際', '娛樂'],
    token: TOKEN, titleResult: { title: '自動帶入的原始標題', source: 'og:title' }, calls: [] };
  const ok = (data) => ({ ok: true, data });
  const bad = (code, extra) => Object.assign({ ok: false, code, error: code }, extra);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const find = (id) => st.items.find((i) => i.id === id);
  const idOf = (url) => (String(url).replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/[?#].*$/, '').match(/\d+/g) || [])
    .reduce((a, b) => (b.length > a.length ? b : a), '') || null;
  const mkV = (ver, t) => ({ ver, t, last: null, count: 0 });

  function seed(item) {
    st.items.push(Object.assign({ cat: '生活', note: '', last: null, count: 0, created: st.now, titles: [] }, item));
  }
  const actions = {
    ping: () => ok({ pong: true }),
    listItems: () => ok(clone({ items: st.items, cats: st.cats })),
    fetchTitle: () => ok(clone(st.titleResult)),
    addItem(a) {
      const id = idOf(a.url) || 'N' + (st.items.length + 1);
      if (find(id)) return bad('duplicate', { existing: clone(find(id)) });
      const item = { id, cat: a.cat, orig: a.orig, url: a.url, note: a.note || '', last: null, count: 0, created: st.now,
        titles: (a.titles || []).map((t, i) => mkV(i + 1, t)) };
      st.items.push(item);
      return ok({ item: clone(item) });
    },
    updateItem(a) {
      const it = find(a.id); if (!it) return bad('not_found');
      const vers = (x) => it.titles.some((v) => v.ver === x);
      if ((a.edit || []).some((e) => !vers(e.ver)) || (a.remove || []).some((x) => !vers(x))) return bad('stale');
      it.cat = a.cat; it.note = a.note;
      (a.edit || []).forEach((e) => { it.titles.find((v) => v.ver === e.ver).t = e.t; });
      const max = it.titles.reduce((m, v) => Math.max(m, v.ver), 0);
      it.titles = it.titles.filter((v) => !(a.remove || []).includes(v.ver));
      (a.add || []).forEach((t, i) => it.titles.push(mkV(max + 1 + i, t)));
      return ok({ item: clone(it) });
    },
    deleteItem(a) {
      if (!find(a.id)) return bad('not_found');
      st.items = st.items.filter((i) => i.id !== a.id);
      return ok({ id: a.id });
    },
    markUsed(a) {
      const it = find(a.id); if (!it) return bad('not_found');
      if (it.titles.length) {
        const v = it.titles.find((x) => x.ver === a.ver); if (!v) return bad('stale');
        v.last = st.now; v.count += 1;
      }
      it.last = st.now; it.count += 1;
      return ok({ item: clone(it) });
    }
  };

  function raw(body) {
    let req;
    try { req = JSON.parse(body); } catch (e) { return JSON.stringify(bad('bad_request')); }
    if (!req || typeof req.token !== 'string' || req.token !== st.token) return JSON.stringify(bad('unauthorized'));
    st.calls.push({ action: req.action, args: req.args });
    if (!Object.prototype.hasOwnProperty.call(actions, req.action)) return JSON.stringify(bad('bad_request'));
    return JSON.stringify(actions[req.action](req.args || {}));
  }
  return { st, raw, seed, TOKEN, DAY };
}

function seedSample(api) {
  const { st, DAY } = api, N = st.now;
  const V = (ver, t, last, count) => ({ ver, t, last, count });
  api.seed({ id: '4032757', cat: '生活', url: 'https://news.tvbs.com.tw/cars/4032757', created: N - 30 * DAY,
    orig: '汽車定期保養別再等到出問題！內行人揭 5 項最容易被忽略的檢查重點',
    titles: [V(1, '定期保養的 5 個重點\n第 3 項最多人漏掉', N - 20 * DAY, 2), V(2, '愛車多久該保養一次？\n行家：別等警示燈亮', N - 9 * DAY, 1),
      V(3, '保養千萬別省！\n這 5 項檢查最容易被漏掉', null, 0)],
    note: '你多久保養一次車？\n留言分享你的習慣 👇', last: N - 9 * DAY, count: 3 });
  api.seed({ id: '4031880', cat: '社會', url: 'https://news.tvbs.com.tw/local/4031880', created: N - 2 * DAY,
    orig: '夜市攤販連假湧入人潮 業者喊「一晚賣出平常三天的量」', titles: [V(1, '連假夜市爆滿\n攤商：一晚抵三天', null, 0)], note: '你最推薦哪一攤？' });
  api.seed({ id: '4028301', cat: '社會', url: 'https://news.tvbs.com.tw/local/4028301', created: N - 1 * DAY,
    orig: '捷運末班車延後營運 跨年夜加開班次時間一次看', titles: [], note: '' });
}

module.exports = { createFakeApi, seedSample, TOKEN };
