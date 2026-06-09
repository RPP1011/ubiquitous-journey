// Player controller: camera-relative movement + translating Input into the
// Fighter's directional-combat intents.

import * as THREE from 'three';
import { TUNE } from './constants.js';
import { ARENA_RADIUS } from './arena.js';
import { collideWalls } from './sim/walls.js';
import type { Fighter } from '../types/sim.js';
import type { OrbitCamera } from './camera.js';
import type { Input } from './input.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();

export class Player {
  fighter: Fighter;
  cam: OrbitCamera;
  input: Input;

  constructor(fighter: Fighter, orbitCam: OrbitCamera, input: Input) {
    this.fighter = fighter;
    this.cam = orbitCam;
    this.input = input;
  }

  update(dt: number): void {
    const f = this.fighter;
    if (!f.alive) return;

    // ---- movement (relative to camera yaw) ----
    const yaw = this.cam.yaw;
    _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    _right.set(Math.cos(yaw), 0, -Math.sin(yaw));

    const axis = this.input.moveAxis();
    _move.set(0, 0, 0)
      .addScaledVector(_fwd, -axis.z)     // W (z=-1) -> forward
      .addScaledVector(_right, axis.x);   // D (x=+1) -> right

    const moving = _move.lengthSq() > 0.0001;
    // can't move freely while swinging or staggered
    const locked = f.state === 'attack' || f.state === 'stagger';
    let speed = 0;
    if (moving && !locked) {
      _move.normalize();
      const slowed = f.state === 'block' || f.state === 'ready';
      speed = (this.input.running && !slowed ? TUNE.runSpeed : TUNE.moveSpeed) * (slowed ? 0.5 : 1);
      const px = f.root.position.x, pz = f.root.position.z;
      f.root.position.addScaledVector(_move, speed * dt);

      // clamp to arena
      const r = Math.hypot(f.root.position.x, f.root.position.z);
      if (r > ARENA_RADIUS) {
        f.root.position.x *= ARENA_RADIUS / r;
        f.root.position.z *= ARENA_RADIUS / r;
      }
      // town walls (overworld only — the y-guard inside skips dungeons)
      collideWalls(f.root.position, px, pz);
    }
    f.setMoving(speed);
    f.setFacing(yaw);   // always face where the camera looks

    // ---- combat intents ----
    const i = this.input;
    if (i.lmb) {
      if (f.state === 'ready') f.aim(i.dir);
      else f.ready(i.dir);
    } else if (f.state === 'ready') {
      f.release();
    }

    if (i.rmb && !i.lmb) f.startBlock(i.dir);
    else if (f.state === 'block') f.stopBlock();
  }
}
