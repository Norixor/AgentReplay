// Unit test for the time-analysis tab (src/analysis_core.js, analysis_path.js, analysis_detect.js) on constructed data:
// a main agent and two sub-agents. Usage: node scripts/test_analysis.mjs   (exits non-zero on the first failed assertion)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const code = ['timeseg.js', 'analysis_core.js', 'analysis_path.js', 'analysis_detect.js']
  .map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8').replace(/^'use strict';/, '')).join('\n');
const L = vm.runInNewContext(code + '\n;({anaBuildScope, anaCriticalPath, anaPathBlocks, anaDetect, anaCostSum, anaConcurrency, repeatGroups, normStr})', {});

const S = x => x * 1000;
let N = 0;
const call = (ts, dur, cmd, cat = 'other', extra = {}) => ({ name: 'Bash', cat, ts: S(ts), dur: S(dur), st: 'ok', bg: false, desc: '', sum: cmd, ...extra });
const step = (ts, calls, extra = {}) => ({ n: ++N, ts: S(ts), end: S(ts), fin: S(ts), calls, cost: 0, ctx: 1000, ...extra });
const turn = (trig, steps) => ({ trig, evs: [], steps });
const agent = (id, start, end, turns, extra = {}) => ({ id, desc: id, start: S(start), end: S(end), turns, cost: 0, nUnp: 0, tok: {}, ...extra });
const scopeOf = (agents, rootId = 'main') => {
  const map = Object.fromEntries(agents.map(a => [a.id, a]));
  return L.anaBuildScope(rootId, id => map[id] || null, id => map[id] || null);
};

// ---- the session: main runs commands, dispatches B in the background and A in the foreground, then waits for B
const main = agent('main', 0, 1700, [turn({ k: 'human', ts: 0 }, [
  step(5, [call(10, 20, 'npm test', 'test')], { cost: 0.2 }),
  step(30, [call(35, 20, 'npm test', 'test')], { cost: 0.1 }),                                   // repeated, nothing written in between
  step(55, [call(60, 30, 'npm run build 2>&1 | tail -5')], { cost: 0.05 }),                      // output cut ...
  step(90, [call(95, 30, 'npm run build 2>&1')], { cost: null }),                                // ... then rerun in full (no price)
  step(125, [call(130, 30, 'until [ -f done ]; do sleep 5; done', 'wait')]),                     // polling
  step(160, [call(165, 10, 'cargo build --release')]),
  step(176, [call(180, 5, 'git status', 'git')]),
  step(184, [call(186, 1, 'src/a.js', 'write', { name: 'Edit' })]),
  step(188, [call(190, 10, 'cargo build --release')]),                                           // after a write: not a repeat
  step(202, [call(205, 5, 'git status', 'git')]),
  step(212, [call(215, 700, 'make long')]),                                                      // 11 min 40 s
  step(918, [call(920, 3, 'lint src', 'test', { st: 'err' })], { cost: 0.01 }),                  // fails ...
  step(924, [call(925, 4, 'lint --fix src', 'test')], { cost: 0.02 }),                           // ... and is corrected
  step(930, [call(935, 1, 'Agent B', 'agent', { name: 'Agent', bg: true, agent: 'B', bgDone: S(1650), disp: { bg: true } })]),
  step(938, [call(940, 300, 'Agent A', 'agent', { name: 'Agent', agent: 'A', disp: {} })]),      // foreground: blocks until 1240
  step(1245, [call(1250, 400, 'TaskOutput', 'wait', { name: 'TaskOutput' })]),
  step(1655, [], { fin: S(1700), stop: 'end_turn' })])]);
const A = agent('A', 945, 1240, [turn({ k: 'brief', ts: S(945) }, [
  step(955, [call(960, 60, 'cargo build --release')]),
  step(1025, [call(1030, 70, 'cargo build --release')]),
  step(1103, [call(1105, 6, 'git status', 'git')]),
  step(1115, [], { fin: S(1240), stop: 'end_turn' })])]);
const B = agent('B', 945, 1650, [turn({ k: 'brief', ts: S(945) }, [
  step(965, [call(970, 55, 'cargo build --release')]),
  step(1105, [call(1110, 6, 'git status', 'git')]),
  step(1198, [call(1200, 1, 'echo x', 'read')], { ctx: 450000, cost: 0.5 }),
  step(1205, [], { fin: S(1650), stop: 'end_turn' })])]);

const sc = scopeOf([main, A, B]);
assert.deepEqual(Array.from(sc.ids).sort(), ['A', 'B', 'main'], 'scope = root and descendants');
assert.deepEqual(Array.from(scopeOf([main, A, B], 'A').ids), ['A'], 'a sub-agent scope has no foreign agents');
assert.equal(sc.conc.max, 3);
assert.ok(sc.conc.avg > 1 && sc.conc.avg < 3);

// ---- critical path
const P = L.anaCriticalPath(sc);
const ids = Array.from(new Set(P.merged.map(p => p.agentId)));
assert.ok(ids.includes('B'), 'path enters the last sub-agent to hand back');
assert.ok(!ids.includes('A'), 'a sub-agent that returned earlier is not on the path');
assert.equal(P.t1, S(1700));
P.pieces.forEach((p, i) => { assert.ok(p.t1 > p.t0); if (i) assert.ok(p.t0 >= P.pieces[i - 1].t1, 'chronological, no overlap'); });
const bPieces = P.pieces.filter(p => p.agentId === 'B');
assert.equal(bPieces[bPieces.length - 1].t1, S(1650), 'B is followed to its hand-back');
assert.equal(bPieces[0].t0, S(945), 'and back to its start');
const before = P.pieces.filter(p => p.agentId === 'main' && p.t1 <= S(945));
assert.ok(before.length && before[before.length - 1].t1 >= S(935), 'back in the parent at the dispatch moment');
assert.ok(P.top.length <= 5 && P.top[0].t1 - P.top[0].t0 >= P.top[P.top.length - 1].t1 - P.top[P.top.length - 1].t0);
assert.ok(L.anaPathBlocks(P, 0.004).length <= 260);
// a foreground dispatch alone puts that sub-agent on the path
const solo = agent('main', 0, 320, [turn({ k: 'human', ts: 0 }, [
  step(95, [call(100, 200, 'Agent X', 'agent', { name: 'Agent', agent: 'X', disp: {} })]), step(305, [], { fin: S(320), stop: 'end_turn' })])]);
const X = agent('X', 105, 295, [turn({ k: 'brief', ts: S(105) }, [step(120, [call(125, 100, 'build')]), step(230, [], { fin: S(295), stop: 'end_turn' })])]);
assert.ok(L.anaCriticalPath(scopeOf([solo, X])).merged.some(p => p.agentId === 'X'));

// ---- detectors
const D = L.anaDetect(sc, { ctxLimit: 400000 });
const by = id => D.list.find(f => f.id === id);
const rep = by('repeat');
assert.equal(rep.count, 2, 'npm test and cargo build (in A) repeat; the one after the Edit does not');
assert.ok(rep.extra.groups.some(g => g.cmd === 'npm test' && g.runs === 2 && g.ms === S(20)));
assert.ok(!rep.evidence.some(e => e.n === main.turns[0].steps[8].n), 'a run after a write is not a repeat');
assert.equal(rep.cost.cost, 0.1 + 0, 'cost of the repeated steps');
const cut = by('cutrerun');
assert.equal(cut.count, 1);
assert.equal(cut.ms, S(30));
assert.equal(cut.cost.cost, 0.05, 'the unpriced step adds nothing');
assert.equal(cut.cost.nUnp, 1, 'and is counted');
assert.equal(cut.cost.priced, 1);
const poll = by('poll');
assert.equal(poll.count, 2);
assert.equal(poll.ms, S(430));
const lng = by('long');
assert.equal(lng.count, 1);
assert.equal(lng.evidence[0].ms, S(700));
const retry = by('retry');
assert.equal(retry.count, 1);
assert.equal(retry.ms, S(7));
assert.ok(Math.abs(retry.cost.cost - 0.03) < 1e-9);
const cpu = by('cpu');
assert.equal(cpu.count, 1, 'only cargo build is slower when 3 agents run');
assert.equal(cpu.evidence[0].text, 'cargo build --release');
assert.equal(cpu.evidence[0].medHi, S(60));
assert.equal(cpu.evidence[0].medLo, S(10));
assert.ok(!D.list.some(f => f.id === 'cpu' && f.evidence.some(e => /git status/.test(e.text))), 'similar durations are not flagged');
const sw = by('subwait');
assert.ok(sw.ms >= S(300 + 400));
assert.ok(sw.evidence.some(e => e.childId === 'A') && sw.evidence.some(e => e.childId === 'B'));
const ctx = by('ctx');
assert.equal(ctx.count, 1);
assert.equal(ctx.cost.cost, 0.5);
assert.equal(L.anaDetect(sc, { ctxLimit: 500000 }).list.find(f => f.id === 'ctx').count, 0, 'the limit is configurable');
assert.ok(D.head && D.head.ms > 0, 'a headline candidate exists');

// ---- a clean session reports nothing and the cost helper skips unpriced steps
const clean = agent('main', 0, 100, [turn({ k: 'human', ts: 0 }, [
  step(5, [call(10, 10, 'cargo build')], { cost: 0.1 }), step(25, [call(30, 10, 'src/a.js', 'write', { name: 'Edit' })]),
  step(45, [call(50, 10, 'cargo build')]), step(65, [], { fin: S(100), stop: 'end_turn' })])]);
const Dc = L.anaDetect(scopeOf([clean]));
assert.equal(Dc.list.filter(f => f.count > 0).length, 0, 'nothing found in a clean session');
assert.equal(Dc.head, null);
const cs = L.anaCostSum([{ cost: 0.5 }, { cost: null }, { cost: 0.25 }]);
assert.equal(cs.cost, 0.75);
assert.equal(cs.nUnp, 1);
assert.equal(L.anaCostSum([{ cost: null }]).priced, 0);
console.log('analysis tests passed');
