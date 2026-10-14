'use strict';
/* Flow graph, part 5: the overlays on the canvas. A status summary (top left), a mini-map with the current viewport
 * (bottom right, click or drag to jump) and hover tooltips for nodes and link labels. */

const GR_MAPW = 190, GR_MAPH = 130;

/* ---------------------------------------------------------------- status summary */
function grStat() {
  const el = GR.host && GR.host.querySelector('#gr-stat'), d = GR.d;
  if (!el || !d) return;
  const n = {exec: 0, think: 0, waiting: 0, idle: 0};
  (d.cards || []).forEach(c => { if (c.state in n) n[c.state]++; });
  const back = new Set((d.returned || []).map(x => x.id));
  GR.retired.forEach(i => back.add(i));
  const rate = Math.round((d.tok15 || 0) / 15), perHour = (d.rate && d.rate.perHour15) || 0;
  const key = [n.exec, n.think, n.waiting, n.idle, back.size, rate, Math.round(perHour * 100)].join('|');
  if (el._k === key) return;
  el._k = key;
  el.innerHTML = '<span class="lst ls-exec">执行中 <b>' + n.exec + '</b></span><span class="lst ls-think">思考中 <b>' + n.think + '</b></span>' +
    '<span class="lst ls-waiting">等子代理 <b>' + n.waiting + '</b></span><span class="lst ls-idle">空闲 <b>' + n.idle + '</b></span><span class="lst gr-sdone">已交回 <b>' + back.size + '</b></span>' +
    (noUsage() ? '' : '<span class="gr-rate" title="近 15 分钟的 token 用量（含缓存读取）除以 15；金额按最近 15 分钟 ×4 折合每小时，按官方标价估算">近 15 分钟 <b class="num">' + fmtTok(rate) + '</b> token/分钟 · <b class="num">' + moneyH(perHour) + '</b>/小时</span>');
}

/* ---------------------------------------------------------------- mini-map */
function grMiniGeom() {
  if (GR.mmFrozen) return GR.mmFrozen;
  const vw = GR.vp.clientWidth, vh = GR.vp.clientHeight;
  let x0 = -GR.vx / GR.k, y0 = -GR.vy / GR.k, x1 = x0 + vw / GR.k, y1 = y0 + vh / GR.k;
  GR.nodes.forEach(o => { x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + o.n.w); y1 = Math.max(y1, o.y + o.n.h); });
  const pad = 30;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const sc = Math.min(GR_MAPW / (x1 - x0), GR_MAPH / (y1 - y0));
  return {x0, y0, sc, ox: (GR_MAPW - (x1 - x0) * sc) / 2, oy: (GR_MAPH - (y1 - y0) * sc) / 2};
}

function grMiniDraw() {
  const cv = GR.map;
  if (!cv || !GR.vp || !GR.active) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(GR_MAPW * dpr)) { cv.width = Math.round(GR_MAPW * dpr); cv.height = Math.round(GR_MAPH * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, GR_MAPW, GR_MAPH);
  const m = GR.mm = grMiniGeom();
  GR.nodes.forEach(o => {
    const c = o.n.card;
    g.globalAlpha = c && c.done ? 0.4 : 0.9;
    g.fillStyle = c ? resolveColor(chipColor(modelFam(c.model || '') || 'sonnet')) : cssVar('--dim');
    g.fillRect(m.ox + (o.x - m.x0) * m.sc, m.oy + (o.y - m.y0) * m.sc, Math.max(2, o.n.w * m.sc), Math.max(2, o.n.h * m.sc));
  });
  g.globalAlpha = 1;
  const vw = GR.vp.clientWidth, vh = GR.vp.clientHeight;
  g.lineWidth = 1.5;
  g.strokeStyle = cssVar('--accent');
  g.fillStyle = 'rgba(120,140,200,.12)';
  const rx = m.ox + (-GR.vx / GR.k - m.x0) * m.sc, ry = m.oy + (-GR.vy / GR.k - m.y0) * m.sc, rw = vw / GR.k * m.sc, rh = vh / GR.k * m.sc;
  g.fillRect(rx, ry, rw, rh);
  g.strokeRect(rx, ry, rw, rh);
}

function grBindMap() {
  const cv = GR.map;
  const jump = e => {
    const r = cv.getBoundingClientRect(), m = GR.mmFrozen || GR.mm;
    if (!m) return;
    const wx = ((e.clientX - r.left) * GR_MAPW / r.width - m.ox) / m.sc + m.x0, wy = ((e.clientY - r.top) * GR_MAPH / r.height - m.oy) / m.sc + m.y0;
    GR.auto = false;
    GR.vt = null;
    GR.vx = GR.vp.clientWidth / 2 - wx * GR.k;
    GR.vy = GR.vp.clientHeight / 2 - wy * GR.k;
    grApplyView();
  };
  cv.addEventListener('pointerdown', e => {
    e.stopPropagation();
    GR.mmFrozen = GR.mm;      // keep the map still while dragging, otherwise it rescales under the pointer
    GR.mmDrag = true;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    jump(e);
  });
  cv.addEventListener('pointermove', e => { if (GR.mmDrag) jump(e); });
  const end = () => { GR.mmDrag = false; GR.mmFrozen = null; grMiniDraw(); };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

/* ---------------------------------------------------------------- tooltips */
function grTipHide() { if (GR.tip) { GR.tip.hidden = true; GR.tipKey = null; } }

function grTipHtml(key) {
  const age = LV.fetchedAt ? Date.now() - LV.fetchedAt : 0;
  if (key.startsWith('e:')) {
    const e = GR.edges.get(key.slice(2)), ch = e && GR.nodes.get(e.to), c = ch && ch.n.card;
    if (!c) return '';
    const b = c.brief;
    return '<div class="gr-th"><b>派单 ' + fmtClock(c.start || 0) + '</b> · ' + esc(c.desc) + '</div>' +
      (b ? b.lines.map(l => '<div class="gr-tl">' + esc(l) + '</div>').join('') + (b.why ? '<div class="gr-tl gr-twhy">' + esc(b.why) + '</div>' : '') : '<div class="dim">没有记录简报</div>');
  }
  const o = GR.nodes.get(key);
  if (!o) return '';
  if (o.n.kind === 'sum') return '<div class="gr-th"><b>已交回 ' + GR.retired.size + ' 个</b></div>' + Array.from(GR.retired).slice(-12).map(i => '<div class="gr-tl">' + esc(GR.names[i] || i) + '</div>').join('');
  const c = o.n.card, d = c.detail || {};
  let h = '<div class="gr-th"><b>' + esc(c.id === 'main' ? '主代理' : c.desc) + '</b> · ' + esc(GR_STATE_TXT[c.state] || c.state) + '</div>';
  if (c.state === 'exec' || (c.state === 'waiting' && d.tool)) {
    const n = lbNowBrief(c);
    h += '<h5>当前调用 · 已执行 ' + fmtDur((d.elapsed || 0) + age) + '</h5><div class="gr-tl"><b>' + esc(n.kindLabel) + '</b> ' + esc(n.action) + '</div>' + (d.desc ? '<div class="gr-tl dim">原因：' + esc(d.desc) + '</div>' : '') +
      (d.inp || d.sum ? '<pre>' + esc(clip(d.inp || d.sum, 400)) + '</pre>' : '');
  } else if (d.why) h += '<div class="gr-tl dim">' + esc(d.why) + '</div>';
  else if (c.said) h += '<div class="gr-tl dim">最近说明：' + esc(lbSaid(c, 200)) + '</div>';
  const rec = c.recent || [];
  h += '<h5>最近 ' + rec.length + ' 步</h5>' + (rec.length ? '<ol class="gr-trec">' + rec.map(r => {
    const l = lbStepLine(r);
    return '<li class="rs-' + esc(r.st) + '"><time class="num">' + fmtClock(r.ts) + '</time> <b>' + esc(l[0]) + '</b> ' + esc(clip(l[1], 160)) + (l[2] ? ' <span class="bad">· ' + esc(clip(l[2], 100)) + '</span>' : '') +
      (r.why ? '<div class="dim">原因：' + esc(clip(r.why, 160)) + '</div>' : '') + '</li>';
  }).join('') + '</ol>' : '<div class="dim">还没有步骤</div>');
  return h;
}

function grBindTip() {
  const vp = GR.vp;
  vp.addEventListener('mousemove', e => {
    if ((GR.drag && GR.drag.moved) || GR.mmDrag) return grTipHide();
    const t = e.target.closest && e.target.closest('.gr-node, .gr-elabel');
    if (!t) return grTipHide();
    const key = t.dataset.edge ? 'e:' + t.dataset.edge : t.dataset.id;
    if (GR.tipKey !== key) {
      const h = grTipHtml(key);
      if (!h) return grTipHide();
      GR.tipKey = key;
      GR.tip.innerHTML = h;
      GR.tip.hidden = false;
    }
    const r = vp.getBoundingClientRect(), tw = GR.tip.offsetWidth, th = GR.tip.offsetHeight;
    let x = e.clientX - r.left + 16, y = e.clientY - r.top + 16;
    if (x + tw > r.width - 6) x = Math.max(6, e.clientX - r.left - tw - 16);
    if (y + th > r.height - 6) y = Math.max(6, r.height - th - 6);
    GR.tip.style.left = x + 'px';
    GR.tip.style.top = y + 'px';
  });
  vp.addEventListener('mouseleave', grTipHide);
  vp.addEventListener('wheel', grTipHide, {passive: true});
}
