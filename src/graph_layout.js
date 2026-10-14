'use strict';
/* Flow graph, part 1: tree layout and curve maths. No DOM access here.
 * grBuild() turns the live snapshot (running cards + recently returned cards) into nodes with target positions:
 * the main agent is on the left, sub-agents of depth N form band N to its right, laid out as a grid (row-major, in dispatch
 * order) whose column count follows the viewport shape, so many parallel agents fit on one screen at a readable zoom.
 * Returned agents stay visible while they fade (graphFadeSec), then fold into one summary node. */

const GR_W = 272, GR_H = 252, GR_MH = 304;   // agent node size; the main agent is taller (sub-agent counts, last user message)
const GR_SW = 272, GR_SH = 70;         // summary node size
const GR_GX = 170, GR_GY = 22;         // gaps between depth bands / grid rows
const GR_CX = 64;                      // gap between grid columns inside one band
const GR_SLOT = GR_H + GR_GY;          // grid row pitch
const GR_FIT_PAD = 28, GR_FIT_PADT = 56, GR_FIT_MAX = 1.2;   // grFit padding (top clears the status overlay) and zoom cap
const GR_HYST = 1.15, GR_TIE = 0.98;   // column-count hysteresis; near-tie tolerance
const GR_SLOT_Y = 17;                  // vertical offset of the input / output slots inside a node
const GR_SUM = '__sum';

/* Nodes shown, edges between them, and the ids folded into the summary node.
 * opt: {now, fadeMs, maxNodes, retired:Set, vw, vh, mem}. `retired` is the page-lifetime set of ids that were folded in.
 * vw/vh: viewport size in px. `mem` (optional, mutated like `retired`) carries the previous column counts and cells so
 * repeated builds stay stable; without it the result depends on the inputs only. */
function grBuild(d, opt) {
  const cards = (d.cards || []).concat(d.returned || []);
  const byId = new Map();
  cards.forEach(c => { if (!byId.has(c.id)) byId.set(c.id, c); });
  const main = byId.get('main');
  if (!main) return {nodes: [], edges: [], folded: []};
  const kids = new Map();
  byId.forEach((c, id) => {
    if (id === 'main') return;
    let p = c.parent;
    if (!p || p === id || !byId.has(p)) p = 'main';
    c._p = p;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(c);
  });
  /* A returned agent is folded once its fade is over, or at once when the graph would exceed maxNodes.
   * It stays while any descendant is still shown, so the tree never loses a link. */
  const overflow = byId.size > opt.maxNodes;
  const expired = c => c.done && (overflow || opt.now - c.doneTs > opt.fadeMs);
  const keep = new Map();
  const visit = (c, depth) => {
    if (keep.has(c.id)) return keep.get(c.id);
    keep.set(c.id, true);  // cycle guard
    let any = false;
    (kids.get(c.id) || []).forEach(k => { if (depth < 12 && visit(k, depth + 1)) any = true; });
    const v = c.id === 'main' || !expired(c) || any;
    keep.set(c.id, v);
    return v;
  };
  visit(main, 0);
  const folded = [];
  byId.forEach((c, id) => {
    if (id !== 'main' && !keep.get(id) && c.done) { folded.push(id); opt.retired.add(id); }
    else if (!c.done) opt.retired.delete(id);
  });
  /* bands: depth N is band N, each band ordered by dispatch time */
  const bands = [];
  const place = (c, depth, seen) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    (bands[depth] = bands[depth] || []).push(c);
    (kids.get(c.id) || []).filter(k => keep.get(k.id)).forEach(k => place(k, depth + 1, seen));
  };
  place(main, 0, new Set());
  for (let d = 1; d < bands.length; d++) bands[d].sort((a, b) => (a.start || 1e15) - (b.start || 1e15) || (a.id < b.id ? -1 : 1));
  const ns = bands.map(l => l.length);
  const hasSum = opt.retired.size > 0;
  const mem = opt.mem || {};
  const cols = grPickCols(ns, hasSum, opt.vw || 1400, opt.vh || 800, mem.cols);
  const nodes = [], edges = [];
  nodes.push({id: 'main', kind: 'agent', card: main, col: 0, row: 0, gc: 0, x: 0, y: 0, w: GR_W, h: GR_MH, parent: null});
  const cells = [];
  let x = 0, span1 = 0;
  for (let d = 1; d < bands.length; d++) {
    const list = bands[d], c = cols[d];
    const idx = grCells(list, c, mem.cols && mem.cols[d] === c && mem.cells ? mem.cells[d] : null);
    cells[d] = new Map(list.map((n, i) => [n.id, idx[i]]));
    x += (d === 1 ? GR_W : grBandW(Math.min(cols[d - 1], grUsed(cells[d - 1])))) + GR_GX;
    list.forEach((n, i) => {
      const gc = idx[i] % c, gr = Math.floor(idx[i] / c);
      nodes.push({id: n.id, kind: 'agent', card: n, col: d, row: gr, gc, x: x + gc * (GR_W + GR_CX), y: gr * GR_SLOT, w: GR_W, h: GR_H, parent: n._p});
    });
    if (d === 1) span1 = list.length ? Math.ceil(grUsed(cells[1]) / c) * GR_SLOT - GR_GY : 0;
  }
  const rows1 = span1 ? (span1 + GR_GY) / GR_SLOT : 0;
  if (hasSum) {
    nodes.push({id: GR_SUM, kind: 'sum', card: null, col: 1, row: rows1, gc: 0, x: GR_W + GR_GX, y: rows1 * GR_SLOT, w: GR_SW, h: GR_SH, parent: 'main'});
    span1 = rows1 * GR_SLOT + GR_SH;
  }
  nodes[0].y = span1 ? (span1 - GR_MH) / 2 : 0;
  if (opt.mem) { opt.mem.cols = cols; opt.mem.cells = cells; }
  const ids = new Set(nodes.map(n => n.id));
  nodes.forEach(n => { if (n.parent && ids.has(n.parent)) edges.push({id: n.parent + '>' + n.id, from: n.parent, to: n.id}); });
  return {nodes, edges, folded, cols};
}

/* ---------------------------------------------------------------- grid bands
 * Every depth band is a row-major grid. The column counts are chosen so that grFit reaches the largest zoom for the
 * viewport (vw x vh); candidates share one row budget R (band d gets ceil(n_d / R) columns), which covers every useful
 * single-band choice and keeps deeper bands about as tall as the first one.
 * Stability: the previous column counts stay while they reach at least 1/GR_HYST of the best zoom, so the grid only
 * reflows after crossing a clear threshold; with the same counts, nodes keep their cells (see grCells). */
const grBandW = c => c * GR_W + Math.max(0, c - 1) * GR_CX;
const grUsed = m => { let u = 0; if (m) m.forEach(i => { if (i + 1 > u) u = i + 1; }); return u; };

/* The zoom grFit would pick for this many nodes per band laid out with these column counts. */
function grScore(ns, cols, hasSum, vw, vh) {
  let w = GR_W, span1 = 0, ymax = 0;
  for (let d = 1; d < ns.length; d++) {
    const c = Math.max(1, Math.min(cols[d], ns[d])), span = Math.ceil(ns[d] / c) * GR_SLOT - GR_GY;
    w += GR_GX + grBandW(c);
    if (d === 1) span1 = span;
    ymax = Math.max(ymax, span);
  }
  if (hasSum) {
    span1 = (ns.length > 1 ? span1 + GR_GY : 0) + GR_SH;
    if (ns.length < 2) w += GR_GX + GR_SW;
    ymax = Math.max(ymax, span1);
  }
  const top = span1 ? (span1 - GR_MH) / 2 : 0;
  const h = Math.max(ymax, top + GR_MH) - Math.min(0, top);
  return Math.min(GR_FIT_MAX, (vw - 2 * GR_FIT_PAD) / w, (vh - GR_FIT_PAD - GR_FIT_PADT) / h);
}

/* Column count per band (index 0, the main agent, is always 1). `prev` is the choice of the previous build. */
function grPickCols(ns, hasSum, vw, vh, prev) {
  const top = Math.max(1, ...ns.slice(1));
  const forRows = r => ns.map((n, d) => d ? Math.max(1, Math.ceil(n / r)) : 1);
  let best = null, kmax = 0;
  const cands = [];
  for (let r = top; r >= 1; r--) { const c = forRows(r), k = grScore(ns, c, hasSum, vw, vh); cands.push([c, k]); if (k > kmax) kmax = k; }
  /* near-ties go to fewer columns: links into the first grid column are the easiest to follow */
  for (const [c, k] of cands) if (k >= kmax * GR_TIE) { best = [c, k]; break; }
  if (prev && prev.length > 1) {
    const rows1 = Math.max(1, Math.ceil((ns[1] || 0) / Math.max(1, Math.min(prev[1], ns[1] || 1))));
    const keep = ns.map((n, d) => d === 0 ? 1 : prev[d] || Math.max(1, Math.ceil(n / rows1)));
    if (grScore(ns, keep, hasSum, vw, vh) * GR_HYST >= best[1]) return keep;
  }
  return best[0];
}

/* Cell index per node (list is in dispatch order). With an unchanged column count the previous cells are kept and new
 * nodes go after the last used cell, so a fold leaves a hole instead of shifting everyone; the band is repacked only when
 * that keeps the order wrong or when packing would save a whole row. */
function grCells(list, c, prev) {
  const packed = list.map((n, i) => i);
  if (!prev) return packed;
  let next = 0;
  list.forEach(n => { const i = prev.get(n.id); if (i != null && i + 1 > next) next = i + 1; });
  const idx = [];
  let last = -1;
  for (const n of list) {
    let i = prev.get(n.id);
    if (i == null) i = next++;
    if (i <= last) return packed;
    idx.push(last = i);
  }
  return Math.ceil((last + 1) / c) > Math.ceil(list.length / c) ? packed : idx;
}

/* ComfyUI-style link: horizontal tangents, control offset = half the distance between the two slots.
 * endOff (optional) caps the control offset at the target end. */
function grCurve(x1, y1, x2, y2, endOff) {
  const off = Math.hypot(x2 - x1, y2 - y1) * 0.5, off2 = endOff != null ? Math.min(off, endOff) : off;
  return {p0: [x1, y1], c1: [x1 + off, y1], c2: [x2 - off2, y2], p1: [x2, y2],
          d: 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'C' + (x1 + off).toFixed(1) + ' ' + y1.toFixed(1) + ' ' + (x2 - off2).toFixed(1) + ' ' + y2.toFixed(1) + ' ' + x2.toFixed(1) + ' ' + y2.toFixed(1)};
}
function grPoint(c, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, e = 3 * u * t * t, f = t * t * t;
  return [a * c.p0[0] + b * c.c1[0] + e * c.c2[0] + f * c.p1[0], a * c.p0[1] + b * c.c1[1] + e * c.c2[1] + f * c.p1[1]];
}
const grEase = t => 1 - Math.pow(1 - t, 3);
const grClamp = (v, a, b) => Math.max(a, Math.min(b, v));
