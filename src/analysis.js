'use strict';
/* Time-analysis tab: routes #analysis (the whole session) and #analysis/agent/<id> (one agent and its descendants).
 * Why it was slow, where, and which time and money could have been saved. The numbers come from the shared time
 * segmentation (timeseg.js); the critical path is in analysis_path.js, the waste detectors in analysis_detect.js and the
 * markup of the headline / path / waste cards in analysis_ui.js. Computed once per scope when the tab is opened and
 * cached on D. */

const ANA_TOP_STEPS = 20, ANA_TOP_REPEATS = 15;
const ANA_COLS = [
  ['start', '代理', 'l'], ['total', '总时长'], ['work', '工作', 0, '工具执行加思考'], ['wait', '等待', 0, '等子代理、轮询、等你回复'],
  ['read', '读'], ['test', '测'], ['write', '写'], ['git', 'git'], ['poll', '轮询', 0, '等待与轮询类命令'], ['agent', '派'], ['other', '其他'], ['cost', '金额'], ['tok', 'token']
];
const ANA_SORT = {key: 'start', dir: -1};

function anaConfig() {
  const cfg = (typeof LV !== 'undefined' && LV.data && LV.data.cfg) || {};
  return {ctxLimit: cfg.ctxLimit || ANA_CTX_DEFAULT, longMs: ANA_LONG_CMD_MS};
}

/* Everything the page shows for one scope, computed once. */
function anaData(rootId) {
  const cache = D._ana || (D._ana = {});
  if (cache[rootId]) return cache[rootId];
  const scope = anaBuildScope(rootId, id => A[id] || null);
  const root = scope.byId[rootId];
  const det = anaDetect(scope, anaConfig());
  const steps = [];
  scope.rows.forEach(r => stepTimes(r.T).forEach(x => { if (x.ms > 0) steps.push({r, x}); }));
  steps.sort((p, q) => q.x.ms - p.x.ms);
  const rows = scope.rows.map(r => {
    const sp = anaTimeSplit(r.T), by = r.T.by;
    return {id: r.id, a: r.a, start: r.T.T0, total: sp.total, work: sp.work, wait: sp.wait, read: by.read, test: by.test, write: by.write, git: by.git, poll: by.wait,
      agent: by.agent, other: by.other, cost: r.a.cost || 0, tok: tokSum(r.a.tok), nUnp: r.a.nUnp || 0};
  });
  return cache[rootId] = {scope, root, split: anaTimeSplit(root.T), det, path: anaCriticalPath(scope), steps: steps.slice(0, ANA_TOP_STEPS),
    repeats: repeatGroups(scope.calls).slice(0, ANA_TOP_REPEATS), rows};
}

const anaJa = (r, it) => ' data-ja="' + esc(r.id + '|' + Math.round(it.ts) + '|' + (it.n == null ? '' : it.n)) + '" tabindex="0" role="link"';

function anaTopSteps(d) {
  const list = ordered(d.steps.slice().sort((p, q) => p.r.T.flat[p.x.i].s.ts - q.r.T.flat[q.x.i].s.ts));
  const multi = d.scope.rows.length > 1;
  // Fixed column widths: the reason/command column takes the rest instead of being squeezed to one word per line.
  const cols = '<colgroup><col class="an-c-t">' + (multi ? '<col class="an-c-ag">' : '') + '<col class="an-c-tool"><col><col class="an-c-dur"><col class="an-c-cost"></colgroup>';
  return '<section class="card"><h3>耗时最多的 ' + d.steps.length + ' 步（按时间排列）</h3>' + (list.length ? '<div class="tblwrap"><table class="tbl an-tbl">' + cols + '<thead><tr><th>时间</th>' + (multi ? '<th>代理</th>' : '') +
    '<th>工具</th><th>原因 / 命令</th><th class="r">时长</th><th class="r">金额</th></tr></thead><tbody>' + list.map(p => {
      const s = p.r.T.flat[p.x.i].s, c = p.x.main && p.x.main.c, a = p.r.a;
      const why = typeof focusReason === 'function' ? focusReason(a, p.r.T, p.x.main || {cat: 'think', stepIdx: p.x.i}) : '';
      const more = s.calls.length > 1 ? ' <span class="dim">+' + (s.calls.length - 1) + '</span>' : '';
      const full = why + (c && c.sum ? '\n' + c.sum : '');
      return '<tr' + anaJa(p.r, {ts: c ? c.ts : s.ts, n: s.n}) + '><td class="t">' + fmtClock(s.ts) + ' <span class="dim">#' + s.n + '</span></td>' + (multi ? '<td class="an-ag" title="' + esc(anaName(p.r.id)) + '">' + esc(anaName(p.r.id)) + '</td>' : '') +
        '<td class="an-tool">' + (c ? '<span class="tool cat-' + esc(c.cat) + '">' + esc(c.name) + '</span>' + more : '<span class="dim">回复</span>') + '</td><td class="an-why" title="' + esc(clip(full, 800)) + '"><div class="an-r">' + esc(why) + '</div>' +
        (c && c.sum ? '<div class="an-cmd">' + esc(clip(firstLine(c.sum), 300)) + '</div>' : '') + '</td><td class="r num">' + fmtDur(p.x.ms) + '</td><td class="r num an-cost">' + stepCostHTML(s, {inline: true}) + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="dim">没有步骤。</p>') + '</section>';
}

function anaRepeatTable(d) {
  const rows = d.repeats;
  return '<section class="card"><h3>重复命令汇总（归一化后相同，前 ' + ANA_TOP_REPEATS + ' 个）</h3>' + (rows.length ? '<div class="tblwrap"><table class="tbl an-tbl"><colgroup><col><col class="an-c-n"><col class="an-c-dur"><col class="an-c-dur"><col class="an-c-n2"></colgroup><thead><tr><th>命令</th><th class="r">次数</th><th class="r">总耗时</th><th class="r">平均</th><th class="r">总金额</th></tr></thead><tbody>' +
    rows.map(g => '<tr' + anaJa(g.firstItem.r, {ts: g.first.ts, n: g.firstStep.n}) + '><td class="an-why" title="' + esc(g.cmd) + '"><span class="tool cat-' + esc(g.first.cat) + '">' + esc(g.name) + '</span> <span class="an-cmd an-cmd-in">' + esc(clip(g.cmd, 300)) + '</span></td><td class="r num">' + g.n +
      '</td><td class="r num">' + fmtDur(g.total) + '</td><td class="r num">' + fmtDur(g.total / g.n) + '</td><td class="r num">' + (g.nUnp === g.n ? '无价格' : fmtMoney(g.cost)) + '</td></tr>').join('') +
    '</tbody></table></div><p class="note tf-note">哈希和数字按占位符合并。一步里有多个调用时，这一步的金额平分给各调用；没有价格的步骤不计入。</p>' : '<p class="dim">没有重复的命令。</p>') + '</section>';
}

function anaAgentTable(d) {
  const k = ANA_SORT.key;
  let rows = d.rows.slice();
  if (k === 'start') {
    rows.sort((p, q) => p.start - q.start);
    rows = ordered(rows);
  } else rows.sort((p, q) => (ANA_SORT.dir * (q[k] - p[k])) || (p.start - q.start));
  const mark = key => (ANA_SORT.key === key && key !== 'start' ? (ANA_SORT.dir < 0 ? ' ▼' : ' ▲') : '');
  const head = ANA_COLS.map(c => '<th class="' + (c[2] === 'l' ? '' : 'r ') + 'ana-sort" data-sort="' + c[0] + '" tabindex="0" role="button"' + (c[3] ? ' title="' + esc(c[3]) + '"' : '') + '>' + esc(c[1]) + mark(c[0]) + '</th>').join('');
  const cell = ms => '<td class="r num">' + (ms ? fmtDur(ms) : '<span class="dim">0</span>') + '</td>';
  return '<section class="card"><h3>按代理的耗时（' + rows.length + ' 个）</h3><div class="tblwrap"><table class="tbl tf-tbl ana-agents"><thead><tr>' + head + '</tr></thead><tbody>' + rows.map(r =>
    '<tr><td><a href="' + focusHash(r.id) + '"' + mdAttr({type: 'agent', agent: r.id}) + ' title="在弹窗里查看这个代理的概要">' + esc(clip(anaName(r.id), 46)) + '</a>' + (r.id !== d.scope.rootId && d.scope.rows.length > 1 ? ' <a class="dim" href="#analysis/agent/' + encodeURIComponent(r.id) + '" title="只分析它和它的后代">仅看它</a>' : '') + '</td>' +
    cell(r.total) + cell(r.work) + cell(r.wait) + cell(r.read) + cell(r.test) + cell(r.write) + cell(r.git) + cell(r.poll) + cell(r.agent) + cell(r.other) +
    '<td class="r num">' + (r.nUnp && !r.cost ? '无价格' : moneyH(r.cost)) + '</td><td class="r num">' + fmtTok(r.tok) + '</td></tr>').join('') +
    '</tbody></table></div><p class="note tf-note">工作 = 工具执行加思考；等待 = 等子代理 + 轮询 + 等你回复。各类别互不重叠。点列标题排序，点代理名在弹窗里看概要，点任意证据或路径分段在弹窗里看对应的步骤。</p></section>';
}

function anaHeader(id) {
  const a = A[id], isAll = id === 'main';
  const subs = ordered(SUBS.slice().sort((x, y) => (x.start || 0) - (y.start || 0)));
  const opts = [{id: 'main', label: '全部（主代理和所有子代理）'}].concat(subs.map(s => ({id: s.id, label: clip(s.desc, 60)})));
  return '<nav class="tf-nav ana-nav" aria-label="耗时分析范围">' + (isAll ? '' : '<a class="btn" href="#analysis">← 返回全部</a>') + '<span class="tf-sp"></span>' +
    '<label class="ana-pick">看哪个代理 <select id="ana-sel" aria-label="选择代理">' + opts.map(o => '<option value="' + esc(o.id) + '"' + (o.id === id ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</select></label></nav>' +
    '<div class="tf-title">' + (isAll ? '' : agentChip(a.model, a.fam, a.effort)) + '<h1>耗时分析' + (isAll ? '' : '：' + esc(clip(a.desc, 80))) + '</h1></div>' +
    (isAll ? '' : '<p class="dim tf-meta">只统计这个代理和它派出的子代理（共 ' + (anaData(id).scope.rows.length) + ' 个）。</p>');
}

function anaBind(host, d) {
  const go = el => {
    const ja = el.closest('[data-ja]');
    if (ja) {
      const p = ja.dataset.ja.split('|'), n = p.pop(), ts = p.pop();
      jumpTo(p.join('|'), +ts, false, n === '' ? null : +n);
      return true;
    }
    const sg = el.closest('[data-seg]');
    if (sg) { anaOpenSeg(sg); return true; }
    return false;
  };
  host.addEventListener('click', e => {
    const all = e.target.closest('[data-evall]');
    if (all) { anaOpenEvidence(d.det.list[+all.dataset.evall]); return; }
    const more = e.target.closest('[data-more]');
    if (more) { anaMoreEvidence(d.det.list[+more.dataset.more], more); return; }
    const so = e.target.closest('[data-sort]');
    if (so) { anaSort(host, d, so.dataset.sort); return; }
    const sa = e.target.closest('a[data-seg]');
    if (sa) { e.preventDefault(); anaOpenSeg(sa); return; }
    if (!e.target.closest('a,button')) go(e.target);
  });
  host.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const so = e.target.closest('[data-sort]');
    if (so) anaSort(host, d, so.dataset.sort);
    else if (e.target.matches('[data-ja],[data-seg]')) go(e.target);
  });
  host.querySelector('#ana-sel').addEventListener('change', e => { location.hash = e.target.value === 'main' ? '#analysis' : '#analysis/agent/' + encodeURIComponent(e.target.value); });
}

/* A critical-path piece: the steps of that agent inside it (a wait for the user has none: its end is the user's message, so the turn). */
function anaSegSpec(o) {
  const a = A[o.a];
  if (!a) return null;
  const steps = mdStepsInRange(a, o.t0, o.t1);
  if (!steps.length && o.c === 'user' && a.turns.length) return {type: 'turn', agent: o.a, turn: findTurnAt(a, o.t1)};
  return {type: 'steps', agent: o.a, steps, title: anaName(o.a) + ' · ' + (TS_CATS[o.c] ? TS_CATS[o.c].label : o.c) + ' · ' + fmtDur(o.t1 - o.t0)};
}
function anaOpenSeg(el) {
  let o = null;
  try { o = JSON.parse(el.getAttribute('data-seg')); } catch (e) { /* bad attribute */ }
  const spec = o && anaSegSpec(o);
  if (spec) showDetail(spec); else toast('回看数据里没有这个代理，点「刷新回看数据」更新。');
}
/* All steps of one waste pattern, across agents. */
function anaOpenEvidence(f) {
  if (!f) return;
  showDetail({type: 'steps', steps: ordered(f.evidence).filter(e => e.n != null).map(e => ({agent: e.agentId, step: e.n})), title: f.title});
}

function anaSort(host, d, key) {
  if (ANA_SORT.key === key) ANA_SORT.dir = -ANA_SORT.dir; else { ANA_SORT.key = key; ANA_SORT.dir = -1; }
  const old = host.querySelector('.ana-agents').closest('section');
  old.outerHTML = anaAgentTable(d);
  const th = host.querySelector('[data-sort="' + key + '"]');
  if (th) th.focus();
}

function renderAnalysis(root, agentId) {
  const id = agentId || 'main';
  if (!A[id]) {
    root.innerHTML = '<p class="crumb"><a href="#analysis">← 返回全部</a></p><p class="warn">没有这个代理：' + esc(id) + '</p>';
    return;
  }
  const d = anaData(id), S = d.scope;
  const host = document.createElement('div');
  host.className = 'ana';
  if (d.root.T.T1 <= d.root.T.T0) {
    host.innerHTML = anaHeader(id) + emptyState('没有可分析的时间范围', '会话里没有记录到这个代理的开始和结束时间。');
  } else {
    host.innerHTML = anaHeader(id) + '<section class="card ana-sum"><p class="ana-head">' + anaRich(anaHeadline(d.split, d.det)) + '</p>' + anaStats(S, d) + '</section>' +
      anaPathHTML(d) + anaFindingsHTML(d) + anaTopSteps(d) + anaRepeatTable(d) + anaAgentTable(d);
  }
  root.innerHTML = '';
  root.appendChild(host);
  anaBind(host, d);
}
