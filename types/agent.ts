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
import type { Deed } from './motivation.js';
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

/** Transient mood (decays; colours decisions). The two negative-arousal emotions gate
 *  flee/fight; the slow-decaying valence emotions (joy/pride/loneliness/grief) wash over the
 *  whole candidate set so the SAME agent visibly behaves differently across a good vs bad spell —
 *  a proud agent seeks an audience, a grieving one withdraws and works listlessly. Own-state only. */
export interface Mood {
  fear: number;
  anger: number;
  joy: number;        // a windfall / good turn — socialise, spend, linger in public
  pride: number;      // a class-up / kept oath / triumph — seek an audience
  loneliness: number; // chronic unmet social need — pulls toward others
  grief: number;      // a bonded other's death — withdraw, listless work
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
  // docs/architecture/17 P2: the committed (primitive, motivation) pair — the short-term impetus
  // selected this tick + the public physical act it drives. `bind` is the committed goal (the same
  // object as `goal`). First-class so the deed emit (P3) + inspector can read what an agent is doing
  // and WHY without re-deriving it. Optional until arbitrate sets it each commit.
  motive?: { key: string; primitive: string; bind: Goal } | null;
  // docs/architecture/17 §6/§7: the inbox of witnessed deeds (public primitives) awaiting motive
  // inference, drained each perceive pass (motivation/infer.ts). Lazily created on first publish; bounded.
  perceivedDeeds?: Deed[];
  // docs/architecture/17 §7.4: this agent presents a deceptive COVER on its deeds (a spy / the guileful).
  // Default false (the honest mainline). Set by intrigue/the Director; read by presentTag + the guile branch.
  _deceives?: boolean;
  // docs/architecture/17 §7.2a/§7.6: the DEDICATED bounded ring of UNRESOLVED puzzles — salient deeds
  // whose motive a witness read inconclusively and may later `deliberate` over. Separate from the
  // episodic memory rings (so puzzles never evict drama memories). Lazily created; capped.
  _puzzles?: Array<{ deed: Deed; posterior: { best: string; conf: number }; t: number; passes?: number }>;
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
  _duelStart?: number | null;                                    // when the duel was enlisted (supervisor timeout)
  _duelRestore?: { combatant: boolean; canWork?: boolean } | null;  // role-flag restore blob (stand-down)
  avengerOf?: EntityId | null;
  guardianOf?: EntityId | null;
  bodyguardOf?: EntityId | null;      // sworn to shield a charge (director bodyguard trope)
  warlord?: boolean;                  // a mustered war-leader (director raid) — never duels for honour
  sightTarget?: Vector3 | null;       // a target landmark position (steer/sightsee), not an id
  _ambitionIntent?: string | null;    // standing ambition-activity kind (ambition_goals feature → decide)
  relics?: unknown[];
  homeBeliefId?: EntityId | null;
  _buildSiteId?: EntityId | null;
  groupName?: string | null;          // the fellowship's coined name (groups.js _join — flavour)
  groupHallId?: EntityId | null;      // THE GUILDHALL: my fellowship's hall (building/place id),
                                      //   stamped by Groups on completion; decide reads it with
                                      //   my OWN place-belief of that id (discovered by sight)
  _groupFormedAt?: number | null;     // anchor-side: when this group formed (the hall endurance gate)
  _quitBand?: EntityId | null;        // DEFECTION/MUTINY: a follower set this (own decision, off its
                                      //   own soured belief of the leader) to mutiny; Groups._prune
                                      //   honours it (the execution-side revert + the visible fracture)
  _schemaGoalLock?: { kind: string; until: number } | null;
  _quirk?: string;                    // QUIRKS: stable behavioural tic, derived once by quirkOf (decide.ts)
  _quirkLingerUntil?: number;         // SHOW-OFF: sim-time a show-off lingers at a fresh kill (act.ts)
  _lastKills?: number;                // SHOW-OFF: last-seen life.kills (kill-delta edge detect, act.ts)
  _duelChallengedAt?: number;         // EMERGENT DUEL: last tick this agent issued a challenge (throttle)
  _slain?: Set<EntityId>;
  _liveOaths?: number;                // sworn-and-unresolved oath count (oath economics: gnaw/courage/purpose)
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
  _simNow?: number;                   // sim time stamped EVERY frame at the top of act() — the
                                      //   clock ability windows (slow/haggle/craft-boost, stamped
                                      //   with ctx.time) are compared against off the hot path
  _haggleEdgeUntil?: number;          // haggle's bargaining window (trade_edge op): trade ask/bid
                                      //   drive a harder bargain while _simNow < this
  _craftBoostUntil?: number;          // master_craft's produce-speed window (craft_boost op)
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
  mateId?: EntityId | null;        // persistent couple bond (lineage births run off it; the wedded are rooted)
  _prospects?: { townId: number; name?: string; x: number; z: number; t: number }[];  // perceived land-is-cheap rumours (bounded Inform mailbox, migration)
  _migrating?: { townId: number; x: number; z: number; until: number } | null;        // own journey state: walking to a new home town (settle on arrival)
  _lastSolicit?: number;           // beg-arm solicitation throttle (sim-time)
  _lastGranaryDraw?: number;       // granary-arm draw throttle (sim-time)
  _granaryEmptyUntil?: number;     // own memory of finding the larder bare — beg wins until then
  _diedOfHunger?: boolean;         // death was starvation, not a blade (the reaper's beat text)
  _buildAccum: number;
  wanderTarget: Vector3 | null;
  _haunt?: { x: number; z: number } | null;   // HAUNT: a favourite spot stamped where a good moment happened — the wander steer-fill drifts back toward it (own-state, gentle)
  _dangerSpots?: { x: number; z: number; w: number; t: number }[];   // DANGER (doc 18): banked decaying bad spots (believed-hostile lastPos / witnessed death) — the travel/wander steer-fills lean lightly away (own-state, gentle)
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
  _toolQuality?: number;                                            // believed mean quality 0..1 of tools held (from a high-mastery smith; market.ts)
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
