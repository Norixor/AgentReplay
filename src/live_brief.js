'use strict';
/* Live tab: plain-language briefs (step_brief.js) for the agent cards, the agent-graph nodes and its tooltip.
 *
 * A snapshot card carries `detail` (the running call: tool, cat, sum, inp, desc, elapsed), `said` (the agent's latest note) and
 * `recent[].calls` (category, summary, input, result of the newest steps; see src/live_brief.py). Older steps and snapshots from
 * before the briefs have only {tool, sum, st}: those fall back to a call built from the step itself, which gives a reasonable
 * action but never claims a result (a call without `res` has none to show). Pure helpers + small markup builders, no DOM access. */

const LB_REPLY = /^(回复|思考)$/;

/* The calls of a recent step to describe: its own list when the snapshot has one, else one call built from the step line. */
function lbStepCalls(r) {
  if (Array.isArray(r.calls)) return r.calls;
  if (!r.tool || LB_REPLY.test(r.tool)) return [];
  return [{name: r.tool, sum: r.sum || '', st: r.st === 'err' || r.st === 'hook' ? r.st : 'ok', ts: r.ts, dur: r.dur}];
}

/* stepBrief of one call, never throwing: a malformed call degrades to the raw tool name and summary. */
function lbBrief(call, r) {
  try {
    return stepBrief(call, call ? null : {says: r && r.sum});
  } catch (e) {
    return {kind: 'other', kindLabel: '其他', color: 'other', action: String(call && (call.sum || call.name) || (r && r.sum) || '（无摘要）'), target: '', more: '', where: '', result: {state: 'none', line: ''}};
  }
}

/* The call that is running now, as the card's detail describes it. */
function lbNowCall(c) {
  const d = c.detail || {};
  return {name: d.tool || '', cat: d.cat, sum: d.sum || '', inp: d.inp || '', st: 'pend', ts: 0};
}

const lbKindHTML = b => '<span class="sb-kind sb-c-' + esc(b.color) + '"><i aria-hidden="true"></i>' + esc(b.kindLabel) + '</span>';

/* "执行中 · 已 N" with a ticking clock (updateLiveBar advances every .tick between refreshes). */
function lbRunningHTML(call, nowMs) {
  const el = call && call.ts && nowMs ? Math.max(0, nowMs - call.ts) : null;
  return '<span class="sb-res sb-pend">' + (call && call.bg ? '后台运行中' : '执行中') + (el == null ? '' : ' · 已 <b class="tick" data-ms="' + el + '">' + fmtDur(el) + '</b>') + '</span>';
}

function lbResultHTML(b, call, nowMs) {
  if (call && call.st === 'pend') return lbRunningHTML(call, nowMs);
  const r = b.result;
  if (r.line) return '<span class="sb-res sb-' + esc(r.state) + '">' + esc(r.line) + '</span>';
  if (call && (call.st === 'err' || call.st === 'hook')) return '<span class="sb-res sb-err">' + (call.st === 'hook' ? '被钩子拦截' : '失败') + '</span>';
  return '';
}

/* The action text of a step: its brief, or for a step without a call that wrote no text a plain note instead of the bare "回复". */
const lbAction = (b, first, r) => !first && !String(r && r.sum || '').trim() ? '（只有思考，没有文字输出）' : b.action;

/* What a step row of a card says: the first call's action and result, the second call on one line, then the step's reason. */
function lbStepHTML(r, nowMs) {
  const calls = lbStepCalls(r), first = calls[0] || null, b = lbBrief(first, r);
  const act = '<span class="sb-act" title="' + esc(first ? (first.inp || first.sum || '') : (r.sum || '')) + '">' + esc(lbAction(b, first, r)) + (b.where ? ' <span class="sb-where">' + esc(b.where) + '</span>' : '') + '</span>';
  let more = '';
  if (calls.length > 1) {
    const b2 = lbBrief(calls[1], r), l2 = calls[1].st === 'pend' ? '执行中' : b2.result.line;
    more = '<span class="sb-more">同时：' + esc(b2.kindLabel + ' ' + b2.action + (l2 ? ' · ' + l2 : '')) + '</span>';
  } else if (b.more) more = '<span class="sb-more">' + esc(b.more) + '</span>';
  return {
    kind: lbKindHTML(b),
    body: act + lbResultHTML(b, first, nowMs) + more + (r.why ? '<span class="rwhy sb-act">原因：' + esc(r.why) + '</span>' : '')
  };
}

/* Plain text of one step for tight places (graph node rows): [kind label, action, result line when it failed]. */
function lbStepLine(r) {
  const calls = lbStepCalls(r), first = calls[0] || null, b = lbBrief(first, r);
  const bad = first && (first.st === 'err' || first.st === 'hook');
  return [b.kindLabel, lbAction(b, first, r), bad ? (b.result.line || (first.st === 'hook' ? '被钩子拦截' : '失败')) : ''];
}

/* The running call of a card in words: {kindLabel, color, action, tip}. */
function lbNowBrief(c) {
  const d = c.detail || {}, call = lbNowCall(c), b = lbBrief(call, null);
  return {b, kindLabel: b.kindLabel, color: b.color, action: b.action + (b.where ? ' · ' + b.where : ''), tip: [d.tool, d.desc, d.inp || d.sum].filter(Boolean).join('\n')};
}

/* The note an agent made last, one line, for the thinking / waiting states. */
const lbSaid = (c, n) => clip(firstLine(c.said || '').replace(/\s+/g, ' '), n || 120);
