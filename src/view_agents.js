'use strict';
/* Sub-agent list (with live status), agent detail and the main agent's replay header. */

const SX_FILTERS = [['all', '全部'], ['run', '在跑'], ['done', '已交回']];

function renderAgents(root) {
  root.innerHTML = '<h1>子代理（' + SUBS.length + '）</h1><div class="fbar"><span class="sx-seg" role="group" aria-label="按状态筛选" id="asx"></span>' +
    '<label>排序 <select id="asort"><option value="start">开始时间（' + (newestFirst() ? '新的在前' : '旧的在前') + '）</option><option value="cost">预估金额（高到低）</option>' +
    '<option value="dur">时长（长到短）</option><option value="steps">步数（多到少）</option></select></label><input type="search" class="q" id="aq" placeholder="搜索任务名、模型…" aria-label="搜索子代理"><span class="fcount dim"></span></div>' +
    '<div class="tblwrap"><table class="tbl atbl"><thead><tr><th>任务</th><th>模型·强度</th><th>状态</th><th class="hn">开始</th><th class="r">时长</th><th class="r">步数</th><th class="r">预估金额</th><th class="r hn">测试检查</th><th class="r hn">等待</th><th class="r hn">拦截</th></tr></thead><tbody></tbody></table></div>' +
    '<div class="empty" id="aempty" hidden><b>没有符合条件的子代理</b><span>换个关键词或状态筛选试试。</span></div>';
  const body = root.querySelector('tbody'), sel = root.querySelector('#asort'), q = root.querySelector('#aq'), cnt = root.querySelector('.fcount'), seg = root.querySelector('#asx');
  let filter = 'all';
  function draw() {
    const key = sel.value, kw = q.value.trim().toLowerCase();
    const dir = newestFirst() ? -1 : 1;
    const val = {start: a => dir * a.start, cost: a => -a.cost, dur: a => -(a.end - a.start), steps: a => -a.nsteps}[key];
    const st = new Map(SUBS.map(a => [a.id, sxGet(a)]));
    const n = {all: SUBS.length, run: 0, done: 0};
    st.forEach(s => { if (sxRunning(s)) n.run++; else if (s.state === 'done') n.done++; });
    const keep = a => filter === 'all' || (filter === 'run' ? sxRunning(st.get(a.id)) : st.get(a.id).state === 'done');
    const list = SUBS.filter(a => keep(a) && (!kw || (a.desc + ' ' + a.model + ' ' + a.effort).toLowerCase().indexOf(kw) >= 0)).sort((x, y) => val(x) - val(y));
    // Sub-agents still running stay on top whatever the sort (the sort keeps ordering each group).
    const all = list.filter(a => sxRunning(st.get(a.id))).concat(list.filter(a => !sxRunning(st.get(a.id))));
    seg.innerHTML = SX_FILTERS.map(f => '<button type="button" data-f="' + f[0] + '" class="' + (filter === f[0] ? 'on' : '') + '" aria-pressed="' + (filter === f[0]) + '">' + f[1] + ' ' + n[f[0]] + '</button>').join('');
    body.innerHTML = all.map(a => '<tr class="' + (sxRunning(st.get(a.id)) ? 'is-running' : '') + '"><td style="padding-left:' + (8 + (a.depth - 1) * 14) + 'px">' + agentLink(a.id, clip(a.desc, 60)) + (a.bg ? ' <span class="dim">后台</span>' : '') + '</td><td>' + agentChip(a.model, a.fam, a.effort) +
      '</td><td class="sxcell">' + sxStatusHTML(a, true) + '</td><td class="hn t">' + fmtTS(a.start) + '</td><td class="r num">' + fmtDur(a.end - a.start) + '</td><td class="r num">' + a.nsteps + '</td><td class="cellcost num">' + costHTML(a.cost, a.tok, {unit: false}) + '</td><td class="r num hn">' + (a.stats.testT ? fmtDur(a.stats.testT) : '') +
      '</td><td class="r num hn">' + (a.stats.waitT ? fmtDur(a.stats.waitT) : '') + '</td><td class="r num hn">' + (a.stats.hooks || '') + '</td></tr>').join('');
    cnt.textContent = all.length + ' / ' + SUBS.length;
    root.querySelector('#aempty').hidden = all.length > 0 || !SUBS.length;
    if (!SUBS.length) body.innerHTML = '<tr><td colspan="10">' + emptyState('这个会话没有子代理') + '</td></tr>';
  }
  seg.addEventListener('click', e => { const b = e.target.closest('button[data-f]'); if (b) { filter = b.dataset.f; draw(); } });
  sel.addEventListener('change', draw);
  q.addEventListener('input', draw);
  draw();
  sxStart(root, draw);
}

function agentStats(a) {
  const peak = Math.max.apply(null, [0].concat(allCalls(a).map(x => x.s.ctx)));
  const dur = a.end - a.start;
  return '<div class="stats">' + stat('步数', a.nsteps, a.nsteps ? '平均每步 ' + moneyH(a.cost / a.nsteps) : '') + stat('时长', fmtDur(dur), fmtTS(a.start) + ' → ' + fmtTS(a.end)) +
    stat('预估金额', '<span title="' + esc(tokTitle(a.tok)) + '">' + moneyH(a.cost) + '</span>', '占总金额 ' + pct(a.cost, D.totals.cost) + ' · ' + fmtTok(tokSum(a.tok)) + ' token') + stat('上下文峰值', fmtTok(peak)) +
    stat('测试检查', fmtDur(a.stats.testT), pct(a.stats.testT, dur) + ' 的时长') + stat('等待与轮询', fmtDur(a.stats.waitT), pct(a.stats.waitT, dur) + ' 的时长') +
    stat('超过 60 秒的命令', fmtDur(a.stats.longT), a.stats.longN + ' 条') + stat('钩子拦截', a.stats.hooks) + '</div>';
}

function agentCatHTML(a) { return '<h3>金额：按活动类别</h3>' + catSection(a.byCat, a.cost) + tokenCard(a.tok); }

function renderAgent(root, id, jump) {
  const a = A[id];
  if (!a) { root.innerHTML = '<p class="warn">没有这个代理：' + esc(id) + '</p>'; return; }
  const title = id === 'main' ? '主代理逐轮回看' : a.desc;
  let h = '<p class="crumb"><a href="#' + (id === 'main' ? 'overview' : 'agents') + '">← ' + (id === 'main' ? '总览' : '子代理列表') + '</a>' +
    (a.parent && a.parent !== 'main' && A[a.parent] ? ' · 上级：' + agentLink(a.parent) : id !== 'main' ? ' · 上级：' + agentLink('main', '主代理') : '') + '</p>';
  h += '<h1>' + esc(title) + '</h1>';
  if (id !== 'main') {
    h += '<p class="meta">' + agentChip(a.model, a.fam, a.effort) + ' <span class="dim">' + (a.bg ? '后台' : '前台') + ' · 嵌套深度 ' + a.depth + (a.type ? ' · ' + esc(a.type) : '') + ' · id <span class="mono">' + esc(a.id) + '</span></span> ' + copyBtn(a.id) +
      (a.wt ? ' <span class="dim mono" title="' + esc(a.wt) + '">worktree ' + esc(clip(a.wt, 50)) + '</span>' : '') + '</p><div class="sx-head" id="sxhead"></div>';
  }
  h += '<div id="agstats">' + agentStats(a) + '</div>';
  const unp = unpricedNote(a);
  if (unp) h += '<p class="warn">' + unp + '。</p>';
  if (id === 'main') h += timeCatMainCard();
  h += '<div class="card" id="agcat">' + agentCatHTML(a) + '</div>';
  if (id !== 'main') {
    h += '<section class="card"><h3>简报 ' + (a.briefing ? copyBtn(a.briefing) : '') + '</h3>' + (a.reason ? clampBlock(a.reason, 'reasonline', 2) : SRC_NOTES.reasonMissing ? '<p class="dim">' + esc(SRC_NOTES.reasonMissing) + '</p>' : '') +
      clampBlock(a.briefing, 'brief', 4) + '</section>';
  }
  h += '<h2 class="sh">逐步回看 <span class="vseg" id="vseg" role="group" aria-label="显示方式"></span></h2><div id="lsbar" class="lsbar"></div><div id="stepsroot"></div><div id="termroot" hidden></div>';
  if (id !== 'main') {
    const src = {handback: '来自 SubagentHandback 调用', lasttext: SRC_NOTES.lastText || '', lastmsg: '取该线程最后一轮的 last_agent_message'}[a.reportSrc] || '没有找到交回报告';
    h += '<section class="card"><h3>交回报告 <span class="dim">（' + src + '）</span> ' + (a.report ? copyBtn(a.report) : '') + '</h3>' + (a.report ? clampBlock(a.report, 'report', 6) : '<p class="dim">无</p>') + '</section>';
  }
  if (a.children.length) {
    h += '<section class="card"><h3>嵌套派出的子代理（' + a.children.length + '）</h3><table class="tbl"><tr><th>任务</th><th>模型</th><th>步数</th><th class="r">预估金额</th></tr>' +
      a.children.map(c => A[c]).filter(Boolean).map(c => '<tr><td>' + agentLink(c.id, clip(c.desc, 60)) + '</td><td>' + agentChip(c.model, c.fam, c.effort) + '</td><td>' + c.nsteps + '</td><td class="cellcost">' + costHTML(c.cost, c.tok) + '</td></tr>').join('') + '</table></section>';
  }
  root.innerHTML = h;
  // stepsView (steps_view.js) adds the table / terminal switch and the live update; without it the plain table is shown
  if (typeof stepsView === 'function') stepsView(root, a, jump);
  else renderSteps(a, root.querySelector('#stepsroot'), jump);
  fitClamps(root);
  const head = root.querySelector('#sxhead');
  if (head) {  // status of this sub-agent: live in an active session, else from the recording
    const paint = () => { head.innerHTML = '<b>状态</b> ' + sxStatusHTML(a, true); };
    paint();
    sxStart(head, paint);
  }
}
