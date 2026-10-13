#!/usr/bin/env node
// Detail dialog model (src/modal_model.js) with a small hand-written session: the four spec types resolve, unknown
// agents / steps / turns give a message instead of an exception, and the layer stack goes back correctly.
// Usage: node scripts/test_modal.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'modal_model.js'), 'utf8');
const step = (n, ts) => ({ n, ts, end: ts + 5, ctx: n * 100, calls: [] });
const main = { id: 'main', desc: 'main', turns: [{ trig: { k: 'human', ts: 1000 }, evs: [], steps: [step(1, 1000), step(2, 2000)] }] };
const sub = { id: 's1', desc: '子任务', turns: [{ trig: { k: 'brief', ts: 1500 }, evs: [], steps: [step(1, 1500)] }], start: 1500, end: 1600 };
const ctx = vm.createContext({
  A: { main, s1: sub }, esc: String, jumpHash: (id, ts, turn, n) => '#' + id + '?t=' + ts + (turn ? '&k=turn' : '') + (n != null ? '&s=' + n : ''),
  findTurnAt: () => 0, findStepAt: (a, ts) => ({ s: a.turns[0].steps[0] }),
});
const m = vm.runInContext(src + '\n({mdResolve, mdFromTime, mdReplayHash, mdStackPush, mdStackBack, mdCanBack, mdStepsInRange})', ctx);
const plain = x => JSON.parse(JSON.stringify(x));
let n = 0;
const t = (name, fn) => { n++; try { fn(); } catch (e) { console.log('FAIL ' + name + ': ' + e.message.split('\n')[0]); process.exitCode = 1; } };

t('four spec types resolve', () => {
  assert.ok(m.mdResolve({ type: 'step', agent: 's1', step: 1 }).ok);
  const r = m.mdResolve({ type: 'steps', agent: 'main', steps: [1, 2, 9], title: 'x' });
  assert.ok(r.ok && r.items.length === 2 && r.missing === 1 && r.title === 'x');
  assert.equal(m.mdResolve({ type: 'agent', agent: 's1' }).title, '子任务');
  assert.ok(m.mdResolve({ type: 'turn', turn: 0 }).ok);
});
t('unknown things do not throw', () => {
  [null, 5, { type: 'x' }, { type: 'agent', agent: 'no' }, { type: 'step', agent: 'no', step: 1 }, { type: 'step', agent: 'main', step: 99 }, { type: 'turn', turn: 9 }]
    .forEach(s => { const r = m.mdResolve(s); assert.equal(r.ok, false); assert.ok(r.msg.length > 5); });
});
t('time lookups and replay hash', () => {
  assert.deepEqual(plain(m.mdFromTime('main', 1000, false, 2)), { type: 'step', agent: 'main', step: 2 });
  assert.equal(m.mdFromTime('main', 1000, true).type, 'turn');
  assert.equal(m.mdFromTime('no', 1), null);
  assert.equal(m.mdReplayHash({ type: 'step', agent: 'main', step: 2 }), '#main?t=2000&s=2');
  assert.deepEqual(plain(m.mdStepsInRange(main, 1900, 2100)), [2]);
});
t('layer stack', () => {
  const a = { type: 'agent', agent: 's1' }, b = { type: 'step', agent: 's1', step: 1 };
  let s = m.mdStackPush([], a);
  assert.equal(m.mdCanBack(s), false);
  s = m.mdStackPush(m.mdStackPush(s, b), b);
  assert.equal(s.length, 2);
  assert.ok(m.mdCanBack(s));
  assert.deepEqual(plain(m.mdStackBack(s)), [a]);
  assert.equal(m.mdStackBack(m.mdStackBack(s)).length, 1);
});
console.log(process.exitCode ? 'modal checks failed' : 'modal model: ' + n + ' checks passed');
