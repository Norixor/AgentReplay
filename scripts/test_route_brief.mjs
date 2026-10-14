// Behaviour of route_brief.js: the theme line and the composition of a folded stretch of the route map. No DOM.
// Run: node scripts/test_route_brief.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = ['step_brief.js', 'route_model.js', 'route_brief.js'].map(f => fs.readFileSync(path.join(src, f), 'utf8')).join('\n') + '\n;({RM, RB})';
const {RM, RB} = vm.runInNewContext(code, {});

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.error('FAIL: ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

const T = 1_000_000;
let n = 0;
const call = (name, cat, sum, o = {}) => Object.assign({name, cat, sum, ts: T + (++n) * 1000, dur: 500, st: 'ok', bg: false, desc: '', hook: ''}, o);
const step = calls => ({n: n, ts: calls[0].ts, end: calls[0].ts + 1, cost: 0.01, said: '', calls});
/* An agent from page-data shaped turns; returns its time-ordered route items and its triggers. */
function lane(turns) {
  const st = RM.createStore();
  const a = RM.ingestAgent(st, {id: 'main', desc: '主代理', turns});
  return {items: RM.items(a), ctx: {trigs: a.trigs, lookupName: id => ({W1: '写手接口', W2: '部落目标'})[id] || ''}};
}
const mixOf = b => b.mix.map(m => m.key + ':' + m.n).join(' ');

// only reads: theme names the most read file, composition is all "read"
{
  const {items, ctx} = lane([{trig: {k: 'brief', ts: T}, steps: [
    step([call('Read', 'read', '/p/src/a.js')]), step([call('Read', 'read', '/p/src/a.js')]), step([call('Grep', 'read', 'foo')]), step([call('Bash', 'read', 'cat *.php')]), step([call('Bash', 'read', 'cat $1')]), step([call('Read', 'read', '/p/src/b.js')])]}]);
  const b = RB.summarize(items, ctx);
  eq(mixOf(b), 'read:6', 'reads only: composition');
  eq(b.theme, '读 a.js 等 2 个文件', 'reads only: theme from the most read file');
  eq(b.src, 'work', 'reads only: theme source');
  eq([b.err, b.hook], [0, 0], 'reads only: no failures');
}

// read, edit and test mixed: writes and tests outweigh the more numerous reads; a failed test is counted
{
  const {items, ctx} = lane([{trig: {k: 'brief', ts: T}, steps: [
    step([call('Read', 'read', '/p/a.js')]), step([call('Read', 'read', '/p/b.js')]), step([call('Read', 'read', '/p/c.js')]), step([call('Read', 'read', '/p/d.js')]),
    step([call('Edit', 'write', '/p/a.js')]), step([call('Edit', 'write', '/p/a.js')]),
    step([call('Bash', 'test', 'npm test', {st: 'err'})]), step([call('Bash', 'test', 'npm test')]),
    step([call('Bash', 'git', 'git status --short')])]}]);
  const b = RB.summarize(items, ctx);
  eq(mixOf(b), 'read:4 write:2 test:2 git:1', 'mixed: composition, most frequent first');
  eq(b.err, 1, 'mixed: the failed test is counted');
  ok(/^改 a\.js$|^跑测试 npm test$/.test(b.theme), 'mixed: theme comes from the heavier writes or tests, not the reads (got ' + b.theme + ')');
  ok(/失败 1/.test(b.mixText), 'mixed: mixText names the failure');
}

// a blocked call and a Bash description: the description is the theme of a command stretch
{
  const {items, ctx} = lane([{trig: {k: 'brief', ts: T}, steps: [
    step([call('Bash', 'other', 'make all', {desc: 'Build everything'})]), step([call('Bash', 'other', 'make all', {desc: 'Build everything', st: 'hook', hook: 'denied'})])]}]);
  const b = RB.summarize(items, ctx);
  eq(b.hook, 1, 'blocked: counted');
  eq(b.theme, 'Build everything', 'description: used as theme');
}

// a user message inside the stretch wins over everything else; tagged machine messages are not user messages
{
  const {items, ctx} = lane([
    {trig: {k: 'human', ts: T + 100, text: '修好路线图的折叠节点\n细节见下'}, steps: [step([call('Read', 'read', '/p/a.js')]), step([call('Edit', 'write', '/p/a.js')])]},
    {trig: {k: 'human', ts: T + 50_000, text: '<agent-message from="W1">\nreport'}, steps: [(n = 55, step)([call('Agent', 'agent', 'x', {agent: 'W2', disp: {model: 'sonnet'}})])]}]);
  const b = RB.summarize(items, ctx);
  eq(b.theme, '✉ 修好路线图的折叠节点', 'user message: first line is the theme');
  eq(b.src, 'user', 'user message: source');
  const later = RB.summarize(items.filter(i => i.ts >= T + 50_000), ctx);
  eq(later.theme, '◆ 派 1 个：部落目标', 'tagged hand-back is not a user message; the dispatch names the agent');
  eq(later.ctxText, '修好路线图的折叠节点', 'the user message in force is kept for the tooltip');
}

// a task notification opening a turn inside the stretch, when nothing was dispatched
{
  const {items, ctx} = lane([
    {trig: {k: 'human', ts: T, text: '继续'}, steps: [step([call('Read', 'read', '/p/a.js')])]},
    {trig: {k: 'notify', ts: T + 90_000, text: 'Agent "写手接口" finished'}, steps: [(n = 95, step)([call('Bash', 'git', 'git merge w1')]), step([call('Bash', 'test', 'npm test')])]}]);
  const b = RB.summarize(items.filter(i => i.ts >= T + 90_000), ctx);
  eq(b.theme, '◇ 子代理完成：写手接口', 'notification: theme');
  eq(b.src, 'trig', 'notification: source');
}

// empty stretch
{
  const b = RB.summarize([], {});
  eq([b.theme, b.calls, b.mix.length], ['', 0, 0], 'empty: nothing');
  eq(RB.of('main', [], {}).calls, 0, 'empty: cached path');
}

// live steps from /api/live carry only name/cat/sum/desc (no inp/res)
{
  const st = RM.createStore();
  RM.applyLive(st, {cards: [{id: 'main', desc: '主代理', start: T, recent: [
    {ts: T + 3000, tool: 'Bash', sum: 'pytest -q', st: 'err'}, {ts: T + 2000, tool: 'Edit', sum: '/p/src/x.py'}, {ts: T + 1000, tool: 'Read', sum: '/p/src/x.py'}]}]});
  const items = RM.items(st.agents.get('main'));
  const b = RB.summarize(items, {trigs: st.agents.get('main').trigs});
  eq(mixOf(b), 'read:1 write:1 test:1', 'live: composition from synthetic steps');
  eq(b.err, 1, 'live: failure counted');
  ok(b.theme.length > 0, 'live: a theme is found');
  // without step_brief.js the route category is used
  const {RM: RM2, RB: RB2} = vm.runInNewContext(['route_model.js', 'route_brief.js'].map(f => fs.readFileSync(path.join(src, f), 'utf8')).join('\n') + '\n;({RM, RB})', {});
  const st2 = RM2.createStore();
  RM2.applyLive(st2, {cards: [{id: 'm', start: T, recent: [{ts: T + 1000, tool: 'Read', sum: '/p/a.js'}, {ts: T + 2000, tool: 'Bash', sum: 'pytest'}]}]});
  eq(mixOf(RB2.summarize(RM2.items(st2.agents.get('m')), {})), 'read:1 test:1', 'no stepBrief: falls back to the route category');
}

// cache, span and single-call action
{
  const {items, ctx} = lane([{trig: {k: 'brief', ts: T}, steps: [step([call('Read', 'read', '/p/a.js')]), step([call('Edit', 'write', '/p/a.js')])]}]);
  ok(RB.of('main', items, ctx) === RB.of('main', items.slice(), ctx), 'cache: same stretch, same summary');
  eq(RB.span(items, items[1].ts, items[1].ts).length, 1, 'span: time window');
  eq(RB.actionOf(items[1]), '改 /p/a.js', 'single call: stepBrief action');
  const nd = RM.makeNode({id: 'main'}, [items[1]], () => '');
  eq(nd.title, '改 /p/a.js', 'single call node: titled with its action');
}

console.log(fails ? fails + ' of ' + checks + ' checks failed' : 'all ' + checks + ' checks passed');
process.exit(fails ? 1 : 0);
