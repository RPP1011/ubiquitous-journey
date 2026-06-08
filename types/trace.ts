// Reasoning traces (js/sim/trace.js): the per-agent diagnostic side-channel. WRITTEN BY
// cognition (own-view), NEVER read back by a decision — read only by the UI/tests.

import type { EntityId } from './core.js';

/** The pipeline stage that emitted a trace entry (STAGE). */
export type Stage = 'perceive' | 'infer' | 'schema' | 'goal' | 'plan' | 'decide' | 'act';

/** A stable reason code (REASON) — not a free string, so tests match on it. */
export type Reason =
  | 'dest_inferred' | 'animacy_revised'
  | 'schema_fired' | 'schema_suppressed'
  | 'goal_derived' | 'goal_popped'
  | 'plan_found' | 'plan_failed' | 'plan_replanned'
  | 'behaviour_won' | 'behaviour_runnerup' | 'interrupted' | 'resumed';

/** The outcome of a reasoning step (VERDICT), or null when not applicable. */
export type Verdict =
  | 'fired' | 'suppressed' | 'won' | 'lost' | 'blocked' | 'replanned' | 'revised';

/** Options to Trace.note (the only write surface). */
export interface TraceNoteOpts {
  t?: number;
  verdict?: Verdict | null;
  subjectId?: EntityId | null;
  a?: unknown;
  b?: unknown;
}

/** One reasoning event — tiny, structured (the string is built lazily on read). */
export interface TraceEntry {
  t: number;
  stage: Stage | null;
  code: Reason;
  verdict: Verdict | null;
  subjectId: EntityId | null;
  a: unknown;
  b: unknown;
}

/** A bounded per-agent ring of "why I acted this tick" (js/sim/trace.js Trace). */
export interface Trace {
  depth: number;
  // O(1) append; never throws. With TRACE.enabled off it is a guarded early-return.
  note(stage: Stage | null, code: Reason, opts?: TraceNoteOpts): void;
  recent(n?: number): TraceEntry[];   // newest-first
  newestT(): number | null;
}
