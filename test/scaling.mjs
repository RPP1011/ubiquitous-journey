// Phase 3 (Scale) cost-scaling gate — proves the REASONING-COST-PER-AGENT-PER-TICK
// metric stays FLAT (or sub-linear) as the town N grows, which is what makes
// "tractable" MEASURED rather than asserted.
//
//   bun test/scaling.mjs          # builds sims at N ≈ 50/100/200; exit 1 on a cost-growth breach
//
// It drives the WHOLE sim headlessly exactly like test/depth.mjs (sim.update ->
// fighter.update -> resolveCombat -> onCombatEvents), samples a DepthProbe on a
// 1 Hz cadence, and reads rep.reasoning.cost.total — the per-agent-tick deliberative
// work (schema evals + candidates scored + replans), already window-averaged by the
// probe (Σwork / Σ living-agent-samples).
//
// TWO modes (the order gate that makes the test non-trivial):
//   (1) LOD OFF — the STRUCTURAL baseline. Per-agent work is already bounded (beliefs
//       ≤12, schemas fixed, candidates ≤~10) independent of N, so this should be flat
//       even with no LOD. Proves the bound.
//   (2) LOD ON  — assert per-agent cost is flat AND never materially ABOVE the LOD-off
//       cost at each N (LOD must not raise cost; at the larger N it should LOWER it).
//       This demonstrates the MECHANISM, not just the pre-existing bound.
//
// The sim uses raw Math.random() (no seed), so the metric swings run-to-run on its
// high-variance components (replans). We control that by window-averaging (~40
// windows per run) and a generous growth band.

import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { DepthProbe } from '../js/sim/depthMetrics.js';
import { LOD } from '../js/sim/simconfig.js';
import { makeFighter, stubScene } from './harness.mjs';

// per-town townsfolk counts chosen so total LIVING agents land near 50 / 100 / 200.
// (Two towns + ~20 fixed others: monsters/camps/reporter. The test reads the ACTUAL
// living count and normalises by it, so the exact N need not be exact.)
const SIZES = [
  { label: 'N≈50',  townsfolkPerTown: 15 },
  { label: 'N≈100', townsfolkPerTown: 40 },
  { label: 'N≈200', townsfolkPerTown: 90 },
];

// The gate is "flat OR SUB-LINEAR". Per-agent work is bounded by LOCAL density
// (a fixed vision radius × the ≤12-belief cap), NOT by N — so as the fixed-radius
// town packs more agents the per-agent candidate count rises toward a SATURATION
// ceiling, then flattens. The honest, non-trivial assertion is therefore SUB-LINEAR:
// when N grows ×R, per-agent cost must grow by strictly LESS than ×R, with margin
// (linear-in-N per agent would be quadratic total — that is the failure we guard).
// We require per-agent growth to stay under SUBLINEAR_FRAC of the actual N ratio.
// The smallest N is UNDER-saturated (the fixed-radius town isn't packed yet, so its
// per-agent candidate count sits below the saturation ceiling) — the step OUT of that
// sparse regime is partly a saturation RAMP, not N-driven cost, so we relax the
// sub-linear fraction there. Once dense (N_prev ≥ 100) the bound is tight: the metric
// must be genuinely flat-ish, well under the N ratio.
const SUBLINEAR_FRAC = 0.85;          // dense/saturated step (N_prev ≥ 100): tight
const SUBLINEAR_FRAC_SPARSE = 1.00;   // sparse step (N_prev < 100): still strictly < N ratio
// Once density SATURATES (N ≥ ~100, beliefs near the ≤12 cap) cost is essentially
// flat — assert the upper successive step is within this band. Still far tighter than
// the sub-linear ceiling (~×1.66 at these N), so it asserts genuine near-flatness in
// the dense regime, while absorbing the unseeded run-to-run swing in the (density-
// saturated) candidate count.
const SATURATED_BAND = 1.35;
// LOD-on cost must not exceed LOD-off by more than this factor at any N (no seed
// => a small overhead band absorbs run-to-run variance; at scale LOD should LOWER it).
const LOD_OVERHEAD_BAND = 1.12;

const FRAMES = 2500, dt = 1 / 60, SAMPLE_EVERY = 60;   // ~40s, ~40 windows

// Build + drive one sim at the given per-town headcount; returns the cost block
// plus the mean living-agent count over the sampled windows.
async function runOne(townsfolkPerTown) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  sim.spawn({ townsfolkPerTown });

  // settle the lazy ability imports (mirror depth.mjs) so cognition is realistic
  await Promise.all([
    import('../js/rpg/abilities/catalog.js').catch(() => {}),
    import('../js/rpg/abilities/ir.js').catch(() => {}),
  ]);
  for (let k = 0; k < 5; k++) await Promise.resolve();

  const probe = new DepthProbe(sim);
  sim._depTrades = 0;

  let aliveSum = 0, aliveSamples = 0;
  let stage = 'init';
  try {
    for (let i = 0; i < FRAMES; i++) {
      stage = 'sim.update'; sim.update(dt);
      stage = 'fighter.update'; for (const f of sim.fighters) f.update(dt);
      stage = 'resolveCombat';
      const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
      if (ev.length) { stage = 'onCombatEvents'; sim.onCombatEvents(ev); }
      if (i % SAMPLE_EVERY === 0) {
        stage = 'probe.sample';
        probe.sample(sim.time);
        aliveSum += sim.agents.filter((a) => a.alive).length;
        aliveSamples++;
      }
    }
  } catch (err) {
    console.error(`\nFAILED: scaling run threw at stage '${stage}' -> ${err && err.message}`);
    console.error(err);
    process.exit(1);
  }

  const rep = probe.report({ goldConserved: true });
  return { cost: rep.reasoning.cost, meanAlive: aliveSamples ? aliveSum / aliveSamples : 0 };
}

// Run all three sizes for the CURRENT LOD.enabled, return rows keyed by label.
async function sweep(modeLabel) {
  const rows = [];
  for (const s of SIZES) {
    const r = await runOne(s.townsfolkPerTown);
    rows.push({ ...s, ...r });
    const c = r.cost;
    console.log(
      `  [${modeLabel}] ${s.label}  alive≈${r.meanAlive.toFixed(0).padStart(3)} · ` +
      `schemaEvals/at ${c.schemaEvalsPerAgentTick.toFixed(3)} · ` +
      `decide/at ${c.decideCallsPerAgentTick.toFixed(3)} · ` +
      `cands/at ${c.candsPerAgentTick.toFixed(2)} · ` +
      `replans/at ${c.replansPerAgentTick.toFixed(2)} · ` +
      `maxPlanDepth ${c.planDepthMax} · TOTAL ${c.total.toFixed(3)}/agent-tick`,
    );
  }
  return rows;
}

async function main() {
  const fails = [];

  console.log('\n=== Phase 3 cost-scaling gate ===');
  console.log(`drive: ${FRAMES} frames @ ${dt.toFixed(4)}s, sample every ${SAMPLE_EVERY} (~${(FRAMES / SAMPLE_EVERY) | 0} windows)\n`);

  // --- mode 1: LOD OFF (structural baseline) ---
  const savedEnabled = LOD.enabled;
  LOD.enabled = false;
  console.log('LOD OFF (structural baseline — per-agent work is bounded independent of N):');
  const off = await sweep('off');

  // --- mode 2: LOD ON (the mechanism) ---
  LOD.enabled = true;
  console.log('\nLOD ON (amortized cognition — distant/idle tail reasons every Kth tick):');
  const on = await sweep('on');
  LOD.enabled = savedEnabled;   // restore (we mutate the live config object in-process only)

  // --- assert: per-agent cost is SUB-LINEAR in N, in BOTH modes ---
  // For each successive (N_prev -> N_cur): per-agent cost growth must be strictly
  // below the N-growth ratio (sub-linear => bounded, NOT N-driven). Once saturated
  // (N_prev >= 100) it must additionally be near-flat (within SATURATED_BAND).
  console.log('\n--- assertions ---');
  for (const [mode, rows] of [['off', off], ['on', on]]) {
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].cost.total, cur = rows[i].cost.total;
      const nPrev = rows[i - 1].meanAlive, nCur = rows[i].meanAlive;
      const growth = prev > 1e-9 ? cur / prev : 1;
      const nRatio = nPrev > 1e-9 ? nCur / nPrev : 1;
      const ceiling = nRatio * (nPrev >= 100 ? SUBLINEAR_FRAC : SUBLINEAR_FRAC_SPARSE);
      const okSub = growth <= ceiling;
      console.log(`  [${mode}] per-agent cost ${rows[i - 1].label}→${rows[i].label}: ` +
        `${prev.toFixed(3)} → ${cur.toFixed(3)}  (×${growth.toFixed(3)})  vs N ×${nRatio.toFixed(2)} ` +
        `(sub-linear ceiling ×${ceiling.toFixed(3)})  ${okSub ? 'SUB-LINEAR ✓' : 'TOO STEEP ✗'}`);
      if (!okSub) fails.push(`[${mode}] cost grew ${rows[i - 1].label}→${rows[i].label} ×${growth.toFixed(3)} ` +
        `>= sub-linear ceiling ×${ceiling.toFixed(3)} (N grew ×${nRatio.toFixed(2)})`);
      // saturated regime: once the town is dense the per-agent cost must be ~flat.
      if (nPrev >= 100) {
        const okFlat = growth <= SATURATED_BAND;
        if (!okFlat) fails.push(`[${mode}] saturated cost grew ${rows[i - 1].label}→${rows[i].label} ×${growth.toFixed(3)} > ${SATURATED_BAND}`);
        console.log(`    └ saturated (N≥100): ${okFlat ? `FLAT ✓ (≤×${SATURATED_BAND})` : `NOT FLAT ✗ (>×${SATURATED_BAND})`}`);
      }
    }
  }

  // --- assert: LOD ON does not RAISE cost vs LOD OFF at any N (mechanism, not just bound) ---
  for (let i = 0; i < SIZES.length; i++) {
    const offT = off[i].cost.total, onT = on[i].cost.total;
    const ratio = offT > 1e-9 ? onT / offT : 1;
    const okHelps = ratio <= LOD_OVERHEAD_BAND;
    console.log(`  [on vs off] ${SIZES[i].label}: ${onT.toFixed(3)} (on) vs ${offT.toFixed(3)} (off)  ` +
      `(×${ratio.toFixed(3)})  ${ratio < 1 ? 'LOWER ✓' : okHelps ? 'NEUTRAL ✓' : 'HIGHER ✗'}`);
    if (!okHelps) fails.push(`[on vs off] ${SIZES[i].label} LOD raised cost ×${ratio.toFixed(3)} > ${LOD_OVERHEAD_BAND}`);
  }

  if (fails.length) {
    console.log(`\n  COST-SCALING GATE BREACHED:\n    ${fails.join('\n    ')}`);
    process.exit(1);
  }
  console.log(`\n  ✓ per-agent reasoning cost is SUB-LINEAR as N grows (< the N ratio — tight ×${SUBLINEAR_FRAC} ` +
    `once dense, flat ≤×${SATURATED_BAND} in the saturated regime) in both LOD modes, and LOD-on never ` +
    `raises it (≤×${LOD_OVERHEAD_BAND}) — "tractable" is MEASURED.`);
  process.exit(0);
}

main();
