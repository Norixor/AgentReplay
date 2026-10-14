// Unit test for src/timeseg.js: built agent data in, segments out.
// Usage: node scripts/test_timeseg.mjs   (exits non-zero on the first failed assertion)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const code = fs.readFileSync(path.join(root, 'src', 'timeseg.js'), 'utf8');
const { timeSegments, timeByCategory, TS_ORDER, TS_CATS } = vm.runInNewContext(
  code + '\n;({timeSegments, timeByCategory, TS_ORDER, TS_CATS})', {});

const plain = x => JSON.parse(JSON.stringify(x));  // arrays from the vm realm do not deep-equal main-realm ones
const call = (ts, dur, cat, extra = {}) => ({ name: 'Bash', cat, ts, dur, st: 'ok', bg: false, desc: '', sum: cat, ...extra });
const step = (ts, calls, extra = {}) => {
  const end = Math.max(ts, ...calls.filter(c => !c.bg).map(c => c.ts + c.dur));
  return { n: 0, ts, end, fin: ts, calls, cost: 0, ctx: 0, ...extra };
};
const turn = (trig, steps, evs = [], extra = {}) => ({ trig, evs, steps, ...extra });
const agent = (id, start, end, turns, extra = {}) => ({ id, start, end, turns, children: [], ...extra });

function check(name, a, opts) {
  const segs = timeSegments(a, opts);
  const total = a.end - a.start;
  assert.ok(segs.length > 0, name + ': has segments');
  assert.equal(segs[0].t0, a.start, name + ': starts at agent start');
  assert.equal(segs[segs.length - 1].t1, a.end, name + ': ends at agent end');
  segs.forEach((s, i) => {
    assert.ok(s.t1 > s.t0, name + ': positive length ' + i);
    assert.ok(TS_ORDER.includes(s.cat), name + ': known category ' + s.cat);
    if (i) assert.equal(s.t0, segs[i - 1].t1, name + ': contiguous at ' + i);
  });
  const by = timeByCategory(a, opts);
  assert.equal(Object.values(by).reduce((x, y) => x + y, 0), total, name + ': categories add up to the duration');
  assert.equal(timeSegments(a, opts), segs, name + ': cached on the agent');
  return { segs, by };
}

// 1. A plain turn: generate, run a test command, read a file, reply; then the user answers after a long pause.
{
  const s0 = step(1600, [call(1600, 2400, 'test')]);                 // generation 1000-1600, tests 1600-4000
  const s1 = step(4500, [call(4600, 100, 'read', { name: 'Read' })]); // generation 4000-4600, read 4600-4700
  const s2 = step(4900, [], { fin: 5200, stop: 'end_turn' });          // generation 4700-5200 (text reply)
  const s3 = step(10500, [call(10600, 400, 'git')]);                  // user at 10000 -> generation 10000-10600
  const a = agent('main', 1000, 11000, [
    turn({ k: 'human', ts: 1000 }, [s0, s1, s2]),
    turn({ k: 'human', ts: 10000 }, [s3])]);
  const { segs, by } = check('plain', a);
  assert.deepEqual(plain(segs.map(s => [s.t0, s.t1, s.cat])), [
    [1000, 1600, 'think'], [1600, 4000, 'test'], [4000, 4600, 'think'], [4600, 4700, 'read'], [4700, 5200, 'think'],
    [5200, 10000, 'user'], [10000, 10600, 'think'], [10600, 11000, 'git']]);
  assert.equal(by.user, 4800);
  assert.equal(by.think, 600 + 600 + 500 + 600);
  assert.equal(segs[1].stepIdx, 0);
  assert.equal(segs[7].stepIdx, 3);
  assert.equal(by.idle, 0);
  assert.equal(TS_CATS.user.label, '等你回复');
}

// 2. Parallel calls in one step: one category per instant, the call that started first wins.
{
  const s0 = step(100, [call(100, 500, 'test'), call(150, 100, 'read'), call(400, 400, 'write')]);
  const a = agent('p', 100, 800, [turn({ k: 'human', ts: 100 }, [s0])]);
  const { segs } = check('parallel', a);
  assert.deepEqual(plain(segs.map(s => [s.t0, s.t1, s.cat])), [[100, 600, 'test'], [600, 800, 'write']]);
  assert.equal(segs[1].c.cat, 'write');
}

// 3. Sub-agents: a foreground dispatch is waiting, a background dispatch only counts its launch, the
//    wait-for-task tool waits, and time left with children running is waiting for them (idle without children).
{
  const kids = { c1: { id: 'c1', start: 1100, end: 2000 }, c2: { id: 'c2', start: 3100, end: 4600 } };
  const fg = call(1000, 1000, 'agent', { name: 'Agent', disp: { bg: false }, agent: 'c1' });
  const bg = call(3000, 50, 'agent', { name: 'Agent', disp: { bg: true }, bg: true, agent: 'c2', bgDone: 4600 });
  const out = call(4000, 300, 'other', { name: 'TaskOutput' });
  const s0 = step(1000, [fg]);
  const s1 = step(3000, [bg]);
  const s2 = step(4000, [out]);
  // 4300-4600 is a gap in the turn (a notification arrives at 4600) while c2 still runs
  const s3 = step(4900, [], { fin: 5000, stop: 'end_turn' });
  const t = turn({ k: 'human', ts: 1000 }, [s0, s1, s2, s3], [{ k: 'notify', ts: 4600, at: 3 }]);
  const a = agent('main', 1000, 5000, [t]);
  const { segs, by } = check('children', a, { lookup: id => kids[id] });
  assert.equal(by.agent, 50, 'background dispatch counts the launch only');
  assert.equal(segs[0].cat, 'subwait');
  assert.equal(segs[0].t1 - segs[0].t0, 1000, 'foreground dispatch is waiting for the child');
  assert.equal(by.subwait, 1000 + 300 + 300, 'dispatch + TaskOutput + 4300-4600 gap while c2 still runs');
  // without any child the same gap is unknown time
  const lone = agent('solo', 1000, 3000, [turn({ k: 'human', ts: 1000 },
    [step(1500, [call(1500, 100, 'read')]), step(2900, [], { fin: 3000, stop: 'end_turn' })], [{ k: 'hookctx', ts: 2800, at: 1 }])]);
  const r = check('solo', lone);
  assert.equal(r.by.idle, 2800 - 1600 - 0, 'gap before the injected message is unknown');
  assert.equal(r.by.subwait, 0);
}

// 3b. A parser can mark a blocking dispatch under any tool name (Gemini invoke_agent): the parent waits for the child.
{
  const kids = { g1: { id: 'g1', start: 1100, end: 2000 } };
  const inv = call(1000, 1000, 'agent', { name: 'invoke_agent', disp: { bg: false, block: true }, agent: 'g1' });
  const a = agent('gm', 1000, 2000, [turn({ k: 'human', ts: 1000 }, [step(1000, [inv])])]);
  const { by } = check('blocking dispatch', a, { lookup: id => kids[id] });
  assert.equal(by.subwait, 1000);
  assert.equal(by.agent, 0);
}

// 4. Codex style: the turn ends with an explicit marker; a machine wake-up while a child runs is waiting for it.
{
  const kids = { k1: { id: 'k1', start: 2200, end: 9000 } };
  const spawn = call(2000, 100, 'agent', { name: 'spawn_agent', disp: { bg: false }, agent: 'k1' });
  const s0 = step(2000, [spawn]);
  const s1 = step(2300, [], { fin: 2400 });
  const t0 = turn({ k: 'human', ts: 1000 }, [s0, s1], [], { end: 2400, endKind: 'complete' });
  const s2 = step(9100, [], { fin: 9200 });
  const t1 = turn({ k: 'handback', ts: 9000, from: 'k1' }, [s2], [], { end: 9200 });
  const a = agent('cx', 1000, 9200, [t0, t1]);
  const { segs, by } = check('codex', a, { lookup: id => kids[id] });
  assert.equal(by.subwait, 9000 - 2400, 'turn ended, child still running, woken by hand-back');
  assert.equal(by.user, 0);
  assert.ok(segs.some(s => s.cat === 'agent' && s.t1 - s.t0 === 100), 'spawn_agent is a launch, not a wait');
  // the same gap woken by a human message is waiting for the user
  const b = agent('cx2', 1000, 9200, [t0, turn({ k: 'human', ts: 9000 }, [s2], [], { end: 9200 })]);
  const rb = check('codex-user', b, { lookup: id => kids[id] });
  assert.equal(rb.by.user, 9000 - 2400);
  assert.equal(rb.by.subwait, 0, 'children running does not hide a wait for the user');
}

// 5. Degenerate input: zero length agents have no segments and zero totals.
{
  const a = agent('z', 500, 500, []);
  assert.deepEqual(plain(timeSegments(a)), []);
  assert.equal(Object.values(timeByCategory(a)).reduce((x, y) => x + y, 0), 0);
}

console.log('timeseg: all assertions passed');
