// The economy layer: the closed money loop (js/sim/market.js auction) + the player-only
// reputation/standing ledger (js/sim/reputation.js).

import type { Vector3 } from 'three';
import type { EntityId } from './core.js';
import type { Agent } from './agent.js';

/** A tradeable commodity (simconfig.js COMMODITIES). */
export type Commodity = 'food' | 'wood' | 'ore' | 'tool' | 'herb' | 'potion';

/** A cleared trade (the econstats telemetry record — js/sim/market.js recordTrade arg). */
export interface Trade {
  t: number;
  commodity: Commodity;
  price: number;               // midpoint clearing price (the market signal)
  sellerId: EntityId;
  buyerId: EntityId;
  sellerBelief?: number;       // pre-clear price belief
  buyerBelief?: number;
}

/** The player-only standing ledger (js/sim/reputation.js Reputation). */
export interface Reputation {
  playerId: EntityId | null;
  faction: Record<string, number>;   // coarse per-faction opinion of the player (-1..1)

  setPlayer(id: EntityId): void;
  standing(npcAgent: Agent | null, playerId?: EntityId | null): number;
  factionStanding(faction: string): number;
  isHostileTo(npcAgent: Agent | null, playerId?: EntityId | null): boolean;
  describe(npcAgent: Agent | null, playerId?: EntityId | null): string;
  bumpFaction(faction: string | null, delta: number): void;
  applyDeedTo(witness: Agent, deedKey: string, now?: number, playerId?: EntityId | null): number;
  witnessDeed(agents: Agent[], deedKey: string, pos: Vector3 | null, now?: number, subjectId?: EntityId | null, playerId?: EntityId | null): number;
  favoredPrice(base: number, standing: number, selling?: boolean): number;
  decay(dt: number, agents?: Agent[] | null, playerId?: EntityId | null): void;
}
