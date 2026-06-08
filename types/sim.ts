// Shared simulation types (Stage 1 of the TypeScript port).
//
// PURE TYPES — no runtime code. Emits an empty `dist/types/sim.js` (harmless). The
// core slice imports these with `import type` (mandatory under `verbatimModuleSyntax`).
//
// The high-value win lives here: `CognitionCtx` vs `FullCtx` make THE EPISTEMIC SPLIT
// (docs/architecture/02-epistemic-split) a COMPILE-TIME guarantee — `CognitionCtx`
// structurally lacks `agents` / `agentsById` / `player` / `buildSites`, so a roster read
// from cognition (decide/act/perception-consumers) is a typecheck error, not just a scan
// failure. The split is already real in the data: `Simulation._cognitionCtx()` returns the
// restricted shape, `_ctx()` the full one — this only puts a type on what already exists.

import type { Vector3 } from 'three';

// ───────────────────────────── snapshots / refs ─────────────────────────────

/** A positional snapshot handed back by the execution resolver — NOT a live agent. */
export interface PosSnapshot { x: number; y: number; z: number; alive?: boolean; }

/** A minimal vision-gated reference (id + pos) — never the live roster object. */
export interface AgentRef { id: number | string; pos: PosSnapshot; }

// ───────────────────────────── belief layer ─────────────────────────────

/** One observer→subject belief row (the spec's per-(observer,subject) cell). Loose by
 *  design in Stage 1 — the audit endorsed keeping the multi-concern bag as-is for now. */
export interface BeliefState {
  id?: number | string;
  faction?: string;
  hostile?: boolean;
  lastPos?: Vector3 | PosSnapshot | null;
  confidence?: number;
  [k: string]: unknown;
}

/** The N² per-observer belief table (js/sim/beliefs.js BeliefStore). Loose in Stage 1. */
export interface BeliefStore {
  get(subjectId: number | string): BeliefState | undefined;
  set?(subjectId: number | string, b: BeliefState): void;
  decay?(dt: number): void;
  [k: string]: unknown;
}

// ───────────────────────────── goals / geography ─────────────────────────────

/** A motivation goal. `kind` stays a loose string in Stage 1 (discriminated union deferred). */
export interface Goal { kind: string; [k: string]: unknown; }

/** A static map place (POI/landmark) — pure geography, no dynamic agent state. */
export interface Place { id?: string; pos?: Vector3 | PosSnapshot; kind?: string; [k: string]: unknown; }

/** The shared static places registry (js/sim/mentalmap.js). Loose in Stage 1. */
export interface MentalMap { [k: string]: unknown; }

/** The static world (POIs/biomes). Loose in Stage 1. */
export interface World { [k: string]: unknown; }

// ───────────────────────────── the agent ─────────────────────────────

/** The Agent interface (js/sim/agent.js). Economy-bearing fields are OPTIONAL so any
 *  access without a guard is a typecheck error under strictNullChecks — the freeze lesson
 *  (monsters/player have `profession: null`, no inventory/economy) becomes *checkable*. */
export interface Agent {
  // mandatory core (present on every agent incl. monsters/player)
  id: number | string;
  name: string;
  faction: string;
  pos: Vector3;
  alive: boolean;
  beliefs: BeliefStore;
  personality: Record<string, number>;
  goals: Goal[];
  goal?: Goal | null;

  // ECONOMY — absent on professionless agents → OPTIONAL → guard required (freeze lesson)
  profession?: string | null;
  inventory?: Record<string, number>;
  priceBeliefs?: Record<string, number>;
  gold?: number;
  recipes?: Set<string>;
  mastery?: Record<string, number>;

  // progression / aux / subsystem flags — all optional
  progression?: unknown;
  memory?: unknown;
  trace?: unknown;
  ambition?: unknown;
  abilities?: unknown;
  townsperson?: boolean;
  inParty?: boolean;
  reporter?: boolean;
  spy?: boolean;
  controlled?: boolean;

  // methods (delegate to still-.js submodules in Stage 1)
  decide(ctx: CognitionCtx): void;
  act(dt: number, ctx: CognitionCtx): void;
  considerHostile?(b: BeliefState): boolean;
  applyBuy?(good: string, price: number): void;
  applySell?(good: string, price: number): void;
  surplus?(good: string): number;

  // remaining fields are open in Stage 1 (precise interfaces deferred to later stages)
  [k: string]: unknown;
}

// ───────────────────────────── the resolver facade ─────────────────────────────

export interface BuildSiteFacade {
  resolve(agent: Agent, ctx: CognitionCtx): unknown | null;
}

/** The narrow EXECUTION facade handed to cognition (Simulation._cogResolver). Its methods
 *  return vision-gated `Agent | null` / `AgentRef | null`, but it exposes NO `Map`/`Agent[]`
 *  roster — there is no member to scan. The exact method set is reconciled against
 *  `_cogResolver()` when simulation.ts is ported (later step). Loose where the audit allowed. */
export interface ResolverFacade {
  perceive?(observer: Agent, subjectId: number | string): Agent | null;
  cast?(spec: unknown, caster: Agent): boolean;
  castTarget?(observer: Agent, subjectId: number | string): Agent | null;
  nearestVisibleOfFaction?(observer: Agent, faction: string): AgentRef | null;
  enemyNearLeader?(observer: Agent, leader: Agent): AgentRef | null;
  seenPos?(observer: Agent, subjectId: number | string): PosSnapshot | null;
  isLiveAgent?(subjectId: number | string): boolean;
  marketClear?(a: Agent, good: string, buying: boolean): boolean;
  deliverTo?(from: Agent, toId: number | string, payload: { item?: string; n?: number; gold?: number }): boolean;
  buildSite?: BuildSiteFacade;
  [k: string]: unknown;
}

// ───────────────────────────── the two contexts (THE SPLIT) ─────────────────────────────

/** EXECUTION-side context (Simulation._ctx). Only execution sees the live roster. */
export interface FullCtx {
  agents: Agent[];
  agentsById: Map<number | string, Agent>;
  player: Agent | null;
  perceivables: unknown;
  world: World;
  map: MentalMap;
  time: number;
  playerId: number | string | null;
  buildSites: unknown;
  cities: unknown;
  resolver: ResolverFacade;
}

/** RESTRICTED COGNITION context (Simulation._cognitionCtx). Handed to decide()/act().
 *  STRUCTURALLY LACKS agents / agentsById / player / buildSites — reading any from cognition
 *  is a COMPILE ERROR. Mirrors `_cognitionCtx()`'s return literal exactly. The one sanctioned
 *  cross-agent handle is `partyLeader` (steer-fill, EPISTEMIC-OK); `playerId` is a primitive. */
export interface CognitionCtx {
  world: World;
  map: MentalMap;
  time: number;
  cities: unknown;
  playerId: number | string | null;
  partyLeader: Agent | null;
  resolver: ResolverFacade;
}
