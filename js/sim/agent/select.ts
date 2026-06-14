// THE BELIEF-WEIGHTED SELECTION PRIMITIVE (doc 18 — Knowledge Exploitation, M1).
//
// One pure, guarded `bestOption` that generalises the single call site that already
// does belief-weighted picking RIGHT — `nearestComfortSource` (decide.ts): it weighs
// a FELT/believed value against a cultural prior, SKIPS places it believes razed, and
// DISTANCE-DISCOUNTS the rest. Most other "pick the X" sites instead reach for raw
// `nearest`/first-match and throw the richer belief away (the doc's "proxy gaps").
// Routing those through this primitive makes good knowledge-use the DEFAULT.
//
// THE SCORE (argmax of):
//     value − distancePenalty − cost
//   where value/cost come from the CALLER (belief-derived), and the distance penalty
//   is value-relative: `value / (1 + dist/range)` — a far option must be proportionally
//   richer to win, exactly like nearestComfortSource's `q / (1 + d/sourceRange)`. We
//   express it as a discount on value (not a flat subtraction) so the ranking is
//   scale-stable across very different value magnitudes.
//
// EPISTEMIC SPLIT: this file reads NOTHING. The caller supplies candidates drawn from
// the agent's OWN beliefs + the STATIC mental map; the value/cost/skip closures are the
// caller's too. So the primitive can never widen the cognition boundary — it is pure
// arithmetic over what the caller already knows. It is parity-safe by construction: it
// chooses a LOCOMOTION TARGET among options, never a candidate KIND, so it sits BELOW
// the motivation scorer (arbitrate.ts / decide.ts scoreAndSelect) and cannot move S2.
//
// Never throws (the freeze lesson): every closure call is wrapped; a throwing closure
// just drops that candidate.

import { SELECT } from '../simconfig.js';

/** The knobs for one selection. All optional; sensible defaults from SELECT. */
export interface BestOptionOpts<T> {
  /** Believed worth of an option (higher = better). Default: every option worth 1. */
  valueOf?: (o: T) => number;
  /** A flat additive cost subtracted from the discounted value (e.g. tuition, risk surcharge). Default 0. */
  costOf?: (o: T) => number;
  /** Straight-line distance from the agent to the option, for the distance discount. Default 0 (no discount). */
  distanceOf?: (o: T) => number;
  /** Drop an option outright (invalid / believed-bad / known-hostile-adjacent). Default: keep all. */
  skipIf?: (o: T) => boolean;
  /** Distance over which value halves-ish (the `range` in value/(1+dist/range)). Default SELECT.range. */
  range?: number;
}

/**
 * Argmax of `value/(1 + dist/range) − cost` over `candidates`, skipping invalid/known-bad
 * options. Pure; no roster read (the caller supplies belief-/map-derived candidates). Returns
 * the winning candidate, or null when the list is empty / everything was skipped / every score
 * came out non-finite. Ties resolve to the FIRST candidate (stable — callers can pre-order).
 */
export function bestOption<T>(candidates: readonly T[] | null | undefined, opts?: BestOptionOpts<T>): T | null {
  if (!candidates || candidates.length === 0) return null;
  const o: BestOptionOpts<T> = opts || ({} as BestOptionOpts<T>);
  const range = (typeof o.range === 'number' && o.range > 0) ? o.range : (SELECT.range || 40);
  let best: T | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      if (o.skipIf && o.skipIf(c)) continue;
      const v = o.valueOf ? o.valueOf(c) : 1;
      if (!Number.isFinite(v)) continue;
      const d = o.distanceOf ? o.distanceOf(c) : 0;
      const dist = Number.isFinite(d) && d > 0 ? d : 0;
      const cost = o.costOf ? o.costOf(c) : 0;
      const score = v / (1 + dist / range) - (Number.isFinite(cost) ? cost : 0);
      if (score > bestScore) { bestScore = score; best = c; }
    } catch { /* a throwing closure drops this candidate, never the tick */ }
  }
  return best;
}

/**
 * Convenience: the {x,z} (+y) ground-plane distance helper most callers want for `distanceOf`,
 * tolerant of either {x,z} points or anything with a `pos`. Returns Infinity on bad input so the
 * candidate is effectively de-prioritised rather than crashing.
 */
export function planarDist(from: { x: number; z: number }, p: { x: number; z: number } | null | undefined): number {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return Infinity;
  return Math.hypot(p.x - from.x, p.z - from.z);
}
