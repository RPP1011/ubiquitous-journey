// THEORY-OF-MIND INFERENCE (docs/architecture/17 §7) — the OBSERVER half of the (primitive, motivation)
// split. A witness perceives a Deed (a public primitive + scene cues) and must answer "why did they do
// that?" by a bounded prior×likelihood read over its OWN memory/beliefs. This module owns that read and
// the inbox drain that feeds it; it writes ONLY the observer's own beliefs (the epistemic split holds).
//
// PHASING: P3 wires the path with a STUB onWitnessPrimitive (no belief write — the existing hardcoded
// witnessDeed fold is untouched, so behaviour is unchanged). P4 replaces the stub with real inference.

import { motivesFor } from './registry.js';
import { MOTIVE, SIM } from '../simconfig.js';
import './../motives/index.js';   // self-register the inference motives (verbs-are-data)
import type { Agent, FullCtx, Deed, Cues, MotivePosterior } from '../../../types/sim.js';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

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
  _processed++;
  const { best, conf } = inferMotive(a, deed, ctx);
  if (best === 'unknown' || conf < (MOTIVE.attributeAt || 0.45)) return;   // §7.2a: sub-threshold → no write
  // attribute onto MY belief about the actor — only if I already hold one (don't mint a belief from a
  // single ambiguous glimpse; perception forms the base belief, this annotates its motive). Sparse by
  // construction. P4 is ADDITIVE: it writes the inferred motive only; the existing standing fold
  // (witnessDeed) stays authoritative for the magnitude. Deception (P6) fools exactly this field.
  const b = a.beliefs.get(deed.actorId);
  if (!b) return;
  b.believedMotive = best;
  b.motiveConf = conf;
}

/** Assemble the cue view a likelihood reads: the deed's frozen SCENE cues ∪ the observer's OBSERVER
 *  cues (queries over a's OWN beliefs — §4a). No roster scan; a handful of belief reads. */
function assembleCues(a: Agent, deed: Deed): Cues {
  const cues: Cues = { ...(deed.sceneCues || {}) };
  const vb = deed.targetId != null ? a.beliefs.get(deed.targetId) : null;
  cues.iBelieveVictimRich = vb ? (vb.believedWealth || 0) * (vb.wealthConf || 0) : 0;
  const ab = a.beliefs.get(deed.actorId);
  cues.iBelieveActorPoor = ab ? clamp01(1 - (ab.believedWealth || 0)) : 0.5;
  return cues;
}

/** Infer a motive for a witnessed deed: a bounded prior×likelihood read over the candidate motives for
 *  the deed's primitive, normalized to a posterior. Reads ONLY the observer's own beliefs (the split).
 *  Returns the argmax + its confidence + the distribution. Never throws. */
export function inferMotive(a: Agent, deed: Deed, ctx: FullCtx): MotivePosterior {
  const cands = motivesFor(deed.primitive);
  if (!cands.length) return { best: 'unknown', conf: 0, dist: {} };
  const cues = assembleCues(a, deed);
  const post: Record<string, number> = {};
  let Z = 0;
  for (const m of cands) {
    let prior: number;
    try { prior = m.prior ? clamp01(m.prior(a, deed.actorId, deed, ctx)) : (m.basePrior ?? 0.25); }
    catch { prior = m.basePrior ?? 0.25; }
    let like: number;
    try { like = m.reads ? clamp01(m.reads.likelihood(deed, cues)) : 1; }
    catch { like = 0; }
    const p = prior * like;
    post[m.key] = p; Z += p;
  }
  if (Z <= 0) return { best: 'unknown', conf: 0, dist: {} };
  let best = 'unknown', bestP = -1;
  for (const k in post) { post[k] /= Z; if (post[k] > bestP) { bestP = post[k]; best = k; } }
  void SIM;
  return { best, conf: bestP, dist: post };
}
