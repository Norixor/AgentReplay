'use strict';
/* Live append for an agent's step list and terminal: polls /api/steps/<tool>/<id> every 5 s while the page is in front,
 * merges the answer into the page's data model (A[id].turns) and tells the views what changed.
 * Only for sessions that were still active when the page was generated (D.meta.active). */

const LS_POLL_MS = 5000;
const LS_ENDED_MS = 10 * 60000;   // no write for this long: the session is probably over, polling stops

/* Followers per agent id, and listeners that hear about every merged answer (the agent dialog uses them, modal.js). */
const LS_ACTIVE = {};
const LS_TAPS = new Set();

const lsHasPend = s => s.calls.some(c => c.st === 'pend');

/* Merges one /api/steps answer into agent `a`. Returns {added, updated, touched, redo} for the views. */
function lsMerge(a, j) {
  const info = {added: [], updated: [], touched: [], redo: null};
  const touched = new Set();
  (j.agents || []).forEach(x => {   // sub-agents that appeared since the page was generated
    if (A[x.id]) return;
    x.turns = [];
    A[x.id] = x;
    D.agents.push(x);
    SUBS.push(x);
  });
  Object.assign(a, j.stats);
  D.totals = j.totals;
  D.meta.end = Math.max(D.meta.end, j.end || 0);
  (j.turns || []).forEach(h => {
    const t = a.turns[h.ti];
    if (!t) { a.turns[h.ti] = {trig: h.trig, evs: h.evs, steps: []}; touched.add(h.ti); return; }
    if (t.trig.ts !== h.trig.ts || t.trig.k !== h.trig.k) {   // an empty turn was folded into the next trigger
      t.trig = h.trig; t.evs = h.evs; info.redo = h.ti; touched.add(h.ti);
    } else if (h.evs.length !== t.evs.length) { t.evs = h.evs; touched.add(h.ti); }
  });
  (j.steps || []).forEach((s, i) => {
    const ti = j.ti[i];
    if (!a.turns[ti]) a.turns[ti] = {trig: {k: 'meta', ts: s.ts, text: ''}, evs: [], steps: []};
    // Two followers of one agent (the page and an open agent dialog) can both receive a step: keep it once.
    if (a.turns[ti].steps.some(x => x.n === s.n)) return;
    a.turns[ti].steps.push(s);
    info.added.push({s, ti});
    touched.add(ti);
  });
  (j.updated || []).forEach((s, i) => {
    const ti = j.updatedTi[i], steps = a.turns[ti] && a.turns[ti].steps;
    const k = steps ? steps.findIndex(x => x.n === s.n) : -1;
    if (k < 0 || JSON.stringify(steps[k]) === JSON.stringify(s)) return;
    steps[k] = s;
    info.updated.push({s, ti});
  });
  info.touched = Array.from(touched).sort((x, y) => x - y);
  return info;
}

/* Starts the polling for agent `a`. bar: element for the status line; onInfo(info) repaints the views; onStats() the header.
 * Returns {destroy()} or null when the page is not live. */
function lsStart(a, bar, onInfo, onStats) {
  if (!D.meta.active || !bar) return null;
  const S = {after: 0, pend: new Set(), paused: false, ended: false, stale: false, fails: 0, last: 0, inflight: false, timer: 0, tick: 0, warming: false};
  LS_ACTIVE[a.id] = (LS_ACTIVE[a.id] || 0) + 1;
  a.turns.forEach(t => t.steps.forEach(s => { S.after++; if (lsHasPend(s)) S.pend.add(s.n); }));
  bar.innerHTML = '<span class="ls-dot" aria-hidden="true"></span><b class="ls-st"></b><span class="dim ls-age"></span>' +
    '<span class="grow"></span><button type="button" class="ls-pause">暂停</button>';
  const st = bar.querySelector('.ls-st'), age = bar.querySelector('.ls-age'), pause = bar.querySelector('.ls-pause');
  const reload = '<a href="/s/' + esc(D.meta.liveKey) + '">刷新回看数据</a>';

  function paint() {
    const hidden = document.hidden;
    let cls = 'on', html;
    if (S.stale) { cls = 'off'; html = '数据与服务端不一致（会话文件被改写），请' + reload; }
    else if (S.ended) { cls = 'off'; html = '会话可能已结束（超过 10 分钟没有新写入），已停止刷新'; }
    else if (S.fails >= 3) { cls = 'off'; html = '无法读取实时数据，已停止刷新（导出的静态页面没有实时功能）'; }
    else if (S.paused) { cls = 'off'; html = '已暂停'; }
    else if (hidden) { cls = 'off'; html = '页面在后台，已暂停刷新'; }
    else if (S.warming) html = '正在读取最新数据…';
    else html = '实时更新中';
    bar.dataset.state = cls;
    st.innerHTML = html;
    age.textContent = S.last ? ' · 上次更新 ' + Math.max(0, Math.floor((Date.now() - S.last) / 1000)) + ' 秒前' : '';
    pause.textContent = S.ended || S.fails >= 3 ? '再检查' : S.paused ? '继续' : '暂停';
    pause.hidden = S.stale;
  }
  function url() {
    const pend = Array.from(S.pend).sort((x, y) => y - x).slice(0, 60).join(',');
    return '/api/steps/' + D.meta.liveKey + '?agent=' + encodeURIComponent(a.id) + '&after=' + S.after + '&turns=' + a.turns.length +
      '&known=' + D.agents.length + '&pend=' + pend;
  }
  async function poll() {
    if (S.inflight || S.stale) return;
    S.inflight = true;
    try {
      const r = await fetch(url(), {cache: 'no-store'});
      const j = await r.json();
      if (j.restarting) { S.warming = true; S.inflight = false; paint(); return; }  // source updated: the server restarts in a moment
      if (!j.ok) throw new Error(j.error || 'HTTP ' + r.status);
      S.fails = 0;
      S.warming = !!j.warming;
      if (j.reset) S.stale = true;
      else if (!j.warming) {
        const info = lsMerge(a, j);
        S.after = j.total;
        info.added.forEach(({s}) => { if (lsHasPend(s)) S.pend.add(s.n); });
        info.updated.forEach(({s}) => { if (lsHasPend(s)) S.pend.add(s.n); else S.pend.delete(s.n); });
        S.pend.forEach(n => { if (n >= S.after) S.pend.delete(n); });
        S.last = Date.now();
        S.ended = !!j.ended || j.sinceWrite > LS_ENDED_MS;
        if (info.added.length || info.updated.length || info.touched.length) onInfo(info);
        onStats();
        LS_TAPS.forEach(f => { try { f(a, info); } catch (e) { /* a dialog repaint must not stop the poll */ } });
      }
    } catch (e) {
      S.fails++;
    }
    S.inflight = false;
    paint();
  }
  function schedule() {
    clearTimeout(S.timer);
    if (S.paused || S.ended || S.stale || S.fails >= 3 || document.hidden || !bar.isConnected) return;
    S.timer = setTimeout(async () => { await poll(); schedule(); }, LS_POLL_MS);
  }
  const kick = () => { poll().then(schedule); };
  pause.addEventListener('click', () => {
    if (S.ended || S.fails >= 3) { S.ended = false; S.fails = 0; kick(); }
    else { S.paused = !S.paused; if (S.paused) clearTimeout(S.timer); else kick(); }
    paint();
  });
  const onVis = () => { if (document.hidden) clearTimeout(S.timer); else if (!S.paused) kick(); paint(); };
  document.addEventListener('visibilitychange', onVis);
  S.tick = setInterval(paint, 1000);
  paint();
  schedule();
  return {
    destroy() { LS_ACTIVE[a.id] = Math.max(0, (LS_ACTIVE[a.id] || 1) - 1); clearTimeout(S.timer); clearInterval(S.tick); document.removeEventListener('visibilitychange', onVis); },
  };
}
