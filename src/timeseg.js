'use strict';
/* Time segmentation shared by the timeline, the single-agent view and the statistics.
 *
 * One agent's lifetime [start, end] is cut into non-overlapping segments, each in exactly one category, so that the
 * segments add up to the total duration. The Claude and Codex parsers produce the same turns -> steps -> calls model,
 * so the same rules serve both. Categories (see TS_CATS):
 *   tool categories   a call is executing (read / test / write / git / wait / agent / other)
 *   subwait           blocked on sub-agents: a foreground dispatch, a wait-for-task tool, or idle with children running
 *   think             the model is generating: from the previous result or trigger to the next message
 *   user              the turn has ended and the agent waits for the next message
 *   idle              nothing above explains it (e.g. a gap in the recording)
 * Claims compete by priority; the winner of each instant owns it:
 *   1 tool executions (the call that started first wins among parallel calls)  2 waiting for sub-agents after a turn
 *   ended when a machine message wakes it  3 waiting for the user  4 generation  5 children running  6 unknown
 */

const TS_ORDER = ['read', 'test', 'write', 'git', 'wait', 'agent', 'other', 'subwait', 'think', 'user', 'idle'];
/* Names, colours and a plain-language meaning of every category; colours are CSS variables (theme aware), defined in
 * replay.css / tl_focus.css. The meanings follow the rules above, tsCallCat and the command classifier (common.py). */
const TS_CATS = {
  read: {label: '读代码与文档', color: 'var(--c-read)', tool: true, hint: '读文件、搜索、列目录这类只读命令和工具在执行'},
  test: {label: '测试与检查', color: 'var(--c-test)', tool: true, hint: '跑测试、lint、类型检查（构建不算，归「其他命令」）'},
  write: {label: '写代码', color: 'var(--c-write)', tool: true, hint: '改文件、写文件、装依赖这类命令和工具在执行'},
  git: {label: 'git', color: 'var(--c-git)', tool: true, hint: 'git 或 gh 命令在执行'},
  wait: {label: '等待与轮询', color: 'var(--c-wait)', tool: true, hint: 'sleep、until / while 轮询、tail -f 这类等待命令在执行'},
  agent: {label: '派子代理', color: 'var(--c-agent)', tool: true, hint: '派出子代理的调用本身（后台派单只算派出的那一下）'},
  other: {label: '其他命令', color: 'var(--c-other)', tool: true, hint: '其余命令和工具在执行，包括构建'},
  subwait: {label: '等子代理', color: 'var(--c-subwait)', hint: '阻塞在子代理上：前台派单、等后台任务的工具，或一轮结束后子代理还在跑'},
  think: {label: '思考或输出', color: 'var(--c-think)', hint: '模型在生成：从上一个结果或触发消息到下一条消息写完'},
  user: {label: '等你回复', color: 'var(--c-user)', hint: '一轮结束后，等你发下一条消息'},
  idle: {label: '空闲（未知）', color: 'var(--c-idle)', hint: '上面都解释不了的空档，例如记录里的缺口'}
};
const TS_WAIT_TASK = /(^|\+)(TaskOutput|AgentOutput|wait_agent|wait_threads)(\+|$)/;  // block until background work reports
const TS_MACHINE = {notify: 1, handback: 1, agentmsg: 1, silent: 1};                    // wake-ups that are not a user message
const TS_END_SLACK = 5000;  // a Codex task_complete this close to the last activity belongs to the waiting window

/* A foreground Claude dispatch blocks the parent until the child reports; Codex spawn_agent returns at once. A parser marks
 * a dispatch call that blocks until the child is done with disp.block (Gemini invoke_agent). */
function tsBlockingDispatch(c) { return !!c.disp && !c.bg && (c.name === 'Agent' || c.name === 'Task' || !!c.disp.block); }
function tsCallCat(c, hasKids) {
  if (tsBlockingDispatch(c)) return 'subwait';
  if (hasKids && TS_WAIT_TASK.test(c.name || '')) return 'subwait';
  return TS_CATS[c.cat] && TS_CATS[c.cat].tool ? c.cat : 'other';
}
function tsLookup(opts) {
  if (opts && opts.lookup) return opts.lookup;
  return id => (typeof A !== 'undefined' ? A[id] : null);
}

/* Time ranges in which each sub-agent dispatched by `agent` was running: dispatch (or its own start) to hand-back. */
function childSpans(agent, lookup) {
  const hb = {};
  agent.turns.forEach(t => [t.trig].concat(t.evs).forEach(e => {
    if (e.k === 'handback' && e.from && e.ts && !(e.from in hb)) hb[e.from] = e.ts;
  }));
  const out = [];
  agent.turns.forEach((t, ti) => t.steps.forEach(s => s.calls.forEach(c => {
    if (!c.agent) return;
    const ch = lookup(c.agent);
    const t0 = (ch && ch.start) || c.ts;
    let t1 = tsBlockingDispatch(c) && c.dur > 0 ? c.ts + c.dur : (hb[c.agent] || c.bgDone || (ch && ch.end) || t0);
    out.push({id: c.agent, t0, t1: Math.max(t0, t1), call: c, step: s, ti, hb: hb[c.agent] || 0});
  })));
  return out;
}

/* End of a turn (0 when it did not end): the explicit marker when the parser recorded one, else a final reply without tools. */
function tsTurnEnd(t) {
  const last = t.steps[t.steps.length - 1];
  if (!last) return 0;
  const la = Math.max(last.fin || 0, last.end || 0, last.ts || 0);
  if (t.end) return t.end - la <= TS_END_SLACK ? la : t.end;
  if (last.stop) return last.stop === 'tool_use' ? 0 : la;
  return last.calls.length ? 0 : la;
}

/* When the agent is free to go on after a step: its last foreground result (a background launch does not block). */
function tsStepDone(s) {
  let d = 0;
  s.calls.forEach(c => { if (!c.bg) d = Math.max(d, c.ts + (c.dur || 0)); });
  if (d) return d;
  return s.calls.length ? Math.min.apply(null, s.calls.map(c => c.ts)) : (s.fin || s.end || s.ts);
}

function tsBuild(agent, lookup) {
  const flat = [], turnLast = [];
  agent.turns.forEach((t, ti) => {
    t.steps.forEach((s, si) => flat.push({s, t, ti, si, idx: flat.length}));
    turnLast.push(flat.length - 1);
  });
  let T0 = agent.start || agent._s || 0;
  let T1 = agent.end || agent._e || 0;
  if (!T0 && flat.length) T0 = flat[0].s.ts;
  if (T1 < T0) T1 = T0;
  const res = {segs: [], by: {}, T0, T1, flat, spans: [], hasKids: false};
  TS_ORDER.forEach(k => { res.by[k] = 0; });
  if (T1 <= T0) return res;
  const spans = res.spans = childSpans(agent, lookup);
  const hasKids = spans.length > 0 || flat.some(f => f.s.calls.some(c => c.agent || c.disp));
  res.hasKids = hasKids;
  const claims = [];
  let ord = 0;
  const add = (a, b, cat, prio, extra) => {
    const st = a;
    a = Math.max(a, T0);
    b = Math.min(b, T1);
    if (b > a) claims.push(Object.assign({a, b, st, cat, prio, ord: ord++}, extra));
  };

  flat.forEach((f, i) => {
    const s = f.s, prev = i ? flat[i - 1].s : null;
    // 1 tool executions: only the part of the call the model is waiting on (a background launch is just the start)
    s.calls.forEach((c, ci) => { if (c.dur > 0) add(c.ts, c.ts + c.dur, tsCallCat(c, hasKids), 1, {si: i, c, ci, s}); });
    // 4 generation: previous result / trigger -> the message is complete (first tool_use, or the end of a text reply)
    const gEnd = s.calls.length ? Math.min.apply(null, s.calls.map(c => c.ts)) : (s.fin || s.end || s.ts);
    let ready = prev ? tsStepDone(prev) : T0;  // the agent's first generation starts when the agent does
    if (f.si === 0 && f.t.trig.ts && prev) ready = Math.max(ready, f.t.trig.ts);
    f.t.evs.forEach(e => { if (e.at <= f.si && e.ts && e.ts <= gEnd && e.k !== 'compact' && e.k !== 'compactsum') ready = Math.max(ready, e.ts); });
    add(ready, gEnd, 'think', 4, {si: i, s});
  });

  // 2 / 3 after a turn ended: waiting for the next message; a machine wake-up (notify / hand-back) while children still run
  // means the agent was waiting for them, not for the user
  agent.turns.forEach((t, ti) => {
    const ws = tsTurnEnd(t);
    if (!ws) return;
    const nt = agent.turns[ti + 1];
    const we = nt ? (nt.trig.ts || (nt.steps[0] && nt.steps[0].ts) || T1) : T1;
    if (we <= ws) return;
    if (nt && TS_MACHINE[nt.trig.k]) spans.forEach(sp => add(Math.max(ws, sp.t0), Math.min(we, sp.t1), 'subwait', 2, {si: turnLast[ti]}));
    add(ws, we, 'user', 3, {si: turnLast[ti]});
  });
  // 5 / 6 whatever is left: children running -> waiting for them, else unknown
  spans.forEach(sp => add(sp.t0, sp.t1, 'subwait', 5, {}));
  add(T0, T1, 'idle', 6, {});

  tsSweep(claims, T0, T1, res);
  return res;
}

function tsBetter(c, w) {
  if (c.prio !== w.prio) return c.prio < w.prio;
  return c.st !== w.st ? c.st < w.st : c.ord < w.ord;
}
/* Sweep the claims over the boundaries; the best active claim owns each elementary interval. Pieces of one claim are merged. */
function tsSweep(claims, T0, T1, res) {
  claims.sort((x, y) => x.a - y.a);
  const set = new Set([T0, T1]);
  claims.forEach(c => { set.add(c.a); set.add(c.b); });
  const pts = Array.from(set).sort((x, y) => x - y);
  let active = [], ci = 0, last = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    while (ci < claims.length && claims[ci].a <= a) active.push(claims[ci++]);
    active = active.filter(c => c.b > a);
    let win = null;
    active.forEach(c => { if (!win || tsBetter(c, win)) win = c; });
    if (!win) continue;
    if (last && last.claim === win || (last && last.t1 === a && last.cat === win.cat && !last.c && !win.c && last.stepIdx === win.si)) {
      last.t1 = b;
    } else {
      last = {t0: a, t1: b, cat: win.cat, claim: win};
      if (win.si != null) last.stepIdx = win.si;
      if (win.c) { last.c = win.c; last.ci = win.ci; }
      if (win.s) last.s = win.s;
      res.segs.push(last);
    }
  }
  res.segs.forEach(sg => { delete sg.claim; res.by[sg.cat] += sg.t1 - sg.t0; });
}

/* Cached on the agent object: the segmentation is computed once. */
function timeSegData(agent, opts) {
  if (!agent._tseg) agent._tseg = tsBuild(agent, tsLookup(opts));
  return agent._tseg;
}
function timeSegments(agent, opts) { return timeSegData(agent, opts).segs; }
function timeByCategory(agent, opts) { return Object.assign({}, timeSegData(agent, opts).by); }
