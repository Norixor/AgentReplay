'use strict';
/* Flow graph, part 2: node markup (run time, steps and speed, tokens, context bar, current call, last 3 steps, alerts; the main agent adds sub-agent counts and the last user message). A node is built once and then updated field by field, so CSS animations and the
 * context-bar transition survive the 5-second data refresh. */

const GR_ICON = {
  exec: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  think: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3" cy="8" r="1.6" fill="currentColor"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><circle cx="13" cy="8" r="1.6" fill="currentColor"/></svg>',
  waiting: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2h8M4 14h8M5 2c0 4 3 4 3 6s-3 2-3 6M11 2c0 4-3 4-3 6s3 2 3 6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  idle: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4" y="3" width="2.6" height="10" rx=".8" fill="currentColor"/><rect x="9.4" y="3" width="2.6" height="10" rx=".8" fill="currentColor"/></svg>',
  done: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};
const GR_STATE_TXT = {exec: '执行中', think: '思考或输出中', waiting: '等子代理', idle: '空闲', done: '已交回'};
const GR_ALERT_TXT = {longcmd: '长命令', poll: '轮询', steps: '步数多', ctx: '过压缩点', hook: '被拦截', fail: '连续失败'};

function grNodeEl(n) {
  const el = document.createElement('div');
  el.className = 'gr-node';
  el.dataset.id = n.id;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el._sig = {};
  if (n.kind === 'sum') {
    el.classList.add('gr-sumnode');
    el.innerHTML = '<div class="gr-card st-idle"><div class="gr-sumcount"></div><div class="gr-sumnames dim"></div></div><i class="gr-slot in"></i>';
    return el;
  }
  const main = n.id === 'main';
  el.classList.toggle('gr-main', main);
  el.innerHTML = '<div class="gr-card"><div class="gr-glow"></div><div class="gr-title"><span class="gr-chk" aria-hidden="true">' + GR_ICON.done + '</span><span class="gr-name"></span><span class="gr-badge"></span></div>' +
    '<div class="gr-body"><div class="gr-state"><span class="gr-sic"></span><span class="gr-sttx"></span><span class="gr-steps num"></span></div>' +
    '<div class="gr-row gr-run"></div><div class="gr-row gr-tok"></div>' +
    '<div class="gr-ctx"><div class="gr-ctxbar" role="progressbar" aria-label="上下文用量"><i></i></div><span class="gr-ctxt num"></span></div>' +
    '<div class="gr-call"><div class="gr-call1"><span class="gr-tool"></span><span class="gr-el"></span></div><div class="gr-desc"></div></div>' +
    '<ul class="gr-mini"></ul><div class="gr-alerts"></div>' +
    (main ? '<div class="gr-mainx"><div class="gr-subs"></div><div class="gr-lastu"></div></div>' : '') + '</div></div>' +
    (main ? '' : '<i class="gr-slot in"></i>') + '<i class="gr-slot out"></i>';
  const q = s => el.querySelector(s);
  el._r = {card: q('.gr-card'), name: q('.gr-name'), badge: q('.gr-badge'), sic: q('.gr-sic'), sttx: q('.gr-sttx'), steps: q('.gr-steps'), tool: q('.gr-tool'), el: q('.gr-el'),
           desc: q('.gr-desc'), bar: q('.gr-ctxbar'), fill: q('.gr-ctxbar i'), ctxt: q('.gr-ctxt'), alerts: q('.gr-alerts'), state: q('.gr-state'),
           run: q('.gr-run'), tok: q('.gr-tok'), mini: q('.gr-mini'), subs: q('.gr-subs'), lastu: q('.gr-lastu')};
  return el;
}

/* Sets a field only when it changed (keeps running animations untouched). */
function grSet(el, key, val, apply) {
  if (el._sig[key] === val) return false;
  el._sig[key] = val;
  apply(val);
  return true;
}

/* What the "current call" area shows for each state: [tool label, description, elapsed label, elapsed ms | null, extra]. */
function grCallInfo(c) {
  const d = c.detail || {};
  if (c.state === 'exec' || (c.state === 'waiting' && d.tool)) {
    return [d.tool || '', d.desc || d.sum || '', '已执行', d.elapsed, d.n > 1 ? d.n + ' 个调用同时在跑' : (d.desc && d.sum && d.sum !== d.desc ? d.sum : '')];
  }
  if (c.state === 'think') return ['', '模型正在思考或输出', '距上次写入', d.since, ''];
  if (c.state === 'done') return ['', c.doneTs ? '于 ' + fmtClock(c.doneTs) + ' 交回' : '已交回', '', null, ''];
  return ['', d.why || '', '', null, ''];
}

function grStepsText(c) { return c.steps + (c.stepsApprox ? '+' : '') + ' 步 · ' + (c.spm == null ? '—' : c.spm) + ' 步/分'; }
function grTokText(c) { return fmtMoney(c.costWin) + ' · ' + fmtTok(c.tokTotal || 0) + ' token'; }

function grUpdateNode(el, n, ageMs) {
  if (n.kind === 'sum') {
    const ids = Array.from(GR.retired);
    grSet(el, 'sum', ids.length, () => {
      el.querySelector('.gr-sumcount').textContent = '已交回 ' + ids.length + ' 个';
      el.setAttribute('aria-label', '已交回 ' + ids.length + ' 个子代理，点击查看');
    });
    grSet(el, 'names', ids.slice(-3).join(','), () => {
      el.querySelector('.gr-sumnames').textContent = ids.slice(-3).map(i => (GR.names[i] || i).slice(0, 18)).join('、') + (ids.length > 3 ? ' 等' : '');
    });
    return;
  }
  const c = n.card, r = el._r;
  const fam = modelFam(c.model || '');
  grSet(el, 'color', fam, () => { el.style.setProperty('--gc', chipColor(fam || 'sonnet')); });
  const state = c.state in GR_STATE_TXT ? c.state : 'idle';
  grSet(el, 'state', state, () => {
    r.card.classList.remove('st-exec', 'st-think', 'st-waiting', 'st-idle', 'st-done');
    r.card.classList.add('st-' + state);
    r.sic.innerHTML = GR_ICON[state];
    r.sttx.textContent = GR_STATE_TXT[state];
    el.dataset.state = state;
  });
  const name = c.id === 'main' ? '主代理' : (c.desc || c.id);
  grSet(el, 'name', name, () => { r.name.textContent = name; r.name.title = name; el.setAttribute('aria-label', name + '，' + GR_STATE_TXT[state] + '，点击查看最近几步，双击查看概要'); });
  grSet(el, 'badge', (c.model || '') + '|' + (c.effort || ''), () => { r.badge.textContent = (fam || '?') + (c.effort ? '·' + c.effort : ''); r.badge.title = c.model || ''; });
  grSet(el, 'steps', grStepsText(c), v => { r.steps.textContent = v; r.steps.title = '步数和最近 5 分钟的速度'; });
  grSet(el, 'runk', c.start ? 's' : '-', () => {
    r.run.innerHTML = c.start ? '已运行 <b class="tick" data-ms="0"></b> · 开始 ' + fmtClock(c.start) : '';
  });
  const rt = r.run.querySelector('.tick');
  if (rt) { rt.dataset.ms = Math.max(0, c.runMs || 0); rt.textContent = fmtDur(Math.max(0, c.runMs || 0) + (ageMs || 0)); }
  grSet(el, 'tok', grTokText(c) + '|' + ((c.tok && c.tok.cr) || 0), v => { r.tok.textContent = grTokText(c); r.tok.title = tokTitle(c.tok, '读取窗口内（约最近 61 分钟）的预估金额与用量'); });
  const ci = grCallInfo(c);
  grSet(el, 'tool', ci[0], v => { r.tool.textContent = v; r.tool.hidden = !v; });
  grSet(el, 'desc', ci[1] + '|' + ci[4], () => {
    r.desc.textContent = ci[1] + (ci[4] ? ' · ' + ci[4] : '');
    r.desc.title = (ci[0] ? ci[0] + ' ' : '') + ci[1] + (ci[4] ? ' · ' + ci[4] : '');
  });
  /* elapsed: a .tick element, advanced every second by updateLiveBar() between refreshes */
  grSet(el, 'elk', ci[2] + (ci[3] == null ? '-' : 'v'), () => {
    r.el.innerHTML = ci[3] == null ? '' : ci[2] + ' <b class="tick" data-ms="0"></b>';
  });
  const tk = r.el.querySelector('.tick');
  if (tk) { tk.dataset.ms = Math.max(0, ci[3] || 0); tk.textContent = fmtDur(Math.max(0, ci[3] || 0) + (ageMs || 0)); }
  const lim = c.ctxLimit || (LV.data && LV.data.cfg && LV.data.cfg.ctxLimit) || 400000;
  const pv = lim ? c.ctx / lim : 0;
  r.fill.style.width = Math.min(100, pv * 100).toFixed(1) + '%';
  grSet(el, 'ctxcls', pv >= 1 ? 'over' : pv >= .8 ? 'near' : '', v => { r.bar.className = 'gr-ctxbar ' + v; });
  r.bar.setAttribute('aria-valuenow', c.ctx);
  r.bar.setAttribute('aria-valuemax', lim);
  grSet(el, 'ctxt', fmtTok(c.ctx) + '/' + fmtTok(lim) + '|' + Math.round(pv * 100), () => {
    r.ctxt.textContent = '上下文 ' + fmtTok(c.ctx) + '/' + fmtTok(lim) + ' · ' + Math.round(pv * 100) + '%';
    r.ctxt.title = pv >= 1 ? '已过压缩点' : '距压缩点还有 ' + fmtTok(Math.max(0, lim - c.ctx));
  });
  const rec = (c.recent || []).slice(0, 3);
  grSet(el, 'mini', rec.map(x => x.n + x.ts + x.tool + x.st + (x.why || x.sum)).join('|'), () => {
    r.mini.innerHTML = rec.length ? rec.map(x => '<li class="rs-' + esc(x.st) + '"><time class="num">' + fmtClock(x.ts) + '</time><span class="gr-mtool">' + esc(clip(x.tool, 10)) + '</span><span class="gr-mwhy">' + esc(x.why || x.sum || '（无摘要）') + '</span></li>').join('') : '<li class="dim">还没有步骤</li>';
  });
  grSet(el, 'al', c.alerts.map(a => a.k + a.text).join('|'), () => {
    r.alerts.innerHTML = c.alerts.map(a => '<span class="al al-' + esc(a.k) + '" title="' + esc(a.text) + '">⚠ ' + esc(GR_ALERT_TXT[a.k] || a.k) + '</span>').join('');
  });
  if (c.id === 'main' && r.subs && GR.d) {
    const running = Math.max(0, (GR.d.cards || []).length - 1);
    const back = new Set((GR.d.returned || []).map(x => x.id));
    GR.retired.forEach(i => back.add(i));
    grSet(el, 'subs', running + '|' + back.size, () => { r.subs.innerHTML = '子代理 在跑 <b>' + running + '</b> · 已交回 <b>' + back.size + '</b>'; });
    const lu = GR.d.lastUser ? clip(String(GR.d.lastUser.text).replace(/\s+/g, ' '), 60) : '';
    grSet(el, 'lastu', lu, () => { r.lastu.textContent = lu ? '最近用户消息：' + lu : '最近没有用户消息'; r.lastu.title = GR.d.lastUser ? GR.d.lastUser.text : ''; });
  }
  el.classList.toggle('is-done', !!c.done);
}
