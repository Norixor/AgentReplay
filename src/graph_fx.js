'use strict';
/* Flow graph, part 3: one-shot effects. Events are keyed by (ts, kind, agent, text) and each key is played once;
 * the first snapshot (and any snapshot after the page was hidden or the view switched) only marks events as seen,
 * so history never replays. Effects that loop (glow, link dashes) are plain CSS in graph.css. */

const GRFX = {seen: new Set(), dots: []};

const grFxKey = e => e.ts + '|' + e.k + '|' + e.agent + '|' + String(e.text || '').slice(0, 40);

/* Events not seen before, oldest first; they are marked seen right away. */
function grFxFresh(d) {
  const out = [];
  (d.events || []).forEach(e => {
    const k = grFxKey(e);
    if (!GRFX.seen.has(k)) { GRFX.seen.add(k); out.push(e); }
  });
  if (GRFX.seen.size > 600) {
    const drop = [];
    for (const k of GRFX.seen) { if (drop.length >= 300) break; drop.push(k); }
    drop.forEach(k => GRFX.seen.delete(k));
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/* Restarts a one-shot CSS class on an element and removes it again after ms. */
function grFxClass(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(el['_t' + cls]);
  el['_t' + cls] = setTimeout(() => el.classList.remove(cls), ms);
}

/* A short-lived overlay element inside a node's card (halo ring, red flash). */
function grFxOverlay(o, cls, ms) {
  const i = document.createElement('i');
  i.className = cls;
  o.el._r.card.appendChild(i);
  setTimeout(() => i.remove(), ms);
}

function grFxNode(id) {
  const o = GR.nodes.get(id);
  return o && o.el._r ? o : null;
}

function grFxRun(list) {
  if (grReduced()) return;
  list.forEach(e => {
    if (e.k === 'hook') {
      const o = grFxNode(e.agent);
      if (o) { grFxClass(o.el._r.card, 'fx-shake', 600); grFxOverlay(o, 'gr-flash', 800); }
    } else if (e.k === 'fail') {
      const o = grFxNode(e.agent);
      if (o) grFxClass(o.el._r.state, 'fx-fail', 1300);
    } else if (e.k === 'merge') {
      const o = grFxNode('main');
      if (o) grFxOverlay(o, 'gr-halo', 1100);
    } else if (e.k === 'compact') {
      const o = grFxNode(e.agent) || grFxNode('main');
      if (o) grFxClass(o.el._r.bar, 'fx-compact', 1500);
    }
  });
}

/* New sub-agent: the card scales and fades in (the link draws itself, see grFrame). */
function grFxPop(o) {
  if (grReduced() || !o.el._r) return;
  const c = o.el._r.card;
  c.classList.add('gr-pop');
  setTimeout(() => c.classList.remove('gr-pop'), 700);
}

/* Hand-back: a light travels from the child's input slot back to the parent's output slot, and the check appears. */
function grFxReturn(o) {
  if (grReduced() || !o.el._r) return;
  grFxClass(o.el, 'fx-return', 1100);
  const e = GR.edges.get(o.n.parent + '>' + o.n.id);
  if (!e) return;
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('class', 'gr-dot');
  dot.setAttribute('r', '6');
  dot.style.opacity = '0';
  GR.svg.appendChild(dot);
  GRFX.dots.push({e, dot, t0: performance.now(), dur: 1000});
}

/* Advances the light dots; true while any is still travelling. */
function grFxStep(now) {
  GRFX.dots = GRFX.dots.filter(d => {
    const p = (now - d.t0) / d.dur;
    if (p >= 1 || !GR.edges.has(d.e.id)) { d.dot.remove(); return false; }
    if (d.e.curve) {
      const pt = grPoint(d.e.curve, 1 - grEase(Math.max(0, p)));
      d.dot.setAttribute('cx', pt[0].toFixed(1));
      d.dot.setAttribute('cy', pt[1].toFixed(1));
      d.dot.style.opacity = String(Math.min(1, p * 8, (1 - p) * 4));
    }
    return true;
  });
  return GRFX.dots.length > 0;
}
