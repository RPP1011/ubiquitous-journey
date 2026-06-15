// SCRATCH PROFILING RUNNER — not committed source, not a gate. Drives ONLY the soak's
// frame loop (copying the soak setup) with per-pass performance.now() accumulators, by
// monkeypatching the per-agent prototype methods + the subsystem instance .tick methods.
// Run:  bun test/profrun.mjs            (soak-only wall time + per-pass breakdown)
//       bun test/profrun.mjs --time     (just wall time, no instrumentation overhead)

import { setSeed } from '../js/sim/rng.js';
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { Agent } from '../js/sim/agent.js';
import { resolveCombat } from '../js/combat.js';
import { BeliefStore } from '../js/sim/beliefs.js';
import { Progression } from '../js/rpg/progression.js';
import { Memory } from '../js/sim/memory.js';

const TIME_ONLY = process.argv.includes('--time');
const FRAMES = 12000, dt = 1 / 60;

// ---- accumulators -------------------------------------------------------
const acc = Object.create(null);   // pass name -> total ms
const cnt = Object.create(null);   // pass name -> # calls
function bump(name, ms) { acc[name] = (acc[name] || 0) + ms; cnt[name] = (cnt[name] || 0) + 1; }

// wrap a method on a prototype/object; aggregate ALL per-agent calls under one bucket.
function wrap(obj, key, label) {
  const orig = obj[key];
  if (typeof orig !== 'function') return;
  obj[key] = function (...args) {
    const t = performance.now();
    try { return orig.apply(this, args); }
    finally { bump(label, performance.now() - t); }
  };
}

setSeed(0xC00D19);

const world = new World(stubScene);
const sim = new Simulation(stubScene, world, { makeFighter });
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

if (!TIME_ONLY) {
  // per-agent cognition/execution passes (prototype-level)
  wrap(Agent.prototype, 'perceive', 'perceive');
  wrap(Agent.prototype, 'gossipBeliefs', 'gossip');
  wrap(Agent.prototype, 'decide', 'decide');
  wrap(Agent.prototype, 'act', 'act');
  wrap(BeliefStore.prototype, 'decay', 'beliefs.decay');
  wrap(Progression.prototype, 'tick', 'progression.tick');
  wrap(Memory.prototype, 'tick', 'memory.tick');

  // sim-level passes
  wrap(Simulation.prototype, '_runMarket', 'market');
  wrap(Simulation.prototype, '_sweepDeaths', 'sweepDeaths');
  wrap(Simulation.prototype, '_reapCorpses', 'reapCorpses');

  // quest board (two calls)
  wrap(sim.quests, 'refresh', 'quests.refresh');
  wrap(sim.quests, 'tick', 'quests.tick');

  // every subsystem instance with a .tick / .sweep that runs inline in the fixed loop
  const subs = [
    ['groups', sim.groups], ['defenses', sim.defenses], ['faith', sim.faith],
    ['watch', sim.watch], ['expeditions', sim.expeditions], ['patrician', sim.patrician],
    ['cities', sim.cities], ['surveyor', sim.surveyor], ['buildSites', sim.buildSites],
    ['intrigue', sim.intrigue], ['director', sim.director], ['lineage', sim.lineage],
    ['migration', sim.migration], ['chronicle', sim.chronicle], ['reporter', sim.reporter],
    ['bounties', sim.bounties], ['arbitrage', sim.arbitrage],
  ];
  for (const [name, inst] of subs) if (inst) wrap(inst, 'tick', `sub.${name}`);
  if (sim.sagas) wrap(sim.sagas, 'sweep', 'sub.sagas');
  if (sim.world) wrap(sim.world, 'update', 'world.update');
  if (sim.reputation) wrap(sim.reputation, 'decay', 'reputation.decay');
  if (sim.party) wrap(sim.party, 'prune', 'party.prune');
}

// ---- frame-step buckets (the soak frame body) ---------------------------
let tUpdate = 0, tFighter = 0, tResolve = 0, tCombatEv = 0;
let agentSamples = [];
let cogTicks = 0;
const startAgents = sim.agents.length;

// hook tick counting: count how many times the fixed-tick body runs vs frames.
// We detect a tick by wrapping market (runs once per fixed tick).
const origMarket = sim.constructor.prototype._runMarket;

const wallStart = performance.now();
let stage = 'init';
try {
  for (let i = 0; i < FRAMES; i++) {
    let t = performance.now();
    stage = 'sim.update'; sim.update(dt);
    tUpdate += performance.now() - t;

    t = performance.now();
    stage = 'fighter.update'; for (const f of sim.fighters) f.update(dt);
    tFighter += performance.now() - t;

    t = performance.now();
    stage = 'resolveCombat';
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    tResolve += performance.now() - t;

    if (ev.length) {
      t = performance.now();
      stage = 'onCombatEvents'; sim.onCombatEvents(ev);
      tCombatEv += performance.now() - t;
    }
    if (i % 600 === 0) agentSamples.push({ frame: i, n: sim.agents.length });
  }
} catch (err) {
  console.error(`THREW at stage '${stage}' frame loop -> ${err && err.message}`);
  console.error(err);
  process.exit(1);
}
const wallMs = performance.now() - wallStart;

// market is called once per fixed cognition tick — its call count == # cognition ticks
cogTicks = cnt['market'] || 0;
const endAgents = sim.agents.length;

// ---- report -------------------------------------------------------------
console.log(`\n=== SOAK PROFILE (${FRAMES} frames, ${(FRAMES * dt).toFixed(0)} sim-sec) ===`);
console.log(`wall (frame loop only): ${(wallMs / 1000).toFixed(2)} s`);
console.log(`agents: start=${startAgents} end=${endAgents}`);
console.log(`agent count samples (frame:n): ${agentSamples.map(s => `${s.frame}:${s.n}`).join(' ')}`);
console.log(`cognition ticks (fixed): ${cogTicks}  over ${FRAMES} frames  => ${(cogTicks / FRAMES).toFixed(3)} ticks/frame`);
console.log(`  => ${(cogTicks / (FRAMES * dt)).toFixed(2)} cognition ticks/sim-sec ; ${(FRAMES / (FRAMES * dt)).toFixed(0)} frames/sim-sec`);

console.log(`\n--- frame-step buckets (wall ms / % of frame-loop wall) ---`);
const frameSteps = [
  ['sim.update (total)', tUpdate],
  ['fighter.update', tFighter],
  ['resolveCombat', tResolve],
  ['onCombatEvents', tCombatEv],
];
for (const [label, ms] of frameSteps)
  console.log(`  ${label.padEnd(24)} ${ms.toFixed(0).padStart(8)} ms  ${(100 * ms / wallMs).toFixed(1).padStart(5)}%`);

if (!TIME_ONLY) {
  console.log(`\n--- per-pass breakdown (inside sim.update + frame steps; wall ms / % of frame-loop wall / calls) ---`);
  const rows = Object.keys(acc).map(k => [k, acc[k], cnt[k]]).sort((a, b) => b[1] - a[1]);
  let measured = 0;
  for (const [k, ms] of rows) measured += ms;
  for (const [k, ms, c] of rows)
    console.log(`  ${k.padEnd(20)} ${ms.toFixed(0).padStart(8)} ms  ${(100 * ms / wallMs).toFixed(1).padStart(5)}%  calls=${c}`);
  // unmeasured slice of sim.update = reason + raw loop overhead + LOD scheduling + status sensor + signal folds
  const updateMeasuredInside = (acc['perceive']||0)+(acc['gossip']||0)+(acc['decide']||0)+
    (acc['beliefs.decay']||0)+(acc['progression.tick']||0)+(acc['memory.tick']||0)+(acc['market']||0)+
    (acc['quests.refresh']||0)+(acc['quests.tick']||0)+(acc['sweepDeaths']||0)+(acc['reapCorpses']||0)+
    (acc['world.update']||0)+(acc['reputation.decay']||0)+(acc['party.prune']||0)+
    Object.keys(acc).filter(k=>k.startsWith('sub.')).reduce((s,k)=>s+acc[k],0);
  const updateUnmeasured = tUpdate - updateMeasuredInside;
  console.log(`\n  [derived] sim.update measured-inside: ${updateMeasuredInside.toFixed(0)} ms`);
  console.log(`  [derived] sim.update UNMEASURED (reason + LOD sched + status/signal folds + loop): ${updateUnmeasured.toFixed(0)} ms  ${(100*updateUnmeasured/wallMs).toFixed(1)}%`);
  console.log(`\n  NOTE: 'act' runs every frame (${cnt['act']} calls); cognition passes run only on cognition ticks for DUE agents.`);
}
