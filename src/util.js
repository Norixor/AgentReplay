'use strict';
/* Shared UI helpers: newest-first ordering, clamped text, copy buttons, jump targets, theme colours. */

/* ---- order toggle (newest first by default; preference kept in localStorage, failures fall back to the default) */
let ORDER = 'new';
try { if (localStorage.getItem('agent-replay.order') === 'old') ORDER = 'old'; } catch (e) { /* storage blocked */ }
function setOrder(o) {
  ORDER = o === 'old' ? 'old' : 'new';
  try { localStorage.setItem('agent-replay.order', ORDER); } catch (e) { /* ignore */ }
}
const newestFirst = () => ORDER === 'new';
/* Returns a copy of a chronological list in the active order. */
function ordered(list) { return newestFirst() ? list.slice().reverse() : list.slice(); }

/* ---- clamped text with expand/collapse; the title shows the full text on hover */
function clampBlock(text, cls, lines) {
  text = String(text == null ? '' : text);
  if (!text) return '';
  return '<div class="clampw ' + (cls || '') + '"><div class="clamp" style="--lines:' + (lines || 3) + '" title="' + esc(clip(text, 2500)) + '">' + esc(text) +
    '</div><button type="button" class="clamp-btn" hidden>展开</button></div>';
}
/* Shows the toggle only where the text really overflows. Call after the markup is in the document. */
function fitClamps(root) {
  (root || document).querySelectorAll('.clampw').forEach(w => {
    const c = w.firstElementChild, b = w.lastElementChild;
    if (!b || !b.classList.contains('clamp-btn')) return;
    b.hidden = !(w.classList.contains('open') || c.scrollHeight > c.clientHeight + 1);
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('.clamp-btn');
  if (b) {
    const w = b.parentNode;
    const open = w.classList.toggle('open');
    b.textContent = open ? '收起' : '展开';
    e.stopPropagation();
    return;
  }
  const cp = e.target.closest('[data-cp]');
  if (cp) {
    e.stopPropagation();
    copyText(cp.dataset.cp, cp);
  }
}, true);

/* ---- copy */
function copyBtn(text, label) {
  return '<button type="button" class="cp" data-cp="' + esc(text) + '" title="复制" aria-label="复制">' + (label || '复制') + '</button>';
}
function copyText(text, btn) {
  const done = () => { const o = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = o; }, 1100); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
  else legacyCopy(text, done);
}
function legacyCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
  ta.remove();
}

/* ---- replay hashes: #main?t=<ts>&k=turn  /  #agent/<id>?t=<ts>; jumpTo opens the detail dialog instead of navigating */
function jumpHash(agentId, ts, turn, stepN) {
  return (agentId === 'main' ? '#main' : '#agent/' + agentId) + (ts ? '?t=' + Math.round(ts) + (turn ? '&k=turn' : '') + (stepN != null ? '&s=' + stepN : '') : '');
}
/* Opens the detail dialog (modal.js) for "agent X at time ts": a clicked bar, mark, table row or event. Nothing navigates. */
function jumpTo(agentId, ts, turn, stepN) {
  const spec = mdFromTime(agentId, ts, turn, stepN);
  if (!spec) { toast('回看数据里没有这个代理，点「刷新回看数据」更新。'); return; }
  showDetail(spec);
  if (ts && ts > D.meta.end + 3000) toast('这一步发生在回看数据生成之后，点「刷新回看数据」才看得到。');
}
/* The old behaviour: leave for the replay page at that place. Only used for explicit "open in the replay" requests. */
function jumpToReplay(agentId, ts, turn, stepN) {
  if (!A[agentId]) { toast('回看数据里没有这个代理，点「刷新回看数据」更新。'); return; }
  const target = jumpHash(agentId, ts, turn, stepN);
  if (location.hash === target) route(); else location.hash = target;
}
let toastTimer = 0;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

/* ---- canvas colours: CSS variables resolved against the root so the theme switch is respected */
const _cs = {};
function cssVar(name) {
  if (_cs.theme !== (document.documentElement.dataset.theme || '') + matchMedia('(prefers-color-scheme:dark)').matches) {
    for (const k in _cs) delete _cs[k];
    _cs.theme = (document.documentElement.dataset.theme || '') + matchMedia('(prefers-color-scheme:dark)').matches;
  }
  if (!(name in _cs)) _cs[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  return _cs[name];
}
function resolveColor(c) {
  const m = /^var\((--[\w-]+)\)$/.exec(c);
  return m ? cssVar(m[1]) : c;
}

/* ---- relative "x seconds ago" */
function ago(ms) { return ms < 1500 ? '刚刚' : fmtDur(ms) + '前'; }

/* ---- status blocks shared by views */
function emptyState(msg, sub) { return '<div class="empty"><b>' + esc(msg) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div>'; }

/* Runs fn on the next animation frame, or after 80 ms when frames are not produced (hidden pane / background tab). */
function frame(fn) {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(run);
  setTimeout(run, 80);
}

/* ---- live updates: keep the reader's place while content is inserted, and flash what is new */
/* Runs fn (which adds content around the reader) and then scrolls so that the first element of `sel` in view stays where it was.
 * Nothing is done when the page is at the very top: a reader at the top of a newest-first list should see the new rows. */
function keepScroll(root, sel, fn) {
  const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stick')) || 60) + 4;
  let anchor = null, y0 = 0;
  if (window.scrollY > 2) {
    const els = root.querySelectorAll(sel);
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.bottom > top && r.height > 0) { anchor = els[i]; y0 = r.top; break; }
    }
  }
  fn();
  if (anchor && anchor.isConnected) {
    const dy = anchor.getBoundingClientRect().top - y0;
    if (Math.abs(dy) > 1) window.scrollBy(0, dy);
  }
}
/* Highlight that fades out after about two seconds (the .hl-new animation). */
function flashEl(el, ms) {
  el.classList.remove('hl-new');
  void el.offsetWidth;  // restart the animation if it is already running
  el.classList.add('hl-new');
  setTimeout(() => el.classList.remove('hl-new'), ms || 2100);
}
