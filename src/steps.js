'use strict';
/* Step-by-step replay list shared by the main agent view and the subagent detail view. */

function chip(kind, label, html, full) {
  return '<span class="why w-' + kind + '"' + (full ? ' title="' + esc(clip(full, 1500)) + '"' : '') + '><b>' + label + '</b>' + html + '</span>';
}

function causeText(c) {
  const lab = EV_LABEL[c.k] || c.k;
  if (c.k === 'handback') return lab + '：' + esc(A[c.from] ? A[c.from].desc : c.from || '');
  return lab + (c.text ? '：' + esc(clip(c.text, 110)) : '');
}
function causeFull(c) { return (EV_LABEL[c.k] || c.k) + (c.text ? '：' + c.text : ''); }

function triggerBody(tr, a) {
  switch (tr.k) {
    case 'brief': return longText(a.briefing, 200, 'brief');
    case 'handback': {
      const ch = A[tr.from];
      return '子代理 ' + (ch ? agentLink(ch.id, ch.desc) : esc(tr.from || '')) + ' 交回了最终报告' +
        (tr.ref ? '<span class="dim">（全文见该子代理详情）</span>' : longText(tr.text, 200));
    }
    case 'notify': {
      const ch = A[tr.task];
      return esc(clip(tr.text, 200)) + (ch ? ' ' + agentLink(ch.id, '→ 看子代理') : '') +
        '<span class="dim"> ' + esc(tr.status || '') + (tr.durMs ? ' · 用时 ' + fmtDur(tr.durMs) : '') + '</span>';
    }
    case 'xsession': return '<span class="dim">来自 ' + esc(clip(tr.from, 60)) + '</span> ' + longText(tr.text, 200);
    case 'compact': return '压缩前 ' + fmtTok(tr.pre || 0) + ' token（' + trigLabel(tr.trigger) + '）';
    case 'agentmsg': return '<span class="dim">来自 ' + (A[tr.from] ? agentLink(tr.from, A[tr.from].desc) : esc(clip(tr.from, 60))) + '</span> ' + longText(tr.text, 200);
    default: return longText(tr.text, 200, tr.k);
  }
}

function turnHead(t, a) {
  const tr = t.trig, steps = t.steps;
  const sum = sumSteps(steps);
  const t0 = steps.length ? steps[0].ts : tr.ts, t1 = steps.length ? Math.max.apply(null, steps.map(s => s.end)) : tr.ts;
  const lag = steps.length && tr.ts ? Math.max(0, steps[0].ts - tr.ts) : 0;
  return '<header class="turn-h k-' + esc(tr.k) + '"><div class="th-l"><span class="badge b-' + esc(tr.k) + '">' + esc(EV_LABEL[tr.k] || tr.k) +
    '</span><time>' + fmtTS(tr.ts) + '</time></div><div class="th-body">' + triggerBody(tr, a) + '</div><div class="th-r">' +
    '<span class="num">' + steps.length + '</span> 步 · ' + fmtDur(t1 - t0) + ' · <span class="num">' + costHTML(sum.cost, sum.tok, {inline: true, note: unpricedNote({nUnp: sum.nUnp})}) + '</span>' + (lag > 2000 ? '<br><span class="dim">' + fmtDur(lag) + ' 后开始动作</span>' : '') + '</div></header>';
}

function evLine(e) {
  let body = esc(clip(e.text, 240));
  if (e.k === 'compact') body = '压缩前 ' + fmtTok(e.pre || 0) + ' token（' + trigLabel(e.trigger) + '）';
  if (e.k === 'agentmsg') body = esc(A[e.from] ? A[e.from].desc : clip(e.from, 60)) + '：' + esc(clip(e.text, 200));
  if (e.k === 'goalstatus') body = (e.met ? '已达成' : '未达成') + '：' + esc(clip(e.text, 200));
  if (e.k === 'handback') body = esc(A[e.from] ? A[e.from].desc : e.from) + ' 交回了报告';
  if (e.k === 'notify') body = esc(clip(e.text, 200)) + ' <span class="dim">' + esc(e.status || '') + '</span>';
  const full = (e.text || '').length > 240 ? ' title="' + esc(clip(e.text, 1500)) + '"' : '';
  return '<div class="ev e-' + esc(e.k) + '"' + full + '><time>' + fmtTS(e.ts) + '</time><span class="badge b-' + esc(e.k) + '">' +
    esc(EV_LABEL[e.k] || e.k) + '</span><span>' + body + '</span></div>';
}

function whyHTML(s, c, first, a) {
  const p = [];
  if (first) {
    s.cause.slice(0, 3).forEach(k => p.push(chip('trig', '触发', causeText(k), causeFull(k))));
    if (s.cause.length > 3) p.push('<span class="dim">另有 ' + (s.cause.length - 3) + ' 个事件</span>');
    if (s.said) p.push(chip('said', s.saidSrc === 'prev' ? '说明·上条' : '说明', esc(clip(s.said, 240)), s.said));
    if (s.rsum) p.push(chip('rsum', '推理摘要', esc(clip(firstLine(s.rsum).replace(/\*\*/g, ''), 200)), s.rsum));
  }
  if (c) {
    if (c.desc) p.push(chip('desc', '描述', esc(clip(c.desc, 200)), c.desc));
    if (c.disp) {
      const ch = A[c.agent];
      p.push(chip('disp', '派单', famChip(ch ? modelFam(ch.model || ch.fam) : (c.disp.model || '未记录'), ch ? ch.effort : c.disp.effort) +
        ' ' + (c.disp.bg ? '后台' : '前台') + (c.disp.type ? ' · ' + esc(c.disp.type) : '')));
      if (c.disp.reason) p.push('<span class="reasonline clamp-2" title="' + esc(c.disp.reason) + '">' + esc(c.disp.reason) + '</span>');
    }
    if (c.st === 'hook') p.push(chip('hook', '拦截理由', esc(clip(c.hook, 240)), c.hook));
  }
  if (first && !s.cause.length && !s.said && !(c && c.desc) && s.after != null)
    p.push('<span class="why w-after"><b>承接</b>#' + s.after + ' 的结果</span>');
  return p.join('');
}

function statusHTML(c) {
  if (!c) return '<span class="ok">回复</span>';
  if (c.st === 'hook') return '<span class="bad">被钩子拦截</span>';
  if (c.st === 'err') return '<span class="bad">失败</span>';
  if (c.st === 'pend') return '<span class="dim">无结果</span>';
  if (c.bg) {
    let t = '<span class="bgst">后台</span>';
    if (c.bgDone) t += '<small>' + fmtClock(c.bgDone) + ' 完成' + (c.notif && c.notif.status !== 'completed' ? '·' + esc(c.notif.status) : '') + '</small>';
    return t;
  }
  return '<span class="ok">成功</span>';
}

function durHTML(c) {
  if (!c) return '';
  if (c.bg) return c.bgDur != null ? '<span class="' + (c.bgLong ? 'long' : '') + '">' + fmtDur(c.bgDur) + '</span><small>后台</small>' : '';
  return '<span class="' + (c.long ? 'long' : '') + '">' + (c.dur < 500 ? '<1 秒' : fmtDur(c.dur)) + '</span>';
}

function rowHTML(s, c, ci, first, a, idx) {
  const cat = c ? c.cat : 'other';
  const tool = c ? c.name : '回复';
  const sum = c ? c.sum : clip(firstLine(s.says), 200);
  return '<div class="rw' + (first ? '' : ' cont') + '" data-i="' + idx + '" data-sn="' + s.n + '"><div class="row st-' + (c ? c.st : 'ok') + (c && (c.long || c.bgLong) ? ' is-long' : '') + '">' +
    '<div class="c-time">' + (first ? '<b>' + fmtClock(s.ts) + '</b><small>' + (fmtDay(s.ts) === DAY0 ? '' : fmtDay(s.ts) + ' · ') + '#' + s.n + (s.gap > 1500 ? ' · +' + fmtDur(s.gap) : '') + '</small>' : '<small>↳ 并行</small>') + '</div>' +
    '<div class="c-tool"><span class="tool cat-' + cat + '">' + esc(tool) + '</span></div>' +
    '<div class="c-why">' + whyHTML(s, c, first, a) + '</div>' +
    '<div class="c-cmd" title="' + esc(clip(c && c.inp ? c.inp : sum, 1200)) + '">' + esc(sum) + '</div>' +
    '<div class="c-dur">' + durHTML(c) + '</div>' +
    '<div class="c-cost">' + (first ? stepCostHTML(s, {unit: false}) : '') + '</div>' +
    '<div class="c-ctx">' + (first ? ctxText(s.ctx) : '') + '</div>' +
    '<div class="c-st">' + statusHTML(c) + '</div></div></div>';
}

function pre(label, text, cls, copy) {
  return text ? '<div class="blk ' + (cls || '') + '"><h5>' + label + (copy ? ' ' + copyBtn(text) : '') + '</h5><pre>' + esc(text) + '</pre></div>' : '';
}

/* Why a step happened, assembled by source (also used by the detail dialog, modal.js). */
function detailWhyHTML(s, c) {
  const why = [];
  s.cause.forEach(k => why.push('<li><b>触发事件</b> ' + fmtTS(k.ts) + ' ' + esc(EV_LABEL[k.k] || k.k) + '：' + esc(clip(k.text, 600)) + '</li>'));
  if (s.said) why.push('<li><b>代理的说明</b>（' + (s.saidSrc === 'prev' ? '来自上一条消息' : '同一条消息') + '）<div class="quote">' + esc(s.said) + '</div></li>');
  if (c && c.desc) why.push('<li><b>调用自带的描述</b> ' + esc(c.desc) + '</li>');
  if (s.rsum) why.push('<li><b>推理摘要</b>（模型自述，加密的原始推理不可用）<div class="quote">' + esc(s.rsum) + '</div></li>');
  if (!s.cause.length && s.after != null) why.push('<li><b>承接</b> 上一步 #' + s.after + ' 的结果</li>');
  return '<div class="blk"><h5>为什么调用（按来源拼出，' + esc(SRC_NOTES.why || '') + '）</h5><ul class="whys">' + (why.join('') || '<li class="dim">没有可还原的原因</li>') + '</ul></div>';
}

/* One call of a step: dispatch target, background completion, full input, hook reason, (truncated) result. */
function detailCallHTML(c) {
  const h = [];
  if (c.disp) {
    const ch = A[c.agent];
    let d = '<div class="blk disp"><h5>派单</h5><div>' + (ch ? agentChip(ch.model, ch.fam, ch.effort) + ' ' + agentLink(ch.id, ch.desc) : famChip(c.disp.model, c.disp.effort)) +
      ' · ' + (c.disp.bg ? '后台' : '前台') + (c.disp.type ? ' · ' + esc(c.disp.type) : '') + '</div>';
    if (c.disp.reason) d += '<div class="reasonline">' + esc(c.disp.reason) + '</div>';
    if (ch) {
      d += '<div class="dim">子代理运行 ' + fmtDT(ch.start) + ' → ' + fmtClock(ch.end) + '（' + fmtDur(ch.end - ch.start) + '）· ' + ch.nsteps + ' 步 · 预估金额 ' + costHTML(ch.cost, ch.tok, {inline: true}) + '</div>';
      d += clampBlock(ch.briefing, 'brief', 3);
    }
    h.push(d + '</div>');
  }
  if (c.notif) h.push('<div class="blk"><h5>后台任务完成</h5><div>' + (c.bgDone ? fmtDT(c.bgDone) + '，距启动 ' + fmtDur(c.bgDur) + ' · ' : '') + esc(c.notif.status) + ' · ' + esc(c.notif.text) + '</div></div>');
  h.push(pre(c.name === 'Bash' ? '命令' : '输入', c.inp || c.sum, '', true));
  if (c.st === 'hook') h.push(pre('钩子拦截理由（全文）', c.hook, 'bad'));
  else h.push(pre('结果' + (c.rlen > c.res.length ? '（共 ' + c.rlen + ' 字符，保留前 ' + D.meta.outChars + '）' : ''), c.res, c.st === 'err' ? 'bad' : ''));
  return h.join('');
}

/* Model, token parts, context, amount and timing of a step, as one line. */
function detailTokHTML(s) {
  const t = s.tok, note = stepNote(s);
  if (noUsage()) return '<div class="dim tokline">模型 ' + esc(s.model || s.fam) + (s.effort ? '·' + esc(s.effort) : '') + ' · 上下文 ' + ctxText(s.ctx) +
    (s.think ? ' · 思考 ' + fmtDur(s.think) : '') + ' · 模型间隔 ' + fmtDur(s.gap) + '</div>';
  return '<div class="dim tokline">模型 ' + esc(s.model || s.fam) + (s.effort ? '·' + esc(s.effort) : '') + ' · 未缓存输入 ' + t.in + ' · 缓存写入 ' + (t.cw5 + t.cw1) +
    (t.cw1 ? '（5 分钟 ' + t.cw5 + ' / 1 小时 ' + t.cw1 + '）' : '') + ' · 缓存读取 ' + t.cr + ' · 输出 ' + t.out + (t.rsn != null ? '（含推理 ' + t.rsn + '）' : '') +
    ' · 上下文 ' + fmtTok(s.ctx) + ' · 预估金额 ' + (s.cost == null ? '未定价' : moneyH(s.cost)) + (note ? '（' + esc(note) + '）' : '') +
    (s.think ? ' · 思考 ' + fmtDur(s.think) : '') + ' · 模型间隔 ' + fmtDur(s.gap) + '</div>';
}

function detailHTML(a, s, c) {
  const h = [detailWhyHTML(s, c)];
  if (!c) h.push(pre('回复全文', s.says));
  if (c) h.push(detailCallHTML(c));
  h.push(detailTokHTML(s));
  return h.join('');
}

/* HTML chunks (chronological) for the steps from stFrom and the events from evFrom of turn t. Registers every row in `meta`
 * (filters and the detail view read it) and `byStep`; t._tbl remembers how far this view has rendered, for live appends. */
const turnHuman = t => ['human', 'followup'].includes(t.trig.k) || t.evs.some(e => e.k === 'human');

function turnChunks(a, t, stFrom, evFrom, meta, byStep) {
  const human = turnHuman(t);
  const chunks = [];
  let evi = evFrom;
  const flushEv = n => { while (evi < t.evs.length && t.evs[evi].at <= n) chunks.push(evLine(t.evs[evi++])); };
  for (let si = stFrom; si < t.steps.length; si++) {
    const s = t.steps[si];
    flushEv(si);
    chunks.push(stepRows(a, s, t, human, meta, byStep));
  }
  flushEv(1e9);
  t._tbl = {st: t.steps.length, ev: evi};
  return chunks;
}

/* The rows (one per call) of a step; (re)registers them in meta / byStep. */
function stepRows(a, s, t, human, meta, byStep) {
  const calls = s.calls.length ? s.calls : [null];
  byStep[s.n] = [];
  let html = '';
  calls.forEach((c, ci) => {
    meta.push({s, c, t, human, hay: null});
    byStep[s.n].push(meta.length - 1);
    html += rowHTML(s, c, ci, ci === 0, a, meta.length - 1);
  });
  return html;
}

function turnSection(a, t, ti, meta, byStep) {
  const chunks = turnChunks(a, t, 0, 0, meta, byStep);
  return '<section class="turn" data-ti="' + ti + '" data-human="' + (turnHuman(t) ? 1 : 0) + '">' + turnHead(t, a) + '<div class="turn-b">' + (newestFirst() ? chunks.reverse() : chunks).join('') + '</div></section>';
}

function renderSteps(a, root, jump) {
  const meta = [], byStep = {};
  const turnHtml = a.turns.map((t, ti) => turnSection(a, t, ti, meta, byStep));
  const html = ordered(turnHtml).join('');
  root.innerHTML = '<div class="fbar"><label><input type="checkbox" data-f="disp"> 只看派单</label><label><input type="checkbox" data-f="hook"> 只看被拦截</label>' +
    '<label><input type="checkbox" data-f="long"> 只看超过 60 秒</label><label><input type="checkbox" data-f="user"> 只看用户消息</label>' +
    '<input type="search" class="q" placeholder="搜索原因、命令、结果…" aria-label="搜索步骤"><span class="fcount dim"></span></div>' +
    '<div class="colhead"><div>时间</div><div>工具</div><div>原因（触发 / 说明 / 描述 / 派单）</div><div>命令或输入</div><div class="r">耗时</div><div class="r">预估金额</div><div class="r">上下文</div><div class="r">结果</div></div>' +
    '<div class="steps">' + (html || emptyState('没有记录到步骤', '这个代理还没有产生模型响应。')) + '</div><div class="empty" id="noresult" hidden><b>没有符合条件的步骤</b><span>换个关键词，或取消上面的筛选。</span></div>';
  const f = {disp: false, hook: false, long: false, user: false, q: ''};
  let rows = root.querySelectorAll('.rw'), turns = root.querySelectorAll('.turn');
  const cnt = root.querySelector('.fcount');
  function hay(m) {
    if (m.hay == null) {
      const c = m.c, s = m.s;
      m.hay = [m.t.trig.text, s.said, s.says, c && c.desc, c && c.sum, c && c.inp, c && c.res, c && c.hook, c && c.disp && c.disp.reason]
        .filter(Boolean).join('\n').toLowerCase();
    }
    return m.hay;
  }
  function apply() {
    rows = root.querySelectorAll('.rw');  // live appends add rows and turns
    turns = root.querySelectorAll('.turn');
    const q = f.q.trim().toLowerCase();
    let shown = 0;
    rows.forEach(el => {
      const m = meta[+el.dataset.i], c = m.c;
      let ok = true;
      if (f.disp) ok = ok && !!c && !!c.disp;
      if (f.hook) ok = ok && !!c && c.st === 'hook';
      if (f.long) ok = ok && !!c && !!(c.long || c.bgLong);
      if (f.user) ok = ok && m.human;
      if (q) ok = ok && hay(m).indexOf(q) >= 0;
      el.hidden = !ok;
      if (ok) shown++;
    });
    const filtering = f.disp || f.hook || f.long || f.user || q;
    turns.forEach(tn => {
      const vis = tn.querySelector('.rw:not([hidden])');
      tn.hidden = !!filtering && !vis;
      tn.classList.toggle('filtered', !!filtering);
    });
    cnt.textContent = '显示 ' + shown + ' / ' + rows.length + ' 行';
    root.querySelector('#noresult').hidden = !(filtering && !shown && rows.length);
  }
  root.querySelectorAll('.fbar input[data-f]').forEach(i => i.addEventListener('change', () => { f[i.dataset.f] = i.checked; apply(); }));
  root.querySelector('.q').addEventListener('input', e => { f.q = e.target.value; apply(); });
  root.querySelector('.steps').addEventListener('click', e => {
    if (e.target.closest('a,summary,details,pre,input,button')) return;
    const row = e.target.closest('.row');
    if (!row) return;
    const rw = row.parentNode;
    let d = rw.querySelector('.detail');
    if (!d) {
      const m = meta[+rw.dataset.i];
      d = document.createElement('div');
      d.className = 'detail';
      d.innerHTML = detailHTML(a, m.s, m.c);
      rw.appendChild(d);
      row.classList.add('open');
      fitClamps(d);
      return;
    }
    d.hidden = !d.hidden;
    row.classList.toggle('open', !d.hidden);
  });
  if (rows.length > 1500) root.querySelector('.steps').classList.add('cv');
  apply();
  fitClamps(root);
  root._tbl = {append: info => appendSteps(a, root, meta, byStep, info, apply)};
  if (jump && jump.t) revealStep(root, a, meta, byStep, jump);
}

/* Scroll to and highlight the step (or turn) that was running at jump.t, whatever the list order is. */
function revealStep(root, a, meta, byStep, jump) {
  let el = null;
  if (jump.k === 'turn') {
    const ti = findTurnAt(a, jump.t);
    el = root.querySelector('.turn[data-ti="' + ti + '"] .turn-h');
    const tn = root.querySelector('.turn[data-ti="' + ti + '"]');
    if (tn) tn.hidden = false;
  } else {
    const hit = jump.s != null && byStep[jump.s] ? {s: {n: jump.s}} : findStepAt(a, jump.t);
    if (hit) {
      const idxs = byStep[hit.s.n] || [];
      let pick = idxs[0];
      idxs.forEach(i => { const c = meta[i].c; if (c && c.ts <= jump.t && jump.t <= c.ts + Math.max(c.dur, 1)) pick = i; });
      el = root.querySelector('.rw[data-i="' + pick + '"]');
    }
  }
  if (!el) return;
  if (el.hidden) el.hidden = false;
  const turn = el.closest('.turn');
  if (turn) turn.hidden = false;
  root.querySelectorAll('.hl-jump').forEach(x => x.classList.remove('hl-jump'));
  el.classList.add('hl-jump');
  // Rows of long lists are laid out lazily (content-visibility), so their offsets settle after the first scroll: correct twice.
  const go = () => el.scrollIntoView({block: 'center'});
  frame(go);
  setTimeout(go, 350);
  setTimeout(go, 1000);
}

/* Live update of a rendered list. info (see live_steps.js): {touched: turn indexes with new steps / events, updated: [{s}] steps whose
 * calls changed, redo: turn index to render from scratch or null}. Rows go where the active order puts newer content and the
 * reader's position is kept; new rows flash. */
function appendSteps(a, root, meta, byStep, info, applyFilters) {
  const stepsEl = root.querySelector('.steps');
  if (!stepsEl) return;
  const fresh = [];
  keepScroll(root, '.rw,.turn-h', () => {
    stepsEl.querySelectorAll(':scope > .empty').forEach(e => e.remove());
    info.touched.forEach(ti => {
      const t = a.turns[ti];
      let sec = stepsEl.querySelector('.turn[data-ti="' + ti + '"]');
      if (sec && info.redo === ti) { sec.remove(); sec = null; }
      if (!sec) {
        stepsEl.insertAdjacentHTML(newestFirst() ? 'afterbegin' : 'beforeend', turnSection(a, t, ti, meta, byStep));
        return;
      }
      const from = t._tbl || {st: 0, ev: 0};
      const chunks = turnChunks(a, t, from.st, from.ev, meta, byStep);
      sec.querySelector('.turn-h').outerHTML = turnHead(t, a);
      if (chunks.length) sec.querySelector('.turn-b').insertAdjacentHTML(newestFirst() ? 'afterbegin' : 'beforeend', (newestFirst() ? chunks.reverse() : chunks).join(''));
    });
    info.updated.forEach(({s, ti}) => {
      const t = a.turns[ti], old = Array.from(root.querySelectorAll('.rw[data-sn="' + s.n + '"]'));
      if (!old.length) return;
      old[0].insertAdjacentHTML('beforebegin', stepRows(a, s, t, turnHuman(t), meta, byStep));
      old.forEach(el => el.remove());
    });
  });
  info.added.forEach(({s}) => root.querySelectorAll('.rw[data-sn="' + s.n + '"]').forEach(el => fresh.push(el)));
  fresh.forEach(el => flashEl(el));
  applyFilters();
  fitClamps(root);
}
