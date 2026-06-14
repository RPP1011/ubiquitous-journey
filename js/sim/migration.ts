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
import { MIGRATE, BASE_PRICE } from './simconfig.js';

const BASE_PRICE_T = BASE_PRICE as Record<string, number>;

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

  // The destination town's REPORTED staple prices, read from the Gazette's recent
  // market briefs (the omniscient observer layer narrating world prices — the SAME
  // intel the arbitrage layer reads; not a roster-belief read). Returns a good→median
  // map for the destination; empty when there's no paper or no fresh market story.
  // Guarded — a stale/absent gazette just yields base-price fallbacks in migrate.ts.
  _destPrices(townId: number): Record<string, number> {
    const out: Record<string, number> = {};
    try {
      const arts = (this.sim.gazette && this.sim.gazette.recent) ? this.sim.gazette.recent(30) : [];
      for (const art of arts) {
        const b = art && art.brief;
        if (!b || b.kind !== 'market' || b.originTown !== townId || b.good == null) continue;
        if (out[b.good] == null && b.med != null) out[b.good] = b.med;   // freshest wins (recent() is newest-first)
      }
    } catch { /* no paper → base-price fallback */ }
    return out;
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
      // COMPARATIVE ADVANTAGE: the word also carries what the destination's market
      // REPORTS staple prices at (the same Gazette intel the arbitrage layer reads) —
      // so a migrant can weigh "does MY trade pay better there?" (migrate.ts), not just
      // "is it emptier?". A per-good reported-price picture for the destination town,
      // read once per pass. Missing/made goods fall back to base price in migrate.ts.
      const destPrices = this._destPrices(dest.id);
      let stamped = 0;
      for (const a of this.sim.agents) {
        if (stamped >= (MIGRATE.rumoursPerPass || 2)) break;
        if (!this._civ(a) || a.townId !== hi) continue;
        if (rng() > (MIGRATE.rumourChance || 0.3)) continue;   // the word reaches SOME ears, not all
        const box = (a._prospects ||= []);
        if (box.some((p: { townId: number }) => p && p.townId === dest.id)) continue;  // already heard it
        // stamp the destination's REPORTED price for THIS ear's own trade (the figure it
        // will weigh its believed margin on). A staple with no fresh report, or a made
        // good (gazette prices staples only), falls back to base — never an own-belief read.
        const trade = a._trade;
        const price = (trade != null && destPrices[trade] != null)
          ? destPrices[trade] : (trade != null ? (BASE_PRICE_T[trade] || 0) : 0);
        box.push({ townId: dest.id, name: dest.name, x: dest.center.x, z: dest.center.z, t: now, good: trade, price });
        while (box.length > (MIGRATE.prospectCap || 2)) box.shift();
        stamped++; this.rumours++;
      }
    } catch { /* never stall the fixed tick (the freeze lesson) */ }
  }
}
