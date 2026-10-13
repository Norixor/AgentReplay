'use strict';
/* Timeline painting on <canvas>: only the rows in view are drawn, short segments are merged per pixel column. */

const TICKS = [1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3];
const BAR_Y = 7, BAR_H = 12;

function fmtIdle(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? m + ' 分钟' : m < 1440 ? (m / 60).toFixed(m % 60 ? 1 : 0) + ' 小时' : (m / 1440).toFixed(1) + ' 天';
}

function setupCanvas(cv, w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

const vx = (S, v) => (v - S.v0) / (S.v1 - S.v0) * S.plotW;
const tx = (S, t) => vx(S, S.W.r2v(t));
const xt = (S, x) => S.W.v2r(S.v0 + x / S.plotW * (S.v1 - S.v0));

function tickList(S) {
  const span = S.v1 - S.v0, pxPerMs = S.plotW / span;
  const step = TICKS.find(t => t * pxPerMs >= 92) || TICKS[TICKS.length - 1];
  const out = [];
  S.W.pieces.forEach(p => {
    if (p.gap || p.v1 < S.v0 || p.v0 > S.v1) return;
    const ra = Math.max(p.r0, S.W.v2r(Math.max(S.v0, p.v0))), rb = Math.min(p.r1, S.W.v2r(Math.min(S.v1, p.v1)));
    const off = new Date(ra).getTimezoneOffset() * 60000;
    for (let t = Math.ceil((ra - off) / step) * step + off; t <= rb; t += step) out.push({t, step});
  });
  return out;
}
function tickLabel(t, step) {
  const d = new Date(t);
  const day = step >= 86400e3 || (d.getHours() === 0 && d.getMinutes() === 0);
  return (day ? fmtDay(t) + ' ' : '') + p2(d.getHours()) + ':' + p2(d.getMinutes()) + (step < 60e3 ? ':' + p2(d.getSeconds()) : '');
}

function paintAxis(S) {
  const ctx = setupCanvas(S.axisCv, S.plotW, 26);
  ctx.fillStyle = cssVar('--dim');
  ctx.font = '11px -apple-system, "PingFang SC", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  tickList(S).forEach(k => {
    const x = tx(S, k.t);
    ctx.fillText(tickLabel(k.t, k.step), x, 13);
    ctx.fillRect(x, 20, 1, 6);
  });
  S.W.pieces.forEach(p => {
    if (!p.gap || p.v1 < S.v0 || p.v0 > S.v1) return;
    const x0 = vx(S, p.v0), x1 = vx(S, p.v1);
    if (x1 - x0 > 56) {
      ctx.fillStyle = cssVar('--ink');
      ctx.fillText('空闲 ' + fmtIdle(p.r1 - p.r0), (Math.max(0, x0) + Math.min(S.plotW, x1)) / 2, 13);
    }
  });
  if (S.now && !(S.hide && S.hide.now)) {
    const x = tx(S, S.now);
    if (x >= 0 && x <= S.plotW) {
      ctx.fillStyle = cssVar('--bad');
      ctx.textAlign = x > S.plotW - 24 ? 'right' : 'left';
      ctx.fillText('现在', x + (x > S.plotW - 24 ? -3 : 3), 7);
    }
  }
}

function paintGaps(ctx, S, h) {
  S.W.pieces.forEach(p => {
    if (!p.gap || p.v1 < S.v0 || p.v0 > S.v1) return;
    const x0 = vx(S, p.v0), x1 = vx(S, p.v1);
    ctx.fillStyle = cssVar('--gapbg');
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.strokeStyle = cssVar('--line');
    ctx.beginPath();
    ctx.moveTo(x0 + .5, 0); ctx.lineTo(x0 + .5, h); ctx.moveTo(x1 - .5, 0); ctx.lineTo(x1 - .5, h);
    ctx.stroke();
  });
}

function paintPlot(S) {
  const W = S.plotW, H = S.plotH, ctx = setupCanvas(S.cv, W, H);
  const RH = S.RH, first = Math.floor(S.off / RH), last = Math.min(S.rows.length - 1, Math.ceil((S.off + H) / RH));
  paintGaps(ctx, S, H);
  ctx.strokeStyle = cssVar('--line');
  ctx.globalAlpha = .6;
  tickList(S).forEach(k => { const x = Math.round(tx(S, k.t)) + .5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); });
  ctx.globalAlpha = 1;
  const vspan = S.v1 - S.v0, k = W / vspan;
  const rLeft = S.W.v2r(S.v0), rRight = S.W.v2r(S.v1);
  const cols = S.cols;
  for (let i = first; i <= last; i++) {
    const r = S.rows[i], y = i * RH - S.off;
    ctx.fillStyle = cssVar('--line');
    ctx.fillRect(0, y + RH - 1, W, 1);
    const a = r.a, row = r.row;
    const xa = tx(S, a._s), xb = Math.max(tx(S, Math.max(a._e, a._s + 500)), xa + 3);
    if (xb < -2 || xa > W + 2) { paintMarks(ctx, S, r, y); continue; }
    const x0 = Math.max(-2, xa), x1 = Math.min(W + 2, xb);
    if (S.mode === 'model') {
      ctx.globalAlpha = .85;
      ctx.fillStyle = resolveColor(famColor(a.fam));
      ctx.fillRect(x0, y + BAR_Y, x1 - x0, BAR_H);
      ctx.globalAlpha = 1;
      lodSegs(ctx, S, row.long, y, rLeft, rRight, k, false);
      bgStrips(ctx, S, row.bg, y, rLeft, rRight, 60000, false);
    } else {
      if (S.hide && S.hide.think) {
        // Thinking hidden: keep a hairline so the agent's lifetime stays visible behind the remaining segments.
        ctx.fillStyle = cssVar('--line');
        ctx.fillRect(x0, y + BAR_Y + Math.floor(BAR_H / 2), x1 - x0, 1);
      } else {
        ctx.fillStyle = cssVar('--think');
        ctx.fillRect(x0, y + BAR_Y, x1 - x0, BAR_H);
      }
      ctx.fillStyle = resolveColor(famColor(a.fam));
      ctx.fillRect(Math.max(-2, xa), y + BAR_Y, 2.5, BAR_H);
      lodSegs(ctx, S, row.segs, y, rLeft, rRight, k, true);
      bgStrips(ctx, S, row.bg, y, rLeft, rRight, 0, true);
    }
    paintMarks(ctx, S, r, y);
  }
  if (!(S.hide && S.hide.link)) paintLinks(ctx, S, first, last);
  if (S.now && !(S.hide && S.hide.now)) {
    const x = Math.round(tx(S, S.now)) + .5;
    if (x >= 0 && x <= W) {
      ctx.strokeStyle = cssVar('--bad');
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
}

/* Segments of one row: wide ones are drawn directly, sub-pixel ones are summed per pixel column (dominant category wins). */
function lodSegs(ctx, S, segs, y, rLeft, rRight, k, byCat) {
  if (!segs.length) return;
  // binary search the first segment that may reach into the view (segments are sorted by start, none longer than maxDur)
  let lo = 0, hi = segs.length;
  const lim = rLeft - (segs.maxDur || 3600e3 * 6);
  while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m].a < lim) lo = m + 1; else hi = m; }
  const W = S.plotW, cols = S.cols, ncat = 9;
  let used = false;
  for (let i = lo; i < segs.length; i++) {
    const sg = segs[i];
    if (sg.a > rRight) break;
    if (sg.b < rLeft) continue;
    const col = segCol(sg, byCat);
    if (S.hideCol && S.hideCol[col]) continue;
    const xa = tx(S, sg.a), xb = tx(S, sg.b), w = xb - xa;
    if (w >= 1.6) {
      ctx.fillStyle = S.catColor[col];
      ctx.fillRect(xa, y + BAR_Y - (byCat ? 0 : 1), w, BAR_H + (byCat ? 0 : 2));
    } else {
      const c0 = Math.max(0, Math.floor(xa)), c1 = Math.min(W - 1, Math.floor(xb));
      if (c1 < c0) continue;
      const dur = Math.max(sg.b - sg.a, 1);
      for (let c = c0; c <= c1; c++) cols[c * ncat + col] += dur / (c1 - c0 + 1);
      used = true;
    }
  }
  if (!used) return;
  const colMs = (S.v1 - S.v0) / W;
  for (let c = 0; c < W; c++) {
    let tot = 0, best = 0, bi = 0;
    for (let j = 0; j < ncat; j++) { const v = cols[c * ncat + j]; tot += v; if (v > best) { best = v; bi = j; } }
    if (tot > 0) {
      ctx.globalAlpha = Math.min(1, .35 + .65 * tot / colMs);
      ctx.fillStyle = S.catColor[bi];
      ctx.fillRect(c, y + BAR_Y, 1, BAR_H);
      for (let j = 0; j < ncat; j++) cols[c * ncat + j] = 0;
    }
  }
  ctx.globalAlpha = 1;
}

/* Colour slot of a segment: the activity category in "by activity" mode, the long-command type in "by model" mode. */
function segCol(sg, byCat) {
  return byCat ? sg.cat : (sg.c.cat === 'test' ? 1 : sg.c.cat === 'wait' ? 4 : 7);
}

function bgStrips(ctx, S, list, y, rLeft, rRight, minMs, byCat) {
  if (S.hide && S.hide.bg) return;
  ctx.globalAlpha = .6;
  list.forEach(b => {
    if (b.b < rLeft || b.a > rRight || b.b - b.a < minMs) return;
    const xa = tx(S, b.a), w = Math.max(2, tx(S, b.b) - xa);
    ctx.fillStyle = byCat ? S.catColor[b.cat < 0 ? 6 : b.cat] : S.catColor[b.c.cat === 'test' ? 1 : b.c.cat === 'wait' ? 4 : 7];
    ctx.fillRect(xa, y + 18, w, 4);
  });
  ctx.globalAlpha = 1;
}

function paintMarks(ctx, S, r, y) {
  const cy = y + 13, lastX = {};
  const lo = lowerBound(r.row.marks, S.W.v2r(S.v0 - 12 / S.plotW * (S.v1 - S.v0)));
  for (let i = lo; i < r.row.marks.length; i++) {
    const m = r.row.marks[i];
    if (!S.kinds[m.kind]) continue;
    const x = tx(S, m.ts);
    if (x > S.plotW + 8) break;
    if (m.kind in lastX && x - lastX[m.kind] < 3) continue;
    lastX[m.kind] = x;
    drawGlyph(ctx, m.kind, x, cy, cssVar(MK[m.kind].c));
  }
}
function lowerBound(arr, ts) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].ts < ts) lo = m + 1; else hi = m; }
  return lo;
}
function drawGlyph(ctx, kind, x, y, col) {
  ctx.fillStyle = ctx.strokeStyle = col;
  ctx.beginPath();
  if (kind === 'user') ctx.arc(x, y, 4, 0, 6.3);
  else if (kind === 'compact') { ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); }
  else if (kind === 'merge') { ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath(); }
  else if (kind === 'back') { ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y - 4); ctx.lineTo(x, y + 4); ctx.closePath(); }
  else if (kind === 'hook') {
    ctx.lineWidth = 2; ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke(); ctx.lineWidth = 1; return;
  } else { ctx.lineWidth = 1.6; ctx.arc(x, y, 3.2, 0, 6.3); ctx.stroke(); ctx.lineWidth = 1; return; }
  ctx.fill();
}

/* Thin dispatch links: from the parent row at the dispatch moment to the start of the child bar. */
function paintLinks(ctx, S, first, last) {
  ctx.strokeStyle = cssVar('--link');
  ctx.lineWidth = 1;
  S.links.forEach(l => {
    const pi = S.rowOf[l.parent], ci = S.rowOf[l.child.id];
    if (pi == null || ci == null) return;
    const lo = Math.min(pi, ci), hi = Math.max(pi, ci);
    if (hi < first || lo > last) return;
    const xp = tx(S, l.ts), xc = tx(S, l.child._s);
    if (Math.max(xp, xc) < -4 || Math.min(xp, xc) > S.plotW + 4) return;
    const yp = pi * S.RH - S.off + 13, yc = ci * S.RH - S.off + BAR_Y;
    ctx.beginPath();
    ctx.moveTo(xp, yp);
    ctx.lineTo(xp, ci > pi ? yc : yc + BAR_H);
    if (Math.abs(xc - xp) > .5) ctx.lineTo(xc, ci > pi ? yc : yc + BAR_H);
    ctx.stroke();
    ctx.fillStyle = cssVar('--link');
    ctx.fillRect(xp - 1.5, yp - 1.5, 3, 3);
  });
}

/* ---- hit testing */
function hitTest(S, px, py) {
  const i = Math.floor((py + S.off) / S.RH);
  if (i < 0 || i >= S.rows.length) return null;
  const r = S.rows[i], t = xt(S, px), pxMs = (S.v1 - S.v0) / S.plotW;
  let best = null, bd = 7;
  const ts0 = xt(S, px - 9), ts1 = xt(S, px + 9);
  for (let j = lowerBound(r.row.marks, ts0); j < r.row.marks.length; j++) {
    const m = r.row.marks[j];
    if (m.ts > ts1) break;
    if (!S.kinds[m.kind]) continue;
    const d = Math.abs(tx(S, m.ts) - px);
    if (d < bd) { bd = d; best = m; }
  }
  if (best) return {kind: 'mark', row: r, mark: best};
  const segs = S.mode === 'model' ? r.row.long : r.row.segs;
  const slack = pxMs * 2;
  let hit = null;
  for (let j = lowerBoundSeg(segs, t - (segs.maxDur || 0) - slack); j < segs.length; j++) {
    const s = segs[j];
    if (s.a > t + slack) break;
    if (S.hideCol && S.hideCol[segCol(s, S.mode !== 'model')]) continue;
    if (t >= s.a - slack && t <= s.b + slack) hit = s;
  }
  if (hit) return {kind: 'seg', row: r, seg: hit, t};
  if (!(S.hide && S.hide.bg)) for (const b of r.row.bg) if (t >= b.a && t <= b.b && (S.mode === 'act' || b.b - b.a >= 60000) && py + S.off - i * S.RH > 16) return {kind: 'bg', row: r, seg: b, t};
  const a = r.a;
  if (t >= a._s - pxMs * 2 && t <= Math.max(a._e, a._s + 500) + pxMs * 2) return {kind: 'bar', row: r, t};
  return null;
}
function lowerBoundSeg(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].a < t) lo = m + 1; else hi = m; }
  return lo;
}
