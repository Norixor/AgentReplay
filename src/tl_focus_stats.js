'use strict';
/* Time analysis under the single-agent chart: category bars, the slowest steps, repeated commands, waiting, and the
 * dispatch / wait-for-children details. Everything derives from the shared segmentation (timeseg.js). */

const FOCUS_TOP = 10;

/* One-line reason for a segment, shared by the chart tooltip and the tables (plain text, not HTML). */
function focusReason(a, T, sg) {
  const f = sg.stepIdx != null ? T.flat[sg.stepIdx] : null, s = sg.s || (f && f.s), c = sg.c;
  if (sg.cat === 'user') {
    const nt = f && a.turns[f.ti + 1];
    return nt ? '本轮结束，等下一条消息：' + (EV_LABEL[nt.trig.k] || nt.trig.k) + (nt.trig.text ? '：' + clip(nt.trig.text, 80) : '') : '本轮已结束，等下一条消息';
  }
  if (sg.cat === 'idle') return '这段时间没有记录到活动（记录中断或无法归类）';
  if (sg.cat === 'subwait') {
    if (c && c.disp) return '前台派单，等子代理交回：' + clip(A[c.agent] ? A[c.agent].desc : (c.desc || c.sum), 80);
    if (c) return '等后台任务：' + clip(c.desc || c.sum, 80);
    const names = [];
    T.spans.forEach(sp => { if (sp.t0 < sg.t1 && sp.t1 > sg.t0) { const n = A[sp.id] ? A[sp.id].desc : sp.id; if (!names.includes(n)) names.push(n); } });
    return names.length ? '子代理还在运行：' + names.slice(0, 3).map(n => clip(n, 30)).join('、') + (names.length > 3 ? ' 等 ' + names.length + ' 个' : '') : '等子代理';
  }
  if (c) return clip(c.desc || c.sum, 120);
  if (!s) return '';
  if (s.said) return clip(firstLine(s.said), 120);
  if (s.cause && s.cause.length) return '触发：' + s.cause.slice(0, 2).map(k => (EV_LABEL[k.k] || k.k) + (k.text ? '：' + clip(k.text, 60) : '')).join('；');
  if (s.rsum) return clip(firstLine(s.rsum).replace(/\*\*/g, ''), 120);
  return s.after != null ? '承接 #' + s.after + ' 的结果' : '模型生成';
}

/* Repeated commands of one agent: the grouping itself is shared with the analysis tab (analysis_core.js). */
function focusRepeats(T) {
  const items = [];
  T.flat.forEach(f => f.s.calls.forEach(c => items.push({c, s: f.s})));
  return repeatGroups(items).slice(0, FOCUS_TOP);
}

/* Adjacent segments of one category are one stretch of waiting. */
function focusStretches(T, cat) {
  const out = [];
  T.segs.forEach(sg => {
    if (sg.cat !== cat) return;
    const last = out[out.length - 1];
    if (last && last.t1 === sg.t0) last.t1 = sg.t1; else out.push({t0: sg.t0, t1: sg.t1, sg});
  });
  return out;
}

const jtAttr = (ts, n) => ' data-jt="' + Math.round(ts) + '"' + (n != null ? ' data-n="' + n + '"' : '') + ' tabindex="0" role="link"';

function focusCatBars(a, T) {
  const total = Math.max(1, T.T1 - T.T0), list = TS_ORDER.filter(k => T.by[k] > 0).sort((x, y) => T.by[y] - T.by[x]);
  const max = T.by[list[0]] || 1;
  const money = k => a.byCat[k] && TS_CATS[k].tool ? ' · ' + costHTML(a.byCat[k].c, a.byCat[k].tok, {inline: true}) : '';
  return '<section class="card tf-bars"><h3>时间花在哪里（共 ' + fmtDur(total) + '）</h3>' + list.map(k =>
    bar(esc(TS_CATS[k].label), T.by[k], max, '', '<b>' + fmtDur(T.by[k]) + '</b> · ' + pct(T.by[k], total) + money(k), TS_CATS[k].color)).join('') +
    '<p class="note tf-note">各类别互不重叠，加起来等于这个代理从开始到结束的时长。金额和 token 按「活动类别」口径分摊（一步里有多个调用时平分，纯文字回复计入「其他」），所以只有工具类别带金额。</p></section>';
}

function focusTopSteps(a, T) {
  const rows = stepTimes(T).filter(r => r.ms > 0).sort((x, y) => y.ms - x.ms).slice(0, FOCUS_TOP);
  return '<section class="card"><h3>耗时最长的 ' + FOCUS_TOP + ' 步</h3>' + (rows.length ? '<div class="tblwrap"><table class="tbl tf-tbl"><thead><tr><th>时间</th><th>工具</th><th>原因 / 命令</th><th class="r">时长</th></tr></thead><tbody>' +
    rows.map(r => {
      const s = r.f.s, c = r.main && r.main.c, cat = c ? tsCallCat(c, T.hasKids) : 'think';
      const more = s.calls.length > 1 ? ' <span class="dim">+' + (s.calls.length - 1) + '</span>' : '';
      const why = focusReason(a, T, r.main || {cat: 'think', stepIdx: r.i});
      return '<tr' + jtAttr(s.ts, s.n) + '><td class="t">' + fmtClock(s.ts) + ' <span class="dim">#' + s.n + '</span></td><td>' +
        (c ? '<span class="tool cat-' + esc(c.cat) + '">' + esc(c.name) + '</span>' + more : '<span class="dim">回复</span>') + '</td><td class="why">' + esc(why) +
        (c && c.sum ? '<div class="mono">' + esc(clip(firstLine(c.sum), 100)) + '</div>' : '') + '</td><td class="r num">' + fmtDur(r.ms) +
        (cat === 'subwait' ? ' <span class="dim">等子代理</span>' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="dim">没有步骤。</p>') + '</section>';
}

function focusRepeatCmds(T) {
  const rows = focusRepeats(T);
  return '<section class="card"><h3>重复命令（归一化后相同，前 ' + FOCUS_TOP + ' 个）</h3>' + (rows.length ? '<div class="tblwrap"><table class="tbl tf-tbl"><thead><tr><th>命令</th><th class="r">次数</th><th class="r">合计</th><th class="r">平均</th></tr></thead><tbody>' +
    rows.map(g => '<tr' + jtAttr(g.first.ts, g.firstStep.n) + '><td class="cmd"><span class="tool cat-' + esc(g.first.cat) + '">' + esc(g.name) + '</span> ' + esc(clip(g.cmd, 160)) +
      '</td><td class="r num">' + g.n + '</td><td class="r num">' + fmtDur(g.total) + '</td><td class="r num">' + fmtDur(g.total / g.n) + '</td></tr>').join('') +
    '</tbody></table></div><p class="note tf-note">哈希和数字按占位符合并，所以 <code>sleep 30</code> 与 <code>sleep 60</code> 算同一条。</p>' : '<p class="dim">没有重复的命令。</p>') + '</section>';
}

function focusWaits(a, T) {
  const defs = [['subwait', '等子代理', T.hasKids], ['user', '等你回复', true], ['wait', '轮询（等待与轮询类命令）', true], ['idle', '空闲（未知）', true]];
  const rows = defs.filter(d => d[2]).map(d => {
    const st = focusStretches(T, d[0]), tot = T.by[d[0]];
    let top = null;
    st.forEach(x => { if (!top || x.t1 - x.t0 > top.t1 - top.t0) top = x; });
    return '<tr' + (top ? jtAttr(top.t0, top.sg.s ? top.sg.s.n : null) : '') + '><td><i class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;background:' + TS_CATS[d[0]].color + '"></i>' + esc(d[1]) +
      '</td><td class="r num">' + (tot ? fmtDur(tot) : '无') + '</td><td class="r num">' + st.length + '</td><td class="r num">' + (top ? fmtDur(top.t1 - top.t0) + ' <span class="dim tf-hide-s">' + fmtClock(top.t0) + '</span>' : '') + '</td></tr>';
  });
  return '<section class="card"><h3>等待与空闲</h3><div class="tblwrap"><table class="tbl tf-tbl"><thead><tr><th>类别</th><th class="r">总时长</th><th class="r">次数</th><th class="r">最长一段</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
    (a.id === 'main' ? '' : '<p class="note tf-note">子代理一般没有「等你回复」。</p>') + '</section>';
}

function focusDispatchInfo(a) {
  const M = timelineModel(), d = M.disp[a.id];
  if (!d) return '<section class="card"><h3>派单与交回</h3><p class="dim">会话里没有找到派出这个代理的调用。</p></section>';
  let first = 0;
  allCalls(a).forEach(x => { if (x.c.ts && (!first || x.c.ts < first)) first = x.c.ts; });
  const back = M.hb[a.id] || d.bgDone || a._e;
  const row = (k, v) => '<tr><td>' + k + '</td><td class="r num">' + v + '</td></tr>';
  return '<section class="card"><h3>派单与交回</h3><div class="tblwrap"><table class="tbl tf-tbl"><tbody>' +
    row('派单时刻（' + esc(A[d.parent] ? clip(A[d.parent].desc, 24) : d.parent) + '）', fmtTS(d.ts)) +
    row('派单 → 子代理开始', a.start ? fmtDur(Math.max(0, a.start - d.ts)) : '-') +
    row('派单 → 第一次工具调用', first ? fmtDur(Math.max(0, first - d.ts)) : '没有工具调用') +
    row('派单 → 交回', back ? fmtDur(Math.max(0, back - d.ts)) : '-') + '</tbody></table></div></section>';
}

function focusWaitsOnChildren(a, T) {
  const sub = T.segs.filter(sg => sg.cat === 'subwait'), seen = {}, rows = [];
  T.spans.forEach(sp => {
    if (seen[sp.id]) return;
    seen[sp.id] = 1;
    let w = 0;
    for (let i = lowerByEnd(sub, sp.t0, 't1'); i < sub.length && sub[i].t0 < sp.t1; i++) w += Math.max(0, Math.min(sub[i].t1, sp.t1) - Math.max(sub[i].t0, sp.t0));
    rows.push({sp, w, run: sp.t1 - sp.t0});
  });
  rows.sort((x, y) => y.w - x.w || y.run - x.run);
  const runSum = rows.reduce((m, r) => m + r.run, 0), shown = rows.slice(0, 30);
  return '<section class="card"><h3>在等哪些子代理（' + rows.length + '）</h3><div class="tblwrap"><table class="tbl tf-tbl"><thead><tr><th>子代理</th><th class="r tf-hide-s">运行区间</th><th class="r">运行</th><th class="r">其间在等</th></tr></thead><tbody>' +
    shown.map(r => '<tr><td>' + (A[r.sp.id] ? mdAgentRef(r.sp.id, clip(A[r.sp.id].desc, 50)) : esc(r.sp.id)) + '</td><td class="r num tf-hide-s">' + fmtTS(r.sp.t0) + ' → ' + fmtClock(r.sp.t1) +
      '</td><td class="r num">' + fmtDur(r.run) + '</td><td class="r num">' + (r.w ? fmtDur(r.w) + ' <span class="dim">' + pct(r.w, r.run) + '</span>' : '<span class="dim">没在等</span>') + '</td></tr>').join('') +
    '</tbody></table></div><p class="note tf-note"><b>合计在等 ' + fmtDur(T.by.subwait) + '</b>（墙钟时间：几个子代理同时在跑的时候，重叠部分只算一次）；各子代理运行时长相加是 ' + fmtDur(runSum) +
    '，所以各行的「其间在等」可以互相重叠，不能直接相加。' + (rows.length > shown.length ? '只列出前 ' + shown.length + ' 个。' : '') + '</p></section>';
}

function renderFocusStats(a, T, host) {
  host.innerHTML = '<h2>耗时分析</h2><div class="tf-grid">' + focusCatBars(a, T) + focusWaits(a, T) + '</div>' +
    '<div class="tf-grid">' + focusTopSteps(a, T) + focusRepeatCmds(T) + '</div>' +
    (a.id !== 'main' || T.spans.length ? '<div class="tf-grid">' + (a.id !== 'main' ? focusDispatchInfo(a) : '') + (T.spans.length ? focusWaitsOnChildren(a, T) : '') + '</div>' : '');
  const go = el => {
    const tr = el.closest('[data-jt]');
    if (tr) jumpTo(a.id, +tr.dataset.jt, false, tr.dataset.n == null ? null : +tr.dataset.n);
  };
  host.addEventListener('click', e => { if (!e.target.closest('a')) go(e.target); });
  host.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-jt]')) go(e.target); });
}
