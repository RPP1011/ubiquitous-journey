// CameraRig: a camera with its own mind, decoupled from whoever is acting.
//
// It holds a FOCUS point and a framing (yaw, pitch, distance), all critically damped — the
// look-at point glides, it never snaps. Scenes give it a GOAL, not a target to chase:
//
//   frameWide(p, dist)    the hub's establishing shot
//   frameOn(p, dist)      a conversation close-up (a slow glide, not a cut)
//   frameBox(points)      a battle: the bounding box of everyone still in the fight, with a dead
//                         zone so a single step doesn't re-frame — the camera moves only when the
//                         fight itself has shifted
//
// The player can take it: WASD/arrows pan, right-drag rotates, wheel zooms, C recenters. Manual
// control holds until the scene changes (a new goal kind) or C.

import * as THREE from 'three';

interface CameraLike { position: THREE.Vector3; lookAt(v: THREE.Vector3): void; }

const damp = (x: number, to: number, tau: number, dt: number) => x + (to - x) * (1 - Math.exp(-dt / tau));

export class CameraRig {
  private cam: CameraLike;
  private focus = new THREE.Vector3();
  private goal = new THREE.Vector3();
  private pan = new THREE.Vector3();           // manual offset from the goal
  yaw = 0; pitch = 0.8; dist = 16;
  private goalYaw = 0; private goalPitch = 0.8; private goalDist = 16;
  private tau = 0.9;                            // seconds: how lazily the focus follows its goal
  private mode = '';
  private manual = false;
  private dragging = false; private lastX = 0;
  private started = false;
  /** Shift the framed subject left on screen (fraction of distance) — room for a right-side panel. */
  private bias = 0;

  constructor(cam: CameraLike, dom: HTMLElement) {
    this.cam = cam;
    dom.addEventListener('mousedown', (e) => { if (e.button === 2) { this.dragging = true; this.lastX = e.clientX; } });
    window.addEventListener('mouseup', (e) => { if (e.button === 2) this.dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.goalYaw -= (e.clientX - this.lastX) * 0.006; this.lastX = e.clientX; this.manual = true;
    });
    dom.addEventListener('wheel', (e) => { this.goalDist = Math.max(6, Math.min(34, this.goalDist * (e.deltaY > 0 ? 1.1 : 0.9))); this.manual = true; }, { passive: true });
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'KeyC') this.recenter();
    });
  }

  private setMode(m: string): void { if (m !== this.mode) { this.mode = m; this.manual = false; this.pan.set(0, 0, 0); this.bias = m === 'box' ? 0.22 : 0; } }

  recenter(): void { this.manual = false; this.pan.set(0, 0, 0); }

  /** A wide establishing shot of a place. */
  frameWide(p: THREE.Vector3, dist = 17, pitch = 0.78): void {
    this.setMode('wide');
    this.tau = 1.1;
    this.goal.copy(p);
    if (!this.manual) { this.goalDist = dist; this.goalPitch = pitch; }
  }

  /** A slow glide in on someone (a conversation). */
  frameOn(p: THREE.Vector3, dist = 8, pitch = 0.55): void {
    this.setMode('on');
    this.tau = 1.0;
    this.goal.copy(p);
    if (!this.manual) { this.goalDist = dist; this.goalPitch = pitch; }
  }

  /**
   * Frame a set of points (the fight). Re-frames only when the box has moved meaningfully —
   * a dead zone keeps the camera still while people trade blows in place.
   */
  frameBox(points: THREE.Vector3[], minDist = 11, maxDist = 22): void {
    this.setMode('box');
    this.tau = 1.6;
    if (!points.length) return;
    const lo = points[0].clone(), hi = points[0].clone();
    for (const p of points) { lo.min(p); hi.max(p); }
    const center = lo.clone().add(hi).multiplyScalar(0.5);
    const extent = Math.max(hi.x - lo.x, hi.z - lo.z);
    const want = Math.max(minDist, Math.min(maxDist, extent * 0.95 + 6));
    if (center.distanceTo(this.goal) > 2.5 || !this.started) this.goal.copy(center);
    if (!this.manual && (Math.abs(want - this.goalDist) > 3 || !this.started)) { this.goalDist = want; this.goalPitch = 0.88; }
  }

  update(dt: number, keys?: { has(code: string): boolean }): void {
    // manual pan, camera-relative
    if (keys) {
      let fx = 0, fz = 0;
      if (keys.has('KeyW') || keys.has('ArrowUp')) fz -= 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) fz += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) fx -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) fx += 1;
      if (fx || fz) {
        const sp = this.dist * 0.9 * dt;
        const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
        this.pan.x += (fx * c + fz * s) * sp; this.pan.z += (-fx * s + fz * c) * sp;
        this.manual = true;
      }
    }
    const goal = this.goal.clone().add(this.pan);
    if (!this.started) { this.focus.copy(goal); this.yaw = this.goalYaw; this.pitch = this.goalPitch; this.dist = this.goalDist; this.started = true; }
    this.focus.x = damp(this.focus.x, goal.x, this.tau, dt);
    this.focus.y = damp(this.focus.y, goal.y, this.tau, dt);
    this.focus.z = damp(this.focus.z, goal.z, this.tau, dt);
    this.yaw = damp(this.yaw, this.goalYaw, 0.35, dt);
    this.pitch = damp(this.pitch, this.goalPitch, 0.8, dt);
    this.dist = damp(this.dist, this.goalDist, 0.8, dt);
    // the subject sits left of centre when a panel owns the right of the screen
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const look = this.focus.clone().add(new THREE.Vector3(0, 1.1, 0)).addScaledVector(right, this.bias * this.dist);
    const cp = Math.cos(this.pitch);
    this.cam.position.set(look.x + Math.sin(this.yaw) * cp * this.dist, look.y + Math.sin(this.pitch) * this.dist, look.z + Math.cos(this.yaw) * cp * this.dist);
    this.cam.lookAt(look);
  }
}
