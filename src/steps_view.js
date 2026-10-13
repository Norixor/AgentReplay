'use strict';
/* The "逐步回看" section of an agent page: table / terminal switch (choice kept in localStorage), the lazily built views and
 * the live update that feeds both. Called by renderAgent (view_agents.js). */

const SV_VIEWS = [['table', '表格'], ['term', '终端']];

function stepsView(root, a, jump) {
  const tbl = root.querySelector('#stepsroot'), trm = root.querySelector('#termroot'), seg = root.querySelector('#vseg'), bar = root.querySelector('#lsbar');
  let view = jump ? 'table' : termPref();   // a jump target lives in the table
  let tblDone = false, term = null;

  function show() {
    tbl.hidden = view !== 'table';
    trm.hidden = view !== 'term';
    if (view === 'table' && !tblDone) { renderSteps(a, tbl, jump); tblDone = true; }
    if (view === 'term' && !term) { term = termMount(trm, a); VIEW_CLEANUP.push(term.destroy); }
    if (view === 'term') term.show();
    seg.innerHTML = SV_VIEWS.map(v => '<button type="button" data-v="' + v[0] + '" class="' + (view === v[0] ? 'on' : '') + '" aria-pressed="' + (view === v[0]) + '">' + v[1] + '</button>').join('');
    if (typeof syncTopH === 'function') syncTopH();
  }
  seg.addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.dataset.v === view) return;
    view = b.dataset.v;
    termSetPref(view);
    show();
  });
  show();

  const live = lsStart(a, bar, info => {
    if (tblDone && tbl._tbl) tbl._tbl.append(info);
    if (term) term.apply(info);
  }, () => {   // header: statistics and the category card follow the new steps
    const stats = root.querySelector('#agstats'), cat = root.querySelector('#agcat');
    if (stats) stats.innerHTML = agentStats(a);
    if (cat) cat.innerHTML = agentCatHTML(a);
  });
  if (live) VIEW_CLEANUP.push(live.destroy);
}
