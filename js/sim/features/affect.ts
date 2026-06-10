// FEATURE: the Affect rows — rob / free / wreck (docs/architecture/10 + 10-lld §8, §12, §13).
// Registers those verbs and their effect-landed predicates — all from THIS file as DATA rows.
// Gated by ROB.enabled (rob) and AFFECT.enabled (free/wreck); off → nothing live, soak byte-stable.
//
// Reuses the seam's GENERIC resolver mechanics, never a bespoke per-verb function: `take` (the
// conserved value move — debits the mark as it credits the robber, never mints), `witnessDeed` (the
// EMERGENT souring — per-perceiver, witness-gated), `affect` (the physical state change freed/
// wrecked — the change only; the reaction emerges from perception, e.g. a freed captive's _freedBy).
//
// rob's GOAL is supplied by the urchin steal-deriver (goalSteal routes through `rob` when ROB is on
// and `burgle` when URCHIN is on — the planner picks the cheaper). free/wreck have no captivity /
// sabotage-target mechanic in the current sim, so they carry no live deriver yet (gap, 10-lld §19):
// the executors + goals are correct and unit-tested; a breadth step adds the trigger.

import { registerExecutor, registerEffectHolds } from '../exec/registry.js';
import { stepTargetPos } from '../planner.js';
import { steer } from '../agent/steer.js';
import type { Agent, CognitionCtx, PlanStep } from '../../../types/sim.js';
import { ROB, AFFECT } from '../simconfig.js';

const REACH = 2.2;

// Walk to the believed position of `targetId` until within reach; returns true once on station.
function reach(a: Agent, ctx: CognitionCtx, targetId: number | string, dt: number): boolean {
  const tp = stepTargetPos(a, ctx, { subjectId: targetId });
  if (!tp) { a.fighter.setMoving(0); return false; }                 // no belief → don't know where to go
  if (a.pos.distanceTo(tp) > REACH) { steer(a, { attractors: [{ pos: tp }] }, dt); return false; }
  a.fighter.setMoving(0); return true;
}

// rob(mark): take gold off the mark by force. MOVED (conserved); the reaction EMERGES (witnessDeed,
// a heavier social trace than a quiet cache theft — robbery is seen).
registerExecutor('rob', (a, step, dt, ctx) => {
  if (!ROB.enabled || !ctx.resolver) { a.fighter.setMoving(0); return; }
  const b = step.bind || {}; const markId = b.target;
  if (markId == null || !reach(a, ctx, markId, dt)) return;
  const took = ctx.resolver.take(a, markId, { gold: b.amt || ROB.amount || 0 });
  if (took > 0) ctx.resolver.witnessDeed(a, markId, 'robbery', 0.6);
});

// free(captive): cut the bonds. The PHYSICAL change only (resolver.affect) — the captive's
// gratitude EMERGES from it perceiving _freedBy, not a baked response here.
registerExecutor('free', (a, step, dt, ctx) => {
  if (!AFFECT.enabled || !ctx.resolver) { a.fighter.setMoving(0); return; }
  const targetId = (step.bind || {}).target;
  if (targetId == null || !reach(a, ctx, targetId, dt)) return;
  ctx.resolver.affect(a, targetId, 'freed');
});

// wreck(target): sabotage. Physical change only; an owner's anger emerges from perception.
registerExecutor('wreck', (a, step, dt, ctx) => {
  if (!AFFECT.enabled || !ctx.resolver) { a.fighter.setMoving(0); return; }
  const targetId = (step.bind || {}).target;
  if (targetId == null || !reach(a, ctx, targetId, dt)) return;
  if (ctx.resolver.affect(a, targetId, 'wrecked')) ctx.resolver.witnessDeed(a, targetId, 'sabotage', 0.5);
});

// effect-landed: each is a one-shot act on arrival. gold_ge (rob) / the expiry (free/wreck) guard
// the goal's own completion; here we just advance past the act once performed.
registerEffectHolds('rob', () => true);
registerEffectHolds('free', () => true);
registerEffectHolds('wreck', () => true);

export {};
