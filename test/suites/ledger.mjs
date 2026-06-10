// ---- the obligation ledger, live (docs/architecture/10 execution) ------------------------
// Drives the ledger's per-tick wiring through the frame loop (always-live on the mainline): a
// `succoured` memory ARMS a repay-on-next-meeting commitment; perceiving the benefactor FIRES it; the
// deferred action (a repay goal, marked from='obligation') is taken. (The pure-store unit checks live
// in obligations.mjs.) Also checks a recurrence fires at its due time and an unfired commitment lapses.
import { FeatureStage } from './_stage.mjs';
import { addObligation, settleObligations } from '../../js/sim/obligations.js';

export function ledgerLiveTest(ok, helpers) {
  {
    // LIVE — a kindness received arms a commitment; meeting the benefactor fires the deferred repay.
    {
      const st = new FeatureStage(helpers);
      const a = st.add('Ines', 0, 0);
      const ben = st.add('Gris', 4, 0);
      for (const k in a.needs) a.needs[k] = 1;
      st.inject(a, { t: st.sim.time, kind: 'succoured', withId: ben.id, valence: 1, salience: 0.9 });
      st.believe(a, ben);   // I currently perceive my benefactor → the 'meet' trigger fires
      st.run(() => a.goals.some((g) => g.kind === 'repay' && g.from === 'obligation'),
        { maxFrames: 40, pin: [[ben, 4, 0]], refresh: [[a, ben]] });
      ok(a.goals.some((g) => g.kind === 'repay' && g.from === 'obligation'),
        'ledger LIVE: a succoured memory armed a commitment that fired into a repay goal on meeting the benefactor');
      st.dispose();
    }
    // RECURRENCE — a time-triggered duty fires when its due time has come.
    {
      const st = new FeatureStage(helpers);
      const a = st.add('Bru', 0, 0);
      addObligation(a, { trigger: 'time', action: 'pay', counterparty: 99, dueAt: 5, expiry: 1000, at: 0 });
      const fired = settleObligations(a, null, 6);
      ok(fired.length === 1 && fired[0].action === 'pay', 'ledger RECUR: a time-triggered duty fired at its due time');
      st.dispose();
    }
    // LAPSE — a commitment whose trigger never fires is dropped once past expiry.
    {
      const st = new FeatureStage(helpers);
      const a = st.add('Vex', 0, 0);
      addObligation(a, { trigger: 'meet', action: 'repay', counterparty: 77, expiry: 10, at: 0 });
      settleObligations(a, null, 20);   // past expiry, never met
      ok((a._obligations || []).length === 0, 'ledger LAPSE: an unfired commitment lapsed at expiry');
      st.dispose();
    }
  }
}
