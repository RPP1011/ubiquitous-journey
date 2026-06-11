// BEHAVIOURAL-DIVERSITY PROBE (throwaway) — measures whether PERSONALITY actually translates into
// distinct BEHAVIOUR, and how committed agents are to a long-term through-line. Read-only.
//
//   bun test/_behavior.mjs [seed] [simSeconds]
//
// Reports:
//  · dominant-goal histogram + Shannon evenness (how varied the town's primary behaviours are)
//  · trait→behaviour Pearson correlations (the acid test: do bold souls fight, social souls mingle?)
//  · behavioural spread (mean pairwise L1 distance of normalised goal-vectors — higher = more unique)
//  · ambition-aligned dwell + medianGoalBudget (long-term commitment)
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { setSeed } from '../js/sim/rng.js';
import { goalDwellVector } from '../js/sim/signals.js';

const SEED = process.argv[2] !== undefined ? Number(process.argv[2]) : 31;
const SECS = Number(process.argv[3]) || 1200;
const dt = 1 / 60;

setSeed(SEED);
const world = new World(stubScene);
const sim = new Simulation(stubScene, world, { makeFighter, seed: SEED });
sim.spawn();
await Promise.all([
  import('../js/rpg/abilities/catalog.js').catch(() => {}),
  import('../js/rpg/abilities/generate.js').catch(() => {}),
  import('../js/rpg/abilities/ir.js').catch(() => {}),
]);
for (let k = 0; k < 50; k++) await Promise.resolve();
for (let i = 0; i < Math.round(SECS / dt); i++) { sim.update(dt); for (const f of sim.fighters) f.update(dt); }

const living = sim.agents.filter((a) => a.alive && !a.controlled && a.faction === 'townsfolk');

// per-agent normalised goal vector + the personality traits
const rows = [];
for (const a of living) {
  const v = goalDwellVector(a, sim.time);
  let span = 0; for (const k in v) span += v[k];
  if (span <= 0) continue;
  const frac = {}; for (const k in v) frac[k] = v[k] / span;
  const p = a.personality || {};
  rows.push({ a, frac, span, top: Object.keys(frac).reduce((b, k) => frac[k] > (frac[b] || 0) ? k : b, Object.keys(frac)[0]),
    risk: p.risk_tolerance ?? 0.5, social: p.social_drive ?? 0.5, curi: p.curiosity ?? 0.5, amb: p.ambition ?? 0.5, altr: p.altruism ?? 0.5,
    ambition: (a.ambition && a.ambition.kind) || '—' });
}

const pearson = (xs, ys) => {
  const n = xs.length; if (n < 3) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  return (vx <= 0 || vy <= 0) ? 0 : cov / Math.sqrt(vx * vy);
};
const fr = (r, ks) => ks.reduce((s, k) => s + (r.frac[k] || 0), 0);
const corr = (trait, ks) => pearson(rows.map((r) => r[trait]), rows.map((r) => fr(r, ks)));

// dominant-goal histogram + Shannon evenness
const hist = {}; for (const r of rows) hist[r.top] = (hist[r.top] || 0) + 1;
const tot = rows.length;
let H = 0; for (const k in hist) { const p = hist[k] / tot; H -= p * Math.log(p); }
const evenness = H / Math.log(Object.keys(hist).length || 1);   // 0..1; 1 = perfectly even

// behavioural spread: mean pairwise L1 distance of normalised goal-vectors (sampled, bounded)
const ALLK = [...new Set(rows.flatMap((r) => Object.keys(r.frac)))];
let dsum = 0, dn = 0;
for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
  let d = 0; for (const k of ALLK) d += Math.abs((rows[i].frac[k] || 0) - (rows[j].frac[k] || 0));
  dsum += d / 2; dn++;   // /2 so identical→0, disjoint→1
}
const spread = dn ? dsum / dn : 0;

// ambition-aligned dwell: fraction of life on goals this agent's ambition FAVOURS (>1)
const FAVGOALS = { wealth: ['work', 'market'], mastery: ['work'], renown: ['fight'], wanderlust: ['wander', 'sightsee'], belonging: ['socialize'] };
const aligned = rows.map((r) => fr(r, FAVGOALS[r.ambition] || []));
const meanAligned = aligned.reduce((s, v) => s + v, 0) / (aligned.length || 1);
const budgets = rows.map((r) => Math.max(...Object.values(r.frac))).sort((a, b) => a - b);
const median = budgets[budgets.length >> 1] || 0;

const pct = (x) => (100 * x).toFixed(0) + '%';
console.log(`\n=== BEHAVIOURAL DIVERSITY (seed ${SEED}, ${SECS}s) — ${rows.length} living townsfolk measured ===\n`);
console.log(`DOMINANT-GOAL HISTOGRAM (Shannon evenness ${evenness.toFixed(2)} of 1.0 — higher = more varied):`);
for (const [k, n] of Object.entries(hist).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${String(n).padStart(3)}  ${pct(n / tot)}`);
console.log(`\nTRAIT → BEHAVIOUR CORRELATIONS (Pearson; >0.3 = personality clearly drives it, ~0 = it doesn't):`);
console.log(`  risk_tolerance → fight        r = ${corr('risk', ['fight']).toFixed(2)}`);
console.log(`  risk_tolerance → flee         r = ${corr('risk', ['flee']).toFixed(2)}   (expect NEGATIVE)`);
console.log(`  social_drive   → socialize    r = ${corr('social', ['socialize']).toFixed(2)}`);
console.log(`  curiosity      → sightsee+wander r = ${corr('curi', ['sightsee', 'wander']).toFixed(2)}`);
console.log(`  ambition       → work+build   r = ${corr('amb', ['work', 'build']).toFixed(2)}`);
console.log(`  altruism       → steal/rob    r = ${corr('altr', ['steal', 'rob']).toFixed(2)}   (expect NEGATIVE)`);
console.log(`\nBEHAVIOURAL SPREAD (mean pairwise goal-vector distance, 0..1): ${spread.toFixed(3)}`);
console.log(`LONG-TERM COMMITMENT:  ambition-aligned dwell = ${pct(meanAligned)}   ·   median top-goal budget = ${pct(median)}`);
sim.dispose?.();
