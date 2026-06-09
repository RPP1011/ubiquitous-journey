// HeadlessFighter: a logic-only stand-in for Fighter, for running the simulation
// without a renderer (Bun/Node, tests, CI). It implements the exact interface the
// sim + combat use — position, facing, the directional swing state machine,
// hit-window timing, weapon/torso points, health/death — but with NO model,
// animation mixer, canvas, or DOM. Combat resolution (combat.js) is geometry-only
// and works identically against these math points.
//
// Parity notes:
//  * Swing timing reuses TUNE (activeStart/activeEnd/windupHold/recover/stagger)
//    so the hit window matches the rendered game frame-for-frame.
//  * weaponPoints() are placed at CHEST height (y + height*0.55) — the same height
//    torsoCenter() reports — because the real weapon node rides up on the model.
//    If the blade sat at ground y, the 0.95m hitRadius could never close the ~1m
//    vertical gap and melee would never land.
//
// The browser still uses the real Fighter; Simulation picks the body via an
// injected `makeFighter` factory (default = Fighter), so nothing here touches the
// playable game.

import * as THREE from 'three';
import { DIR, TUNE, MODEL_YAW_OFFSET } from './constants.js';
import type { Fighter as IFighter, FighterState, FighterDir } from '../types/sim.js';
import type { AbilitySpec, Agent } from '../types/sim.js';

const _tip = new THREE.Vector3();
const _origin = new THREE.Vector3();
const SWING_DUR = 0.6;     // fixed swing length (real clips are ~this; no mixer here)

// The headless root: a real Vector3 position + a plain rotation/userData bag (no
// scene graph). This is the structural `Fighter.root` the sim reads/writes.
interface HeadlessRoot {
  position: THREE.Vector3;
  rotation: { x: number; y: number; z: number };
  userData: Record<string, unknown>;
}

export class HeadlessFighter implements IFighter {
  root: HeadlessRoot;
  height: number;
  isPlayer: boolean;
  characterKey: string;
  state: FighterState;
  dir: FighterDir;
  blockDir: FighterDir;
  hasHit: boolean;
  pendingSpec: AbilitySpec | null;
  health: number;
  alive: boolean;
  targetYaw: number;
  aimYaw: number;
  moveSpeed: number;
  dur: number;
  _t: number;
  recoverTimer: number;
  staggerTimer: number;
  agent?: Agent;

  constructor(characterKey: string, { isPlayer = false }: { isPlayer?: boolean } = {}) {
    // minimal Object3D-like root: a real Vector3 position (the sim reads/writes it
    // heavily) plus a userData bag the Agent stamps a back-ref onto.
    this.root = { position: new THREE.Vector3(), rotation: { x: 0, y: 0, z: 0 }, userData: {} };
    this.height = TUNE.targetHeight;
    this.isPlayer = isPlayer;
    this.characterKey = characterKey;

    this.state = 'idle';                 // idle|ready|attack|recover|block|stagger|dead
    this.dir = DIR.RIGHT;
    this.blockDir = DIR.RIGHT;
    this.hasHit = false;
    this.pendingSpec = null;             // ability melee routing (unused by NPCs)

    this.health = TUNE.maxHealth;
    this.alive = true;

    this.targetYaw = 0;
    this.aimYaw = 0;                     // raw facing (pre model-offset); drives weaponPoints
    this.moveSpeed = 0;

    this.dur = SWING_DUR;
    this._t = 0;                         // swing clock while attacking
    this.recoverTimer = 0;
    this.staggerTimer = 0;
  }

  // --- combat intents (called by Agent._combatStep / controllers) -----------
  canAct(): boolean { return this.alive && (this.state === 'idle' || this.state === 'recover' || this.state === 'block'); }

  ready(dir: FighterDir): void {
    if (!this.canAct()) return;
    this.state = 'ready';
    this.dir = dir;
  }

  aim(dir: FighterDir): void { if (this.state === 'ready') this.dir = dir; }

  release(): void {
    if (this.state !== 'ready') return;
    this.state = 'attack';
    this.hasHit = false;
    this._t = TUNE.windupHold * this.dur;   // unpause from the cocked pose
  }

  startBlock(dir: FighterDir): void {
    if (!this.alive || this.state === 'attack' || this.state === 'stagger') return;
    this.blockDir = dir;
    if (this.state !== 'block') this.state = 'block';
  }

  stopBlock(): void { if (this.state === 'block') this.state = 'idle'; }

  // --- being hit: 'blocked' | 'hit' | 'dead' --------------------------------
  takeHit(damage: number, attackDir: FighterDir): 'blocked' | 'hit' | 'dead' {
    if (!this.alive) return 'dead';
    if (this.state === 'block' && this.blockDir === attackDir) return 'blocked';
    this.health = Math.max(0, this.health - damage);
    if (this.health <= 0) { this._die(); return 'dead'; }
    this.state = 'stagger';
    this.staggerTimer = TUNE.staggerTime;
    return 'hit';
  }

  _die(): void { this.alive = false; this.state = 'dead'; }

  // --- hit sampling ---------------------------------------------------------
  isHitActive(): boolean {
    if (this.state !== 'attack' || this.hasHit) return false;
    return this._t >= TUNE.activeStart * this.dur && this._t <= TUNE.activeEnd * this.dur;
  }

  // weapon tip + handle origin in world space, at chest height, projected along
  // the faced direction. Forward toward the aimed target = (-sin, -cos) of the raw
  // facing yaw (the same convention the ability interpreter uses).
  weaponPoints(): [THREE.Vector3, THREE.Vector3] {
    const p = this.root.position, y = p.y + this.height * 0.55;
    _origin.set(p.x, y, p.z);
    _tip.set(p.x - Math.sin(this.aimYaw) * TUNE.reach, y, p.z - Math.cos(this.aimYaw) * TUNE.reach);
    return [_tip, _origin];
  }

  torsoCenter(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.root.position);
    out.y += this.height * 0.55;
    return out;
  }

  // --- per-frame ------------------------------------------------------------
  setFacing(yaw: number): void { this.targetYaw = yaw + MODEL_YAW_OFFSET; this.aimYaw = yaw; }
  setMoving(speed: number): void { this.moveSpeed = speed; }

  update(dt: number): void {
    switch (this.state) {
      case 'attack':
        this._t += dt;
        if (this._t >= this.dur) { this.state = 'recover'; this.recoverTimer = TUNE.recover; }
        break;
      case 'recover':
        this.recoverTimer -= dt;
        if (this.recoverTimer <= 0) this.state = 'idle';
        break;
      case 'stagger':
        this.staggerTimer -= dt;
        if (this.staggerTimer <= 0) this.state = 'idle';
        break;
      // ready / block: hold; idle / dead: nothing
    }
  }

  dispose(): void { /* no resources to free */ }
}
