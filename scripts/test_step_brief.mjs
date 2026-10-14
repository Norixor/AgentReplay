// Unit test for the call brief (src/step_brief.js): category, action and result line of real-looking Claude Code and Codex calls.
// Usage: node scripts/test_step_brief.mjs   (exits non-zero on the first failed assertion)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const code = fs.readFileSync(path.join(root, 'src', 'step_brief.js'), 'utf8').replace(/^'use strict';/, '');
const L = vm.runInNewContext(code + '\n;({stepBrief})', {D: {meta: {project: '/Users/me/Project/Animy'}}});

const P = '/Users/me/Project/Animy', WT = P + '/.claude/worktrees';
let n = 0;
const bash = (cmd, extra = {}) => ({name: 'Bash', cat: 'other', st: 'ok', bg: false, sum: cmd.split('\n')[0], inp: cmd, res: '', rlen: 0, ...extra});
const brief = (c, s) => L.stepBrief(c, s || {says: ''});
function check(name, c, want, s) {
  const b = brief(c, s);
  for (const [k, v] of Object.entries(want)) {
    const got = k.startsWith('result.') ? b.result[k.slice(7)] : b[k];
    if (v instanceof RegExp) assert.match(got, v, name + ': ' + k + ' = ' + JSON.stringify(got));
    else assert.equal(got, v, name + ': ' + k);
  }
  n++;
  return b;
}

// ---- shell commands as agents write them
check('cd + sed -i + grep | head', bash("cd /x/y && sed -i '' 's/a/b/' f.php && grep -n foo f.php | head", {cat: 'write'}),
  {kind: 'write', action: '改 f.php（sed）', more: /^另有 1 条命令：搜索「foo」于 f\.php$/});
check('env prefix, 2>&1 and | tail are noise', bash('APP_ENV=dev composer check -- --all 2>&1 | tail -12', {cat: 'test'}),
  {kind: 'check', kindLabel: '检查', action: '检查 composer check -- --all', more: ''});
check('git -C <worktree>', bash('git -C ' + WT + '/wc3 rebase --continue', {cat: 'git'}), {kind: 'git', action: 'git rebase --continue', where: 'wc3'});
check('python heredoc that writes a file', bash("python3 - <<'EOF'\np='docs/i18n.md'\ns=open(p,encoding='utf-8').read()\nassert s.count('a')==1\nopen(p,'w',encoding='utf-8').write(s.replace('a','b'))\nEOF"),
  {kind: 'write', action: '改 docs/i18n.md（python 脚本）'});
check('python heredoc that only reads, inside a worktree', bash("cd " + WT + "/wc3 && python3 - <<'EOF'\nimport json\nsp=json.load(open('content/packs/base/species.json'))\nprint(len(sp))\nEOF"),
  {kind: 'read', action: '读 content/packs/base/species.json（python 脚本）', where: 'wc3'});
check('python edit then git commit: the edit leads, the commit is listed first in more', bash("python3 - <<'EOF'\np='LEDGER.md'\ns=open(p).read()\nopen(p,'w').write(s+'x')\nEOF\ngit add LEDGER.md && git commit -qm \"docs(ledger): note\" && git log --oneline -1", {cat: 'git'}),
  {kind: 'write', action: '改 LEDGER.md（python 脚本）', more: /^另有 3 条命令：git commit「docs\(ledger\): note」 · git add LEDGER\.md …$/});
check('npm script test', bash('npm run test:e2e -- --workers=2', {cat: 'test'}), {kind: 'test', kindLabel: '跑测试', action: /^跑测试 npm run test:e2e/});
check('rg', bash('rg -n "memberIssues" src/Animy', {cat: 'read'}), {kind: 'search', action: '搜索「memberIssues」于 src/Animy'});
check('curl drops the query string', bash("curl -s 'http://127.0.0.1:9311/api/live?token=abc' | head -c 300"), {kind: 'net', action: '请求 127.0.0.1:9311/api/live'});
check('curl POST', bash('curl -sS -X POST -d @body.json https://api.example.com/v1/run'), {kind: 'net', action: '请求 POST api.example.com/v1/run'});
check('pipes and a subshell: worktree add leads', bash('git worktree add .claude/worktrees/ch1 -b ch1 main 2>&1 | tail -1 && (cd .claude/worktrees/ch1 && php tools/worktree-deps.php 2>&1 | tail -1)', {cat: 'git'}),
  {kind: 'git', action: /^git worktree add worktrees\/ch1 -b ch1 main/, more: /运行 tools\/worktree-deps\.php/});
check('command substitution counts as a command', bash('for f in a.php b.php; do n=$(git show HEAD~3:$f 2>/dev/null | wc -l); echo "$f $n"; done'),
  {kind: 'git', action: 'git show HEAD~3:$f'});
check('with-timeout sh -c wrapper is unwrapped', bash("~/AGENTS_MD/bin/with-timeout 600 sh -c 'cd " + WT + "/w2 && composer check -- --all > /tmp/x.log 2>&1'", {cat: 'test'}),
  {kind: 'check', action: '检查 composer check -- --all', where: 'w2'});
check('shell variables are substituted into paths', bash('S=/private/tmp/claude-501/p/s/scratchpad && php $S/audit.php > $S/out.txt'), {kind: 'run', action: '运行 scratchpad/audit.php'});
check('git add + commit + log: the commit leads', bash('git add -A && git commit -q -m "fix: CellGate capital check" && git log --oneline -1', {cat: 'git'}),
  {kind: 'git', action: 'git commit「fix: CellGate capital check」', more: /^另有 2 条命令：git add -A · git log --oneline -1$/});
check('sleep then tail: waiting', bash('sleep 30; tail -5 /tmp/run.log', {cat: 'wait'}), {kind: 'wait', action: '等待 30 秒', more: /读 \/tmp\/run\.log 末 5 行/});
check('node --check', bash('node --check src/steps.js'), {kind: 'check', action: '语法检查 src/steps.js'});
check('a check script by name', bash('python3 -I scripts/check.py > $LOG 2>&1'), {kind: 'check', action: '检查 scripts/check.py'});
check('sed -n range', bash('sed -n 60,150p ' + P + '/src/Animy/Application/Content/CellGate.php', {cat: 'read'}),
  {kind: 'read', action: '读 src/Animy/Application/Content/CellGate.php 第 60–150 行'});
check('ssh runs the remote command', bash("ssh -o BatchMode=yes root@10.0.0.7 'cd /srv/app && git status --short'"), {kind: 'git', action: 'git status --short', where: 'ssh 10.0.0.7'});
check('background vite: a server', bash('cd frontend && (nohup npx vite --port 5183 > /tmp/v.log 2>&1 &) && sleep 4'), {kind: 'serve', action: /^起服务 npx vite --port 5183/});
check('unknown program falls back to the data category', bash('frobnicate --fast input.bin', {cat: 'test'}), {kind: 'test', action: 'frobnicate --fast input.bin'});
check('only banners: falls back to the category and the text', bash('echo ---; printf "x\\n"', {cat: 'read'}), {kind: 'read', action: 'echo ---; printf "x\\n"'});

// ---- Codex calls
check('codex exec cell with exec_command', {name: 'exec_command', cat: 'read', st: 'ok', sum: "sed -n '1,40p' src/a.py", rlen: 40,
  inp: 'const r = await tools.exec_command({cmd:"sed -n \'1,40p\' src/a.py","workdir":"/w","yield_time_ms":1000});\ntext(JSON.stringify(r));',
  res: '\n{"chunk_id":"762933","wall_time_seconds":1.0,"exit_code":0,"original_token_count":20,"output":"import os\\nprint(1)"}'},
  {kind: 'read', action: '读 src/a.py 第 1–40 行', 'result.state': 'ok', 'result.line': 'import os'});
check('codex exit code in the JSON result', {name: 'exec_command', cat: 'test', st: 'ok', sum: 'composer test', inp: 'composer test',
  res: '{"chunk_id":"1","exit_code":255,"output":"PHP Fatal error:  Uncaught Error: Class \\"support\\\\Db\\" not found'},
  {kind: 'test', 'result.state': 'err', 'result.line': /^exit 255 · PHP Fatal error: Uncaught Error/});
check('codex apply_patch', {name: 'apply_patch', cat: 'write', st: 'ok', sum: P + '/src/a.py, ' + P + '/src/b.py', inp: '', res: '{}'},
  {kind: 'write', action: '改 src/a.py、src/b.py（补丁）', 'result.line': '无输出'});
check('codex write_stdin poll', {name: 'write_stdin', cat: 'wait', st: 'ok', sum: 'session 7 轮询输出', inp: '', res: ''}, {kind: 'wait', action: '轮询会话输出'});

// ---- Claude Code tools
check('Read with offset', {name: 'Read', cat: 'read', st: 'ok', sum: WT + '/wc3/src/x.ts @40', rlen: 5300, res: '40→const a = 1;'},
  {kind: 'read', action: '读 src/x.ts 从第 40 行', where: 'wc3', 'result.line': '读到 5300 字符'});
check('Edit', {name: 'Edit', cat: 'write', st: 'ok', sum: P + '/src/a.php', res: 'The file ' + P + '/src/a.php has been updated successfully.'},
  {kind: 'write', action: '改 src/a.php', 'result.line': '已保存'});
check('Grep', {name: 'Grep', cat: 'read', st: 'ok', sum: 'memberIssues  ' + P + '/src', res: 'src/a.php'}, {kind: 'search', action: '搜索「memberIssues」于 src'});
check('Agent in the background', {name: 'Agent', cat: 'agent', st: 'ok', sum: 'CH1 写手接口通用化', res: 'Async agent launched successfully. agentId: x'},
  {kind: 'agent', action: '派子代理：CH1 写手接口通用化', 'result.line': '已派出，后台运行'});
check('browser tool', {name: 'mcp__Claude_Browser__navigate', cat: 'other', st: 'ok', sum: 'http://127.0.0.1:9311/r/x', res: 'ok'}, {kind: 'browser', action: /^打开页面 127\.0\.0\.1:9311/});
check('a reply without a tool call', null, {kind: 'reply', action: '先看一下主线状态。', 'result.state': 'none'}, {says: '\n先看一下主线状态。\n然后再派单。'});

// ---- result lines
const res = (r, extra = {}) => ({...brief(bash('vendor/bin/phpunit', {cat: 'test', res: r, ...extra})).result});  // copied: the module lives in another realm
assert.equal(res('PHPUnit 10.5 by Sebastian Bergmann\n\n......\n\nTime: 00:01.2\n\nOK (6 tests, 142 assertions)').line, 'OK (6 tests, 142 assertions)');
assert.deepEqual(res('Exit code 1\nRunning...\nError: Class "Foo" not found in a.php:3\nmore', {st: 'err'}), {state: 'err', line: 'exit 1 · Error: Class "Foo" not found in a.php:3'});
assert.equal(res('1 file changed, 2 insertions(+)\nFAILURES!\nTests: 1, Assertions: 2, Failures: 1.').line, 'Tests: 1, Assertions: 2, Failures: 1.');
assert.equal(res('composer check: base main\nlogs: runtime/check/1/\n  ok   content (2.9s)\n  ok   deptrac (23.1s)\n  FAIL stan (3.0s)').line, '1 项失败（FAIL stan (3.0s)）· 2 项通过');
assert.equal(res(' Test Files  12 passed (12)\n      Tests  141 passed (141)').line, 'Tests 141 passed (141)');
assert.equal(res('Tests: 1, Assertions: 2, Failures: 1.\nOK (1 test, 3 assertions)').line, 'OK (1 test, 3 assertions)', 'the final summary wins');
assert.equal(res('[fix-gate 83b08bf8] fix: gate\n 2 files changed, 17 insertions(+), 1 deletion(-)').line, '[fix-gate 83b08bf8] fix: gate');
assert.equal(res('(Bash completed with no output)').line, '无输出');
assert.equal(res('Command running in background with ID: b1. Output is being written to: /tmp/x').line, '已转入后台运行');
assert.deepEqual(res('', {st: 'pend', bg: true}), {state: 'pend', line: '后台运行中'});
assert.deepEqual(res('', {st: 'hook', hook: 'Blocked: background commands need a time limit\nmore'}), {state: 'err', line: '被钩子拦截：Blocked: background commands need a time limit'});
assert.equal(res('Exit code 1\ncat: /private/tmp/claude-501/p/sess/scratchpad/brief.md: No such file or directory', {st: 'err'}).line, 'exit 1 · cat: scratchpad/brief.md: No such file or directory');
assert.ok(res('x'.repeat(400)).line.length <= 110, 'result lines are capped');
n += 13;

// ---- cache: the same call gives the same object until its result changes (live updates fill res / st in place)
const c = bash('npm test', {st: 'pend'});
const b1 = brief(c), b2 = brief(c);
assert.equal(b1, b2, 'cached per call');
c.st = 'ok'; c.res = 'Tests  3 passed (3)';
assert.equal(brief(c).result.line, 'Tests 3 passed (3)', 'recomputed after the result arrives');
n += 2;

// ---- live shapes: calls with fewer fields than the replay data has
assert.deepEqual({...brief(bash('npm test', {st: 'pend', inp: ''})).result}, {state: 'pend', line: '执行中'}, 'a running call is "执行中", not "无结果"');
const fb = brief({name: 'Bash', sum: 'cd ' + P + ' && vendor/bin/phpunit tests/Unit/FooTest.php 2>&1 | tail -5', st: 'ok'});
assert.equal(fb.kind, 'test', 'only a summary: the action is still recognised');
assert.deepEqual({...fb.result}, {state: 'none', line: ''}, 'no res field: no result is claimed');
assert.equal(brief({name: 'Read', sum: P + '/src/a.php', st: 'ok'}).result.line, '', 'a read without res and rlen claims nothing');
assert.equal(brief({name: 'Bash', sum: 'false', st: 'err'}).result.state, 'err', 'a failure without res is still a failure');
assert.doesNotThrow(() => { brief({name: 'mcp__x__y', st: 'pend'}); brief({name: '', sum: '', st: 'ok'}); brief({name: 'Bash', st: 'ok'}); brief(null, {says: ''}); }, 'sparse calls do not throw');
n += 7;

// ---- Cursor names its shell tools run_terminal_command(_v2) / run_terminal_cmd
['run_terminal_command_v2', 'run_terminal_command', 'run_terminal_cmd'].forEach(name =>
  check('cursor shell tool ' + name, {name, cat: 'other', st: 'ok', sum: 'git status --short', inp: '', res: ''}, {kind: 'git', action: /^git status/}));

console.log('step brief unit test passed (' + n + ' checks)');
