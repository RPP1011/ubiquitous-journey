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
import { GOODS, ECON, SIM, SOCIAL, BAND, BUILD, COMFORT, NOVELTY, RECIPES, CAUTION, ROMANCE , ALMS, GRANARY } from '../simconfig.js';
import { castSpec, onCooldown } from '../../rpg/abilities/interpreter.js';
import { isMelee } from '../../rpg/abilities/ir.js';
import { bus, makeEvent } from '../../rpg/events.js';
import { awardGoalClosureXP } from '../motivation.js';
import { stepTargetPos, stepEffectHolds } from '../planner.js';
import { goTo, groundY } from './movement.js';
import { steer, STEER_FILLS } from './steer.js';
import { rng } from '../rng.js';
import { registerExecutor, runExecutor, runPlanOutcome } from '../exec/registry.js';
import { classifyYield } from '../experience.js';
import { masteryMul } from './occupation.js';
import { collideWalls } from '../walls.js';
import type {
  Agent, CognitionCtx, PlanStep, PlanBind, Goal, EntityId, AbilitySpec, FighterDir, ActionEventSpec, ActionEvent,
} from '../../../types/sim.js';

type OutcomeStatus = 'shortfall' | 'neutral' | 'windfall' | 'peril' | 'waste';

// events.js infers makeEvent's `tags=[]` default as never[]; retype to its real spec.
const mkEvent = makeEvent as (spec: ActionEventSpec) => ActionEvent;
// simconfig GOODS inferred without an index signature (allowJs).
const GOODS_T = GOODS as Record<string, { inputs: Record<string, number> | null; site: string; raw: boolean; tags: string[] } | undefined>;

// Map a producer's commodity output -> the behavior tags the deed earns. There
// is no per-commodity tag in the RPG vocabulary, so produced goods map to the
// gather/craft identity that makes them (sourced from GOODS). A chosen
// occupation thus steers which class the agent builds.
const OUTPUT_TAGS: Record<string, string[]> = Object.fromEntries(
  Object.keys(GOODS).map((g) => [g, GOODS_T[g]!.tags])
);

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const DIRS: FighterDir[] = [DIR.UP, DIR.DOWN, DIR.LEFT, DIR.RIGHT];
const randDir = (): FighterDir => DIRS[(rng() * 4) | 0];

// resolveLeaderRef + the follow locomotion moved to steer.js (fillFollow) in Phase 2b:
// follow is now a steer-fill (formation-slot attractor + snapTo teleport), dispatched
// through steer() like every other locomotion behaviour.

// --- act ---------------------------------------------------------------------
export function act(a: Agent, dt: number, ctx: CognitionCtx): void {
  if (!a.alive || a.controlled) return;
  // CAPTIVE (the rescue arc): a held captive does not act — it stands fast where its captor left
  // it (no work, no wander, no flight). Only `free` (its bonds cut) lifts `_held`.
  if (a._held) { a.fighter.setMoving(0); a._updateLabel(); return; }
  a.priceGossip(ctx, dt);
  // drink a remedy when badly hurt — keeps a recurring demand for potions
  if (a.fighter.health < TUNE.maxHealth * 0.5 && (a.inventory.potion || 0) >= 1) {
    a.inventory.potion -= 1;
    a.fighter.health = Math.min(TUNE.maxHealth, a.fighter.health + 45);
  }

  // DISPATCH (Phase 2b — the steering substrate). The locomotion-shaped goal.kinds
  // are DATA: a steer-fill (in steer.js) returns the {attractors/repulsors/speed}
  // force-field for that behaviour from beliefs/map/own-state, and the single steer()
  // executor moves the body. The on-arrival/in-place VERB stays EXPLICIT here, fired
  // on the boolean steer() returns (locomotion is a field; world-interactions are
  // verbs — the doc's hard caution). The genuinely-special executors (plan/fight/spy/
  // build, the multi-tick state machines, and the not-yet-migrated locomotion kinds)
  // stay dispatched, not table-filled, and fall through to the shared epilogue below.
  // a null goal (e.g. a captive whose decide deferred this tick, then was freed mid-frame so the
  // _held standstill above no longer caught it) idles — never dispatch on a missing goal (freeze
  // lesson). The next cognition tick re-derives a real goal.
  const goal = a.goal;
  if (!goal) { a.fighter.setMoving(0); a._updateLabel(); return; }
  const k = goal.kind;
  if (k === 'plan') execPlanStep(a, dt, ctx);
  else if (k === 'fight') combatStep(a, dt, ctx);
  else if (k === 'spy') spyStep(a, dt, ctx);
  else if (k === 'build') buildStep(a, dt, ctx);
  else if (k === 'eat') {
    if (a.inventory.food > 0 && a.needs.hunger < 1) {
      const amt = ECON.eatRate * dt;
      a.needs.hunger = clamp01(a.needs.hunger + amt);
      a.inventory.food = Math.max(0, a.inventory.food - amt);
    }
    a.fighter.setMoving(0);
  }
  // --- MIGRATED locomotion kinds (Phase 2b steps 2-4): table-filled, motored by steer().
  // This now includes the Phase-2a SCHEMA DISPOSITIONS (flee/hide/shadow/avoid), collapsed
  // into XOR single-force steer-fills (fillFlee/fillHide/fillShadow/fillAvoid in steer.js).
  else {
    const fill = STEER_FILLS[k] || STEER_FILLS.wander;   // unknown kind -> wander (the old default)
    const field = fill(a, ctx);
    const arrived = field ? steer(a, field, dt) : (a.fighter.setMoving(0), false);
    // ON-ARRIVAL / IN-PLACE VERB — explicit, per behaviour, NEVER inside steer/a fill.
    if (k === 'beg' && arrived) {
      // BEGGING (alms): stand at the stalls and solicit — the resolver carries the plea to
      // bystanders' perceivable mailboxes (their _pleas); each decides FOR ITSELF off its own
      // altruism/kin/surplus (features/alms.js). Throttled; guarded; the beggar never touches
      // another agent — pure Inform, the recruiter-offer pattern.
      a.fighter.setMoving(0);
      try {
        const t = a._rpgNow || 0;
        if (ctx.resolver && ctx.resolver.solicitAlms && t - (a._lastSolicit || -Infinity) >= (ALMS.solicitEvery || 3)) {
          a._lastSolicit = t;
          ctx.resolver.solicitAlms(a);
        }
      } catch { /* never throw on the tick */ }
    } else if (k === 'granary' && arrived) {
      // THE PUBLIC LARDER: stand at the granary and draw ONE meal from civic stock — the
      // resolver co-location-gates and conserves the move (food tithed off market clears,
      // never gold). A bare larder is REMEMBERED on my own state (_granaryEmptyUntil), so
      // the next decide falls back to begging instead of haunting an empty store. Throttled;
      // guarded; the drawer never touches the building record itself — pure facade.
      a.fighter.setMoving(0);
      try {
        const t = a._rpgNow || 0;
        if (ctx.resolver && ctx.resolver.granaryDraw && t - (a._lastGranaryDraw || -Infinity) >= (GRANARY.drawEvery || 2)) {
          a._lastGranaryDraw = t;
          if (!ctx.resolver.granaryDraw(a)) a._granaryEmptyUntil = t + (GRANARY.emptyMemory || 45);
        }
      } catch { /* never throw on the tick */ }
    } else if (k === 'rest' && arrived) {
      a.needs.energy = clamp01(a.needs.energy + SIM.restRate * dt);
    } else if (k === 'work' && arrived) {
      produce(a, dt);
    } else if (k === 'comfort' && arrived) {
      // restore comfort; a tavern also tops up social (and feeds belonging warmth).
      a.needs.comfort = clamp01((a.needs.comfort ?? 1) + COMFORT.restoreRate * dt);
      if (goal.srcKind === 'tavern') {
        a.needs.social = clamp01(a.needs.social + COMFORT.tavernSocialRate * dt);
        a.life.social += COMFORT.tavernSocialRate * dt;   // tavern colocation feeds belonging
      }
    } else if (k === 'court' && arrived) {
      // STAR-CROSSED, ENACTED (docs/architecture/12 §8): lingering beside the believed sweetheart
      // deepens the bond (own belief) and feeds belonging — the lived courtship the arc narrates.
      const cid = (goal as { subjectId?: EntityId }).subjectId;
      if (cid != null) { const rb = a.beliefs.get(cid); if (rb) rb.standing = Math.min(1, (rb.standing || 0) + (ROMANCE.courtWarm || 0.02)); }
      a.needs.social = clamp01(a.needs.social + SIM.socializeRate * dt);
    } else if (k === 'socialize' && arrived) {
      a.needs.social = clamp01(a.needs.social + SIM.socializeRate * dt);
      a.life.social += SIM.socializeRate * dt;     // feeds the 'belonging' ambition
      // QUALITY TIME: deliberately standing beside this friend deepens the bond faster
      // than the incidental gossip-pass affinity. Belief-only (my own standing toward
      // them); capped like all familiarity warmth. Re-derive the friend belief here (the
      // same lookup fillSocialize used). PRESERVED EXACTLY: the old branch applied this
      // bond to ANY non-null `rel` on arrival (including arriving at the market fallback
      // with a below-knownConf rel), so the condition deliberately does NOT re-gate on
      // confidence — only the standing/hostility cap, as before.
      const rel = (goal.withId != null) ? a.beliefs.get(goal.withId) : null;
      if (rel && !rel.hostile && rel.standing >= 0)
        rel.standing = Math.min(BAND.affinityCap, rel.standing + SOCIAL.bondBonus * dt);
    } else if (k === 'sightsee' && arrived) {
      // the PRIMARY payoff: relieve boredom (the NOVELTY need). A fresh sight tops it up.
      a.needs.novelty = clamp01((a.needs.novelty ?? 1) + NOVELTY.restore * dt);
      // a little comfort + society too — a pleasant outing lightly serves those needs.
      a.needs.comfort = clamp01((a.needs.comfort ?? 1) + COMFORT.restoreRate * dt * 0.5);
      a.needs.social = clamp01(a.needs.social + SIM.socializeRate * dt * 0.3);
      a.life.social += SIM.socializeRate * dt * 0.3;   // a touch of belonging
      // hold at the sight until boredom is genuinely topped up, THEN pick a fresh one
      // (so it doesn't bounce off the instant it arrives). Wanderlust feeds via life.dist.
      if ((a.needs.novelty ?? 1) >= NOVELTY.satisfiedAt) a.sightTarget = null;
    } else if (k === 'hide' && arrived) {
      a.fighter.setMoving(0);   // go to ground: stand still at the concealing place
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

// SIGHTSEE (leisure variety) is now a steer-fill (fillSightsee in steer.js): it picks
// among the few NEAREST landmarks and walks there; the on-arrival novelty/comfort/social
// restore + sightTarget reset are the explicit verb in act()'s dispatch (Phase 2b).

// SPY locomotion (intrigue): an infiltrator under cover SCOUTS toward the town
// core (origin/market) to whisper a planted rumour, then EXFILTRATES back to its
// camp anchor. The Intrigue subsystem does the planting and flips a.spy.phase to
// 'exfil'; here we just drive the body. On reaching the camp it resets to 'scout'
// for another run. Fully guarded — a spy with no camp anchor simply edges toward
// the core (still infiltrating), never throwing on the tick.
function spyStep(a: Agent, dt: number, _ctx: CognitionCtx): void {
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
    const jx = (rng() - 0.5) * 6, jz = (rng() - 0.5) * 6;
    S.scoutTarget = new THREE.Vector3(jx, a.pos.y, jz);
  }
  goTo(a, S.scoutTarget!, dt, true);
}

// --- controlled execution (the single avatar the player drives) -------------
// The controlled agent does NOT run decide()/act(); the Commander sets .goal
// from mouse orders and calls this each frame. We reuse the very same movement
// and combat primitives the NPC AI uses, so the body behaves consistently and
// there's no second combat path to keep in sync.
export function actControlled(a: Agent, dt: number, ctx: CognitionCtx): void {
  if (!a.alive) return;
  const goal = a.goal!;
  switch (goal.kind) {
    case 'fight': combatStep(a, dt, ctx); break;
    case 'goto': {
      // a controlled GOTO is a single-attractor steer to the ordered target; arrival
      // (or a missing target) drops back to idle. steer() faces/arrives/clamps exactly
      // as the old goTo did (same shared stepper). A goto target is a POSITION (Vector3).
      const t = goal.target as { x: number; z: number } | undefined;
      const field = t ? { attractors: [{ pos: t, weight: 1 }], run: goal.run } : null;
      if (!field || steer(a, field, dt)) a.goal = { kind: 'idle' };
      break;
    }
    case 'approach': {
      // the player's controlled body walks to a SEEN target (vision-gated via the
      // resolver, which returns a position snapshot, not the live object). Lost from
      // sight -> idle. Reads no roster handle. steer() handles the walk + arrival halt;
      // arrival sets the `arrived` flag (talkRange-gated below, not steer's arriveDist).
      const sp = (ctx.resolver && goal.targetId != null) ? ctx.resolver.seenPos(a, goal.targetId) : null;
      if (!sp) { a.goal = { kind: 'idle' }; break; }
      if (a.pos.distanceTo(sp as unknown as THREE.Vector3) <= SIM.talkRange) { a.fighter.setMoving(0); goal.arrived = true; }
      else steer(a, { attractors: [{ pos: sp, weight: 1 }] }, dt);
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
export function produce(a: Agent, dt: number): void {
  const output = a._trade;
  const g = output ? GOODS_T[output] : null;
  if (!g || !output) { a.fighter.setMoving(0); return; }
  const inv = a.inventory;
  a.fighter.setMoving(0);
  // INCREASING RETURNS TO MASTERY: a seasoned maker is far more productive at its craft —
  // it forges faster and gathers more per second, several-fold a novice. This is what lets
  // a master flood its field cheaply and makes it nearly impossible for a low-mastery unit
  // to compete there. 1.0 for a novice, growing uncapped with mastery for a grandmaster.
  const skillMul = masteryMul(a, output);
  if (g.inputs) {
    // RECIPE GATE (own-state): a crafted good is producible only if I KNOW its recipe.
    // ALWAYS-LIVE. Guarded for the freeze lesson: a professionless agent's `recipes` is an
    // empty Set (never undefined), and a missing field still can't throw. No event emitted, no
    // timer touched — a silent no-op, so an un-taught maker simply idles and re-chooses next
    // decide (the learn/teach step that fills `recipes` supplies it).
    if (!(a.recipes && a.recipes.has(output))) {
      maybeRediscover(a, output, dt);     // Phase-4 stub: rate 0 on day one ⇒ never fires
      a.fighter.setMoving(0); return;
    }
    // crafted good: convert inputs -> output on the smithing timer
    const inputs = g.inputs;
    const has = Object.keys(inputs).every((c) => (inv[c] || 0) >= inputs[c]);
    if (has) {
      a._smithTimer += dt;
      if (a._smithTimer >= ECON.smithSecsPerTool / skillMul) {
        a._smithTimer = 0;
        for (const c in inputs) inv[c] -= inputs[c];
        if ((inv[output] || 0) < ECON.maxStack) inv[output] = (inv[output] || 0) + 1;
        a.mastery[output] = (a.mastery[output] || 0) + 1;   // practice deepens mastery
        // a crafted good is a discrete crafting deed
        bus.emit(mkEvent({
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
    bus.emit(mkEvent({
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

// SELF-REDISCOVERY (Phase-4 hook; STUB). A maker stuck without a recipe may, very slowly,
// re-invent it. Gated on RECIPES.rediscoverPerSec (0 on day one ⇒ this never adds a recipe,
// so the soak is byte-identical). Phase 4 raises the rate and emits an 'invention' Chronicle
// beat here. Fully guarded — never throws on the tick (the freeze lesson). The rate<=0
// early-return runs BEFORE any Math.random() draw, so day-one doesn't perturb the RNG stream.
function maybeRediscover(a: Agent, output: string, dt: number): void {
  try {
    const rate = (RECIPES && RECIPES.rediscoverPerSec) || 0;
    if (rate <= 0 || !a.recipes) return;
    if (rng() < rate * dt) a.recipes.add(output);   // Phase 4: + chronicle 'invention'
  } catch { /* never throw on the tick */ }
}

// THE MULTI-TICK CONSTRUCTION PROCESS (the execution half of Phase-1 buildings).
// Resolve the committed BuildSite (commission lazily here if the agent chose to
// build but holds no site yet — commission re-checks qualifyHome, so a stale
// decide candidate is a safe no-op). Travel to the plot, feed it WOOD (a pure
// commodity transfer — never minted gold), and accrue progress capped by the
// wood actually contributed. Drains labour (energy + tool wear) and emits a build
// deed that grows a Mason/Carpenter identity. Completion is detected + finalized
// in BuildSites.tick. Fully guarded — never throws on the tick (the freeze lesson).
export function buildStep(a: Agent, dt: number, ctx: CognitionCtx): void {
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
          bus.emit(mkEvent({ actorId: a.id, verb: 'produce', tags: ['ENDURANCE'], magnitude: 1, t: a._rpgNow }));
        }
        return;                                                 // keep felling until stocked
      }
      // no forest reachable: fall through and build with whatever wood is on hand.
    }

    // travel to the plot — not there yet, keep walking (goTo halts on arrival).
    if (!goTo(a, sitePos, dt)) return;

    // ON THE PLOT — WOOD RESERVATION (closed money loop: a commodity transfer via the facade).
    // site is an OPAQUE SiteHandle; woodNeeded is the one surface field the caller passes back.
    const woodNeeded = (site as { woodNeeded?: number }).woodNeeded;
    rb.feedWood(a, site, woodNeeded as number);                // contribute all carried wood

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
        bus.emit(mkEvent({
          actorId: a.id, verb: 'build',
          tags: ['BUILD', 'CRAFTING', 'ENDURANCE'], magnitude: 1, t: a._rpgNow,
        }));
      }
    }
    // COMPLETION is detected + finalized in BuildSites.tick (progress >= 1).
  } catch { a.fighter.setMoving(0); }   // never throw on the tick (freeze lesson)
}

// AMBITION FALL-BACK (Phase B1): a broken-off fight (no target / lost quarry / leash) reverts to
// the agent's OWN ambition standing activity rather than aimless wander — a frontier prowler keeps
// prowling, a craftsman heads back toward its bench — until the next decide() re-scores in full.
// Reads only own-state (the intent the ambition_goals deriver stamps, already actionable);
// monsters carry no intent and keep the old wander. Guarded; never throws (the freeze lesson).
function breakOffGoal(a: Agent): Goal {
  try { return { kind: a._ambitionIntent || 'wander' }; } catch { return { kind: 'wander' }; }
}

// close on a believed-hostile target and trade directional blows (reuses the
// Fighter swing state machine, telegraphed like the old enemy AI).
export function combatStep(a: Agent, dt: number, ctx: CognitionCtx): void {
  const f = a.fighter;
  const targetId = a.goal!.targetId;
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
  if (targetId == null) { a.goal = breakOffGoal(a); return; }
  const seenThisTick = ctx.resolver && ctx.resolver.perceive
    ? !!ctx.resolver.perceive(a, targetId)   // re-acquired by sight -> belief refreshed
    : false;
  // BELIEF-GATED: act on where I BELIEVE the threat is, never its true position. The fight
  // target is a belief subject; I close on, face and swing at that believed spot, and
  // reality — perception (in) + geometric combat (out) — decides what, if anything, is
  // actually struck. A belief faded below the act threshold means I've lost track → break
  // off. No true-object deref here, so the "target" may be a foe that moved, a corpse, or a
  // SCARECROW — and nothing in this path assumes otherwise.
  const b = a.beliefs.get(targetId);
  if (!b || b.confidence < SIM.actOnBeliefMin) { a.goal = breakOffGoal(a); return; }
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
  if (a.homeAnchor && a.homeAnchor.distanceTo(tpos) > (a.leashR || 50)) { a.goal = breakOffGoal(a); return; }
  const dx = tpos.x - a.pos.x, dz = tpos.z - a.pos.z;
  const dist = Math.hypot(dx, dz);
  f.setFacing(Math.atan2(-dx, -dz));
  const reach = 2.2;
  // NPC ability casting: a spec resolves on a real Agent, so casting requires the target
  // to actually BE a perceived live agent (ctx.agentsById). A belief about a non-agent
  // (a scarecrow, a phantom) simply can't be cast at — the MELEE swing below still lands
  // geometrically on whatever body is there. Guarded: ability-less / no-real-target -> no-op.
  if (a._castCd <= 0) {
    a._castCd = 0.4 + rng() * 0.4;
    // a spec resolves on a REAL body, so casting requires the target to be a perceived
    // live agent — the resolver returns it ONLY when vision-confirmed (a belief about a
    // scarecrow returns null and simply can't be cast at; the melee swing below still
    // lands geometrically on whatever body is actually there).
    const realTarget = ctx.resolver ? ctx.resolver.castTarget(a, targetId) : null;
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
      a._releaseTimer = 0.35 + rng() * 0.25;
      a._attackCd = 1.3 + rng() * 1.2;
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
export function tryCastAbility(a: Agent, target: Agent, dist: number, ctx: CognitionCtx): boolean {
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
export function bestOffensiveAbility(a: Agent, dist: number, now: number): AbilitySpec | null {
  let best: AbilitySpec | null = null, bestScore = -Infinity;
  for (const spec of a.abilities.values()) {
    if (!spec || !spec.header) continue;
    const tgt = spec.header.target;
    if (tgt !== 'enemy' && tgt !== 'any') continue;       // not an attack
    const dmg = offensivePower(spec);
    if (dmg <= 0) continue;                                // no hostile effect
    if (onCooldown(a, spec, now)) continue;             // still recharging
    const melee = isMelee(spec);
    // can this spec actually reach the target from here? area dims are union-shaped
    // (r on circle/cone, len on line) — read both loosely, defaulting to 0.
    const area = spec.header.area as { r?: number; len?: number };
    const reach = melee ? Math.max(spec.header.range, 2.2)
      : Math.max(spec.header.range, area.r || 0, area.len || 0);
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
export function offensivePower(spec: AbilitySpec): number {
  let p = 0;
  for (const e of spec.effects || []) {
    if (e.op === 'damage') p += Math.max(0, e.amount || 0);
    else if (e.op === 'stun' || e.op === 'slow' || e.op === 'knockback') p += 1 + (e.dur || 0);
  }
  return p;
}

// --- CAUTION emit sites (docs/architecture/11) ----------------------------------------------
// The execution-side bookkeeping that lets outcomes price strategies. A WATCHED step (burgle/rob/
// loot) is snapshotted at its start (own gold), marked `_acted` when the payoff site is reached
// (every watched executor is arrival-gated, so reach ⇒ the verb ran), then classified: shortfall/
// neutral/windfall by realized-vs-believed yield, or peril if the agent is frightened mid-act. A
// dropped watched step that was acted (interrupted before it landed) classifies too; one that was
// never reached costs nothing (re-planning is the engine's normal operation, never punished).
// ALWAYS-LIVE: invoked from execPlanStep every tick.

const cautionTouched = (step: PlanStep | undefined): boolean => !!step && CAUTION.watched.indexOf(step.prim) >= 0;
const threatened = (a: Agent): boolean => ((a.mood && a.mood.fear) || 0) >= (CAUTION.perilFear || 1);

// the believed payoff position of a watched act (stash place / mark / corpse).
function cautionTargetPos(a: Agent, ctx: CognitionCtx, step: PlanStep): THREE.Vector3 | null {
  const b = step.bind || {};
  if (b.place != null) return stepTargetPos(a, ctx, b.place);
  const id = (b.target != null ? b.target : (b.corpse != null ? b.corpse : null)) as EntityId | null;
  return id != null ? stepTargetPos(a, ctx, { subjectId: id }) : null;
}

const expectedYield = (step: PlanStep): number => {
  if (step.prim === 'loot') return 1;
  const amt = (step.bind || {}).amt;
  return (typeof amt === 'number' && amt > 0) ? amt : 0;     // burgle/rob: the believed haul
};

// fire the handlers, mark the step resolved (de-dup) + close the goal's caution trail.
function cautionEmit(a: Agent, ctx: CognitionCtx, step: PlanStep, goal: Goal | null | undefined, status: OutcomeStatus, expected?: number, realized?: number): void {
  step._emitted = true;
  if (goal && goal._cautionTrail && goal._cautionTrail.step === step) goal._cautionTrail.resolved = true;
  a._cautionStep = null; a._cautionGoal = null;
  runPlanOutcome(a, ctx, { status, step, expected, realized });
}

// pre-exec: a watched step that JUST stopped being current (re-plan/preemption) is resolved if it had
// been acted (peril when threatened, else an interrupted-heist shortfall); an unreached one costs
// nothing. Then snapshot the current watched step (own gold = the realized-delta anchor).
function cautionPre(a: Agent, ctx: CognitionCtx, goal: Goal, step: PlanStep): void {
  const prev = a._cautionStep;
  if (prev && prev !== step && !prev._emitted) {
    if (prev._acted) cautionEmit(a, ctx, prev, a._cautionGoal, threatened(a) ? 'peril' : 'shortfall');
    a._cautionStep = null; a._cautionGoal = null;
  }
  if (!cautionTouched(step)) return;
  if (goal._cautionTrail && goal._cautionTrail.resolved) { step._emitted = true; return; }   // venture already settled
  if (!step._snap) {
    step._snap = { gold: a.gold || 0, t0: ctx.time };
    step._acted = false; step._emitted = false;
    goal._cautionTrail = { step, acted: false, resolved: false };
  }
  a._cautionStep = step; a._cautionGoal = goal;
}

// post-exec (the executor ran this tick): mark reached, then resolve. Peril pre-empts a yield read
// (the night nearly cost you); else reaching the site ⇒ the act ran ⇒ classify its realized yield.
function cautionPost(a: Agent, ctx: CognitionCtx, goal: Goal, step: PlanStep): void {
  if (!cautionTouched(step) || !step._snap || step._emitted) return;
  const tp = cautionTargetPos(a, ctx, step);
  if (tp && a.pos.distanceTo(tp) <= (SIM.arriveDist || 1.5) + 0.5) {
    step._acted = true;
    if (goal._cautionTrail && goal._cautionTrail.step === step) goal._cautionTrail.acted = true;
  }
  if (threatened(a)) { cautionEmit(a, ctx, step, goal, 'peril'); return; }
  if (!step._acted) return;                                  // still travelling — nothing resolved yet
  const expected = expectedYield(step);
  const realized = (a.gold || 0) - step._snap.gold;
  cautionEmit(a, ctx, step, goal, classifyYield(expected, realized), expected, realized);
}

// --- plan-step execution (Phase 2) ------------------------------------------
// Run the current primitive of the top goal. Reuses the existing movement /
// produce / combat primitives and adds the genuinely-new give/pay TRANSFERS
// (which only MOVE value — the closed money loop stays intact). When the step
// effect holds, advance the step pointer; when the goal predicate is true, pop
// it and record a closure memory. Guarded; never throws on the tick.
export function execPlanStep(a: Agent, dt: number, ctx: CognitionCtx): void {
  const goal = a.goals[a.goals.length - 1];
  // a.goal is the committed 'plan' goal: its `step` is the injected PlanStep candidate
  // (decide pushes { step: planStep }), distinct from the stack goal's numeric pointer.
  const step = a.goal!.step as PlanStep | undefined;
  if (!goal || !step) { a.fighter.setMoving(0); return; }
  try {
    cautionPre(a, ctx, goal, step);   // snapshot watched step / classify a dropped one
    execPrimitive(a, step, dt, ctx);
    cautionPost(a, ctx, goal, step);  // reached & acted ⇒ classify yield; threatened ⇒ peril
    // advance when this step's effect has landed in believed state
    if (stepEffectHolds(a, ctx, step) && goal.plan) {
      if (goal.step === undefined) goal.step = 0;
      // only advance if we're still on the same step (planStep is the cached one)
      const ptr = (typeof goal.step === 'number') ? goal.step : 0;
      if (goal.plan.steps[ptr] === step) goal.step = ptr + 1;
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

// Run a plan step's verb (VERBS ARE DATA): dispatch through the executor REGISTRY — the verb tag
// is data, the executor is the code it binds to (docs/architecture/10). An unregistered verb idles
// (exactly the old switch `default`). Feature modules register their own verbs from their own file.
export function execPrimitive(a: Agent, step: PlanStep, dt: number, ctx: CognitionCtx): void {
  const verb = step.exec ? step.exec.verb : step.prim;
  if (!runExecutor(verb, a, step, dt, ctx)) a.fighter.setMoving(0);
}

// --- base verb registrations (the rows the planner's core actions dispatch to) ---------------
// Registered as DATA into the executor registry at module load, so there is no hand-grown switch.
// Each closure is the world-interaction the verb performs on arrival; behaviour is verbatim the
// old switch arms. The referenced helpers (produce/marketStep/giveStep/payStep/combatStep) are
// hoisted function declarations, so registering here (below execPrimitive) is safe.
registerExecutor('goto', (a, step, dt, ctx) => {
  // single-attractor steer to the believed/static step target (walk); null target → idle.
  const tp = stepTargetPos(a, ctx, (step.bind || {}).place);
  if (tp) steer(a, { attractors: [{ pos: tp }] }, dt); else a.fighter.setMoving(0);
});
registerExecutor('attack', (a, step, dt, ctx) => {
  // BELIEF-GATED: a confident belief routes to combatStep (belief-gated); else march to the last
  // believed spot. No roster read — the quarry may be a moved foe, a corpse, a scarecrow.
  const b = step.bind || {};
  const bel = b.target != null ? a.beliefs.get(b.target) : null;
  if (bel && bel.confidence >= SIM.actOnBeliefMin) { a.goal!.targetId = b.target; combatStep(a, dt, ctx); }
  else { const tp = stepTargetPos(a, ctx, { subjectId: b.target }); if (tp) steer(a, { attractors: [{ pos: tp }] }, dt); else a.fighter.setMoving(0); }
});
registerExecutor('produce', (a, _step, dt) => { produce(a, dt); });
registerExecutor('consume', (a, step, dt) => {
  const item = (step.bind || {}).item;
  if (item && (a.inventory[item] || 0) >= 1 && a.needs.hunger < 1) {
    const amt = ECON.eatRate * dt;
    a.needs.hunger = clamp01(a.needs.hunger + amt);
    a.inventory[item] = Math.max(0, a.inventory[item] - amt);
  }
  a.fighter.setMoving(0);
});
registerExecutor('gather', (a, step, dt, ctx) => {
  // gather a raw good at its node: move to the node, then accrue a unit.
  const b = step.bind || {}; const good = b.good;
  if (!good || !b.site) { a.fighter.setMoving(0); return; }
  if ((a.inventory[good] || 0) >= (b.n || 1)) { a.fighter.setMoving(0); return; }
  const node = ctx.world && ctx.world.nearest(b.site, a.pos);
  if (node && goTo(a, node.pos, dt)) a.inventory[good] = (a.inventory[good] || 0) + (b.n || 1);
});
const marketExec: (a: Agent, step: PlanStep, dt: number, ctx: CognitionCtx) => void = (a, step, dt, ctx) => marketStep(a, step, dt, ctx);
registerExecutor('buy', marketExec);
registerExecutor('sell', marketExec);
registerExecutor('give', (a, step, dt, ctx) => giveStep(a, step.bind || {}, dt, ctx));
registerExecutor('pay', (a, step, dt, ctx) => payStep(a, step.bind || {}, dt, ctx));
registerExecutor('hold', (a, step, dt, ctx) => {
  // WAIT (Phase 4): hold at the safe/hidden spot; the plan advances (stepEffectHolds) when the
  // waited-for condition becomes believed-true. Walk to cover if not there yet, else wait.
  const tp = stepTargetPos(a, ctx, (step.bind || {}).place);
  if (tp && a.pos.distanceTo(tp) > (SIM.arriveDist || 1.5)) steer(a, { attractors: [{ pos: tp }] }, dt);
  else a.fighter.setMoving(0);
});

// walk to the market, then trade ONE unit of the bind good against a willing townsperson
// there — the conserved clearing is performed by the EXECUTION resolver (marketClear),
// which finds the counterparty actually at the market POI and moves gold + goods between
// two real agents (never minting). The agent never reads cp.gold/pos/priceBeliefs.
export function marketStep(a: Agent, step: PlanStep, dt: number, ctx: CognitionCtx): void {
  const b = step.bind || {};
  const m = ctx.world && ctx.world.nearest(POI_KIND.MARKET, a.pos);
  if (!m || !goTo(a, m.pos, dt)) return;          // still travelling
  a.fighter.setMoving(0);
  if (!ctx.resolver || !b.good) return;
  ctx.resolver.marketClear(a, b.good, step.prim === 'buy');   // success/fail; replan next decide
}

// give item×n to a benefactor: walk to its BELIEVED position, then have the resolver MOVE
// the goods (conserved; fires the receiver's own succour/standing hook) and stamp _repaid
// so goalRepay's predicate fires. The giver never touches to.inventory/needs/beliefs.
export function giveStep(a: Agent, b: PlanBind, dt: number, ctx: CognitionCtx): void {
  const n = b.n || 1, item = b.item, to = b.to;
  if (item == null || to == null) { a.fighter.setMoving(0); return; }
  if ((a.inventory[item] || 0) < n) { a.fighter.setMoving(0); return; }   // lost the goods -> replan
  // attempt the conserved transfer FIRST — the resolver co-location-gates it, so a deliver
  // lands the moment we're at reach (and is a clean no-op otherwise). On success, stamp
  // _repaid so goalRepay's predicate fires.
  if (ctx.resolver && ctx.resolver.deliverTo(a, to, { item, n })) { a._repaid[to] = true; a.fighter.setMoving(0); return; }
  // not yet at reach: walk toward where I BELIEVE the receiver is (belief lastPos). No
  // belief -> I don't know where to go (idle; decide re-routes).
  const tp = stepTargetPos(a, ctx, { subjectId: to });
  if (tp) goTo(a, tp, dt); else a.fighter.setMoving(0);
}

// pay amt coin to a benefactor: walk to its BELIEVED position, then have the resolver MOVE
// the gold (conserved; fires the receiver's own succour/standing hook inside the sim).
// The payer never touches to.gold/needs/beliefs.
export function payStep(a: Agent, b: PlanBind, dt: number, ctx: CognitionCtx): void {
  const amt = b.amt || 1, to = b.to;
  if (to == null) { a.fighter.setMoving(0); return; }
  if ((a.gold || 0) < amt) { a.fighter.setMoving(0); return; }   // lost the coin -> replan
  if (ctx.resolver && ctx.resolver.deliverTo(a, to, { gold: amt })) { a._repaid[to] = true; a.fighter.setMoving(0); return; }
  const tp = stepTargetPos(a, ctx, { subjectId: to });
  if (tp) goTo(a, tp, dt); else a.fighter.setMoving(0);
}
