'use strict';
/* Overview, subagent list/detail and the hash router. */

function bar(label, val, max, cls, extra, color) {
  const w = max > 0 ? Math.max(val / max * 100, val > 0 ? 0.6 : 0) : 0;
  return '<div class="barrow"><div class="bl">' + label + '</div><div class="bt"><i class="' + (cls || '') + '" style="width:' + w + '%' + (color ? ';background:' + color : '') + '"></i></div><div class="bv">' + extra + '</div></div>';
}
function stat(label, value, sub) {
  return '<div class="stat"><div class="sl">' + label + '</div><div class="sv">' + value + '</div>' + (sub ? '<div class="ss">' + sub + '</div>' : '') + '</div>';
}
function pct(a, b) { return b > 0 ? Math.round(a / b * 100) + '%' : '-'; }

function catSection(by, totalCost) {
  const max = Math.max.apply(null, Object.keys(by).map(k => by[k].c));
  return Object.keys(CAT_LABEL).map(k => bar(CAT_LABEL[k], by[k].c, max, 'cat-' + k,
    '<b>' + fmtCost(by[k].c) + '</b> · ' + pct(by[k].c, totalCost) + ' · ' + by[k].n + ' 次调用' + (by[k].t ? ' · 工具耗时 ' + fmtDur(by[k].t) : ''))).join('');
}

function tokenCard(tok, rsn) {
  const tot = tok[0] + tok[1] + tok[2] + tok[3];
  const row = (label, v, cls) => bar(label, v, Math.max(tok[0], tok[1], tok[2], tok[3], 1), cls, '<b>' + fmtTok(v) + '</b> · ' + v.toLocaleString() + ' · ' + pct(v, tot));
  return '<h3>token 用量</h3>' + row('输入（未缓存）', tok[0], 'c-main') + row('缓存读取', tok[3], 'cat-read') +
    (tok[2] ? row('缓存写入', tok[2], 'cat-git') : '') + row('输出' + (rsn != null ? '（含推理）' : ''), tok[1], 'c-sub') +
    (rsn != null ? row('其中推理', rsn, 'cat-wait') : '');
}

function renderOverview(root) {
  const m = D.meta, T = D.totals;
  const fams = Object.keys(T.byFam).sort((x, y) => T.byFam[y] - T.byFam[x]);
  const famMax = Math.max.apply(null, fams.map(f => T.byFam[f] || 0).concat([0]));
  const topAgents = SUBS.slice().sort((x, y) => y.cost - x.cost).slice(0, 10);
  const priceNote = UNIT_TOKEN
    ? '<p class="note"><b>' + QL + '一栏显示 token 数</b>（输入不含缓存读取，加输出）：' + esc(TOOL_NAME) + ' 的模型还没有在 prices.json 里配置价格，所以没有折算额度。在 <code>prices.json</code> 的 <code>' + esc(TOOL) + '.models</code> 里按「输入 / 输出 / 缓存写入 / 缓存读取」填入每百万 token 的价格后重新生成即可按配置折算。</p>'
    : '<p class="note">额度为相对单位，用于比较，不是账单。按每百万 token：' + Object.keys(m.prices).map(f => esc(f) + ' 输入 ' + m.prices[f][0] + ' / 输出 ' + m.prices[f][1] + ' / 缓存写 ' + m.prices[f][2] + ' / 缓存读 ' + m.prices[f][3]).join('；') + '。</p>';
  root.innerHTML = '<h1>' + esc(m.name) + '</h1><p class="dim metaline">' + toolChip() + ' <span>' + fmtTS(m.start) + ' → ' + fmtTS(m.end) + '</span> <span>会话 <span class="mono">' + esc(m.sid) + '</span> ' + copyBtn(m.sid) + '</span>' + (m.project ? ' <span class="mono" title="' + esc(m.project) + '">' + esc(clip(m.project, 60)) + '</span>' : '') + '</p>' +
    (m.note ? '<p class="warn">' + esc(m.note) + '</p>' : '') +
    '<div class="stats">' +
    stat('总时长', fmtDur(m.end - m.start), '含等待用户的空闲时间') +
    stat('主代理步数', T.mainSteps, TOOL === 'codex' ? '一次模型响应算一步（按 token_count 切分）' : '按 message.id 去重') +
    stat('子代理', T.nsub, '含嵌套') +
    stat(UNIT_TOKEN ? '总 token（不含缓存读取）' : '总额度', fmtCost(T.cost), '主 ' + fmtCost(T.mainCost) + ' · 子 ' + fmtCost(T.subCost) + (UNIT_TOKEN ? ' · 未配置价格' : '')) +
    stat('上下文压缩', T.compacts.length, (T.compacts.slice(0, 3).map(c => trigLabel(c.trigger) + '，压缩前 ' + fmtTok(c.pre || 0)).join('；') + (T.compacts.length > 3 ? '；…等共 ' + T.compacts.length + ' 次' : '')) || '无') +
    stat('钩子拦截', T.hooks, TOOL === 'codex' ? '按输出文本识别（Codex 没有结构化的拦截记录）' : 'PreToolUse 拦截工具调用' + (T.stopBlocks ? ' · Stop 钩子拦截结束 ' + T.stopBlocks + ' 次' : '')) +
    stat('超过 60 秒的命令', fmtDur(T.longT), T.longN + ' 条前台命令' + (T.bgLongT ? ' · 另有后台命令累计 ' + fmtDur(T.bgLongT) + '（可能并行）' : '')) +
    '</div>' + priceNote +
    '<div class="cols"><section class="card"><h3>' + QL + '：主代理与子代理</h3>' +
    bar('主代理', T.mainCost, T.cost, 'c-main', '<b>' + fmtCost(T.mainCost) + '</b> · ' + pct(T.mainCost, T.cost)) +
    bar('子代理', T.subCost, T.cost, 'c-sub', '<b>' + fmtCost(T.subCost) + '</b> · ' + pct(T.subCost, T.cost)) +
    '<h3>' + QL + '：按模型</h3>' + fams.map(f => bar(famChip(f), T.byFam[f], famMax, '', '<b>' + fmtCost(T.byFam[f]) + '</b> · ' + pct(T.byFam[f], T.cost), famColor(f))).join('') +
    (T.tok ? tokenCard(T.tok, T.rsn) : '') +
    '</section><section class="card"><h3>' + QL + '：按活动类别</h3>' + catSection(T.byCat, T.cost) +
    '<p class="note">一步里有多个工具调用时，' + QL + '平均分给这些调用的类别；纯文字回复计入「其他」。</p></section></div>' +
    '<div class="cols"><section class="card"><h3>子代理（按模型和强度）</h3><table class="tbl"><tr><th>模型</th><th>强度</th><th>数量</th><th>' + QL + '</th></tr>' +
    T.groups.map(g => '<tr><td>' + famChip(modelFam(g.model)) + '</td><td>' + esc(g.effort) + '</td><td>' + g.n + '</td><td>' + fmtCost(g.cost) + '</td></tr>').join('') +
    '</table></section><section class="card"><h3>' + QL + '最高的子代理</h3><table class="tbl"><tr><th>任务</th><th>模型</th><th>步数</th><th>' + QL + '</th></tr>' +
    topAgents.map(a => '<tr><td>' + agentLink(a.id, clip(a.desc, 36)) + '</td><td>' + agentChip(a.model, a.fam, a.effort) + '</td><td>' + a.nsteps + '</td><td>' + fmtCost(a.cost) + '</td></tr>').join('') +
    '</table></section></div>';
}

function renderAgents(root) {
  root.innerHTML = '<h1>子代理（' + SUBS.length + '）</h1><div class="fbar"><label>排序 <select id="asort"><option value="start">开始时间（' + (newestFirst() ? '新的在前' : '旧的在前') + '）</option><option value="cost">' + QL + '（高到低）</option>' +
    '<option value="dur">时长（长到短）</option><option value="steps">步数（多到少）</option></select></label><input type="search" class="q" id="aq" placeholder="搜索任务名、模型…" aria-label="搜索子代理"><span class="fcount dim"></span></div>' +
    '<div class="tblwrap"><table class="tbl atbl"><thead><tr><th>任务</th><th>模型·强度</th><th class="hn">开始</th><th class="r">时长</th><th class="r">步数</th><th class="r">' + QL + '</th><th class="r hn">测试检查</th><th class="r hn">等待</th><th class="r hn">拦截</th></tr></thead><tbody></tbody></table></div>' +
    '<div class="empty" id="aempty" hidden><b>没有符合条件的子代理</b><span>换个关键词试试。</span></div>';
  const body = root.querySelector('tbody'), sel = root.querySelector('#asort'), q = root.querySelector('#aq'), cnt = root.querySelector('.fcount');
  function draw() {
    const key = sel.value, kw = q.value.trim().toLowerCase();
    const dir = newestFirst() ? -1 : 1;
    const val = {start: a => dir * a.start, cost: a => -a.cost, dur: a => -(a.end - a.start), steps: a => -a.nsteps}[key];
    const list = SUBS.filter(a => !kw || (a.desc + ' ' + a.model + ' ' + a.effort).toLowerCase().indexOf(kw) >= 0).sort((x, y) => val(x) - val(y));
    body.innerHTML = list.map(a => '<tr><td style="padding-left:' + (8 + (a.depth - 1) * 14) + 'px">' + agentLink(a.id, clip(a.desc, 60)) + (a.bg ? ' <span class="dim">后台</span>' : '') + '</td><td>' + agentChip(a.model, a.fam, a.effort) +
      '</td><td class="hn t">' + fmtTS(a.start) + '</td><td class="r num">' + fmtDur(a.end - a.start) + '</td><td class="r num">' + a.nsteps + '</td><td class="r num">' + fmtCost(a.cost) + '</td><td class="r num hn">' + (a.stats.testT ? fmtDur(a.stats.testT) : '') +
      '</td><td class="r num hn">' + (a.stats.waitT ? fmtDur(a.stats.waitT) : '') + '</td><td class="r num hn">' + (a.stats.hooks || '') + '</td></tr>').join('');
    cnt.textContent = list.length + ' / ' + SUBS.length;
    root.querySelector('#aempty').hidden = list.length > 0 || !SUBS.length;
    if (!SUBS.length) body.innerHTML = '<tr><td colspan="9">' + emptyState('这个会话没有子代理') + '</td></tr>';
  }
  sel.addEventListener('change', draw);
  q.addEventListener('input', draw);
  draw();
}

function agentStats(a) {
  const peak = Math.max.apply(null, [0].concat(allCalls(a).map(x => x.s.ctx)));
  const dur = a.end - a.start;
  return '<div class="stats">' + stat('步数', a.nsteps, a.nsteps ? '平均每步 ' + fmtCost(a.cost / a.nsteps) : '') + stat('时长', fmtDur(dur), fmtTS(a.start) + ' → ' + fmtTS(a.end)) +
    stat(QL, fmtCost(a.cost), '占总' + QL + ' ' + pct(a.cost, D.totals.cost)) + stat('上下文峰值', fmtTok(peak)) +
    stat('测试检查', fmtDur(a.stats.testT), pct(a.stats.testT, dur) + ' 的时长') + stat('等待与轮询', fmtDur(a.stats.waitT), pct(a.stats.waitT, dur) + ' 的时长') +
    stat('超过 60 秒的命令', fmtDur(a.stats.longT), a.stats.longN + ' 条') + stat('钩子拦截', a.stats.hooks) + '</div>';
}

function renderAgent(root, id, jump) {
  const a = A[id];
  if (!a) { root.innerHTML = '<p class="warn">没有这个代理：' + esc(id) + '</p>'; return; }
  const title = id === 'main' ? '主代理逐轮回看' : a.desc;
  let h = '<p class="crumb"><a href="#' + (id === 'main' ? 'overview' : 'agents') + '">← ' + (id === 'main' ? '总览' : '子代理列表') + '</a>' +
    (a.parent && a.parent !== 'main' && A[a.parent] ? ' · 上级：' + agentLink(a.parent) : id !== 'main' ? ' · 上级：' + agentLink('main', '主代理') : '') + '</p>';
  h += '<h1>' + esc(title) + '</h1>';
  if (id !== 'main') {
    h += '<p class="meta">' + agentChip(a.model, a.fam, a.effort) + ' <span class="dim">' + (a.bg ? '后台' : '前台') + ' · 嵌套深度 ' + a.depth + (a.type ? ' · ' + esc(a.type) : '') + ' · id <span class="mono">' + esc(a.id) + '</span></span> ' + copyBtn(a.id) +
      (a.wt ? ' <span class="dim mono" title="' + esc(a.wt) + '">worktree ' + esc(clip(a.wt, 50)) + '</span>' : '') + '</p>';
  }
  h += agentStats(a);
  h += '<div class="card"><h3>' + QL + '：按活动类别</h3>' + catSection(a.byCat, a.cost) + tokenCard(a.tok, a.rsn) + '</div>';
  if (id !== 'main') {
    h += '<section class="card"><h3>简报 ' + (a.briefing ? copyBtn(a.briefing) : '') + '</h3>' + (a.reason ? clampBlock(a.reason, 'reasonline', 2) : TOOL === 'codex' ? '' : '<p class="dim">简报里没有以「选档理由：」开头的行。</p>') +
      clampBlock(a.briefing, 'brief', 4) + '</section>';
  }
  h += '<h2>逐步回看</h2><div id="stepsroot"></div>';
  if (id !== 'main') {
    const src = {handback: '来自 SubagentHandback 调用', lasttext: TOOL === 'codex' ? '取该线程最后一条不带工具调用的回复' : '没有 SubagentHandback，取最后一段文字', lastmsg: '取该线程最后一轮的 last_agent_message'}[a.reportSrc] || '没有找到交回报告';
    h += '<section class="card"><h3>交回报告 <span class="dim">（' + src + '）</span> ' + (a.report ? copyBtn(a.report) : '') + '</h3>' + (a.report ? clampBlock(a.report, 'report', 6) : '<p class="dim">无</p>') + '</section>';
  }
  if (a.children.length) {
    h += '<section class="card"><h3>嵌套派出的子代理（' + a.children.length + '）</h3><table class="tbl"><tr><th>任务</th><th>模型</th><th>步数</th><th>' + QL + '</th></tr>' +
      a.children.map(c => A[c]).filter(Boolean).map(c => '<tr><td>' + agentLink(c.id, clip(c.desc, 60)) + '</td><td>' + agentChip(c.model, c.fam, c.effort) + '</td><td>' + c.nsteps + '</td><td>' + fmtCost(c.cost) + '</td></tr>').join('') + '</table></section>';
  }
  root.innerHTML = h;
  renderSteps(a, root.querySelector('#stepsroot'), jump);
  fitClamps(root);
}

