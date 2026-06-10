// THE EXECUTOR & DERIVER REGISTRIES (docs/architecture/10) — the data substrate that keeps
// VERBS AS DATA. The action grammar is data: actions are flat rows (effect / requirements / cost
// / verb), and the verb is a data TAG that binds a row to its executor. The executor is the one
// thing the doc says is genuinely code ("the variety lives in the executors; the actions above
// them stay uniform"). So the verb→executor binding is itself a DATA structure — this map —
// dispatched by lookup, never a hand-grown switch. Adding a behaviour = REGISTERING a row here,
// not editing control flow. This mirrors the sim's existing data-driven style (PRIMITIVES,
// STEER_FILLS, the EFFECTS op-map, the schema catalogue), and it is what lets the feature
// executors live in disjoint files (each registers its own verbs) instead of one shared switch.
//
// Two registries:
//   · EXECUTORS  — verb (string) → the world-interaction run on arrival (act-layer; ground truth).
//   · DERIVERS   — a flat list of goal-derivers run each cognition tick (turn beliefs/needs/memory
//                  into goals), so a feature adds its derivation as a row, not a branch in deriveGoals.
//
// SAFETY (the freeze lesson): every dispatch is guarded and never throws; an unknown verb is a
// no-op (the caller idles). Registration is idempotent-ish (last writer wins per verb).

import type { Agent, CognitionCtx, PlanStep, Goal } from '../../../types/sim.js';

/** A verb's executor: the world-interaction run on arrival. Reads ground truth (act layer). */
export type Executor = (a: Agent, step: PlanStep, dt: number, ctx: CognitionCtx) => void;
/** A goal-deriver: turns an agent's OWN beliefs/needs/memory into goals (cognition layer). */
export type Deriver = (a: Agent, ctx: CognitionCtx | null) => void;
/** "Has this step's effect landed?" — when true the plan advances to the next step. Belief-grounded. */
export type EffectHolds = (a: Agent, ctx: CognitionCtx, step: PlanStep) => boolean;
/** OUTCOME-CONDITIONED CAUTION (docs/architecture/11): the resolution a WATCHED act emits. */
export interface OutcomeEvt {
  status: 'shortfall' | 'neutral' | 'windfall' | 'peril' | 'waste';
  step: PlanStep;            // the watched step this resolution is about (carries bind + _conf)
  expected?: number;          // believed yield at plan time
  realized?: number;          // experienced own-state delta over the step
  goal?: Goal;                // present on 'waste' (the goal-layer emit)
}
/** A plan-outcome handler — fired when a watched act resolves (caution.ts registers the one). */
export type PlanOutcome = (a: Agent, ctx: CognitionCtx, evt: OutcomeEvt) => void;

const EXECUTORS: Record<string, Executor> = Object.create(null);
const DERIVERS: Deriver[] = [];
const EFFECT_HOLDS: Record<string, EffectHolds> = Object.create(null);
const PLAN_OUTCOME: PlanOutcome[] = [];

// Register a verb's executor (data row into the dispatch map). Feature modules call this from
// their own file, so no shared switch is edited. Guarded against a bad arg.
export function registerExecutor(verb: string, fn: Executor): void {
  if (verb && typeof fn === 'function') EXECUTORS[verb] = fn;
}

// Dispatch a verb to its executor. Unknown verb → false (the caller idles), never throws.
export function runExecutor(verb: string, a: Agent, step: PlanStep, dt: number, ctx: CognitionCtx): boolean {
  const fn = EXECUTORS[verb];
  if (!fn) return false;
  try { fn(a, step, dt, ctx); return true; } catch { return false; }
}

export function hasExecutor(verb: string): boolean { return !!EXECUTORS[verb]; }

// Register a goal-deriver (data row into the deriver list). Run by deriveGoals each tick.
export function registerDeriver(fn: Deriver): void {
  if (typeof fn === 'function' && !DERIVERS.includes(fn)) DERIVERS.push(fn);
}

// Run every registered deriver for this agent. Each is independently guarded so one feature's
// fault never blocks another's (or freezes the tick).
export function runDerivers(a: Agent, ctx: CognitionCtx | null): void {
  for (const d of DERIVERS) { try { d(a, ctx); } catch { /* never throw on the tick */ } }
}

// Register a verb's "effect landed?" predicate (data row), so a feature's multi-step plan can
// advance from its own file instead of a branch in the planner's stepEffectHolds switch.
export function registerEffectHolds(verb: string, fn: EffectHolds): void {
  if (verb && typeof fn === 'function') EFFECT_HOLDS[verb] = fn;
}

// The registered effect-landed predicate for a verb, or undefined if none (caller falls back to
// its base handling). Guarded — a faulting predicate reads as "not yet landed" (false), never throws.
export function effectHolds(verb: string, a: Agent, ctx: CognitionCtx, step: PlanStep): boolean | undefined {
  const fn = EFFECT_HOLDS[verb];
  if (!fn) return undefined;
  try { return fn(a, ctx, step); } catch { return false; }
}

// Register a plan-outcome handler (data row), fired when a watched act resolves (doc 11). Same shape
// as the other registries — a feature adds its row, no shared switch. Dedups; independently guarded.
export function registerPlanOutcome(fn: PlanOutcome): void {
  if (typeof fn === 'function' && !PLAN_OUTCOME.includes(fn)) PLAN_OUTCOME.push(fn);
}

// Fire every plan-outcome handler for one resolution. Each independently guarded (a faulting handler
// never blocks another or freezes the tick). A no-op when no handler is registered (caution off).
export function runPlanOutcome(a: Agent, ctx: CognitionCtx, evt: OutcomeEvt): void {
  for (const h of PLAN_OUTCOME) { try { h(a, ctx, evt); } catch { /* never throw on the tick */ } }
}
