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
import { areaTiles, inReach, type PieceDef, type PieceState } from './pieces.js';
import { answers, hears, type Call, type Want } from './comms.js';
import { telegraph, type Intent } from './intents.js';
import { ITEMS, type ItemId, type Kit } from './items.js';

export type Side = 'us' | 'them';
export type Role = 'player' | 'companion' | 'ally' | 'foe';
export type Out = null | 'downed' | 'dead' | 'fled' | 'yielded' | 'captured';
export type Outcome = 'victory' | 'defeat' | 'escaped' | 'truce' | 'arrested' | 'overpowered' | 'timeout';

/** How a unit fights (drives AI positioning and choices). */
/** A passing state a friend's fate puts on you: wrath (a bonded friend just fell). */
export interface Boon { kind: 'wrath'; by: Unit['id']; until: number }
export interface Bond { lvl: number; kind: 'friend' | 'rival' }
export const pairKey = (a: Unit['id'], b: Unit['id']): string => [String(a), String(b)].sort().join('|');

export type Tactic = 'brute' | 'archer' | 'skirmisher' | 'leader' | 'beast' | 'guardian' | 'healer' | 'rogue' | 'civilian';

/** A companion's developing temperament (0..1), read by the AI. */
export interface Traits { bravery: number; compassion: number; loyalty: number; ruthlessness: number; }

/** A structured record of what happened — fuel for companion growth and hub gossip. */
export interface BattleEvent {
  round: number;
  kind: 'hit' | 'kill' | 'down' | 'revive' | 'flee' | 'escape' | 'ignite' | 'burned' | 'shove' | 'hazard' | 'social' | 'bluffed'
    | 'grab' | 'yield' | 'parley' | 'heal' | 'guard' | 'reaction' | 'free' | 'rescued' | 'relic' | 'broken' | 'finish' | 'refuse' | 'fell' | 'piece' | 'combo' | 'save' | 'broke';
  actor?: Unit['id'];
  target?: Unit['id'];
  detail?: string;
  /** The second person in a two-person moment (the one who set it up, the partner, the one saved). */
  with?: Unit['id'];
}

/**
 * PRESENTATION CUES: what the screen should SHOW, in order, for everything that just happened.
 * Pure data for the view's choreographer (ui/battleFX); logic never reads them and building them
 * never draws from rng(), so headless runs are unchanged. `logAt` is the log length when the cue
 * was made, so the view can caption each beat with the lines it produced.
 */
type Id = number | string;
export type CueSpec =
  | { k: 'step'; u: Id; from: Spot; to: Spot }
  | { k: 'strike'; u: Id; t: Id; res: 'hit' | 'miss'; style: 'blade' | 'power' | 'shove' | 'pommel' | 'opportunity' | 'bite'; crit?: boolean; back?: boolean }
  | { k: 'shot'; u: Id; t: Id; res: 'hit' | 'miss'; kind: 'arrow' | 'frost' | 'magic' }
  | { k: 'intercept'; u: Id; t: Id }
  | { k: 'dmg'; t: Id; amt: number; res: 'hit' | 'dead' | 'down' | 'blocked'; how: string; hp: number }
  | { k: 'slide'; t: Id; from: Spot; to: Spot }
  | { k: 'bump'; t: Id; at: Spot }
  | { k: 'fall'; t: Id }
  | { k: 'anim'; u: Id; clip: string }
  | { k: 'spill'; from: Spot; tiles: Spot[] }
  | { k: 'throw'; u: Id; from: Spot; to: Spot; prop: string; effect: 'splash' | 'cloud' | 'fire' | 'hit' | 'miss' }
  | { k: 'fire'; at: Spot; oil?: boolean }
  | { k: 'douse'; at: Spot }
  | { k: 'heal'; t: Id; amt: number; hp: number }
  | { k: 'getup'; t: Id }
  | { k: 'free'; u: Id; t: Id }
  | { k: 'tether'; u: Id; t: Id }
  | { k: 'stance'; u: Id; what: 'guard' | 'aim' | 'ready' }
  | { k: 'say'; u: Id; t?: Id; text: string; ok: boolean; react: 'recoil' | 'turn' | 'anger' | 'shrug' | 'rally' | 'kneel' | 'none' }
  | { k: 'coins'; u: Id; t: Id; amt: number }
  | { k: 'yield'; t: Id }
  | { k: 'escape'; u: Id; to: Spot }
  | { k: 'icon'; u: Id; icon: '!' | '!!' | '?' | 'zzz' }
  | { k: 'hew'; u: Id; at: Spot; kind: string; left: number; max: number }
  | { k: 'topple'; at: Spot; dir: [number, number]; kind: string; log: Spot | null }
  | { k: 'piece'; id: string; dir: [number, number]; at: Spot };
export type Cue = CueSpec & { logAt: number };

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
  /** Who laid a foe open: follow-through credits the setter (docs 23). */
  setBy: { prone?: Unit['id']; exposed?: Unit['id']; stunned?: Unit['id'] };
  /** What they carry into the fight and can spend once (items.ts). */
  kit: Kit;
  /** Has this unit called out this turn (talk is free, once a turn)? */
  spoke: boolean;
  boon: Boon | null;
  burning: number; prone: boolean; exposed: boolean; defending: boolean; overwatch: boolean;
  /** Rounds left without a weapon in hand (disarm): blows land at half strength, no weapon arts. */
  disarmed: number;
  /** Holding ground: a foe that steps next to this unit must stop there (zone of control). */
  blocking: boolean;
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
  | { kind: 'hew'; prop: string; toward?: Spot }              // chop at a tree / smash wooden gear; a felled tree drops toward `toward`
  | { kind: 'throw'; prop: string; at: Spot }                 // a light prop (adjacent or carried)
  | { kind: 'hurl'; target: Unit['id'] }                     // throw your own weapon: a hit at range, then empty-handed
  | { kind: 'charge'; target: Unit['id'] }                   // a brute's straight-line rush: bowls them over (telegraphed)
  | { kind: 'pin'; target: Unit['id'] }                      // an archer's pinning shot: a lighter hit that slows
  | { kind: 'howl' }                                          // a pack leader: the pack steadies, the timid quail
  | { kind: 'item'; item: ItemId; target?: Unit['id']; at?: Spot }   // spend a consumable (items.ts)
  | { kind: 'ignite'; at: Spot }                              // needs a flame to hand
  | { kind: 'douse'; at: Spot }                               // needs water to hand
  | { kind: 'pickup'; prop: string }
  | { kind: 'grab'; target: Unit['id'] }
  | { kind: 'subdue'; target: Unit['id'] }
  | { kind: 'trip'; target: Unit['id'] }                     // sweep their legs: prone
  | { kind: 'disarm'; target: Unit['id'] }                   // knock the weapon away: weak blows a while
  | { kind: 'aid'; target: Unit['id'] }
  | { kind: 'free'; target: Unit['id'] }                      // cut a captive's bonds
  | { kind: 'guard'; target: Unit['id'] }
  | { kind: 'social'; verb: SocialVerb; target?: Unit['id']; claim?: Claim; subject?: Unit['id'] }
  | { kind: 'ready'; trigger: Trigger; response: Action }
  | { kind: 'use'; piece: string }                         // set off a set-piece (pieces.ts)
  | { kind: 'overwatch' } | { kind: 'defend' } | { kind: 'block' } | { kind: 'dash' } | { kind: 'escape' } | { kind: 'wait' };

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
  cues: Cue[] = [];
  /** What this fight is FOR (set by the scene): the AI and the run's objective check read these. */
  goals: { rescue?: Unit['id']; retrieve?: string; chief?: Unit['id']; spareChief?: boolean } = {};
  /** What every other unit has committed to doing next (intents.ts) — set as your turn begins. */
  intents = new Map<Unit['id'], Intent>();

  /** What people have called out (comms.ts): asks and announced plans, heard by those in earshot. */
  calls: Call[] = [];
  private callSeq = 0;
  /** How much a speaker's word is worth less after they said one thing and did another. */
  brokenWord = new Map<Unit['id'], number>();
  /** What each unit did on its last turn (to check it against what it said it would do). */
  private lastDeed = new Map<Unit['id'], { action: Action; at: Spot }>();

  /** Call out — free, once a turn. Everyone in earshot hears it, foes included. */
  speak(u: Unit, c: { to: Unit['id'][] | 'all'; kind: 'ask' | 'plan'; want: Want; words: string }): string | null {
    if (u.spoke) return 'you have already called out this turn';
    u.spoke = true;
    this.revealed.add(u.id);                                      // a shout gives you away
    const heardBy = this.active().filter((l) => hears(this, u, l)).map((l) => l.id);
    this.calls.push({ id: ++this.callSeq, from: u.id, ...c, round: this.round, heardBy, answered: [] });
    if (this.calls.length > 40) this.calls.splice(0, 10);
    this.cue({ k: 'say', u: u.id, text: c.words, ok: true, react: 'none' });
    this.note('social', `${this.nm(u, true)}: “${c.words}”`);
    return null;
  }

  /** Bonds between the people on our side (installed by the run; absent = level 0). */
  bonds = new Map<string, Bond>();
  bondOf(a: Unit, c: Unit): Bond { return this.bonds.get(pairKey(a.id, c.id)) ?? { lvl: 0, kind: 'friend' }; }

  /** The place's set-pieces (pieces.ts): usable once, by anyone in reach. */
  pieces = new Map<string, PieceState>();

  /** Install a set-piece; a solid one fills its tiles until it's used. */
  addPiece(def: PieceDef): PieceState {
    const p: PieceState = { ...def, used: false };
    this.pieces.set(p.id, p);
    if (p.solid) for (const [x, z] of p.at) { const t = this.map.tile(x, z); if (t) t.wall = true; }
    return p;
  }

  /** Consumables u could spend from `from`: mend yourself or a friend beside you, or throw at a foe / a spot. */
  private itemOptions(u: Unit, from: Spot): Action[] {
    const out: Action[] = [];
    const foes = this.foesOf(u);
    for (const id of Object.keys(u.kit) as ItemId[]) {
      if (!u.kit[id]) continue;
      const def = ITEMS[id];
      if (def.aim === 'mend') {
        for (const w of [u, ...this.friendsOf(u), ...this.downed(u.side)]) {
          if (w !== u && !this.adjacent(from, w)) continue;
          if (w.out === 'downed' || w.agent.fighter.health < TUNE.maxHealth * 0.75 || (id === 'draught' && w.burning > 0)) out.push({ kind: 'item', item: id, target: w.id });
        }
      } else if (def.aim === 'foe') {
        for (const f of foes) if (dist(from, f) <= def.range && dist(from, f) >= 1 && this.map.sees(from.x, from.z, f.x, f.z)) out.push({ kind: 'item', item: id, target: f.id });
      } else if (id === 'caltrops') {
        for (const [dx, dz] of DIRS) { const s = { x: from.x + dx, z: from.z + dz }; if (this.map.standable(s.x, s.z) && !this.unitAt(s.x, s.z) && !this.map.tile(s.x, s.z)!.caltrops) out.push({ kind: 'item', item: id, at: s }); }
      } else {
        // thrown at where the foes are (a handful of sensible spots, not every tile)
        for (const f of foes) if (dist(from, f) <= def.range && this.map.sees(from.x, from.z, f.x, f.z) && (id !== 'wolfsbane' || f.tactic === 'beast')) out.push({ kind: 'item', item: id, at: { x: f.x, z: f.z } });
      }
    }
    return out;
  }

  /** Spend one of what you carry (items.ts). */
  useItem(u: Unit, id: ItemId, t: Unit | undefined, at: Spot | undefined, fl = ''): void {
    if (!u.kit[id]) return;
    u.kit[id]!--;
    const def = ITEMS[id];
    const area = (c: Spot) => [[0, 0], ...DIRS, [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => this.map.tile(c.x + dx, c.z + dz)).filter((x): x is Tile => !!x);
    const nm = this.nm(u, true), v = (a: string, bb: string) => (u.agent.controlled ? a : bb);
    switch (id) {
      case 'bandage': case 'draught': {
        const w = t ?? u;
        this.cue({ k: 'anim', u: u.id, clip: 'Interact' });
        if (w.out === 'downed') { w.out = null; w.agent.fighter.health = id === 'draught' ? 35 : 18; this.cue({ k: 'getup', t: w.id }); this.ev('revive', u, w); this.note('move', `${nm} ${v('get', 'gets')} ${w === u ? 'back up' : `${this.nm(w)} back on their feet`} with ${def.name}${fl}.`); break; }
        const f = w.agent.fighter, before = f.health;
        f.health = Math.min(TUNE.maxHealth, f.health + (id === 'draught' ? 40 : 20));
        if (id === 'draught') w.burning = 0;
        this.cue({ k: 'heal', t: w.id, amt: Math.round(f.health - before), hp: f.health });
        this.note('move', `${nm} ${id === 'draught' ? v('drink', 'drinks') : v('bind', 'binds')} ${w === u ? (id === 'draught' ? 'a healing draught' : 'a wound') : `${this.nm(w)}'s wound`}${fl}.`);
        break;
      }
      case 'oilflask': case 'smokepot': case 'flash': case 'wolfsbane': {
        const c = at ?? (t ? { x: t.x, z: t.z } : { x: u.x, z: u.z });
        this.face(u, c);
        this.cue({ k: 'throw', u: u.id, from: { x: u.x, z: u.z }, to: c, prop: id === 'oilflask' ? 'oil' : 'flour', effect: id === 'oilflask' ? 'splash' : 'cloud' });
        const tiles = area(c);
        if (id === 'oilflask') {
          for (const x of tiles) if (!x.wall && x.ground !== 'water') x.oil = Math.max(x.oil, 4);
          this.note('env', `${nm} ${v('smash', 'smashes')} a flask of lamp oil${fl} — the ground is slick with it.`);
          if (tiles.some((x) => x.burning > 0) || tiles.some((x) => this.map.propAt(x.x, x.z)?.fireSource)) { const hot = tiles.find((x) => x.burning > 0 || this.map.propAt(x.x, x.z)?.fireSource)!; this.ignite(hot.x, hot.z, u, '', true); }
        } else if (id === 'smokepot') {
          for (const x of tiles) x.smoke = Math.max(x.smoke, 3);
          this.note('env', `${nm} ${v('smash', 'smashes')} a smoke pot${fl} — thick grey smoke rolls out.`);
        } else if (id === 'flash') {
          for (const x of tiles) x.smoke = Math.max(x.smoke, 1);
          const hit = this.active().filter((w) => w.side !== u.side && tiles.some((x) => x.x === w.x && x.z === w.z));
          for (const w of hit) { w.exposed = true; if (rng() < 0.35) w.stunned = true; }
          this.note('env', `${nm} ${v('throw', 'throws')} flash powder${fl} — a white burst${hit.length ? `: ${hit.map((w) => this.nm(w)).join(', ')} blinded` : ''}.`);
        } else {
          const beasts = this.active().filter((w) => w.side !== u.side && w.tactic === 'beast' && dist(w, c) <= 1);
          for (const w of beasts) { if (w.tags.has('chief')) w.morale = 'shaken'; else { w.morale = 'broken'; this.ev('broken', w); } this.cue({ k: 'icon', u: w.id, icon: '!!' }); }
          for (const x of tiles) x.smoke = Math.max(x.smoke, 1);
          this.note('env', `${nm} ${v('throw', 'throws')} burning wolfsbane${fl}${beasts.length ? ` — ${beasts.map((w) => this.nm(w)).join(', ')} ${beasts.length > 1 ? 'recoil' : 'recoils'} from the reek` : ''}.`);
        }
        break;
      }
      case 'caltrops': {
        const c = at ?? { x: u.x, z: u.z };
        const x = this.map.tile(c.x, c.z); if (x) x.caltrops = true;
        this.cue({ k: 'anim', u: u.id, clip: 'Interact' });
        this.note('move', `${nm} ${v('scatter', 'scatters')} caltrops${fl}.`);
        break;
      }
      case 'bola': {
        if (!t) break;
        this.face(u, t);
        const ok = check(u.sheet.finesse, 10 + t.sheet.finesse + (t.defending ? 2 : 0)).ok;
        this.cue({ k: 'throw', u: u.id, from: { x: u.x, z: u.z }, to: { x: t.x, z: t.z }, prop: 'rocks', effect: ok ? 'hit' : 'miss' });
        if (ok) { t.slowed = Math.max(t.slowed, 3); this.note('hit', `${nm} ${v('tangle', 'tangles')} ${this.nm(t)}'s legs with a bola${fl}!`); }
        else this.note('miss', `${nm}'s bola whirls past ${this.nm(t)}.`);
        break;
      }
    }
  }

  /**
   * A brute's charge at t: a straight run along a row or column, 2 to move+2 tiles, every tile
   * before t clear and no sudden climb. Returns the tiles it will cross (ending beside t), or null.
   */
  chargeLine(u: Unit, t: Unit): Spot[] | null {
    if (u.x !== t.x && u.z !== t.z) return null;
    const d = dist(u, t);
    if (d < 2 || d > u.move + 2) return null;
    const dx = Math.sign(t.x - u.x), dz = Math.sign(t.z - u.z);
    const out: Spot[] = [];
    let h = this.map.standH(u.x, u.z);
    for (let i = 1; i < d; i++) {
      const s = { x: u.x + dx * i, z: u.z + dz * i };
      if (!this.map.standable(s.x, s.z) || this.unitAt(s.x, s.z)) return null;
      const nh = this.map.standH(s.x, s.z); if (Math.abs(nh - h) > JUMP) return null; h = nh;
      out.push(s);
    }
    return out;
  }

  /** In the brush and no foe close enough to see you: archers and watchers can't find you. */
  hidden(t: Unit): boolean {
    return this.map.tile(t.x, t.z)?.ground === 'brush' && !this.foesOf(t).some((f) => dist(f, t) <= 1);
  }

  // ---- sight: each side sees only what its people can see (fog of war, stealth) ---------------
  /** Night (the run sets it from the stage): sight shrinks, unless you're near a flame. */
  dark = false;
  /** Who gave themselves away this turn (struck, threw, shouted): seen from anywhere in sight. */
  revealed = new Set<Unit['id']>();
  /** Where each side last saw each of the other side's people. */
  lastSeen = new Map<Side, Map<Unit['id'], { x: number; z: number; round: number }>>([['us', new Map()], ['them', new Map()]]);

  sightOf(v: Unit): number { return (this.dark ? 6 : 11) + (this.map.standH(v.x, v.z) >= 3 ? 2 : 0); }
  /** Near a fire, carrying one, or burning: seen as if by day. */
  lit(t: Unit): boolean { return t.burning > 0 || this.flameAt(t); }

  /** Does v see t right now? Next to you, always; brush and smoke hide; night shortens the look. */
  spots(v: Unit, t: Unit): boolean {
    if (v.out !== null && v.out !== 'downed') return false;
    const d = dist(v, t);
    if (d <= 1) return true;
    const tile = this.map.tile(t.x, t.z)!;
    const loud = this.revealed.has(t.id) || this.lit(t);
    if (!loud && (tile.ground === 'brush' || tile.smoke > 0)) return false;
    const range = this.dark && !loud ? this.sightOf(v) : Math.max(this.sightOf(v), 11);
    return d <= range && this.map.sees(v.x, v.z, t.x, t.z);
  }

  /** Does anyone on `side` see t? (A side shares what it sees — a spotter helps an archer.) */
  visibleTo(side: Side, t: Unit): boolean {
    if (t.side === side) return true;
    return this.units.some((v) => v.side === side && (v.out === null) && this.spots(v, t));
  }

  /** Update what each side last saw of the other. */
  refreshSight(): void {
    for (const side of ['us', 'them'] as Side[]) {
      const mem = this.lastSeen.get(side)!;
      for (const t of this.active()) if (t.side !== side && this.visibleTo(side, t)) mem.set(t.id, { x: t.x, z: t.z, round: this.round });
    }
  }
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
  add(agent: Agent, role: Role, at: Spot, extra: { tactic?: Tactic; traits?: Traits | null; tags?: string[]; bound?: boolean; kit?: Kit } = {}): Unit {
    const sheet = sheetOf(agent);
    const u: Unit = {
      id: agent.id, agent, side: role === 'foe' ? 'them' : 'us', role, sheet,
      x: at.x, z: at.z, facing: [0, 1], init: check(sheet.finesse, 0).total,
      move: 4 + (sheet.finesse >= 3 ? 1 : 0), out: null,
      moved: false, acted: false, reacted: false, setBy: {}, boon: null, spoke: false,
      burning: 0, prone: false, exposed: false, defending: false, overwatch: false, blocking: false, disarmed: 0, stunned: false, slowed: 0, shield: 0,
      morale: 'steady', guardedBy: null, tauntedBy: null, turnedOn: null, lastHitBy: null, carrying: null, readied: null, surprised: false,
      tactic: extra.tactic ?? (agent.faction === 'monster' ? 'beast' : role === 'foe' ? 'brute' : 'guardian'),
      traits: extra.traits ?? null, tags: new Set(extra.tags ?? []), bound: !!extra.bound,
      readyRound: new Map(), bluffHeat: 0, deathSaves: { ok: 0, fail: 0 }, loot: 0, kit: { ...(extra.kit ?? {}) },
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

  /** Is this unit's turn one the player decides? Only their own: companions always act for themselves. */
  playerControls(u: Unit): boolean {
    return u.role === 'player';
  }

  adjacent(a: Spot, b: Spot): boolean { return dist(a, b) === 1; }

  /**
   * Tiles the unit can reach this turn: Dijkstra over 4-neighbours; climbing ≤ JUMP levels per
   * step; mud/water cost double; friends can be passed through, foes block; can't stop on a unit.
   * A foe who is BLOCKING pins you: you may step next to them, but not on past them this turn.
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
        if (this.pinnedAt(nx, nz, u) || t.caltrops) q.pop();   // pinned by a blocker, or stopped dead by caltrops
      }
    }
    return out;
  }

  /** Is (x,z) next to a foe of u who is holding the ground (block)? */
  pinnedAt(x: number, z: number, u: Unit): boolean {
    return this.units.some((f) => f.blocking && f.out === null && f.side !== u.side && !f.stunned && dist(f, { x, z }) === 1);
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
      if (this.map.tile(t.x, t.z)!.ground === 'brush') { dc += 3; notes.push('in the brush'); }
      dc += Math.max(0, Math.floor((dist(from, t) - 4) / 2));
    } else if (dist(from, t) === 1) {
      if (a.tactic === 'beast' && !this.friendsOf(t).some((f) => f !== t && this.adjacent(f, t))) { dc -= 2; notes.push('isolated'); }
      const opp = this.unitAt(2 * t.x - from.x, 2 * t.z - from.z);
      if (opp && opp !== a && opp.side === a.side && opp.out === null) { dc -= this.bondOf(a, opp).lvl >= 2 ? 3 : 2; notes.push('pincered'); }
    }
    if (!this.visibleTo(t.side, a)) { dc -= 3; notes.push('unseen'); }         // an ambush: they never saw it coming
    const ft = this.followThrough(a, t);
    if (ft) notes.push(`following through (${this.nm(ft.by)})`);
    dc = Math.max(5, dc);
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
        if (u.out === null && u.agent.alive && !this.outcome && !spent) {
          if (this.playerControls(u)) telegraph(this);   // everyone else settles their next move — and shows it
          return;
        }
      }
      else if (u.out === 'downed' && u.role === 'player') this.deathSave(u);
      this.turn++;
      if (this.checkEnd()) return;
    }
    this.endRound();
  }

  private startTurn(u: Unit): void {
    u.defending = false; u.overwatch = false; u.blocking = false; u.moved = false; u.acted = false;
    this.revealed.delete(u.id);
    this.refreshSight();
    for (const o of this.units) if (o.boon && this.round > o.boon.until) o.boon = null;
    u.spoke = false;
    if (u.disarmed > 0) { u.disarmed--; if (u.disarmed === 0) this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'snatch' : 'snatches'} up a weapon again.`); }
    if (u.readied) { u.readied = null; }
    if (u.bound) { u.moved = true; u.acted = true; return; }
    if (u.surprised) { this.cue({ k: 'icon', u: u.id, icon: '?' }); u.surprised = false; u.moved = true; u.acted = true; this.note('info', `${this.nm(u, true)} ${u.agent.controlled ? 'are' : 'is'} caught off guard!`); return; }
    if (u.burning > 0) {
      this.wound(u.lastHitBy ?? u, u, 8, 'fire');
      u.burning--;
      if (u.out === null) this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'burn' : 'burns'}!`);
      if (u.role !== 'player' && u.out === null && u.morale === 'steady') u.morale = 'shaken';
    }
    if (u.stunned) { u.stunned = false; u.acted = true; u.moved = true; this.note('info', `${this.nm(u, true)} ${u.agent.controlled ? 'are' : 'is'} stunned and lose${u.agent.controlled ? '' : 's'} the turn.`); }
    if (u.prone && !u.stunned) {
      this.cue({ k: 'getup', t: u.id }); u.prone = false; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'get' : 'gets'} up.`); u.slowed = Math.max(u.slowed, 0); }
    if (u.stunned === false && u.acted && u.moved) { /* stunned turn */ }
  }

  /** The current unit has finished (player: End Turn; NPC: after its plan). */
  endTurn(u: Unit, facing?: Spot): void {
    if (this.current() !== u) return;
    // said you'd do one thing and did another: the ones who heard trust your word less
    for (const c of this.calls) {
      if (c.kind !== 'plan' || c.from !== u.id || c.round !== this.round || c.answered.includes(u.id)) continue;
      c.answered.push(u.id);
      const did = this.lastDeed.get(u.id);
      if (did && answers(c.want, did.action, did.at)) continue;
      this.brokenWord.set(u.id, (this.brokenWord.get(u.id) ?? 0) + 0.15);
      const heard = c.heardBy.map((id) => this.get(id)).filter((x): x is Unit => !!x && x.side === u.side && x.role === 'companion');
      for (const l of heard) this.ev('broke', u, l);
      if (heard.length) this.note('social', `${heard.map((l) => l.agent.name.split(' ')[0]).join(' and ')} ${heard.length > 1 ? 'notice' : 'notices'} — that wasn't what ${u.agent.controlled ? 'you' : this.nm(u)} said.`);
    }
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
      this.cue({ k: 'step', u: u.id, from: leaving, to: { x: step.x, z: step.z } });
      this.opportunity(u, leaving);
      if (u.out !== null) return null;
      this.overwatchFire(u);
      if (u.out !== null) return null;
      this.fireReadied(u, 'move');
      if (u.out !== null) return null;
      this.enterTile(u);
      if (u.out !== null) return null;
      this.refreshSight();
      const here = this.map.tile(u.x, u.z)!;
      if (here.caltrops) {
        here.caltrops = false;
        this.wound(u.lastHitBy ?? u, u, 6, 'caltrops');
        this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'step' : 'steps'} on caltrops and ${u.agent.controlled ? 'stop' : 'stops'} dead!`);
        return null;
      }
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
      this.cue({ k: 'icon', u: w.id, icon: '!' });
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
      this.strike(f, u, false, f.tactic === 'leader' || f.tactic === 'guardian' ? 1 : 0.7);
      if (u.out !== null) return;
    }
  }

  private overwatchFire(u: Unit): void {
    if (this.hidden(u)) return;                                   // moving through the brush unseen
    for (const f of this.foesOf(u)) {
      if (!this.spots(f, u)) continue;                           // can't fire on what you don't see
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
      case 'trip': { if (!t) return { p: 0, notes: [] }; const face = this.facingOf(from, t); return roll('finesse', 10 + Math.max(t.sheet.finesse, t.sheet.might) + (t.defending ? 2 : 0) - (face === 'back' ? 3 : face === 'side' ? 1 : 0), face !== 'front' ? [face === 'back' ? 'from behind' : 'flank'] : []); }
      case 'hurl': { if (!t) return { p: 0, notes: [] }; const h = this.hitDC(u, t, from, true); return roll('finesse', h.dc, h.notes); }
      case 'charge': { if (!t) return { p: 0, notes: [] }; const line = this.chargeLine(u, t); const h = this.hitDC(u, t, line ? line[line.length - 1] : from, false); return roll('might', h.dc - 1, ['charge', ...h.notes]); }
      case 'pin': { if (!t) return { p: 0, notes: [] }; const h = this.hitDC(u, t, from, true); return roll('finesse', h.dc, h.notes); }
      case 'item': { if (a.item === 'bola' && t) return roll('finesse', 10 + t.sheet.finesse + (t.defending ? 2 : 0)); return { p: 1, notes: [] }; }
      case 'disarm': { if (!t) return { p: 0, notes: [] }; return roll('finesse', 12 + t.sheet.might + (t.defending ? 2 : 0) - (t.prone ? 3 : 0), t.prone ? ['prone'] : []); }
      case 'aid': { const w = t ?? u; return w.out === 'downed' ? roll('finesse', 10) : ((u.agent.inventory as Record<string, number> | undefined)?.potion ?? 0) > 0 ? { p: 1, notes: ['potion'] } : roll('finesse', 11); }
      case 'social': return this.socialOdds(u, a, t);
      case 'use': { const p = this.pieces.get(a.piece); return p?.check ? roll(p.check.stat, p.check.dc) : { p: 1, notes: [] }; }
      default: return { p: 1, notes: [] };
    }
  }

  /** Every action this unit could take right now from where it stands (for UI buttons and AI). */
  options(u: Unit, from: Spot = u): Action[] {
    const out: Action[] = [];
    const foes = this.foesOf(u), friends = this.friendsOf(u);
    for (const f of foes) {
      if (!this.adjacent(from, f) && !this.visibleTo(u.side, f)) continue;   // can't aim at what no one on your side can see
      if (this.adjacent(from, f)) {
        out.push({ kind: 'attack', target: f.id }, { kind: 'shove', target: f.id }, { kind: 'subdue', target: f.id });
        if (!f.prone && f.tactic !== 'beast') out.push({ kind: 'trip', target: f.id });
        if (!f.disarmed && f.tactic !== 'beast') out.push({ kind: 'disarm', target: f.id });
      }
      if (!u.disarmed && u.tactic !== 'beast' && dist(from, f) >= 2 && dist(from, f) <= 4 && this.map.sees(from.x, from.z, f.x, f.z)) out.push({ kind: 'hurl', target: f.id });
      if (u.tactic === 'brute' && !u.moved && from.x === u.x && from.z === u.z && this.chargeLine(u, f)) out.push({ kind: 'charge', target: f.id });
      if (u.tactic === 'archer' && !u.disarmed && this.bestRanged(u) && dist(from, f) >= 2 && dist(from, f) <= this.rangedReach(u) && this.map.sees(from.x, from.z, f.x, f.z) && !this.hidden(f)) out.push({ kind: 'pin', target: f.id });
      if (this.adjacent(from, f)) {
        if ((f.agent.gold || 0) > 0 && !f.bound) out.push({ kind: 'grab', target: f.id });
      }
      for (const ab of u.agent.abilities?.values?.() ?? []) {
        if (u.disarmed > 0) continue;
        if ((u.readyRound.get(ab.id) ?? 0) > this.round || !ab.effects.some((e) => e.op === 'damage' || e.op === 'stun' || e.op === 'expose')) continue;
        const reach = Math.max(1, Math.ceil(ab.header.range / TILE));
        if (reach > 1 && dist(from, f) > 2 && this.hidden(f)) continue;       // can't shoot what you can't see
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
      if (u.tactic !== 'beast') out.push({ kind: 'aid', target: f.id });
      out.push(...(f.out === null ? [{ kind: 'guard', target: f.id } as Action] : []));
    }
    if (frac(u) < 1 && u.tactic !== 'beast') out.push({ kind: 'aid', target: u.id });
    for (const p of this.map.props.values()) {
      const d = dist(from, p);
      if (d === 1 && p.weight === 1) out.push({ kind: 'kick', prop: p.id }, { kind: 'shove', target: p.id });
      if (d === 1 && HEWABLE.includes(p.kind)) out.push({ kind: 'hew', prop: p.id });
      if (d <= 1 && p.weight === 0) out.push({ kind: 'pickup', prop: p.id });
      if (d <= 1 && p.weight === 0) for (const f of foes) if (dist(from, f) <= 5 && this.map.sees(from.x, from.z, f.x, f.z)) out.push({ kind: 'throw', prop: p.id, at: { x: f.x, z: f.z } });
    }
    if (u.carrying) for (const f of foes) if (dist(from, f) <= 5) out.push({ kind: 'throw', prop: u.carrying.id, at: { x: f.x, z: f.z } });
    if (this.flameAt(u, from)) for (const [dx, dz] of DIRS) { const t = this.map.tile(from.x + dx, from.z + dz); if (t && this.flammable(t.x, t.z)) out.push({ kind: 'ignite', at: { x: t.x, z: t.z } }); }
    if (this.waterAt(u, from)) for (const [dx, dz] of [[0, 0], ...DIRS]) { const t = this.map.tile(from.x + dx, from.z + dz); if (t && (t.burning || this.unitAt(t.x, t.z)?.burning)) out.push({ kind: 'douse', at: { x: t.x, z: t.z } }); }
    if (u.tactic === 'beast' && u.tags.has('chief') && (u.readyRound.get('howl') ?? 0) <= this.round) out.push({ kind: 'howl' });
    out.push(...this.itemOptions(u, from));
    for (const p of this.pieces.values()) if (!p.used && inReach(p, from) && (!p.needsFire || this.flameAt(u, from))) out.push({ kind: 'use', piece: p.id });
    out.push({ kind: 'defend' }, { kind: 'overwatch' }, { kind: 'block' }, { kind: 'social', verb: 'rally' }, { kind: 'social', verb: 'parley' });
    if (this.map.edge(from.x, from.z)) out.push({ kind: 'escape' });
    // beasts bite, shove and howl — they don't kick barrels, light fires, pull levers or carry kits
    if (u.tactic === 'beast') return out.filter((a) => !['kick', 'hew', 'pickup', 'throw', 'ignite', 'douse', 'use', 'item', 'grab', 'subdue', 'trip', 'disarm', 'hurl', 'social'].includes(a.kind) && !(a.kind === 'shove' && !this.get(a.target as Unit['id'])));
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
    this.lastDeed.set(u.id, { action: a, at: { x: u.x, z: u.z } });
    const before = new Map(this.units.map((x) => [x, [x.prone, x.exposed, x.stunned]] as const));
    const fl = flourish ? ` — "${flourish}"` : '';
    const t = 'target' in a && a.target != null ? this.get(a.target as Unit['id']) : undefined;
    if (t && t.side !== u.side) this.face(u, t);
    // a hostile act on someone who is being watched over: the watcher's readied response goes first
    if (t && t.side !== u.side && ['attack', 'ability', 'shove', 'grab', 'subdue'].includes(a.kind)) {
      this.fireReadied(u, 'attack', t);
      if (u.out !== null || !u.agent.alive || u.stunned) { this.checkEnd(); return null; }
    }
    switch (a.kind) {
      case 'ready': this.cue({ k: 'stance', u: u.id, what: 'ready' }); u.readied = { trigger: a.trigger, response: a.response, flourish }; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'wait' : 'waits'}, ready${fl}.`); break;
      case 'attack': this.strike(u, t!, false, 1, fl); break;
      case 'ability': { const spec = u.agent.abilities.get(a.abilityId); if (spec) this.useAbility(u, spec, t!); break; }
      case 'shove': t ? this.shoveUnit(u, t, fl) : this.shoveProp(u, this.map.props.get(String(a.target))!, fl); break;
      case 'kick': this.kick(u, this.map.props.get(a.prop)!, fl); break;
      case 'hew': this.hew(u, this.map.props.get(a.prop)!, a.toward, fl); break;
      case 'throw': this.throwProp(u, this.map.props.get(a.prop) ?? u.carrying!, a.at, fl); break;
      case 'ignite': this.ignite(a.at.x, a.at.z, u, fl); break;
      case 'douse': this.douse(a.at.x, a.at.z, u); break;
      case 'pickup': { const p = this.map.props.get(a.prop)!; u.carrying = p; this.cue({ k: 'anim', u: u.id, clip: 'PickUp' }); if (p.kind === 'relic') this.ev('relic', u); this.map.removeProp(p); this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'pick' : 'picks'} up ${p.name}.`); u.acted = false; break; }
      case 'grab': this.grab(u, t!); break;
      case 'subdue': this.subdue(u, t!); break;
      case 'trip': {
        const ok = check(u.sheet.finesse, 10 + Math.max(t!.sheet.finesse, t!.sheet.might) + (t!.defending ? 2 : 0) - (this.facingOf(u, t!) === 'back' ? 3 : this.facingOf(u, t!) === 'side' ? 1 : 0)).ok;
        this.cue({ k: 'strike', u: u.id, t: t!.id, res: ok ? 'hit' : 'miss', style: 'shove' });
        if (ok) { t!.prone = true; this.cue({ k: 'fall', t: t!.id }); this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'sweep' : 'sweeps'} ${this.nm(t!)}'s legs${fl} — down they go!`); this.ev('shove', u, t, 'trip'); }
        else this.note('miss', `${this.nm(t!, true)} ${t!.agent.controlled ? 'keep' : 'keeps'} ${t!.agent.controlled ? 'your' : 'their'} feet against ${this.nm(u)}'s trip.`);
        break;
      }
      case 'charge': {
        const line = this.chargeLine(u, t!) ?? [];
        u.moved = true;
        let stopped = false;
        for (const s of line) {
          const blocker = this.unitAt(s.x, s.z);
          if (blocker && blocker.out === null) {
            // someone stepped into the line: the charge breaks on them
            const braced = blocker.defending || blocker.blocking;
            this.cue({ k: 'bump', t: u.id, at: s });
            this.wound(u, blocker, braced ? 3 : 8, 'collision'); this.wound(blocker, u, braced ? 10 : 5, 'collision');
            if (braced) u.prone = true; else blocker.prone = true;
            this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'crash' : 'crashes'} into ${this.nm(blocker)}${braced ? ' — and breaks on the braced shield!' : ' and bowls them over!'}`);
            stopped = true; break;
          }
          const from0 = { x: u.x, z: u.z };
          this.face(u, s); u.x = s.x; u.z = s.z; this.place(u);
          this.cue({ k: 'step', u: u.id, from: from0, to: s });
          if (this.pinnedAt(s.x, s.z, u)) { this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'are' : 'is'} checked mid-charge.`); stopped = !this.adjacent(u, t!); break; }
        }
        if (!stopped && this.adjacent(u, t!) && u.out === null) {
          const h0 = t!.agent.fighter.health;
          this.strike(u, t!, false, 1.3, fl);
          if (t!.out === null && t!.agent.fighter.health < h0) { t!.prone = true; this.note('hit', `${this.nm(t!, true)} ${t!.agent.controlled ? 'are' : 'is'} bowled over by the charge!`); }
        }
        break;
      }
      case 'pin': {
        const h = this.hitDC(u, t!, u, true);
        const r = check(u.sheet.finesse, h.dc);
        this.cue({ k: 'shot', u: u.id, t: t!.id, res: r.ok ? 'hit' : 'miss', kind: 'arrow' });
        if (!r.ok) { this.note('miss', `${this.nm(u, true)}'s pinning shot at ${this.nm(t!)} goes wide.`); break; }
        const res = this.wound(u, t!, TUNE.damage * 0.55);
        t!.slowed = Math.max(t!.slowed, 2);
        this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'pin' : 'pins'} ${this.nm(t!)} with an arrow${fl} — slowed${this.fellText(t!, res)}.`);
        break;
      }
      case 'howl': {
        u.readyRound.set('howl', this.round + 3);
        this.cue({ k: 'say', u: u.id, text: '(a long, rising howl)', ok: true, react: 'none' });
        for (const w of this.active()) if (w.side === u.side && w.tactic === 'beast' && dist(w, u) <= 8) w.morale = 'steady';
        const quail = this.active().filter((x) => x.side !== u.side && x.role !== 'player' && dist(x, u) <= 6 && (x.traits ? x.traits.bravery < 0.45 : x.sheet.nerve < 2) && x.morale === 'steady');
        for (const x of quail) x.morale = 'shaken';
        this.note('social', `${this.nm(u, true)} howls — the pack steadies${quail.length ? `, and ${quail.map((x) => this.nm(x)).join(', ')} ${quail.length > 1 ? 'quail' : 'quails'}` : ''}.`);
        break;
      }
      case 'hurl': {
        const h = this.hitDC(u, t!, u, true);
        const r = check(u.sheet.finesse, h.dc);
        this.cue({ k: 'throw', u: u.id, from: { x: u.x, z: u.z }, to: { x: t!.x, z: t!.z }, prop: 'weapon', effect: r.ok ? 'hit' : 'miss' });
        u.disarmed = 2;                                    // it's over there now
        if (!r.ok) { this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'hurl' : 'hurls'} a weapon at ${this.nm(t!)}${fl} — wide, and now empty-handed.`); break; }
        const res = this.wound(u, t!, TUNE.damage * (0.8 + 0.08 * u.sheet.might) * (r.crit ? 1.5 : 1));
        this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'hurl' : 'hurls'} a weapon into ${this.nm(t!)}${fl}${this.fellText(t!, res)} — empty-handed now.`);
        break;
      }
      case 'disarm': {
        const ok = check(u.sheet.finesse, 12 + t!.sheet.might + (t!.defending ? 2 : 0) - (t!.prone ? 3 : 0)).ok;
        this.cue({ k: 'strike', u: u.id, t: t!.id, res: ok ? 'hit' : 'miss', style: 'pommel' });
        if (ok) { t!.disarmed = 2; this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'knock' : 'knocks'} the weapon from ${this.nm(t!)}'s hand${fl}!`); }
        else this.note('miss', `${this.nm(t!, true)} ${t!.agent.controlled ? 'keep' : 'keeps'} a grip on ${t!.agent.controlled ? 'your' : 'their'} weapon.`);
        break;
      }
      case 'aid': this.aid(u, t ?? u); break;
      case 'free':
        if (t && t.bound) { t.bound = false; this.ev('free', u, t); this.cue({ k: 'free', u: u.id, t: t.id }); this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'cut' : 'cuts'} ${this.nm(t)} free!`); }
        break;
      case 'guard': this.ev('guard', u, t); this.cue({ k: 'tether', u: u.id, t: t!.id }); t!.guardedBy = u; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'cover' : 'covers'} ${this.nm(t!)}.`); break;
      case 'defend': this.cue({ k: 'stance', u: u.id, what: 'guard' }); u.defending = true; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'brace' : 'braces'}.`); break;
      case 'block': this.cue({ k: 'stance', u: u.id, what: 'guard' }); u.blocking = true; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'dig in' : 'digs in'}, blocking the way — no one gets past${fl}.`); break;
      case 'overwatch': this.cue({ k: 'stance', u: u.id, what: 'aim' }); u.overwatch = true; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'hold' : 'holds'}, watching.`); break;
      case 'escape':
        u.out = 'fled'; this.release(u); this.ev(u.tags.has('captive') ? 'rescued' : 'escape', u, undefined, u.carrying?.kind);
        this.cue({ k: 'escape', u: u.id, to: { x: u.x + (u.x === 0 ? -3 : u.x === this.map.n - 1 ? 3 : 0), z: u.z + (u.z === 0 ? -3 : u.z === this.map.n - 1 ? 3 : 0) } });
        this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'slip' : 'slips'} away from the fight${u.carrying ? ` with ${u.carrying.name}` : ''}.`); break;
      case 'social': this.social(u, a, t, fl); break;
      case 'use': { const p = this.pieces.get(a.piece); if (p && !p.used) this.usePiece(u, p, fl); break; }
      case 'item': this.useItem(u, a.item, t, a.at, fl); break;
      case 'wait': break;
    }
    // giving yourself away: a strike, a throw — seen from anywhere in sight until your next turn
    if (!['defend', 'overwatch', 'block', 'wait', 'ready', 'pickup', 'dash', 'escape', 'free', 'aid', 'guard'].includes(a.kind) && !(a.kind === 'item' && (a.item === 'bandage' || a.item === 'draught' || a.item === 'caltrops'))) this.revealed.add(u.id);
    this.refreshSight();
    for (const [x, [pr, ex, st]] of before) {
      if (x.side === u.side) continue;
      if (x.prone && !pr) x.setBy.prone = u.id; if (!x.prone) delete x.setBy.prone;
      if (x.exposed && !ex) x.setBy.exposed = u.id; if (!x.exposed) delete x.setBy.exposed;
      if (x.stunned && !st) x.setBy.stunned = u.id; if (!x.stunned) delete x.setBy.stunned;
    }
    this.checkEnd();
    return null;
  }

  /** A foe someone ELSE on your side laid open: the follow-through (docs 23). */
  followThrough(u: Unit, t: Unit): { mul: number; by: Unit; state: 'stunned' | 'prone' | 'exposed' } | null {
    for (const st of ['stunned', 'prone', 'exposed'] as const) {
      if (!t[st]) continue;
      const id = t.setBy[st]; const by = id != null ? this.get(id) : undefined;
      if (!by || by === u || by.side !== u.side) continue;
      return { mul: 1.2 + 0.05 * this.bondOf(u, by).lvl, by, state: st };
    }
    return null;
  }


  // ---- resolution helpers -------------------------------------------------------------------

  private strike(u: Unit, t: Unit, _ranged: boolean, mul: number, fl = ''): void {
    if (t.guardedBy && t.guardedBy.out === null && t.guardedBy !== u && this.adjacent(t.guardedBy, t) && rng() < 0.5) {
      this.cue({ k: 'intercept', u: t.guardedBy.id, t: t.id });
      this.note('move', `${this.nm(t.guardedBy, true)} ${t.guardedBy.agent.controlled ? 'step' : 'steps'} in front of ${this.nm(t)}.`);
      t = t.guardedBy;
    }
    this.swing(u);
    const h = this.hitDC(u, t, u, false);
    const r = check(u.sheet.might + this.trickMod(fl, false) + (u.boon?.kind === 'wrath' ? 1 : 0), h.dc);
    const style = mul < 0.8 ? 'opportunity' : u.tactic === 'beast' ? 'bite' : 'blade';
    this.cue({ k: 'strike', u: u.id, t: t.id, res: r.ok ? 'hit' : 'miss', style, crit: r.crit, back: this.facingOf(u, t) === 'back' });
    if (!r.ok) { this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'swing' : 'swings'} at ${this.nm(t)}${fl} — and ${u.agent.controlled ? 'miss' : 'misses'}.`); return; }
    const back = this.facingOf(u, t) === 'back';
    let dmg = TUNE.damage * (0.75 + 0.08 * u.sheet.might) * (0.85 + rng() * 0.3) * mul * (u.disarmed > 0 ? 0.5 : 1);
    const ft = this.followThrough(u, t);
    let k = 1;
    if (r.crit || (back && rng() < 0.35)) k *= 1.5;
    if (t.exposed) { k *= 1.5; t.exposed = false; }
    if (ft) { k *= ft.mul; this.ev('combo', u, t, ft.state, ft.by); }
    dmg *= Math.min(k, 2.2);
    const res = this.wound(u, t, dmg);
    if (u.tactic === 'beast' && t.out === null && !t.prone && this.active().some((w) => w !== u && w.side === u.side && w.tactic === 'beast' && this.adjacent(w, t))) { t.prone = true; this.note('hit', `The pack drags ${this.nm(t)} down!`); }
    this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'hit' : 'hits'} ${this.nm(t)}${back ? ' from behind' : ''}${fl}${r.crit ? ' — critical!' : ''}${ft ? ` — following through on ${this.nm(ft.by)}'s opening` : ''}${this.fellText(t, res)}.`);
  }

  private useAbility(u: Unit, spec: NonNullable<ReturnType<Agent['abilities']['get']>>, t: Unit): void {
    u.readyRound.set(spec.id, this.round + Math.max(1, Math.ceil((spec.header.cooldown || 0) / 3)));
    const ranged = spec.header.range > 3;
    const area = spec.header.area;
    const r0 = 'r' in area ? Math.round(area.r / TILE) : 0;
    const targets = r0 > 0 ? this.foesOf(u).filter((f) => dist(f, t) <= r0) : [t];
    this.swing(u);
    const parts: string[] = [];
    const tags = spec.effects.flatMap((e) => e.tags || []);
    const shotKind = tags.includes('FROST') ? 'frost' : tags.includes('PIERCE') || spec.id === 'shortbow' ? 'arrow' : 'magic';
    for (const tt of targets) {
      const ft = this.followThrough(u, tt);
      const h = this.hitDC(u, tt, u, ranged);
      const r = check(Math.max(u.sheet.might, u.sheet.presence) + 1, h.dc);
      if (ranged) this.cue({ k: 'shot', u: u.id, t: tt.id, res: r.ok ? 'hit' : 'miss', kind: shotKind });
      else this.cue({ k: 'strike', u: u.id, t: tt.id, res: r.ok ? 'hit' : 'miss', style: 'power', crit: r.crit });
      if (!r.ok) { parts.push(`${this.nm(tt)} evades`); continue; }
      let fell = false;
      for (const e of spec.effects) {
        if (e.when && e.when !== 'on_hit') continue;
        if (e.op === 'damage') {
          const k = Math.min(2.2, (r.crit ? 1.5 : 1) * (tt.exposed ? 1.5 : 1) * (ft ? ft.mul : 1));
          if (ft) this.ev('combo', u, tt, ft.state, ft.by);
          const res = this.wound(u, tt, (e.amount || TUNE.damage) * k); tt.exposed = false;
          if (res === 'dead' || tt.out) { fell = true; break; }
        }
        else if (e.op === 'stun') tt.stunned = true;
        else if (e.op === 'slow') tt.slowed = 2;
        else if (e.op === 'expose') tt.exposed = true;
        else if (e.op === 'knockback') this.push(tt, this.dirFrom(u, tt), 1, u);
        else (EFFECTS as Record<string, (e: unknown, a: Agent, t: Agent | null, c: unknown) => boolean>)[e.op]?.(e, u.agent, tt.agent, { time: this.session.sim.time });
      }
      parts.push(fell ? `${this.nm(tt)} falls` : `${this.nm(tt)} is hit`);
    }
    if (!targets.length || spec.effects.every((e) => e.op === 'heal' || e.op === 'shield')) {
      for (const e of spec.effects) if (e.op === 'heal') { u.agent.fighter.health = Math.min(TUNE.maxHealth, u.agent.fighter.health + e.amount); this.cue({ k: 'heal', t: u.id, amt: e.amount, hp: u.agent.fighter.health }); }
      if (!spec.effects.some((e) => e.op === 'heal')) this.cue({ k: 'anim', u: u.id, clip: 'Spellcast_Raise' });
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
    this.cue({ k: 'strike', u: u.id, t: t.id, res: r.ok ? 'hit' : 'miss', style: 'shove' });
    if (!r.ok) { this.note('miss', `${this.nm(t, true)} ${t.agent.controlled ? 'hold' : 'holds'} firm against ${this.nm(u)}'s shove.`); return; }
    this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'shove' : 'shoves'} ${this.nm(t)}${fl}!`);
    this.push(t, this.dirFrom(u, t), r.crit ? 2 : 1, u);
  }

  private shoveProp(u: Unit, p: Prop, fl: string): void {
    const r = check(u.sheet.might, p.kind === 'cart' ? 13 : 9);
    this.cue({ k: 'anim', u: u.id, clip: 'Block_Attack' });
    if (!r.ok) { this.note('miss', `${p.name} won't budge.`); return; }
    const d = this.dirFrom(u, p);
    this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'heave' : 'heaves'} ${p.name}${fl}.`);
    this.slideProp(p, d, p.kind === 'barrel' || p.kind === 'oil' ? 4 : 2, u);
  }

  /** Set off a set-piece: roll if it asks for one, then its effects in order (pieces.ts). */
  usePiece(u: Unit, p: PieceState, fl = ''): void {
    const anchor = { x: p.at[0][0], z: p.at[0][1] };
    this.face(u, anchor);
    if (p.check && !check(u.sheet[p.check.stat], p.check.dc).ok) {
      this.cue({ k: 'anim', u: u.id, clip: 'Block_Attack' });
      this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'strain' : 'strains'} at ${p.name}${fl} — it holds, for now.`);
      return;
    }
    p.used = true;
    this.cue({ k: 'anim', u: u.id, clip: dist(u, anchor) > 1 ? 'Throw' : 'Interact' });
    this.cue({ k: 'piece', id: p.id, dir: this.dirFrom(u, anchor), at: anchor });
    if (p.solid) for (const [x, z] of p.at) { const t = this.map.tile(x, z); if (t) t.wall = false; }
    this.ev('piece', u, undefined, p.id);
    this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'go' : 'goes'} for ${p.name}${fl} — ${p.says}`);
    const inB = (s: Spot) => !!this.map.tile(s.x, s.z);
    const body = (s: Spot) => { const w = this.unitAt(s.x, s.z); return !!w && w.out === null && w !== u; };
    for (const e of p.effects) {
      if (e.do === 'shake') {
        for (const f of this.foesOf(u)) {
          if (dist(f, anchor) > e.r) continue;
          f.overwatch = false; f.readied = null;
          if (f.role !== 'player' && f.morale === 'steady' && !f.tags.has('chief')) f.morale = 'shaken';
          this.cue({ k: 'icon', u: f.id, icon: '!!' });
        }
        continue;
      }
      const tiles = areaTiles(p, e.area, u, inB, body);
      for (const s of tiles) {
        const t = this.map.tile(s.x, s.z)!;
        switch (e.do) {
          case 'hit': {
            const v = this.unitAt(s.x, s.z);
            if (!v || v.out !== null || v === u) break;
            this.wound(u, v, e.dmg, 'crushed');
            if (e.prone) v.prone = true;
            if (e.expose) v.exposed = true;
            if (e.shake && v.role !== 'player' && v.morale === 'steady') v.morale = 'shaken';
            break;
          }
          case 'ignite': this.ignite(s.x, s.z, u, '', true); break;
          case 'flood': {
            t.ground = 'water'; t.burning = 0; t.wet = Math.max(t.wet, 2);
            const pr = this.map.propAt(s.x, s.z); if (pr) pr.burning = 0;
            const v = this.unitAt(s.x, s.z); if (v) v.burning = 0;
            this.cue({ k: 'douse', at: s });
            break;
          }
          case 'breach': t.wall = false; break;
          case 'drop': if (!t.wall && !this.map.propAt(s.x, s.z) && !this.unitAt(s.x, s.z)) this.map.addProp(e.prop, s.x, s.z); break;
          case 'smoke': t.smoke = Math.max(t.smoke, e.turns); break;
        }
      }
    }
  }

  /** Damage a blow does to wood (no roll: a tree doesn't dodge). */
  hewDamage(u: Unit): number { return Math.round(TUNE.damage * (0.75 + 0.08 * u.sheet.might)); }

  /**
   * Chop at a tree or smash wooden gear. A tree takes a few blows (its damage persists between
   * turns); when it goes it falls — away from you, or toward `toward` (a neighbouring tile of the
   * trunk) — crushing whoever stands in the fall line, and leaves a log: half cover you can climb.
   */
  private hew(u: Unit, p: Prop, toward: Spot | undefined, fl: string): void {
    const dmg = this.hewDamage(u);
    const max = p.kind === 'tree' ? 60 : 20;
    p.hp = Math.max(0, Math.min(p.hp, max) - dmg);
    this.face(u, p);
    this.cue({ k: 'hew', u: u.id, at: { x: p.x, z: p.z }, kind: p.kind, left: p.hp, max });
    if (p.hp > 0) {
      const blows = Math.ceil(p.hp / dmg);
      this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'hack' : 'hacks'} at ${p.name}${fl} — ${blows} more blow${blows === 1 ? '' : 's'}.`);
      return;
    }
    this.map.removeProp(p);
    if (p.kind !== 'tree') {
      this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'smash' : 'smashes'} ${p.name} to kindling${fl}.`);
      return;
    }
    // which way it falls: toward the named side if that's a neighbour of the trunk, else away from the axe
    let d: [number, number] = this.dirFrom(u, p);
    if (toward && Math.abs(toward.x - p.x) + Math.abs(toward.z - p.z) >= 1) d = this.dirFrom(p, toward);
    const crushed: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const v = this.unitAt(p.x + d[0] * i, p.z + d[1] * i);
      if (v && v.out === null && v !== u) { this.wound(u, v, 18, 'crushed'); v.prone = true; crushed.push(this.nm(v)); }
    }
    const lx = p.x + d[0], lz = p.z + d[1];
    const spot = this.map.tile(lx, lz) && !this.map.tile(lx, lz)!.wall && !this.map.propAt(lx, lz) ? { x: lx, z: lz } : { x: p.x, z: p.z };
    const log = this.map.addProp('log', spot.x, spot.z);
    log.name = 'a felled trunk';
    this.cue({ k: 'topple', at: { x: p.x, z: p.z }, dir: d, kind: p.kind, log: spot });
    this.ev('fell', u, undefined, crushed.join(','));
    this.note('env', `${this.nm(u, true)} ${u.agent.controlled ? 'fell' : 'fells'} ${p.name}${fl} — timber!${crushed.length ? ` It comes down on ${crushed.join(' and ')}.` : ''} A trunk lies there now: half cover.`);
  }

  private kick(u: Unit, p: Prop, fl: string): void {
    const d = this.dirFrom(u, p);
    this.cue({ k: 'anim', u: u.id, clip: 'Unarmed_Melee_Attack_Kick' });
    if (p.kind === 'brazier') {
      const tiles: Spot[] = [];
      for (let i = 0; i < 4; i++) if (this.map.tile(p.x + d[0] * i, p.z + d[1] * i)) tiles.push({ x: p.x + d[0] * i, z: p.z + d[1] * i });
      this.cue({ k: 'spill', from: { x: p.x, z: p.z }, tiles });
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
    this.cue({ k: 'throw', u: u.id, from: { x: u.x, z: u.z }, to: { x: at.x, z: at.z }, prop: p.kind, effect: !hit ? 'miss' : p.liquid ? 'splash' : p.blinding ? 'cloud' : p.fireSource ? 'fire' : 'hit' });
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
    this.cue({ k: 'anim', u: u.id, clip: 'Interact' });
    if (!r.ok || purse <= 0) { this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'grab' : 'grabs'} at ${t.agent.controlled ? 'your' : this.nm(t) + "'s"} purse and ${purse > 0 ? 'misses' : 'finds it empty'}.`); return; }
    const amt = Math.min(purse, Math.round(6 + u.sheet.finesse * 3 + rng() * 10));
    t.agent.gold -= amt; u.agent.gold = (u.agent.gold || 0) + amt; u.loot += amt;   // a transfer, never a mint
    this.ev('grab', u, t, String(amt));
    this.cue({ k: 'coins', u: u.id, t: t.id, amt });
    this.note('social', `${this.nm(u, true)} ${u.agent.controlled ? 'cut' : 'cuts'} ${t.agent.controlled ? 'your' : this.nm(t) + "'s"} purse — ${amt} gold.`);
  }

  private subdue(u: Unit, t: Unit): void {
    this.swing(u);
    const h = this.hitDC(u, t, u, false);
    const sOk = check(u.sheet.might, h.dc + 2).ok;
    this.cue({ k: 'strike', u: u.id, t: t.id, res: sOk ? 'hit' : 'miss', style: 'pommel' });
    if (!sOk) { this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'try' : 'tries'} to pin ${this.nm(t)} and ${u.agent.controlled ? 'fail' : 'fails'}.`); return; }
    const dmg = TUNE.damage * 0.5;
    if (hpOf(t) - dmg <= TUNE.maxHealth * 0.25) { this.yieldTo(u, t); return; }
    this.wound(u, t, dmg);
    this.note('hit', `${this.nm(u, true)} ${u.agent.controlled ? 'batter' : 'batters'} ${this.nm(t)} with the flat of the blade.`);
  }

  private yieldTo(u: Unit, t: Unit): void {
    t.out = 'yielded'; this.release(t);
    this.ev('yield', u, t);
    this.cue({ k: 'yield', t: t.id });
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
      this.cue({ k: 'anim', u: u.id, clip: 'Interact' });
      if (check(u.sheet.finesse, 10).ok) { this.cue({ k: 'getup', t: w.id }); this.ev('revive', u, w); w.out = null; w.deathSaves = { ok: 0, fail: 0 }; w.agent.fighter.health = 15 + u.sheet.finesse * 3; this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'haul' : 'hauls'} ${this.nm(w)} back up.`); }
      else this.note('miss', `${this.nm(u, true)} can't rouse ${this.nm(w)}.`);
      return;
    }
    if (inv && (inv.potion || 0) >= 1) { inv.potion -= 1; w.agent.fighter.health = Math.min(TUNE.maxHealth, hpOf(w) + 45); this.cue({ k: 'anim', u: u.id, clip: 'Use_Item' }); this.cue({ k: 'heal', t: w.id, amt: 45, hp: w.agent.fighter.health }); this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'pour' : 'pours'} a potion into ${w === u ? (u.agent.controlled ? 'yourself' : 'themself') : this.nm(w)}.`); return; }
    this.cue({ k: 'anim', u: u.id, clip: 'Interact' });
    if (check(u.sheet.finesse, 11).ok) { w.agent.fighter.health = Math.min(TUNE.maxHealth, hpOf(w) + 12 + u.sheet.finesse * 2); this.cue({ k: 'heal', t: w.id, amt: 12 + u.sheet.finesse * 2, hp: w.agent.fighter.health }); this.note('move', `${this.nm(u, true)} ${u.agent.controlled ? 'bind' : 'binds'} a wound.`); }
    else this.note('miss', `${this.nm(u, true)} ${u.agent.controlled ? 'fumble' : 'fumbles'} the bandage.`);
  }

  private socialOdds(u: Unit, a: Extract<Action, { kind: 'social' }>, t?: Unit): { p: number; notes: string[] } {
    const b = t ? t.agent.beliefs.get(u.id) : undefined;
    switch (a.verb) {
      case 'intimidate': {
        if (!t) return { p: 0, notes: [] };
        const fire = t.tactic === 'beast' && this.flameAt(u);            // beasts fear a brandished flame
        return { p: chance(u.sheet.presence, 10 + t.sheet.nerve + (t.morale === 'steady' ? 1 : -2) - Math.round((b?.notoriety || 0) * 4) - (frac(t) < 0.4 ? 2 : 0) - (fire ? 5 : 0)), notes: fire ? ['fire in hand −5'] : [] };
      }
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
    {
      const pick = (xs: string[]) => xs[(this.round + (t ? String(t.id).length : 0)) % xs.length];
      const subj = a.subject != null ? this.get(a.subject) : undefined;
      const line = fl ? fl.replace(/^ — "/, '').replace(/"$/, '')
        : a.verb === 'intimidate' ? pick(['Run, or die where you stand!', "Look at me. You're next."])
        : a.verb === 'taunt' ? pick(["Is that all you've got?", 'Come on, then!'])
        : a.verb === 'rally' ? pick(['With me! Hold the line!', 'Stand together!'])
        : a.verb === 'parley' ? (u.side === 'them' ? 'Mercy! I yield!' : 'Enough! Lay down your arms!')
        : a.claim === 'turncoat' && subj ? `${subj.agent.name.split(' ')[0]} sold you out!`
        : a.claim === 'reinforcements' ? 'The Watch is right behind us!' : 'Behind you!';
      const react = !ok ? 'shrug' : a.verb === 'intimidate' || a.claim === 'reinforcements' ? 'recoil' : a.verb === 'taunt' ? 'anger'
        : a.verb === 'bluff' ? 'turn' : a.verb === 'rally' ? 'rally' : a.verb === 'parley' ? 'kneel' : 'none';
      this.cue({ k: 'say', u: u.id, t: t?.id, text: line, ok, react });
    }
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
          for (const f of this.active().filter((x) => x.side === 'them')) { f.out = 'yielded'; this.release(f); this.ev('yield', u, f, 'surrender'); this.cue({ k: 'yield', t: f.id }); }
          this.note('social', `${who} throws down their weapon and begs for terms${fl}. ${u.tags.has('chief') ? 'The band surrenders.' : ''}`);
        } else if (ok) {
          for (const f of this.foesOf(u)) { const b = f.agent.beliefs.get(u.id); if (b) { b.hostile = false; b.standing = Math.max(b.standing, -0.3); } f.out = 'yielded'; this.release(f); this.ev('parley', u, f); this.cue({ k: 'yield', t: f.id }); }
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
    return t.ground === 'grass' || t.ground === 'brush' || t.ground === 'mud' || t.oil > 0 || !!(p && p.flammable);
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
    this.cue({ k: 'fire', at: { x, z }, oil: p?.kind === 'oil' });
    if (p && p.flammable) p.burning = Math.max(p.burning, p.kind === 'oil' ? 1 : 3);
    t.burning = Math.max(t.burning, p?.kind === 'hay' ? 3 : 2);
    if (p?.kind === 'oil') {
      // lamp oil: the barrel bursts and the whole neighbourhood goes up
      this.map.removeProp(p);
      for (const [dx, dz] of DIRS) { const n = this.map.tile(x + dx, z + dz); if (n && n.ground !== 'water') { n.burning = Math.max(n.burning, 2); } }
      for (const u of this.active()) if (dist(u, { x, z }) <= 1) { this.wound(by ?? u, u, 14, 'fire'); u.burning = 2; }
      this.note('env', `The oil barrel bursts into flame!`);
    }
    // a spilled-oil slick goes up all at once, and whoever stands in it
    if (t.oil > 0) {
      const slick: Tile[] = [], seen = new Set<string>(), q = [t];
      while (q.length) { const c = q.pop()!; const k = key(c.x, c.z); if (seen.has(k)) continue; seen.add(k); if (c.oil <= 0) continue; slick.push(c); for (const [dx, dz] of DIRS) { const n = this.map.tile(c.x + dx, c.z + dz); if (n) q.push(n); } }
      for (const c of slick) { c.oil = 0; c.burning = Math.max(c.burning, 3); this.cue({ k: 'fire', at: { x: c.x, z: c.z }, oil: true }); const w = this.unitAt(c.x, c.z); if (w && w.out === null) { this.wound(by ?? w, w, 10, 'fire'); w.burning = 2; } }
      this.note('env', `The spilled oil goes up with a whoomp!`);
    }
    const u = this.unitAt(x, z);
    if (u && u.burning === 0) { u.burning = 2; if (by) u.lastHitBy = by; }
    if (by) this.ev('ignite', by, u, p?.kind ?? 'ground');
    if (!silent && by) this.note('env', `${this.nm(by, true)} ${by.agent.controlled ? 'set' : 'sets'} ${p ? p.name : 'the ground'} alight${fl}.`);
  }

  douse(x: number, z: number, by?: Unit): void {
    this.cue({ k: 'douse', at: { x, z } });
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
      if (t.burning > 0) { t.burning--; if (t.burning === 0 && (t.ground === 'grass' || t.ground === 'brush')) t.ground = 'ash'; }
      if (t.smoke > 0) t.smoke--;
      if (t.wet > 0) t.wet--;
      if (t.oil > 0) t.oil--;
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
        this.cue({ k: 'bump', t: t.id, at: { x: nx, z: nz } });
        this.wound(by, t, 7, 'collision'); t.prone = true;
        if (other && other.out === null) { this.wound(by, other, 5, 'collision'); other.prone = true; }
        const what = !tile ? 'the edge' : other ? this.nm(other) : this.map.propAt(nx, nz)?.name ?? 'the wall';
        this.note('env', `${this.nm(t, true)} ${t.agent.controlled ? 'slam' : 'slams'} into ${what}.`);
        return;
      }
      const drop = hereH - this.map.standH(nx, nz);
      const from = { x: t.x, z: t.z };
      t.x = nx; t.z = nz; this.place(t);
      this.cue({ k: 'slide', t: t.id, from, to: { x: nx, z: nz } });
      if (drop > FALL_SAFE) this.cue({ k: 'fall', t: t.id });
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
  wound(by: Unit, t: Unit, amount: number, _how = 'blow', redirected = false): 'hit' | 'dead' | 'blocked' {
    const f = t.agent.fighter;
    if (!f.alive) return 'dead';
    let dmg = Math.max(1, Math.round(amount));
    if (t.shield > 0) { const s = Math.min(t.shield, dmg); t.shield -= s; dmg -= s; if (dmg <= 0) return 'blocked'; }
    // DIVE IN: a lethal blow on one of us, and a friend beside them who would take it (docs 23)
    if (!redirected && t.side === 'us' && dmg >= f.health && by !== t) {
      const w = this.diver(t, by);
      if (w) {
        w.reacted = true;
        this.cue({ k: 'intercept', u: w.id, t: t.id });
        this.note('hit', `${this.nm(w, true)} ${w.agent.controlled ? 'dive' : 'dives'} in front of the blow meant for ${this.nm(t)}!`);
        this.ev('save', w, t, _how, t);
        return this.wound(by, w, amount * 0.8, _how, true);
      }
    }
    t.lastHitBy = by;
    if (t.side === 'us' && dmg >= f.health && this.active().some((o) => o.side === 'us' && o !== t)) {
      for (const o of this.active()) if (o !== t && o.side === 'us' && this.bondOf(o, t).lvl >= 3) { o.boon = { kind: 'wrath', by: t.id, until: this.round + 1 }; this.cue({ k: 'icon', u: o.id, icon: '!!' }); this.note('social', `${this.nm(o, true)} ${o.agent.controlled ? 'see' : 'sees'} ${this.nm(t)} fall — and something hardens.`); }
      f.health = 0.5; t.out = 'downed'; t.burning = 0;
      this.cue({ k: 'dmg', t: t.id, amt: dmg, res: 'down', how: _how, hp: 0 });
      this.fold(by, t, 'hit');
      this.ev('down', by, t, _how);
      this.note('info', `${this.nm(t, true)} ${t.agent.controlled ? 'go' : 'goes'} down!`);
      return 'hit';
    }
    const res = f.takeHit(dmg, 'DOWN');
    this.cue({ k: 'dmg', t: t.id, amt: dmg, res, how: _how, hp: Math.max(0, f.health) });
    this.fold(by, t, res);
    if (res === 'dead' || !t.agent.alive) {
      this.ev(t.morale === 'broken' ? 'finish' : 'kill', by, t, _how);
      t.out = t.agent._held ? 'captured' : 'dead'; this.release(t); return 'dead';
    }
    if (res === 'hit') this.ev('hit', by, t, _how);
    if (t.agent._held) { t.out = 'captured'; this.release(t); }
    return res;
  }

  /** Who beside t would throw themselves into a killing blow: bonded, soft-hearted, or a shield. */
  private diver(t: Unit, by: Unit): Unit | null {
    const cands = this.active().filter((w) => w !== t && w !== by && w.side === 'us' && !w.reacted && !w.stunned && !w.bound && w.tactic !== 'civilian' && w.role !== 'player'
      && this.adjacent(w, t) && this.bondOf(w, t).kind !== 'rival' && (this.bondOf(w, t).lvl >= 2 || (w.traits?.compassion ?? 0) >= 0.75 || w.tactic === 'guardian'));
    if (!cands.length) return null;
    const w = cands.sort((a, c) => (c.tactic === 'guardian' ? 1 : 0) - (a.tactic === 'guardian' ? 1 : 0) || this.bondOf(c, t).lvl - this.bondOf(a, t).lvl)[0];
    return check(w.sheet.finesse + this.bondOf(w, t).lvl, 12).ok ? w : null;
  }

  private fold(by: Unit, t: Unit, type: 'hit' | 'dead' | 'blocked'): void {
    try { this.session.sim.onCombatEvents([{ type, attacker: by.agent.fighter, target: t.agent.fighter, point: t.agent.pos.clone() }] as never); }
    catch { /* the fold is the engine's; never let it break a battle */ }
  }

  private deathSave(u: Unit): void {
    if (u.deathSaves.ok >= 3) return;
    const r = check(0, 10);
    if (r.crit) { u.out = null; u.agent.fighter.health = 10; this.cue({ k: 'getup', t: u.id }); this.note('info', 'You drag yourself up, somehow.'); return; }
    if (r.ok) u.deathSaves.ok++; else u.deathSaves.fail += r.fumble ? 2 : 1;
    if (u.deathSaves.fail >= 3) this.kill(u);
    else this.note('info', u.deathSaves.ok >= 3 ? 'You are stable, but out of the fight.' : `You cling on (${u.deathSaves.ok} saves, ${u.deathSaves.fail} failures).`);
  }

  private kill(u: Unit): void {
    const by = u.lastHitBy ?? u;
    u.agent.fighter.health = 0.5; u.agent.fighter.takeHit(1e6, 'DOWN');
    this.cue({ k: 'dmg', t: u.id, amt: 0, res: 'dead', how: 'wounds', hp: 0 });
    this.fold(by, u, 'dead');
    u.out = 'dead'; this.release(u);
  }

  private morale(): void {
    const lost = (s: Side) => { const all = this.units.filter((u) => u.side === s); return all.length ? all.filter((u) => u.out === 'dead' || u.out === 'captured').length / all.length : 0; };
    for (const u of this.active()) {
      if (u.role === 'player' || u.tags.has('chief')) continue;     // a chief fights to the end, or sues for terms — never runs
      const scorched = u.burning > 0 && (!u.traits || u.traits.bravery < 0.5);
      if (!(frac(u) < 0.35 || u.morale !== 'steady' || lost(u.side) >= 0.5 || scorched)) continue;
      if (u.boon?.kind === 'wrath') continue;                        // a fallen friend to answer for: no running
      const steady = Math.min(3, this.active().filter((o) => o !== u && o.side === u.side && this.adjacent(o, u)).reduce((q, o) => q + this.bondOf(u, o).lvl, 0));
      const grit = (u.traits ? Math.round((u.traits.bravery - 0.5) * 8) : 0) + steady;   // bravery, and a bonded friend at your shoulder
      if (check(u.sheet.nerve + grit, 11 + (u.morale === 'shaken' ? 2 : 0) + (u.morale === 'broken' ? 20 : 0)).ok) continue;
      u.morale = 'broken';
      this.ev('broken', u);
      this.cue({ k: 'icon', u: u.id, icon: '!!' });
      this.objectives.delete(u.id);
      this.note('social', `${this.nm(u, true)}'s nerve breaks!`);
      // and they say so: fear spreads to the friends who hear it (a chief or a bonded friend holds)
      if (u.tactic !== 'beast' || u.side === 'them') {
        const heard = this.active().filter((l) => l !== u && l.side === u.side && l.role !== 'player' && !l.tags.has('chief') && l.morale === 'steady' && hears(this, u, l) && this.bondOf(l, u).lvl < 2);
        if (heard.length) {
          this.cue({ k: 'say', u: u.id, text: u.tactic === 'beast' ? '(a yelp, and the pack falters)' : 'Run — it\'s lost!', ok: true, react: 'none' });
          for (const l of heard) l.morale = 'shaken';
          this.note('social', `${this.nm(u, true)} ${u.tactic === 'beast' ? 'yelps and bolts' : 'shouts to run'} — ${heard.map((l) => this.nm(l)).join(', ')} ${heard.length > 1 ? 'waver' : 'wavers'}.`);
        }
      }
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
    try { u.agent.fighter.setFacing(Math.atan2(-d[0], -d[1])); } catch { /* stub */ }
  }
  /** Snap the unit's body to its tile (world position, standing height). */
  place(u: Unit): void {
    const t = this.map.tile(u.x, u.z); if (!t) return;
    u.agent.pos.x = t.wx; u.agent.pos.z = t.wz;
    u.agent.pos.y = this.map.surfaceY(u.x, u.z);
  }
  private swing(_u: Unit): void { /* bodies animate from cues (ui/battleFX), not at logic time */ }
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
  cue(c: CueSpec): void { this.cues.push({ ...c, logAt: this.log.length } as Cue); }

  ev(kind: BattleEvent['kind'], actor?: Unit, target?: Unit, detail?: string, withU?: Unit): void {
    this.events.push({ round: this.round, kind, actor: actor?.id, target: target?.id, detail, ...(withU ? { with: withU.id } : {}) });
  }
  note(kind: LogLine['kind'], text: string): void { this.log.push({ round: this.round, kind, text }); if (this.log.length > 300) this.log.splice(0, 100); }
}

/** Props an axe (or a sword, badly) can take apart. */
export const HEWABLE = ['tree', 'crate', 'barrel', 'table', 'cart', 'tent'];

export function sameAction(a: Action, b: Action): boolean {
  if (a.kind !== b.kind) return false;
  const A = a as Record<string, unknown>, B = b as Record<string, unknown>;
  for (const k of ['target', 'abilityId', 'prop', 'verb', 'piece', 'item']) if (A[k] !== undefined && B[k] !== undefined && A[k] !== B[k]) return false;
  if ('at' in a && 'at' in b && a.at && b.at) return a.at.x === b.at.x && a.at.z === b.at.z;
  return true;
}

export type { Tile, Prop };
