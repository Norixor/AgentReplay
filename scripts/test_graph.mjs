// Key checks for the live flow graph layout (graph_layout.js): grid bands fit one screen, no overlaps, stable updates.
// No DOM. Run: node scripts/test_graph.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const code = fs.readFileSync(path.join(src, 'graph_layout.js'), 'utf8') +
  '\n;({grBuild, GR_W, GR_H, GR_MH, GR_GX, GR_GY, GR_SH, GR_SUM, GR_FIT_PAD, GR_FIT_PADT, GR_FIT_MAX})';
const G = vm.runInNewContext(code, {});

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.error('FAIL: ' + msg); } };

const NOW = 10_000_000;
const card = (id, start, o = {}) => Object.assign({id, parent: 'main', start, done: false, doneTs: 0}, o);
const snap = (n, o = {}) => ({cards: [card('main', 1)].concat(Array.from({length: n}, (_, i) => card('s' + i, 100 + i, o)))});
const build = (d, vw, vh, extra = {}) => G.grBuild(d, Object.assign({now: NOW, fadeMs: 60000, maxNodes: 40, retired: new Set(), vw, vh}, extra));

const bbox = ns => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  ns.forEach(n => { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); });
  return {w: x1 - x0, h: y1 - y0};
};
const fitK = (b, vw, vh) => Math.min(G.GR_FIT_MAX, (vw - 2 * G.GR_FIT_PAD) / b.w, (vh - G.GR_FIT_PAD - G.GR_FIT_PADT) / b.h);
/* the previous layout: one node per row in each depth column */
const stackedBox = n => {
  const span = n * (G.GR_H + G.GR_GY) - G.GR_GY, top = (span - G.GR_MH) / 2;
  return {w: 2 * G.GR_W + G.GR_GX, h: Math.max(span, top + G.GR_MH) - Math.min(0, top)};
};
const overlaps = ns => {
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = ns[i], b = ns[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return a.id + '/' + b.id;
  }
  return '';
};
const edgesValid = r => { const ids = new Set(r.nodes.map(n => n.id)); return r.edges.every(e => ids.has(e.from) && ids.has(e.to)); };
const pos = r => new Map(r.nodes.filter(n => n.id !== 'main').map(n => [n.id, n.x + ',' + n.y]));

const VIEWS = {'16:10': [1400, 875], '16:9': [1600, 900], '4:3': [1200, 900], portrait: [800, 1200]};

/* 1: every size x viewport shape: no overlaps, valid edges, main agent left of every sub-agent, zoom >= stacked layout */
for (const n of [1, 2, 5, 12, 30, 40]) for (const [name, [vw, vh]] of Object.entries(VIEWS)) {
  const r = build(snap(n), vw, vh);
  const tag = n + ' agents @' + name;
  ok(r.nodes.length === n + 1, tag + ': every agent is shown');
  ok(!overlaps(r.nodes), tag + ': nodes overlap (' + overlaps(r.nodes) + ')');
  ok(edgesValid(r), tag + ': every edge points at a shown node');
  const m = r.nodes[0];
  ok(m.id === 'main' && r.nodes.every(x => x === m || x.x >= m.x + m.w + G.GR_GX - 1e-6), tag + ': main agent stays left of the bands');
  const kGrid = fitK(bbox(r.nodes), vw, vh), kOld = fitK(stackedBox(r.nodes.length - 1), vw, vh);
  ok(kGrid >= kOld - 1e-9, tag + ': fit zoom ' + kGrid.toFixed(3) + ' below stacked ' + kOld.toFixed(3));
  if (n >= 12 && name !== 'portrait') ok(kGrid >= 2 * kOld, tag + ': grid should at least double the zoom (' + kGrid.toFixed(3) + ' vs ' + kOld.toFixed(3) + ')');
  const kids = r.nodes.filter(x => x.id !== 'main');
  const ys = kids.map(x => x.y), mid = (Math.min(...ys) + Math.max(...ys.map((y, i) => y + kids[i].h))) / 2;
  ok(Math.abs(m.y + m.h / 2 - mid) < 1, tag + ': main agent is centred on its sub-agents');
}

/* 2: dispatch order is row-major (left to right, then down) */
{
  const r = build(snap(12), 1400, 875);
  const k = r.nodes.filter(n => n.id !== 'main');
  const order = k.slice().sort((a, b) => a.y - b.y || a.x - b.x).map(n => n.id);
  ok(JSON.stringify(order) === JSON.stringify(k.map(n => n.id)), 'grid is filled row by row in dispatch order');
  ok(r.cols[1] > 1, '12 agents on a wide screen use several grid columns (got ' + r.cols[1] + ')');
  ok(build(snap(12), 800, 1400).cols[1] < r.cols[1], 'a portrait viewport uses fewer columns than a wide one');
}

/* 3: appending a node keeps every existing node in place; the column count only changes past the hysteresis threshold */
for (const [name, [vw, vh]] of Object.entries(VIEWS)) {
  const mem = {}, retired = new Set();
  let prev = null, prevCols = 0, changes = 0;
  for (let n = 1; n <= 30; n++) {
    const r = build(snap(n), vw, vh, {mem, retired});
    if (prev && r.cols[1] === prevCols) {
      const p = pos(r);
      ok([...prev].every(([id, xy]) => p.get(id) === xy), name + ': adding agent ' + n + ' moved an existing node');
    } else if (prev) changes++;
    prev = pos(r); prevCols = r.cols[1];
  }
  ok(changes <= 6, name + ': column count changed ' + changes + ' times while growing to 30');
  /* rebuilding with the same input is a no-op */
  const a = pos(build(snap(30), vw, vh, {mem, retired})), b = pos(build(snap(30), vw, vh, {mem, retired}));
  ok([...a].every(([id, xy]) => b.get(id) === xy), name + ': repeated build is stable');
}

/* 4: hysteresis: a viewport that wobbles around a size does not flip the column count back and forth */
{
  const mem = {}, retired = new Set(), seen = [];
  for (let i = 0; i < 12; i++) seen.push(build(snap(12), 1400 + (i % 2 ? 30 : -30), 875, {mem, retired}).cols[1]);
  ok(new Set(seen.slice(1)).size === 1, 'small viewport changes keep the column count (' + seen.join(',') + ')');
}

/* 5: a fold leaves a hole instead of shifting the later nodes; the summary node sits under the band, left-aligned */
{
  const mem = {}, retired = new Set(), vw = 1400, vh = 875;
  const d = snap(12);
  const r0 = build(d, vw, vh, {mem, retired}), p0 = pos(r0);
  d.cards[3] = card('s2', 102, {done: true, doneTs: NOW - 120000});   // returned long ago: folded
  const r1 = build(d, vw, vh, {mem, retired}), p1 = pos(r1);
  ok(r1.folded.includes('s2') && !p1.has('s2'), 'the expired agent is folded');
  ok([...p1].filter(([id]) => id !== G.GR_SUM).every(([id, xy]) => p0.get(id) === xy), 'folding one agent moves no other node');
  const sum = r1.nodes.find(n => n.id === G.GR_SUM), band = r1.nodes.filter(n => n.col === 1 && n.kind === 'agent');
  ok(sum && sum.x === Math.min(...band.map(n => n.x)) && sum.y >= Math.max(...band.map(n => n.y + n.h)), 'summary node is below the band, in its first column');
  ok(r1.edges.some(e => e.from === 'main' && e.to === G.GR_SUM), 'summary node is linked from the main agent');
  ok(!overlaps(r1.nodes), 'no overlaps with a summary node');
}

/* 6: deeper levels form their own band to the right; maxNodes overflow folds returned agents first */
{
  const d = {cards: [card('main', 1)]};
  for (let i = 0; i < 4; i++) d.cards.push(card('p' + i, 100 + i));
  for (let i = 0; i < 10; i++) d.cards.push(card('g' + i, 200 + i, {parent: 'p' + (i % 4)}));
  const r = build(d, 1600, 900);
  const p = r.nodes.filter(n => n.col === 1), g = r.nodes.filter(n => n.col === 2);
  ok(p.length === 4 && g.length === 10, 'two bands: 4 children, 10 grandchildren');
  ok(Math.min(...g.map(n => n.x)) >= Math.max(...p.map(n => n.x + n.w)) + G.GR_GX - 1e-6, 'grandchildren sit right of the children band');
  ok(!overlaps(r.nodes) && edgesValid(r) && r.edges.filter(e => e.to.startsWith('g')).every(e => e.from.startsWith('p')), 'grandchildren link to their parents');
  const kGrid = fitK(bbox(r.nodes), 1600, 900), kOld = fitK({w: 3 * G.GR_W + 2 * G.GR_GX, h: 10 * (G.GR_H + G.GR_GY) - G.GR_GY}, 1600, 900);
  ok(kGrid > kOld, 'two-level grid fits better than stacking (' + kGrid.toFixed(3) + ' vs ' + kOld.toFixed(3) + ')');

  const o = snap(45);
  for (let i = 0; i < 10; i++) Object.assign(o.cards[1 + i], {done: true, doneTs: NOW - 1000});
  const ro = build(o, 1600, 900);
  ok(ro.folded.length === 10 && ro.nodes.some(n => n.id === G.GR_SUM) && !overlaps(ro.nodes), 'over maxNodes the returned agents fold at once');
}

console.log(fails ? fails + ' of ' + checks + ' checks failed' : 'graph layout: ' + checks + ' checks passed');
process.exit(fails ? 1 : 0);
