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

import type { Agent, CognitionCtx, PlanStep } from '../../../types/sim.js';

/** A verb's executor: the world-interaction run on arrival. Reads ground truth (act layer). */
export type Executor = (a: Agent, step: PlanStep, dt: number, ctx: CognitionCtx) => void;
/** A goal-deriver: turns an agent's OWN beliefs/needs/memory into goals (cognition layer). */
export type Deriver = (a: Agent, ctx: CognitionCtx | null) => void;
/** "Has this step's effect landed?" — when true the plan advances to the next step. Belief-grounded. */
export type EffectHolds = (a: Agent, ctx: CognitionCtx, step: PlanStep) => boolean;

const EXECUTORS: Record<string, Executor> = Object.create(null);
const DERIVERS: Deriver[] = [];
const EFFECT_HOLDS: Record<string, EffectHolds> = Object.create(null);

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
