'use strict';
/* Fork-route map, part 5: the view. Entry point: renderRoute(container, {live, store, key, skew}) -> controller.
 *   live: poll running agents (see route_live.js), keep the "now" line in view; false: a finished session, static.
 * Layers inside the plot (all share one world coordinate system: x = time, y = lanes; the lane names and the time axis
 * live outside it and follow only one direction of the pan):
 *   canvas  .rt-bg     lane stripes, active spans, idle bands, grid, "now" line, nodes too small for a DOM element
 *   svg     .rt-edges  dispatch / hand-back lines and retry arcs
 *   dom     .rt-node   only the nodes inside the viewport, kept in a keyed map and diffed on every frame
 * so a session with ten thousand steps opens as fast as a small one. */

const RV_ST = {ok: ['成功', 'ok'], err: ['失败', 'err'], hook: ['拦截', 'hook'], pend: ['进行中', 'run']};
const RV_NO_ST = {user: 1, compact: 1, recv: 1, strip: 1, group: 1};
const RV_LEGEND = [['read', '读/搜'], ['write', '写/改'], ['test', '测试'], ['git', 'git'], ['wait', '等待'], ['agent', '协作'], ['other', '其他']];
const RV_MARKS = [['✉', '用户消息'], ['◆', '派单'], ['◇', '交回'], ['✗', '拦截'], ['★', '合入'], ['⟲', '压缩']];
const RV_GRANS = [['overview', '概览', '只显示关键节点（用户消息、派单、交回、测试、失败、合入、压缩），其余调用折成一段虚线，点虚线展开'], ['stage', '阶段', '相邻同类调用合并成一个节点'], ['step', '逐步', '每次调用一个节点']];
const RV_LINE_LABEL_W = 70;  // a folded-run line this long carries a small "N 步 · 耗时" label
const RV_DOM_MIN_W = 12;     // nodes narrower than this are painted on the canvas only
const RV_DOM_CAP = 700;      // at most this many node elements; the rest is painted
const RV_FOLLOW = 0.85;      // the "now" line stays at this fraction of the plot width while following
const RV_EXP = new Map();    // strip ids shown expanded, per session (survives switching tabs)

function rvReduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
function rvColor(name) { return typeof cssVar === 'function' ? cssVar(name) : '#888'; }
function rvCanvas(cv, w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (cv._w !== w || cv._h !== h || cv._d !== dpr) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    cv._w = w; cv._h = h; cv._d = dpr;
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return g;
}
function rvHatch(color) {
  if (rvHatch.c !== color) {
    const cv = document.createElement('canvas'), g = cv.getContext('2d');
    cv.width = cv.height = 8;
    g.strokeStyle = color; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
    rvHatch.c = color; rvHatch.p = g.createPattern(cv, 'repeat');
  }
  return rvHatch.p;
}
function rvCatColor(nd) { return rvColor(RL.colorVar(nd)); }

function renderRoute(container, opts) {
  opts = opts || {};
  const live = !!opts.live;
  const store = opts.store || RM.fromPageData(D);
  const key = opts.key || (typeof D !== 'undefined' && D.meta ? D.meta.liveKey : '');
  const skew = opts.skew || (() => 0);
  const now = () => Date.now() + skew();
  if (live) store.agents.forEach(a => { a.running = a.id === 'main' ? !!(D.meta && D.meta.active) : !a.doneTs; });
  const skey = key || (typeof D !== 'undefined' && D.meta ? String(D.meta.sid || D.meta.start) : 'x');

  const V = {ppm: 60, vx: 0, vy: 0, vp: null, W: 1, H: 1, ax: null, auto: live, gran: 'overview', onlyRunning: false, collapseIdle: true,
             collapsed: new Map(), expanded: RV_EXP.get(skey) || new Set(), model: null, layout: null, nodes: new Map(), edges: new Map(), labs: new Map(), folds: new Map(),
             elById: new Map(), hideLab: new Set(), prevIds: null, fresh: new Map(), mmBitmap: null, active: true, hidden: document.hidden, raf: 0, needBuild: false, needAxis: false, needLay: false,
             dirty: false, tipId: '', fitted: false, axisAt: 0, tickList: []};
  try {
    const saved = JSON.parse(localStorage.getItem('ar-route-exp:' + skey) || 'null');
    if (Array.isArray(saved) && !RV_EXP.has(skey)) saved.forEach(id => V.expanded.add(id));
  } catch (e) { /* storage is optional */ }
  RV_EXP.set(skey, V.expanded);
  const saveExpanded = () => { try { localStorage.setItem('ar-route-exp:' + skey, JSON.stringify(Array.from(V.expanded).slice(-300))); } catch (e) { /* optional */ } };

  const SORT_KEY = 'agent-replay.route.sort';
  try { const v = localStorage.getItem(SORT_KEY); if (RM.SORT_KEYS.includes(v)) V.sort = v; } catch (e) { /* storage is optional */ }
  if (!V.sort) V.sort = 'start';   // default: start time (user choice)

  container.className = (container.className || '').replace(/\brt\b/g, '') + ' rt' + (document.hidden ? ' rt-hidden' : '');
  container.innerHTML =
    '<div class="rt-bar"><span class="rt-seg" role="group" aria-label="详略">' +
    RV_GRANS.map(g => '<button type="button" data-g="' + g[0] + '" class="' + (g[0] === V.gran ? 'on' : '') + '" aria-pressed="' + (g[0] === V.gran) + '" title="' + g[2] + '">' + g[1] + '</button>').join('') + '</span>' +
    '<label class="rt-chk rt-sortw">排序 <select id="rt-sort" class="rt-sort">' + RM.sorts().map(o => '<option value="' + o[0] + '"' + (o[0] === V.sort ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>' +
    '<label class="rt-chk"><input type="checkbox" id="rt-run"> 只看在跑的泳道</label>' +
    '<label class="rt-chk" title="所有代理都没有活动、且超过 15 分钟的时段压成一条固定宽度的空闲带"><input type="checkbox" id="rt-idle" checked> 折叠空闲</label>' +
    '<button type="button" id="rt-fold" class="rt-foldall" title="展开或折叠所有子代理泳道（泳道很多时，已交回的默认折叠成一行）">展开全部泳道</button>' +
    '<span class="grow"></span><span class="rt-src dim" id="rt-src"></span><span class="rt-zoom num dim" id="rt-zoom" title="时间比例：每分钟占多少像素"></span>' +
    '<button type="button" id="rt-follow" hidden title="让「现在」回到画面右侧并继续自动跟随">跟随最新</button>' +
    '<button type="button" id="rt-fit" title="整个会话的有效时长正好铺满画布">适配画面</button></div>' +
    '<details class="rt-leg"' + (innerWidth >= 900 ? ' open' : '') + '><summary>图例</summary><div class="rt-legbody">' +
    '<div class="rt-sw">' + RV_LEGEND.map(c => '<span><i style="background:var(--c-' + c[0] + ')"></i>' + c[1] + '</span>').join('') + '</div>' +
    '<div class="rt-mk">' + RV_MARKS.map(m => '<span><b>' + m[0] + '</b>' + m[1] + '</span>').join('') +
    '<span class="rt-bad"><i></i>失败/拦截</span><span><i class="rt-lgs"></i>虚线 N 步（折叠的普通调用，点击展开）</span><span><i class="rt-lgg"></i>组 ×N（挤在一起的节点，放大后拆开，点击看明细）</span><span><i class="rt-lgi"></i>空闲带（已折叠的无人活动时段）</span></div>' +
    '<div class="dim">竖线：派单（父泳道 → 子泳道）与交回（子泳道 → 父泳道，◇ 为交回时刻）；跨过其他泳道时画成虚线 · 拖动或两指滑动平移 · 捏合或 ⌘/Ctrl+滚轮缩放 · 点节点看详情</div></div></details>' +
    '<div class="rt-main"><div class="rt-corner">泳道</div><canvas class="rt-axis" aria-hidden="true"></canvas><div class="rt-labs"></div>' +
    '<div class="rt-vp" tabindex="0" role="application" aria-label="分岔路线图，按时间排列的泳道。方向键平移，加号减号缩放，F 适配画面">' +
    '<canvas class="rt-bg" aria-hidden="true"></canvas><div class="rt-world"><svg class="rt-edges" width="1" height="1" aria-hidden="true"></svg></div>' +
    '<canvas class="rt-ovl rt-map" width="' + RN.MM_W + '" height="' + RN.MM_H + '" aria-label="小地图：点击或拖动跳转"></canvas>' +
    '<div class="rt-empty dim" hidden>还没有可画的步骤。</div><div class="rt-tip" hidden></div></div></div>';
  const vp = V.vp = container.querySelector('.rt-vp');
  const q = s => container.querySelector(s);
  const world = q('.rt-world'), svg = q('.rt-edges'), labsEl = q('.rt-labs'), bgEl = q('.rt-bg'), axisEl = q('.rt-axis');
  const tipEl = q('.rt-tip'), mapEl = q('.rt-map'), emptyEl = q('.rt-empty'), followBtn = q('#rt-follow');
  const SVGNS = 'http://www.w3.org/2000/svg';

  /* ---------------------------------------------------------------- model, axis, layout */
  const plotW = () => vp.clientWidth || 900;
  function rebuildAxis() {
    V.needAxis = false;
    V.axisAt = Date.now();
    V.ax = RL.buildAxis(V.model, {now: live ? now() : 0, collapse: V.collapseIdle});
    V.needLay = true;
  }
  function relayout() {
    V.needLay = false;
    const m = V.model, many = m.lanes.length > 30;
    V.layout = RL.place(m, V.ax, V.ppm, {now: live ? now() : 0, onlyRunning: V.onlyRunning,
                        isCollapsed: L => V.collapsed.has(L.id) ? V.collapsed.get(L.id) : (many && L.done && !L.running)});
    const mm = plotW() >= 700;
    V.W = V.layout.W + (mm ? RN.MM_W + 24 : 0);
    V.H = V.layout.H + (mm ? RN.MM_H + 24 : 8);
    V.mmBitmap = null;
    V.elById = new Map();
    V.layout.lanes.forEach(L => { L.els.forEach(e => V.elById.set(e.id, e)); L.lines.forEach(e => V.elById.set(e.id, e)); });
    V.hideLab = RL.hiddenLabels(m, V.ax, V.ppm);
    emptyEl.hidden = m.nodeCount > 0;
    if (V.auto && live) follow(); else RN.limit(V);
  }
  function rebuild() {
    V.needBuild = false;
    V.model = RM.build(store, V.gran, {expanded: V.expanded, sort: V.sort, newest: newestFirst(), now: live ? now() : 0});
    rebuildAxis();
    relayout();
    const ids = new Set();
    V.model.nodeById.forEach((nd, id) => ids.add(id));
    if (V.prevIds && !rvReduced() && !V.hidden) ids.forEach(id => { if (!V.prevIds.has(id)) V.fresh.set(id, performance.now()); });
    V.prevIds = ids;
    schedule();
  }
  function requestBuild() { V.needBuild = true; if (V.active && !V.hidden) { cancelAnimationFrame(V.raf); V.raf = requestAnimationFrame(frame); } }

  /* ---------------------------------------------------------------- view control */
  function nowX() { return RL.t2x(V.ax, now(), V.ppm); }
  /* Following: the "now" line stays at RV_FOLLOW of the plot width; the newest lane is scrolled into view. */
  function follow() {
    V.vx = RV_FOLLOW * plotW() - nowX();
    V.vx = Math.min(plotW() - RN.MARGIN, V.vx);
    let best = null;
    V.layout.lanes.forEach(L => { const nd = L.nodes[L.nodes.length - 1]; if (nd && (!best || nd.t1 > best.nd.t1)) best = {nd, L}; });
    if (best && (best.L.y + V.vy < 0 || best.L.y + best.L.h + V.vy > vp.clientHeight)) V.vy = Math.min(0, vp.clientHeight / 2 - best.L.y - best.L.h / 2);
    V.vy = Math.min(0, Math.max(Math.min(0, vp.clientHeight - V.H), V.vy));
  }
  function setAuto(on) {
    V.auto = on;
    followBtn.hidden = !live || on;
  }
  /* Default zoom: the whole effective duration fills the plot (live: up to the follow position). */
  function fit() {
    const w = plotW();
    V.ppm = RL.fitPpm(V.ax, (live ? RV_FOLLOW * w : w) - RL.PAD_L * 2, w);
    V.vx = RL.PAD_L; V.vy = 0;
    V.fitted = w > 0 && vp.clientWidth > 0;
    if (live) setAuto(true);
    relayout();
    schedule();
  }
  const hooks = {
    zoomed: () => { V.needLay = true; },
    change: () => schedule(),
    moved: () => { if (V.auto) setAuto(false); },
    click: el => {
      const nd = elOf(el.dataset.id);
      if (!nd) return;
      if (nd.kind === 'strip') toggleStrip(nd.id); else openDetail(nd);
    },
    fit, anchorX: () => (V.auto && live ? nowX() + V.vx : null)
  };
  const elOf = id => V.elById.get(id) || (V.model && V.model.nodeById.get(id));
  function toggleStrip(id) {
    if (V.expanded.has(id)) V.expanded.delete(id); else V.expanded.add(id);
    saveExpanded();
    V.prevIds = null;
    hideTip();
    rebuild();
  }
  /* Nearest recorded step of a node without steps of its own (hand-back, compaction): the last step at or before it. */
  function nearStep(nd) {
    const items = V.model.laneById.get(nd.agent).items;
    let s = null;
    for (let i = 0; i < items.length && items[i].ts <= nd.t0 + 1; i++) if (items[i].step != null) s = items[i].step;
    if (s == null) { const f = items.find(i => i.step != null); s = f ? f.step : null; }
    return s;
  }
  /* Clicks open the detail window (modal.js); without it the old jump into the replay view is used. */
  function openDetail(nd) {
    if (typeof showDetail === 'function') {
      if (nd.kind === 'group') {   // every item of the group, in time order
        const st = RM.distinct([].concat.apply([], nd.members.map(m => (m.steps.length ? m.steps : [nearStep(m)]))));
        if (st.length) return showDetail({type: 'steps', agent: nd.agent, steps: st, title: nd.title});
        return showDetail({type: 'agent', agent: nd.agent});
      }
      if (nd.kind === 'user' && nd.ti != null) return showDetail({type: 'turn', turn: nd.ti});
      if (nd.steps.length > 1) return showDetail({type: 'steps', agent: nd.agent, steps: nd.steps, title: nd.title});
      const s = nd.steps.length ? nd.steps[0] : nearStep(nd);
      if (s != null) return showDetail({type: 'step', agent: nd.agent, step: s});
      return showDetail({type: 'agent', agent: nd.agent});
    }
    if (typeof jumpTo === 'function') jumpTo(nd.agent, nd.items[0].ts, nd.kind === 'user' || nd.kind === 'compact', nd.firstStep);
  }
  function openAgent(id) {
    if (typeof showDetail === 'function') showDetail({type: 'agent', agent: id});
    else if (typeof jumpTo === 'function') jumpTo(id, 0, false, null);
  }

  /* ---------------------------------------------------------------- DOM: nodes */
  function lodOf(nd) { return nd.dw >= 112 ? 2 : nd.dw >= 48 ? 1 : 0; }
  /* Two lines in every box: the title, then the small duration and amount. */
  function nodeInner(nd, lod, isLive) {
    if (nd.mark) return '<span class="rt-ic">' + esc(nd.icon || '') + '</span>';
    if (lod === 0) return '<span class="rt-ic">' + esc(nd.icon || '') + '</span>';
    const st = RV_ST[nd.st === 'pend' && !isLive ? 'ok' : nd.st] || RV_ST.ok;
    const stTxt = lod < 2 || RV_NO_ST[nd.kind] ? '' : (nd.st === 'pend' && !isLive ? '' : st[0]);
    const dur = nd.t1 - nd.t0;
    const meta = (isLive ? '<b class="rt-tick" data-t0="' + nd.t0 + '">' + fmtDur(Math.max(0, now() - nd.t0)) + '</b>' : (dur > 0 ? '<span>' + fmtDur(dur) + '</span>' : '')) +
      (nd.cost > 0 && nd.dw >= 110 ? '<span class="rt-cost">' + esc(fmtMoney(nd.cost)) + '</span>' : '') + (nd.retry && lod === 2 ? '<span class="rt-rtn">重试 ' + nd.retry + ' 次</span>' : '');
    return '<div class="rt-h"><span class="rt-t">' + esc(nd.title) + '</span>' + (stTxt ? '<span class="rt-s s-' + st[1] + '">' + stTxt + '</span>' : '') + '</div><div class="rt-m">' + meta + '</div>';
  }
  function nodeEl(nd, isLive) {
    let el = V.nodes.get(nd.id);
    const lod = lodOf(nd), du = !nd.mark && nd.kind !== 'group' && nd.dw > nd.w + 8 ? Math.round(nd.w) : 0;
    const sig = nd.title + '|' + nd.st + '|' + (nd.t1 - nd.t0) + '|' + nd.cost + '|' + nd.retry + '|' + isLive + '|' + lod + '|' + du + '|' + (nd.dw >= 110) + '|' + nd.bad;
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = nd.id;
      el.setAttribute('role', 'button');
      if (V.fresh.has(nd.id)) el.classList.add('rt-new');
      world.appendChild(el);
      V.nodes.set(nd.id, el);
    }
    if (el._sig !== sig) {
      el._sig = sig;
      el.className = 'rt-node k-' + nd.kind + ' c-' + nd.cat + ' s-' + nd.st + ' lod' + lod + (nd.mark ? ' rt-mark' : '') + (nd.bad ? ' has-bad' : '') + (isLive ? ' live' : '') +
        (el.classList.contains('rt-new') ? ' rt-new' : '') + (nd.retry ? ' retried' : '');
      el.innerHTML = nodeInner(nd, lod, isLive) + (du ? '<i class="rt-du" style="width:' + du + 'px"></i>' : '');
      el.setAttribute('aria-label', nd.title);
    }
    const pos = nd.lx + ',' + nd.y + ',' + nd.dw;
    if (el._pos !== pos) { el._pos = pos; el.style.left = nd.lx + 'px'; el.style.top = nd.y + 'px'; el.style.width = nd.dw + 'px'; el.style.height = nd.h + 'px'; }
  }
  /* A folded run of plain calls: a dotted line between its neighbours, with a label when it is long enough. */
  function lineEl(nd) {
    let el = V.nodes.get(nd.id);
    const lab = nd.dw >= RV_LINE_LABEL_W ? nd.n + ' 步 · ' + RM.fmtDur(nd.t1 - nd.t0) : '';
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = nd.id;
      el.className = 'rt-line';
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', nd.title + '，点击展开');
      world.appendChild(el);
      V.nodes.set(nd.id, el);
    }
    if (el._lab !== lab) { el._lab = lab; el.innerHTML = lab ? '<span>' + esc(lab) + '</span>' : ''; }
    const pos = nd.lx + ',' + nd.y + ',' + nd.dw;
    if (el._pos !== pos) { el._pos = pos; el.style.left = nd.lx + 'px'; el.style.top = nd.y + 'px'; el.style.width = nd.dw + 'px'; el.style.height = nd.h + 'px'; }
  }
  function foldEl(f, L) {
    let el = V.folds.get(f.id);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button'; el.className = 'rt-fold';
      el.dataset.id = f.id;
      el.title = '收起：把这 ' + f.n + ' 步重新折成一段虚线';
      el.textContent = '▴ 收起 ' + f.n + ' 步';
      el.onclick = ev => { ev.stopPropagation(); toggleStrip(f.id); };
      world.appendChild(el);
      V.folds.set(f.id, el);
    }
    const a = f.first.cl || f.first, z = f.last.cl || f.last;
    const x = a.lx, w = Math.max(60, z.lx + z.dw - x), pos = x + ',' + L.y + ',' + w;
    if (el._pos !== pos) { el._pos = pos; el.style.left = x + 'px'; el.style.top = (L.y + 1) + 'px'; el.style.width = w + 'px'; }
  }

  /* ---------------------------------------------------------------- DOM: edges (svg) */
  function edgeEl(e, g) {
    let el = V.edges.get(e.key);
    if (!el) {
      el = document.createElementNS(SVGNS, 'g');
      el.setAttribute('class', 'rt-e e-' + e.kind + (V.fresh.has(e.to.id) ? ' rt-new' : ''));
      svg.appendChild(el);
      V.edges.set(e.key, el);
    }
    const off = e.kind === 'retry' && V.hideLab.has(e.key), sig = g.d + (g.cross ? 'x' : '') + (off ? 'o' : '');
    if (el._sig === sig) return;
    el._sig = sig;
    el.classList.toggle('cross', !!g.cross);
    el.classList.toggle('lab-off', off);   // an overlapping label shows only while the arc is hovered
    let h = '<path d="' + g.d + '"/>';
    if (e.kind === 'retry') h += '<path class="hit" d="' + g.d + '"/><text x="' + g.lx + '" y="' + g.ly + '" text-anchor="middle">重试 ' + e.n + ' 次</text>';
    else {
      if (g.cross) h += '<circle cx="' + g.x1 + '" cy="' + g.y1 + '" r="3"/>';
      // a hand-back icon marker already is the diamond
      h += e.kind === 'join' ? (e.to.mark ? '' : '<path class="mk" d="M' + g.x2 + ',' + (g.y2 - 5) + ' l4,5 l-4,5 l-4,-5 z"/>') : (g.cross ? '<circle cx="' + g.x2 + '" cy="' + g.y2 + '" r="3"/>' : '');
    }
    el.innerHTML = h;
  }

  /* ---------------------------------------------------------------- canvas: background, axis */
  function drawBg(lanes, small, x0, x1) {
    const w = vp.clientWidth, h = vp.clientHeight, g = rvCanvas(bgEl, w, h);
    const stripe = rvColor('--rt-stripe'), line = rvColor('--line'), active = rvColor('--rt-active');
    V.layout.lanes.forEach(L => {
      const y = L.y + V.vy;
      if (y > h || y + L.h < 0) return;
      if (L.vi % 2) { g.fillStyle = stripe; g.fillRect(0, y, w, L.h); }
    });
    // idle bands and the grid
    const hatch = rvHatch(rvColor('--rt-hatch'));
    V.ax.pieces.forEach(p => {
      if (!p.gap) return;
      const xa = RL.t2x(V.ax, p.r0, V.ppm) + V.vx, xb = xa + RL.GAP_PX;
      if (xb < 0 || xa > w) return;
      g.fillStyle = rvColor('--rt-bg'); g.fillRect(xa, 0, RL.GAP_PX, h);
      g.fillStyle = hatch; g.fillRect(xa, 0, RL.GAP_PX, h);
      g.fillStyle = line; g.fillRect(xa, 0, 1, h); g.fillRect(xb - 1, 0, 1, h);
    });
    g.fillStyle = rvColor('--rt-grid');
    V.tickList.forEach(t => g.fillRect(Math.round(t.x + V.vx), 0, 1, h));
    // active span of every agent: a faint fill from its start to its end
    V.layout.lanes.forEach(L => {
      const y = L.y + V.vy;
      if (y > h || y + L.h < 0 || L.x1 + V.vx < 0 || L.x0 + V.vx > w) return;
      const xa = Math.max(-2, L.x0 + V.vx), xb = Math.min(w + 2, L.x1 + V.vx);
      g.fillStyle = active; g.fillRect(xa, y + 3, Math.max(1, xb - xa), L.h - 6);
      g.fillStyle = rvColor('--rt-edge'); g.fillRect(xa, y + 3, Math.max(1, xb - xa), 1);
      if (L.collapsed) {   // a collapsed lane shows its nodes as small marks on the span
        for (let i = RL.firstAt(L, x0); i < L.els.length && L.xs[i] <= x1; i++) {
          const nd = L.els[i];
          g.fillStyle = rvCatColor(nd);
          g.fillRect(nd.lx + V.vx, y + 9, Math.max(1.5, Math.min(nd.dw, 40)), 8);
        }
      }
    });
    small.forEach(nd => { g.fillStyle = rvCatColor(nd); g.fillRect(nd.lx + V.vx, nd.y + V.vy + 4, Math.max(1.5, nd.dw), nd.h - 8); });
    // lane dividers
    g.fillStyle = line;
    V.layout.lanes.forEach(L => { const y = Math.round(L.y + L.h + V.vy) - 1; if (y >= 0 && y <= h) g.fillRect(0, y, w, 1); });
    if (live) {
      const x = nowX() + V.vx;
      if (x >= 0 && x <= w) { g.fillStyle = rvColor('--bad'); for (let y = 0; y < h; y += 8) g.fillRect(Math.round(x), y, 1.5, 4); }
    }
  }
  function drawAxis() {
    const w = vp.clientWidth, g = rvCanvas(axisEl, w, RL.AXIS_H);
    g.font = '11px -apple-system, "PingFang SC", system-ui, sans-serif';
    g.textBaseline = 'middle'; g.textAlign = 'center';
    g.fillStyle = rvColor('--dim');
    V.tickList.forEach(t => { const x = Math.round(t.x + V.vx); g.fillText(t.label, x, 13); g.fillRect(x, 21, 1, 9); });
    V.ax.pieces.forEach(p => {
      if (!p.gap) return;
      const xa = RL.t2x(V.ax, p.r0, V.ppm) + V.vx, xb = xa + RL.GAP_PX;
      if (xb < 0 || xa > w) return;
      g.fillStyle = rvColor('--rt-bg'); g.fillRect(xa, 0, RL.GAP_PX, RL.AXIS_H);
      g.fillStyle = rvHatch(rvColor('--rt-hatch')); g.fillRect(xa, 0, RL.GAP_PX, RL.AXIS_H);
      g.fillStyle = rvColor('--ink'); g.fillText('空闲 ' + RL.fmtIdle(p.r1 - p.r0), xa + RL.GAP_PX / 2, 13);
    });
    if (live) {
      const x = nowX() + V.vx;
      if (x >= -20 && x <= w + 20) {
        g.fillStyle = rvColor('--rt-bg'); g.fillRect(x - 18, 2, 36, 15);
        g.fillStyle = rvColor('--bad'); g.fillText('现在', x, 10); g.fillRect(Math.round(x), 18, 1.5, RL.AXIS_H - 18);
      }
    }
    g.fillStyle = rvColor('--line'); g.fillRect(0, RL.AXIS_H - 1, w, 1);
  }

  /* ---------------------------------------------------------------- render */
  function render() {
    const m = V.model;
    if (!m || !V.layout || !V.ax) return;
    const w = vp.clientWidth, h = vp.clientHeight;
    world.style.transform = 'translate(' + V.vx + 'px,' + V.vy + 'px)';
    const x0 = -V.vx - 40, x1 = w - V.vx + 40, y0 = -V.vy - 4, y1 = h - V.vy + 4;
    V.tickList = RL.ticks(V.ax, V.ppm, x0, x1);
    // 1. visible nodes: DOM for the readable ones, canvas for slivers (and for the excess when a view is extremely dense)
    const cand = [], lineCand = [], wantL = new Set();
    V.layout.lanes.forEach(L => {
      if (L.y + L.h < y0 || L.y > y1) return;
      wantL.add(L.id);
      if (L.collapsed) return;
      for (let i = RL.firstAt(L, x0); i < L.els.length && L.xs[i] <= x1; i++) { const nd = L.els[i]; if (nd.lx + nd.dw >= x0) cand.push(nd); }
      L.lines.forEach(nd => { if (nd.lx <= x1 && nd.lx + nd.dw >= x0) lineCand.push(nd); });
    });
    let dom = cand.filter(nd => nd.dw >= RV_DOM_MIN_W);
    const small = cand.filter(nd => nd.dw < RV_DOM_MIN_W);
    if (dom.length > RV_DOM_CAP) { dom.sort((a, b) => b.dw - a.dw); dom.splice(RV_DOM_CAP).forEach(nd => small.push(nd)); }
    const wantN = new Set(dom.map(nd => nd.id));
    lineCand.forEach(nd => wantN.add(nd.id));
    dom.forEach(nd => nodeEl(nd, !!nd.live));
    lineCand.forEach(lineEl);
    V.nodes.forEach((el, id) => { if (!wantN.has(id)) { el.remove(); V.nodes.delete(id); } });
    // 2. edges and fold handles
    const wantE = new Set(), wantF = new Set();
    m.edges.forEach(e => {
      const L = m.laneById.get(e.lane);
      if (!L.vis) return;
      if (e.kind === 'retry') { if (e.to.lx + e.to.dw < x0 || e.from.lx > x1) return; }
      else if (Math.max(RL.t2x(V.ax, e.tFrom, V.ppm), RL.t2x(V.ax, e.tTo, V.ppm)) < x0 || Math.min(RL.t2x(V.ax, e.tFrom, V.ppm), RL.t2x(V.ax, e.tTo, V.ppm)) > x1) return;
      const g = RL.edgeGeom(m, V.ax, V.ppm, e);
      if (!g || Math.max(g.y1, g.y2) < y0 || Math.min(g.y1, g.y2) > y1) return;
      edgeEl(e, g);
      wantE.add(e.key);
    });
    V.edges.forEach((el, id) => { if (!wantE.has(id)) { el.remove(); V.edges.delete(id); } });
    V.layout.lanes.forEach(L => {
      if (!wantL.has(L.id) || L.collapsed) return;
      L.folds.forEach(f => { const a = f.first.cl || f.first, z = f.last.cl || f.last; if (a.lx <= x1 && z.lx + z.dw >= x0) { foldEl(f, L); wantF.add(f.id); } });
    });
    V.folds.forEach((el, id) => { if (!wantF.has(id)) { el.remove(); V.folds.delete(id); } });
    // 3. canvases and lane names
    drawBg(wantL, small, x0, x1);
    drawAxis();
    renderLabs(wantL);
    if (V.fresh.size) { const t = performance.now(); V.fresh.forEach((ts, id) => { if (t - ts > 2500) V.fresh.delete(id); }); }
    q('#rt-zoom').textContent = V.ppm >= 10 ? Math.round(V.ppm) + ' px/分' : V.ppm.toFixed(1) + ' px/分';
    if (V.tipId && !V.nodes.has(V.tipId)) hideTip();
    if (!V.mmBitmap) RN.mmRebuild(V, m, rvColor);
    RN.mmDraw(V, mapEl, rvColor);
  }
  /* Lane names: a fixed column on the left; only the vertical pan moves them. */
  function renderLabs(want) {
    V.layout.lanes.forEach(L => {
      if (!want.has(L.id)) return;
      let b = V.labs.get(L.id);
      if (!b) { b = document.createElement('div'); b.dataset.id = L.id; labsEl.appendChild(b); V.labs.set(L.id, b); }
      const a = L.agent, nm = L.id === 'main' ? '主代理' : (a.desc || L.id);
      const sig = nm + '|' + L.collapsed + '|' + L.running + '|' + L.depth + '|' + L.vi % 2 + '|' + L.h + '|' + (a.model || '') + (a.effort || '') + '|' + (L.sentBy || '');
      if (b._sig !== sig) {
        b._sig = sig;
        b.className = 'rt-lab' + (L.vi % 2 ? ' alt' : '') + (L.running ? ' run' : '') + (L.collapsed ? ' col' : '');
        b.style.paddingLeft = (6 + Math.min(L.depth, 4) * 8) + 'px';
        b.style.height = L.h + 'px';
        const fam = a.fam || (a.model ? modelFam(a.model) : '');
        b.innerHTML = '<span class="rt-lr">' +
          (L.id === 'main' ? '' : '<button type="button" class="rt-tg' + (L.collapsed ? ' shut' : '') + '" title="' + (L.collapsed ? '展开这条泳道，显示每个节点' : '折叠成一行') + '" aria-label="' + (L.collapsed ? '展开' : '折叠') + '泳道" aria-expanded="' + !L.collapsed + '">' + (L.collapsed ? '+' : '−') + '</button>') +
          '<span class="rt-ln" role="link" tabindex="0" title="' + esc(nm + (a.model ? ' · ' + a.model : '') + (a.effort ? ' · ' + a.effort : '')) + '">' + esc(nm) + '</span>' + (L.running ? '<i class="rt-dot" title="在跑"></i>' : '') +
          '</span>' + (!L.collapsed && (fam || L.sentBy) ? '<span class="rt-lm">' + (fam ? agentChip(a.model, fam, a.effort) : '') + (L.sentBy ? '<span class="rt-by dim">由 ' + esc(L.sentBy) + ' 派出</span>' : '') + '</span>' : '');
      }
      b.style.top = (L.y + V.vy) + 'px';
    });
    V.labs.forEach((el, id) => { if (!want.has(id)) { el.remove(); V.labs.delete(id); } });
  }

  /* ---------------------------------------------------------------- tooltip */
  function tipHTML(nd) {
    const L = nd.items.slice(0, 8);
    const head = '<b>' + esc(nd.title) + '</b>' + (nd.kind === 'strip' ? ' <span class="dim">点击展开</span>' : nd.kind === 'group' ? ' <span class="dim">点击看明细，放大后自动拆开</span>' : '');
    return head + '<div class="dim">' + esc(fmtTS(nd.t0)) + (nd.t1 > nd.t0 ? ' → ' + esc(fmtClock(nd.t1)) : '') + ' · ' + nd.n + ' 项' + (nd.cost > 0 ? ' · ' + esc(fmtMoney(nd.cost)) : '') + '</div><ul>' +
      L.map(it => '<li><time>' + esc(fmtClock(it.ts)) + '</time><span class="rt-tn">' + esc(clip(it.name, 18)) + '</span><span class="rt-tx">' + esc(clip(it.why || it.sum, 70)) + '</span>' +
        (it.t1 > it.ts ? '<i>' + esc(fmtDur(it.t1 - it.ts)) + '</i>' : '') + (it.cost > 0 ? '<i>' + esc(fmtMoney(it.cost)) + '</i>' : '') +
        (it.st === 'err' || it.st === 'hook' ? '<em>' + (it.st === 'hook' ? '拦截' : '失败') + '</em>' : '') + '</li>').join('') + '</ul>' +
      (nd.n > 8 ? '<div class="dim">…还有 ' + (nd.n - 8) + ' 项</div>' : '');
  }
  function hideTip() { V.tipId = ''; tipEl.hidden = true; }
  vp.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || vp.classList.contains('panning')) return;
    const el = e.target.closest && e.target.closest('.rt-node, .rt-line');
    const nd = el && elOf(el.dataset.id);
    if (!nd) { if (V.tipId) hideTip(); return; }
    if (V.tipId !== nd.id) { V.tipId = nd.id; tipEl.innerHTML = tipHTML(nd); tipEl.hidden = false; }
    const r = vp.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 16;
    if (x + tw > r.width - 4) x = Math.max(4, e.clientX - r.left - tw - 14);
    if (y + th > r.height - 4) y = Math.max(4, e.clientY - r.top - th - 14);
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  });
  vp.addEventListener('pointerleave', hideTip);
  labsEl.addEventListener('click', e => {
    const lab = e.target.closest('.rt-lab');
    if (!lab) return;
    if (e.target.closest('.rt-tg')) {
      const L = V.model.laneById.get(lab.dataset.id);
      V.collapsed.set(L.id, !L.collapsed);
      V.needLay = true; schedule();
    } else if (e.target.closest('.rt-ln')) openAgent(lab.dataset.id);
  });
  labsEl.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('rt-ln')) { e.preventDefault(); openAgent(e.target.closest('.rt-lab').dataset.id); } });
  // the lane column scrolls the plot vertically too
  labsEl.addEventListener('wheel', e => { if (V.H <= vp.clientHeight + 1) return; e.preventDefault(); V.vy -= e.deltaY; RN.limit(V); schedule(); }, {passive: false});

  /* ---------------------------------------------------------------- frames, ticking, polling */
  function schedule() { V.dirty = true; if (!V.raf && V.active && !V.hidden) V.raf = requestAnimationFrame(frame); }
  function frame() {
    V.raf = 0;
    if (!V.active || V.hidden) return;
    if (V.needBuild) rebuild();
    if (!V.fitted && vp.clientWidth > 0 && V.model) fit();
    if (V.needAxis) rebuildAxis();
    if (V.needLay) relayout();
    if (V.dirty) { V.dirty = false; render(); }
  }
  const tick = setInterval(() => {
    if (V.hidden || !V.active) return;
    const t = now();
    container.querySelectorAll('.rt-tick').forEach(el => { el.textContent = fmtDur(Math.max(0, t - +el.dataset.t0)); });
    const srcEl = q('#rt-src');
    if (live && poller) srcEl.textContent = poller.state.mode === 'api' ? '实时：逐代理读取新步骤' : '实时：使用快照中的最近步骤';
    if (live && V.model) {
      // running nodes grow and the "now" line moves: lay out again (cheap); the idle bands are re-evaluated every 30 s
      if (Date.now() - V.axisAt > 30000) V.needAxis = true;
      V.needLay = true;
      schedule();
    }
  }, 1000);
  const poller = live ? rtLiveCreate({store, key, onChange: requestBuild}) : null;
  const onVis = () => {
    V.hidden = document.hidden;
    container.classList.toggle('rt-hidden', V.hidden);
    if (V.hidden) { if (poller) poller.stop(); cancelAnimationFrame(V.raf); V.raf = 0; }
    else if (V.active) { if (poller) poller.start(); V.needBuild = true; V.prevIds = null; schedule(); }
  };
  document.addEventListener('visibilitychange', onVis);
  const onResize = () => { V.mmBitmap = null; V.needLay = true; schedule(); };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(vp); else window.addEventListener('resize', onResize);
  const themeMq = window.matchMedia ? matchMedia('(prefers-color-scheme:dark)') : null;
  const onTheme = () => schedule();
  if (themeMq && themeMq.addEventListener) themeMq.addEventListener('change', onTheme);
  const themeObs = typeof MutationObserver === 'function' ? new MutationObserver(onTheme) : null;
  if (themeObs) themeObs.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'class']});

  /* ---------------------------------------------------------------- toolbar */
  container.querySelectorAll('.rt-seg button').forEach(b => {
    b.onclick = () => {
      V.gran = b.dataset.g;
      container.querySelectorAll('.rt-seg button').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
      V.prevIds = null;
      hideTip();
      rebuild();
    };
  });
  q('#rt-run').onchange = e => { V.onlyRunning = e.target.checked; V.needLay = true; schedule(); };
  q('#rt-sort').onchange = e => {
    V.sort = RM.SORT_KEYS.includes(e.target.value) ? e.target.value : 'start';
    try { localStorage.setItem(SORT_KEY, V.sort); } catch (err) { /* optional */ }
    V.vy = 0;
    requestBuild();
  };
  q('#rt-idle').onchange = e => { V.collapseIdle = e.target.checked; rebuildAxis(); fit(); };
  q('#rt-fold').onclick = e => {
    // Toggle between "every lane open" and "folded" for all sub-agent lanes; per-lane ▸/▾ still works afterwards.
    const open = e.currentTarget.dataset.open !== '1';
    V.model.lanes.forEach(L => { if (L.id !== V.model.rootId) V.collapsed.set(L.id, !open); });
    e.currentTarget.dataset.open = open ? '1' : '';
    e.currentTarget.textContent = open ? '折叠全部泳道' : '展开全部泳道';
    V.needLay = true; schedule();
  };
  q('#rt-fit').onclick = fit;
  followBtn.onclick = () => { setAuto(true); V.needLay = true; schedule(); };
  RN.bindInput(V, hooks);
  RN.bindMap(V, mapEl, hooks);

  rebuild();
  setAuto(live);
  if (vp.clientWidth > 0) fit();
  schedule();
  if (poller) poller.start();

  return {
    store, state: V,
    onLive(d) { if (poller) poller.onSnapshot(d); },
    setActive(on) {
      V.active = !!on;
      container.hidden = !on;
      if (!on) { if (poller) poller.stop(); cancelAnimationFrame(V.raf); V.raf = 0; return; }
      if (poller) poller.start();
      V.prevIds = null; V.needBuild = true; schedule();
    },
    destroy() {
      V.active = false;
      clearInterval(tick);
      if (poller) poller.stop();
      cancelAnimationFrame(V.raf);
      document.removeEventListener('visibilitychange', onVis);
      if (themeMq && themeMq.removeEventListener) themeMq.removeEventListener('change', onTheme);
      if (themeObs) themeObs.disconnect();
      if (ro) ro.disconnect(); else window.removeEventListener('resize', onResize);
    }
  };
}
