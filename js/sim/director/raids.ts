// DIRECTOR / RAIDS — the threat spawner: monster-faction raid waves (the difficulty
// curve AND anti-massacre valve), plus the WARLORD (faction-scale war) and NEMESIS
// (named recurring boss) escalations. Free functions over the Director instance `d`;
// the class keeps thin delegators so call sites are unchanged. Raiders carry ZERO
// gold — spawning a body never mints money (the soak's gold-conservation assertion).
import { Agent } from '../agent.js';
import { DIRECTOR, MONSTER } from '../simconfig.js';
import { ARENA_RADIUS, terrainHeight } from '../../arena.js';
import { TUNE } from '../../constants.js';
import { BEAT } from '../chronicle.js';
import { grantEpithet } from '../combatEvents.js';
import { rand, clamp } from './util.js';

// `d` is the Director (a thin STATE+ORCHESTRATION shell — director.ts) and `sim`/`a` are
// the Simulation/Agents it steers. All three carry a large freeform surface of ad-hoc
// drama fields (raider lists, war state, role flags) not worth a rigid shape; simulation.ts
// is a separate (wave-2) cluster still in .js. We type them opaquely on purpose (any) —
// behaviour is unchanged and fully guarded.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dir = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;

// A blank personality so a spawned body has the fields decide()/groups read,
// without importing the Simulation's private makePersonality. Mid-range, inert.
function flatPersonality() {
  return {
    risk_tolerance: rand(0.5, 0.8),
    social_drive:   0.4,
    ambition:       0.5,
    altruism:       0.3,
    curiosity:      0.4,
  };
}

// drop dead raiders, and WITHDRAW (despawn) any whose raid-wave TTL has elapsed —
// a raid is a transient WAVE, not a permanent siege. Withdrawing keeps the town
// from being ground out by an ever-accumulating besieging force and creates the
// LULLS that let it recover (the pulse). Raiders carry no gold, so removing them
// never touches conservation.
export function _pruneRaiders(d: Dir): void {
  if (!d._raiders.length) return;
  const now = d.sim.time;
  const keep = [];
  for (const a of d._raiders) {
    if (!a || !a.alive) continue;                       // fell in battle
    if (a._raidExpire != null && now >= a._raidExpire) { d._despawn(a); continue; }
    keep.push(a);
  }
  d._raiders = keep;
}

// remove a director-spawned body from the world (it has withdrawn). Pulled from
// the roster + scene so combat/perception stop seeing it. Gold-neutral by spawn.
export function _despawn(d: Dir, a: Ag): void {
  try {
    if (a.fighter) a.fighter.alive = false;             // NB: agent.alive is a getter — set the field
    if (a.fighter && a.fighter.root) d.sim.scene.remove(a.fighter.root);
    const i = d.sim.agents.indexOf(a);
    if (i >= 0) d.sim.agents.splice(i, 1);
    d.sim.agentsById.delete(a.id);
  } catch { /* never throw on the tick */ }
}

// a decimated town gets a true REPRIEVE: call off the raid entirely (withdraw
// every live raider) so the survivors can rebuild instead of being mopped up.
export function _withdrawAll(d: Dir): void {
  if (!d._raiders.length) return;
  const keep = [];
  for (const a of d._raiders) {
    if (a && a.alive && a.nemesis) { keep.push(a); continue; }   // a nemesis never withdraws
    if (a && a.alive) d._despawn(a);
  }
  d._raiders = keep;
}

// --- RAID: a small WAVE of monster-faction raiders near the town -----------
// Size scales with population; concurrent raiders are capped; lulls are enforced
// by DIRECTOR.raidCooldown so the town never faces a continuous swarm.
export function _raid(d: Dir, pop: number): void {
  const R = DIRECTOR.raid;
  const WAR = DIRECTOR.war || {};
  const atWar = !!(d._warlord && d._warlord.alive);   // raids INTENSIFY during a war
  // lull: don't stack raids back-to-back (shorter lull while at war).
  if (d.sim.time - d._lastRaidAt < R.cooldown * (atWar ? (WAR.cooldownMul || 0.65) : 1)) return;

  // population-scaled wave size: small towns get a token poke, large towns get a
  // bigger (but still bounded) wave. Below the cull floor we ease off entirely.
  if (pop < R.minPop) return;
  const scaled = Math.round((pop - R.minPop) * R.perTownsfolk) + R.baseSize;
  let want = clamp(scaled, R.baseSize, R.maxWave);
  if (atWar) want = Math.min(R.maxWave + (WAR.extraWave || 2), Math.ceil(want * (WAR.intensity || 1.4)));

  // honour the concurrency cap (raised while at war).
  const cap = R.maxConcurrent + (atWar ? (WAR.extraConcurrent || 3) : 0);
  const room = cap - d._raiders.length;
  want = Math.min(want, Math.max(0, room));
  // the BUDGET gates the wave size: only as many raiders as the banked points buy
  // (so a prosperous, long-quiet town funds a big wave; a bled one barely a poke).
  const PT = DIRECTOR.points || {};
  const perRaider = PT.raidPerRaider || 4;
  want = Math.min(want, Math.floor(d._points / perRaider));
  if (want <= 0) return;

  // spawn point: a ring just outside the town core so they "arrive" and advance.
  const ang = rand(0, Math.PI * 2);
  const dist = rand(R.spawnRingMin, R.spawnRingMax);
  const cx = Math.cos(ang) * dist, cz = Math.sin(ang) * dist;

  let spawned = 0;
  for (let i = 0; i < want; i++) {
    const a = d._spawnRaider(cx + rand(-4, 4), cz + rand(-4, 4));
    if (a) { d._raiders.push(a); spawned++; }
  }
  if (spawned > 0) {
    d.stats.raids++;
    d.stats.spawned += spawned;
    d._lastRaidAt = d.sim.time;
    d._sinceEvent = 0;
    d._points = Math.max(0, d._points - spawned * perRaider);   // pay for the wave
    // a wave raises the town's TENSION (the pacing layer; a peak earns a relief).
    const P = DIRECTOR.pacing || {};
    d._tension = Math.min(1, d._tension + (P.raidTension || 0.16) + spawned * 0.02);
  }
}

// build ONE monster-faction raider, reusing the makeFighter factory + Agent spawn
// pattern from simulation.js. CRITICAL: gold is forced to 0 so spawning a body
// never mints money (the soak's gold-conservation assertion must hold).
export function _spawnRaider(d: Dir, x: number, z: number): Ag {
  const sim = d.sim;
  const fighter = sim.makeFighter(MONSTER.model, {});
  const px = clamp(x, -ARENA_RADIUS * 0.97, ARENA_RADIUS * 0.97);
  const pz = clamp(z, -ARENA_RADIUS * 0.97, ARENA_RADIUS * 0.97);
  const py = typeof document === 'undefined' ? 0 : terrainHeight(px, pz);
  fighter.root.position.set(px, py, pz);
  sim.scene.add(fighter.root);
  const a = new Agent(fighter, {
    id: sim._nextId++, name: `Raider ${d.stats.spawned + 1}`,
    profession: null, personality: flatPersonality(),
    faction: MONSTER.faction, combatant: true, threat: MONSTER.threat,
  });
  a.gold = 0;                 // NO purse — spawning must not add gold to the loop
  for (const c in a.inventory) a.inventory[c] = 0;   // and carry no goods either
  // a slight speed edge so a raider can actually RUN DOWN a fleeing townsperson —
  // at equal speed it never catches anyone, which is why ordinary raids killed
  // nobody and the town had no stakes. The reprieve floor still prevents a spiral.
  a.speedMul = DIRECTOR.raid.raiderSpeedMul || 1;
  a._raidExpire = sim.time + (DIRECTOR.raid.raiderTTL ?? 32);   // withdraws when the wave ends
  sim.agents.push(a);
  sim.agentsById.set(a.id, a);
  return a;
}

// A RAID BOSS RISES (Nemesis) — promote a live raider to a named, persistent boss.
// The town defends so well that few raiders ever rack up the kills to earn a dread
// name organically, so the director anoints one: a singular recurring antagonist
// that won't withdraw and must be put down by a hero. One nemesis at a time.
export function _tropeNemesis(d: Dir): boolean {
  if (d.sim.agents.some((a: any) => a.alive && a.nemesis)) return false;   // a singular threat
  const cands = d._raiders.filter((a: any) => a && a.alive && !a.nemesis);
  if (!cands.length) return false;
  const boss = d._shuffle(cands)[0];
  grantEpithet(d.sim, boss, 'villain');
  return !!boss.nemesis;
}

// WAR (faction-scale) — a camp's chief rises as a named WARLORD and marches on the
// town: a persistent, un-leashed boss (reusing the nemesis machinery) while raids
// INTENSIFY (see _raid). The war is a saga arc with a clear end — it lasts until a
// hero brings the warlord down. One war at a time.
export function _tropeWar(d: Dir): boolean {
  if (d._warlord && d._warlord.alive) return false;
  const camps = d.sim.camps ? Object.keys(d.sim.camps).map((k) => d.sim.camps[k]) : [];
  const camp = d._shuffle(camps.filter((c) => c && c.leader && c.leader.alive && !c.leader.warlord))[0];
  if (!camp) return false;
  const L = camp.leader, W = DIRECTOR.war || {};
  const names = W.warlordNames || ['the Warlord'];
  const name = names[(L.id || 0) % names.length];
  const wasChief = L.name;
  L.warlord = true; L.nemesis = true;        // war state + persistent-boss machinery
  L.epithet = name; L.name = name;
  L.homeAnchor = null; L.leashR = 0;          // un-leashed: it marches on the town
  L._raidExpire = undefined;
  try {
    if (L.fighter) L.fighter.health = (TUNE.maxHealth || 100) * (W.hpMul || 3);
    L.threat = (L.threat || 1) * (W.threatMul || 1.5);
    L.speedMul = W.speedMul || 1.25;
  } catch { /* boosting best-effort */ }
  // the whole HOST marches: un-leash every camp member so they assault the town
  // alongside their warlord (a war is the camp on the move, not a lone chief who
  // suicides into the towers — that made wars flash by in seconds).
  d._warCamp = camp;
  for (const m of camp.members) {
    if (!m || !m.alive || m === L) continue;
    m._warHome = m.homeAnchor;
    m.homeAnchor = null; m.leashR = 0; m.atWar = true;
  }
  d._warlord = L;
  d._note(BEAT.LEGEND, L.id, `${wasChief} has risen as the warlord ${name} — war comes to the town.`);
  return true;
}
