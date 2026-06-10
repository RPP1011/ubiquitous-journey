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
    this.stats = { truces: 0, quelled: 0 };
  }

  tick(ctx: unknown, dt: number): void {
    try {
      if (!this.sim._spawned) return;   // a real town only (not bare test sub-sims)
      this._acc += dt;
      if (this._acc < PATRICIAN.tickEvery) return;
      this._acc = 0;
      this._broker();
    } catch { /* never throw on the tick */ }
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
    if (rng() < (PATRICIAN.reconcileChance || 0)) {
      this._reconcile(A, B);
    } else {
      this._truce(A, B);
      this._truce(B, A);
      this.stats.truces++;
      this._note(`The Patrician brokered peace between ${A.name} and ${B.name}.`);
    }
  }

  // pull A's standing toward B back up toward neutral, and defuse a latched hostility.
  _truce(A: Ag, B: Ag): void {
    const b = A.beliefs && A.beliefs.get ? A.beliefs.get(B.id) : null;
    if (!b) return;
    b.standing = Math.min(0.1, (b.standing || 0) + (PATRICIAN.brokerAmount || 0));
    if (PATRICIAN.quellHostile && b.hostile) { b.hostile = false; this.stats.quelled++; }
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
