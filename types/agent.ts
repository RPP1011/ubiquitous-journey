// The Agent (js/sim/agent.js): ONE thin state class + many optional role/state flags.
//
// THE FREEZE LESSON, encoded: the protection is NOT "economy fields are absent" — at
// runtime most are ALWAYS-PRESENT EMPTY CONTAINERS (inventory {}, recipes Set(), abilities
// Map(), mastery {}). So they are NON-OPTIONAL here (a professionless monster/player still
// has them, empty). Only the genuinely conditional ROLE/STATE fields are optional. A final
// `[k: string]: unknown` index carries the long tail (drama/news/society flags).
//
// THE EPISTEMIC SPLIT, encoded in the method ctx types: intake passes (perceive/gossip) get
// the FULL ctx (the sanctioned truth→belief bridge); cognition (decide/act/chooseOccupation)
// gets the RESTRICTED ctx.

import type { Vector3 } from 'three';
import type { EntityId } from './core.js';
import type { BeliefStore, BeliefState } from './beliefs.js';
import type { Memory } from './memory.js';
import type { Trace } from './trace.js';
import type { Progression } from './rpg.js';
import type { AbilitySpec } from './abilities.js';
import type { Goal, Ambition } from './goals.js';
import type { Fighter } from './combat.js';
import type { Bounty } from './news.js';
import type { CognitionCtx, FullCtx } from './ctx.js';

/** Personality traits (cfg.personality) — a bag of named 0..1 scalars. */
export type Personality = Record<string, number>;

/** The agent's needs (1 = satisfied). */
export interface Needs {
  hunger: number;
  energy: number;
  social: number;
  comfort: number;
  novelty: number;
  [k: string]: number;
}

/** Transient mood (decays; gates flee/fight). */
export interface Mood {
  fear: number;
  anger: number;
  [k: string]: number;
}

/** Lifetime tallies feeding longer-term ambitions. */
export interface Life {
  kills: number;
  monsterKills: number;
  dist: number;
  social: number;
  [k: string]: number;
}

/** A belief-reference handle returned by _nearestHostile — NOT the real object. */
export interface HostileRef {
  id: EntityId;
  pos: Vector3;             // belief.lastPos (NOT ground truth)
  faction: string | null;
  belief: BeliefState;
}

export interface Agent {
  // ───── ALWAYS-PRESENT core (on every agent incl. monsters/player) ─────
  id: EntityId;
  name: string;
  profession: string | null;          // always assigned; null for monsters/player
  controlled: boolean;
  faction: string;
  beliefs: BeliefStore;
  personality: Personality;
  needs: Needs;
  mood: Mood;
  mastery: Record<string, number>;    // empty {} for the professionless
  inventory: Record<string, number>;
  gold: number;
  stash: number;
  recipes: Set<string>;               // empty Set for the professionless
  priceBeliefs: Record<string, number>;
  abilities: Map<string, AbilitySpec>;// empty Map for the ability-less
  progression: Progression;
  goal: Goal | null;
  goals: Goal[];
  memory: Memory;
  trace: Trace;
  ambition: Ambition | null;
  townsperson: boolean;
  combatant: boolean;
  threat: number;
  life: Life;

  // structural body + derived accessors
  fighter: Fighter;
  readonly pos: Vector3;              // = fighter.root.position
  readonly alive: boolean;           // = fighter.alive
  readonly autonomous: boolean;      // = !controlled — the ONE legit player/NPC distinction

  // ───── OPTIONAL role/state fields (genuinely conditional) ─────
  homeAnchor?: Vector3;
  leashR?: number;
  speedMul?: number;
  roam?: unknown;
  campAnchor?: Vector3;
  townId?: number;
  townAnchor?: Vector3;
  townRadius?: number;
  inParty?: boolean;
  partySlot?: number;
  reporter?: boolean;
  spy?: boolean;
  disguiseFaction?: string | null;
  bounty?: Bounty | null;
  arbitrage?: unknown;
  expedition?: unknown;
  caravanRun?: unknown;
  _duelWith?: EntityId | null;
  avengerOf?: EntityId | null;
  guardianOf?: EntityId | null;
  sightTarget?: EntityId | null;
  relics?: unknown[];
  homeBeliefId?: EntityId | null;
  _buildSiteId?: EntityId | null;
  _schemaGoalLock?: { kind: string; until: number } | null;
  _slain?: Set<EntityId>;
  _underground?: boolean;
  _barrierSide?: number;
  strikeLog?: Map<EntityId, { count: number; first: number }> | null;
  canWork?: boolean;
  epithet?: string | null;
  nemesis?: boolean;
  house?: string;

  // ───── methods ─────
  // abilities (safe no-ops when the agent knows nothing)
  grantAbility(spec: AbilitySpec): void;
  knowsAbility(id: string): boolean;
  abilityList(): AbilitySpec[];

  homeBelief(): BeliefState | null;
  totalWealth(): number;
  drainNeeds(dt: number): void;
  considerHostile(b: BeliefState): boolean;

  // INTAKE passes (FULL ctx — the sanctioned truth→belief bridge)
  perceive(ctx: FullCtx): void;
  gossipBeliefs(ctx: FullCtx): void;

  // COGNITION passes (RESTRICTED ctx — beliefs only)
  decide(ctx: CognitionCtx): void;
  act(dt: number, ctx: CognitionCtx): void;
  chooseOccupation(ctx: CognitionCtx): void;

  // trade interface (used by the market)
  keepOf(c: string): number;
  surplus(c: string): number;
  hasSurplus(c: string): boolean;
  wantQty(c: string): number;
  sellQty(c: string): number;
  askPrice(c: string): number;
  bidPrice(c: string): number;
  applyBuy(c: string, price: number): void;
  applySell(c: string, price: number): void;
  learnPrice(c: string, price: number, w: number): void;

  // goal stack
  pushGoal(goal: Goal, ctx: CognitionCtx | FullCtx | null): Goal | null;

  // the long tail of un-typed drama/news/society flags (deliberate — one thin state class).
  [k: string]: unknown;
}
