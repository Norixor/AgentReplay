#!/usr/bin/env node
// Smoke test of a generated replay page without a browser: runs the page's script against a stub DOM, then renders every
// view with real session data and fails on exceptions or on "undefined" / "NaN" in the output.
// Usage: node scripts/test_pages.mjs page.html [page2.html ...]
import fs from 'node:fs';
import { stubElement, loadPage, markup } from './page_stub.mjs';

const bad = /undefined|NaN|\[object|Infinity/;
let failed = 0;
for (const file of process.argv.slice(2)) {
  let page;
  try { page = loadPage(file); } catch (e) { console.log('FAIL ' + file + ': load: ' + String(e && e.message || e) + ' @ ' + String((e && e.stack) || '').split('\n').filter(l => /at /.test(l)).slice(0, 2).join(' | ')); failed++; continue; }
  const views = [
    ['overview', "(() => { const r = {}; renderOverview(rootStub(r)); return markup(r); })()"],
    ['agents list', "(() => { const r = {}; renderAgents(rootStub(r)); return markup(r); })()"],
    ['main replay', "(() => { const r = {}; renderAgent(rootStub(r), 'main', null); return markup(r); })()"],
    ['sub-agent detail', "(() => { const r = {}; renderAgent(rootStub(r), SUBS[0].id, null); return markup(r); })()"],
    ['agents list with live status', "(() => { const st = ['exec', 'think', 'waiting', 'idle', 'done']; SX.phase = 'live'; SX.at = Date.now(); SX.map = {}; " +
      "SUBS.forEach((a, i) => { SX.map[a.id] = {state: st[i % 5], runMs: 65000, elapsed: 4000, tool: 'Bash', desc: 'npm test', sum: 'npm test', doneTs: Date.now(), why: 'x'}; }); " +
      "const r = {}; renderAgents(rootStub(r)); const r2 = {}; renderAgent(rootStub(r2), SUBS[0].id, null); SX.phase = 'static'; return markup(r) + markup(r2); })()"],
    ['single-agent time view', "(() => { const r = {}; renderTimelineFocus(rootStub(r), SUBS[0].id); return markup(r); })()"],
  ];
  if (process.env.SNAPSHOT) {  // a real /api/live snapshot: paint the live tab (cards, rate card) from it
    views.push(['live tab', "(() => { LV.data = " + fs.readFileSync(process.env.SNAPSHOT, 'utf8') + "; LV.fetchedAt = Date.now(); const r = {}; LV.root = rootStub(r); paintLive(); return markup(r); })()"]);
  }
  page.ctx.rootStub = o => stubElement(o);
  page.ctx.markup = markup;
  const err = page.appStore.innerHTML || '';
  if (/渲染失败/.test(err)) { console.log('FAIL ' + file + ': route() reported: ' + err.replace(/<[^>]+>/g, ' ').slice(0, 200)); failed++; }
  for (const [name, code] of views) {
    try {
      const out = String(page.run(code));
      if (process.env.DUMP_DIR) fs.writeFileSync(process.env.DUMP_DIR + '/' + file.split('/').pop() + '.' + name.replace(/\W+/g, '_') + '.html', out);  // for inspecting the markup
      const m = bad.exec(out.replace(/<style[\s\S]*?<\/style>/g, ''));
      if (!out || m) { console.log('FAIL ' + file + ' [' + name + ']: ' + (out ? 'found "' + m[0] + '" near: ' + out.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ') : 'empty output')); failed++; }
    } catch (e) { console.log('FAIL ' + file + ' [' + name + ']: ' + String(e && e.message || e) + ' @ ' + String((e && e.stack) || '').split('\n').filter(l => /at /.test(l)).slice(0, 2).join(' | ')); failed++; }
  }
}
console.log(failed ? failed + ' page check(s) failed' : 'pages: all views rendered without errors');
process.exit(failed ? 1 : 0);
