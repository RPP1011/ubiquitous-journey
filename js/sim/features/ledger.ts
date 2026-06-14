// FEATURE: the obligation ledger, live (docs/architecture/10 + 10-lld §11). Wires the per-agent
// commitment store (js/sim/obligations.ts) into the cognition tick as a DATA-row deriver: each tick
// it (1) ARMS a commitment when a perceivable promise is made, (2) SETTLES the ledger against this
// agent's OWN perception (discharge a fired commitment, fire a recurrence at its due time, lapse the
// expired), and (3) turns each fired obligation into its deferred goal. ALWAYS-LIVE on the mainline.
//
// A commitment is armed for a SPECIFIC perceived event ("when I next meet my benefactor → repay")
// and OUTLIVES every plan between promising and keeping — which is exactly why it lives here, not as
// a hold-until step (that dies with its plan). The producer here arms a repay-on-next-meeting
// commitment from a `succoured` memory: distinct from passive reciprocity in that it is an armed
// trigger, persisted across re-plans, fired by perceiving the counterparty. Reads the agent's OWN
// memory + beliefs only (the epistemic split); never the roster.

import { registerDeriver } from '../exec/registry.js';
import { addObligation, settleObligations, triggerKey } from '../obligations.js';
import { goalRepay } from '../planner.js';
import { LEDGER, SIM } from '../simconfig.js';
import type { Agent, CognitionCtx, EntityId } from '../../../types/sim.js';

registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!a || a.controlled || a.faction === 'monster') return;
  const now = ctx ? ctx.time : 0;

  // (1) PRODUCER — arm a repay-on-next-meeting commitment from a succoured memory (a kindness
  // received). The trigger is the perceived event "I meet my benefactor again"; it persists across
  // every re-plan until kept or lapsed. Bounded + deduped by addObligation.
  try {
    const salient = a.memory && typeof a.memory.salient === 'function' ? a.memory.salient() : null;
    if (Array.isArray(salient)) {
      for (const ep of salient) {
        if (ep && ep.kind === 'succoured' && ep.withId != null && ep.withId !== a.id) {
          addObligation(a, { trigger: 'meet', action: 'repay', counterparty: ep.withId, amount: 1, at: now, expiry: now + (LEDGER.commitExpiry || 300) });
        }
      }
    }
  } catch { /* never throw on the tick */ }

  // (2) SETTLE — build the fired-triggers set from this agent's OWN fresh perception: a counterparty
  // I currently hold a confident, freshly-updated belief about counts as "met". Plus time triggers
  // (recurrence) are handled inside settleObligations by `now`. A DEFAULTED debt (a pay/repay that
  // lapsed unkept — chiefly a CREDIT debt never settled within its term) leaks its social consequence
  // through onLapse: the conserved witnessDeed primitive sours the creditor's belief toward this
  // defaulter + spreads bystander suspicion (per-perceiver, witness-gated — the FORSWORN-style leak).
  const fired = settleObligations(a, perceivedTriggers(a, now), now, (o) => {
    if (o.action !== 'repay' && o.action !== 'pay') return;
    if (o.counterparty == null || !ctx || !ctx.resolver || !ctx.resolver.witnessDeed) return;
    ctx.resolver.witnessDeed(a, o.counterparty, 'default', LEDGER.defaultSeverity || 0.3);
  });

  // (3) DISCHARGE — each fired obligation becomes its deferred goal (the repay the promise deferred).
  for (const o of fired) {
    if (o.action === 'repay' && o.counterparty != null) {
      const g = goalRepay(o.counterparty, o.amount || 1, 'any');
      g.priority = 0.75; g.from = 'obligation';
      g.expiresAt = now + 200;
      a.pushGoal(g, ctx);
    }
  }
});

// The set of triggerKey()s this agent's perception raises THIS tick — belief-only: a counterparty
// I hold a confident, recently-updated belief about is one I have "met" (seen) again.
function perceivedTriggers(a: Agent, now: number): Set<string> {
  const out = new Set<string>();
  if (!a.beliefs) return out;
  for (const b of a.beliefs.all()) {
    if (!b || (b.confidence || 0) < SIM.actOnBeliefMin) continue;   // a confident belief ≈ I can see them
    out.add(triggerKey({ trigger: 'meet', counterparty: b.subjectId as EntityId }));
  }
  return out;
}

export {};
