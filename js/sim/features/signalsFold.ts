// FEATURE: fold the PLAN_OUTCOME-driven catalog signals (docs/architecture/13 Family A/E). A single
// registered PLAN_OUTCOME handler (verbs-are-data) that records, per resolved watched act, the
// per-strategy outcome STREAK ("third failed heist in a row" — desperation before the burn cap) and
// the PERILS-survived tally (near-misses — burnedVeteran colour). Own-state only; guarded; the same
// emission caution already reads, so this costs nothing new (the second customer, [11] §8).

import { registerPlanOutcome } from '../exec/registry.js';
import { foldStreak, foldPeril } from '../signals.js';

registerPlanOutcome((a, ctx, evt) => {
  if (!a || !evt || !evt.step) return;
  const now = ctx ? ctx.time : 0;
  try {
    foldStreak(a, evt.step.prim, evt.status, now);
    if (evt.status === 'peril') foldPeril(a, now);
  } catch { /* never throw on the tick */ }
});

export {};
