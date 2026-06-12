// Episodic memory: a cognitively-grounded, three-tier ring-buffer store of the
// salient things that happen to an agent. This is the autobiography the sim
// lacked — distinct from the BeliefStore (semantic memory ABOUT others). Future
// goal-derivation (grief / gratitude / fortune-seeking / revenge) reads it, and
// the inspector renders it as a "Life so far" biography.
//
// Three rings, consolidated like memory in sleep:
//   STM  short-term  — every salient episode, recent, high churn (small ring)
//   MTM  medium-term — STM episodes above a threshold, fades over minutes
//   LTM  long-term   — the formative few; promoted from MTM, fades very slowly
//
// An episode is plain data: { t, kind, withId?, place?, valence, salience }.
// Bounded by construction (ring overwrite) — no unbounded growth on the tick.

import { MEMORY } from './simconfig.js';
import type { Ring as IRing, Memory as IMemory, Episode } from '../../types/sim.js';

// Fixed-capacity circular buffer. push() overwrites the oldest when full and
// returns whatever it evicted (or null). items() yields newest-first.
export class Ring<T> implements IRing<T> {
  cap: number;
  buf: T[];
  head: number;
  constructor(capacity: number) { this.cap = Math.max(1, capacity | 0); this.buf = []; this.head = 0; }
  get size() { return this.buf.length; }
  push(item: T): T | null {
    if (this.buf.length < this.cap) { this.buf.push(item); return null; }
    const evicted = this.buf[this.head];
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    return evicted ?? null;
  }
  items(): T[] {                  // newest -> oldest
    const n = this.buf.length, out: T[] = [];
    for (let i = 0; i < n; i++) out.push(this.buf[(this.head + n - 1 - i) % n] as T);
    return out;
  }
}

export class Memory implements IMemory {
  stm: Ring<Episode>;
  mtm: Ring<Episode>;
  ltm: Ring<Episode>;
  _acc: number;
  constructor() {
    this.stm = new Ring(MEMORY.stm);
    this.mtm = new Ring(MEMORY.mtm);
    this.ltm = new Ring(MEMORY.ltm);
    this._acc = 0;
  }

  // record a fresh episode (no-op if too trivial to bother remembering). A repeat
  // of the same recent episode REINFORCES it (memory strengthens with repetition)
  // instead of flooding the buffer with duplicates.
  record(ep: Episode) {
    if (!ep || ep.salience < MEMORY.minSalience) return;
    const last = this.stm.items()[0];   // newest
    if (last && last.kind === ep.kind && last.withId === ep.withId && (ep.t - last.t) < MEMORY.dedupWindow) {
      last.salience = Math.min(1, Math.max(last.salience, ep.salience) + 0.05);
      last.t = ep.t;
      return;
    }
    this.stm.push(ep);
  }

  // periodic consolidation + slow forgetting; call on the fixed tick (self-throttled)
  tick(dt: number, now: number) {
    this._acc += dt;
    if (this._acc < MEMORY.consolidateEvery) return;
    const elapsed = this._acc; this._acc = 0;
    this._consolidate();
    this._fade(this.mtm, MEMORY.mtmDecay * elapsed);
    this._fade(this.ltm, MEMORY.ltmDecay * elapsed);
  }

  // cascade STM -> MTM -> LTM in one pass, so a strong episode reaches long-term
  // memory at full salience before fading erodes it. Copies are independent.
  _consolidate() {
    for (const ep of this.stm.items()) {
      if (ep._mt || ep.salience < MEMORY.mtmThreshold) continue;
      ep._mt = 1; this.mtm.push({ ...ep, _mt: 0 });
    }
    for (const ep of this.mtm.items()) {
      if (ep._lt || ep.salience < MEMORY.ltmThreshold) continue;
      ep._lt = 1; this.ltm.push({ ...ep, _lt: 0 });
    }
  }

  _fade(ring: Ring<Episode>, amt: number) { for (const ep of ring.items()) ep.salience = Math.max(0, ep.salience - amt); }

  // the formative few (LTM, then MTM), strongest first — for goals + the biography.
  // DIVERSITY-AWARE (the bond-crowding fix): a quiet life records the same episode kind
  // over and over (three apprentices = three 'bond' eps at 0.7), and a plain top-k-by-
  // salience returned four "joined with X" rows as the WHOLE formative set — every
  // consumer (goal derivation, biography highlights, the life digest) saw a monoculture.
  // A repeat of an already-picked kind now competes at salience × kindRepeatDamp^n, so
  // the second bond weighs 0.42 and a rarer windfall/grief/reunion surfaces instead.
  // The RINGS are untouched — storage, decay and the biography's bond scan are unchanged;
  // only the formative SELECTION diversifies. O(k·n) over ≤26 items — trivial.
  salient(k = 5) {
    const pool = [...this.ltm.items(), ...this.mtm.items()];
    const damp = MEMORY.kindRepeatDamp ?? 0.6;
    const picked: Episode[] = [];
    const kindN: Record<string, number> = {};
    while (picked.length < k && pool.length) {
      let bi = -1, bs = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i].salience * Math.pow(damp, kindN[pool[i].kind] || 0);
        if (s > bs) { bs = s; bi = i; }
      }
      if (bi < 0) break;
      const ep = pool.splice(bi, 1)[0];
      kindN[ep.kind] = (kindN[ep.kind] || 0) + 1;
      picked.push(ep);
    }
    return picked;
  }
  recent(k = 5) { return this.stm.items().slice(0, k); }
}

// Render an episode as a short past-tense phrase for the biography / dialogue.
export function memoryPhrase(ep: Episode, nameOf?: ((id: number | string) => string) | null) {
  const who = ep.withId != null ? (nameOf ? nameOf(ep.withId) : `#${ep.withId}`) : null;
  switch (ep.kind) {
    case 'triumph':         return who ? `bested ${who}` : 'won a victory';
    case 'bloodshed':       return who ? `killed ${who}` : 'spilled blood';
    case 'assaulted':       return who ? `was attacked by ${who}` : 'was attacked';
    case 'witnessed_death': return who ? `saw ${who} fall` : 'witnessed a death';
    case 'forsworn':        return who ? `forsook their vow against ${who}` : 'broke their sworn word';
    case 'survived':        return who ? `survived ${who}'s onslaught` : 'cheated death';
    case 'windfall':        return `struck it rich at the ${ep.place || 'market'}`;
    case 'milestone':       return ep.label ? `became a ${ep.label}` : 'came into their own';
    case 'bond':            return who ? `joined with ${who}` : 'found companions';
    case 'succoured':       return who ? `was saved by ${who}` : 'was helped in need';
    case 'relic':           return `found a relic in ${ep.place || 'a ruin'}`;
    case 'closure':         return who ? `made peace over ${who}` : 'found closure';
    case 'ruined':          return 'lost everything';
    case 'thwarted':        return 'gave up the venture';
    case 'slandered':       return 'found themselves shunned';
    default:                return ep.kind;
  }
}
