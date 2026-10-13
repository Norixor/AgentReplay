'use strict';
/* Live tab: running-agent cards, recent event stream and consumption rate, fed by /api/live/<tool>/<id>. */

const LV = {data: null, fetchedAt: 0, rtt: 0, err: '', paused: false, inflight: false, timer: 0, tick: 0, root: null, hist: [], view: 'route', route: null};

/* The live tab always opens on the fork-route map. Switching to the agent graph or the cards only lasts for this page view (nothing is stored). */
function liveSetView(v) {
  LV.view = v;
  const root = LV.root;
  if (!root) return;
  root.querySelectorAll('.lv-vbtn').forEach(b => { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  root.classList.toggle('wide', v === 'graph' || v === 'route');   // both canvases use the full width of the content area
  grSetActive(v === 'graph');
  const rh = root.querySelector('#lv-route');
  rh.hidden = v !== 'route';
  if (v === 'route') {
    if (!LV.route) {   // built lazily: it needs a visible container to measure
      LV.route = renderRoute(rh, {live: true, key: D.meta.liveKey, skew: () => (LV.data && LV.fetchedAt ? LV.data.now - LV.fetchedAt : 0)});
      if (LV.data) LV.route.onLive(LV.data);
    } else LV.route.setActive(true);
  } else if (LV.route) LV.route.setActive(false);
  paintLive();
}
const LSTATE = {exec: ['执行中', 'exec'], think: ['思考或输出中', 'think'], waiting: ['等子代理', 'waiting'], idle: ['空闲', 'idle'], done: ['已交回', 'think']};
const EV_KIND = {user: '用户消息', dispatch: '派单', handback: '子代理交回', hook: '钩子拦截', merge: '合入主线', compact: '压缩', fail: '失败调用'};

async function liveFetch() {
  if (LV.inflight) return;
  LV.inflight = true;
  const t0 = performance.now();
  try {
    const r = await fetch('/api/live/' + D.meta.liveKey, {cache: 'no-store'});
    const j = await r.json();
    if (j.restarting) { LV.updating = true; LV.inflight = false; paintLive(); setTimeout(() => { if (!LV.paused) liveFetch(); }, 3000); return; }
    if (!j.ok) throw new Error(j.error || ('HTTP ' + r.status));
    LV.updating = false;
    LV.rtt = Math.round(performance.now() - t0);
    LV.hist.push(LV.rtt);
    if (LV.hist.length > 40) LV.hist.shift();
    LV.data = j;
    LV.fetchedAt = Date.now();
    LV.err = '';
  } catch (e) {
    LV.err = String(e && e.message || e);
    if (LV.updating) LV.err = '';  // the server is restarting after a source update: keep the notice, not an error
  }
  LV.inflight = false;
  paintLive();
}

function liveSchedule() {
  clearTimeout(LV.timer);
  if (LV.paused || document.hidden || !LV.root || !LV.root.isConnected) return;
  const cfg = (LV.data && LV.data.cfg) || {pollSec: 5, slowPollSec: 60};
  const sec = LV.data && LV.data.ended ? cfg.slowPollSec : cfg.pollSec;
  LV.timer = setTimeout(async () => { await liveFetch(); liveSchedule(); }, sec * 1000);
}

function stateBadge(c) {
  const [txt, cls] = LSTATE[c.state] || ['未知', 'idle'];
  return '<span class="lst ls-' + cls + '">' + txt + '</span>';
}

function cardNow(c) {
  const d = c.detail || {};
  if (c.state === 'exec' || (c.state === 'waiting' && d.tool)) {
    const what = esc(d.tool || '') + (d.desc ? ' · ' + esc(d.desc) : '') + (d.sum && d.sum !== d.desc ? ' · <span class="mono">' + esc(d.sum) + '</span>' : '');
    return '<div class="lnow" title="' + esc((d.tool || '') + ' ' + (d.desc || '') + ' ' + (d.sum || '')) + '"><span class="clamp-2">' + what + '</span><span class="lel">已执行 <b class="tick" data-ms="' + d.elapsed + '">' + fmtDur(d.elapsed) + '</b>' +
      (d.n > 1 ? ' · 同时 ' + d.n + ' 个调用' : '') + '</span></div>';
  }
  if (c.state === 'think') return '<div class="lnow dim">最后一条是工具结果或用户消息，模型正在思考或输出（<b class="tick" data-ms="' + d.since + '">' + fmtDur(d.since) + '</b> 前）</div>';
  if (d.why) return '<div class="lnow dim">' + esc(d.why) + '</div>';
  return '';
}

function ctxBar(c) {
  const pctv = c.ctxLimit ? c.ctx / c.ctxLimit : 0;
  const cls = pctv >= 1 ? 'over' : pctv >= .8 ? 'near' : '';
  return '<div class="lctx"><div class="ctxbar ' + cls + '" role="progressbar" aria-valuemin="0" aria-valuemax="' + c.ctxLimit + '" aria-valuenow="' + c.ctx + '"><i style="width:' + Math.min(100, pctv * 100) + '%"></i></div>' +
    '<span class="num">上下文 ' + fmtTok(c.ctx) + ' / ' + fmtTok(c.ctxLimit) + '（' + Math.round(pctv * 100) + '%）' + (pctv >= 1 ? ' · 已过压缩点' : c.ctxLimit > c.ctx ? ' · 距压缩点还有 ' + fmtTok(c.ctxLimit - c.ctx) : '') + '</span></div>';
}

function recentList(c) {
  if (!c.recent.length) return '<div class="dim lrecent">还没有步骤。</div>';
  return '<ul class="lrecent">' + c.recent.slice(0, 3).map(r => '<li class="rs-' + esc(r.st) + '"><time class="num">' + fmtClock(r.ts) + '</time><span class="tool cat-other">' + esc(clip(r.tool, 24)) + '</span>' +
    '<span class="rtx"><span class="clamp-2" title="' + esc((r.sum || '') + (r.why ? '\n原因：' + r.why : '')) + '">' + esc(r.sum || '（无摘要）') + '</span>' +
    (r.why ? '<span class="rwhy clamp-2">原因：' + esc(r.why) + '</span>' : '') + '</span>' +
    '<span class="rst">' + (r.st === 'err' ? '<span class="bad">失败</span>' : r.st === 'hook' ? '<span class="bad">拦截</span>' : '') + '</span></li>').join('') + '</ul>';
}

function liveCard(c) {
  const known = !!A[c.id];
  const name = known ? '<a href="' + jumpHash(c.id) + '"' + mdAttr({type: 'agent', agent: c.id}) + '>' + esc(c.desc) + '</a>' : esc(c.desc) + ' <span class="badge">回看数据里还没有</span>';
  const fam = modelFam(c.model || '');
  return '<article class="lcard ls-' + (LSTATE[c.state] || ['', 'idle'])[1] + (c.alerts.length ? ' has-alert' : '') + '"><header><div class="lname">' + (c.id === 'main' ? '主代理' : name) +
    (c.id === 'main' ? ' <span class="dim">' + (known ? '<a href="#main">逐轮回看</a>' : '') + '</span>' : '') + '</div>' + stateBadge(c) + '</header>' +
    '<div class="lmeta">' + (c.model ? agentChip(c.model, fam, c.effort) : '') + ' <span>运行 <b class="tick" data-ms="' + (c.runMs || 0) + '">' + fmtDur(c.runMs || 0) + '</b></span> <span><b class="num">' +
    c.steps + (c.stepsApprox ? '+' : '') + '</b> 步</span> <span class="dim" title="' + esc(tokTitle(c.tok, '读取窗口内（约最近 61 分钟）：' + moneyH(c.costWin))) + '">近 15 分钟 <b class="num">' + moneyH(c.cost15) + '</b> · ' + fmtTok(c.tok15) + ' token</span></div>' +
    cardNow(c) + recentList(c) + ctxBar(c) +
    (c.alerts.length ? '<div class="lalerts">' + c.alerts.map(a => '<span class="al al-' + esc(a.k) + '" title="' + esc(a.text) + '">⚠ ' + esc(a.text) + '</span>').join('') + '</div>' : '') + '</article>';
}

function eventsList(d) {
  if (!d.events.length) return emptyState('最近没有事件', '用户消息、派单、交回、拦截、合入、压缩和失败调用会出现在这里。');
  return '<ul class="levents">' + d.events.map((e, i) => '<li tabindex="0" role="button" data-i="' + i + '" class="ek-' + esc(e.k) + '" title="' + esc(e.text) + '"><time class="num">' + fmtTS(e.ts) + '</time><span class="badge b-ev-' + esc(e.k) + '">' + (EV_KIND[e.k] || esc(e.k)) + '</span>' +
    '<span class="evag">' + esc(clip(e.agentName || e.agent, 24)) + '</span><span class="evtx">' + esc(clip(e.text, 120)) + '</span></li>').join('') + '</ul>';
}

function rateCard(d) {
  const r = d.rate, mx = Math.max(1e-9, ...r.series), tmx = Math.max(1, ...r.tseries);
  const tile = (label, money, sub) => '<div class="stat"><div class="sl">' + label + '</div><div class="sv num">' + money + '</div><div class="ss">' + sub + '</div></div>';
  const unp = d.unpriced && d.unpriced.length ? '<p class="note">模型 ' + d.unpriced.map(esc).join('、') + ' 未定价：token 照常统计，金额未计入。</p>' : '';
  return '<section class="card lrate"><h3>消耗速度（预估金额与 token）</h3><div class="rgrid">' +
    tile('最近 15 分钟', moneyH(r.c15), fmtTok(r.t15) + ' token · 折合每小时 ' + moneyH(r.perHour15)) +
    tile('最近 60 分钟', moneyH(r.c60), fmtTok(r.t60) + ' token') +
    tile('按当前速度，每小时约', moneyH(r.perHour15), fmtTok(r.tPerHour15) + ' token · 以最近 15 分钟 ×4 计') + '</div>' +
    '<div class="spark" aria-label="最近 60 分钟，每 5 分钟一格">' + r.series.map((v, i) => '<i style="height:' + Math.max(2, v / mx * 100) + '%" title="' + moneyH(v) + ' · ' + fmtTok(r.tseries[i]) + ' token"></i>').join('') + '</div>' +
    '<div class="dim spark-lab"><span>60 分钟前</span><span>现在</span></div>' + unp + '</section>';
}

function paintLive() {
  const root = LV.root;
  if (!root || !root.isConnected) return;
  const d = LV.data;
  if (!d) {
    root.querySelector('#lv-body').innerHTML = LV.updating ? emptyState('服务更新中', '源码刚更新，服务正在重启，几秒后自动重试。') : LV.err ? '<div class="empty err"><b>无法读取实时数据</b><span>' + esc(LV.err) + '。导出的静态页面没有实时功能，请从 agent-replay 服务打开。</span><button id="lv-retry">重试</button></div>'
      : emptyState('正在读取实时状态…');
    const rb = root.querySelector('#lv-retry');
    if (rb) rb.onclick = () => { LV.err = ''; paintLive(); liveFetch(); };
    updateLiveBar();
    return;
  }
  const subs = d.cards.length - 1;
  let h = '';
  if (d.ended) h += '<p class="warn">会话可能已结束：超过 ' + Math.round((d.sinceWrite || 0) / 60000) + ' 分钟没有新写入，已改为每 ' + d.cfg.slowPollSec + ' 秒检查一次。</p>';
  if (LV.updating) h += '<p class="warn">服务更新中，几秒后自动重试（保留上次的数据）。</p>';
  if (LV.err) h += '<p class="warn">最近一次刷新失败：' + esc(LV.err) + '（保留上次的数据）</p>';
  if (LV.view === 'cards') h += '<div class="lgrid">' + d.cards.map(liveCard).join('') + '</div>';
  if (d.staleSubs) h += '<p class="note">另有 ' + d.staleSubs + ' 个超过 1 小时没有写入、也没有交回的子代理未列出（可能已被中止）。</p>';
  h += '<div class="cols lcols"><section class="card"><h3>最近事件（' + d.events.length + '）</h3>' + eventsList(d) + '</section>' + rateCard(d) + '</div>';
  root.querySelector('#lv-body').innerHTML = h;
  fitClamps(root);
  root.querySelectorAll('.levents li').forEach(li => {
    const go = () => { const e = d.events[+li.dataset.i]; jumpTo(A[e.agent] ? e.agent : 'main', e.ts, e.k === 'user' || e.k === 'compact'); };
    li.onclick = go;
    li.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } };
  });
  root.querySelector('#lv-sub').textContent = '主代理 1 张 + 在跑的子代理 ' + subs + ' 张';
  grUpdate(d);
  if (LV.route) LV.route.onLive(d);
  updateLiveBar();
}

function updateLiveBar() {
  const root = LV.root;
  if (!root || !root.isConnected) return;
  const d = LV.data, bar = root.querySelector('#lv-stat');
  const age = LV.fetchedAt ? Date.now() - LV.fetchedAt : null;
  const cfg = (d && d.cfg) || {pollSec: 5, slowPollSec: 60};
  bar.innerHTML = (LV.paused ? '<span class="lst ls-idle">已暂停</span>' : document.hidden ? '<span class="lst ls-idle">页面在后台，已暂停刷新</span>' : '<span class="lst ls-think">每 ' + (d && d.ended ? cfg.slowPollSec : cfg.pollSec) + ' 秒更新</span>') +
    ' <span class="dim">上次更新 ' + (age == null ? '—' : '<b>' + Math.floor(age / 1000) + ' 秒前</b>') + (LV.rtt ? ' · 请求 ' + LV.rtt + ' 毫秒' + (d ? '（服务端 ' + d.took + ' 毫秒）' : '') : '') + '</span>';
  root.querySelectorAll('.tick').forEach(el => { el.textContent = fmtDur(+el.dataset.ms + (age || 0)); });
  const gen = D.meta.generated;
  root.querySelector('#lv-snap').textContent = '回看数据生成于 ' + fmtTS(gen) + '（' + ago(Date.now() - gen) + '），之后的步骤不在回看各标签里。';
}

function renderLive(root) {
  root.innerHTML = '<h1>实时 <span class="dim lsub" id="lv-sub"></span></h1>' +
    '<div class="fbar lbar"><span id="lv-stat"></span><span class="grow"></span><span class="lv-vseg" role="group" aria-label="显示方式"><button type="button" class="lv-vbtn" data-v="route" title="分岔路线图：每个代理一条泳道，节点是做的一件事">路线图</button><button type="button" class="lv-vbtn" data-v="graph" title="代理节点图：子代理之间的派单关系">代理图</button><button type="button" class="lv-vbtn" data-v="cards" title="每个代理一张卡片">卡片</button></span><button id="lv-pause">暂停刷新</button><button id="lv-now">立即刷新</button>' +
    '<a class="btn" id="lv-reparse" href="/s/' + esc(D.meta.liveKey) + '" title="重新全量解析这个会话；回看各标签的数据只在点击后才更新">刷新回看数据</a></div>' +
    '<p class="note" id="lv-snap"></p><div id="lv-route" hidden></div><div id="lv-graph" hidden></div><div id="lv-body"></div>';
  LV.root = root;
  grInit(root.querySelector('#lv-graph'), D.meta.liveKey);
  root.querySelectorAll('.lv-vbtn').forEach(b => { b.onclick = () => liveSetView(b.dataset.v); });
  LV.route = null;
  LV.view = 'route';
  liveSetView('route');
  const pause = root.querySelector('#lv-pause');
  pause.onclick = () => { LV.paused = !LV.paused; pause.textContent = LV.paused ? '继续刷新' : '暂停刷新'; if (LV.paused) clearTimeout(LV.timer); else { liveFetch().then(liveSchedule); } updateLiveBar(); };
  pause.textContent = LV.paused ? '继续刷新' : '暂停刷新';
  root.querySelector('#lv-now').onclick = () => { liveFetch().then(liveSchedule); };
  paintLive();
  clearInterval(LV.tick);
  LV.tick = setInterval(updateLiveBar, 1000);
  const onVis = () => { if (document.hidden) clearTimeout(LV.timer); else if (!LV.paused) { liveFetch().then(liveSchedule); } updateLiveBar(); };
  document.addEventListener('visibilitychange', onVis);
  VIEW_CLEANUP.push(() => { grDestroy(); if (LV.route) { LV.route.destroy(); LV.route = null; } clearTimeout(LV.timer); clearInterval(LV.tick); document.removeEventListener('visibilitychange', onVis); LV.root = null; });
  // Always load once so a tab opened in the background is not blank; liveSchedule() still skips polling while hidden.
  if (!LV.paused) liveFetch().then(liveSchedule);
}
