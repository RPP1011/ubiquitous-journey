// OUTCOME-CONDITIONED CAUTION — the store (docs/architecture/11-outcome-conditioned-caution-lld).
// Pure helpers, the obligations.ts pattern: the per-agent, per-strategy `ActExperience` math —
// `recordBurn` / `recordWindfall` / `feltSurcharge` / `expKey` / lazy decay — with NO tick wiring of
// its own (act.ts/motivation.ts own the emit sites; caution.ts is the one handler that calls in).
//
// This is the BURNED-HAND half of regret: an agent learns about its STRATEGIES from its own
// outcomes the way it already learns about the WORLD from perception. A signed surcharge per
// strategy — burned (dearer) when a watched act fell short / nearly killed / the trip died on the
// road; emboldened (cheaper) by genuine success — eroded by time and by success, read inside `cost`
// beside `confidenceSurcharge`. Belief/own-state only; bounded; lazily decayed (no per-tick pass);
// never throws. NATURE STAYS FIXED — this never mutates personality; decay is always toward 0.

import { CAUTION } from './simconfig.js';
import type { Agent } from '../../types/sim.js';
import type { PlanBind } from '../../types/goals.js';

/** One strategy's learned record — the belief-table shape (value / time / weight). */
export interface ActExperience { s: number; t: number; n: number; }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// v1 KEY = the primitive NAME (the row IS the strategy). One signature everywhere; the qualified-key
// follow-up (e.g. `sell:${place}`) rides the same store with a finer key (10-lld §3 / §7 caveat).
export function expKey(primName: string, _bind?: PlanBind | null): string { return primName; }

// lazy decay: the surcharge halves every CAUTION.halfLife of sim-time since it was last written.
export function decayed(e: ActExperience, now: number): number {
  const hl = CAUTION.halfLife || 1;
  return e.s * Math.pow(0.5, Math.max(0, now - e.t) / hl);
}

// THE single write path. `delta` is a number OR a function of the CURRENT (post-decay) entry — how
// the diminishing windfall reads `n`. Clamped asymmetrically: burns up to `cap`, emboldening only to
// `capDiscount` (cap/4) — a hot streak makes you keen, not invincible. Bounded map (oldest-t drop).
function write(a: Agent, key: string, delta: number | ((e: ActExperience) => number), now: number): void {
  if (!a) return;
  if (!a._actExperience) a._actExperience = new Map();
  const e = a._actExperience.get(key) || { s: 0, t: now, n: 0 };
  const base = decayed(e, now);
  const d = (typeof delta === 'function') ? delta(e) : delta;
  e.s = Math.max(-(CAUTION.capDiscount || 0), Math.min(CAUTION.cap || 0, base + d));
  e.t = now; e.n += 1;
  a._actExperience.set(key, e);
  enforceMaxKeys(a);
}

function enforceMaxKeys(a: Agent): void {
  const m = a._actExperience;
  if (!m) return;
  const max = CAUTION.maxKeys || 12;
  while (m.size > max) {                      // drop the oldest-updated entry
    let oldestKey: string | null = null, oldestT = Infinity;
    for (const [k, e] of m) if (e.t < oldestT) { oldestT = e.t; oldestKey = k; }
    if (oldestKey == null) break;
    m.delete(oldestKey);
  }
}

// BURN — a shortfall / waste / peril outcome. ATTRIBUTION (§5): a failure on a CONFIDENT belief was
// bad luck and writes little; a knowing gamble writes a lot. `conf` is the plan-time confidence the
// watched bet leaned on (bind._conf). burn = base · (1 − conf · luckDiscount).
export function recordBurn(a: Agent, key: string, status: 'shortfall' | 'waste' | 'peril', conf: number, now: number): void {
  const base = (CAUTION.burn && CAUTION.burn[status]) || 0;
  const factor = 1 - clamp01(conf) * (CAUTION.luckDiscount || 0);
  write(a, key, base * factor, now);
}

// WINDFALL — genuine success writes the OPPOSING (negative) entry, loss-averse (|windfall| ≪ burns)
// and DIMINISHING (the 10th success teaches less than the 1st), so streaks embolden but shallowly.
export function recordWindfall(a: Agent, key: string, now: number): void {
  write(a, key, (e) => (CAUTION.windfall || 0) / (1 + e.n * 0.25), now);
}

// THE COGNITION READ — added to stepCost in solveAtom beside confidenceSurcharge. Own-state only;
// 0 when unknown. May be NEGATIVE (emboldened). rtRelief shrinks the POSITIVE side only — the
// bold shrug off burns but still enjoy streaks.
export function feltSurcharge(a: Agent, primName: string, bind: PlanBind | null, now: number): number {
  if (!a || !a._actExperience) return 0;
  const e = a._actExperience.get(expKey(primName, bind));
  if (!e) return 0;
  let s = decayed(e, now);
  if (s > 0) {
    const rt = (a.personality && typeof a.personality.risk_tolerance === 'number') ? a.personality.risk_tolerance : 0.5;
    s *= (1 - rt * (CAUTION.rtRelief || 0));
  }
  return s;
}

// YIELD CLASSIFICATION (§4.2) — three bands, one function. The NEUTRAL band is load-bearing: a
// mildly-disappointing night (60% of expectation) writes NOTHING, so across many ordinary nights the
// loss-aversion asymmetry can't invert in aggregate. Only genuine surprise — either direction — writes.
export function classifyYield(expected: number, realized: number): 'shortfall' | 'neutral' | 'windfall' {
  if (!(expected > 0)) return 'neutral';                       // nothing believed at stake ⇒ nothing learned
  if (realized < (CAUTION.shortfallRatio || 0) * expected) return 'shortfall';
  if (realized < expected) return 'neutral';
  return 'windfall';
}

// THE ATTRIBUTION INPUT (§5) — the plan-time confidence the watched bet leans on, snapshotted onto
// bind._conf in solveAtom. Per verb (10-lld §5 table): burgle leans on the stash LOCATION belief
// (assoc.conf — the honest v1 proxy until the §15 wealth-cue estimate lands); rob/loot on how
// well-tracked the mark/corpse is (belief.confidence). Own-state belief read; 0 when unknown.
export function relevantConfidence(a: Agent, primName: string, bind: PlanBind | null): number {
  if (!a || !a.beliefs || !bind) return 0;
  try {
    if (primName === 'burgle') {
      const b = bind.target != null ? a.beliefs.get(bind.target) : null;
      return clamp01(b && b.assoc ? (b.assoc.conf || 0) : 0);
    }
    if (primName === 'rob') {
      const b = bind.target != null ? a.beliefs.get(bind.target) : null;
      return clamp01(b ? (b.confidence || 0) : 0);
    }
    if (primName === 'loot') {
      const id = bind.corpse != null ? bind.corpse : bind.target;
      const b = id != null ? a.beliefs.get(id) : null;
      return clamp01(b ? (b.confidence || 0) : 0);
    }
  } catch { /* never throw */ }
  return 0;
}
