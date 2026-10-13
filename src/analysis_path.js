'use strict';
/* Critical path: the chain of work that decides when the session ends.
 *
 * Walk back from the last moment of the root agent through its time segmentation. A "waiting for sub-agents" segment is
 * explained by the sub-agent whose hand-back is closest to the end of that wait; the walk then goes into that sub-agent
 * (back to its start) and returns to the parent at the dispatch moment. Work the parent did in parallel with the child
 * in between is not on the path. Pieces are returned in chronological order. */

/* Index of the last segment that starts before t (-1 when none). */
function anaLastBefore(segs, t) {
  let lo = 0, hi = segs.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].t0 < t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

/* The not yet used sub-agent that handed back closest to `hi`, among those running during [lo, hi]. */
function anaPickChild(spans, used, scope, lo, hi) {
  let best = null, bd = Infinity;
  spans.forEach(sp => {
    if (used.has(sp.id) || !scope.byId[sp.id] || sp.t0 >= hi || sp.t1 <= lo) return;
    const ct = scope.byId[sp.id].T;
    if (ct.T1 <= ct.T0) return;
    const d = Math.abs(sp.t1 - hi);
    if (d < bd || (d === bd && best && sp.t0 > best.t0)) { best = sp; bd = d; }
  });
  return best;
}

function anaPathWalk(scope, id, tEnd, tStop, used, out, depth) {
  const T = scope.byId[id].T, segs = T.segs;
  const piece = (cat, t0, t1, seg) => out.push({agentId: id, cat, t0, t1, seg: seg || null});
  let t = Math.min(tEnd, T.T1);
  let i = anaLastBefore(segs, t);
  while (i >= 0 && t > tStop) {
    const sg = segs[i], hi = Math.min(sg.t1, t), lo = Math.max(sg.t0, tStop);
    if (hi <= lo) { i--; continue; }
    const sp = sg.cat === 'subwait' && depth < 16 ? anaPickChild(T.spans, used, scope, lo, hi) : null;
    if (!sp) { piece(sg.cat, lo, hi, sg); t = lo; i--; continue; }
    used.add(sp.id);
    const ct = scope.byId[sp.id].T, cEnd = Math.min(hi, ct.T1);
    if (hi > cEnd) piece('subwait', cEnd, hi, sg);          // the parent kept waiting after the child had finished
    anaPathWalk(scope, sp.id, cEnd, ct.T0, used, out, depth + 1);
    const d = Math.min(Math.max(sp.call.ts, tStop), hi);    // back to the parent at the dispatch moment
    if (ct.T0 > d) piece('subwait', d, Math.min(ct.T0, cEnd), sg);  // dispatch -> the child's first recorded moment
    t = d;
    i = anaLastBefore(segs, t);
  }
}

/* -> {pieces (chronological), merged (adjacent pieces of one agent and category joined), total, top (5 longest merged)}. */
function anaCriticalPath(scope) {
  const out = [], rootRow = scope.byId[scope.rootId];
  if (rootRow && rootRow.T.T1 > rootRow.T.T0) anaPathWalk(scope, scope.rootId, rootRow.T.T1, rootRow.T.T0, new Set([scope.rootId]), out, 0);
  const pieces = out.reverse().filter(p => p.t1 > p.t0);
  const merged = [];
  pieces.forEach(p => {
    const l = merged[merged.length - 1];
    if (l && l.agentId === p.agentId && l.cat === p.cat && l.t1 === p.t0) { l.t1 = p.t1; l.n++; } else merged.push(Object.assign({n: 1}, p));
  });
  const total = merged.reduce((m, p) => m + p.t1 - p.t0, 0);
  const top = merged.slice().sort((x, y) => (y.t1 - y.t0) - (x.t1 - x.t0)).slice(0, 5);
  return {pieces, merged, total, top, t0: merged.length ? merged[0].t0 : 0, t1: merged.length ? merged[merged.length - 1].t1 : 0};
}

/* Joins runs of tiny neighbours of one agent so that the bar has a few hundred blocks at most. A joined block takes the
 * category with the most time in it. minFrac is the smallest share of the path a block may have before it is joined. */
function anaPathBlocks(path, minFrac) {
  const total = Math.max(1, path.total), min = total * minFrac, out = [];
  let cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  path.merged.forEach(p => {
    const d = p.t1 - p.t0;
    if (d >= min) { flush(); out.push({agentId: p.agentId, cat: p.cat, t0: p.t0, t1: p.t1, d, parts: 1, by: {[p.cat]: d}}); return; }
    if (cur && (cur.agentId !== p.agentId || cur.d >= min)) flush();
    if (!cur) cur = {agentId: p.agentId, cat: p.cat, t0: p.t0, t1: p.t1, d: 0, parts: 0, by: {}};
    cur.t1 = p.t1;
    cur.d += d;
    cur.parts++;
    cur.by[p.cat] = (cur.by[p.cat] || 0) + d;
  });
  flush();
  out.forEach(b => { b.cat = Object.keys(b.by).sort((x, y) => b.by[y] - b.by[x])[0]; });
  return out;
}
