// Enemy AI controller: surround the player, telegraph a wind-up then swing in a
// random direction, and occasionally raise a (sometimes-correct) block when the
// player winds up. Drives a Fighter; combat resolution is shared with the player.

import { DIR, TUNE, ENEMY } from './constants.js';
import { rng } from './sim/rng.js';
import { ARENA_RADIUS } from './arena.js';
import type { Fighter, FighterDir } from '../types/sim.js';

const DIRS: FighterDir[] = [DIR.UP, DIR.DOWN, DIR.LEFT, DIR.RIGHT];
const randDir = (): FighterDir => DIRS[(rng() * 4) | 0];

export class Enemy {
  fighter: Fighter;
  angle: number;
  cooldown: number;
  releaseTimer: number;
  blockHold: number;
  _prevPlayerReady: boolean;

  constructor(fighter: Fighter, angle: number) {
    this.fighter = fighter;
    this.angle = angle;                 // preferred slot around the player
    this.cooldown = rng() * ENEMY.attackCooldownMax;
    this.releaseTimer = 0;
    this.blockHold = 0;
    this._prevPlayerReady = false;
  }

  update(dt: number, player: Fighter): void {
    const f = this.fighter;
    if (!f.alive) return;
    this.cooldown -= dt;

    const ex = f.root.position.x, ez = f.root.position.z;
    const dx = player.root.position.x - ex, dz = player.root.position.z - ez;
    const dist = Math.hypot(dx, dz) || 1e-3;
    f.setFacing(Math.atan2(-dx, -dz));

    if (!player.alive) { f.setMoving(0); if (f.state === 'block') f.stopBlock(); return; }

    // move toward a slot around the player so the group surrounds rather than stacks
    const tx = player.root.position.x + Math.cos(this.angle) * ENEMY.approachUntil;
    const tz = player.root.position.z + Math.sin(this.angle) * ENEMY.approachUntil;
    const mx = tx - ex, mz = tz - ez, md = Math.hypot(mx, mz);
    let speed = 0;
    const canMove = f.state === 'idle' || f.state === 'recover';
    if (md > 0.25 && canMove) {
      speed = TUNE.enemySpeed;
      f.root.position.x += (mx / md) * speed * dt;
      f.root.position.z += (mz / md) * speed * dt;
      const r = Math.hypot(f.root.position.x, f.root.position.z);
      if (r > ARENA_RADIUS) { f.root.position.x *= ARENA_RADIUS / r; f.root.position.z *= ARENA_RADIUS / r; }
    }
    f.setMoving(speed);

    // finish a telegraphed swing
    if (this.releaseTimer > 0) {
      this.releaseTimer -= dt;
      if (this.releaseTimer <= 0 && f.state === 'ready') f.release();
    }

    // react to the player's wind-up by maybe raising guard
    const winding = player.state === 'ready';
    if (winding && !this._prevPlayerReady &&
        dist < ENEMY.engageRange * 2.2 && f.canAct() && rng() < ENEMY.blockChance) {
      f.startBlock(rng() < 0.6 ? player.dir : randDir());
      this.blockHold = 1.1;
    }
    this._prevPlayerReady = winding;

    if (f.state === 'block') {
      this.blockHold -= dt;
      if (this.blockHold <= 0) f.stopBlock();
    }

    // attack when close enough, off cooldown and free to act
    if (dist <= ENEMY.engageRange && this.cooldown <= 0 && f.canAct() && f.state !== 'block') {
      f.ready(randDir());
      this.releaseTimer = 0.32 + rng() * 0.22;     // telegraph window
      this.cooldown = ENEMY.attackCooldownMin + rng() * (ENEMY.attackCooldownMax - ENEMY.attackCooldownMin);
    }
  }
}
