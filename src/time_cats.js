'use strict';
/* "Time by category" for the overview and the main agent's replay. The numbers come from timeseg.js only
 * (timeByCategory), the same segmentation as the timeline, so the categories and colours match it. */

/* Bars for one {category: ms} map; shares are of the sum, which is the agent's lifetime for a single agent. */
function timeCatBars(by) {
  const total = TS_ORDER.reduce((x, k) => x + (by[k] || 0), 0);
  const list = TS_ORDER.filter(k => by[k] > 0).sort((x, y) => by[y] - by[x]);
  if (!list.length) return '<p class="dim">没有可统计的时间。</p>';
  return list.map(k => bar(esc(TS_CATS[k].label), by[k], by[list[0]], '', '<b>' + fmtDur(by[k]) + '</b> · ' + pct(by[k], total), TS_CATS[k].color)).join('');
}
function timeCatSum(by) { return TS_ORDER.reduce((x, k) => x + (by[k] || 0), 0); }

/* Main agent: wall clock, the categories add up to its total duration. */
function timeCatMain() { return timeByCategory(MAIN); }
/* Every agent's categories added up: parallel agents count once each, so the sum can exceed the wall clock. */
function timeCatAll() {
  const sum = {};
  TS_ORDER.forEach(k => { sum[k] = 0; });
  D.agents.forEach(a => { const by = timeByCategory(a); TS_ORDER.forEach(k => { sum[k] += by[k] || 0; }); });
  return sum;
}

function timeCatMainBlock() {
  const by = timeCatMain();
  return '<h4 class="tc-h">主代理（墙钟）<span class="dim"> · 总时长 ' + fmtDur(timeCatSum(by)) + '，各类别加起来等于总时长</span></h4>' + timeCatBars(by);
}
function timeCatAllBlock() {
  const by = timeCatAll();
  return '<h4 class="tc-h">所有代理合计 <span class="dim"> · ' + fmtDur(timeCatSum(by)) + '（并行会重复计入）</span></h4>' + timeCatBars(by);
}

/* Overview card: both calibres. */
function timeCatCard() {
  return '<section class="card tc-card"><h3>时间：按类别</h3>' + timeCatMainBlock() + (SUBS.length ? timeCatAllBlock() : '') +
    '<p class="note">类别与时间线一致：工具调用按命令分类，另有「等子代理」「思考或输出」「等你回复」「空闲（未知）」。</p></section>';
}
/* Main agent's replay: only the main agent's calibre. */
function timeCatMainCard() {
  return '<section class="card tc-card"><h3>时间：按类别</h3>' + timeCatMainBlock() + '</section>';
}
