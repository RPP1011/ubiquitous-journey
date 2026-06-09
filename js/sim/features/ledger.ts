// FEATURE: the obligation ledger, live (docs/architecture/10 execution). Wires the per-agent
// commitment store (js/sim/obligations.ts) into the cognition tick: each tick, settle obligations
// against perception (discharge a fired commitment, fire a recurrence at its due time, lapse the
// expired), and register a deriver that ARMS obligations + turns a fired one into its deferred
// action (e.g. a fired "pay when you deliver" pushes a pay/repay goal). All from THIS file as DATA
// rows. Gated by LEDGER.enabled; off → nothing live, soak byte-stable.
//
// TODO(worktree ledger): implement here, using:
//   import { registerDeriver } from '../exec/registry.js';
//   import { addObligation, settleObligations, triggerKey } from '../obligations.js';
//   - a producer: arm a commitment when a promise is made (e.g. a credit deal / a vow)
//   - the per-tick settle: build the fired-triggers set from this agent's fresh perception, call
//     settleObligations(a, fired, now); for each fired, push its deferred goal (pay/testify/repay)
//   - a recurrence example: a seasonal debt re-armed each time its time-trigger fires
//   Reads only the agent's OWN perception/beliefs (epistemic split); never the roster.
export {};
