'use strict';
/* Single-agent timeline: row layout, canvas painting and hit testing. The controller is tl_focus.js.
 * Rows (top to bottom): one swim lane per time-segmentation category that occurs, one block row for tool calls
 * (parallel and background calls are packed into sub-rows), a marker row, then one mini bar per dispatched sub-agent. */

const FX = {LANE: 22, CALL: 20, MARK: 24, CHILD: 18, SEC: 20, MAXSUB: 6};
const FOCUS_MARKS = {hook: 1, fail: 1, compact: 1, merge: 1};
const FOCUS_TICKS = [100, 200, 500].concat(TICKS);

function focusLayout(a, T) {
  const M = timelineModel();
  const lanes = TS_ORDER.filter(k => T.by[k] > 0);
  const segsBy = {};
  lanes.forEach(k => { segsBy[k] = []; });
  T.segs.forEach(sg => segsBy[sg.cat].push(sg));
  // tool-call blocks, packed greedily into sub-rows by their (background-extended) extent
  const blocks = [];
  T.flat.forEach(f => f.s.calls.forEach(c => {
    if (!c.ts) return;
    const b = Math.max(c.ts + Math.max(c.dur || 0, 0), c.ts + 1);
    blocks.push({c, s: f.s, a: c.ts, b, ext: Math.max(b, c.bg && c.bgDone ? c.bgDone : 0), cat: tsCallCat(c, T.hasKids)});
  }));
  blocks.sort((x, y) => x.a - y.a);
  const subs = [], ends = [], blockOf = new Map();
  blocks.forEach(bl => {
    let k = ends.findIndex(e => e <= bl.a);
    if (k < 0) k = Math.min(ends.length, FX.MAXSUB - 1);
    if (k === ends.length) { ends.push(0); subs.push([]); subs[k].maxLen = 0; }
    ends[k] = Math.max(ends[k], bl.ext);
    subs[k].maxLen = Math.max(subs[k].maxLen, bl.ext - bl.a);
    subs[k].push(bl);
    bl.sub = k;
    blockOf.set(bl.c, bl);
  });
  const marks = (M.rows[a.id] ? M.rows[a.id].marks : []).filter(m => FOCUS_MARKS[m.kind]);
  const seen = {}, kids = [];
  T.spans.slice().sort((x, y) => x.t0 - y.t0).forEach(sp => { if (!seen[sp.id]) { seen[sp.id] = 1; kids.push(sp); } });
  const rows = [];
  let y = 0;
  const push = (r, h) => { r.y = y; r.h = h; y += h; rows.push(r); return r; };
  lanes.forEach(k => push({kind: 'lane', cat: k}, FX.LANE));
  push({kind: 'calls', subs}, Math.max(1, subs.length) * FX.CALL + 4);
  if (marks.length) push({kind: 'marks'}, FX.MARK);
  if (kids.length) {
    push({kind: 'sec', label: '派出的子代理（' + kids.length + '）'}, FX.SEC);
    kids.forEach(sp => push({kind: 'child', sp}, FX.CHILD));
  }
  return {lanes, segsBy, blocks, blockOf, marks, kids, rows, H: y};
}

/* ---- scale helpers: the axis is linear in real time over [v0, v1] */
const ffx = (F, t) => (t - F.v0) / (F.v1 - F.v0) * F.plotW;
const fft = (F, x) => F.v0 + x / F.plotW * (F.v1 - F.v0);

function focusTickList(F) {
  const span = F.v1 - F.v0, pxPerMs = F.plotW / span;
  const step = FOCUS_TICKS.find(t => t * pxPerMs >= 92) || FOCUS_TICKS[FOCUS_TICKS.length - 1];
  const off = new Date(F.v0).getTimezoneOffset() * 60000, out = [];
  for (let t = Math.ceil((F.v0 - off) / step) * step + off; t <= F.v1; t += step) out.push({t, step});
  return out;
}
function focusTickLabel(t, step) {
  const base = tickLabel(t, step);
  return step < 1000 ? base + '.' + String(Math.floor(((t % 1000) + 1000) % 1000 / 100)) : base;
}

function focusPaintAxis(F) {
  const ctx = setupCanvas(F.axisCv, F.plotW, 26);
  ctx.fillStyle = cssVar('--dim');
  ctx.font = '11px -apple-system, "PingFang SC", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  focusTickList(F).forEach(k => {
    const x = ffx(F, k.t);
    ctx.fillText(focusTickLabel(k.t, k.step), Math.min(F.plotW - 30, Math.max(30, x)), 13);
    ctx.fillRect(x, 20, 1, 6);
  });
}

function lowerByEnd(arr, t, key) {  // first element whose [key] >= t, for arrays sorted by that key
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][key] < t) lo = m + 1; else hi = m; }
  return lo;
}

/* Text colour for a filled block: dark on light fills, white on dark ones (the fills differ between the two themes). */
const _inkCache = {};
function inkFor(col) {
  if (col in _inkCache) return _inkCache[col];
  let rgb = null, m = /^#([0-9a-f]{6})$/i.exec(col);
  if (m) rgb = [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16));
  else if ((m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(col))) rgb = [+m[1], +m[2], +m[3]];
  return (_inkCache[col] = rgb && 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150 ? '#14181e' : '#ffffff');
}

/* Text cut to a pixel width with an ellipsis. */
function fitText(ctx, str, maxW) {
  if (ctx.measureText(str).width <= maxW) return str;
  let lo = 0, hi = str.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(str.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; }
  return lo ? str.slice(0, lo) + '…' : '';
}

function focusPaint(F) {
  const W = F.plotW, ctx = setupCanvas(F.cv, W, F.L.H);
  ctx.font = '11px -apple-system, "PingFang SC", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = cssVar('--line');
  ctx.globalAlpha = .6;
  focusTickList(F).forEach(k => { const x = Math.round(ffx(F, k.t)) + .5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, F.L.H); ctx.stroke(); });
  ctx.globalAlpha = 1;
  F.L.rows.forEach(row => {
    ctx.fillStyle = cssVar('--line');
    ctx.fillRect(0, row.y + row.h - 1, W, 1);
    if (row.kind === 'lane') paintFocusLane(ctx, F, row);
    else if (row.kind === 'calls') paintFocusCalls(ctx, F, row);
    else if (row.kind === 'marks') paintFocusMarks(ctx, F, row);
    else if (row.kind === 'child') paintFocusChild(ctx, F, row);
  });
  paintFocusLinks(ctx, F);
}

function paintFocusLane(ctx, F, row) {
  const segs = F.L.segsBy[row.cat];
  ctx.fillStyle = resolveColor(TS_CATS[row.cat].color);
  for (let i = lowerByEnd(segs, F.v0, 't1'); i < segs.length; i++) {
    const sg = segs[i];
    if (sg.t0 > F.v1) break;
    const x0 = ffx(F, sg.t0), w = Math.max(ffx(F, sg.t1) - x0, 1);
    ctx.globalAlpha = w < 1.2 ? .6 : 1;
    ctx.fillRect(x0, row.y + 3, w, row.h - 7);
  }
  ctx.globalAlpha = 1;
}

function paintFocusCalls(ctx, F, row) {
  const bad = cssVar('--bad');
  row.subs.forEach((list, k) => {
    const y0 = row.y + 2 + k * FX.CALL, h = FX.CALL - 4;
    for (let i = lowerByEnd(list, F.v0 - list.maxLen, 'a'); i < list.length; i++) {
      const bl = list[i];
      if (bl.a > F.v1) break;
      if (bl.ext < F.v0) continue;
      const x0 = ffx(F, bl.a), x1 = ffx(F, bl.b), w = Math.max(x1 - x0, 2);
      const fill = resolveColor(TS_CATS[bl.cat].color);
      ctx.fillStyle = fill;
      if (bl.ext > bl.b) {  // background command: the launch is the block, the run is a faint strip
        ctx.globalAlpha = .35;
        ctx.fillRect(x1, y0 + h / 2 - 1, Math.max(ffx(F, bl.ext) - x1, 1), 3);
        ctx.globalAlpha = 1;
      }
      ctx.fillRect(x0, y0, w, h);
      if (bl.c.st === 'err' || bl.c.st === 'hook') { ctx.strokeStyle = bad; ctx.lineWidth = 1.5; ctx.strokeRect(x0 + .5, y0 + .5, Math.max(w - 1, 1), h - 1); ctx.lineWidth = 1; }
      if (w >= 46) {
        const c = bl.c, desc = c.desc || firstLine(c.sum);
        const txt = fitText(ctx, c.name + (desc ? '  ' + desc : ''), w - 6);
        if (txt) { ctx.fillStyle = inkFor(fill); ctx.textAlign = 'left'; ctx.fillText(txt, Math.max(x0, 0) + 3, y0 + h / 2 + .5); }
      }
    }
  });
}

function paintFocusMarks(ctx, F, row) {
  const marks = F.L.marks, lastX = {};
  for (let i = lowerByEnd(marks, F.v0 - 12 / F.plotW * (F.v1 - F.v0), 'ts'); i < marks.length; i++) {
    const m = marks[i], x = ffx(F, m.ts);
    if (x > F.plotW + 8) break;
    if (m.kind in lastX && x - lastX[m.kind] < 3) continue;
    lastX[m.kind] = x;
    drawGlyph(ctx, m.kind, x, row.y + row.h / 2, cssVar(MK[m.kind].c));
  }
}

function paintFocusChild(ctx, F, row) {
  const sp = row.sp, ch = A[sp.id];
  const x0 = ffx(F, sp.t0), w = Math.max(ffx(F, sp.t1) - x0, 3);
  if (x0 > F.plotW || x0 + w < 0) return;
  const fill = resolveColor(famColor(ch ? ch.fam : 'other'));
  ctx.globalAlpha = .85;
  ctx.fillStyle = fill;
  ctx.fillRect(x0, row.y + 4, w, row.h - 9);
  ctx.globalAlpha = 1;
  if (w >= 50) {
    const txt = fitText(ctx, ch ? ch.desc : sp.id, Math.min(w, F.plotW - Math.max(x0, 0)) - 6);
    if (txt) { ctx.fillStyle = inkFor(fill); ctx.textAlign = 'left'; ctx.fillText(txt, Math.max(x0, 0) + 3, row.y + row.h / 2); }
  }
}

/* Dispatch links: from the dispatching call block down to the start of the child's mini bar. */
function paintFocusLinks(ctx, F) {
  const callsRow = F.L.rows.find(r => r.kind === 'calls');
  if (!callsRow) return;
  ctx.strokeStyle = ctx.fillStyle = cssVar('--link');
  ctx.lineWidth = 1;
  F.L.rows.forEach(row => {
    if (row.kind !== 'child') return;
    const sp = row.sp, bl = F.L.blockOf.get(sp.call);
    const xp = ffx(F, sp.call.ts), xc = ffx(F, sp.t0);
    if (Math.max(xp, xc) < -4 || Math.min(xp, xc) > F.plotW + 4) return;
    const yp = callsRow.y + 2 + (bl ? bl.sub : 0) * FX.CALL + (FX.CALL - 4) / 2, yc = row.y + row.h / 2;
    ctx.beginPath();
    ctx.moveTo(xp, yp);
    ctx.lineTo(xp, yc);
    if (Math.abs(xc - xp) > .5) ctx.lineTo(xc, yc);
    ctx.stroke();
    ctx.fillRect(xp - 1.5, yp - 1.5, 3, 3);
  });
}

/* ---- hit testing */
function focusRowAt(F, py) {
  for (const r of F.L.rows) if (py >= r.y && py < r.y + r.h) return r;
  return null;
}
function focusHit(F, px, py) {
  const row = focusRowAt(F, py);
  if (!row) return null;
  const t = fft(F, px), slack = (F.v1 - F.v0) / F.plotW * 2;
  if (row.kind === 'lane') {
    const segs = F.L.segsBy[row.cat];
    const i = lowerByEnd(segs, t - slack, 't1');
    return i < segs.length && segs[i].t0 <= t + slack ? {kind: 'seg', seg: segs[i], row} : null;
  } else if (row.kind === 'calls') {
    const list = row.subs[Math.floor((py - row.y - 2) / FX.CALL)];
    if (!list) return null;
    let hit = null;
    for (let i = lowerByEnd(list, t - list.maxLen - slack, 'a'); i < list.length && list[i].a <= t + slack; i++) {
      const bl = list[i];
      if (t >= bl.a - slack && t <= bl.b + slack) hit = bl;
    }
    return hit && {kind: 'block', bl: hit, row};
  } else if (row.kind === 'marks') {
    let best = null, bd = 8;
    F.L.marks.forEach(m => { const d = Math.abs(ffx(F, m.ts) - px); if (d < bd) { bd = d; best = m; } });
    return best && {kind: 'mark', mark: best, row};
  } else if (row.kind === 'child') {
    const sp = row.sp;
    if (t >= sp.t0 - slack && t <= Math.max(sp.t1, sp.t0 + slack * 3)) return {kind: 'child', sp, row};
  }
  return null;
}
