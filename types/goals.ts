// The goal / GOAP layer: motivation derives goals (js/sim/motivation.js), the planner
// plans toward them over BELIEFS (js/sim/planner.js). Goals read beliefs only.

import type { Vector3 } from 'three';
import type { EntityId, Vec2Like } from './core.js';

/** The goal kinds the motivation/decide/act/schema layers emit. */
export type GoalKind =
  | 'work' | 'wander' | 'eat' | 'rest' | 'socialize' | 'market' | 'comfort'
  | 'build' | 'sightsee' | 'flee' | 'fight' | 'follow' | 'plan' | 'spy'
  | 'bounty' | 'arbitrage' | 'expedition' | 'caravan' | 'reporter' | 'avenge'
  | 'grieve' | 'repay' | 'seek_fortune' | 'delve' | 'defeat' | 'avoid'
  | 'hide' | 'shadow' | 'goto' | 'approach' | 'idle'
  | (string & {});   // open: derived/variant kinds may appear

/** One world-state predicate atom the planner satisfies (js/sim/planner.js Atom). */
export interface Atom {
  pred: 'at' | 'have' | 'gold_ge' | 'received' | 'dead' | 'in_reach' | 'know_assoc' | 'need_ge' | 'know' | 'hold_until' | 'force_ge' | 'freed' | 'wrecked';
  place?: string;
  good?: string;
  n?: number;
  amt?: number;
  subjectId?: EntityId;
  value?: number;
  kind?: string;
  need?: string;     // need_ge: which need (hunger/energy/…) the threshold is on
  level?: number;    // need_ge: the believed need-level to reach (graded, 0..1)
  topic?: KnowTopic; // know: the proposition to be known (docs/architecture/10 knowledge model)
  cond?: Atom;       // hold_until: the believed condition to wait for (advance when it holds)
  deadline?: number; // hold_until: sim-time by which the window must open, else abandon
}

/** A `topic` an agent can Know — a specific proposition with a HOME (a belief-table field for
 *  facts about others, or own-state for a recipe). docs/architecture/10 "The knowledge model". */
export interface KnowTopic {
  kind: 'loc' | 'whereabouts' | 'price' | 'recipe' | 'strength' | 'secret' | 'state';
  subjectId?: EntityId;   // loc / whereabouts / secret: which person
  place?: string;         // loc role ('stash') / strength / state: which place
  good?: string;          // price / recipe: which good
  attribute?: string;     // state: which place-attribute (depleted/infected/closed/sheltered)
}

/** The concrete parameters a primitive chose when its effect unified with a subgoal. */
export interface PlanBind {
  place?: string;
  good?: string;
  n?: number;
  site?: string;
  price?: number;
  inputs?: Record<string, number> | null;
  item?: string;
  to?: EntityId;
  amt?: number;
  target?: EntityId;
  corpse?: EntityId;
  fromStock?: boolean;
  best?: string;
  _conf?: number;               // CAUTION (doc 11 §5): plan-time confidence the watched bet leans on (attribution)
  [k: string]: unknown;
}

/** One primitive step of a plan ({ prim, bind, exec }). `exec` is executor METADATA
 *  (the verb the act() executor fires on arrival) — NOT a callable. */
export interface PlanStep {
  prim: string;                 // 'goto'|'gather'|'produce'|'buy'|'sell'|'give'|'pay'|…
  bind: PlanBind;
  exec?: { verb: string; [k: string]: unknown };
  // CAUTION (doc 11 §4) — act.ts emit-site bookkeeping on a WATCHED step. Written only when
  // CAUTION.enabled, so off ⇒ these stay undefined and the path is byte-identical.
  _snap?: { gold: number; t0: number };   // own gold at the act's start (the realized-delta anchor)
  _acted?: boolean;                        // reached the payoff site (⇒ the verb actually ran)
  _emitted?: boolean;                      // this step already resolved an outcome (de-dup guard)
}

/** A cached plan on a goal: an ordered primitive list + total cost. `partial` marks a
 *  SATISFICE — the best plan the agent could reach toward a numeric threshold it cannot
 *  fully meet (docs/architecture/10, Phase 1); `shortfall` is how far the believed total
 *  still falls short. A partial plan runs (earns what it can), then the goal cools down. */
export interface Plan {
  steps: PlanStep[];
  cost: number;
  partial?: boolean;
  shortfall?: number;
}

/** A motivation goal. `kind` is the discriminator; variant-specific fields are loose (the
 *  field set overlaps messily across kinds — survey flagged target: Vector3 | number). */
export interface Goal {
  kind: GoalKind;
  subjectId?: EntityId;
  targetId?: EntityId;
  target?: Vector3 | EntityId;
  toPos?: Vec2Like | null;
  around?: Vec2Like | null;
  toward?: Vec2Like | null;     // a Gazette/bounty march destination (own-state point)
  fromId?: EntityId;            // flee: the believed-threat subject to run from
  withId?: EntityId;            // socialize: the believed-friend to seek
  phase?: string;               // spy goal phase mirror
  arrived?: boolean;            // controlled approach: reached talk range
  run?: boolean;                // controlled goto: run vs walk
  place?: string;
  affords?: string[];
  srcKind?: string;
  atoms?: Atom[];
  plan?: Plan | null;
  step?: number | PlanStep;     // numeric stack pointer OR the injected plan-candidate step
  bornAt?: number;
  expiresAt?: number;
  predicate?: (agent: unknown, ctx: unknown) => boolean;
  _unreachable?: boolean;
  _cooldownUntil?: number;      // sim-time before which an unreachable threshold goal won't re-plan
  _cautionTrail?: { step: PlanStep; acted: boolean; resolved: boolean };  // CAUTION (doc 11 §4.4): the venture's life, for the waste emit at goal-end
  [k: string]: unknown;
}

/** A persistent drive (js/sim/motivation.js): one per Agent, no-op for the player. */
export interface Ambition {
  kind: string;                 // 'wealth'|'mastery'|'renown'|'wander'|'belong'|…
  label: string;
  base: Record<string, number>; // snapshot baseline for cumulative progress
  progress: number;             // 0..1
  t0: number;
  revenge: boolean;
  targetId?: EntityId;          // a specific believed SUBJECT bound to this ambition (e.g. a rival-to-surpass); narration-only
  targetPlace?: string;         // a specific place bound to this ambition (e.g. a frontier to roam); narration-only
}

/** The compact ambition view surfaced to UI/biography (motivation.ambitionSnapshot). */
export interface AmbitionSnapshot {
  label: string;
  progress: number;
  revenge: boolean;
}
