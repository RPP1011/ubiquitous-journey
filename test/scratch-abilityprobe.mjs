// SCRATCH: ability-integration audit. 900s seeded run: who HOLDS abilities, who CASTS,
// which specs fire, and which never do. Read-only; delete freely.
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { setSeed } from '../js/sim/rng.js';
import { bus } from '../js/rpg/events.js';
setSeed(7);
const world = new World(stubScene);
const sim = new Simulation(stubScene, world, { makeFighter, seed: 7 });
sim.spawn();
await Promise.all([
  import('../js/rpg/abilities/catalog.js').catch(() => {}),
  import('../js/rpg/abilities/generate.js').catch(() => {}),
]);
for (let k = 0; k < 5; k++) await Promise.resolve();
const casts = {};
const casters = new Set();
bus.on((ev) => {
  if (ev && ev.verb === 'cast') {
    casts[(ev.tags || []).join(',') || '?'] = (casts[(ev.tags || []).join(',') || '?'] || 0) + 1;
    casters.add(ev.actorId);
  }
});
const dt = 1 / 60;
while (sim.time < 900) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);
}
let holders = 0, specCount = {}, living = 0;
for (const a of sim.agents) {
  if (!a.alive || a.controlled) continue;
  living++;
  if (a.abilities && a.abilities.size > 0) {
    holders++;
    for (const s of a.abilities.values()) specCount[s.id] = (specCount[s.id] || 0) + 1;
  }
}
console.log(`living=${living}  ability-holders=${holders}`);
console.log('held specs:', Object.entries(specCount).sort((a, b) => b[1] - a[1]).slice(0, 15));
console.log(`cast events: ${Object.values(casts).reduce((s, n) => s + n, 0)} by ${casters.size} distinct casters`);
console.log('casts by tags:', Object.entries(casts).sort((a, b) => b[1] - a[1]).slice(0, 10));
