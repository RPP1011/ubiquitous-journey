// SCRATCH: expedition-survival audit. Cranks expedition cadence, snapshots every member
// at formation (sustain/alpha/level/risk/explore), records outcomes (survived/fell, kills),
// and prints survivor-vs-fallen group means — the optimal-adventurer-archetype test.
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { setSeed } from '../js/sim/rng.js';
import { EXPEDITION } from '../js/sim/simconfig.js';

const SEED = Number(process.argv[process.argv.indexOf('--seed') + 1] || 7);
setSeed(SEED);
// crank the cadence so a 30-min run yields a sample (serial — the delve pocket is shared).
EXPEDITION.formEvery = 20; EXPEDITION.formChance = 1; EXPEDITION.delveChance = 1;
EXPEDITION.captainMinLevel = 2; EXPEDITION.partySize = 4; EXPEDITION.delveSecs = 45;

const world = new World(stubScene);
const sim = new Simulation(stubScene, world, { makeFighter, seed: SEED });
sim.spawn();
await Promise.all([
  import('../js/rpg/abilities/catalog.js').catch(() => {}),
  import('../js/rpg/abilities/generate.js').catch(() => {}),
]);
for (let k = 0; k < 5; k++) await Promise.resolve();

const records = [];     // one per member per expedition
const tracked = new Map(); // capId -> {members:[{a, snap}]}

function selfSustainPower(a) {
  let p = 0;
  if (a.abilities) for (const s of a.abilities.values()) {
    if (s.header && s.header.target === 'self') {
      for (const e of s.effects || []) if (e.op === 'heal' || e.op === 'shield') p += e.amount || 0;
    }
  }
  return p;
}
function alphaPower(a) {
  // max burst among held offensive specs (direct scan — cooldown-agnostic)
  let best = 0;
  if (a.abilities) for (const s of a.abilities.values()) {
    const tgt = s.header && s.header.target;
    if (tgt !== 'enemy' && tgt !== 'any') continue;
    let p = 0;
    for (const e of s.effects || []) if (e.op === 'damage') p += e.amount || 0;
    if (p > best) best = p;
  }
  return best;
}
const snap = (a) => ({
  name: a.name,
  potions: a.inventory.potion || 0,
  sustain: selfSustainPower(a),
  alpha: alphaPower(a),
  level: (a.progression && a.progression.totalLevel) || 0,
  risk: (a.personality && a.personality.risk_tolerance) || 0,
  explore: (a.progression && a.progression.behavior_profile && a.progression.behavior_profile.EXPLORE) || 0,
  kills0: (a.life && a.life.monsterKills) || 0,
});

const dt = 1 / 60;
const t0 = Date.now();
while (sim.time < 1800) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);

  for (const cap of (sim.expeditions && sim.expeditions.active) || []) {
    if (cap.expedition && !tracked.has(cap.id)) {
      tracked.set(cap.id, { members: cap.expedition.members.map((m) => ({ a: m, s: snap(m) })) });
    }
  }
  for (const [capId, rec] of tracked) {
    const cap = sim.agentsById.get(capId);
    if (!cap || !cap.expedition) {     // ended (or captain gone) — settle the books
      for (const { a, s } of rec.members) {
        records.push({ ...s, survived: !!(a && a.alive), kills: Math.max(0, (((a && a.life && a.life.monsterKills) || s.kills0) - s.kills0)) });
      }
      tracked.delete(capId);
    }
  }
}
console.log(`expeditions mounted=${sim.expeditions.stats.mounted} triumphs=${sim.expeditions.stats.triumphs} losses=${sim.expeditions.stats.losses} horrors slain=${sim.expeditions.stats.slain}`);
const S = records.filter((r) => r.survived), F = records.filter((r) => !r.survived);
const mean = (xs, k) => xs.length ? (xs.reduce((t, r) => t + r[k], 0) / xs.length) : 0;
console.log(`members tracked=${records.length}  survived=${S.length}  fell=${F.length}`);
for (const k of ['potions', 'sustain', 'alpha', 'level', 'risk', 'explore']) {
  console.log(`  ${k.padEnd(8)} survivors=${mean(S, k).toFixed(2)}  fallen=${mean(F, k).toFixed(2)}`);
}
const kills = records.slice().sort((a, b) => b.kills - a.kills).slice(0, 3);
console.log('top slayers:', kills.map((r) => `${r.name}(k=${r.kills},alpha=${r.alpha},sus=${r.sustain},pot=${r.potions})`).join('  '));
console.log(`(wall ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
