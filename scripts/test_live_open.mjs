#!/usr/bin/env node
// "Fetch what the page lacks, then open" logic (src/live_open.js) on a hand-written session and a mocked /api/steps:
// a step already in the page's data opens without a request; a newer step, an unfinished call or a sub-agent the page
// never saw is fetched once (concurrent clicks share it), merged with the real lsMerge, and opened; failures say why.
// Usage: node scripts/test_live_open.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
// the real step lookup (tl_model.js) so that its per-agent cache is part of the test
const tl = read('tl_model.js');
const stepLookup = tl.slice(tl.indexOf('function findStepAt'), tl.indexOf('function findTurnAt')) + 'function findTurnAt(a, ts) { let b = 0; a.turns.forEach((t, i) => { if ((t.trig.ts || 0) <= ts + 1) b = i; }); return b; }';
const code = [read('modal_model.js'), stepLookup, read('live_steps.js'), read('live_open.js').replace('const LO_WARM_WAIT = 1000', 'const LO_WARM_WAIT = 5')].join('\n');

const call = (st, name = 'Bash') => ({ name, st, cat: 'other' });
const step = (n, ts, st = 'ok') => ({ n, ts, end: ts + 5, calls: [call(st)] });
const plain = x => JSON.parse(JSON.stringify(x));

function world({ active = true } = {}) {
  const main = { id: 'main', desc: 'main', start: 1000, end: 2005, turns: [{ trig: { k: 'human', ts: 1000 }, evs: [], steps: [step(0, 1000), step(1, 2000)] }] };
  const sub = { id: 's1', desc: 'sub', start: 1500, end: 1600, turns: [{ trig: { k: 'brief', ts: 1500 }, evs: [], steps: [step(0, 1500)] }] };
  const log = { shown: [], toasts: [], urls: [] };
  const toastEl = { hidden: false, textContent: '' };
  const w = { answers: [], hold: null };   // answers: queue of JSON bodies (or Errors) the mock returns
  const ctx = vm.createContext({
    A: { main, s1: sub }, D: { meta: { active, liveKey: 'claude/x', end: 2005 }, agents: [main, sub], totals: {} }, SUBS: [sub], SRC: {},
    esc: String, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date, JSON, Math, Promise, URLSearchParams,
    document: { getElementById: () => toastEl, addEventListener() {}, hidden: false },
    showDetail: s => log.shown.push(plain(s)), toast: m => { log.toasts.push(m); toastEl.textContent = m; toastEl.hidden = false; },
    fetch: async url => {
      log.urls.push(url);
      if (w.hold) await w.hold;
      const a = w.answers.shift();
      if (a instanceof Error) throw a;
      return { json: async () => a };
    },
  });
  const api = vm.runInContext(code + '\n({liveOpen, liveOpenAt, LO, LS_ACTIVE, A, D})', ctx);
  return { api, log, w, main, sub, toastEl };
}
const answer = (extra) => Object.assign({ ok: true, total: 3, steps: [], ti: [], updated: [], updatedTi: [], turns: [], stats: {}, totals: { x: 1 }, end: 3000, agents: [] }, extra);

let n = 0;
const queue = [];
const t = (name, fn) => { n++; queue.push(fn().catch(e => { console.log('FAIL ' + name + ': ' + String(e.message).split('\n')[0]); process.exitCode = 1; })); };

t('a step already in the page data opens at once, no request', async () => {
  const { api, log } = world();
  assert.equal(api.liveOpen({ type: 'step', agent: 'main', step: 1 }), true);   // synchronous when nothing is fetched
  assert.deepEqual(log.shown, [{ type: 'step', agent: 'main', step: 1 }]);
  assert.equal(log.urls.length, 0);
  assert.equal(api.liveOpenAt('main', 2000, false, null), true);
  assert.equal(log.urls.length, 0);
});

t('a step newer than the page is fetched once, merged, then opened', async () => {
  const { api, log, w } = world();
  w.answers.push(answer({ steps: [step(2, 2900)], ti: [0], end: 2905 }));
  const ok = await api.liveOpen({ type: 'step', agent: 'main', step: 2 });
  assert.equal(ok, true);
  assert.equal(log.urls.length, 1);
  assert.match(log.urls[0], /^\/api\/steps\/claude\/x\?agent=main&after=2&turns=1&known=2&pend=$/);
  assert.deepEqual(log.shown, [{ type: 'step', agent: 'main', step: 2 }]);
  assert.equal(api.D.meta.end, 2905);
});

t('by time: a click newer than the last step fetches, and the new step is found (lookup cache refreshed)', async () => {
  const { api, log, w } = world();
  api.liveOpenAt('main', 2000, false, null);   // fills the per-agent step lookup
  w.answers.push(answer({ steps: [step(2, 9000)], ti: [0] }));
  await api.liveOpenAt('main', 9000, false, null);
  assert.equal(log.urls.length, 1);
  assert.deepEqual(log.shown[1], { type: 'step', agent: 'main', step: 2 });
});

t('a sub-agent the page never saw is created from agentRec with its steps', async () => {
  const { api, log, w } = world();
  w.answers.push(answer({ total: 1, steps: [step(0, 2500)], ti: [0], turns: [{ ti: 0, trig: { k: 'brief', ts: 2500 }, evs: [] }],
    stats: { id: 'new1', desc: 'fresh' }, agentRec: { id: 'new1', desc: 'fresh', briefing: 'do it' } }));
  await api.liveOpen({ type: 'agent', agent: 'new1' });
  assert.match(log.urls[0], /agent=new1&after=0&turns=0&known=2&pend=&full=1$/);
  assert.equal(api.A.new1.briefing, 'do it');
  assert.equal(api.A.new1.turns[0].steps.length, 1);
  assert.equal(api.D.agents.length, 3);
  assert.deepEqual(log.shown, [{ type: 'agent', agent: 'new1' }]);
});

t('an unfinished call is re-read; the finished result replaces it', async () => {
  const { api, log, w, main } = world();
  main.turns[0].steps.push(step(2, 2500, 'pend'));
  w.answers.push(answer({ updated: [step(2, 2500, 'ok')], updatedTi: [0] }));
  await api.liveOpen({ type: 'step', agent: 'main', step: 2 });
  assert.match(log.urls[0], /after=3&turns=1&known=2&pend=2$/);
  assert.equal(main.turns[0].steps[2].calls[0].st, 'ok');
  assert.equal(log.shown.length, 1);
});

t('the running call of a card: the newest step with a pending call of that tool', async () => {
  const { api, log, w, main } = world();
  main.turns[0].steps.push(step(2, 2500, 'pend'));
  w.answers.push(answer({ updated: [], updatedTi: [] }));
  await api.liveOpenAt('main', 2500, false, null, { pend: true, tool: 'Bash' });
  assert.equal(log.urls.length, 1);
  assert.deepEqual(log.shown, [{ type: 'step', agent: 'main', step: 2 }]);
});

t('a failed request says why and shows nothing it cannot show', async () => {
  const { api, log, w } = world();
  w.answers.push(new Error('boom'));
  assert.equal(await api.liveOpen({ type: 'step', agent: 'main', step: 5 }), false);
  assert.equal(log.shown.length, 0);
  assert.match(log.toasts[log.toasts.length - 1], /读取最新步骤失败.*boom/);
  w.answers.push({ ok: false, error: '没有这个代理：zz' });
  assert.equal(await api.liveOpenAt('zz', 9999, false, null), false);
  assert.match(log.toasts[log.toasts.length - 1], /没有这个代理：zz/);
  assert.equal(api.A.zz, undefined);
});

t('a failure still shows what the page has (agent summary)', async () => {
  const { api, log, w } = world();
  w.answers.push(new Error('offline'));
  assert.equal(await api.liveOpenAt('main', 9000, false, null), true);   // ts newer than the data: falls back to the nearest step
  assert.equal(log.shown.length, 1);
  assert.match(log.toasts[log.toasts.length - 1], /先显示已有数据/);
});

t('concurrent clicks on one agent share one request', async () => {
  const { api, log, w } = world();
  let release;
  w.hold = new Promise(r => { release = r; });
  w.answers.push(answer({ steps: [step(2, 9000)], ti: [0] }));
  const a = api.liveOpen({ type: 'step', agent: 'main', step: 2 });
  const b = api.liveOpen({ type: 'step', agent: 'main', step: 2 });
  const c = api.liveOpenAt('main', 9000, false, null);
  release();
  await Promise.all([a, b, c]);
  assert.equal(log.urls.length, 1);
  assert.equal(log.shown.length, 3);
});

t('a good answer is reused for a moment (double click)', async () => {
  const { api, log, w } = world();
  w.answers.push(answer({ steps: [], ti: [] }));
  await api.liveOpen({ type: 'step', agent: 'main', step: 7 });   // server has no step 7 yet
  await api.liveOpen({ type: 'step', agent: 'main', step: 7 });
  assert.equal(log.urls.length, 1);
});

t('a server that is still parsing is asked again', async () => {
  const { api, log, w } = world();
  w.answers.push({ ok: true, warming: true, steps: [], ti: [], updated: [], turns: [], agents: [] }, answer({ steps: [step(2, 2900)], ti: [0] }));
  await api.liveOpen({ type: 'step', agent: 'main', step: 2 });
  assert.equal(log.urls.length, 2);
  assert.equal(log.shown.length, 1);
});

t('an agent that something already follows is not fetched again', async () => {
  const { api, log } = world();
  api.LS_ACTIVE.main = 1;
  await api.liveOpen({ type: 'step', agent: 'main', step: 9 });
  assert.equal(log.urls.length, 0);
});

t('a static export keeps the old behaviour: no request, plain messages', async () => {
  const { api, log } = world({ active: false });
  assert.equal(api.liveOpenAt('nobody', 5000, false, null), false);
  assert.match(log.toasts[0], /回看数据里没有这个代理/);
  api.liveOpenAt('main', 99999, false, null);
  assert.equal(log.urls.length, 0);
  assert.match(log.toasts[1], /回看数据生成之后/);
  assert.equal(log.shown.length, 1);
});

await Promise.all(queue);
console.log(process.exitCode ? 'live open checks failed' : 'live open: ' + n + ' checks passed');
