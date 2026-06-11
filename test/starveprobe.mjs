// STARVATION PROBE — a standalone eval harness (not a gate): drive the WHOLE sim headless for
// N sim-seconds on a seeded rng and count STARVATION deaths (corpses flagged _diedOfHunger,
// id-deduped before the reaper sweeps them). Used to measure the survival ladder — e.g. the
// granary's starvation delta vs the pre-granary baseline. Read-only over the sim.
//
//   bun test/starveprobe.mjs [--seed <n>] [--duration <simSeconds>]
//
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { setSeed } from '../js/sim/rng.js';

function parseArgs(argv) {
  const out = { seed: 31, duration: 1200 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed') out.seed = Number(argv[++i]);
    else if (argv[i] === '--duration') out.duration = Number(argv[++i]);
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));

setSeed(ARGS.seed);
const world = new World(stubScene);
const sim = new Simulation(stubScene, world, { makeFighter, seed: ARGS.seed });
sim.spawn();
const pf = makeFighter('knight', { isPlayer: true });
pf.root.position.set(0, 0, 8);
sim.addPlayer(pf);
await Promise.all([
  import('../js/rpg/abilities/catalog.js').catch(() => {}),
  import('../js/rpg/abilities/generate.js').catch(() => {}),
  import('../js/rpg/abilities/ir.js').catch(() => {}),
]);
for (let k = 0; k < 5; k++) await Promise.resolve();

const dt = 1 / 60;
const starved = new Set();   // ids seen dead-of-hunger (corpses linger ~90s, so a 10s sweep can't miss one)
const allDead = new Set();
const deathInfo = [];        // per-starved telemetry: gold at death, dist to own town anchor
let granaryMeals = 0, granaries = 0, granaryStock = 0;
const sweep = () => {
  for (const a of sim.agents) {
    if (a.alive || a.controlled) continue;
    allDead.add(a.id);
    if (a._diedOfHunger && !starved.has(a.id)) {
      starved.add(a.id);
      const anchor = a.townAnchor || { x: 0, z: 0 };
      deathInfo.push({
        gold: a.gold || 0,
        dist: Math.hypot(a.pos.x - anchor.x, a.pos.z - anchor.z),
      });
    }
  }
};
const t0 = Date.now();
let frame = 0;
while (sim.time < ARGS.duration) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);
  frame++;
  if (frame % 600 === 0) sweep();   // every 10 sim-seconds: catch corpses before the reaper
}
sweep();   // final sweep + granary telemetry (best-effort: fields exist only once the feature lands)
try {
  for (const b of (sim.buildSites && sim.buildSites._buildings) || []) {
    if (b.buildKind === 'granary') { granaries++; granaryStock += b.stock || 0; }
  }
  granaryMeals = (sim.buildSites && sim.buildSites.stats && sim.buildSites.stats.granaryMeals) || 0;
} catch { /* pre-feature baseline */ }

const living = sim.agents.filter((a) => a.alive && !a.controlled).length;
const destitute = deathInfo.filter((d) => d.gold < 1).length;
const meanDist = deathInfo.length ? deathInfo.reduce((s, d) => s + d.dist, 0) / deathInfo.length : 0;
console.log(`starveprobe: seed=${ARGS.seed} duration=${ARGS.duration}s wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  starved=${starved.size}  totalDeaths>=${allDead.size}  living=${living}`);
console.log(`  starved destitute(gold<1)=${destitute} moneyed=${starved.size - destitute} meanDistFromTown=${meanDist.toFixed(0)}m`);
console.log(`  granaries=${granaries} stock=${granaryStock.toFixed(1)} mealsServed=${granaryMeals}`);
