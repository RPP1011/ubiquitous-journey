// The shared fighter body (js/fighter.js + js/headlessFighter.js) + combat resolution
// events (js/combat.js). Both Fighter and HeadlessFighter implement this same surface;
// the sim picks one via an injected makeFighter factory (browser = visual Fighter).

import type { Vector3 } from 'three';
import type { Agent } from './agent.js';
import type { AbilitySpec } from './abilities.js';

/** Directional swing state. */
export type FighterState = 'idle' | 'ready' | 'attack' | 'recover' | 'block' | 'stagger' | 'dead';
/** A directional-melee direction (constants.js DIR). */
export type FighterDir = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

/** The shared body interface both Fighter and HeadlessFighter implement. */
export interface Fighter {
  // logic fields
  root: { position: Vector3; rotation: { x: number; y: number; z: number } };
  height: number;
  isPlayer: boolean;
  state: FighterState;
  dir: FighterDir;
  blockDir: FighterDir;
  hasHit: boolean;
  pendingSpec: AbilitySpec | null;   // ability melee routing
  health: number;
  alive: boolean;
  targetYaw: number;
  moveSpeed: number;
  dur: number;
  recoverTimer: number;
  staggerTimer: number;
  agent?: Agent;                     // back-ref (a Percept body carries none)

  // shared methods
  canAct(): boolean;
  ready(dir: FighterDir): void;
  aim(dir: FighterDir): void;
  release(): void;
  startBlock(dir: FighterDir): void;
  stopBlock(): void;
  takeHit(damage: number, attackDir: FighterDir): 'blocked' | 'hit' | 'dead';
  isHitActive(): boolean;
  weaponPoints(): [Vector3, Vector3];
  torsoCenter(out: Vector3): Vector3;
  setFacing(yaw: number): void;
  setMoving(speed: number): void;
  update(dt: number): void;
  dispose(): void;
}

/** A combat-resolution event (js/combat.js resolveCombat output). NO magnitude field
 *  (it is read elsewhere with a `|| 0` guard but never set on the event). */
export interface CombatEvent {
  type: 'hit' | 'blocked' | 'dead';
  attacker: Fighter;
  target: Fighter;
  point: Vector3;
}

/** The injected body factory (Simulation default = the visual Fighter). */
export type MakeFighter = (model: string, opts?: { isPlayer?: boolean }) => Fighter;
