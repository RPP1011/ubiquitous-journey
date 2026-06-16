// Headless test for the EXPLORATION / discovery system (js/sim/exploration.ts + the landmark/steer
// changes). Verifies: reaching a landmark DISCOVERS it (memory + a counted discovery), the FIRST to
// reach a cache claims its GOODS, gold stays conserved (caches are goods, never minted gold), and
// agents actually discover landmarks during normal play. Run: `bun test/explore.mjs`.

import { Simulation } from '../js/sim/simulation.js';
import { World } from '../js/sim/world.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import { LANDMARKS } from '../js/arena.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

const stub = { add() {}, remove() {} };
const sim = new Simulation(stub, new World(stub), { makeFighter: (m, o) => new HeadlessFighter(m, o), seed: 2025 });
sim.spawn();

const totalGold = () => sim.agents.reduce((s, a) => s + (a.gold || 0) + (a.stash || 0), 0);
const gold0 = totalGold();

// ── direct: stand a living townsperson on a remote CACHE landmark and run the discovery pass ──
const cacheL = LANDMARKS.find((L) => L.find && Math.hypot(L.x, L.z) > 100);
ok(!!cacheL, `a remote cache landmark exists (${cacheL && cacheL.name})`);
const a = sim.agents.find((x) => x.alive && x.faction === 'townsfolk' && !x.controlled);
a.pos.set(cacheL.x, 0, cacheL.z);
const inv0 = a.inventory[cacheL.find.good] || 0;
const disc0 = a.life.discoveries || 0;

sim.exploration.tick({ agents: sim.agents, time: sim.time });

ok(a._seen && a._seen.has(cacheL.name), `the soul standing at ${cacheL.name} discovered it`);
ok((a.life.discoveries || 0) === disc0 + 1, 'the discovery was counted on its life');
ok((a.inventory[cacheL.find.good] || 0) === inv0 + cacheL.find.qty, `it claimed the goods cache (+${cacheL.find.qty} ${cacheL.find.good})`);
ok(sim.exploration.firstSeen.has(cacheL.name), 'the first-discovery was recorded globally');

// re-running does NOT re-award (already seen, and the cache is claimed once globally).
const inv1 = a.inventory[cacheL.find.good];
sim.exploration.tick({ agents: sim.agents, time: sim.time });
ok(a.inventory[cacheL.find.good] === inv1, 'the cache is one-time (no farming the same landmark)');

// the discovery PASS itself never touches gold (caches are GOODS, never minted gold).
ok(totalGold() === gold0, 'gold conserved across the discovery pass (caches are goods, not gold)');

// ── live: over a normal run, explorers reach landmarks; memories form + consolidate into biography ──
for (let i = 0; i < 1200; i++) sim.update(1 / 30);
ok(sim.exploration.stats.discoveries > 0, `souls discover landmarks during play (${sim.exploration.stats.discoveries} discoveries)`);
ok(sim.exploration.stats.firsts > 0, `landmarks get a first-discoverer (${sim.exploration.stats.firsts} firsts)`);
const explorers = sim.agents.filter((x) => (x.life && x.life.discoveries) > 0);
ok(explorers.length > 0, `souls became explorers (${explorers.length} with discoveries)`);
// a discovery memory consolidates into salient memory — it shapes who the explorer IS (biography reads it).
const withMemory = explorers.some((x) => x.memory.salient(12).some((e) => e.kind === 'beheld' || e.kind === 'relic'));
ok(withMemory, 'a discovery became a vivid, lasting memory (surfaces in salient memory / biography)');

console.log(fails === 0 ? '\nExploration: all checks passed.' : `\nExploration: ${fails} FAILED.`);
process.exit(fails === 0 ? 0 : 1);
