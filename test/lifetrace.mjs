// LIFE TRACE — drive the WHOLE sim headless for N sim-seconds (default 1800 = 30 min sim-time) and
// follow ONE chosen agent: log every goal transition (its lived action timeline), then dump its
// biography — class, ambition, deeds, oaths, perils, the narrative ARCS it was a principal in, its
// memory, its strongest relationships, and the chronicle beats that named it. Read-only over the sim.
//
//   bun test/lifetrace.mjs [simSeconds]
//
import { makeOk, stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { memoryPhrase } from '../js/sim/memory.js';
import { deedLedger, oaths, perilsSurvived, goldTrend, streakOf, arcLoad } from '../js/sim/signals.js';

const SIM_SECONDS = Number(process.argv[2]) || 1800;
const dt = 1 / 60;

const world = new World(stubScene);
const sim = new Simulation(stubScene, world, { makeFighter });
sim.spawn();
const pf = makeFighter('knight', { isPlayer: true });
pf.root.position.set(0, 0, 8);
sim.addPlayer(pf);
// let Progression's lazy ability imports settle (same as the soak).
await Promise.all([
  import('../js/rpg/abilities/catalog.js').catch(() => {}),
  import('../js/rpg/abilities/generate.js').catch(() => {}),
  import('../js/rpg/abilities/ir.js').catch(() => {}),
]);
for (let k = 0; k < 5; k++) await Promise.resolve();

// pick our protagonist: an autonomous townsperson WITH a profession (a real economic + social life),
// preferring one near the town core so it's in the thick of things.
const withTrade = sim.agents.filter((a) => !a.controlled && a.alive && a.faction === 'townsfolk' && a.profession);
const anyTown = sim.agents.filter((a) => !a.controlled && a.alive && a.faction === 'townsfolk');
const pool = withTrade.length ? withTrade : anyTown;
const hero = pool[Math.floor(pool.length / 2)] || sim.agents.find((a) => !a.controlled && a.alive);
const heroId = hero.id;
const name0 = hero.name;
console.log(`\n=== TRACING: ${name0} (#${heroId}, ${hero.faction}, trade=${hero._trade || 'emergent'}) over ${SIM_SECONDS} sim-seconds ===\n`);

const goldTotal = () => sim.agents.reduce((s, a) => s + (a.gold || 0) + (a.stash || 0), 0);
const gold0 = goldTotal();

// --- the action timeline: record goal transitions + a few periodic state snapshots --------------
const timeline = [];   // { t, goal, pos, gold, hp }
let lastGoal = null, lastKills = 0, lastClasses = 0, diedAt = null;
const milestones = [];  // notable life events (class gained, kill, first deed, etc.)

// TOWN-WIDE narrative production: the _closed ring is small + churns, so count arcs as they close
// (by kind+outcome) across the WHOLE run — the keystone "are stories being produced" metric.
const arcsSeen = new Set();
const arcTally = {};
const heroArcs = [];   // every arc our hero was a principal in, captured before the ring evicts it

const t0 = Date.now();
let frame = 0;
while (sim.time < SIM_SECONDS) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);
  frame++;
  // sweep the closed ring for arcs we haven't tallied yet (before they age out of the 64-cap ring)
  for (const arc of sim.sagas._closed) {
    if (arcsSeen.has(arc.arcId)) continue;
    arcsSeen.add(arc.arcId);
    const k = `${arc.kind}:${arc.outcome}`;
    arcTally[k] = (arcTally[k] || 0) + 1;
    if (arc.principals && arc.principals.indexOf(heroId) !== -1) heroArcs.push(`${arc.kind}[${arc.outcome}] @${(arc.closedAt || 0).toFixed(0)}s`);
  }

  const a = sim.agentsById.get(heroId);
  if (a && a.alive) {
    const gk = a.goal ? a.goal.kind : 'idle';
    if (gk !== lastGoal) {
      timeline.push({ t: +sim.time.toFixed(0), goal: gk, gold: Math.round(a.gold || 0), hp: Math.round(a.fighter ? a.fighter.health : 0) });
      lastGoal = gk;
    }
    // milestones: a new class, a fresh kill
    const nClasses = a.progression && a.progression.classes ? a.progression.classes.size : 0;
    if (nClasses > lastClasses) {
      const cls = a.progression.primaryClass && a.progression.primaryClass();
      milestones.push(`[${sim.time.toFixed(0)}s] became a ${(cls && cls.name) || 'new class'}`);
      lastClasses = nClasses;
    }
    const k = a.life ? a.life.kills : 0;
    if (k > lastKills) { milestones.push(`[${sim.time.toFixed(0)}s] slew someone (kill #${k})`); lastKills = k; }
  } else if (a && !a.alive && diedAt == null) {
    diedAt = +sim.time.toFixed(0);
    milestones.push(`[${diedAt}s] *** DIED ***`);
  }
  // progress ping every ~300 sim-seconds
  if (frame % 18000 === 0) console.log(`  …${sim.time.toFixed(0)}s (wall ${(Date.now() - t0) / 1000 | 0}s, agents=${sim.agents.length})`);
}
const wall = ((Date.now() - t0) / 1000).toFixed(1);

// ============================ THE BIOGRAPHY ============================
const a = sim.agentsById.get(heroId);
const nameOf = (id) => { const x = sim.agentsById.get(id); return (x && x.name) || `#${id}`; };
console.log(`\n=============== BIOGRAPHY: ${name0} ===============`);
console.log(`ran ${frame} frames to ${sim.time.toFixed(0)}s in ${wall}s wall  ·  gold conserved: ${gold0.toFixed(0)} -> ${goldTotal().toFixed(0)}`);
console.log(`status: ${a ? (a.alive ? 'ALIVE' : `DIED at ${diedAt}s`) : 'GONE (despawned)'}`);

if (a) {
  // identity
  const cls = a.progression && a.progression.primaryClass && a.progression.primaryClass();
  const classes = a.progression && a.progression.classes ? [...a.progression.classes.values()].map((c) => `${c.name} L${c.level}`) : [];
  console.log(`\n— IDENTITY —`);
  console.log(`  trade (current good): ${a._trade || '—'}   classes: ${classes.join(', ') || '—'}   totalLevel: ${a.progression ? a.progression.totalLevel : 0}`);
  console.log(`  ambition: ${a.ambition ? a.ambition.label : '—'} (${Math.round((a.ambition && a.ambition.progress || 0) * 100)}%)`);
  console.log(`  gold: ${Math.round(a.gold || 0)}   kills: ${a.life ? a.life.kills : 0}   notoriety: ${(a.notoriety || 0).toFixed(2)}   house: ${a.house || '—'}`);
  const tr = goldTrend(a);
  console.log(`  goldFast/Slow: ${tr.fast.toFixed(0)}/${tr.slow.toFixed(0)}   perilsSurvived: ${perilsSurvived(a)}`);

  // deeds + oaths (the catalog signals)
  console.log(`\n— DEEDS (deedLedger) —`);
  const deeds = deedLedger(a);
  const dk = Object.keys(deeds);
  console.log(dk.length ? dk.map((t) => `  ${t}: ${deeds[t].n}  (first ${deeds[t].first.toFixed(0)}s, last ${deeds[t].last.toFixed(0)}s)`).join('\n') : '  (none recorded)');
  console.log(`\n— OATHS (kept vs abandoned) —`);
  const o = oaths(a);
  const ok2 = Object.keys(o);
  console.log(ok2.length ? ok2.map((k) => `  ${k}: sworn ${o[k].sworn}, kept ${o[k].kept}, abandoned ${o[k].abandoned}`).join('\n') : '  (swore no narrative oaths)');

  // the narrative ARCS this soul was a principal in (open + closed)
  console.log(`\n— ARCS (sim.sagas — the stories they were IN) —`);
  const closed = sim.sagas._closed.filter((arc) => arc.principals && arc.principals.indexOf(heroId) !== -1);
  const open = [...sim.sagas._open.values()].filter((arc) => arc.principals && arc.principals.indexOf(heroId) !== -1);
  if (!closed.length && !open.length) console.log('  (was not a principal in any tracked arc)');
  for (const arc of closed) console.log(`  CLOSED ${arc.kind} [${arc.outcome}] rounds=${arc.rounds} principals=[${arc.principals.map(nameOf).join(', ')}]`);
  for (const arc of open) console.log(`  OPEN   ${arc.kind} rounds=${arc.rounds} principals=[${arc.principals.map(nameOf).join(', ')}]`);
  console.log(`  arcLoad now: ${arcLoad(sim, a)}`);

  // strongest relationships (its own beliefs, by |standing|)
  console.log(`\n— RELATIONSHIPS (its strongest opinions) —`);
  const rels = Array.from(a.beliefs && a.beliefs.all ? a.beliefs.all() : [])
    .filter((b) => b && Math.abs(b.standing || 0) > 0.15)
    .sort((x, y) => Math.abs(y.standing) - Math.abs(x.standing)).slice(0, 8);
  console.log(rels.length ? rels.map((b) => `  ${b.standing > 0 ? '(+)' : '(-)'} ${nameOf(b.subjectId)}: standing ${b.standing.toFixed(2)}${b.hostile ? ' HOSTILE' : ''}${b.suspicion > 0.3 ? ` suspicion ${b.suspicion.toFixed(2)}` : ''}`).join('\n') : '  (no strong opinions formed)');

  // memory — the autobiography (LTM, most salient)
  console.log(`\n— MEMORY (long-term, most salient) —`);
  const eps = a.memory ? [...a.memory.ltm.items(), ...a.memory.mtm.items()].sort((x, y) => (y.salience || 0) - (x.salience || 0)).slice(0, 10) : [];
  console.log(eps.length ? eps.map((e) => `  [${(e.t || 0).toFixed(0)}s] ${memoryPhrase(e, nameOf)} (sal ${(e.salience || 0).toFixed(2)})`).join('\n') : '  (remembers nothing formative)');
}

// chronicle beats that named our hero
console.log(`\n— CHRONICLE BEATS naming ${name0} —`);
const beats = (sim.chronicle.recent(400) || []).filter((b) => b.text && b.text.includes(name0));
console.log(beats.length ? beats.reverse().map((b) => `  [${(b.t || 0).toFixed(0)}s] ${b.text}`).join('\n') : '  (the chronicle never named them)');

// the action timeline (goal transitions)
console.log(`\n— ACTION TIMELINE (goal transitions: ${timeline.length}) —`);
console.log(timeline.map((s) => `  [${s.t}s] ${s.goal}  (gold ${s.gold}, hp ${s.hp})`).join('\n'));

// a compact tally of how its time was spent
const dur = {};
for (let i = 0; i < timeline.length; i++) {
  const end = i + 1 < timeline.length ? timeline[i + 1].t : Math.min(SIM_SECONDS, diedAt || SIM_SECONDS);
  dur[timeline[i].goal] = (dur[timeline[i].goal] || 0) + (end - timeline[i].t);
}
console.log(`\n— TIME BUDGET (sim-seconds per goal) —`);
console.log(Object.entries(dur).sort((a, b) => b[1] - a[1]).map(([g, s]) => `  ${g}: ${s}s`).join('\n'));

console.log(`\n— LIFE MILESTONES —`);
console.log(milestones.length ? milestones.map((m) => '  ' + m).join('\n') : '  (an uneventful life)');

console.log(`\n— HERO'S ARCS (captured before ring-eviction) —`);
console.log(heroArcs.length ? '  ' + heroArcs.join('\n  ') : '  (was a principal in NO completed arc all run)');

console.log(`\n=============== TOWN-WIDE NARRATIVE PRODUCTION (whole run) ===============`);
console.log(`  total completed arcs: ${arcsSeen.size}   (final pop ${sim.agents.length})`);
const entries = Object.entries(arcTally).sort((a, b) => b[1] - a[1]);
console.log(entries.length ? entries.map(([k, n]) => `  ${k}: ${n}`).join('\n') : '  (NO arcs closed all run — the keystone metric is 0)');
// how many townsfolk swore avenge oaths, and the total churn (a health check on the oaths signal)
let oathSworn = 0, oathKept = 0, agentsWithOaths = 0;
for (const ag of sim.agents) {
  const o = ag._oaths; if (!o) continue;
  let any = false;
  for (const k in o) { oathSworn += o[k].sworn; oathKept += o[k].kept; any = true; }
  if (any) agentsWithOaths++;
}
console.log(`  oaths town-wide: ${oathSworn} sworn / ${oathKept} kept across ${agentsWithOaths} agents  (mean ${(oathSworn / Math.max(1, agentsWithOaths)).toFixed(0)} sworn/agent — a health check)`);
console.log('');
sim.dispose();
