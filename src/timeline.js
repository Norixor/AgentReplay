'use strict';
/* Timeline view controller: toolbar, filters, overview + axis + plot canvases, zoom/pan/select and click-through. */

const TLP = {collapse: true, mode: 'model', model: '', running: false, min2: false,
  kinds: {user: true, compact: true, hook: true, merge: true, fail: true, back: true}, rowH: 26, ovH: 62};
let TLS = null;

function isRunning(a) {
  if (a.id === 'main') return true;
  const ref = D.meta.active ? Date.now() : D.meta.end;
  return ref - a._e < 5 * 60 * 1000;
}

function tlRows() {
  const subs = SUBS.filter(a => (!TLP.model || modelFam(a.model || a.fam) === TLP.model || a.fam === TLP.model || a.model === TLP.model) &&
    (!TLP.running || isRunning(a)) && (!TLP.min2 || a._e - a._s >= 120000));
  const sorted = subs.slice().sort((x, y) => x._s - y._s);
  const list = [MAIN].concat(newestFirst() ? sorted.reverse() : sorted);
  const M = timelineModel();
  return list.map(a => ({a, row: M.rows[a.id]}));
}

function tlLegend() {
  const kinds = Object.keys(MK).map(k => '<button type="button" class="lg-mk' + (TLP.kinds[k] ? '' : ' off') + '" data-k="' + k + '" aria-pressed="' + TLP.kinds[k] + '"><svg width="12" height="12" viewBox="0 0 12 12" class="mk-' + k + '">' +
    {user: '<circle cx="6" cy="6" r="4"/>', compact: '<path d="M6 1 11 6 6 11 1 6z"/>', merge: '<path d="M6 1 11 10H1z"/>', back: '<path d="M1 2h10L6 10z"/>',
      hook: '<path d="M2 2l8 8M10 2l-8 8" stroke-width="2" fill="none"/>', fail: '<circle cx="6" cy="6" r="3.2" fill="none" stroke-width="1.6"/>'}[k] + '</svg>' + MK[k].t + '</button>').join('');
  const base = TLP.mode === 'model'
    ? famList().map(f => '<span><i class="sw" style="background:' + famColor(f) + '"></i>' + esc(f) + '</span>').join('') +
      '<span><i class="sw seg-test"></i>超过 60 秒·测试检查</span><span><i class="sw seg-wait"></i>超过 60 秒·等待</span><span><i class="sw seg-long"></i>超过 60 秒·其他</span>'
    : CAT_KEYS.map(k => '<span><i class="sw" style="background:var(--c-' + k + ')"></i>' + esc(CAT_LABEL[k]) + '</span>').join('') +
      '<span><i class="sw" style="background:var(--think)"></i>思考或输出（无工具调用）</span>';
  return base + '<span><i class="sw sw-bg"></i>后台命令</span><span><i class="sw sw-link"></i>派单连线</span>' + (D.meta.active ? '<span><i class="sw sw-now"></i>现在</span>' : '') +
    '<span class="lg-sep"></span>' + kinds;
}

function tlTip(S, h, ev) {
  const a = h.row.a;
  let html = '';
  if (h.kind === 'mark') {
    const m = h.mark, name = '<b>' + MK[m.kind].t + '</b> · ' + esc(clip(a.desc, 40)) + ' · ' + fmtTS(m.ts) + '<br>';
    if (m.kind === 'user') html = name + esc(clip(m.e.text, 120));
    else if (m.kind === 'compact') html = name + '压缩前 ' + fmtTok(m.e.pre || 0) + ' token（' + trigLabel(m.e.trigger) + '）';
    else if (m.kind === 'back') html = name + esc(m.child.desc) + ' 交回报告（' + fmtDur(m.child._e - m.child._s) + '，' + m.child.nsteps + ' 步）';
    else if (m.kind === 'hook') html = name + esc(m.c.name) + '：' + esc(clip(m.c.hook, 200));
    else if (m.kind === 'merge') html = name + esc(clip(m.c.sum, 160)) + '<br><span class="dim">' + esc(m.c.merge) + '</span>';
    else html = name + esc(m.c.name) + '：' + esc(clip(m.c.sum, 120)) + (m.c.res ? '<br><span class="dim">' + esc(clip(firstLine(m.c.res), 120)) + '</span>' : '');
  } else if (h.kind === 'seg' || h.kind === 'bg') {
    const sg = h.seg, c = sg.c;
    html = '<b>' + (h.kind === 'bg' ? '后台 ' : '') + esc(CAT_LABEL[c.cat] || c.cat) + '</b> · ' + fmtDur(sg.b - sg.a) + ' · ' + fmtTS(sg.a) + '<br>' +
      '<span class="mono">' + esc(c.name) + '</span> ' + esc(clip(c.desc || c.sum, 160)) + '<br><span class="dim">步骤 #' + sg.s.n + ' · 点击跳到这一步</span>';
  } else {
    html = '<b>' + esc(a.desc) + '</b><br>' + agentChip(a.model, a.fam, a.effort) + ' ' + fmtTS(a._s) + ' → ' + fmtClock(a._e) +
      '<br>时长 ' + fmtDur(a._e - a._s) + ' · ' + QL + ' ' + fmtCost(a.cost) + ' · ' + a.nsteps + ' 步<br>测试检查 ' + fmtDur(a.stats.testT) + ' · 等待 ' + fmtDur(a.stats.waitT);
  }
  showTip(html, ev);
}

function renderTimeline(root) {
  const M = timelineModel();
  const nSub = SUBS.length;
  root.innerHTML = '<div class="tlbar" role="toolbar" aria-label="时间线"><div class="btns"><button data-b="out">缩小</button><button data-b="in">放大</button><button data-b="l">← 左移</button><button data-b="r">右移 →</button>' +
    '<button data-b="all">整个会话</button></div>' +
    '<div class="seg-ctl" role="group" aria-label="着色方式"><button data-mode="model" aria-pressed="' + (TLP.mode === 'model') + '">按模型</button><button data-mode="act" aria-pressed="' + (TLP.mode === 'act') + '">按活动</button></div>' +
    '<label class="chk"><input type="checkbox" id="tl-collapse"' + (TLP.collapse ? ' checked' : '') + '> 折叠空闲</label></div>' +
    '<div class="tlbar tlf"><label>模型 <select id="tl-model"><option value="">全部</option>' + famList().map(f => '<option value="' + esc(f) + '"' + (TLP.model === f ? ' selected' : '') + '>' + esc(f) + '</option>').join('') + '</select></label>' +
    '<label class="chk"><input type="checkbox" id="tl-run"' + (TLP.running ? ' checked' : '') + '> 只看在跑的</label>' +
    '<label class="chk"><input type="checkbox" id="tl-min2"' + (TLP.min2 ? ' checked' : '') + '> 隐藏少于 2 分钟的代理</label><span class="dim" id="tl-count"></span></div>' +
    '<div class="legend" id="tl-legend"></div>' +
    '<p class="dim tl-hint">Ctrl/⌘ + 滚轮缩放，拖动平移，双击放大；在上方曲线上拖动选区可缩放到这一段；点击横条或标记进入对应的一步。</p>' +
    '<div class="tl"><div class="tl-ov"><div class="tl-lab ov-lab">概览</div><div class="tl-ovp"><canvas id="tl-ov" aria-label="概览曲线"></canvas></div></div>' +
    '<div class="tl-axis"><div class="tl-lab" id="tl-axlab">代理</div><div class="tl-axp"><canvas id="tl-ax"></canvas></div></div>' +
    '<div class="tl-body" id="tl-body"><div class="tl-labs" id="tl-labs"></div><div class="tl-plotw"><canvas id="tl-cv" aria-label="时间线"></canvas></div></div></div>';
  const $q = s => root.querySelector(s);
  const S = TLS = {W: null, v0: 0, v1: 1, plotW: 800, plotH: 300, off: 0, rows: [], rowOf: {}, RH: TLP.rowH, mode: TLP.mode, kinds: TLP.kinds, links: [],
    cv: $q('#tl-cv'), axisCv: $q('#tl-ax'), ovCv: $q('#tl-ov'), ovH: TLP.ovH, cols: null, catColor: [], now: 0, sel: null, ovData: null, full: [0, 1]};
  const body = $q('#tl-body'), labs = $q('#tl-labs'), plotw = $q('.tl-plotw');
  let raf = 0, labRange = [-1, -1];

  function setWarp(reset) {
    S.W = buildWarp(TLP.collapse);
    S.ovData = buildOverviewData(S.W);
    const pad = S.W.VT * 0.01;
    S.full = [-pad, S.W.VT + pad];
    if (reset) { S.v0 = S.full[0]; S.v1 = S.full[1]; }
  }
  function setRows() {
    S.rows = tlRows();
    S.rowOf = {};
    S.rows.forEach((r, i) => { S.rowOf[r.a.id] = i; });
    S.links = [];
    S.rows.forEach(r => { const d = M.disp[r.a.id]; if (d && S.rowOf[d.parent] != null) S.links.push({parent: d.parent, ts: d.ts, child: r.a}); });
    $q('#tl-count').textContent = '显示 ' + (S.rows.length - 1) + ' / ' + nSub + ' 个子代理';
    $q('#tl-axlab').textContent = '代理（主代理在首行，其余' + (newestFirst() ? '新的在上' : '旧的在上') + '）';
    body.style.height = S.rows.length * S.RH + 'px';
    labRange = [-1, -1];
  }
  function geom() {
    const top = (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topH')) || 44) + 26;
    S.plotW = Math.max(120, Math.floor(plotw.clientWidth));
    const bodyH = S.rows.length * S.RH;
    S.plotH = Math.max(S.RH * 2, Math.min(bodyH, innerHeight - top - 6));
    plotw.style.setProperty('--ph', S.plotH + 'px');
    plotw.style.setProperty('--st', top + 'px');
    const bt = body.getBoundingClientRect().top;
    S.off = Math.max(0, Math.min(bodyH - S.plotH, top - bt));
    if (!S.cols || S.cols.length !== S.plotW * 8) S.cols = new Float32Array(S.plotW * 8);
    S.now = D.meta.active ? Date.now() : 0;
    S.catColor = CAT_KEYS.map(k => cssVar('--c-' + k)).concat([cssVar('--c-other')]);
    S.catColor[1] = cssVar('--seg-test'); S.catColor[4] = cssVar('--seg-wait'); S.catColor[7] = cssVar('--seg-long');
  }
  function layoutLabels() {
    const first = Math.max(0, Math.floor(S.off / S.RH) - 2), last = Math.min(S.rows.length - 1, Math.ceil((S.off + S.plotH) / S.RH) + 2);
    if (labRange[0] === first && labRange[1] === last) return;
    labRange = [first, last];
    let h = '';
    for (let i = first; i <= last; i++) {
      const a = S.rows[i].a, ind = a.id === 'main' ? 0 : Math.max(0, (a.depth || 1) - 1);
      h += '<div class="tl-lab" style="top:' + i * S.RH + 'px;padding-left:' + (6 + ind * 12) + 'px" title="' + esc(a.desc) + '">' +
        (ind ? '<span class="tl-ind">└</span>' : '') + '<a href="' + jumpHash(a.id) + '">' + agentChip(a.model, a.fam, a.effort) + ' ' + esc(clip(a.desc, 36)) + '</a>' +
        '<button class="zoomto" data-z="' + esc(a.id) + '" title="缩放到这个代理" aria-label="缩放到这个代理">⌖</button></div>';
    }
    labs.innerHTML = h;
  }
  function paint() {
    raf = 0;
    geom();
    layoutLabels();
    const lg = $q('#tl-legend');
    if (lg.dataset.mode !== TLP.mode) { lg.innerHTML = tlLegend(); lg.dataset.mode = TLP.mode; }
    S.mode = TLP.mode;
    paintPlot(S);
    paintAxis(S);
    paintOverview(S);
  }
  const schedule = () => { if (!raf) { raf = 1; frame(paint); } };
  function setView(a, b) {
    const minSpan = Math.min(2000, S.W.VT), maxSpan = S.full[1] - S.full[0];
    const span = Math.min(Math.max(b - a, minSpan), maxSpan);
    a = Math.min(Math.max(a, S.full[0]), S.full[1] - span);
    S.v0 = a; S.v1 = a + span;
    schedule();
  }
  const zoom = (f, cx) => { const sp = S.v1 - S.v0, at = S.v0 + sp * cx, ns = sp * f; setView(at - ns * cx, at + ns * (1 - cx)); };
  const frac = e => { const r = S.cv.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const zoomAgent = id => {
    const a = A[id], v0 = S.W.r2v(a._s), v1 = S.W.r2v(Math.max(a._e, a._s + 1000)), pd = Math.max((v1 - v0) * .08, 3000);
    setView(v0 - pd, v1 + pd);
  };

  setWarp(true);
  setRows();
  $q('#tl-legend').innerHTML = tlLegend();
  $q('#tl-legend').dataset.mode = TLP.mode;

  root.querySelector('.btns').addEventListener('click', e => {
    const b = e.target.dataset.b, sp = S.v1 - S.v0;
    if (b === 'in') zoom(.5, .5); else if (b === 'out') zoom(2, .5); else if (b === 'all') setView(S.full[0], S.full[1]);
    else if (b === 'l') setView(S.v0 - sp * .4, S.v1 - sp * .4); else if (b === 'r') setView(S.v0 + sp * .4, S.v1 + sp * .4);
  });
  root.querySelector('.seg-ctl').addEventListener('click', e => {
    const m = e.target.dataset.mode;
    if (!m) return;
    TLP.mode = m;
    root.querySelectorAll('.seg-ctl button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    schedule();
  });
  $q('#tl-collapse').addEventListener('change', e => { TLP.collapse = e.target.checked; setWarp(true); schedule(); });
  $q('#tl-model').addEventListener('change', e => { TLP.model = e.target.value; setRows(); schedule(); });
  $q('#tl-run').addEventListener('change', e => { TLP.running = e.target.checked; setRows(); schedule(); });
  $q('#tl-min2').addEventListener('change', e => { TLP.min2 = e.target.checked; setRows(); schedule(); });
  $q('#tl-legend').addEventListener('click', e => {
    const b = e.target.closest('.lg-mk');
    if (!b) return;
    TLP.kinds[b.dataset.k] = !TLP.kinds[b.dataset.k];
    b.classList.toggle('off', !TLP.kinds[b.dataset.k]);
    b.setAttribute('aria-pressed', String(TLP.kinds[b.dataset.k]));
    schedule();
  });
  labs.addEventListener('click', e => { const z = e.target.closest('[data-z]'); if (z) zoomAgent(z.dataset.z); });

  /* plot interactions */
  let drag = null, moved = false, ovDrag = null;
  S.cv.addEventListener('pointerdown', e => { if (e.button) return; drag = {x: e.clientX, v0: S.v0, v1: S.v1}; moved = false; hideTip(); });
  function onMove(e) {
    if (drag) {
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 4) moved = true;
      if (moved) { const d = -dx / S.plotW * (drag.v1 - drag.v0); setView(drag.v0 + d, drag.v1 + d); }
    }
    if (ovDrag) { const r = S.ovCv.getBoundingClientRect(); S.sel = [ovDrag.x0, Math.min(S.plotW, Math.max(0, e.clientX - r.left))]; schedule(); }
  }
  function onUp() {
    drag = null;
    if (ovDrag) {
      const sel = S.sel;
      ovDrag = null;
      S.sel = null;
      if (sel && Math.abs(sel[1] - sel[0]) > 6) {
        const a = Math.min(sel[0], sel[1]), b = Math.max(sel[0], sel[1]), sp = S.v1 - S.v0;
        setView(S.v0 + a / S.plotW * sp, S.v0 + b / S.plotW * sp);
      } else schedule();
    }
    setTimeout(() => { moved = false; }, 0);
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  S.cv.addEventListener('mousemove', e => {
    if (drag && moved) return;
    const r = S.cv.getBoundingClientRect(), h = hitTest(S, e.clientX - r.left, e.clientY - r.top);
    S.cv.style.cursor = h && h.kind !== 'bar' ? 'pointer' : 'grab';
    if (h) tlTip(S, h, e); else {
      const t = xt(S, e.clientX - r.left), gp = S.W.pieces.find(p => p.gap && p.r0 <= t && t <= p.r1);
      if (gp) showTip('<b>空闲 ' + fmtIdle(gp.r1 - gp.r0) + '</b><br>' + fmtTS(gp.r0) + ' → ' + fmtTS(gp.r1) + '<br><span class="dim">所有代理都没有活动，已折叠</span>', e); else hideTip();
    }
  });
  S.cv.addEventListener('mouseleave', hideTip);
  S.cv.addEventListener('dblclick', e => zoom(.4, frac(e)));
  S.cv.addEventListener('click', e => {
    if (moved) return;
    const r = S.cv.getBoundingClientRect(), h = hitTest(S, e.clientX - r.left, e.clientY - r.top);
    if (!h) return;
    const aid = h.row.a.id;
    if (h.kind === 'mark') {
      const m = h.mark;
      if (m.kind === 'hook' || m.kind === 'fail') jumpTo(aid, m.c.ts, false, m.s.n);
      else if (m.kind === 'merge') jumpTo(aid, m.c.ts, aid === 'main', aid === 'main' ? null : m.s.n);
      else jumpTo(aid, m.ts, true);
    } else if (h.kind === 'seg' || h.kind === 'bg') jumpTo(aid, h.seg.c.ts, false, h.seg.s.n);
    else jumpTo(aid, h.t);
  });
  S.cv.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) { e.preventDefault(); zoom(e.deltaY > 0 ? 1.25 : .8, frac(e)); }
    else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { e.preventDefault(); const sp = S.v1 - S.v0; setView(S.v0 + sp * e.deltaX / 800, S.v1 + sp * e.deltaX / 800); }
  }, {passive: false});

  /* overview: drag a range to zoom the timeline to it */
  S.ovCv.addEventListener('pointerdown', e => {
    if (e.button) return;
    const r = S.ovCv.getBoundingClientRect();
    ovDrag = {x0: e.clientX - r.left};
    S.sel = [ovDrag.x0, ovDrag.x0];
    hideTip();
  });
  S.ovCv.addEventListener('mousemove', e => {
    if (ovDrag) return;
    const r = S.ovCv.getBoundingClientRect();
    showTip(ovTip(S, e.clientX - r.left), e);
  });
  S.ovCv.addEventListener('mouseleave', hideTip);

  window.addEventListener('scroll', schedule, {passive: true});
  const ro = new ResizeObserver(schedule);
  ro.observe(plotw);
  const timer = D.meta.active ? setInterval(schedule, 5000) : 0;
  VIEW_CLEANUP.push(() => {
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    ro.disconnect();
    clearInterval(timer);
    TLS = null;
  });
  paint();
}
