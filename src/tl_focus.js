'use strict';
/* Single-agent timeline view, route #timeline/agent/<id>: header, previous / next navigation, the zoomable chart and
 * the time analysis. Painting is in tl_focus_draw.js, the statistics in tl_focus_stats.js, the numbers in timeseg.js. */

const focusHash = id => '#timeline/agent/' + encodeURIComponent(id);

/* Agent order of the timeline rows (respecting its filters); an agent hidden by a filter falls back to the full order. */
function focusOrder(id) {
  const ids = tlRows().map(r => r.a.id);
  if (ids.includes(id)) return ids;
  const subs = SUBS.slice().sort((x, y) => x._s - y._s);
  return ['main'].concat((newestFirst() ? subs.reverse() : subs).map(a => a.id));
}

function focusHandback(a) {
  if (a.id === 'main') return '主代理';
  const src = {handback: 'SubagentHandback', lasttext: '取最后一段文字', lastmsg: 'last_agent_message'}[a.reportSrc];
  if (src) return '已交回（' + src + '）';
  return isRunning(a) ? '运行中' : '没有找到交回报告';
}

function focusHeader(a, order) {
  const i = order.indexOf(a.id), prev = i > 0 ? A[order[i - 1]] : null, next = i >= 0 && i < order.length - 1 ? A[order[i + 1]] : null;
  const nb = (ag, text) => ag ? '<a class="btn" href="' + focusHash(ag.id) + '" title="' + esc(ag.desc) + '">' + text + '</a>' : '<a class="btn off" aria-disabled="true">' + text + '</a>';
  const peak = Math.max.apply(null, [0].concat(allCalls(a).map(x => x.s.ctx)));
  const par = a.id !== 'main' ? (A[a.parent] || MAIN) : null;
  return '<nav class="tf-nav" aria-label="单代理视图导航"><a class="btn" href="#timeline">← 返回全部</a><span class="tf-sp"></span>' +
    nb(prev, '← 上一个') + '<span class="tf-pos">' + (i + 1) + ' / ' + order.length + '</span>' + nb(next, '下一个 →') + '</nav>' +
    '<div class="tf-title">' + agentChip(a.model, a.fam, a.effort) + '<h1>' + esc(a.id === 'main' ? '主代理' : a.desc) + '</h1></div>' +
    '<p class="dim tf-meta">' + toolChip() + ' ' + (par ? '由 <a href="' + focusHash(par.id) + '">' + esc(par.id === 'main' ? '主代理' : clip(par.desc, 40)) + '</a> 派出（' + (a.bg ? '后台' : '前台') + (a.type ? ' · ' + esc(a.type) : '') + '）' : '会话的主代理') +
    ' · <a href="' + jumpHash(a.id) + '">在回看中打开详情 →</a></p>' +
    '<div class="stats tf-stats">' + stat('时长', fmtDur(a._e - a._s), fmtTS(a._s) + ' → ' + fmtTS(a._e)) + stat('步数', a.nsteps) +
    usageStat('预估金额', '<span title="' + esc(tokTitle(a.tok)) + '">' + moneyH(a.cost) + '</span>', fmtTok(tokSum(a.tok)) + ' token · 输出 ' + fmtTok(a.tok.out) + ' · 缓存读 ' + fmtTok(a.tok.cr) + (a.nUnp ? ' · ' + a.nUnp + ' 步未定价' : '')) + (noUsage() && !peak ? '' : stat('上下文峰值', fmtTok(peak))) +
    stat('交回状态', esc(focusHandback(a))) + stat('模型 · 强度', esc(a.model || a.fam) + (a.effort ? ' · ' + esc(a.effort) : '')) + '</div>';
}

function focusLegend(F) {
  const mk = {hook: '钩子拦截', fail: '失败调用', compact: '上下文压缩', merge: '合入主线'};
  return F.L.lanes.map(k => '<span><i class="sw" style="background:' + TS_CATS[k].color + '"></i>' + esc(TS_CATS[k].label) + '</span>').join('') +
    '<span class="lg-sep"></span>' +
    Object.keys(mk).filter(k => F.L.marks.some(m => m.kind === k)).map(k => '<span class="lg-mk"><svg width="12" height="12" viewBox="0 0 12 12" class="mk-' + k + '">' +
      {compact: '<path d="M6 1 11 6 6 11 1 6z"/>', merge: '<path d="M6 1 11 10H1z"/>', hook: '<path d="M2 2l8 8M10 2l-8 8" stroke-width="2" fill="none"/>',
        fail: '<circle cx="6" cy="6" r="3.2" fill="none" stroke-width="1.6"/>'}[k] + '</svg>' + mk[k] + '</span>').join('') +
    (F.L.kids.length ? '<span><i class="sw sw-link"></i>派单连线</span>' : '');
}

function focusLabels(F) {
  const T = F.T, total = Math.max(1, T.T1 - T.T0);
  return F.L.rows.map(r => {
    const st = 'top:' + r.y + 'px;height:' + r.h + 'px';
    if (r.kind === 'lane') return '<div class="tf-lab" style="' + st + '" title="' + esc(TS_CATS[r.cat].label + ' ' + fmtDur(T.by[r.cat])) + '"><i class="sw" style="background:' + TS_CATS[r.cat].color + '"></i><span class="nm">' +
      esc(TS_CATS[r.cat].label) + '</span><span class="pc">' + pct(T.by[r.cat], total) + '</span></div>';
    if (r.kind === 'calls') return '<div class="tf-lab" style="' + st + '">工具调用</div>';
    if (r.kind === 'marks') return '<div class="tf-lab" style="' + st + '">标记</div>';
    if (r.kind === 'sec') return '<div class="tf-lab sec" style="' + st + '">' + esc(r.label) + '</div>';
    const ch = A[r.sp.id];
    return '<div class="tf-lab" style="' + st + '" title="' + esc(ch ? ch.desc : r.sp.id) + '">' + (ch ? '<a href="' + focusHash(ch.id) + '">' + esc(clip(ch.desc, 30)) + '</a> <button type="button" class="md-mini"' + mdAttr({type: 'agent', agent: ch.id}) + ' title="在弹窗里查看这个子代理的概要">概要</button>' : esc(r.sp.id)) + '</div>';
  }).join('');
}

function focusTip(F, h, ev) {
  const a = F.a, T = F.T;
  if (h.kind === 'mark') return tlTip(null, {kind: 'mark', row: {a}, mark: h.mark}, ev);
  let html;
  if (h.kind === 'child') {
    const sp = h.sp, ch = A[sp.id];
    html = '<b>' + esc(ch ? ch.desc : sp.id) + '</b><br>' + (ch ? agentChip(ch.model, ch.fam, ch.effort) + ' ' : '') + fmtTS(sp.t0) + ' → ' + fmtClock(sp.t1) + '<br>运行 ' + fmtDur(sp.t1 - sp.t0) +
      (ch ? ' · ' + ch.nsteps + ' 步' : '') + '<br><span class="dim">' + (ch ? '点击切换到这个子代理的视图 · Shift+点击看概要' : '回看数据里没有这个代理') + '</span>';
  } else if (h.kind === 'block') {
    const c = h.bl.c;
    html = '<b>' + esc(TS_CATS[h.bl.cat].label) + '</b> · ' + (c.bg ? '后台启动 ' : '') + fmtDur(c.dur) + ' · ' + fmtTS(c.ts) + ' → ' + fmtClock(c.ts + (c.dur || 0)) + '<br><span class="mono">' + esc(c.name) + '</span> ' + esc(clip(c.desc || c.sum, 160)) +
      (c.st === 'hook' ? '<br><span class="bad">被钩子拦截</span>' : c.st === 'err' ? '<br><span class="bad">失败</span>' : '') +
      (c.bg && c.bgDone ? '<br><span class="dim">后台运行到 ' + fmtClock(c.bgDone) + '（' + fmtDur(c.bgDone - c.ts) + '）</span>' : '') + '<br><span class="dim">步骤 #' + h.bl.s.n + ' · 点击查看这一步</span>';
  } else {
    const sg = h.seg, why = focusReason(a, T, sg), s = sg.s || (sg.stepIdx != null && T.flat[sg.stepIdx].s);
    html = '<b>' + esc(TS_CATS[sg.cat].label) + '</b> · ' + fmtDur(sg.t1 - sg.t0) + '<br>' + fmtTS(sg.t0) + ' → ' + fmtClock(sg.t1) + (why ? '<br>' + esc(why) : '') +
      '<br><span class="dim">' + (s ? '步骤 #' + s.n + ' · ' : '') + '点击在弹窗里查看</span>';
  }
  showTip(html, ev);
}

/* Jump from a time-segment to the replay: the step it belongs to, or the turn when the agent was waiting for a message. */
function focusJump(a, T, sg) {
  const s = sg.s || (sg.stepIdx != null && T.flat[sg.stepIdx] && T.flat[sg.stepIdx].s);
  if (sg.cat === 'user') jumpTo(a.id, sg.t1, true);
  else if (s) jumpTo(a.id, sg.c ? sg.c.ts : Math.max(sg.t0, s.ts), false, s.n);
  else jumpTo(a.id, sg.t0);
}

function renderTimelineFocus(root, id) {
  const a = A[id];
  if (!a) { root.innerHTML = '<p class="crumb"><a href="#timeline">← 返回全部</a></p><p class="warn">没有这个代理：' + esc(id) + '</p>'; return; }
  timelineModel();
  const T = timeSegData(a), order = focusOrder(id);
  root.innerHTML = focusHeader(a, order) + '<div id="tf-main"></div><div class="tf-sec" id="tf-stats"></div>';
  const main = root.querySelector('#tf-main');
  if (T.T1 <= T.T0) {
    main.innerHTML = emptyState('这个代理没有可画的时间范围', '会话里没有记录到它的开始和结束时间。');
    return;
  }
  const F = {a, T, L: focusLayout(a, T), v0: T.T0, v1: T.T1, plotW: 800, full: [T.T0, T.T1]};
  const pad = (T.T1 - T.T0) * 0.01;
  F.full = [T.T0 - pad, T.T1 + pad];
  F.v0 = F.full[0]; F.v1 = F.full[1];
  main.innerHTML = '<div class="tlbar"><div class="btns"><button data-b="out">缩小</button><button data-b="in">放大</button><button data-b="l">← 左移</button><button data-b="r">右移 →</button><button data-b="all">整个生命周期</button></div></div>' +
    '<div class="legend">' + focusLegend(F) + '</div>' +
    '<p class="dim tf-hint">每一行是一个时间类别，互不重叠；捏合或 Ctrl/⌘ + 滚轮缩放，拖动或左右滑动平移，双击放大。点击任意一块在弹窗里查看对应的步骤；点击下方的迷你横条切换到那个子代理的视图，Shift+点击或点名称旁的「概要」弹出它的概要。</p>' +
    '<div class="tf-chart"><div class="tf-axis"><div class="tf-lab">时间</div><div class="tf-axp"><canvas id="tf-ax" aria-label="时间轴"></canvas></div></div>' +
    '<div class="tf-body" id="tf-body"><div class="tf-labs" id="tf-labs"></div><div class="tf-plotw"><canvas id="tf-cv" aria-label="单代理时间线"></canvas></div></div></div>';
  const $q = s => root.querySelector(s);
  F.cv = $q('#tf-cv');
  F.axisCv = $q('#tf-ax');
  const body = $q('#tf-body'), labs = $q('#tf-labs'), plotw = $q('.tf-plotw');
  body.style.height = F.L.H + 'px';
  labs.style.height = F.L.H + 'px';
  labs.innerHTML = focusLabels(F);
  renderFocusStats(a, T, $q('#tf-stats'));

  let raf = 0, drag = null, moved = false;
  function paint() {
    raf = 0;
    F.plotW = Math.max(120, Math.floor(plotw.clientWidth));
    focusPaint(F);
    focusPaintAxis(F);
  }
  const schedule = () => { if (!raf) { raf = 1; frame(paint); } };
  function setView(x, y) {
    const maxSpan = F.full[1] - F.full[0], span = Math.min(Math.max(y - x, Math.min(200, maxSpan)), maxSpan);
    x = Math.min(Math.max(x, F.full[0]), F.full[1] - span);
    F.v0 = x; F.v1 = x + span;
    schedule();
  }
  const zoom = (f, cx) => { const sp = F.v1 - F.v0, at = F.v0 + sp * cx, ns = sp * f; setView(at - ns * cx, at + ns * (1 - cx)); };
  const frac = e => { const r = F.cv.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const hitAt = e => { const r = F.cv.getBoundingClientRect(); return focusHit(F, e.clientX - r.left, e.clientY - r.top); };

  $q('.btns').addEventListener('click', e => {
    const b = e.target.dataset.b, sp = F.v1 - F.v0;
    if (b === 'in') zoom(.5, .5); else if (b === 'out') zoom(2, .5); else if (b === 'all') setView(F.full[0], F.full[1]);
    else if (b === 'l') setView(F.v0 - sp * .4, F.v1 - sp * .4); else if (b === 'r') setView(F.v0 + sp * .4, F.v1 + sp * .4);
  });
  F.cv.addEventListener('pointerdown', e => { if (e.button) return; drag = {x: e.clientX, v0: F.v0, v1: F.v1}; moved = false; hideTip(); });
  const onMove = e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 4) moved = true;
    if (moved) { const d = -dx / F.plotW * (drag.v1 - drag.v0); setView(drag.v0 + d, drag.v1 + d); }
  };
  const onUp = () => { drag = null; setTimeout(() => { moved = false; }, 0); };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  F.cv.addEventListener('mousemove', e => {
    if (drag && moved) return;
    const h = hitAt(e);
    F.cv.style.cursor = h ? 'pointer' : 'grab';
    if (h) focusTip(F, h, e); else hideTip();
  });
  F.cv.addEventListener('mouseleave', hideTip);
  F.cv.addEventListener('dblclick', e => zoom(.4, frac(e)));
  F.cv.addEventListener('click', e => {
    if (moved) return;
    const h = hitAt(e);
    if (!h) return;
    if (h.kind === 'seg') focusJump(a, T, h.seg);
    else if (h.kind === 'block') jumpTo(a.id, h.bl.c.ts, false, h.bl.s.n);
    else if (h.kind === 'child') { if (A[h.sp.id]) { if (e.shiftKey) showDetail({type: 'agent', agent: h.sp.id}); else location.hash = focusHash(h.sp.id); } }
    else {
      const m = h.mark;
      if (m.kind === 'hook' || m.kind === 'fail') jumpTo(a.id, m.c.ts, false, m.s.n);
      else if (m.kind === 'merge') jumpTo(a.id, m.c.ts, a.id === 'main', a.id === 'main' ? null : m.s.n);
      else jumpTo(a.id, m.ts, true);
    }
  });
  F.cv.addEventListener('wheel', e => {
    // Pinch (ctrl+wheel on macOS) and ⌘/Ctrl+wheel zoom in proportion to the gesture, so a trackpad pinch is smooth;
    // shift+wheel and horizontal swipes pan; a plain vertical swipe is left to the page.
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(Math.min(2, Math.max(.5, Math.exp(e.deltaY * (e.ctrlKey ? .01 : .0025)))), frac(e)); }
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); const d = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, sp = F.v1 - F.v0; setView(F.v0 + sp * d / 800, F.v1 + sp * d / 800); }
  }, {passive: false});
  const ro = new ResizeObserver(schedule);
  ro.observe(plotw);
  VIEW_CLEANUP.push(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    ro.disconnect();
  });
  paint();
}
