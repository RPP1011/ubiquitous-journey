// Headless throughput benchmark. Times a full sim rollout (no renderer) the way
// main.js drives a frame: sim.update -> fighter.update -> resolveCombat ->
// onCombatEvents.  Usage: bun test/bench.mjs [frames]
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import { resolveCombat } from '../js/combat.js';

const stub = { add() {}, remove() {} };
const mk = (m, o) => new HeadlessFighter(m, o);

function build() {
  const w = new World(stub);
  const sim = new Simulation(stub, w, { makeFighter: mk });
  sim.spawn();
  const pf = mk('knight', { isPlayer: true }); pf.root.position.set(0, 0, 8); sim.addPlayer(pf);
  return sim;
}
function rollout(sim, frames, dt) {
  for (let i = 0; i < frames; i++) {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  }
}

const N = process.argv[2] ? +process.argv[2] : 12000;
const dt = 1 / 60;

// warmup (JIT)
rollout(build(), 1000, dt);

const sim = build();
const agents = sim.agents.length;
const t0 = performance.now();
rollout(sim, N, dt);
const wall = (performance.now() - t0) / 1000;

const fps = N / wall;
const simSec = N * dt;
console.log(`agents=${agents}  frames=${N}  wall=${wall.toFixed(3)}s`);
console.log(`  ${fps.toFixed(0)} frames/s   =   ${(simSec / wall).toFixed(0)}x realtime   (${simSec.toFixed(0)} sim-seconds in ${wall.toFixed(2)}s)`);
console.log(`  one 200-sim-second rollout (12k frames) ~= ${(12000 / fps * 1000).toFixed(0)} ms   ->   ${(fps / 12000).toFixed(1)} rollouts/s/core`);
