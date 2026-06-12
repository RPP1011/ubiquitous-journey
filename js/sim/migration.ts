// MIGRATION: the truth-side half of the emigration valve (config: MIGRATE). A
// multi-town birth loop compounds wherever couples get a head start (dense towns
// breed more — rich-get-richer; measured by test/townprobe.mjs), so left alone the
// outer towns hollow out. The valve is a CENSUS + a RUMOUR, never a quota:
//
//   CENSUS — each pass counts living townsfolk per town (an OBSERVER-LAYER
//            aggregate, like the Director's quiet-world read: it narrates where
//            the world is crowded, it never drives a decision directly).
//   RUMOUR — when one town is crowded and another sparse, word reaches a few ears
//            in the crowded town that land is cheap in the sparse one: an Inform
//            written into the agent's own perceivable `_prospects` mailbox (the
//            recruiter-offer / alms-plea pattern). Bounded + TTL'd.
//
// THE EPISTEMIC SPLIT HOLDS: this pass computes crowding from ground truth (it is
// not an NPC), but the would-be MIGRANT decides entirely off its OWN state — the
// perceived prospect + its own poverty/houselessness/personality — in the
// features/migrate.js deriver. Whoever the rumour reaches may simply ignore it.
//
// CONSTRAINTS honoured here (the lineage conventions):
//  * never throw / never stall the fixed tick — the pass is fully guarded.
//  * bounded — at most MIGRATE.rumoursPerPass prospects stamped per pass, mailbox
//    capped at MIGRATE.prospectCap (oldest dropped).
//  * inert in bare sub-sims — a world with fewer than two towns has no valve.
//
// Self-throttled: Simulation calls migration.tick(ctx, step) on the fixed loop.

import { rng } from './rng.js';
import { MIGRATE } from './simconfig.js';

// `sim`/`ctx` (the owning Simulation + cognition context) are typed opaquely on
// purpose, exactly like lineage.ts — this pass reads roster aggregates truth-side
// and writes only bounded own-state mailboxes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

export class Migration {
  sim: Sim;
  _acc: number;
  rumours: number;     // lifetime prospects stamped (telemetry)

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this.rumours = 0;
  }

  // is `a` a living, non-controlled townsperson of town `tid`? (the census body)
  _civ(a: Ag): boolean {
    return a && a.alive && a.autonomous && !a.combatant && a.townsperson &&
      a.faction === 'townsfolk' && a.townId != null;
  }

  // fixed-tick entry (self-throttled). Never throws.
  tick(_ctx: Ctx, dt: number): void {
    try {
      this._acc += dt;
      if (this._acc < MIGRATE.tickEvery) return;
      this._acc = 0;
      if (!MIGRATE.enabled) return;
      const towns = this.sim.towns;
      if (!towns || towns.length < 2) return;          // one town has nowhere to send anyone

      // CENSUS: living townsfolk per town (truth-side aggregate; bounded one pass).
      const counts = towns.map(() => 0);
      for (const a of this.sim.agents) {
        if (this._civ(a) && a.townId < counts.length) counts[a.townId]++;
      }
      const total = counts.reduce((s: number, x: number) => s + x, 0);
      if (!total) return;
      const mean = total / towns.length;

      // the CROWDED town (max, at/above mean×crowdRatio) and the SPARSE one (min,
      // at/below mean×sparseRatio) — and a real head-gap between them (anti-flutter).
      let hi = 0, lo = 0;
      for (let t = 1; t < towns.length; t++) {
        if (counts[t] > counts[hi]) hi = t;
        if (counts[t] < counts[lo]) lo = t;
      }
      if (hi === lo) return;
      if (counts[hi] < mean * (MIGRATE.crowdRatio || 1.2)) return;
      if (counts[lo] > mean * (MIGRATE.sparseRatio || 0.85)) return;
      if (counts[hi] - counts[lo] < (MIGRATE.minGap || 6)) return;

      // RUMOUR: word reaches a few ears in the crowded town — an Inform into each
      // agent's own `_prospects` mailbox; the agent decides for itself (or doesn't).
      const dest = towns[lo];
      const now = this.sim.time;
      let stamped = 0;
      for (const a of this.sim.agents) {
        if (stamped >= (MIGRATE.rumoursPerPass || 2)) break;
        if (!this._civ(a) || a.townId !== hi) continue;
        if (rng() > (MIGRATE.rumourChance || 0.3)) continue;   // the word reaches SOME ears, not all
        const box = (a._prospects ||= []);
        if (box.some((p: { townId: number }) => p && p.townId === dest.id)) continue;  // already heard it
        box.push({ townId: dest.id, name: dest.name, x: dest.center.x, z: dest.center.z, t: now });
        while (box.length > (MIGRATE.prospectCap || 2)) box.shift();
        stamped++; this.rumours++;
      }
    } catch { /* never stall the fixed tick (the freeze lesson) */ }
  }
}
