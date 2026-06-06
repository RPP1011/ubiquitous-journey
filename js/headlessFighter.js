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

const _tip = new THREE.Vector3();
const _origin = new THREE.Vector3();
const SWING_DUR = 0.6;     // fixed swing length (real clips are ~this; no mixer here)

export class HeadlessFighter {
  constructor(characterKey, { isPlayer = false } = {}) {
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
  canAct() { return this.alive && (this.state === 'idle' || this.state === 'recover' || this.state === 'block'); }

  ready(dir) {
    if (!this.canAct()) return;
    this.state = 'ready';
    this.dir = dir;
  }

  aim(dir) { if (this.state === 'ready') this.dir = dir; }

  release() {
    if (this.state !== 'ready') return;
    this.state = 'attack';
    this.hasHit = false;
    this._t = TUNE.windupHold * this.dur;   // unpause from the cocked pose
  }

  startBlock(dir) {
    if (!this.alive || this.state === 'attack' || this.state === 'stagger') return;
    this.blockDir = dir;
    if (this.state !== 'block') this.state = 'block';
  }

  stopBlock() { if (this.state === 'block') this.state = 'idle'; }

  // --- being hit: 'blocked' | 'hit' | 'dead' --------------------------------
  takeHit(damage, attackDir) {
    if (!this.alive) return 'dead';
    if (this.state === 'block' && this.blockDir === attackDir) return 'blocked';
    this.health = Math.max(0, this.health - damage);
    if (this.health <= 0) { this._die(); return 'dead'; }
    this.state = 'stagger';
    this.staggerTimer = TUNE.staggerTime;
    return 'hit';
  }

  _die() { this.alive = false; this.state = 'dead'; }

  // --- hit sampling ---------------------------------------------------------
  isHitActive() {
    if (this.state !== 'attack' || this.hasHit) return false;
    return this._t >= TUNE.activeStart * this.dur && this._t <= TUNE.activeEnd * this.dur;
  }

  // weapon tip + handle origin in world space, at chest height, projected along
  // the faced direction. Forward toward the aimed target = (-sin, -cos) of the raw
  // facing yaw (the same convention the ability interpreter uses).
  weaponPoints() {
    const p = this.root.position, y = p.y + this.height * 0.55;
    _origin.set(p.x, y, p.z);
    _tip.set(p.x - Math.sin(this.aimYaw) * TUNE.reach, y, p.z - Math.cos(this.aimYaw) * TUNE.reach);
    return [_tip, _origin];
  }

  torsoCenter(out) {
    out.copy(this.root.position);
    out.y += this.height * 0.55;
    return out;
  }

  // --- per-frame ------------------------------------------------------------
  setFacing(yaw) { this.targetYaw = yaw + MODEL_YAW_OFFSET; this.aimYaw = yaw; }
  setMoving(speed) { this.moveSpeed = speed; }

  update(dt) {
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

  dispose() { /* no resources to free */ }
}
