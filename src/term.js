'use strict';
/* Terminal view of an agent's steps (DOM side; the text model is term_format.js).
 * Always in time order, whatever the "newest first" switch says: new output appears at the bottom and the view follows it
 * until the reader scrolls up. Only the last ~2000 lines are rendered up front, earlier ones are added when scrolling up. */

const TERM_PREF_KEY = 'agent-replay.view';
const TERM_WINDOW = 2000, TERM_PAGE = 1000;

function termPref() {
  try { return localStorage.getItem(TERM_PREF_KEY) === 'term' ? 'term' : 'table'; } catch (e) { return 'table'; }
}
function termSetPref(v) {
  try { localStorage.setItem(TERM_PREF_KEY, v); } catch (e) { /* storage blocked: the choice only lasts for this page */ }
}

function termLineHTML(l, active) {
  let text = esc(l.text);
  if (l.ref && l.label && A[l.ref]) {
    const i = l.text.indexOf(l.label);
    if (i >= 0) text = esc(l.text.slice(0, i)) + '<a href="#' + (l.ref === 'main' ? 'main' : 'agent/' + esc(l.ref)) + '"' + mdAttr({type: 'agent', agent: l.ref}) + '>' + esc(l.label) + '</a>' + esc(l.text.slice(i + l.label.length));
  }
  const exp = l.full ? ' exp" tabindex="0" role="button" title="点击展开或收起" data-t="' + esc(l.text) + '" data-f="' + esc(l.full) : '';
  let right = '';
  if (l.pend) right = active ? '<span class="tm-d spin" data-ts="' + l.ts + '">' + termDur(Math.max(0, Date.now() - l.ts)) + '</span>' : '<span class="tm-d dim">无结果</span>';
  else if (l.dur != null) right = '<span class="tm-d' + (l.long ? ' long' : '') + '">' + termDur(l.dur) + '</span>';
  return '<div class="tm-l k-' + l.k + (l.cont ? ' cont' : '') + '"><span class="tm-t">' + termClock(l.ts) + '</span><span class="tm-x' + exp + '">' + text + '</span>' + right + '</div>';
}
function termBlockHTML(b, active) {
  return b.lines.length ? '<div class="tm-b" data-k="' + b.key + '">' + b.lines.map(l => termLineHTML(l, active)).join('') + '</div>' : '';
}
const termCount = blocks => blocks.reduce((n, b) => n + b.lines.length, 0);

/* Builds the terminal inside `root` and returns {apply(info), show(), destroy()}. */
function termMount(root, a) {
  const active = !!D.meta.active;
  const ctx = {project: D.meta.project || '', agent: id => A[id], seen: new Set()};
  const T = {blocks: [], by: new Map(), cnt: [], first: 0, follow: true, tick: 0};
  root.innerHTML = '<div class="term-bar"><button type="button" class="term-copy">复制全部</button><span class="dim term-n"></span>' +
    '<span class="dim term-note">时间正序，不受「最新在前」影响</span></div>' +
    '<div class="term"><div class="term-body" tabindex="0" aria-label="终端输出"><div class="term-top" hidden></div><div class="term-lines"></div>' +
    '<div class="tm-l term-cur"><span class="tm-t"></span><span class="tm-x"><i class="tm-cur"></i></span></div></div><button type="button" class="term-jump" hidden>↓ 跳到最新</button></div>';
  const body = root.querySelector('.term-body'), lines = root.querySelector('.term-lines'), top = root.querySelector('.term-top');
  const jump = root.querySelector('.term-jump'), nEl = root.querySelector('.term-n');

  const toBottom = () => { body.scrollTop = body.scrollHeight; };
  function status() {
    top.hidden = T.first <= 0;
    if (!top.hidden) top.textContent = '↑ 还有 ' + termCount(T.blocks.slice(0, T.first)) + ' 行更早的内容，向上滚动加载';
    nEl.textContent = '共 ' + termCount(T.blocks) + ' 行';
  }
  function register(list) {
    list.forEach(b => { T.blocks.push(b); T.by.set(b.key, b); });
  }
  function build() {
    T.blocks = []; T.by = new Map(); T.cnt = [];
    ctx.seen = new Set();
    register(termAgentBlocks(a, ctx));
    a.turns.forEach((t, ti) => { T.cnt[ti] = {st: t.steps.length, ev: t.evs.length}; });
    let n = 0, i = T.blocks.length;
    while (i > 0 && n < TERM_WINDOW) n += T.blocks[--i].lines.length;
    T.first = i;
    lines.innerHTML = T.blocks.slice(T.first).map(b => termBlockHTML(b, active)).join('');
    status();
  }
  function loadEarlier() {
    let n = 0, i = T.first;
    while (i > 0 && n < TERM_PAGE) n += T.blocks[--i].lines.length;
    const h0 = body.scrollHeight;
    lines.insertAdjacentHTML('afterbegin', T.blocks.slice(i, T.first).map(b => termBlockHTML(b, active)).join(''));
    T.first = i;
    body.scrollTop += body.scrollHeight - h0;  // keep the line the reader was looking at
    status();
  }

  body.addEventListener('scroll', () => {
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
    T.follow = atEnd;
    jump.hidden = atEnd;
    if (body.scrollTop < 120 && T.first > 0) loadEarlier();
  });
  jump.addEventListener('click', () => { T.follow = true; jump.hidden = true; toBottom(); });
  root.querySelector('.term-copy').addEventListener('click', e => copyText(termPlain(T.blocks), e.currentTarget));
  lines.addEventListener('click', e => {  // clipped comments and separators expand in place
    const x = e.target.closest('.exp');
    if (!x || e.target.closest('a')) return;
    const open = x.classList.toggle('open');
    x.textContent = open ? x.dataset.f : x.dataset.t;
  });
  lines.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('exp')) { e.preventDefault(); e.target.click(); }
  });
  T.tick = setInterval(() => {  // elapsed seconds of commands that have no result yet
    if (document.hidden) return;
    const now = Date.now();
    lines.querySelectorAll('.spin').forEach(el => { el.textContent = termDur(Math.max(0, now - +el.dataset.ts)); });
  }, 1000);

  build();
  toBottom();

  return {
    /* info: {touched, updated, redo} from live_steps.js; the model (a.turns) already contains the new data. */
    apply(info) {
      if (info.redo != null) { build(); if (T.follow) toBottom(); return; }
      const added = [];
      info.touched.forEach(ti => {
        const t = a.turns[ti], c = T.cnt[ti];
        const r = termTurnBlocks(t, ti, ctx, c ? c.st : 0, c ? c.ev : 0, !c);
        T.cnt[ti] = {st: r.st, ev: r.ev};
        r.blocks.forEach(b => added.push(b));
      });
      info.updated.forEach(({s}) => {
        const b = T.by.get('s' + s.n);
        if (!b) return;
        b.lines = termStepLines(s, ctx);
        const el = lines.querySelector('.tm-b[data-k="s' + s.n + '"]');
        if (el) el.outerHTML = termBlockHTML(b, active);
      });
      register(added);
      if (added.length) lines.insertAdjacentHTML('beforeend', added.map(b => termBlockHTML(b, active)).join(''));
      status();
      if (T.follow) toBottom();
    },
    show() { if (T.follow) toBottom(); },
    destroy() { clearInterval(T.tick); },
  };
}
