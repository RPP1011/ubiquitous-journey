// Resource sites scattered across the open world, each rooted in the biome that
// fits it: fields in plains, woods in forest, mines in hills, the market + forge
// in the central village. Locations are common knowledge (shared state); site
// kinds line up with PROFESSIONS[*].site so an agent finds "its" workplace.

import * as THREE from 'three';
import { ARENA_RADIUS, BIOME, findBiomeSpot, regionAt, REGIONS, LANDMARKS, terrainHeight } from '../arena.js';
import { TOWNS } from './simconfig.js';
import { buildWalls } from './walls.js';
import type { World as IWorld, Poi, Vec2Like } from '../../types/sim.js';

// A minimal browser-visual mesh node. The vendored `three` is un-typed JS, so TS
// cannot see Object3D's defineProperties-installed transform members; this hand-shape
// covers exactly what the decor builders below touch. Adds nothing at runtime.
interface Obj3D {
  position: { set(x: number, y: number, z: number): void; copy(v: { x: number; y: number; z: number }): { x: number; y: number; z: number }; x: number; y: number; z: number; readonly clone?: () => unknown };
  rotation: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
  castShadow: boolean;
  add(...o: Obj3D[]): void;
}
interface SceneLike { add(o: Obj3D): void; remove(o: Obj3D): void; }

export const POI_KIND = {
  FIELD: 'field', FOREST: 'forest', MINE: 'mine', FORGE: 'forge',
  MARKET: 'market', REST: 'rest', MEADOW: 'meadow', HUT: 'hut',
};

export class World implements IWorld {
  scene: SceneLike;
  pois: Poi[];
  market?: Poi;
  landmarkMeshes?: Obj3D[];

  constructor(scene: SceneLike) {
    this.scene = scene;
    this.pois = [];
    this._build();
  }

  _add(kind: string, pos: THREE.Vector3, mesh?: Obj3D): Poi {
    // ground the site on the terrain surface (Phase 3 elevation) so resource
    // sites sit ON the hills/plains, not under a flat plane. y is cosmetic (the
    // sim picks sites by x/z), so only lift it in the browser — headless keeps
    // y=0 so World.nearest's 3D distance stays flat-plane identical to before.
    let y = 0;
    if (typeof document !== 'undefined') { try { y = terrainHeight(pos.x, pos.z); } catch { /* keep 0 */ } }
    const p = pos.clone(); p.y = y;
    const poi = { kind, pos: p, region: this._regionOf(p), mesh };
    this.pois.push(poi);
    if (mesh) { mesh.position.copy(p); this.scene.add(mesh); }
    return poi;
  }

  _regionOf(p: Vec2Like): string | null { try { return regionAt(p.x, p.z); } catch { return null; } }

  // Scatter `count` sites of `kind` in `biome`, but BIAS placement toward the
  // REGIONS where this resource is rich (economic geography): for each site we
  // sample a few candidate spots and keep the one whose region most favours the
  // matching good, so ore clusters in the Ironhills, food in the Goldfurrows,
  // etc. WHERE an agent works then shapes its wealth + risk. Deterministic-safe
  // (uses the same Math.random the rest of placement does — never at module eval).
  _scatter(kind: string, biome: string, count: number, minR: number, maxR: number, make: () => Obj3D, good?: string) {
    for (let i = 0; i < count; i++) {
      let best: THREE.Vector3 | null = null, bestW = -Infinity;
      for (let t = 0; t < 4; t++) {
        const p = findBiomeSpot(biome, minR, maxR);
        if (!p) continue;
        const regId = this._regionOf(p);
        // REGIONS is a closed config map keyed by region id; look up loosely (unknown id → undefined).
        const reg = regId != null ? (REGIONS as Record<string, { rich?: Record<string, number> }>)[regId] : null;
        // richness weight for THIS good/kind in the candidate's region (default 1)
        const w = reg ? ((reg.rich && ((good != null && reg.rich[good]) || reg.rich[kind])) || 1) : 1;
        if (w > bestW) { bestW = w; best = p; }
      }
      const p = best ||
        new THREE.Vector3(Math.cos(i) * (minR + maxR) / 2, 0, Math.sin(i) * (minR + maxR) / 2);
      this._add(kind, p, make());
    }
  }

  _build() {
    // OPEN WORLD: build a dense village around EACH town centre (market + forges +
    // huts + campfires + its own ring of resource sites), with wilderness between.
    // Town 0 sits at the origin so its terrain/landmarks are unchanged.
    const centers = (TOWNS && TOWNS.centers && TOWNS.centers.length)
      ? TOWNS.centers : [[0, 0]];
    const tr = (TOWNS && TOWNS.radius) || 70;
    for (let ti = 0; ti < centers.length; ti++) {
      const cx = centers[ti][0], cz = centers[ti][1];
      this._buildTown(cx, cz, tr, ti === 0, ti);
    }
    // stone walls ringing each town core (browser-visual; collision is config-pure)
    buildWalls(this.scene);
    // a deep-frontier landmark set (browser-visual) — placed once over the world.
    this._buildLandmarks();
  }

  // raise one town: its market (the trade hub), a forge or two, an apothecary hut,
  // some hearth campfires, and a ring of resource sites in its hinterland. Sites
  // are placed RELATIVE to the town centre so each town has its own reachable
  // economy (proximity keeps its townsfolk local — the social-density guarantee).
  _buildTown(cx: number, cz: number, radius: number, primary: boolean, ti: number) {
    const at = (dx: number, dz: number) => new THREE.Vector3(cx + dx, 0, cz + dz);
    const m = this._add(POI_KIND.MARKET, at(0, 0), makeMarket());
    if (primary) this.market = m;                    // town 0's market = the legacy singleton
    this._add(POI_KIND.FORGE, at(6, -4), makeForge());
    this._add(POI_KIND.FORGE, at(-7, 5), makeForge());
    this._add(POI_KIND.HUT,   at(-9, -6), makeHut()); // apothecary
    for (const [dx, dz] of [[-4, 6], [5, 4], [0, -7], [9, 2]]) this._add(POI_KIND.REST, at(dx, dz), makeCampfire());
    // resource sites ringing this town's hinterland (within its home band so its
    // townsfolk reach them without straying toward another town's sites). Counts come
    // from this town's SPECIALIZATION profile (comparative advantage) — see TOWNS.
    const inner = 18, outer = radius;
    const prof = (TOWNS && TOWNS.profiles && TOWNS.profiles[ti]) || { field: 6, forest: 6, mine: 6, meadow: 5 };
    this._scatterAround(POI_KIND.FIELD,  cx, cz, prof.field,  inner, outer, makeField,  'food');
    this._scatterAround(POI_KIND.FOREST, cx, cz, prof.forest, inner, outer, makeWoods,  'wood');
    this._scatterAround(POI_KIND.MINE,   cx, cz, prof.mine,   inner, outer, makeMine,   'ore');
    this._scatterAround(POI_KIND.MEADOW, cx, cz, prof.meadow, inner, outer, makeMeadow, 'herb');
    this._scatterAround(POI_KIND.REST,   cx, cz, 4,           inner, outer, makeCampfire);
  }

  // scatter `count` sites of `kind` in an annulus [minR,maxR] around (cx,cz).
  // Town-relative placement (vs the origin-biased _scatter) so each town owns a
  // reachable hinterland. Deterministic-safe (same Math.random as other placement).
  _scatterAround(kind: string, cx: number, cz: number, count: number, minR: number, maxR: number, make: () => Obj3D, good?: string) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = minR + Math.random() * (maxR - minR);
      this._add(kind, new THREE.Vector3(cx + Math.cos(ang) * r, 0, cz + Math.sin(ang) * r), make());
    }
  }

  // a random POI of `kind` in a named region (or null) — lets quest/spawn code
  // target "a mine in the Ironhills". Read-only; guarded.
  randomSiteInRegion(kind: string, region: string | null): Poi | null {
    const m = this.pois.filter((p) => p.kind === kind && p.region === region);
    if (m.length) return m[(Math.random() * m.length) | 0];
    return this.randomSite(kind);
  }

  // Visual markers for the named LANDMARKS (a cairn on Highcairn, a signpost at
  // the ford, etc). Browser-only: skipped headless (no scene meshes needed for
  // the sim, which references landmarks via arena.nearestLandmark). Guarded.
  _buildLandmarks() {
    if (typeof document === 'undefined') return;     // headless: nothing to draw
    for (const l of LANDMARKS) {
      let y = 0; try { y = terrainHeight(l.x, l.z); } catch { /* 0 */ }
      const m = makeLandmark(l.kind);
      m.position.set(l.x, y, l.z);
      this.scene.add(m);
      this.landmarkMeshes = this.landmarkMeshes || [];
      this.landmarkMeshes.push(m);
    }
  }

  nearest(kind: string, pos: THREE.Vector3): Poi | null {
    let best: Poi | null = null, bestD = Infinity;
    for (const p of this.pois) {
      if (p.kind !== kind) continue;
      const d = p.pos.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // a random site of a kind (used to scatter spawns across the world)
  randomSite(kind: string): Poi | null {
    const m = this.pois.filter((p) => p.kind === kind);
    return m.length ? m[(Math.random() * m.length) | 0] : null;
  }

  // a random site of a kind within `maxR` of the origin (used to seed the spawn
  // cohort in a TIGHT inner band on the 2x map — agents still lean toward
  // different first trades by kind, but start socially dense near the village so
  // beliefs/groups form, then migrate outward to the spread-out work sites).
  randomSiteNear(kind: string, maxR: number, center?: Vec2Like): Poi | null {
    const cx = center ? center.x : 0, cz = center ? center.z : 0;
    const m = this.pois.filter((p) => p.kind === kind && Math.hypot(p.pos.x - cx, p.pos.z - cz) <= maxR);
    if (m.length) return m[(Math.random() * m.length) | 0];
    return this.randomSite(kind);   // fall back to any if none are near
  }

  dispose() {
    for (const p of this.pois) if (p.mesh) this.scene.remove(p.mesh as Obj3D);
    if (this.landmarkMeshes) for (const m of this.landmarkMeshes) this.scene.remove(m);
    this.landmarkMeshes = [];
    this.pois = [];
  }

  update(dt: number) { /* static for now */ }
}

// ---- site meshes -----------------------------------------------------------
// The vendored `three` is un-typed JS: TS can't see the real Mesh/geometry/material
// ctor signatures, so we view THREE through a minimal hand-written shape (`T3`) for the
// browser-visual decor builders below. One justified cast; adds nothing at runtime.
type Ctor0<T> = new () => T;
type Ctor1<T> = new (...args: unknown[]) => T;
interface T3Shape {
  Group: Ctor0<Obj3D>;
  Mesh: Ctor1<Obj3D>;
  PointLight: Ctor1<Obj3D>;
  ConeGeometry: Ctor1<unknown>;
  CylinderGeometry: Ctor1<unknown>;
  BoxGeometry: Ctor1<unknown>;
  IcosahedronGeometry: Ctor1<unknown>;
  DodecahedronGeometry: Ctor1<unknown>;
  TorusGeometry: Ctor1<unknown>;
  PlaneGeometry: Ctor1<unknown>;
  MeshStandardMaterial: Ctor1<unknown>;
  MeshBasicMaterial: Ctor1<unknown>;
  DoubleSide: number;
}
const T3 = THREE as unknown as T3Shape;

function makeField() {
  const g = new T3.Group();
  const mat = new T3.MeshStandardMaterial({ color: 0xd8b24a, roughness: 1 });
  for (let i = 0; i < 20; i++) {
    const w = new T3.Mesh(new T3.ConeGeometry(0.12, 1.0, 5), mat);
    w.position.set((Math.random() - 0.5) * 5, 0.5, (Math.random() - 0.5) * 5);
    w.castShadow = true; g.add(w);
  }
  return g;
}

function makeWoods() {
  const g = new T3.Group();
  const leaf = new T3.MeshStandardMaterial({ color: 0x2f6d33, roughness: 1, flatShading: true });
  const bark = new T3.MeshStandardMaterial({ color: 0x5a3d24, roughness: 1 });
  for (let i = 0; i < 7; i++) {
    const t = new T3.Group();
    const trunk = new T3.Mesh(new T3.CylinderGeometry(0.14, 0.18, 1.0), bark);
    trunk.position.y = 0.5;
    const crown = new T3.Mesh(new T3.ConeGeometry(0.8, 1.9, 7), leaf);
    crown.position.y = 1.6; crown.castShadow = true;
    t.add(trunk); t.add(crown);
    t.position.set((Math.random() - 0.5) * 5, 0, (Math.random() - 0.5) * 5);
    g.add(t);
  }
  return g;
}

function makeMine() {
  const g = new T3.Group();
  const mat = new T3.MeshStandardMaterial({ color: 0x6f7681, roughness: 1, flatShading: true });
  for (let i = 0; i < 9; i++) {
    const r = new T3.Mesh(new T3.IcosahedronGeometry(0.45 + Math.random() * 0.6, 0), mat);
    r.position.set((Math.random() - 0.5) * 4.5, 0.3, (Math.random() - 0.5) * 4.5);
    r.rotation.set(Math.random(), Math.random(), Math.random());
    r.castShadow = true; g.add(r);
  }
  // a pit-entrance timber
  const beam = new T3.Mesh(new T3.BoxGeometry(2, 0.2, 0.2),
    new T3.MeshStandardMaterial({ color: 0x4a3526 }));
  beam.position.y = 1.1; g.add(beam);
  return g;
}

function makeForge() {
  const g = new T3.Group();
  const base = new T3.Mesh(new T3.BoxGeometry(1.2, 0.5, 1.2),
    new T3.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.8 }));
  base.position.y = 0.25; base.castShadow = true;
  const anvil = new T3.Mesh(new T3.BoxGeometry(0.9, 0.35, 0.4),
    new T3.MeshStandardMaterial({ color: 0x55585f }));
  anvil.position.set(0.9, 0.45, 0);
  const fire = new T3.Mesh(new T3.ConeGeometry(0.3, 0.6, 8),
    new T3.MeshBasicMaterial({ color: 0xff7a1e }));
  fire.position.y = 0.6;
  const light = new T3.PointLight(0xff8030, 6, 9, 2); light.position.y = 1;
  g.add(base, anvil, fire, light);
  return g;
}

function makeMarket() {
  const g = new T3.Group();
  const well = new T3.Mesh(new T3.CylinderGeometry(0.9, 0.9, 0.7, 14),
    new T3.MeshStandardMaterial({ color: 0x808890, roughness: 0.9 }));
  well.position.y = 0.35; well.castShadow = true; g.add(well);
  const cols = [0xc94f4f, 0x4f86d6, 0x5f9f4f, 0xd8b24a, 0xb060c0, 0xe0a040];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const stall = new T3.Group();
    const post = new T3.Mesh(new T3.BoxGeometry(0.1, 1.2, 0.1),
      new T3.MeshStandardMaterial({ color: 0x6a4b2f }));
    post.position.y = 0.6;
    const top = new T3.Mesh(new T3.BoxGeometry(1.6, 0.1, 1.0),
      new T3.MeshStandardMaterial({ color: cols[i] }));
    top.position.y = 1.2;
    stall.add(post, top);
    stall.position.set(Math.cos(a) * 3.6, 0, Math.sin(a) * 3.6);
    g.add(stall);
  }
  return g;
}

function makeMeadow() {
  const g = new T3.Group();
  const stem = new T3.MeshStandardMaterial({ color: 0x5f9f4f, roughness: 1 });
  const blooms = [0xe06f9c, 0xe0c84a, 0x9c6fe0, 0xffffff];
  for (let i = 0; i < 18; i++) {
    const p = new T3.Group();
    const s = new T3.Mesh(new T3.CylinderGeometry(0.03, 0.04, 0.5, 4), stem);
    s.position.y = 0.25;
    const b = new T3.Mesh(new T3.IcosahedronGeometry(0.12, 0),
      new T3.MeshStandardMaterial({ color: blooms[(Math.random() * blooms.length) | 0], roughness: 0.8 }));
    b.position.y = 0.55;
    p.add(s, b);
    p.position.set((Math.random() - 0.5) * 5, 0, (Math.random() - 0.5) * 5);
    g.add(p);
  }
  return g;
}

function makeHut() {
  const g = new T3.Group();
  const wall = new T3.Mesh(new T3.BoxGeometry(2.2, 1.6, 2.2),
    new T3.MeshStandardMaterial({ color: 0x8a6b4a, roughness: 1 }));
  wall.position.y = 0.8; wall.castShadow = true;
  const roof = new T3.Mesh(new T3.ConeGeometry(1.9, 1.1, 4),
    new T3.MeshStandardMaterial({ color: 0x5a7b8a, flatShading: true }));
  roof.position.y = 2.1; roof.rotation.y = Math.PI / 4; roof.castShadow = true;
  const cauldron = new T3.Mesh(new T3.CylinderGeometry(0.4, 0.3, 0.5, 10),
    new T3.MeshStandardMaterial({ color: 0x2c2c30 }));
  cauldron.position.set(1.6, 0.25, 0);
  const brew = new T3.PointLight(0x80ffb0, 4, 5, 2); brew.position.set(1.6, 0.6, 0);
  g.add(wall, roof, cauldron, brew);
  return g;
}

// a named-landmark marker, styled by kind (a cairn/peak, ford signpost, vale
// menhir, town banner, frontier gate). Cheap primitives; browser-visual only.
function makeLandmark(kind: string) {
  const g = new T3.Group();
  if (kind === 'peak') {
    const stone = new T3.MeshStandardMaterial({ color: 0x8a8276, roughness: 1, flatShading: true });
    for (let i = 0; i < 4; i++) {
      const r = new T3.Mesh(new T3.DodecahedronGeometry(1.2 - i * 0.25, 0), stone);
      r.position.y = 0.6 + i * 1.0; r.rotation.y = i; r.castShadow = true; g.add(r);
    }
  } else if (kind === 'ford' || kind === 'gate') {
    const wood = new T3.MeshStandardMaterial({ color: 0x6a4b2f, roughness: 1 });
    const post = new T3.Mesh(new T3.CylinderGeometry(0.12, 0.14, 2.6, 6), wood);
    post.position.y = 1.3; post.castShadow = true;
    const arm = new T3.Mesh(new T3.BoxGeometry(1.4, 0.3, 0.1), wood);
    arm.position.set(0.5, 2.1, 0); g.add(post, arm);
  } else if (kind === 'vale') {
    const stone = new T3.MeshStandardMaterial({ color: 0x5a5550, roughness: 1, flatShading: true });
    const menhir = new T3.Mesh(new T3.BoxGeometry(0.8, 3.4, 0.5), stone);
    menhir.position.y = 1.7; menhir.rotation.z = 0.08; menhir.castShadow = true; g.add(menhir);
  } else {  // town
    const pole = new T3.Mesh(new T3.CylinderGeometry(0.08, 0.08, 3.2, 6),
      new T3.MeshStandardMaterial({ color: 0x6a4b2f }));
    pole.position.y = 1.6;
    const flag = new T3.Mesh(new T3.PlaneGeometry(1.2, 0.7),
      new T3.MeshStandardMaterial({ color: 0xc94f4f, side: T3.DoubleSide }));
    flag.position.set(0.6, 2.8, 0); g.add(pole, flag);
  }
  return g;
}

function makeCampfire() {
  const g = new T3.Group();
  const ring = new T3.Mesh(new T3.TorusGeometry(0.55, 0.1, 6, 16),
    new T3.MeshStandardMaterial({ color: 0x5a4632 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.1;
  const fire = new T3.Mesh(new T3.ConeGeometry(0.28, 0.6, 8),
    new T3.MeshBasicMaterial({ color: 0xff8a2a }));
  fire.position.y = 0.45;
  g.add(ring, fire);
  return g;
}
