// Unit test for src/term_format.js (the terminal view's text model): built steps in, text lines out.
// Usage: node scripts/test_term.mjs   (exits non-zero on the first failed assertion)
process.env.TZ = 'UTC';  // the clock column is local time; pin it so the expected text is stable
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const code = fs.readFileSync(path.join(root, 'src', 'term_format.js'), 'utf8');
const F = vm.runInNewContext(code + '\n;({termCallLines, termStepLines, termEventLines, termTurnBlocks, termAgentBlocks, termPlain, termDur, termTok, termClock})', {});
const plain = x => JSON.parse(JSON.stringify(x));

const T0 = Date.UTC(2026, 9, 12, 8, 30, 5);
const AGENTS = { sub1: { desc: 'Login page UI', model: 'claude-sonnet-5-5', effort: 'medium' } };
const ctx = { project: '/home/demo/app', agent: id => AGENTS[id] };
const call = (name, extra = {}) => ({ name, cat: 'other', ts: T0, dur: 0, st: 'ok', bg: false, desc: '', sum: '', res: '', rlen: 0, hook: '', inp: '', ...extra });
const texts = lines => plain(lines).map(l => l.text);

function eq(name, got, want) {
  try { assert.deepEqual(got, want); } catch (e) { console.error('FAIL ' + name + '\n  got:  ' + JSON.stringify(got) + '\n  want: ' + JSON.stringify(want)); process.exit(1); }
}

// Bash: command, output, duration; long commands are flagged
let L = plain(F.termCallLines(call('Bash', { sum: 'npm test', dur: 4200, res: 'ok 3 tests\nall passed' }), {}, ctx));
eq('bash ok', L.map(l => l.text), ['$ npm test', 'ok 3 tests', 'all passed']);
eq('bash ok kinds', L.map(l => l.k), ['cmd', 'out', 'out']);
eq('bash ok dur', [L[0].dur, L[0].long], [4200, false]);
L = plain(F.termCallLines(call('Bash', { sum: 'sleep 90', dur: 90000 }), {}, ctx));
eq('bash long', [L[0].dur, L[0].long], [90000, true]);

// Bash multi-line command (the full text is in inp) wraps into continuation lines
L = plain(F.termCallLines(call('Bash', { sum: 'cat <<EOF …', inp: 'cat <<EOF\nline 1\nEOF' }), {}, ctx));
eq('bash multiline', L.map(l => l.text), ['$ cat <<EOF', '> line 1', '> EOF']);

// Bash failure: output in red (kind err) and the exit code at the end
L = plain(F.termCallLines(call('Bash', { sum: 'npm run lint', st: 'err', dur: 1500, res: 'Exit code 2\nsrc/a.js: error no-undef' }), {}, ctx));
eq('bash err text', L.map(l => l.text), ['$ npm run lint', 'src/a.js: error no-undef', '✗ exit code 2']);
eq('bash err kinds', L.map(l => l.k), ['cmd', 'err', 'exit']);
L = plain(F.termCallLines(call('Bash', { sum: 'make', st: 'err', res: 'boom happened' }), {}, ctx));
eq('bash err without code', L.map(l => l.text), ['$ make', 'boom happened', '✗ error: boom happened']);

// Codex shell results carry a header that is dropped; the code goes to the closing line when the command failed
L = plain(F.termCallLines(call('exec_command', { shell: true, sum: 'npm test', dur: 900, st: 'err', res: 'Exit code: 1\nWall time: 0.9 seconds\nOutput:\nFAIL a.test' }), {}, ctx));
eq('codex err', L.map(l => l.text), ['$ npm test', 'FAIL a.test', '✗ exit code 1']);
L = plain(F.termCallLines(call('exec_command', { shell: true, sum: 'ls', res: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\na.txt' }), {}, ctx));
eq('codex ok', L.map(l => l.text), ['$ ls', 'a.txt']);
eq('codex spawn does not return at once', texts(F.termCallLines(call('spawn_agent', { desc: 'scan', agent: 'sub1', disp: { model: 'gpt-6-luna', effort: 'low' } }), {}, ctx)), ['» spawn scan (sonnet medium)']);

// Pending command: spinner flag, no output
L = plain(F.termCallLines(call('Bash', { sum: 'npm run e2e', st: 'pend' }), {}, ctx));
eq('bash pending', [L.length, L[0].pend, L[0].dur], [1, true, undefined]);

// Hook block
L = plain(F.termCallLines(call('Bash', { sum: 'git commit -am x', st: 'hook', hook: 'Direct commits to main are blocked.\nUse a branch.' }), {}, ctx));
eq('hook', L.map(l => l.text), ['$ git commit -am x', '✗ blocked by hook: Direct commits to main are blocked.']);
eq('hook kind', L[1].k, 'blocked');

// Read / Grep / Edit / Write
eq('read range', texts(F.termCallLines(call('Read', { sum: '/home/demo/app/src/app.py @120', inp: JSON.stringify({ file_path: '/home/demo/app/src/app.py', offset: 120, limit: 61 }) }), {}, ctx)), ['read src/app.py:120-180']);
eq('read whole', texts(F.termCallLines(call('Read', { sum: '/etc/hosts', inp: JSON.stringify({ file_path: '/etc/hosts' }) }), {}, ctx)), ['read /etc/hosts']);
eq('read cut json', texts(F.termCallLines(call('Read', { sum: '/home/demo/app/a.md', inp: '{\n "file_path": "/home/demo/app/a.md",\n "offset": 5, "limit": 10, "x": "cut' }), {}, ctx)), ['read a.md:5-14']);
eq('grep', texts(F.termCallLines(call('Grep', { sum: 'foo|bar  /home/demo/app/src', inp: JSON.stringify({ pattern: 'foo|bar', path: '/home/demo/app/src' }) }), {}, ctx)), ['grep "foo|bar" src']);
eq('glob', texts(F.termCallLines(call('Glob', { sum: 'src/**/*.ts', inp: JSON.stringify({ pattern: 'src/**/*.ts' }) }), {}, ctx)), ['glob src/**/*.ts']);
eq('edit', texts(F.termCallLines(call('Edit', { sum: '/home/demo/app/src/app.py', inp: JSON.stringify({ file_path: '/home/demo/app/src/app.py', old_string: 'a', new_string: 'b' }) }), {}, ctx)), ['edit src/app.py']);
eq('write', texts(F.termCallLines(call('Write', { sum: '/home/demo/app/docs/x.md', inp: JSON.stringify({ file_path: '/home/demo/app/docs/x.md', content: 'hi' }) }), {}, ctx)), ['write docs/x.md']);
eq('tool with failure', texts(F.termCallLines(call('Edit', { sum: '/x/y.js', st: 'err', res: 'String to replace not found\nmore' }), {}, ctx)), ['edit /x/y.js', '✗ error: String to replace not found']);

// Dispatching a sub-agent: foreground returns on the next line, background does not
L = plain(F.termCallLines(call('Agent', { desc: 'Login page UI', agent: 'sub1', disp: { model: 'sonnet', effort: 'medium', bg: false } }), {}, ctx));
eq('spawn fg', L.map(l => l.text), ['» spawn Login page UI (sonnet medium)', '« Login page UI returned']);
eq('spawn ref', [L[0].ref, L[1].ref], ['sub1', 'sub1']);
L = plain(F.termCallLines(call('Agent', { desc: 'Docs', bg: true, disp: { model: 'haiku', effort: 'high', bg: true } }), {}, ctx));
eq('spawn bg', L.map(l => l.text), ['» spawn Docs (haiku high)']);

// Hand-back (trigger of a turn), notification, compaction, user message
eq('handback', texts(F.termEventLines({ k: 'handback', ts: T0, from: 'sub1' }, ctx)), ['« Login page UI returned']);
eq('notify', texts(F.termEventLines({ k: 'notify', ts: T0, task: 'sub1', status: 'completed', text: 'Agent "Login page UI" completed' }, ctx)),
  ['── 通知: Agent "Login page UI" completed (completed) ──', '« Login page UI returned']);
eq('compact', texts(F.termEventLines({ k: 'compact', ts: T0, pre: 189500, trigger: 'auto' }, ctx)), ['── context compacted (pre 189.5k) ──']);
eq('human', texts(F.termEventLines({ k: 'human', ts: T0, text: 'please fix\nthe login' }, ctx)), ['── 用户: please fix the login ──']);
// a return shown by the dispatch call is not repeated by the hand-back event
const seenCtx = Object.assign({ seen: new Set() }, ctx);
F.termCallLines(call('Agent', { desc: 'Login page UI', agent: 'sub1', disp: { model: 'sonnet', effort: 'medium' } }), {}, seenCtx);
eq('handback not repeated', texts(F.termEventLines({ k: 'handback', ts: T0, from: 'sub1' }, seenCtx)), []);
eq('noise skipped', texts(F.termEventLines({ k: 'hookctx', ts: T0, text: 'x' }, ctx)), []);

// Comments: clipped with the full text kept
L = plain(F.termStepLines({ n: 1, ts: T0, said: 'I will read the config first.', saidSrc: 'same', says: '', calls: [call('Read', { sum: '/etc/a', inp: JSON.stringify({ file_path: '/etc/a' }) })] }, ctx));
eq('say + call', L.map(l => l.text), ['# I will read the config first.', 'read /etc/a']);
eq('say not clipped', L[0].full, undefined);
const longText = 'word '.repeat(80);
L = plain(F.termStepLines({ n: 2, ts: T0, said: '', saidSrc: '', says: longText, calls: [] }, ctx));
eq('say clipped', [L[0].text.length, L[0].full.length > 300], [2 + 200 + 1, true]);
eq('say from previous step is not repeated', texts(F.termStepLines({ n: 3, ts: T0, said: 'again', saidSrc: 'prev', says: '', calls: [call('Glob', { sum: '*.js' })] }, ctx)), ['glob *.js']);

// A turn in time order: trigger, events by `at`, steps; counters allow continuing
const turn = { trig: { k: 'human', ts: T0, text: 'go' }, evs: [{ k: 'compact', ts: T0, pre: 1000, at: 1 }],
  steps: [{ n: 0, ts: T0, said: '', saidSrc: '', says: '', calls: [call('Glob', { sum: 'a' })] }, { n: 1, ts: T0, said: '', saidSrc: '', says: '', calls: [call('Glob', { sum: 'b' })] }] };
let tb = F.termTurnBlocks(turn, 0, ctx, 0, 0, true);
eq('turn order', plain(tb.blocks).map(b => b.key + '=' + b.lines.map(l => l.text).join('|')), ['t0=── 用户: go ──', 's0=glob a', 'e0.0=── context compacted (pre 1.0k) ──', 's1=glob b']);
turn.steps.push({ n: 2, ts: T0, said: '', saidSrc: '', says: '', calls: [call('Glob', { sum: 'c' })] });
tb = F.termTurnBlocks(turn, 0, ctx, tb.st, tb.ev, false);
eq('turn continues', plain(tb.blocks).map(b => b.key), ['s2']);

// Plain text for copy: clock, text, duration of commands
const blocks = [{ key: 's0', lines: F.termCallLines(call('Bash', { sum: 'ls', dur: 2000, res: 'a' }), {}, ctx) }];
eq('plain text', F.termPlain(blocks), '08:30:05  $ ls   [2.0s]\n08:30:05  a');
eq('durations', [F.termDur(800), F.termDur(2500), F.termDur(45000), F.termDur(192000), F.termDur(3900000)], ['800ms', '2.5s', '45s', '3m12s', '1h05m']);

console.log('term format: all assertions passed');
