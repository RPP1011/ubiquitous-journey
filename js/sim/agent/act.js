// Agent action layer — the execution half of the epistemic split: act reads the
// agent's already-decided goal and drives the body through GROUND TRUTH (move,
// produce, fight, cast, trade, transfer). Extracted from Agent as free functions
// over a passed agent instance. Builds on the locomotion primitives in
// movement.js (one-directional: movement <- act). Behaviour-preserving: verbatim
// bodies of the old Agent methods. No cycles — imports config, pure helpers, the
// ability interpreter, the rpg event bus, and movement only.

import * as THREE from 'three';
import { DIR, TUNE } from '../../constants.js';
import { ARENA_RADIUS } from '../../arena.js';
import { POI_KIND } from '../world.js';
import { GOODS, ECON, SIM, MOTIVE, SOCIAL, BAND, BUILD, COMFORT } from '../simconfig.js';
import { BUILD_KIND } from '../construction.js';
import { castSpec, onCooldown } from '../../rpg/abilities/interpreter.js';
import { isMelee } from '../../rpg/abilities/ir.js';
import { bus, makeEvent } from '../../rpg/events.js';
import { awardGoalClosureXP } from '../motivation.js';
import { stepTargetPos, stepEffectHolds } from '../planner.js';
import { goTo, fleeFrom, followLeader } from './movement.js';
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
    case 'follow': followLeader(a, a._leader(ctx), dt); break;
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
    case 'flee':  fleeFrom(a, ctx.agentsById.get(a.goal.fromId), dt); break;
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
      // walk to my home or a tavern and restore comfort; a tavern also tops up
      // social (and feeds the existing belonging/colocation warmth). Walk-through
      // benefit zone — no collision. Guarded so a missing source just idles.
      const src = a.home || (ctx.buildSites && ctx.buildSites.nearest(BUILD_KIND.TAVERN, a.pos));
      if (src && goTo(a, src.pos, dt)) {
        const isTavern = src.kind === BUILD_KIND.TAVERN;
        a.needs.comfort = clamp01((a.needs.comfort ?? 1) + COMFORT.restoreRate * dt);
        if (isTavern) {
          a.needs.social = clamp01(a.needs.social + COMFORT.tavernSocialRate * dt);
          a.life.social += COMFORT.tavernSocialRate * dt;   // tavern colocation feeds belonging
        }
      } else if (!src) { a.fighter.setMoving(0); }           // no comfort source known: idle (decide re-routes)
      break;
    }
    case 'build': buildStep(a, dt, ctx); break;
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
  a._updateLabel();
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
      const o = ctx.agentsById.get(a.goal.targetId);
      if (!o || !o.alive) { a.goal = { kind: 'idle' }; break; }
      if (a.pos.distanceTo(o.pos) <= SIM.talkRange) { a.fighter.setMoving(0); a.goal.arrived = true; }
      else goTo(a, o.pos, dt);
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
  if (g.inputs) {
    // crafted good: convert inputs -> output on the smithing timer
    const has = Object.keys(g.inputs).every((c) => (inv[c] || 0) >= g.inputs[c]);
    if (has) {
      a._smithTimer += dt;
      if (a._smithTimer >= ECON.smithSecsPerTool) {
        a._smithTimer = 0;
        for (const c in g.inputs) inv[c] -= g.inputs[c];
        if ((inv[output] || 0) < ECON.maxStack) inv[output] = (inv[output] || 0) + 1;
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
  const gained = ECON.produceRate * (boosted ? ECON.toolBoost : 1) * dt;
  inv[output] = (inv[output] || 0) + gained;
  // emit ONE produce ActionEvent per whole unit accumulated, tagged by output
  a._produceAccum += gained;
  while (a._produceAccum >= 1) {
    a._produceAccum -= 1;
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
    const bs = ctx.buildSites;
    if (!bs) { a.fighter.setMoving(0); return; }

    // resolve (or lazily commission) the committed site.
    let site = (a._buildSiteId != null) ? bs.siteById(a._buildSiteId) : null;
    if (!site) {
      site = bs.commission(a, ctx);                          // re-checks qualifyHome internally
      if (!site) {                                            // no room / at cap / unqualified
        a._buildSiteId = null;
        a.fighter.setMoving(0);                              // brief idle; decide re-routes next tick
        return;
      }
    }

    const inv = a.inventory || (a.inventory = {});

    // MATERIALS FIRST — the site is paid in WOOD. If the owner can't yet finish the
    // build with the wood it has IN HAND PLUS what's already on site, it must go FELL
    // WOOD: walk to the nearest forest and gather (wood is a RENEWABLE commodity — its
    // production mints wood, never gold, so the closed money loop is untouched). This
    // is what makes an organic build actually COMPLETE instead of stalling at whatever
    // wood the owner happened to be carrying. Guarded: no forest => just build with
    // what's on hand (degrades gracefully).
    const needTotal = site.woodNeeded - site.woodHave;          // wood still owed to the site
    if (needTotal > 0 && (inv.wood || 0) < needTotal && ctx.world) {
      const forest = ctx.world.nearest(POI_KIND.FOREST, a.pos);
      if (forest) {
        if (!goTo(a, forest.pos, dt)) return;                   // travelling to fell wood
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
    if (!goTo(a, site.pos, dt)) return;

    // ON THE PLOT — WOOD RESERVATION (closed money loop: a commodity transfer).
    // The owner contributes its own wood into the site (no gold moves here).
    while (site.woodHave < site.woodNeeded && (inv.wood || 0) > 0) {
      inv.wood -= 1; site.woodHave += 1;                     // pure commodity transfer (no mint)
    }

    // PROGRESS ACCRUAL — capped by the wood actually contributed, so the owner
    // must keep feeding wood (gathered/bought) to finish.
    a.fighter.setMoving(0);                                   // standing, building
    const woodCap = site.woodHave / (site.woodNeeded || 1);
    const inc = BUILD.progressPerSec * dt;
    const next = Math.min(woodCap, site.progress + inc);
    if (next > site.progress) {
      const adv = next - site.progress;
      site.progress = next;
      site.lastProgressAt = ctx.time;
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
  const target = ctx.agentsById.get(a.goal.targetId);
  if (!target || !target.alive) { a.goal = { kind: 'wander' }; return; }
  // territorial predators break off a chase that strays beyond their leash (they
  // turn back toward their lair/camp instead of pursuing a victim into the town).
  if (a.homeAnchor && a.homeAnchor.distanceTo(target.pos) > (a.leashR || 50)) { a.goal = { kind: 'wander' }; return; }
  const dx = target.pos.x - a.pos.x, dz = target.pos.z - a.pos.z;
  const dist = Math.hypot(dx, dz);
  f.setFacing(Math.atan2(-dx, -dz));
  const reach = 2.2;
  // NPC ability casting: when the reflex gap is up, try the best ready offensive
  // ability against this target. RANGED/instant specs fire immediately via the
  // interpreter; MELEE specs arm fighter.pendingSpec so the swing below routes
  // them (combat.js). Fully guarded: ability-less / dead-target -> no-op.
  if (a._castCd <= 0) { a._castCd = 0.4 + Math.random() * 0.4; tryCastAbility(a, target, dist, ctx); }
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
    if (!ctx || !target || !target.alive || !a.abilities || a.abilities.size === 0) return false;
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
    // castSpec re-validates, gates on + owns the interpreter cooldown, dispatches
    // ranged/instant/area directly and arms melee onto pendingSpec. False on no-op.
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
      const tp = stepTargetPos(a, ctx, { subjectId: b.target });
      const target = ctx.agentsById && ctx.agentsById.get(b.target);
      if (target && target.alive) { a.goal.targetId = b.target; combatStep(a, dt, ctx); }
      else if (tp) goTo(a, tp, dt);
      else a.fighter.setMoving(0);
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

// walk to the market, then trade ONE unit of the bind good against the nearest
// willing townsperson there (conservation-safe: applyBuy/applySell move gold +
// goods between two real agents, never minting). Belief-priced at the midpoint.
export function marketStep(a, step, dt, ctx) {
  const b = step.bind || {};
  const m = ctx.world && ctx.world.nearest(POI_KIND.MARKET, a.pos);
  if (!m || !goTo(a, m.pos, dt)) return;          // still travelling
  a.fighter.setMoving(0);
  const good = b.good;
  const buying = step.prim === 'buy';
  // find a counterparty at the market with the matching opposite intent
  let cp = null;
  for (const o of ctx.agents) {
    // any living townsperson (occupation is emergent now — no profession gate)
    if (o === a || !o.alive || o.controlled || o.faction === 'monster') continue;
    if (o.pos.distanceTo(m.pos) > SIM.talkRange) continue;
    if (buying ? o.sellQty(good) > 0 : (o.wantQty(good) > 0 && o.gold >= 1)) { cp = o; break; }
  }
  if (!cp) return;                                   // no counterparty this tick — wait/replan
  const price = +(((a.priceBeliefs[good] || 1) + (cp.priceBeliefs[good] || 1)) / 2).toFixed(2);
  if (buying) {
    if (a.gold < price) return;                   // precond lost -> replan next decide
    a.applyBuy(good, price); cp.applySell(good, price);
  } else {
    if (a.surplus(good) < 1 || cp.gold < price) return;
    a.applySell(good, price); cp.applyBuy(good, price);
  }
}

// give item×n to a benefactor: walk to its believed position, then MOVE the
// goods (no minting) and stamp _repaid so goalRepay's predicate fires.
export function giveStep(a, b, dt, ctx) {
  const to = ctx.agentsById && ctx.agentsById.get(b.to);
  const tp = stepTargetPos(a, ctx, { subjectId: b.to }) || (to && to.alive ? to.pos : null);
  if (!tp) { a.fighter.setMoving(0); return; }
  if (!goTo(a, tp, dt)) return;                    // still travelling
  a.fighter.setMoving(0);
  const n = b.n || 1, item = b.item;
  if ((a.inventory[item] || 0) < n) return;        // lost the goods -> replan
  if (!to || !to.alive) return;
  // succoured hook: a gift of food/sustenance to a DESPERATE receiver is formative
  // (recorded BEFORE the transfer lands, while the receiver is still in need).
  recordSuccour(a, to, item, ctx);
  a.inventory[item] -= n;
  to.inventory[item] = (to.inventory[item] || 0) + n; // closed loop: pure transfer
  a._repaid[b.to] = true;
  if (to.beliefs) { const rel = to.beliefs.get(a.id); if (rel) rel.standing = Math.min(1, rel.standing + 0.15); }
}

// record a `succoured` episode on a DESPERATE receiver (low food/hunger) when I
// hand it value — the kindness that deriveGoals lifts into a repay(me) goal.
// Guarded; never throws on the tick. (Same loop the closed economy relies on.)
export function recordSuccour(a, to, item, ctx) {
  try {
    if (!to || !to.memory || to.controlled) return;
    const hungry = (to.needs && to.needs.hunger <= MOTIVE.succourHunger) ||
      ((to.inventory && to.inventory.food) || 0) < 1;
    if (!hungry) return;
    const t = ctx ? ctx.time : 0;
    to.memory.record({ t, kind: 'succoured', withId: a.id, valence: 1, salience: 0.75 });
    to.memory._consolidate();   // make it derivable same-tick (salient reads MTM/LTM)
  } catch { /* never throw */ }
}

// pay amt coin to a benefactor: walk over, then MOVE gold (no minting).
export function payStep(a, b, dt, ctx) {
  const to = ctx.agentsById && ctx.agentsById.get(b.to);
  const tp = stepTargetPos(a, ctx, { subjectId: b.to }) || (to && to.alive ? to.pos : null);
  if (!tp) { a.fighter.setMoving(0); return; }
  if (!goTo(a, tp, dt)) return;
  a.fighter.setMoving(0);
  const amt = b.amt || 1;
  if ((a.gold || 0) < amt) return;                 // lost the coin -> replan
  if (!to || !to.alive) return;
  recordSuccour(a, to, 'coin', ctx);               // coin to a desperate soul also succours
  a.gold -= amt;
  to.gold = (to.gold || 0) + amt;                     // closed loop: pure transfer
  a._repaid[b.to] = true;
  if (to.beliefs) { const rel = to.beliefs.get(a.id); if (rel) rel.standing = Math.min(1, rel.standing + 0.15); }
}
