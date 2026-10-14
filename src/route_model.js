'use strict';
/* Route map, part 1: the model. Pure functions (no DOM), so scripts/test_route.mjs can run them under node.
 *
 * Store   per agent: flat step list (the page's step objects) + trigger events (user message, compaction, hand-back).
 *         It is fed by the page data D, by /api/steps increments, or by the /api/live "recent" fallback; every ingest
 *         is idempotent (steps are keyed by step number, events by kind+time+source, fallback steps by call timestamp).
 * Items   one per tool call or event, ordered by time inside an agent.
 * Nodes   three levels of detail (gran):
 *           overview  key items only (user message, dispatch, hand-back, test, failure/block, merge, compaction, the call
 *                     still running); the plain calls between two key items fold into one grey "strip" node. A strip the
 *                     reader opened (opts.expanded) shows its calls as stage nodes instead.
 *           stage     adjacent plain calls of one category merge into one node.
 *           step      one node per item.
 *         Node ids derive from the first item, so they stay stable while a node grows.
 * Lanes   one per agent, with the active span [s0, s1] (s1 = 0 while running) used for the lane's background.
 * Edges   fork (dispatch -> child's first node; tFrom = dispatch time, tTo = child start), join (child's last node ->
 *         hand-back node or the parent's next node; tFrom = child end, tTo = hand-back time), retry (a failed/blocked
 *         node -> the next node of the same kind, labelled "retry N").
 */

const RM = {};
RM.EV_KEEP = {human: 'user', compact: 'compact', handback: 'recv'};
RM.RETRY_SPAN = 12;     // a retry must show up within this many nodes of the failure

const rmClip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const rmFirst = s => String(s || '').split('\n').find(l => l.trim()) || '';

/* ------------------------------------------------------------------ store */
RM.createStore = function () {
  return {agents: new Map(), order: [], rev: 0};
};
RM.ensureAgent = function (st, meta) {
  let a = st.agents.get(meta.id);
  if (!a) {
    a = {id: meta.id, desc: '', model: '', effort: '', parent: '', depth: 0, start: 0, end: 0, doneTs: 0, running: false,
         steps: [], byN: new Map(), events: [], evKeys: new Set(), tsSet: new Set(), nturns: 0, synth: 0, trigs: [], trigKeys: new Set()};
    st.agents.set(meta.id, a);
    st.order.push(meta.id);
    st.rev++;
  }
  ['desc', 'model', 'effort', 'depth', 'start', 'end', 'doneTs', 'cost', 'fam'].forEach(k => { if (meta[k] != null && meta[k] !== '') a[k] = meta[k]; });
  if (meta.parent) a.parent = meta.parent;
  return a;
};
RM.addEvent = function (st, a, ev, ti) {
  const kind = RM.EV_KEEP[ev && ev.k];
  if (!kind || !ev.ts) return false;
  const key = ev.k + '@' + ev.ts + '@' + (ev.from || '');
  if (a.evKeys.has(key)) return false;
  a.evKeys.add(key);
  a.events.push({k: ev.k, kind, ts: ev.ts, text: ev.text || '', from: ev.from || '', ti: ti == null ? null : ti});
  st.rev++;
  return true;
};
/* Turn triggers of every kind (user message, task notification, cross-session message, hand-back ...), kept sorted by time:
 * route_brief.js names a folded stretch after them. */
RM.addTrig = function (a, t) {
  if (!t || !t.ts || !t.k) return;
  const key = t.k + '@' + t.ts;
  if (a.trigKeys.has(key)) return;
  a.trigKeys.add(key);
  const x = {k: t.k, ts: t.ts, text: t.text || '', from: t.from || ''};
  if (a.trigs.length && a.trigs[a.trigs.length - 1].ts > x.ts) { a.trigs.push(x); a.trigs.sort((p, q) => p.ts - q.ts); } else a.trigs.push(x);
};
/* Add steps not seen before (by step number); a step number seen again replaces the old object (refreshed last step). */
RM.addSteps = function (st, id, steps) {
  const a = st.agents.get(id);
  if (!a) return 0;
  let added = 0;
  (steps || []).forEach(s => {
    if (!s || s.n == null) return;
    if (a.byN.has(s.n)) { const i = a.byN.get(s.n); a.steps[i] = s; st.rev++; return; }
    a.byN.set(s.n, a.steps.length);
    a.steps.push(s);
    (s.calls || []).forEach(c => a.tsSet.add(c.ts));
    added++;
  });
  if (added) st.rev++;
  return added;
};
/* Page data (replay.js): agents with turns -> flat steps + events. */
RM.ingestAgent = function (st, ag) {
  const a = RM.ensureAgent(st, ag);
  a.doneTs = ag.doneTs || 0;
  const steps = [];
  (ag.turns || []).forEach((t, ti) => {
    t.steps.forEach(s => steps.push(s));
    RM.addTrig(a, t.trig);
    // only the trigger opens turn `ti`; later events inside the turn carry no turn index
    [t.trig].concat(t.evs || []).forEach((e, ei) => { if (e) RM.addEvent(st, a, e, ei === 0 ? ti : null); });
  });
  a.nturns = Math.max(a.nturns, (ag.turns || []).length);
  RM.addSteps(st, ag.id, steps);
  return a;
};
RM.fromPageData = function (D) {
  const st = RM.createStore();
  D.agents.forEach(ag => RM.ingestAgent(st, ag));
  return st;
};
/* /api/steps answer -> store. Returns the number of new steps. */
RM.applyStepsAnswer = function (st, id, j) {
  const a = st.agents.get(id);
  if (!a) return 0;
  if (j.reset) { a.steps = []; a.byN = new Map(); a.tsSet = new Set(); a.events = []; a.evKeys = new Set(); a.nturns = 0; a.trigs = []; a.trigKeys = new Set(); }
  (j.agents || []).forEach(m => RM.ensureAgent(st, m));
  let n = RM.addSteps(st, id, j.steps);
  RM.addSteps(st, id, j.updated);
  (j.turns || []).forEach(t => {
    RM.addTrig(a, t.trig);
    [t.trig].concat(t.evs || []).forEach((e, ei) => { if (e) RM.addEvent(st, a, e, ei === 0 ? t.ti : null); });
    a.nturns = Math.max(a.nturns, (t.ti || 0) + 1);
  });
  if (j.state === 'done' && j.stats && j.stats.doneTs) a.doneTs = j.stats.doneTs;
  else if (j.stats && j.stats.doneTs) a.doneTs = j.stats.doneTs;
  if (j.state) a.running = j.state !== 'done';
  return n;
};
/* /api/live snapshot fallback: synthetic steps from each card's `recent`, de-duplicated by call timestamp. */
RM.guessCat = function (tool, sum) {
  tool = String(tool || ''); sum = String(sum || '');
  if (/^(Read|Grep|Glob|LSP|WebFetch|WebSearch|NotebookRead|ListSkills|SearchSkills)$/.test(tool)) return 'read';
  if (/^(Edit|Write|NotebookEdit)$/.test(tool)) return 'write';
  if (/^(Agent|Task|SendMessage)$/.test(tool)) return 'agent';
  if (tool === 'Monitor') return 'wait';
  if (tool === 'Bash') {
    if (/\b(pytest|jest|vitest|mocha|unittest|tsc|eslint|ruff|lint)\b|\b(test|check)\b|node\s+--check/.test(sum)) return 'test';
    if (/^\s*git\b/.test(sum)) return 'git';
    if (/\b(sleep|until|while)\b/.test(sum)) return 'wait';
  }
  return 'other';
};
RM.applyLive = function (st, d, opts) {
  let added = 0;
  const withSteps = !(opts && opts.steps === false);
  const cards = (d.cards || []).concat(d.returned || []);
  const seenIds = new Set();
  cards.forEach(c => {
    seenIds.add(c.id);
    const a = RM.ensureAgent(st, {id: c.id, desc: c.desc, model: c.model, effort: c.effort, parent: c.parent && c.parent !== c.id ? c.parent : '', depth: c.depth, start: c.start, doneTs: c.doneTs || 0});
    a.running = !c.done;
    if (c.done && c.doneTs) a.doneTs = c.doneTs;
    if (!withSteps) return;
    (c.recent || []).slice().reverse().forEach(r => {
      if (!r.ts || a.tsSet.has(r.ts)) return;
      a.tsSet.add(r.ts);
      a.synth++;
      const call = {name: r.tool || '', cat: RM.guessCat(r.tool, r.sum), ts: r.ts, dur: r.dur || 0, st: r.st || 'ok', bg: false, desc: r.why || '', sum: r.sum || '', hook: r.st === 'hook' ? (r.why || '') : ''};
      // negative numbers keep synthetic steps apart from real step numbers
      const s = {n: -r.ts, ts: r.ts, end: r.ts + (r.dur || 0), cost: null, calls: [call], said: '', synthetic: true};
      a.byN.set(s.n, a.steps.length);
      a.steps.push(s);
      added++;
    });
  });
  st.agents.forEach(a => { if (!seenIds.has(a.id)) a.running = false; });
  (d.events || []).forEach(e => {
    const a = st.agents.get(e.agent);
    if (a && (e.k === 'user' || e.k === 'compact')) RM.addEvent(st, a, {k: e.k === 'user' ? 'human' : 'compact', ts: e.ts, text: e.text});
  });
  if (added) st.rev++;
  return added;
};

/* ------------------------------------------------------------------ items */
const RM_PATH_TOOLS = {Read: 1, Edit: 1, Write: 1, NotebookEdit: 1};
RM.fileOf = function (c) {
  return String(c.sum || '').replace(/ @\d+$/, '');
};
RM.baseName = p => { p = String(p || ''); const i = p.lastIndexOf('/'); return i >= 0 && i < p.length - 1 ? p.slice(i + 1) : p; };
RM.shortCmd = function (sum) {
  let s = String(sum || '').trim();
  const segs = s.split(/&&|;|\|\|/).map(x => x.trim()).filter(x => x && !/^(cd|export|set)\b/.test(x));
  s = (segs.length ? segs[segs.length - 1] : s).replace(/^(\w+=\S+\s+)+/, '');
  return rmClip(s.split(/\s+/).slice(0, 4).join(' '), 30);
};
/* One call (or event) -> item. Cost of a step is split evenly between its calls. */
RM.itemOfCall = function (s, c, ci) {
  let kind = 'act';
  if (c.disp) kind = 'dispatch';
  else if (c.st === 'hook') kind = 'hook';
  else if (c.merge) kind = 'merge';
  else if (c.cat === 'test') kind = 'test';
  const n = (s.calls || []).length || 1;
  return {key: 'c' + s.n + '.' + ci, kind, cat: c.cat || 'other', ts: c.ts, t1: c.ts + (c.bg ? 0 : (c.dur || 0)), st: c.st || 'ok', name: c.name || '',
          sum: c.sum || '', desc: c.desc || '', why: c.desc || rmFirst(s.said), hook: c.hook || '', child: c.agent || '', disp: c.disp || null,
          merge: c.merge || '', bgDone: c.bg && c.bgDone ? c.bgDone : 0, step: s.n < 0 ? null : s.n, cost: s.cost == null ? null : s.cost / n, file: RM_PATH_TOOLS[c.name] ? RM.fileOf(c) : '', ord: 1 + ci,
          call: c, src: s};   // the page's own call / step objects, for stepBrief (route_brief.js)
};
RM.itemOfEvent = function (e) {
  return {key: 'e' + e.k + '@' + e.ts + '@' + e.from, kind: e.kind, cat: 'event', ts: e.ts, t1: e.ts, st: 'ok', name: e.k, sum: e.text, desc: '', why: '',
          hook: '', child: e.kind === 'recv' ? e.from : '', disp: null, merge: '', bgDone: 0, step: null, cost: null, file: '', ord: 0, text: e.text, ti: e.ti};
};
RM.items = function (a) {
  const out = [];
  a.steps.forEach(s => (s.calls || []).forEach((c, ci) => out.push(RM.itemOfCall(s, c, ci))));
  a.events.forEach(e => { if (e.kind !== 'recv' || e.from) out.push(RM.itemOfEvent(e)); });
  out.forEach((it, i) => { it.i = i; });
  out.sort((x, y) => (x.ts - y.ts) || (x.ord - y.ord) || (x.i - y.i));
  // Cost of steps that made no call (a final reply) goes to the nearest earlier item, so totals stay right.
  a.steps.forEach(s => {
    if ((s.calls || []).length || s.cost == null || !out.length) return;
    let k = 0;
    while (k < out.length - 1 && out[k + 1].ts <= s.ts) k++;
    out[k].cost = (out[k].cost || 0) + s.cost;
  });
  return out;
};

/* ------------------------------------------------------------------ nodes */
const RM_ICON = {user: '✉', dispatch: '◆', recv: '◇', hook: '✗', merge: '★', compact: '⟲', test: '✓'};
RM.CAT_TITLE = {read: '读代码', write: '改代码', git: 'git', wait: '等待', agent: '协作', other: '其他命令', test: '测试'};

RM.briefOf = function (it) {
  if (it.file) return RM.baseName(it.file);
  if (it.name === 'Grep') return rmClip(it.sum, 40);
  if (it.name === 'Bash' || it.name === 'Monitor') return RM.shortCmd(it.sum) || rmClip(it.desc, 40);
  return rmClip(it.desc || it.sum || it.name, 40);
};
RM.distinct = function (arr) { const seen = new Set(); return arr.filter(x => x && !seen.has(x) && seen.add(x)); };
RM.lines2 = function (briefs) {
  const b = RM.distinct(briefs);
  if (b.length <= 2) return b;
  return [b[0], b[1] + ' +' + (b.length - 2)];
};

RM.makeNode = function (a, items, lookupName) {
  const f = items[0], l = items[items.length - 1], n = items.length;
  const node = {id: a.id + '#' + f.key, agent: a.id, kind: f.kind, cat: f.cat, items, n, t0: f.ts, t1: Math.max.apply(null, items.map(i => i.t1)),
                st: 'ok', cost: null, child: '', from: '', firstStep: null, title: '', lines: [], icon: '', retry: 0, retryFrom: '', grp: ''};
  items.forEach(i => { if (i.cost != null) node.cost = (node.cost || 0) + i.cost; if (node.firstStep == null && i.step != null) node.firstStep = i.step; });
  if (items.some(i => i.st === 'hook')) node.st = 'hook';
  else if (items.some(i => i.st === 'err')) node.st = 'err';
  else if (items.some(i => i.st === 'pend')) node.st = 'pend';
  node.icon = RM_ICON[f.kind] || '';
  node.steps = RM.distinct(items.map(i => i.step));
  node.ti = f.kind === 'user' ? f.ti : null;
  const brief = items.map(RM.briefOf);
  switch (f.kind) {
    case 'user': node.title = '✉ ' + rmClip(f.text, 30); node.lines = []; break;
    case 'compact': node.title = '⟲ 压缩'; node.lines = f.text ? [rmClip(f.text, 60)] : []; break;
    case 'dispatch': {
      node.child = f.child;
      const nm = f.child ? lookupName(f.child) : '';
      node.title = '◆ 派单 · ' + rmClip(nm || f.desc || f.sum, 24);
      const d = f.disp || {};
      node.lines = RM.distinct([[d.model, d.effort].filter(Boolean).join('·') + (d.bg ? ' 后台' : ''), rmClip(d.reason || f.desc, 50)]).reduce((x, y) => x.concat(y), []).filter(x => x && x.trim()).slice(0, 2);
      break;
    }
    case 'recv': {
      node.from = node.child = f.child;
      node.title = '◆ 收到交回 · ' + rmClip(lookupName(f.child) || f.child, 22);
      node.lines = f.text ? [rmClip(rmFirst(f.text), 60)] : [];
      break;
    }
    case 'hook': node.title = '✗ 拦截 · ' + rmClip(f.name, 20); node.lines = [rmClip(f.hook || f.desc, 70)].filter(Boolean); break;
    case 'merge': node.title = '★ 合入 · ' + rmClip(f.merge, 16); node.lines = [RM.shortCmd(f.sum)].filter(Boolean); break;
    case 'test': node.title = '✓ 测试 · ' + (RM.shortCmd(f.sum) || f.name); node.lines = [rmClip(f.sum, 70)].filter(Boolean);
      if (node.st === 'err') { node.title = '✗ 测试失败 · ' + (RM.shortCmd(f.sum) || f.name); node.icon = '✗'; }
      break;
    default: {
      const isRead = f.cat === 'read';
      const search = isRead && items.every(i => i.name === 'Grep' || i.name === 'Glob');
      if (f.cat === 'write') {
        const files = RM.distinct(items.map(i => i.file || i.sum));
        const edit = items.some(i => i.name === 'Edit' || i.name === 'NotebookEdit');
        node.title = (edit ? '改 ' : '写 ') + files.length + ' 个文件';
      } else if (isRead) node.title = (search ? '搜索' : '读代码') + (n > 1 ? ' ×' + n : '');
      else node.title = (RM.CAT_TITLE[f.cat] || '其他') + (n > 1 ? ' ×' + n : '');
      node.lines = RM.lines2(brief);
      node.icon = Array.from(node.title)[0] || '';   // narrow boxes show only this glyph
      // a single call says what it did ("跑测试 npm test", "改 src/a.js") instead of only its category
      const act = n === 1 && typeof RB !== 'undefined' ? RB.actionOf(f) : '';
      if (act) node.title = act;
    }
  }
  return node;
};

/* Names for automatic groups (a group is built by the layout when nodes of one lane crowd each other). */
RM.KEY_TITLE = {user: '用户消息', dispatch: '派单', recv: '交回', hook: '拦截', merge: '合入', compact: '压缩', test: '测试', read: '读代码', write: '改代码', git: 'git', wait: '等待', agent: '协作', other: '其他命令'};
RM.keyOf = nd => (nd.kind === 'act' ? nd.cat : nd.kind);
/* {title, cat (colour key of the most common kind), n (items), bad (failed or blocked nodes)}:
 * "派单 ×3", "测试 ×4（1 失败）", or "N 个事件" when the kinds are mixed. */
RM.groupInfo = function (members) {
  const cnt = new Map();
  let n = 0, bad = 0, top = '', topN = 0;
  members.forEach(m => {
    const k = RM.keyOf(m), c = (cnt.get(k) || 0) + m.n;
    cnt.set(k, c);
    n += m.n;
    if (m.st === 'err' || m.st === 'hook') bad++;
    if (c > topN) { top = k; topN = c; }
  });
  const title = cnt.size === 1 ? (RM.KEY_TITLE[top] || '其他') + ' ×' + n + (bad && top !== 'hook' ? '（' + bad + ' 失败）' : '') : n + ' 个事件';
  const cat = {dispatch: 'agent', recv: 'agent', hook: 'bad', merge: 'git', compact: 'wait'}[top] || top;
  return {title, cat, n, bad};
};

/* Compact duration for strips and labels; same format as the page's fmtDur but usable under node. */
RM.fmtDur = function (ms) {
  if (ms == null) return '-';
  if (ms < 1000) return Math.max(0, Math.round(ms)) + ' 毫秒';
  const t = Math.round(ms / 1000);
  if (t < 10) return (ms / 1000).toFixed(1) + ' 秒';
  if (t < 60) return t + ' 秒';
  const m = Math.floor(t / 60), r = t % 60;
  if (m < 60) return m + ' 分' + (r ? ' ' + r + ' 秒' : '');
  return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
};

/* Key items stay visible in the overview: everything except plain successful calls (read, write, edit, git, commands). */
RM.isKey = it => it.kind !== 'act' || it.st === 'err' || it.st === 'hook';

/* A grey strip standing for a run of plain calls between two key nodes (overview granularity). */
RM.makeStrip = function (a, items) {
  const f = items[0];
  const node = {id: a.id + '#s:' + f.key, agent: a.id, kind: 'strip', cat: 'strip', items, n: items.length, t0: f.ts, t1: Math.max.apply(null, items.map(i => i.t1)),
                st: 'ok', cost: null, child: '', from: '', firstStep: null, steps: [], title: '', lines: [], icon: '…', retry: 0, retryFrom: '', grp: ''};
  items.forEach(i => { if (i.cost != null) node.cost = (node.cost || 0) + i.cost; if (i.step != null) node.steps.push(i.step); });
  node.steps = RM.distinct(node.steps);
  node.firstStep = node.steps.length ? node.steps[0] : null;
  node.title = '… ' + node.n + ' 步 · ' + RM.fmtDur(node.t1 - node.t0);
  return node;
};

/* Stage merging: adjacent plain calls of one category become one node; everything else stands alone. */
RM.stageNodes = function (a, items, lookupName, out) {
  let run = null;
  const flush = () => { if (run) { out.push(RM.makeNode(a, run, lookupName)); run = null; } };
  items.forEach(it => {
    if (it.kind === 'act') {
      if (run && run[0].cat === it.cat) run.push(it);
      else { flush(); run = [it]; }
    } else { flush(); out.push(RM.makeNode(a, [it], lookupName)); }
  });
  flush();
};

/* gran: 'overview' (key nodes + strips), 'stage' (merged calls) or 'step' (one node per call).
 * opts: {expanded: Set of strip ids shown at stage level, running: the agent is still running (its last call stays visible)}. */
RM.nodesOf = function (a, items, gran, lookupName, opts) {
  opts = opts || {};
  const nodes = [], folds = [];
  if (gran === 'stage') { RM.stageNodes(a, items, lookupName, nodes); return {nodes, folds}; }
  if (gran === 'step') { items.forEach(it => nodes.push(RM.makeNode(a, [it], lookupName))); return {nodes, folds}; }
  const lastKey = opts.running ? items.length - 1 : -1;
  let run = null;
  const flush = () => {
    if (!run) return;
    const id = a.id + '#s:' + run[0].key;
    if (opts.expanded && opts.expanded.has(id)) {
      const at = nodes.length;
      RM.stageNodes(a, run, lookupName, nodes);
      for (let k = at; k < nodes.length; k++) nodes[k].grp = id;
      folds.push({id, agent: a.id, t0: run[0].ts, t1: Math.max.apply(null, run.map(i => i.t1)), n: run.length, first: nodes[at], last: nodes[nodes.length - 1]});
    } else nodes.push(RM.makeStrip(a, run));
    run = null;
  };
  items.forEach((it, i) => {
    if (i === lastKey || RM.isKey(it)) { flush(); nodes.push(RM.makeNode(a, [it], lookupName)); }
    else (run || (run = [])).push(it);
  });
  flush();
  return {nodes, folds};
};

/* ------------------------------------------------------------------ lane / row ordering (shared with the timeline) */
RM.SORTS = [['dispatch', '派单顺序'], ['start', '开始时间'], ['dur', '耗时'], ['cost', '预估金额'], ['state', '状态'], ['model', '模型']];
RM.SORT_KEYS = RM.SORTS.map(x => x[0]);
/* The options offered: a source without token usage has no amount to sort by. */
RM.sorts = () => RM.SORTS.filter(o => !(o[0] === 'cost' && noUsage()));
RM.FAM_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];
RM.famOf = function (a) { return a.fam || (String(a.model || '').match(/haiku|sonnet|opus|fable/) || [])[0] || ''; };
/* Orders `list` by `mode` (any mode except 'dispatch', which keeps the caller's own order). `info(x)` returns
 * {root, start, dur, cost (null = no price), state (0 running, 1 has failed/blocked step, 2 handed back), fam}.
 * Root entries always come first and are never reordered; `newest` flips only the start-time directions. */
RM.sortAgents = function (list, mode, info, newest) {
  if (!mode || mode === 'dispatch') return list.slice();
  const rows = list.map((x, i) => Object.assign({x, i}, info(x)));
  const roots = rows.filter(r => r.root), rest = rows.filter(r => !r.root);
  const dir = newest ? -1 : 1;
  const byStart = (a, b) => dir * (a.start - b.start);
  const has = c => c != null && isFinite(c);
  const cmp = {
    start: byStart,
    dur: (a, b) => (b.dur - a.dur) || byStart(a, b),
    cost: (a, b) => (has(a.cost) ? 0 : 1) - (has(b.cost) ? 0 : 1) || (has(a.cost) ? b.cost - a.cost : 0) || byStart(a, b),
    state: (a, b) => (a.state - b.state) || byStart(a, b),
    model: (a, b) => {
      const g = r => { const k = RM.FAM_ORDER.indexOf(r.fam); return k < 0 ? RM.FAM_ORDER.length : k; };
      return (g(a) - g(b)) || (a.start - b.start);
    }
  }[mode] || byStart;
  rest.sort((a, b) => cmp(a, b) || (a.i - b.i));
  return roots.concat(rest).map(r => r.x);
};

/* ------------------------------------------------------------------ model: lanes, nodes and the three kinds of edges */
RM.build = function (st, gran, opts) {
  gran = gran || 'overview';
  opts = opts || {};
  const lookupName = id => { const x = st.agents.get(id); return x ? x.desc : ''; };
  const lanes = new Map();
  st.order.forEach(id => {
    const a = st.agents.get(id);
    const items = RM.items(a);
    const r = RM.nodesOf(a, items, gran, lookupName, {expanded: opts.expanded, running: !!a.running});
    r.nodes.forEach((nd, i) => { nd.idx = i; nd.grp = nd.grp || ''; });
    lanes.set(id, {id, agent: a, items, nodes: r.nodes, folds: r.folds, parent: '', children: [], depth: 0, running: !!a.running, done: false, s0: 0, s1: 0});
  });
  if (!lanes.has('main') && st.order.length) lanes.set(st.order[0], lanes.get(st.order[0]));
  const rootId = lanes.has('main') ? 'main' : st.order[0];
  // parent = the agent that dispatched it; else the hint from the live card; else the root
  const parentOf = new Map(), dispatchOf = new Map();
  lanes.forEach(L => L.nodes.forEach(nd => { if (nd.kind === 'dispatch' && nd.child && lanes.has(nd.child) && !parentOf.has(nd.child)) { parentOf.set(nd.child, L.id); dispatchOf.set(nd.child, nd); } }));
  lanes.forEach(L => {
    if (L.id === rootId) return;
    const p = parentOf.get(L.id) || (L.agent.parent && lanes.has(L.agent.parent) && L.agent.parent !== L.id ? L.agent.parent : rootId);
    L.parent = p;
  });
  lanes.forEach(L => { if (L.id !== rootId && lanes.has(L.parent)) lanes.get(L.parent).children.push(L); });
  // lane order: depth-first, children by dispatch time (nested ones below their parent)
  const start = L => { const d = dispatchOf.get(L.id); return d ? d.t0 : (L.nodes[0] ? L.nodes[0].t0 : (L.agent.start || 0)); };
  const order = [], seen = new Set();
  const walk = (L, depth) => {
    if (seen.has(L.id)) return;
    seen.add(L.id);
    L.depth = depth;
    order.push(L);
    L.children.sort((x, y) => start(x) - start(y)).forEach(c => walk(c, depth + 1));
  };
  if (rootId) walk(lanes.get(rootId), 0);
  lanes.forEach(L => { if (!seen.has(L.id)) walk(L, 1); });
  order.forEach(L => {
    L.done = !L.running && (L.agent.doneTs > 0 || (L.id !== rootId));
    // Active span of the agent: its first call (or recorded start) to its recorded end / last call. A running lane has
    // no end yet (s1 stays 0; the layout extends it to "now").
    const f = L.items[0], l = L.items[L.items.length - 1];
    const d = dispatchOf.get(L.id);
    const first = f ? f.ts : (d ? d.t0 : (L.agent.start || 0));
    L.s0 = L.agent.start > 0 ? Math.min(L.agent.start, first || L.agent.start) : first;
    const lastT = l ? Math.max.apply(null, L.items.slice(-8).map(i => i.t1)) : L.s0;
    L.s1 = L.running ? 0 : Math.max(lastT, L.agent.doneTs || 0, L.agent.end || 0);
    const lastNode = L.nodes[L.nodes.length - 1];
    if (L.running && lastNode) lastNode.live = true;
  });

  // Flat orderings drop the hierarchy: no indent, and each lane remembers which non-root agent dispatched it.
  if (opts.sort && opts.sort !== 'dispatch') {
    const nowT = opts.now || 0;
    const info = L => {
      const a = L.agent, st = L.items.some(i => i.st === 'err' || i.st === 'hook');
      let cost = a.cost;
      if (cost == null) { const cs = L.items.filter(i => i.cost != null); cost = cs.length ? cs.reduce((t, i) => t + i.cost, 0) : null; }
      const s0 = L.s0 || 0, e = L.running ? Math.max(nowT, s0) : (L.s1 || s0);
      return {root: L.id === rootId, start: s0, dur: Math.max(0, e - s0), cost, state: L.running ? 0 : (st ? 1 : 2), fam: RM.famOf(a)};
    };
    const sorted = RM.sortAgents(order, opts.sort, info, !!opts.newest);
    order.length = 0;
    sorted.forEach(L => {
      L.depth = 0;
      const P = lanes.get(L.parent);
      L.sentBy = L.id !== rootId && P && P.id !== rootId ? (P.agent.desc || P.id) : '';
      order.push(L);
    });
  }

  const nodeById = new Map(), recvOf = new Map();
  order.forEach(L => L.nodes.forEach(nd => { nodeById.set(nd.id, nd); if (nd.kind === 'recv' && nd.from) recvOf.set(L.id + '<' + nd.from, nd); }));
  const edges = [];
  order.forEach(L => {
    if (L.id === rootId) return;
    const P = lanes.get(L.parent);
    const d = dispatchOf.get(L.id);
    const first = L.nodes[0], last = L.nodes[L.nodes.length - 1];
    if (d && first) edges.push({key: 'f:' + d.id + '>' + first.id, kind: 'fork', from: d, to: first, lane: L.id, tFrom: d.t0, tTo: L.s0});
    if (!last || !P) return;
    let target = recvOf.get(P.id + '<' + L.id);
    if (!target && d && !L.running) {
      const endT = last.t0;
      target = P.nodes.find(nd => nd.idx > d.idx && nd.t0 >= endT && nd !== d);
    }
    if (target) edges.push({key: 'j:' + last.id + '>' + target.id, kind: 'join', from: last, to: target, lane: L.id, tFrom: L.s1 || last.t1, tTo: target.kind === 'recv' ? target.t0 : (L.s1 || last.t1)});
  });
  // retries: a failed or blocked node -> the next node of the same kind (same tool for hook blocks)
  order.forEach(L => {
    for (let i = 0; i < L.nodes.length; i++) {
      const nd = L.nodes[i];
      if ((nd.st !== 'err' && nd.st !== 'hook') || (nd.kind !== 'test' && nd.kind !== 'hook')) continue;
      for (let j = i + 1; j < L.nodes.length && j <= i + RM.RETRY_SPAN; j++) {
        const o = L.nodes[j];
        if (o.kind === nd.kind && (nd.kind !== 'hook' || o.items[0].name === nd.items[0].name) && (nd.kind !== 'test' || o.cat === nd.cat)) {
          o.retry = nd.retry + 1;
          o.retryFrom = nd.id;
          edges.push({key: 'r:' + nd.id + '>' + o.id, kind: 'retry', from: nd, to: o, lane: L.id, n: o.retry});
          break;
        }
        if (o.kind === 'user') break;   // a new user message ends the attempt
      }
    }
  });
  const nodeCount = order.reduce((s, L) => s + L.nodes.length, 0);
  return {gran, lanes: order, laneById: lanes, nodeById, edges, rootId, nodeCount, rev: st.rev, parentOf, dispatchOf};
};
