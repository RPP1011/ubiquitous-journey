// REASONING TRACES — the per-agent diagnostic side-channel (docs/reasoning-traces.md).
//
// A trace is a small, bounded, per-agent ring buffer of *why this mind did what it
// did this tick*. It is WRITTEN BY the cognition tick (from the agent's OWN view) and
// is NEVER READ BACK by any decision — the one non-negotiable rule. It is read only by
// the UI (truth-side, read-only) and by tests. That write-only rule is what keeps the
// trace safe: no feedback loop, no epistemic leak (it records only own-state).
//
// COST DISCIPLINE (the label-cache lesson, `Agent._updateLabel`): an entry is a CHEAP
// STRUCTURED record — no strings built on the tick. The human-readable string is produced
// ONLY when the UI actually reads it, via `traceLabel(entry)`. That is the whole reason
// entries are structured-not-string: it is what makes "trace everyone" affordable.
//
// SAFETY (the freeze lesson): `note()` is fully guarded — it never throws, and a null
// subject/operand is fine (a trace may reference a despawned percept). With `TRACE.enabled`
// off it is a single guarded early-return (byte-stable, zero allocation).
//
// HEADLESS-SAFE: a plain ring of plain objects. No DOM, no Three. Tests read it directly.

import { TRACE } from './simconfig.js';
import type { Stage, Reason, Verdict, TraceEntry, TraceNoteOpts, Trace as ITrace } from '../../types/sim.js';

// STAGE — the pipeline position that emitted the entry (which reasoning layer).
export const STAGE = {
  PERCEIVE: 'perceive',
  INFER: 'infer',
  SCHEMA: 'schema',
  GOAL: 'goal',
  PLAN: 'plan',
  DECIDE: 'decide',
  ACT: 'act',
} as const satisfies Record<string, Stage>;

// REASON — a small STABLE enum (not a free string) so tests match on it and the
// formatter can localise it (mirrors beliefs.js's provenanceLabel/provenanceTag).
// Grouped by stage; grows as the Phase 4/5 schemas land.
export const REASON = {
  // INFER
  DEST_INFERRED: 'dest_inferred',       // inferDestination committed a place (a=placeId)
  ANIMACY_REVISED: 'animacy_revised',   // schema #6: hostile→false from zero observed animacy
  // SCHEMA
  SCHEMA_FIRED: 'schema_fired',         // a=schemaId (verdict=FIRED)
  SCHEMA_SUPPRESSED: 'schema_suppressed', // a=schemaId, b=failing-predicate (verdict=SUPPRESSED)
  // GOAL
  GOAL_DERIVED: 'goal_derived',         // a=goalKind, subjectId=source memory's subject
  GOAL_POPPED: 'goal_popped',           // a goal's predicate became satisfied (a=goalKind)
  // PLAN
  PLAN_FOUND: 'plan_found',             // a=stepCount
  PLAN_FAILED: 'plan_failed',           // a=blocking precondition atom
  PLAN_REPLANNED: 'plan_replanned',     // a belief change invalidated a pre/eff
  // DECIDE / ACT (the most valuable entries — deferred to the post-2b executor)
  BEHAVIOUR_WON: 'behaviour_won',       // a=behaviour/steer-fill, b=utility; subjectId=target
  BEHAVIOUR_RUNNERUP: 'behaviour_runnerup', // a=behaviour, b=utility — the loser ("why not X?")
  INTERRUPTED: 'interrupted',           // flee/threat overrode the active plan (a=overriding)
  RESUMED: 'resumed',                   // the stacked goal resumed after the interrupt cleared
} as const satisfies Record<string, Reason>;

// VERDICT — the outcome of the reasoning step (or null when not applicable).
export const VERDICT = {
  FIRED: 'fired',
  SUPPRESSED: 'suppressed',
  WON: 'won',
  LOST: 'lost',
  BLOCKED: 'blocked',
  REPLANNED: 'replanned',
  REVISED: 'revised',
} as const satisfies Record<string, Verdict>;

// One reasoning event. Tiny, allocation-light, no strings built on the tick.
//   { t, stage, code, verdict, subjectId, a, b }

export class Trace implements ITrace {
  depth: number;
  buf: TraceEntry[];     // a plain ring; grows to `depth` then overwrites oldest
  head: number;          // next write index
  len: number;           // entries currently held (<= depth)

  constructor(depth = (TRACE && TRACE.depth) || 24) {
    this.depth = Math.max(1, depth | 0);
    this.buf = [];
    this.head = 0;
    this.len = 0;
  }

  // O(1) append; overwrites the oldest past the cap. NEVER throws (the freeze lesson).
  // A null subject/operand is fine. With TRACE.enabled off it is a guarded early-return
  // (byte-stable, zero allocation) so the soak baseline is unchanged either way.
  note(stage: Stage | null, code: Reason, opts?: TraceNoteOpts): void {
    try {
      if (!TRACE || !TRACE.enabled) return;
      if (!code) return;
      const o = opts || EMPTY;
      const e: TraceEntry = {
        t: o.t != null ? o.t : 0,
        stage: stage || null,
        code,
        verdict: o.verdict != null ? o.verdict : null,
        subjectId: o.subjectId != null ? o.subjectId : null,
        a: o.a != null ? o.a : null,
        b: o.b != null ? o.b : null,
      };
      if (this.len < this.depth) { this.buf.push(e); this.len++; }
      else { this.buf[this.head] = e; }
      this.head = (this.head + 1) % this.depth;
    } catch { /* never throw on the tick */ }
  }

  // Newest-first view, for the UI/tests. Bounded by `n` (default: all held). O(min(n,len)).
  recent(n = this.len): TraceEntry[] {
    const out: TraceEntry[] = [];
    const count = Math.min(n | 0 || this.len, this.len);
    // walk backwards from the most recently written slot
    for (let i = 0; i < count; i++) {
      const idx = (this.head - 1 - i + this.depth * 2) % this.depth;
      const e = this.buf[idx];
      if (e) out.push(e);
    }
    return out;
  }

  // newest entry's tick stamp — the UI's cache signature (rebuild only on a new entry).
  // null when empty.
  newestT(): number | null {
    if (!this.len) return null;
    const idx = (this.head - 1 + this.depth) % this.depth;
    const e = this.buf[idx];
    return e ? e.t : null;
  }
}

const EMPTY: TraceNoteOpts = {};

// Render an entry to text ON READ (never on the tick). Cosmetic only — tests match on
// `code`, never on this string. Guarded; always returns a string.
export function traceLabel(e: TraceEntry | null | undefined): string {
  if (!e || !e.code) return '';
  const subj = e.subjectId != null ? `#${e.subjectId}` : '';
  const A = e.a != null ? String(e.a) : '';
  const B = e.b != null ? String(e.b) : '';
  switch (e.code) {
    case REASON.DEST_INFERRED:
      return `inferred ${subj || 'a quarry'} is making for ${A || 'somewhere'}`;
    case REASON.ANIMACY_REVISED:
      return `revised ${subj || 'a "foe"'} — it never reacts; no threat`;
    case REASON.SCHEMA_FIRED:
      return `schema ${A || '?'} fired`;
    case REASON.SCHEMA_SUPPRESSED:
      return `schema ${A || '?'} suppressed${B ? ` (${B})` : ''}`;
    case REASON.GOAL_DERIVED:
      return `derived goal ${A || '?'}${subj ? ` re ${subj}` : ''}`;
    case REASON.GOAL_POPPED:
      return `goal ${A || '?'} satisfied${subj ? ` re ${subj}` : ''}`;
    case REASON.PLAN_FOUND:
      return `planned ${A || '0'} step(s)`;
    case REASON.PLAN_FAILED:
      return `plan blocked on ${A || 'a precondition'}`;
    case REASON.PLAN_REPLANNED:
      return `replanned — ${A || 'a belief'} changed`;
    case REASON.BEHAVIOUR_WON:
      return `chose ${A || '?'}${B ? ` (u=${B})` : ''}${subj ? ` → ${subj}` : ''}`;
    case REASON.BEHAVIOUR_RUNNERUP:
      return `passed over ${A || '?'}${B ? ` (u=${B})` : ''}`;
    case REASON.INTERRUPTED:
      return `interrupted by ${A || 'a threat'}`;
    case REASON.RESUMED:
      return `resumed ${A || 'the plan'}`;
    default:
      return `${e.stage || ''} ${e.code}${A ? ` ${A}` : ''}`.trim();
  }
}
