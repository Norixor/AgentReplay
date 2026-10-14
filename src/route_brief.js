'use strict';
/* Route map, brief of a folded stretch: what a run of items (an overview group, a folded strip, a stage group) was doing.
 * Pure functions, no DOM (scripts/test_route_brief.mjs loads step_brief.js, route_model.js and this file under node).
 *
 *   RB.summarize(items, ctx) -> {theme, themeFull, src, mix, calls, err, hook, ctxText, said, mixText}
 *     items  route items (RM.itemOfCall / RM.itemOfEvent), in time order
 *     ctx    {trigs: the agent's turn triggers [{k, ts, text, from}] sorted by ts, lookupName(id) -> agent name}
 *   theme     one line saying what the stretch is about, chosen in this order:
 *               1. a user message inside the stretch (the one that governs most of its calls)
 *               2. the agents it dispatched ("◆ 派 3 个：A 等")
 *               3. a cross-session message or task notification that started a turn inside the stretch
 *               4. the dominant kind of work, said with stepBrief's action / target or the call's own description
 *                  (Bash `description`), e.g. "改 route_view.js 等 3 个文件", "跑测试 npm test"
 *             themeFull is the untruncated text for tooltips; src names the rule that won (user/dispatch/trig/work/said/'').
 *   mix       composition by kind group, most frequent first: [{key, label, name, n}]; key is also the --c-<key> colour token.
 *   calls     tool calls counted in mix; err / hook: failed / blocked calls.
 *   ctxText   the user message in force when the stretch started (for the tooltip), said: the last narration line.
 * Live steps merged from /api/live carry only name/cat/sum/desc (no inp/res): stepBrief copes, and without stepBrief the
 * route category and the call's text are used. RB.of() caches a summary per stretch (first key, last key, length, state). */

const RB = {};
// kind group -> [chip label, full name]; colours are the page's --c-<key> tokens (same as step_brief.js SB_KINDS colours)
RB.GROUPS = {read: ['读', '读代码/搜索'], write: ['改', '改文件'], test: ['测', '测试/检查/构建'], git: ['git', 'git'], agent: ['派', '派子代理'],
  wait: ['等', '等待/后台'], other: ['其他', '其他命令']};
// stepBrief kind -> group
RB.KIND_GROUP = {read: 'read', search: 'read', net: 'read', browser: 'read', write: 'write', test: 'test', check: 'test', build: 'test', git: 'git',
  agent: 'agent', wait: 'wait', serve: 'wait', bg: 'wait'};
// how strongly a group speaks for the stretch when picking the theme (reads are many but say little)
RB.WEIGHT = {test: 3, write: 3, agent: 3, git: 2, other: 1.5, wait: 1, read: 1};
RB.TRIG_KEEP = {human: 1, xsession: 1, notify: 1, local: 1, handback: 1};

const rbClip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const rbFirst = s => (String(s || '').split('\n').find(l => l.trim()) || '').trim();
const rbBase = p => { p = String(p || '').replace(/\/+$/, ''); const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; };

/* A real file name (not a glob, a shell variable or a bare word): only those name a read / write stretch. */
RB.isFile = f => !!f && /^[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,8}$/.test(f);
/* stepBrief of one call item, or a fallback from the route category when step_brief.js is absent or fails. */
RB.callBrief = function (it) {
  if (it.call && typeof stepBrief === 'function') {
    try { return stepBrief(it.call, it.src || null); } catch (e) { /* fall through to the category */ }
  }
  const k = {read: 'read', write: 'write', test: 'test', git: 'git', wait: 'wait', agent: 'agent'}[it.cat] || 'other';
  const text = rbFirst(it.sum) || it.name || '';
  return {kind: k, action: text, target: it.file || '', where: ''};
};
/* Group key of one item; null for events (user message, compaction, hand-back), which are not work. */
RB.groupOf = function (it) {
  if (!it || it.cat === 'event') return null;
  if (it.kind === 'dispatch') return 'agent';
  if (it.kind === 'merge') return 'git';
  return RB.KIND_GROUP[RB.callBrief(it).kind] || 'other';
};

/* 'Agent "X" finished' -> '子代理完成：X'; other notification / message text -> its first line. */
RB.trigText = function (t) {
  const s = rbFirst(t.text);
  if (t.k === 'notify') {
    const m = s.match(/^(Agent|Background command|Task|Command)\s+"(.+?)"\s+(\w+)/i);
    if (m) {
      const who = /^agent$/i.test(m[1]) ? '子代理' : '后台命令';
      const verb = /fail|error/i.test(m[3]) ? '失败' : /kill|stop|cancel/i.test(m[3]) ? '停止' : '完成';
      return who + verb + '：' + m[2];
    }
  }
  return s;
};
const RB_TRIG_ICON = {human: '✉ ', xsession: '⇄ ', notify: '◇ ', local: '$ ', handback: '◇ '};

/* The trigger in force at time t (the latest one at or before t), or null. trigs are sorted by ts. */
RB.trigAt = function (trigs, t) {
  let lo = 0, hi = (trigs || []).length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (trigs[m].ts <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? trigs[best] : null;
};

/* Most frequent value (ties: the latest one), with the number of distinct values. */
function rbTop(vals) {
  const cnt = new Map();
  let top = '', topN = 0;
  vals.forEach(v => { if (!v) return; const c = (cnt.get(v) || 0) + 1; cnt.set(v, c); if (c >= topN) { top = v; topN = c; } });
  return {top, kinds: cnt.size};
}

RB.summarize = function (items, ctx) {
  ctx = ctx || {};
  const lookupName = ctx.lookupName || (() => '');
  const out = {theme: '', themeFull: '', src: '', mix: [], calls: 0, err: 0, hook: 0, ctxText: '', said: '', mixText: ''};
  if (!items || !items.length) return out;
  const t0 = items[0].ts, t1 = items[items.length - 1].ts;
  const cnt = {}, byGroup = {}, users = [], disp = [];
  let lastSaid = '', lastStep = null;
  items.forEach(it => {
    if (it.kind === 'user') { users.push(it); return; }
    const g = RB.groupOf(it);
    if (!g) return;
    out.calls++;
    cnt[g] = (cnt[g] || 0) + 1;
    (byGroup[g] || (byGroup[g] = [])).push(it);
    if (it.st === 'err') out.err++;
    else if (it.st === 'hook') out.hook++;
    if (it.kind === 'dispatch') disp.push(it);
    if (it.src && it.src !== lastStep) { lastStep = it.src; const s = rbFirst(it.src.said); if (s) lastSaid = s; }
  });
  out.mix = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).map(k => ({key: k, label: RB.GROUPS[k][0], name: RB.GROUPS[k][1], n: cnt[k]}));
  out.mixText = out.mix.map(m => m.name + ' ' + m.n).join('，') + (out.err ? '，失败 ' + out.err : '') + (out.hook ? '，拦截 ' + out.hook : '');
  out.said = lastSaid;
  const trigs = (ctx.trigs || []).filter(t => RB.TRIG_KEEP[t.k]);
  const gov = RB.trigAt(trigs.filter(t => t.k === 'human' && !/^</.test(rbFirst(t.text))), t0);
  if (gov && rbFirst(gov.text)) out.ctxText = rbFirst(gov.text);
  const set = (theme, full, src) => { out.theme = theme; out.themeFull = full || theme; out.src = src; return out; };

  // Some "user" events are machine messages wrapped in a tag (a sub-agent's hand-back as <agent-message from="id">, a task
  // notification ...): they are not the user's instruction. A hand-back names its agent; other tagged ones are skipped.
  const machine = [];
  for (let k = users.length - 1; k >= 0; k--) {
    const txt = String(users[k].text || users[k].sum || '').trim();
    if (!/^<[\w-]+[\s>]/.test(txt)) continue;
    const m = txt.match(/^<agent-message\s+from="([^"]+)"/);
    if (m) machine.unshift({k: 'handback', ts: users[k].ts, text: '收到交回：' + (lookupName(m[1]) || m[1])});
    users.splice(k, 1);
  }
  // 1. a user message inside the stretch: the one followed by the most calls
  if (users.length) {
    let best = users[0], bestN = -1;
    users.forEach((u, k) => {
      const end = k + 1 < users.length ? users[k + 1].ts : Infinity;
      const n = items.filter(i => i.cat !== 'event' && i.ts >= u.ts && i.ts < end).length;
      if (n > bestN) { best = u; bestN = n; }
    });
    const txt = rbFirst(best.text || best.sum);
    if (txt) return set('✉ ' + txt, '用户：' + String(best.text || best.sum).trim() + (users.length > 1 ? '（本段共 ' + users.length + ' 条用户消息）' : ''), 'user');
  }
  // 2. dispatched agents
  if (disp.length) {
    const names = disp.map(d => rbClip(lookupName(d.child) || d.desc || d.sum, 40)).filter(Boolean);
    const uniq = names.filter((x, i) => names.indexOf(x) === i);
    if (uniq.length) return set('◆ 派 ' + disp.length + ' 个：' + uniq[0] + (uniq.length > 1 ? ' 等' : ''), '派单：' + uniq.join('、'), 'dispatch');
  }
  // 3. a message or notification that opened a turn inside the stretch (the one whose turn covers most calls)
  // the turn the stretch starts in counts too: its trigger usually comes just before the first call
  const open = RB.trigAt(trigs, t0), from = open ? open.ts : t0;
  const inside = trigs.filter(t => t.k !== 'human' && t.k !== 'handback' && t.ts >= from && t.ts <= t1 && rbFirst(t.text) && !/^</.test(rbFirst(t.text)))
    .concat(machine).sort((p, q) => p.ts - q.ts);
  if (inside.length) {
    let best = inside[0], bestN = -1;
    inside.forEach((t, k) => {
      const end = k + 1 < inside.length ? inside[k + 1].ts : Infinity;
      const n = items.filter(i => i.cat !== 'event' && i.ts >= t.ts && i.ts < end).length;
      if (n > bestN || (n === bestN && t.k === 'xsession')) { best = t; bestN = n; }
    });
    const txt = RB.trigText(best);
    return set(RB_TRIG_ICON[best.k] + txt, txt + (inside.length > 1 ? '（本段共 ' + inside.length + ' 条通知/消息）' : ''), 'trig');
  }
  // 4. the dominant kind of work
  const keys = Object.keys(cnt);
  if (keys.length) {
    const g = keys.sort((a, b) => cnt[b] * RB.WEIGHT[b] - cnt[a] * RB.WEIGHT[a])[0];
    const its = byGroup[g], briefs = its.map(RB.callBrief);
    let theme = '';
    if (g === 'write' || g === 'read') {
      const files = briefs.filter(b => b.kind === 'read' || b.kind === 'write').map(b => rbBase(b.target)).filter(RB.isFile);
      const f = rbTop(files);
      if (f.top) theme = (g === 'write' ? '改 ' : '读 ') + f.top + (f.kinds > 1 ? ' 等 ' + f.kinds + ' 个文件' : '');
    }
    if (!theme) {
      const d = rbTop(its.map(i => rbFirst(i.desc)));
      if (d.top && g !== 'agent') theme = d.top + (d.kinds > 1 ? ' 等' : '');
    }
    if (!theme) {
      const a = rbTop(briefs.map(b => rbFirst(b.action)));
      theme = a.top + (a.kinds > 1 ? ' 等' : '');
    }
    if (theme) return set(theme, theme + '（' + RB.GROUPS[g][1] + ' ' + cnt[g] + ' 次）', 'work');
  }
  if (lastSaid) return set(lastSaid, lastSaid, 'said');
  return out;
};

/* Cached summary of a stretch of one agent. The key covers what can change while a stretch is reused: a stretch grows at its
 * end, and its last call may finish (pend -> ok/err). */
RB.CACHE = new Map();
RB.CACHE_MAX = 4000;
RB.of = function (agentId, items, ctx) {
  if (!items || !items.length) return RB.summarize([], ctx);
  const f = items[0], l = items[items.length - 1];
  const key = agentId + '|' + f.key + '|' + l.key + '|' + items.length + '|' + l.st + '|' + ((ctx && ctx.trigs) ? ctx.trigs.length : 0);
  let hit = RB.CACHE.get(key);
  if (!hit) {
    if (RB.CACHE.size >= RB.CACHE_MAX) RB.CACHE.clear();
    hit = RB.summarize(items, ctx);
    RB.CACHE.set(key, hit);
  }
  return hit;
};

/* Items of a lane between t0 and t1 (inclusive), found by binary search on the time-sorted item list. */
RB.span = function (items, t0, t1) {
  let lo = 0, hi = items.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (items[m].ts < t0) lo = m + 1; else hi = m; }
  let e = lo;
  while (e < items.length && items[e].ts <= t1) e++;
  return items.slice(lo, e);
};

/* One-line action for a single call node (step granularity): stepBrief's action, or '' when it adds nothing. */
RB.actionOf = function (it) {
  if (!it || !it.call || typeof stepBrief !== 'function') return '';
  const b = RB.callBrief(it);
  return rbClip(rbFirst(b.action), 40);
};
