// ---- the recipe-learning lifecycle, live (docs/architecture/10 execution) ----------------
// Drives the knowledge channels end-to-end with KNOW forced on in-test: (D) a crafter that lacks a
// recipe it wants DERIVES a Know(recipe) goal; (E) it executes a channel (observe/study) and comes
// away holding the recipe — Know(topic) is satisfied. Conserved (knowledge writes touch no gold).
import { FeatureStage } from './_stage.mjs';
import { goalLearn, knowsTopic } from '../../js/sim/planner.js';
import { deriveGoals } from '../../js/sim/motivation.js';
import { recipeConf, learnRecipe, forgetTick } from '../../js/sim/recipeKnow.js';
import { KNOW, RECIPES } from '../../js/sim/simconfig.js';

export function learningTest(ok, helpers) {
  const prev = KNOW.enabled;
  KNOW.enabled = true;
  try {
    // (D) DERIVATION — a crafter whose trade is a good it does not know the recipe for.
    {
      const st = new FeatureStage(helpers);
      const crafter = st.add('Sora', 0, 0);
      crafter._trade = 'potion';
      crafter.recipes && crafter.recipes.delete('potion');
      for (const k in crafter.needs) crafter.needs[k] = 1;
      deriveGoals(crafter, st.ctx());   // the derivation step in isolation (the channel runs so fast the goal pops in-frame)
      ok(crafter.goals.some((g) => g.kind === 'learn'),
        'learning D: a crafter lacking its recipe derives a Know(recipe) goal');
      st.dispose();
    }
    // (E) EXECUTION — push the learn goal; the cheapest channel runs and the recipe is acquired.
    {
      const st = new FeatureStage(helpers);
      const crafter = st.add('Sora', 0, 0);
      crafter.recipes && crafter.recipes.delete('potion');
      for (const k in crafter.needs) crafter.needs[k] = 1;
      const topic = { kind: 'recipe', good: 'potion' };
      crafter.pushGoal(goalLearn(topic), st.ctx());
      const ran = st.run(() => knowsTopic(crafter, topic), { maxFrames: 2000 });
      ok(knowsTopic(crafter, topic) && crafter.recipes.has('potion'),
        `learning E: the crafter learned the recipe (knows=${knowsTopic(crafter, topic)}, ${ran}f)`);
      st.dispose();
    }
    // (G) GRADED RECIPE KNOWLEDGE (docs/architecture/10-lld §6, §19 gap #1) — recipes carry a
    // confidence: HALF-learned from one session, firmed by repeated study (paying a conserved
    // tuition), and FORGOTTEN if not practised. Gated by RECIPES.graded (restored in finally so the
    // soak stays binary / byte-identical).
    {
      const prevG = RECIPES.graded; RECIPES.graded = true;
      try {
        const topic = { kind: 'recipe', good: 'potion' };
        // G1: one taught session HALF-learns it — graded conf below the craft bar, not yet craftable.
        const st = new FeatureStage(helpers);
        const learner = st.add('Sora', 0, 0);
        learner.recipes.delete('potion'); if (learner._recipeKnow) learner._recipeKnow.clear();
        learnRecipe(learner, 'potion', RECIPES.studyGain, 0, 1);
        const half = recipeConf(learner, 'potion');
        ok(half > 0 && half < RECIPES.craftMinConf && !learner.recipes.has('potion') && !knowsTopic(learner, topic),
          `learning G1: one session HALF-learns the recipe (conf=${half.toFixed(2)} < craft ${RECIPES.craftMinConf}, not yet craftable)`);
        // G2: repeated study firms it past the craft bar → known AND craftable.
        for (let i = 0; i < 3; i++) learnRecipe(learner, 'potion', RECIPES.studyGain, 0, 1);
        ok(recipeConf(learner, 'potion') >= RECIPES.craftMinConf && learner.recipes.has('potion') && knowsTopic(learner, topic),
          `learning G2: repeated study firms the recipe to craftable (conf=${recipeConf(learner, 'potion').toFixed(2)})`);
        st.dispose();
        // G3: CONSERVED TUITION — study pays a co-located teacher; gold MOVES, never minted.
        {
          const st2 = new FeatureStage(helpers);
          const student = st2.add('Pol', 0, 0); student.gold = 10; student.recipes.delete('tool');
          const teacher = st2.add('Mira', 0, 0); teacher.gold = 0; teacher.recipes.add('tool');
          const before = st2.totalGold();
          const taught = st2.ctx().resolver.teachRecipe(student, 'tool');
          ok(taught && student.gold === 10 - KNOW.studyTuition && teacher.gold === KNOW.studyTuition,
            `learning G3: tuition paid to a co-located teacher (student=${student.gold}, teacher=${teacher.gold})`);
          ok(Math.abs(st2.totalGold() - before) < 1e-6,
            `learning G3b: gold CONSERVED across tuition (${before} -> ${st2.totalGold()})`);
          st2.dispose();
        }
        // G4: FORGET — an unpractised recipe fades out of the craftable set; the practised trade stays.
        {
          const st3 = new FeatureStage(helpers);
          const maker = st3.add('Edda', 0, 0);
          maker._trade = 'tool';
          maker.recipes.add('tool'); maker.recipes.add('potion');
          maker._recipeKnow = new Map([['tool', { conf: 1, hops: 0, t: 0 }], ['potion', { conf: RECIPES.craftMinConf + 0.05, hops: 0, t: 0 }]]);
          for (let i = 0; i < 60; i++) forgetTick(maker, i, maker._trade);   // 60 ticks of NOT practising potion
          ok(maker.recipes.has('tool') && recipeConf(maker, 'tool') === 1,
            `learning G4: the PRACTISED trade stays sharp (tool conf=${recipeConf(maker, 'tool')})`);
          ok(!maker.recipes.has('potion') && recipeConf(maker, 'potion') < RECIPES.craftMinConf,
            `learning G4b: an UNPRACTISED recipe is forgotten out of the craftable set (potion conf=${recipeConf(maker, 'potion').toFixed(2)})`);
          st3.dispose();
        }
      } finally { RECIPES.graded = prevG; }
    }
  } finally { KNOW.enabled = prev; }
}
