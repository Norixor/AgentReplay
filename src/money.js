'use strict';
/* Estimated amount (USD) and token display, shared by every view. The amount is the main value, the token total the
 * secondary one; the token breakdown is in the hover title. Amounts are estimates from the official list prices
 * (prices.json), not a bill. A step whose model has no price has no amount (cost == null) but its tokens count. */

const TOK_PARTS = [['in', '未缓存输入'], ['cw5', '缓存写入（5 分钟）'], ['cw1', '缓存写入（1 小时）'], ['cr', '缓存读取'], ['out', '输出']];

/* Under one cent "<$0.01", under $100 two decimals, above that whole dollars with thousands separators. */
function fmtMoney(c) {
  if (c == null) return '—';
  if (c <= 0) return '$0.00';
  if (c < 0.01) return '<$0.01';
  return c < 100 ? '$' + c.toFixed(2) : '$' + Math.round(c).toLocaleString('en-US');
}
/* The same text escaped for HTML ("<$0.01" must not open a tag). */
function moneyH(c) { return esc(fmtMoney(c)); }
/* Token total: uncached input + cache writes + cache reads + output. */
function tokSum(t) { return t ? (t.in || 0) + (t.cw5 || 0) + (t.cw1 || 0) + (t.cr || 0) + (t.out || 0) : 0; }
function fmtTokFull(n) { return Math.round(n || 0).toLocaleString('en-US'); }

/* Plain-text breakdown for a title attribute. */
function tokTitle(t, note) {
  if (!t) return '';
  const lines = TOK_PARTS.filter(p => t[p[0]] || p[0] === 'in' || p[0] === 'out').map(p => p[1] + ' ' + fmtTokFull(t[p[0]]));
  if (t.rsn != null) lines.push('其中推理 ' + fmtTokFull(t.rsn) + '（已含在输出里）');
  lines.push('合计 ' + fmtTokFull(tokSum(t)) + ' token');
  return (note ? note + '\n' : '') + lines.join('\n');
}
/* Per-step flags -> a short note for the title. */
function stepNote(s) {
  const n = [];
  if (s.cost == null) n.push('模型未定价，未计入金额');
  if (s.local) n.push('本地模型，金额记为 0');
  if (s.fast) n.push('快速模式，按标准价计');
  return n.join('；');
}

/* Amount plus tokens. opts.inline puts them on one line ("$1.20 · 12.3k"), otherwise the tokens sit under the amount. */
function costHTML(cost, tok, opts) {
  opts = opts || {};
  const title = esc(tokTitle(tok, opts.note));
  const money = cost == null ? '<span class="mny unp" title="' + title + '">未定价</span>' : '<span class="mny" title="' + title + '">' + moneyH(cost) + '</span>';
  const tk = '<span class="tkv" title="' + title + '">' + fmtTok(tokSum(tok)) + (opts.unit === false ? '' : ' token') + '</span>';
  return money + (opts.inline ? ' · ' : '') + tk;
}
function stepCostHTML(s, opts) { return costHTML(s.cost, s.tok, Object.assign({note: stepNote(s)}, opts || {})); }

/* "N 步模型未定价，未计入金额" and similar, for the aggregates (an agent, the session). */
function unpricedNote(x) {
  const p = [];
  if (x.nUnp) p.push(x.nUnp + ' 步模型未定价，未计入金额' + (x.unpModels && x.unpModels.length ? '（' + x.unpModels.map(esc).join('、') + '）' : ''));
  if (x.nLocal) p.push(x.nLocal + ' 步为本地模型，金额记为 0');
  if (x.nFast) p.push(x.nFast + ' 步为快速模式，按标准价计');
  return p.join('；');
}

/* Sum of the steps' amounts (priced steps only) and tokens. */
function sumSteps(steps) {
  const out = {cost: 0, tok: {in: 0, cw5: 0, cw1: 0, cr: 0, out: 0}, nUnp: 0};
  steps.forEach(s => {
    out.cost += s.cost || 0;
    if (s.cost == null) out.nUnp++;
    ['in', 'cw5', 'cw1', 'cr', 'out'].forEach(k => { out.tok[k] += s.tok[k] || 0; });
  });
  return out;
}
