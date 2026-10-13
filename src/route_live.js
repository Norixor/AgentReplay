'use strict';
/* Fork-route map, part 3: live data. Polls /api/steps for each running agent (5 s cycle); when that route does not
 * exist (404 / unknown session) the /api/live snapshot passed in by live.js (`recent` steps per card) is used instead.
 * All writes go through RM.* which de-duplicates, so a repeated answer never creates duplicate nodes. */

const RTLIVE_MAX_PER_CYCLE = 12;

function rtLiveCreate(opts) {
  const o = Object.assign({store: null, key: '', intervalMs: 5000, fetchFn: (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
                           hidden: () => (typeof document !== 'undefined' && document.hidden), onChange: () => {}}, opts);
  const S = {mode: 'api', timer: 0, rot: 0, busy: false, stopped: true, retryApiAt: 0, lastOk: 0, err: ''};

  async function pollAgent(a) {
    const real = a.steps.length - a.synth;
    const url = '/api/steps/' + o.key + '?agent=' + encodeURIComponent(a.id) + '&after=' + real + '&turns=' + a.nturns + '&known=' + o.store.order.length;
    let r;
    try { r = await o.fetchFn(url, {cache: 'no-store'}); } catch (e) { S.err = String(e && e.message || e); return null; }
    if (r.status === 404) {
      let j = null;
      try { j = await r.json(); } catch (e) { /* plain-text 404: the route does not exist */ }
      return {missing: true, j};
    }
    if (r.status === 503) return {skip: true};
    let j;
    try { j = await r.json(); } catch (e) { S.err = 'bad json'; return null; }
    if (!j || !j.ok) return {skip: true};
    if (j.warming) return {skip: true};
    return {j};
  }

  /* One polling round. Returns true when the store changed. */
  async function cycle() {
    if (S.busy) return false;
    S.busy = true;
    let changed = false;
    try {
      const running = o.store.order.map(id => o.store.agents.get(id)).filter(a => a.running);
      if (S.mode === 'fallback' && Date.now() < S.retryApiAt) return false;
      const n = Math.min(running.length, RTLIVE_MAX_PER_CYCLE);
      for (let i = 0; i < n; i++) {
        const a = running[(S.rot + i) % running.length];
        const res = await pollAgent(a);
        if (!res || res.skip) continue;
        if (res.missing) { S.mode = 'fallback'; S.retryApiAt = Date.now() + 60000; break; }
        S.mode = 'api';
        S.lastOk = Date.now();
        const before = o.store.rev;
        RM.applyStepsAnswer(o.store, a.id, res.j);
        if (o.store.rev !== before) changed = true;
      }
      S.rot += n;
    } finally { S.busy = false; }
    if (changed) o.onChange();
    return changed;
  }
  function schedule() {
    clearTimeout(S.timer);
    if (S.stopped || o.hidden()) return;
    S.timer = setTimeout(async () => { await cycle(); schedule(); }, o.intervalMs);
  }
  return {
    state: S, cycle,
    start() { S.stopped = false; cycle().then(schedule); },
    stop() { S.stopped = true; clearTimeout(S.timer); },
    resume() { if (S.stopped || o.hidden()) return; cycle().then(schedule); },
    /* The /api/live snapshot (every poll of live.js): marks running agents; supplies steps only when /api/steps is unavailable. */
    onSnapshot(d) {
      const before = o.store.rev;
      RM.applyLive(o.store, d, {steps: S.mode === 'fallback'});
      if (o.store.rev !== before) o.onChange();
    }
  };
}
