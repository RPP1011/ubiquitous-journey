// THE EPISTEMIC SPLIT, made a compile-time guarantee. `CognitionCtx` STRUCTURALLY LACKS
// `agents`/`agentsById`/`player`/`buildSites` — so a roster read from cognition (decide/
// act) is a typecheck error. `FullCtx` (the execution bridge) has them. This only puts a
// type on what Simulation._cognitionCtx()/_ctx() already return.

import type { EntityId, AgentRef, PosSnapshot } from './core.js';
import type { Agent } from './agent.js';
import type { Perceivable } from './percept.js';
import type { World, MentalMap } from './world.js';
import type { AbilitySpec } from './abilities.js';
import type { Arc, ArcOpenOpts } from './arcs.js';
import type { Deed } from './motivation.js';

/** The narrator's arc write-ports, exposed on BOTH ctxs (docs/architecture/12 §3). These are
 *  OBSERVER-LAYER, write-only: they file/escalate/close completed-arc records the chronicle and
 *  Gazette consume. They carry NO roster handle and never drive a decision, so they are sanctioned
 *  on the cognition ctx (a deriveGoals/pruneGoals hook can open/close an arc without reading truth). */
export interface ArcPorts {
  openArc(opts: ArcOpenOpts): Arc | null;
  appendArcRound(opts: ArcOpenOpts, text?: string): Arc | null;
  appendArcBeat(key: string, tag: string, text?: string): Arc | null;
  closeArc(key: string, outcome: string, text?: string): Arc | null;
  findArc(key: string): Arc | null;
}

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
  // the leader's OWN believed warband strength (base + living followers banded to it) — lets a
  // mustered war-leader judge it is strong enough to march on the believed foe. Execution-side.
  warbandStrength(leader: Agent): number;
  seenPos(observer: Agent, subjectId: EntityId): PosSnapshot | null;
  isLiveAgent(subjectId: EntityId): boolean;
  marketClear(a: Agent, good: string, buying: boolean): boolean;
  deliverTo(from: Agent, toId: EntityId, payload: { item?: string; n?: number; gold?: number }): boolean;
  solicitAlms?(beggar: Agent): number;   // carry a beggar's plea to bystanders' _pleas mailboxes (Inform)
  granaryDraw?(a: Agent): boolean;       // serve ONE meal from the town granary's civic stock (co-location-gated)
  // the TRUE benefit of the standing building the agent is AT (colocation-gated; null in the
  // open / at a razed shell) — act.ts scales the comfort restore by it and the agent learns
  // the felt quality onto its own place-belief (experience: the sanctioned truth→belief bridge).
  placeBenefitAt?(a: Agent): { comfort: number; social: number; kind: string; mine?: boolean; cellar?: boolean } | null;
  // Action-grammar execution (docs/architecture/10): the GENERIC "moved" acquire mechanic + the
  // EMERGENT consequence + physical Affect. `take` moves value source→taker (conserved, no baked
  // reaction — the social meaning is the acquire row's data); `witnessDeed` folds a perceived wrong
  // into the victim + bystanders' beliefs (per-perceiver, witness-gated — not a hardcoded victim);
  // `affect` applies a physical-state change (freed/wrecked). Callers gate location.
  take(a: Agent, sourceId: EntityId, payload: { item?: string; n?: number; gold?: number }): number;
  witnessDeed(actor: Agent, victimId: EntityId | null, kind: string, severity?: number): void;
  // docs/architecture/17 §6: drop a public Deed envelope into the inbox of every agent in perception
  // range (vision-gated roster scan — execution layer). The inference that follows reads only the
  // observer's own beliefs. Drained each perceive pass.
  publishDeed(deed: Deed): void;
  // docs/architecture/17 §8.1: the `say` speech-act — plant an opinion (valence) about a subject into
  // the nearby audience's own beliefs + publish the say deed for motive inference. Conserved; gated.
  say(speaker: Agent, subjectId: EntityId, valence: number, opts?: { range?: number; weight?: number; surfaceTag?: string }): void;
  affect(actor: Agent, targetId: EntityId, state: 'freed' | 'wrecked'): boolean;
  // RECRUIT (Inform): plant an OFFER on the candidate's own perception (`_offers`). NOT a
  // foreign-mind write of a goal — the candidate decides for itself; this only makes the offer
  // perceivable. Co-location-gated by the caller. Returns true on a landed offer.
  makeOffer(leader: Agent, candidateId: EntityId, payoff: number): boolean;
  // TEACH (graded recipes §6): move the student's tuition to a co-located teacher of `good` (a
  // conserved transfer); returns true when a teacher taught, so study learns only from a real
  // instructor. Execution-side (scans the roster); the caller gates being at the market.
  teachRecipe(student: Agent, good: string): boolean;
  // WARBAND (recruiter follow-through, docs/architecture/10-lld §19 item 4): the EXECUTION half of
  // a recruited NPC band-join. The follower DECIDES to join in cognition (its own offer/standing/
  // personality — no roster read); this flips the band flags through the shared Groups machinery
  // (the same path the player's Party uses). NOT a foreign-mind write — the candidate asked to join
  // itself. `cap` bounds the leader's band. Returns whether the follower actually joined.
  joinBand(follower: Agent, leaderId: EntityId, cap: number): boolean;
  // MIGRATION SETTLEMENT (the emigration valve): the EXECUTION half of a migrant's arrival —
  // the agent DECIDED to relocate in cognition (its own perceived prospect + own state,
  // features/migrate.ts) and WALKED there; this flips its citizenship (townId/townAnchor/
  // townRadius) to the town it now stands in. Truth-side town lookup; chronicle notes the
  // move. Returns whether it settled. (Optional like solicitAlms — stub facades omit it.)
  relocate?(a: Agent, townId: number): boolean;
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
  arcs: ArcPorts;               // narrator arc write-ports (sim.sagas) — observer-layer, write-only
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
  arcs: ArcPorts;               // narrator arc write-ports (sim.sagas) — observer-layer, write-only (no roster)
}
