// DISTPROBE — roster-wide NARRATIVE-DISTRIBUTION + HOMOGENEITY audit (an eval/inspection
// harness like test/lifetrace.mjs, NOT part of the headless gate). Drives the whole sim and,
// instead of following one hero, measures how interest is DISTRIBUTED across the living
// roster: eventfulness quantiles + top-decile share + zero count, who the top souls are,
// what a MEDIAN agent's life reads like, and the homogeneity histograms (primary class /
// held classes / top profile tag / faith / formative-memory kinds / time-use by goal kind)
// plus an arc-churn detector and the arc-entry snowball check. This is the tool that found
// (and re-measures) the merchant/Blind-Io/bond-memory monocultures and the early-arc snowball.
//
//   bun test/distprobe.mjs [--seed <n>] [--duration <secs>]
//
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { setSeed } from '../js/sim/rng.js';
import { agentBiography, agentDrive } from '../js/sim/biography.js';
import { memoryPhrase } from '../js/sim/memory.js';
import { deedLedger, oaths, goalDwellVector } from '../js/sim/signals.js';
import { goalBudgetOf } from './health.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? Number(process.argv[i + 1]) : dflt;
}
const SEED = arg('--seed', 7);
const SIM_SECONDS = arg('--duration', 1800);
const dt = 1 / 60;

setSeed(SEED);
const world = new World(stubScene);
const sim = new Simulation(stubScene, world, { makeFighter, seed: SEED });
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

// ---- eventfulness tally (same fold as lifetrace) + combat-exposure tally ----
const eventfulness = new Map();   // id -> { arcs, beats, deeds }
const bumpEvent = (id, key, n = 1) => {
  if (id == null) return;
  const e = eventfulness.get(id) || { arcs: 0, beats: 0, deeds: 0 };
  e[key] += n; eventfulness.set(id, e);
};
const combatTouched = new Map();  // id -> blows given+received (ground-truth exposure)
const bumpCombat = (id) => { if (id != null) combatTouched.set(id, (combatTouched.get(id) || 0) + 1); };

const arcsSeen = new Set(), beatsSeen = new Set();
const firstArcAt = new Map();     // id -> sim-time the agent FIRST became an arc principal

const t0 = Date.now();
let frame = 0;
while (sim.time < SIM_SECONDS) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) {
    sim.onCombatEvents(ev);
    for (const e of ev) {
      bumpCombat(e.attacker && e.attacker.id);
      bumpCombat(e.target && e.target.id);
    }
  }
  frame++;
  for (const arc of sim.sagas._closed) {
    if (arcsSeen.has(arc.arcId)) continue;
    arcsSeen.add(arc.arcId);
    if (Array.isArray(arc.principals)) for (const pid of arc.principals) {
      bumpEvent(pid, 'arcs');
      if (!firstArcAt.has(pid)) firstArcAt.set(pid, sim.time);
    }
  }
  if (frame % 600 === 0) {
    for (const b of sim.chronicle.recent(200) || []) {
      if (beatsSeen.has(b.id) || !b.text) continue;
      beatsSeen.add(b.id);
      for (const a of sim.agents) { if (a.name && b.text.indexOf(a.name) !== -1) bumpEvent(a.id, 'beats'); }
    }
  }
  if (frame % 18000 === 0) console.log(`  …${sim.time.toFixed(0)}s (wall ${(Date.now() - t0) / 1000 | 0}s)`);
}

for (const a of sim.agents) {
  const d = deedLedger(a); let n = 0; for (const k in d) n += d[k].n;
  if (n) bumpEvent(a.id, 'deeds', n);
}
const eventScore = (id) => { const e = eventfulness.get(id); return e ? e.arcs * 3 + e.beats * 2 + e.deeds : 0; };

// ---- the distribution over LIVING townsfolk ----
const living = sim.agents.filter((a) => a.alive && !a.controlled && a.faction === 'townsfolk');
const scored = living.map((a) => ({ a, s: eventScore(a.id) })).sort((x, y) => y.s - x.s);
const total = scored.reduce((s, x) => s + x.s, 0) || 1;
const q = (f) => scored[Math.min(scored.length - 1, Math.floor(f * (scored.length - 1)))].s;
const topDecile = scored.slice(0, Math.ceil(scored.length / 10));
const topShare = topDecile.reduce((s, x) => s + x.s, 0) / total;
const zeroes = scored.filter((x) => x.s === 0).length;

console.log(`\n=== NARRATIVE DISTRIBUTION  ·  seed=${SEED}  ·  ${SIM_SECONDS}s  ·  ${living.length} living townsfolk ===`);
console.log(`eventScore quantiles  p10=${q(0.9)}  p25=${q(0.75)}  p50=${q(0.5)}  p75=${q(0.25)}  p90=${q(0.1)}  max=${scored[0].s}`);
console.log(`top decile (${topDecile.length} souls) holds ${(topShare * 100).toFixed(0)}% of all eventfulness; ${zeroes} agents (${(zeroes / living.length * 100).toFixed(0)}%) scored ZERO`);

const withArcs = living.filter((a) => (eventfulness.get(a.id) || {}).arcs > 0).length;
const withOaths = living.filter((a) => Object.keys(oaths(a)).length > 0).length;
const withDeeds = living.filter((a) => Object.keys(deedLedger(a)).length > 0).length;
const named = living.filter((a) => (eventfulness.get(a.id) || {}).beats > 0).length;
const touched = living.filter((a) => combatTouched.has(a.id)).length;
console.log(`coverage: arcs ${withArcs}/${living.length}  oaths ${withOaths}  deeds ${withDeeds}  chronicle-named ${named}  combat-touched ${touched}`);

// correlation: does combat exposure explain eventfulness?
const inCombat = scored.filter((x) => combatTouched.has(x.a.id));
const noCombat = scored.filter((x) => !combatTouched.has(x.a.id));
const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x.s, 0) / xs.length : 0;
console.log(`mean eventScore: combat-touched ${mean(inCombat).toFixed(1)} (${inCombat.length})  vs never-in-combat ${mean(noCombat).toFixed(1)} (${noCombat.length})`);

// ---- WHO are the top souls? ----
console.log(`\n--- the top 8 ---`);
for (const { a, s } of scored.slice(0, 8)) {
  const e = eventfulness.get(a.id) || {};
  const pc = a.progression && a.progression.primaryClass && a.progression.primaryClass();
  console.log(`  ${a.name}  score=${s} (arcs=${e.arcs | 0} beats=${e.beats | 0} deeds=${e.deeds | 0})  ` +
    `class=${pc ? pc.key : '-'}  watch=${!!a.watch}  combatant=${!!a.combatant}  kills=${a.life ? a.life.kills : 0}  blows=${combatTouched.get(a.id) | 0}`);
}

// ---- what does a MEDIAN life read like? ----
console.log(`\n--- three median lives (p45/p50/p55) ---`);
for (const f of [0.45, 0.5, 0.55]) {
  const { a, s } = scored[Math.floor(f * (scored.length - 1))];
  const e = eventfulness.get(a.id) || {};
  const dwell = goalBudgetOf(a, sim.time);
  let bio = '', drive = '';
  try { bio = agentBiography(a, sim) || ''; } catch { /* */ }
  try { drive = agentDrive(a) || ''; } catch { /* */ }
  console.log(`\n  ${a.name}  score=${s} (arcs=${e.arcs | 0} beats=${e.beats | 0} deeds=${e.deeds | 0})`);
  console.log(`    bio:   ${String(bio).slice(0, 180)}`);
  console.log(`    drive: ${String(drive).slice(0, 140)}`);
  console.log(`    time:  ${(dwell.topFrac * 100).toFixed(0)}% of life in '${dwell.top}' (${dwell.span | 0}s measured)`);
  const eps = (a.memory && a.memory.salient ? a.memory.salient(4) : []) || [];
  console.log(`    formative memories: ${eps.length ? eps.map((ep) => memoryPhrase(ep, (id) => { const x = sim.agentsById.get(id); return (x && x.name) || `#${id}`; })).join('; ') : '(none above the salience floor)'}`);
}

// ---- HOMOGENEITY diagnostics: class / faith / formative-memory / time-use distributions ----
const hist = (xs) => {
  const h = {};
  for (const x of xs) h[x] = (h[x] || 0) + 1;
  return Object.entries(h).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ');
};
console.log(`\n--- primary class (living townsfolk) ---`);
console.log(`  ${hist(living.map((a) => { const pc = a.progression && a.progression.primaryClass && a.progression.primaryClass(); return pc ? pc.key : '(none)'; }))}`);
const heldAll = [];
for (const a of living) {
  const cl = a.progression && a.progression.classes;
  if (cl && cl.forEach) cl.forEach((g, k) => heldAll.push(k));
}
console.log(`--- ALL held classes (multi-count) ---\n  ${hist(heldAll)}`);

console.log(`--- top behavior_profile tag per agent ---`);
console.log(`  ${hist(living.map((a) => {
  const bp = a.progression && a.progression.behavior_profile; if (!bp) return '(none)';
  let top = '(none)', tv = 0; for (const k in bp) if (bp[k] > tv) { tv = bp[k]; top = k; }
  return top;
}))}`);

console.log(`--- faith ---\n  ${hist(living.map((a) => a.faith || '(none)'))}`);

const memKinds = [];
for (const a of living) {
  const eps = (a.memory && a.memory.salient ? a.memory.salient(4) : []) || [];
  for (const ep of eps) memKinds.push(ep.kind);
}
console.log(`--- formative-memory kinds (4 salient slots x roster) ---\n  ${hist(memKinds)}`);

// time-use: mean fraction of dwell by goal kind across the roster
const dwellSum = {};
let dwellTotal = 0;
for (const a of living) {
  const v = goalDwellVector(a, sim.time);
  for (const k in v) { dwellSum[k] = (dwellSum[k] || 0) + v[k]; dwellTotal += v[k]; }
}
const dwellLine = Object.entries(dwellSum).sort((a, b) => b[1] - a[1]).slice(0, 10)
  .map(([k, s]) => `${k}:${(s / dwellTotal * 100).toFixed(0)}%`).join('  ');
console.log(`--- roster time-use by goal kind ---\n  ${dwellLine}`);

// ---- arc-churn detector: the most-arced agent's arc kinds (a healthy max is single digits) ----
const arcCount = new Map();
const arcKinds = new Map();
for (const a of sim.agents) { arcCount.set(a.id, 0); }
for (const id of arcsSeen) { /* arcsSeen holds arcIds, not per-agent — recount below */ }
{
  const perAgent = new Map();
  for (const arc of sim.sagas._closed) {
    for (const pid of arc.principals || []) {
      perAgent.set(pid, (perAgent.get(pid) || 0) + 1);
      const m = arcKinds.get(pid) || {};
      m[`${arc.kind}:${arc.outcome}`] = (m[`${arc.kind}:${arc.outcome}`] || 0) + 1;
      arcKinds.set(pid, m);
    }
  }
  // NOTE: _closed is a bounded ring (320) — the eventfulness tally above counts the true
  // total; this dump is the RETAINED tail, enough to identify a churning kind.
  const worstE = [...eventfulness.entries()].sort((a, b) => (b[1].arcs | 0) - (a[1].arcs | 0))[0];
  if (worstE) {
    const wid = worstE[0];
    const w = sim.agentsById.get(wid);
    console.log(`\n--- most-arced agent: ${(w && w.name) || wid} (${worstE[1].arcs} arcs tallied) — retained kinds: ${JSON.stringify(arcKinds.get(wid) || {})}`);
  }
}

// ---- snowball check: of the agents in ≥2 arcs, when did their FIRST arc land? ----
const multi = scored.filter((x) => (eventfulness.get(x.a.id) || {}).arcs >= 2);
const early = multi.filter((x) => (firstArcAt.get(x.a.id) || Infinity) < SIM_SECONDS / 3).length;
console.log(`\nsnowball: ${multi.length} agents hold >=2 arcs; ${early} of them (${multi.length ? (early / multi.length * 100).toFixed(0) : 0}%) entered their FIRST arc in the first third of the run`);
console.log(`(wall ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
