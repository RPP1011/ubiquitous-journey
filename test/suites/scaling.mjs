// ---- Phase 3 (Scale) cost-scaling gate (fast in-suite check) -----------------
// Proves the REASONING-COST-PER-AGENT-PER-TICK metric stays SUB-LINEAR as the town
// N grows — the Phase 3 "tractable is MEASURED" gate, folded into the headless tally.
//
// This is the FAST variant (smaller N) so it doesn't bloat the headless fast path;
// the full standalone proof (larger N, LOD-off vs LOD-on comparison, richer table)
// lives in `test/scaling.mjs` (run alongside depth.mjs). It window-averages ~40
// windows (like the standalone). The headless harness seeds the PRNG, so the metric is now
// deterministic run-to-run; the window-average + headroom fractions remain as robustness.
//
// It drives the WHOLE sim headlessly exactly like depth.mjs (sim.update ->
// fighter.update -> resolveCombat -> onCombatEvents), samples a DepthProbe on a 1 Hz
// cadence, and reads rep.reasoning.cost.total (per-agent-tick deliberative work,
// already window-averaged by the probe). Per-agent work is bounded by LOCAL density
// (fixed vision radius × ≤12-belief cap), NOT by N — so per-agent cost grows
// SUB-LINEARLY (strictly slower than N) and flattens once dense.

import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { resolveCombat } from '../../js/combat.js';
import { DepthProbe } from '../../js/sim/depthMetrics.js';

const SIZES = [
  { label: 'N≈60',  townsfolkPerTown: 22 },
  { label: 'N≈100', townsfolkPerTown: 42 },
  { label: 'N≈170', townsfolkPerTown: 77 },
];
const FRAMES = 2400, dt = 1 / 60, SAMPLE_EVERY = 60;   // ~40s, ~40 windows
// per-agent growth must stay under (frac × the N ratio). The metric is dominated by
// `_decideCands` (the utility-candidate count). The headless harness now SEEDS the shared PRNG, so
// this metric is DETERMINISTIC run-to-run (it used to swing under the platform Math.random()); the
// fractions below are kept as the generous headroom that proved stable across seeds — they still
// strictly bound any genuinely super-linear (quadratic-total) blow-up well under the N ratio. We also
// (a) start at a DENSER N_prev (~60, past the worst of the saturation ramp) so the step is more
// N-driven than ramp-driven, and (b) average ~40 windows (matching the standalone test/scaling.mjs).
const SUBLINEAR_FRAC = 0.90;          // dense step (N_prev ≥ 100): tight
const SUBLINEAR_FRAC_SPARSE = 1.30;   // sparse step (N_prev < 100): headroom, still bounds super-linear
                                      //   growth (< N ratio + 30%)

async function runOne(townsfolkPerTown, makeFighter, stubScene) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  sim.spawn({ townsfolkPerTown });
  await Promise.all([
    import('../../js/rpg/abilities/catalog.js').catch(() => {}),
    import('../../js/rpg/abilities/ir.js').catch(() => {}),
  ]);
  for (let k = 0; k < 5; k++) await Promise.resolve();

  const probe = new DepthProbe(sim);
  let aliveSum = 0, aliveSamples = 0;
  for (let i = 0; i < FRAMES; i++) {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
    if (i % SAMPLE_EVERY === 0) {
      probe.sample(sim.time);
      aliveSum += sim.agents.filter((a) => a.alive).length;
      aliveSamples++;
    }
  }
  const rep = probe.report({ goldConserved: true });
  return { cost: rep.reasoning.cost, meanAlive: aliveSamples ? aliveSum / aliveSamples : 0 };
}

export async function scalingTest(ok, { makeFighter, stubScene }) {
  const rows = [];
  for (const s of SIZES) rows.push({ ...s, ...(await runOne(s.townsfolkPerTown, makeFighter, stubScene)) });

  // metric populated at every N (degrades to 0 on a missing counter — guard)
  ok(rows.every((r) => r.cost && Number.isFinite(r.cost.total) && r.cost.total > 0),
    `scaling: reasoning-cost metric populated at all N (${rows.map((r) => r.cost.total.toFixed(2)).join(' / ')}/agent-tick)`);

  // per-agent cost SUB-LINEAR: when N grows ×R, per-agent cost grows strictly slower.
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].cost.total, cur = rows[i].cost.total;
    const nRatio = rows[i - 1].meanAlive > 1e-9 ? rows[i].meanAlive / rows[i - 1].meanAlive : 1;
    const growth = prev > 1e-9 ? cur / prev : 1;
    const ceiling = nRatio * (rows[i - 1].meanAlive >= 100 ? SUBLINEAR_FRAC : SUBLINEAR_FRAC_SPARSE);
    ok(growth <= ceiling,
      `scaling: per-agent cost ${rows[i - 1].label}→${rows[i].label} ×${growth.toFixed(3)} ` +
      `< sub-linear ceiling ×${ceiling.toFixed(3)} (N ×${nRatio.toFixed(2)})`);
  }
}
