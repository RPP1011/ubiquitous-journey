// THE MOTIVATION REGISTRY (docs/architecture/17 §3) — the data substrate that keeps MOTIVATIONS AS
// DATA, mirroring js/sim/exec/registry.ts (verbs-as-data). A motivation is one row: the short-term
// impetus that selects a primitive (actor half) and — from P4 — defines how that primitive reads when
// witnessed (observer half). Each motive family registers its rows from its OWN file (js/sim/motives/
// *.ts) as an import side-effect, so they stay disjoint; nothing here knows a motive by name.
//
// Two readers:
//   · arbitrate(a, ctx)  scans ALL rows, scoring the eligible ones (the un-fused decide() scorer).
//   · inferMotive(...)   scans motivesFor(primitive) — the candidate motives for a witnessed primitive.
//
// SAFETY (the freeze lesson): registration is guarded + idempotent; lookups never throw.

import type { Motivation } from '../../../types/sim.js';

const MOTIVATIONS: Motivation[] = [];

// Register a motivation row (data into the list). Feature/motive modules call this from their own
// file, so no shared table is edited. Guarded against a bad arg; idempotent (no duplicate).
export function registerMotive(m: Motivation): void {
  if (m && typeof m.score === 'function' && typeof m.primitive === 'string' && !MOTIVATIONS.includes(m)) {
    MOTIVATIONS.push(m);
  }
}

// Every registered motive (the arbiter's candidate pool). Returned as the live array for the hot path;
// callers must not mutate it.
export function allMotives(): readonly Motivation[] {
  return MOTIVATIONS;
}

// The candidate motives that drive one primitive (inference's candidate set for a witnessed deed).
// Bounded — a single-digit constant per primitive. Never throws.
export function motivesFor(primitive: string): Motivation[] {
  const out: Motivation[] = [];
  for (const m of MOTIVATIONS) if (m.primitive === primitive) out.push(m);
  return out;
}

// Look a motive up by its unique key (the inference write-back: posterior.best → its consequence).
export function motiveByKey(key: string): Motivation | undefined {
  for (const m of MOTIVATIONS) if (m.key === key) return m;
  return undefined;
}
