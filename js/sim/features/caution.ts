// FEATURE: outcome-conditioned caution (docs/architecture/11). The SMALLEST feature — caution is
// pure cost-shaping, so it registers NO verbs, NO executors, NO derivers, NO effect-holds. It is one
// PLAN_OUTCOME handler: when a watched act resolves (classified by act.ts / motivation.ts emit sites),
// it writes the per-strategy surcharge through the pure experience.ts store. The read side lives in
// the planner (feltSurcharge beside confidenceSurcharge). The registries' cleanest proof that a
// behaviour-shaping feature can be a single registered row.
//
// Gated INSIDE the handler (registration is unconditional so a test can toggle CAUTION.enabled at
// runtime, the codebase's real feature pattern): off ⇒ the handler returns immediately, the emit
// sites never fire, and feltSurcharge is 0 — the soak is byte-identical.

import { registerPlanOutcome } from '../exec/registry.js';
import { recordBurn, recordWindfall, expKey } from '../experience.js';
import { CAUTION } from '../simconfig.js';

registerPlanOutcome((a, ctx, evt) => {
  if (!CAUTION.enabled || !a || !evt || !evt.step) return;
  const key = expKey(evt.step.prim, evt.step.bind);
  const now = ctx ? ctx.time : 0;
  switch (evt.status) {
    case 'windfall': recordWindfall(a, key, now); break;       // genuine success embolds (shallow)
    case 'neutral':  break;                                    // mediocrity teaches nothing — no write
    case 'shortfall': case 'waste': case 'peril':
      recordBurn(a, key, evt.status, (evt.step.bind && (evt.step.bind._conf as number)) || 0, now);
      break;
  }
});

export {};
