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
import { epistemicScan } from './suites/epistemic.mjs';
import { shadowGuard } from './suites/shadows.mjs';
import { combatUnit } from './suites/combat.mjs';
import { proceduralAbilityTest, narrativeAbilityTest } from './suites/abilities.mjs';
import { plannerSelfTest } from './suites/planner.mjs';
import { obligationsTest } from './suites/obligations.mjs';
import { seedingTest, romanceTest } from './suites/seeding.mjs';
import { arcsTest, arcsE2ETest } from './suites/arcs.mjs';
import { signalsTest, wealthTest, outlawTest, whitelistTest, catalogTest, catalogTailTest, gossipSnubTest, softAvoidTest, oathArcResolutionTest } from './suites/signals.mjs';
import { expeditionTest } from './suites/expeditions.mjs';
import { executionTest } from './suites/execution.mjs';
// Action-grammar EXECUTION suites (docs/architecture/10) — one per feature worktree, pre-registered
// so each fills its own file with zero shared edits. Stubs are no-ops until filled.
import { urchinTest } from './suites/urchin.mjs';
import { learningTest } from './suites/learning.mjs';
import { recruitTest } from './suites/recruit.mjs';
import { affectTest } from './suites/affect.mjs';
import { ledgerLiveTest } from './suites/ledger.mjs';
import { migrationTest } from './suites/migration.mjs';
import { cautionTest } from './suites/caution.mjs';
import { memoryGoalTest, npcCastTest } from './suites/memoryGoals.mjs';
import { perceptTest } from './suites/percept.mjs';
import { schemasTest } from './suites/schemas.mjs';
import { motivationTest, motivationInferenceTest, motivationDeceptionTest, motivationDeedPathTest, motivationShadowTest } from './suites/motivation.mjs';
import { wealthCheck } from './suites/wealth.mjs';
import { recipeTest } from './suites/recipes.mjs';
import { traceTest } from './suites/trace.mjs';
import { hearsayTest } from './suites/hearsay.mjs';
import { obituaryTest } from './suites/obituary.mjs';
import { constructionTest } from './suites/construction.mjs';
import { homecomingTest } from './suites/homecoming.mjs';
import { cityTest } from './suites/city.mjs';
import { roadsTest } from './suites/roads.mjs';
import { soak } from './suites/soak.mjs';
import { scalingTest } from './suites/scaling.mjs';
import { runScenarios } from './scenarios.mjs';

const { ok, failures } = makeOk();
const helpers = { makeFighter, stubScene };

console.log('— headless sim checks —');
// EPISTEMIC GATE FIRST (fail fast): the static source scan that enforces THE INVARIANT
// — cognition/execution code never reads ground truth. Folds into the same tally.
epistemicScan(ok);
// STALE-SHADOW GATE (TS port): no `<name>.ts` may coexist with `<name>.js` in a dir
// (a leftover .js would silently shadow the .ts under Bun). Cheap; fail fast.
shadowGuard(ok);
combatUnit(ok, helpers);
proceduralAbilityTest(ok);
await narrativeAbilityTest(ok, helpers);   // docs 15/16: provenance, conditions, the oath:kept seam
plannerSelfTest(ok, helpers);
// Action-grammar Phase 5: the obligation ledger (commitments + recurrence), the one new store.
obligationsTest(ok);
// Narrative tooling (docs/architecture/12 §3): the arc/saga registry — open/append/close lifecycle,
// keying dedup, bounded eviction, unconditional close, re-arm/re-ignition. The narrative SPINE.
arcsTest(ok);
arcsE2ETest(ok, helpers);
// Narrative signals (docs/architecture/13) + the status-delta sensor (12 §5): transfer-fold ruin
// gating, hysteresis, and snubsFelt-not-the-mean as the slander gate.
signalsTest(ok);
gossipSnubTest(ok);   // Task A: gossip-about-self feeds snubsFelt (docs/architecture/13 §3)
wealthTest(ok);
outlawTest(ok, helpers);
oathArcResolutionTest(ok, helpers);   // forgetting ≠ keeping; the march is not the warband outcome
expeditionTest(ok, helpers);   // proper quests: march / provision / retreat / explore
softAvoidTest(ok, helpers);   // Task B: suspicion-gated soft-avoidance ("cross the street", doc 13 §3)
whitelistTest(ok);
catalogTest(ok);
catalogTailTest(ok);
seedingTest(ok, helpers);
romanceTest(ok, helpers);
// Action-grammar EXECUTION feature suites (filled per worktree; no-op stubs until then).
urchinTest(ok, helpers);
learningTest(ok, helpers);
recruitTest(ok, helpers);
affectTest(ok, helpers);
ledgerLiveTest(ok, helpers);
// the emigration valve (config MIGRATE): census→rumour→decision→journey→settlement.
migrationTest(ok, helpers);
cautionTest(ok, helpers);
executionTest(ok, helpers);
memoryGoalTest(ok, helpers);
npcCastTest(ok, helpers);
// Phase-1 world-model gate: scarecrow tolerance (perceive→believe-person→strike, no
// mind-feedback, no throw) + pursuit-intercept (destination inference via the mental map).
perceptTest(ok, helpers);
// Phase-2a reasoning framework (Step 1): IR + vocab evaluators + interpreter, in isolation.
// Catalogue empty ⇒ behaviour unchanged; the substrate writes' output-stability is the soak.
schemasTest(ok);
// Motivation layer (docs/architecture/17 §3) P1 foundation: the MOTIVATIONS registry in isolation.
motivationTest(ok);
// Motivation P4 inference: one deed, two witnesses, two attributed motives (per-witness divergence).
motivationInferenceTest(ok);
// Motivation P6 deception: a covered slander fools a neutral witness, not a fond one (bias not dictate).
motivationDeceptionTest(ok);
// Motivation P3/P5 deed path + say effect (deterministic, scripted).
motivationDeedPathTest(ok, helpers);
// Motivation P1 shadow: the row-based arbiter matches decide()'s scorer tick-for-tick over a soak.
await motivationShadowTest(ok, helpers);
// Phase-4 economy prerequisite: stored wealth (purse vs stash) — day-one inert.
await wealthCheck(ok, helpers);
// Phase-4 economy prerequisite: recipe-gating of crafted production — day-one inert.
recipeTest(ok, helpers);
// REASONING TRACES: the trace substrate + the implemented write-sites (DEST_INFERRED,
// GOAL_DERIVED) + the write-only scan rule. Matches on the stable `code` enum.
traceTest(ok, helpers);
hearsayTest(ok);
obituaryTest(ok, helpers);
// full deterministic scenario suite (docs/goal-system-tests.md): A1–A4, B1–B7,
// C1–C4, D1–D4, E1/E3, and the whole-system G1–G4/G6. Folds into the same tally.
runScenarios(ok);
// Phase-1 emergent buildings: homes + tavern, gold-neutral, headless-safe.
await constructionTest(ok, helpers);
// Phase-2a homecoming gate: a miner's home is torched while he's away — he walks home on his
// STALE intact belief, DISCOVERS the ruin by perception (or by decay if it despawned), THEN
// reroutes. No telepathic re-route. The semantic gate that proves the building-state split.
await homecomingTest(ok, helpers);
// Phase-1 tile-city: CityGrid invariants + buildingParts raid/collapse/shelter (sync).
cityTest(ok, helpers);
// Trade roads: the static inter-town road graph + the caravan/arbitrage/expedition
// road-pull blend (graph connectivity, roadPull sanity, oscillation-free route walk).
roadsTest(ok);
await soak(ok, helpers);
// Phase-3 (Scale) gate: the reasoning-cost-per-agent-per-tick metric stays SUB-LINEAR
// as N grows (LOD amortizes the distant/idle tail). Fast in-suite sweep; the full
// LOD-off vs LOD-on proof at larger N lives in the standalone `test/scaling.mjs`.
await scalingTest(ok, helpers);

console.log(`\n${failures.count ? `${failures.count} CHECK(S) FAILED` : 'ALL CHECKS PASSED'}`);
process.exit(failures.count ? 1 : 0);
