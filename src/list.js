'use strict';
/* Session list: filters, sorting and navigation. Active sessions are pinned on top and their live columns refresh every 15 s. */
const $ = id => document.getElementById(id);
const p2 = n => (n < 10 ? '0' : '') + n;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
function fmtT(ms) {
  if (!ms) return '-';
  const d = new Date(ms), md = p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '-' + md;
}
function fmtSize(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB'; }
function dayStart(s) { return s ? new Date(s + 'T00:00:00').getTime() : null; }

const LSTATE = {exec: '执行中', think: '思考中', waiting: '等子代理', idle: '空闲'};
const LORDER = {exec: 0, think: 1, waiting: 2, idle: 3};
const COLS = [
  {k: 'tool', t: '来源', v: r => r.tool},
  {k: 'name', t: '会话名', v: r => r.name || ''},
  {k: 'project', t: '项目 / 工作目录', v: r => r.project || '', cls: 'hn'},
  {k: 'start', t: '开始', v: r => r.start || 0, cls: 'hn'},
  {k: 'end', t: '最后更新', v: r => r.end || 0},
  {k: 'size', t: '大小', v: r => r.size, cls: 'r hn'},
  {k: 'subs', t: '子代理', v: r => r.subs, cls: 'r hn'},
  {k: 'live', t: '当前状态', v: r => r.live ? 4 - (LORDER[r.live.state] || 0) : r.status === 'active' ? 1 : 0},
  {k: 'status', t: '状态', v: r => r.status === 'active' ? 2 : r.archived ? 1 : 0, cls: 'hn'}
];
let rows = [], sortKey = 'end', asc = false, shown = 150, lastAuto = 0, state = 'loading', errMsg = '';
const PAGE = 150;

function statusOf(r) { return r.status === 'active' ? 'active' : r.archived ? 'archived' : 'idle'; }

function filtered() {
  const tool = $('f-tool').value, proj = $('f-proj').value, st = $('f-status').value, q = $('f-q').value.trim().toLowerCase();
  const from = dayStart($('f-from').value), to = dayStart($('f-to').value);
  return rows.filter(r => (!tool || r.tool === tool) && (!proj || r.cwd === proj) && (!st || statusOf(r) === st) &&
    (!q || ((r.name || '') + ' ' + r.project + ' ' + r.id).toLowerCase().indexOf(q) >= 0) &&
    (!from || (r.end || 0) >= from) && (!to || (r.end || 0) < to + 86400000));
}

function liveCell(r) {
  if (r.status !== 'active') return '';
  if (!r.live) return '<span class="st st-active">进行中</span>';
  const n = r.live.running;
  return '<span class="lst ls-' + esc(r.live.state) + '">' + (LSTATE[r.live.state] || '进行中') + '</span>' + (n ? ' <span class="subn num" title="还没交回、最近 5 分钟有写入的子代理">' + n + ' 个子代理在跑</span>' : '');
}

function draw() {
  const col = COLS.find(c => c.k === sortKey);
  const list = filtered().sort((a, b) => {
    const x = col.v(a), y = col.v(b);
    const c = typeof x === 'string' ? x.localeCompare(y, 'zh') : x - y;
    return asc ? c : -c;
  });
  // Active sessions always come first (stable, so the chosen sort still orders each group).
  const act = list.filter(r => r.status === 'active'), rest = list.filter(r => r.status !== 'active');
  const all = act.concat(rest);
  $('head').innerHTML = COLS.map(c => '<th data-k="' + c.k + '" class="' + (c.cls || '') + (c.k === sortKey ? ' on' + (asc ? ' asc' : '') : '') + '" tabindex="0" aria-sort="' +
    (c.k === sortKey ? (asc ? 'ascending' : 'descending') : 'none') + '">' + c.t + '</th>').join('');
  $('rows').innerHTML = all.slice(0, shown).map(r => {
    const href = '/s/' + r.tool + '/' + encodeURIComponent(r.id);
    const name = r.name || '(未命名)';
    return '<tr data-href="' + href + '" class="' + (r.status === 'active' ? 'is-active' : '') + '"><td><span class="src src-' + r.tool + '">' + (r.tool === 'claude' ? 'Claude Code' : 'Codex') + '</span></td>' +
      '<td class="nm' + (r.named ? '' : ' un') + '" title="' + esc(name + '\n' + r.id) + '"><a href="' + href + '">' + esc(name) + '</a> <button type="button" class="cp" data-cp="' + esc(r.id) + '" title="复制会话 id" aria-label="复制会话 id">id</button></td>' +
      '<td class="proj hn" title="' + esc(r.cwd) + '">' + esc(r.project) + '</td><td class="t hn">' + fmtT(r.start) + '</td><td class="t">' + fmtT(r.end) + '</td>' +
      '<td class="num hn">' + fmtSize(r.size) + '</td><td class="num hn">' + (r.subs || '') + '</td>' +
      '<td class="livecell">' + liveCell(r) + '</td>' +
      '<td class="hn">' + (r.status === 'active' ? '' : r.archived ? '<span class="st">已归档</span>' : '') + '</td></tr>';
  }).join('');
  const nAct = act.length;
  $('count').textContent = '显示 ' + Math.min(shown, all.length) + ' / 符合 ' + all.length + ' / 共 ' + rows.length + ' 个会话' + (nAct ? ' · ' + nAct + ' 个进行中（置顶）' : '');
  $('empty').hidden = all.length > 0 || state !== 'ok';
  $('more').hidden = all.length <= shown;
  const st = $('state');
  st.hidden = state === 'ok';
  st.className = 'empty' + (state === 'error' ? ' err' : '');
  st.innerHTML = state === 'loading' ? '<b>正在读取会话索引…</b><span>第一次扫描大量会话文件可能要几秒。</span>'
    : state === 'error' ? '<b>读取会话列表失败</b><span>' + esc(errMsg) + '。请确认 agent-replay serve 仍在运行。</span><button type="button" id="retry">重试</button>' : '';
  const rt = $('retry');
  if (rt) rt.onclick = () => load(false);
}

function fillProjects() {
  const cur = $('f-proj').value, m = {};
  rows.forEach(r => { if (r.cwd) m[r.cwd] = (m[r.cwd] || 0) + 1; });
  $('f-proj').innerHTML = '<option value="">全部</option>' + Object.keys(m).sort().map(c =>
    '<option value="' + esc(c) + '">' + esc(c.replace(/^\/Users\/[^/]+/, '~')) + '（' + m[c] + '）</option>').join('');
  $('f-proj').value = cur;
}

async function load(force) {
  $('refresh').disabled = true;
  $('refresh').textContent = force ? '扫描中…' : '加载中…';
  if (!rows.length) { state = 'loading'; draw(); }
  try {
    const r = await fetch('/api/sessions' + (force ? '?refresh=1' : ''), {cache: 'no-store'});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    rows = d.rows;
    state = 'ok';
    $('meta').textContent = '索引 ' + d.stats.total + ' 个文件，本次重扫 ' + d.stats.scanned + ' 个，用时 ' + d.stats.seconds.toFixed(2) + ' 秒';
    fillProjects();
    lastAuto = Date.now();
  } catch (e) {
    state = 'error';
    errMsg = String(e && e.message || e);
  }
  draw();
  $('refresh').disabled = false;
  $('refresh').textContent = '刷新';
}

/* Light poll: only the active sessions' status columns. An unknown active key means a new session, so reload the whole list. */
async function pollLive() {
  if (document.hidden || state !== 'ok') return;
  try {
    const r = await fetch('/api/live-list', {cache: 'no-store'});
    if (!r.ok) return;
    const d = await r.json();
    const byKey = {};
    rows.forEach(x => { byKey[x.key] = x; });
    let unknown = false;
    Object.keys(d.active).forEach(k => {
      const row = byKey[k];
      if (!row) { unknown = true; return; }
      Object.assign(row, {status: 'active', end: d.active[k].end, subs: d.active[k].subs, size: d.active[k].size, live: d.active[k].live});
    });
    rows.forEach(x => { if (x.status === 'active' && !d.active[x.key]) { x.status = ''; x.live = null; } });
    lastAuto = Date.now();
    if (unknown) return load(false);
    draw();
  } catch (e) { /* keep the previous columns */ }
}
setInterval(pollLive, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastAuto > 15000) pollLive(); });
setInterval(() => {
  const n = rows.some(r => r.status === 'active');
  $('auto').textContent = n && lastAuto ? '进行中会话每 15 秒自动刷新 · 上次 ' + Math.max(0, Math.round((Date.now() - lastAuto) / 1000)) + ' 秒前' : '';
}, 1000);

function sortBy(k) {
  if (!k) return;
  if (k === sortKey) asc = !asc; else { sortKey = k; asc = k === 'name' || k === 'project' || k === 'tool'; }
  draw();
}
$('head').addEventListener('click', e => sortBy(e.target.dataset.k));
$('head').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(e.target.dataset.k); } });
$('rows').addEventListener('click', e => {
  const cp = e.target.closest('[data-cp]');
  if (cp) {
    e.stopPropagation();
    const done = () => { cp.textContent = '已复制'; setTimeout(() => { cp.textContent = 'id'; }, 1100); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cp.dataset.cp).then(done, () => {});
    return;
  }
  if (e.target.closest('a')) return;
  const tr = e.target.closest('tr');
  if (tr) location.href = tr.dataset.href;
});
['f-tool', 'f-proj', 'f-status', 'f-from', 'f-to'].forEach(id => $(id).addEventListener('change', () => { shown = PAGE; draw(); }));
$('f-q').addEventListener('input', () => { shown = PAGE; draw(); });
$('clear').addEventListener('click', () => {
  ['f-tool', 'f-proj', 'f-status', 'f-from', 'f-to', 'f-q'].forEach(id => { $(id).value = ''; });
  shown = PAGE;
  draw();
});
$('more').addEventListener('click', () => { shown += PAGE; draw(); });
$('refresh').addEventListener('click', () => load(true));
window.addEventListener('pageshow', e => { if (e.persisted) load(false); });
load(false);
