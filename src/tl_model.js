'use strict';
/* Timeline data model: per-agent segments and markers, dispatch links, the collapsed-idle time warp and overview buckets. */

const CAT_KEYS = ['read', 'test', 'write', 'git', 'wait', 'agent', 'other'];
const TL_SUBWAIT = 8;                    // colour slot of "waiting for sub-agents" (7 is the long-command colour of the model mode)
const GAP_MS = 15 * 60 * 1000;          // all-agents idle longer than this is collapsed
const MK = {                              // marker kinds: glyph colour variable, label
  user: {c: '--accent', t: '用户消息'}, compact: {c: '--bad', t: '上下文压缩'}, hook: {c: '--bad', t: '钩子拦截'},
  merge: {c: '--ok', t: '合入主线'}, fail: {c: '--warn-ink', t: '失败调用'}, back: {c: '--c-git', t: '子代理交回'}
};

let _model = null;
function timelineModel() {
  if (_model) return _model;
  const disp = {};                         // child id -> {parent, ts, bgDone}
  const hb = {};                           // child id -> first hand-back event ts seen in a parent
  D.agents.forEach(a => {
    a.turns.forEach(t => {
      t.steps.forEach(s => s.calls.forEach(c => { if (c.agent && !disp[c.agent]) disp[c.agent] = {parent: a.id, ts: c.ts, bgDone: c.bgDone || 0}; }));
      [t.trig].concat(t.evs).forEach(e => {
        if (e.k === 'handback' && e.from && e.ts && !(e.from in hb)) hb[e.from] = e.ts;
      });
    });
  });
  // Agents without any recorded step (Codex children whose own rows are not in the rollout) have start = end = 0:
  // place them at their dispatch moment so they stay visible and the time axis is not stretched.
  D.agents.forEach(a => {
    const d = disp[a.id];
    a._s = a.start || (d && d.ts) || D.meta.start;
    a._e = a.end || hb[a.id] || (d && d.bgDone) || a._s + 1000;
  });
  const rows = {};
  D.agents.forEach(a => {
    // Tool segments come from the shared time segmentation (one category per instant, foreground dispatches are "waiting").
    const segs = [], bg = [], marks = [];
    timeSegments(a).forEach(sg => {
      if (sg.c) segs.push({a: sg.t0, b: sg.t1, cat: sg.cat === 'subwait' ? TL_SUBWAIT : CAT_KEYS.indexOf(sg.cat), tcat: sg.cat, s: sg.s, c: sg.c, long: !!sg.c.long});
    });
    a.turns.forEach(t => {
      t.steps.forEach(s => s.calls.forEach(c => {
        if (c.bg && c.bgDone && c.bgDone > c.ts) bg.push({a: c.ts, b: c.bgDone, cat: CAT_KEYS.indexOf(c.cat), s, c});
        if (c.st === 'hook') marks.push({ts: c.ts, kind: 'hook', s, c});
        else if (c.st === 'err') marks.push({ts: c.ts, kind: 'fail', s, c});
        if (c.merge) marks.push({ts: c.ts, kind: 'merge', s, c});
      }));
      [t.trig].concat(t.evs).forEach(e => {
        if (a.id === 'main' && (e.k === 'human' || e.k === 'followup') && e.ts) marks.push({ts: e.ts, kind: 'user', e, turn: true});
        if (e.k === 'compact' && e.ts) marks.push({ts: e.ts, kind: 'compact', e});
      });
    });
    bg.sort((x, y) => x.a - y.a);
    const long = segs.filter(x => x.long);
    segs.maxDur = segs.reduce((m, x) => Math.max(m, x.b - x.a), 0);
    long.maxDur = segs.maxDur;
    rows[a.id] = {a, segs, long, bg, marks};
  });
  // hand-back markers sit on the parent row at the moment the child reported back
  SUBS.forEach(ch => {
    const d = disp[ch.id], pr = rows[(d && d.parent) || ch.parent || 'main'];
    if (!pr) return;
    const ts = hb[ch.id] || (d && d.bgDone) || ch._e;
    if (ts) pr.marks.push({ts, kind: 'back', child: ch});
  });
  Object.values(rows).forEach(r => r.marks.sort((x, y) => x.ts - y.ts));
  _model = {rows, disp, hb};
  return _model;
}

/* ---- idle collapse: a monotone real-time -> virtual-time map with fixed-size idle bands */
function buildWarp(collapse) {
  const T0 = D.meta.start, T1 = Math.max(D.meta.end, T0 + 1000);
  const now = D.meta.active ? Date.now() : 0;
  const hi = Math.max(T1, now);
  if (!collapse) {
    const piece = {r0: T0, r1: hi, v0: 0, v1: hi - T0, gap: false};
    return finishWarp([piece], T0, hi);
  }
  const iv = [];
  D.agents.forEach(a => a.turns.forEach(t => {
    t.steps.forEach(s => {
      iv.push([s.ts, Math.max(s.end, s.ts)]);
      s.calls.forEach(c => { if (c.bg && c.bgDone) iv.push([c.ts, c.bgDone]); });
    });
    iv.push([t.trig.ts || 0, t.trig.ts || 0]);
  }));
  if (now) iv.push([now - 1, now]);
  iv.push([T0, T0], [T1, T1]);
  const pts = iv.filter(x => x[0] >= T0 - 1000 && x[0] > 0).sort((x, y) => x[0] - y[0]);
  const spans = [];
  pts.forEach(x => {
    const last = spans[spans.length - 1];
    if (last && x[0] - last[1] <= GAP_MS) last[1] = Math.max(last[1], x[1]);
    else spans.push([x[0], x[1]]);
  });
  const active = spans.reduce((m, s) => m + (s[1] - s[0]), 0);
  const F = Math.max(20000, active * 0.02);
  const pieces = [];
  let v = 0;
  spans.forEach((s, i) => {
    if (i > 0) {
      pieces.push({r0: spans[i - 1][1], r1: s[0], v0: v, v1: v + F, gap: true});
      v += F;
    }
    pieces.push({r0: s[0], r1: Math.max(s[1], s[0] + 1), v0: v, v1: v + Math.max(s[1], s[0] + 1) - s[0], gap: false});
    v += pieces[pieces.length - 1].v1 - pieces[pieces.length - 1].v0;
  });
  return finishWarp(pieces, spans[0][0], spans[spans.length - 1][1]);
}
function finishWarp(pieces, r0, r1) {
  const VT = pieces[pieces.length - 1].v1;
  const W = {pieces, VT, r0, r1, collapsed: pieces.some(p => p.gap)};
  W.r2v = t => {
    if (t <= pieces[0].r0) return pieces[0].v0 + (t - pieces[0].r0);
    let lo = 0, hi = pieces.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pieces[m].r0 <= t) lo = m; else hi = m - 1; }
    const p = pieces[lo];
    if (t >= p.r1 && lo === pieces.length - 1) return p.v1 + (t - p.r1);
    return p.v0 + Math.min(1, (t - p.r0) / Math.max(1, p.r1 - p.r0)) * (p.v1 - p.v0);
  };
  W.v2r = v => {
    if (v <= 0) return pieces[0].r0 + v;
    let lo = 0, hi = pieces.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pieces[m].v0 <= v) lo = m; else hi = m - 1; }
    const p = pieces[lo];
    if (v >= p.v1 && lo === pieces.length - 1) return p.r1 + (v - p.v1);
    return p.r0 + Math.min(1, (v - p.v0) / Math.max(1, p.v1 - p.v0)) * (p.r1 - p.r0);
  };
  return W;
}

/* ---- step lookup used by every jump: the step of an agent that was running at time ts */
function findStepAt(a, ts) {
  if (a._stepIdx == null) {
    a._stepIdx = [];
    a.turns.forEach((t, ti) => t.steps.forEach(s => a._stepIdx.push({s, ti})));
  }
  const arr = a._stepIdx;
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].s.ts <= ts) { best = m; lo = m + 1; } else hi = m - 1;
  }
  return best < 0 ? (arr[0] || null) : arr[best];
}
function findTurnAt(a, ts) {
  let best = 0;
  a.turns.forEach((t, i) => { if ((t.trig.ts || 0) <= ts + 1) best = i; });
  return best;
}
