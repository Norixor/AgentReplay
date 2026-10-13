// Key checks for the swim-lane route map: time axis, idle folding, fork/join lines, sub-rows, overview strips, incremental updates.
// No DOM. Run: node scripts/test_route.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = ['route_model.js', 'route_layout.js'].map(f => fs.readFileSync(path.join(src, f), 'utf8')).join('\n') + '\n;({RM, RL})';
const {RM, RL} = vm.runInNewContext(code, {Date});

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.error('FAIL: ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

/* One main agent and one sub-agent, 10 steps, with a 50-minute silence in the middle of the main lane. */
const T = 1_000_000, IDLE = 3_000_000, PPM = 120;
const call = (name, cat, ts, o = {}) => Object.assign({name, cat, ts, dur: 1000, st: 'ok', bg: false, desc: '', sum: '', hook: ''}, o);
const sn = {};
const step = (ag, ts, calls) => { sn[ag] = (sn[ag] ?? -1) + 1; return {n: sn[ag], ts, end: ts + 1, cost: 0.1, said: '', calls}; };
const mainSteps = [
  step('main', T + 1000, [call('Read', 'read', T + 1000, {sum: '/a.js'}), call('Read', 'read', T + 1100, {sum: '/b.js'})]),
  step('main', T + 2000, [call('Edit', 'write', T + 2000, {sum: '/a.js'})]),
  step('main', T + 4000, [call('Bash', 'test', T + 4000, {sum: 'pytest -q', st: 'err'})]),
  step('main', T + 5000, [call('Bash', 'test', T + 5000, {sum: 'pytest -q'})]),
  step('main', T + 6000, [call('Agent', 'agent', T + 6000, {sum: 'worker A', agent: 'A', disp: {model: 'sonnet', effort: '', bg: false}})]),
  step('main', T + IDLE, [call('Read', 'read', T + IDLE, {sum: '/c.js'})]),
  step('main', T + IDLE + 1000, [call('Edit', 'write', T + IDLE + 1000, {sum: '/c.js'})]),
];
const aSteps = [
  step('A', T + 7000, [call('Read', 'read', T + 7000, {sum: '/x.js'})]),
  step('A', T + 8000, [call('Read', 'read', T + 8000, {sum: '/y.js'})]),
  step('A', T + 9000, [call('Edit', 'write', T + 9000, {sum: '/x.js'})]),
];
const agent = (id, desc, trig, evs, steps, o = {}) => Object.assign({id, desc, model: 'sonnet', effort: '', depth: id === 'main' ? 0 : 1, start: 0, end: 0, doneTs: 0, turns: [{trig, evs, steps}]}, o);
const D = {agents: [
  agent('main', '主代理', {k: 'human', ts: T + 500, text: '修复问题'}, [{k: 'handback', ts: T + 20000, from: 'A', at: 5}], mainSteps),
  agent('A', 'worker A', {k: 'brief', ts: T + 6500}, [], aSteps, {doneTs: T + 19000}),
]};
const lay = (m, ppm) => { const ax = RL.buildAxis(m, {}); return {ax, res: RL.place(m, ax, ppm, {})}; };
const model = (gran, o) => RM.build(RM.fromPageData(D), gran, o);

/* 1+2: x is proportional to time; the 50-minute silence is one fixed-width band */
{
  const m = model('stage'), {ax} = lay(m, PPM), M = m.laneById.get('main').nodes;
  ok(Math.abs((M[3].x - M[1].x) - (M[3].t0 - M[1].t0) * PPM / 60000) < 1e-6, 'node x is proportional to its start time');
  const dx = M[M.length - 2].x - M[M.length - 3].x;
  ok(ax.gaps === 1 && dx >= RL.GAP_PX - 1e-6 && dx < 300, 'idle stretch is one fixed band, not 50 minutes (' + Math.round(dx) + ' px)');
}

/* 3: dispatch and hand-back lines sit at their moments */
{
  const m = model('stage'), {ax} = lay(m, PPM), X = t => RL.t2x(ax, t, PPM);
  const gf = RL.edgeGeom(m, ax, PPM, m.edges.find(e => e.kind === 'fork')), gj = RL.edgeGeom(m, ax, PPM, m.edges.find(e => e.kind === 'join'));
  ok(Math.abs(gf.x1 - X(T + 6000)) < 1e-9 && Math.abs(gf.x2 - X(T + 7000)) < 1e-9 && gf.y2 > gf.y1, 'dispatch line starts at the dispatch time and ends at the child start');
  ok(Math.abs(gj.x2 - X(T + 20000)) < 1e-9 && gj.y2 < gj.y1, 'hand-back marker sits at the hand-back time, on the parent lane');
}

/* 4: crowded nodes form groups that open up when zoomed in; every box has the same height; a lane has at most MAX_ROWS sub-rows */
{
  const m = model('step'), M = m.laneById.get('main'), els = () => M.els;
  lay(m, 60);
  ok(els().some(e => e.kind === 'group' && e.members.length > 1 && /×|个事件/.test(e.title)), 'overlapping nodes are drawn as a group (' + els().map(e => e.title).join(' | ') + ')');
  ok(M.rows <= RL.MAX_ROWS && els().every(e => e.mark ? e.h === RL.MARK_W : e.h === RL.NODE_H), 'every box is NODE_H tall, markers 16 px');
  ok(els().every((e, i) => els().slice(i + 1).every(o => o.row !== e.row || o.lx >= e.lx + e.dw - 1e-6)), 'elements of one sub-row do not overlap');
  const n60 = els().length;
  lay(m, 60000);
  ok(!els().some(e => e.kind === 'group') && els().length > n60 && M.nodes.every(n => n.cl === n), 'zoomed in, the groups open into single nodes');
  ok(els().every(e => e.mark ? e.h === RL.MARK_W : e.h === RL.NODE_H), 'heights stay equal after zooming');
}

/* 5: overview keeps key nodes; the folded calls become dotted lines between two nodes and take no sub-row; instants are markers */
{
  const m = model('overview'), M = m.laneById.get('main');
  eq(M.nodes.map(n => n.kind), ['user', 'strip', 'test', 'test', 'dispatch', 'recv', 'strip'], 'overview node kinds');
  eq([M.nodes[1].n, M.nodes[1].t1 - M.nodes[1].t0, M.nodes[6].n], [3, 2000, 2], 'strip step counts and duration');
  eq(M.nodes[1].title, '… 3 步 · 2.0 秒', 'strip label');
  const open = model('overview', {expanded: new Set([M.nodes[1].id])}).laneById.get('main');
  eq(open.nodes.length, M.nodes.length + 1, 'expanding one strip replaces it with stage nodes (reads, edit) in place');
  lay(m, 6000);
  const strip = M.nodes[1], prev = M.nodes[0].cl, next = M.nodes[2].cl;
  ok(M.rows === 1 && !M.els.some(e => e.kind === 'strip') && M.lines.includes(strip), 'a folded run is a line, not an element or a sub-row');
  ok(prev.lx + prev.dw <= strip.lx + 1e-6 && strip.lx + strip.dw <= next.lx + 1e-6 && strip.dw >= 8, 'the line lies between the node before and the node after');
  const recv = M.nodes[5];
  ok(recv.mark && recv.h === RL.MARK_W && M.nodes[0].mark === false && M.nodes[2].mark === false, 'a hand-back is an icon marker; the test and user boxes are not');
  const retry = m.edges.find(e => e.kind === 'retry');
  ok(retry && RL.edgeGeom(m, RL.buildAxis(m, {}), 6000, retry), 'the retry arc is drawn between two visible boxes');
  lay(m, 30);
  ok(RL.edgeGeom(m, RL.buildAxis(m, {}), 30, retry) === null, 'no retry arc when an end is folded into a group');
}

/* 6: incremental updates never duplicate nodes */
{
  const st = RM.fromPageData(D), n0 = RM.build(st, 'overview').nodeCount;
  const extra = step('main', T + IDLE + 5000, [call('Bash', 'test', T + IDLE + 5000, {sum: 'pytest -q', st: 'err'})]);
  const ans = {ok: true, steps: [extra], updated: [], turns: [], agents: [], state: 'running', stats: {}};
  eq([RM.applyStepsAnswer(st, 'main', ans), RM.applyStepsAnswer(st, 'main', ans)], [1, 0], 'the same answer twice adds the step once');
  const m = RM.build(st, 'overview'), ids = m.lanes.flatMap(L => L.nodes.map(n => n.id));
  ok(m.nodeCount === n0 + 1 && new Set(ids).size === ids.length, 'one new node, ids unique');
}

/* 11: lane sorting: dispatch order is unchanged; flat orders keep the main lane first and drop the hierarchy */
{
  const bSteps = [step('B', T + 10000, [call('Bash', 'test', T + 10000, {sum: 'pytest -q', st: 'err'})]), step('B', T + 11000, [call('Read', 'read', T + 11000, {sum: '/z.js'})])];
  const D3 = {agents: D.agents.concat([agent('B', 'worker B', {k: 'brief', ts: T + 9500}, [], bSteps, {doneTs: T + 12000, model: 'opus'})])};
  const mk = o => RM.build(RM.fromPageData(D3), 'stage', o).lanes.map(L => L.id);
  eq(mk({}), mk({sort: 'dispatch'}), 'dispatch order is the default and matches the old order');
  eq(mk({sort: 'dur'}), ['main', 'A', 'B'], 'duration: longest first, main stays first');
  eq(mk({sort: 'state'}), ['main', 'B', 'A'], 'state: the lane with a failed step precedes the clean handed-back one');
  eq(mk({sort: 'model'}), ['main', 'B', 'A'], 'model: opus before sonnet');
}

console.log(fails ? fails + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed');
process.exit(fails ? 1 : 0);
