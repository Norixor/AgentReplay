// Shared by the page tests: a stub DOM and a loader that runs a generated replay page's script against it.
import fs from 'node:fs';
import vm from 'node:vm';

export function stubElement(store) {
  const fn = function () {};
  const p = new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === '__store') return store;
      if (k === 'querySelector') {  // one stub per selector, so the markup written into children can be collected
        return sel => { const kids = store.__kids = store.__kids || {}; return kids[sel] = kids[sel] || stubElement(sel === '#asort' ? {value: 'start'} : {}); };
      }
      if (k === 'querySelectorAll' || k === 'getElementsByTagName') return () => Object.assign([], {forEach() {}});
      if (k === 'getBoundingClientRect') return () => ({left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600});
      if (k === 'then') return undefined;
      if (k in store) return store[k];
      if (k === 'innerHTML' || k === 'textContent' || k === 'className') return '';
      if (k === 'value') return '';
      if (k === 'clientWidth' || k === 'offsetHeight' || k === 'clientHeight' || k === 'offsetWidth' || k === 'scrollHeight' || k === 'length') return 800;
      if (k === 'isConnected') return true;
      if (k === 'hidden') return false;
      if (k === 'dataset' || k === 'style' || k === 'classList') return store[k] = store[k] || stubElement({});
      return p;
    },
    set(t, k, v) { store[k] = v; return true; },
    apply() { return p; },
  });
  return p;
}

export function loadPage(file) {
  const html = fs.readFileSync(file, 'utf8');
  const data = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const scripts = [...html.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!data || !scripts.length) throw new Error('page has no data or script block: ' + file);
  const root = {};
  const doc = {
    getElementById: id => id === 'data' ? {textContent: data[1].replace(/\\u003c/g, '<')} : id === 'app' ? appStub : stubElement({}),
    querySelector: () => stubElement({}), querySelectorAll: () => Object.assign([], {forEach() {}}),
    createElement: () => stubElement({}), createElementNS: () => stubElement({}), addEventListener() {}, removeEventListener() {}, body: stubElement({}),
    documentElement: {style: {setProperty() {}}, dataset: {}}, hidden: false,
  };
  const appStore = {};
  const appStub = stubElement(appStore);
  const win = {addEventListener() {}, removeEventListener() {}, scrollTo() {}, devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800};
  const ctx = vm.createContext(Object.assign(win, {
    document: doc, window: win, location: {hash: '', href: 'http://x/'}, localStorage: {getItem: () => null, setItem() {}},
    matchMedia: () => ({matches: false}), performance: {mark() {}, now: () => 0}, requestAnimationFrame: f => 0, cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, getComputedStyle: () => ({getPropertyValue: () => '#888', position: ''}),
    fetch: () => Promise.reject(new Error('no network')), console, URLSearchParams, Math, JSON, Date, navigator: {}, history: {replaceState() {}},
    ResizeObserver: class { observe() {} disconnect() {} }, Float32Array, Float64Array, Uint8Array, Set, Map,
  }));
  vm.runInContext(scripts.join('\n'), ctx, {filename: file});
  return {ctx, appStore, run: code => vm.runInContext(code, ctx)};
}

/* All markup written into a stub element and its querySelector children. */
export function markup(store) { return String(store.innerHTML || '') + Object.values(store.__kids || {}).map(k => markup(k.__store)).join(''); }

