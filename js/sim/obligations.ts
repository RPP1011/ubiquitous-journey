// THE OBLIGATION LEDGER (docs/architecture/10, Phase 5) — the one piece of genuinely new
// machinery the action grammar needs. A small per-agent store of standing INTENTIONS, each a
// (trigger, deferred action, counterparty, expiry), checked against perception each tick. It
// absorbs the two things the design pushed out of the one-shot plan:
//   · COMMITMENTS — "I'll pay you when you deliver", "I'll testify if you do": a thing promised
//     now and discharged later when a perceived event comes to pass (or lapsed at expiry);
//   · RECURRENCE — a debt due each season, a nightly patrol: a trigger that is a TIME, re-derived
//     each time it comes due (a plan is one-shot, so the schedule cannot live in the plan).
// A ledger entry OUTLIVES every plan the agent makes between promising and keeping — which is
// exactly why a commitment cannot just be a hold-until step (that dies with its plan). It is
// structurally a little belief table with decay: a handful of entries per agent, most empty.
//
// SAFETY (the freeze lesson): every function is guarded and never throws; the store is bounded
// (LEDGER.max). These are pure helpers; the per-tick wiring lives in the ledger feature
// (ALWAYS-LIVE on the mainline).

import { LEDGER } from './simconfig.js';
import { foldObligationDefault } from './signals.js';
import type { Agent, Obligation } from '../../types/sim.js';

// A stable identity for an obligation (so adds dedup + perception can match a fired trigger).
function key(o: Obligation): string { return `${o.trigger}:${o.action}:${o.counterparty ?? ''}`; }
// The trigger identity perception fires against — what-happened to / by whom.
export function triggerKey(o: Pick<Obligation, 'trigger' | 'counterparty'>): string {
  return `${o.trigger}:${o.counterparty ?? ''}`;
}

// Arm a standing intention. Dedups by (trigger, action, counterparty); bounded by LEDGER.max
// (oldest dropped, like the belief table). Lazily creates the per-agent store. Guarded.
export function addObligation(agent: Agent, obl: Obligation): void {
  if (!agent || !obl) return;
  try {
    if (!agent._obligations) agent._obligations = [];
    const k = key(obl);
    if (agent._obligations.some((o) => key(o) === k)) return;   // already armed
    agent._obligations.push(obl);
    while (agent._obligations.length > (LEDGER.max || 8)) agent._obligations.shift();
  } catch { /* never throw on the tick */ }
}

export function obligationsOf(agent: Agent): Obligation[] {
  return (agent && Array.isArray(agent._obligations)) ? agent._obligations : [];
}

// The per-tick settle pass: DISCHARGE every obligation whose trigger fired (a perceived event in
// `firedTriggers`, or a recurrence whose `dueAt` time has come), DROP every one that has lapsed
// (now past its expiry without firing), and KEEP the rest. Returns the FIRED obligations — the
// deferred actions to take now (pay the coin, testify, re-derive the recurring duty). Mutates the
// agent's ledger (removes fired + lapsed). `firedTriggers` is the set of triggerKey()s perception
// raised this tick. Guarded; never throws; a missing/empty ledger is a no-op returning [].
// `onLapse` (optional) is called with each DEFAULTED obligation (a pay/repay that lapsed unkept) so
// the caller can leak the social consequence — the credit-default standing hit (ledger.ts) routes the
// FORSWORN-style belief fold through it. Defaulting still folds the per-agent tally here regardless.
export function settleObligations(agent: Agent, firedTriggers: Set<string> | null, now: number, onLapse?: (o: Obligation) => void): Obligation[] {
  if (!agent || !Array.isArray(agent._obligations) || !agent._obligations.length) return [];
  const fired: Obligation[] = [];
  try {
    agent._obligations = agent._obligations.filter((o) => {
      if (!o) return false;
      // RECURRENCE: a time-triggered duty fires when its next-due time has come.
      if (o.trigger === 'time' && o.dueAt != null && now >= o.dueAt) { fired.push(o); return false; }
      // COMMITMENT: a perceived event satisfies the armed trigger ("you delivered" → I pay).
      if (firedTriggers && firedTriggers.has(triggerKey(o))) { fired.push(o); return false; }
      // LAPSE: the window passed without the trigger ever firing — drop it (the promise expired).
      // §13 D.creditLoad: a lapsed obligation is a DEFAULT — fold a per-agent default tally (own-state;
      // the town aggregate reads these in the observer pass). Only a real obligation (pay/repay) defaults.
      if (now >= o.expiry) {
        if (o.action === 'pay' || o.action === 'repay') { foldObligationDefault(agent, 1); if (onLapse) { try { onLapse(o); } catch { /* never throw */ } } }
        return false;
      }
      return true;
    });
  } catch { /* never throw on the tick */ }
  return fired;
}
