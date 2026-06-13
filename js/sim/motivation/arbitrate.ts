// THE ARBITER (docs/architecture/17 §5) — the un-fused decide() candidate scorer, re-hosted as a
// DATA TABLE of motivation rows over a single shared scratch. Each row is the short-term impetus
// behind one candidate behaviour; arbitrate() collects every eligible row's score, applies the same
// ambition/cohesion/hysteresis phases decide() does, and returns the winning goal — WITHOUT committing
// it (the caller commits). It is the behaviour-equivalent twin of agent/decide.ts `scoreAndSelect`,
// verified tick-for-tick by the shadow check below before it ever drives the sim.
//
// WHY A SHARED SCRATCH: decide()'s scorer threads computed context (enemy/inDanger/laborValue/the
// believed friend/comfort source) across its candidates. Rows that each recomputed it would risk
// drift; instead arbitrate computes the scratch ONCE (mirroring scoreAndSelect's locals) and every
// row reads it — so the row table is identical-by-construction, not a re-derivation.
//
// The role-guard early-returns + the side-effecting passes (updateAmbition/deriveGoals/pruneGoals/
// _currentPlanStep) stay in decide() (the pre-phase, §5); arbitrate is pure SELECTION and never
// re-runs them — it reads the `planStep` decide already computed.

import {
  SIM, WEIGHT, ECON, COMMODITIES, GROUP_TYPES, SOCIAL, COMFORT, NOVELTY, BUILD,
  ROMANCE, MOTIVE, ALMS, GRANARY, MIGRATE,
} from '../simconfig.js';
import { ambitionFavor, ambitionWantsFight } from '../motivation.js';
import { laborValue } from '../agent/occupation.js';
import { qualifyHome, isUnhoused } from '../construction.js';
import {
  pickSocialTarget, pickSuspectToAvoid, ambitionDrive, topAmbitionGoal, nearestComfortSource,
} from '../agent/decide.js';
import type { Agent, CognitionCtx, Goal, PlanStep, EntityId } from '../../../types/sim.js';
import type { Vector3 } from 'three';

const GROUP_TYPES_T = GROUP_TYPES as Record<string, { cohesion?: string; combatant?: boolean; pull?: number } | undefined>;
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** A scored utility candidate (spread into the chosen goal), exactly as decide()'s Candidate. */
interface Candidate { kind: string; score: number; [k: string]: unknown }

/** The shared, once-computed context every row reads — mirrors scoreAndSelect's locals. */
interface Scratch {
  inDanger: boolean;
  brave: boolean;
  tethered: boolean;
  enemyId: EntityId | null;
  lv: number;                         // laborValue(a) — computed once
  friend: EntityId | null;            // pickSocialTarget(a) — once
  src: { pos: Vector3; kind: string } | null;  // nearestComfortSource — once
  avoidPos: { x: number; z: number } | null;                    // pickSuspectToAvoid — once
  sellLoad: number;
}

/** One motivation row: the short-term impetus behind a candidate. `gen` returns the scored candidate
 *  (kind + score + extras) or null when ineligible / score≤0. Reads the agent + the shared scratch. */
interface Row {
  key: string;
  primitive: string;                  // the physical act it drives (P2 un-fuses; informational in P1)
  serves: 'goal' | 'need' | 'ambition' | 'reflex';
  gen(a: Agent, ctx: CognitionCtx, sc: Scratch): Candidate | null;
}

// Helper: a candidate only if score>0 (the push>0 gate), else null.
const c = (kind: string, score: number, extra?: Record<string, unknown>): Candidate | null =>
  score > 0 ? { kind, score, ...extra } : null;

// THE ROW TABLE — in the SAME order scoreAndSelect pushes, so tie-breaking (argmax keeps the earlier
// equal) is identical. Each gen is the verbatim expression from scoreAndSelect over the shared scratch.
const ROWS: Row[] = [
  // ── survival (belief-only hostile) ──
  { key: 'fight', primitive: 'strike', serves: 'reflex', gen(a, _ctx, sc) {
    if (sc.enemyId == null || !sc.brave || sc.tethered) return null;
    return c('fight', WEIGHT.fight * (0.4 + a.personality.risk_tolerance) + a.mood.anger, { targetId: sc.enemyId });
  } },
  { key: 'flee', primitive: 'locomote', serves: 'reflex', gen(a, _ctx, sc) {
    if (sc.enemyId == null || a.combatant || !sc.inDanger) return null;
    return c('flee', WEIGHT.flee * (1.2 - a.personality.risk_tolerance) + a.mood.fear + 0.5, { fromId: sc.enemyId });
  } },

  // ── economic / life scheduling (canWork && !inDanger) ──
  { key: 'eat', primitive: 'consume', serves: 'need', gen(a, _ctx, sc) {
    if (!a.canWork || sc.inDanger) return null;
    const inv = a.inventory;
    if (!(inv.food > 0.05)) return null;
    const hungry = inv.food > 0.05 && a.needs.hunger < (ECON.eatUrgent || 0.4);
    return c('eat', hungry ? WEIGHT.eat * 1.8 : Math.pow(1 - a.needs.hunger, 1.5) * WEIGHT.eat);
  } },
  { key: 'work', primitive: 'produce', serves: 'ambition', gen(a, _ctx, sc) {
    if (!a.canWork || sc.inDanger || hungryNow(a)) return null;
    const inv = a.inventory, P = a.personality;
    const goldNeed = clamp01(1 - a.gold / 30);
    const made = a._trade ? (inv[a._trade] || 0) : 0;
    const overstock = clamp01(made / ECON.maxStack);
    const wealthMotive = (0.5 + 0.5 * goldNeed) * sc.lv;
    const motive = Math.max(ECON.workIntrinsicFloor * P.ambition, wealthMotive);
    return c('work', WEIGHT.work * (0.4 + P.ambition) * motive * (1 - 0.7 * overstock));
  } },
  { key: 'rest', primitive: 'locomote', serves: 'need', gen(a, _ctx, sc) {
    if (!a.canWork || sc.inDanger || hungryNow(a)) return null;
    return c('rest', Math.pow(1 - a.needs.energy, 1.5) * WEIGHT.rest);
  } },
  { key: 'socialize', primitive: 'locomote', serves: 'need', gen(a, _ctx, sc) {
    if (!a.canWork || sc.inDanger || hungryNow(a)) return null;
    const P = a.personality;
    const friend = sc.friend;
    const friendPull = friend != null ? 1.25 : 1;
    return c('socialize', (1 - a.needs.social) * (0.5 + P.social_drive) * WEIGHT.socialize * friendPull,
      friend != null ? { withId: friend } : undefined);
  } },
  { key: 'court', primitive: 'locomote', serves: 'goal', gen(a, _ctx, sc) {
    if (!a.canWork || sc.inDanger || hungryNow(a)) return null;
    if (a._courtingId == null) return null;
    const lb = a.beliefs.get(a._courtingId);
    if (!(lb && lb.confidence >= SIM.actOnBeliefMin)) return null;
    return c('court', (0.5 + (a.personality.risk_tolerance || 0)) * ROMANCE.weight, { subjectId: a._courtingId });
  } },
  { key: 'sightsee', primitive: 'locomote', serves: 'need', gen(a, _ctx, sc) {
    if (!a.canWork || sc.inDanger || hungryNow(a)) return null;
    if (!(NOVELTY.enabled && a.needs.novelty < NOVELTY.seekBelow)) return null;
    return c('sightsee', (1 - a.needs.novelty) * WEIGHT.sightsee * (0.4 + a.personality.curiosity) * (0.7 + 0.5 * (1 - sc.lv)));
  } },
  { key: 'market', primitive: 'locomote', serves: 'need', gen(a, _ctx, sc) {   // haul/buy (canWork)
    if (!a.canWork || sc.inDanger || hungryNow(a)) return null;
    const inv = a.inventory;
    const outOfFood = (inv.food || 0) < 1;
    const outOfTool = (inv.tool || 0) < 1 && a.gold >= 2;
    if (!(sc.sellLoad >= ECON.haulLoad || outOfFood || outOfTool)) return null;
    const urgency = Math.min(2, sc.sellLoad / (ECON.haulLoad || 5)) + (outOfFood ? 0.8 : 0) + (outOfTool ? 0.5 : 0);
    return c('market', WEIGHT.market * (0.6 + urgency));
  } },
  { key: 'comfort', primitive: 'locomote', serves: 'need', gen(a, _ctx, sc) {
    if (!a.canWork || sc.inDanger || hungryNow(a)) return null;
    const seeking = a.goal && a.goal.kind === 'comfort';
    const comfortCeil = seeking ? COMFORT.satisfiedAt : COMFORT.seekBelow;
    if (!(COMFORT.enabled && a.needs.comfort < comfortCeil)) return null;
    let cBase = (1 - a.needs.comfort) * WEIGHT.comfort;
    if (a._migrating) cBase *= (MIGRATE.roadHardship || 0.55);
    if (a.needs.hunger < (ECON.nibbleBelow || 0.25)) cBase *= 0.3;
    if (a.needs.comfort < (COMFORT.urgentBelow || 0)) cBase *= (COMFORT.urgentBoost || 1);
    const src = sc.src;
    if (!src) return null;
    let cs = cBase;
    if (seeking) {
      cs *= (a.pos.distanceTo(src.pos) <= (SIM.arriveDist || 1.5) + 1)
        ? (COMFORT.dwellBoost || 1) : (COMFORT.seekBoost || 1);
    }
    return c('comfort', cs, { toPos: { x: src.pos.x, z: src.pos.z }, srcKind: src.kind });
  } },
  { key: 'build', primitive: 'build', serves: 'goal', gen(a, ctx, sc) {
    if (!a.canWork || sc.inDanger || hungryNow(a)) return null;
    if (BUILD.enabled && qualifyHome(a, ctx)) {
      return c('build', WEIGHT.build * (1.4 + 0.4 * a.personality.ambition));
    } else if (BUILD.enabled && a._buildSiteId != null && isUnhoused(a)) {
      return c('build', WEIGHT.build * 1.8);
    }
    return null;
  } },

  // ── survival provisioning for the professionless (!canWork) ──
  { key: 'eat', primitive: 'consume', serves: 'need', gen(a, _ctx, sc) {   // !canWork eat
    if (a.canWork || sc.inDanger || a.faction !== 'townsfolk' || !a.autonomous) return null;
    const inv = a.inventory;
    if (!(inv.food > 0.05)) return null;
    const hungry = inv.food > 0.05 && a.needs.hunger < (ECON.eatUrgent || 0.4);
    return c('eat', hungry ? WEIGHT.eat * 1.8 : Math.pow(1 - a.needs.hunger, 1.5) * WEIGHT.eat);
  } },
  { key: 'market', primitive: 'locomote', serves: 'need', gen(a, _ctx, sc) {   // !canWork provision
    if (a.canWork || sc.inDanger || a.faction !== 'townsfolk' || !a.autonomous) return null;
    if (!((a.inventory.food || 0) < 1 && a.gold >= 1)) return null;
    return c('market', WEIGHT.market * (0.4 + 1.2 * (1 - a.needs.hunger)));
  } },

  // ── begging / the public larder (destitute) ──
  { key: 'beg', primitive: 'solicit', serves: 'need', gen(a, _ctx, sc) {
    if (!destitute(a, sc)) return null;
    return c('beg', ALMS.begWeight * (0.5 + (1 - a.needs.hunger)));
  } },
  { key: 'granary', primitive: 'locomote', serves: 'need', gen(a, ctx, sc) {
    if (!destitute(a, sc)) return null;
    if (!(a._granaryEmptyUntil == null || ctx.time >= a._granaryEmptyUntil)) return null;
    const lp = ctx.map && ctx.map.nearest(['larder'], a.pos, a.townId);
    if (!lp) return null;
    let gw = ALMS.begWeight * (0.5 + (1 - a.needs.hunger)) + (GRANARY.drawBump || 0.05);
    if (a.needs.hunger < (ECON.nibbleBelow || 0.25)) gw = Math.max(gw, GRANARY.urgentWeight || 1.6);
    return c('granary', gw, { toPos: { x: lp.pos.x, z: lp.pos.z } });
  } },

  // ── soft avoidance / wander / migrate ──
  { key: 'avoid', primitive: 'locomote', serves: 'reflex', gen(a, _ctx, sc) {
    if (sc.inDanger || !sc.avoidPos) return null;
    return c('avoid', SOCIAL.avoidWeight, { around: sc.avoidPos });
  } },
  { key: 'wander', primitive: 'locomote', serves: 'reflex', gen(a, _ctx, sc) {
    if (sc.inDanger) return null;
    return c('wander', WEIGHT.wander * (0.6 + a.personality.curiosity));
  } },
  { key: 'migrate', primitive: 'locomote', serves: 'goal', gen(a, _ctx, sc) {
    if (sc.inDanger || !a._migrating) return null;
    return c('migrate', WEIGHT.migrate, { toPos: { x: a._migrating.x, z: a._migrating.z } });
  } },
];

// the canWork-branch `hungry` gate, shared by work/rest/socialize/court/sightsee/market/comfort/build.
function hungryNow(a: Agent): boolean {
  return a.inventory.food > 0.05 && a.needs.hunger < (ECON.eatUrgent || 0.4);
}
// the destitute gate shared by beg + granary.
function destitute(a: Agent, sc: Scratch): boolean {
  return !sc.inDanger && !!a.townsperson && a.faction === 'townsfolk' && !!a.autonomous &&
    (a.inventory.food || 0) < 0.05 && (a.gold || 0) < 1 && a.needs.hunger < (ECON.eatUrgent || 0.45);
}

// Compute the shared scratch ONCE (mirrors scoreAndSelect's locals up to the candidate pushes).
function computeScratch(a: Agent, ctx: CognitionCtx): Scratch {
  const enemy = a._nearestHostile(ctx);
  let inDanger = false, brave = false, tethered = false;
  let enemyId: EntityId | null = null;
  if (enemy) {
    enemyId = enemy.id;
    const dist = a.pos.distanceTo(enemy.pos);
    const committed = a.goal?.kind === 'flee' || a.goal?.kind === 'fight';
    inDanger = dist <= SIM.dangerRange || (committed && dist <= SIM.safeRange);
    brave = !!a.combatant || ambitionWantsFight(a);
    tethered = !!a.homeAnchor && a.homeAnchor.distanceTo(enemy.pos) > (a.leashR || 50);
  }
  let sellLoad = 0;
  for (const cm of COMMODITIES) sellLoad += a.sellQty(cm);
  return {
    inDanger, brave, tethered, enemyId,
    lv: laborValue(a),
    friend: pickSocialTarget(a),
    src: nearestComfortSource(a, ctx),
    avoidPos: pickSuspectToAvoid(a),
    sellLoad,
  };
}

/** Re-host of scoreAndSelect: score the row table over a shared scratch, apply the ambition/cohesion/
 *  hysteresis phases, return the winning goal. Does NOT commit (caller assigns a.goal). Side-effect-free
 *  apart from `a._mScratch` (overwritten each call; an inspector convenience). */
export function arbitrate(a: Agent, ctx: CognitionCtx, planStep: PlanStep | null): Goal {
  const sc = computeScratch(a, ctx);
  (a as { _mScratch?: Scratch })._mScratch = sc;

  const cand: Candidate[] = [];
  let avoiding = false;
  for (const row of ROWS) {
    const got = row.gen(a, ctx, sc);
    if (got) { cand.push(got); if (got.kind === 'avoid') avoiding = true; }
  }

  // ambition tilt: scale every collected candidate by its per-kind favour.
  for (const cc of cand) cc.score *= ambitionFavor(a, cc.kind);

  // AMBITION-ACTIVITY (pushed AFTER the favour loop, so NOT double-scaled; clamped below WEIGHT.plan).
  if (!sc.inDanger && !avoiding) {
    const ak = topAmbitionGoal(a);
    const provisioned = !(ak && ak.kind === 'seek_glory' && (a.inventory.food || 0) < 1);
    if (ak && provisioned) {
      const s = Math.min(WEIGHT.ambition * (MOTIVE.ambitionDriveFloor + ambitionDrive(a)), WEIGHT.plan - 0.05);
      if (s > 0) cand.push({ kind: ak.kind, score: s, ...(ak.extra || {}) });
    }
  }

  // PLAN STEP candidate (after the ambition tilt, so not double-scaled).
  if (planStep) cand.push({ kind: 'plan', score: WEIGHT.plan, step: planStep });

  // LOOSE-GROUP COHESION post-phase: mutate the socialize/work candidates in place (not new rows).
  const gt = a.groupType ? GROUP_TYPES_T[a.groupType] : null;
  if (gt && !a.inParty && gt.cohesion === 'loose') {
    const pull = gt.pull || 1.6;
    const hb = (a.groupHallId != null) ? a.beliefs.get(a.groupHallId) : null;
    const hallPos = (hb && hb.sheltered !== false && hb.lastPos && hb.confidence >= SIM.actOnBeliefMin)
      ? { x: hb.lastPos.x, z: hb.lastPos.z } : null;
    for (const cc of cand) {
      if (cc.kind === 'socialize') {
        cc.score *= (a.groupType === 'circle' ? pull : 1.6);
        if (hallPos) { cc.toPos = hallPos; cc.withId = null; }
        else if (a.groupType === 'circle' && cc.withId == null && a.bandLeaderId != null) {
          const ab = a.beliefs.get(a.bandLeaderId);
          if (ab && ab.confidence >= SIM.actOnBeliefMin) cc.withId = a.bandLeaderId;
        }
      } else if (cc.kind === 'work' && a.groupType === 'guild') cc.score *= pull;
    }
  }

  // argmax with the +18% incumbent-kind hysteresis (a.goal still holds the PREVIOUS goal here).
  const prevKind = a.goal ? a.goal.kind : undefined;
  let best: Candidate | undefined = cand[0];
  for (const cc of cand) {
    const eff = cc.kind === prevKind ? cc.score * 1.18 : cc.score;
    const bestEff = best && best.kind === prevKind ? best.score * 1.18 : (best ? best.score : -Infinity);
    if (eff > bestEff) best = cc;
  }
  return best ? (best as unknown as Goal) : { kind: a.canWork ? 'work' : 'wander' };
}

// ── SHADOW VERIFICATION (docs/architecture/17 P1) ──────────────────────────────────────────────────
// Run arbitrate() alongside the live scoreAndSelect() and tally where the chosen `kind` diverges, WITHOUT
// driving the sim. Off by default (one boolean check on the hot path; byte-identical behaviour when off).
// The soak shadow test flips it on, runs a full town, and asserts divergence ≤ ε before any swap.
let _shadowOn = false;
let _total = 0, _diverge = 0;
const _samples: Array<{ live: string; row: string }> = [];

export function setShadow(on: boolean): void { _shadowOn = on; _total = 0; _diverge = 0; _samples.length = 0; }
export function shadowStats(): { total: number; diverge: number; rate: number; samples: ReadonlyArray<{ live: string; row: string }> } {
  return { total: _total, diverge: _diverge, rate: _total ? _diverge / _total : 0, samples: _samples };
}

/** Called from decide() right after scoreAndSelect, BEFORE the commit (so a.goal still holds the prev
 *  goal — matching the hysteresis input). No-op when shadowing is off. Never throws. */
export function shadowCheck(a: Agent, ctx: CognitionCtx, planStep: PlanStep | null, liveKind: string): void {
  if (!_shadowOn) return;
  try {
    const w = arbitrate(a, ctx, planStep);
    _total++;
    if (w.kind !== liveKind) {
      _diverge++;
      if (_samples.length < 40) _samples.push({ live: liveKind, row: w.kind });
    }
  } catch { /* never throw on the tick */ }
}
