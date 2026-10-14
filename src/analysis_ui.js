'use strict';
/* Markup of the time-analysis tab: headline, key numbers, critical-path bar and the waste-pattern cards.
 * Tables and the page itself are in analysis.js. Clicks use data-ja (open a step in the detail dialog), data-seg (a critical-path piece) and data-evall (a whole pattern). */

const ANA_EVID_SHOWN = 5, ANA_EVID_MAX = 300;
/* A piece of the critical path as a clickable element: the dialog lists the steps of that agent inside the piece (analysis.js). */
const anaSegAttr = (agentId, t0, t1, cat) => ' data-seg="' + esc(JSON.stringify({a: agentId, t0: Math.round(t0), t1: Math.round(t1), c: cat})) + '"';
const anaName = id => (id === 'main' ? '主代理' : (A[id] ? A[id].desc : id));
const anaDurText = ms => (ms == null ? '—' : fmtDur(ms));
const anaPct = (a, b) => (b > 0 ? Math.round(a / b * 100) + '%' : '-');

/* `code` spans in the generated text become <code>. */
function anaRich(s) { return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'); }

/* Amount of a finding: priced steps summed; the steps without a price are named, not guessed. */
function anaCostText(c, none) {
  if (none || !c || !c.steps || noUsage()) return '—';
  if (!c.priced) return '无价格';
  return fmtMoney(c.cost) + (c.nUnp ? '（另有 ' + c.nUnp + ' 步无价格，未计入）' : '');
}

/* One sentence: where the time went and the largest single waste. */
function anaHeadline(split, det) {
  const parts = [{k: '在等子代理', v: split.subwait}, {k: '在等你回复', v: split.user}, {k: '在轮询等待', v: split.poll}].sort((x, y) => y.v - x.v);
  let s = '总时长 ' + fmtDur(split.total);
  if (split.total > 0) s += parts[0].v / split.total >= 0.1 ? '，其中 ' + anaPct(parts[0].v, split.total) + ' ' + parts[0].k : '，其中 ' + anaPct(split.work, split.total) + ' 是代理在工作';
  const h = det.head;
  if (h && h.ms >= 10000) {
    const money = h.cost && h.cost.priced ? '，' + fmtMoney(h.cost.cost) : '';
    s += '，最大的单项浪费是' + h.text + '（' + h.count + ' 次，约 ' + fmtDur(h.ms) + money + '）';
  } else s += '，没有发现明显的单项浪费';
  return s;
}

function anaStats(S, d) {
  const sp = d.split, c = S.conc;
  const allWork = S.rows.reduce((m, r) => m + anaTimeSplit(r.T).work, 0);
  return '<div class="stats ana-stats">' +
    stat('总时长', fmtDur(sp.total), fmtTS(d.root.T.T0) + ' → ' + fmtTS(d.root.T.T1)) +
    stat('代理实际在工作', fmtDur(sp.work), anaPct(sp.work, sp.total) + ' · 工具执行加思考' + (S.rows.length > 1 ? '；全部代理累计 ' + fmtDur(allWork) : '')) +
    stat('等你回复', fmtDur(sp.user), anaPct(sp.user, sp.total)) +
    stat('空等子代理', fmtDur(sp.subwait), anaPct(sp.subwait, sp.total) + (sp.poll ? ' · 另有轮询等待 ' + fmtDur(sp.poll) : '')) +
    stat('同时运行的代理', '平均 ' + c.avg.toFixed(1) + ' · 最高 ' + c.max, S.rows.length + ' 个代理参与') +
    usageStat('预估金额', costHTML(S.cost, S.tok, {inline: true}), (S.nUnp ? S.nUnp + ' 步未定价，未计入金额' : '含全部代理')) + '</div>';
}

/* ---- critical path */
function anaPathHTML(d) {
  const P = d.path;
  if (!P.merged.length) return '<section class="card"><h3>关键路径</h3><p class="dim">没有可画的时间范围。</p></section>';
  const blocks = anaPathBlocks(P, 0.004), total = Math.max(1, P.total);
  const rows = P.top.map((p, i) => {
    const a = A[p.agentId], T = d.scope.byId[p.agentId].T, dur = p.t1 - p.t0;
    const why = typeof focusReason === 'function' && p.seg ? focusReason(a, T, p.seg) : '';
    return '<tr' + anaSegAttr(p.agentId, p.t0, p.t1, p.cat) + ' tabindex="0" role="button"><td class="num">' + (i + 1) + '</td><td>' + esc(clip(anaName(p.agentId), 40)) + '</td><td>' + anaSwatch(p.cat) + esc(TS_CATS[p.cat].label) + '</td><td class="why">' + esc(why) + '</td><td class="r num">' + fmtDur(dur) + ' <span class="dim">' + anaPct(dur, total) + '</span></td></tr>';
  }).join('');
  return '<section class="card ana-path"><h3>关键路径（共 ' + fmtDur(P.total) + '，占总时长 ' + anaPct(P.total, d.split.total) + '）</h3>' +
    '<p class="note">决定会话结束时间的那条链：从最后一刻往回走，遇到「等子代理」就进入最后交回的那个子代理，直到它开始，再回到派单时刻。上层是这条链经过的代理，下层是它在做什么；点下层任意一段，在弹窗里看这一段做了哪些步骤。</p>' +
    anaPathBarHTML(P, blocks) +
    '<div class="ana-axis"><span>' + fmtClock(P.t0) + '</span><span>' + fmtClock(P.t1) + '</span></div>' + anaKeyHTML(anaCatRows(anaPathCats(P)), {compact: true, aria: '关键路径上的类别与时长'}) +
    '<h3>路径上耗时最多的 ' + P.top.length + ' 段</h3><div class="tblwrap"><table class="tbl an-tbl"><colgroup><col class="an-c-n"><col class="an-c-ag"><col class="an-c-cat"><col><col class="an-c-dur2"></colgroup><thead><tr><th>#</th><th>代理</th><th>类别</th><th>原因</th><th class="r">时长</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
}

/* ---- waste patterns */
function anaEvidRow(f, e) {
  const text = f.id === 'ctx' ? '上下文 ' + fmtTok(e.ctx) + ' token' : e.text;
  const money = e.step && f.id !== 'subwait' && !noUsage() ? (e.step.cost == null ? '无价格' : fmtMoney(e.step.cost)) : '';
  return '<li class="ana-ev" data-ja="' + esc(e.agentId) + '|' + Math.round(e.ts) + '|' + (e.n == null ? '' : e.n) + '" tabindex="0" role="link"><span class="t">' + fmtClock(e.ts) + (e.n != null ? ' <span class="dim">#' + e.n + '</span>' : '') +
    '</span><span class="who">' + esc(clip(anaName(e.agentId), 24)) + '</span><span class="what"><span class="mono">' + esc(text) + '</span>' + (e.sub ? '<span class="dim"> ' + esc(e.sub) + '</span>' : '') +
    '</span><span class="num">' + (f.ms == null ? '' : anaDurText(e.ms)) + (money ? ' · ' + money : '') + '</span></li>';
}
function anaFindingCard(f, fi) {
  const list = ordered(f.evidence), shown = list.slice(0, ANA_EVID_SHOWN), more = list.length - shown.length;
  const noCost = !!f.noCost;
  return '<details class="ana-find" data-f="' + fi + '"><summary><b>' + esc(f.title) + '</b><span class="ana-k">' + f.count + ' 次</span>' +
    (f.ms == null ? '' : '<span class="ana-k">' + fmtDur(f.ms) + (f.msNote ? ' <span class="dim">' + esc(f.msNote) + '</span>' : '') + '</span>') +
    '<span class="ana-k">' + esc(anaCostText(f.cost, noCost)) + '</span></summary>' +
    '<p class="note">' + esc(f.rule) + (noCost ? '。等待期间不产生模型费用，所以没有金额。' : '。金额为涉及步骤的预估金额合计，没有价格的步骤不计入。') + '</p>' +
    (f.evidence.some(e => e.n != null) ? '<p><button type="button" class="btn md-mini" data-evall="' + fi + '">在弹窗里查看这 ' + f.evidence.filter(e => e.n != null).length + ' 步</button></p>' : '') +
    '<ul class="ana-evl">' + shown.map(e => anaEvidRow(f, e)).join('') + '</ul>' +
    (more > 0 ? '<button type="button" class="btn ana-more" data-more="' + fi + '">展开其余 ' + more + ' 条</button>' : '') + '</details>';
}
function anaFindingsHTML(d) {
  const hit = d.det.list.map((f, i) => ({f, i})).filter(x => x.f.count > 0), miss = d.det.list.filter(f => f.count === 0);
  return '<section class="card ana-finds"><h3>浪费模式检测</h3>' + (hit.length ? hit.map(x => anaFindingCard(x.f, x.i)).join('') : '<p class="dim">所有检测项都没有命中。</p>') +
    (miss.length ? '<p class="note ana-miss">未发现：' + miss.map(f => esc(f.title)).join('、') + '</p>' : '') + '</section>';
}
/* The rest of a finding's evidence, filled in when its button is pressed (capped so a huge list stays responsive). */
function anaMoreEvidence(f, btn) {
  const list = ordered(f.evidence).slice(ANA_EVID_SHOWN, ANA_EVID_MAX);
  btn.previousElementSibling.insertAdjacentHTML('beforeend', list.map(e => anaEvidRow(f, e)).join(''));
  const left = f.evidence.length - ANA_EVID_MAX;
  if (left > 0) btn.outerHTML = '<p class="note">只列出前 ' + ANA_EVID_MAX + ' 条，另有 ' + left + ' 条。</p>'; else btn.remove();
}
