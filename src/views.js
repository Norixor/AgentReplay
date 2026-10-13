'use strict';
/* Overview: totals, estimated amount (main/sub-agents, models, activity categories), tokens, time by category. */

function bar(label, val, max, cls, extra, color) {
  const w = max > 0 ? Math.max(val / max * 100, val > 0 ? 0.6 : 0) : 0;
  return '<div class="barrow"><div class="bl">' + label + '</div><div class="bt"><i class="' + (cls || '') + '" style="width:' + w + '%' + (color ? ';background:' + color : '') + '"></i></div><div class="bv">' + extra + '</div></div>';
}
function stat(label, value, sub) {
  return '<div class="stat"><div class="sl">' + label + '</div><div class="sv">' + value + '</div>' + (sub ? '<div class="ss">' + sub + '</div>' : '') + '</div>';
}
function pct(a, b) { return b > 0 ? Math.round(a / b * 100) + '%' : '-'; }

/* The value column of an amount bar: amount, tokens (breakdown on hover) and the share of the total. */
function moneyExtra(c, tok, total) { return costHTML(c, tok, {inline: true}) + ' · ' + pct(c, total); }

function catSection(by, totalCost) {
  const max = Math.max.apply(null, Object.keys(by).map(k => by[k].c));
  return Object.keys(CAT_LABEL).map(k => bar(CAT_LABEL[k], by[k].c, max, 'cat-' + k,
    moneyExtra(by[k].c, by[k].tok, totalCost) + ' · ' + by[k].n + ' 次调用' + (by[k].t ? ' · 工具耗时 ' + fmtDur(by[k].t) : ''))).join('');
}

function tokenCard(tok) {
  const tot = tokSum(tok);
  const max = Math.max(tok.in, tok.cw5, tok.cw1, tok.cr, tok.out, 1);
  const row = (label, v, cls) => bar(label, v, max, cls, '<b>' + fmtTok(v) + '</b> · ' + fmtTokFull(v) + ' · ' + pct(v, tot));
  return '<h3>token 用量（合计 ' + fmtTok(tot) + '）</h3>' + row('未缓存输入', tok.in, 'c-main') + row('缓存读取', tok.cr, 'cat-read') +
    (tok.cw5 || !tok.cw1 ? row('缓存写入（5 分钟）', tok.cw5, 'cat-git') : '') + (tok.cw1 ? row('缓存写入（1 小时）', tok.cw1, 'cat-git') : '') +
    row('输出' + (tok.rsn != null ? '（含推理）' : ''), tok.out, 'c-sub') + (tok.rsn != null ? row('其中推理', tok.rsn, 'cat-wait') : '');
}

/* Footnote of the whole page: where the prices come from and what the amounts mean. */
function priceFootnote() {
  const p = D.meta.pricing || {}, src = /^https?:\/\//.test(p.source || '') ? p.source : '';
  return '<p class="note price-note">金额按官方 API 标价估算（' + esc(p.readDate || '未知日期') + ' 读取' + (src ? '，<a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer">出处</a>' : '') +
    '）；订阅套餐（如 Claude Max、ChatGPT 套餐）不按 token 计费，金额只用于比较和定位成本。</p>' +
    (p.rules && p.rules.length ? '<details class="note"><summary>计价规则（' + esc(TOOL_NAME) + '）</summary><ul>' + p.rules.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul></details>' : '');
}

function renderOverview(root) {
  const m = D.meta, T = D.totals;
  const fams = Object.keys(T.byFam).sort((x, y) => T.byFam[y].c - T.byFam[x].c || T.byFam[y].n - T.byFam[x].n);
  const famMax = Math.max.apply(null, fams.map(f => T.byFam[f].c).concat([0]));
  const topAgents = SUBS.slice().sort((x, y) => y.cost - x.cost).slice(0, 10);
  const unp = unpricedNote(T);
  root.innerHTML = '<h1>' + esc(m.name) + '</h1><p class="dim metaline">' + toolChip() + ' <span>' + fmtTS(m.start) + ' → ' + fmtTS(m.end) + '</span> <span>会话 <span class="mono">' + esc(m.sid) + '</span> ' + copyBtn(m.sid) + '</span>' + (m.project ? ' <span class="mono" title="' + esc(m.project) + '">' + esc(clip(m.project, 60)) + '</span>' : '') + '</p>' +
    (m.note ? '<p class="warn">' + esc(m.note) + '</p>' : '') +
    '<div class="stats">' +
    stat('总时长', fmtDur(m.end - m.start), '含等待用户的空闲时间') +
    stat('主代理步数', T.mainSteps, TOOL === 'codex' ? '一次模型响应算一步（按 token_count 切分）' : '按 message.id 去重') +
    stat('子代理', T.nsub, '含嵌套') +
    stat('预估金额', '<span title="' + esc(tokTitle(T.tok)) + '">' + moneyH(T.cost) + '</span>', '主 ' + moneyH(T.mainCost) + ' · 子 ' + moneyH(T.subCost) + ' · ' + fmtTok(tokSum(T.tok)) + ' token') +
    stat('上下文压缩', T.compacts.length, (T.compacts.slice(0, 3).map(c => trigLabel(c.trigger) + '，压缩前 ' + fmtTok(c.pre || 0)).join('；') + (T.compacts.length > 3 ? '；…等共 ' + T.compacts.length + ' 次' : '')) || '无') +
    stat('钩子拦截', T.hooks, TOOL === 'codex' ? '按输出文本识别（Codex 没有结构化的拦截记录）' : 'PreToolUse 拦截工具调用' + (T.stopBlocks ? ' · Stop 钩子拦截结束 ' + T.stopBlocks + ' 次' : '')) +
    stat('超过 60 秒的命令', fmtDur(T.longT), T.longN + ' 条前台命令' + (T.bgLongT ? ' · 另有后台命令累计 ' + fmtDur(T.bgLongT) + '（可能并行）' : '')) +
    '</div>' + (unp ? '<p class="warn">' + unp + '。</p>' : '') +
    '<div class="cols"><section class="card"><h3>金额：主代理与子代理</h3>' +
    bar('主代理', T.mainCost, T.cost, 'c-main', moneyExtra(T.mainCost, T.mainTok, T.cost)) +
    bar('子代理', T.subCost, T.cost, 'c-sub', moneyExtra(T.subCost, T.subTok, T.cost)) +
    '<h3>金额：按模型</h3>' + fams.map(f => bar(famChip(f), T.byFam[f].c, famMax, '', moneyExtra(T.byFam[f].c, T.byFam[f].tok, T.cost), famColor(f))).join('') +
    '</section><section class="card">' + tokenCard(T.tok) + '</section></div>' +
    '<div class="cols"><section class="card"><h3>金额：按活动类别</h3>' + catSection(T.byCat, T.cost) +
    '<p class="note">一步里有多个工具调用时，金额和 token 平均分给这些调用的类别；纯文字回复计入「其他」。</p></section>' +
    timeCatCard() + '</div>' +
    '<div class="cols"><section class="card"><h3>子代理（按模型和强度）</h3><table class="tbl"><tr><th>模型</th><th>强度</th><th>数量</th><th class="r">预估金额</th></tr>' +
    T.groups.map(g => '<tr><td>' + famChip(modelFam(g.model)) + '</td><td>' + esc(g.effort) + '</td><td>' + g.n + '</td><td class="cellcost">' + costHTML(g.cost, g.tok) + '</td></tr>').join('') +
    '</table></section><section class="card"><h3>预估金额最高的子代理</h3><table class="tbl"><tr><th>任务</th><th>模型</th><th>步数</th><th class="r">预估金额</th></tr>' +
    topAgents.map(a => '<tr><td>' + agentLink(a.id, clip(a.desc, 36)) + '</td><td>' + agentChip(a.model, a.fam, a.effort) + '</td><td>' + a.nsteps + '</td><td class="cellcost">' + costHTML(a.cost, a.tok) + '</td></tr>').join('') +
    '</table></section></div>' + priceFootnote();
}
