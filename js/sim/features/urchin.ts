// FEATURE: the urchin heist (docs/architecture/10 + 10-lld §13 — the flagship). Registers this
// feature's verbs (surveil / approach / burgle), its goal-deriver (a poor, larcenous agent forms a
// steal goal against a believed-prosperous mark), and its effect-landed predicates — ALL from THIS
// file, as DATA rows into the registries (verbs-are-data), so it stays disjoint from every other
// feature. Gated by URCHIN.enabled; off → registers nothing live and the soak is byte-stable.
//
// The mechanic is GENERIC + conserved (resolver.take moves gold, never mints); the social
// consequence (the mark + any witness souring) EMERGES from perception (resolver.witnessDeed,
// per-perceiver, witness-gated), never a baked reaction on one designated victim. The mark + the
// believed haul are picked from CUES on the agent's own beliefs, never the roster.

import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
import { goalSteal, stepTargetPos } from '../planner.js';
import { URCHIN, SIM } from '../simconfig.js';
import { steer } from '../agent/steer.js';
import { goTo } from '../agent/movement.js';
import type { Agent, CognitionCtx, PlanStep } from '../../../types/sim.js';

const REACH = 2.2;

// surveil(mark): the epistemic GATHER. Hold at a stand-off OUTSIDE the mark's modelled sight and
// watch; each `surveilDwell` seconds of holding accrues one sighting toward a believed `assoc`
// (the stash), consolidating after URCHIN.consolidateAfter. Belief-only target (lastPos); a lost
// mark idles (the goal re-plans / expires). The stash is modelled at where the mark is seen to keep
// returning — its believed position — which is exactly the urchin's fallible read.
registerExecutor('surveil', (a, step, dt, _ctx) => {
  if (!URCHIN.enabled) { a.fighter.setMoving(0); return; }
  const markId = (step.bind || {}).target;
  if (markId == null || !a.beliefs) { a.fighter.setMoving(0); return; }
  const b = a.beliefs.get(markId);
  if (!b || b.confidence <= 0) { a.fighter.setMoving(0); return; }   // lost the mark
  const standoff = URCHIN.standoffRange || 14;
  if (a.pos.distanceTo(b.lastPos) > standoff) {
    steer(a, { attractors: [{ pos: b.lastPos }] }, dt);             // close to the stand-off ring
    return;
  }
  a.fighter.setMoving(0);                                            // within the gap: hold and watch
  a._surveilAccum = (a._surveilAccum || 0) + dt;
  if (a._surveilAccum >= (URCHIN.surveilDwell || 4.5)) {
    a._surveilAccum = 0;
    b.recordAssocSighting('stash', b.lastPos, URCHIN.sightGain, URCHIN.consolidateAfter);
  }
});

// approach(stash): steer to the believed stash position (the assoc place). Reached via the planner's
// `approach` primitive, whose precondition (know_assoc) guarantees the assoc exists by here.
registerExecutor('approach', (a, step, dt, ctx) => {
  if (!URCHIN.enabled) { a.fighter.setMoving(0); return; }
  const tp = stepTargetPos(a, ctx, (step.bind || {}).place);
  if (tp) steer(a, { attractors: [{ pos: tp }] }, dt); else a.fighter.setMoving(0);
});

// burgle(mark): the take. Walk to the believed stash; on arrival, MOVE gold from the mark's purse
// (conserved — resolver.take debits the source as it credits the urchin), then let the consequence
// EMERGE — resolver.witnessDeed folds the theft into the mark's + any witness's OWN beliefs,
// witness-gated. NO hardcoded reaction. The believed haul is the goal's gold target (bind.amt).
registerExecutor('burgle', (a, step, dt, ctx) => {
  if (!URCHIN.enabled) { a.fighter.setMoving(0); return; }
  const b = step.bind || {};
  const markId = b.target;
  if (markId == null || !ctx.resolver) { a.fighter.setMoving(0); return; }
  const tp = stepTargetPos(a, ctx, b.place);                         // the believed stash pos
  if (tp && a.pos.distanceTo(tp) > REACH) { steer(a, { attractors: [{ pos: tp }] }, dt); return; }
  a.fighter.setMoving(0);
  const took = ctx.resolver.take(a, markId, { gold: b.amt || 0 });   // conserved; never mints
  if (took > 0) ctx.resolver.witnessDeed(a, markId, 'theft', 0.45);  // the souring EMERGES, per-perceiver
});

// effect-landed predicates (advance the multi-step plan from THIS file). NOTE: effect-holds is
// keyed by the PRIMITIVE name (step.prim), not the exec verb — so the surveil step registers under
// its prim 'shadow' (whose exec verb is 'surveil'); approach/burgle prim==verb.
registerEffectHolds('shadow', (a, _ctx, step) => {
  const markId = (step.bind || {}).target;
  const b = markId != null && a.beliefs ? a.beliefs.get(markId) : null;
  return !!(b && b.assoc);                                           // the stash is now believed-located
});
registerEffectHolds('approach', (a, ctx, step) => {
  const tp = stepTargetPos(a, ctx, (step.bind || {}).place);
  return !!(tp && a.pos.distanceTo(tp) <= (SIM.arriveDist || 1.5) + 0.5);
});
registerEffectHolds('burgle', () => true);                          // one-shot take; goal predicate (gold_ge) guards the loop

// THE LIVE DERIVER (belief/own-state only — the epistemic split). A poor + larcenous townsperson
// forms a steal goal against the believed-most-established (≈ prosperous) non-hostile local it
// knows. The greed gate is the disposition lever the design names: poverty is circumstance,
// character is the choice — so only the larcenous reach for it. Bounded: pushGoal dedups by kind.
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!URCHIN.enabled) return;
  if (!a || !a.alive || a.controlled || a.faction === 'monster') return;
  if ((a.gold || 0) >= URCHIN.deriveBelowGold) return;               // only the poor consider it (circumstance)
  // DISPOSITION GATE: larcenous == uncaring (low altruism) AND bold (high risk_tolerance). The
  // scrupulous beg/work/go without even when broke and able — character is the choice, not poverty.
  const p = a.personality || {};
  if ((p.altruism ?? 1) > URCHIN.deriveAltruismMax) return;
  if ((p.risk_tolerance ?? 0) < URCHIN.deriveRiskMin) return;
  if (!a.beliefs) return;
  let markId: number | string | null = null, best = 0;
  for (const b of a.beliefs.all()) {
    if (!b || b.subjectId === a.id) continue;
    if (b.confidence < SIM.actOnBeliefMin) continue;
    if (b.hostile || (a.considerHostile && a.considerHostile(b))) continue;   // foes are a combat matter
    const cue = b.confidence;                                        // established-in-mind ≈ a settled local
    if (cue > best) { best = cue; markId = b.subjectId; }
  }
  if (markId == null) return;
  const g = goalSteal(markId, URCHIN.deriveTarget);
  g.priority = 0.5; g.from = 'larceny';
  g.expiresAt = (ctx ? ctx.time : 0) + (URCHIN.deriveExpiry || 110);
  a.pushGoal(g, ctx);
});

export {};
