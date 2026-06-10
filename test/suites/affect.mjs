// ---- the Affect rows rob/free/wreck, live (docs/architecture/10 execution) ---------------
// Drives rob (conserved theft by force), free (cut a captive's bonds), and wreck (sabotage) end-
// to-end through the frame loop with ROB/AFFECT forced on in-test. Asserts gold CONSERVED on a rob,
// the freed/wrecked flags flip, and the reaction EMERGES (a robbery is seen → the mark sours).
import { FeatureStage } from './_stage.mjs';
import { goalSteal, goalFree, goalWreck } from '../../js/sim/planner.js';
import { ROB, AFFECT, URCHIN } from '../../js/sim/simconfig.js';

export function affectTest(ok, helpers) {
  const prevR = ROB.enabled, prevA = AFFECT.enabled, prevU = URCHIN.enabled;
  ROB.enabled = true; AFFECT.enabled = true; URCHIN.enabled = false;   // URCHIN off → steal routes through `rob`
  try {
    // ROB — take by force off the mark's person (no cache). MOVED ⇒ conserved.
    {
      const st = new FeatureStage(helpers);
      const thug = st.add('Brak', 0, 0, { personality: { greed: 0.9 } });
      const mark = st.add('Olen', 6, 0);
      st.strip(thug); mark.gold = 20;
      for (const k in thug.needs) thug.needs[k] = 1;
      const before = st.totalGold();
      st.believe(thug, mark);
      thug.pushGoal(goalSteal(mark.id, 5), st.ctx());
      const ran = st.run(() => (thug.gold || 0) > 0, { maxFrames: 1500, pin: [[mark, 6, 0]], refresh: [[thug, mark]] });
      ok((thug.gold || 0) > 0 && (mark.gold || 0) < 20,
        `affect ROB1: a robbery paid (thug=${thug.gold | 0}, mark=${mark.gold | 0}, ${ran}f)`);
      ok(Math.abs(st.totalGold() - before) < 1e-6, `affect ROB2: gold CONSERVED (${before} -> ${st.totalGold()})`);
      const rel = mark.beliefs.get(thug.id);
      ok(!!rel && (rel.suspicion || 0) > 0, 'affect ROB3: the mark soured — robbery is seen, the consequence emerged');
      st.dispose();
    }
    // FREE — cut a captive's bonds. The physical change only (_held flips, _freedBy records who).
    {
      const st = new FeatureStage(helpers);
      const rescuer = st.add('Mara', 0, 0);
      const captive = st.add('Wren', 5, 0);
      captive._held = true;
      st.believe(rescuer, captive);
      rescuer.pushGoal(goalFree(captive.id), st.ctx());
      st.run(() => captive._held === false, { maxFrames: 1500, pin: [[captive, 5, 0]], refresh: [[rescuer, captive]] });
      ok(captive._held === false && captive._freedBy === rescuer.id,
        `affect FREE: the captive's bonds were cut (_held=${captive._held}, _freedBy=${captive._freedBy})`);
      st.dispose();
    }
    // WRECK — sabotage a target (the _wrecked flag flips; an owner's anger would emerge from sight).
    {
      const st = new FeatureStage(helpers);
      const saboteur = st.add('Cole', 0, 0);
      const target = st.add('Rig', 5, 0);
      st.believe(saboteur, target);
      saboteur.pushGoal(goalWreck(target.id), st.ctx());
      st.run(() => target._wrecked === true, { maxFrames: 1500, pin: [[target, 5, 0]], refresh: [[saboteur, target]] });
      ok(target._wrecked === true, `affect WRECK: the target was sabotaged (_wrecked=${target._wrecked})`);
      st.dispose();
    }
  } finally { ROB.enabled = prevR; AFFECT.enabled = prevA; URCHIN.enabled = prevU; }
}
