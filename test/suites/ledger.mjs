// ---- the obligation ledger, live (docs/architecture/10 execution) ------------------------
// Drives the ledger through the frame loop with LEDGER forced on in-test: an agent arms a
// commitment, perception fires its trigger, the deferred action (a pay/repay goal) is taken; a
// recurrence fires at its due time; an unfired commitment lapses. (The pure-store unit checks
// live in obligations.mjs.) Filled by the ledger worktree.
export function ledgerLiveTest(ok, helpers) {
  // TODO(worktree ledger): per-tick settle wiring + a fired commitment taking its deferred action.
}
