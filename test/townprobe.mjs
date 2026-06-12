// TOWN-POPULATION PROBE — a standalone eval harness (not a gate): drive the WHOLE sim
// headless for N sim-seconds on a seeded rng and tally PER-TOWN births / deaths / net /
// final population. Used to measure the multi-town population skew (the origin town
// compounding while the outer towns hollow out) and any migration fix. Read-only.
//
//   bun test/townprobe.mjs [--seed <n>] [--duration <simSeconds>]
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

const nTowns = sim.towns.length;
const townName = (t) => (sim.towns[t] && sim.towns[t].name) || `Town ${t}`;
const mk = () => sim.towns.map(() => 0);

// per-town tallies. Births are attributed to the BIRTH town (first townId seen);
// deaths to the town the corpse belonged to when it died (so a migrant who dies
// abroad counts against its adopted town). Migrations = townId reassignments.
const start = mk(), births = mk(), deaths = mk(), starvedDeaths = mk();
const migIn = mk(), migOut = mk();
const seenTown = new Map();   // id -> last townId (detects births + migrations)
const deadSeen = new Set();

const civ = (a) => a.townsperson && a.townId != null;
for (const a of sim.agents) if (civ(a) && a.alive) { start[a.townId]++; seenTown.set(a.id, a.townId); }

const sweep = () => {
  for (const a of sim.agents) {
    if (!civ(a)) continue;
    const last = seenTown.get(a.id);
    if (last === undefined) {            // a NEW townsperson: a birth in its town
      seenTown.set(a.id, a.townId);
      if (a.alive) births[a.townId]++;
    } else if (last !== a.townId) {      // townId reassigned: a MIGRATION
      migOut[last]++; migIn[a.townId]++;
      seenTown.set(a.id, a.townId);
    }
    if (!a.alive && !a.controlled && !deadSeen.has(a.id)) {
      deadSeen.add(a.id);
      deaths[a.townId]++;
      if (a._diedOfHunger) starvedDeaths[a.townId]++;
    }
  }
};

const dt = 1 / 60;
const t0 = Date.now();
let frame = 0;
while (sim.time < ARGS.duration) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);
  frame++;
  if (frame % 300 === 0) sweep();   // every 5 sim-seconds: catch corpses + flips
}
sweep();

const final = mk();
for (const a of sim.agents) if (civ(a) && a.alive) final[a.townId]++;
const totalFinal = final.reduce((s, x) => s + x, 0);

console.log(`townprobe: seed=${ARGS.seed} duration=${ARGS.duration}s wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('  town          start  births deaths(starved)  migIn migOut  final  share');
for (let t = 0; t < nTowns; t++) {
  console.log(`  ${townName(t).padEnd(12)}  ${String(start[t]).padStart(5)}  ${String(births[t]).padStart(6)} ${String(deaths[t]).padStart(6)}(${String(starvedDeaths[t]).padStart(2)})      ${String(migIn[t]).padStart(5)} ${String(migOut[t]).padStart(6)}  ${String(final[t]).padStart(5)}  ${(100 * final[t] / Math.max(1, totalFinal)).toFixed(0)}%`);
}
console.log(`  TOTAL final=${totalFinal} births=${births.reduce((s, x) => s + x, 0)} deaths=${deaths.reduce((s, x) => s + x, 0)} starved=${starvedDeaths.reduce((s, x) => s + x, 0)}`);
