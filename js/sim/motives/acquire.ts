// INFERENCE MOTIVES for the `take` primitive (docs/architecture/17 §7) — how a witness READS a
// theft-shaped acquisition: as plain theft, as a robbery, or (the Robin-Hood mirror) as rough JUSTICE
// when a poor, bold soul sees the believed-rich relieved of their gold. These are INFERENCE rows: they
// carry prior() + reads.likelihood (the observer half); their actor-half (eligible/score/bind) is inert
// (selection is the arbitrate ROW table, not these). Registered as data — one file, disjoint.
//
// The prior/likelihood reproduce-and-generalize the hardcoded witnessDeed reaction: a robbery normally
// reads as a wrong, but a larcenous pauper who believes the victim wealthy reads it as justice — the
// same conjunction the OUTLAW branch hand-codes, now as an inferred motive (so it can be deceived).

import { registerMotive } from '../motivation/registry.js';
import type { Agent, Deed, EntityId } from '../../../types/sim.js';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const inert = { eligible: () => false, score: () => 0, bind: () => ({}) };

// a believed-poorer, harsher actor primes a "theft" reading (character prior, observer's own belief).
function larcenyPrior(o: Agent, actorId: EntityId): number {
  const b = o.beliefs.get(actorId);
  const poor = b ? clamp01(1 - (b.believedWealth || 0)) : 0.5;
  const unkind = b && b.believedKindness != null ? clamp01(1 - b.believedKindness) : 0.5;
  return clamp01(0.3 + 0.3 * poor + 0.2 * unkind);
}

registerMotive({
  key: 'theft', primitive: 'take', serves: 'goal', basePrior: 0.4, ...inert,
  prior: (o, actorId) => larcenyPrior(o, actorId),
  reads: { tag: 'theft', likelihood: (deed) => (deed.surfaceTag === 'theft' ? 0.9 : 0.2) },
});

registerMotive({
  key: 'robbery', primitive: 'take', serves: 'goal', basePrior: 0.4, ...inert,
  prior: (o, actorId) => larcenyPrior(o, actorId),
  reads: { tag: 'robbery', likelihood: (deed) => (deed.surfaceTag === 'robbery' ? 0.9 : 0.15) },
});

registerMotive({
  key: 'justice', primitive: 'take', serves: 'goal', basePrior: 0.05, ...inert,
  // THE ROBIN-HOOD MIRROR: only a bold, poor, uncaring witness who BELIEVES the victim rich reads a
  // robbery as justice. The same four conjuncts the OUTLAW.warm* branch hand-codes — now a prior.
  prior: (o: Agent, _actorId, deed: Deed) => {
    const P = (o.personality || {}) as { risk_tolerance?: number; altruism?: number };
    const bold = (P.risk_tolerance || 0) >= 0.5;
    const poor = (o.gold || 0) <= 10;
    const uncaring = (P.altruism ?? 0.5) <= 0.4;
    if (!(bold && poor && uncaring)) return 0.02;
    const vb = deed.targetId != null ? o.beliefs.get(deed.targetId) : null;
    const victimRich = vb ? (vb.believedWealth || 0) * (vb.wealthConf || 0) : 0;
    return clamp01(0.25 + 0.6 * victimRich);
  },
  reads: { tag: 'justice', likelihood: (deed) => (deed.surfaceTag === 'robbery' ? 0.8 : 0.1) },
});
