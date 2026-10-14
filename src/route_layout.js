'use strict';
/* Fork-route map, part 2: layout. Pure functions (no DOM).
 *
 * Horizontal axis = real time. The same idle collapse as the timeline tab applies: a stretch in which no agent did
 * anything for more than GAP_MS becomes one fixed-width band (GAP_PX), the rest of the axis is linear:
 *   x(t) = activeMs(t) * ppm / 60000 + gapsBefore(t) * GAP_PX          (ppm = pixels per minute, the zoom)
 * Nodes sit at x(t0). Every box is NODE_H tall; short boxes may be drawn wider (dw) when the row has room, so their title stays
 * readable, without moving them. Instants (hand-back, merge, compaction, block, narrow dispatch / user message) are 16 px icon
 * markers. Crowded nodes of one lane become groups; folded strips become dotted lines (see packLane).
 * Vertical axis = lanes (one per agent), each with at most MAX_ROWS sub-rows.
 */

const RL = {GAP_PX: 72, RESERVE_W: 84, ROW_H: 44, NODE_H: 40, PAD_T: 14, PAD_B: 6, COLLAPSED_H: 26, MAX_ROWS: 2,
            REQ_BOX: 40, MARK_W: 16, MARK_BELOW: 48, GROUP_W: 160, TOL: 8, AXIS_H: 30, PAD_L: 24,
            MAX_PPM: 600, TICK_STEPS: [10e3, 30e3, 60e3, 300e3, 900e3, 3600e3, 10800e3, 21600e3, 43200e3, 86400e3], TICK_MIN_PX: 78, SEP: 3};

const rlGapMs = () => (typeof GAP_MS !== 'undefined' ? GAP_MS : 15 * 60 * 1000);   // shared with the timeline tab when it is loaded
const rlP2 = n => (n < 10 ? '0' : '') + n;

/* ------------------------------------------------------------------ time axis */
/* Pieces cover the whole axis without holes: {r0, r1 (real ms), gap, a0 (active ms before), g0 (gap bands before)}. */
RL.buildAxis = function (model, opts) {
  opts = opts || {};
  const now = opts.now || 0, gapMs = opts.collapse === false ? Infinity : rlGapMs();
  const iv = [];
  model.lanes.forEach(L => L.items.forEach(it => { if (it.ts > 0) iv.push([it.ts, Math.max(it.t1, it.bgDone || 0, it.ts)]); }));
  if (now) iv.push([now - 1, now]);
  if (!iv.length) iv.push([1, 1001]);
  iv.sort((x, y) => x[0] - y[0]);
  const spans = [];
  iv.forEach(x => {
    const last = spans[spans.length - 1];
    if (last && x[0] - last[1] <= gapMs) last[1] = Math.max(last[1], x[1]);
    else spans.push([x[0], x[1]]);
  });
  const pieces = [];
  let a = 0, g = 0;
  spans.forEach((s, i) => {
    if (i > 0) { pieces.push({r0: spans[i - 1][1], r1: s[0], gap: true, a0: a, g0: g}); g++; }
    const len = Math.max(1000, s[1] - s[0]);
    pieces.push({r0: s[0], r1: s[0] + len, gap: false, a0: a, g0: g});
    a += len;
  });
  const r0 = pieces[0].r0, r1 = pieces[pieces.length - 1].r1;
  const day = t => { const d = new Date(t); return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate(); };
  return {pieces, activeMs: a, gaps: g, r0, r1, multiDay: day(r0) !== day(r1), now};
};
RL.t2x = function (ax, t, ppm) {
  const k = ppm / 60000, P = ax.pieces;
  if (t <= P[0].r0) return (t - P[0].r0) * k;
  let lo = 0, hi = P.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (P[m].r0 <= t) lo = m; else hi = m - 1; }
  const p = P[lo];
  if (p.gap) return p.a0 * k + p.g0 * RL.GAP_PX + Math.min(1, (t - p.r0) / Math.max(1, p.r1 - p.r0)) * RL.GAP_PX;
  return (p.a0 + (t - p.r0)) * k + p.g0 * RL.GAP_PX;
};
RL.x2t = function (ax, x, ppm) {
  const k = ppm / 60000, P = ax.pieces, G = RL.GAP_PX;
  if (x <= 0) return P[0].r0 + x / k;
  const xs = p => p.a0 * k + p.g0 * G;
  let lo = 0, hi = P.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xs(P[m]) <= x) lo = m; else hi = m - 1; }
  const p = P[lo];
  if (p.gap) return p.r0 + Math.min(1, Math.max(0, (x - xs(p)) / G)) * (p.r1 - p.r0);
  return p.r0 + (x - xs(p)) / k;
};
/* Width of the whole axis at this zoom. */
RL.axisW = (ax, ppm) => ax.activeMs * ppm / 60000 + ax.gaps * RL.GAP_PX;
/* Zoom limits: the whole session as wide as half the canvas ... 1 minute = MAX_PPM px. */
RL.minPpm = (ax, canvasW) => Math.max(1e-4, (0.5 * canvasW - ax.gaps * RL.GAP_PX) / (Math.max(ax.activeMs, 1000) / 60000));
RL.clampPpm = (ax, ppm, canvasW) => Math.min(RL.MAX_PPM, Math.max(RL.minPpm(ax, canvasW), ppm));
/* Default zoom: the effective (idle-collapsed) duration exactly fills `w` pixels. */
RL.fitPpm = (ax, w, canvasW) => RL.clampPpm(ax, (w - ax.gaps * RL.GAP_PX) / (Math.max(ax.activeMs, 1000) / 60000), canvasW || w);

RL.fmtIdle = function (ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? m + ' 分钟' : m < 1440 ? (m / 60).toFixed(m % 60 ? 1 : 0) + ' 小时' : (m / 1440).toFixed(1) + ' 天';
};

/* Ticks inside the world range [xa, xb]: 10 s / 30 s / 1 / 5 / 15 min / 1 h (longer steps only when even 1 h is too dense).
 * Local time; a label carries the date at the first tick of a multi-day session and whenever the day changes. */
RL.ticks = function (ax, ppm, xa, xb) {
  const k = ppm / 60000;
  const step = RL.TICK_STEPS.find(s => s * k >= RL.TICK_MIN_PX) || RL.TICK_STEPS[RL.TICK_STEPS.length - 1];
  const out = [];
  let prevDay = '';
  ax.pieces.forEach(p => {
    if (p.gap) return;
    const ta = Math.max(p.r0, RL.x2t(ax, xa, ppm)), tb = Math.min(p.r1, RL.x2t(ax, xb, ppm));
    if (tb < ta) return;
    const off = new Date(ta).getTimezoneOffset() * 60000;
    for (let t = Math.ceil((ta - off) / step) * step + off; t <= tb; t += step) {
      const d = new Date(t), day = rlP2(d.getMonth() + 1) + '-' + rlP2(d.getDate());
      let label = rlP2(d.getHours()) + ':' + rlP2(d.getMinutes()) + (step < 60e3 ? ':' + rlP2(d.getSeconds()) : '');
      if ((ax.multiDay && !prevDay) || (prevDay && day !== prevDay)) label = day + ' ' + label;
      prevDay = day;
      out.push({t, x: RL.t2x(ax, t, ppm), label, step});
    }
  });
  return out;
};

/* ------------------------------------------------------------------ lanes and nodes */
/* Estimated width the title needs (CJK glyphs ~12 px, others ~6.6 px). */
RL.want = function (nd) {
  if (nd._want) return nd._want;
  let w = 0;
  for (const ch of nd.title) w += ch.charCodeAt(0) > 0x2e80 ? 12 : 6.6;
  return (nd._want = Math.min(260, Math.max(RL.RESERVE_W, Math.round(w + 26))));
};
RL.colorVar = el => (el.st === 'err' || el.st === 'hook' || el.cat === 'bad' ? '--bad' : el.cat === 'event' || el.cat === 'user' || el.kind === 'user' ? '--accent' : '--c-' + el.cat);

const RL_MARK_KIND = {recv: 1, merge: 1, compact: 1, hook: 1};   // always an icon marker, never a box

/* An automatic group: several crowded nodes of one lane drawn as one box (members keep their own data). */
RL.makeGroup = function (members) {
  const f = members[0], info = RM.groupInfo(members);
  const g = {id: 'g:' + f.id, agent: f.agent, kind: 'group', cat: info.cat, members, n: info.n, bad: info.bad, st: 'ok', title: info.title, icon: '',
             t0: f.t0, t1: Math.max.apply(null, members.map(m => m.t1)), cost: null, retry: 0, live: false, mark: false, w: 0, h: RL.NODE_H};
  members.forEach(m => { if (m.cost != null) g.cost = (g.cost || 0) + m.cost; });
  let items = null, steps = null;
  Object.defineProperty(g, 'items', {get() { return items || (items = [].concat.apply([], members.map(m => m.items))); }});
  Object.defineProperty(g, 'steps', {get() { return steps || (steps = RM.distinct([].concat.apply([], members.map(m => m.steps)))); }});
  return g;
};

/* Places the nodes of one lane and returns the number of sub-rows used. Fills L.els (what is drawn: boxes, icon markers and
 * groups, in x order) and L.lines (dotted lines for folded strips). Every element has lx (left), dw (drawn width), h, row.
 *   - A node whose start lies less than its needed width after the previous element joins it in a group (the group
 *     window is GROUP_W wide, so a crowded stretch becomes a row of groups, never one huge one).
 *   - Elements really overlapping in time (a long node and a later start) take a second sub-row; when no row has room the
 *     node joins the previous element. So a lane never has more than `rows` sub-rows.
 *   - Strips are not elements: they become dotted lines on the middle of the first row, cut around what is drawn there. */
RL.packLane = function (L, ax, ppm, now, rows) {
  L.nodes.forEach(nd => { nd.fm = false; });
  let used = RL.packOnce(L, ax, ppm, now, rows);
  // a dispatch / user box that ended up narrower than MARK_BELOW (crowded by its neighbours) becomes a marker: pack again
  let again = false;
  L.els.forEach(e => { if (!e.mark && !e.members && (e.kind === 'dispatch' || e.kind === 'user') && !e.live && e.dw < RL.MARK_BELOW) { e.fm = true; again = true; } });
  return again ? RL.packOnce(L, ax, ppm, now, rows) : used;
};
RL.packOnce = function (L, ax, ppm, now, rows) {
  const P = [], S = [];
  L.nodes.forEach(nd => {
    nd.x = RL.t2x(ax, nd.t0, ppm);
    nd.w = Math.max(0, RL.t2x(ax, nd.live && now > nd.t1 ? now : nd.t1, ppm) - nd.x);
    nd.cl = null; nd.mark = false; nd.h = RL.NODE_H; nd.row = 0; nd.gapAfter = 0;
    if (nd.kind === 'strip') {
      if (P.length) P[P.length - 1].gapAfter = Math.max(P[P.length - 1].gapAfter, RL.t2x(ax, nd.t1, ppm) - nd.x);
      S.push(nd);
    } else P.push(nd);
  });
  P.forEach((nd, k) => {
    const room = k + 1 < P.length ? P[k + 1].x - nd.x - RL.SEP : Infinity;
    nd.mark = nd.fm || !!RL_MARK_KIND[nd.kind] || ((nd.kind === 'dispatch' || nd.kind === 'user') && !nd.live && Math.max(nd.w, Math.min(RL.want(nd), room)) < RL.MARK_BELOW);
    nd.req = nd.mark ? RL.MARK_W + 2 : RL.REQ_BOX;
    nd.lx = nd.mark ? nd.x - RL.MARK_W / 2 : nd.x;
    nd.ext = nd.mark ? RL.MARK_W : Math.max(nd.w, nd.req);
    nd.h = nd.mark ? RL.MARK_W : RL.NODE_H;
    nd.pi = k;
  });
  const cs = [], rend = [], soft = [];
  for (let r = 0; r < rows; r++) { rend.push(-Infinity); soft.push(false); }
  let last = null;
  // a start inside the group window joins it; a forced join (no row has room) also stretches the window
  const join = (c, nd, forced) => {
    if (c.members.length === 1) c.rend = Math.max(c.rend, c.lx + RL.GROUP_W);
    c.members.push(nd);
    if (forced) c.rend = Math.max(c.rend, nd.lx + nd.req);
    rend[c.row] = c.rend; soft[c.row] = false;
  };
  P.forEach(nd => {
    if (last && !nd.live && nd.lx < last.lx + (last.members.length > 1 ? RL.GROUP_W + RL.SEP : last.members[0].req)) return join(last, nd);
    let row = -1;
    for (let r = 0; r < rows; r++) if (rend[r] + RL.SEP - (soft[r] ? RL.TOL : 0) <= nd.lx) { row = r; break; }
    if (row < 0) {
      if (last && !nd.live) return join(last, nd, true);
      row = 0;
      for (let r = 1; r < rows; r++) if (rend[r] < rend[row]) row = r;
    }
    last = {members: [nd], lx: nd.lx, rend: nd.lx + nd.ext, row};
    rend[row] = last.rend; soft[row] = true;
    cs.push(last);
  });
  // drawn widths: a box may grow to its title width when its row has room (a folded-strip line keeps part of that room)
  const nextIn = new Array(cs.length), seen = new Array(rows).fill(-1);
  for (let i = cs.length - 1; i >= 0; i--) { nextIn[i] = seen[cs[i].row]; seen[cs[i].row] = i; }
  const els = [], xs = [], xe = [];
  let mx = -Infinity;
  cs.forEach((c, i) => {
    const nd = c.members[0], nx = nextIn[i] >= 0 ? cs[nextIn[i]] : null;
    const free = nx ? nx.lx - RL.SEP - c.lx : Infinity;
    let el;
    if (c.members.length > 1) {
      el = RL.makeGroup(c.members);
      el.lx = c.lx; el.x = nd.x; el.dw = Math.max(12, Math.min(c.rend - c.lx, free));
      c.members.forEach(m => { m.cl = el; m.lx = el.lx; m.dw = el.dw; m.row = c.row; });
    } else {
      el = nd;
      nd.cl = nd;
      if (nd.mark) nd.dw = RL.MARK_W;
      else {
        const res = nx && nx.members[0].pi === nd.pi + 1 ? Math.min(80, nd.gapAfter) : 0;
        const lim = Math.max(free - res, Math.min(free, RL.REQ_BOX));
        nd.dw = nd.w > free ? Math.max(12, free) : Math.max(12, Math.min(Math.max(nd.w, Math.min(RL.want(nd), lim)), free));
      }
    }
    el.row = c.row;
    els.push(el);
    xs.push(el.lx);
    mx = Math.max(mx, el.lx + el.dw);
    xe.push(mx);
  });
  L.els = els; L.xs = xs; L.xe = xe;
  // folded strips -> dotted lines on the first row's middle, cut around the elements drawn there
  const r0 = els.filter(e => e.row === 0), lines = [];
  let j = 0;
  S.forEach(s => {
    const a = s.x, b = Math.max(a, RL.t2x(ax, s.t1, ppm));
    s.line = false;
    while (j < r0.length && r0[j].lx + r0[j].dw + 2 <= a) j++;
    let cur = a, best = null;
    const keep = (u, v) => { if (v - u >= 8 && (!best || v - u > best[1] - best[0])) best = [u, v]; };
    for (let k = j; k < r0.length && r0[k].lx - 2 < b; k++) {
      if (r0[k].lx - 2 > cur) keep(cur, Math.min(r0[k].lx - 2, b));
      cur = Math.max(cur, r0[k].lx + r0[k].dw + 2);
    }
    if (cur < b) keep(cur, b);
    if (best) { s.lx = best[0]; s.dw = best[1] - best[0]; s.line = true; s.h = 16; lines.push(s); }
  });
  L.lines = lines;
  return els.reduce((m, e) => Math.max(m, e.row + 1), 1);
};

/* opts: {now, onlyRunning, isCollapsed(lane)}. Fills lane.y/h/rows/x0/x1 and the y of every element.
 * Returns {lanes (visible), W, H}. */
RL.place = function (model, ax, ppm, opts) {
  opts = opts || {};
  const now = opts.now || 0, vis = [];
  let y = 0;
  model.lanes.forEach(L => {
    if (opts.onlyRunning && L.id !== model.rootId && !L.running) { L.vis = false; return; }
    L.vis = true;
    L.collapsed = L.id !== model.rootId && !!(opts.isCollapsed && opts.isCollapsed(L));
    const rows = RL.packLane(L, ax, ppm, now, L.collapsed ? 1 : RL.MAX_ROWS);
    L.rows = L.collapsed ? 1 : rows;
    L.y = y;
    L.h = L.collapsed ? RL.COLLAPSED_H : RL.PAD_T + L.rows * RL.ROW_H + RL.PAD_B;
    L.vi = vis.length;
    y += L.h;
    vis.push(L);
    L.x0 = RL.t2x(ax, L.s0 || (L.nodes[0] && L.nodes[0].t0) || ax.r0, ppm);
    const lastNode = L.nodes[L.nodes.length - 1];
    const end = L.running ? Math.max(now, lastNode ? lastNode.t1 : 0) : (L.s1 || (lastNode ? lastNode.t1 : 0));
    L.x1 = Math.max(L.x0, RL.t2x(ax, end || ax.r1, ppm));
    L.els.forEach(e => {
      const top = L.y + RL.PAD_T + e.row * RL.ROW_H;
      e.y = e.mark ? top + (RL.NODE_H - RL.MARK_W) / 2 : top;
      e.bot = e.y + e.h;
      if (e.members) e.members.forEach(m => { m.y = e.y; m.bot = e.bot; });
    });
    L.lines.forEach(s => { s.y = L.y + RL.PAD_T + (RL.NODE_H - s.h) / 2; });
  });
  const W = RL.t2x(ax, Math.max(ax.r1, now), ppm) + 60;
  return {lanes: vis, W, H: y};
};

/* First element index of a lane that may reach x0 or beyond (elements are ordered by x; xe is the running max of right edges). */
RL.firstAt = (L, x0) => RL.lowerBound(L.xe, x0);

/* ------------------------------------------------------------------ edges */
/* Geometry of an edge in world coordinates, or null when an endpoint's lane is hidden.
 *   fork   vertical line from the dispatch node (parent lane) down to the start of the child's lane
 *   join   vertical line from the end of the child's lane up to the parent (a marker sits on the parent at the hand-back time)
 *   retry  small arc above two nodes of one lane
 * cross: lanes lie between the endpoints (the line is drawn faint and dashed, with a dot at each end). */
RL.edgeGeom = function (model, ax, ppm, e) {
  const C = model.laneById.get(e.lane);
  if (e.kind === 'retry') {
    if (!C.vis || C.collapsed) return null;
    const a = e.from, b = e.to;
    // only between two boxes that are drawn on their own, in one sub-row
    if (a.cl !== a || b.cl !== b || a.mark || b.mark || a.row !== b.row) return null;
    const x1 = a.lx + Math.min(a.dw, 56) / 2, x2 = b.lx + Math.min(b.dw, 56) / 2, base = Math.min(a.y, b.y) + 2;
    // below the first sub-row the arc would cross the boxes above: draw nothing when something sits in its way
    if (a.row > 0) for (let i = RL.firstAt(C, x1); i < C.els.length && C.xs[i] <= x2; i++) if (C.els[i].row < a.row && C.els[i].lx + C.els[i].dw >= x1) return null;
    const top = Math.max(C.y + 2, base - 0.4 * C.h);
    return {kind: 'retry', x1, x2, y1: top, y2: base, lx: (x1 + x2) / 2, ly: top + 11,
            d: 'M' + x1 + ',' + base + ' C' + x1 + ',' + top + ' ' + x2 + ',' + top + ' ' + x2 + ',' + base};
  }
  const P = model.laneById.get(e.kind === 'fork' ? e.from.agent : e.to.agent);
  if (!C.vis || !P || !P.vis) return null;
  const cross = Math.abs(C.vi - P.vi) > 1;
  let x1, y1, x2, y2;
  if (e.kind === 'fork') {
    x1 = RL.t2x(ax, e.tFrom, ppm); y1 = P.collapsed ? P.y + P.h / 2 : e.from.bot;
    x2 = RL.t2x(ax, e.tTo, ppm); y2 = C.y + (C.collapsed ? C.h / 2 : 3);
  } else {
    x1 = RL.t2x(ax, e.tFrom, ppm); y1 = C.y + (C.collapsed ? C.h / 2 : 3);
    x2 = RL.t2x(ax, e.tTo, ppm); y2 = P.collapsed ? P.y + P.h / 2 : e.to.bot;
  }
  const ym = (y1 + y2) / 2;
  return {kind: e.kind, cross, x1, y1, x2, y2, d: 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + ym + ' ' + x2 + ',' + ym + ' ' + x2 + ',' + y2};
};

/* First index in an ascending number array with value >= v. */
RL.lowerBound = function (arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
};

/* Retry labels that would overlap an earlier label of the same lane: their keys (drawn only while the arc is hovered). */
RL.hiddenLabels = function (model, ax, ppm) {
  const hide = new Set(), occ = new Map();
  model.edges.forEach(e => {
    if (e.kind !== 'retry') return;
    const g = RL.edgeGeom(model, ax, ppm, e);
    if (!g) return;
    const list = occ.get(e.lane) || occ.set(e.lane, []).get(e.lane), a = g.lx - 25, b = g.lx + 25;
    if (list.some(r => a < r[1] && b > r[0])) hide.add(e.key); else list.push([a, b]);
  });
  return hide;
};
