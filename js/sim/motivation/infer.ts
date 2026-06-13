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

/** DECEPTION (docs/architecture/17 §7.4) — the surface tag an actor PRESENTS on its deed. An honest
 *  actor presents its true tag; a deceiver (`a._deceives`) presents the motive's innocuous COVER. The
 *  deceiver only BIASES the witness's inference (the cover boosts the cover-motive's likelihood) — it
 *  never SETS the belief, so a witness with a strong contrary prior sees through it. */
export function presentTag(a: Agent, trueTag: string, coverTag?: string): string {
  return ((a as { _deceives?: boolean })._deceives && coverTag) ? coverTag : trueTag;
}

/** RECURSIVE ToM (docs/architecture/17 §7.5) — a synthetic "typical bystander", built within the
 *  ACTOR'S OWN epistemic scope (the actor assumes the average witness holds no strong opinion of the
 *  subject). The guile branch runs inferMotive against this model to predict how a deed will read. */
function modelTypicalWitness(deed: Deed): Agent {
  const m = new Map<number, unknown>();
  if (deed.targetId != null) m.set(deed.targetId as number, { standing: 0, hostile: false, believedWealth: 0, wealthConf: 0 });
  if (deed.actorId != null) m.set(deed.actorId as number, { standing: 0, hostile: false, believedWealth: 0.4, wealthConf: 0.3 });
  return { id: -1, personality: {}, gold: 50, beliefs: { get(id: number) { return m.get(id); } } } as unknown as Agent;
}

/** The guile branch (docs/architecture/17 §7.5): a deceiving actor picks the cover tag that best hides
 *  its true (damaging) motive — by running the SAME inferMotive against a model witness and minimizing
 *  P(they read my real motive). One level only; gated on `_deceives` (honest actors return their true
 *  tag); K ≤ 4 cover options (bounded, ~24 cheap reads). Never throws. */
export function chooseDeceptiveTag(actor: Agent, deed: Deed, trueMotiveKey: string, coverTags: string[], ctx: FullCtx): string {
  const trueTag = deed.surfaceTag || trueMotiveKey;
  if (!(actor as { _deceives?: boolean })._deceives) return trueTag;   // honest mainline — no guile
  try {
    const witness = modelTypicalWitness(deed);
    let bestTag = trueTag, bestExposure = Infinity;
    for (const tag of coverTags.slice(0, 4)) {   // K ≤ 4 — bounded enumeration
      const post = inferMotive(witness, { ...deed, surfaceTag: tag }, ctx);
      const exposure = post.dist[trueMotiveKey] || 0;   // how likely they read my real, costly motive
      if (exposure < bestExposure) { bestExposure = exposure; bestTag = tag; }
    }
    return bestTag;
  } catch { return trueTag; }
}

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
