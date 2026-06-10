// SEED REPRO — prove the seedable PRNG reproduces: build TWO sims with the SAME seed, drive both
// identically for N sim-seconds, and compare a state digest each step. Then build a THIRD sim with a
// DIFFERENT seed and assert it diverges (so the digest is actually sensitive). Read-only.
//
//   bun test/seedrepro.mjs [simSeconds] [seedA] [seedB]
//
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { setSeed } from '../js/sim/rng.js';

const SIM_SECONDS = Number(process.argv[2]) || 120;
const SEED_A = process.argv[3] !== undefined ? Number(process.argv[3]) : 12345;
const SEED_B = process.argv[4] !== undefined ? Number(process.argv[4]) : 67890;
const dt = 1 / 60;
const STEPS = Math.round(SIM_SECONDS / dt);

async function settle() {
  await Promise.all([
    import('../js/rpg/abilities/catalog.js').catch(() => {}),
    import('../js/rpg/abilities/generate.js').catch(() => {}),
    import('../js/rpg/abilities/ir.js').catch(() => {}),
  ]);
  for (let k = 0; k < 5; k++) await Promise.resolve();
}

// WARM-UP — Progression loads its ability catalog via a LAZY `import().then()` fired on the first
// deed; that async resolution lands at a scheduling-dependent tick, so the FIRST run grants its
// abilities a hair later than a run where the catalog is already cached. Run a throwaway sim to
// TRIGGER + DRAIN that load once, so every measured run below starts with the catalog already
// resolved — isolating the seed's determinism from the one-time async-load timing. (This is the
// documented residual: in the live browser, the catalog likewise loads async on first play.)
async function warmCatalog() {
  setSeed(undefined);
  const w = new World(stubScene);
  const s = new Simulation(stubScene, w, { makeFighter });
  s.spawn();
  for (let i = 0; i < 600; i++) s.update(dt);          // generate deeds -> triggers ensureCatalog()
  for (let k = 0; k < 50; k++) await Promise.resolve(); // drain the import().then() microtasks
  s.dispose?.();
}

function build(seed) {
  // Arm the seed BEFORE World construction so world-gen placement draws are seeded too
  // (the Simulation constructor re-arms with the same seed — idempotent). This mirrors the
  // app ordering (main.js seeds before `new World`), making the WHOLE run reproducible.
  setSeed(seed);
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter, seed });
  sim.spawn();
  return sim;
}

// A compact, order-stable digest of the live sim: agent positions + gold + needs + goal kind,
// folded with a cheap rolling hash. Sensitive to any stochastic divergence on the tick.
function digest(sim) {
  let h = 2166136261 >>> 0;
  const mix = (x) => { h ^= (x | 0); h = Math.imul(h, 16777619) >>> 0; };
  for (const a of sim.agents) {
    const p = a.pos || (a.fighter && a.fighter.root && a.fighter.root.position) || { x: 0, y: 0, z: 0 };
    mix((p.x * 1000) | 0); mix((p.z * 1000) | 0);
    mix(((a.gold || 0) * 100) | 0);
    mix(((a.needs && a.needs.food || 0) * 1000) | 0);
    if (a.goal && a.goal.kind) for (let i = 0; i < a.goal.kind.length; i++) mix(a.goal.kind.charCodeAt(i));
  }
  mix(sim.agents.length);
  return h >>> 0;
}

// The PRNG is a single module-level stream (one sim per process — the product's real shape), so
// runs must be SEQUENTIAL: build+drive a whole run, capture its per-step digest trace, tear down,
// repeat. Concurrent seeded sims would share+interleave the one stream (a documented limitation).
async function run(seed) {
  await settle();
  const sim = build(seed);
  const trace = new Uint32Array(STEPS);
  for (let i = 0; i < STEPS; i++) { sim.update(dt); trace[i] = digest(sim); }
  sim.dispose?.();
  return trace;
}

await warmCatalog();
const traceA = await run(SEED_A);
const traceA2 = await run(SEED_A);
const traceB = await run(SEED_B);

let firstDivergeA = -1, firstDivergeB = -1;
for (let i = 0; i < STEPS; i++) {
  if (firstDivergeA < 0 && traceA[i] !== traceA2[i]) firstDivergeA = i;
  if (firstDivergeB < 0 && traceA[i] !== traceB[i]) firstDivergeB = i;
}

const sameSeedIdentical = firstDivergeA < 0;
const diffSeedDiverged = firstDivergeB >= 0;

console.log(`steps=${STEPS} (${SIM_SECONDS}s)  seedA=${SEED_A} seedB=${SEED_B}`);
console.log(`same-seed identical for whole run: ${sameSeedIdentical}` +
  (sameSeedIdentical ? '' : `  (first divergence at step ${firstDivergeA})`));
console.log(`different-seed diverged: ${diffSeedDiverged}` +
  (diffSeedDiverged ? `  (first divergence at step ${firstDivergeB})` : '  (!! digest insensitive)'));

if (sameSeedIdentical && diffSeedDiverged) { console.log('SEED REPRO PASSED'); process.exit(0); }
else { console.log('SEED REPRO FAILED'); process.exit(1); }
