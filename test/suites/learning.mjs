// ---- the recipe-learning lifecycle, live (docs/architecture/10 execution) ----------------
// Drives the knowledge channels end-to-end with KNOW forced on in-test: (D) a crafter that lacks a
// recipe it wants DERIVES a Know(recipe) goal; (E) it executes a channel (observe/study) and comes
// away holding the recipe — Know(topic) is satisfied. Conserved (knowledge writes touch no gold).
import { FeatureStage } from './_stage.mjs';
import { goalLearn, knowsTopic } from '../../js/sim/planner.js';
import { deriveGoals } from '../../js/sim/motivation.js';
import { KNOW } from '../../js/sim/simconfig.js';

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
  } finally { KNOW.enabled = prev; }
}
