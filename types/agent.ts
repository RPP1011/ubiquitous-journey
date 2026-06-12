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
import type { Goal, Ambition, PlanStep } from './goals.js';
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

/** Spy infiltration state (intrigue.js): cover phase + scout/exfil waypoints. */
export interface SpyState {
  phase: string;                // 'scout' | 'exfil'
  anchor?: Vector3 | null;      // camp anchor to exfiltrate to
  scoutTarget?: Vector3 | null; // current scout waypoint
  [k: string]: unknown;
}

/** Arbitrage hauler state (arbitrage.js): the dear-market destination to sell at. */
export interface ArbitrageState {
  destPos?: Vector3 | null;
  [k: string]: unknown;
}

/** A roaming-party / caravan / expedition objective handle (own-state target point). */
export interface TargetState {
  target?: Vector3 | null;
  [k: string]: unknown;
}

/** Dungeon roam state: a fixed patrol centre + radius. */
export interface RoamState {
  x: number;
  z: number;
  r: number;
  [k: string]: unknown;
}

/** One entry in the obligation ledger (docs/architecture/10, Phase 5): a standing intention —
 *  a thing promised now and discharged later when a perceived event comes to pass, or lapsed at
 *  expiry. The one piece of genuinely new machinery the action grammar needs (a little belief
 *  table with decay); also rehomes recurrence (a trigger that is a time or a believed condition). */
export interface Obligation {
  trigger: string;           // what arms it: 'delivered' | 'time' | a believed-condition tag
  action: string;            // the deferred action to take when the trigger fires ('pay' | 'testify' | …)
  counterparty?: EntityId;   // who it is owed to / about
  amount?: number;           // optional magnitude (coin promised, etc.)
  expiry: number;            // sim-time after which the unfired obligation lapses
  at?: number;               // sim-time the obligation was made (for recurrence re-derivation)
  dueAt?: number;            // recurrence (trigger 'time'): the sim-time the next instance comes due
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
  roam?: RoamState;
  campAnchor?: Vector3;
  campPatrolR?: number;
  townId?: number;
  townAnchor?: Vector3;
  townRadius?: number;
  inParty?: boolean;
  partySlot?: number;
  reporter?: boolean;
  spy?: SpyState | null;
  disguiseFaction?: string | null;
  bounty?: Bounty | null;
  arbitrage?: ArbitrageState | null;
  expedition?: TargetState | null;
  caravanRun?: TargetState | null;
  _duelWith?: EntityId | null;
  avengerOf?: EntityId | null;
  guardianOf?: EntityId | null;
  sightTarget?: Vector3 | null;       // a target landmark position (steer/sightsee), not an id
  _ambitionIntent?: string | null;    // standing ambition-activity kind (ambition_goals feature → decide)
  relics?: unknown[];
  homeBeliefId?: EntityId | null;
  _buildSiteId?: EntityId | null;
  _schemaGoalLock?: { kind: string; until: number } | null;
  _slain?: Set<EntityId>;
  _underground?: boolean;
  _barrierSide?: number;
  sim?: unknown;                      // back-ref to the owning Simulation (opaque; city grid only)
  strikeLog?: Map<EntityId, { count: number; first: number }> | null;
  canWork?: boolean;
  epithet?: string | null;
  nemesis?: boolean;
  house?: string;

  // ───── RUNTIME/internal state (always set by the Agent constructor) ─────
  bandLeaderId: EntityId | null;
  groupType: string | null;
  _trade: string | null;              // the good currently being made (null until first pick)
  _rpgNow: number;                    // sim time stamped each decide() (event timestamp)
  _produceAccum: number;              // fractional production awaiting a whole-unit deed emit
  _smithTimer: number;
  toolWear: number;
  _releaseTimer: number;
  _attackCd: number;
  _castCd: number;
  _tradeFlash: number;
  _comfortLowSince: number | null;
  _starveSecs?: number;            // seconds hunger has sat empty (drainNeeds starvation clock)
  _pleas?: { fromId: EntityId; t: number }[];   // perceived begging pleas (bounded Inform mailbox, alms)
  _lastSolicit?: number;           // beg-arm solicitation throttle (sim-time)
  _lastGranaryDraw?: number;       // granary-arm draw throttle (sim-time)
  _granaryEmptyUntil?: number;     // own memory of finding the larder bare — beg wins until then
  _diedOfHunger?: boolean;         // death was starvation, not a blade (the reaper's beat text)
  _buildAccum: number;
  wanderTarget: Vector3 | null;
  _repaid: Record<EntityId, boolean>;
  // REASONING-COST counters (Phase 3 — measurement only; read truth-side, never in cognition)
  _decideCalls: number;
  _decideCands: number;
  _planReplans: number;
  _planDepth: number;
  // LOD scheduling state (Phase 3 — written by the scheduler/cognition; read truth-side)
  _lodTick: number;
  _lastGoalChangeAt: number;
  _prevGoalKind: string | null | undefined;
  // Action-grammar Phase 5 (docs/architecture/10) — gated own-state for the breadth vocabulary.
  // Lazily created and read only when the feature flags are on, so off it is byte-stable.
  _strengthBelief?: Map<string, { value: number; conf: number }>;   // Strength(place) topic home
  _secretBelief?: Map<EntityId, { conf: number }>;                  // Secret(subject) topic home
  _recipeKnow?: Map<string, { conf: number; hops: number; t: number }>;  // graded Recipe(good) home (§6; binary `recipes` Set is the craftable view)
  _theyBelieve?: Map<string, { conf: number }>;                     // Believes(subject,topic), one level (key `subj:topicKey`)
  _obligations?: Obligation[];                                      // the commitment ledger (Phase 5)
  _held?: boolean;                                                  // a captive's held state (capture sets it, free flips it)
  _captorId?: EntityId;                                            // who captured this agent (CAPTIVE; ground truth, execution)
  _freedBy?: EntityId;                                              // who cut this agent's bonds (Affect: free)
  _courtingId?: EntityId | null;                                   // chosen sweetheart (romance trope/authoring); the court enactment reads it
  _diedAt?: number;                                                // sim-time of death, stamped by the corpse reaper (then reaped after the grace TTL)
  _freedAck?: EntityId;                                             // _freedBy already turned into emergent gratitude (de-dup guard)
  _wrecked?: boolean;                                               // a target sabotaged (Affect: wreck)
  _surveilAccum?: number;                                           // surveil dwell-time accumulator (urchin: throttles assoc sightings)
  _offers?: Record<EntityId, { from: EntityId; payoff: number; t: number }>;  // recruit offers this agent has perceived (follower side)
  // OUTCOME-CONDITIONED CAUTION (docs/architecture/11) — the burned-hand strategy memory + the
  // act.ts emit-site bookkeeping. Lazily created; written only when CAUTION.enabled (byte-stable off).
  _actExperience?: Map<string, { s: number; t: number; n: number }>;  // per-strategy signed surcharge store
  _cautionStep?: PlanStep | null;                                   // the watched plan step currently in progress (transition detect)
  _cautionGoal?: Goal | null;                                       // the goal that step belongs to

  // ───── OPTIONAL transient role/visual state ─────
  reporterTarget?: Vector3 | null;    // the gazetteer's current subject position
  scoutTarget?: Vector3 | null;       // spy scout waypoint
  notoriety?: number;                 // player fame (controlled agents only)
  proxy?: unknown;                    // browser-visual decor (THREE meshes/sprites)
  ring?: unknown;
  ringMat?: unknown;
  label?: unknown;
  _lblCanvas?: unknown;
  _lblCtx?: unknown;
  _lblTex?: unknown;
  _lblSig?: string;
  home?: unknown;                     // legacy truth-side home handle (retired in Phase 2a)

  // ───── methods ─────
  // abilities (safe no-ops when the agent knows nothing)
  grantAbility(spec: AbilitySpec): void;
  knowsAbility(id: string): boolean;
  abilityList(): AbilitySpec[];

  homeBelief(): BeliefState | null;
  totalWealth(): number;
  drainNeeds(dt: number): void;
  considerHostile(b: BeliefState): boolean;
  profColor(): number;          // packed RGB for the agent's profession/faction tint (UI)

  // INTAKE passes (FULL ctx — the sanctioned truth→belief bridge)
  perceive(ctx: FullCtx): void;
  gossipBeliefs(ctx: FullCtx): void;

  // COGNITION passes (RESTRICTED ctx — beliefs only)
  decide(ctx: CognitionCtx): void;
  act(dt: number, ctx: CognitionCtx): void;
  actControlled(dt: number, ctx: CognitionCtx): void;   // player-driven body (commander.js)
  chooseOccupation(ctx: CognitionCtx): void;
  _strongestClassGood(): string | null;   // the good whose tags the strongest class is built from

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

  // ───── internal cognition/execution helpers (free-fn delegates over the instance) ─────
  priceGossip(ctx: CognitionCtx, dt: number): void;
  _nearestHostile(ctx: CognitionCtx | null): HostileRef | null;
  _leader(ctx: CognitionCtx): Agent | null;        // EPISTEMIC-OK: controlled party leader only
  _decideParty(ctx: CognitionCtx): void;
  _currentPlanStep(ctx: CognitionCtx): PlanStep | null;
  _updateLabel(): void;

  // the long tail of un-typed drama/news/society flags (deliberate — one thin state class).
  [k: string]: unknown;
}
