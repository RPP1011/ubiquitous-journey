// ---- the obligation ledger (docs/architecture/10, Phase 5 — the one new store) ----------
// A small per-agent store of standing intentions checked against perception each tick: a
// COMMITMENT discharges when a perceived event fires its trigger and LAPSES at expiry; a
// RECURRENCE (a time-trigger) fires when its next-due time comes; re-arming dedups. The ledger
// only touches agent._obligations, so a tiny fake agent exercises it.

import { addObligation, settleObligations, obligationsOf, triggerKey } from '../../js/sim/obligations.js';

export function obligationsTest(ok) {
  const mkAgent = () => ({ id: 1 });

  // COMMITMENT — "I'll pay X when X delivers to me": armed now, discharged when perception fires.
  const a = mkAgent();
  addObligation(a, { trigger: 'delivered', action: 'pay', counterparty: 7, amount: 5, expiry: 100 });
  ok(obligationsOf(a).length === 1, 'ledger: a commitment is armed onto the store');

  // nothing perceived yet, not expired → kept, nothing fired.
  let fired = settleObligations(a, new Set(), 10);
  ok(fired.length === 0 && obligationsOf(a).length === 1, 'ledger: an unfired, unexpired commitment is kept');

  // perception sees X deliver → the armed trigger fires, the obligation discharges (pay now).
  fired = settleObligations(a, new Set([triggerKey({ trigger: 'delivered', counterparty: 7 })]), 20);
  ok(fired.length === 1 && fired[0].action === 'pay' && obligationsOf(a).length === 0,
    'ledger: a perceived event discharges the commitment (and removes it)');

  // LAPSE — a commitment whose window passes without firing is dropped (the promise expired).
  const b = mkAgent();
  addObligation(b, { trigger: 'delivered', action: 'pay', counterparty: 7, expiry: 50 });
  const f2 = settleObligations(b, new Set(), 60);
  ok(f2.length === 0 && obligationsOf(b).length === 0, 'ledger: an unfired commitment lapses at its expiry');

  // RECURRENCE — a debt due each season is a time-trigger that fires when its next-due time comes.
  const c = mkAgent();
  addObligation(c, { trigger: 'time', action: 'repay', dueAt: 100, expiry: 1e9 });
  let f3 = settleObligations(c, null, 50);   // before due
  ok(f3.length === 0 && obligationsOf(c).length === 1, 'ledger: a recurring duty waits until it is due');
  f3 = settleObligations(c, null, 100);      // due
  ok(f3.length === 1 && f3[0].action === 'repay' && obligationsOf(c).length === 0,
    'ledger: a recurring duty fires when its time comes due');

  // DEDUP + BOUND — re-arming the same intention doesn't duplicate it.
  const d = mkAgent();
  addObligation(d, { trigger: 'delivered', action: 'pay', counterparty: 9, expiry: 100 });
  addObligation(d, { trigger: 'delivered', action: 'pay', counterparty: 9, expiry: 100 });
  ok(obligationsOf(d).length === 1, 'ledger: re-arming the same intention dedups');

  // never throws on a missing/empty ledger.
  let threw = false;
  try { settleObligations({ id: 2 }, new Set(), 0); settleObligations(null, null, 0); } catch { threw = true; }
  ok(!threw, 'ledger: settling a missing/empty ledger never throws');
}
