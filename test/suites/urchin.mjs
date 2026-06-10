// ---- the urchin heist, live (docs/architecture/10 execution) ----------------------------
// Drives the surveil→approach→burgle heist end-to-end through the REAL frame loop with URCHIN
// forced on in-test (restored after). Asserts: (D) a poor + larcenous agent DERIVES a steal goal
// against a believed mark; (E) the heist executes — gold is CONSERVED (the take debits the mark,
// never mints) and the consequence EMERGES (the mark sours / grows suspicious of the thief).
import { FeatureStage } from './_stage.mjs';
import { goalSteal, estimateHaul } from '../../js/sim/planner.js';
import { URCHIN, QUANTITY, ESTIMATE } from '../../js/sim/simconfig.js';

export function urchinTest(ok, helpers) {
  const prevU = URCHIN.enabled, prevQ = QUANTITY.enabled;
  URCHIN.enabled = true; QUANTITY.enabled = true;
  try {
    // (D) DERIVATION — a poor, larcenous, professionless townsperson with a believed mark.
    {
      const st = new FeatureStage(helpers);
      const thief = st.add('Pip', 0, 0, { personality: { altruism: 0.2, risk_tolerance: 0.8 } });
      const mark = st.add('Olen', 8, 0);
      st.strip(thief);
      for (const k in thief.needs) thief.needs[k] = 1;           // sated, so the heist isn't crowded out
      st.believe(thief, mark); st.believe(thief, mark);          // a confident belief about the mark
      st.run(() => thief.goals.some((g) => g.kind === 'steal'), { maxFrames: 30, pin: [[mark, 8, 0]], refresh: [[thief, mark]] });
      ok(thief.goals.some((g) => g.kind === 'steal' && g.subjectId === mark.id),
        'urchin D: a poor + larcenous agent derives a steal goal against a believed mark');
      st.dispose();
    }
    // (E) EXECUTION — push the steal goal and run the heist to a paid theft.
    {
      const st = new FeatureStage(helpers);
      const thief = st.add('Pip', 0, 0, { personality: { altruism: 0.2, risk_tolerance: 0.8 } });
      const mark = st.add('Olen', 8, 0);
      st.strip(thief);
      for (const k in thief.needs) thief.needs[k] = 1;
      mark.gold = 30;
      const before = st.totalGold();
      st.believe(thief, mark);
      thief.pushGoal(goalSteal(mark.id, 16), st.ctx());
      const ran = st.run(() => (thief.gold || 0) > 0, { maxFrames: 3000, pin: [[mark, 8, 0]], refresh: [[thief, mark]] });
      ok((thief.gold || 0) > 0 && (mark.gold || 0) < 30,
        `urchin E1: the heist paid — thief lifted gold off the mark (thief=${thief.gold | 0}, mark=${mark.gold | 0}, ${ran}f)`);
      ok(Math.abs(st.totalGold() - before) < 1e-6,
        `urchin E2: gold CONSERVED across the theft (${before} -> ${st.totalGold()})`);
      const rel = mark.beliefs.get(thief.id);
      ok(!!rel && (rel.suspicion || 0) > 0,
        `urchin E3: the consequence EMERGED — the mark grew suspicious of the thief (susp=${rel ? rel.suspicion.toFixed(2) : 'n/a'})`);
      st.dispose();
    }
    // (W) WEALTH-CUE ESTIMATION (docs/architecture/10-lld §15) — the haul is an inferred EXPECTED
    // value with a confidence, read off belief cues, not a flat constant. Gated by ESTIMATE.enabled
    // (off → the deriver keeps URCHIN.deriveTarget; restored in finally so the soak is byte-stable).
    {
      const prevE = ESTIMATE.enabled; ESTIMATE.enabled = true;
      try {
        const st = new FeatureStage(helpers);
        const thief = st.add('Pip', 0, 0, { personality: { altruism: 0.2, risk_tolerance: 0.8 } });
        const rich = st.add('Rych', 8, 0);
        const poor = st.add('Plin', -8, 0);
        st.strip(thief);
        for (const k in thief.needs) thief.needs[k] = 1;            // sated, so the heist isn't crowded out
        st.believe(thief, rich); st.believe(thief, poor);
        // make `rich` READ prosperous from perceivable cues: a SEEN stash + believed fame. `poor` is a
        // bare acquaintance (a shakier, lower belief). Neither read touches the real purse — §15.
        const br = thief.beliefs.get(rich.id);
        br.recordAssocSighting('stash', rich.pos, 0.9, 1); br.notoriety = 0.6;
        const bp = thief.beliefs.get(poor.id); bp.confidence = 0.3;
        const er = estimateHaul(thief, rich.id), ep = estimateHaul(thief, poor.id);
        ok(er.value > ep.value,
          `urchin W1: a believed-richer mark estimates a higher haul (${er.value.toFixed(1)} > ${ep.value.toFixed(1)})`);
        ok(er.confidence > ep.confidence,
          `urchin W2: a stash-seen first-hand belief is a more confident estimate (${er.confidence.toFixed(2)} > ${ep.confidence.toFixed(2)})`);
        // the deriver marks the believed-RICHEST of the two, and the goal aims for the ESTIMATE.
        st.run(() => thief.goals.some((g) => g.kind === 'steal'),
          { maxFrames: 60, pin: [[rich, 8, 0], [poor, -8, 0]], refresh: [[thief, rich], [thief, poor]] });
        const g = thief.goals.find((gg) => gg.kind === 'steal');
        ok(!!g && g.subjectId === rich.id,
          `urchin W3: the urchin marks the believed-RICHEST of two (mark=${g ? g.subjectId : 'none'})`);
        ok(!!g && Math.round(g.target) === Math.round(estimateHaul(thief, rich.id).value) && g.target !== URCHIN.deriveTarget,
          `urchin W4: the heist aims for the ESTIMATED haul, not the flat constant (target=${g ? g.target : 'n/a'}, flat=${URCHIN.deriveTarget})`);
        st.dispose();
      } finally { ESTIMATE.enabled = prevE; }
    }
  } finally { URCHIN.enabled = prevU; QUANTITY.enabled = prevQ; }
}
