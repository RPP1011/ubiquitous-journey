// Run a rollout, then print the EPISODIC HISTORY (life story) of the highest-
// level characters — to see whether high level actually means a storied life.
// Usage: bun test/history.mjs [frames]
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import { resolveCombat } from '../js/combat.js';
import { memoryPhrase } from '../js/sim/memory.js';

const stub = { add() {}, remove() {} };
const mk = (m, o) => new HeadlessFighter(m, o);
const w = new World(stub);
const sim = new Simulation(stub, w, { makeFighter: mk });
sim.spawn();
const pf = mk('knight', { isPlayer: true }); pf.root.position.set(0, 0, 8); sim.addPlayer(pf);

const dt = 1 / 60;
const FRAMES = +(process.argv[2] || 600000);
for (let i = 0; i < FRAMES; i++) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);
}

const nameOf = (id) => { const a = sim.agentsById.get(id); return a ? a.name : '#' + id; };
const npcs = sim.agents.filter((a) => !a.controlled);
const top = npcs.sort((a, b) => b.progression.totalLevel - a.progression.totalLevel).slice(0, 5);

console.log(`=== ${(sim.time / 60).toFixed(0)} min (${sim.time.toFixed(0)} sim-s) · ${npcs.length} souls ===\n`);
for (const a of top) {
  const classes = [...a.progression.classes.values()].sort((x, y) => y.level - x.level).map((c) => `${c.name} ${c.level}`).join(', ');
  console.log(`### ${a.name} — total level ${a.progression.totalLevel}${a.alive ? '' : ' (DEAD)'}`);
  console.log(`classes:  ${classes}`);
  console.log(`ambition: ${a.ambition ? a.ambition.label : '-'}   doing: ${a.goal ? a.goal.kind : '-'}`);
  const mem = a.memory;
  const eps = [...mem.ltm.items(), ...mem.mtm.items()];
  const seen = new Set(); const story = [];
  for (const e of eps.sort((x, y) => x.t - y.t)) {
    const k = e.t + '|' + e.kind + '|' + e.withId;
    if (seen.has(k)) continue; seen.add(k); story.push(e);
  }
  if (!story.length) console.log('  (no formative memories)');
  for (const e of story) {
    console.log(`  ${String(Math.round(e.t / 60)).padStart(3)}min  [${String(Math.round(e.salience * 100)).padStart(3)}]  ${memoryPhrase(e, nameOf)}`);
  }
  console.log('');
}
