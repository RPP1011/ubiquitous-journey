// Leveling-pace measurement: run a long headless rollout and track how sim-time
// maps to character total-level — i.e. how long until level 10/20/30 souls appear.
// Usage: bun test/levelbench.mjs [maxFrames]
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import { resolveCombat } from '../js/combat.js';

const stub = { add() {}, remove() {} };
const mk = (m, o) => new HeadlessFighter(m, o);
const w = new World(stub);
const sim = new Simulation(stub, w, { makeFighter: mk });
sim.spawn();
const pf = mk('knight', { isPlayer: true }); pf.root.position.set(0, 0, 8); sim.addPlayer(pf);

const dt = 1 / 60;
const FRAMES = +(process.argv[2] || 2_000_000);
const npcs = () => sim.agents.filter((a) => !a.controlled && a.alive);
const maxLevel = () => npcs().reduce((m, a) => Math.max(m, a.progression.totalLevel), 0);
const countAtLeast = (L) => npcs().filter((a) => a.progression.totalLevel >= L).length;

let f10 = null, f20 = null, f30 = null;
// PEAK tracking: deaths/respawns thin the live roster, so a single end-of-run
// snapshot understates HEADROOM. We track each agent's lifetime peak total-level
// (keyed by id, surviving respawns) so headroom reflects the storied lives that
// actually occurred — not just whoever happens to be alive at the final frame.
const peak = new Map();   // id -> { peak, beats }
const t0 = performance.now();
for (let i = 0; i < FRAMES; i++) {
  sim.update(dt);
  for (const fi of sim.fighters) fi.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);

  if (i % 600 === 0) {
    for (const a of npcs()) {
      const p = peak.get(a.id) || { peak: 0, beats: 0 };
      p.peak = Math.max(p.peak, a.progression.totalLevel);
      p.beats = Math.max(p.beats, a.progression.narrativeBeats || 0);
      peak.set(a.id, p);
    }
  }
  if (i % 6000 === 0) {                          // every 100 sim-seconds
    const ml = maxLevel();
    if (f10 === null && ml >= 10) f10 = sim.time;
    if (f20 === null && ml >= 20) f20 = sim.time;
    if (f30 === null && ml >= 30) { f30 = sim.time; }
    if (i % 60000 === 0) {
      const avg = npcs().reduce((s, a) => s + a.progression.totalLevel, 0) / Math.max(1, npcs().length);
      console.log(`t=${(sim.time / 60).toFixed(0)}min(${sim.time.toFixed(0)}s)  max=${ml}  avg=${avg.toFixed(1)}  >=10:${countAtLeast(10)} >=20:${countAtLeast(20)} >=30:${countAtLeast(30)}`);
    }
    if (f30 !== null) break;
  }
}
const wall = (performance.now() - t0) / 1000;
const fmt = (t) => (t == null ? '(not reached)' : `${(t / 60).toFixed(1)} min (${t.toFixed(0)} sim-s)`);
console.log(`--- ran ${sim.time.toFixed(0)} sim-s in ${wall.toFixed(1)}s wall ---`);
console.log(`first level 10 @ ${fmt(f10)}`);
console.log(`first level 20 @ ${fmt(f20)}`);
console.log(`first level 30 @ ${fmt(f30)}`);
const top = npcs().sort((a, b) => b.progression.totalLevel - a.progression.totalLevel).slice(0, 5);
for (const a of top) console.log(`  ${a.name}: total ${a.progression.totalLevel} — ${[...a.progression.classes.values()].map((c) => c.name + ' ' + c.level).join(', ')}`);

// --- PHASE 1 verification: HEADROOM + SPREAD --------------------------------
// Measured over LIFETIME PEAKS (deaths thin the live roster), classifying a soul
// as STORIED iff it ever earned a narrative beat (kill / goal closure / windfall /
// witnessed death / brush with death) vs QUIET (pure routine labour, 0 beats).
//   (a) HEADROOM — at least one soul clears the old ~8 plateau (peak >= 15).
//   (b) SPREAD   — storied lives outlevel quiet ones on average.
const peaks = [...peak.values()];
const storied = peaks.filter((p) => p.beats > 0), quiet = peaks.filter((p) => p.beats === 0);
const avg = (arr) => (arr.length ? arr.reduce((s, p) => s + p.peak, 0) / arr.length : 0);
const maxPeak = peaks.reduce((m, p) => Math.max(m, p.peak), 0);
console.log(`--- HEADROOM/SPREAD (lifetime peaks): maxPeak=${maxPeak}  storied(n=${storied.length}) avgPeak=${avg(storied).toFixed(1)}  quiet(n=${quiet.length}) avgPeak=${avg(quiet).toFixed(1)} ---`);
const headroomOk = maxPeak >= 15;
const spreadOk = !storied.length || !quiet.length || avg(storied) > avg(quiet);
console.log(`HEADROOM (peak>=15): ${headroomOk ? 'PASS' : 'FAIL'}   SPREAD (storied>quiet): ${spreadOk ? 'PASS' : 'FAIL'}`);
if (!headroomOk || !spreadOk) process.exitCode = 1;
