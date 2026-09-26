// STAGE SET: dresses a quest stage's battlefield so each place is recognisable at a glance — its own
// ground (solid diorama blocks per tile), walls in the place's style, a landmark past the grid edge,
// sky / fog / light, ambient particles, and firelight. Visual only: it reads the Battle's map and
// never changes it. The rules half is app/run/sets.ts.

import * as THREE from 'three';
import { TILE, type BattleMap, type Ground } from '../app/tactics/map.js';
import type { Battle } from '../app/tactics/battle.js';

// The vendored three.module.js is untyped JS: talk to its objects loosely at this boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const X = (o: unknown) => o as Any;

type WallStyle = 'stone' | 'burnt' | 'palisade' | 'cliff' | 'drystone' | 'waystone';
type Particles = 'embers' | 'snow' | 'mist' | 'motes' | 'fireflies' | 'rain' | 'dust';

interface Look {
  sky: number; fog: [number, number, number];
  hemi: [number, number, number]; sun: [number, number, [number, number, number]];
  apron: number; ground?: Partial<Record<Ground, number>>;
  wall?: WallStyle; particles?: Particles[];
  trees?: { n: number; near: number; far: number; color: number; dead?: number; snow?: boolean };
  landmark?: (k: Kit) => void;
  /** Ground cover colours: grass tufts, tall brush, flowers in the grass, blooms in the brush. */
  tuft?: number; brush?: number; flowers?: number[]; bloom?: number;
}

const GROUND: Record<Ground, number> = {
  grass: 0x5f7d3a, dirt: 0x8a6b45, stone: 0x7b7d80, water: 0x2f5d7a, mud: 0x4d3b28, ash: 0x2e2b28, snow: 0xe6edf3, brush: 0x55702f,
};

/** A little builder over tile coordinates (fractional and off-grid allowed). */
class Kit {
  constructor(readonly g: Any, readonly map: BattleMap, readonly rnd: () => number) {}
  wx(x: number): number { return this.map.ox + x * TILE + TILE / 2; }
  wz(z: number): number { return this.map.oz + z * TILE + TILE / 2; }
  mat(color: number, extra: Record<string, unknown> = {}): Any { return new THREE.MeshStandardMaterial({ color, roughness: 0.95, ...extra }); }
  put(geo: Any, color: number | Any, x: number, y: number, z: number, ry = 0, extra: Record<string, unknown> = {}): Any {
    const m = X(new THREE.Mesh(geo, typeof color === 'number' ? this.mat(color, extra) : color));
    m.position.set(this.wx(x), y, this.wz(z)); m.rotation.y = ry; m.castShadow = true; m.receiveShadow = true;
    this.g.add(m); return m;
  }
  box(w: number, h: number, d: number, color: number, x: number, z: number, y = 0, ry = 0): Any { return this.put(new THREE.BoxGeometry(w, h, d), color, x, y + h / 2, z, ry); }
  cyl(r1: number, r2: number, h: number, color: number, x: number, z: number, y = 0, seg = 8): Any { return this.put(new THREE.CylinderGeometry(r1, r2, h, seg), color, x, y + h / 2, z); }
  cone(r: number, h: number, color: number, x: number, z: number, y = 0, seg = 7): Any { return this.put(new THREE.ConeGeometry(r, h, seg), color, x, y + h / 2, z); }
  rock(s: number, color: number, x: number, z: number, y = 0): Any { const m = this.put(new THREE.DodecahedronGeometry(s, 0), color, x, y + s * 0.5, z, this.rnd() * 6); m.scale.set(1 + this.rnd() * 0.6, 0.6 + this.rnd() * 0.5, 1 + this.rnd() * 0.6); return m; }
  /** A flat strip on the apron (a road running on past the grid). */
  strip(x0: number, z0: number, x1: number, z1: number, w: number, color: number, y = 0.03): void {
    const dx = this.wx(x1) - this.wx(x0), dz = this.wz(z1) - this.wz(z0);
    const len = Math.hypot(dx, dz);
    const m = X(new THREE.Mesh(new THREE.PlaneGeometry(w, len), this.mat(color)));
    m.rotation.x = -Math.PI / 2; m.rotation.z = -Math.atan2(dx, dz);
    m.position.set((this.wx(x0) + this.wx(x1)) / 2, y, (this.wz(z0) + this.wz(z1)) / 2); m.receiveShadow = true;
    this.g.add(m);
  }
  pine(x: number, z: number, s: number, color: number, snow = false): void {
    this.cyl(0.18 * s, 0.25 * s, 1.2 * s, 0x4a3524, x, z);
    this.cone(1.1 * s, 2.6 * s, color, x, z, 0.9 * s);
    this.cone(0.8 * s, 2.0 * s, color, x, z, 2.0 * s);
    if (snow) this.cone(0.45 * s, 0.9 * s, 0xf2f6fa, x, z, 3.15 * s);
  }
  deadTree(x: number, z: number, s: number): void {
    this.cyl(0.14 * s, 0.26 * s, 3.2 * s, 0x3b3128, x, z);
    for (let i = 0; i < 3; i++) { const b = this.cyl(0.05 * s, 0.1 * s, 1.4 * s, 0x3b3128, x, z, (1.6 + i * 0.5) * s); b.rotation.z = (this.rnd() - 0.5) * 1.8; b.rotation.x = (this.rnd() - 0.5) * 1.2; }
  }
}

// ---------------------------------------------------------------------------------------------
// the nine places

const LOOKS: Record<string, Look> = {
  old_road: {
    sky: 0xa9c9b2, fog: [0xa9c9b2, 34, 115], hemi: [0xe2f2dc, 0x39472a, 0.85], sun: [0xfff0cc, 1.45, [-0.4, 1, 0.35]],
    apron: 0x48652f, tuft: 0x5f8a38, brush: 0x6d8a36, flowers: [0xf2e6a0, 0xd98fb0, 0xffffff], particles: ['motes'], trees: { n: 170, near: 1, far: 34, color: 0x2f5a2c },
    landmark: (k) => {
      k.strip(7.5, -30, 7.5, -0.6, 4, 0x7d6143); k.strip(7.5, 15.6, 7.5, 45, 4, 0x7d6143);
      k.box(0.5, 1.1, 0.35, 0x8d8f86, 5.9, 16.2);                                   // a milestone by the road
      for (let i = 0; i < 6; i++) k.rock(0.5 + k.rnd() * 0.5, 0x6d6e66, -1.5 - k.rnd() * 3, k.rnd() * 16);
    },
  },
  mill: {
    sky: 0xd99a62, fog: [0xc78d5f, 28, 100], hemi: [0xffcf9e, 0x3d2718, 0.72], sun: [0xff9a55, 1.55, [0.9, 0.42, -0.3]],
    apron: 0x6f6b3c, tuft: 0x857f45, wall: 'burnt', particles: ['embers', 'dust'],
    landmark: (k) => {
      // the stream runs on past the grid, and the wheel still turns in it
      const water = k.mat(0x2e6488, { transparent: true, opacity: 0.8, roughness: 0.25, metalness: 0.1 });
      const s = X(new THREE.Mesh(new THREE.PlaneGeometry(2 * TILE, 90), water)); s.rotation.x = -Math.PI / 2; s.position.set(k.wx(14.5), -0.15, k.wz(7.5)); k.g.add(s);
      const wheel = X(new THREE.Group()); wheel.position.set(k.wx(14.5), 1.7, k.wz(-0.6));
      const rim = X(new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.12, 6, 20), k.mat(0x3a2a1c))); rim.rotation.y = Math.PI / 2; wheel.add(rim);
      for (let i = 0; i < 8; i++) { const p = X(new THREE.Mesh(new THREE.BoxGeometry(0.15, 3.6, 0.5), k.mat(0x4a3322))); p.rotation.x = i * Math.PI / 8; wheel.add(p); }
      k.g.add(wheel); k.g.userData.spin = wheel;
      // the mill's burnt gable and fallen roof beams past the north edge
      k.box(8.4 * TILE, 5.5, 0.5, 0x2a2019, 7.5, -0.9);
      k.put(new THREE.ConeGeometry(4.6 * TILE / 2, 3.2, 4), 0x201812, 7.5, 7, -1.6, Math.PI / 4);
      for (let i = 0; i < 5; i++) { const b = k.box(0.25, 0.25, 5 + k.rnd() * 3, 0x1e1712, 5 + i * 1.2, 1.5, 0.2 + k.rnd() * 1.5); b.rotation.x = 0.3 + k.rnd() * 0.5; }
      for (let i = 0; i < 9; i++) k.cyl(0.05, 0.05, 1.3, 0x5a4630, -1 + i * 0.1, 3 + i * 1.6);  // a fence along the lane
    },
  },
  camp: {
    sky: 0x1e2638, fog: [0x1e2638, 30, 100], hemi: [0x7082c0, 0x221a12, 0.62], sun: [0xa8baff, 0.8, [-0.3, 1, -0.5]],
    apron: 0x3d472c, wall: 'palisade', particles: ['embers'],
    landmark: (k) => {
      // a watchtower at the gate, raiders' banners on the rise, the rocks the camp sits between
      for (const [x, z] of [[6.5, 1.5], [9.5, 1.8]]) { k.cyl(0.05, 0.05, 3.4, 0x3a2a1c, x, z, 1.5); const f = k.box(0.02, 0.9, 1.3, 0x9a1f1a, x, z + 0.6, 3.6); f.castShadow = false; }
      for (let i = 0; i < 16; i++) { const a = k.rnd() * Math.PI * 2, r = 12 + k.rnd() * 10; k.rock(1 + k.rnd() * 2.2, 0x55565a, 7.5 + Math.cos(a) * r, 6 + Math.sin(a) * r); }
    },
  },
  crossroads: {
    sky: 0x9fd2f2, fog: [0xc2e2f6, 48, 160], hemi: [0xeaf5ff, 0x5a5030, 1.0], sun: [0xfff6e0, 1.75, [0.3, 1, 0.45]],
    apron: 0x7e9142, tuft: 0x7d9a44, brush: 0xd8b34a, flowers: [0xe4553c, 0x6f8fe0, 0xf2e6a0], wall: 'waystone', particles: ['motes'],
    landmark: (k) => {
      for (const [a, b] of [[[7.5, -40], [7.5, -0.6]], [[7.5, 15.6], [7.5, 50]], [[-40, 7.5], [-0.6, 7.5]], [[15.6, 7.5], [55, 7.5]]] as const) k.strip(a[0], a[1], b[0], b[1], 4, 0x9a7b52);
      // wheat in the four fields
      const wheat = k.mat(0xd8b34a);
      for (const [cx, cz] of [[-6, -6], [21, -6], [-6, 21], [21, 21]]) for (let i = 0; i < 90; i++) {
        const w = X(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9 + k.rnd() * 0.4, 0.5), wheat)); w.position.set(k.wx(cx + (k.rnd() - 0.5) * 10), 0.5, k.wz(cz + (k.rnd() - 0.5) * 10)); k.g.add(w);
      }
      for (let i = 0; i < 14; i++) { k.cyl(0.07, 0.07, 1.1, 0x6b5238, -0.8, i * 1.15); k.cyl(0.07, 0.07, 1.1, 0x6b5238, 15.8, i * 1.15); }
      k.pine(22, -14, 2.2, 0x3d6b33);                       // a lone tree on the skyline
    },
  },
  mine: {
    sky: 0x8a939d, fog: [0x8a939d, 32, 116], hemi: [0xd0d6dc, 0x3f3a34, 0.95], sun: [0xe8edf2, 1.15, [-0.5, 1, 0.25]],
    apron: 0x6a675f, wall: 'cliff', particles: ['dust'],
    landmark: (k) => {
      // the cliff runs on past the grid; the mine mouth is timbered and black
      for (let i = -14; i < 30; i++) if (i < 0 || i > 15) k.box(TILE * 1.02, 6 + k.rnd() * 4, TILE * 2.2, 0x5f5a54, i, 0.2);
      for (let i = -14; i < 30; i++) k.box(TILE * 1.02, 8 + k.rnd() * 5, TILE * 3, 0x55504a, i, -2.6);
      const dark = k.mat(0x07070a, { roughness: 1 });
      k.put(new THREE.BoxGeometry(2 * TILE - 0.6, 3.2, 0.2), dark, 7.5, 1.6, 0.35);
      for (const x of [7.2, 7.8]) k.strip(x, 1.6, x, 16, 0.14, 0x3b3b3e, 0.12);   // rails
      for (let i = 0; i < 5; i++) k.rock(1.2 + k.rnd(), 0x6e6960, -2 - k.rnd() * 4, 3 + i * 3);
      k.cyl(0.6, 0.6, 1.4, 0x4a3524, 17, 3); k.box(0.2, 2.6, 0.2, 0x4a3524, 17, 3, 1.4);   // the winch
    },
  },
  ruin: {
    sky: 0x4b4a67, fog: [0x4b4a67, 28, 100], hemi: [0xc4c6d4, 0x2e2c30, 0.75], sun: [0xe4e2f4, 0.95, [0.2, 1, -0.6]],
    apron: 0x4c5838, tuft: 0x5a6a3e, flowers: [0xcfc8e8], wall: 'stone', particles: ['rain'],
    landmark: (k) => {
      // the apse arch behind the altar
      for (const x of [5.2, 9.8]) k.box(0.9, 7, 0.9, 0x8a8a90, x, -0.6);
      const arch = k.put(new THREE.TorusGeometry(2.3 * TILE / 2, 0.45, 6, 12, Math.PI), 0x8a8a90, 7.5, 7, -0.6); arch.rotation.y = 0;
      k.box(1.6, 0.9, 0.9, 0x9a9aa0, 8, 3, 0);             // the altar stone under the relic
      // graves outside
      for (let i = 0; i < 12; i++) { const g = k.box(0.6, 0.8 + k.rnd() * 0.5, 0.18, 0x7c7c80, 14.6 + (i % 3) * 1.1, 2 + Math.floor(i / 3) * 2.4); g.rotation.z = (k.rnd() - 0.5) * 0.25; }
      k.deadTree(-1.5, 12, 1.4); k.deadTree(17.5, 13, 1.2);
      k.cyl(1.4, 1.6, 4.5, 0x77777c, -2.2, 1.5);            // the stump of the bell tower
    },
  },
  sheepfold: {
    sky: 0x6f6f9c, fog: [0x7b7aa2, 30, 112], hemi: [0xd4bad8, 0x2b301f, 0.62], sun: [0xffb08a, 1.1, [-0.9, 0.33, 0.25]],
    apron: 0x55703a, tuft: 0x5d7d3c, brush: 0x3f5a2a, bloom: 0xf0c830, flowers: [0xe8e2f0], wall: 'drystone', particles: ['mist', 'fireflies'],
    landmark: (k) => {
      // the shepherd's hut, the flock huddled behind the fold, the hills beyond
      k.box(3.2, 2.2, 2.6, 0x8a8478, 17.5, 13); k.put(new THREE.ConeGeometry(2.4, 1.6, 4), 0x5a4a32, 17.5, 3, 13, Math.PI / 4);
      for (let i = 0; i < 9; i++) { const x = 5 + k.rnd() * 6, z = 15.6 + k.rnd() * 1.6; k.box(0.9, 0.6, 0.55, 0xecebe4, x, z, 0.25); k.box(0.3, 0.3, 0.3, 0x2a2622, x + 0.5, z, 0.55); }
      for (let i = 0; i < 7; i++) { const h = X(new THREE.Mesh(new THREE.SphereGeometry(10 + k.rnd() * 8, 12, 8), k.mat(0x3f5a2e))); h.position.set(k.wx(-10 + i * 7), -6, k.wz(-22 - k.rnd() * 6)); k.g.add(h); }
    },
  },
  hollow: {
    sky: 0x1e2a21, fog: [0x1e2a21, 12, 58], hemi: [0x6a8a70, 0x0f140f, 0.5], sun: [0xa8c8a0, 0.5, [0.2, 1, 0.1]],
    apron: 0x2c3921, tuft: 0x3c5a2e, brush: 0x4f6a2e, particles: ['mist', 'fireflies'], trees: { n: 240, near: 0.5, far: 26, color: 0x1f3a1f, dead: 0.25 },
    landmark: (k) => {
      // the hunter's lean-to
      const r = k.box(3, 0.12, 2.4, 0x4a3a28, 3, 12, 1.2); r.rotation.x = 0.5;
      k.cyl(0.07, 0.07, 1.9, 0x3a2a1c, 1.8, 11.2); k.cyl(0.07, 0.07, 1.9, 0x3a2a1c, 4.2, 11.2);
    },
  },
  den: {
    sky: 0x19212f, fog: [0x223044, 22, 92], hemi: [0x8aa0d0, 0x1f2430, 0.55], sun: [0xbfd4ff, 0.85, [-0.4, 1, -0.2]],
    apron: 0xdfe7ef, ground: { stone: 0x6f7378 }, wall: 'cliff', particles: ['snow'], trees: { n: 60, near: 6, far: 34, color: 0x2c4a36, snow: true },
    landmark: (k) => {
      for (let i = -14; i < 30; i++) if (i < 0 || i > 15) k.box(TILE * 1.02, 7 + k.rnd() * 5, TILE * 2.2, 0x4d525a, i, 0.2);
      for (let i = -14; i < 30; i++) { k.box(TILE * 1.02, 10 + k.rnd() * 5, TILE * 3, 0x444952, i, -2.6); k.box(TILE * 1.02, 0.4, TILE * 3, 0xe8eef4, i, -2.6, 10); }
      const dark = k.mat(0x040507, { roughness: 1 });
      const mouth = k.put(new THREE.CylinderGeometry(2.6, 2.6, 0.3, 14, 1, false, 0, Math.PI), dark, 8, 0, 0.7); mouth.rotation.x = Math.PI / 2; mouth.rotation.z = Math.PI / 2;
      // bones before the den
      const bone = k.mat(0xe9e2d0);
      for (let i = 0; i < 16; i++) { const b = X(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 5), bone)); b.rotation.z = Math.PI / 2; b.rotation.y = k.rnd() * 6; b.position.set(k.wx(6 + k.rnd() * 4), 0.08, k.wz(2 + k.rnd() * 2)); k.g.add(b); }
      for (let i = 0; i < 10; i++) k.rock(1 + k.rnd() * 1.5, 0x5a5f68, -3 - k.rnd() * 6, 3 + i * 1.8);
    },
  },
};

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// set-piece models (tile coords; `base` = the ground's height there). `anim` is how it goes off.

type PieceAnim = 'topple' | 'roll' | 'drop' | 'raise' | 'swing' | 'fade' | 'none';
const PIECE_MODELS: Record<string, { build: (k: Kit, x: number, z: number, base: number) => void; anim: PieceAnim; len?: number }> = {
  logpile: { anim: 'roll', len: 5, build: (k, x, z, y) => {
    for (const [dy, dz] of [[0.3, -0.35], [0.3, 0.35], [0.85, 0]]) { const l = k.cyl(0.3, 0.3, 1.9, 0x6b4a2c, x, z + dz / 2, y + dy - 0.95, 9); l.rotation.x = Math.PI / 2; l.position.y = y + dy; }
    for (const s of [-1, 1]) k.cyl(0.06, 0.06, 1.5, 0x3a2a1c, x + s * 0.45, z + 0.5, y);
    k.box(0.05, 0.05, 1.9, 0xc8b27a, x, z, y + 1.15);                                   // the lashing
  } },
  hive: { anim: 'drop', build: (k, x, z, y) => {
    k.pine(x, z, 1.2, 0x2f5a2c);
    const h = k.put(new THREE.SphereGeometry(0.42, 8, 6), 0x8a6a3a, x + 0.35, y + 2.3, z); h.scale.set(1, 1.35, 1);
    k.cyl(0.02, 0.02, 0.5, 0x3a2a1c, x + 0.35, z, y + 2.75);
  } },
  sluice: { anim: 'raise', build: (k, x, z, y) => {
    for (const s of [-0.45, 0.45]) k.box(0.2, 2.4, 0.2, 0x4a3524, x + s, z, y);
    k.box(1.1, 1.3, 0.16, 0x6b4a2c, x, z, y + 0.1);
    k.box(1.3, 0.18, 0.3, 0x3a2a1c, x, z, y + 2.3);
    k.cyl(0.12, 0.12, 0.5, 0x2f2f33, x, z, y + 2.45);                                     // the winch
  } },
  roof: { anim: 'topple', build: (k, x, z, y) => {
    k.box(0.4, 4.4, 0.4, 0x1e1712, x, z, y);
    const b = k.box(0.3, 0.3, 3.6, 0x1b140f, x + 0.8, z - 0.6, y + 3.6); b.rotation.x = 0.35;
  } },
  tower: { anim: 'topple', build: (k, x, z, y) => {
    for (const [dx, dz] of [[-0.55, -0.55], [0.55, -0.55], [-0.55, 0.55], [0.55, 0.55]]) k.box(0.2, 5.2, 0.2, 0x4a3524, x + dx / 2, z + dz / 2, y);
    k.box(1.9, 0.2, 1.9, 0x5a4230, x, z, y + 4.2);
    for (const [dx, dz, w, d] of [[0, -0.45, 1.9, 0.08], [0, 0.45, 1.9, 0.08], [-0.45, 0, 0.08, 1.9], [0.45, 0, 0.08, 1.9]]) k.box(w, 0.7, d, 0x5a4230, x + dx, z + dz, y + 4.4);
    k.put(new THREE.ConeGeometry(1.5, 1.2, 4), 0x3a2a1c, x, y + 5.8, z, Math.PI / 4);
  } },
  horses: { anim: 'roll', len: 6, build: (k, x, z, y) => {
    k.box(0.08, 0.9, 1.8, 0x5a4230, x - 0.7, z, y);                                        // the hitching rail
    for (const [dz, c] of [[-0.35, 0x6b4a2c], [0.4, 0x9a9a92]] as const) {
      k.box(1.5, 0.6, 0.55, c, x, z + dz / 2, y + 0.9);
      const nk = k.box(0.35, 0.8, 0.3, c, x - 0.7, z + dz / 2, y + 1.1); nk.rotation.z = 0.5;
      k.box(0.5, 0.28, 0.25, c, x - 1.05, z + dz / 2, y + 1.7);
      for (const [lx, lz] of [[-0.55, -0.18], [0.55, -0.18], [-0.55, 0.18], [0.55, 0.18]]) k.box(0.12, 0.9, 0.12, 0x2a2018, x + lx / 2, z + dz / 2 + lz / 2, y);
    }
  } },
  timbers: { anim: 'drop', build: (k, x, z, y) => {
    for (const dx of [-0.95, 1.95]) { const p = k.box(0.35, 3.6, 0.35, 0x5a3f28, x + dx / 2, z + 0.1, y); p.rotation.z = dx < 0 ? 0.04 : -0.05; }
    k.box(2 * TILE + 0.4, 0.4, 0.45, 0x5a3f28, x + 0.5, z + 0.1, y + 3.6);
    const brace = k.box(0.2, 2.6, 0.2, 0x4a3524, x + 0.5, z + 0.3, y + 0.6); brace.rotation.z = 0.9;
  } },
  orecart: { anim: 'roll', len: 6, build: (k, x, z, y) => {
    k.box(1.2, 0.7, 1.5, 0x3d3a36, x, z, y + 0.35);
    for (let i = 0; i < 5; i++) k.rock(0.22, 0x8a7a5a, x + (k.rnd() - 0.5) * 0.7, z + (k.rnd() - 0.5) * 0.9, y + 1.0);
    for (const [dx, dz] of [[-0.62, -0.5], [0.62, -0.5], [-0.62, 0.5], [0.62, 0.5]]) { const w = k.cyl(0.24, 0.24, 0.12, 0x222226, x + dx / 2, z + dz / 2, y + 0.12, 10); w.rotation.z = Math.PI / 2; w.position.y = y + 0.24; }
  } },
  pillar: { anim: 'topple', build: (k, x, z, y) => {
    k.box(1.2, 0.4, 1.2, 0x8f8a80, x, z, y);
    const c = k.cyl(0.45, 0.5, 4.6, 0xa7a295, x, z, y + 0.4, 10); c.rotation.z = 0.08;
    k.box(1.2, 0.4, 1.2, 0x8f8a80, x + 0.18, z, y + 4.9);
  } },
  bell: { anim: 'swing', build: (k, x, z, y) => {
    k.cyl(0.03, 0.03, 4.2, 0xc8b27a, x, z, y + 0.6);
    k.put(new THREE.CylinderGeometry(0.35, 0.6, 0.8, 12, 1, true), 0x8a6a3a, x, y + 5.2, z);
    k.box(1.6, 0.2, 0.2, 0x3a2a1c, x, z, y + 5.7);
  } },
  foldwall: { anim: 'topple', build: (k, x, z, y) => {
    for (const dx of [0, 1]) { k.box(TILE, 1.05, TILE * 0.8, 0x94938b, x + dx, z, y); k.box(TILE * 0.9, 0.22, TILE * 0.85, 0x7e7d76, x + dx, z, y + 1.05); }
    k.box(0.1, 0.5, 0.1, 0xe8e2d0, x + 0.3, z - 0.4, y + 1.2);                             // a cracked cap stone
  } },
  deadfall: { anim: 'drop', build: (k, x, z, y) => {
    k.box(0.22, 3.2, 0.22, 0x4a3524, x, z, y);
    k.box(0.22, 3.2, 0.22, 0x4a3524, x - 3.3, z, y);
    const log = k.cyl(0.34, 0.34, 3 * TILE, 0x5e4128, x - 2, z, y + 2.5, 9); log.rotation.z = Math.PI / 2; log.position.y = y + 2.6;
    k.box(3.4 * TILE / 2, 0.03, 0.03, 0xc8b27a, x - 1.65, z, y + 3.1);
  } },
  oak: { anim: 'topple', build: (k, x, z, y) => {
    k.cyl(0.35, 0.55, 4.5, 0x3b3128, x, z, y);
    for (let i = 0; i < 4; i++) { const b = k.cyl(0.08, 0.16, 2, 0x3b3128, x, z, y + 3 + i * 0.4); b.rotation.z = (i % 2 ? 1 : -1) * (0.6 + i * 0.1); b.rotation.x = (i - 1.5) * 0.4; }
  } },
  boulders: { anim: 'roll', len: 6, build: (k, x, z, y) => {
    k.rock(0.9, 0x5f646c, x, z, y); k.rock(0.6, 0x6a6f78, x + 0.6, z + 0.3, y + 0.8); k.rock(0.55, 0x575c64, x - 0.5, z - 0.2, y + 0.6);
    k.box(TILE, 0.2, TILE, 0xe8eef4, x, z, y + 1.5);
  } },
  cornice: { anim: 'drop', build: (k, x, z, y) => {
    const s = k.box(3 * TILE, 1.4, 2.6, 0xeef3f8, x, z - 0.6, y + 8.2); s.rotation.x = 0.12;
    for (let i = 0; i < 8; i++) k.cone(0.12, 0.8 + k.rnd() * 0.6, 0xdce8f2, x - 1.2 + i * 0.35, z + 0.1, y + 7.2).rotation.x = Math.PI;
  } },
};

/** A soft round dot for particles (square points look like confetti). */
let _dot: Any = null;
function softDot(): Any {
  if (_dot) return _dot;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!; const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,0.7)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  _dot = new THREE.CanvasTexture(c); return _dot;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function hasSet(id: string): boolean { return id in LOOKS; }

export class StageSet {
  private g: Any = new THREE.Group();
  private scene: Any;
  private map: BattleMap;
  private look: Look;
  private groundMesh: Any;
  private groundKeys: string[] = [];
  private t = 0;
  private saved: { bg: Any; fog: Any; hemi: Array<[Any, Any, Any, number]>; sun: Array<[Any, Any, number, Any]> };
  private fires: Any[] = [];
  private parts: Array<{ pts: Any; kind: Particles; vel: Float32Array; box: number[] }> = [];
  private wmat: Any;
  private water = new Map<string, Any>();
  private walls = new Map<string, Any>();
  /** Ground cover by tile index: which instances to hide when the tile burns or floods. */
  private cover: Array<{ mesh: Any; idx: number[] }>[] = [];
  private pieces = new Map<string, { outer: Any; inner: Any; anim: PieceAnim; t: number; dir: [number, number]; playing: boolean; len: number; base: Any }>();

  constructor(scene: unknown, private battle: Battle, id: string) {
    this.scene = X(scene); this.map = battle.map; this.look = LOOKS[id];
    const rnd = mulberry([...id].reduce((h, c) => h * 31 + c.charCodeAt(0), 7));
    const k = new Kit(this.g, this.map, rnd);
    const L = this.look;

    // light, sky, fog (restored on dispose)
    this.saved = { bg: this.scene.background, fog: this.scene.fog, hemi: [], sun: [] };
    this.scene.background = new THREE.Color(L.sky);
    this.scene.fog = new THREE.Fog(L.fog[0], L.fog[1], L.fog[2]);
    const cx = k.wx(7.5), cz = k.wz(7.5);
    this.scene.traverse((o: Any) => {
      if (o.isHemisphereLight) { this.saved.hemi.push([o, o.color.clone(), o.groundColor.clone(), o.intensity]); o.color.setHex(L.hemi[0]); o.groundColor.setHex(L.hemi[1]); o.intensity = L.hemi[2]; }
      if (o.isDirectionalLight) {
        this.saved.sun.push([o, o.color.clone(), o.intensity, o.position.clone()]);
        const [dx, dy, dz] = L.sun[2], n = Math.hypot(dx, dy, dz);
        o.color.setHex(L.sun[0]); o.intensity = L.sun[1];
        o.position.set(cx + dx / n * 70, dy / n * 70, cz + dz / n * 70);
        o.target.position.set(cx, 0, cz); o.target.updateMatrixWorld();
      }
    });

    // the apron (the land around the grid)
    const apron = X(new THREE.Mesh(new THREE.PlaneGeometry(260, 260), k.mat(L.apron)));
    apron.rotation.x = -Math.PI / 2; apron.position.set(cx, -0.02, cz); apron.receiveShadow = true; this.g.add(apron);

    // the ground: one solid block per tile, its top at the tile's surface; sides darker, so raised
    // ground reads as terraces and cliff faces rather than a flat board
    const geo = X(new THREE.BoxGeometry(TILE, 1, TILE));
    const nrm = geo.attributes.normal, shade: number[] = [];
    for (let i = 0; i < nrm.count; i++) { const top = nrm.getY(i) > 0.5; shade.push(...(top ? [1, 1, 1] : [0.56, 0.53, 0.5])); }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
    this.groundMesh = X(new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 1, vertexColors: true }), this.map.tiles.length));
    this.groundMesh.receiveShadow = true;
    this.paintGround(true);
    this.g.add(this.groundMesh);
    // water surfaces (more appear if something floods)
    this.wmat = k.mat(0x2e6488, { transparent: true, opacity: 0.82, roughness: 0.2, metalness: 0.1 });
    this.syncWater();
    // thin grid lines so the tiles still read
    const lines: number[] = [];
    for (const t of this.map.tiles) {
      const y = this.map.surfaceY(t.x, t.z, false) + 0.035, h = TILE / 2;
      lines.push(t.wx - h, y, t.wz - h, t.wx + h, y, t.wz - h, t.wx - h, y, t.wz - h, t.wx - h, y, t.wz + h);
    }
    const lg = new THREE.BufferGeometry(); X(lg).setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 })));

    // set-pieces (their own models; they animate when set off)
    const pieceTiles = new Set<string>();
    for (const pc of battle.pieces.values()) { for (const [x, z] of pc.at) if (pc.solid) pieceTiles.add(`${x},${z}`); this.buildPiece(pc.id, pc.kind, pc.at[0][0], pc.at[0][1], rnd); }
    // walls in the place's style (each tile its own group, so a breach can take it away)
    for (const t of this.map.tiles) if (t.wall && !pieceTiles.has(`${t.x},${t.z}`)) {
      const wg = X(new THREE.Group()); this.g.add(wg); this.walls.set(`${t.x},${t.z}`, wg);
      this.wall(new Kit(wg, this.map, rnd), t.x, t.z, L.wall ?? 'stone');
    }
    // ground cover: tufts, flowers and stones; tall brush where the layout has it
    this.dress(rnd);
    // a ring of trees past the grid
    if (L.trees) for (let i = 0; i < L.trees.n; i++) {
      const side = Math.floor(rnd() * 4), along = -L.trees.far + rnd() * (16 + 2 * L.trees.far), out = L.trees.near + Math.pow(rnd(), 0.8) * (L.trees.far - L.trees.near);
      const [x, z] = side === 0 ? [along, -1 - out] : side === 1 ? [along, 16 + out] : side === 2 ? [-1 - out, along] : [16 + out, along];
      if (L.trees.dead && rnd() < L.trees.dead) k.deadTree(x, z, 1 + rnd() * 0.6); else k.pine(x, z, 1 + rnd() * 0.9, L.trees.color, L.trees.snow);
    }
    L.landmark?.(k);
    // firelight: a small pool of lights that follow whatever is burning
    for (let i = 0; i < 4; i++) { const p = X(new THREE.PointLight(0xff9a4a, 0, 14, 1.6)); this.fires.push(p); this.g.add(p); }
    for (const kind of L.particles ?? []) this.particles(kind, cx, cz);
    this.scene.add(this.g);
  }

  private paintGround(first: boolean): void {
    const m = new THREE.Matrix4(), c = new THREE.Color();
    const pal = { ...GROUND, ...(this.look.ground ?? {}) };
    this.map.tiles.forEach((t, i) => {
      const k = `${t.ground}|${t.h}`;
      if (!first && this.groundKeys[i] === k) return;
      if (!first) this.hideCover(i);                 // burnt or flooded: the grass and brush are gone
      this.groundKeys[i] = k;
      const top = this.map.surfaceY(t.x, t.z, false) - (t.ground === 'water' ? 0.35 : 0), bottom = -1.5, h = top - bottom;
      m.makeScale(1, h, 1); m.setPosition(t.wx, bottom + h / 2, t.wz);
      this.groundMesh.setMatrixAt(i, m);
      const j = 0.9 + ((t.x * 73 + t.z * 151) % 17) / 85;
      c.setHex(t.wall ? 0x5d5a55 : pal[t.ground]).multiplyScalar(j * (1 + t.h * 0.03));
      this.groundMesh.setColorAt(i, c);
    });
    this.groundMesh.instanceMatrix.needsUpdate = true;
    if (this.groundMesh.instanceColor) this.groundMesh.instanceColor.needsUpdate = true;
  }

  /** A water surface on every water tile (a flood adds more). */
  private syncWater(): void {
    for (const t of this.map.tiles) {
      const k = `${t.x},${t.z}`;
      if (t.ground !== 'water' || this.water.has(k)) continue;
      const w = X(new THREE.Mesh(new THREE.PlaneGeometry(TILE, TILE), this.wmat));
      w.rotation.x = -Math.PI / 2; w.position.set(t.wx, this.map.surfaceY(t.x, t.z, false) - 0.12, t.wz);
      this.g.add(w); this.water.set(k, w);
    }
  }

  /** Instanced ground cover: grass tufts and flowers on grass, stones on dirt and rock, tall brush. */
  private dress(rnd: () => number): void {
    const L = this.look;
    type Item = { tile: number; x: number; y: number; z: number; s: number; ry: number; tilt: number; c: number };
    const kinds: Record<string, { geo: Any; items: Item[] }> = {
      tuft: { geo: new THREE.ConeGeometry(0.1, 0.42, 4), items: [] },
      blade: { geo: new THREE.ConeGeometry(0.07, 1.25, 3), items: [] },
      bloom: { geo: new THREE.SphereGeometry(0.07, 5, 4), items: [] },
      stone: { geo: new THREE.DodecahedronGeometry(0.14, 0), items: [] },
    };
    const brush = L.brush ?? 0x7c8f3a, grass = L.tuft ?? 0x6f8f3e;
    this.map.tiles.forEach((t, i) => {
      if (t.wall) return;
      const y = this.map.surfaceY(t.x, t.z, false);
      const at = () => ({ x: t.wx + (rnd() - 0.5) * TILE * 0.9, z: t.wz + (rnd() - 0.5) * TILE * 0.9 });
      if (t.ground === 'brush') {
        for (let j = 0; j < 22; j++) { const p = at(); kinds.blade.items.push({ tile: i, x: p.x, y: y + 0.5, z: p.z, s: 0.7 + rnd() * 0.6, ry: rnd() * 6, tilt: (rnd() - 0.5) * 0.5, c: brush }); }
        if (L.bloom) for (let j = 0; j < 5; j++) { const p = at(); kinds.bloom.items.push({ tile: i, x: p.x, y: y + 0.9 + rnd() * 0.4, z: p.z, s: 1, ry: 0, tilt: 0, c: L.bloom }); }
      } else if (t.ground === 'grass') {
        for (let j = 0; j < 5; j++) { const p = at(); kinds.tuft.items.push({ tile: i, x: p.x, y: y + 0.16, z: p.z, s: 0.7 + rnd() * 0.7, ry: rnd() * 6, tilt: (rnd() - 0.5) * 0.4, c: grass }); }
        if (L.flowers && rnd() < 0.35) { const p = at(); kinds.bloom.items.push({ tile: i, x: p.x, y: y + 0.2, z: p.z, s: 1, ry: 0, tilt: 0, c: L.flowers[Math.floor(rnd() * L.flowers.length)] }); }
      } else if (t.ground === 'dirt' || t.ground === 'stone' || t.ground === 'snow') {
        if (rnd() < 0.5) { const p = at(); kinds.stone.items.push({ tile: i, x: p.x, y: y + 0.05, z: p.z, s: 0.6 + rnd(), ry: rnd() * 6, tilt: 0, c: t.ground === 'snow' ? 0x5f646c : 0x807b72 }); }
      }
    });
    this.cover = this.map.tiles.map(() => []);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), col = new THREE.Color();
    for (const kd of Object.values(kinds)) {
      if (!kd.items.length) continue;
      const mesh = X(new THREE.InstancedMesh(kd.geo, new THREE.MeshStandardMaterial({ roughness: 1 }), kd.items.length));
      kd.items.forEach((it, n) => {
        e.set(it.tilt, it.ry, it.tilt * 0.5); q.setFromEuler(e); sc.set(it.s, it.s, it.s); pos.set(it.x, it.y, it.z);
        m.compose(pos, q, sc); mesh.setMatrixAt(n, m);
        col.setHex(it.c).multiplyScalar(0.85 + rnd() * 0.3); mesh.setColorAt(n, col);
        const slot = this.cover[it.tile]; let entry = slot.find((c) => c.mesh === mesh); if (!entry) { entry = { mesh, idx: [] }; slot.push(entry); } entry.idx.push(n);
      });
      mesh.receiveShadow = true;
      this.g.add(mesh);
    }
  }

  private hideCover(i: number): void {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const c of this.cover[i] ?? []) { for (const n of c.idx) c.mesh.setMatrixAt(n, zero); c.mesh.instanceMatrix.needsUpdate = true; }
    if (this.cover[i]) this.cover[i] = [];
  }

  /** A set-piece's model, in a pivot group so it can topple, roll or drop when set off. */
  private buildPiece(id: string, kind: string, x: number, z: number, rnd: () => number): void {
    const model = PIECE_MODELS[kind]; if (!model) return;
    const outer = X(new THREE.Group()), inner = X(new THREE.Group()); outer.add(inner); this.g.add(outer);
    const base = this.map.surfaceY(Math.max(0, Math.min(15, x)), Math.max(0, Math.min(15, z)), false);
    model.build(new Kit(inner, this.map, rnd), x, z, base);
    const pivot = new THREE.Vector3(new Kit(inner, this.map, rnd).wx(x), base, new Kit(inner, this.map, rnd).wz(z));
    outer.position.copy(pivot); inner.position.set(-pivot.x, -pivot.y, -pivot.z);
    this.pieces.set(id, { outer, inner, anim: model.anim, t: 0, dir: [0, 1], playing: false, len: model.len ?? 4, base: pivot });
  }

  /** The rules set a piece off: play its model's motion. */
  playPiece(id: string, dir: [number, number]): void {
    const p = this.pieces.get(id); if (!p || p.playing) return;
    p.playing = true; p.t = 0; p.dir = dir;
    if (p.anim === 'topple') {
      // pivot on the edge it falls over
      const pv = p.base.clone().add(new THREE.Vector3(dir[0] * TILE / 2, 0, dir[1] * TILE / 2));
      p.outer.position.copy(pv); p.inner.position.set(-pv.x, -pv.y, -pv.z);
    }
  }

  private animatePieces(dt: number): void {
    for (const [id, p] of this.pieces) {
      if (!p.playing) continue;
      p.t += dt;
      const k = Math.min(1, p.t / 0.9), [dx, dz] = p.dir;
      switch (p.anim) {
        case 'topple': { const a = (Math.PI / 2) * k * k; p.outer.rotation.x = dz * a; p.outer.rotation.z = -dx * a; break; }
        case 'roll': p.outer.position.set(p.base.x + dx * p.len * TILE * k, p.base.y, p.base.z + dz * p.len * TILE * k); p.inner.rotation.x += dt * 6 * dz; p.inner.rotation.z -= dt * 6 * dx; break;
        case 'drop': p.outer.position.y = p.base.y - 6 * k * k; break;
        case 'raise': p.outer.position.y = p.base.y + 1.4 * k; break;
        case 'swing': p.outer.rotation.z = Math.sin(p.t * 7) * 0.35 * Math.exp(-p.t * 0.6); break;
        case 'fade': { const s = Math.max(0, 1 - k); p.outer.scale.set(s, s, s); break; }
      }
      const persist = p.anim === 'raise' || p.anim === 'swing';
      if (!persist && p.t > 1.5) { const s = Math.max(0, 1 - (p.t - 1.5) / 0.5); p.outer.scale.set(s, s, s); if (s <= 0) { this.g.remove(p.outer); this.pieces.delete(id); } }
      if (p.anim === 'swing' && p.t > 6) p.playing = false;
    }
  }

  private wall(k: Kit, x: number, z: number, style: WallStyle): void {
    const r = k.rnd, base = this.map.surfaceY(x, z, false);
    switch (style) {
      case 'stone': { const h = 1.2 + r() * 2.4; k.box(TILE, h, TILE * 0.7, [0xa39e92, 0x98938a, 0xaaa597][Math.floor(r() * 3)], x, z, base); if (r() < 0.5) k.box(TILE * 0.5, 0.5, TILE * 0.5, 0x7a7a80, x + (r() - 0.5), z + 0.6, 0, r()); break; }
      case 'burnt': { k.box(TILE, 2.6 + r() * 1.6, TILE * 0.45, 0x2b2119, x, z, base); if (r() < 0.6) k.box(0.3, 3.8, 0.3, 0x1b140f, x + 0.4, z, base); break; }
      case 'palisade': for (let i = 0; i < 3; i++) { const ox = (i - 1) * 0.62, h = 2.4 + r() * 0.5; k.cyl(0.26, 0.28, h, 0x6a4c30, x + ox / TILE, z, base); k.cone(0.28, 0.6, 0x6a4c30, x + ox / TILE, z, base + h); } break;
      case 'cliff': k.box(TILE * 1.02, 4 + r() * 3, TILE * 1.02, 0x5c5852, x, z, base); break;
      case 'drystone': { const h = 0.95 + r() * 0.2; k.box(TILE, h, TILE * 0.8, 0x8b8b84, x, z, base); k.box(TILE * 0.9, 0.22, TILE * 0.85, 0x7a7a72, x, z, base + h); break; }
      case 'waystone': {
        k.box(0.7, 1.9, 0.5, 0x8d8f86, x, z, base);
        k.cyl(0.08, 0.08, 3.1, 0x5a4230, x + 0.45, z + 0.4, base);
        for (const [ry, y] of [[0.3, 2.7], [1.9, 2.4], [-1.2, 2.1]]) { const a = k.box(1.3, 0.22, 0.06, 0x8a6b45, x + 0.45, z + 0.4, base + y); a.rotation.y = ry; }
        break;
      }
    }
  }

  private particles(kind: Particles, cx: number, cz: number): void {
    const n = kind === 'mist' ? 70 : kind === 'rain' ? 700 : kind === 'snow' ? 500 : kind === 'fireflies' ? 60 : 220;
    const box = [cx - 30, 0, cz - 30, cx + 30, kind === 'mist' ? 2.5 : 18, cz + 30];
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = box[0] + Math.random() * (box[3] - box[0]); pos[i * 3 + 1] = box[1] + Math.random() * (box[4] - box[1]); pos[i * 3 + 2] = box[2] + Math.random() * (box[5] - box[2]);
      const v = kind === 'rain' ? [0.5, -22, 0.2] : kind === 'snow' ? [0.3, -1.1, 0.1] : kind === 'embers' ? [0.3, 1.6, 0.1] : kind === 'mist' ? [0.35, 0, 0.12] : kind === 'fireflies' ? [0, 0.05, 0] : [0.12, 0.05, 0.08];
      vel[i * 3] = v[0] * (0.6 + Math.random() * 0.8); vel[i * 3 + 1] = v[1] * (0.6 + Math.random() * 0.8); vel[i * 3 + 2] = v[2] * (0.6 + Math.random() * 0.8);
    }
    const geo = new THREE.BufferGeometry(); X(geo).setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const look: Record<Particles, [number, number, number]> = { embers: [0xff8a33, 0.35, 0.95], snow: [0xffffff, 0.3, 0.9], mist: [0xdfe6ea, 9, 0.07], motes: [0xfff3c8, 0.16, 0.55], fireflies: [0xd8ff7a, 0.4, 0.9], rain: [0xb8c4e0, 0.07, 0.55], dust: [0xd6c7a8, 0.2, 0.35] };
    const [color, size, opacity] = look[kind];
    const mat = new THREE.PointsMaterial({ color, size, map: softDot(), transparent: true, opacity, depthWrite: false, sizeAttenuation: true });
    if (kind === 'embers' || kind === 'fireflies') X(mat).blending = THREE.AdditiveBlending;
    const pts = X(new THREE.Points(geo, mat)); pts.frustumCulled = false;
    this.g.add(pts);
    this.parts.push({ pts, kind, vel, box });
  }

  /** Per frame: particles drift, the wheel turns, firelight follows the flames, ash spreads. */
  sync(dt: number): void {
    this.t += dt;
    for (const p of this.parts) {
      const a = p.pts.geometry.attributes.position, arr = a.array as Float32Array, b = p.box;
      for (let i = 0; i < arr.length; i += 3) {
        const w = p.kind === 'embers' || p.kind === 'fireflies' ? Math.sin(this.t * 2 + i) * 0.4 : 0;
        arr[i] += (p.vel[i] + w) * dt; arr[i + 1] += p.vel[i + 1] * dt; arr[i + 2] += p.vel[i + 2] * dt;
        if (arr[i + 1] < b[1]) arr[i + 1] = b[4]; if (arr[i + 1] > b[4]) arr[i + 1] = b[1];
        if (arr[i] > b[3]) arr[i] = b[0]; if (arr[i] < b[0]) arr[i] = b[3];
        if (arr[i + 2] > b[5]) arr[i + 2] = b[2]; if (arr[i + 2] < b[2]) arr[i + 2] = b[5];
      }
      a.needsUpdate = true;
      if (p.kind === 'fireflies') p.pts.material.opacity = 0.55 + 0.4 * Math.sin(this.t * 3);
    }
    const spin = this.g.userData.spin; if (spin) spin.rotation.x += dt * 0.5;
    // firelight
    const src: Array<{ x: number; y: number; z: number }> = [];
    for (const pr of this.map.props.values()) if (pr.fireSource || pr.burning > 0) { const t = this.map.tile(pr.x, pr.z)!; src.push({ x: t.wx, y: this.map.surfaceY(pr.x, pr.z, false) + 1.3, z: t.wz }); }
    for (const t of this.map.tiles) if (t.burning > 0 && src.length < 12) src.push({ x: t.wx, y: this.map.surfaceY(t.x, t.z, false) + 1, z: t.wz });
    for (const u of this.battle.active()) if (u.carrying?.fireSource) src.push({ x: u.agent.pos.x, y: u.agent.pos.y + 1.6, z: u.agent.pos.z });
    this.fires.forEach((l, i) => {
      const s = src[i];
      l.intensity = s ? (5 + 1.5 * Math.sin(this.t * 11 + i * 2) + Math.sin(this.t * 23 + i) * 0.7) : 0;
      if (s) l.position.set(s.x, s.y, s.z);
    });
    // burnt grass turns to ash (and loses its cover), floods bring water, breached walls come down
    this.paintGround(false);
    this.syncWater();
    for (const [k, wg] of this.walls) { const [x, z] = k.split(',').map(Number); if (!this.map.tile(x, z)?.wall) { this.g.remove(wg); this.walls.delete(k); } }
    this.animatePieces(dt);
  }

  dispose(): void {
    this.scene.remove(this.g);
    this.g.traverse((o: Any) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Any) => m.dispose?.()); });
    this.scene.background = this.saved.bg; this.scene.fog = this.saved.fog;
    for (const [o, c, g, i] of this.saved.hemi) { o.color.copy(c); o.groundColor.copy(g); o.intensity = i; }
    for (const [o, c, i, p] of this.saved.sun) { o.color.copy(c); o.intensity = i; o.position.copy(p); o.target.position.set(0, 0, 0); o.target.updateMatrixWorld(); }
  }
}

