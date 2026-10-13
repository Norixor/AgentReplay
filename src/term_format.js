'use strict';
/* Terminal view, text model. Pure functions (no DOM, no page globals) so scripts/test_term.mjs can run them alone.
 *
 * A "line" is {ts, k, text, ...}: k is cmd | out | err | exit | tool | blocked | spawn | ret | say | sep.
 * Optional fields: dur (ms, shown at the right of a command line), long (dur > 60 s), pend (call without a result yet),
 * ref + label (agent id and the part of text that links to it), full (complete text of a clipped comment or separator).
 * Lines are grouped in blocks (one block per trigger, event or step) so a live update can replace or append whole blocks.
 *
 * ctx: {project: string, agent: id => {desc, model, effort} | undefined, seen?: Set} (seen: agents whose return was already shown)
 */

const TERM_CAP = {cmd: 12, out: 30, say: 200, sep: 120, hook: 240, err: 120};
const TERM_LONG_MS = 60000;
const TERM_FAM = /haiku|sonnet|opus|fable/;

function termClock(ts) {
  const d = new Date(ts), p = n => (n < 10 ? '0' : '') + n;
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function termDur(ms) {
  if (ms == null) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + 's';
  const t = Math.round(s);
  if (t < 60) return t + 's';
  const m = Math.floor(t / 60), r = t % 60;
  if (m < 60) return m + 'm' + (r < 10 ? '0' : '') + r + 's';
  return Math.floor(m / 60) + 'h' + ((m % 60) < 10 ? '0' : '') + (m % 60) + 'm';
}
function termTok(n) {
  n = Math.round(n || 0);
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}
const termOneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const termClip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const termFirst = s => String(s || '').split('\n').map(x => x.trim()).find(Boolean) || '';

/* Path relative to the session's project directory when it lies inside it. */
function termPath(p, project) {
  p = String(p || '');
  if (project && p.startsWith(project.replace(/\/+$/, '') + '/')) return p.slice(project.replace(/\/+$/, '').length + 1);
  return p;
}

/* A field of a tool input: the inputs are stored as JSON text that may have been cut at the size cap, so fall back to a regex. */
function termField(inp, name) {
  if (!inp) return undefined;
  try {
    const o = JSON.parse(inp);
    if (o && typeof o === 'object' && name in o) return o[name];
  } catch (e) { /* cut or not JSON */ }
  const m = new RegExp('"' + name + '"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|-?\\d+)').exec(inp);
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch (e) { return undefined; }
}

function termFamOf(model) {
  const m = TERM_FAM.exec(String(model || '').toLowerCase());
  return m ? m[0] : String(model || '');
}

function termIsShell(c) {
  return c.name === 'Bash' || /^(exec|exec_command|shell_command|shell|local_shell)(\+|$)/.test(c.name || '');
}

/* "Exit code 2" (Claude) or "exited with code 2" (Codex) in a failed shell result. */
const TERM_EXIT = /(?:^|\n)\s*(?:Exit code[: ]+|Process exited with code[: ]+|exit(?:ed)?(?: with)? (?:code|status)[: ]+)(-?\d+)/i;

const TERM_HEAD = /^\s*(?:Exit code[: ]+(-?\d+)[ \t]*\n?)?(?:Wall time: [^\n]*\n?)?(?:Output:[ \t]*\n?)?/;

function termToolText(c, ctx) {
  const inp = c.inp || '', pj = ctx.project;
  const path = () => termPath(termField(inp, 'file_path') || termField(inp, 'notebook_path') || String(c.sum || '').replace(/ @\d+$/, ''), pj);
  switch (c.name) {
    case 'Read': {
      const off = termField(inp, 'offset'), lim = termField(inp, 'limit');
      const m = /@(\d+)$/.exec(c.sum || '');
      const start = off != null ? +off : m ? +m[1] : null;
      const range = start != null ? ':' + start + '-' + (lim != null ? start + lim - 1 : '') : lim != null ? ':1-' + lim : '';
      return 'read ' + path() + range;
    }
    case 'Grep': {
      const pat = termField(inp, 'pattern'), where = termField(inp, 'path'), glob = termField(inp, 'glob');
      if (pat == null) return 'grep ' + termClip(termOneLine(c.sum), 120);
      return 'grep "' + termClip(termOneLine(pat), 80) + '"' + (where ? ' ' + termPath(where, pj) : '') + (glob ? ' --glob ' + glob : '');
    }
    case 'Glob': return 'glob ' + (termField(inp, 'pattern') || c.sum || '');
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit ' + path();
    case 'Write': return 'write ' + path();
    case 'WebFetch': return 'fetch ' + (termField(inp, 'url') || c.sum || '');
    case 'WebSearch': return 'search "' + termClip(termOneLine(termField(inp, 'query') || c.sum), 100) + '"';
    case 'Skill': return 'skill ' + (c.sum || '');
    case 'ToolSearch': return 'tool-search ' + termClip(termOneLine(c.sum), 100);
    case 'Monitor': return 'monitor ' + termClip(termOneLine(c.desc || c.sum), 120);
    case 'SendMessage': return '» send ' + termClip(termOneLine(c.sum), 140);
    case 'SubagentHandback': return '« handback final report';
    default: return (c.name || 'tool') + (c.sum ? ' ' + termClip(termOneLine(c.sum), 140) : '');
  }
}

/* Lines of one tool call. */
function termCallLines(c, s, ctx) {
  const L = [], ts = c.ts;
  if (c.disp || (c.agent && /^(Agent|Task|spawn_agent)$/.test(c.name))) {
    const ag = ctx.agent ? ctx.agent(c.agent) : null;
    const d = c.disp || {};
    const task = termOneLine(c.desc || (ag && ag.desc) || d.type || 'agent');
    const fam = termFamOf((ag && ag.model) || d.model), eff = (ag && ag.effort) || d.effort || '';
    const who = [fam, eff].filter(Boolean).join(' ');
    const line = {ts, k: 'spawn', text: '» spawn ' + task + (who ? ' (' + who + ')' : ''), label: task};
    if (c.agent) line.ref = c.agent;
    if (c.st === 'pend') line.pend = true;
    L.push(line);
    if (c.st === 'hook') L.push({ts, k: 'blocked', text: '✗ blocked by hook: ' + termClip(termFirst(c.hook), TERM_CAP.hook)});
    else if (c.st === 'err') L.push({ts, k: 'exit', text: '✗ error: ' + termClip(termOneLine(termFirst(c.res)), TERM_CAP.err)});
    else if (c.st === 'ok' && !c.bg && /^(Agent|Task)$/.test(c.name)) {  // Claude waits for the sub-agent; Codex's spawn returns at once
      const back = {ts: ts + (c.dur || 0), k: 'ret', text: '« ' + task + ' returned', label: task};
      if (c.agent) { back.ref = c.agent; if (ctx.seen) ctx.seen.add(c.agent); }
      L.push(back);
    }
    return L;
  }
  if (termIsShell(c)) {
    const cmd = String(c.inp || c.sum || '').replace(/\s+$/, '');
    const rows = cmd.split('\n');
    const first = {ts, k: 'cmd', text: '$ ' + rows[0]};
    if (c.st === 'pend') first.pend = true;
    else if (c.st !== 'hook' && !c.bg) { first.dur = c.dur || 0; first.long = (c.dur || 0) > TERM_LONG_MS; }
    L.push(first);
    rows.slice(1, TERM_CAP.cmd).forEach(r => L.push({ts, k: 'cmd', text: '> ' + r, cont: true}));
    if (rows.length > TERM_CAP.cmd) L.push({ts, k: 'cmd', text: '> … (' + (rows.length - TERM_CAP.cmd) + ' more lines)', cont: true});
    const end = ts;   // output lines carry the command's own time so a block reads as one moment
    if (c.st === 'hook') {
      L.push({ts: end, k: 'blocked', text: '✗ blocked by hook: ' + termClip(termFirst(c.hook), TERM_CAP.hook)});
      return L;
    }
    const bad = c.st === 'err';
    // Result header: "Exit code 2\n" (Claude), "Exit code: 2\nWall time: 1.2 seconds\nOutput:\n" (Codex). The code moves to the closing line.
    let res = String(c.res || '').replace(/\s+$/, '');
    const h = TERM_HEAD.exec(res);
    let code = null;
    if (h && h[0]) { code = h[1] != null ? h[1] : null; res = res.slice(h[0].length); }
    if (bad && code == null) { const m = TERM_EXIT.exec(res); if (m) code = m[1]; }
    if (res) {
      const out = res.split('\n');
      out.slice(0, TERM_CAP.out).forEach(r => L.push({ts: end, k: bad ? 'err' : 'out', text: r}));
      if (out.length > TERM_CAP.out) L.push({ts: end, k: bad ? 'err' : 'out', text: '… (' + (out.length - TERM_CAP.out) + ' more lines)'});
    }
    if (bad) L.push({ts: end, k: 'exit', text: code != null ? '✗ exit code ' + code : '✗ error' + (res ? ': ' + termClip(termOneLine(termFirst(res)), TERM_CAP.err) : '')});
    return L;
  }
  const t = {ts, k: 'tool', text: termToolText(c, ctx)};
  if (c.st === 'pend') t.pend = true;
  else if (c.dur >= 1000) t.dur = c.dur;
  L.push(t);
  if (c.st === 'hook') L.push({ts, k: 'blocked', text: '✗ blocked by hook: ' + termClip(termFirst(c.hook), TERM_CAP.hook)});
  else if (c.st === 'err') L.push({ts, k: 'exit', text: '✗ error: ' + termClip(termOneLine(termFirst(c.res)), TERM_CAP.err)});
  return L;
}

/* The agent's own words as a "# …" comment; the full text stays available for expanding. */
function termSayLine(ts, text) {
  const one = termOneLine(text);
  if (!one) return null;
  const line = {ts, k: 'say', text: '# ' + termClip(one, TERM_CAP.say)};
  if (one.length > TERM_CAP.say || String(text).trim().indexOf('\n') >= 0) line.full = String(text).trim().slice(0, 4000);
  return line;
}

/* Lines of one step: what the agent said, then its calls in order. */
function termStepLines(s, ctx) {
  const L = [];
  const say = termSayLine(s.ts, s.saidSrc === 'prev' ? '' : s.said || s.says || '');  // a "prev" comment was already shown with its own step
  if (say) L.push(say);
  const rets = [];   // parallel dispatches: every spawn first, then the returns in the order they came back
  (s.calls || []).forEach(c => termCallLines(c, s, ctx).forEach(l => (l.k === 'ret' ? rets : L).push(l)));
  return L.concat(rets.sort((x, y) => x.ts - y.ts));
}

const TERM_SEP = {human: '用户', followup: '续接', xsession: '跨会话', goal: '目标检查', interrupt: '用户中断', local: '本地命令', meta: '系统',
  stophook: 'Stop 钩子', info: '系统提示', agentmsg: '代理消息', image: '图片', brief: '简报', notify: '通知'};

function termSep(ts, label, text) {
  const body = termOneLine(text);
  const line = {ts, k: 'sep', text: '── ' + label + (body ? ': ' + termClip(body, TERM_CAP.sep) : '') + ' ──'};
  if (body.length > TERM_CAP.sep) line.full = '── ' + label + ': ' + String(text).trim().slice(0, 4000) + ' ──';
  return line;
}

/* Trigger of a turn or an event inside a turn -> lines ([] for kinds that are only noise here). */
function termEventLines(e, ctx) {
  const ts = e.ts || 0, ag = id => (id && ctx.agent ? ctx.agent(id) : null);
  switch (e.k) {
    case 'compact': return [{ts, k: 'sep', text: '── context compacted (pre ' + termTok(e.pre || 0) + ') ──'}];
    case 'handback': {
      const ch = ag(e.from);
      const task = termOneLine(ch ? ch.desc : e.from || 'agent');
      if (e.from && ctx.seen) { if (ctx.seen.has(e.from)) return []; ctx.seen.add(e.from); }  // the dispatch call already showed it
      const line = {ts, k: 'ret', text: '« ' + task + ' returned', label: task};
      if (e.from) line.ref = e.from;
      return [line];
    }
    case 'notify': {
      const L = [termSep(ts, TERM_SEP.notify, e.text + (e.status ? ' (' + e.status + ')' : ''))];
      const ch = ag(e.task);
      if (ch && !(ctx.seen && ctx.seen.has(e.task))) {
        if (ctx.seen) ctx.seen.add(e.task);
        const task = termOneLine(ch.desc);
        L.push({ts, k: 'ret', text: '« ' + task + ' returned', label: task, ref: e.task});
      }
      return L;
    }
    case 'goalstatus': return [termSep(ts, '目标状态', (e.met ? '已达成' : '未达成') + '：' + (e.text || ''))];
    case 'agentmsg': {
      const ch = ag(e.from);
      return [termSep(ts, TERM_SEP.agentmsg, (ch ? ch.desc : e.from || '') + '：' + (e.text || ''))];
    }
    case 'xsession': return [termSep(ts, TERM_SEP.xsession, (e.from ? e.from + '：' : '') + (e.text || ''))];
    case 'brief': return [termSep(ts, TERM_SEP.brief, '')];
    case 'hookctx': case 'taskstat': case 'compactsum': case 'silent': case 'localout': return [];
    default: return TERM_SEP[e.k] ? [termSep(ts, TERM_SEP[e.k], e.text)] : [];
  }
}

/* Blocks of turn t (index ti) from step stFrom and event evFrom on; the trigger block is included when stFrom and evFrom are 0
 * and withHead is true. Events sit before the step whose index they carry in `at`. -> {blocks, st, ev} (counters to continue from). */
function termTurnBlocks(t, ti, ctx, stFrom, evFrom, withHead) {
  const blocks = [];
  if (withHead) blocks.push({key: 't' + ti, lines: termEventLines(t.trig, ctx)});
  let evi = evFrom;
  const flush = n => { while (evi < t.evs.length && t.evs[evi].at <= n) { blocks.push({key: 'e' + ti + '.' + evi, lines: termEventLines(t.evs[evi], ctx)}); evi++; } };
  for (let si = stFrom; si < t.steps.length; si++) {
    flush(si);
    blocks.push({key: 's' + t.steps[si].n, lines: termStepLines(t.steps[si], ctx)});
  }
  flush(1e9);
  return {blocks, st: t.steps.length, ev: evi};
}

/* All blocks of an agent in time order. */
function termAgentBlocks(a, ctx) {
  const out = [];
  a.turns.forEach((t, ti) => termTurnBlocks(t, ti, ctx, 0, 0, true).blocks.forEach(b => out.push(b)));
  return out;
}

/* Plain text (copy / export): "HH:MM:SS  text", comments and separators in full. */
function termPlain(blocks) {
  const out = [];
  blocks.forEach(b => b.lines.forEach(l => out.push(termClock(l.ts) + '  ' + (l.full || l.text) + (l.dur != null && l.k === 'cmd' && !l.cont ? '   [' + termDur(l.dur) + ']' : ''))));
  return out.join('\n');
}
