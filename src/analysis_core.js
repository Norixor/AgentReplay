'use strict';
/* Shared building blocks of the time-analysis tab and the single-agent statistics: command normalisation, per-step time,
 * repeated-command grouping, and the "scope" (an agent plus its descendants) the analysis page works on.
 * Everything here is pure data in, data out (no DOM), so scripts/test_analysis.mjs can run it on constructed agents. */

const ANA_WORK_CATS = ['read', 'test', 'write', 'git', 'agent', 'other'];  // tool categories that count as "the agent is working"
const ANA_TOOL_CATS = ['read', 'test', 'write', 'git', 'wait', 'agent', 'other'];
const ANA_WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/i;

/* Commands with run-specific noise (hashes, numbers) removed, so repeated invocations fall into one group. */
function normStr(s) {
  const base = String(s || '').replace(/\s+…$/, '').replace(/\s+/g, ' ').trim();
  return base.replace(/\b[0-9a-f]{7,40}\b/g, '<hash>').replace(/\b\d+(\.\d+)?\b/g, '<n>');
}
function normCmd(c) { return normStr(c.sum || c.desc); }

/* The time each step accounts for: its generation plus the tools it ran (waiting for the user is not the step's time). */
function stepTimes(T) {
  const rows = T.flat.map((f, i) => ({f, i, ms: 0, main: null, mainMs: 0}));
  T.segs.forEach(sg => {
    if (sg.stepIdx == null || sg.cat === 'user') return;
    const r = rows[sg.stepIdx], d = sg.t1 - sg.t0;
    r.ms += d;
    if (sg.c && d > r.mainMs) { r.main = sg; r.mainMs = d; }
  });
  return rows;
}

/* A step's amount shared evenly between its calls (null when the step has no price). */
function anaShare(s) { return s.cost == null ? null : s.cost / Math.max(1, s.calls.length); }

/* Groups of calls whose normalised command is the same and which ran more than once.
 * items: [{c, s}]; each group {name, cmd, n, total, first, firstStep, cost, nUnp}; sorted by total time, then count. */
function repeatGroups(items) {
  const groups = new Map();
  items.forEach(it => {
    const c = it.c;
    if (c.disp || c.name === 'SubagentHandback' || !(c.sum || c.desc)) return;
    const key = c.name + '\u0000' + normCmd(c);
    let g = groups.get(key);
    if (!g) groups.set(key, g = {name: c.name, cmd: normCmd(c), n: 0, total: 0, first: c, firstStep: it.s, firstItem: it, cost: 0, nUnp: 0});
    g.n++;
    g.total += c.dur > 0 ? c.dur : 0;
    const sh = anaShare(it.s);
    if (sh == null) g.nUnp++; else g.cost += sh;
  });
  return Array.from(groups.values()).filter(g => g.n > 1).sort((x, y) => y.total - x.total || y.n - x.n);
}

function anaMedian(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const anaIsShell = c => c.shell != null ? !!c.shell : (c.name === 'Bash' || c.name === 'Monitor');
const anaIsMutation = c => c.cat === 'write' || ANA_WRITE_TOOLS.test(c.name || '') || !!c.merge;
const anaIsWaitCall = c => c.cat === 'wait' || TS_WAIT_TASK.test(c.name || '');

/* Amount of a set of distinct steps: priced steps are summed, the others are counted (they are not in the amount). */
function anaCostSum(steps) {
  const seen = new Set();
  const out = {cost: 0, steps: 0, nUnp: 0};
  steps.forEach(s => {
    if (seen.has(s)) return;
    seen.add(s);
    out.steps++;
    if (s.cost == null) out.nUnp++; else out.cost += s.cost;
  });
  out.priced = out.steps - out.nUnp;
  return out;
}

/* Number of agents running at a time: ranges [[t0, t1], ...] -> {at(t), avg (while anything runs), max}. */
function anaConcurrency(ranges) {
  const ev = [];
  ranges.forEach(r => { if (r[1] > r[0]) { ev.push([r[0], 1]); ev.push([r[1], -1]); } });
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const ts = [], cs = [];
  let c = 0, max = 0, area = 0, busy = 0, prev = 0;
  ev.forEach(e => {
    if (c > 0) { area += c * (e[0] - prev); busy += e[0] - prev; }
    c += e[1];
    prev = e[0];
    if (c > max) max = c;
    ts.push(e[0]);
    cs.push(c);
  });
  return {
    max, avg: busy ? area / busy : 0,
    at(t) {
      let lo = 0, hi = ts.length - 1, r = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
      return r < 0 ? 0 : cs[r];
    }
  };
}

/* Work / waiting split of one agent's lifetime from its segmentation (milliseconds). */
function anaTimeSplit(T) {
  const by = T.by;
  let work = by.think;
  ANA_WORK_CATS.forEach(k => { work += by[k] || 0; });
  return {total: Math.max(0, T.T1 - T.T0), work, subwait: by.subwait, poll: by.wait, user: by.user, idle: by.idle, wait: by.subwait + by.wait + by.user};
}

/* Everything the analysis needs for the agent `rootId` and its descendants.
 *   get(id) -> agent object (null when unknown); lookup is handed to timeSegData so the segmentation matches the chart.
 * Result: {rootId, ids, rows, byId, calls, conc, tok, cost, nUnp}; rows[i] = {id, a, T, calls}; a call item is
 * {r (row), a, T, f (flat step entry), s (step), c (call), q (index inside the agent's call sequence), si (step index)}. */
function anaBuildScope(rootId, get, lookup) {
  const root = get(rootId);
  const order = [], seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    const a = get(id);
    if (!a) continue;
    seen.add(id);
    order.push(id);
    a.turns.forEach(t => t.steps.forEach(s => s.calls.forEach(c => { if (c.agent && !seen.has(c.agent)) queue.push(c.agent); })));
  }
  const rows = [], byId = {}, calls = [];
  order.forEach(id => {
    const a = get(id), T = timeSegData(a, {lookup});
    const r = {id, a, T, calls: []};
    T.flat.forEach(f => f.s.calls.forEach(c => {
      const it = {r, a, T, f, s: f.s, c, q: r.calls.length, si: f.idx};
      r.calls.push(it);
      calls.push(it);
    }));
    rows.push(r);
    byId[id] = r;
  });
  const conc = anaConcurrency(rows.map(r => [r.T.T0, r.T.T1]));
  let cost = 0, nUnp = 0;
  const tok = {in: 0, cw5: 0, cw1: 0, cr: 0, out: 0};
  rows.forEach(r => {
    cost += r.a.cost || 0;
    nUnp += r.a.nUnp || 0;
    ['in', 'cw5', 'cw1', 'cr', 'out'].forEach(k => { tok[k] += (r.a.tok && r.a.tok[k]) || 0; });
  });
  return {rootId, root, ids: order, rows, byId, calls, conc, tok, cost, nUnp};
}
