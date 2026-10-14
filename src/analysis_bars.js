'use strict';
/* Time-analysis tab: the colour card ("where the time went"), the stacked category bars, the two-layer critical-path bar
 * and the legend-driven highlighting. Every bar colours its pieces with the classes `tsc tsc-<category>` (analysis.css),
 * so one highlighted category can dim all other pieces of the page by a single attribute on the page host (data-hl). */

const ANA_LBL_PCT = 0.05, ANA_LBL_NAME = 0.13;  // share of a bar from which a piece shows its percentage / also its name

/* {category: ms} -> {total, rows}: the categories with time, largest first (ties in TS_ORDER order); frac is the share
 * of the sum, which is the agent's lifetime for one agent's segmentation. */
function anaCatRows(by) {
  const total = TS_ORDER.reduce((m, k) => m + (by[k] > 0 ? by[k] : 0), 0);
  const rows = TS_ORDER.filter(k => by[k] > 0).map(k => ({k, ms: by[k], frac: total ? by[k] / total : 0}));
  rows.sort((x, y) => (y.ms - x.ms) || (TS_ORDER.indexOf(x.k) - TS_ORDER.indexOf(y.k)));
  return {total, rows};
}

/* Time per category on the critical path (the merged pieces, before tiny ones are joined for drawing). */
function anaPathCats(path) {
  const by = {};
  path.merged.forEach(p => { by[p.cat] = (by[p.cat] || 0) + (p.t1 - p.t0); });
  return by;
}

/* Upper layer of the critical-path bar: consecutive blocks of one agent joined into a run. The shade alternates per run,
 * so two neighbouring runs always differ even when an agent comes back later (main -> child -> main). */
function anaPathAgentRuns(blocks) {
  const out = [];
  blocks.forEach(b => {
    const l = out[out.length - 1];
    if (l && l.agentId === b.agentId) { l.t1 = b.t1; l.d += b.d; l.n++; return; }
    out.push({agentId: b.agentId, t0: b.t0, t1: b.t1, d: b.d, n: 1, shade: out.length % 2});
  });
  return out;
}

/* Label tier of a piece of a bar by its share: 2 name and percentage, 1 percentage only, 0 colour only. */
function anaLabelTier(frac) { return frac >= ANA_LBL_NAME ? 2 : frac >= ANA_LBL_PCT ? 1 : 0; }

const anaCatCls = k => 'tsc tsc-' + k;
const anaSwatch = k => '<i class="ana-sw ' + anaCatCls(k) + '" aria-hidden="true"></i>';
const anaPctText = f => (f >= 0.995 ? '100%' : f >= 0.095 ? Math.round(f * 100) + '%' : f >= 0.001 ? (f * 100).toFixed(1) + '%' : '<0.1%');

/* A 100 % stacked bar of category rows. opts.big writes names / percentages into wide pieces; opts.cls is the bar class. */
function anaStackHTML(cr, opts) {
  const o = opts || {};
  return '<div class="' + (o.cls || 'ana-stack') + '" role="img" aria-label="' + esc(o.aria || cr.rows.map(r => TS_CATS[r.k].label + ' ' + anaPctText(r.frac)).join('，')) + '">' +
    cr.rows.map(r => {
      const tier = o.big ? anaLabelTier(r.frac) : 0, tip = TS_CATS[r.k].label + ' · ' + fmtDur(r.ms) + ' · ' + anaPctText(r.frac);
      const lab = tier ? '<span class="ana-sl">' + (tier > 1 ? '<b>' + esc(TS_CATS[r.k].label) + '</b> ' : '') + anaPctText(r.frac) + '</span>' : '';
      return '<span class="ana-sseg ' + anaCatCls(r.k) + (tier === 2 && r.frac < 0.3 ? ' ana-nm-s' : '') + (tier === 1 && r.frac < 0.1 ? ' ana-lo' : '') + '" data-cat="' + r.k + '" style="flex:' + (r.frac * 1000).toFixed(3) + ' 1 0" title="' + esc(tip) + '">' + lab + '</span>';
    }).join('') + '</div>';
}

/* The colour card: one row per category with time. compact (critical path) leaves out the meaning and the share bar. */
function anaKeyHTML(cr, opts) {
  const o = opts || {}, top = cr.rows.length ? cr.rows[0].ms : 1;
  return '<ul class="ana-key' + (o.compact ? ' ana-key-c' : '') + '" aria-label="' + esc(o.aria || '类别颜色对照表') + '">' + cr.rows.map(r => {
    const c = TS_CATS[r.k];
    const body = o.compact
      ? anaSwatch(r.k) + '<span class="ana-kn">' + esc(c.label) + '</span><span class="ana-kv">' + fmtDur(r.ms) + ' · ' + anaPctText(r.frac) + '</span>'
      : anaSwatch(r.k) + '<span class="ana-kn">' + esc(c.label) + '</span><span class="ana-kh">' + esc(c.hint || '') + '</span><span class="ana-kv"><b>' + fmtDur(r.ms) + '</b> ' + anaPctText(r.frac) +
        '</span><span class="ana-kb" aria-hidden="true"><i class="' + anaCatCls(r.k) + '" style="width:' + Math.max(1, r.ms / top * 100).toFixed(2) + '%"></i></span>';
    return '<li><button type="button" class="ana-krow" data-cat="' + r.k + '" aria-pressed="false" title="高亮「' + esc(c.label) + '」：' + esc(c.hint || '') + '">' + body + '</button></li>';
  }).join('') + '</ul>';
}

/* "Where the time went": the scope's wall clock split into categories, as one bar and the full colour card. */
function anaWhereHTML(d) {
  const cr = anaCatRows(d.root.T.by), multi = d.scope.rows.length > 1;
  if (!cr.rows.length) return '';
  return '<section class="card ana-where"><h3>时间去哪了 <span class="dim">· 总时长 ' + fmtDur(cr.total) + '</span></h3>' +
    '<p class="note">' + (multi ? '按' + (d.scope.rootId === 'main' ? '主代理' : '这个代理') + '的墙钟时间切分：子代理在跑而它在等的时间算「等子代理」，' : '') + '各类别互不重叠，加起来等于总时长。悬停或点对照表里的一行，页面上所有横条只突出这一类；再点一次或按 Esc 取消。</p>' +
    anaStackHTML(cr, {big: true, cls: 'ana-stack ana-stack-big', aria: '时间去哪了：' + cr.rows.map(r => TS_CATS[r.k].label + ' ' + fmtDur(r.ms) + ' ' + anaPctText(r.frac)).join('，')}) +
    anaKeyHTML(cr) + '</section>';
}

/* Two layers: who the chain runs through (neutral shades + agent names) above what it was doing (category colours).
 * The category pieces are links: a click opens the steps of that piece in the dialog (analysis.js). */
function anaPathBarHTML(P, blocks) {
  const total = Math.max(1, P.total), grow = d => (d / total * 1000).toFixed(3);
  const runs = anaPathAgentRuns(blocks).map(r => {
    const w = r.d / total, tip = anaName(r.agentId) + ' · ' + fmtDur(r.d) + ' · ' + fmtClock(r.t0) + ' → ' + fmtClock(r.t1);
    return '<span class="ana-arun ana-sh' + r.shade + '" style="flex:' + grow(r.d) + ' 1 0" title="' + esc(tip) + '">' + (w >= 0.06 ? '<span>' + esc(clip(anaName(r.agentId), 18)) + '</span>' : '') + '</span>';
  }).join('');
  const segs = blocks.map(b => {
    const w = b.d / total, c = TS_CATS[b.cat];
    const tip = anaName(b.agentId) + ' · ' + c.label + ' · ' + fmtDur(b.d) + (b.parts > 1 ? '（' + b.parts + ' 小段合并）' : '') + ' · ' + fmtClock(b.t0);
    return '<a class="ana-seg ' + anaCatCls(b.cat) + '" data-cat="' + b.cat + '" href="' + focusHash(b.agentId) + '"' + anaSegAttr(b.agentId, b.t0, b.t1, b.cat) + ' style="flex:' + grow(b.d) + ' 1 0" title="' + esc(tip) + '" aria-label="' + esc(tip) + '">' +
      (w >= 0.08 ? '<span>' + esc(c.label) + '</span>' : '') + '</a>';
  }).join('');
  return '<div class="ana-pbar"><div class="ana-play ana-pag" aria-hidden="true">' + runs + '</div>' +
    '<div class="ana-play ana-pcat" role="group" aria-label="关键路径分段横条，按类别">' + segs + '</div></div>';
}

/* Composition cell of the per-agent table: the agent's own lifetime by category. */
function anaMixCell(by) {
  const cr = anaCatRows(by || {});
  return '<td class="ana-mixc">' + (cr.rows.length ? anaStackHTML(cr, {cls: 'ana-mix'}) : '<span class="dim">—</span>') + '</td>';
}

/* ---- highlighting: hover / focus previews a category, a click pins it (aria-pressed), a second click or Esc unpins.
 * Only an attribute on the host changes; the CSS dims the pieces of the other categories (no re-render, no layout change). */
function anaHlApply(host) {
  const k = host.dataset.hlPreview || host.dataset.hlPin || '';
  if (k) host.dataset.hl = k; else delete host.dataset.hl;
  host.querySelectorAll('.ana-krow').forEach(b => b.setAttribute('aria-pressed', b.dataset.cat === host.dataset.hlPin ? 'true' : 'false'));
}
function anaHlPin(host, k) {
  if (k && host.dataset.hlPin !== k) host.dataset.hlPin = k; else delete host.dataset.hlPin;
  anaHlApply(host);
}
function anaHlBind(host) {
  const row = e => e.target.closest && e.target.closest('.ana-krow');
  const preview = k => { if (k) host.dataset.hlPreview = k; else delete host.dataset.hlPreview; anaHlApply(host); };
  host.addEventListener('mouseover', e => { const r = row(e); if (r) preview(r.dataset.cat); });
  host.addEventListener('mouseout', e => { const r = row(e); if (r && !r.contains(e.relatedTarget)) preview(''); });
  host.addEventListener('focusin', e => { const r = row(e); if (r) preview(r.dataset.cat); });
  host.addEventListener('focusout', e => { if (row(e)) preview(''); });
  host.addEventListener('click', e => { const r = row(e); if (r) anaHlPin(host, r.dataset.cat); });
  // Esc works wherever the focus is (also on the page body); the listener goes away once this page host is replaced.
  const esc = e => {
    if (!host.isConnected) { document.removeEventListener('keydown', esc); return; }
    if (e.key !== 'Escape' || !host.dataset.hlPin || document.querySelector('[aria-modal="true"]')) return;
    delete host.dataset.hlPreview;
    anaHlPin(host, '');
  };
  document.addEventListener('keydown', esc);
}
