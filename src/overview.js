'use strict';
/* Overview curves above the timeline: running agents and consumption per time bucket, on the same (warped) time axis. */

function buildOverviewData(W) {
  timelineModel();
  const starts = D.agents.map(a => a._s).sort((x, y) => x - y), ends = D.agents.map(a => a._e).sort((x, y) => x - y);
  const pts = [];
  D.agents.forEach(a => a.turns.forEach(t => t.steps.forEach(s => pts.push([W.r2v((s.ts + s.end) / 2), s.cost || 0, tokSum(s.tok)]))));
  pts.sort((x, y) => x[0] - y[0]);
  const vs = new Float64Array(pts.length), cum = new Float64Array(pts.length + 1), cumTok = new Float64Array(pts.length + 1);
  pts.forEach((p, i) => { vs[i] = p[0]; cum[i + 1] = cum[i] + p[1]; cumTok[i + 1] = cumTok[i] + p[2]; });
  return {starts, ends, vs, cum, cumTok};
}
function ubound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }

/* Buckets over the visible virtual range (so zooming keeps the curves detailed). */
function overviewBuckets(S) {
  const O = S.ovData, n = Math.max(20, Math.min(360, Math.floor(S.plotW / 3))), bw = (S.v1 - S.v0) / n;
  const conc = new Float32Array(n), cost = new Float32Array(n), tok = new Float64Array(n), gap = new Uint8Array(n);
  const P = S.W.pieces;
  let pi = 0;
  for (let i = 0; i < n; i++) {
    const va = S.v0 + i * bw, vb = va + bw, vm = (va + vb) / 2;
    while (pi < P.length - 1 && P[pi].v1 <= vm) pi++;
    if (vm < 0 || vm > S.W.VT) { gap[i] = 2; continue; }
    if (P[pi].gap) { gap[i] = 1; continue; }
    conc[i] = ubound(O.starts, S.W.v2r(vb)) - ubound(O.ends, S.W.v2r(va));
    cost[i] = O.cum[ubound(O.vs, vb)] - O.cum[ubound(O.vs, va)];
    tok[i] = O.cumTok[ubound(O.vs, vb)] - O.cumTok[ubound(O.vs, va)];
  }
  return {n, bw, conc, cost, tok, gap, maxConc: Math.max(1, ...conc), maxCost: Math.max(1e-9, ...cost), realBw: S.W.v2r(S.v0 + bw) - S.W.v2r(S.v0)};
}

function paintOverview(S) {
  const W = S.plotW, H = S.ovH, ctx = setupCanvas(S.ovCv, W, H);
  paintGaps(ctx, S, H);
  const B = S.ovB = overviewBuckets(S);
  const pad = 14, base = H - 3, top = pad;
  const col = (i) => ((i * B.bw) / (S.v1 - S.v0)) * W;
  const bwpx = B.bw / (S.v1 - S.v0) * W;
  ctx.fillStyle = cssVar('--accent');
  ctx.globalAlpha = .28;
  for (let i = 0; i < B.n; i++) {
    if (B.gap[i] || !B.conc[i]) continue;
    const h = B.conc[i] / B.maxConc * (base - top);
    ctx.fillRect(col(i), base - h, Math.ceil(bwpx), h);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < B.n; i++) {
    if (B.gap[i]) { pen = false; continue; }
    const y = base - B.conc[i] / B.maxConc * (base - top), x0 = col(i), x1 = x0 + bwpx;
    if (!pen) { ctx.moveTo(x0, y); pen = true; } else ctx.lineTo(x0, y);
    ctx.lineTo(x1, y);
  }
  ctx.stroke();
  ctx.strokeStyle = cssVar('--opus');
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  pen = false;
  for (let i = 0; i < B.n; i++) {
    if (B.gap[i]) { pen = false; continue; }
    const y = base - B.cost[i] / B.maxCost * (base - top), x = col(i) + bwpx / 2;
    if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.font = '11px -apple-system, "PingFang SC", system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = cssVar('--accent');
  ctx.textAlign = 'left';
  ctx.fillText('在跑的代理 峰值 ' + B.maxConc, 4, 1);
  ctx.fillStyle = cssVar('--opus-ink');
  ctx.textAlign = 'right';
  ctx.fillText('每桶预估金额 峰值 ' + fmtMoney(B.maxCost) + '（桶宽约 ' + fmtDur(B.realBw) + '）', W - 4, 1);
  if (S.now) {
    const x = Math.round(tx(S, S.now)) + .5;
    if (x >= 0 && x <= W) { ctx.strokeStyle = cssVar('--bad'); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  }
  if (S.sel) {
    ctx.fillStyle = cssVar('--accent');
    ctx.globalAlpha = .18;
    const a = Math.min(S.sel[0], S.sel[1]), b = Math.max(S.sel[0], S.sel[1]);
    ctx.fillRect(a, 0, b - a, H);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = cssVar('--accent');
    ctx.strokeRect(a + .5, .5, b - a, H - 1);
  }
}

function ovTip(S, px) {
  const B = S.ovB;
  if (!B) return '';
  const i = Math.min(B.n - 1, Math.max(0, Math.floor(px / S.plotW * B.n)));
  if (B.gap[i]) return '<b>空闲</b>';
  const ra = S.W.v2r(S.v0 + i * B.bw), rb = S.W.v2r(S.v0 + (i + 1) * B.bw);
  return '<b>' + fmtTS(ra) + ' – ' + fmtClock(rb) + '</b><br>同时在跑 ' + B.conc[i] + ' 个代理<br>预估金额 ' + moneyH(B.cost[i]) + ' · ' + fmtTok(B.tok[i]) + ' token';
}
