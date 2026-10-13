'use strict';
/* Hash router, header controls and start-up. Routes: #live #overview #timeline #timeline/agent/<id> #analysis #analysis/agent/<id> #route #main #agents #agent/<id>, optional ?t=<ms>&k=turn. */

const VIEW_CLEANUP = [];

/* The sticky header height varies when the nav wraps; sticky bars below it read it from --topH / --stick. */
function syncTopH() {
  const top = document.querySelector('.top').offsetHeight;
  document.documentElement.style.setProperty('--topH', top + 'px');
  const fb = document.querySelector('#stepsroot .fbar');
  const stick = fb && getComputedStyle(fb).position === 'sticky' ? top + fb.offsetHeight + 12 : top;
  document.documentElement.style.setProperty('--stick', stick + 'px');
}
window.addEventListener('resize', syncTopH);

function updateOrderBtn() {
  const b = document.getElementById('ordbtn');
  b.textContent = newestFirst() ? '最新在前 ⇅' : '最早在前 ⇅';
  b.setAttribute('aria-label', '当前' + (newestFirst() ? '最新在前' : '最早在前') + '，点击切换');
}

function route() {
  hideTip();
  VIEW_CLEANUP.splice(0).forEach(f => { try { f(); } catch (e) { /* ignore cleanup errors */ } });
  syncTopH();
  const raw = location.hash.replace(/^#/, '') || (D.meta.active ? 'live' : 'overview');
  const qi = raw.indexOf('?');
  const path = qi < 0 ? raw : raw.slice(0, qi), q = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
  const parts = path.split('/');
  const view = parts[0];
  const root = document.getElementById('app');
  const jump = q.get('t') ? {t: +q.get('t'), k: q.get('k'), s: q.get('s') == null ? null : +q.get('s')} : null;
  document.querySelectorAll('#nav a').forEach(a => {
    const on = a.dataset.v === (view === 'agent' ? 'agents' : view);
    a.classList.toggle('on', on);
    a.setAttribute('aria-selected', String(on));
    a.setAttribute('role', 'tab');
    a.tabIndex = on ? 0 : -1;
  });
  root.className = 'v-' + view;
  try {
    if (view === 'live' && D.meta.active) renderLive(root);
    else if (view === 'timeline') {
      if (parts[1] === 'agent' && parts[2]) renderTimelineFocus(root, decodeURIComponent(parts[2]));
      else renderTimeline(root);
    }
    else if (view === 'analysis') renderAnalysis(root, parts[1] === 'agent' && parts[2] ? decodeURIComponent(parts[2]) : null);
    else if (view === 'route') renderRoute(root, {live: false});   // static route map from the page data, no polling
    else if (view === 'main') renderAgent(root, 'main', jump);
    else if (view === 'agents') renderAgents(root);
    else if (view === 'agent') renderAgent(root, parts[1], jump);
    else renderOverview(root);
  } catch (e) {
    root.innerHTML = '<div class="empty err"><b>这个页面渲染失败</b><span>' + esc(e && e.message || e) + '。数据可能不完整，可以换一个标签，或回到会话列表重新生成。</span></div>';
    if (window.console) console.error(e);
  }
  fitClamps(root);
  syncTopH();
  if (!jump) window.scrollTo(0, 0);
  try { performance.mark('ar-route:' + view); } catch (e) { /* marks are optional */ }
}

(function boot() {
  const nav = document.getElementById('nav');
  if (D.meta.active) nav.insertAdjacentHTML('afterbegin', '<a href="#live" data-v="live">实时<i class="livedot"></i></a>');
  const tl = nav.querySelector('[data-v="timeline"]');
  if (tl) tl.insertAdjacentHTML('afterend', '<a href="#analysis" data-v="analysis">耗时分析</a><a href="#route" data-v="route">路线</a>');
  nav.addEventListener('keydown', e => {  // arrow keys move between tabs
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    const tabs = Array.from(nav.querySelectorAll('a'));
    let i = tabs.indexOf(document.activeElement);
    if (i < 0) i = tabs.findIndex(a => a.classList.contains('on'));
    i = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[i].focus();
    location.hash = tabs[i].getAttribute('href');
  });
  const brand = document.getElementById('brand');
  brand.addEventListener('click', () => { location.hash = D.meta.active ? '#live' : '#overview'; });
  brand.innerHTML = toolChip() + ' ' + esc(D.meta.name) + ' · 会话回看';
  brand.title = D.meta.name;
  document.title = D.meta.name + ' · 会话回看';
  const ob = document.getElementById('ordbtn');
  ob.addEventListener('click', () => { setOrder(newestFirst() ? 'old' : 'new'); updateOrderBtn(); route(); });
  updateOrderBtn();
  window.addEventListener('hashchange', route);
  route();
})();
