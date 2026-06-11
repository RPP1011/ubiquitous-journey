// BELIEF-CAP SWEEP — find the MAX USEFUL ToM table size: where do the behavioural/social gains
// of a bigger mind PLATEAU while the per-frame cost keeps climbing? Sweeps SIM.beliefsPerAgent
// in-process (the config object is mutable; each arm builds a fresh seeded sim), measuring per
// arm: the trait→behaviour correlations (legibility), group cohesion, aligned dwell, behavioural
// spread, mean realised table size (are the slots even USED?), and wall-clock ms/frame (cost).
//
//   bun test/beliefsweep.mjs [duration=900] [seedA=31] [seedB=77]
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { SIM } from '../js/sim/simconfig.js';
import { goalDwellVector, groupCohesion } from '../js/sim/signals.js';

const SECS = Number(process.argv[2]) || 900;
const SEEDS = [Number(process.argv[3]) || 31, Number(process.argv[4]) || 77];
const CAPS = [12, 25, 50, 100, 175, 300];   // 175 ≈ roster-scale; 300 = effectively UNBOUNDED (eviction never fires)
const dt = 1 / 60;

const pearson = (xs, ys) => {
  const n = xs.length; if (n < 3) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  return (vx <= 0 || vy <= 0) ? 0 : cov / Math.sqrt(vx * vy);
};

async function arm(cap, seed) {
  SIM.beliefsPerAgent = cap;
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter, seed });
  sim.spawn();
  await Promise.all([import('../js/rpg/abilities/catalog.js').catch(() => {}), import('../js/rpg/abilities/generate.js').catch(() => {})]);
  for (let k = 0; k < 50; k++) await Promise.resolve();
  const frames = Math.round(SECS / dt);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) { sim.update(dt); for (const f of sim.fighters) f.update(dt); }
  const msPerFrame = (performance.now() - t0) / frames;

  const living = sim.agents.filter((a) => a.alive && !a.controlled && a.faction === 'townsfolk');
  const rows = [];
  let tblSum = 0, tblN = 0;
  for (const a of living) {
    const m = a.beliefs && a.beliefs.map; if (m) { tblSum += m.size; tblN++; }
    const v = goalDwellVector(a, sim.time);
    let span = 0; for (const k in v) span += v[k];
    if (span <= 0) continue;
    const frac = {}; for (const k in v) frac[k] = v[k] / span;
    const p = a.personality || {};
    rows.push({ frac, risk: p.risk_tolerance ?? 0.5, social: p.social_drive ?? 0.5, curi: p.curiosity ?? 0.5 });
  }
  const fr = (r, ks) => ks.reduce((s, k) => s + (r.frac[k] || 0), 0);
  const corr = (t, ks) => pearson(rows.map((r) => r[t]), rows.map((r) => fr(r, ks)));
  const gc = groupCohesion(sim);
  const FAV = { wealth: ['work', 'market'], mastery: ['work'], renown: ['fight', 'seek_glory'], wanderlust: ['wander', 'sightsee'], belonging: ['socialize'] };
  // aligned dwell needs each agent's ambition: recompute quickly
  let alignedSum = 0, alignedN = 0;
  for (const a of living) {
    const v = goalDwellVector(a, sim.time);
    let span = 0; for (const k in v) span += v[k];
    if (span <= 0 || !a.ambition) continue;
    const ks = FAV[a.ambition.kind] || [];
    let al = 0; for (const k of ks) al += (v[k] || 0);
    alignedSum += al / span; alignedN++;
  }
  const out = {
    cap, seed,
    msPerFrame: +msPerFrame.toFixed(3),
    tableFill: tblN ? +(tblSum / tblN).toFixed(1) : 0,
    riskFightGlory: +corr('risk', ['fight', 'seek_glory']).toFixed(2),
    riskFlee: +corr('risk', ['flee']).toFixed(2),
    socialSocialize: +corr('social', ['socialize']).toFixed(2),
    curiosityExplore: +corr('curi', ['sightsee', 'wander']).toFixed(2),
    cohesion: +gc.mean.toFixed(2),
    alignedDwellPct: alignedN ? Math.round(100 * alignedSum / alignedN) : 0,
    living: living.length,
  };
  sim.dispose?.();
  return out;
}

console.log(`belief-cap sweep: caps=${CAPS.join('/')} seeds=${SEEDS.join('/')} duration=${SECS}s`);
const results = [];
for (const cap of CAPS) for (const seed of SEEDS) {
  const r = await arm(cap, seed);
  results.push(r);
  console.log(JSON.stringify(r));
}
// per-cap averages
console.log('\ncap  ms/frame  tableFill  risk→f+g  risk→flee  social  curiosity  cohesion  aligned%');
for (const cap of CAPS) {
  const rs = results.filter((r) => r.cap === cap);
  const avg = (k) => (rs.reduce((s, r) => s + r[k], 0) / rs.length);
  console.log(`${String(cap).padEnd(4)} ${avg('msPerFrame').toFixed(3).padEnd(9)} ${avg('tableFill').toFixed(1).padEnd(10)} ${avg('riskFightGlory').toFixed(2).padEnd(9)} ${avg('riskFlee').toFixed(2).padEnd(10)} ${avg('socialSocialize').toFixed(2).padEnd(7)} ${avg('curiosityExplore').toFixed(2).padEnd(10)} ${avg('cohesion').toFixed(2).padEnd(9)} ${Math.round(avg('alignedDwellPct'))}`);
}
