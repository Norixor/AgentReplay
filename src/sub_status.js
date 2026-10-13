'use strict';
/* Sub-agent status for the sub-agent list and detail header.
 * Active sessions: the live API (the same /api/live snapshot live.js polls, field "subs", matched by agent id) gives
 * executing / thinking / waiting for children / idle / handed back. Finished sessions, and agents the live view no longer
 * follows: "handed back (time)" from the recording, or "not handed back (recording stops)". */

const SX = {phase: D.meta.active ? 'loading' : 'static', map: null, at: 0, timer: 0, tick: 0};

/* {state, L?, doneTs?}: state is a live state (exec think waiting idle done), or loading / lost for the recorded fallback. */
function sxGet(a) {
  const L = SX.phase === 'live' && SX.map && SX.map[a.id];
  if (L) return {state: L.state, L, doneTs: L.state === 'done' ? (L.doneTs || a.doneTs || 0) : 0};
  if (SX.phase === 'loading') return {state: 'loading'};
  return a.doneTs ? {state: 'done', doneTs: a.doneTs} : {state: 'lost'};
}
/* Running = anything but handed back (a live "idle" sub-agent has not handed back either). */
function sxRunning(st) { return !!st.L && st.state !== 'done'; }

function sxLive(ms, at) { return '<b class="sx-t" data-ms="' + Math.round(ms) + '" data-at="' + at + '">' + fmtDur(ms) + '</b>'; }

/* One line: the call being executed (tool name plus its description), or what the agent is doing instead. */
function sxNow(L) {
  if ((L.state === 'exec' || L.state === 'waiting') && L.tool) {
    const what = L.desc || L.sum || '';
    return '<div class="sx-now" title="' + esc(L.tool + ' ' + (L.desc || '') + ' ' + (L.sum || '')) + '"><span class="mono">' + esc(L.tool) + '</span>' + (what ? ' · ' + esc(clip(what, 70)) : '') +
      (L.elapsed != null ? ' · 已执行 ' + sxLive(L.elapsed, SX.at) : '') + '</div>';
  }
  if (L.state === 'think') return '<div class="sx-now dim">模型思考或输出中</div>';
  return L.why ? '<div class="sx-now dim">' + esc(L.why) + '</div>' : '';
}

function sxStatusHTML(a, withNow) {
  const st = sxGet(a);
  if (st.state === 'loading') return '<span class="dim">读取中…</span>';
  if (st.state === 'lost') return '<span class="lst ls-idle" title="这个代理的记录里没有交回或结束标记">未交回（记录中断）</span>';
  const [txt, cls] = LSTATE[st.state] || ['未知', 'idle'];
  if (st.state === 'done') return '<span class="lst ls-' + cls + '">已交回</span>' + (st.doneTs ? ' <span class="dim">（' + fmtTS(st.doneTs) + '）</span>' : '');
  return '<span class="sx-dot" aria-hidden="true"></span><span class="lst ls-' + cls + '">' + txt + '</span>' +
    (st.L.runMs != null ? ' <span class="sx-run">已运行 ' + sxLive(st.L.runMs, SX.at) + '</span>' : '') + (withNow ? sxNow(st.L) : '');
}

/* Counters ticking in the browser between two polls. */
function sxTickAll(root) {
  const now = Date.now();
  root.querySelectorAll('.sx-t').forEach(el => { el.textContent = fmtDur(+el.dataset.ms + (now - +el.dataset.at)); });
}

/* One fetch of the live snapshot into SX (also used by the agent dialog, modal.js, which is paced by live_steps.js). */
async function sxRefresh() {
  await liveFetch();  // live.js: also keeps LV.data for the live tab
  if (LV.data && LV.data.subs) { SX.map = LV.data.subs; SX.at = LV.fetchedAt; SX.phase = 'live'; }
  else if (SX.phase === 'loading') SX.phase = 'static';  // exported page or no server: fall back to the recording
}

/* Poll the live API every 5 s while the page is in front (active sessions only) and call onUpdate after each answer. */
function sxStart(root, onUpdate) {
  if (!D.meta.active) return;
  const poll = async () => {
    if (document.hidden) return;
    await sxRefresh();
    onUpdate();
  };
  const onVis = () => { if (!document.hidden) poll(); };
  document.addEventListener('visibilitychange', onVis);
  clearInterval(SX.timer);
  clearInterval(SX.tick);
  SX.timer = setInterval(poll, 5000);
  SX.tick = setInterval(() => sxTickAll(root), 1000);
  VIEW_CLEANUP.push(() => { clearInterval(SX.timer); clearInterval(SX.tick); document.removeEventListener('visibilitychange', onVis); });
  poll();
}
