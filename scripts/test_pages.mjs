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
    // a source that records no token usage (meta.source.noUsage): no view shows an amount or a usage token count (the size before a
    // context compaction is a context figure, not usage)
    ['no-usage mode', "(() => { SRC.noUsage = true; try { const rs = [{}, {}, {}, {}, {}]; renderOverview(rootStub(rs[0])); renderAgents(rootStub(rs[1])); renderAgent(rootStub(rs[2]), 'main', null); " +
      "renderAgent(rootStub(rs[3]), SUBS[0].id, null); renderTimelineFocus(rootStub(rs[4]), SUBS[0].id); return rs.map(markup).join(''); } finally { SRC.noUsage = false; } })()"],
  ];
  // the live tab of a source without token usage: a snapshot that deliberately carries amounts and tokens (a real one has zeros), so
  // any figure that is not left out shows up; the context size must stay
  const card = (id, state) => ({id, desc: id === 'main' ? '主代理' : id, model: 'm', effort: 'medium', parent: id === 'main' ? null : 'main', depth: id === 'main' ? 0 : 1, start: Date.now() - 600000,
    runMs: 600000, steps: 7, stepsApprox: false, ctx: 5000, ctxLimit: 256000, state, detail: {tool: 'Bash', desc: 'run', sum: 'make', elapsed: 4000, n: 1, since: 3000}, lastTs: Date.now(), done: false, doneTs: 0,
    tok: {in: 111111, cw5: 0, cw1: 0, cr: 222222, out: 3333}, tokTotal: 336666, costWin: 12.34, spm: 2, brief: null, recent: [{n: 1, ts: Date.now(), tool: 'Bash', sum: 'make', why: '', st: 'ok', dur: 10}],
    alerts: [], cost15: 5.67, tok15: 99999});
  const snap = {ok: true, tool: 'cursor', id: 'x', now: Date.now(), lastWrite: Date.now(), sinceWrite: 0, ended: false, cards: [card('main', 'exec'), card('sub1', 'think')], returned: [], events: [], lastUser: null,
    tok15: 99999, staleSubs: 0, subs: {}, unpriced: ['m'], rate: {c15: 5.67, c60: 8.9, perHour15: 22.68, perHour60: 8.9, t15: 99999, t60: 123456, tPerHour15: 399996, tPerHour60: 123456, series: new Array(12).fill(1.5), tseries: new Array(12).fill(5000)},
    cfg: {pollSec: 5, slowPollSec: 60, ctxLimit: 256000, graphMaxNodes: 40, graphFadeSec: 60, returnedKeepSec: 600}, build: {ms: 1, followed: 2}, took: 1};
  const liveNoUsage = "(() => { SRC.noUsage = true; try { LV.data = " + JSON.stringify(snap) + "; LV.fetchedAt = Date.now(); LV.view = 'cards'; const r = {}; LV.root = rootStub(r); paintLive(); " +
    "const g = LV.data.cards.map(c => grTokText(c)).join('') + rateCard(LV.data) + RM.sorts().map(o => o[1]).join(' '); return markup(r) + g; } finally { SRC.noUsage = false; LV.view = 'route'; } })()";
  views.push(['no-usage live tab', liveNoUsage]);
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
      const leak = name.startsWith('no-usage') ? /\$[0-9][0-9,]*\.[0-9]{2}|<\$0\.01|(?<!压缩前 [0-9.]*)[0-9][kM]? token\b/.exec(out.replace(/<style[\s\S]*?<\/style>/g, '')) : null;
      if (name === 'no-usage live tab' && /金额/.test(out)) { console.log('FAIL ' + file + ' [' + name + ']: an amount label is shown'); failed++; }
      if (name === 'no-usage live tab' && !/上下文 [0-9]/.test(out)) { console.log('FAIL ' + file + ' [' + name + ']: the context size is missing'); failed++; }
      if (leak) { console.log('FAIL ' + file + ' [' + name + ']: amount or token count shown near: ' + out.slice(Math.max(0, leak.index - 60), leak.index + 60).replace(/\s+/g, ' ')); failed++; }
      if (!out || m) { console.log('FAIL ' + file + ' [' + name + ']: ' + (out ? 'found "' + m[0] + '" near: ' + out.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ') : 'empty output')); failed++; }
    } catch (e) { console.log('FAIL ' + file + ' [' + name + ']: ' + String(e && e.message || e) + ' @ ' + String((e && e.stack) || '').split('\n').filter(l => /at /.test(l)).slice(0, 2).join(' | ')); failed++; }
  }
}
console.log(failed ? failed + ' page check(s) failed' : 'pages: all views rendered without errors');
process.exit(failed ? 1 : 0);
