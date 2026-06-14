// THE PATRICIAN — a diegetic peace-keeper (Discworld's Lord Vetinari). The Director
// is the agent of drama; the Patrician is its counterweight. Each measured interval
// it scans the town for the most dangerous FEUD (the most mutually-hostile pair of
// townsfolk — often one the Director just lit) and BROKERS a partial truce, quelling
// any latched intra-town hostility before it becomes a killing.
//
// The point is not to remove tension but to MANAGE it: feuds still smoulder, crime
// still simmers, but the city holds — so the world stays interesting without tearing
// itself apart. Belief-only (it nudges standings; ground truth is untouched), no
// gold, fully guarded (never throws on the fixed tick).

import { PATRICIAN } from './simconfig.js';
import { rng } from './rng.js';
import { brandForsworn } from './houses.js';

// `sim`/`ctx` (the owning Simulation + cognition context — wave-2, still .js) and the
// agents (via their belief/standing flags) are typed opaquely on purpose; this layer is
// belief-only and fully guarded, so behaviour is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;

export class Patrician {
  sim: Sim;
  _acc: number;
  stats: Record<string, number>;

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this.stats = { truces: 0, quelled: 0, forswornLeaks: 0 };
  }

  tick(ctx: unknown, dt: number): void {
    try {
      if (!this.sim._spawned) return;   // a real town only (not bare test sub-sims)
      // BETRAYAL-AS-CHOICE leak (every tick, PROMPT): drain any oath-abandonment stamped on a
      // breaker's own-state this cognition tick and leak it to its witnesses BEFORE the breaker
      // wanders off. Cheap (a single O(n) roster pass; short-circuits when nothing is armed).
      this._leakForsworn();
      this._acc += dt;
      if (this._acc < PATRICIAN.tickEvery) return;
      this._acc = 0;
      this._broker();
    } catch { /* never throw on the tick */ }
  }

  // OBSERVER bridge for betrayal-as-choice: motivation.resolveOath stamps `_forswornLeak` on a
  // breaker's own-state (cognition writes only its own flag — the epistemic split holds). Here, in
  // the omniscient society pass, we read the roster to PLANT the deed into nearby witnesses' beliefs
  // (reputation.witnessForsworn — each writes its OWN belief) and, if the breaker is now a habitual
  // oathbreaker, brand it. The marker is consumed once. Belief/name only; ground truth untouched.
  _leakForsworn(): void {
    const agents = this.sim.agents;
    if (!agents || !this.sim.reputation || !this.sim.reputation.witnessForsworn) return;
    for (const a of agents) {
      const mark = a && (a as { _forswornLeak?: { t: number; count: number } })._forswornLeak;
      if (!mark) continue;
      (a as { _forswornLeak?: unknown })._forswornLeak = undefined;   // consume once
      if (!a.alive) continue;
      try {
        const n = this.sim.reputation.witnessForsworn(agents, a, this.sim.time);
        if (n > 0) {
          this.stats.forswornLeaks = (this.stats.forswornLeaks || 0) + 1;
          this._note(`Word spreads that ${a.name} forsook a sworn vow.`);
        }
        brandForsworn(this.sim, a);   // gated on life.forsworn; brands once, never clobbers a held epithet
      } catch { /* never throw on the tick */ }
    }
  }

  // find the single most-mutually-hostile pair of townsfolk and broker a truce.
  _broker(): void {
    const folk = this.sim.agents.filter((a: any) => a.alive && a.autonomous && a.faction === 'townsfolk');
    // a real intra-town FEUD is a latched HOSTILE belief between two townsfolk (what
    // the director's feud / a kin-vendetta leaves behind) — NOT merely a low standing,
    // which a fond pair soured by a spark never crosses. Find the most bitter such pair.
    let pair = null, worst = Infinity;
    for (const A of folk) {
      const all = A.beliefs && A.beliefs.all ? A.beliefs.all() : [];
      for (const b of all) {
        if (!b) continue;
        const B = this.sim.agentsById.get(b.subjectId);
        if (!B || !B.alive || B.faction !== 'townsfolk' || B === A) continue;
        const ba = B.beliefs.get(A.id);
        if (!(b.hostile || (ba && ba.hostile))) continue;   // only an actual feud (latched hostility)
        const sum = (b.standing || 0) + ((ba && ba.standing) || 0);
        if (sum < worst) { worst = sum; pair = [A, B]; }
      }
    }
    if (!pair) return;
    const [A, B] = pair;
    // most interventions are a TRUCE (damp the feud); occasionally the Patrician
    // achieves a lasting RECONCILIATION — former enemies become friends. Peace, not
    // just a pause: the positive counterpoint to all the blood-feuds.
    // CONTESTED / REFUSABLE PEACE: brokering is not omnipotent. A party nursing a fresh, salient
    // BETRAYED/AVENGE wound RESISTS — a forced forgiveness over real blood is no forgiveness. A
    // reconciliation (enemies → friends) is impossible if EITHER side holds such a wound; it
    // degrades to a (still-resisted) truce. A failed brokering that hardens a feud is more
    // interesting than silent neutralization.
    const grudge = Math.max(this._grudgeSalience(A, B), this._grudgeSalience(B, A));
    if (grudge < (PATRICIAN.refuseSalience || 0.6) && rng() < (PATRICIAN.reconcileChance || 0)) {
      this._reconcile(A, B);
    } else {
      const r1 = this._truce(A, B);
      const r2 = this._truce(B, A);
      this.stats.truces++;
      if (r1 || r2) this._note(`The Patrician tried to broker peace between ${A.name} and ${B.name}, but the grudge runs deep.`);
      else this._note(`The Patrician brokered peace between ${A.name} and ${B.name}.`);
    }
  }

  // The peak salience of a fresh BETRAYED/AVENGE-class wound A carries about B (own-memory only —
  // the epistemic split: we read the TARGET's own autobiography to gauge how forgivable this is).
  // Scans all rings; a hostile-feud grudge memory keyed on B (withId/byId) at high salience is the
  // "I will not be made to forgive this" signal. Bounded, guarded, returns 0 when there's none.
  _grudgeSalience(A: Ag, B: Ag): number {
    try {
      const m = A && A.memory;
      if (!m || !B) return 0;
      const rings = [m.stm, m.mtm, m.ltm];
      let best = 0;
      const GRUDGE = new Set(['betrayed', 'assaulted', 'forsworn', 'witnessed_death', 'grief']);
      for (const r of rings) {
        if (!r || !r.items) continue;
        for (const e of r.items()) {
          if (!e || (e.valence || 0) >= 0) continue;
          if (e.withId !== B.id && e.byId !== B.id) continue;
          if (!GRUDGE.has(e.kind)) continue;
          if ((e.salience || 0) > best) best = e.salience || 0;
        }
      }
      return best;
    } catch { return 0; }
  }

  // Pull A's standing toward B back up toward neutral, defuse a latched hostility — UNLESS A holds a
  // salient grudge about B, in which case the nudge is throttled by (1 - grudge): a deep wound barely
  // moves, and the hostility is NOT quelled. When the wound is severe, the forced peace can BACKFIRE —
  // A resents being made to forgive: the feud hardens a touch and A files a `forced_peace` resentment
  // memory (and, rarely, sours on the Patrician's whole project — recorded, never a hidden truth flip).
  // Returns true if A resisted (so the caller can narrate a hardened feud rather than a clean peace).
  _truce(A: Ag, B: Ag): boolean {
    const b = A.beliefs && A.beliefs.get ? A.beliefs.get(B.id) : null;
    if (!b) return false;
    const grudge = this._grudgeSalience(A, B);
    const throttle = Math.max(0, 1 - grudge);              // 1 = no grudge (full nudge); 0 = unforgivable
    const resisted = grudge >= (PATRICIAN.resistSalience || 0.5);
    if (resisted && rng() < (PATRICIAN.hardenChance || 0)) {
      // BACKFIRE: forcing the issue hardens the feud instead of damping it.
      b.standing = Math.max(-1, (b.standing || 0) - (PATRICIAN.hardenAmount || 0.08));
      if (A.memory) { try { A.memory.record({ t: this.sim.time, kind: 'forced_peace', withId: B.id, valence: -1, salience: Math.min(0.85, 0.45 + grudge * 0.4) }); } catch { /* */ } }
      this.stats.hardened = (this.stats.hardened || 0) + 1;
      return true;
    }
    b.standing = Math.min(0.1, (b.standing || 0) + (PATRICIAN.brokerAmount || 0) * throttle);
    if (PATRICIAN.quellHostile && b.hostile && !resisted) { b.hostile = false; this.stats.quelled++; }
    return resisted;
  }

  // a LASTING peace: mutual standing turns warmly POSITIVE (friendship, so it won't
  // simply re-sour), hostility is cleared, and each records a reconciliation bond.
  // If the two belong to different Houses, it's a peace between their lines — a
  // saga-worthy beat (the marriage-alliance / feud's-end trope).
  _reconcile(A: Ag, B: Ag): void {
    for (const [x, y] of [[A, B], [B, A]]) {
      const b = x.beliefs && x.beliefs.get ? x.beliefs.get(y.id) : null;
      if (b) { b.standing = Math.max(b.standing || 0, PATRICIAN.reconcileStanding || 0.4); b.hostile = false; }
      if (x.memory) { try { x.memory.record({ t: this.sim.time, kind: 'bond', withId: y.id, rel: 'reconciled', valence: 1, salience: 0.7 }); } catch { /* */ } }
    }
    this.stats.reconciliations = (this.stats.reconciliations || 0) + 1;
    const houses = A.house && B.house && A.house !== B.house;
    const text = houses
      ? `Houses ${A.house} and ${B.house} have set aside their feud and made peace.`
      : `${A.name} and ${B.name}, long at odds, have reconciled.`;
    this._note(text, 'legend');   // peace endures in the saga
  }

  _note(text: string, kind?: string): void { try { if (this.sim.chronicle && this.sim.chronicle.note) this.sim.chronicle.note(kind || 'patrician', kind === 'legend' ? -14 : -12, text); } catch { /* */ } }
}
