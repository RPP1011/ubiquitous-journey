// FEATURE: the recruiter (docs/architecture/10 + 10-lld §12 — the capstone, both ends). Registers
// the `recruit` verb (approach a candidate and make an OFFER it perceives), a muster-goal deriver
// (a bold would-be leader facing a believed-too-strong foe forms a goalMuster), and the FOLLOWER
// side as an ORDINARY belief update (the candidate, perceiving an offer, warms toward the leader
// through its OWN belief — never a foreign-mind write). All from THIS file as DATA rows.
// ALWAYS-LIVE on the mainline (both ends).
//
// The architecturally load-bearing claim is that NO side writes the other's mind: `recruit` is an
// Inform — it makes an offer the candidate PERCEIVES (its `_offers`) + records the leader's own
// one-level prediction (recordBelieves: "I believe this candidate will follow", at compliance
// confidence). The candidate then decides for itself. NPC war-party FORMATION/FOLLOWING (turning a
// warmed candidate into a marching ally) reuses the SAME band machinery the player's Party uses
// (the WARBAND follow-through); the belief half proves the no-foreign-write boundary.

import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
import { goalMuster, goalAssault, recordBelieves, complianceOf, stepTargetPos } from '../planner.js';
import { RECRUIT, WARBAND, SIM } from '../simconfig.js';
import { steer } from '../agent/steer.js';
import type { Agent, CognitionCtx, PlanStep, EntityId } from '../../../types/sim.js';

const REACH = 2.2;

// BELIEVED-MOTIVE COMPLIANCE (doc 18 §collapse-gap; item 1). The candidate's attributed motive about
// the OFFERER colours its join bar on top of standing: a confident hostile read (thief/aggressor/
// slanderer) makes it warier (a higher bar), a confident benign read (defender/justice/voucher) an
// easier sell (a lower bar). Reads ONLY the candidate's own belief about the offerer; never throws.
const HOSTILE_MOTIVES: Record<string, true> = { theft: true, robbery: true, aggression: true, avenge: true, slander: true };
const BENIGN_MOTIVES: Record<string, true> = { defense: true, justice: true, vouch: true, warn: true };
function motiveTrust(b: { believedMotive?: string; motiveConf?: number } | null | undefined): -1 | 0 | 1 {
  if (!b || !b.believedMotive) return 0;
  if ((b.motiveConf || 0) < (RECRUIT.motiveTrustConf || 0.45)) return 0;
  if (HOSTILE_MOTIVES[b.believedMotive]) return -1;
  if (BENIGN_MOTIVES[b.believedMotive]) return 1;
  return 0;
}

// RECURSIVE ToM (one level deeper than the `follow` prediction): does the LEADER believe THE
// CANDIDATE also fears the foe? The leader cannot read the candidate's mind — but it CAN reason over
// two of its OWN beliefs: where it believes the candidate stands, and where it believes a hostile
// foe is. If it believes the candidate has been close to a believed-hostile foe, it infers the
// candidate has likely SEEN and JUDGED that foe a threat too — a shared grievance, an easier sell.
// This is the leader's model of the candidate's belief ("I believe you believe the foe hostile"),
// grounded entirely in the leader's own epistemic scope. Returns 0..1 (how confidently shared).
function sharedFoeFearOf(a: Agent, candId: EntityId): number {
  if (!a.beliefs) return 0;
  const cb = a.beliefs.get(candId);                 // my belief about where the candidate is
  if (!cb || cb.confidence < SIM.actOnBeliefMin) return 0;
  const near2 = (RECRUIT.foeNearRange || 22) * (RECRUIT.foeNearRange || 22);
  let best = 0;
  for (const f of a.beliefs.all()) {                // scan MY beliefs for a foe I think it's near
    if (!f || f.subjectId === candId || f.confidence < SIM.actOnBeliefMin) continue;
    if (!(f.hostile || (a.considerHostile && a.considerHostile(f)))) continue;   // I believe it hostile
    const dx = f.lastPos.x - cb.lastPos.x, dz = f.lastPos.z - cb.lastPos.z;
    if (dx * dx + dz * dz > near2) continue;          // candidate not believed near this foe
    // confidence in the SHARED read = min of how sure I am of each of the two beliefs.
    const conf = Math.min(cb.confidence, f.confidence);
    if (conf > best) best = conf;
  }
  return best;
}

// recruit(candidate): approach; on reach, make the OFFER the candidate perceives AND record the
// leader's OWN one-level prediction that the candidate will follow (compliance off its standing).
registerExecutor('recruit', (a, step, dt, ctx) => {
  const candId = (step.bind || {}).target;
  if (candId == null) { a.fighter.setMoving(0); return; }
  const tp = stepTargetPos(a, ctx, { subjectId: candId });
  if (!tp) { a.fighter.setMoving(0); return; }
  if (a.pos.distanceTo(tp) > REACH) { steer(a, { attractors: [{ pos: tp }] }, dt); return; }
  a.fighter.setMoving(0);
  // RECURSIVE ToM: a candidate the leader believes ALSO fears the foe is an easier sell — the leader
  // both firms its one-level follow-prediction and tilts the offer richer for it. Own-scope (its two
  // beliefs about candidate + foe); never a roster read. 0 when no believed-shared-foe (ordinary recruit).
  const shared = sharedFoeFearOf(a, candId);
  // the leader's PREDICTION (one-level Believes): how likely THIS candidate is to follow, read off
  // the cue it can see (the candidate's believed standing toward it), FIRMED when it also fears the
  // foe. Calibrated, not a dice-roll.
  const b = a.beliefs ? a.beliefs.get(candId) : null;
  const follow = complianceOf(b ? b.standing : 0) + shared * (RECRUIT.sharedFoeFollow || 0);
  recordBelieves(a, candId, 'follow', follow);
  // make the OFFER the candidate perceives (its own store) — the Inform, nothing more. INFAMY DRAWS A
  // FOLLOWING (docs/architecture/12 §9.3): a notorious leader makes a MORE COMPELLING offer — the
  // payoff is tilted by the leader's own notoriety (own-state; the town reads it via the generalised
  // notoriety bridge, so a warming candidate weighs a richer believed payoff). Infamy literally recruits.
  // A SHARED FOE tilts it richer still: the easier sell gets the more compelling pitch.
  const noto = (a as Agent & { notoriety?: number }).notoriety || 0;
  const payoff = RECRUIT.candidateStrength
    * (1 + noto * (RECRUIT.notorietyTilt || 0))
    * (1 + shared * (RECRUIT.sharedFoeTilt || 0));
  if (ctx.resolver && ctx.resolver.makeOffer) ctx.resolver.makeOffer(a, candId, payoff);
});

registerEffectHolds('recruit', () => true);   // the offer landed; composeForce credited it in planning

// THE FOLLOWER SIDE (ordinary belief update; own-state only): a candidate that has perceived an
// offer warms toward the offerer through ITS OWN belief — the offer shifted what it believes, no
// foreign goal was written into it. Its later decide() then weighs joining for itself.
registerDeriver((a: Agent, _ctx: CognitionCtx | null) => {
  if (!a || !a._offers || !a.beliefs) return;
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
// to join. ALWAYS-LIVE on the mainline. Heavily guarded; bounded by the offer loop. Already-banded
// / unfit agents short-circuit.
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!a || !a._offers || !a.beliefs) return;
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
    // BELIEVED-MOTIVE COMPLIANCE (item 1): my own attributed motive about THIS offerer shifts the
    // bar — warier of a confident brigand (bar up), an easier sell for a confident defender (bar down).
    const mt = motiveTrust(rel);
    const effBar = bar + (mt < 0 ? (WARBAND.motiveDistrustBar || 0) : mt > 0 ? -(WARBAND.motiveTrustBar || 0) : 0);
    if (standing < effBar) continue;                                             // not yet won over
    if (standing > bestStanding) { bestStanding = standing; bestId = off.from; } // join the dearest offerer
  }
  if (bestId == null) return;
  // decided: ask to join the offerer's band (execution flips the shared band flags). On success the
  // offer is spent; on failure (band full / leader gone) we leave it to re-weigh next tick.
  if (ctx.resolver.joinBand(a, bestId, WARBAND.maxFollowers || 6) && a._offers) delete a._offers[bestId];
});

// DEFECTION / MUTINY (the mirror of the join — a warband fracturing FROM WITHIN): a follower whose
// OWN belief of its leader has SOURED decides, for itself, to mutiny. This is cognition — it reads
// ONLY the follower's own belief-standing toward its leader and its own episodic memory (a recently
// witnessed band-mate death it lays at the leader's feet), never the roster / ground truth (the
// epistemic split holds). A grievance first ERODES the leader's standing (its own belief shifts);
// once that standing falls past the bar the follower re-plants a low standing on the former leader
// (the visible fracture) and sets `_quitBand` — the EXECUTION-side revert (Groups._prune, the shared
// band machinery) leaves the band cleanly and propagates the fracture to its ex-mates' perception.
// No foreign-mind write, no Director fiat. Heavily guarded; bounded + rare (gated on a real souring).
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!a || !a.alive || a.controlled || !a.beliefs) return;
  const leaderId = a.bandLeaderId;
  if (leaderId == null) return;                                  // not a follower — nothing to defect from
  if (a.inParty && ctx && ctx.playerId != null && leaderId === ctx.playerId) return;  // never mutiny the player's party
  if (a._quitBand != null) return;                               // already decided this tick (await the prune)
  const rel = a.beliefs.get(leaderId);                           // MY belief about my leader (the only cue)
  if (!rel) return;
  // A FRESH GRIEVANCE: a band-mate I held in regard fell within living memory — a death I lay at the
  // leader's feet. Read ONLY my own episodic memory (witnessed_death of someone I liked); it erodes
  // the leader's standing in MY belief first (the souring), so the bar below is reached honestly.
  const now = ctx ? ctx.time : 0;
  let grieved = false;
  try {
    const eps = a.memory ? a.memory.recent(8) : [];
    for (const ep of eps) {
      if (!ep || ep.kind !== 'witnessed_death' || ep.withId == null) continue;
      if (now - (ep.t || 0) > (WARBAND.defectGriefSecs || 25)) continue;        // not fresh enough
      const fr = a.beliefs.get(ep.withId);                                       // did I regard the fallen?
      if (fr && (fr.standing || 0) > 0.2) { grieved = true; break; }
    }
  } catch { /* never throw on the tick */ }
  if (grieved) rel.standing = Math.max(-1, (rel.standing || 0) - (WARBAND.defectGrief || 0.35));
  // the mutiny gate: my own belief of the leader has soured past the bar (from the grievance above,
  // a gossiped snub, a forsworn-leader standing hit, or combat feedback — all ordinary belief shifts).
  if ((rel.standing || 0) > (WARBAND.defectStanding || -0.25)) return;
  // DECIDED: re-plant a low standing on the former leader (the fracture is in MY belief), and set the
  // own-state flag the execution-side revert honours. The flag-flip is execution; the choice was mine.
  rel.standing = Math.min(rel.standing, (WARBAND.defectSour || -0.5));
  a._quitBand = leaderId;
});

// THE LEADER SIDE (belief-only deriver, the recruiter capstone, BOTH halves): a bold agent that
// believes a foe too strong to face alone first MUSTERS a force (recruits, via composeForce →
// makeOffer); once it actually leads a band strong enough to outmatch the threat, it turns the band
// ONTO the foe — `goalAssault`, the missing march-on-the-foe half. Belief-only target; the band
// converges via decideParty. Conservative gate (bold + a confidently-believed strong hostile);
// dormant for the timid and for followers (only a would-be / standing leader musters).
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!a || a.controlled || !a.canWork || a.faction === 'monster' || !a.beliefs) return;
  if (a.inParty || a.bandLeaderId != null) return;                   // a follower doesn't raise its own band
  // IDEMPOTENT (life-trace finding): once this leader is already MARCHING (holds a goalAssault), the
  // deriver MUST no-op — otherwise it re-files the march round on the warband arc EVERY cognition
  // tick, churning ~1000 spurious rounds over a soak. One muster → one march → one resolution. (Mustering
  // — a live goalMuster — still re-runs each tick to upgrade to the march; openArc is idempotent then.)
  if (Array.isArray(a.goals) && a.goals.some((g) => g.kind === 'assault')) return;
  const bold = a.personality ? (a.personality.risk_tolerance || 0) : 0;
  if (bold < (RECRUIT.musterRiskTol || 0.6)) return;                 // only the bold try to raise a force
  let foe = null;
  for (const b of a.beliefs.all()) {
    if (!b || b.confidence < SIM.actOnBeliefMin) continue;
    if (!(b.hostile || (a.considerHostile && a.considerHostile(b)))) continue;
    foe = b; break;
  }
  if (!foe) return;
  const now = ctx ? ctx.time : 0;
  const target = Math.max(2, (RECRUIT.selfStrength || 1) + 2);       // believed strength to outmatch the threat
  // the leader's OWN believed band strength (execution-mediated; the deriver never scans the roster).
  const bandStr = (ctx && ctx.resolver && ctx.resolver.warbandStrength) ? ctx.resolver.warbandStrength(a) : (RECRUIT.selfStrength || 1);
  // WARBAND ARC (docs/architecture/12 §3.5): a muster is a tracked arc — but opened LAZILY on its
  // FIRST real escalation (a follower riding to the banner in joinWarband, OR the march below), never
  // eagerly at muster. An open-and-immediately-closed 0-round arc is NOISE, not a tale (the muster-
  // flicker fix): a band that lapses/routs before any escalation files no arc at all. Write-only.
  const arcOpts = { kind: 'warband', key: 'warband:' + a.id, principals: [a.id] };
  if (bandStr >= target) {
    // MUSTERED enough — march the band on the believed foe; followers converge (decideParty).
    const g = goalAssault(foe.subjectId);
    g.priority = 0.7; g.from = 'warleader'; g.expiresAt = now + 120;
    a.pushGoal(g, ctx);
    // the march IS the escalation — lazily open the arc on this round, but DON'T close it: a
    // march is the story's beginning, not its outcome. The arc resolves where the battle does —
    // 'victorious' when the leader's assault pops on a genuine kill (pruneGoals), 'routed' when
    // the leader falls (the combat bridge), or 'lapsed' by the TTL sweep when the campaign
    // peters out. The win/loss PLAN_OUTCOME ([11] §8 synergy 2) fires at those resolutions too,
    // never at the commitment (marching is not yet a windfall).
    if (ctx && ctx.arcs) ctx.arcs.appendArcRound(arcOpts, `${a.name} marched their war-band on the foe.`);
  } else {
    // still too weak alone — raise the force first.
    const g = goalMuster(target);
    g.priority = 0.5; g.from = 'muster'; g.expiresAt = now + 120;
    a.pushGoal(g, ctx);
  }
});

export {};
