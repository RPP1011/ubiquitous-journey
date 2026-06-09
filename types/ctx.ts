// THE EPISTEMIC SPLIT, made a compile-time guarantee. `CognitionCtx` STRUCTURALLY LACKS
// `agents`/`agentsById`/`player`/`buildSites` — so a roster read from cognition (decide/
// act) is a typecheck error. `FullCtx` (the execution bridge) has them. This only puts a
// type on what Simulation._cognitionCtx()/_ctx() already return.

import type { EntityId, AgentRef, PosSnapshot } from './core.js';
import type { Agent } from './agent.js';
import type { Perceivable } from './percept.js';
import type { World, MentalMap } from './world.js';
import type { AbilitySpec } from './abilities.js';

/** An opaque build-site handle (resolved by the execution facade; never inspected by cognition). */
export type SiteHandle = unknown;

/** The BUILD-STATE EXECUTION FACADE (debt #2 retirement). Reached only via the resolver in
 *  act() (execution) — never named on the cognition ctx. SIX members. */
export interface BuildSiteFacade {
  // resolve-or-commission the agent's committed site; an OPAQUE handle or null.
  resolve(agent: Agent, ctx: CognitionCtx): SiteHandle | null;
  woodOwed(handle: SiteHandle): number;
  feedWood(agent: Agent, handle: SiteHandle, units: number): number;
  advance(handle: SiteHandle, dt: number, ctx: CognitionCtx): number;
  pos(handle: SiteHandle): PosSnapshot | null;
  nearestWood(agent: Agent): PosSnapshot | null;
}

/** The narrow EXECUTION facade handed to cognition (Simulation._cogResolver). Every method
 *  is NON-OPTIONAL (the facade always defines them) and vision-/conservation-gated. It
 *  exposes NO roster Map/Agent[] — there is no member to scan. */
export interface ResolverFacade {
  perceive(observer: Agent, subjectId: EntityId): Agent | null;
  cast(spec: AbilitySpec, caster: Agent): boolean;
  castTarget(observer: Agent, subjectId: EntityId): Agent | null;
  nearestVisibleOfFaction(observer: Agent, faction: string): AgentRef | null;
  enemyNearLeader(observer: Agent, leader: Agent | null): AgentRef | null;
  seenPos(observer: Agent, subjectId: EntityId): PosSnapshot | null;
  isLiveAgent(subjectId: EntityId): boolean;
  marketClear(a: Agent, good: string, buying: boolean): boolean;
  deliverTo(from: Agent, toId: EntityId, payload: { item?: string; n?: number; gold?: number }): boolean;
  // Action-grammar execution (docs/architecture/10, Phase 5): conserved theft (burgle/rob), and the
  // Affect flag-flips (free a captive / wreck a target). Callers gate location; these do the effect.
  pilfer(thief: Agent, markId: EntityId, amount: number): number;
  cutBonds(freer: Agent, captiveId: EntityId): boolean;
  sabotage(wrecker: Agent, targetId: EntityId): boolean;
  buildSite: BuildSiteFacade;
}

/** EXECUTION-side context (Simulation._ctx). Only execution sees the live roster. */
export interface FullCtx {
  agents: Agent[];
  perceivables: Perceivable[];
  agentsById: Map<EntityId, Agent>;
  world: World;
  map: MentalMap;
  time: number;
  player: Agent | null;
  playerId: EntityId | null;
  buildSites: unknown;          // the dynamic BuildSites registry (opaque to types)
  cities: unknown;              // the cities registry (opaque to types)
  resolver: ResolverFacade;
}

/** RESTRICTED COGNITION context (Simulation._cognitionCtx). Handed to decide()/act().
 *  STRUCTURALLY LACKS agents / agentsById / player / buildSites — reading any is a COMPILE
 *  ERROR. The one sanctioned cross-agent handle is `partyLeader` (controlled party leader). */
export interface CognitionCtx {
  world: World;
  map: MentalMap;
  time: number;
  cities: unknown;
  playerId: EntityId | null;
  partyLeader: Agent | null;
  resolver: ResolverFacade;
}
