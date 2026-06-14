// KNOWLEDGE-USE PROBE — the quantitative measurement instrument for docs/architecture/18
// (Knowledge Exploitation). An eval/inspection harness like test/distprobe.mjs + test/lifetrace.mjs
// (NOT part of the headless gate). It drives the WHOLE sim headless under a fixed SEED and reports
// the doc's "definition of done" metrics on the CONSUMPTION side — how richly NPC decisions read the
// belief fields the formation layer already banks, and how far personality moves a decision when the
// beliefs are held fixed.
//
//   bun test/knowledgeprobe.mjs [--seed <n>] [--duration <secs>]
//
// It is meant to capture a BASELINE on the CURRENT tree (before the M1/M2/M3 site-fixes land) so the
// before/after deltas in the impact report are visible. SEVERAL metrics read ~0 here BY DESIGN — those
// are exactly the gaps the doc names (flee is radial, migration ignores comparative advantage,
// believedThreat is not a field yet). The probe PRINTS them clearly so a later run shows the delta.
//
// THE METRICS (doc §Measurement):
//   1. FLEE→KNOWN-REFUGE     — % of flee decisions whose target is a KNOWN refuge (a believed
//                              safe/exit/conceal place or a comfort source) vs a pure RADIAL push.
//   2. MIGRATION↔ADVANTAGE   — does an emigrant's destination correlate with its comparative
//                              advantage (believed labour margin for its trade)? + migrants' margin
//                              vs stayers' (do the better-off-elsewhere actually move there?).
//   3. TRADE-READS-SOCIAL    — fraction of NPC↔NPC trades whose seller HELD a social belief about
//                              the buyer at clear time (standing/hostile/motive read available).
//   4. PERSONALITY-VARIANCE  — beliefs held FIXED, personality varied: run identical belief+need
//                              states for one agent through many trait profiles and measure how many
//                              DISTINCT winning goals (and which) the scorer produces. The M3 dial.
//   5. SURVIVAL-READS-THREAT — % of survival (flee/fight) decisions that read a believedThreat /
//                              believed-combat-strength field (vs distance + faction + personality).
//                              (believedThreat is NOT a belief field today → 0 by construction.)
//
// Read-only over the sim: nothing here drives a decision. The personality-variance metric clones an
// agent's OWN state and calls the pure scorer (scoreAndSelect) on throwaway copies — the live roster
// is never mutated.

import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { setSeed } from '../js/sim/rng.js';
import { scoreAndSelect, nearestComfortSource } from '../js/sim/agent/decide.js';
import { laborValue } from '../js/sim/agent/occupation.js';
import { recentTrades } from '../js/sim/econstats.js';
import { SIM } from '../js/sim/simconfig.js';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? Number(process.argv[i + 1]) : dflt;
}
const SEED = arg('--seed', 7);
const SIM_SECONDS = arg('--duration', 900);
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

const ctx = sim._ctx();
const nearOf = (p, q) => Math.hypot((p.x ?? 0) - (q.x ?? 0), (p.z ?? 0) - (q.z ?? 0));

// ── accumulators ────────────────────────────────────────────────────────────
// 1. flee targeting
let fleeDecisions = 0, fleeToKnownRefuge = 0, fleeRadial = 0;
// 5. survival decisions that read a believedThreat field (structural: does the belief carry one?)
let survivalDecisions = 0, survivalReadThreat = 0;
// a believed-threat field is a per-belief scalar the doc names: believedThreat / threat / level.
// We probe whether ANY hostile belief the agent acts on carries such a field (formation-gap test).
const THREAT_FIELDS = ['believedThreat', 'threat', 'level', 'combatStrength'];
// 3. trade reads social belief — sampled from the econstats feed, deduped.
let npcTrades = 0, tradesWithSellerBelief = 0;
const tradeSeen = new Set();
// 2. migration ↔ comparative advantage
const migrants = [];          // { id, fromTown, toTown, laborValue, margin }
const everMigrating = new Set();
const laborByAgent = new Map();   // last-sampled laborValue per living townsperson (for stayer baseline)

// a known refuge = a believed shelter/safe place the agent could flee TOWARD. We approximate the
// "did flee read a refuge" test the SAME way nearestComfortSource does (the M1 exemplar): if the
// fleeing agent has a known comfort/shelter source AND its flee goal aims at that source, it read
// knowledge; if the goal is a pure repulsor (no toPos, or toPos merely away from the threat), radial.
function fleeTargetsRefuge(a) {
  try {
    const g = a.goal;
    if (!g || g.kind !== 'flee') return null;          // not a flee this tick
    const refuge = nearestComfortSource(a, ctx) || (ctx.map && ctx.map.nearest(['safe', 'exit', 'conceal', 'shelter', 'rest'], a.pos, a.townId));
    // a refuge-targeting flee MUST carry a toPos that lands near a KNOWN refuge.
    if (g.toPos && refuge && refuge.pos) return nearOf(g.toPos, refuge.pos) < 6;
    return false;                                       // no toPos (pure repulsor) → radial
  } catch { return false; }
}

const t0 = Date.now();
let frame = 0;
while (sim.time < SIM_SECONDS) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);
  frame++;

  // sample decisions on a cadence (cheap; goals are stable across the 6Hz cognition tick).
  if (frame % 30 === 0) {
    for (const a of sim.agents) {
      if (a.controlled || !a.alive) continue;
      const g = a.goal;
      // FLEE targeting
      if (g && g.kind === 'flee') {
        fleeDecisions++;
        const r = fleeTargetsRefuge(a);
        if (r) fleeToKnownRefuge++; else fleeRadial++;
      }
      // SURVIVAL (flee|fight) — does the acted-on hostile belief carry a believed-threat field?
      if (g && (g.kind === 'flee' || g.kind === 'fight')) {
        survivalDecisions++;
        const sid = g.fromId != null ? g.fromId : g.targetId;
        let read = false;
        try {
          const b = sid != null && a.beliefs ? a.beliefs.get(sid) : null;
          if (b) for (const f of THREAT_FIELDS) if (typeof b[f] === 'number') { read = true; break; }
        } catch { /* */ }
        if (read) survivalReadThreat++;
      }
      // migration intent (truth-side observe — does NOT drive a decision)
      if (a._migrating && !everMigrating.has(a.id)) {
        everMigrating.add(a.id);
        let lv = 1; try { lv = laborValue(a); } catch { /* */ }
        migrants.push({ id: a.id, name: a.name, fromTown: a.townId, toTown: a._migrating.townId, laborValue: lv });
      }
      // cache labour value for the stayer baseline
      if (a.faction === 'townsfolk') { try { laborByAgent.set(a.id, laborValue(a)); } catch { /* */ } }
    }
    // TRADE social-belief read — drain the econstats feed (bounded ring), dedup.
    try {
      for (const tr of recentTrades(14)) {
        if (tr.sellerId == null || tr.buyerId == null) continue;
        const key = `${tr.t}:${tr.sellerId}:${tr.buyerId}:${tr.commodity}:${tr.price}`;
        if (tradeSeen.has(key)) continue;
        tradeSeen.add(key);
        const seller = sim.agentsById.get(tr.sellerId), buyer = sim.agentsById.get(tr.buyerId);
        if (!seller || !buyer || seller.controlled || buyer.controlled) continue;   // NPC↔NPC only
        npcTrades++;
        const b = seller.beliefs && seller.beliefs.get(tr.buyerId);
        if (b) tradesWithSellerBelief++;       // a social belief was AVAILABLE to read (standing/etc.)
      }
    } catch { /* */ }
  }
  if (frame % 18000 === 0) console.log(`  …${sim.time.toFixed(0)}s (wall ${(Date.now() - t0) / 1000 | 0}s)`);
}

// ── METRIC 4: personality variance with beliefs held FIXED ────────────────────
// Take a sample of living townsfolk; for each, hold its OWN belief/need/inventory state FIXED and
// run a battery of personality profiles through the pure scorer (scoreAndSelect). Count how many
// DISTINCT winning goals the SAME beliefs produce across the trait profiles — the M3 "same beliefs,
// different character ⇒ different action" signal. We clone the agent shallowly and only swap
// `personality` + `mood` (the trait dial), so beliefs/needs/inventory/position are identical inputs.
const PROFILES = [
  { name: 'coward',  personality: { risk_tolerance: 0.05, ambition: 0.3, social_drive: 0.4, curiosity: 0.3, altruism: 0.5, greed: 0.3 } },
  { name: 'striver', personality: { risk_tolerance: 0.5,  ambition: 0.95, social_drive: 0.3, curiosity: 0.3, altruism: 0.3, greed: 0.7 } },
  { name: 'daredevil', personality: { risk_tolerance: 0.95, ambition: 0.6, social_drive: 0.4, curiosity: 0.6, altruism: 0.4, greed: 0.4 } },
  { name: 'hermit',  personality: { risk_tolerance: 0.4,  ambition: 0.2, social_drive: 0.05, curiosity: 0.8, altruism: 0.3, greed: 0.2 } },
  { name: 'butterfly', personality: { risk_tolerance: 0.4, ambition: 0.3, social_drive: 0.95, curiosity: 0.5, altruism: 0.8, greed: 0.2 } },
  { name: 'miser',   personality: { risk_tolerance: 0.3,  ambition: 0.4, social_drive: 0.2, curiosity: 0.2, altruism: 0.1, greed: 0.95 } },
];
const NEUTRAL_MOOD = { fear: 0, anger: 0, joy: 0, grief: 0, pride: 0, loneliness: 0 };

function winningGoalUnder(a, profile) {
  // clone just enough that scoreAndSelect reads the SAME beliefs/needs but a DIFFERENT personality.
  // scoreAndSelect mutates a._decideCands / a.goal-adjacent telemetry; clone is a fresh proto-linked
  // object so the live agent is untouched (the live roster is never mutated by the probe).
  const clone = Object.create(Object.getPrototypeOf(a));
  Object.assign(clone, a);
  clone.personality = Object.assign({}, a.personality, profile.personality);
  clone.mood = Object.assign({}, NEUTRAL_MOOD, a.mood && { fear: 0, anger: 0 });   // neutralise transient mood; trait is the variable
  try {
    const g = scoreAndSelect(clone, ctx, null);
    return (g && g.kind) || null;
  } catch { return null; }
}

const living = sim.agents.filter((a) => a.alive && !a.controlled && a.faction === 'townsfolk' && a.canWork);
// sample up to 40 agents spread across the roster for the variance probe.
const step = Math.max(1, Math.floor(living.length / 40));
const sample = living.filter((_, i) => i % step === 0).slice(0, 40);
let varianceSum = 0, divergedAgents = 0;
const divergencePairs = new Map();   // 'coward→flee | striver→work' style — distinct winning-goal sets
for (const a of sample) {
  const wins = new Map();   // profileName -> goalKind
  for (const p of PROFILES) wins.set(p.name, winningGoalUnder(a, p));
  const distinct = new Set([...wins.values()].filter((v) => v != null));
  varianceSum += distinct.size;
  if (distinct.size > 1) divergedAgents++;
  // record the winning-goal vector signature for the most divergent few
  if (distinct.size > 1) {
    const sig = [...wins.entries()].map(([n, k]) => `${n}:${k}`).join(' ');
    divergencePairs.set(sig, (divergencePairs.get(sig) || 0) + 1);
  }
}
const meanDistinctGoals = sample.length ? varianceSum / sample.length : 0;
const divergedFrac = sample.length ? divergedAgents / sample.length : 0;

// ── migration correlation ─────────────────────────────────────────────────────
// Correlation of migration destination with comparative advantage. Today the destination is a
// received rumour (town id) with NO margin read, so we report the structural fact + the measurable
// proxy: do MIGRANTS have a higher (or lower) believed labour value than STAYERS? If migration read
// comparative advantage, movers would be those whose margin is WORSE where they are.
const migMargins = migrants.map((m) => m.laborValue);
const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
const stayerMargins = [...laborByAgent.entries()].filter(([id]) => !everMigrating.has(id)).map(([, v]) => v);
const migMean = mean(migMargins), stayMean = mean(stayerMargins);

// ── REPORT ─────────────────────────────────────────────────────────────────
const wall = ((Date.now() - t0) / 1000).toFixed(1);
const p = (n, d) => d > 0 ? (100 * n / d).toFixed(1) + '%' : '—';

console.log(`\n╔══ KNOWLEDGE-USE PROBE  ·  seed=${SEED}  ·  ${SIM_SECONDS}s in ${wall}s wall ══`);
console.log(`  (consumption-side baseline for docs/architecture/18 — several metrics read ~0 BY DESIGN; those are the gaps)\n`);

console.log(`  1. FLEE → KNOWN REFUGE`);
console.log(`     flee decisions sampled: ${fleeDecisions}`);
console.log(`     → toward a KNOWN refuge: ${fleeToKnownRefuge} (${p(fleeToKnownRefuge, fleeDecisions)})   ·   RADIAL (away-only): ${fleeRadial} (${p(fleeRadial, fleeDecisions)})`);
console.log(`     [GAP: flee is a pure repulsor field today — no refuge knowledge read → expect ~0%]`);

console.log(`\n  2. MIGRATION ↔ COMPARATIVE ADVANTAGE`);
console.log(`     emigrants observed: ${migrants.length}   ·   stayers measured: ${stayerMargins.length}`);
console.log(`     migrants' mean believed labour value: ${migMean.toFixed(3)}   ·   stayers': ${stayMean.toFixed(3)}   (Δ ${(migMean - stayMean).toFixed(3)})`);
console.log(`     destination chosen by comparative advantage? NO — destination is a received town-rumour (no margin/price read).`);
console.log(`     [GAP: migration reads poverty + personality, never the agent's trade margin at the destination]`);
if (migrants.length) console.log(`     movers: ${migrants.slice(0, 8).map((m) => `${m.name}(t${m.fromTown}→t${m.toTown}, lv=${m.laborValue.toFixed(2)})`).join('  ')}`);

console.log(`\n  3. TRADE READS A SOCIAL BELIEF`);
console.log(`     NPC↔NPC trades sampled: ${npcTrades}`);
console.log(`     → seller HELD a social belief about the buyer: ${tradesWithSellerBelief} (${p(tradesWithSellerBelief, npcTrades)})`);
console.log(`     (the standing skew + credit gate READ this belief when present; no believed-thief / motive refusal exists)`);

console.log(`\n  4. PERSONALITY VARIANCE (beliefs held FIXED, ${PROFILES.length} trait profiles)`);
console.log(`     agents probed: ${sample.length}`);
console.log(`     mean DISTINCT winning goals per agent across profiles: ${meanDistinctGoals.toFixed(2)} (of ${PROFILES.length} profiles)`);
console.log(`     agents whose decision DIVERGED with personality: ${divergedAgents} (${p(divergedAgents, sample.length)})`);
if (divergencePairs.size) {
  console.log(`     example divergences (winning goal per profile):`);
  for (const [sig, n] of [...divergencePairs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4))
    console.log(`       ×${n}  ${sig}`);
}

console.log(`\n  5. SURVIVAL READS A believedThreat FIELD`);
console.log(`     survival (flee|fight) decisions sampled: ${survivalDecisions}`);
console.log(`     → read a believed-threat field (${THREAT_FIELDS.join('/')}): ${survivalReadThreat} (${p(survivalReadThreat, survivalDecisions)})`);
console.log(`     [GAP: no believedThreat is banked into beliefs today → survival reads distance + faction + risk_tolerance only → 0%]`);

console.log(`\n  actOnBeliefMin=${SIM.actOnBeliefMin}  visionRange=${SIM.visionRange}  dangerRange=${SIM.dangerRange}`);
console.log(`╚${'═'.repeat(66)}`);

sim.dispose();
