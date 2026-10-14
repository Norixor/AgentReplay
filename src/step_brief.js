'use strict';
/* Plain-language brief of one tool call: what kind of work it is, the action on its object, and the most telling result line.
 * Pure functions, no DOM (node tests load this file alone, see scripts/test_step_brief.mjs).
 *
 *   stepBrief(call, step, opts) -> {kind, kindLabel, color, action, target, more, where, result: {state, line}}
 *
 * Shell commands are split into segments (&&, ||, ;, newlines, subshells) and pipelines; filters after the first pipe
 * (head, tail, grep, sort ...), `cd`, env prefixes, echo/printf banners and redirects are noise. Every remaining segment gets a
 * kind and a weight; the heaviest one (the first on ties) is the action, the others are counted in `more`. A command that no
 * rule recognises falls back to the replay data's own category (call.cat) and the cleaned command text, so nothing is guessed.
 * opts.root: project directory used to shorten paths (default: D.meta.project when the page data exists). */

// kind -> [label, colour token]; colour tokens are the existing --c-* category colours.
const SB_KINDS = {
  read: ['读文件', 'read'], search: ['搜索', 'read'], write: ['改文件', 'write'], test: ['跑测试', 'test'], check: ['检查', 'test'],
  build: ['构建', 'test'], git: ['git', 'git'], deps: ['装依赖', 'other'], run: ['运行', 'other'], serve: ['起服务', 'wait'], bg: ['后台命令', 'wait'],
  wait: ['等待', 'wait'], agent: ['子代理', 'agent'], net: ['网络', 'read'], browser: ['浏览器', 'read'], tool: ['工具', 'other'],
  other: ['其他', 'other'], reply: ['回复', 'other']
};
const SB_CAT_KIND = {read: 'read', test: 'test', write: 'write', git: 'git', wait: 'wait', agent: 'agent'};
const SB_W = {test: 7, check: 7, build: 7, write: 6, deps: 6, serve: 6, bg: 4, net: 4, run: 3, wait: 3, agent: 5, browser: 3, read: 2, search: 2, tool: 2, other: 1};

const SB_READ = new Set(['cat', 'head', 'tail', 'less', 'more', 'nl', 'bat', 'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'stat', 'file', 'jq', 'xxd', 'od',
  'strings', 'diff', 'cmp', 'ls', 'tree', 'du', 'df', 'readlink', 'realpath', 'which', 'type', 'pwd', 'column', 'tr', 'shasum', 'md5', 'md5sum', 'sha256sum', 'yq', 'plutil']);
const SB_SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'fd', 'find', 'locate', 'mdfind']);
const SB_NOISE = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'unset', 'true', 'false', ':', 'source', '.', 'local', 'declare', 'trap', 'exit', 'return',
  'for', 'done', 'fi', 'esac', 'case', 'in', '{', '}', 'shopt', 'ulimit', 'umask', 'eval', 'printf', 'echo', '[', '[[', 'test', 'read', 'break', 'continue']);
const SB_PREFIX = new Set(['sudo', 'command', 'builtin', 'time', 'nice', 'nohup', 'exec', 'caffeinate', 'stdbuf', 'unbuffer']);
const SB_KEYWORD = new Set(['do', 'then', 'else', 'elif', 'if', 'while', '!', 'time']);
const SB_INTERP = /^(python[\d.]*|node|php[\d.]*|ruby|perl|deno|bun|osascript)$/;
const SB_GIT_MUT = new Set(['commit', 'rebase', 'merge', 'push', 'pull', 'cherry-pick', 'reset', 'checkout', 'switch', 'worktree', 'stash', 'tag', 'revert',
  'am', 'apply', 'restore', 'rm', 'mv', 'clone', 'init', 'fetch', 'branch', 'add', 'gc', 'prune', 'clean', 'update-ref', 'notes']);
const SB_TEST_TOOLS = {vitest: 'test', jest: 'test', pytest: 'test', phpunit: 'test', paratest: 'test', mocha: 'test', ava: 'test', playwright: 'test',
  cypress: 'test', karma: 'test', tap: 'test', rspec: 'test', tsc: 'check', eslint: 'check', prettier: 'check', ruff: 'check', mypy: 'check',
  flake8: 'check', black: 'check', pyright: 'check', phpstan: 'check', psalm: 'check', deptrac: 'check', phpcs: 'check', 'php-cs-fixer': 'check',
  stylelint: 'check', shellcheck: 'check', biome: 'check', 'vue-tsc': 'check', webpack: 'build', esbuild: 'build', tsup: 'build', rollup: 'build',
  turbo: 'build', xcodebuild: 'build', gradle: 'build', gradlew: 'build', mvn: 'build', swiftc: 'build', gcc: 'build', clang: 'build', cmake: 'build'};
const SB_DEPS_SUB = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'require', 'dump-autoload', 'link', 'unlink']);
const SB_WRITES = /open\s*\([^)\n]*,\s*(?:mode\s*=\s*)?['"][wax]b?\+?['"]|\.write_text\s*\(|\.write_bytes\s*\(|(?<!std(?:out|err)\.)\.write\s*\(|writeFileSync|appendFileSync|fs\.writeFile|file_put_contents|json\.dump\s*\(|shutil\.(copy|move|rmtree)|os\.(remove|rename|replace|unlink|makedirs)|\.unlink\s*\(|fopen\([^)]*['"][wa]/;
// String literals are scanned with a bounded pattern, then tested for a path shape (a known file extension, or a slash).
const SB_STRLIT = /(['"])([^'"\n\\]{2,160})\1/g;
const SB_EXT = 'php|m?js|cjs|tsx?|jsx|json|jsonl|md|py|sh|css|scss|html?|ya?ml|toml|txt|log|csv|sql|xml|vue|svelte|go|rs|rb|java|kt|swift|[ch]|cc|cpp|hpp|lock|ini|conf|cfg|env|neon|dist|svg|png|jpe?g|gif|webp|plist|zip|gz|pdf|lua|dart|ex|exs|twig|blade';
const SB_PATHY = new RegExp('^(?:~\\/|\\.{0,2}\\/)?(?:[\\w.@-]+\\/)*[\\w.@-]+\\.(?:' + SB_EXT + ')$|^(?:~\\/|\\/)?(?:[\\w.@-]+\\/)+[\\w.@-]+\\/?$');

const sbClip = (s, n) => (s = String(s == null ? '' : s)).length > n ? s.slice(0, n - 1) + '…' : s;
const sbBase = p => String(p || '').replace(/\/+$/, '').split('/').pop();

function sbRoot(opts) {
  if (opts && opts.root != null) return opts.root;
  try { return typeof D !== 'undefined' && D && D.meta ? D.meta.project || '' : ''; } catch (e) { return ''; }
}

/* A path made short and relative: worktree and scratchpad prefixes and the project root are dropped. Returns {p, wt}. */
function sbPath(p, root) {
  p = String(p || '').replace(/^['"]|['"]$/g, '');
  let wt = '';
  const w = p.match(/(?:^|\/)\.(?:claude|codex)\/worktrees\/([^/]+)(\/.*)?$/);
  if (w) { wt = w[1]; p = w[2] ? w[2].slice(1) : '.'; }
  else {
    const sp = p.match(/\/scratchpad(\/.*)?$/);
    if (sp) p = 'scratchpad' + (sp[1] || '');
    else if (root && (p === root || p.startsWith(root + '/'))) p = p === root ? '.' : p.slice(root.length + 1);
    else p = p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^\/home\/[^/]+(?=\/|$)/, '~');
  }
  if (p.length > 52) {
    const parts = p.split('/');
    let out = parts.pop();
    while (parts.length && out.length + parts[parts.length - 1].length < 44) out = parts.pop() + '/' + out;
    p = '…/' + out;
  }
  return {p, wt};
}

/* ---- shell parsing */

/* Heredoc bodies are cut out of the text and replaced by a marker word __HD<n>__ (an unterminated body runs to the end). */
function sbHeredocs(cmd) {
  const lines = String(cmd || '').split('\n'), out = [], bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const tags = [];
    const line = lines[i].replace(/(^|[^<])<<-?\s*(['"]?)([A-Za-z_][\w-]*)\2/g, (m, pre, q, tag) => { tags.push(tag); return pre + ' __HD' + (bodies.length + tags.length - 1) + '__'; });
    out.push(line);
    tags.forEach(tag => {
      const body = [];
      while (++i < lines.length && lines[i].trim() !== tag) body.push(lines[i]);
      bodies.push(body.join('\n'));
    });
  }
  return {text: out.join('\n'), bodies};
}

/* Segments of a command line: [{parts: [pipeline part text], bg}], split outside quotes and $( ). */
function sbSegments(src) {
  const segs = [];
  let parts = [''], q = null, dep = 0;
  const add = s => { parts[parts.length - 1] += s; };
  const push = bg => {
    const ps = parts.map(x => x.trim()).filter(Boolean);
    if (ps.length) segs.push({parts: ps, bg: !!bg});
    parts = [''];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1], pv = src[i - 1];
    if (q) {
      add(ch);
      if (ch === '\\' && q !== "'" && i + 1 < src.length) { add(nx); i++; }
      else if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; add(ch); continue; }
    if (ch === '\\') { if (nx === '\n') add(' '); else add(ch + (nx || '')); i++; continue; }
    if (ch === '$' && nx === '(') { dep++; add('$('); i++; continue; }
    if (dep) { if (ch === '(') dep++; else if (ch === ')') dep--; add(ch); continue; }
    if ((ch === '&' && nx === '&') || (ch === '|' && nx === '|')) { push(); i++; continue; }
    if (ch === ';' || ch === '\n' || ch === '(' || ch === ')') { push(); continue; }
    if (ch === '|') { parts.push(''); if (nx === '&') i++; continue; }
    if (ch === '&') {
      if (pv === '>' || pv === '<' || nx === '>') { add(ch); continue; }
      push(true);
      continue;
    }
    add(ch);
  }
  push();
  return segs;
}

/* Words of one pipeline part, quotes removed; `raw` keeps the quoted spelling for code arguments. */
function sbWords(part) {
  const out = [];
  const re = /(?:[^\s'"\\]|\\.|'[^']*'?|"(?:\\.|[^"\\])*"?)+/g;
  let m;
  while ((m = re.exec(part))) out.push(m[0].replace(/'([^']*)'?|"((?:\\.|[^"\\])*)"?|\\(.)/g, (x, a, b, c) => a != null ? a : b != null ? b.replace(/\\(["\\$`])/g, '$1') : c));
  return out;
}

/* Words without redirects; the redirect targets are returned separately. */
function sbRedirects(words) {
  const ws = [], outs = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], m = w.match(/^(\d*|&)(>>?|<)(&?\d*|\|)?(.*)$/);
    if (m && (m[1] || m[2]) && /^[\d&]*[<>]/.test(w)) {
      if (m[3] && /&\d/.test(m[3])) continue;                 // 2>&1, >&2
      let target = m[4];
      if (!target && i + 1 < words.length) target = words[++i];
      if (m[2] !== '<' && target && !/^\/dev\/(null|stdout|stderr)$/.test(target)) outs.push({file: target, append: m[2] === '>>'});
      continue;
    }
    ws.push(w);
  }
  return {ws, outs};
}

const sbFiles = (args, root) => args.filter(a => a && !a.startsWith('-') && !/^__HD\d+__$/.test(a)).map(a => sbPath(a, root).p);
const sbList = (fs, n) => fs.length ? fs.slice(0, n || 1).join('、') + (fs.length > (n || 1) ? ' 等 ' + fs.length + ' 个' : '') : '';

/* Files named by an inline script (paths in string literals), the written ones first when they can be told apart. */
function sbScriptFiles(body, root) {
  const all = [], written = [];
  let m;
  SB_STRLIT.lastIndex = 0;
  while ((m = SB_STRLIT.exec(body))) {
    const lit = m[2];
    if (!SB_PATHY.test(lit) || /^\/+$/.test(lit)) continue;
    const p = sbPath(lit, root).p;
    if (!all.includes(p)) all.push(p);
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (/^\s*,\s*(?:mode\s*=\s*)?['"][wax]/.test(after) && !written.includes(p)) written.push(p);
  }
  // `p='file'` followed by open(p,'w') or sub(p, ...) helpers: the assigned file is the one changed
  const asg = body.match(/^\s*\w+\s*=\s*(['"])([^'"\n]+\.\w{1,8})\1\s*$/m);
  if (asg && !written.length) written.push(sbPath(asg[2], root).p);
  return {all, written: written.length ? written : all};
}

function sbScriptKind(name) {
  const n = String(name || '').toLowerCase();
  if (/(^|[:/_.-])(test|tests|spec|e2e|unit|integration)([:/_.-]|$)/.test(n)) return 'test';
  if (/(check|lint|stan|typecheck|tsc|verify|validate|gate|format|fmt)/.test(n)) return 'check';
  if (/(^|[:/_.-])(build|bundle|compile|dist|package)([:/_.-]|$)/.test(n)) return 'build';
  if (/(^|[:/_.-])(dev|serve|server|preview|watch)([:/_.-]|$)/.test(n)) return 'serve';
  return '';
}

const SB_VERB = {test: '跑测试', check: '检查', build: '构建', serve: '起服务', bg: '后台运行', run: '运行'};
const sbCmdText = (ws, n) => sbClip(ws.join(' '), n || 64);
const sbArg = (a, root) => {
  if (!/\//.test(a) || /^-/.test(a) || /^https?:/.test(a)) return a;
  const r = sbPath(a, root);
  return r.wt && r.p === '.' ? 'worktrees/' + r.wt : r.p;
};

/* One pipeline (already split into words) -> {kind, action, target, w, where} or null for noise. */
function sbClassify(partsWords, ctx, bodies, bg) {
  const root = ctx.root;
  let {ws, outs} = sbRedirects(partsWords[0]);
  // keywords and prefixes: `do x`, `if grep`, `sudo x`, `timeout 60 x`, `env A=b x`, `A=b x`
  for (let guard = 0; guard < 8 && ws.length; guard++) {
    const w = ws[0];
    if (SB_KEYWORD.has(w)) { if (w === 'while' && ws[1] === 'read') return null; ws = ws.slice(1); continue; }
    if (SB_PREFIX.has(sbBase(w))) { if (w === 'nohup') bg = true; ws = ws.slice(1); while (ws.length && /^-\w$/.test(ws[0])) ws = ws.slice(1); continue; }
    if (w === 'env') { ws = ws.slice(1); continue; }
    if (/^[A-Za-z_]\w*=/.test(w)) { ws = ws.slice(1); continue; }
    if (/^(g?timeout|with-timeout)$/.test(sbBase(w))) { ws = ws.slice(1); while (ws.length && /^(-\S+|\d+[smhd]?)$/.test(ws[0])) ws = ws.slice(1); continue; }
    break;
  }
  if (!ws.length) return null;
  const prog = sbBase(ws[0]), args = ws.slice(1);
  const hd = args.map(a => (a.match(/^__HD(\d+)__$/) || [])[1]).find(x => x != null);
  const body = hd != null ? bodies[+hd] || '' : '';
  const mk = (kind, action, target, w) => ({kind, action, target: target || '', w: w != null ? w : SB_W[kind]});

  if (prog === 'until') return mk('wait', '轮询直到 ' + sbClip(args.join(' '), 40), '', 3);
  if (/^(sh|bash|zsh|dash)$/.test(prog)) {
    const ci = args.findIndex(a => /^-\w*c$/.test(a));
    if (ci >= 0 && args[ci + 1] != null) return {nested: args[ci + 1]};
    const script = args.find(a => !a.startsWith('-'));
    if (script && !/^__HD/.test(script)) { const k = sbScriptKind(script) || 'run'; return mk(k, (SB_VERB[k] || '运行') + ' ' + sbPath(script, root).p, script); }
    if (body) return {nested: body};
    return null;
  }
  if (prog === 'ssh') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += /^-[iopFlJLRDWbcEeIQSw]$/.test(args[i]) ? 2 : 1;
    const host = args[i], rest = args.slice(i + 1).join(' ');
    if (!host) return null;
    if (rest || body) return {nested: rest || body, where: 'ssh ' + host.replace(/^[^@]+@/, '')};
    return mk('net', '连接 ' + host, host, 4);
  }
  if (prog === 'xargs') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += /^-[IJLnPsd]$/.test(args[i]) ? 2 : 1;
    return args[i] ? sbClassify([args.slice(i)], ctx, bodies, bg) : null;
  }
  if (prog === 'echo' || prog === 'printf' || prog === 'cat' && (hd != null || !args.length)) {
    if (outs.length) {
      const f = sbPath(outs[0].file, root).p;
      return mk('write', (outs[0].append ? '追加到 ' : '写 ') + f, f, 6);
    }
    if (prog !== 'cat') return null;
  }
  if (SB_NOISE.has(prog)) return null;
  if (prog === 'wait') return mk('wait', '等后台任务结束', '', 1.5);

  // ---- git and GitHub
  if (prog === 'git') {
    let i = 0, where = '';
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-C') { where = sbPath(args[i + 1], root).wt || ''; i += 2; } else if (args[i] === '-c') i += 2; else i++;
    }
    const sub = args[i] || '', rest = args.slice(i + 1);
    if (!sub) return mk('git', 'git', '', 2);
    if (sub === 'grep') return mk('search', '搜索「' + sbClip(rest.find(a => !a.startsWith('-')) || '', 30) + '」（git grep）', '', 2);
    let action = 'git ' + sub;
    if (sub === 'commit') {
      const mi = rest.findIndex(a => /^-\w*m$/.test(a) || a === '--message');
      action += mi >= 0 && rest[mi + 1] ? '「' + sbClip(rest[mi + 1].split('\n')[0], 40) + '」' : rest.includes('--amend') ? ' --amend' : '';
    } else {
      const shown = rest.filter(a => !/^__HD/.test(a)).map(a => sbArg(a, root));
      if (shown.length) action += ' ' + sbClip(shown.join(' '), 48);
    }
    // `git branch` / `git stash list` / `git worktree list` only look; adding to the index is a small step before a commit
    const looks = (sub === 'branch' && !rest.some(a => /^-[dDmMcC]$/.test(a)) && !rest.some(a => !a.startsWith('-'))) || /^(list|show)$/.test(rest[0] || '');
    const r = mk('git', action, sub, SB_GIT_MUT.has(sub) && !looks ? (sub === 'add' ? 4 : 6) : 3);
    if (where) r.where = where;
    return r;
  }
  if (prog === 'gh') return mk('git', 'gh ' + sbClip(args.slice(0, 3).join(' '), 40), args[0], 5);

  // ---- in-place edits: sed -i '' 's/a/b/' f, perl -pi -e '...' f (the script is the first word unless -e gave it)
  if ((prog === 'sed' || prog === 'perl') && args.some(a => /^-\w*i/.test(a) || a === '--in-place')) {
    const pos = [];
    let hadE = false;
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (a === '-e' || a === '--expression') { hadE = true; j++; continue; }
      if (a.startsWith('-')) { if (prog === 'sed' && a === '-i' && args[j + 1] === '') j++; continue; }
      pos.push(a);
    }
    const fs = sbFiles(hadE ? pos : pos.slice(1), root);
    return mk('write', '改 ' + (sbList(fs, 1) || '文件') + '（' + prog + '）', fs[0], 6);
  }

  // ---- inline scripts (heredoc, -c / -e / -r code)
  if (SB_INTERP.test(prog)) {
    const lang = prog.replace(/[\d.]+$/, '');
    const ci = args.findIndex(a => /^-(c|e|r|E)$/.test(a));
    const code = body || (ci >= 0 ? args[ci + 1] || '' : '');
    if (code && (hd != null || ci >= 0 || args[0] === '-')) {
      const files = sbScriptFiles(code, root);
      if (SB_WRITES.test(code)) return mk('write', '改 ' + (sbList(files.written, 1) || '文件') + '（' + lang + ' 脚本）', files.written[0], 6);
      if (files.all.length) return mk('read', '读 ' + sbList(files.all, 1) + '（' + lang + ' 脚本）', files.all[0], 2.5);
      return mk('run', '运行 ' + lang + ' 内联脚本', '', 3);
    }
    const mi = args.indexOf('-m');
    if (mi >= 0 && args[mi + 1]) {
      const mod = args[mi + 1];
      if (mod === 'pytest' || mod === 'unittest') return mk('test', '跑测试 ' + sbCmdText([prog, '-m'].concat(args.slice(mi + 1)), 56), mod);
      if (/^(py_compile|compileall|mypy|ruff|flake8|black|pyright)$/.test(mod)) return mk('check', '检查 ' + sbCmdText(args.slice(mi + 1), 56), mod);
      if (mod === 'pip') return mk('deps', '装依赖 ' + sbCmdText(args.slice(mi + 1), 56), 'pip');
      if (mod === 'http.server') return mk('serve', '起服务 ' + sbCmdText([prog].concat(args), 56), mod);
      return mk('run', '运行 ' + sbCmdText([prog].concat(args), 56), mod);
    }
    if (lang === 'php' && args[0] === '-l') return mk('check', '语法检查 ' + sbList(sbFiles(args.slice(1), root), 2), args[1]);
    if (lang === 'php' && args[0] === '-S') return mk('serve', '起服务 php -S ' + (args[1] || ''), args[1]);
    if (lang === 'node' && args[0] === '--check') return mk('check', '语法检查 ' + sbList(sbFiles(args.slice(1), root), 2), args[1]);
    const si = args.findIndex(a => !a.startsWith('-'));
    if (si >= 0) {
      const script = args[si], sub = args[si + 1] || '';
      const tool = SB_TEST_TOOLS[sbBase(script)];
      if (lang === 'php' && sbBase(script) === 'artisan') {
        const k = sub === 'test' ? 'test' : sub === 'serve' ? 'serve' : 'run';
        return mk(k, (SB_VERB[k]) + ' artisan ' + sub, sub);
      }
      const k = tool || sbScriptKind(sbBase(script)) || sbScriptKind(sub) || (/^(serve|dev|start|restart|reload)$/.test(sub) ? 'serve' : '') || (bg ? 'bg' : 'run');
      const shown = [sbPath(script, root).p].concat(args.slice(si + 1).map(a => sbArg(a, root)));
      return mk(k, SB_VERB[k] + ' ' + sbCmdText(shown, 60), script);
    }
    return mk('run', '运行 ' + prog, prog, 2);
  }

  // ---- package managers and build tools
  if (/^(npm|pnpm|yarn|bun|npx|bunx|composer|pip3?|uv|poetry|brew|apt|apt-get|cargo|go|make|gradle|mvn|swift|deno)$/.test(prog)) {
    let sub = args.find(a => !a.startsWith('-')) || '';
    const si = args.indexOf(sub);
    if (/^(npx|bunx)$/.test(prog) || (prog === 'pnpm' && sub === 'dlx')) {
      const rest = prog === 'pnpm' ? args.slice(si + 1) : args.slice(si);
      const t = rest.find(a => !a.startsWith('-')) || '';
      const k = SB_TEST_TOOLS[t] || sbScriptKind(t) || (t === 'vite' && rest.includes('build') ? 'build' : t === 'vite' ? 'serve' : 'run');
      return mk(k, SB_VERB[k] + ' ' + sbCmdText([prog].concat(args), 60), t);
    }
    if (prog === 'uv' && sub === 'pip') sub = 'install';
    if (SB_DEPS_SUB.has(sub) && prog !== 'make' && prog !== 'go') return mk('deps', '装依赖 ' + sbCmdText([prog].concat(args), 56), sub);
    if (prog === 'go' && /^(get|mod)$/.test(sub)) return mk('deps', '装依赖 ' + sbCmdText([prog].concat(args), 56), sub);
    if (/^(brew|apt|apt-get)$/.test(prog)) return mk('deps', sbCmdText([prog].concat(args), 56), sub, 4);
    let name = sub;
    if (sub === 'run' || sub === 'run-script' || sub === 'exec') name = args.slice(si + 1).find(a => !a.startsWith('-')) || '';
    let k;
    if (/^(cargo|go|swift)$/.test(prog)) k = {test: 'test', clippy: 'check', check: 'check', fmt: 'check', vet: 'check', build: 'build', run: bg ? 'bg' : 'run'}[sub] || 'run';
    else if (prog === 'make') k = sbScriptKind(name) || 'build';
    else k = SB_TEST_TOOLS[name] || sbScriptKind(name) || (name === 'test' || name === 't' ? 'test' : bg ? 'bg' : 'run');
    const shown = [prog].concat(args.map(a => sbArg(a, root)));
    return mk(k, SB_VERB[k] + ' ' + sbCmdText(shown, 60), name);
  }
  if (SB_TEST_TOOLS[prog]) { const k = SB_TEST_TOOLS[prog]; return mk(k, SB_VERB[k] + ' ' + sbCmdText([prog].concat(args.map(a => sbArg(a, root))), 60), prog); }
  if (prog === 'vite' || prog === 'next' || prog === 'nuxt') {
    const k = args.includes('build') ? 'build' : 'serve';
    return mk(k, SB_VERB[k] + ' ' + sbCmdText([prog].concat(args), 50), prog);
  }
  if (prog === 'docker' || prog === 'docker-compose' || prog === 'podman') {
    const k = args.includes('up') || args.includes('run') && args.includes('-d') ? 'serve' : args.includes('build') ? 'build' : 'run';
    return mk(k, SB_VERB[k] + ' ' + sbCmdText([prog].concat(args), 56), args[0]);
  }

  // ---- waiting, processes, network
  if (prog === 'sleep') return mk('wait', '等待 ' + (args[0] || '') + (/^\d+$/.test(args[0] || '') ? ' 秒' : ''), '', 3);
  if (prog === 'watch') return mk('wait', '反复执行 ' + sbClip(args.filter(a => !a.startsWith('-')).join(' '), 40), '', 3);
  if (prog === 'tail' && args.some(a => /^-\w*[fF]/.test(a) || a === '--follow')) return mk('wait', '跟踪 ' + sbList(sbFiles(args, root), 1), '', 3);
  if (prog === 'pgrep' || prog === 'lsof' || prog === 'ps') return mk('wait', '查看进程 ' + sbClip(args.filter(a => !a.startsWith('-')).join(' '), 30), '', 1.5);
  if (prog === 'kill' || prog === 'pkill' || prog === 'killall') {
    if (args[0] === '-0') return mk('wait', '检查进程 ' + (args[1] || ''), '', 1.5);
    return mk('run', '结束进程 ' + sbClip(args.filter(a => !a.startsWith('-')).join(' '), 30), '', 3);
  }
  if (/^(curl|wget|http|https|xh)$/.test(prog)) {
    const url = args.find(a => /^https?:\/\//.test(a)) || args.find(a => /^[\w.-]+(:\d+)?\//.test(a)) || '';
    const xi = args.findIndex(a => a === '-X' || a === '--request');
    const method = xi >= 0 ? (args[xi + 1] || '').toUpperCase() : args.some(a => /^(-d|--data|--data-raw|--data-binary|-F|--form|--json)$/.test(a)) ? 'POST' : '';
    const u = url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
    return mk('net', '请求 ' + (method && method !== 'GET' ? method + ' ' : '') + sbClip(u || prog, 56), u, 4);
  }
  if (/^(dig|nslookup|host|ping|nc|traceroute|openssl|whois)$/.test(prog)) return mk('net', '检查网络 ' + sbClip(args.filter(a => !a.startsWith('-')).join(' '), 40), '', 3);
  if (prog === 'scp' || prog === 'rsync') { const fs = args.filter(a => !a.startsWith('-')); return mk('net', '传输 ' + sbClip(fs.map(a => sbArg(a, root)).join(' → '), 56), fs[fs.length - 1], 5); }

  // ---- file changes
  if (prog === 'tee') { const fs = sbFiles(args, root); return fs.length ? mk('write', (args.includes('-a') ? '追加到 ' : '写 ') + sbList(fs, 1), fs[0], 6) : null; }
  if (/^(cp|mv|ln|install|rsync|ditto)$/.test(prog)) {
    const fs = sbFiles(args, root);
    const verb = {cp: '复制', mv: '移动', ln: '建链接', install: '安装文件', ditto: '复制'}[prog];
    return mk('write', verb + ' ' + (fs.length >= 2 ? sbList(fs.slice(0, -1), 1) + ' → ' + fs[fs.length - 1] : sbList(fs, 1)), fs[fs.length - 1], 5);
  }
  if (/^(rm|rmdir|unlink|trash)$/.test(prog)) return mk('write', '删除 ' + sbList(sbFiles(args, root), 1), '', 4);
  if (prog === 'mkdir') return mk('write', '建目录 ' + sbList(sbFiles(args, root), 1), '', 2);
  if (prog === 'touch') return mk('write', '创建 ' + sbList(sbFiles(args, root), 1), '', 4);
  if (prog === 'chmod' || prog === 'chown') return mk('write', '改权限 ' + sbList(sbFiles(args.slice(1), root), 1), '', 3);
  if (prog === 'patch' || prog === 'apply_patch') return mk('write', '打补丁 ' + sbList(sbFiles(args, root), 1), '', 6);

  // ---- reading and searching
  if (SB_SEARCH.has(prog)) {
    if (prog === 'find' || prog === 'fd' || prog === 'locate' || prog === 'mdfind') {
      const ni = args.findIndex(a => /^-i?(name|path|regex)$/.test(a));
      const dirs = sbFiles(args.slice(0, args.findIndex(a => a.startsWith('-')) >= 0 ? args.findIndex(a => a.startsWith('-')) : args.length), root);
      return mk('search', '找文件 ' + (ni >= 0 ? sbClip(args[ni + 1], 30) + ' ' : '') + (dirs.length ? '于 ' + sbList(dirs, 2) : ''), dirs[0], 2);
    }
    const pos = [];
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (/^-(e|f|g|t|m|A|B|C|-include|-exclude|-glob|-type|-max-count)$/.test(a) && j + 1 < args.length) { if (a === '-e' && !pos.length) pos.push(args[j + 1]); j++; continue; }
      if (a.startsWith('-')) continue;
      pos.push(a);
    }
    const pat = pos[0] || '', where = sbFiles(pos.slice(1), root);
    return mk('search', '搜索「' + sbClip(pat.replace(/\\\|/g, '|'), 32) + '」' + (where.length ? '于 ' + sbList(where, 2) : ''), pat, 2);
  }
  if (SB_READ.has(prog)) {
    const fs = sbFiles(prog === 'sed' || prog === 'awk' || prog === 'jq' ? args.filter((a, j) => j !== args.findIndex(x => !x.startsWith('-'))) : args.filter((a, j) => !(j && /^-[nNc]$/.test(args[j - 1]))), root);
    const f = sbList(fs, 1);
    let action;
    if (prog === 'ls' || prog === 'tree') action = '列出 ' + (f || '当前目录');
    else if (prog === 'wc') action = (args.includes('-l') ? '数行数 ' : '统计 ') + (f || '输入');
    else if (prog === 'sed') {
      const sc = args.find(a => !a.startsWith('-')) || '', r = sc.match(/^(\d+)(?:,(\d+|\$))?p$/);
      action = '读 ' + (f || '输入') + (r ? (r[2] ? ' 第 ' + r[1] + '–' + r[2] + ' 行' : ' 第 ' + r[1] + ' 行') : '');
    } else if (prog === 'head' || prog === 'tail') {
      const ni = args.findIndex(a => a === '-n' || /^-\d+$/.test(a)), n = ni >= 0 ? (args[ni] === '-n' ? args[ni + 1] : args[ni].slice(1)) : '';
      action = '读 ' + (f || '输入') + (n ? (prog === 'head' ? ' 前 ' : ' 末 ') + n.replace(/^\+/, '') + ' 行' : '');
    } else if (prog === 'diff' || prog === 'cmp') action = '对比 ' + fs.slice(0, 2).join(' 和 ');
    else if (prog === 'which' || prog === 'type') action = '查找命令 ' + args.filter(a => !a.startsWith('-')).join(' ');
    else if (prog === 'pwd') return mk('read', '看当前目录', '', 0.5);
    else if (/^(stat|file|du|df|readlink|realpath|shasum|md5|md5sum|sha256sum)$/.test(prog)) action = '查看 ' + (f || prog);
    else action = '读 ' + (f || '输入') + (prog === 'jq' || prog === 'awk' ? '（' + prog + '）' : '');
    return mk('read', action, fs[0], fs.length ? 2 : 1);
  }
  if (/^(psql|mysql|sqlite3|redis-cli|mongosh|pg_isready)$/.test(prog)) return mk('run', '查询数据库（' + prog + '）', '', 3);
  if (prog === 'open' || prog === 'osascript') return mk('run', sbCmdText([prog].concat(args.map(a => sbArg(a, root))), 56), '', 2);
  // ./tool, bin/x, tools/x.sh, an executable by path or a plain unknown program
  const k = SB_TEST_TOOLS[prog] || sbScriptKind(prog) || (/^(serve|dev|start)$/.test(args[0] || '') ? 'serve' : '') || (bg ? 'bg' : '');
  if (k) return mk(k, SB_VERB[k] + ' ' + sbCmdText([sbPath(ws[0], root).p].concat(args.map(a => sbArg(a, root))), 60), prog);
  return mk('other', sbCmdText([/\//.test(ws[0]) ? sbPath(ws[0], root).p : ws[0]].concat(args.map(a => sbArg(a, root))), 60), prog, 1);
}

/* Command substitutions $( ... ) are cut out (marker __SUB<n>__) so that their commands count as segments of their own. */
function sbSubs(src) {
  const subs = [];
  let out = '', q = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q === "'") { out += ch; if (ch === "'") q = null; continue; }
    if (ch === '\\') { out += ch + (src[i + 1] || ''); i++; continue; }
    if (ch === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
      let dep = 1, j = i + 2, q2 = null;
      for (; j < src.length && dep; j++) {
        const c = src[j];
        if (q2) { if (c === '\\' && q2 === '"') j++; else if (c === q2) q2 = null; continue; }
        if (c === "'" || c === '"') q2 = c; else if (c === '(') dep++; else if (c === ')') dep--;
      }
      subs.push(src.slice(i + 2, dep ? j : j - 1));
      out += '__SUB' + (subs.length - 1) + '__';
      i = j - 1;
      continue;
    }
    if (ch === '"') q = q ? null : '"'; else if (ch === "'" && !q) q = "'";
    out += ch;
  }
  return {text: out, subs};
}

/* Every meaningful segment of a shell command, in order: [{kind, action, target, w, where}]. `cd` sets the working place and
 * plain assignments (S=/path) are substituted into later words, so `$S/x.php` reads as scratchpad/x.php. */
function sbShell(cmd, ctx, depth) {
  const hd = sbHeredocs(cmd), {text, subs} = sbSubs(hd.text), bodies = hd.bodies;
  const out = [], vars = Object.assign({}, ctx.vars || {});
  let where = ctx.where || '';
  const nest = (src, w) => { if ((depth || 0) < 3) sbShell(src, {root: ctx.root, where: w || where, vars}, (depth || 0) + 1).forEach(x => out.push(x)); };
  const expand = w => w.indexOf('$') < 0 ? w : w.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, v) => v === 'PWD' ? '.' : v === 'HOME' ? '~' : vars[v] != null ? vars[v] : m);
  sbSegments(text).forEach(seg => {
    (seg.parts.join(' ').match(/__SUB\d+__/g) || []).forEach(m => nest(subs[+m.slice(5, -2)]));
    const words = seg.parts.map(p => sbWords(p).map(expand));
    let head = words[0];
    if (head[0] === 'export' || head[0] === 'local' || head[0] === 'declare') head = head.slice(1);
    if (head.length && head.every(w => /^[A-Za-z_]\w*=/.test(w))) {
      head.forEach(w => { const i = w.indexOf('='); if (!/__SUB/.test(w)) vars[w.slice(0, i)] = w.slice(i + 1); });
      return;
    }
    if (head[0] === 'cd' || head[0] === 'pushd') { const p = sbPath(head[1] || '~', ctx.root); where = p.wt || (p.p === '.' ? '' : where); return; }
    const r = sbClassify(words, ctx, bodies, seg.bg);
    if (!r) return;
    if (r.nested != null) { nest(r.nested, r.where); return; }
    if (!r.where && where) r.where = where;
    out.push(r);
  });
  return out;
}

/* The command text of a call: Claude Bash input, a Codex exec_command (also inside an exec cell's JavaScript). */
function sbCommand(c) {
  const t = c.inp || c.sum || '';
  if (/tools\.(exec_command|shell_command)\s*\(/.test(t) || /^\s*\{\s*"(cmd|command)"/.test(t)) {
    const cmds = [];
    const re = /"?(?:cmd|command)"?\s*:\s*("(?:\\.|[^"\\])*")/g;
    let m;
    while ((m = re.exec(t))) { try { cmds.push(JSON.parse(m[1])); } catch (e) { /* cut by the input cap */ } }
    if (cmds.length) return cmds.join('\n');
  }
  return t;
}

/* ---- non-shell tools */
const SB_BROWSER = {navigate: '打开页面', computer: '操作页面', javascript_tool: '在页面执行脚本', javascript_exec: '在页面执行脚本', browser_batch: '批量页面操作',
  resize_window: '调整视口', read_console_messages: '读控制台', read_network_requests: '读网络请求', find: '查找页面元素', read_page: '读页面结构',
  get_page_text: '读页面文字', preview_start: '启动预览', preview_stop: '停止预览', tabs_close: '关闭标签页', tabs_create: '新建标签页',
  tabs_context: '查看标签页', tabs_select: '切换标签页', form_input: '填写表单', screenshot: '截图'};

function sbTool(c, root) {
  const name = c.name || '', sum = c.sum || '', short = name.split('__').pop();
  const fp = () => sbPath(sum.replace(/ @\d+$/, ''), root);
  switch (name) {
    case 'Read': { const p = fp(); const at = sum.match(/ @(\d+)$/); return {kind: 'read', action: '读 ' + p.p + (at ? ' 从第 ' + at[1] + ' 行' : ''), target: p.p, where: p.wt}; }
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': { const p = fp(); return {kind: 'write', action: '改 ' + p.p, target: p.p, where: p.wt}; }
    case 'Write': { const p = fp(); return {kind: 'write', action: '写 ' + p.p, target: p.p, where: p.wt}; }
    case 'Grep': { const m = sum.match(/^(.*?)\s{2}(.*)$/); const pat = m ? m[1] : sum, p = m && m[2] ? sbPath(m[2], root) : null;
      return {kind: 'search', action: '搜索「' + sbClip(pat, 32) + '」' + (p ? '于 ' + p.p : ''), target: pat, where: p ? p.wt : ''}; }
    case 'Glob': return {kind: 'search', action: '找文件 ' + sbClip(sum, 50), target: sum};
    case 'LSP': return {kind: 'search', action: '代码导航 ' + sbClip(sum, 50), target: sum};
    case 'WebFetch': return {kind: 'net', action: '抓取网页 ' + sbClip(sum.replace(/^https?:\/\//, '').replace(/[?#].*$/, ''), 50), target: sum};
    case 'WebSearch': case 'web_search': case 'web__run': {
      const q = (sum.match(/'q': '([^']+)'|"q": "([^"]+)"/) || []).slice(1).find(Boolean) || sum;
      return {kind: 'net', action: '搜索网页「' + sbClip(q, 40) + '」', target: q};
    }
    case 'Agent': case 'Task': case 'spawn_agent': return {kind: 'agent', action: '派子代理：' + sbClip(sum, 50), target: sum};
    case 'SendMessage': case 'send_message': case 'followup_task': return {kind: 'agent', action: '发消息 ' + sbClip(sum, 50), target: ''};
    case 'SubagentHandback': return {kind: 'agent', action: '交回最终报告', target: ''};
    case 'Monitor': return {kind: 'wait', action: '监视 ' + sbClip(sum, 50), target: ''};
    case 'wait_agent': case 'wait': case 'wait_threads': case 'sleep': return {kind: 'wait', action: sum ? sbClip(sum, 50) : '等待', target: ''};
    case 'write_stdin': return {kind: 'wait', action: /输入/.test(sum) ? '向会话' + sbClip(sum.replace(/^session \S+ /, ''), 40) : '轮询会话输出', target: ''};
    case 'apply_patch': return {kind: 'write', action: '改 ' + (sbList(sum.split(', ').filter(Boolean).map(f => sbPath(f.replace(/ 等 \d+ 个文件$/, ''), root).p), 2) || '文件') + '（补丁）', target: sum};
    case 'ToolSearch': return {kind: 'tool', action: '加载工具 ' + sbClip(sum, 40), target: ''};
    case 'Skill': return {kind: 'tool', action: '使用技能 ' + sbClip(sum, 40), target: sum};
    case 'TaskStop': return {kind: 'tool', action: '停止后台任务', target: ''};
    case 'AskUserQuestion': case 'request_user_input_async': case 'request_user_input': return {kind: 'tool', action: '询问用户', target: ''};
    case 'update_plan': case 'TodoWrite': return {kind: 'tool', action: '更新计划', target: ''};
  }
  if (/^mcp__(Claude_Browser|claude-in-chrome|playwright|puppeteer|chrome)/i.test(name) || /^mcp__.*browser/i.test(name)) {
    return {kind: 'browser', action: (SB_BROWSER[short] || short) + (sum && !/^\{/.test(sum) ? ' ' + sbClip(sum.replace(/^https?:\/\//, ''), 40) : ''), target: ''};
  }
  if (/^mcp__work-band__progress$/.test(name)) return {kind: 'tool', action: '上报进度', target: ''};
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return {kind: 'tool', action: '调用 ' + sbClip(parts.slice(1).join('.'), 40), target: ''};
  }
  return null;
}

/* ---- result line */
const SB_JUNK = /^(\{\}$|(bash|zsh|sh): warning: setlocale|Warning: Permanently added|Warning: truncated output|Total output lines:|Output:$|Wall time|Chunk ID|Original token count|… \[已省略|\(Bash completed with no output\)|Process running with session ID|Script (completed|failed))/;
const SB_RES_PATTERNS = [
  [/\b\d+\s+(passed|failed|failing|passing|skipped|tests? passed)\b/i, 9], [/^(Tests?:\s*\d|Test Files\s+\d|Tests\s+\d+|OK \(\d+ tests?)/, 9],
  [/^(Ran \d+ tests?|# (pass|fail) \d+|FAILED \(|All \d+ tests? passed)/i, 9],
  [/\bexit(?:\s*code)?\s*[=:]\s*-?\d+\b/i, 7],
  [/\b\d+ files? changed\b/, 8], [/^\[[^\]\s]+ [0-9a-f]{7,40}\]/, 8],
  [/^(Successfully rebased|Fast-forward|Already up to date|CONFLICT|HEAD is now at|Switched to|Preparing worktree|Merge made by|nothing to commit|Your branch is|Deleted branch|To \S+)/, 7],
  [/^(PASS|FAIL)\b.*\S/, 6], [/^\s*(ok|not ok)\s+\d+/, 5]
];
const SB_ERR = /\b(error|errors|fatal|exception|traceback|failed|failure|failures|cannot|could not|couldn't|not found|no such file|permission denied|denied|unmatched|syntax error|undefined|refused|timed? ?out|conflict)\b/i;

function sbOutText(c) {
  let text = String(c.res || ''), exit = null;
  const em = text.match(/^\s*(?:Exit code|Process exited with code)\s+(-?\d+)/m);
  if (em) exit = +em[1];
  if (/^\s*\{\s*"(chunk_id|wall_time_seconds|exit_code|output|session_id)"/.test(text)) {   // Codex exec_command JSON result
    const xm = text.match(/"exit_code"\s*:\s*(-?\d+)/);
    if (xm) exit = +xm[1];
    const om = text.match(/"output"\s*:\s*"((?:\\.|[^"\\])*)/);
    if (om) { let s = om[1].replace(/\\$/, ''); try { s = JSON.parse('"' + s + '"'); } catch (e) { s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"'); } text = s; }
    else text = '';
  }
  return {text, exit};
}

function sbResult(c, kind, root) {
  if (!c) return {state: 'none', line: ''};
  if (c.st === 'hook') return {state: 'err', line: sbClip('被钩子拦截' + (c.hook ? '：' + String(c.hook).trim().split('\n')[0] : ''), 100)};
  if (c.st === 'pend') return {state: 'pend', line: c.bg ? '后台运行中' : '无结果'};
  const state = c.st === 'err' ? 'err' : 'ok';
  const {text, exit} = sbOutText(c);
  const raw = text.split('\n');
  if (/^(Command running in background|.*moved to the background)/.test(raw.find(l => l.trim()) || '')) return {state, line: /timeout/.test(text) ? '超时，转入后台' : '已转入后台运行'};
  if (/^Async agent launched/.test(text.trim())) return {state, line: '已派出，后台运行'};
  if (/^Monitor started/.test(text.trim())) return {state, line: '已开始监视'};
  const lines = raw.map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && !SB_JUNK.test(l) && !/^(Exit code|Process exited with code) -?\d+$/.test(l) && !/^[-=_*#~]{3,}$/.test(l) && !/^[[\]{}(),;]+$/.test(l) && !(state === 'ok' && /^(PHP )?(Deprecated|Notice):/.test(l)));
  if (c.name === 'Read' && state === 'ok') return {state, line: c.rlen ? '读到 ' + c.rlen + ' 字符' : '无内容'};
  if ((c.name === 'Edit' || c.name === 'Write' || c.name === 'MultiEdit') && state === 'ok' && /has been (updated|created|written)|successfully/i.test(lines[0] || '')) return {state, line: '已保存'};
  let best = null, bestScore = 0;
  // a status list (ok / PASS / FAIL rows of a check runner) is summed up as counts
  const okN = lines.filter(l => /^(ok|PASS|✓|✔)\b/i.test(l)).length, failN = lines.filter(l => /^(FAIL|FAILED|not ok|ERROR|✗|✘|×)\b/.test(l)).length;
  if (okN + failN >= 2) { best = (failN ? failN + ' 项失败（' + sbClip(lines.find(l => /^(FAIL|FAILED|not ok|ERROR|✗|✘|×)\b/.test(l)), 50) + '）· ' : '') + okN + ' 项通过'; bestScore = 8.5; }
  lines.forEach(l => {
    // test summaries: the last one wins (a run that first fails, then passes, ends in its final state); others: the first
    for (const [re, sc] of SB_RES_PATTERNS) if ((sc > bestScore || sc >= 9 && sc === bestScore) && re.test(l)) { best = l; bestScore = sc; }
    if (state === 'err' && bestScore < 6 && SB_ERR.test(l)) { best = l; bestScore = 6; }
  });
  let line = best || lines[0] || (state === 'ok' ? '无输出' : '');
  if (exit != null && exit !== 0) line = 'exit ' + exit + (line && !/^exit\b/i.test(line) ? ' · ' + line : '');
  // long absolute paths in the line are shortened like the ones in actions
  line = line.replace(/<\/?tool_use_error>/g, '').replace(/(^|[\s:'"(])((?:\/[\w.@~-]+){3,})/g, (m, pre, p) => { const r = sbPath(p, root).p; return pre + (r === '.' ? sbBase(p) : r); });
  return {state: exit != null && exit !== 0 ? 'err' : state, line: sbClip(line, 110)};
}

/* ---- entry point */
const SB_CACHE = new WeakMap();

function stepBrief(c, s, opts) {
  const key = c || s;
  const sig = c ? c.st + '|' + (c.res || '').length + '|' + (c.inp || c.sum || '').length : 'reply';
  if (key && typeof key === 'object' && !(opts && opts.root != null)) {
    const hit = SB_CACHE.get(key);
    if (hit && hit.sig === sig) return hit.b;
  }
  const b = sbBuild(c, s, sbRoot(opts));
  if (key && typeof key === 'object' && !(opts && opts.root != null)) SB_CACHE.set(key, {sig, b});
  return b;
}

function sbBuild(c, s, root) {
  const fin = (kind, action, target, more, where) => {
    const k = SB_KINDS[kind] ? kind : 'other';
    const tidy = x => String(x || '').replace(/__SUB\d+__/g, '$(…)').replace(/__HD\d+__/g, '<<…');
    return {kind: k, kindLabel: SB_KINDS[k][0], color: SB_KINDS[k][1], action: tidy(action), target: tidy(target), more: tidy(more), where: where || '', result: sbResult(c, k, root)};
  };
  if (!c) {
    const said = String(s && s.says || '').split('\n').map(x => x.trim()).find(Boolean) || '';
    return fin('reply', sbClip(said, 120) || '回复');
  }
  const t = sbTool(c, root);
  if (t) return fin(t.kind, t.action, t.target, '', t.where);
  const shellish = /^(Bash|bash|exec_command|shell_command|shell|run_terminal_cmd|run_shell_command|run_in_terminal)$/.test(c.name || '') ||
    /(^|\+)(exec_command|shell_command)(\+|$)/.test(c.name || '') || /^mcp__terminal__run_in_terminal$/.test(c.name || '');
  const cmd = shellish ? sbCommand(c) : '';
  const fallbackKind = SB_CAT_KIND[c.cat] || (c.cat === 'other' ? 'other' : 'tool');
  if (!cmd || /^\s*(const|let|await|text\(|tools\.)/.test(cmd)) {
    const first = String(c.sum || c.inp || '').split('\n')[0];
    return fin(shellish ? fallbackKind : (SB_CAT_KIND[c.cat] || 'tool'), shellish ? sbClip(first, 80) : c.name + (first ? ' ' + sbClip(first, 60) : ''), '');
  }
  const segs = sbShell(cmd, {root, where: ''}, 0);
  if (!segs.length) return fin(fallbackKind, sbClip(String(cmd).trim().split('\n')[0], 80), '');
  let main = segs[0];
  segs.forEach(x => { if (x.w > main.w) main = x; });
  if (main.kind === 'other' && SB_CAT_KIND[c.cat] && segs.length === 1) main = Object.assign({}, main, {kind: SB_CAT_KIND[c.cat]});
  if (c.bg && (main.kind === 'run' || main.kind === 'other')) main = Object.assign({}, main, {kind: 'bg', action: main.action.replace(/^运行 /, '')});
  // the other segments, heaviest first and without repeats of the same action
  const seen = new Set([main.action]);
  const others = segs.filter(x => x !== main && x.w >= 1 && !seen.has(x.action) && seen.add(x.action)).sort((x, y) => y.w - x.w);
  const more = others.length ? '另有 ' + others.length + ' 条命令：' + others.slice(0, 2).map(x => sbClip(x.action, 30)).join(' · ') + (others.length > 2 ? ' …' : '') : '';
  return fin(main.kind, main.action, main.target, more, main.where);
}
