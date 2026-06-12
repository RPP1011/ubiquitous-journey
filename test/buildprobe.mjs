// BUILDPROBE — the settlement-architecture eval (an inspection harness like lifetrace/
// distprobe, NOT part of the headless gate). Drives the whole sim seeded for N sim-seconds
// and reports what the towns actually BUILT: per-town building counts by kind, zone
// adherence (do civic works front the plaza? do homes keep to the blocks?), the storey
// histogram (does density build UP?), grid growth, shrine gods, comfort-source routing
// (home/tavern/shrine splits, benefitFelt learning coverage) — and an ASCII town plan to
// eyeball, headless. Read-only over a finished sim.
//
//   bun test/buildprobe.mjs [--seed <n>] [--duration <secs>]
//
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { setSeed } from '../js/sim/rng.js';
import { ZONE } from '../js/world/cityGrid.js';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? Number(process.argv[i + 1]) : dflt;
}
const SEED = arg('--seed', 7);
const SIM_SECONDS = arg('--duration', 1800);
const dt = 1 / 60;

setSeed(SEED);
const world = new World(stubScene);
const sim = new Simulation(stubScene, world, { makeFighter, seed: SEED });
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

// comfort-source routing tally: sample living townsfolk's comfort goals periodically.
const srcTally = {};
const t0 = Date.now();
let frame = 0;
while (sim.time < SIM_SECONDS) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);
  frame++;
  if (frame % 300 === 0) {
    for (const a of sim.agents) {
      if (!a.alive || a.controlled || !a.goal || a.goal.kind !== 'comfort') continue;
      const k = a.goal.srcKind || '?';
      srcTally[k] = (srcTally[k] || 0) + 1;
    }
  }
  if (frame % 18000 === 0) console.log(`  …${sim.time.toFixed(0)}s (wall ${(Date.now() - t0) / 1000 | 0}s)`);
}

console.log(`\n=== SETTLEMENT ARCHITECTURE  ·  seed=${SEED}  ·  ${SIM_SECONDS}s ===`);
const bs = sim.buildSites;
const blds = bs._buildings || [];

for (const town of sim.towns) {
  const grid = sim.cities.gridFor(town.id);
  const mine = blds.filter((b) => b.town === town.id);
  const byKind = {};
  for (const b of mine) byKind[b.buildKind] = (byKind[b.buildKind] || 0) + 1;
  // zone adherence: where did each kind actually land?
  let civicInBand = 0, civicTotal = 0, homesInBand = 0, homesTotal = 0;
  const storeys = {};
  for (const b of mine) {
    if (!b.plotTiles || !grid) continue;
    const zones = b.plotTiles.map((t) => grid.zoneOf(t.tx, t.ty));
    const civic = b.buildKind !== 'home';
    const inCivic = zones.every((z) => z === ZONE.CIVIC);
    const inHomes = zones.every((z) => z === ZONE.HOMES);
    if (civic) { civicTotal++; if (inCivic) civicInBand++; }
    else { homesTotal++; if (inHomes) homesInBand++; }
    const lv = (b.storeys || 1);
    storeys[lv] = (storeys[lv] || 0) + 1;
  }
  const kinds = Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join('  ') || '(nothing built)';
  console.log(`\n— ${town.name || 'town ' + town.id}  ·  grid ${grid ? grid.size : '?'}×${grid ? grid.size : '?'} tiles`);
  console.log(`  buildings: ${kinds}`);
  console.log(`  zone adherence: civic ${civicInBand}/${civicTotal} in the plaza band · homes ${homesInBand}/${homesTotal} in the blocks`);
  console.log(`  storeys: ${Object.entries(storeys).sort().map(([s, n]) => `${s}fl:${n}`).join('  ')}`);
  const shrine = mine.find((b) => b.buildKind === 'shrine');
  if (shrine) console.log(`  shrine: ${shrine.label} (sheltered=${shrine.sheltered !== false})`);
}

console.log(`\n— comfort-source routing (sampled goal srcKind):`);
console.log(`  ${Object.entries(srcTally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ')}`);
let learned = 0, living = 0;
for (const a of sim.agents) {
  if (!a.alive || a.controlled || a.faction !== 'townsfolk') continue;
  living++;
  for (const b of a.beliefs.all()) if ((b.benefitFelt || 0) > 0) { learned++; break; }
}
console.log(`  ${learned}/${living} living townsfolk have LEARNED a place's felt benefit`);

// the eyeball: the first town's plan, headless.
const g0 = sim.cities.gridFor(sim.towns[0].id);
if (g0) console.log(`\n— ${sim.towns[0].name || 'town 0'} plan ('#' street, 'o' plaza, digits = storeys):\n${g0.ascii()}`);
console.log(`\n(wall ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
