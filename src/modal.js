'use strict';
/* Detail dialog: showDetail(spec) is the only entry point (specs: see modal_model.js). A click inside the page opens the
 * detail here instead of leaving the page; only "在回看页中打开" navigates, and only when the reader asks for it.
 * Layers stack (opening an agent or step from inside the dialog adds a layer, "← 返回" removes it). Esc, the backdrop and the
 * close button close everything; focus moves into the dialog, stays there while Tab is pressed and returns to the opener.
 * While an agent is shown in an active session the dialog follows it every 5 s through live_steps.js (no polling of its own). */

const MD = {stack: [], back: null, win: null, opener: null, live: null, tap: null, seq: 0, extra: [], timer: 0};
const MD_FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

function showDetail(spec) {
  if (!MD.back) mdOpen();
  MD.stack = mdStackPush(MD.stack, spec);
  mdPaint(true);
}

function closeDetail() {
  if (!MD.back) return;
  mdStopLive();
  document.removeEventListener('keydown', mdKeys, true);
  window.removeEventListener('hashchange', closeDetail);
  MD.back.remove();
  document.documentElement.classList.remove('md-lock');
  const o = MD.opener;
  MD.back = MD.win = MD.opener = null;
  MD.stack = [];
  if (o && o.isConnected && typeof o.focus === 'function') { try { o.focus({preventScroll: true}); } catch (e) { /* element gone */ } }
}

function mdOpen() {
  MD.opener = document.activeElement;
  const back = document.createElement('div');
  back.className = 'md-back';
  back.innerHTML = '<div class="md-win" role="dialog" aria-modal="true" aria-labelledby="md-title" tabindex="-1">' +
    '<header class="md-h"><button type="button" class="md-bk" hidden>← 返回</button><h2 id="md-title"></h2><button type="button" class="md-x" aria-label="关闭">×</button></header>' +
    '<div class="md-body"></div><footer class="md-f"><span class="dim md-note"></span><button type="button" class="md-open">在回看页中打开</button></footer></div>';
  document.body.appendChild(back);
  MD.back = back;
  MD.win = back.firstElementChild;
  document.documentElement.classList.add('md-lock');
  back.addEventListener('mousedown', e => { if (e.target === back) closeDetail(); });
  MD.win.addEventListener('click', mdClick);
  MD.win.addEventListener('toggle', mdToggle, true);
  document.addEventListener('keydown', mdKeys, true);
  window.addEventListener('hashchange', closeDetail);   // the page changed under the dialog (tab bar, link): leave with it
}

/* Escape closes; Tab and Shift+Tab cycle inside the dialog. */
function mdKeys(e) {
  if (!MD.win) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDetail(); return; }
  if (e.key !== 'Tab') return;
  const list = Array.from(MD.win.querySelectorAll(MD_FOCUSABLE)).filter(x => !x.hidden && !x.closest('[hidden]') && (x.offsetWidth || x.offsetHeight || x.getClientRects().length));
  if (!list.length) { e.preventDefault(); MD.win.focus(); return; }
  const first = list[0], last = list[list.length - 1], cur = document.activeElement;
  if (!MD.win.contains(cur)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && (cur === first || cur === MD.win)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
}

function mdClick(e) {
  if (e.target.closest('.md-x')) { closeDetail(); return; }
  if (e.target.closest('.md-bk')) { MD.stack = mdStackBack(MD.stack); mdPaint(true); return; }
  if (e.target.closest('.md-open')) {
    const hash = mdReplayHash(MD.stack[MD.stack.length - 1]);
    closeDetail();
    if (location.hash === hash) route(); else location.hash = hash;   // the one navigation: the reader asked for it
    return;
  }
  const more = e.target.closest('.md-pre-more');
  if (more) {
    const p = more.previousElementSibling;
    const open = p.classList.toggle('md-full');
    more.textContent = open ? '收起' : '展开全文';
  }
}

/* Fills the body of a step row the first time it is opened. */
function mdToggle(e) {
  const d = e.target;
  if (!d.classList || !d.classList.contains('md-st') || !d.open) return;
  const box = d.querySelector('.md-sb');
  if (box.firstChild) return;
  const a = A[d.dataset.ag], hit = a && mdFindStep(a, d.dataset.sn);
  box.innerHTML = hit ? mdStepBody(a, hit.s) : '<p class="dim">这一步已经不在回看数据里。</p>';
  mdDecorate(box);
}

/* Long inputs and results: a button to show the whole text instead of the scrolling box. */
function mdDecorate(root) {
  fitClamps(root);
  root.querySelectorAll('.blk pre').forEach(p => {
    if (p.nextElementSibling && p.nextElementSibling.classList.contains('md-pre-more')) return;
    if (p.scrollHeight <= p.clientHeight + 2) return;
    p.insertAdjacentHTML('afterend', '<button type="button" class="md-pre-more">展开全文</button>');
  });
}

function mdOpenKeys(root) {
  const s = new Set();
  root.querySelectorAll('details.md-st[open]').forEach(d => s.add(d.dataset.k));
  return s;
}

function mdPaint(reset) {
  if (!MD.win) return;
  mdStopLive();
  const spec = MD.stack[MD.stack.length - 1], out = mdRender(spec);
  const body = MD.win.querySelector('.md-body');
  MD.win.querySelector('#md-title').textContent = out.title;
  MD.win.querySelector('.md-bk').hidden = !mdCanBack(MD.stack);
  MD.win.querySelector('.md-open').hidden = !out.r.ok;
  MD.win.querySelector('.md-note').textContent = MD.stack.length > 1 ? '第 ' + MD.stack.length + ' 层' : '';
  body.innerHTML = out.html;
  mdDecorate(body);
  if (reset) {
    body.scrollTop = 0;
    const target = MD.win.querySelector('.md-bk:not([hidden])') || MD.win.querySelector('.md-x') || MD.win;
    target.focus({preventScroll: true});
  }
  if (out.r.ok && out.r.type === 'agent') mdFollow(out.r.a);
  else if (out.r.ok && out.r.type === 'step' && lsHasPend(out.r.s)) mdFollowStep(out.r);
}

/* ---- live follow of the agent in view */
function mdStopLive() {
  MD.seq++;
  if (MD.live) { MD.live.destroy(); MD.live = null; }
  if (MD.tap) { LS_TAPS.delete(MD.tap); MD.tap = null; }
  clearInterval(MD.timer);
  MD.extra.splice(0).forEach(el => el.remove());
}

function mdRepaintAgent(a) {
  if (!MD.win) return;
  const body = MD.win.querySelector('.md-body');
  const head = body.querySelector('[data-md-live="head"]'), rec = body.querySelector('[data-md-live="recent"]');
  if (!head || !rec) return;
  const open = mdOpenKeys(rec);
  head.innerHTML = mdAgentHead(a);
  rec.innerHTML = mdAgentRecent(a, open);
  rec.querySelectorAll('details.md-st[open] .md-sb').forEach(b => mdDecorate(b));
}

function mdFollow(a) {
  if (!D.meta.active) return;
  const seq = MD.seq;
  const repaint = () => { if (seq === MD.seq) mdRepaintAgent(a); };
  MD.tap = (ag) => { if (ag === a) sxRefresh().then(repaint); };
  LS_TAPS.add(MD.tap);
  sxRefresh().then(repaint);   // first status without waiting for the 5 s tick
  // The page may already follow this agent (its own replay view): then its poll feeds us through LS_TAPS.
  if (!LS_ACTIVE[a.id]) MD.live = lsStart(a, MD.win.querySelector('#md-ls'), () => {}, () => {});
}

/* A step with an unfinished call: a banner says it is running, and the step is re-read every 5 s (live_steps.js, the same
 * poll as for an agent) until its calls have results; then the body is redrawn with the result and the follow stops. */
function mdFollowStep(r) {
  if (!D.meta.active) return;
  const a = r.a, n = r.s.n, seq = MD.seq, body = MD.win.querySelector('.md-body');
  const run = document.createElement('div'), bar = document.createElement('div');
  run.className = 'md-run';
  run.setAttribute('role', 'status');
  bar.className = 'md-ls lsbar';
  body.parentNode.insertBefore(run, body);
  body.parentNode.insertBefore(bar, body);
  MD.extra.push(run, bar);
  const paintRun = () => {
    const hit = mdFindStep(a, n), c = hit && hit.s.calls.find(x => x.st === 'pend');
    if (c) run.innerHTML = '<span class="ls-dot" aria-hidden="true"></span><b>执行中</b> ' + esc(c.name) + ' · 已 ' + fmtDur(Math.max(0, Date.now() - hit.s.ts)) + '<span class="dim">　结果出来后这里会自动更新</span>';
  };
  let shown = r.s;
  MD.tap = ag => {
    if (ag !== a || seq !== MD.seq) return;
    const hit = mdFindStep(a, n);
    if (!hit || hit.s === shown) return;
    shown = hit.s;
    const out = mdRender(MD.stack[MD.stack.length - 1]), top = body.scrollTop;
    body.innerHTML = out.html;
    mdDecorate(body);
    body.scrollTop = top;
    if (!lsHasPend(hit.s)) mdStopLive();   // finished: the body now shows the result
  };
  LS_TAPS.add(MD.tap);
  paintRun();
  MD.timer = setInterval(paintRun, 1000);
  if (!LS_ACTIVE[a.id]) MD.live = lsStart(a, bar, () => {}, () => {});
}

/* ---- clickable references in markup: any element with data-md='<spec json>' opens the dialog */
function mdSpecOf(el) {
  try { return JSON.parse(el.getAttribute('data-md')); } catch (e) { return null; }
}
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const el = e.target.closest && e.target.closest('[data-md]');
  if (!el) return;
  const inner = e.target.closest('a,button,input,select,summary');
  if (inner && inner !== el && el.contains(inner)) return;   // a real link or button inside keeps its own job
  const spec = mdSpecOf(el);
  if (!spec) return;
  e.preventDefault();
  showDetail(spec);
});
document.addEventListener('keydown', e => {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.defaultPrevented || MD.win && MD.win.contains(e.target) && e.target.tagName === 'SUMMARY') return;
  const el = e.target;
  if (!el.matches || !el.matches('[data-md]') || /^(A|BUTTON|INPUT|SELECT|SUMMARY)$/.test(el.tagName)) return;
  const spec = mdSpecOf(el);
  if (!spec) return;
  e.preventDefault();
  showDetail(spec);
});
