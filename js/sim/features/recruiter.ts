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
import { RECRUIT, WARBAND, SIM } from '../simconfig.js';
import { steer } from '../agent/steer.js';
import type { Agent, CognitionCtx, PlanStep, EntityId } from '../../../types/sim.js';

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

// THE FOLLOW-THROUGH (WARBAND, docs/architecture/10-lld §19 item 4 — the recruiter capstone's
// missing half): a warmed candidate forms its OWN decision to MARCH with the offerer. This is
// cognition — it reads ONLY the agent's own _offers, its own belief-standing toward the offerer,
// and its own personality (never the roster / ground truth — the epistemic split holds). When the
// candidate decides yes, the flag flip is EXECUTION: it requests the join through ctx.resolver
// .joinBand, which reuses the SAME band machinery (Groups._join) the player's Party uses. No
// foreign-mind write: the OFFER (an Inform) warmed it; the candidate weighed it and chose to ask
// to join. Gated by WARBAND.enabled — off ⇒ no NPC ever forms a recruited band (soak byte-stable).
// Heavily guarded; bounded by the offer loop. Already-banded / unfit agents short-circuit.
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!WARBAND.enabled || !a || !a._offers || !a.beliefs) return;
  if (!a.alive || a.controlled || a.inParty || a.bandLeaderId != null) return;   // not already banded
  if (a.faction === 'monster' || !a.autonomous) return;
  if (!ctx || !ctx.resolver || !ctx.resolver.joinBand) return;                   // need the exec seam
  const now = ctx.time || 0;
  const ttl = WARBAND.offerTtl || 30;
  // the candidate's appetite: a bold soul accepts a thinner offer (the bar is damped by its risk
  // tolerance), a cautious one wants to be more sure of the leader before marching. Own-state only.
  const risk = a.personality ? (a.personality.risk_tolerance || 0) : 0;
  const bar = (WARBAND.joinStanding || 0.35) * (1 - (WARBAND.joinRiskTol || 0.45) * risk);
  let bestId: EntityId | null = null, bestStanding = -Infinity;
  for (const k in a._offers) {
    const off = a._offers[k];
    if (!off) continue;
    if (now - (off.t || 0) > ttl) { delete a._offers[k]; continue; }             // stale offer lapses
    if ((off.payoff || 0) < (WARBAND.minPayoff || 0)) continue;                  // too thin to weigh
    const rel = a.beliefs.get(off.from);                                         // MY belief about the offerer
    const standing = rel ? (rel.standing || 0) : 0;
    if (standing < bar) continue;                                                // not yet won over
    if (standing > bestStanding) { bestStanding = standing; bestId = off.from; } // join the dearest offerer
  }
  if (bestId == null) return;
  // decided: ask to join the offerer's band (execution flips the shared band flags). On success the
  // offer is spent; on failure (band full / leader gone) we leave it to re-weigh next tick.
  if (ctx.resolver.joinBand(a, bestId, WARBAND.maxFollowers || 6) && a._offers) delete a._offers[bestId];
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
