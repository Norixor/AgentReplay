'use strict';
/* Flow graph, part 1: tree layout and curve maths. No DOM access here.
 * grBuild() turns the live snapshot (running cards + recently returned cards) into nodes with target positions:
 * the main agent is column 0, a sub-agent of depth N sits in column N, each column ordered by dispatch time.
 * Returned agents stay visible while they fade (graphFadeSec), then fold into one summary node. */

const GR_W = 272, GR_H = 252, GR_MH = 304;   // agent node size; the main agent is taller (sub-agent counts, last user message)
const GR_SW = 272, GR_SH = 70;         // summary node size
const GR_GX = 170, GR_GY = 22;         // gaps between columns / rows
const GR_SLOT_Y = 17;                  // vertical offset of the input / output slots inside a node
const GR_SUM = '__sum';

/* Nodes shown, edges between them, and the ids folded into the summary node.
 * opt: {now, fadeMs, maxNodes, retired:Set}. `retired` is the page-lifetime set of ids that were folded in. */
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
  /* columns */
  const cols = [];
  const place = (c, depth, seen) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    (cols[depth] = cols[depth] || []).push(c);
    (kids.get(c.id) || []).filter(k => keep.get(k.id)).forEach(k => place(k, depth + 1, seen));
  };
  place(main, 0, new Set());
  const nodes = [], edges = [];
  const slotH = GR_H + GR_GY;
  cols.forEach((list, col) => {
    if (col > 0) list.sort((a, b) => (a.start || 1e15) - (b.start || 1e15) || (a.id < b.id ? -1 : 1));
    list.forEach((c, row) => nodes.push({id: c.id, kind: 'agent', card: c, col, row, x: col * (GR_W + GR_GX), y: row * slotH, w: GR_W, h: GR_H,
                                         parent: c.id === 'main' ? null : c._p}));
  });
  const n1 = (cols[1] || []).length + (opt.retired.size ? 1 : 0);
  const mainNode = nodes[0];
  mainNode.h = GR_MH;
  mainNode.y = n1 ? ((n1 - 1) * slotH + GR_H - GR_MH) / 2 : 0;
  if (opt.retired.size) {
    nodes.push({id: GR_SUM, kind: 'sum', card: null, col: 1, row: n1 - 1, x: GR_W + GR_GX, y: (n1 - 1) * slotH, w: GR_SW, h: GR_SH, parent: 'main'});
  }
  const ids = new Set(nodes.map(n => n.id));
  nodes.forEach(n => { if (n.parent && ids.has(n.parent)) edges.push({id: n.parent + '>' + n.id, from: n.parent, to: n.id}); });
  return {nodes, edges, folded};
}

/* ComfyUI-style link: horizontal tangents, control offset = half the distance between the two slots. */
function grCurve(x1, y1, x2, y2) {
  const off = Math.hypot(x2 - x1, y2 - y1) * 0.5;
  return {p0: [x1, y1], c1: [x1 + off, y1], c2: [x2 - off, y2], p1: [x2, y2],
          d: 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'C' + (x1 + off).toFixed(1) + ' ' + y1.toFixed(1) + ' ' + (x2 - off).toFixed(1) + ' ' + y2.toFixed(1) + ' ' + x2.toFixed(1) + ' ' + y2.toFixed(1)};
}
function grPoint(c, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, e = 3 * u * t * t, f = t * t * t;
  return [a * c.p0[0] + b * c.c1[0] + e * c.c2[0] + f * c.p1[0], a * c.p0[1] + b * c.c1[1] + e * c.c2[1] + f * c.p1[1]];
}
const grEase = t => 1 - Math.pow(1 - t, 3);
const grClamp = (v, a, b) => Math.max(a, Math.min(b, v));
