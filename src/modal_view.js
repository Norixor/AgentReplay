'use strict';
/* Detail dialog, markup part: HTML for the four kinds of content (see modal_model.js for the specs). The step markup reuses the
 * fragments of the replay list (steps.js: detailWhyHTML / detailCallHTML / detailTokHTML, statusHTML, durHTML) so that the
 * dialog and the replay page always show the same facts. */

/* A clickable reference to an agent / step inside markup: an anchor that keeps a real href for middle click and copy link. */
function mdAgentRef(id, label) {
  const a = A[id];
  if (!a) return esc(label || id);
  return '<a class="alink" href="#' + (id === 'main' ? 'main' : 'agent/' + esc(id)) + '"' + mdAttr({type: 'agent', agent: id}) + '>' + esc(label || mdName(id)) + '</a>';
}

/* ---- one step */
function mdStepTool(s) {
  const c = s.calls[0];
  if (!c) return '<span class="tool cat-other">回复</span>';
  return '<span class="tool cat-' + esc(c.cat) + '">' + esc(c.name) + '</span>' + (s.calls.length > 1 ? ' <span class="dim">+' + (s.calls.length - 1) + '</span>' : '');
}

/* The facts line of a step: time, tool, duration, status, amount. */
function mdStepFacts(s) {
  const c = s.calls[0];
  return '<div class="md-facts"><span><i>时间</i><b>' + esc(fmtTS(s.ts)) + '</b></span><span><i>工具</i>' + mdStepTool(s) + '</span>' +
    '<span><i>耗时</i>' + (c ? durHTML(c) : '<span class="dim">-</span>') + '</span><span><i>结果</i>' + statusHTML(c) + '</span>' +
    '<span><i>金额 / token</i>' + stepCostHTML(s, {inline: true}) + '</span></div>';
}

/* Full body of a step: why, every call (input, result, dispatch target, hook reason), tokens. */
function mdStepBody(a, s) {
  const h = [detailWhyHTML(s, s.calls[0])];
  if (!s.calls.length) h.push(pre('回复全文', s.says));
  s.calls.forEach((c, i) => {
    if (s.calls.length > 1) h.push('<h4 class="md-callh">调用 ' + (i + 1) + ' / ' + s.calls.length + ' · <span class="tool cat-' + esc(c.cat) + '">' + esc(c.name) + '</span> ' + statusHTML(c) + ' ' + durHTML(c) + '</h4>');
    if (i > 0 && c.desc) h.push('<div class="dim">描述：' + esc(c.desc) + '</div>');
    h.push(detailCallHTML(c));
  });
  h.push(detailTokHTML(s));
  return h.join('');
}

function mdStepHTML(r) {
  return '<p class="dim md-in">' + (r.a.id === 'main' ? '主代理' : '子代理 ' + mdAgentRef(r.a.id)) + ' · 第 ' + (r.ti + 1) + ' 轮 · ' + esc(EV_LABEL[r.t.trig.k] || r.t.trig.k) + '触发</p>' +
    mdStepFacts(r.s) + '<div class="md-step">' + mdStepBody(r.a, r.s) + '</div>';
}

/* ---- a list of steps, each expandable in place (the body is filled when it is opened, see modal.js) */
const mdKey = (id, n) => id + '|' + n;

function mdStepRow(it, showAgent, open) {
  const s = it.s, c = s.calls[0];
  const sum = c ? c.sum : clip(firstLine(s.says), 160);
  return '<details class="md-st st-' + (c ? esc(c.st) : 'ok') + '" data-k="' + esc(mdKey(it.a.id, s.n)) + '" data-ag="' + esc(it.a.id) + '" data-sn="' + s.n + '"' + (open ? ' open' : '') + '><summary>' +
    '<span class="md-t">' + fmtClock(s.ts) + '<small>#' + s.n + '</small></span>' + (showAgent ? '<span class="md-ag" title="' + esc(mdName(it.a.id)) + '">' + esc(clip(mdName(it.a.id), 18)) + '</span>' : '') +
    '<span class="md-tl">' + mdStepTool(s) + '</span><span class="md-sum" title="' + esc(clip(c && c.inp ? c.inp : sum, 600)) + '">' + esc(clip(firstLine(sum), 140)) + '</span>' +
    '<span class="md-d">' + (c ? durHTML(c) : '') + '</span><span class="md-c">' + stepCostHTML(s, {unit: false}) + '</span><span class="md-s">' + statusHTML(c) + '</span></summary>' +
    '<div class="md-sb">' + (open ? mdStepBody(it.a, s) : '') + '</div></details>';
}

function mdStepList(items, openKeys) {
  if (!items.length) return '<p class="dim">没有步骤。</p>';
  const multi = items.some(it => it.a.id !== items[0].a.id);
  return '<div class="md-list' + (multi ? ' md-multi' : '') + '">' + items.map(it => mdStepRow(it, multi, !!openKeys && openKeys.has(mdKey(it.a.id, it.s.n)))).join('') + '</div>';
}

function mdStepsHTML(r) {
  if (!r.items.length) return '<p class="dim">' + (r.total ? '这些步骤在回看数据里都找不到（可能还没更新）。' : '这一段里没有记录到步骤。') + '</p>';
  const sum = sumSteps(r.items.map(it => it.s));
  const t0 = Math.min.apply(null, r.items.map(it => it.s.ts)), t1 = Math.max.apply(null, r.items.map(it => it.s.end || it.s.ts));
  return '<p class="dim md-in">' + r.items.length + ' 步 · ' + fmtTS(t0) + ' → ' + fmtClock(t1) + ' · 预估金额 ' + costHTML(sum.cost, sum.tok, {inline: true}) + '</p>' +
    (r.missing ? '<p class="warn">另有 ' + r.missing + ' 步在回看数据里找不到。</p>' : '') +
    (r.capped ? '<p class="warn">只列出前 ' + MD_MAX_STEPS + ' 步，共 ' + r.total + ' 步。</p>' : '') + mdStepList(r.items);
}

/* ---- a turn: the trigger in full, the events in it and its steps */
function mdTurnHTML(r) {
  const tr = r.t.trig, a = r.a;
  const text = tr.k === 'brief' && !tr.text ? a.briefing : tr.text;
  const sum = sumSteps(r.t.steps);
  let head = '';
  if (tr.k === 'handback' && A[tr.from]) head = '<p>子代理 ' + mdAgentRef(tr.from) + ' 交回了报告</p>';
  else if (tr.k === 'notify' && A[tr.task]) head = '<p>' + mdAgentRef(tr.task, '→ 看这个子代理') + '</p>';
  else if (tr.k === 'compact') head = '<p>压缩前 ' + fmtTok(tr.pre || 0) + ' token（' + trigLabel(tr.trigger) + '）</p>';
  return '<p class="md-in"><span class="badge b-' + esc(tr.k) + '">' + esc(EV_LABEL[tr.k] || tr.k) + '</span> <time>' + fmtTS(tr.ts) + '</time> · ' +
    r.t.steps.length + ' 步 · 预估金额 ' + costHTML(sum.cost, sum.tok, {inline: true}) + '</p>' + head +
    pre('触发事件全文', text || '', '', true) + (r.t.evs.length ? '<div class="blk"><h5>这一轮里的其他事件（' + r.t.evs.length + '）</h5>' + r.t.evs.map(evLine).join('') + '</div>' : '') +
    '<h3 class="md-sh">这一轮的步骤</h3>' + mdStepList(r.t.steps.map(s => ({a, s, t: r.t, ti: r.ti})));
}

/* ---- an agent summary; the head and the recent list are repainted separately by the live refresh */
function mdAgentHead(a) {
  const f = mdAgentFacts(a), isMain = a.id === 'main';
  return '<div class="md-chips">' + (isMain ? '' : agentChip(a.model, a.fam, a.effort) + ' <span class="dim">' + (a.bg ? '后台' : '前台') + (a.type ? ' · ' + esc(a.type) : '') + '</span> ') +
    (isMain ? '' : '<b>状态</b> ' + sxStatusHTML(a, true)) + '</div>' +
    '<div class="stats md-stats">' + stat('开始 → 结束', esc(fmtTS(a.start)), '→ ' + esc(fmtTS(a.end))) + stat('时长', fmtDur(f.dur)) + stat('步数', a.nsteps) +
    usageStat('预估金额', '<span title="' + esc(tokTitle(a.tok)) + '">' + moneyH(a.cost) + '</span>', fmtTok(tokSum(a.tok)) + ' token') + (noUsage() && !f.peak ? '' : stat('上下文峰值', fmtTok(f.peak))) + '</div>';
}

function mdAgentRecent(a, openKeys) {
  return '<h3 class="md-sh">最近 ' + MD_RECENT + ' 步（新的在前）</h3>' + mdStepList(mdRecent(a, MD_RECENT), openKeys);
}

function mdFold(title, text, cls) {
  return text ? '<details class="md-fold"><summary>' + esc(title) + '</summary>' + clampBlock(text, cls, 6) + '</details>' : '';
}

function mdAgentHTML(r) {
  const a = r.a, isMain = a.id === 'main';
  let by = null;
  try { by = timeByCategory(a); } catch (e) { by = null; }
  const kids = (a.children || []).map(c => A[c]).filter(Boolean);
  const parent = !isMain && a.parent && A[a.parent] ? a.parent : (!isMain ? 'main' : null);
  return (parent ? '<p class="dim md-in">由 ' + mdAgentRef(parent) + ' 派出</p>' : '') +
    '<div data-md-live="head">' + mdAgentHead(a) + '</div><div class="md-ls lsbar" id="md-ls"></div>' +
    '<div class="md-cols"><section class="card"><h3>时间：按类别</h3>' + (by ? timeCatBars(by) : '<p class="dim">没有可统计的时间。</p>') + '</section>' +
    (kids.length ? '<section class="card"><h3>派出的子代理（' + kids.length + '）</h3><ul class="md-kids">' + kids.map(c => '<li>' + agentChip(c.model, c.fam, c.effort) + ' ' + mdAgentRef(c.id, clip(c.desc, 50)) +
      ' <span class="dim">' + c.nsteps + ' 步' + (noUsage() ? '' : ' · ' + moneyH(c.cost)) + '</span></li>').join('') + '</ul></section>' : '') + '</div>' +
    (isMain ? '' : mdFold('简报（全文）', a.briefing, 'brief') + mdFold('交回报告（全文）', a.report, 'report')) +
    '<div data-md-live="recent">' + mdAgentRecent(a) + '</div>';
}

/* The content of one layer: {title, html}. A spec that cannot be resolved gives a friendly message, never an exception. */
function mdRender(spec) {
  let r;
  try { r = mdResolve(spec); } catch (e) { r = {ok: false, msg: '这项内容暂时无法显示。'}; }
  if (!r.ok) return {title: '无法显示', html: emptyState('找不到这项内容', r.msg), r};
  try {
    const html = {step: mdStepHTML, steps: mdStepsHTML, turn: mdTurnHTML, agent: mdAgentHTML}[r.type](r);
    return {title: r.title, html, r};
  } catch (e) {
    return {title: r.title, html: emptyState('这项内容渲染失败', String(e && e.message || e)), r: Object.assign({}, r, {ok: false})};
  }
}
