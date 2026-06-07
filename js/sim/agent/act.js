// Agent action layer — the execution half of the epistemic split: act reads the
// agent's already-decided goal and drives the body through GROUND TRUTH (move,
// produce, fight, cast, trade, transfer). Extracted from Agent as free functions
// over a passed agent instance. Builds on the locomotion primitives in
// movement.js (one-directional: movement <- act). Behaviour-preserving: verbatim
// bodies of the old Agent methods. No cycles — imports config, pure helpers, the
// ability interpreter, the rpg event bus, and movement only.

import * as THREE from 'three';
import { DIR, TUNE } from '../../constants.js';
import { ARENA_RADIUS, LANDMARKS } from '../../arena.js';
import { POI_KIND } from '../world.js';
import { GOODS, ECON, SIM, SOCIAL, BAND, BUILD, COMFORT, NOVELTY } from '../simconfig.js';
import { castSpec, onCooldown } from '../../rpg/abilities/interpreter.js';
import { isMelee } from '../../rpg/abilities/ir.js';
import { bus, makeEvent } from '../../rpg/events.js';
import { awardGoalClosureXP } from '../motivation.js';
import { stepTargetPos, stepEffectHolds } from '../planner.js';
import { goTo, fleeFrom, followLeader, groundY } from './movement.js';
import { masteryMul } from './occupation.js';
import { collideWalls } from '../walls.js';

// Map a producer's commodity output -> the behavior tags the deed earns. There
// is no per-commodity tag in the RPG vocabulary, so produced goods map to the
// gather/craft identity that makes them (sourced from GOODS). A chosen
// occupation thus steers which class the agent builds.
const OUTPUT_TAGS = Object.fromEntries(
  Object.keys(GOODS).map((g) => [g, GOODS[g].tags])
);

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const DIRS = [DIR.UP, DIR.DOWN, DIR.LEFT, DIR.RIGHT];
const ZERO = new THREE.Vector3(0, 0, 0);   // world centre fallback when an agent has no town
const randDir = () => DIRS[(Math.random() * 4) | 0];

// Resolve the band leader to a { pos, alive } REF for followLeader. The controlled
// player-led party reads its real leader handle (the documented ctx.partyLeader
// exception). An NPC band follows where it BELIEVES its leader is (belief lastPos),
// confidence-gated — no roster read. Returns null when the leader is unknown/gone.
function resolveLeaderRef(a, ctx) {
  const pl = a._leader(ctx);                       // EPISTEMIC-OK: controlled party leader (known mechanic)
  if (pl) return pl;
  if (a.bandLeaderId == null) return null;
  const b = a.beliefs.get(a.bandLeaderId);
  if (!b || b.confidence < SIM.actOnBeliefMin) return null;
  return { pos: b.lastPos, alive: true };
}

// --- act ---------------------------------------------------------------------
export function act(a, dt, ctx) {
  if (!a.alive || a.controlled) return;
  a.priceGossip(ctx, dt);
  // drink a remedy when badly hurt — keeps a recurring demand for potions
  if (a.fighter.health < TUNE.maxHealth * 0.5 && (a.inventory.potion || 0) >= 1) {
    a.inventory.potion -= 1;
    a.fighter.health = Math.min(TUNE.maxHealth, a.fighter.health + 45);
  }

  switch (a.goal.kind) {
    case 'plan': execPlanStep(a, dt, ctx); break;
    case 'fight': combatStep(a, dt, ctx); break;
    case 'follow': followLeader(a, resolveLeaderRef(a, ctx), dt); break;
    case 'bounty': {
      // a bounty-hunter marches (at speed) toward the quarry / the threat zone the
      // Gazette notice named; the 'fight' goal takes over once a target is in sight.
      const t = a.goal.toward;
      if (t) goTo(a, t, dt, true);
      break;
    }
    case 'arbitrage': {
      // haul the load to the dear town's market; once within trading range, HOLD so
      // the localized auction (market.js) sells the goods there at the better price.
      const ar = a.arbitrage;
      if (ar && ar.destPos) {
        if (a.pos.distanceTo(ar.destPos) > (ECON.marketRange || 18) - 2) goTo(a, ar.destPos, dt, true);
        else a.fighter.setMoving(0);
      } else a.fighter.setMoving(0);
      break;
    }
    case 'reporter': {
      // the gazetteer hurries toward its current subject; with none yet, it ambles
      // around its home town waiting for a story to break.
      const t = a.reporterTarget;
      if (t) goTo(a, t, dt, true);
      else {
        if (!a.wanderTarget || a.pos.distanceTo(a.wanderTarget) < 1.0) {
          const c = a.townAnchor || ZERO, rr = (a.townRadius || 40) * 0.5;
          const ang = Math.random() * Math.PI * 2, r = Math.random() * rr;
          a.wanderTarget = new THREE.Vector3(c.x + Math.cos(ang) * r, 0, c.z + Math.sin(ang) * r);
        }
        goTo(a, a.wanderTarget, dt, false);
      }
      break;
    }
    case 'sightsee': sightseeStep(a, dt, ctx); break;
    case 'flee': {
      // SCHEMA FLEE-TO-REFUGE: the flee-to-safety schema sets a concrete `toPos` (the
      // nearest static place affording exit/conceal) — RUN TO IT rather than merely away
      // from the threat. A static-geography point (shared map), never a live read. If no
      // refuge was found (toPos null) fall through to the away-from-threat steering below.
      if (a.goal.toPos) { goTo(a, a.goal.toPos, dt, true); break; }
      // BELIEF-GATED: flee from where I BELIEVE the threat is (its belief lastPos), never
      // a live read. A faded belief just means I steer away from my last sighting of it.
      const fb = a.beliefs.get(a.goal.fromId);
      fleeFrom(a, fb ? { pos: fb.lastPos } : null, dt);
      break;
    }
    case 'eat': {
      if (a.inventory.food > 0 && a.needs.hunger < 1) {
        const amt = ECON.eatRate * dt;
        a.needs.hunger = clamp01(a.needs.hunger + amt);
        a.inventory.food = Math.max(0, a.inventory.food - amt);
      }
      a.fighter.setMoving(0);
      break;
    }
    case 'work': {
      if (!a.canWork) break;               // monsters/player have no workplace
      if (!a._trade) a.chooseOccupation(ctx);
      const g = a._trade && GOODS[a._trade];
      if (!g) break;
      const site = ctx.world.nearest(g.site, a.pos);
      if (site && goTo(a, site.pos, dt)) produce(a, dt);
      break;
    }
    case 'rest': {
      const r = ctx.world.nearest(POI_KIND.REST, a.pos);
      if (r && goTo(a, r.pos, dt)) a.needs.energy = clamp01(a.needs.energy + SIM.restRate * dt);
      break;
    }
    case 'socialize': {
      // walk to a believed-FRIEND and stand with them (decide picked withId from my
      // beliefs; I head for where I THINK they are). With no friend known, fall back to
      // the market — the town's gathering place — so a newcomer still finds company.
      // Belief-only: a moved/dead friend leaves an empty spot, the need just doesn't fill
      // and I re-choose next decide. Either way, ARRIVING restores social + feeds belonging.
      const rel = (a.goal.withId != null) ? a.beliefs.get(a.goal.withId) : null;
      let here = false;
      if (rel && rel.confidence > SOCIAL.knownConf) here = goTo(a, rel.lastPos, dt);
      else {
        const m = ctx.world.nearest(POI_KIND.MARKET, a.pos);
        if (m) here = goTo(a, m.pos, dt);
      }
      if (here) {
        a.needs.social = clamp01(a.needs.social + SIM.socializeRate * dt);
        a.life.social += SIM.socializeRate * dt;     // feeds the 'belonging' ambition
        // QUALITY TIME: deliberately spending time beside this friend deepens the bond
        // faster than the incidental affinity the gossip pass grants from mere proximity.
        // Belief-only (my own standing toward them); capped like all familiarity warmth.
        if (rel && !rel.hostile && rel.standing >= 0)
          rel.standing = Math.min(BAND.affinityCap, rel.standing + SOCIAL.bondBonus * dt);
      }
      break;
    }
    case 'market': {
      // HAUL the load to market and stand the stall — the localized double-auction
      // (runMarket) clears deals for whoever is within marketRange. goTo halts on
      // arrival; the agent holds there until its load is sold / need met (decide).
      const m = ctx.world.nearest(POI_KIND.MARKET, a.pos);
      if (m) goTo(a, m.pos, dt); else a.fighter.setMoving(0);
      break;
    }
    case 'spy': spyStep(a, dt, ctx); break;
    case 'expedition': {
      // march toward the company's current objective (the wilds, or home on return).
      const tgt = a.expedition && a.expedition.target;
      if (tgt) goTo(a, tgt, dt, true); else a.fighter.setMoving(0);
      break;
    }
    case 'caravan': {
      // plod the trade road at WALKING pace toward the current waypoint (out, then
      // home). A laden caravan is SLOW — which is exactly what lets the ambush catch
      // it (it only breaks into a fast flee once a raider is right on top of it).
      const ct = a.caravanRun && a.caravanRun.target;
      if (ct) goTo(a, ct, dt, false); else a.fighter.setMoving(0);
      break;
    }
    case 'comfort': {
      // walk to my home or a tavern and restore comfort; a tavern also tops up social (and
      // feeds the existing belonging/colocation warmth). BELIEF-BACKED (debt #2 retired):
      // decide picked the destination (toPos) + kind (srcKind) from my OWN home-belief or a
      // STATIC shelter Place — no live BuildSites lookup here. Walk-through benefit zone (no
      // collision). Guarded so a missing destination just idles (decide re-routes).
      const cp = a.goal.toPos;
      if (cp && goTo(a, cp, dt)) {
        a.needs.comfort = clamp01((a.needs.comfort ?? 1) + COMFORT.restoreRate * dt);
        if (a.goal.srcKind === 'tavern') {
          a.needs.social = clamp01(a.needs.social + COMFORT.tavernSocialRate * dt);
          a.life.social += COMFORT.tavernSocialRate * dt;   // tavern colocation feeds belonging
        }
      } else if (!cp) { a.fighter.setMoving(0); }            // no comfort source known: idle (decide re-routes)
      break;
    }
    case 'build': buildStep(a, dt, ctx); break;
    // --- SCHEMA DISPOSITIONS (Phase 2a) -------------------------------------
    // Phase 2b COLLAPSE-FODDER: hide/shadow/avoid are three special-cases of the
    // same steer() potential-field primitive — when steer() lands these three
    // cases collapse into one goal.kind -> steer-fills branch and are deleted.
    case 'hide': {
      // go to ground at a concealing place (toPos, a static map point set by the
      // go-to-ground schema), then stand still. No threat ref deref. Guarded.
      if (a.goal.toPos) { if (goTo(a, a.goal.toPos, dt, true)) a.fighter.setMoving(0); }
      else a.fighter.setMoving(0);
      break;
    }
    case 'shadow': {
      // trail a SUSPECTED mask at a stand-off distance: close to within a tail gap of
      // where I BELIEVE it is (belief lastPos — no live read), then hold. A faded/absent
      // belief just leaves me idling (the suspect moved out of my knowledge).
      const sb = (a.goal.subjectId != null) ? a.beliefs.get(a.goal.subjectId) : null;
      if (sb && sb.confidence >= SIM.actOnBeliefMin) {
        const gap = a.pos.distanceTo(sb.lastPos);
        if (gap > (SOCIAL.shadowGap || 6)) goTo(a, sb.lastPos, dt); else a.fighter.setMoving(0);
      } else a.fighter.setMoving(0);
      break;
    }
    case 'avoid': {
      // clear a believed danger zone: steer toward the safe place (toPos) the schema
      // picked; with none, steer directly AWAY from the believed brawl centre (around).
      // Both are static/belief points — no live read.
      if (a.goal.toPos) goTo(a, a.goal.toPos, dt, true);
      else if (a.goal.around) fleeFrom(a, { pos: a.goal.around }, dt);
      else a.fighter.setMoving(0);
      break;
    }
    default: {
      if (!a.wanderTarget || a.pos.distanceTo(a.wanderTarget) < 1.0) {
        if (a.roam) {
          // dungeon dwellers pace within their room (set at spawn): a small
          // patrol radius around a fixed centre instead of the whole arena.
          const ang = Math.random() * Math.PI * 2, r = Math.random() * a.roam.r;
          a.wanderTarget = new THREE.Vector3(a.roam.x + Math.cos(ang) * r, a.pos.y, a.roam.z + Math.sin(ang) * r);
        } else if (a.campAnchor) {
          // camp combatants PATROL near their camp anchor (a frontier lair) rather
          // than roaming the inner village — they're a fixed territorial hazard, not
          // a wandering mob (drama-plan §3). So they only menace townsfolk who come
          // out to the frontier, exactly as the monsters do — without that, a camp
          // member falls into the townsfolk roam band and drifts into town, where it
          // constantly perceives + hunts civilians (the source of the massacre).
          const ang = Math.random() * Math.PI * 2, r = Math.random() * (a.campPatrolR || 20);
          a.wanderTarget = new THREE.Vector3(a.campAnchor.x + Math.cos(ang) * r, a.pos.y, a.campAnchor.z + Math.sin(ang) * r);
        } else if (a.faction === 'monster') {
          // monsters prowl the mid-to-outer wilds around the world centre (danger
          // lives on the frontier, between the towns).
          const minR = ARENA_RADIUS * 0.45, maxR = ARENA_RADIUS * 0.92;
          const ang = Math.random() * Math.PI * 2, r = minR + Math.random() * (maxR - minR);
          a.wanderTarget = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
        } else {
          // townsfolk roam within THEIR town's home band (around its centre) — this
          // is what keeps each town socially dense and stops agents diffusing into
          // the wilderness / drifting toward another town.
          const c = a.townAnchor || ZERO;
          const maxR = (a.townRadius || ARENA_RADIUS * 0.65) * 0.85;
          const ang = Math.random() * Math.PI * 2, r = Math.random() * maxR;
          a.wanderTarget = new THREE.Vector3(c.x + Math.cos(ang) * r, 0, c.z + Math.sin(ang) * r);
        }
      }
      goTo(a, a.wanderTarget, dt);
    }
  }
  // Settle the body onto the terrain surface every frame — NOT just inside goTo.
  // combatStep (and any direct x/z move) advances position without re-grounding, so
  // a chaser on sloped ground would keep its stale y and float. groundY is DOM-/
  // roam-/party-guarded (headless no-op, dungeon & party y owned elsewhere) and is a
  // single pure-trig sample, so this is free of behavioural/test drift.
  groundY(a);
  a._updateLabel();
}

// SIGHTSEE (leisure variety): a townsperson takes in a named LANDMARK. To rove the
// map for variety WITHOUT trekking to the deadly frontier, it picks at random among
// the few NEAREST landmarks (regional, not always the closest), walks there, and on
// arrival takes it in — a little comfort + society (feeds belonging). A threat still
// interrupts via decide's flee/fight, so a sightseer near danger bolts. Picks a fresh
// landmark each outing. Guarded; never throws on the tick.
function sightseeStep(a, dt, ctx) {
  if (!a.sightTarget) {
    if (!LANDMARKS || !LANDMARKS.length) { a.fighter.setMoving(0); return; }
    const near = LANDMARKS.slice()
      .sort((p, q) => ((p.x - a.pos.x) ** 2 + (p.z - a.pos.z) ** 2) - ((q.x - a.pos.x) ** 2 + (q.z - a.pos.z) ** 2))
      .slice(0, 3);
    const L = near[(Math.random() * near.length) | 0];
    a.sightTarget = new THREE.Vector3(L.x, a.pos.y, L.z);
  }
  if (goTo(a, a.sightTarget, dt)) {        // goTo halts + returns true on arrival
    // the PRIMARY payoff: relieve boredom (the NOVELTY need). A fresh sight tops it up.
    a.needs.novelty = clamp01((a.needs.novelty ?? 1) + NOVELTY.restore * dt);
    // a little comfort + society too — a pleasant outing lightly serves those needs.
    a.needs.comfort = clamp01((a.needs.comfort ?? 1) + COMFORT.restoreRate * dt * 0.5);
    a.needs.social = clamp01(a.needs.social + SIM.socializeRate * dt * 0.3);
    a.life.social += SIM.socializeRate * dt * 0.3;   // a touch of belonging
    // hold at the sight until boredom is genuinely topped up, THEN pick a fresh one
    // (so it doesn't bounce off the instant it arrives). Wanderlust feeds via goTo dist.
    if ((a.needs.novelty ?? 1) >= NOVELTY.satisfiedAt) a.sightTarget = null;
  }
}

// SPY locomotion (intrigue): an infiltrator under cover SCOUTS toward the town
// core (origin/market) to whisper a planted rumour, then EXFILTRATES back to its
// camp anchor. The Intrigue subsystem does the planting and flips a.spy.phase to
// 'exfil'; here we just drive the body. On reaching the camp it resets to 'scout'
// for another run. Fully guarded — a spy with no camp anchor simply edges toward
// the core (still infiltrating), never throwing on the tick.
function spyStep(a, dt, ctx) {
  const S = a.spy;
  if (!S) { goTo(a, new THREE.Vector3(0, a.pos.y, 0), dt); return; }
  if (S.phase === 'exfil') {
    // run home to the camp anchor (stored on the spy state at assignment); if it
    // somehow has none, just edge outward away from the core. Reset on arrival.
    const tgt = S.anchor || new THREE.Vector3(a.pos.x * 1.3, a.pos.y, a.pos.z * 1.3);
    if (goTo(a, tgt, dt, true)) S.phase = 'scout';
    return;
  }
  // scout: edge toward the town core (origin). Slightly jittered so a clutch of
  // spies don't stack on the exact centre. RUN — an infiltrator hurries through
  // the frontier monster gauntlet rather than dawdling and getting cornered.
  if (!S.scoutTarget || a.pos.distanceTo(S.scoutTarget) < 1.2) {
    const jx = (Math.random() - 0.5) * 6, jz = (Math.random() - 0.5) * 6;
    S.scoutTarget = new THREE.Vector3(jx, a.pos.y, jz);
  }
  goTo(a, S.scoutTarget, dt, true);
}

// --- controlled execution (the single avatar the player drives) -------------
// The controlled agent does NOT run decide()/act(); the Commander sets .goal
// from mouse orders and calls this each frame. We reuse the very same movement
// and combat primitives the NPC AI uses, so the body behaves consistently and
// there's no second combat path to keep in sync.
export function actControlled(a, dt, ctx) {
  if (!a.alive) return;
  switch (a.goal.kind) {
    case 'fight': combatStep(a, dt, ctx); break;
    case 'goto': {
      const t = a.goal.target;
      if (!t || goTo(a, t, dt, a.goal.run)) a.goal = { kind: 'idle' };
      break;
    }
    case 'approach': {
      // the player's controlled body walks to a SEEN target (vision-gated via the
      // resolver, which returns a position snapshot, not the live object). Lost from
      // sight -> idle. Reads no roster handle.
      const sp = ctx.resolver ? ctx.resolver.seenPos(a, a.goal.targetId) : null;
      if (!sp) { a.goal = { kind: 'idle' }; break; }
      if (a.pos.distanceTo(sp) <= SIM.talkRange) { a.fighter.setMoving(0); a.goal.arrived = true; }
      else goTo(a, sp, dt);
      break;
    }
    default: a.fighter.setMoving(0); break;   // idle / post-kill 'wander'
  }
  a._updateLabel();
}

// Make the agent's CHOSEN good (a._trade). Generalized off profession: a
// crafted good (inputs present) converts inputs->output on a timer; a raw good
// accrues over time, tool-boosted + tool-wearing. Guarded: a missing/invalid
// trade is a no-op (never throws on the tick — the freeze lesson).
export function produce(a, dt) {
  const output = a._trade;
  const g = output && GOODS[output];
  if (!g) { a.fighter.setMoving(0); return; }
  const inv = a.inventory;
  a.fighter.setMoving(0);
  // INCREASING RETURNS TO MASTERY: a seasoned maker is far more productive at its craft —
  // it forges faster and gathers more per second, several-fold a novice. This is what lets
  // a master flood its field cheaply and makes it nearly impossible for a low-mastery unit
  // to compete there. 1.0 for a novice, growing uncapped with mastery for a grandmaster.
  const skillMul = masteryMul(a, output);
  if (g.inputs) {
    // crafted good: convert inputs -> output on the smithing timer
    const has = Object.keys(g.inputs).every((c) => (inv[c] || 0) >= g.inputs[c]);
    if (has) {
      a._smithTimer += dt;
      if (a._smithTimer >= ECON.smithSecsPerTool / skillMul) {
        a._smithTimer = 0;
        for (const c in g.inputs) inv[c] -= g.inputs[c];
        if ((inv[output] || 0) < ECON.maxStack) inv[output] = (inv[output] || 0) + 1;
        a.mastery[output] = (a.mastery[output] || 0) + 1;   // practice deepens mastery
        // a crafted good is a discrete crafting deed
        bus.emit(makeEvent({
          actorId: a.id, verb: 'forge', tags: OUTPUT_TAGS[output] || ['CRAFTING'],
          magnitude: 1, t: a._rpgNow,
        }));
      }
    }
    return;
  }
  // raw producer
  if ((inv[output] || 0) >= ECON.maxStack) return;
  const boosted = inv.tool >= 1;
  const gained = ECON.produceRate * (boosted ? ECON.toolBoost : 1) * skillMul * dt;
  inv[output] = (inv[output] || 0) + gained;
  // emit ONE produce ActionEvent per whole unit accumulated, tagged by output
  a._produceAccum += gained;
  while (a._produceAccum >= 1) {
    a._produceAccum -= 1;
    a.mastery[output] = (a.mastery[output] || 0) + 1;   // practice deepens mastery
    bus.emit(makeEvent({
      actorId: a.id, verb: 'produce',
      tags: OUTPUT_TAGS[output] || ['ENDURANCE'],
      magnitude: 1, t: a._rpgNow,
    }));
  }
  if (boosted) {
    // tools wear PER UNIT PRODUCED — ties tool demand to throughput, which is
    // what closes the money loop (validated via the Markov-chain analysis).
    a.toolWear += gained * ECON.toolWearPerGain;
    while (a.toolWear >= 1 && inv.tool > 0) { a.toolWear -= 1; inv.tool -= 1; }
  }
}

// THE MULTI-TICK CONSTRUCTION PROCESS (the execution half of Phase-1 buildings).
// Resolve the committed BuildSite (commission lazily here if the agent chose to
// build but holds no site yet — commission re-checks qualifyHome, so a stale
// decide candidate is a safe no-op). Travel to the plot, feed it WOOD (a pure
// commodity transfer — never minted gold), and accrue progress capped by the
// wood actually contributed. Drains labour (energy + tool wear) and emits a build
// deed that grows a Mason/Carpenter identity. Completion is detected + finalized
// in BuildSites.tick. Fully guarded — never throws on the tick (the freeze lesson).
export function buildStep(a, dt, ctx) {
  try {
    if (!a.canWork) { a.fighter.setMoving(0); return; }     // monsters/player never build
    // DEBT #2 RETIRED (Phase 2a): build state is reached ONLY through the EXECUTION facade
    // ctx.resolver.buildSite — buildStep names neither `ctx.buildSites` (a dynamic-state
    // handle banned on the cognition ctx) NOR `ctx.world` (geography routed via the facade's
    // nearestWood). buildStep IS execution (it runs in act(), which legitimately mutates the
    // truth-side site through the facade), exactly as marketStep consumes the market resolver.
    const rb = ctx.resolver && ctx.resolver.buildSite;
    if (!rb) { a.fighter.setMoving(0); return; }

    // resolve (or lazily commission) the committed site — an OPAQUE handle.
    const site = rb.resolve(a, ctx);
    if (!site) { a._buildSiteId = null; a.fighter.setMoving(0); return; }  // no room/at cap/unqualified
    const sitePos = rb.pos(site);
    if (!sitePos) { a.fighter.setMoving(0); return; }

    const inv = a.inventory || (a.inventory = {});

    // MATERIALS FIRST — the site is paid in WOOD. If the owner can't yet finish the
    // build with the wood it has IN HAND PLUS what's already on site, it must go FELL
    // WOOD: walk to the nearest forest and gather (wood is a RENEWABLE commodity — its
    // production mints wood, never gold, so the closed money loop is untouched). The forest
    // destination comes through the facade (nearestWood) so buildStep doesn't name ctx.world.
    // Guarded: no forest => just build with what's on hand (degrades gracefully).
    const owed = rb.woodOwed(site);                             // wood still owed to the site
    if (owed > 0 && (inv.wood || 0) < owed) {
      const forestPos = rb.nearestWood(a);
      if (forestPos) {
        if (!goTo(a, forestPos, dt)) return;                    // travelling to fell wood
        a.fighter.setMoving(0);                                 // at the forest — gather
        const boosted = (inv.tool || 0) >= 1;
        const gained = ECON.produceRate * (boosted ? ECON.toolBoost : 1) * dt;
        inv.wood = (inv.wood || 0) + gained;                    // renewable wood (no gold minted)
        a._produceAccum = (a._produceAccum || 0) + gained;
        while (a._produceAccum >= 1) {
          a._produceAccum -= 1;
          bus.emit(makeEvent({ actorId: a.id, verb: 'produce', tags: ['ENDURANCE'], magnitude: 1, t: a._rpgNow }));
        }
        return;                                                 // keep felling until stocked
      }
      // no forest reachable: fall through and build with whatever wood is on hand.
    }

    // travel to the plot — not there yet, keep walking (goTo halts on arrival).
    if (!goTo(a, sitePos, dt)) return;

    // ON THE PLOT — WOOD RESERVATION (closed money loop: a commodity transfer via the facade).
    rb.feedWood(a, site, site.woodNeeded);                     // contribute all carried wood

    // PROGRESS ACCRUAL — capped by the wood actually contributed (the facade clamps it), so
    // the owner must keep feeding wood (gathered/bought) to finish.
    a.fighter.setMoving(0);                                    // standing, building
    const adv = rb.advance(site, dt, ctx);
    if (adv > 0) {
      // labour cost: drain energy + wear a tool (both guarded/optional).
      a.needs.energy = clamp01((a.needs.energy ?? 1) - BUILD.staminaPerSec * dt);
      a.toolWear = (a.toolWear || 0) + BUILD.toolWearPerSec * dt;
      while (a.toolWear >= 1 && (inv.tool || 0) > 0) { a.toolWear -= 1; inv.tool -= 1; }
      // EMIT A DEED per whole unit of progress (grows [Mason]/[Survivor]); batched
      // so a slow build doesn't spam the bus every frame.
      a._buildAccum = (a._buildAccum || 0) + adv;
      while (a._buildAccum >= 0.2) {
        a._buildAccum -= 0.2;
        bus.emit(makeEvent({
          actorId: a.id, verb: 'build',
          tags: ['BUILD', 'CRAFTING', 'ENDURANCE'], magnitude: 1, t: a._rpgNow,
        }));
      }
    }
    // COMPLETION is detected + finalized in BuildSites.tick (progress >= 1).
  } catch { a.fighter.setMoving(0); }   // never throw on the tick (freeze lesson)
}

// close on a believed-hostile target and trade directional blows (reuses the
// Fighter swing state machine, telegraphed like the old enemy AI).
export function combatStep(a, dt, ctx) {
  const f = a.fighter;
  a._attackCd -= dt;
  a._castCd -= dt;
  // ACTIVE PERCEPTION of the engaged target: while I can SEE it, my belief about where it
  // is tracks it continuously (I'm watching my opponent) — so the belief I act on stays
  // fresh and I can actually catch a fleeing foe. Out of sight, the belief FREEZES at
  // last-seen and I swing where I last saw it. This is vision-gated perception (truth →
  // belief), so the split holds: I still ACT only on the belief below. It refreshes only
  // POSITION/faction of a real, visible agent — a misidentified prop (a scarecrow has no
  // agent to find here) is never "corrected", so the identity mistake fully persists.
  // This goes through the RESOLVER's vision-gated perception (truth in → belief out, the
  // sanctioned bridge): cognition never holds the roster, so it can't read an arbitrary
  // entity — it can only ask "if I can see my target, refresh my belief of it".
  const seenThisTick = ctx.resolver && ctx.resolver.perceive
    ? !!ctx.resolver.perceive(a, a.goal.targetId)   // re-acquired by sight -> belief refreshed
    : false;
  // BELIEF-GATED: act on where I BELIEVE the threat is, never its true position. The fight
  // target is a belief subject; I close on, face and swing at that believed spot, and
  // reality — perception (in) + geometric combat (out) — decides what, if anything, is
  // actually struck. A belief faded below the act threshold means I've lost track → break
  // off. No true-object deref here, so the "target" may be a foe that moved, a corpse, or a
  // SCARECROW — and nothing in this path assumes otherwise.
  const b = a.beliefs.get(a.goal.targetId);
  if (!b || b.confidence < SIM.actOnBeliefMin) { a.goal = { kind: 'wander' }; return; }
  // DESTINATION-INTENT PURSUIT (Theory of Mind, not dead-reckoning): when the belief is
  // FRESH (just sighted, high confidence) I close on the last SIGHTING (lastPos). When it
  // has gone STALE (out of sight, confidence below reacquireConf) I navigate instead to the
  // INFERRED DESTINATION the quarry is presumed making for (a static geography point
  // inferred from its last heading) — I cut it off there. resolver.perceive re-acquires it
  // (resetting lastPos + clearing destPos) the moment it comes back into sight. If it never
  // reappears the belief decays and I break off (the lost-quarry case above).
  let tpos = b.lastPos;
  if (!seenThisTick && b.confidence < (SIM.reacquireConf ?? 0.75) && b.destPos) tpos = b.destPos;
  // territorial predators break off a chase that strays beyond their leash (believed pos).
  if (a.homeAnchor && a.homeAnchor.distanceTo(tpos) > (a.leashR || 50)) { a.goal = { kind: 'wander' }; return; }
  const dx = tpos.x - a.pos.x, dz = tpos.z - a.pos.z;
  const dist = Math.hypot(dx, dz);
  f.setFacing(Math.atan2(-dx, -dz));
  const reach = 2.2;
  // NPC ability casting: a spec resolves on a real Agent, so casting requires the target
  // to actually BE a perceived live agent (ctx.agentsById). A belief about a non-agent
  // (a scarecrow, a phantom) simply can't be cast at — the MELEE swing below still lands
  // geometrically on whatever body is there. Guarded: ability-less / no-real-target -> no-op.
  if (a._castCd <= 0) {
    a._castCd = 0.4 + Math.random() * 0.4;
    // a spec resolves on a REAL body, so casting requires the target to be a perceived
    // live agent — the resolver returns it ONLY when vision-confirmed (a belief about a
    // scarecrow returns null and simply can't be cast at; the melee swing below still
    // lands geometrically on whatever body is actually there).
    const realTarget = ctx.resolver ? ctx.resolver.castTarget(a, a.goal.targetId) : null;
    if (realTarget) tryCastAbility(a, realTarget, dist, ctx);
  }
  if (dist > reach) {
    if (f.state !== 'attack' && f.state !== 'stagger') {
      // speedMul lets a NEMESIS boss outrun fleeing prey (a relentless hunter you
      // can't simply outrun — so a hero has to STAND and fight it); 1 for everyone else.
      const sp = SIM.runSpeed * (a.speedMul || 1);
      const px = a.pos.x, pz = a.pos.z;
      a.pos.x += (dx / dist) * sp * dt; a.pos.z += (dz / dist) * sp * dt;
      const r = Math.hypot(a.pos.x, a.pos.z);
      if (r > ARENA_RADIUS) { a.pos.x *= ARENA_RADIUS / r; a.pos.z *= ARENA_RADIUS / r; }
      collideWalls(a.pos, px, pz);   // a chaser can't barge through the wall (it stops at it)
      f.setMoving(sp);
    }
  } else {
    f.setMoving(0);
    if (a._releaseTimer > 0) {
      a._releaseTimer -= dt;
      if (a._releaseTimer <= 0 && f.state === 'ready') f.release();
    } else if (a._attackCd <= 0 && f.canAct() && f.state !== 'block') {
      f.ready(randDir());
      a._releaseTimer = 0.35 + Math.random() * 0.25;
      a._attackCd = 1.3 + Math.random() * 1.2;
    }
  }
}

// --- NPC ability casting -----------------------------------------------------
// Try to bring an OFFENSIVE ability to bear on `target`, at `dist` meters. Picks
// the best ready offensive spec (interpreter owns cooldowns) and either fires it
// through castSpec (ranged/instant) or arms fighter.pendingSpec (melee, so the
// existing swing routes the damage via combat.js). Everything is guarded so the
// fixed tick can NEVER throw on an ability-less / ctx-less / dead-target agent
// (the freeze lesson). Returns true if a spec was cast or armed.
export function tryCastAbility(a, target, dist, ctx) {
  try {
    // `target` is a RESOLVER-confirmed live body (vision-gated, supplied by combatStep via
    // ctx.resolver.castTarget) — casting a spec is geometric EXECUTION on a real agent.
    if (!ctx || !target || !target.alive || !a.abilities || a.abilities.size === 0) return false;   // EPISTEMIC-OK: resolver vision-confirmed cast target (execution)
    const f = a.fighter;
    if (!f || !f.alive) return false;
    const now = ctx.time || 0;
    const spec = bestOffensiveAbility(a, dist, now);
    if (!spec) return false;
    // MELEE specs ride the swing: only commit when the body is free to start one
    // and isn't already carrying a spec, so castSpec's cooldown burn maps 1:1 to
    // an actual armed swing. The interpreter's melee branch arms pendingSpec,
    // sets the cooldown, and emits the cast event; combat.js applies the damage.
    if (isMelee(spec) && (f.pendingSpec || !f.canAct() || f.state === 'block')) return false;
    // EXECUTION: the interpreter resolves area/range targets over the TRUE roster — a
    // geometric reach, like combat — so it runs through the resolver's cast bridge (which
    // hands castSpec the full sim ctx). Cognition never holds the roster the interpreter
    // scans. Re-validates, owns the cooldown, dispatches ranged/instant/area, arms melee
    // onto pendingSpec. False on no-op. Melee specs (no roster scan needed) still fall
    // back to a direct cast if no resolver is present (e.g. the player's direct cast path).
    if (ctx.resolver && ctx.resolver.cast) return ctx.resolver.cast(spec, a);
    return castSpec(spec, a, ctx);
  } catch { return false; }   // never throw on the tick
}

// Pick the best READY offensive spec for the current engagement. Offensive =
// an enemy/any-targeted spec carrying a hostile effect (damage/stun/slow/
// knockback). At range we prefer NON-melee reach (projectile/area/instant ranged)
// that can actually hit; adjacent we prefer melee. Ties break on damage. Ready =
// off the interpreter cooldown. Returns a validated catalog/generated spec or null.
export function bestOffensiveAbility(a, dist, now) {
  let best = null, bestScore = -Infinity;
  for (const spec of a.abilities.values()) {
    if (!spec || !spec.header) continue;
    const tgt = spec.header.target;
    if (tgt !== 'enemy' && tgt !== 'any') continue;       // not an attack
    const dmg = offensivePower(spec);
    if (dmg <= 0) continue;                                // no hostile effect
    if (onCooldown(a, spec, now)) continue;             // still recharging
    const melee = isMelee(spec);
    // can this spec actually reach the target from here?
    const reach = melee ? Math.max(spec.header.range, 2.2)
      : Math.max(spec.header.range, spec.header.area.r || 0, spec.header.area.len || 0);
    if (dist > reach + 0.001) continue;                    // out of range -> skip
    // prefer the delivery suited to the gap: ranged when target is beyond melee,
    // melee when adjacent. Otherwise score on raw offensive power.
    let score = dmg;
    const adjacent = dist <= 2.4;
    if (adjacent) { if (melee) score += 1000; }
    else { if (!melee) score += 1000; }
    if (score > bestScore) { bestScore = score; best = spec; }
  }
  return best;
}

// A spec's offensive weight: its damage amount, plus a small credit for control
// effects (stun/slow/knockback) so a pure-control spec still counts as an attack.
export function offensivePower(spec) {
  let p = 0;
  for (const e of spec.effects || []) {
    if (e.op === 'damage') p += Math.max(0, e.amount || 0);
    else if (e.op === 'stun' || e.op === 'slow' || e.op === 'knockback') p += 1 + (e.dur || 0);
  }
  return p;
}

// --- plan-step execution (Phase 2) ------------------------------------------
// Run the current primitive of the top goal. Reuses the existing movement /
// produce / combat primitives and adds the genuinely-new give/pay TRANSFERS
// (which only MOVE value — the closed money loop stays intact). When the step
// effect holds, advance the step pointer; when the goal predicate is true, pop
// it and record a closure memory. Guarded; never throws on the tick.
export function execPlanStep(a, dt, ctx) {
  const goal = a.goals[a.goals.length - 1];
  const step = a.goal.step;
  if (!goal || !step) { a.fighter.setMoving(0); return; }
  try {
    execPrimitive(a, step, dt, ctx);
    // advance when this step's effect has landed in believed state
    if (stepEffectHolds(a, ctx, step) && goal.plan) {
      if (goal.step === undefined) goal.step = 0;
      // only advance if we're still on the same step (planStep is the cached one)
      if (goal.plan.steps[goal.step] === step) goal.step++;
    }
    // goal complete? pop + closure memory (memory <-> goals feedback) + the
    // narrative-beat xp for fulfilling a lived arc (PHASE 1; same award as the
    // reactive pruneGoals closure so it's uniform however the goal resolved).
    if (typeof goal.predicate === 'function' && goal.predicate(a, ctx)) {
      a.goals.pop();
      if (a.memory) a.memory.record({
        t: ctx.time, kind: goal.kind === 'avenge' ? 'triumph' : 'closure',
        withId: goal.subjectId, valence: 1, salience: 0.5,
      });
      awardGoalClosureXP(a, goal, ctx.time, 0.5);
    }
  } catch { a.fighter.setMoving(0); }
}

export function execPrimitive(a, step, dt, ctx) {
  const b = step.bind || {};
  switch (step.exec ? step.exec.verb : step.prim) {
    case 'goto': {
      const tp = stepTargetPos(a, ctx, b.place);
      if (tp) goTo(a, tp, dt); else a.fighter.setMoving(0);
      break;
    }
    case 'attack': {
      // BELIEF-GATED: a confident belief about the target routes to combatStep (itself
      // fully belief-gated — closes on lastPos / inferred destination, re-acquires by
      // sight, casts on a vision-confirmed body). No belief / faded -> march to the last
      // believed spot. No roster read; the quarry may be a moved foe, a corpse, a scarecrow.
      const bel = a.beliefs.get(b.target);
      if (bel && bel.confidence >= SIM.actOnBeliefMin) { a.goal.targetId = b.target; combatStep(a, dt, ctx); }
      else {
        const tp = stepTargetPos(a, ctx, { subjectId: b.target });
        if (tp) goTo(a, tp, dt); else a.fighter.setMoving(0);
      }
      break;
    }
    case 'produce': produce(a, dt); break;
    case 'consume': {
      if ((a.inventory[b.item] || 0) >= 1 && a.needs.hunger < 1) {
        const amt = ECON.eatRate * dt;
        a.needs.hunger = clamp01(a.needs.hunger + amt);
        a.inventory[b.item] = Math.max(0, a.inventory[b.item] - amt);
      }
      a.fighter.setMoving(0);
      break;
    }
    case 'gather': {
      // gather a raw good at its node: move to the node, then accrue a unit.
      const good = b.good;
      if ((a.inventory[good] || 0) >= (b.n || 1)) { a.fighter.setMoving(0); break; }
      const node = ctx.world && ctx.world.nearest(b.site, a.pos);
      if (node && goTo(a, node.pos, dt)) {
        a.inventory[good] = (a.inventory[good] || 0) + (b.n || 1);
      }
      break;
    }
    case 'buy': case 'sell': marketStep(a, step, dt, ctx); break;
    case 'give': giveStep(a, b, dt, ctx); break;
    case 'pay':  payStep(a, b, dt, ctx); break;
    default: a.fighter.setMoving(0);
  }
}

// walk to the market, then trade ONE unit of the bind good against a willing townsperson
// there — the conserved clearing is performed by the EXECUTION resolver (marketClear),
// which finds the counterparty actually at the market POI and moves gold + goods between
// two real agents (never minting). The agent never reads cp.gold/pos/priceBeliefs.
export function marketStep(a, step, dt, ctx) {
  const b = step.bind || {};
  const m = ctx.world && ctx.world.nearest(POI_KIND.MARKET, a.pos);
  if (!m || !goTo(a, m.pos, dt)) return;          // still travelling
  a.fighter.setMoving(0);
  if (!ctx.resolver) return;
  ctx.resolver.marketClear(a, b.good, step.prim === 'buy');   // success/fail; replan next decide
}

// give item×n to a benefactor: walk to its BELIEVED position, then have the resolver MOVE
// the goods (conserved; fires the receiver's own succour/standing hook) and stamp _repaid
// so goalRepay's predicate fires. The giver never touches to.inventory/needs/beliefs.
export function giveStep(a, b, dt, ctx) {
  const n = b.n || 1, item = b.item;
  if ((a.inventory[item] || 0) < n) { a.fighter.setMoving(0); return; }   // lost the goods -> replan
  // attempt the conserved transfer FIRST — the resolver co-location-gates it, so a deliver
  // lands the moment we're at reach (and is a clean no-op otherwise). On success, stamp
  // _repaid so goalRepay's predicate fires.
  if (ctx.resolver && ctx.resolver.deliverTo(a, b.to, { item, n })) { a._repaid[b.to] = true; a.fighter.setMoving(0); return; }
  // not yet at reach: walk toward where I BELIEVE the receiver is (belief lastPos). No
  // belief -> I don't know where to go (idle; decide re-routes).
  const tp = stepTargetPos(a, ctx, { subjectId: b.to });
  if (tp) goTo(a, tp, dt); else a.fighter.setMoving(0);
}

// pay amt coin to a benefactor: walk to its BELIEVED position, then have the resolver MOVE
// the gold (conserved; fires the receiver's own succour/standing hook inside the sim).
// The payer never touches to.gold/needs/beliefs.
export function payStep(a, b, dt, ctx) {
  const amt = b.amt || 1;
  if ((a.gold || 0) < amt) { a.fighter.setMoving(0); return; }   // lost the coin -> replan
  if (ctx.resolver && ctx.resolver.deliverTo(a, b.to, { gold: amt })) { a._repaid[b.to] = true; a.fighter.setMoving(0); return; }
  const tp = stepTargetPos(a, ctx, { subjectId: b.to });
  if (tp) goTo(a, tp, dt); else a.fighter.setMoving(0);
}
