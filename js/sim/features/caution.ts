// FEATURE: outcome-conditioned caution (docs/architecture/11). The SMALLEST feature — caution is
// pure cost-shaping, so it registers NO verbs, NO executors, NO derivers, NO effect-holds. It is one
// PLAN_OUTCOME handler: when a watched act resolves (classified by act.ts / motivation.ts emit sites),
// it writes the per-strategy surcharge through the pure experience.ts store. The read side lives in
// the planner (feltSurcharge beside confidenceSurcharge). The registries' cleanest proof that a
// behaviour-shaping feature can be a single registered row.
//
// ALWAYS-LIVE on the mainline: the handler writes the surcharge whenever a watched act resolves,
// and the read side (feltSurcharge) prices it into the plan.

import { registerPlanOutcome } from '../exec/registry.js';
import { recordBurn, recordWindfall, expKey } from '../experience.js';

registerPlanOutcome((a, ctx, evt) => {
  if (!a || !evt || !evt.step) return;
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
