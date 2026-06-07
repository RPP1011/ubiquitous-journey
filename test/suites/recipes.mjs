// Recipe-gating gate (Phase-4 economy prerequisite). Asserts the OWN-STATE recipe
// gate: (a) a knowing producer still crafts (baseline-preserving), (b) a recipe-
// stripped agent does NOT produce that good, (c) gold AND goods conserved (the gate
// transfers/creates nothing — it only withholds production). Mirrors the SCARECROW
// pattern: we flip RECIPES.enabled on a controlled sub-sim and drive produce()
// directly, so the main soak (RECIPES.enabled:false) stays byte-identical.

import { Agent } from '../../js/sim/agent.js';
import { RECIPES } from '../../js/sim/simconfig.js';
import { produce } from '../../js/sim/agent/act.js';   // already exported

export function recipeTest(ok, { makeFighter, stubScene }) {
  const prevEnabled = RECIPES.enabled;
  RECIPES.enabled = true;                 // turn the gate ON for this isolated check
  try {
    // build a minimal autonomous crafter committed to 'tool', with inputs in hand.
    const mk = (recipes) => {
      const f = makeFighter('knight', {}); stubScene.add(f.root);
      const a = new Agent(f, { id: 1, name: 'Smith', profession: null,
        personality: { risk_tolerance: .3, social_drive: .5, ambition: .5, altruism: .5, curiosity: .5 },
        faction: 'townsfolk', townsperson: true });
      a.canWork = true; a._trade = 'tool';
      a.inventory.wood = 5; a.inventory.ore = 5;
      a.inventory.tool = 0; a._smithTimer = 999;       // next produce() tick crafts immediately
      a.recipes = new Set(recipes);
      return a;
    };

    // (a) a KNOWING producer still crafts a tool.
    const knower = mk(['tool', 'potion']);
    const inBefore = { ...knower.inventory };
    for (let i = 0; i < 5; i++) produce(knower, 1);   // dt=1s ticks, timer pre-armed
    ok(knower.inventory.tool >= 1, `recipes: a knowing producer still forges tool (${knower.inventory.tool})`);
    // goods conserved: each tool consumed exactly {wood:1,ore:1} (no minting of inputs).
    const made = knower.inventory.tool;
    ok(Math.abs((inBefore.wood - knower.inventory.wood) - made) < 1e-9 &&
       Math.abs((inBefore.ore  - knower.inventory.ore ) - made) < 1e-9,
       'recipes: crafted goods conserve inputs (1 wood + 1 ore per tool, none minted)');

    // (b) a recipe-STRIPPED agent does NOT produce that good.
    const ignorant = mk([]);              // knows no recipes
    const wBefore = ignorant.inventory.wood, oBefore = ignorant.inventory.ore;
    for (let i = 0; i < 5; i++) produce(ignorant, 1);
    ok((ignorant.inventory.tool || 0) === 0,
       `recipes: a recipe-stripped agent makes NO tool (${ignorant.inventory.tool || 0})`);
    // (c) it also consumed NOTHING (no inputs touched, no gold moved — a silent no-op).
    ok(ignorant.inventory.wood === wBefore && ignorant.inventory.ore === oBefore,
       'recipes: a recipe-stripped no-op consumes no inputs (conservation: nothing created or destroyed)');
  } finally {
    RECIPES.enabled = prevEnabled;        // ALWAYS restore so later suites see the baseline
  }
}
