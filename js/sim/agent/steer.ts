// THE STEERING SUBSTRATE (Phase 2b) — one potential-field locomotion primitive +
// the steer-FILL catalogue that collapses the ~12-entry goal.kind locomotion switch
// in act.js into data. Each "behaviour" becomes a pure (agent, ctx) -> field fill;
// all motor through this single steer() executor. World-INTERACTION verbs (gather/
// strike/transfer/build/…) STAY explicit in act.js — locomotion is a field, world-
// interactions are verbs (the doc's hard caution). This file is COGNITION/EXECUTION
// on the restricted ctx: it is in the epistemic scan (test/suites/epistemic.mjs).
//
// BELIEF-GATED BY CONSTRUCTION: every force pos comes from the agent's OWN beliefs
// (a.beliefs.*.lastPos), its own-state targets (a.wanderTarget/arbitrage/expedition/…),
// the STATIC mental map / world POIs (ctx.world.nearest, LANDMARKS), or the resolver
// facade snapshots (ctx.resolver.seenPos). NEVER the roster (no ctx.agents/agentsById/
// player, no foreign true-deref). The single sanctioned carve-out is the party-leader
// ref (resolveLeaderRef in act.js, marked // EPISTEMIC-OK) — do not widen it; if a fill
// needs truth, fix the fill.
//
// THE DELIBERATE DIVERGENCE FROM THE DOC SKETCH. The reasoning doc sketches
// `flee = steer(attract:[refuge?], repel:[threat])` — a SIMULTANEOUS refuge-attract +
// threat-repel field. Today's code has no such case: flee/avoid are strictly XOR
// (a refuge attractor OR a threat repulsor, never both in one field). A simultaneous
// field (curved flight past a threat toward a refuge) is a NEW behaviour the old code
// never had — and the one place the weighted-sum heading would diverge from the
// single-attractor arrival point (overshoot/orbit). So EVERY fill in this preserving
// pass is single-attractor OR single-repulsor. steer() still implements the general
// weighted sum (it is the correct substrate for a future simultaneous-field feature),
// but no fill here exercises the divergent path: for an attractor fill the Stage-A
// sum-heading and the Stage-B primary-attractor arrival point are ALWAYS the same
// point, and a pure-repulsor fill never arrives. The Stage-A/Stage-B incoherence
// therefore never triggers in this workflow.

import * as THREE from 'three';
import { rng } from '../rng.js';
import { ARENA_RADIUS, LANDMARKS } from '../../arena.js';
import { SIM, STEER, SOCIAL, ECON, GOODS, PARTY, ROMANCE, MOTIVE } from '../simconfig.js';
import { POI_KIND } from '../world.js';
import { _stepAlong, groundY } from './movement.js';
import type { Agent, CognitionCtx, EntityId } from '../../../types/sim.js';

/** A {x,z} (+optional y) point: a belief lastPos, a static POI/Place, or an own point. */
interface XZ { x: number; z: number; y?: number }
/** One potential-field force (an attractor pull / repulsor push). A stale pos is guarded;
 *  weight is optional (steer defaults it to STEER.wAttract / STEER.wThreat). */
export interface Force { pos: XZ | null | undefined; weight?: number }
/** The locomotion force-field a steer-fill returns; steer() resolves it to a step. */
interface Field {
  attractors?: Force[];
  repulsors?: Force[];
  speed?: number;
  run?: boolean;
  snapTo?: { x: number; z: number; y?: number };
}

const GOODS_T = GOODS as Record<string, { site: string } | undefined>;

const ZERO = new THREE.Vector3(0, 0, 0);   // world-centre fallback when an agent has no town

// A single-attractor field at `pos` — the common shape (most fills are one static
// place / believed spot). `weight` defaults to STEER.wAttract.
const attractField = (pos: XZ, run = false): Field =>
  ({ attractors: [{ pos, weight: STEER.wAttract }], run });

const _away = new THREE.Vector3();   // scratch for the pure-repulsor synthetic target

const valid = (p: XZ | null | undefined): p is XZ => !!p && Number.isFinite(p.x) && Number.isFinite(p.z);

// steer(a, field, dt) -> boolean (arrived at the primary attractor, halted).
//   field = { attractors:[{pos,weight}], repulsors:[{pos,weight}], speed, run, snapTo? }
//     pos    : any {x,z} (a belief.lastPos, a static POI/Place, an inferred destPos, or
//              an own-derived point). A force whose pos is missing/NaN is SKIPPED (guard:
//              a belief may point at a despawned percept) — never NaN-steps.
//     weight : positive relative pull/push strength.
//     speed  : base m/s BEFORE terrain slow (SIM.moveSpeed | SIM.runSpeed). Optional;
//              defaulted from `run`.
//     run    : bool; selects SIM.runSpeed when `speed` is absent.
//     snapTo : {x,z,y} optional teleport (follow only) — honoured before Stage A.
//   Returns true (and halts: setMoving(0)+groundY) when within SIM.arriveDist of the
//   PRIMARY attractor (the highest-weighted attractor). Returns false while moving and
//   for a pure-repulsor field (which never arrives). Empty/all-stale -> idle, returns
//   false. NEVER throws (the freeze lesson) — every deref is guarded, not exception-based.
export function steer(a: Agent, field: Field | null, dt: number): boolean {
  if (!field) { a.fighter.setMoving(0); return false; }
  // Stage 0 — snapTo teleport (follow only): set x/z (+ owned y), halt, "arrived".
  if (field.snapTo && valid(field.snapTo)) {
    a.pos.x = field.snapTo.x; a.pos.z = field.snapTo.z;
    if (Number.isFinite(field.snapTo.y)) a.pos.y = field.snapTo.y!;
    a.fighter.setMoving(0);
    return true;
  }
  const sp = (typeof field.speed === 'number') ? field.speed
    : (field.run ? SIM.runSpeed : SIM.moveSpeed);

  // Stage A — resolve the field to (heading hx/hz, primary attractor).
  let hx = 0, hz = 0;
  let primary: XZ | null = null, primaryW = -Infinity;
  const attractors = field.attractors || null;
  const repulsors = field.repulsors || null;
  if (attractors) {
    for (let i = 0; i < attractors.length; i++) {
      const f = attractors[i];
      if (!f || !valid(f.pos)) continue;            // guard: skip despawned-percept force
      const dx = f.pos.x - a.pos.x, dz = f.pos.z - a.pos.z;
      const L = Math.hypot(dx, dz) || 1;
      const w = f.weight || STEER.wAttract;
      hx += (dx / L) * w; hz += (dz / L) * w;
      if (w > primaryW) { primaryW = w; primary = f.pos; }
    }
  }
  let hadRepulsor = false;
  if (repulsors) {
    for (let i = 0; i < repulsors.length; i++) {
      const f = repulsors[i];
      const w = f && (f.weight || STEER.wThreat);
      if (!f) continue;
      hadRepulsor = true;
      if (!valid(f.pos)) continue;                  // a stale repulsor is handled below
      const dx = a.pos.x - f.pos.x, dz = a.pos.z - f.pos.z;   // AWAY (only sign differs)
      const L = Math.hypot(dx, dz) || 1;
      hx += (dx / L) * w; hz += (dz / L) * w;
    }
  }

  // PURE-REPULSOR fill (no attractor — fillFlee/fillAvoid away-branch). Reproduce
  // fleeFrom EXACTLY: project a synthetic away-target STEER.fleeAway metres along the
  // away-vector and step toward it (so it never arrives). When the repulsor pos is
  // invalid/absent, the away-vector falls back to `pos` (the agent's WORLD-position
  // vector — radially outward from origin), matching fleeFrom(null)'s old quirk: an
  // all-stale flee DRIFTS RADIALLY from origin, it does NOT idle. (G4/C4's D-position-
  // when-M-removed depends on this exact resumption point.) Recomputed every frame.
  if (primary === null && hadRepulsor) {
    let ax = a.pos.x, az = a.pos.z;                  // fleeFrom(null) radial fallback
    if (hx !== 0 || hz !== 0) { ax = hx; az = hz; }  // a valid repulsor: away-from-threat
    const L = Math.hypot(ax, az) || 1;
    _away.set(a.pos.x + (ax / L) * STEER.fleeAway, a.pos.y, a.pos.z + (az / L) * STEER.fleeAway);
    a.fighter.setFacing(Math.atan2(-(ax / L), -(az / L)));
    _stepAlong(a, ax, az, _away, dt, sp);
    return false;                                   // a synthetic 6m point never arrives
  }

  // Idle degradation (freeze lesson): no valid force contributed -> stand, don't NaN-step.
  if (primary === null) { a.fighter.setMoving(0); groundY(a); return false; }

  // ATTRACTOR fill — facing/arrival are decided against the PRIMARY attractor (which,
  // since every fill here is single-attractor, is the only attractor and the heading
  // equals the straight-at-target heading — identical to goTo). Arrival halts.
  const adx = primary.x - a.pos.x, adz = primary.z - a.pos.z;
  a.fighter.setFacing(Math.atan2(-adx, -adz));
  if (Math.hypot(adx, adz) <= SIM.arriveDist) { a.fighter.setMoving(0); groundY(a); return true; }
  _stepAlong(a, hx, hz, primary, dt, sp);
  return false;
}

// THE STEER-FILL CATALOGUE — a dispatch table keyed by goal.kind. A fill is a pure
// (a, ctx) -> field | null; `null` means idle (the caller sets setMoving(0)). The
// on-arrival/in-place VERB stays explicit in act.js, fired on the boolean steer()
// returns. Populated incrementally as each act.js branch migrates (Phase 2b steps
// 1-6). Each fill below carries the EXACT force/speed the old goTo/fleeFrom call
// site used — a behaviour-preserving collapse, NOT a feature.

// MARKET — haul the load to market and stand the stall; the localized double-auction
// (runMarket) clears for whoever is within marketRange. Static POI attractor, walk;
// the on-arrival HOLD is implicit (steer halts at arriveDist, no verb fires).
function fillMarket(a: Agent, ctx: CognitionCtx): Field | null {
  const m = ctx.world.nearest(POI_KIND.MARKET, a.pos);
  return m ? attractField(m.pos, false) : null;   // null -> caller idles (was setMoving(0))
}

// REST — walk to the nearest rest POI; the on-arrival energy restore is the explicit
// verb in act.js. Static POI attractor, walk. (INCIDENTAL-WART FIX: the old `rest`
// branch did NOTHING when no REST POI existed — leaving the body coasting at its prior
// speed forever; here a null field idles it. Unreachable in practice: every world has
// REST POIs, so the only difference is in the never-hit no-POI case.)
function fillRest(a: Agent, ctx: CognitionCtx): Field | null {
  const r = ctx.world.nearest(POI_KIND.REST, a.pos);
  return r ? attractField(r.pos, false) : null;
}

// BOUNTY — a bounty-hunter marches (RUN) toward the quarry / threat-zone the Gazette
// named; the 'fight' goal takes over once a target is in sight. Own-state target
// (a.goal.toward, a static Gazette pos), run. No verb.
function fillBounty(a: Agent, _ctx: CognitionCtx): Field | null {
  return a.goal!.toward ? attractField(a.goal!.toward, true) : null;
}

// ARBITRAGE — haul the load to the dear town's market (RUN); once within trading range
// HOLD (return null -> idle) so the localized auction sells the goods there. Own-state
// dest (a.arbitrage.destPos). Preserves the ECON.marketRange-2 hold threshold.
function fillArbitrage(a: Agent, _ctx: CognitionCtx): Field | null {
  const ar = a.arbitrage;
  if (!ar || !ar.destPos) return null;
  if (a.pos.distanceTo(ar.destPos) > (ECON.marketRange || 18) - 2) return attractField(ar.destPos, true);
  return null;   // within trading range: HOLD (was setMoving(0)) so the auction clears here
}

// EXPEDITION — march (RUN) toward the company's current objective (the wilds, or home
// on return). Own-state target (a.expedition.target). No verb.
function fillExpedition(a: Agent, _ctx: CognitionCtx): Field | null {
  const tgt = a.expedition && a.expedition.target;
  return tgt ? attractField(tgt, true) : null;
}

// CARAVAN — plod the trade road at WALKING pace toward the current waypoint (out, then
// home). A laden caravan is SLOW — exactly what lets the ambush catch it. Own-state
// target (a.caravanRun.target), walk. No verb.
function fillCaravan(a: Agent, _ctx: CognitionCtx): Field | null {
  const ct = a.caravanRun && a.caravanRun.target;
  return ct ? attractField(ct, false) : null;
}

// REPORTER — the gazetteer hurries (RUN) toward its current subject; with none yet, it
// ambles (WALK) around its home town waiting for a story to break. Own-state target
// (a.reporterTarget) OR an own-state wander point in the town band — the two-path the
// old branch had, kept inside the fill. No verb.
function fillReporter(a: Agent, _ctx: CognitionCtx): Field | null {
  const t = a.reporterTarget;
  if (t) return attractField(t, true);
  if (!a.wanderTarget || a.pos.distanceTo(a.wanderTarget) < 1.0) {
    const c = a.townAnchor || ZERO, rr = (a.townRadius || 40) * 0.5;
    const ang = rng() * Math.PI * 2, r = rng() * rr;
    a.wanderTarget = new THREE.Vector3(c.x + Math.cos(ang) * r, 0, c.z + Math.sin(ang) * r);
  }
  return attractField(a.wanderTarget, false);
}

// SIGHTSEE (leisure variety): take in a named LANDMARK. To rove the map for variety
// WITHOUT trekking to the deadly frontier, pick at random among the few NEAREST
// landmarks (regional, not always the closest) and walk there. The on-arrival novelty/
// comfort/social restore + the sightTarget reset are the explicit verb in act.js. Picks
// a fresh landmark each outing; guarded (no landmarks -> idle). Own-state target.
function fillSightsee(a: Agent, _ctx: CognitionCtx): Field | null {
  if (!a.sightTarget) {
    if (!LANDMARKS || !LANDMARKS.length) return null;   // -> caller idles (was setMoving(0))
    const near = LANDMARKS.slice()
      .sort((p, q) => ((p.x - a.pos.x) ** 2 + (p.z - a.pos.z) ** 2) - ((q.x - a.pos.x) ** 2 + (q.z - a.pos.z) ** 2))
      .slice(0, 3);
    const L = near[(rng() * near.length) | 0];
    a.sightTarget = new THREE.Vector3(L.x, a.pos.y, L.z);
  }
  return attractField(a.sightTarget, false);
}

// WANDER (the default) — pick a roam target and amble to it, regenerating when within
// 1m of the current one. Four EXACT radial cases (own-state anchors only, no live read):
// dungeon roam-room / camp patrol / monster frontier-prowl / townsfolk home-band. Walk.
function fillWander(a: Agent, _ctx: CognitionCtx): Field | null {
  if (!a.wanderTarget || a.pos.distanceTo(a.wanderTarget) < 1.0) {
    if (a.roam) {
      // dungeon dwellers pace within their room (set at spawn): a small patrol radius
      // around a fixed centre instead of the whole arena.
      const ang = rng() * Math.PI * 2, r = rng() * a.roam.r;
      a.wanderTarget = new THREE.Vector3(a.roam.x + Math.cos(ang) * r, a.pos.y, a.roam.z + Math.sin(ang) * r);
    } else if (a.campAnchor) {
      // camp combatants PATROL near their camp anchor (a frontier lair) rather than
      // roaming the inner village — a fixed territorial hazard, not a wandering mob.
      const ang = rng() * Math.PI * 2, r = rng() * (a.campPatrolR || 20);
      a.wanderTarget = new THREE.Vector3(a.campAnchor.x + Math.cos(ang) * r, a.pos.y, a.campAnchor.z + Math.sin(ang) * r);
    } else if (a.faction === 'monster') {
      // monsters prowl the mid-to-outer wilds around the world centre (danger lives on
      // the frontier, between the towns).
      const minR = ARENA_RADIUS * 0.45, maxR = ARENA_RADIUS * 0.92;
      const ang = rng() * Math.PI * 2, r = minR + rng() * (maxR - minR);
      a.wanderTarget = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
    } else {
      // townsfolk roam within THEIR town's home band (around its centre) — keeps each
      // town socially dense and stops agents diffusing into the wilderness.
      const c = a.townAnchor || ZERO;
      const maxR = (a.townRadius || ARENA_RADIUS * 0.65) * 0.85;
      const ang = rng() * Math.PI * 2, r = rng() * maxR;
      a.wanderTarget = new THREE.Vector3(c.x + Math.cos(ang) * r, 0, c.z + Math.sin(ang) * r);
    }
  }
  return attractField(a.wanderTarget, false);
}

// WORK — walk to the workplace POI for the agent's CHOSEN trade and produce there
// (the produce verb fires on arrival in act.js). The occupation choice + the two
// guard branches that the OLD `work` branch had (no work-capable body, or no valid
// trade) are performed HERE and return null -> idle (the agent stands, exactly as the
// old `break` did). Static POI attractor, walk. Own-state (_trade) + static map only.
function fillWork(a: Agent, ctx: CognitionCtx): Field | null {
  if (!a.canWork) return null;                  // monsters/player have no workplace -> idle
  if (!a._trade) a.chooseOccupation(ctx);       // lazily pick a trade (own-state, no roster)
  const g = a._trade ? GOODS_T[a._trade] : null;
  if (!g) return null;                          // no valid trade -> idle (was `break`)
  const site = ctx.world.nearest(g.site, a.pos);
  return site ? attractField(site.pos, false) : null;
}

// COMFORT — walk to my home or a tavern (toPos, a belief-home / static shelter Place
// that decide already picked) and restore comfort on arrival (the verb in act.js, which
// also tops up social at a tavern). BELIEF-BACKED: the destination is my own home-belief
// or a static Place — no live read. Guarded: a missing destination idles (decide re-routes).
function fillComfort(a: Agent, _ctx: CognitionCtx): Field | null {
  return a.goal!.toPos ? attractField(a.goal!.toPos, false) : null;
}

// SOCIALIZE — walk to a believed FRIEND and stand with them; with no friend known well
// enough, fall back to the MARKET (the town's gathering place) so a newcomer still finds
// company. The friend force is the belief lastPos (only when confidence clears knownConf —
// a moved/dead friend leaves an empty spot and the need just doesn't fill); the market is a
// static POI. The on-arrival social restore + bond is the explicit verb in act.js. Walk.
function fillSocialize(a: Agent, ctx: CognitionCtx): Field | null {
  const rel = (a.goal!.withId != null) ? a.beliefs.get(a.goal!.withId) : null;
  if (rel && rel.confidence > SOCIAL.knownConf) return attractField(rel.lastPos, false);
  const m = ctx.world.nearest(POI_KIND.MARKET, a.pos);
  return m ? attractField(m.pos, false) : null;
}

// ── PERSISTENT-AMBITION STANDING-ACTIVITY FILL (Phase B1) ──────────────────────────
// Renown's march is the ONE new locomotion the ambition layer needs; mastery/belonging/wanderlust
// reuse fillWork/fillSocialize/fillSightsee (their committed activity kind IS work/socialize/
// sightsee). Reads OWN-STATE + the STATIC map only (scan-clean), fully guarded (null → idle).

// SEEK_GLORY (renown) — prowl the FRONTIER band where monsters roam (the same radial the monster
// branch of fillWander uses: ARENA_RADIUS × gloryFrontierMin..0.92 around world centre). The
// EXISTING fight candidate fires the moment a believed-hostile comes into sight — this fill only
// carries the agent to where the danger lives. The prowl is LOCAL: each leg keeps near the agent's
// OWN current bearing (± a wedge of jitter) rather than rolling a fresh random angle, so a seeker
// marches straight out to the band once and then stalks ALONG it — short hops, more monster
// contact — instead of spending its life on cross-map treks (marching dwell crowds out the very
// fights the renown arc is for). Own-state wanderTarget; walk.
function fillSeekGlory(a: Agent, _ctx: CognitionCtx): Field | null {
  if (!a.wanderTarget || a.pos.distanceTo(a.wanderTarget) < 1.0) {
    const minR = ARENA_RADIUS * (MOTIVE.gloryFrontierMin || 0.45), maxR = ARENA_RADIUS * 0.92;
    const ang = Math.atan2(a.pos.z, a.pos.x) + (rng() - 0.5) * 1.2;   // my bearing ± ~34°
    const r = minR + rng() * (maxR - minR);
    a.wanderTarget = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
  }
  return attractField(a.wanderTarget, false);
}

// FLEE — XOR (the documented divergence from the doc sketch: NEVER a simultaneous
// refuge-attract + threat-repel field — that would be a NEW curved-flight behaviour).
// If the flee-to-refuge schema set a concrete `toPos` (a static place affording exit/
// conceal, from the shared map), RUN TO IT (a single attractor). Otherwise RUN AWAY from
// where I BELIEVE the threat is (its belief lastPos — never a live read) as a single
// PURE REPULSOR: steer's repulsor path projects a 6m synthetic away-point and never
// arrives. A faded/absent belief leaves NO valid repulsor pos -> the away=pos radial
// fallback drifts me outward from origin (the old fleeFrom(null) quirk G4/C4 depend on,
// reproduced in steer's pure-repulsor branch). Run either way.
function fillFlee(a: Agent, _ctx: CognitionCtx): Field | null {
  if (a.goal!.toPos) return attractField(a.goal!.toPos, true);
  const fb = a.goal!.fromId != null ? a.beliefs.get(a.goal!.fromId) : null;
  // belief.lastPos may be undefined (no belief) — steer's repulsor guard handles it,
  // falling back to the radial-from-origin drift exactly as fleeFrom(null) did.
  return { repulsors: [{ pos: fb ? fb.lastPos : undefined, weight: STEER.wThreat }], run: true };
}

// AVOID — clear a believed danger zone. XOR (same divergence note as flee): steer toward
// the safe place (`toPos`) the schema picked as a single attractor; with none, steer
// directly AWAY from the believed brawl centre (`around`) as a single pure repulsor.
// Both are static/belief points — no live read. Run.
function fillAvoid(a: Agent, _ctx: CognitionCtx): Field | null {
  if (a.goal!.toPos) return attractField(a.goal!.toPos, true);
  if (a.goal!.around) return { repulsors: [{ pos: a.goal!.around, weight: STEER.wThreat }], run: true };
  return null;   // no refuge, no zone centre -> idle (was setMoving(0))
}

// HIDE — go to ground at a concealing place (`toPos`, a static map point the go-to-ground
// schema set), then stand still (the stand-still verb fires on arrival in act.js). No
// threat ref deref. Guarded: no place -> idle. Run.
function fillHide(a: Agent, _ctx: CognitionCtx): Field | null {
  return a.goal!.toPos ? attractField(a.goal!.toPos, true) : null;
}

// SHADOW — trail a SUSPECTED mask at a stand-off distance: close to within a tail gap of
// where I BELIEVE it is (belief lastPos — no live read), then HOLD. Only steer while the
// gap exceeds the stand-off (SOCIAL.shadowGap); within the gap, or with a faded/absent
// belief, return null so the caller halts (the suspect moved out of my knowledge). Walk.
function fillShadow(a: Agent, _ctx: CognitionCtx): Field | null {
  const sb = (a.goal!.subjectId != null) ? a.beliefs.get(a.goal!.subjectId) : null;
  if (!sb || sb.confidence < SIM.actOnBeliefMin) return null;   // lost track -> idle
  if (a.pos.distanceTo(sb.lastPos) <= (SOCIAL.shadowGap || 6)) return null;  // within gap: HOLD
  return attractField(sb.lastPos, false);
}

// COURT (docs/architecture/12 §8) — the Star-Crossed enactment: seek the believed position of the
// chosen sweetheart (`_courtingId`) and linger at a social stand-off. Built from the agent's OWN
// belief (lastPos), like every other steer-fill — no roster read. Idle when the love is out of mind.
function fillCourt(a: Agent, _ctx: CognitionCtx): Field | null {
  const id = (a as Agent & { _courtingId?: EntityId | null })._courtingId;
  if (id == null) return null;
  const sb = a.beliefs.get(id);
  if (!sb || sb.confidence < SIM.actOnBeliefMin) return null;        // lost track of my love -> idle
  if (a.pos.distanceTo(sb.lastPos) <= (ROMANCE.courtGap || 2.5)) return null;  // at the stand-off: HOLD (linger)
  return attractField(sb.lastPos, false);
}

// Resolve the band leader to a { pos, alive } REF for fillFollow. The controlled
// player-led party reads its real leader handle (the documented ctx.partyLeader
// exception). An NPC band follows where it BELIEVES its leader is (belief lastPos),
// confidence-gated — no roster read. Returns null when the leader is unknown/gone.
/** The minimal leader handle fillFollow needs: a position + a liveness flag. */
interface LeaderRef { pos: XZ; alive: boolean }

function resolveLeaderRef(a: Agent, ctx: CognitionCtx): LeaderRef | null {
  const pl = a._leader(ctx);                       // EPISTEMIC-OK: controlled party leader (known mechanic)
  if (pl) return pl;
  if (a.bandLeaderId == null) return null;
  const b = a.beliefs.get(a.bandLeaderId);
  if (!b || b.confidence < SIM.actOnBeliefMin) return null;
  return { pos: b.lastPos, alive: true };
}

// FOLLOW — hold a fan slot behind the band leader. More than a plain attractor:
//  * a TELEPORT SNAP when hopelessly separated (gap > PARTY.teleportDist) — copies the
//    leader's y so a member that missed a dungeon descend re-joins at the leader's world.
//  * RUN to catch up when straggling (gap > PARTY.catchUpDist), else walk.
// The slot target is geometry off the leader REF (pos only); the non-snap path lets
// groundY own y (it early-returns for a party member, so the follower keeps its own/
// teleported y exactly as the old followLeader's non-snap goTo did). Leader unknown/
// dead -> null (idle). steer's Stage-0 honours snapTo. Belief-/carve-out-gated only.
function fillFollow(a: Agent, ctx: CognitionCtx): Field | null {
  const leader = resolveLeaderRef(a, ctx);
  if (!leader || !leader.alive) return null;        // EPISTEMIC-OK: controlled party leader (known mechanic)
  const n = Math.max(1, PARTY.maxSize);
  const ang = (a.partySlot || 0) * (Math.PI * 2 / n) + Math.PI;   // fan out behind
  const tx = leader.pos.x + Math.cos(ang) * PARTY.spacing;
  const tz = leader.pos.z + Math.sin(ang) * PARTY.spacing;
  const gap = Math.hypot(leader.pos.x - a.pos.x, leader.pos.z - a.pos.z);
  if (gap > PARTY.teleportDist) return { snapTo: { x: tx, z: tz, y: leader.pos.y } };
  return { attractors: [{ pos: { x: tx, z: tz }, weight: STEER.wAttract }], run: gap > PARTY.catchUpDist };
}

/** goal.kind -> steer-fill. Indexed by an arbitrary kind in act.js (unknown -> wander). */
export type SteerFill = (a: Agent, ctx: CognitionCtx) => Field | null;
export const STEER_FILLS: Record<string, SteerFill> = {
  market: fillMarket,
  rest: fillRest,
  bounty: fillBounty,
  arbitrage: fillArbitrage,
  expedition: fillExpedition,
  caravan: fillCaravan,
  reporter: fillReporter,
  sightsee: fillSightsee,
  work: fillWork,
  comfort: fillComfort,
  socialize: fillSocialize,
  flee: fillFlee,
  avoid: fillAvoid,
  hide: fillHide,
  shadow: fillShadow,
  court: fillCourt,
  follow: fillFollow,
  wander: fillWander,
  // PERSISTENT-AMBITION STANDING-ACTIVITY FILL (Phase B1) — renown's frontier march
  seek_glory: fillSeekGlory,
  beg: fillMarket,        // a beggar heads for the crowd at the stalls; the plea is act's verb
};
