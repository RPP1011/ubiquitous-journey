// Percepts — hittable, perceivable PROPS with no mind (js/sim/percept.js). The epistemic
// split taken to its end: an agent perceives a Percept and forms a belief about it; a
// Scarecrow dressed as a person is struck as a person while every `!agent` guard skips all
// mind-feedback. A finished building is a place-as-percept (placeKind/sheltered).

import type { Vector3 } from 'three';
import type { EntityId } from './core.js';
import type { Agent } from './agent.js';

/** The TRUE nature of a perceivable thing — UNREADABLE by agents (they see only appearance). */
export type PerceptKind = 'person' | 'scarecrow' | 'building';

/** A perceivable, hittable prop with no agent/mind. Shares the perception + combat surface
 *  with an Agent (id/pos/alive/faction/torso) but deliberately carries `agent = null`. */
export interface Percept {
  id: EntityId;
  kind: PerceptKind;            // TRUE nature — agents cannot read this
  faction: string;             // the faction it's DRESSED as (its appearance)
  disguiseFaction: string | null;
  alive: boolean;              // for a building, alive == sheltered
  hp?: number;
  combatant: boolean;
  controlled: boolean;
  agent: null;                 // ← NOT an agent. The tolerance test.
  pos: Vector3;
  root: { position: Vector3 };

  // hittable BODY surface (read by resolveCombat as a target)
  isHitActive(): boolean;
  torsoCenter(out: Vector3): Vector3;
  takeHit(dmg: number): 'blocked' | 'hit' | 'dead';
  update(): void;
}

/** Anything an agent can perceive: a live agent OR a mindless prop. */
export type Perceivable = Agent | Percept;
