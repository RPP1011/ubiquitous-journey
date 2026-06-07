// Depth evaluation runner — drives the WHOLE sim headlessly (exactly like the
// render loop, minus rendering), samples the DepthProbe on a 1 Hz cadence, and
// prints a two-axis scored "Emergent Depth Report". Where the soak suite asserts
// THAT mechanics/behaviour emerge, this measures HOW RICHLY — a profiling lens for
// tuning the simulation's depth.
//
//   bun test/depth.mjs            # prints the scorecard; exit 1 only on a depth FLOOR breach
//
// It reuses the soak's drive loop and the same telemetry singletons (xpstats /
// econstats), reset up-front so the numbers reflect this run alone.

import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { bus } from '../js/rpg/events.js';
import { xpByVerb, xpTotal, resetXpStats } from '../js/rpg/xpstats.js';
import { allCommodityStats, tradedCommodityCount, resetEconStats } from '../js/sim/econstats.js';
import { DepthProbe, formatReport } from '../js/sim/depthMetrics.js';
import { makeFighter, stubScene } from './harness.mjs';

// depth FLOORS — conservative so a healthy run never flakes, but a regression that
// guts emergence (a subsystem stops firing, behaviour collapses to one goal) trips it.
const FLOOR = { overall: 0.40, behaviour: 0.35, mechanics: 0.35, emergedSubsystems: 5, interactions: 3 };

async function main() {
  resetXpStats();
  resetEconStats();

  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  sim.spawn();
  const pf = makeFighter('knight', { isPlayer: true });
  pf.root.position.set(0, 0, 8);
  sim.addPlayer(pf);

  // settle the lazy ability imports so class/ability metrics populate (mirrors soak)
  await Promise.all([
    import('../js/rpg/abilities/catalog.js').catch(() => {}),
    import('../js/rpg/abilities/generate.js').catch(() => {}),
    import('../js/rpg/abilities/ir.js').catch(() => {}),
  ]);
  for (let k = 0; k < 5; k++) await Promise.resolve();

  const probe = new DepthProbe(sim);
  // wire the decoupled accessors the probe reads (keeps depthMetrics free of the
  // econstats singleton) + feed the deed firehose so deed-TAG variety is measured.
  sim._depTrades = 0;
  sim._depEconRows = allCommodityStats;
  const off = bus.on((ev) => { if (ev && ev.tags) probe.noteTags(ev.tags); });

  const goldStart = sim.agents.reduce((s, a) => s + a.gold, 0);
  const FRAMES = 12000, dt = 1 / 60, SAMPLE_EVERY = 60;   // ~200 sim-seconds, 1 Hz sampling
  let stage = 'init';
  try {
    for (let i = 0; i < FRAMES; i++) {
      stage = 'sim.update'; sim.update(dt);
      stage = 'fighter.update'; for (const f of sim.fighters) f.update(dt);
      stage = 'resolveCombat';
      const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
      if (ev.length) { stage = 'onCombatEvents'; sim.onCombatEvents(ev); }
      sim._depTrades += sim.tradesThisTick || 0;
      if (i % SAMPLE_EVERY === 0) { stage = 'probe.sample'; probe.sample(sim.time); }
    }
  } catch (err) {
    off();
    console.error(`\nFAILED: depth run threw at stage '${stage}' -> ${err && err.message}`);
    console.error(err);
    process.exit(1);
  }
  off();

  const goldEnd = sim.agents.reduce((s, a) => s + a.gold, 0);
  const goldConserved = Math.abs(goldEnd - goldStart) < 1e-6;

  const rep = probe.report({ allCommodityStats, tradedCommodityCount, xpByVerb, goldConserved });
  console.log(formatReport(rep));

  // a couple of context lines under the scorecard
  console.log(`\n  context: ${sim.agents.filter((a) => a.alive).length}/${sim.agents.length} alive · ` +
    `${Math.round(xpTotal())} xp routed · ${sim._depTrades} trades · t=${sim.time.toFixed(0)}s`);

  // FLOOR gate
  const emerged = rep.timeline.length;
  const fails = [];
  if (rep.overall < FLOOR.overall) fails.push(`overall ${(rep.overall * 100).toFixed(0)} < ${FLOOR.overall * 100}`);
  if (rep.axes.behaviour.score < FLOOR.behaviour) fails.push(`behaviour ${(rep.axes.behaviour.score * 100).toFixed(0)} < ${FLOOR.behaviour * 100}`);
  if (rep.axes.mechanics.score < FLOOR.mechanics) fails.push(`mechanics ${(rep.axes.mechanics.score * 100).toFixed(0)} < ${FLOOR.mechanics * 100}`);
  if (emerged < FLOOR.emergedSubsystems) fails.push(`only ${emerged} subsystems emerged < ${FLOOR.emergedSubsystems}`);
  if (rep.interactions.pairs < FLOOR.interactions) fails.push(`only ${rep.interactions.pairs} interactions < ${FLOOR.interactions}`);

  if (fails.length) { console.log(`\n  DEPTH FLOOR BREACHED: ${fails.join('; ')}`); process.exit(1); }
  console.log(`\n  ✓ depth floors held (overall ${(rep.overall * 100).toFixed(0)}/100, ${emerged} subsystems, ${rep.interactions.pairs} interactions)`);
  process.exit(0);
}

main();
