// FEATURE: the Affect rows — rob / free / wreck (docs/architecture/10 + 10-lld §8, §12, §13).
// Registers those verbs and their effect-landed predicates — all from THIS file as DATA rows.
// ALWAYS-LIVE on the mainline.
//
// Reuses the seam's GENERIC resolver mechanics, never a bespoke per-verb function: `take` (the
// conserved value move — debits the mark as it credits the robber, never mints), `witnessDeed` (the
// EMERGENT souring — per-perceiver, witness-gated), `affect` (the physical state change freed/
// wrecked — the change only; the reaction emerges from perception, e.g. a freed captive's _freedBy).
//
// rob's GOAL is supplied by the urchin steal-deriver (goalSteal routes through `rob` or `burgle` —
// the planner picks the cheaper). `free` carries a LIVE rescue deriver (the captivity trigger);
// `wreck` stays dormant (no enemy-owned structure entity to target — see 10-lld §19 item 3).

import { registerExecutor, registerEffectHolds, registerDeriver } from '../exec/registry.js';
import { stepTargetPos, goalFree, goalAvenge } from '../planner.js';
import { foldDeed } from '../signals.js';
import { steer } from '../agent/steer.js';
import type { Agent, CognitionCtx, PlanStep } from '../../../types/sim.js';
import { ROB, CAPTIVE, SIM } from '../simconfig.js';

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
  if (!ctx.resolver) { a.fighter.setMoving(0); return; }
  const b = step.bind || {}; const markId = b.target;
  if (markId == null || !reach(a, ctx, markId, dt)) return;
  const took = ctx.resolver.take(a, markId, { gold: b.amt || ROB.amount || 0 });
  if (took > 0) ctx.resolver.witnessDeed(a, markId, 'robbery', 0.6);
});

// free(captive): cut the bonds. The PHYSICAL change only (resolver.affect) — the captive's
// gratitude EMERGES from it perceiving _freedBy, not a baked response here.
registerExecutor('free', (a, step, dt, ctx) => {
  if (!ctx.resolver) { a.fighter.setMoving(0); return; }
  const targetId = (step.bind || {}).target;
  if (targetId == null || !reach(a, ctx, targetId, dt)) return;
  if (ctx.resolver.affect(a, targetId, 'freed')) {
    // RESCUE ARC closes 'freed' — the captive is cut loose (docs/architecture/12 §3.5). Write-only.
    if (ctx.arcs) ctx.arcs.closeArc('rescue:' + targetId, 'freed', 'The captive was freed.');
    foldDeed(a, 'rescue', ctx.time);   // §13 E.deedLedger (truth side)
  }
});

// wreck(target): sabotage. Physical change only; an owner's anger emerges from perception.
registerExecutor('wreck', (a, step, dt, ctx) => {
  if (!ctx.resolver) { a.fighter.setMoving(0); return; }
  const targetId = (step.bind || {}).target;
  if (targetId == null || !reach(a, ctx, targetId, dt)) return;
  if (ctx.resolver.affect(a, targetId, 'wrecked')) ctx.resolver.witnessDeed(a, targetId, 'sabotage', 0.5);
});

// effect-landed: each is a one-shot act on arrival. gold_ge (rob) / the expiry (free/wreck) guard
// the goal's own completion; here we just advance past the act once performed.
registerEffectHolds('rob', () => true);
registerEffectHolds('free', () => true);
registerEffectHolds('wreck', () => true);

// ── THE RESCUE DERIVER (cognition; belief + own-personality ONLY) ──────────────────────────────
// An agent that BELIEVES a well-liked other is captive (b.captive, set by perception from a seen
// `_held`) and is DISPOSED to act (bold OR kind — a disposition gate, not everyone) forms a goalFree
// for it. Reads ONLY its own beliefs + personality — never the roster, never `_held`/`_captorId`
// directly (that would be the forbidden truth-read in cognition). The free executor + the goal's
// predicate (popped when the captive is no longer BELIEVED held — perception-confirmed) resolve it.
// ALWAYS-LIVE on the mainline (fires only when a captive belief is actually written).
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!a || a.controlled || a._held || !a.beliefs || !a.personality) return;
  if (a.faction === 'monster') return;                              // beasts don't mount rescues
  const bold = a.personality.risk_tolerance || 0;
  const kind = a.personality.altruism || 0;
  // DISPOSITION GATE: only the bold or the kind attempt a rescue — the timid + uncaring never do.
  if (bold < (CAPTIVE.rescueRiskTol || 0.45) && kind < (CAPTIVE.rescueAltruism || 0.6)) return;
  let bestId: number | string | null = null, bestStanding = CAPTIVE.rescueStanding || 0.3;
  for (const b of a.beliefs.all()) {
    if (!b || !b.captive || b.subjectId === a.id) continue;
    if (b.confidence < SIM.actOnBeliefMin) continue;                // too faint to act on
    if ((b.standing || 0) < bestStanding) continue;                 // only a well-liked captive is worth it
    bestStanding = b.standing || 0; bestId = b.subjectId;           // rescue the dearest believed-captive
  }
  if (bestId == null) return;
  // CLEAR-THE-GUARDS (docs/architecture/12 §7, review 6): if the rescuer BELIEVES a hostile sits
  // beside the believed-captive, fell it FIRST — prepend an avenge-shaped attack subgoal (higher
  // priority than the free step) so the rescue plan becomes goto→(attack the guard)→free. Own-belief
  // only (the captor's believed pos + a believed-hostile), never the roster. The rescue justification
  // INTENTIONALLY relaxes the aggression gate: a strong-enough bond pulls even a timid-but-kind
  // rescuer past its threshold to cut its way in (decided on purpose, not an accident of executor).
  const capB = a.beliefs.get(bestId);
  if (capB) {
    for (const hb of a.beliefs.all()) {
      if (!hb || hb.subjectId === a.id || hb.subjectId === bestId) continue;
      if (!(hb.hostile || (a.considerHostile && a.considerHostile(hb)))) continue;
      if (hb.confidence < SIM.actOnBeliefMin) continue;
      if (hb.lastPos.distanceTo(capB.lastPos) > (CAPTIVE.guardReach || 4)) continue;   // a guard BESIDE the captive
      const ga = goalAvenge(hb.subjectId);
      ga.priority = 0.8; ga.from = 'rescue_guard';                                     // above the free goal (0.7)
      ga.expiresAt = (ctx ? ctx.time : 0) + 120;
      a.pushGoal(ga, ctx);
      break;                                                                           // one guard at a time
    }
  }
  const g = goalFree(bestId);
  // pop the goal when the captive is no longer BELIEVED held (perception-confirmed freed). Belief-
  // only; the planner's base predicate is `false` (an external confirm), so we supply the confirm.
  g.predicate = (self: unknown) => { const s = self as Agent; const rb = s && s.beliefs ? s.beliefs.get(bestId!) : null; return !rb || !rb.captive; };
  g.priority = 0.7; g.from = 'rescue';
  g.expiresAt = (ctx ? ctx.time : 0) + 120;                         // don't chase a moved captive forever
  a.pushGoal(g, ctx);
  // RESCUE ARC (docs/architecture/12 §3.5): keyed on the VICTIM (one rescue arc, many would-be
  // rescuers); whoever frees closes it. Opened at the derive; closed 'freed' in the free executor.
  if (ctx && ctx.arcs) ctx.arcs.openArc({ kind: 'rescue', key: 'rescue:' + bestId, principals: [a.id, bestId] });
});

// ── THE EMERGENT GRATITUDE (the freed captive's own belief warms toward its rescuer) ────────────
// The captive's gratitude is NOT baked into the free executor (which only flips `_held`/`_freedBy`,
// the physical change). It EMERGES here, per-perceiver, on the FREED side: a captive that perceives
// it was freed by X (its own `_freedBy`, set by the resolver) warms toward X through ITS OWN belief
// — the positive mirror of witnessDeed's souring. Done once per freeing (the `_freedAck` de-dup),
// so it's a one-off warmth, not a per-tick ramp. Own-state only; ALWAYS-LIVE on the mainline.
registerDeriver((a: Agent, _ctx: CognitionCtx | null) => {
  if (!a || a._freedBy == null || a._freedAck === a._freedBy) return;
  if (a.beliefs) {
    const rb = a.beliefs.get(a._freedBy);   // perception built this when the rescuer approached to free me
    if (rb) {
      rb.standing = Math.min(1, (rb.standing || 0) + (CAPTIVE.gratitudeWarmth || 0.5));
      a._freedAck = a._freedBy;             // gratitude felt — don't re-apply it every tick
    }
  }
});

export {};
