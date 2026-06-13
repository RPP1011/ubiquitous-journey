// THEORY-OF-MIND INFERENCE (docs/architecture/17 §7) — the OBSERVER half of the (primitive, motivation)
// split. A witness perceives a Deed (a public primitive + scene cues) and must answer "why did they do
// that?" by a bounded prior×likelihood read over its OWN memory/beliefs. This module owns that read and
// the inbox drain that feeds it; it writes ONLY the observer's own beliefs (the epistemic split holds).
//
// PHASING: P3 wires the path with a STUB onWitnessPrimitive (no belief write — the existing hardcoded
// witnessDeed fold is untouched, so behaviour is unchanged). P4 replaces the stub with real inference.

import type { Agent, FullCtx, Deed } from '../../../types/sim.js';

// Test/telemetry visibility: how many witnessed deeds the path has processed (proves emit→inbox→drain
// is live, not silently dead). Reset by tests via resetDeedStats(); read via deedsProcessed().
let _processed = 0;
export function deedsProcessed(): number { return _processed; }
export function resetDeedStats(): void { _processed = 0; }

/** Drain the agent's perceived-deed inbox, inferring a motive for each. Run in the perceive pass (once
 *  per cognition tick), before new beliefs form. Bounded by the inbox cap; each deed independently
 *  guarded so one fault never blocks the rest (the freeze lesson). */
export function drainDeeds(a: Agent, ctx: FullCtx): void {
  const inbox = (a as { perceivedDeeds?: Deed[] }).perceivedDeeds;
  if (!inbox || !inbox.length) return;
  for (const deed of inbox) {
    try { onWitnessPrimitive(a, deed, ctx); } catch { /* never throw on the tick */ }
  }
  inbox.length = 0;   // consumed
}

/** Infer a motive for one witnessed deed and fold its consequence into the observer's beliefs.
 *  P3 STUB: wire-only — does nothing behaviourally (the existing witnessDeed reaction stays
 *  authoritative). P4 swaps in inferMotive() + the conf-scaled consequence. Never throws. */
export function onWitnessPrimitive(a: Agent, deed: Deed, ctx: FullCtx): void {
  if (!deed || deed.actorId === a.id) return;   // I know my own motive; no self-inference
  void ctx;
  _processed++;
  // P4 fills this: const { best, conf } = inferMotive(a, deed, ctx); …write believedMotive + consequence.
}
