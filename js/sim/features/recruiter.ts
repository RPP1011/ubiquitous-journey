// FEATURE: the recruiter (docs/architecture/10 + 10-lld §12 — the capstone, both ends). Registers
// the `recruit` verb (approach a candidate and make an OFFER it perceives), a muster-goal deriver
// (a bold would-be leader facing a believed-too-strong foe forms a goalMuster), and the FOLLOWER
// side as an ORDINARY belief update (the candidate, perceiving an offer, warms toward the leader
// through its OWN belief — never a foreign-mind write). All from THIS file as DATA rows. Gated by
// RECRUIT.enabled; off → nothing live, soak byte-stable.
//
// The architecturally load-bearing claim is that NO side writes the other's mind: `recruit` is an
// Inform — it makes an offer the candidate PERCEIVES (its `_offers`) + records the leader's own
// one-level prediction (recordBelieves: "I believe this candidate will follow", at compliance
// confidence). The candidate then decides for itself. NPC war-party FORMATION/FOLLOWING (turning a
// warmed candidate into a marching ally) reuses no existing mechanic and is the remaining gap
// (10-lld §19); the belief half — the part that proves the no-foreign-write boundary — is here.

import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
import { goalMuster, recordBelieves, complianceOf, stepTargetPos } from '../planner.js';
import { RECRUIT, SIM } from '../simconfig.js';
import { steer } from '../agent/steer.js';
import type { Agent, CognitionCtx, PlanStep } from '../../../types/sim.js';

const REACH = 2.2;

// recruit(candidate): approach; on reach, make the OFFER the candidate perceives AND record the
// leader's OWN one-level prediction that the candidate will follow (compliance off its standing).
registerExecutor('recruit', (a, step, dt, ctx) => {
  if (!RECRUIT.enabled) { a.fighter.setMoving(0); return; }
  const candId = (step.bind || {}).target;
  if (candId == null) { a.fighter.setMoving(0); return; }
  const tp = stepTargetPos(a, ctx, { subjectId: candId });
  if (!tp) { a.fighter.setMoving(0); return; }
  if (a.pos.distanceTo(tp) > REACH) { steer(a, { attractors: [{ pos: tp }] }, dt); return; }
  a.fighter.setMoving(0);
  // the leader's PREDICTION (one-level Believes): how likely THIS candidate is to follow, read off
  // the cue it can see (the candidate's believed standing toward it). Calibrated, not a dice-roll.
  const b = a.beliefs ? a.beliefs.get(candId) : null;
  recordBelieves(a, candId, 'follow', complianceOf(b ? b.standing : 0));
  // make the OFFER the candidate perceives (its own store) — the Inform, nothing more.
  if (ctx.resolver && ctx.resolver.makeOffer) ctx.resolver.makeOffer(a, candId, RECRUIT.candidateStrength);
});

registerEffectHolds('recruit', () => true);   // the offer landed; composeForce credited it in planning

// THE FOLLOWER SIDE (ordinary belief update; own-state only): a candidate that has perceived an
// offer warms toward the offerer through ITS OWN belief — the offer shifted what it believes, no
// foreign goal was written into it. Its later decide() then weighs joining for itself.
registerDeriver((a: Agent, _ctx: CognitionCtx | null) => {
  if (!RECRUIT.enabled || !a || !a._offers || !a.beliefs) return;
  for (const k in a._offers) {
    const off = a._offers[k];
    if (!off) continue;
    const rel = a.beliefs.get(off.from);
    if (rel) rel.standing = Math.min(1, (rel.standing || 0) + (RECRUIT.offerWarmth || 0.08));
  }
});

// THE LEADER SIDE (belief-only): a bold agent that believes a foe too strong to face alone forms a
// muster goal to out-number it. Conservative gate (bold + a confidently-believed strong hostile);
// dormant for the timid. goalMuster's target is the believed strength to outmatch.
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!RECRUIT.enabled) return;
  if (!a || a.controlled || !a.canWork || a.faction === 'monster' || !a.beliefs) return;
  const bold = a.personality ? (a.personality.risk_tolerance || 0) : 0;
  if (bold < (RECRUIT.musterRiskTol || 0.6)) return;                 // only the bold try to raise a force
  let foe = null;
  for (const b of a.beliefs.all()) {
    if (!b || b.confidence < SIM.actOnBeliefMin) continue;
    if (!(b.hostile || (a.considerHostile && a.considerHostile(b)))) continue;
    foe = b; break;
  }
  if (!foe) return;
  const g = goalMuster(Math.max(2, (RECRUIT.selfStrength || 1) + 2));   // outmatch the believed threat
  g.priority = 0.5; g.from = 'muster';
  g.expiresAt = (ctx ? ctx.time : 0) + 120;
  a.pushGoal(g, ctx);
});

export {};
