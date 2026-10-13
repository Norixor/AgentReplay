'use strict';
/* Waste-pattern detectors. Each takes the scope (analysis_core.js) and returns a finding
 *   {id, title, rule, count, ms, msNote, cost: {cost, steps, nUnp, priced}, evidence: [...], head, extra}
 * evidence entries: {text, sub, ms, agentId, ts, n (step number), step, ...}, in chronological order.
 * `head` (optional) is the candidate for the headline sentence: {text, count, ms, cost}. A finding with count 0 is "not found". */

const ANA_LONG_CMD_MS = 600000;
const ANA_CTX_DEFAULT = 400000;
const ANA_CUT_PIPE = /(?<!\|)\|(?!\|)\s*(head|tail|grep|egrep|rg)\b/;
const ANA_NEAR_STEPS = 5;
const ANA_CPU_MIN_PARALLEL = 3;

const anaDur = c => (c.dur > 0 ? c.dur : 0);
const anaCmdText = c => String(c.sum || c.desc || c.name || '');
function anaEv(it, extra) {
  return Object.assign({text: clipText(anaCmdText(it.c), 200), ms: anaDur(it.c), agentId: it.r.id, ts: it.c.ts, n: it.s.n, step: it.s, name: it.c.name, cat: it.c.cat}, extra || {});
}
function clipText(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

function anaFinding(id, title, rule, evidence, o) {
  o = o || {};
  evidence.sort((x, y) => x.ts - y.ts);
  const steps = o.steps || evidence.map(e => e.step).filter(Boolean);
  return Object.assign({
    id, title, rule, evidence, count: o.count != null ? o.count : evidence.length,
    ms: o.ms != null ? o.ms : evidence.reduce((m, e) => m + (e.ms || 0), 0), msNote: o.msNote || '', cost: anaCostSum(steps), head: null, extra: null
  }, o.more || {});
}

/* Quote-masked copy of a command, same length, so a pipe inside quotes is not taken for a pipe. */
function anaMask(s) { return s.replace(/'[^']*'|"[^"]*"/g, m => 'x'.repeat(m.length)); }
/* The command with a trailing head / tail / grep filter removed: {main, cut}. */
function anaSplitCut(cmd) {
  const m = ANA_CUT_PIPE.exec(anaMask(cmd));
  return m ? {main: cmd.slice(0, m.index).trim(), cut: true} : {main: cmd.trim(), cut: false};
}

/* a. the same command again with no write in between */
function detRepeat(scope) {
  const groups = new Map();
  scope.rows.forEach(r => {
    const last = new Map();
    let mut = 0;
    r.calls.forEach(it => {
      const c = it.c;
      if (anaIsMutation(c)) { mut++; return; }
      if (!anaIsShell(c) || c.cat === 'wait' || c.disp || !(c.sum || c.desc)) return;
      const key = c.name + '\u0000' + normCmd(c), p = last.get(key);
      if (p && p.mut === mut && p.c.st === 'ok') {
        let g = groups.get(key + '\u0000' + r.id);
        if (!g) groups.set(key + '\u0000' + r.id, g = {cmd: clipText(anaCmdText(c), 120), reps: [], chains: 0, agentId: r.id});
        g.reps.push(it);
        if (!p.rep) g.chains++;
        last.set(key, {mut, c, rep: true});
      } else last.set(key, {mut, c, rep: false});
    });
  });
  const ev = [], list = [];
  groups.forEach(g => {
    g.runs = g.reps.length + g.chains;
    g.ms = g.reps.reduce((m, it) => m + anaDur(it.c), 0);
    g.cost = anaCostSum(g.reps.map(it => it.s));
    list.push(g);
    g.reps.forEach((it, k) => ev.push(anaEv(it, {sub: '第 ' + (k + 2) + ' 次重复', text: g.cmd})));
  });
  list.sort((x, y) => y.ms - x.ms);
  const f = anaFinding('repeat', '重复运行同一命令', '同一代理里归一化后相同的命令再次运行，两次之间没有写、改文件的调用；浪费时间按重复那几次的耗时计', ev);
  f.extra = {groups: list};
  if (list.length) f.head = {text: '重复运行 `' + list[0].cmd + '`', count: list[0].runs, ms: list[0].ms, cost: list[0].cost};
  return f;
}

/* b. output cut with head / tail / grep, then the same command run again without the cut */
function detCutRerun(scope) {
  const ev = [], steps = [], taken = new Set();
  scope.rows.forEach(r => {
    r.calls.forEach((it, i) => {
      const c = it.c;
      if (!anaIsShell(c) || c.cat === 'wait' || !c.sum) return;
      const cut = anaSplitCut(c.sum);
      if (!cut.cut || !cut.main) return;
      const key = normStr(cut.main), raw = normStr(c.sum);
      for (let k = i + 1; k < r.calls.length && r.calls[k].si - it.si <= ANA_NEAR_STEPS; k++) {
        const nx = r.calls[k];
        if (anaIsMutation(nx.c)) break;
        if (taken.has(nx) || !anaIsShell(nx.c) || !nx.c.sum || normStr(nx.c.sum) === raw) continue;
        if (normStr(anaSplitCut(nx.c.sum).main) !== key) continue;
        taken.add(nx);
        ev.push(anaEv(nx, {text: clipText(cut.main, 160), sub: '先前截断：' + clipText(c.sum, 100), first: it.c.ts}));
        steps.push(nx.s, it.s);
        break;
      }
    });
  });
  const f = anaFinding('cutrerun', '截断输出后重跑', '命令输出经 head / tail / grep 截断，同一代理 5 步内、中间没有写、改文件，又运行了去掉截断后主命令相同的命令；浪费时间按重跑那次的耗时计', ev, {steps});
  if (ev.length) {
    const top = ev.slice().sort((x, y) => y.ms - x.ms)[0];
    f.head = {text: '截断输出后重跑 `' + top.text + '`', count: ev.length, ms: f.ms, cost: f.cost};
  }
  return f;
}

/* c. polling and waiting calls */
function detPoll(scope) {
  const ev = [];
  scope.calls.forEach(it => { if (anaIsWaitCall(it.c)) ev.push(anaEv(it)); });
  const f = anaFinding('poll', '轮询等待', 'sleep 循环、tail -f、watch、pgrep 轮询，以及 TaskOutput / wait_agent 一类等待调用；统计它们占用的总时长', ev);
  if (ev.length) f.head = {text: '轮询等待', count: ev.length, ms: f.ms, cost: f.cost};
  return f;
}

/* d. commands that ran for more than ten minutes */
function detLong(scope, o) {
  const lim = (o && o.longMs) || ANA_LONG_CMD_MS, ev = [];
  scope.calls.forEach(it => { if (anaIsShell(it.c) && !it.c.bg && anaDur(it.c) > lim) ev.push(anaEv(it)); });
  return anaFinding('long', '长命令', '单条命令耗时超过 ' + Math.round(lim / 60000) + ' 分钟，逐条列出；时间为这些命令的执行时长，不一定都是浪费', ev, {msNote: '占用时间'});
}

/* e. the parent waits for sub-agents (straight from the segmentation) */
function detSubWait(scope) {
  const ev = [];
  let ms = 0;
  scope.rows.forEach(r => {
    if (!r.T.spans.length || !r.T.by.subwait) return;
    ms += r.T.by.subwait;
    const sub = r.T.segs.filter(sg => sg.cat === 'subwait'), seen = new Set();
    r.T.spans.forEach(sp => {
      if (seen.has(sp.id)) return;
      seen.add(sp.id);
      let w = 0;
      sub.forEach(sg => { w += Math.max(0, Math.min(sg.t1, sp.t1) - Math.max(sg.t0, sp.t0)); });
      if (w <= 0) return;
      const ch = scope.byId[sp.id] ? scope.byId[sp.id].a : null;
      ev.push({text: ch ? ch.desc : sp.id, sub: '由 ' + (r.id === 'main' ? '主代理' : r.a.desc) + ' 派出，运行 ' + Math.round((sp.t1 - sp.t0) / 1000) + ' 秒', ms: w, run: sp.t1 - sp.t0,
        agentId: r.id, childId: sp.id, ts: sp.call.ts, n: sp.step.n, step: null, parentWait: r.T.by.subwait});
    });
  });
  const f = anaFinding('subwait', '主代理空等子代理', '时间切分里「等子代理」的总和，列出分别在等哪些子代理；几个子代理同时跑时各行的等待会重叠，不能相加', ev, {ms, steps: [], msNote: '墙钟时间'});
  f.count = ev.length;
  f.noCost = true;
  return f;
}

/* f. failed or hook-blocked calls, plus the call right after each (the correction) */
function detRetry(scope) {
  const ev = [], steps = [], seen = new Set();
  let ms = 0;
  scope.rows.forEach(r => r.calls.forEach((it, i) => {
    if (it.c.st !== 'err' && it.c.st !== 'hook') return;
    const nx = r.calls[i + 1];
    let m = 0;
    [it, nx].forEach(x => {
      if (!x || seen.has(x)) return;
      seen.add(x);
      m += anaDur(x.c);
      steps.push(x.s);
    });
    ms += m;
    ev.push(anaEv(it, {ms: m, sub: (it.c.st === 'hook' ? '被钩子拦截' : '调用失败') + (nx ? '，之后：' + clipText(anaCmdText(nx.c), 100) : '')}));
  }));
  const f = anaFinding('retry', '失败或被拦截之后的重试', '失败的调用、被钩子拦截的调用，加上它之后紧接着的修正调用；时间和金额按这些调用合计', ev, {ms, steps});
  if (ev.length) f.head = {text: '失败或被拦截后的重试', count: ev.length, ms, cost: f.cost};
  return f;
}

/* g. the same command is much slower while several agents run at once (likely CPU contention) */
function detContention(scope) {
  const groups = new Map();
  scope.calls.forEach(it => {
    const c = it.c;
    if (!anaIsShell(c) || c.bg || c.cat === 'wait' || c.disp || !(c.sum || c.desc) || !(c.dur > 0)) return;
    const key = c.name + '\u0000' + normCmd(c);
    let g = groups.get(key);
    if (!g) groups.set(key, g = {cmd: clipText(anaCmdText(c), 120), runs: []});
    g.runs.push({it, k: scope.conc.at(c.ts + c.dur / 2)});
  });
  const ev = [], steps = [];
  groups.forEach(g => {
    if (g.runs.length < 3) return;
    const hi = g.runs.filter(x => x.k >= ANA_CPU_MIN_PARALLEL), lo = g.runs.filter(x => x.k <= 1);
    if (!hi.length || !lo.length) return;
    const mh = anaMedian(hi.map(x => x.it.c.dur)), ml = anaMedian(lo.map(x => x.it.c.dur));
    if (!(ml > 0) || mh <= 2 * ml) return;
    const waste = hi.reduce((m, x) => m + Math.max(0, x.it.c.dur - ml), 0);
    const slow = hi.slice().sort((x, y) => y.it.c.dur - x.it.c.dur)[0].it;
    hi.forEach(x => steps.push(x.it.s));
    ev.push(anaEv(slow, {text: g.cmd, ms: waste, medHi: mh, medLo: ml, nHi: hi.length, nLo: lo.length,
      sub: '同时 ≥3 个代理时中位数 ' + Math.round(mh / 1000) + ' 秒（' + hi.length + ' 次），≤1 个时 ' + Math.round(ml / 1000) + ' 秒（' + lo.length + ' 次）'}));
  });
  return anaFinding('cpu', '疑似抢 CPU', '同一条归一化命令运行 3 次以上，同时在跑的代理数 ≥3 时的耗时中位数超过 ≤1 时的 2 倍；浪费时间为慢的那几次超出 ≤1 时中位数的部分', ev, {steps, msNote: '超出部分'});
}

/* h. steps whose context is above the compaction point */
function detContext(scope, o) {
  const lim = (o && o.ctxLimit) || ANA_CTX_DEFAULT, ev = [], steps = [];
  scope.rows.forEach(r => r.T.flat.forEach(f => {
    if (!(f.s.ctx > lim)) return;
    steps.push(f.s);
    ev.push({text: '', ctx: f.s.ctx, ms: 0, agentId: r.id, ts: f.s.ts, n: f.s.n, step: f.s});
  }));
  const f = anaFinding('ctx', '上下文过大', '上下文超过 ' + Math.round(lim / 1000) + 'k token 的步骤，统计数量和金额', ev, {steps});
  f.ms = null;
  f.limit = lim;
  return f;
}

/* All detectors in display order, plus the headline candidate (largest estimated waste among those that offer one). */
function anaDetect(scope, opts) {
  const list = [detRepeat(scope), detCutRerun(scope), detPoll(scope), detLong(scope, opts), detSubWait(scope), detRetry(scope), detContention(scope), detContext(scope, opts)];
  let head = null;
  list.forEach(f => { if (f.head && (!head || f.head.ms > head.ms)) head = f.head; });
  return {list, head};
}
