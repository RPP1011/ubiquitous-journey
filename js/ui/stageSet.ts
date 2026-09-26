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
}

const GROUND: Record<Ground, number> = {
  grass: 0x5f7d3a, dirt: 0x8a6b45, stone: 0x7b7d80, water: 0x2f5d7a, mud: 0x4d3b28, ash: 0x2e2b28, snow: 0xe6edf3,
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
    apron: 0x48652f, particles: ['motes'], trees: { n: 170, near: 1, far: 34, color: 0x2f5a2c },
    landmark: (k) => {
      k.strip(7.5, -30, 7.5, -0.6, 4, 0x7d6143); k.strip(7.5, 15.6, 7.5, 45, 4, 0x7d6143);
      k.box(0.5, 1.1, 0.35, 0x8d8f86, 5.9, 16.2);                                   // a milestone by the road
      for (let i = 0; i < 6; i++) k.rock(0.5 + k.rnd() * 0.5, 0x6d6e66, -1.5 - k.rnd() * 3, k.rnd() * 16);
    },
  },
  mill: {
    sky: 0xd99a62, fog: [0xc78d5f, 28, 100], hemi: [0xffcf9e, 0x3d2718, 0.72], sun: [0xff9a55, 1.55, [0.9, 0.42, -0.3]],
    apron: 0x6f6b3c, wall: 'burnt', particles: ['embers', 'dust'],
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
      for (const x of [5.6, 9.4]) { k.cyl(0.12, 0.14, 5.5, 0x4a3524, x, 11.5); }
      k.box(4.2, 0.2, 1.8, 0x5a4230, 7.5, 11.5, 4.6);
      for (const [x, z] of [[6.5, 1.5], [9.5, 1.8]]) { k.cyl(0.05, 0.05, 3.4, 0x3a2a1c, x, z, 1.5); const f = k.box(0.02, 0.9, 1.3, 0x9a1f1a, x, z + 0.6, 3.6); f.castShadow = false; }
      for (let i = 0; i < 16; i++) { const a = k.rnd() * Math.PI * 2, r = 12 + k.rnd() * 10; k.rock(1 + k.rnd() * 2.2, 0x55565a, 7.5 + Math.cos(a) * r, 6 + Math.sin(a) * r); }
    },
  },
  crossroads: {
    sky: 0x9fd2f2, fog: [0xc2e2f6, 48, 160], hemi: [0xeaf5ff, 0x5a5030, 1.0], sun: [0xfff6e0, 1.75, [0.3, 1, 0.45]],
    apron: 0x7e9142, wall: 'waystone', particles: ['motes'],
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
      for (const x of [6.62, 8.38]) k.box(0.35, 3.6, 0.35, 0x5a3f28, x, 1.4);
      k.box(2 * TILE + 0.4, 0.4, 0.45, 0x5a3f28, 7.5, 1.4, 3.6);
      for (const x of [7.2, 7.8]) k.strip(x, 1.6, x, 16, 0.14, 0x3b3b3e, 0.12);   // rails
      for (let i = 0; i < 5; i++) k.rock(1.2 + k.rnd(), 0x6e6960, -2 - k.rnd() * 4, 3 + i * 3);
      k.cyl(0.6, 0.6, 1.4, 0x4a3524, 17, 3); k.box(0.2, 2.6, 0.2, 0x4a3524, 17, 3, 1.4);   // the winch
    },
  },
  ruin: {
    sky: 0x4b4a67, fog: [0x4b4a67, 28, 100], hemi: [0xc4c6d4, 0x2e2c30, 0.75], sun: [0xe4e2f4, 0.95, [0.2, 1, -0.6]],
    apron: 0x4c5838, wall: 'stone', particles: ['rain'],
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
    apron: 0x55703a, wall: 'drystone', particles: ['mist', 'fireflies'],
    landmark: (k) => {
      // the shepherd's hut, the flock huddled behind the fold, the hills beyond
      k.box(3.2, 2.2, 2.6, 0x8a8478, 17.5, 13); k.put(new THREE.ConeGeometry(2.4, 1.6, 4), 0x5a4a32, 17.5, 3, 13, Math.PI / 4);
      for (let i = 0; i < 9; i++) { const x = 5 + k.rnd() * 6, z = 15.6 + k.rnd() * 1.6; k.box(0.9, 0.6, 0.55, 0xecebe4, x, z, 0.25); k.box(0.3, 0.3, 0.3, 0x2a2622, x + 0.5, z, 0.55); }
      for (let i = 0; i < 7; i++) { const h = X(new THREE.Mesh(new THREE.SphereGeometry(10 + k.rnd() * 8, 12, 8), k.mat(0x3f5a2e))); h.position.set(k.wx(-10 + i * 7), -6, k.wz(-22 - k.rnd() * 6)); k.g.add(h); }
    },
  },
  hollow: {
    sky: 0x1e2a21, fog: [0x1e2a21, 12, 58], hemi: [0x6a8a70, 0x0f140f, 0.5], sun: [0xa8c8a0, 0.5, [0.2, 1, 0.1]],
    apron: 0x2c3921, particles: ['mist', 'fireflies'], trees: { n: 240, near: 0.5, far: 26, color: 0x1f3a1f, dead: 0.25 },
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

    // the ground: one solid block per tile, its top at the tile's surface
    const geo = new THREE.BoxGeometry(TILE, 1, TILE);
    this.groundMesh = X(new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 1 }), this.map.tiles.length));
    this.groundMesh.receiveShadow = true;
    this.paintGround(true);
    this.g.add(this.groundMesh);
    // water surfaces
    const wmat = k.mat(0x2e6488, { transparent: true, opacity: 0.82, roughness: 0.2, metalness: 0.1 });
    for (const t of this.map.tiles) if (t.ground === 'water') { const w = X(new THREE.Mesh(new THREE.PlaneGeometry(TILE, TILE), wmat)); w.rotation.x = -Math.PI / 2; w.position.set(t.wx, this.map.surfaceY(t.x, t.z, false) - 0.12, t.wz); this.g.add(w); }
    // thin grid lines so the tiles still read
    const lines: number[] = [];
    for (const t of this.map.tiles) {
      const y = this.map.surfaceY(t.x, t.z, false) + 0.035, h = TILE / 2;
      lines.push(t.wx - h, y, t.wz - h, t.wx + h, y, t.wz - h, t.wx - h, y, t.wz - h, t.wx - h, y, t.wz + h);
    }
    const lg = new THREE.BufferGeometry(); X(lg).setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    this.g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16 })));

    // walls in the place's style
    for (const t of this.map.tiles) if (t.wall) this.wall(k, t.x, t.z, L.wall ?? 'stone');
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
    // burnt grass turns to ash
    this.paintGround(false);
  }

  dispose(): void {
    this.scene.remove(this.g);
    this.g.traverse((o: Any) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: Any) => m.dispose?.()); });
    this.scene.background = this.saved.bg; this.scene.fog = this.saved.fog;
    for (const [o, c, g, i] of this.saved.hemi) { o.color.copy(c); o.groundColor.copy(g); o.intensity = i; }
    for (const [o, c, i, p] of this.saved.sun) { o.color.copy(c); o.intensity = i; o.position.copy(p); o.target.position.set(0, 0, 0); o.target.updateMatrixWorld(); }
  }
}

