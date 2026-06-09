// Third-person orbit camera that follows a target position. Yaw/pitch are
// driven by consumed mouse-look deltas; the player faces the camera's yaw.

import * as THREE from 'three';

// The vendored three.module.js is un-typed JS, so tsc cannot see Object3D's
// getter-installed `position`/`lookAt`. This minimal view recovers exactly the
// camera surface this follow-cam touches. Adds nothing at runtime.
interface CameraLike {
  position: THREE.Vector3;
  lookAt(v: THREE.Vector3): void;
}

const LOOK_SENS = 0.0026;
const PITCH_MIN = -0.55;
const PITCH_MAX = 0.9;

export class OrbitCamera {
  camera: CameraLike;
  yaw: number;
  pitch: number;
  distance: number;
  height: number;
  target: THREE.Vector3;
  _desired: THREE.Vector3;
  _look: THREE.Vector3;

  constructor(camera: CameraLike) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.25;
    this.distance = 4.6;
    this.height = 1.5;          // look-at height above the target's feet
    this.target = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._look = new THREE.Vector3();
  }

  applyLook(dx: number, dy: number): void {
    this.yaw -= dx * LOOK_SENS;
    this.pitch += dy * LOOK_SENS;
    this.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.pitch));
  }

  // mouse-wheel zoom for the overhead follow view (dir: +1 out, -1 in)
  zoom(dir: number): void {
    this.distance = Math.max(5, Math.min(20, this.distance + dir * 1.3));
  }

  // follow target (Vector3 at feet), smoothing position.
  update(targetPos: THREE.Vector3, dt: number): void {
    this._look.copy(targetPos);
    this._look.y += this.height;

    const cp = Math.cos(this.pitch);
    const offX = Math.sin(this.yaw) * cp * this.distance;
    const offZ = Math.cos(this.yaw) * cp * this.distance;
    const offY = Math.sin(this.pitch) * this.distance;

    this._desired.set(
      this._look.x + offX,
      this._look.y + offY + 0.4,
      this._look.z + offZ,
    );

    const k = 1 - Math.pow(0.0008, dt);   // smooth follow
    this.camera.position.lerp(this._desired, k);
    this.camera.lookAt(this._look);
  }
}
