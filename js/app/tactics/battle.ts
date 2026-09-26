// A TACTICAL BATTLE on a BattleMap (XCOM / Fire Emblem / FFT / Wildermyth lineage), with the
// town's people in it.
//
// Turn structure: rounds; each round every standing unit takes ONE turn in initiative order
// (speed from Finesse — allies and foes interleave, FFT-style). A turn is MOVE (up to the
// unit's move range, pathfound over heights) + one ACTION, or a DASH (a second move).
// Ending a turn sets FACING; blows from the flank/back land easier and harder.
//
// Reactions: leaving a foe's reach draws an OPPORTUNITY strike; OVERWATCH fires on the first
// foe that moves into reach.
//
// The ENVIRONMENT is systemic: fire spreads across grass, hay, oil and wood each round and
// sets people alight; water douses; a shove sends a body (or a barrel) sliding into fire, off
// a ledge, or into someone else; a kicked brazier spills coals; a thrown flour sack blinds.
//
// People stay people: every wound is folded through the engine's combat fold (witnesses,
// reputation, vendettas, XP), bluffs plant beliefs that outlive the battle, morale breaks,
// the player's side goes DOWN (death saves) rather than dying while a friend stands.

import { TUNE } from '../../constants.js';
import { rng } from '../../sim/rng.js';
import { EFFECTS } from '../../rpg/abilities/effects.js';
import type { Agent } from '../../../types/sim.js';
import type { Session } from '../session.js';
import { check, chance, sheetOf, type Sheet, type Stat } from '../combat/rules.js';
import { objectiveOf, type Objective } from '../combat/objectives.js';
import { BattleMap, DIRS, JUMP, FALL_SAFE, TILE, key, type Prop, type Tile } from './map.js';

export type Side = 'us' | 'them';
export type Role = 'player' | 'companion' | 'ally' | 'foe';
export type Out = null | 'downed' | 'dead' | 'fled' | 'yielded' | 'captured';
export type Outcome = 'victory' | 'defeat' | 'escaped' | 'truce' | 'arrested' | 'overpowered' | 'timeout';

/** How a unit fights (drives AI positioning and choices). */
export type Tactic = 'brute' | 'archer' | 'skirmisher' | 'leader' | 'beast' | 'guardian' | 'healer' | 'rogue' | 'civilian';

/** A companion's developing temperament (0..1), read by the AI. */
export interface Traits { bravery: number; compassion: number; loyalty: number; ruthlessness: number; }

/** A structured record of what happened — fuel for companion growth and hub gossip. */
export interface BattleEvent {
  round: number;
  kind: 'hit' | 'kill' | 'down' | 'revive' | 'flee' | 'escape' | 'ignite' | 'burned' | 'shove' | 'hazard' | 'social' | 'bluffed'
    | 'grab' | 'yield' | 'parley' | 'heal' | 'guard' | 'reaction' | 'free' | 'rescued' | 'relic' | 'broken' | 'finish' | 'refuse';
  actor?: Unit['id'];
  target?: Unit['id'];
  detail?: string;
}

export interface Unit {
  id: number | string;
  agent: Agent;
  side: Side;
  role: Role;
  sheet: Sheet;
  x: number; z: number;
  facing: [number, number];
  init: number;
  move: number;
  out: Out;
  moved: boolean; acted: boolean; reacted: boolean;
  burning: number; prone: boolean; exposed: boolean; defending: boolean; overwatch: boolean;
  stunned: boolean; slowed: number; shield: number;
  morale: 'steady' | 'shaken' | 'broken';
  guardedBy: Unit | null; tauntedBy: Unit | null; turnedOn: Unit | null; lastHitBy: Unit | null;
  carrying: Prop | null;
  readied: Readied | null;          // a held action waiting on its trigger
  surprised: boolean;               // caught unaware: loses the first round
  readyRound: Map<string, number>;
  bluffHeat: number;
  deathSaves: { ok: number; fail: number };
  loot: number;
  tactic: Tactic;
  traits: Traits | null;            // companions only
  tags: Set<string>;                // 'captive' | 'chief' | 'civilian' | …
  bound: boolean;                   // a captive in ropes: cannot act until freed
}

/** What a readied action waits for. */
export type Trigger =
  | { on: 'enter'; at: Spot; r: number }                 // a foe moves within r tiles of a spot
  | { on: 'reach' }                                      // a foe moves into my reach (overwatch)
  | { on: 'moves'; who: Unit['id'] }                     // this particular unit moves
  | { on: 'attacks'; ward: Unit['id'] }                  // someone moves to strike my ward — I go FIRST
  | { on: 'nears'; prop: string };                       // a foe comes next to this prop

export interface Readied { trigger: Trigger; response: Action; flourish?: string; }

export type SocialVerb = 'bluff' | 'intimidate' | 'taunt' | 'rally' | 'parley';
export type Claim = 'look_behind' | 'reinforcements' | 'turncoat' | 'surrender_terms';
export type Spot = { x: number; z: number };

export type Action =
  | { kind: 'attack'; target: Unit['id'] }
  | { kind: 'ability'; abilityId: string; target: Unit['id'] }
  | { kind: 'shove'; target: Unit['id'] | string }            // a unit id, or a prop id
  | { kind: 'kick'; prop: string }                            // tip a table/cart, spill a brazier, roll a barrel
  | { kind: 'throw'; prop: string; at: Spot }                 // a light prop (adjacent or carried)
  | { kind: 'ignite'; at: Spot }                              // needs a flame to hand
  | { kind: 'douse'; at: Spot }                               // needs water to hand
  | { kind: 'pickup'; prop: string }
  | { kind: 'grab'; target: Unit['id'] }
  | { kind: 'subdue'; target: Unit['id'] }
  | { kind: 'aid'; target: Unit['id'] }
  | { kind: 'free'; target: Unit['id'] }                      // cut a captive's bonds
  | { kind: 'guard'; target: Unit['id'] }
  | { kind: 'social'; verb: SocialVerb; target?: Unit['id']; claim?: Claim; subject?: Unit['id'] }
  | { kind: 'ready'; trigger: Trigger; response: Action }
  | { kind: 'overwatch' } | { kind: 'defend' } | { kind: 'dash' } | { kind: 'escape' } | { kind: 'wait' };

export interface LogLine { round: number; text: string; kind: 'hit' | 'miss' | 'move' | 'env' | 'social' | 'join' | 'info' | 'end'; }

const hpOf = (u: Unit) => Math.max(0, u.agent.fighter.health);
const frac = (u: Unit) => hpOf(u) / TUNE.maxHealth;
const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class Battle {
  readonly session: Session;
  readonly map: BattleMap;
  units: Unit[] = [];
  round = 1;
  order: Unit[] = [];
  turn = 0;
  outcome: Outcome | null = null;
  log: LogLine[] = [];
  events: BattleEvent[] = [];
  /** What this fight is FOR (set by the scene): the AI and the run's objective check read these. */
  goals: { rescue?: Unit['id']; retrieve?: string; chief?: Unit['id']; spareChief?: boolean } = {};
  highStakes = false;
  stakesReason = '';
  private objectives = new Map<Unit['id'], Objective>();
  private tricks = new Map<string, number>();

  constructor(session: Session, map: BattleMap) {
    this.session = session;
    this.map = map;
  }

  // ---- setup ----------------------------------------------------------------------------------

  /** Place an engine agent on the grid. Snaps its body to the tile. */
  add(agent: Agent, role: Role, at: Spot, extra: { tactic?: Tactic; traits?: Traits | null; tags?: string[]; bound?: boolean } = {}): Unit {
    const sheet = sheetOf(agent);
    const u: Unit = {
      id: agent.id, agent, side: role === 'foe' ? 'them' : 'us', role, sheet,
      x: at.x, z: at.z, facing: [0, 1], init: check(sheet.finesse, 0).total,
      move: 4 + (sheet.finesse >= 3 ? 1 : 0), out: null,
      moved: false, acted: false, reacted: false,
      burning: 0, prone: false, exposed: false, defending: false, overwatch: false, stunned: false, slowed: 0, shield: 0,
      morale: 'steady', guardedBy: null, tauntedBy: null, turnedOn: null, lastHitBy: null, carrying: null, readied: null, surprised: false,
      tactic: extra.tactic ?? (agent.faction === 'monster' ? 'beast' : role === 'foe' ? 'brute' : 'guardian'),
      traits: extra.traits ?? null, tags: new Set(extra.tags ?? []), bound: !!extra.bound,
      readyRound: new Map(), bluffHeat: 0, deathSaves: { ok: 0, fail: 0 }, loot: 0,
    };
    agent._encounter = 1;
    try { agent.fighter.stopBlock(); agent.fighter.setMoving(0); } catch { /* stub body */ }
    this.units.push(u);
    this.place(u);
    return u;
  }

  /** Begin: roll the order and hand the first turn out. */
  start(): void {
    this.note('info', `Battle! ${this.roster('them')} against ${this.roster('us')}.`);
    this.beginRound();
  }

  // ---- queries --------------------------------------------------------------------------------

  get(id: Unit['id'] | undefined): Unit | undefined { return id == null ? undefined : this.units.find((u) => u.id === id); }
  active(): Unit[] { return this.units.filter((u) => u.out === null && u.agent.alive); }
  foesOf(u: Unit): Unit[] { return this.active().filter((o) => o.side !== u.side); }
  friendsOf(u: Unit): Unit[] { return this.active().filter((o) => o.side === u.side && o !== u); }
  downed(side: Side): Unit[] { return this.units.filter((u) => u.side === side && u.out === 'downed' && u.agent.alive); }
  unitAt(x: number, z: number): Unit | undefined { return this.units.find((u) => u.out !== 'dead' && u.out !== 'fled' && u.out !== 'yielded' && u.x === x && u.z === z && u.agent.alive); }
  current(): Unit | null { return this.outcome ? null : this.order[this.turn] ?? null; }
  objectiveOf(u: Unit): Objective {
    if (u.role === 'player') return { kind: 'win', label: 'you' };
    let o = this.objectives.get(u.id);
    if (!o && u.traits && u.role === 'companion') {
      const pl = this.units.find((x) => x.role === 'player' && x.out !== 'dead');
      o = u.morale === 'broken' || (u.traits.bravery < 0.3 && frac(u) < 0.35) ? { kind: 'survive', label: 'wants out alive' }
        : pl && u.traits.loyalty >= 0.3 && (u.traits.compassion >= 0.5 || u.tactic === 'guardian' || u.tactic === 'healer') ? { kind: 'protect', wardId: pl.id, label: 'is watching your back' }
        : { kind: 'win', label: u.traits.ruthlessness > 0.6 ? 'wants none of them walking away' : 'fights to win' };
      this.objectives.set(u.id, o);
    }
    if (!o) {
      const v = (x: Unit) => ({ id: x.id, name: x.agent.name, controlled: !!x.agent.controlled });
      o = u.morale === 'broken' ? { kind: 'survive', label: 'wants out alive' } : objectiveOf(u.agent, {
        selfId: u.id, foes: this.foesOf(u).map(v), friends: this.friendsOf(u).map(v),
        playerId: this.session.player?.id ?? null, isCompanion: u.role === 'companion',
      });
      // a chief does not run from their own fight: they win, or they sue for terms
      if (u.tags.has('chief') && o.kind === 'survive') o = { kind: 'win', label: 'will not run from this' };
      this.objectives.set(u.id, o);
    }
    return o;
  }

  /** Is this unit's turn one the player decides (their own, or a commanded companion's)? */
  playerControls(u: Unit): boolean {
    return u.role === 'player' || (u.role === 'companion' && this.highStakes);
  }

  adjacent(a: Spot, b: Spot): boolean { return dist(a, b) === 1; }

  /**
   * Tiles the unit can reach this turn: Dijkstra over 4-neighbours; climbing ≤ JUMP levels per
   * step; mud/water cost double; friends can be passed through, foes block; can't stop on a unit.
   */
  reachable(u: Unit, budget = this.moveBudget(u)): Map<string, { cost: number; path: Spot[] }> {
    const out = new Map<string, { cost: number; path: Spot[] }>();
    const start = { x: u.x, z: u.z };
    const best = new Map<string, number>([[key(u.x, u.z), 0]]);
    const q: Array<{ s: Spot; c: number; path: Spot[] }> = [{ s: start, c: 0, path: [] }];
    while (q.length) {
      q.sort((a, b) => a.c - b.c);
      const cur = q.shift()!;
      const here = this.map.standH(cur.s.x, cur.s.z);
      for (const [dx, dz] of DIRS) {
        const nx = cur.s.x + dx, nz = cur.s.z + dz;
        const t = this.map.tile(nx, nz);
        if (!t || !this.map.standable(nx, nz)) continue;
        const nh = this.map.standH(nx, nz);
        if (nh - here > JUMP) continue;
        const occ = this.unitAt(nx, nz);
        if (occ && occ.side !== u.side) continue;
        const c = cur.c + (t.ground === 'water' || t.ground === 'mud' ? 2 : 1) + (nh - here >= 2 ? 1 : 0);
        if (c > budget) continue;
        const k = key(nx, nz);
        if ((best.get(k) ?? Infinity) <= c) continue;
        best.set(k, c);
        const path = [...cur.path, { x: nx, z: nz }];
        q.push({ s: { x: nx, z: nz }, c, path });
        if (!occ) out.set(k, { cost: c, path });
      }
    }
    return out;
  }

  moveBudget(u: Unit): number { return Math.max(1, u.move - u.slowed - (u.prone ? 2 : 0)); }

  /** Height edge of a over b: +1 higher by 2+ levels, −1 lower. */
  heightEdge(a: Spot, b: Spot): number {
    const d = this.map.standH(a.x, a.z) - this.map.standH(b.x, b.z);
    return d >= 2 ? 1 : d <= -2 ? -1 : 0;
  }

  /** Where the blow lands relative to the defender's facing: 'front' | 'side' | 'back'. */
  facingOf(att: Spot, def: Unit): 'front' | 'side' | 'back' {
    const vx = Math.sign(att.x - def.x), vz = Math.sign(att.z - def.z);
    const dot = vx * def.facing[0] + vz * def.facing[1];
    return dot > 0 ? 'front' : dot < 0 ? 'back' : 'side';
  }

  /** The DC to land a blow (melee or ranged) from `from` on t. The GM's arithmetic, readable. */
  hitDC(a: Unit, t: Unit, from: Spot, ranged: boolean): { dc: number; notes: string[] } {
    const notes: string[] = [];
    let dc = 10 + t.sheet.finesse;
    if (t.defending) { dc += 3; notes.push('braced +3'); }
    if (t.guardedBy && t.guardedBy.out === null && this.adjacent(t.guardedBy, t)) { dc += 2; notes.push('guarded +2'); }
    const edge = this.heightEdge(from, t);
    if (edge) { dc -= edge * 2; notes.push(edge > 0 ? 'high ground' : 'uphill'); }
    const face = this.facingOf(from, t);
    if (face === 'back') { dc -= 3; notes.push('from behind'); }
    else if (face === 'side') { dc -= 1; notes.push('flank'); }
    if (t.prone) { dc -= ranged ? 1 : 3; notes.push('prone'); }
    if (t.exposed) { dc -= 4; notes.push('exposed'); }
    if (ranged) {
      const cov = this.map.coverAgainst(t.x, t.z, from.x, from.z);
      if (cov) { dc += cov * 3; notes.push(cov === 2 ? 'full cover' : 'half cover'); }
      else notes.push('flanked');
      if (this.map.tile(t.x, t.z)!.smoke > 0) { dc += 4; notes.push('smoke'); }
      dc += Math.max(0, Math.floor((dist(from, t) - 4) / 2));
    }
    return { dc, notes };
  }

  // ---- the turn machine ---------------------------------------------------------------------

  private beginRound(): void {
    this.objectives.clear();
    for (const u of this.active()) { u.moved = false; u.acted = false; u.reacted = false; }
    this.order = this.active().sort((a, b) => b.init - a.init);
    this.turn = -1;
    this.assessStakes();
    this.nextTurn();
  }

  private nextTurn(): void {
    if (this.checkEnd()) return;
    this.turn++;
    while (this.turn < this.order.length) {
      const u = this.order[this.turn];
      if (u.out === null && u.agent.alive) {
        this.startTurn(u);
        const spent = u.moved && u.acted;          // stunned / surprised: the turn passes
        if (u.out === null && u.agent.alive && !this.outcome && !spent) return;
      }
      else if (u.out === 'downed' && u.role === 'player') this.deathSave(u);
      this.turn++;
      if (this.checkEnd()) return;
    }
    this.endRound();
  }

  private startTurn(u: Unit): void {
    u.defending = false; u.overwatch = false; u.moved = false; u.acted = false;
    if (u.readied) { u.readied = null; }
    if (u.bound) { u.moved = true; u.acted = true; return; }
    if (u.surprised) { u.surprised = false; u.moved = true; u.acted = true; this.note('info', `${this.nm(u, true)} ${u.agent.controlled ? 'are' : 'is'} caught off guard!`); return; }
    if (u.burning > 0) {
      this.wound(u.lastHitBy ?? u, u, 8, 'fire');
      u.burning--;
      if (u.out === null) this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'burn' : 'burns'}!`);
      if (u.role !== 'player' && u.out === null && u.morale === 'steady') u.morale = 'shaken';
    }
    if (u.stunned) { u.stunned = false; u.acted = true; u.moved = true; this.note('info', `${this.nm(u, true)} ${u.agent.controlled ? 'are' : 'is'} stunned and lose${u.agent.controlled ? '' : 's'} the turn.`); }
    if (u.prone && !u.stunned) { u.prone = false; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'get' : 'gets'} up.`); u.slowed = Math.max(u.slowed, 0); }
    if (u.stunned === false && u.acted && u.moved) { /* stunned turn */ }
  }

  /** The current unit has finished (player: End Turn; NPC: after its plan). */
  endTurn(u: Unit, facing?: Spot): void {
    if (this.current() !== u) return;
    const foe = facing ?? this.nearestFoe(u);
    if (foe) this.face(u, foe);
    u.slowed = 0;
    this.nextTurn();
  }

  private endRound(): void {
    this.environment();
    this.morale();
    if (this.checkEnd()) return;
    this.round++;
    if (this.round > 40) { this.outcome = 'timeout'; this.finish(); return; }
    this.beginRound();
  }

  private assessStakes(): void {
    const reasons: string[] = [];
    const p = this.units.find((u) => u.role === 'player');
    if (p && (p.out === 'downed' || frac(p) < 0.45)) reasons.push(p.out === 'downed' ? 'you are down' : 'you are badly hurt');
    const falling = this.active().find((u) => u.role === 'companion' && frac(u) < 0.35);
    if (falling) reasons.push(`${falling.agent.name} is about to fall`);
    const power = (s: Side) => this.active().filter((u) => u.side === s).reduce((t, u) => t + frac(u) * (1 + u.sheet.might * 0.25), 0);
    if (power('them') > power('us') * 1.3) reasons.push('you are outmatched');
    const named = this.active().find((u) => u.side === 'them' && u.agent.epithet);
    if (named) reasons.push(`${named.agent.name} is no common foe`);
    this.highStakes = this.active().some((u) => u.role === 'companion') && reasons.length > 0;
    this.stakesReason = reasons.join('; ');
  }

  // ---- movement -----------------------------------------------------------------------------

  /** Walk along a legal path, step by step (reactions and hazards fire on the way). */
  moveTo(u: Unit, to: Spot): string | null {
    if (this.current() !== u) return 'not your turn';
    if (u.moved && u.acted) return 'turn is spent';
    const dashing = u.moved && !u.acted;
    const r = this.reachable(u).get(key(to.x, to.z));
    if (!r) return 'cannot reach that tile';
    if (dashing) u.acted = true; else u.moved = true;
    for (const step of r.path) {
      const leaving = { x: u.x, z: u.z };
      this.face(u, step);
      u.x = step.x; u.z = step.z;
      this.place(u);
      this.opportunity(u, leaving);
      if (u.out !== null) return null;
      this.overwatchFire(u);
      if (u.out !== null) return null;
      this.fireReadied(u, 'move');
      if (u.out !== null) return null;
      this.enterTile(u);
      if (u.out !== null) return null;
    }
    return null;
  }

  /**
   * Check every held action against what just happened. `mover` moved a step ('move'), or is
   * about to strike `victim` ('attack'). A fired response is re-checked for legality from where
   * the watcher stands NOW; an impossible response fizzles (the moment passed).
   */
  private fireReadied(mover: Unit, what: 'move' | 'attack', victim?: Unit): void {
    for (const w of this.active()) {
      const r = w.readied;
      if (!r || w === mover || w.side === mover.side || w.stunned) continue;
      const tr = r.trigger;
      const hit =
        (what === 'move' && tr.on === 'enter' && dist(mover, tr.at) <= tr.r) ||
        (what === 'move' && tr.on === 'reach' && this.adjacent(w, mover)) ||
        (what === 'move' && tr.on === 'moves' && tr.who === mover.id) ||
        (what === 'move' && tr.on === 'nears' && (() => { const p = this.map.props.get(tr.prop); return !!p && dist(p, mover) <= 1; })()) ||
        (what === 'attack' && tr.on === 'attacks' && victim?.id === tr.ward);
      if (!hit) continue;
      w.readied = null;
      // aim the response at the trigger's author when it was left open ("strike whoever comes")
      let resp = r.response;
      if ('target' in resp && (resp.target == null || resp.target === -1)) resp = { ...resp, target: mover.id } as Action;
      if (resp.kind === 'throw' && (resp.at.x < 0)) resp = { ...resp, at: { x: mover.x, z: mover.z } };
      const legal = resp.kind === 'social' || this.options(w).some((o) => sameAction(o, resp));
      if (!legal) { this.note('miss', `${this.nm(w, true)} ${w.agent.controlled ? 'were' : 'was'} ready — but the moment slips past.`); continue; }
      this.note('info', `${this.nm(w, true)} ${w.agent.controlled ? 'spring' : 'springs'} into action!`);
      this.ev('reaction', w, mover);
      const saved = { acted: w.acted };
      w.acted = false;
      this.performAs(w, resp, r.flourish);
      w.acted = saved.acted || true;
      if (mover.out !== null || !mover.agent.alive) return;
    }
  }

  /** Execute an action for a unit OUT of turn order (a reaction). */
  private performAs(u: Unit, a: Action, flourish?: string): void {
    const prevOrder = this.order, prevTurn = this.turn;
    this.order = [u]; this.turn = 0;               // make `current()` this unit for act()'s guards
    try { this.act(u, a, flourish); } finally { this.order = prevOrder; this.turn = prevTurn; }
  }

  /**
   * FOREWARNING. Before round 1, a forewarned unit may be repositioned and hold a readied
   * action — the ambush set-up. Unwarned units are SURPRISED and lose round 1.
   */
  prepare(u: Unit, opts: { at?: Spot; ready?: Readied }): string | null {
    if (this.order.length) return 'the fight has already begun';
    if (opts.at) {
      if (!this.map.standable(opts.at.x, opts.at.z) || this.unitAt(opts.at.x, opts.at.z)) return 'cannot stand there';
      u.x = opts.at.x; u.z = opts.at.z; this.place(u);
    }
    if (opts.ready) u.readied = opts.ready;
    return null;
  }

  /** Mark who is caught unaware: anyone who holds NO belief about any foe (never saw it coming). */
  surpriseFromBeliefs(forewarned: ReadonlySet<Unit['id']> = new Set()): void {
    for (const u of this.units) {
      if (forewarned.has(u.id)) continue;
      const aware = this.units.some((f) => f.side !== u.side && !!u.agent.beliefs.get(f.id));
      if (!aware && !u.agent.controlled) u.surprised = true;
    }
  }

  private opportunity(u: Unit, from: Spot): void {
    for (const f of this.foesOf(u)) {
      if (f.reacted || f.stunned || f.prone || !this.adjacent(f, from) || this.adjacent(f, u)) continue;
      f.reacted = true;
      this.note('hit', `${this.nm(f, true)} ${f.agent.controlled ? 'take' : 'takes'} a swing as ${this.nm(u)} ${u.agent.controlled ? 'break' : 'breaks'} away.`);
      this.strike(f, u, false, 0.7);
      if (u.out !== null) return;
    }
  }

  private overwatchFire(u: Unit): void {
    for (const f of this.foesOf(u)) {
      if (!f.overwatch || f.reacted) continue;
      const ranged = this.rangedReach(f);
      const inReach = ranged ? dist(f, u) <= ranged && this.map.sees(f.x, f.z, u.x, u.z) : this.adjacent(f, u);
      if (!inReach) continue;
      f.overwatch = false; f.reacted = true;
      this.note('hit', `${this.nm(f, true)} ${f.agent.controlled ? 'were' : 'was'} waiting — overwatch!`);
      if (ranged) { const ab = this.bestRanged(f); if (ab) this.useAbility(f, ab, u); } else this.strike(f, u, false, 1);
      if (u.out !== null) return;
    }
  }

  private enterTile(u: Unit): void {
    const t = this.map.tile(u.x, u.z)!;
    if (t.burning > 0 && u.burning === 0) { u.burning = 2; this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'catch' : 'catches'} fire!`); }
    if ((t.ground === 'water' || t.wet > 0) && u.burning > 0) { u.burning = 0; this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'put' : 'puts'} out the flames.`); }
  }

  // ---- actions ------------------------------------------------------------------------------

  /** Success chance of an action for the preview + AI (0..1; 1 for automatic). */
  odds(u: Unit, a: Action, from: Spot = u): { p: number; notes: string[] } {
    const t = 'target' in a && a.target != null ? this.get(a.target as Unit['id']) : undefined;
    const roll = (stat: Stat, dc: number, notes: string[] = []) => ({ p: chance(u.sheet[stat], dc), notes });
    switch (a.kind) {
      case 'attack': { if (!t) return { p: 0, notes: [] }; const h = this.hitDC(u, t, from, false); return roll('might', h.dc, h.notes); }
      case 'ability': {
        if (!t) return { p: 0, notes: [] };
        const spec = u.agent.abilities.get(a.abilityId);
        const rng_ = spec ? spec.header.range > 3 : false;
        const h = this.hitDC(u, t, from, rng_);
        return { p: chance(Math.max(u.sheet.might, u.sheet.presence) + 1, h.dc), notes: h.notes };
      }
      case 'shove': {
        if (t) return roll('might', 10 + t.sheet.might + (t.defending ? 2 : 0) - this.heightEdge(from, t) * 2, this.shoveNotes(u, t, from));
        const p = this.map.props.get(String(a.target));
        return p ? roll('might', p.kind === 'cart' ? 13 : 9) : { p: 0, notes: [] };
      }
      case 'throw': {
        const tu = this.unitAt(a.at.x, a.at.z);
        if (!tu) return { p: 1, notes: [] };
        const h = this.hitDC(u, tu, from, true);
        return roll('finesse', h.dc - 2, h.notes);
      }
      case 'grab': return t ? roll('finesse', 10 + t.sheet.finesse + (t.defending ? 2 : 0)) : { p: 0, notes: [] };
      case 'subdue': { if (!t) return { p: 0, notes: [] }; const h = this.hitDC(u, t, from, false); return roll('might', h.dc + 2, h.notes); }
      case 'aid': { const w = t ?? u; return w.out === 'downed' ? roll('finesse', 10) : ((u.agent.inventory as Record<string, number> | undefined)?.potion ?? 0) > 0 ? { p: 1, notes: ['potion'] } : roll('finesse', 11); }
      case 'social': return this.socialOdds(u, a, t);
      default: return { p: 1, notes: [] };
    }
  }

  /** Every action this unit could take right now from where it stands (for UI buttons and AI). */
  options(u: Unit, from: Spot = u): Action[] {
    const out: Action[] = [];
    const foes = this.foesOf(u), friends = this.friendsOf(u);
    for (const f of foes) {
      if (this.adjacent(from, f)) {
        out.push({ kind: 'attack', target: f.id }, { kind: 'shove', target: f.id }, { kind: 'subdue', target: f.id });
        if ((f.agent.gold || 0) > 0) out.push({ kind: 'grab', target: f.id });
      }
      for (const ab of u.agent.abilities?.values?.() ?? []) {
        if ((u.readyRound.get(ab.id) ?? 0) > this.round || !ab.effects.some((e) => e.op === 'damage' || e.op === 'stun' || e.op === 'expose')) continue;
        const reach = Math.max(1, Math.ceil(ab.header.range / TILE));
        if (dist(from, f) <= reach && (reach === 1 || this.map.sees(from.x, from.z, f.x, f.z))) out.push({ kind: 'ability', abilityId: ab.id, target: f.id });
      }
      if (dist(from, f) <= 6 && this.map.sees(from.x, from.z, f.x, f.z)) {
        out.push({ kind: 'social', verb: 'intimidate', target: f.id }, { kind: 'social', verb: 'taunt', target: f.id },
          { kind: 'social', verb: 'bluff', target: f.id, claim: 'look_behind' });
      }
    }
    for (const f of [...friends, ...this.downed(u.side)]) {
      if (!this.adjacent(from, f)) continue;
      if (f.bound) { out.push({ kind: 'free', target: f.id }); continue; }
      out.push({ kind: 'aid', target: f.id }, ...(f.out === null ? [{ kind: 'guard', target: f.id } as Action] : []));
    }
    if (frac(u) < 1) out.push({ kind: 'aid', target: u.id });
    for (const p of this.map.props.values()) {
      const d = dist(from, p);
      if (d === 1 && p.weight === 1) out.push({ kind: 'kick', prop: p.id }, { kind: 'shove', target: p.id });
      if (d <= 1 && p.weight === 0) out.push({ kind: 'pickup', prop: p.id });
      if (d <= 1 && p.weight === 0) for (const f of foes) if (dist(from, f) <= 5 && this.map.sees(from.x, from.z, f.x, f.z)) out.push({ kind: 'throw', prop: p.id, at: { x: f.x, z: f.z } });
    }
    if (u.carrying) for (const f of foes) if (dist(from, f) <= 5) out.push({ kind: 'throw', prop: u.carrying.id, at: { x: f.x, z: f.z } });
    if (this.flameAt(u, from)) for (const [dx, dz] of DIRS) { const t = this.map.tile(from.x + dx, from.z + dz); if (t && this.flammable(t.x, t.z)) out.push({ kind: 'ignite', at: { x: t.x, z: t.z } }); }
    if (this.waterAt(u, from)) for (const [dx, dz] of [[0, 0], ...DIRS]) { const t = this.map.tile(from.x + dx, from.z + dz); if (t && (t.burning || this.unitAt(t.x, t.z)?.burning)) out.push({ kind: 'douse', at: { x: t.x, z: t.z } }); }
    out.push({ kind: 'defend' }, { kind: 'overwatch' }, { kind: 'social', verb: 'rally' }, { kind: 'social', verb: 'parley' });
    if (this.map.edge(from.x, from.z)) out.push({ kind: 'escape' });
    return out;
  }

  /** Perform the unit's action for this turn. Returns an error string on refusal. */
  act(u: Unit, a: Action, flourish?: string): string | null {
    if (this.current() !== u) return 'not your turn';
    if (u.acted) return 'already acted this turn';
    if (a.kind === 'dash') { if (u.moved) { u.moved = false; u.acted = true; return null; } return 'move first, then dash'; }
    const legal = a.kind === 'wait' || a.kind === 'social' || a.kind === 'ready' || this.options(u).some((o) => sameAction(o, a));
    if (!legal) return 'not possible from here';
    u.acted = true;
    const fl = flourish ? ` — "${flourish}"` : '';
    const t = 'target' in a && a.target != null ? this.get(a.target as Unit['id']) : undefined;
    if (t && t.side !== u.side) this.face(u, t);
    // a hostile act on someone who is being watched over: the watcher's readied response goes first
    if (t && t.side !== u.side && ['attack', 'ability', 'shove', 'grab', 'subdue'].includes(a.kind)) {
      this.fireReadied(u, 'attack', t);
      if (u.out !== null || !u.agent.alive || u.stunned) { this.checkEnd(); return null; }
    }
    switch (a.kind) {
      case 'ready': u.readied = { trigger: a.trigger, response: a.response, flourish }; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'wait' : 'waits'}, ready${fl}.`); break;
      case 'attack': this.strike(u, t!, false, 1, fl); break;
      case 'ability': { const spec = u.agent.abilities.get(a.abilityId); if (spec) this.useAbility(u, spec, t!); break; }
      case 'shove': t ? this.shoveUnit(u, t, fl) : this.shoveProp(u, this.map.props.get(String(a.target))!, fl); break;
      case 'kick': this.kick(u, this.map.props.get(a.prop)!, fl); break;
      case 'throw': this.throwProp(u, this.map.props.get(a.prop) ?? u.carrying!, a.at, fl); break;
      case 'ignite': this.ignite(a.at.x, a.at.z, u, fl); break;
      case 'douse': this.douse(a.at.x, a.at.z, u); break;
      case 'pickup': { const p = this.map.props.get(a.prop)!; u.carrying = p; if (p.kind === 'relic') this.ev('relic', u); this.map.removeProp(p); this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'pick' : 'picks'} up ${p.name}.`); u.acted = false; break; }
      case 'grab': this.grab(u, t!); break;
      case 'subdue': this.subdue(u, t!); break;
      case 'aid': this.aid(u, t ?? u); break;
      case 'free':
        if (t && t.bound) { t.bound = false; this.ev('free', u, t); this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'cut' : 'cuts'} ${this.nm(t)} free!`); }
        break;
      case 'guard': this.ev('guard', u, t); t!.guardedBy = u; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'cover' : 'covers'} ${this.nm(t!)}.`); break;
      case 'defend': u.defending = true; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'brace' : 'braces'}.`); break;
      case 'overwatch': u.overwatch = true; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'hold' : 'holds'}, watching.`); break;
      case 'escape':
        u.out = 'fled'; this.release(u); this.ev(u.tags.has('captive') ? 'rescued' : 'escape', u, undefined, u.carrying?.kind);
        this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'slip' : 'slips'} away from the fight${u.carrying ? ` with ${u.carrying.name}` : ''}.`); break;
      case 'social': this.social(u, a, t, fl); break;
      case 'wait': break;
    }
    this.checkEnd();
    return null;
  }

  // ---- resolution helpers -------------------------------------------------------------------

  private strike(u: Unit, t: Unit, _ranged: boolean, mul: number, fl = ''): void {
    if (t.guardedBy && t.guardedBy.out === null && t.guardedBy !== u && this.adjacent(t.guardedBy, t) && rng() < 0.5) {
      this.note('move', `${this.nm(t.guardedBy, true)} ${t.guardedBy.agent.controlled ? 'step' : 'steps'} in front of ${this.nm(t)}.`);
      t = t.guardedBy;
    }
    this.swing(u);
    const h = this.hitDC(u, t, u, false);
    const r = check(u.sheet.might + this.trickMod(fl, false), h.dc);
    if (!r.ok) { this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'swing' : 'swings'} at ${this.nm(t)}${fl} — and ${u.agent.controlled ? 'miss' : 'misses'}.`); return; }
    const back = this.facingOf(u, t) === 'back';
    let dmg = TUNE.damage * (0.75 + 0.08 * u.sheet.might) * (0.85 + rng() * 0.3) * mul;
    if (r.crit || (back && rng() < 0.35)) dmg *= 1.5;
    if (t.exposed) { dmg *= 1.5; t.exposed = false; }
    const res = this.wound(u, t, dmg);
    this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'hit' : 'hits'} ${this.nm(t)}${back ? ' from behind' : ''}${fl}${r.crit ? ' — critical!' : ''}${this.fellText(t, res)}.`);
  }

  private useAbility(u: Unit, spec: NonNullable<ReturnType<Agent['abilities']['get']>>, t: Unit): void {
    u.readyRound.set(spec.id, this.round + Math.max(1, Math.ceil((spec.header.cooldown || 0) / 3)));
    const ranged = spec.header.range > 3;
    const area = spec.header.area;
    const r0 = 'r' in area ? Math.round(area.r / TILE) : 0;
    const targets = r0 > 0 ? this.foesOf(u).filter((f) => dist(f, t) <= r0) : [t];
    this.swing(u);
    const parts: string[] = [];
    for (const tt of targets) {
      const h = this.hitDC(u, tt, u, ranged);
      const r = check(Math.max(u.sheet.might, u.sheet.presence) + 1, h.dc);
      if (!r.ok) { parts.push(`${this.nm(tt)} evades`); continue; }
      let fell = false;
      for (const e of spec.effects) {
        if (e.when && e.when !== 'on_hit') continue;
        if (e.op === 'damage') { const res = this.wound(u, tt, (e.amount || TUNE.damage) * (r.crit ? 1.5 : 1) * (tt.exposed ? 1.5 : 1)); tt.exposed = false; if (res === 'dead' || tt.out) { fell = true; break; } }
        else if (e.op === 'stun') tt.stunned = true;
        else if (e.op === 'slow') tt.slowed = 2;
        else if (e.op === 'expose') tt.exposed = true;
        else if (e.op === 'knockback') this.push(tt, this.dirFrom(u, tt), 1, u);
        else (EFFECTS as Record<string, (e: unknown, a: Agent, t: Agent | null, c: unknown) => boolean>)[e.op]?.(e, u.agent, tt.agent, { time: this.session.sim.time });
      }
      parts.push(fell ? `${this.nm(tt)} falls` : `${this.nm(tt)} is hit`);
    }
    if (!targets.length || spec.effects.every((e) => e.op === 'heal' || e.op === 'shield')) {
      for (const e of spec.effects) if (e.op === 'heal') u.agent.fighter.health = Math.min(TUNE.maxHealth, u.agent.fighter.health + e.amount);
      this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'use' : 'uses'} ${spec.name}.`); return;
    }
    this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'unleash' : 'unleashes'} ${spec.name}: ${parts.join(', ')}.`);
  }

  private shoveNotes(u: Unit, t: Unit, from: Spot): string[] {
    const d = this.dirFrom(from, t);
    const nx = t.x + d[0], nz = t.z + d[1];
    const tile = this.map.tile(nx, nz);
    if (!tile) return ['into the edge'];
    const n: string[] = [];
    if (tile.burning || this.map.propAt(nx, nz)?.fireSource) n.push('into the fire!');
    if (this.map.standH(t.x, t.z) - this.map.standH(nx, nz) > FALL_SAFE) n.push('off the ledge!');
    if (!this.map.standable(nx, nz) || this.unitAt(nx, nz)) n.push('into an obstacle');
    return n;
  }

  private shoveUnit(u: Unit, t: Unit, fl: string): void {
    const r = check(u.sheet.might, 10 + t.sheet.might + (t.defending ? 2 : 0) - this.heightEdge(u, t) * 2);
    if (!r.ok) { this.note('miss', `${this.nm(t, true)} ${t.agent.controlled ? 'hold' : 'holds'} firm against ${this.nm(u)}'s shove.`); return; }
    this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'shove' : 'shoves'} ${this.nm(t)}${fl}!`);
    this.push(t, this.dirFrom(u, t), r.crit ? 2 : 1, u);
  }

  private shoveProp(u: Unit, p: Prop, fl: string): void {
    const r = check(u.sheet.might, p.kind === 'cart' ? 13 : 9);
    if (!r.ok) { this.note('miss', `${p.name} won't budge.`); return; }
    const d = this.dirFrom(u, p);
    this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'heave' : 'heaves'} ${p.name}${fl}.`);
    this.slideProp(p, d, p.kind === 'barrel' || p.kind === 'oil' ? 4 : 2, u);
  }

  private kick(u: Unit, p: Prop, fl: string): void {
    const d = this.dirFrom(u, p);
    if (p.kind === 'brazier') {
      this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'kick' : 'kicks'} over ${p.name}${fl} — coals spill!`);
      this.map.removeProp(p);
      for (let i = 0; i < 4; i++) this.ignite(p.x + d[0] * i, p.z + d[1] * i, u, '', true);
      return;
    }
    if (p.kind === 'table' || p.kind === 'cart') {
      p.tipped = true; p.climbable = false; p.cover = p.kind === 'cart' ? 2 : 1;
      this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'kick' : 'kicks'} over ${p.name}${fl} — fresh cover.`);
      return;
    }
    this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'boot' : 'boots'} ${p.name}${fl}.`);
    this.slideProp(p, d, p.kind === 'barrel' || p.kind === 'oil' ? 5 : 1, u);
  }

  private throwProp(u: Unit, p: Prop, at: Spot, fl: string): void {
    if (u.carrying === p) u.carrying = null; else this.map.removeProp(p);
    const tu = this.unitAt(at.x, at.z);
    let hit = true;
    if (tu) {
      const h = this.hitDC(u, tu, u, true);
      hit = check(u.sheet.finesse, h.dc - 2).ok;
    }
    const where = tu ? this.nm(tu) : 'the ground';
    if (!hit) { this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'hurl' : 'hurls'} ${p.name} at ${where}${fl} — wide.`); return; }
    if (p.liquid) { this.douse(at.x, at.z, u); if (tu && tu.side !== u.side) { tu.exposed = true; } this.note('env', `${cap(p.name)} splashes ${where}${fl}.`); return; }
    if (p.blinding) {
      for (const [dx, dz] of [[0, 0], ...DIRS]) { const t = this.map.tile(at.x + dx, at.z + dz); if (t) t.smoke = 2; }
      if (tu) { tu.exposed = true; tu.stunned = tu.stunned || rng() < 0.3; }
      this.note('env', `${cap(p.name)} bursts over ${where}${fl} — a blinding cloud.`); return;
    }
    if (p.fireSource) { this.ignite(at.x, at.z, u, '', true); if (tu) tu.burning = 2; this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'fling' : 'flings'} ${p.name} at ${where}${fl}!`); return; }
    if (tu) { const res = this.wound(u, tu, p.kind === 'rocks' ? 12 : 9); this.note('hit', `${cap(p.name)} strikes ${where}${fl}${this.fellText(tu, res)}.`); }
  }

  private grab(u: Unit, t: Unit): void {
    const r = check(u.sheet.finesse, 10 + t.sheet.finesse + (t.defending ? 2 : 0));
    const purse = Math.floor(t.agent.gold || 0);
    if (!r.ok || purse <= 0) { this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'grab' : 'grabs'} at ${t.agent.controlled ? 'your' : this.nm(t) + "'s"} purse and ${purse > 0 ? 'misses' : 'finds it empty'}.`); return; }
    const amt = Math.min(purse, Math.round(6 + u.sheet.finesse * 3 + rng() * 10));
    t.agent.gold -= amt; u.agent.gold = (u.agent.gold || 0) + amt; u.loot += amt;   // a transfer, never a mint
    this.ev('grab', u, t, String(amt));
    this.note('social', `${this.nm(u, true)} ${u.agent.controlled ? 'cut' : 'cuts'} ${t.agent.controlled ? 'your' : this.nm(t) + "'s"} purse — ${amt} gold.`);
  }

  private subdue(u: Unit, t: Unit): void {
    this.swing(u);
    const h = this.hitDC(u, t, u, false);
    if (!check(u.sheet.might, h.dc + 2).ok) { this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'try' : 'tries'} to pin ${this.nm(t)} and ${u.agent.controlled ? 'fail' : 'fails'}.`); return; }
    const dmg = TUNE.damage * 0.5;
    if (hpOf(t) - dmg <= TUNE.maxHealth * 0.25) { this.yieldTo(u, t); return; }
    this.wound(u, t, dmg);
    this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'batter' : 'batters'} ${this.nm(t)} with the flat of the blade.`);
  }

  private yieldTo(u: Unit, t: Unit): void {
    t.out = 'yielded'; this.release(t);
    this.ev('yield', u, t);
    t.agent.fighter.health = Math.max(t.agent.fighter.health, 10);
    this.note('social', `${this.nm(t, true)} ${t.agent.controlled ? 'are' : 'is'} beaten down and ${t.agent.controlled ? 'yield' : 'yields'} to ${this.nm(u)}.`);
    if (t.role === 'player' && this.active().some((x) => x.side === 'us' && x !== t && !x.tags.has('captive'))) {
      t.out = 'downed'; t.agent.fighter.health = 0.5;
      this.note('info', 'You go down under the blows — your companions fight on.');
      return;
    }
    if (t.role === 'player') {
      const o = this.objectiveOf(u);
      if (o.kind === 'enforce') this.outcome = 'arrested';
      else {
        const purse = Math.floor(t.agent.gold || 0);
        if (purse > 0) { t.agent.gold -= purse; u.agent.gold = (u.agent.gold || 0) + purse; u.loot += purse; }
        this.outcome = 'overpowered';
      }
      this.finish();
    }
  }

  private aid(u: Unit, w: Unit): void {
    const inv = u.agent.inventory as Record<string, number> | undefined;
    if (w.out === 'downed') {
      if (check(u.sheet.finesse, 10).ok) { this.ev('revive', u, w); w.out = null; w.deathSaves = { ok: 0, fail: 0 }; w.agent.fighter.health = 15 + u.sheet.finesse * 3; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'haul' : 'hauls'} ${this.nm(w)} back up.`); }
      else this.note('miss', `${this.nm(u, true)} can't rouse ${this.nm(w)}.`);
      return;
    }
    if (inv && (inv.potion || 0) >= 1) { inv.potion -= 1; w.agent.fighter.health = Math.min(TUNE.maxHealth, hpOf(w) + 45); this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'pour' : 'pours'} a potion into ${w === u ? (u.agent.controlled ? 'yourself' : 'themself') : this.nm(w)}.`); return; }
    if (check(u.sheet.finesse, 11).ok) { w.agent.fighter.health = Math.min(TUNE.maxHealth, hpOf(w) + 12 + u.sheet.finesse * 2); this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'bind' : 'binds'} a wound.`); }
    else this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'fumble' : 'fumbles'} the bandage.`);
  }

  private socialOdds(u: Unit, a: Extract<Action, { kind: 'social' }>, t?: Unit): { p: number; notes: string[] } {
    const b = t ? t.agent.beliefs.get(u.id) : undefined;
    switch (a.verb) {
      case 'intimidate': return t ? { p: chance(u.sheet.presence, 10 + t.sheet.nerve + (t.morale === 'steady' ? 1 : -2) - Math.round((b?.notoriety || 0) * 4) - (frac(t) < 0.4 ? 2 : 0)), notes: [] } : { p: 0, notes: [] };
      case 'taunt': return t ? { p: chance(u.sheet.presence, 10 + Math.round(t.sheet.nerve / 2) - Math.round(((t.agent.mood && t.agent.mood.anger) || 0) * 4)), notes: [] } : { p: 0, notes: [] };
      case 'bluff': {
        if (!t) return { p: 0, notes: [] };
        let dc = 10 + Math.round(t.sheet.nerve / 2) + Math.round((b?.suspicion || 0) * 8) + t.bluffHeat;
        if (a.claim === 'turncoat' && a.subject != null) { const bs = t.agent.beliefs.get(a.subject); dc += bs ? Math.round(bs.standing * 6 - bs.suspicion * 4) : 2; }
        return { p: chance(u.sheet.presence, dc), notes: b?.suspicion ? ['they suspect you'] : [] };
      }
      case 'rally': return { p: chance(u.sheet.presence, 12), notes: [] };
      case 'parley': {
        if (u.side === 'us' && u.role !== 'player') return { p: 0, notes: ['only you can speak for the company'] };
        const foes = this.foesOf(u);
        const lead = foes.reduce((m, f) => Math.max(m, f.sheet.nerve), 0);
        const mood = foes.reduce((s, f) => s + (f.agent.beliefs.get(u.id)?.standing || 0), 0) / Math.max(1, foes.length);
        const odds = foes.length / Math.max(1, this.friendsOf(u).length + 1);
        const hurt = foes.reduce((s, f) => s + (1 - frac(f)), 0) / Math.max(1, foes.length);
        return { p: chance(u.sheet.presence, 10 + lead + Math.round((odds - 1) * 4) - Math.round(mood * 5) - Math.round(hurt * 6)), notes: [] };
      }
    }
  }

  private social(u: Unit, a: Extract<Action, { kind: 'social' }>, t: Unit | undefined, fl: string): void {
    const ok = rng() < this.socialOdds(u, a, t).p;
    this.ev(ok ? 'social' : 'bluffed', u, t, a.verb);
    const who = this.nm(u, true);
    switch (a.verb) {
      case 'intimidate':
        if (!t) return;
        if (ok) { t.morale = t.morale === 'steady' ? 'shaken' : 'broken'; if (t.agent.mood) t.agent.mood.fear = Math.min(1, (t.agent.mood.fear || 0) + 0.35); this.note('social', `${who} ${u.agent.controlled ? 'terrify' : 'terrifies'} ${this.nm(t)}${fl} — ${t.morale}.`); }
        else this.note('miss', `${this.nm(t, true)} ${t.agent.controlled ? 'are' : 'is'} not impressed.`);
        return;
      case 'taunt':
        if (!t) return;
        if (ok) { t.tauntedBy = u; t.defending = false; this.note('social', `${this.nm(t, true)} ${t.agent.controlled ? 'take' : 'takes'} the bait${fl} and will come for ${this.nm(u)}.`); }
        else this.note('miss', `${this.nm(t, true)} ${t.agent.controlled ? 'ignore' : 'ignores'} the taunt.`);
        return;
      case 'bluff': {
        if (!t) return;
        const bb = t.agent.beliefs.get(u.id);
        if (!ok) { t.bluffHeat += 2; if (bb) bb.suspicion = Math.min(1, (bb.suspicion || 0) + 0.3); this.note('miss', `${this.nm(t, true)} ${t.agent.controlled ? "don't" : "doesn't"} buy it — and trust${t.agent.controlled ? '' : 's'} ${this.nm(u)} less.`); return; }
        if (a.claim === 'turncoat' && a.subject != null) {
          const s = this.get(a.subject);
          if (s) {
            const bs = t.agent.beliefs.get(s.id);
            if (bs) { bs.hostile = true; bs.standing = Math.max(-1, bs.standing - 0.6); bs.suspicion = Math.min(1, bs.suspicion + 0.5); }
            else t.agent.beliefs.plant(s.id, { faction: s.agent.faction, pos: s.agent.pos, tick: this.session.sim.time, hostile: true, suspicion: 0.6, confidence: 0.6 });
            t.turnedOn = s;
            this.note('social', `${who} ${u.agent.controlled ? 'convince' : 'convinces'} ${this.nm(t)} that ${this.nm(s)} is a traitor${fl}. ${this.nm(t, true)} rounds on ${this.nm(s)}!`);
          }
          return;
        }
        if (a.claim === 'reinforcements') { t.morale = t.morale === 'steady' ? 'shaken' : 'broken'; this.note('social', `${this.nm(t, true)} ${t.agent.controlled ? 'believe' : 'believes'} help is coming${fl} and falter${t.agent.controlled ? '' : 's'}.`); return; }
        t.exposed = true; t.facing = [-t.facing[0], -t.facing[1]];
        this.note('social', `${this.nm(t, true)} ${t.agent.controlled ? 'look' : 'looks'} away${fl} — ${this.nm(u)} ${u.agent.controlled ? 'have' : 'has'} an opening.`);
        return;
      }
      case 'rally':
        if (ok) { for (const f of this.friendsOf(u)) { if (f.morale !== 'broken') f.morale = 'steady'; } this.recruitNearby(u.side, 0.85); this.note('social', `${who} ${u.agent.controlled ? 'rally' : 'rallies'} ${u.side === 'us' ? 'your side' : 'their side'}${fl}.`); }
        else this.note('miss', `${who} ${u.agent.controlled ? 'call' : 'calls'} out; no one answers.`);
        return;
      case 'parley':
        if (ok && u.side === 'them') {
          // a beaten side sues for terms: its fighters lay down arms
          for (const f of this.active().filter((x) => x.side === 'them')) { f.out = 'yielded'; this.release(f); this.ev('yield', u, f, 'surrender'); }
          this.note('social', `${who} throws down their weapon and begs for terms${fl}. ${u.tags.has('chief') ? 'The band surrenders.' : ''}`);
        } else if (ok) {
          for (const f of this.foesOf(u)) { const b = f.agent.beliefs.get(u.id); if (b) { b.hostile = false; b.standing = Math.max(b.standing, -0.3); } f.out = 'yielded'; this.release(f); this.ev('parley', u, f); }
          this.note('social', `${who} ${u.agent.controlled ? 'talk' : 'talks'} them down${fl}. Weapons lower.`);
          this.outcome = 'truce';
        } else this.note('miss', `${who} ${u.agent.controlled ? 'try' : 'tries'} to parley; no one is listening.`);
        return;
    }
  }

  // ---- environment --------------------------------------------------------------------------

  flammable(x: number, z: number): boolean {
    const t = this.map.tile(x, z); if (!t || t.wet > 0 || t.ground === 'water') return false;
    const p = this.map.propAt(x, z);
    return t.ground === 'grass' || t.ground === 'mud' || !!(p && p.flammable);
  }

  /** A flame within reach: an adjacent fire source, a burning neighbour, a carried torch, a fire ability. */
  flameAt(u: Unit, from: Spot = u): boolean {
    if (u.carrying?.fireSource) return true;
    for (const [dx, dz] of [[0, 0], ...DIRS]) {
      const x = from.x + dx, z = from.z + dz;
      if (this.map.tile(x, z)?.burning || this.map.propAt(x, z)?.fireSource || this.map.propAt(x, z)?.burning) return true;
    }
    return false;
  }

  waterAt(u: Unit, from: Spot = u): boolean {
    if (u.carrying?.liquid) return true;
    for (const [dx, dz] of [[0, 0], ...DIRS]) { const x = from.x + dx, z = from.z + dz; if (this.map.tile(x, z)?.ground === 'water' || this.map.propAt(x, z)?.liquid) return true; }
    return false;
  }

  ignite(x: number, z: number, by?: Unit, fl = '', silent = false): void {
    const t = this.map.tile(x, z); if (!t || t.wet > 0 || t.ground === 'water') return;
    const p = this.map.propAt(x, z);
    if (p && p.flammable) p.burning = Math.max(p.burning, p.kind === 'oil' ? 1 : 3);
    t.burning = Math.max(t.burning, p?.kind === 'hay' ? 3 : 2);
    if (p?.kind === 'oil') {
      // lamp oil: the barrel bursts and the whole neighbourhood goes up
      this.map.removeProp(p);
      for (const [dx, dz] of DIRS) { const n = this.map.tile(x + dx, z + dz); if (n && n.ground !== 'water') { n.burning = Math.max(n.burning, 2); } }
      for (const u of this.active()) if (dist(u, { x, z }) <= 1) { this.wound(by ?? u, u, 14, 'fire'); u.burning = 2; }
      this.note('env', `The oil barrel bursts into flame!`);
    }
    const u = this.unitAt(x, z);
    if (u && u.burning === 0) { u.burning = 2; if (by) u.lastHitBy = by; }
    if (by) this.ev('ignite', by, u, p?.kind ?? 'ground');
    if (!silent && by) this.note('env', `${this.nm(by, true)} ${by.agent.controlled ? 'set' : 'sets'} ${p ? p.name : 'the ground'} alight${fl}.`);
  }

  douse(x: number, z: number, by?: Unit): void {
    for (const [dx, dz] of [[0, 0], ...DIRS]) {
      const t = this.map.tile(x + dx, z + dz); if (!t) continue;
      t.burning = 0; t.wet = 3;
      const p = this.map.propAt(t.x, t.z); if (p) p.burning = 0;
      const u = this.unitAt(t.x, t.z); if (u) u.burning = 0;
    }
    if (by) this.note('env', `${this.nm(by, true)} ${by.agent.controlled ? 'douse' : 'douses'} the flames.`);
  }

  /** End of round: fire spreads and consumes, smoke thins, wet ground dries. */
  private environment(): void {
    const spread: Array<[number, number]> = [];
    for (const t of this.map.tiles) {
      if (t.burning > 0) {
        for (const [dx, dz] of DIRS) {
          const nx = t.x + dx, nz = t.z + dz;
          if (!this.flammable(nx, nz) || this.map.tile(nx, nz)!.burning) continue;
          const p = this.map.propAt(nx, nz);
          const chanceSpread = p?.kind === 'hay' ? 0.75 : p?.flammable ? 0.45 : 0.3;
          if (rng() < chanceSpread) spread.push([nx, nz]);
        }
      }
    }
    for (const t of this.map.tiles) {
      if (t.burning > 0) { t.burning--; if (t.burning === 0 && t.ground === 'grass') t.ground = 'ash'; }
      if (t.smoke > 0) t.smoke--;
      if (t.wet > 0) t.wet--;
    }
    for (const p of [...this.map.props.values()]) {
      if (p.burning <= 0) continue;
      p.hp -= 8; p.burning--;
      const t = this.map.tile(p.x, p.z)!; t.burning = Math.max(t.burning, 1);
      if (p.hp <= 0) { this.map.removeProp(p); this.note('env', `${cap(p.name)} burns away.`); }
    }
    let lit = 0;
    for (const [x, z] of spread) { this.ignite(x, z, undefined, '', true); lit++; }
    if (lit) this.note('env', `The fire spreads (${lit} tile${lit > 1 ? 's' : ''}).`);
    for (const u of this.active()) if (this.map.tile(u.x, u.z)!.burning > 0 && u.burning === 0) { u.burning = 2; this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'are' : 'is'} caught by the fire!`); }
  }

  /**
   * Push a body along a direction. Stops at obstacles (both take a knock), falls off ledges
   * (damage by drop), lands in fire (alight) or water (doused).
   */
  push(t: Unit, d: [number, number], n: number, by: Unit): void {
    for (let i = 0; i < n; i++) {
      const nx = t.x + d[0], nz = t.z + d[1];
      const tile = this.map.tile(nx, nz);
      const hereH = this.map.standH(t.x, t.z);
      const other = this.unitAt(nx, nz);
      if (!tile || !this.map.standable(nx, nz) || other || this.map.standH(nx, nz) - hereH > JUMP) {
        this.wound(by, t, 7, 'collision'); t.prone = true;
        if (other && other.out === null) { this.wound(by, other, 5, 'collision'); other.prone = true; }
        const what = !tile ? 'the edge' : other ? this.nm(other) : this.map.propAt(nx, nz)?.name ?? 'the wall';
        this.note('env', `${this.nm(t, true)} ${t.agent.controlled ? 'slam' : 'slams'} into ${what}.`);
        return;
      }
      const drop = hereH - this.map.standH(nx, nz);
      t.x = nx; t.z = nz; this.place(t);
      if (drop > FALL_SAFE) { this.ev('hazard', by, t, 'ledge'); this.wound(by, t, (drop - FALL_SAFE) * 7, 'fall'); t.prone = true; this.note('env', `${this.nm(t, true)} ${t.agent.controlled ? 'tumble' : 'tumbles'} off the ledge!`); }
      this.enterTile(t);
      if (tile.burning > 0 || this.map.propAt(nx, nz)?.fireSource) this.ev('hazard', by, t, 'fire');
      if (tile.burning === 0 && this.map.propAt(nx, nz)?.fireSource) { t.burning = 2; this.note('env', `${this.nm(t, true)} ${t.agent.controlled ? 'land' : 'lands'} in the fire!`); }
      if (t.out !== null) return;
      if (tile.burning > 0 || this.map.propAt(nx, nz)?.fireSource || tile.ground === 'water') return;   // fire and water stop a stumble
    }
  }

  private slideProp(p: Prop, d: [number, number], n: number, by: Unit): void {
    for (let i = 0; i < n; i++) {
      const nx = p.x + d[0], nz = p.z + d[1];
      const tile = this.map.tile(nx, nz);
      const hit = this.unitAt(nx, nz);
      if (hit && hit.out === null) {
        this.wound(by, hit, p.kind === 'cart' ? 16 : 11, 'crushed'); hit.prone = true;
        this.note('env', `${cap(p.name)} slams into ${this.nm(hit)}${hit.out ? '' : ', knocking them flat'}.`);
        return;
      }
      if (!tile || tile.wall || this.map.propAt(nx, nz) || this.map.standH(nx, nz) > this.map.standH(p.x, p.z) + 1) return;
      p.x = nx; p.z = nz;
      if (tile.burning > 0 && p.flammable) this.ignite(nx, nz, by, '', true);
      if (p.fireSource && this.flammable(nx, nz)) this.ignite(nx, nz, by, '', true);
    }
  }

  // ---- damage, death, morale ------------------------------------------------------------------

  /** Apply damage and fold it through the engine (witnesses, reputation, vendettas, XP). */
  wound(by: Unit, t: Unit, amount: number, _how = 'blow'): 'hit' | 'dead' | 'blocked' {
    const f = t.agent.fighter;
    if (!f.alive) return 'dead';
    let dmg = Math.max(1, Math.round(amount));
    if (t.shield > 0) { const s = Math.min(t.shield, dmg); t.shield -= s; dmg -= s; if (dmg <= 0) return 'blocked'; }
    t.lastHitBy = by;
    if (t.side === 'us' && dmg >= f.health && this.active().some((o) => o.side === 'us' && o !== t)) {
      f.health = 0.5; t.out = 'downed'; t.burning = 0;
      this.fold(by, t, 'hit');
      this.ev('down', by, t, _how);
      this.note('info', `${this.nm(t, true)} ${t.agent.controlled ? 'go' : 'goes'} down!`);
      return 'hit';
    }
    const res = f.takeHit(dmg, 'DOWN');
    this.fold(by, t, res);
    if (res === 'dead' || !t.agent.alive) {
      this.ev(t.morale === 'broken' ? 'finish' : 'kill', by, t, _how);
      t.out = t.agent._held ? 'captured' : 'dead'; this.release(t); return 'dead';
    }
    if (res === 'hit') this.ev('hit', by, t, _how);
    if (t.agent._held) { t.out = 'captured'; this.release(t); }
    return res;
  }

  private fold(by: Unit, t: Unit, type: 'hit' | 'dead' | 'blocked'): void {
    try { this.session.sim.onCombatEvents([{ type, attacker: by.agent.fighter, target: t.agent.fighter, point: t.agent.pos.clone() }] as never); }
    catch { /* the fold is the engine's; never let it break a battle */ }
  }

  private deathSave(u: Unit): void {
    if (u.deathSaves.ok >= 3) return;
    const r = check(0, 10);
    if (r.crit) { u.out = null; u.agent.fighter.health = 10; this.note('info', 'You drag yourself up, somehow.'); return; }
    if (r.ok) u.deathSaves.ok++; else u.deathSaves.fail += r.fumble ? 2 : 1;
    if (u.deathSaves.fail >= 3) this.kill(u);
    else this.note('info', u.deathSaves.ok >= 3 ? 'You are stable, but out of the fight.' : `You cling on (${u.deathSaves.ok} saves, ${u.deathSaves.fail} failures).`);
  }

  private kill(u: Unit): void {
    const by = u.lastHitBy ?? u;
    u.agent.fighter.health = 0.5; u.agent.fighter.takeHit(1e6, 'DOWN');
    this.fold(by, u, 'dead');
    u.out = 'dead'; this.release(u);
  }

  private morale(): void {
    const lost = (s: Side) => { const all = this.units.filter((u) => u.side === s); return all.length ? all.filter((u) => u.out === 'dead' || u.out === 'captured').length / all.length : 0; };
    for (const u of this.active()) {
      if (u.role === 'player' || u.tags.has('chief')) continue;     // a chief fights to the end, or sues for terms — never runs
      const scorched = u.burning > 0 && (!u.traits || u.traits.bravery < 0.5);
      if (!(frac(u) < 0.35 || u.morale !== 'steady' || lost(u.side) >= 0.5 || scorched)) continue;
      const grit = u.traits ? Math.round((u.traits.bravery - 0.5) * 8) : 0;   // a companion's bravery steadies (or fails) them
      if (check(u.sheet.nerve + grit, 11 + (u.morale === 'shaken' ? 2 : 0) + (u.morale === 'broken' ? 20 : 0)).ok) continue;
      u.morale = 'broken';
      this.ev('broken', u);
      this.objectives.delete(u.id);
      this.note('social', `${this.nm(u, true)}'s nerve breaks!`);
    }
  }

  /** Bystanders near the fight choose, from their OWN beliefs, whether to join and on which side. */
  recruitNearby(side: Side | null = null, p = 0.5): void {
    const sim = this.session.sim;
    const us = this.active().filter((u) => u.side === 'us'), them = this.active().filter((u) => u.side === 'them');
    for (const a of sim.agents as Agent[]) {
      if (!a.alive || a.controlled || a._held || a._encounter != null) continue;
      const t = this.map.tileAtWorld(a.pos.x, a.pos.z);
      if (!t || !this.map.standable(t.x, t.z) || this.unitAt(t.x, t.z)) continue;
      const hostile = (xs: Unit[]) => xs.some((x) => { const b = a.beliefs.get(x.id); return !!b && (b.hostile || b.standing < -0.5); });
      const brave = sheetOf(a).nerve >= 3 || a.combatant;
      if (!brave) continue;
      if (a.inParty) { this.add(a, 'companion', t); continue; }
      const vsUs = hostile(us) && !hostile(them), vsThem = hostile(them) && !hostile(us);
      if (vsUs && side !== 'us' && rng() < p) { this.add(a, 'foe', t); this.note('join', `${a.name} joins against you.`); }
      else if (vsThem && side !== 'them' && rng() < p) { this.add(a, 'ally', t); this.note('join', `${a.name} comes to your aid.`); }
    }
  }

  private checkEnd(): boolean {
    if (this.outcome) { this.finish(); return true; }
    const p = this.units.find((u) => u.role === 'player');
    const us = this.active().filter((u) => u.side === 'us' && !u.tags.has('captive')), them = this.active().filter((u) => u.side === 'them');
    if (p && (!p.agent.alive || p.out === 'dead')) this.outcome = 'defeat';
    else if (p && p.out === 'fled') this.outcome = 'escaped';
    else if (!them.length) this.outcome = 'victory';
    else if (!us.length) this.outcome = 'defeat';
    if (this.outcome) { this.finish(); return true; }
    return false;
  }

  private finished = false;
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const u of this.units) {
      if (u.out === 'downed' && u.agent.alive) {
        if (this.outcome === 'victory' || this.outcome === 'truce') { u.out = null; u.agent.fighter.health = Math.max(u.agent.fighter.health, 10); }
        else this.kill(u);
      }
      const pl = this.session.player;
      if (pl && u.role === 'ally' && u.agent.alive) { const b = u.agent.beliefs.get(pl.id); if (b) b.standing = Math.min(1, b.standing + 0.15); }
      this.release(u);
    }
    const verdict: Record<Outcome, string> = { victory: 'Victory', defeat: 'Defeat', escaped: 'You got away', truce: 'A truce', arrested: 'You are arrested', overpowered: 'You are beaten and robbed', timeout: 'The fight peters out' };
    this.note('end', `${verdict[this.outcome!]} — round ${this.round}.`);
  }

  // ---- bits ------------------------------------------------------------------------------------

  nearestFoe(u: Unit): Unit | undefined { return this.foesOf(u).sort((a, b) => dist(a, u) - dist(b, u))[0]; }
  rangedReach(u: Unit): number { const ab = this.bestRanged(u); return ab ? Math.ceil(ab.header.range / TILE) : 0; }
  bestRanged(u: Unit) { return [...(u.agent.abilities?.values?.() ?? [])].find((s) => s.header.range > 3 && (u.readyRound.get(s.id) ?? 0) <= this.round && s.effects.some((e) => e.op === 'damage')); }
  dirFrom(a: Spot, b: Spot): [number, number] {
    const dx = b.x - a.x, dz = b.z - a.z;
    return Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
  }
  face(u: Unit, s: Spot): void {
    const d = this.dirFrom(u, s);
    if (s.x !== u.x || s.z !== u.z) u.facing = d;
    try { u.agent.fighter.root.rotation.y = Math.atan2(-d[0], -d[1]); } catch { /* stub */ }
  }
  /** Snap the unit's body to its tile (world position, standing height). */
  place(u: Unit): void {
    const t = this.map.tile(u.x, u.z); if (!t) return;
    u.agent.pos.x = t.wx; u.agent.pos.z = t.wz;
    u.agent.pos.y = this.map.surfaceY(u.x, u.z);
  }
  private swing(u: Unit): void { try { u.agent.fighter.ready('DOWN'); u.agent.fighter.release(); } catch { /* cosmetic */ } }
  private release(u: Unit): void { u.agent._encounter = null; }
  private trickMod(fl: string, _consume: boolean): number {
    if (!fl) return 0;
    const k = fl.toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter((w) => w.length > 3).sort().slice(0, 3).join('+');
    const n = this.tricks.get(k) || 0; this.tricks.set(k, n + 1);
    return n === 0 ? 1 : -n;
  }
  private fellText(t: Unit, res: string): string {
    if (t.out === 'downed') return `, and ${this.nm(t)} ${t.agent.controlled ? 'go' : 'goes'} down`;
    if (res === 'dead') return t.out === 'captured' ? `, and ${this.nm(t)} is taken captive` : `, and ${this.nm(t)} falls`;
    return '';
  }
  nm(u: Unit, capital = false): string { const s = u.agent.controlled ? 'you' : u.agent.name; return capital ? cap(s) : s; }
  private roster(side: Side): string { const xs = this.active().filter((u) => u.side === side).map((u) => this.nm(u)); return xs.length ? cap(xs.join(', ')) : 'no one'; }
  ev(kind: BattleEvent['kind'], actor?: Unit, target?: Unit, detail?: string): void {
    this.events.push({ round: this.round, kind, actor: actor?.id, target: target?.id, detail });
  }
  note(kind: LogLine['kind'], text: string): void { this.log.push({ round: this.round, kind, text }); if (this.log.length > 300) this.log.splice(0, 100); }
}

export function sameAction(a: Action, b: Action): boolean {
  if (a.kind !== b.kind) return false;
  const A = a as Record<string, unknown>, B = b as Record<string, unknown>;
  for (const k of ['target', 'abilityId', 'prop', 'verb']) if (A[k] !== undefined && B[k] !== undefined && A[k] !== B[k]) return false;
  if ('at' in a && 'at' in b) return a.at.x === b.at.x && a.at.z === b.at.z;
  return true;
}

export type { Tile, Prop };
