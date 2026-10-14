'use strict';
/* Opening a detail dialog for something that may be newer than the page's data. The page embeds a snapshot (A / D); the live
 * tab shows steps and sub-agents that happened after it. liveOpen(spec) / liveOpenAt(agent, ts, ...) check whether the target is
 * in A; if not (or it is an unfinished call), they first pull the missing steps of that one agent from /api/steps, merge them
 * into A with lsMerge (live_steps.js) and only then call showDetail. Every click that may land on fresh data goes through here:
 * jumpTo (util.js), the live cards, the route map and the agent graph. A static export (no D.meta.active) keeps the old behaviour. */

const LO = {busy: new Map(), last: new Map()};   // agent id -> request in flight / time of the last good answer
const LO_GAP_MS = 1500;       // a good answer this young is reused (a double click must not fetch twice)
const LO_WARM_TRIES = 3;      // the server may still be parsing the session: wait and ask again
const LO_WARM_WAIT = 1000;
const LO_MAX_AGENTS = 6;      // agents refreshed by one click (a step list can span many)
const LO_MSG = '正在读取最新步骤…';

const loWait = ms => new Promise(r => setTimeout(r, ms));

/* Last time anything of agent `a` is known to have happened. */
function loLastTs(a) {
  let t = a.end || 0;
  for (let i = a.turns.length - 1; i >= 0; i--) {
    const st = a.turns[i].steps;
    if (st.length) { const s = st[st.length - 1]; t = Math.max(t, s.end || 0, s.ts || 0); break; }
  }
  return t;
}

/* Step numbers whose calls had no result when last read: the next answer must re-send them. */
function loPendNums(a) {
  const out = [];
  a.turns.forEach(t => t.steps.forEach(s => { if (lsHasPend(s)) out.push(s.n); }));
  return out.sort((x, y) => y - x).slice(0, 60);
}

/* The newest step with an unfinished call (preferring one that runs `tool`), or null. */
function loPendStep(a, tool) {
  let any = null;
  for (let ti = a.turns.length - 1; ti >= 0; ti--) {
    const st = a.turns[ti].steps;
    for (let i = st.length - 1; i >= 0; i--) {
      const c = st[i].calls.find(x => x.st === 'pend');
      if (!c) continue;
      if (!tool || c.name === tool) return st[i];
      if (!any) any = st[i];
    }
  }
  return any;
}

/* A follower of this agent (a replay view or an open dialog) keeps its data fresh and appends rows itself: leave it alone. */
const loFollowed = id => !!A[id] && (LS_ACTIVE[id] || 0) > 0;

/* ---- what is stale */

/* Agents that must be refreshed before `spec` can be shown. */
function loStaleIds(spec) {
  const ids = new Set();
  if (!spec || typeof spec !== 'object') return [];
  const need = (id, n) => {
    const a = A[id];
    if (!a) { ids.add(id); return; }
    if (loFollowed(id)) return;
    const hit = mdFindStep(a, n);
    if (!hit || lsHasPend(hit.s)) ids.add(id);
  };
  if (spec.type === 'step') need(spec.agent, spec.step);
  else if (spec.type === 'steps') (spec.steps || []).forEach(x => (x && typeof x === 'object' ? need(x.agent, x.step) : need(spec.agent, x)));
  else if (spec.type === 'agent') { if (!A[spec.agent]) ids.add(spec.agent); }
  else if (spec.type === 'turn') {
    const id = spec.agent || 'main', a = A[id];
    if (!a || (!a.turns[+spec.turn] && !loFollowed(id))) ids.add(id);
  }
  return Array.from(ids).filter(Boolean).slice(0, LO_MAX_AGENTS);
}

/* Is "agent X at time ts / step n / the running call" beyond what the page has? */
function loStaleAt(agentId, ts, stepN, pend) {
  const a = A[agentId];
  if (!a) return true;
  if (loFollowed(agentId)) return false;
  if (pend) return true;
  if (stepN != null && !mdFindStep(a, stepN)) return true;
  return !!ts && ts > loLastTs(a) + 3000;
}

/* ---- the request */

async function loDoFetch(id) {
  for (let i = 0; i < LO_WARM_TRIES; i++) {
    const a = A[id];
    const url = '/api/steps/' + D.meta.liveKey + '?agent=' + encodeURIComponent(id) + '&after=' + (a ? loStepCount(a) : 0) + '&turns=' + (a ? a.turns.length : 0) +
      '&known=' + D.agents.length + '&pend=' + (a ? loPendNums(a).join(',') : '') + (a ? '' : '&full=1');
    let j;
    try {
      const r = await fetch(url, {cache: 'no-store'});
      j = await r.json();
    } catch (e) {
      return {ok: false, err: '读取失败（' + String(e && e.message || e) + '）'};
    }
    if (j.restarting) return {ok: false, err: '服务正在更新，几秒后再试'};
    if (!j.ok) return {ok: false, err: j.error || '服务端返回了错误'};
    if (j.reset) return {ok: false, err: '数据与服务端不一致（会话文件被改写），请点「刷新回看数据」'};
    if (j.warming) { await loWait(LO_WARM_WAIT); continue; }
    const ag = A[id] || lsAddAgent(j.agentRec || j.stats);
    const info = lsMerge(ag, j);
    LO.last.set(id, Date.now());
    LS_TAPS.forEach(f => { try { f(ag, info); } catch (e) { /* a dialog repaint must not fail the click */ } });   // an open dialog repaints
    return {ok: true};
  }
  return {ok: false, err: '服务端还在解析这个会话，稍后再点一次'};
}

const loStepCount = a => a.turns.reduce((n, t) => n + t.steps.length, 0);

/* One request per agent at a time: clicks that arrive while it runs share its answer. */
function loFetchAgent(id) {
  if (LO.busy.has(id)) return LO.busy.get(id);
  if (A[id] && Date.now() - (LO.last.get(id) || 0) < LO_GAP_MS) return Promise.resolve({ok: true});
  const p = loDoFetch(id).then(r => { LO.busy.delete(id); return r; }, e => { LO.busy.delete(id); return {ok: false, err: String(e && e.message || e)}; });
  LO.busy.set(id, p);
  return p;
}

/* Fetches for all `ids` with a short "loading" state on the clicked element and a toast. Resolves with '' or the first error. */
async function loFetchAll(ids, opts) {
  const el = opts.el;
  if (el && el.classList) { el.classList.add('lo-busy'); el.setAttribute('aria-busy', 'true'); }
  toast(LO_MSG);
  try {
    const rs = await Promise.all(ids.map(loFetchAgent));
    const bad = rs.find(r => !r.ok);
    return bad ? bad.err || '读取失败' : '';
  } finally {
    if (el && el.classList) { el.classList.remove('lo-busy'); el.removeAttribute('aria-busy'); }
    const t = document.getElementById('toast');
    if (t && t.textContent === LO_MSG) t.hidden = true;
  }
}

/* ---- opening */

/* Shows the dialog, or says why it cannot. `spec` was resolved against the data after the refresh; `err` is the refresh error. */
function loFinish(spec, err, opts) {
  if (!spec) { toast(err ? '读取最新步骤失败：' + err : '回看数据里没有这个代理，点「刷新回看数据」更新。'); return false; }
  if (err && !mdResolve(spec).ok) { toast('读取最新步骤失败：' + err); return false; }
  showDetail(spec);
  if (err) toast('读取最新步骤失败：' + err + '（先显示已有数据）');
  else if (opts.ts && opts.fetched) {
    const a = A[opts.agent];
    if (a && opts.ts > loLastTs(a) + 3000) toast('这一步刚发生，服务端还没读到，先显示最近的一步；几秒后再点一次。');
  } else if (opts.ts && !D.meta.active && opts.ts > D.meta.end + 3000) toast('这一步发生在回看数据生成之后，点「刷新回看数据」才看得到。');
  return true;
}

function loRun(ids, resolve, opts) {
  if (!ids.length) return loFinish(resolve(), '', opts);
  return loFetchAll(ids, opts).then(err => loFinish(resolve(), err, Object.assign({fetched: true}, opts)));
}

/* Opens `spec` (the showDetail specs), fetching what the page does not have yet. Returns true / a promise of true when shown. */
function liveOpen(spec, opts) {
  opts = opts || {};
  return loRun(D.meta.active ? loStaleIds(spec) : [], () => spec, opts);
}

/* Opens "agent X at time ts" (jumpTo's contract). opts.pend: the call that is running now (opts.tool: its tool name). */
function liveOpenAt(agentId, ts, turn, stepN, opts) {
  opts = Object.assign({}, opts, {agent: agentId, ts});
  const stale = D.meta.active && (turn ? !A[agentId] || (!!ts && !loFollowed(agentId) && ts > loLastTs(A[agentId]) + 3000) : loStaleAt(agentId, ts, stepN, opts.pend));
  const resolve = () => {
    const a = A[agentId];
    if (a && opts.pend) {
      const s = loPendStep(a, opts.tool);
      if (s) return {type: 'step', agent: agentId, step: s.n};
    }
    return mdFromTime(agentId, ts, turn, stepN);
  };
  return loRun(stale ? [agentId] : [], resolve, opts);
}

/* ---- clickable markup: data-lo='{"agent":id,"ts":ms,"pend":1,"tool":name}' (cards of the live tab and the agent graph) */
const loAttr = o => ' data-lo="' + esc(JSON.stringify(o)) + '" tabindex="0" role="button"';

function loOpenEl(el) {
  let o = null;
  try { o = JSON.parse(el.getAttribute('data-lo')); } catch (e) { return; }
  if (!o || !o.agent) return;
  liveOpenAt(o.agent, o.ts || 0, false, null, {pend: !!o.pend, tool: o.tool, el});
}
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const el = e.target.closest && e.target.closest('[data-lo]');
  if (!el) return;
  const inner = e.target.closest('a,button,input,select,summary');
  if (inner && inner !== el && el.contains(inner)) return;
  e.preventDefault();
  loOpenEl(el);
});
document.addEventListener('keydown', e => {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.defaultPrevented) return;
  const el = e.target;
  if (!el.matches || !el.matches('[data-lo]') || /^(A|BUTTON|INPUT|SELECT|SUMMARY)$/.test(el.tagName)) return;
  e.preventDefault();
  loOpenEl(el);
});
