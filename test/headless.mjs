// Headless simulation harness — runs the WHOLE sim with no renderer/DOM, the way
// main.js drives it each frame (sim.update -> fighter.update -> resolveCombat ->
// onCombatEvents), and asserts the invariants that matter. This is the fast
// regression check the browser game never had.
//
//   bun test/headless.mjs        # exit 0 = all good, 1 = a check failed
//
// Resolution of the bare `three` specifier is handled by tsconfig.json paths
// (mirrors index.html's import map). See docs / CLAUDE.md.
//
// This file is a THIN runner: the shared tally + builders live in test/harness.mjs,
// and each domain's checks live in test/suites/*.mjs. We import them, run them in
// the same order as before, fold every result into one tally, and set the exit code.

import { makeOk, stubScene, makeFighter } from './harness.mjs';
import { combatUnit } from './suites/combat.mjs';
import { proceduralAbilityTest } from './suites/abilities.mjs';
import { plannerSelfTest } from './suites/planner.mjs';
import { executionTest } from './suites/execution.mjs';
import { memoryGoalTest, npcCastTest } from './suites/memoryGoals.mjs';
import { hearsayTest } from './suites/hearsay.mjs';
import { obituaryTest } from './suites/obituary.mjs';
import { constructionTest } from './suites/construction.mjs';
import { cityTest } from './suites/city.mjs';
import { soak } from './suites/soak.mjs';
import { runScenarios } from './scenarios.mjs';

const { ok, failures } = makeOk();
const helpers = { makeFighter, stubScene };

console.log('— headless sim checks —');
combatUnit(ok, helpers);
proceduralAbilityTest(ok);
plannerSelfTest(ok, helpers);
executionTest(ok, helpers);
memoryGoalTest(ok, helpers);
npcCastTest(ok, helpers);
hearsayTest(ok);
obituaryTest(ok, helpers);
// full deterministic scenario suite (docs/goal-system-tests.md): A1–A4, B1–B7,
// C1–C4, D1–D4, E1/E3, and the whole-system G1–G4/G6. Folds into the same tally.
runScenarios(ok);
// Phase-1 emergent buildings: homes + tavern, gold-neutral, headless-safe.
await constructionTest(ok, helpers);
// Phase-1 tile-city: CityGrid invariants + buildingParts raid/collapse/shelter (sync).
cityTest(ok, helpers);
await soak(ok, helpers);

console.log(`\n${failures.count ? `${failures.count} CHECK(S) FAILED` : 'ALL CHECKS PASSED'}`);
process.exit(failures.count ? 1 : 0);
