// BattleRender: draws a tactical Battle's grid, props and fire into the Three.js scene, and
// picks tiles under the cursor. Read-only over the battle — it never mutates it.
//
//   tiles   one InstancedMesh of flat quads at each tile's standing height, tinted per state:
//           reachable (blue), targetable (red), the acting unit (gold), fire, smoke, wet
//   props   simple primitive meshes per kind (crate, barrel, hay, brazier, cart, tree, …)
//   fire    flickering flame cones on burning tiles and props

import * as THREE from 'three';
import { TILE, LEVEL, type BattleMap, type Prop } from '../app/tactics/map.js';
import type { Battle, Spot } from '../app/tactics/battle.js';
import { buildProp } from './propModels.js';

// The vendored three.module.js is plain JS: transform members are invisible to tsc.
interface Obj3 {
  position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { set(x: number, y: number, z: number): void };
  visible: boolean; renderOrder: number;
  add(o: unknown): void;
}
const o3 = (m: unknown) => m as Obj3;

const COL = {
  base: new THREE.Color(0x1d2a33), reach: new THREE.Color(0x3d7fd6), target: new THREE.Color(0xd65a4a),
  path: new THREE.Color(0x7fb6ff), current: new THREE.Color(0xe8c879), fire: new THREE.Color(0xff7a1a),
  smoke: new THREE.Color(0x9a9a9a), wet: new THREE.Color(0x3ec7d6), ash: new THREE.Color(0x3a3a3a), hover: new THREE.Color(0xffffff),
};

const PROP_LOOK: Record<string, { geo: () => THREE.BufferGeometry; color: number; y: number }> = {
  crate: { geo: () => new THREE.BoxGeometry(1.2, 1.1, 1.2), color: 0x8a6238, y: 0.55 },
  barrel: { geo: () => new THREE.CylinderGeometry(0.5, 0.5, 1.1, 12), color: 0x6e4a2a, y: 0.55 },
  oil: { geo: () => new THREE.CylinderGeometry(0.5, 0.5, 1.1, 12), color: 0x3b2a1e, y: 0.55 },
  hay: { geo: () => new THREE.BoxGeometry(1.4, 0.9, 1.0), color: 0xd8b64a, y: 0.45 },
  campfire: { geo: () => new THREE.CylinderGeometry(0.7, 0.8, 0.25, 10), color: 0x4a3a32, y: 0.12 },
  brazier: { geo: () => new THREE.CylinderGeometry(0.45, 0.3, 1.0, 10), color: 0x2f2f33, y: 0.5 },
  bucket: { geo: () => new THREE.CylinderGeometry(0.28, 0.22, 0.45, 10), color: 0x5aa7d8, y: 0.22 },
  flour: { geo: () => new THREE.BoxGeometry(0.6, 0.5, 0.4), color: 0xefe8d6, y: 0.25 },
  rocks: { geo: () => new THREE.DodecahedronGeometry(0.35), color: 0x8a8a86, y: 0.3 },
  table: { geo: () => new THREE.BoxGeometry(1.7, 0.9, 0.9), color: 0x9a7248, y: 0.45 },
  cart: { geo: () => new THREE.BoxGeometry(1.8, 1.3, 1.3), color: 0x7a5530, y: 0.65 },
  tree: { geo: () => new THREE.ConeGeometry(0.9, 3.4, 8), color: 0x2f5e2f, y: 1.9 },
  well: { geo: () => new THREE.CylinderGeometry(0.8, 0.8, 0.9, 14), color: 0x7d7d78, y: 0.45 },
  log: { geo: () => new THREE.CylinderGeometry(0.3, 0.3, 1.8, 8), color: 0x5e4128, y: 0.3 },
  torch: { geo: () => new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6), color: 0x5e4128, y: 0.5 },
  relic: { geo: () => new THREE.BoxGeometry(0.55, 0.45, 0.4), color: 0xd8dde6, y: 0.25 },
  tent: { geo: () => new THREE.ConeGeometry(1.1, 1.8, 4), color: 0xb9a57c, y: 0.9 },
};

export class BattleRender {
  private scene: { add(o: unknown): void; remove(o: unknown): void };
  private battle: Battle;
  private map: BattleMap;
  private tiles: THREE.InstancedMesh;
  private propMeshes = new Map<string, THREE.Object3D>();
  private propState = new Map<string, { pos: THREE.Vector3; tip: number; roll: number; dying: number }>();
  private flames: THREE.Mesh[] = [];
  private flameGeo = new THREE.ConeGeometry(0.35, 1.0, 7);
  private flameMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85 });
  private ray = new THREE.Raycaster();
  private t = 0;
  hover: Spot | null = null;
  reach = new Set<string>();
  targets = new Set<string>();
  path: Spot[] = [];

  constructor(scene: { add(o: unknown): void; remove(o: unknown): void }, battle: Battle) {
    this.scene = scene; this.battle = battle; this.map = battle.map;
    const geo = new THREE.PlaneGeometry(TILE * 0.94, TILE * 0.94);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
    this.tiles = new THREE.InstancedMesh(geo, mat, this.map.tiles.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const one = new THREE.Vector3(1, 1, 1);
    this.map.tiles.forEach((t, i) => {
      m.compose(new THREE.Vector3(t.wx, this.map.surfaceY(t.x, t.z, false) + 0.06, t.wz), q, one);
      this.tiles.setMatrixAt(i, m);
      this.tiles.setColorAt(i, COL.base);
    });
    o3(this.tiles).renderOrder = 5;
    scene.add(this.tiles);
    this.sync();
  }

  /** The tile under a normalised-device-coordinate cursor. */
  pick(camera: THREE.Camera, ndc: { x: number; y: number }): Spot | null {
    this.ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const hit = this.ray.intersectObject(this.tiles, false)[0];
    if (!hit || hit.instanceId == null) return null;
    const t = this.map.tiles[hit.instanceId];
    return { x: t.x, z: t.z };
  }

  /** Refresh tints, props and flames from the battle's current state. Cheap (≤ 256 tiles). */
  sync(dt = 0): void {
    this.t += dt;
    const cur = this.battle.current();
    const pathSet = new Set(this.path.map((p) => `${p.x},${p.z}`));
    this.map.tiles.forEach((t, i) => {
      const k = `${t.x},${t.z}`;
      let c = COL.base;
      if (t.ground === 'ash') c = COL.ash;
      if (t.wet > 0) c = COL.wet;
      if (t.smoke > 0) c = COL.smoke;
      if (this.reach.has(k)) c = COL.reach;
      if (pathSet.has(k)) c = COL.path;
      if (this.targets.has(k)) c = COL.target;
      if (cur && cur.x === t.x && cur.z === t.z) c = COL.current;
      if (t.burning > 0) c = COL.fire;
      if (this.hover && this.hover.x === t.x && this.hover.z === t.z) c = COL.hover;
      this.tiles.setColorAt(i, c);
    });
    if (this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true;

    // props: add new; ease existing toward where the rules put them (a kicked barrel ROLLS, a
    // tipped table FALLS); the removed shrink away (burnt, thrown, picked up)
    const live = new Set<string>();
    const ease = 1 - Math.exp(-dt * 9);
    for (const p of this.map.props.values()) {
      live.add(p.id);
      const t = this.map.tile(p.x, p.z)!;
      const target = new THREE.Vector3(t.wx, this.map.surfaceY(t.x, t.z, false), t.wz);
      let mesh = this.propMeshes.get(p.id);
      let st = this.propState.get(p.id);
      if (!mesh || !st) {
        mesh = buildProp(p.kind); this.propMeshes.set(p.id, mesh); this.scene.add(mesh);
        st = { pos: target.clone(), tip: p.tipped ? 1 : 0, roll: 0, dying: 0 };
        this.propState.set(p.id, st);
        o3(mesh).rotation.y = (p.x * 7 + p.z * 13) % 6 * 0.5;        // a little variety
      }
      const before = st.pos.clone();
      st.pos.lerp(target, dt ? ease : 1);
      st.roll += before.distanceTo(st.pos) / 0.5;
      st.tip += ((p.tipped ? 1 : 0) - st.tip) * (dt ? ease : 1);
      o3(mesh).position.set(st.pos.x, st.pos.y + st.tip * 0.45, st.pos.z);
      o3(mesh).rotation.z = st.tip * Math.PI / 2;
      if (p.kind === 'barrel' || p.kind === 'oil') o3(mesh).rotation.x = st.roll;
      const char = p.burning > 0 ? 0.6 : 1;
      o3(mesh).scale.set(1, char + (1 - char) * Math.abs(Math.sin(this.t * 3)), 1);
    }
    for (const [id, mesh] of this.propMeshes) {
      if (live.has(id)) continue;
      const st = this.propState.get(id)!;
      st.dying += dt;
      const k = Math.max(0, 1 - st.dying / 0.4);
      o3(mesh).scale.set(k, k, k);
      if (k <= 0) { this.scene.remove(mesh); this.propMeshes.delete(id); this.propState.delete(id); }
    }

    // flames on burning tiles and props, plus lit fire sources
    const spots: Array<{ x: number; y: number; z: number; s: number }> = [];
    for (const t of this.map.tiles) if (t.burning > 0) spots.push({ x: t.wx, y: this.map.surfaceY(t.x, t.z, false), z: t.wz, s: 1 });
    for (const p of this.map.props.values()) {
      if (p.fireSource || p.burning > 0) { const t = this.map.tile(p.x, p.z)!; spots.push({ x: t.wx, y: this.map.surfaceY(t.x, t.z, false) + (p.kind === 'brazier' ? 1.0 : p.kind === 'torch' ? 1.0 : 0.2), z: t.wz, s: p.kind === 'torch' ? 0.4 : 0.8 }); }
    }
    for (const u of this.battle.active()) if (u.burning > 0) spots.push({ x: u.agent.pos.x, y: u.agent.pos.y + 1.2, z: u.agent.pos.z, s: 0.6 });
    while (this.flames.length < spots.length) { const f = new THREE.Mesh(this.flameGeo, this.flameMat); this.flames.push(f); this.scene.add(f); }
    this.flames.forEach((f, i) => {
      const s = spots[i];
      o3(f).visible = !!s;
      if (!s) return;
      const flick = 0.8 + 0.25 * Math.sin(this.t * 13 + i * 1.7);
      o3(f).position.set(s.x, s.y + 0.5 * s.s * flick, s.z);
      o3(f).scale.set(s.s, s.s * flick * 1.3, s.s);
    });
  }

  dispose(): void {
    this.scene.remove(this.tiles);
    for (const m of this.propMeshes.values()) this.scene.remove(m);
    for (const f of this.flames) this.scene.remove(f);
    this.propMeshes.clear(); this.flames = [];
  }
}
