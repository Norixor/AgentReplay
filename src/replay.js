'use strict';
/* Core: data access, formatting helpers, labels. Views live in timeline.js / steps.js / views.js. */
const D = JSON.parse(document.getElementById('data').textContent);
const A = {};
D.agents.forEach(a => { A[a.id] = a; });
const MAIN = D.agents[0];
const SUBS = D.agents.slice(1);
/* Source label, chip colour and source-specific explanations, from the server's source registry (sources.py). */
const SRC = D.meta.source || {};
const TOOL_NAME = SRC.label || D.meta.tool || '';
const SRC_NOTES = SRC.notes || {};
/* The live tab exists for sessions active at generation time whose source has a live view (meta.source.live). */
function liveTab() { return !!D.meta.active && SRC.live !== false; }

const CAT_LABEL = {read: '读代码与文档', test: '测试与检查', write: '写代码', git: 'git', wait: '等待与轮询', agent: '派子代理', other: '其他'};
const CAT_SHORT = {read: '读', test: '测', write: '写', git: 'git', wait: '等', agent: '派', other: '其他'};
const EV_LABEL = {
  human: '用户消息', handback: '子代理交回报告', xsession: '跨会话消息', goal: '目标检查', local: '本地命令', interrupt: '用户中断',
  meta: '系统消息', brief: '简报', followup: '续接消息', notify: '后台任务通知', silent: '太久没说话的提醒', hookctx: '钩子注入上下文',
  goalstatus: '目标状态', stophook: 'Stop 钩子', info: '系统提示', compact: '上下文压缩', compactsum: '压缩后的摘要', taskstat: '任务状态',
  image: '图片', localout: '本地命令输出', agentmsg: '代理间消息'
};
const FAMS = ['haiku', 'sonnet', 'opus', 'fable'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}
const p2 = n => (n < 10 ? '0' : '') + n;
function fmtClock(ms) { const d = new Date(ms); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
function fmtDay(ms) { const d = new Date(ms); return p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
function fmtDT(ms) { return ms ? fmtDay(ms) + ' ' + fmtClock(ms) : '-'; }
/* Local time; the date is added when it differs from the session's first day ("10-12 21:44:05"). */
const DAY0 = fmtDay(D.meta.start || Date.now());
function fmtTS(ms) { return !ms ? '-' : (fmtDay(ms) === DAY0 ? '' : fmtDay(ms) + ' ') + fmtClock(ms); }
function fmtHM(ms) { const d = new Date(ms); return (fmtDay(ms) === DAY0 ? '' : fmtDay(ms) + ' ') + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
function fmtDur(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return (ms < 1 ? 0 : Math.round(ms)) + ' 毫秒';
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + ' 秒';
  // Round once on whole seconds so 59.6 s becomes "1 分", never "60 秒" or "14 分 60 秒".
  const t = Math.round(s);
  if (t < 60) return t + ' 秒';
  const m = Math.floor(t / 60), r = t % 60;
  if (m < 60) return m + ' 分' + (r ? ' ' + r + ' 秒' : '');
  const h = Math.floor(m / 60);
  return h + ' 时 ' + (m % 60) + ' 分';
}
function fmtTok(n) { n = Math.round(n || 0); return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function firstLine(s) { return String(s || '').split('\n').find(l => l.trim()) || ''; }

const FAM_PALETTE = ['#0f9d8a', '#7a6bd8', '#d6568a', '#3d8ed6', '#c9962b', '#4aa05a', '#d6623d', '#7f8c9a'];
function famColor(name) {  // Claude families use theme variables; other model names get a stable palette colour
  if (FAMS.includes(name)) return 'var(--' + name + ')';
  let h = 0;
  String(name).split('').forEach(ch => { h = (h * 31 + ch.charCodeAt(0)) >>> 0; });
  return FAM_PALETTE[h % FAM_PALETTE.length];
}
function famList() { return SRC.fams ? FAMS : (D.meta.models || []); }
function modelFam(m) { m = String(m || ''); return FAMS.includes(m) ? m : ((m.match(/haiku|sonnet|opus|fable/) || [])[0] || m); }
function trigLabel(t) { return t === 'manual' ? '手动' : t === 'auto' ? '自动' : '类型未记录'; }
function toolChip() { return '<span class="src"' + (SRC.color ? ' style="background:' + esc(SRC.color) + '"' : '') + '>' + esc(TOOL_NAME) + '</span>'; }
function chipColor(name) { return FAMS.includes(name) ? 'var(--' + name + '-bg)' : famColor(name); }
function famChip(fam, effort) {
  return '<span class="fam" style="background:' + chipColor(fam) + '">' + esc(fam) + (effort ? '<i>·' + esc(effort) + '</i>' : '') + '</span>';
}
function agentChip(model, fam, effort) {
  const name = model && !/claude/.test(model) ? model : fam;
  return famChip(FAMS.includes(name) ? name : fam, effort);
}
function agentLink(id, label) {
  const a = A[id];
  if (!a) return esc(label || id);
  // Opens the agent summary dialog (modal.js); the href stays for middle click and copy link.
  return '<a class="alink" href="#' + (id === 'main' ? 'main' : 'agent/' + esc(id)) + '"' + mdAttr({type: 'agent', agent: id}) + '>' + esc(label || a.desc) + '</a>';
}

/* Long text: clamped to a few lines with a toggle (see util.js); the full text is also the hover title. */
function longText(text, preview, cls) { return clampBlock(text, cls, 3); }

const tip = document.getElementById('tip');
function showTip(html, ev) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 16;
  if (x + r.width > innerWidth - 6) x = Math.max(6, ev.clientX - r.width - 14);
  if (y + r.height > innerHeight - 6) y = Math.max(6, ev.clientY - r.height - 14);
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function hideTip() { tip.hidden = true; }

/* Per-agent derived data used by several views. */
function allCalls(a) {
  const out = [];
  a.turns.forEach(t => t.steps.forEach(s => s.calls.forEach(c => out.push({s, c}))));
  return out;
}
