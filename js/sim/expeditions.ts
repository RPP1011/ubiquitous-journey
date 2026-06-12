// ADVENTURING PARTIES — the expedition arc the town-bound drama was missing. A
// renowned captain rallies a brave company, marches OUT into the monster-haunted
// wilds, hunts, and returns — in triumph (foes slain, renown won) or broken (comrades
// lost). The DF-adventurer / M&B lineage, finally realised for NPCs.
//
// It reuses what already exists: the company is a warband (members band-follow the
// captain via the groups path), monsters lurk in the wilds (so "hunting" is just the
// band being THERE and the combatant AI doing its work), and the captain's movement
// is one new `expedition` goal (decide.js routes to it; act.js marches the body).
// This subsystem only forms/steers/resolves the arc. Gated on a real spawned town;
// guarded so it never throws on the fixed tick.

import * as THREE from 'three';
import { Agent } from './agent.js';
import { EXPEDITION, MONSTER } from './simconfig.js';
import { isHomeBuilder } from './construction.js';
import { ARENA_RADIUS } from '../arena.js';
import { TUNE } from '../constants.js';
import { rng } from './rng.js';
import { bus, makeEvent } from '../rpg/events.js';

// `sim` (the owning Simulation — wave-2, still .js) and the expedition Agents (captains +
// followers, via their expedition/band flags) are typed opaquely on purpose; behaviour
// is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;

const CORE = new THREE.Vector3(0, 0, 0);
const rand = (a: number, b: number): number => a + rng() * (b - a);
const HORROR_PERS = { risk_tolerance: 0.6, social_drive: 0.3, ambition: 0.5, altruism: 0.2, curiosity: 0.4 };

export class Expeditions {
  sim: Sim;
  _acc: number;
  _lastForm: number;
  active: Ag[];
  stats: Record<string, number>;
  _horrorSeq?: number;

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this._lastForm = -Infinity;
    this.active = [];                 // captains currently leading an expedition
    this.stats = { mounted: 0, triumphs: 0, losses: 0, slain: 0 };
  }

  tick(ctx: unknown, dt: number): void {
    try {
      if (!this.sim._spawned || !EXPEDITION || !EXPEDITION.enabled) return;
      this._acc += dt;
      if (this._acc < (EXPEDITION.tickEvery || 3)) return;
      this._acc = 0;
      this.active = this.active.filter((c) => c && c.expedition);   // drop ended ones
      for (const cap of this.active.slice()) this._advance(cap);
      this._maybeForm();
    } catch { /* never throw on the fixed tick */ }
  }

  _lvl(a: Ag): number { return (a && a.progression && a.progression.totalLevel) || 0; }
  _brave(a: Ag): boolean {
    return a && a.alive && a.autonomous && a.faction === 'townsfolk' && !a.watch && !a.reporter &&
      !a.inParty && a.expedition == null && a.expeditionOf == null && !isHomeBuilder(a) &&
      // PROVISIONED: the company marches on its stomach — no rations, no place in the line
      // (the seek_glory no-campaign-without-rations precedent, applied to the whole party).
      (a.inventory && (a.inventory.food || 0) >= (EXPEDITION.provisionFood || 0));
  }

  // raise a new company when one is warranted (off cooldown, under the cap, a worthy
  // captain + a couple of brave souls to follow).
  _maybeForm(): void {
    if (this.active.length >= (EXPEDITION.maxActive || 1)) return;
    const now = this.sim.time;
    if (now - this._lastForm < (EXPEDITION.formEvery || 90)) return;
    if (rng() > (EXPEDITION.formChance ?? 0.5)) return;
    // don't drain a struggling town — a company is only mustered when there are folk to spare.
    const townPop = this.sim.agents.filter((a: any) => a.alive && a.autonomous && a.faction === 'townsfolk').length;
    if (townPop < (EXPEDITION.minTownPop || 18)) return;

    const pool = this.sim.agents.filter((a: any) => this._brave(a));
    // a captain of some renown (level), ideally already a fighter/hero.
    const captains = pool.filter((a: any) => this._lvl(a) >= (EXPEDITION.captainMinLevel || 5) &&
      (a.combatant || a.epithet || (a.personality && a.personality.risk_tolerance >= (EXPEDITION.recruitRisk || 0.5))))
      .sort((x: any, y: any) => this._lvl(y) - this._lvl(x));
    const cap = captains[0];
    if (!cap) return;

    // FELLOWSHIP, not mercenary company: followers are chosen by BOND to the captain
    // (mutual regard + mate/kin/master/groupmate), not by proximity-and-courage. A
    // strongly-bonded soul comes even if TIMID (bond.override waives the courage gate
    // — "for Frodo"; the provision gate never waives — somebody packs the pots).
    const want = Math.max(1, (EXPEDITION.partySize || 3) - 1);
    const B = EXPEDITION.bond || {};
    const followers = pool.filter((a: any) => a !== cap && a.personality &&
        (a.personality.risk_tolerance >= (EXPEDITION.recruitRisk || 0.5) ||
         this._bondTo(a, cap) >= (B.override ?? 0.5)))
      .sort((x: any, y: any) => this._bondTo(y, cap) - this._bondTo(x, cap))
      .slice(0, want);
    if (!followers.length) return;

    this._form(cap, followers);
  }

  _form(cap: Ag, followers: Ag[]): void {
    const members = [cap, ...followers];
    cap.expedition = { phase: 'out', members, startedAt: this.sim.time, killsAt0: this._killCount(members) };
    // make the followers a marching company (band-follow the captain — the warband path).
    let slot = 0;
    for (const f of followers) {
      f._expRestore = { combatant: f.combatant, canWork: f.canWork, goal: f.goal, bandLeaderId: f.bandLeaderId, inParty: f.inParty, groupType: f.groupType };
      f.expeditionOf = cap.id;
      f.bandLeaderId = cap.id; f.inParty = true; f.combatant = true; f.groupType = 'warband';
      f.partySlot = slot++;
      f.goal = { kind: 'follow' };
    }
    cap._expRestore = { combatant: cap.combatant, canWork: cap.canWork };
    cap.combatant = true;            // the captain leads from the front

    this.active.push(cap);
    this.stats.mounted++;
    this._lastForm = this.sim.time;

    const who = cap.name + (followers.length ? ` and ${followers.length} companion${followers.length > 1 ? 's' : ''}` : '');
    cap.expedition.who = who;
    // EXPLORE fold marks: distance marched on expedition becomes EXPLORE deeds (per member).
    cap.expedition.distMark = new Map(members.map((m: Ag) => [m.id, (m.life && m.life.dist) || 0]));
    // choose the adventure — and MARCH there either way (the journey is real; the old
    // delve teleport skipped it). A delve party heads for a MOUTH of the deep on the
    // outer ring and only descends on arrival.
    const delvePlanned = rng() < (EXPEDITION.delveChance ?? 0.7);
    const ang = rng() * Math.PI * 2;
    const r = ARENA_RADIUS * (delvePlanned ? (EXPEDITION.delveRing || 0.55) : (EXPEDITION.targetRing || 0.78));
    cap.expedition.target = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
    cap.expedition.delvePlanned = delvePlanned;
    this._note(delvePlanned
      ? `${who} set out for a mouth of the deep.`
      : `${who} set out on an expedition into the wilds.`);
  }

  // DELVE — descend the party into an isolated underground pocket and loose the
  // horrors of the deep on them. They hold and fight there; the dark is far below
  // everything else, so it's isolated by distance (the dungeon spatial trick).
  _descend(cap: Ag, who: string): void {
    const E = cap.expedition;
    E.mouth = (E.target && E.target.clone) ? E.target.clone() : null;   // where the survivors climb out
    E.delve = true; E.phase = 'delve';
    E.horrorIds = [];
    const Y = EXPEDITION.delveDepth || -900;
    E.target = new THREE.Vector3(0, Y, 0);              // they hold at the pocket's heart
    for (const m of E.members) {
      if (!m || !m.alive) continue;
      m.fighter.root.position.set(rand(-3, 3), Y, rand(-3, 3));
      m._underground = true;                            // pinned at depth (groundY respects this)
    }
    const n = EXPEDITION.delveMonsters || 5;
    for (let i = 0; i < n; i++) {
      const h = this._spawnHorror(rand(-14, 14), Y, rand(-14, 14));
      if (h) E.horrorIds.push(h.id);
    }
    E.delveUntil = this.sim.time + (EXPEDITION.delveSecs || 60);
    this.stats.delves = (this.stats.delves || 0) + 1;
    this._note(`${who} descended into the dark of the deep.`);
  }

  // one HORROR of the deep — a tougher monster-faction body, gold-neutral (no minting),
  // pinned at the delve depth.
  _spawnHorror(x: number, y: number, z: number): Ag {
    const sim = this.sim;
    const f = sim.makeFighter(MONSTER.model, {});
    f.root.position.set(x, y, z);
    sim.scene.add(f.root);
    this._horrorSeq = (this._horrorSeq || 0) + 1;
    const a = new Agent(f, {
      id: sim._nextId++, name: `a horror of the deep`, profession: null,
      personality: { ...HORROR_PERS }, faction: MONSTER.faction,
      combatant: true, threat: MONSTER.threat * (EXPEDITION.monsterThreatMul || 1.3),
    });
    a.gold = 0; for (const c in a.inventory) a.inventory[c] = 0;
    a._underground = true;
    try { if (a.fighter) a.fighter.health = (TUNE.maxHealth || 100) * (EXPEDITION.monsterHpMul || 1.6); } catch { /* */ }
    sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  }

  _despawnHorror(h: Ag): void {
    try {
      if (!h) return;
      if (h.fighter) h.fighter.alive = false;   // NB: agent.alive is a getter — set the field
      if (h.fighter && h.fighter.root) this.sim.scene.remove(h.fighter.root);
      const i = this.sim.agents.indexOf(h);
      if (i >= 0) this.sim.agents.splice(i, 1);
      this.sim.agentsById.delete(h.id);
    } catch { /* */ }
  }

  _killCount(members: Ag[]): number {
    let n = 0;
    for (const m of members) n += (m && m.life && m.life.monsterKills) || 0;
    return n;
  }

  _advance(cap: Ag): void {
    const E = cap.expedition;
    if (!E) return;
    this._foldExplore(E);                 // distance marched -> EXPLORE deeds (all phases)
    if (E.delve) { this._advanceDelve(cap); return; }
    // the captain fell — a doomed expedition (resolved from the survivors' side).
    if (!cap.alive) { this._end(cap, 'captainLost'); return; }
    const now = this.sim.time;

    if (E.phase === 'out') {
      if (cap.pos.distanceTo(E.target) < 14) {
        if (E.delvePlanned) { E.delvePlanned = false; this._descend(cap, E.who || cap.name); return; }
        E.phase = 'hunt'; E.huntUntil = now + (EXPEDITION.huntSecs || 60);
      }
      return;
    }
    if (E.phase === 'hunt') {
      const lost = E.members.filter((m: any) => m && !m.alive).length;
      if (now >= (E.huntUntil || 0) || lost > 0) { E.phase = 'return'; E.target = CORE; }
      return;
    }
    if (E.phase === 'return') {
      if (cap.pos.distanceTo(CORE) < 20) this._end(cap, 'home');
    }
  }

  // the delve runs until the deep is CLEARED, time runs out, the party is wiped — or the
  // CAPTAIN CALLS THE RETREAT: losses past retreatBelow, or his own blood past retreatHp.
  // "None climbed back into the light" is now a decision that failed, not a timer.
  _advanceDelve(cap: Ag): void {
    const E = cap.expedition;
    const now = this.sim.time;
    const total = (E.members || []).length || 1;
    const alive = E.members.filter((m: any) => m && m.alive);
    const aliveMembers = alive.length;
    const horrorsLeft = (E.horrorIds || []).filter((id: any) => { const h = this.sim.agentsById.get(id); return h && h.alive; }).length;
    // THE CAPTAIN READS HIS COMPANY, not his own wounds (the probe's inversion lesson: a
    // retreat bell keyed to the captain's hp is SILENCED by his own sustain — self-healing
    // captains pressed on while their parties died, and "weak enough to bail early" became
    // the survival meta). Retreat on FIRST BLOOD (aliveFrac < retreatBelow) or when the
    // PARTY's mean blood runs low (retreatHp on the company, captain included).
    const maxH = TUNE.maxHealth || 100;
    let meanHp = 0;
    for (const m of alive) meanHp += (m.fighter ? m.fighter.health : 0) / maxH;
    meanHp = aliveMembers ? meanHp / aliveMembers : 0;
    // LOYALTY HOLDS THE LINE: a devoted captain (altruism × bonds) does not turn at first
    // blood — only the company's blood (meanHp) turns him. The deliberate un-optimality.
    const firstBlood = (aliveMembers / total) < (EXPEDITION.retreatBelow || 0.99);
    const loyal = cap.alive && this._loyalty(cap, alive) >= (EXPEDITION.loyaltyHold ?? 0.6);
    if (firstBlood && loyal && horrorsLeft > 0 && !E.loyalNoted) {
      E.loyalNoted = true;
      const fallenOne = E.members.find((m: any) => m && !m.alive);
      this._note(`${cap.name} would not leave the dark while ${(fallenOne && fallenOne.name) || 'the fallen'} lay there.`);
    }
    const retreat = aliveMembers > 0 && horrorsLeft > 0 &&
      ((firstBlood && !loyal) || meanHp < (EXPEDITION.retreatHp || 0.4));
    if (retreat) {
      this.stats.retreats = (this.stats.retreats || 0) + 1;
      E.retreated = true;
    }
    if (horrorsLeft === 0 || now >= (E.delveUntil || 0) || aliveMembers === 0 || retreat) {
      this._endDelve(cap, horrorsLeft === 0);
    }
  }

  _endDelve(cap: Ag, cleared: boolean): void {
    const E = cap.expedition;
    if (!E) return;
    const members = E.members;
    const survivors = members.filter((m: any) => m && m.alive);
    const fallen = members.filter((m: any) => m && !m.alive);
    const kills = Math.max(0, this._killCount(survivors) - (E.killsAt0 || 0));
    this.stats.slain += kills;
    // the survivors CLIMB OUT AT THE MOUTH and must still MARCH HOME (the return leg is
    // real — a company can win its relic below and lose someone on the road back).
    const mouth = E.mouth || CORE;
    for (const m of survivors) { m.fighter.root.position.set(mouth.x + rand(-3, 3), 0, mouth.z + rand(-3, 3)); m._underground = false; }
    for (const m of fallen) { m._underground = false; }
    // any horrors still lurking crawl back into the dark (despawn — gold-neutral anyway).
    for (const id of (E.horrorIds || [])) this._despawnHorror(this.sim.agentsById.get(id));

    if (!survivors.length) {
      // a wiped company resolves below — nothing climbs out.
      for (const m of members) this._restore(m);
      cap.expedition = null;
      this.active = this.active.filter((c) => c !== cap);
    } else {
      // the tale of the DEEP is told at the mouth; the homeward leg resolves at _end('home')
      // (E.resolved keeps it from double-counting the stats there).
      E.delve = false; E.resolved = true; E.phase = 'return';
      E.target = CORE.clone ? CORE.clone() : CORE;
    }

    if (!survivors.length) {
      this.stats.losses++;
      this._note(`${cap.name}'s company was swallowed by the dark — none climbed back into the light.`);
    } else if (fallen.length) {
      this.stats.losses++;
      const names = fallen.map((m: any) => m.name).join(' and ');
      this._note(E.retreated
        ? `${cap.name} called the retreat — ${kills} horror${kills === 1 ? '' : 's'} slain, but the deep keeps ${names}.`
        : `${cap.name}'s company climbs back from the deep, ${kills} horror${kills === 1 ? '' : 's'} slain — but ${names} was left below.`);
    } else if (E.retreated) {
      this.stats.losses++;
      this._note(`${cap.name} called the retreat — the company climbs back whole, the deep unconquered.`);
    } else {
      this.stats.triumphs++;
      const relic = cleared && rng() < (EXPEDITION.relicChance ?? 0.6);
      if (relic) {
        try { for (const m of survivors) if (m.progression) m.progression.addNarrativeXP(0.8, this.sim.time); } catch { /* */ }
        try { cap.relics = (cap.relics || 0) + 1; } catch { /* */ }
        this.stats.relics = (this.stats.relics || 0) + 1;
        this._note(`${cap.name}'s company returns from the deep bearing a relic, ${kills} horror${kills === 1 ? '' : 's'} slain.`);
      } else {
        this._note(`${cap.name}'s company returns from the deep, ${kills} horror${kills === 1 ? '' : 's'} slain.`);
      }
    }
  }

  _end(cap: Ag, how: string): void {
    const E = cap.expedition;
    if (!E) return;
    const members = E.members || [cap];
    const survivors = members.filter((m: any) => m && m.alive);
    const fallen = members.filter((m: any) => m && !m.alive);

    // a RESOLVED delve marching home: the deep's tale was told at the mouth (_endDelve)
    // — the homeward arrival just disbands (no double-counted stats, a quiet beat).
    if (E.resolved) {
      if (how === 'home') this._forgeComrades(members);
      for (const m of members) this._restore(m);
      cap.expedition = null;
      this.active = this.active.filter((c) => c !== cap);
      if (how === 'home') this._note(`${cap.name}'s company is home from the deep.`);
      else { this.stats.losses++; this._note(`${cap.name} fell on the road home from the deep.`); }
      return;
    }
    const kills = Math.max(0, this._killCount(survivors) - (E.killsAt0 || 0));
    this.stats.slain += kills;

    // shared peril forges bonds among those who made it home together.
    if (how === 'home' && survivors.length >= 2) this._forgeComrades(members);
    // restore every survivor to civilian life.
    for (const m of members) this._restore(m);
    cap.expedition = null;
    this.active = this.active.filter((c) => c !== cap);

    // tell the tale.
    if (how === 'captainLost' || survivors.length === 0) {
      this.stats.losses++;
      this._note(`The expedition is lost — ${cap.name}'s company did not return from the wilds.`);
    } else if (fallen.length) {
      this.stats.losses++;
      const names = fallen.map((m: any) => m.name).join(' and ');
      this._note(`${cap.name}'s company returns from the wilds, ${kills} foe${kills === 1 ? '' : 's'} slain — but ${names} did not come home.`);
    } else if (kills > 0) {
      this.stats.triumphs++;
      this._note(`${cap.name}'s company returns in triumph, ${kills} foe${kills === 1 ? '' : 's'} slain in the wilds.`);
    } else {
      this._note(`${cap.name}'s company returns from the wilds, finding them quiet this time.`);
    }
  }

  _restore(m: Ag): void {
    if (!m) return;
    const r = m._expRestore;
    if (r) {
      if ('bandLeaderId' in r) { m.bandLeaderId = null; m.inParty = false; m.groupType = null; }   // a follower
      m.combatant = r.combatant; m.canWork = r.canWork;
      m._expRestore = null;
    }
    m.expeditionOf = null;
  }

  // the BOND between a soul and its captain: mutual standing (mean of each one's regard
  // for the other) plus the structural ties — mate, kin, master/apprentice, named-group
  // mate. Belief/own-state reads only (the gossip-warmed fabric IS the fellowship substrate).
  _bondTo(a: Ag, cap: Ag): number {
    try {
      if (!a || !cap) return 0;
      const B = EXPEDITION.bond || {};
      const mine = a.beliefs && a.beliefs.get(cap.id);
      const theirs = cap.beliefs && cap.beliefs.get(a.id);
      let bond = (((mine && mine.standing) || 0) + ((theirs && theirs.standing) || 0)) / 2;
      if (a.mateId === cap.id || cap.mateId === a.id) bond += B.mate ?? 0.8;
      else if ((Array.isArray(a.kinIds) && a.kinIds.includes(cap.id)) ||
               (Array.isArray(cap.kinIds) && cap.kinIds.includes(a.id))) bond += B.kin ?? 0.6;
      else if (a.masterId === cap.id || cap.masterId === a.id) bond += B.master ?? 0.5;
      else if (a.groupName && a.groupName === cap.groupName) bond += B.groupmate ?? 0.4;
      return Math.max(0, Math.min(1.5, bond));
    } catch { return 0; }
  }

  // the captain's LOYALTY to his living company: altruism × mean bond. At/above
  // loyaltyHold he does not turn at first blood — devotion holds the line (and
  // sometimes pays for it; the chronicle says so either way).
  _loyalty(cap: Ag, alive: Ag[]): number {
    try {
      if (!cap || !cap.personality || !alive.length) return 0;
      let mean = 0;
      for (const m of alive) if (m !== cap) mean += this._bondTo(cap, m);
      const others = Math.max(1, alive.length - 1);
      return Math.max(0, Math.min(1, (cap.personality.altruism || 0) * (mean / others) * 2));
    } catch { return 0; }
  }

  // SHARED PERIL FORGES BONDS: survivors who march home together warm toward each other
  // (pairwise standing) and remember it ('comrade' bond, salience BELOW the LTM bar — the
  // bond-crowding lesson). The group machinery then finds them: we don't mint a named
  // fellowship, we make one likely to emerge.
  _forgeComrades(members: Ag[]): void {
    try {
      const warm = EXPEDITION.comradeWarm ?? 0.12;
      const alive = (members || []).filter((m: any) => m && m.alive);
      if (alive.length < 2) return;
      for (const m of alive) {
        for (const o of alive) {
          if (m === o || !m.beliefs || !m.beliefs._ensure) continue;
          const b = m.beliefs._ensure(o.id);
          if (b) b.standing = Math.max(-1, Math.min(1, (b.standing || 0) + warm));
        }
        if (m.memory && typeof m.memory.record === 'function') {
          try { m.memory.record({ t: this.sim.time, kind: 'bond', withId: alive.find((o: Ag) => o !== m)?.id, rel: 'comrade', valence: 1, salience: 0.55 }); } catch { /* */ }
        }
      }
    } catch { /* never throw on the tick */ }
  }

  // DISTANCE MARCHED -> EXPLORE deeds: every exploreDeedDist metres a living member has
  // walked since the last fold emits one EXPLORE deed (the emitter the explorer identity
  // was missing — nothing in the sim folded EXPLORE before this). life.dist is the
  // existing odometer; the per-member mark map keeps the fold incremental + bounded.
  _foldExplore(E: Ag): void {
    try {
      if (!E || !E.distMark) return;
      const per = EXPEDITION.exploreDeedDist || 40;
      for (const m of E.members || []) {
        if (!m || !m.alive || !m.life) continue;
        const mark = E.distMark.get(m.id) ?? m.life.dist;
        let walked = (m.life.dist || 0) - mark;
        let deeds = 0;
        while (walked >= per && deeds < 4) { walked -= per; deeds++; }   // bounded per pass
        if (deeds > 0) {
          E.distMark.set(m.id, (m.life.dist || 0) - walked);
          for (let i = 0; i < deeds; i++) {
            bus.emit(makeEvent({ actorId: m.id, verb: 'explore', tags: ['EXPLORE'], magnitude: 1, t: this.sim.time }));
          }
        }
      }
    } catch { /* never throw on the tick */ }
  }

  _note(text: string): void { try { if (this.sim.chronicle && this.sim.chronicle.note) this.sim.chronicle.note('legend', -15, text); } catch { /* */ } }

  // teardown: dissolve any company (despawn its horrors, surface + restore members).
  disband(): void {
    for (const cap of this.active.slice()) {
      const E = cap.expedition;
      if (E) {
        for (const id of (E.horrorIds || [])) this._despawnHorror(this.sim.agentsById.get(id));
        for (const m of E.members) { if (m) m._underground = false; this._restore(m); }
      }
      cap.expedition = null;
    }
    this.active = [];
  }
}
