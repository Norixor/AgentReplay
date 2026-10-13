'use strict';
/* Detail dialog, model part (the dialog itself is modal.js / modal_view.js). Pure functions over the page data (A, D): turn a
 * spec into what the dialog shows, and the layer stack behind the "back" button.
 *
 * spec = {type: 'step',  agent, step}
 *      | {type: 'steps', agent, steps: [n | {agent, step}], title?}
 *      | {type: 'agent', agent}
 *      | {type: 'turn',  turn, agent? (default main)}
 * Unknown agents or step numbers never throw: the result is {ok: false, msg} with a message the dialog can show. */

const MD_MAX_STEPS = 300;     // longest list the dialog renders (a long critical-path piece can cover thousands of steps)
const MD_RECENT = 20;         // steps listed in an agent summary

const mdName = id => (id === 'main' ? '主代理' : A[id] ? A[id].desc : String(id));

/* number -> {s, t, ti} for one agent; rebuilt when steps were appended by a live update. */
function mdStepIndex(a) {
  let n = 0;
  a.turns.forEach(t => { n += t.steps.length; });
  if (!a._mdIdx || a._mdIdx.n !== n) {
    const by = new Map();
    a.turns.forEach((t, ti) => t.steps.forEach(s => by.set(s.n, {s, t, ti})));
    a._mdIdx = {n, by};
  }
  return a._mdIdx.by;
}
const mdFindStep = (a, n) => mdStepIndex(a).get(+n) || null;

const mdNoAgent = id => ({ok: false, msg: '回看数据里没有这个代理（' + id + '）。点「刷新回看数据」更新后再试。'});

function mdResolve(spec) {
  if (!spec || typeof spec !== 'object') return {ok: false, msg: '没有要显示的内容。'};
  const type = spec.type;
  if (type === 'turn') {
    const id = spec.agent || 'main', a = A[id];
    if (!a) return mdNoAgent(id);
    const ti = +spec.turn, t = a.turns[ti];
    if (!t) return {ok: false, msg: mdName(id) + '没有第 ' + (ti + 1) + ' 轮（可能是回看数据还没更新）。'};
    return {ok: true, type, a, t, ti, title: mdName(id) + ' · 第 ' + (ti + 1) + ' 轮'};
  }
  if (type === 'agent') {
    const a = A[spec.agent];
    return a ? {ok: true, type, a, title: mdName(a.id)} : mdNoAgent(spec.agent);
  }
  if (type === 'step') {
    const a = A[spec.agent];
    if (!a) return mdNoAgent(spec.agent);
    const hit = mdFindStep(a, spec.step);
    if (!hit) return {ok: false, msg: mdName(a.id) + '里没有第 #' + spec.step + ' 步（可能是回看数据还没更新）。'};
    return {ok: true, type, a, s: hit.s, t: hit.t, ti: hit.ti, title: mdName(a.id) + ' · 第 #' + hit.s.n + ' 步'};
  }
  if (type === 'steps') {
    const items = [];
    let missing = 0, total = 0;
    (spec.steps || []).forEach(x => {
      total++;
      if (items.length >= MD_MAX_STEPS) return;
      const id = x && typeof x === 'object' ? x.agent : spec.agent, n = x && typeof x === 'object' ? x.step : x;
      const a = A[id], hit = a && mdFindStep(a, n);
      if (hit) items.push({a, s: hit.s, t: hit.t, ti: hit.ti}); else missing++;
    });
    return {ok: true, type, items, missing, total, capped: total > MD_MAX_STEPS,
      title: spec.title || (spec.agent && A[spec.agent] ? mdName(spec.agent) + ' · ' : '') + total + ' 步'};
  }
  return {ok: false, msg: '不认识的内容类型：' + type};
}

/* Step numbers of agent `a` that overlap [t0, t1]. */
function mdStepsInRange(a, t0, t1) {
  const out = [];
  if (!a) return out;
  a.turns.forEach(t => t.steps.forEach(s => { if (s.ts <= t1 && Math.max(s.end || 0, s.ts) >= t0) out.push(s.n); }));
  return out;
}

/* The last `n` steps, newest first (what an agent summary lists). */
function mdRecent(a, n) {
  const out = [];
  for (let ti = a.turns.length - 1; ti >= 0 && out.length < n; ti--) {
    const st = a.turns[ti].steps;
    for (let i = st.length - 1; i >= 0 && out.length < n; i--) out.push({a, s: st[i], t: a.turns[ti], ti});
  }
  return out;
}

/* Agent facts shown in the summary. */
function mdAgentFacts(a) {
  let peak = 0;
  a.turns.forEach(t => t.steps.forEach(s => { if (s.ctx > peak) peak = s.ctx; }));
  return {peak, dur: Math.max(0, (a.end || 0) - (a.start || 0))};
}

/* The spec for "what was agent X doing at time ts" (the old jump targets): a turn, the named step, or the step running at ts. */
function mdFromTime(agentId, ts, turn, stepN) {
  const a = A[agentId];
  if (!a) return null;
  if (turn && a.turns.length) return {type: 'turn', agent: agentId, turn: findTurnAt(a, ts || 0)};
  if (stepN != null && mdFindStep(a, stepN)) return {type: 'step', agent: agentId, step: stepN};
  const hit = ts ? findStepAt(a, ts) : null;
  if (hit) return {type: 'step', agent: agentId, step: hit.s.n};
  return {type: 'agent', agent: agentId};
}

/* The replay hash behind "open in the replay page": the one place where the dialog navigates, and only on request. */
function mdReplayHash(spec) {
  const r = mdResolve(spec);
  if (!r.ok) return '#overview';
  if (r.type === 'agent') return r.a.id === 'main' ? '#main' : '#agent/' + r.a.id;
  if (r.type === 'turn') return jumpHash(r.a.id, r.t.trig.ts || (r.t.steps[0] && r.t.steps[0].ts), true);
  if (r.type === 'step') return jumpHash(r.a.id, r.s.ts, false, r.s.n);
  const f = r.items[0];
  return f ? jumpHash(f.a.id, f.s.ts, false, f.s.n) : '#overview';
}

/* ---- layer stack (immutable: every function returns a new array) */
const mdSameSpec = (x, y) => JSON.stringify(x) === JSON.stringify(y);
function mdStackPush(stack, spec) {
  return stack.length && mdSameSpec(stack[stack.length - 1], spec) ? stack : stack.concat([spec]);
}
const mdCanBack = stack => stack.length > 1;
const mdStackBack = stack => (stack.length > 1 ? stack.slice(0, -1) : stack);

/* data-md attribute value of a clickable element (JSON, escaped for an attribute). */
const mdAttr = spec => ' data-md="' + esc(JSON.stringify(spec)) + '"';
