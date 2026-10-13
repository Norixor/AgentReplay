'use strict';
/* Fork-route map, part 4: navigation. Pan (drag, wheel, keys), zoom (wheel / pinch / keys), mini-map.
 * V is the view state owned by route_view.js: {ppm (zoom, pixels per minute), vx, vy (screen offset of the world origin),
 * ax (time axis), vp (plot element), W, H (world size)}. Screen x = world x + vx; zooming changes the time scale (ppm),
 * so the world is re-laid-out instead of scaled; the point under the cursor keeps its time.
 * hooks: {zoomed() layout must be redone, change() redraw, moved() the reader moved the view by hand, click(nodeEl), fit(), anchorX() -> screen x or null}. */

const RN = {DRAG_PX: 5, MM_W: 168, MM_H: 92, MARGIN: 80};

/* Zoom to ppm2 keeping the time at screen x `sx` where it is. */
RN.zoomAt = function (V, ppm2, sx) {
  const ppm = RL.clampPpm(V.ax, ppm2, V.vp.clientWidth);
  if (Math.abs(ppm - V.ppm) < 1e-9) return false;
  const t = RL.x2t(V.ax, sx - V.vx, V.ppm);
  V.ppm = ppm;
  V.vx = sx - RL.t2x(V.ax, t, ppm);
  return true;
};
/* Keep the world from being dragged completely out of sight. */
RN.limit = function (V) {
  const w = V.vp.clientWidth, h = V.vp.clientHeight;
  V.vx = Math.min(w - RN.MARGIN, Math.max(RN.MARGIN - V.W, V.vx));
  V.vy = Math.min(0, Math.max(Math.min(0, h - V.H), V.vy));
};

RN.bindInput = function (V, hooks) {
  const vp = V.vp, ptrs = new Map();
  let drag = null, pinch = null;
  const rectOf = () => vp.getBoundingClientRect();
  const zoom = (factor, sx) => {
    const a = hooks.anchorX && hooks.anchorX();
    if (RN.zoomAt(V, V.ppm * factor, a != null ? a : sx)) hooks.zoomed();
    RN.limit(V);
  };
  const down = e => {
    if (e.button != null && e.button > 0) return;
    if (e.target.closest('.rt-ovl, .rt-fold')) return;
    vp.setPointerCapture && vp.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (ptrs.size === 1) drag = {x: e.clientX, y: e.clientY, vx: V.vx, vy: V.vy, moved: false, node: e.target.closest('.rt-node, .rt-line')};
    else if (ptrs.size === 2) {
      const [a, b] = Array.from(ptrs.values());
      pinch = {d: Math.hypot(a.x - b.x, a.y - b.y) || 1, ppm: V.ppm};
      drag = null;
    }
  };
  const move = e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pinch && ptrs.size >= 2) {
      const [a, b] = Array.from(ptrs.values()), r = rectOf();
      const a0 = hooks.anchorX && hooks.anchorX();
      if (RN.zoomAt(V, pinch.ppm * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, a0 != null ? a0 : (a.x + b.x) / 2 - r.left)) hooks.zoomed();
      RN.limit(V);
      hooks.change();
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < RN.DRAG_PX) return;
    if (!drag.moved) { drag.moved = true; vp.classList.add('panning'); hooks.moved(); }
    V.vx = drag.vx + dx;
    V.vy = drag.vy + dy;
    RN.limit(V);
    hooks.change();
  };
  const up = e => {
    const had = ptrs.delete(e.pointerId);
    if (pinch && ptrs.size < 2) pinch = null;
    if (!had) return;
    if (drag && !drag.moved && e.type === 'pointerup' && drag.node) hooks.click(drag.node);
    if (ptrs.size === 0) { drag = null; vp.classList.remove('panning'); }
  };
  vp.addEventListener('pointerdown', down);
  vp.addEventListener('pointermove', move);
  vp.addEventListener('pointerup', up);
  vp.addEventListener('pointercancel', up);
  /* Plain wheel / two-finger swipe only pans. Zoom needs ctrlKey (trackpad pinch arrives as a ctrl+wheel event, as does
   * Ctrl+wheel) or metaKey. A purely vertical wheel over a canvas that already shows every lane is left to the page. */
  vp.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = rectOf();
      zoom(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left);
      hooks.change();
      return;
    }
    const horizontal = e.shiftKey ? (e.deltaX || e.deltaY) : e.deltaX;
    const vertical = e.shiftKey ? 0 : e.deltaY;
    if (!horizontal && V.H <= vp.clientHeight + 1) return;   // nothing to scroll vertically: let the page scroll
    e.preventDefault();
    V.vx -= horizontal;
    V.vy -= vertical;
    RN.limit(V);
    if (horizontal) hooks.moved();
    hooks.change();
  }, {passive: false});
  vp.addEventListener('keydown', e => {
    const w = vp.clientWidth, step = 80;
    let used = true;
    if (e.key === 'ArrowLeft') { V.vx += step; hooks.moved(); }
    else if (e.key === 'ArrowRight') { V.vx -= step; hooks.moved(); }
    else if (e.key === 'ArrowUp') V.vy += step;
    else if (e.key === 'ArrowDown') V.vy -= step;
    else if (e.key === '+' || e.key === '=') zoom(1.25, w / 2);
    else if (e.key === '-' || e.key === '_') zoom(1 / 1.25, w / 2);
    else if (e.key === '0' || e.key === 'f' || e.key === 'F') { hooks.fit(); return; }
    else used = false;
    if (!used) return;
    e.preventDefault();
    RN.limit(V);
    hooks.change();
  });
};

/* ---- mini-map: lanes as rows on an off-screen bitmap, plus the current view rectangle on top. */
RN.mmScale = V => ({sx: (RN.MM_W - 8) / Math.max(1, V.W), sy: (RN.MM_H - 8) / Math.max(1, V.H), ox: 4, oy: 4});
RN.mmRebuild = function (V, model, colorOf) {
  const cv = document.createElement('canvas');
  cv.width = RN.MM_W; cv.height = RN.MM_H;
  const g = cv.getContext('2d'), m = RN.mmScale(V);
  model.lanes.forEach(L => {
    if (!L.vis) return;
    g.fillStyle = colorOf('--rt-active');
    g.fillRect(m.ox + L.x0 * m.sx, m.oy + L.y * m.sy, Math.max(1, (L.x1 - L.x0) * m.sx), Math.max(1, (L.h - 2) * m.sy));
    const hh = Math.max(1, (L.collapsed ? 6 : RL.NODE_H) * m.sy);
    L.els.forEach(nd => {
      g.fillStyle = colorOf(RL.colorVar(nd));
      g.fillRect(m.ox + nd.lx * m.sx, m.oy + (L.collapsed ? L.y + 10 : nd.y) * m.sy, Math.max(1.2, nd.dw * m.sx), L.collapsed ? hh : Math.max(1, nd.h * m.sy));
    });
  });
  V.mmBitmap = cv;
};
RN.mmDraw = function (V, canvas, colorOf) {
  const g = canvas.getContext('2d'), m = RN.mmScale(V);
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (V.mmBitmap) g.drawImage(V.mmBitmap, 0, 0);
  const w = V.vp.clientWidth, h = V.vp.clientHeight;
  const x = m.ox + (-V.vx) * m.sx, y = m.oy + (-V.vy) * m.sy, rw = w * m.sx, rh = h * m.sy;
  g.lineWidth = 1.5;
  g.strokeStyle = colorOf('--accent');
  g.fillStyle = colorOf('--rt-view');
  g.fillRect(x, y, rw, rh);
  g.strokeRect(x, y, rw, rh);
};
RN.bindMap = function (V, canvas, hooks) {
  let on = false;
  const go = e => {
    const r = canvas.getBoundingClientRect(), m = RN.mmScale(V);
    const wx = ((e.clientX - r.left) * (canvas.width / r.width) - m.ox) / m.sx, wy = ((e.clientY - r.top) * (canvas.height / r.height) - m.oy) / m.sy;
    V.vx = V.vp.clientWidth / 2 - wx;
    V.vy = V.vp.clientHeight / 2 - wy;
    RN.limit(V);
    hooks.moved(); hooks.change();
  };
  canvas.addEventListener('pointerdown', e => { on = true; canvas.setPointerCapture(e.pointerId); go(e); e.stopPropagation(); });
  canvas.addEventListener('pointermove', e => { if (on) go(e); });
  canvas.addEventListener('pointerup', () => { on = false; });
  canvas.addEventListener('pointercancel', () => { on = false; });
};
