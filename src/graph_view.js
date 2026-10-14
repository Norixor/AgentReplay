'use strict';
/* Flow graph, part 4: the canvas. A viewport with a dot-grid background holds one "world" element that is panned and
 * zoomed with a CSS transform; nodes are HTML divs and links live in an SVG layer inside the same element.
 * Layout changes tween over 300 ms. The rAF loop only runs while something moves (tweens, link draw-in, flow dots);
 * everything that loops forever (glow, dashes) is CSS and is paused while the page is hidden. */

const GR_MINK = 0.3, GR_MAXK = 2, GR_TWEEN = 300, GR_DRAW = 500, GR_POS_KEY = 'agent-replay.graph.pos.';
const GR_VP_MIN = 520, GR_VP_GAP = 14;   // canvas minimum height / space left below it
const GR = {
  host: null, key: '', d: null, skew: 0, active: false, primed: false, hidden: false, ready: false,
  nodes: new Map(), edges: new Map(), retired: new Set(), mem: {}, names: {},
  k: 1, vx: 24, vy: 24, auto: true, vt: null, vpH: 0, sized: false,
  sel: null, pos: {}, raf: 0, timer: 0, ptrs: new Map(), drag: null, pinch: null, lastTap: null,
  stats: {frames: 0, last: 0, max: 0, sum: 0, samples: []}
};
const grMQ = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const grReduced = () => !!(grMQ && grMQ.matches);

/* ---------------------------------------------------------------- storage (all access guarded)

   Layout positions the user dragged, per session. */
function grLoadPos() {
  try {
    const v = JSON.parse(localStorage.getItem(GR_POS_KEY + GR.key) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch (e) { return {}; }
}
function grSavePos() {
  try {
    const ks = Object.keys(GR.pos);
    ks.slice(0, Math.max(0, ks.length - 120)).forEach(k => { delete GR.pos[k]; });
    localStorage.setItem(GR_POS_KEY + GR.key, JSON.stringify(GR.pos));
  } catch (e) { /* storage blocked: positions just stay for this page view */ }
}

/* ---------------------------------------------------------------- lifecycle */
function grInit(host, key) {
  if (GR.key !== key) { GR.retired = new Set(); GR.mem = {}; }
  Object.assign(GR, {host, key, d: null, primed: false, hidden: document.hidden, nodes: new Map(), edges: new Map(), sel: null, auto: true, vt: null,
                     k: 1, vx: 24, vy: 24, raf: 0, ptrs: new Map(), drag: null, pinch: null, ready: true});
  GRFX.dots = [];
  GR.pos = grLoadPos();
  host.className = 'gr' + (document.hidden ? ' gr-hidden' : '');
  host.innerHTML = '<div class="gr-bar"><span class="gr-hint dim">拖动空白处或两指滑动平移 · 捏合或 ⌘/Ctrl+滚轮缩放 · 拖动节点调整位置 · 点击节点看最近几步 · 双击节点看概要</span><span class="grow"></span>' +
    '<span class="gr-count num dim" id="gr-count"></span><span class="gr-zoom num dim" id="gr-zoom">100%</span>' +
    '<button type="button" id="gr-fit" title="缩放并居中，显示全部节点；之后有新节点时自动跟随，直到你手动平移或缩放">适配画面</button>' +
    '<button type="button" id="gr-reset" title="视图回到 100%，并清除手动摆放的节点位置">重置</button></div>' +
    '<div class="gr-vp" tabindex="0" role="application" aria-label="子代理流程图。方向键平移，加号减号缩放，0 重置，F 适配画面">' +
    '<div class="gr-world"><svg class="gr-edges" width="1" height="1" aria-hidden="true"></svg><div class="gr-labels"></div></div><div class="gr-empty dim" hidden>还没有可画的代理。</div>' +
    '<div class="gr-overlay gr-stat" id="gr-stat"></div><canvas class="gr-overlay gr-map" id="gr-map" width="190" height="130" aria-label="小地图：点击或拖动跳转"></canvas><div class="gr-tip" hidden></div></div>' +
    '<div class="gr-detail" id="gr-detail" aria-live="polite"></div>';
  GR.vp = host.querySelector('.gr-vp');
  GR.vpH = 0;
  GR.world = host.querySelector('.gr-world');
  GR.svg = host.querySelector('.gr-edges');
  GR.detail = host.querySelector('#gr-detail');
  GR.empty = host.querySelector('.gr-empty');
  GR.labels = host.querySelector('.gr-labels');
  GR.tip = host.querySelector('.gr-tip');
  GR.map = host.querySelector('#gr-map');
  GR.mm = null; GR.mmFrozen = null;
  host.querySelector('#gr-fit').onclick = () => { GR.auto = true; grFit(true); };
  host.querySelector('#gr-reset').onclick = () => { GR.pos = {}; grSavePos(); GR.auto = false; grResetView(); grRelayout(false); };
  grBindInput();
  grBindMap();
  grBindTip();
  /* the grid's column count follows the viewport shape, so a resize re-lays out (debounced) before fitting */
  GR.onResize = () => {
    clearTimeout(GR.rsz);
    GR.rsz = setTimeout(() => { if (!GR.active) return; grSizeViewport(); GR.sized = false; grRelayout(false); if (GR.auto) grFit(false); }, 120);
  };
  window.addEventListener('resize', GR.onResize);
  GR.onVis = () => {
    GR.hidden = document.hidden;
    host.classList.toggle('gr-hidden', GR.hidden);
    if (GR.hidden) { cancelAnimationFrame(GR.raf); GR.raf = 0; GR.primed = false; }   // the next refresh re-primes silently
  };
  document.addEventListener('visibilitychange', GR.onVis);
  clearInterval(GR.timer);
  GR.timer = setInterval(() => {
    if (!GR.active || GR.hidden || !GR.primed) return;
    grRelayout(false);
    if (GR.sized) { GR.sized = false; if (GR.auto) grFit(false); }
  }, 1000);
  grApplyView();
}

function grDestroy() {
  clearInterval(GR.timer);
  clearTimeout(GR.rsz);
  cancelAnimationFrame(GR.raf);
  GR.raf = 0;
  if (GR.onVis) document.removeEventListener('visibilitychange', GR.onVis);
  if (GR.onResize) window.removeEventListener('resize', GR.onResize);
  GR.onVis = GR.onResize = null;
  GR.ready = GR.active = false;
  GR.host = null;
}

/* Graph shown (true) or card view shown (false). Leaving the graph drops its DOM so nothing animates in the background. */
function grSetActive(on) {
  if (!GR.ready) return;
  GR.active = on;
  GR.host.hidden = !on;
  GR.primed = false;
  if (!on) {
    cancelAnimationFrame(GR.raf);
    GR.raf = 0;
    GR.nodes.forEach(o => o.el.remove());
    GR.edges.forEach(e => e.g.remove());
    GR.nodes.clear();
    GR.edges.clear();
    GR.svg.querySelectorAll('.gr-dot').forEach(x => x.remove());
    GRFX.dots = [];
  } else {
    GR.auto = true;
    if (GR.d) grRelayout(true);
  }
}

/* Called after every data refresh (paintLive). */
function grUpdate(d) {
  if (!GR.ready) return;
  const play = GR.active && !GR.hidden && GR.primed;
  const fresh = grFxFresh(d);          // always marks the events as seen, so switching views never replays history
  GR.d = d;
  GR.skew = d.now - (LV.fetchedAt || Date.now());
  (d.cards || []).concat(d.returned || []).forEach(c => { GR.names[c.id] = c.desc; });
  if (!GR.active || GR.hidden) return;
  grRelayout(true);
  if (play) grFxRun(fresh);
  grDetail();
  if (GR.tipKey) { const h = grTipHtml(GR.tipKey); if (h) GR.tip.innerHTML = h; else grTipHide(); }
}

/* ---------------------------------------------------------------- reconcile nodes and links with the data */
function grRelayout(fromData) {
  const d = GR.d;
  if (!d || !GR.world) return;
  const cfg = d.cfg || {};
  const fadeMs = (cfg.graphFadeSec || 60) * 1000;
  const now = Date.now() + GR.skew;
  grSizeViewport();
  const vw = GR.vp ? GR.vp.clientWidth : 0, vh = GR.vp ? GR.vp.clientHeight : 0;
  const b = grBuild(d, {now, fadeMs, maxNodes: cfg.graphMaxNodes || 40, retired: GR.retired, mem: GR.mem, vw: vw || undefined, vh: vh || undefined});
  const anim = fromData && GR.primed && !grReduced();
  const tween = GR.primed && !grReduced();   // folds also happen on the 1 s timer: let those moves glide too
  let movedAny = false;
  const t = performance.now();
  const age = LV.fetchedAt ? Date.now() - LV.fetchedAt : 0;
  const live = new Set();
  const returned = [];
  b.nodes.forEach(n => {
    live.add(n.id);
    const tgt = GR.pos[n.id] ? {x: GR.pos[n.id][0], y: GR.pos[n.id][1]} : {x: n.x, y: n.y};
    let o = GR.nodes.get(n.id);
    if (!o) {
      const el = grNodeEl(n);
      el.style.transform = 'translate(' + tgt.x + 'px,' + tgt.y + 'px)';
      GR.world.appendChild(el);
      o = {el, n, x: tgt.x, y: tgt.y, fx: tgt.x, fy: tgt.y, tx: tgt.x, ty: tgt.y, t0: null, wasDone: n.card ? !!n.card.done : false};
      GR.nodes.set(n.id, o);
      if (anim && n.kind === 'agent') grFxPop(o);
    } else if (o.tx !== tgt.x || o.ty !== tgt.y) {
      o.fx = o.x; o.fy = o.y; o.tx = tgt.x; o.ty = tgt.y;
      movedAny = true;
      o.t0 = tween ? t : null;
      if (!tween) { o.x = o.tx; o.y = o.ty; o.el.style.transform = 'translate(' + o.x + 'px,' + o.y + 'px)'; }
    }
    o.n = n;
    if (fromData || n.kind === 'sum' || n.id === 'main' || (o.el._sig && !o.el._sig.state)) grUpdateNode(o.el, n, age);
    if (n.card) {
      const ageDone = n.card.done ? Math.max(0, now - n.card.doneTs) : 0;
      o.el.style.setProperty('--fade', n.card.done ? grClamp(1 - 0.72 * ageDone / fadeMs, 0.28, 1).toFixed(2) : '1');
      if (fromData && anim && n.card.done && !o.wasDone) returned.push(o);
      if (fromData) o.wasDone = !!n.card.done;
    }
    o.el.classList.toggle('sel', GR.sel === n.id);
  });
  GR.nodes.forEach((o, id) => {
    if (live.has(id)) return;
    GR.nodes.delete(id);
    o.el.classList.add('leaving');
    setTimeout(() => o.el.remove(), 450);
  });
  /* links */
  const eids = new Set();
  b.edges.forEach(e => {
    eids.add(e.id);
    let o = GR.edges.get(e.id);
    if (!o) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'gr-edge');
      g.innerHTML = '<path class="gr-line"></path><path class="gr-flow"></path>';
      GR.svg.insertBefore(g, GR.svg.firstChild);
      const label = document.createElement('div');
      label.className = 'gr-elabel';
      label.dataset.edge = e.id;
      GR.labels.appendChild(label);
      o = {g, line: g.firstChild, flow: g.lastChild, label, from: e.from, to: e.to, born: anim ? t : null, curve: null, id: e.id, dirty: true};
      GR.edges.set(e.id, o);
    }
    const child = GR.nodes.get(e.to);
    const st = child && child.n.card ? child.n.card.state : 'sum';
    o.g.setAttribute('class', 'gr-edge st-' + st + (e.to === GR_SUM ? ' to-sum' : ''));
    const cc = child && child.n.card;
    /* a link into a later grid column runs behind the cards to its left; its midpoint label would sit under them */
    o.label.hidden = !cc || !!(child && child.n.gc);
    if (cc) {
      const txt = fmtClock(cc.start || 0) + ' · ' + clip(cc.desc, 16);
      if (o.label._t !== txt) { o.label._t = txt; o.label.textContent = txt; }
    }
    if (child) {
      o.label.style.opacity = child.el.style.getPropertyValue('--fade') || '1';
      o.g.style.setProperty('--gc', child.el.style.getPropertyValue('--gc') || 'var(--chip-slate)');
      o.g.style.opacity = child.el.style.getPropertyValue('--fade') || '1';
    }
    o.dirty = true;
  });
  GR.edges.forEach((o, id) => { if (!eids.has(id)) { GR.edges.delete(id); o.g.remove(); o.label.remove(); } });
  const sumNode = GR.nodes.get(GR_SUM);
  GR.host.querySelector('#gr-count').textContent = b.nodes.length + ' 个节点' + (sumNode ? '（含汇总）' : '');
  GR.host.dataset.nodes = String(b.nodes.length);
  GR.host.dataset.edges = String(b.edges.length);
  GR.empty.hidden = b.nodes.length > 0;
  if (fromData) grStat();
  if (GR.sel && !live.has(GR.sel)) { GR.sel = null; grDetail(); }
  if (fromData) returned.forEach(o => grFxReturn(o));
  if (fromData) GR.primed = true;
  if (GR.auto && (fromData || movedAny || live.size !== GR.lastLive)) grFit(fromData ? anim : tween);
  GR.lastLive = live.size;
  grMiniDraw();
  grKick();
}

/* ---------------------------------------------------------------- frame loop */
function grKick() {
  if (!GR.raf && GR.active && !GR.hidden && GR.ready) GR.raf = requestAnimationFrame(grFrame);
}

function grFrame() {
  GR.raf = 0;
  if (!GR.active || GR.hidden || !GR.ready) return;
  const t0 = performance.now();
  const red = grReduced();
  let busy = false;
  const moved = new Set();
  GR.nodes.forEach(o => {
    if (o.t0 != null) {
      const p = red ? 1 : (t0 - o.t0) / GR_TWEEN;
      if (p >= 1) { o.x = o.tx; o.y = o.ty; o.t0 = null; }
      else { const e = grEase(Math.max(0, p)); o.x = o.fx + (o.tx - o.fx) * e; o.y = o.fy + (o.ty - o.fy) * e; busy = true; }
      o.el.style.transform = 'translate(' + o.x.toFixed(1) + 'px,' + o.y.toFixed(1) + 'px)';
      moved.add(o.n.id);
    } else if (o.dragged) {
      o.dragged = false;
      o.el.style.transform = 'translate(' + o.x.toFixed(1) + 'px,' + o.y.toFixed(1) + 'px)';
      moved.add(o.n.id);
    }
  });
  GR.edges.forEach(e => {
    const drawing = e.born != null;
    if (!(e.dirty || drawing || moved.has(e.from) || moved.has(e.to))) return;
    e.dirty = false;
    const a = GR.nodes.get(e.from), b = GR.nodes.get(e.to);
    if (!a || !b) return;
    /* into a later grid column the link bends late with a short end tangent, so it reaches the input slot at an angle
       out of the column gap instead of running level from the neighbour's output slot (which would read as a chain) */
    e.curve = grCurve(a.x + a.n.w, a.y + GR_SLOT_Y, b.x, b.y + GR_SLOT_Y, b.n.gc ? GR_CX * 0.6 : null);
    e.line.setAttribute('d', e.curve.d);
    e.flow.setAttribute('d', e.curve.d);
    const mid = grPoint(e.curve, 0.5);
    e.label.style.transform = 'translate(' + mid[0].toFixed(1) + 'px,' + mid[1].toFixed(1) + 'px) translate(-50%,-50%)';
    if (drawing) {
      const p = red ? 1 : grEase((t0 - e.born) / GR_DRAW);
      if (p >= 1) { e.born = null; e.line.style.strokeDasharray = ''; e.g.classList.remove('drawing'); }
      else {
        const L = e.line.getTotalLength();
        e.line.style.strokeDasharray = (L * Math.max(0, p)).toFixed(1) + ' ' + L.toFixed(1);
        e.g.classList.add('drawing');
        busy = true;
      }
    }
  });
  if (GR.vt) {
    const v = GR.vt, p = red ? 1 : (t0 - v.t0) / GR_TWEEN, e = grEase(grClamp(p, 0, 1));
    GR.k = v.k0 + (v.k1 - v.k0) * e; GR.vx = v.x0 + (v.x1 - v.x0) * e; GR.vy = v.y0 + (v.y1 - v.y0) * e;
    grApplyView();
    if (p >= 1) GR.vt = null; else busy = true;
  }
  if (moved.size) grMiniDraw();
  if (grFxStep(t0)) busy = true;
  const dt = performance.now() - t0, s = GR.stats;
  s.frames++; s.last = dt; s.sum += dt; if (dt > s.max) s.max = dt;
  s.samples.push(dt); if (s.samples.length > 600) s.samples.shift();
  if (busy) GR.raf = requestAnimationFrame(grFrame);
}

/* ---------------------------------------------------------------- view */
/* The CSS height is only a fallback: the status bar, hint line and toolbar above the canvas are taller than the fixed offset
 * it subtracts, so the canvas bottom used to fall below the window. Measure where the canvas starts (page scroll excluded) and
 * end it just above the window's bottom edge, never shorter than GR_VP_MIN. GR.sized tells the caller to re-fit. */
function grSizeViewport() {
  const vp = GR.vp;
  if (!vp || !vp.offsetParent) return;
  const top = vp.getBoundingClientRect().top + (window.scrollY || 0);
  const h = Math.max(GR_VP_MIN, Math.round(window.innerHeight - top - GR_VP_GAP));
  if (h === GR.vpH) return;
  GR.vpH = h;
  vp.style.height = h + 'px';
  GR.sized = true;
}

function grApplyView() {
  if (!GR.world) return;
  GR.world.style.transform = 'translate(' + GR.vx.toFixed(1) + 'px,' + GR.vy.toFixed(1) + 'px) scale(' + GR.k.toFixed(4) + ')';
  const s = GR.vp.style;
  s.setProperty('--gx', GR.vx.toFixed(1) + 'px');
  s.setProperty('--gy', GR.vy.toFixed(1) + 'px');
  s.setProperty('--gs', ((GR.k < 0.6 ? 48 : 24) * GR.k).toFixed(2) + 'px');
  s.setProperty('--gm', ((GR.k < 0.6 ? 240 : 120) * GR.k).toFixed(2) + 'px');
  s.setProperty('--gk', GR.k.toFixed(3));
  const z = GR.host.querySelector('#gr-zoom');
  if (z) z.textContent = Math.round(GR.k * 100) + '%';
  grMiniDraw();
}

function grBounds() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  GR.nodes.forEach(o => {
    x0 = Math.min(x0, o.tx); y0 = Math.min(y0, o.ty); x1 = Math.max(x1, o.tx + o.n.w); y1 = Math.max(y1, o.ty + o.n.h);
  });
  return x0 > x1 ? null : {x0, y0, x1, y1};
}

function grGoto(k, x, y, animate) {
  if (animate && !grReduced()) { GR.vt = {t0: performance.now(), k0: GR.k, x0: GR.vx, y0: GR.vy, k1: k, x1: x, y1: y}; }
  else { GR.vt = null; GR.k = k; GR.vx = x; GR.vy = y; grApplyView(); }
  grKick();
}

function grFit(animate) {
  grSizeViewport();
  const b = grBounds();
  if (!b || !GR.vp) return;
  const vw = GR.vp.clientWidth, vh = GR.vp.clientHeight, pad = GR_FIT_PAD, padT = GR_FIT_PADT;   // padT keeps the status overlay off the top row
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const k = grClamp(Math.min((vw - 2 * pad) / bw, (vh - pad - padT) / bh), GR_MINK, GR_FIT_MAX);
  /* when even the smallest zoom cannot show everything, start from the top-left so the main agent stays in view */
  const x = bw * k > vw - 2 * pad ? pad - b.x0 * k : (vw - bw * k) / 2 - b.x0 * k;
  const y = bh * k > vh - pad - padT ? padT - b.y0 * k : padT + (vh - pad - padT - bh * k) / 2 - b.y0 * k;
  grGoto(k, x, y, animate);
}

function grResetView() {
  const b = grBounds();
  grGoto(1, 24 - (b ? b.x0 : 0), 24 - (b ? b.y0 : 0), true);
}

function grZoomAt(cx, cy, nk) {
  nk = grClamp(nk, GR_MINK, GR_MAXK);
  const wx = (cx - GR.vx) / GR.k, wy = (cy - GR.vy) / GR.k;
  GR.vt = null;
  GR.k = nk; GR.vx = cx - wx * nk; GR.vy = cy - wy * nk;
  GR.auto = false;
  grApplyView();
}

/* ---------------------------------------------------------------- input */
function grBindInput() {
  const vp = GR.vp;
  vp.addEventListener('wheel', e => {
    const unit = e.deltaMode === 1 ? 16 : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel on macOS; ⌘/Ctrl+wheel zooms with a mouse.
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      grZoomAt(e.clientX - r.left, e.clientY - r.top, GR.k * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)));
      return;
    }
    // Plain wheel / two-finger swipe pans (shift turns vertical into horizontal), so scrolling never zooms by accident.
    e.preventDefault();
    GR.vt = null;
    if (e.shiftKey && !dx) GR.vx -= dy; else { GR.vx -= dx; GR.vy -= dy; }
    GR.auto = false;
    grApplyView();
  }, {passive: false});
  vp.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.gr-overlay')) return;
    GR.ptrs.set(e.pointerId, {x: e.clientX, y: e.clientY});
    try { vp.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    if (GR.ptrs.size === 2) {
      const [a, b] = Array.from(GR.ptrs.values());
      GR.pinch = {d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, k0: GR.k};
      GR.drag = null;
      return;
    }
    const el = e.target.closest('.gr-node');
    const o = el ? GR.nodes.get(el.dataset.id) : null;
    GR.drag = {id: o ? el.dataset.id : null, o, sx: e.clientX, sy: e.clientY, vx0: GR.vx, vy0: GR.vy, ox: o ? o.x : 0, oy: o ? o.y : 0, moved: false};
  });
  vp.addEventListener('pointermove', e => {
    if (!GR.ptrs.has(e.pointerId)) return;
    GR.ptrs.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (GR.pinch && GR.ptrs.size >= 2) {
      const [a, b] = Array.from(GR.ptrs.values()), r = vp.getBoundingClientRect();
      grZoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, GR.pinch.k0 * Math.hypot(a.x - b.x, a.y - b.y) / GR.pinch.d0);
      return;
    }
    const g = GR.drag;
    if (!g) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    GR.auto = false;
    if (g.o) {
      const o = g.o;
      o.x = o.tx = g.ox + dx / GR.k;
      o.y = o.ty = g.oy + dy / GR.k;
      o.t0 = null;
      o.dragged = true;
      GR.pos[g.id] = [Math.round(o.x), Math.round(o.y)];
      grKick();
    } else {
      vp.classList.add('panning');
      GR.vt = null;
      GR.vx = g.vx0 + dx; GR.vy = g.vy0 + dy;
      grApplyView();
    }
  });
  const end = e => {
    GR.ptrs.delete(e.pointerId);
    if (GR.ptrs.size < 2) GR.pinch = null;
    const g = GR.drag;
    if (!g || e.type === 'pointercancel') { GR.drag = null; vp.classList.remove('panning'); return; }
    GR.drag = null;
    vp.classList.remove('panning');
    if (g.moved) { if (g.o) grSavePos(); return; }
    /* a tap: select; a second tap on the same node within 350 ms opens it in the replay */
    const tn = Date.now();
    if (g.id && GR.lastTap && GR.lastTap.id === g.id && tn - GR.lastTap.t < 350) { GR.lastTap = null; grOpen(g.id); return; }
    GR.lastTap = g.id ? {id: g.id, t: tn} : null;
    grSelect(g.id && GR.sel !== g.id ? g.id : null);
  };
  vp.addEventListener('pointerup', end);
  vp.addEventListener('pointercancel', end);
  vp.addEventListener('keydown', e => {
    const nodeEl = e.target.closest && e.target.closest('.gr-node');
    if (nodeEl && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (e.shiftKey) grOpen(nodeEl.dataset.id); else grSelect(GR.sel === nodeEl.dataset.id ? null : nodeEl.dataset.id);
      return;
    }
    const r = vp.getBoundingClientRect(), cx = r.width / 2, cy = r.height / 2;
    let used = true;
    if (e.key === '+' || e.key === '=') grZoomAt(cx, cy, GR.k * 1.2);
    else if (e.key === '-') grZoomAt(cx, cy, GR.k / 1.2);
    else if (e.key === '0') { GR.pos = {}; grSavePos(); GR.auto = false; grResetView(); grRelayout(false); }
    else if (e.key === 'f' || e.key === 'F') { GR.auto = true; grFit(true); }
    else if (e.key.startsWith('Arrow') && e.target === vp) {
      GR.auto = false;
      GR.vx += e.key === 'ArrowLeft' ? 60 : e.key === 'ArrowRight' ? -60 : 0;
      GR.vy += e.key === 'ArrowUp' ? 60 : e.key === 'ArrowDown' ? -60 : 0;
      grApplyView();
    } else used = false;
    if (used) e.preventDefault();
  });
}

function grSelect(id) {
  GR.sel = id;
  GR.nodes.forEach((o, k) => o.el.classList.toggle('sel', k === id));
  grDetail();
}

/* Double click / Shift+Enter: the agent summary dialog (modal.js). A single click only selects the node and shows its card below. */
function grOpen(id) {
  const o = GR.nodes.get(id);
  if (!o || !o.n.card) return;
  liveOpen({type: 'agent', agent: id});   // an agent the page has never seen is fetched first (live_open.js)
}

/* Recent steps of the selected node, below the canvas: the same card the card view shows. */
function grDetail() {
  if (!GR.detail) return;
  const o = GR.sel && GR.nodes.get(GR.sel);
  if (!o) { GR.detail.innerHTML = ''; GR.detail.hidden = true; return; }
  GR.detail.hidden = false;
  let h;
  if (o.n.kind === 'sum') {
    const ids = Array.from(GR.retired);
    h = '<h3>已交回 ' + ids.length + ' 个子代理</h3><ul class="gr-sumlist">' + ids.map(i => '<li>' + (A[i] ? mdAgentRef(i, GR.names[i] || i) : esc(GR.names[i] || i)) + '</li>').join('') + '</ul>' +
      '<p class="note">交回后超过淡出时间的代理收在这里，实时接口只保留最近 ' + Math.round(((GR.d && GR.d.cfg && GR.d.cfg.returnedKeepSec) || 600) / 60) + ' 分钟内交回的。</p>';
  } else {
    h = '<div class="gr-dhead"><b>' + esc(o.n.id === 'main' ? '主代理' : o.n.card.desc) + ' 的最近几步</b><button type="button" id="gr-dclose">关闭</button></div>' + liveCard(o.n.card);
  }
  GR.detail.innerHTML = h;
  const cb = GR.detail.querySelector('#gr-dclose');
  if (cb) cb.onclick = () => grSelect(null);
}
