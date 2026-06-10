// ---- the Affect rows rob/free/wreck, live (docs/architecture/10 execution) ---------------
// Drives rob (conserved theft by force), free (cut a captive's bonds), and wreck (sabotage) end-
// to-end through the frame loop (all always-live on the mainline). Asserts gold CONSERVED on a
// steal, the freed/wrecked flags flip, and the reaction EMERGES (the theft is seen → the mark sours).
import { FeatureStage } from './_stage.mjs';
import { goalSteal, goalFree, goalWreck } from '../../js/sim/planner.js';
import { deriveGoals } from '../../js/sim/motivation.js';
import { CAPTIVE } from '../../js/sim/simconfig.js';

export function affectTest(ok, helpers) {
  {
    // ROB / STEAL — take off the mark (the planner picks the cheaper of rob/burgle). MOVED ⇒ conserved.
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
      st.sim.sagas.openArc({ kind: 'rescue', key: 'rescue:' + captive.id, principals: [rescuer.id, captive.id] });   // (the deriver's open)
      st.run(() => captive._held === false, { maxFrames: 1500, pin: [[captive, 5, 0]], refresh: [[rescuer, captive]] });
      ok(captive._held === false && captive._freedBy === rescuer.id,
        `affect FREE: the captive's bonds were cut (_held=${captive._held}, _freedBy=${captive._freedBy})`);
      // ARC (docs/architecture/12 §3.5): the free executor CLOSED the rescue arc 'freed'.
      ok(st.sim.sagas.recentClosed().some((x) => x.kind === 'rescue' && x.outcome === 'freed'),
        'affect FREE: the free executor closed the rescue arc `freed`');
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
    // CLEAR-THE-GUARDS (docs/architecture/12 §7) — a rescuer that believes a HOSTILE sits beside the
    // believed-captive prepends an avenge-shaped attack subgoal (fell the guard before the free step).
    {
      const st = new FeatureStage(helpers);
      const rescuer = st.add('Bold', 0, 0, { personality: { risk_tolerance: 0.9, altruism: 0.8, social_drive: 0.4, ambition: 0.4, curiosity: 0.4 } });
      const captive = st.add('Friend', 8, 0);
      const guard = st.add('Brute', 8.5, 0, { faction: 'bandit' });
      // the rescuer believes: a dear captive (b.captive + warm standing) AND a hostile guard beside it.
      st.believe(rescuer, captive); const cb = rescuer.beliefs.get(captive.id); cb.captive = true; cb.standing = 0.6; cb.confidence = 1;
      st.believe(rescuer, guard, true); const gb = rescuer.beliefs.get(guard.id); gb.confidence = 1;
      deriveGoals(rescuer, st.sim._cognitionCtx());
      ok(rescuer.goals.some((g) => g.kind === 'free' && g.subjectId === captive.id), 'affect GUARD: the rescue goal is derived');
      ok(rescuer.goals.some((g) => g.kind === 'avenge' && g.subjectId === guard.id && g.from === 'rescue_guard'),
        'affect GUARD: an avenge-shaped subgoal is prepended to clear the guard beside the captive');
      st.dispose();
    }

    // ── CAPTIVITY → RESCUE (the `free` arc trigger, docs/architecture/10-lld §19 item 3) ──────────
    const prevChance = CAPTIVE.captureChance;
    CAPTIVE.captureChance = 1;   // force capture on a qualifying lethal blow (deterministic in-test)
    try {
      // CAPTURE-ON-DEFEAT (execution, ground truth): a bandit's lethal blow on a non-combatant
      // townsperson is converted to a CAPTURE — the victim is revived, _held, _captorId set.
      {
        const st = new FeatureStage(helpers);
        const bandit = st.add('Skar', 0, 0, { faction: 'bandit', combatant: true });
        const victim = st.add('Pell', 2, 0);   // townsfolk, non-combatant
        const before = st.totalGold();
        // synthesise the lethal blow the same way the frame loop delivers it to onCombatEvents.
        victim.fighter.takeHit(9999, victim.fighter.dir);            // drive HP to 0 → a real 'dead'
        st.sim.onCombatEvents([{ type: 'dead', attacker: { agent: bandit }, target: { agent: victim } }]);
        ok(victim._held === true && victim._captorId === bandit.id && victim.alive === true,
          `CAPTIVE CAP1: a defeated townsperson was CAPTURED not killed (_held=${victim._held}, captor=${victim._captorId}, alive=${victim.alive})`);
        ok(Math.abs(st.totalGold() - before) < 1e-6, `CAPTIVE CAP2: gold conserved across capture (${before} -> ${st.totalGold()})`);
        st.dispose();
      }
      // PERCEIVE CAPTIVITY (perception writes belief): an onlooker who SEES a _held subject records
      // b.captive on its OWN belief — the epistemic split (the deriver reads only the belief).
      {
        const st = new FeatureStage(helpers);
        const onlooker = st.add('Wynn', 0, 0);
        const captive = st.add('Pell', 3, 0);
        captive._held = true; captive._captorId = 999;
        st.run(() => { const b = onlooker.beliefs.get(captive.id); return !!(b && b.captive); },
          { maxFrames: 400, pin: [[captive, 3, 0], [onlooker, 0, 0]] });
        const b = onlooker.beliefs.get(captive.id);
        ok(!!b && b.captive === true, `CAPTIVE PER: perception set b.captive on the onlooker's belief (captive=${b && b.captive})`);
        st.dispose();
      }
      // RESCUE DERIVER + EXECUTOR + EMERGENT GRATITUDE (cognition belief-only → free → warmth).
      {
        const st = new FeatureStage(helpers);
        const rescuer = st.add('Mara', 0, 0, { personality: { altruism: 0.9, risk_tolerance: 0.6 } });
        const captive = st.add('Pell', 4, 0);
        captive._held = true; captive._captorId = 999;
        // the rescuer LIKES the captive (high standing) — the gate for a rescue.
        const rel = rescuer.beliefs.observe(captive.id, captive.faction, captive.pos, st.sim.time, false);
        rel.standing = 0.8; rel.confidence = 1;
        // let perception write b.captive + the deriver form the goal, then drive it to completion.
        const derived = st.run(() => rescuer.goals.some((g) => g && g.kind === 'free' && g.subjectId === captive.id),
          { maxFrames: 600, pin: [[captive, 4, 0]], refresh: [[rescuer, captive]] });
        ok(rescuer.goals.some((g) => g && g.kind === 'free' && g.subjectId === captive.id),
          `CAPTIVE RES1: a liked believed-captive made the rescuer DERIVE goalFree (${derived}f)`);
        // run it: the rescuer walks to the captive and cuts its bonds (the free executor).
        st.run(() => captive._held === false,
          { maxFrames: 2000, pin: [[captive, 4, 0]] });
        ok(captive._held === false && captive._freedBy === rescuer.id,
          `CAPTIVE RES2: the rescuer freed the captive (_held=${captive._held}, _freedBy=${captive._freedBy})`);
        // emergent gratitude: the freed captive, perceiving _freedBy, warms toward its rescuer
        // through its OWN belief (per-perceiver, not a baked reaction).
        st.run(() => { const cb = captive.beliefs.get(rescuer.id); return !!(cb && cb.standing > 0.2); },
          { maxFrames: 600, pin: [[rescuer, captive.fighter.root.position.x, captive.fighter.root.position.z]] });
        const cb = captive.beliefs.get(rescuer.id);
        ok(!!cb && cb.standing > 0.2, `CAPTIVE RES3: the freed captive's gratitude EMERGED — it warmed toward its rescuer (standing=${cb && cb.standing.toFixed(2)})`);
        st.dispose();
      }
    } finally { CAPTIVE.captureChance = prevChance; }
  }
}
