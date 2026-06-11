// The open world: a large biome-painted ground (plains / forest / hills /
// wilds), scattered terrain props, lighting and sky. Exports a deterministic
// biomeAt(x,z) so the rest of the sim can place resources in the right terrain
// and (later) vary movement/encounters by biome.

import * as THREE from 'three';
import { rng } from './sim/rng.js';
import { ROADS } from './sim/roads.js';

// The vendored three.module.js is un-typed JS; tsc cannot see Object3D's
// getter-installed transform/scene members. These minimal views cover exactly
// what the scene-building helpers below touch. Add nothing at runtime.
interface SceneLike {
  background: THREE.Color;
  fog: THREE.Fog;
  add(o: object): void;
}
// A scene-graph node's transform/render surface (the getter-installed members tsc
// can't see on the vendored JS classes). xf() recovers it for the build helpers below.
interface Node3D {
  position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  renderOrder: number;
  castShadow: boolean;
  receiveShadow: boolean;
  frustumCulled: boolean;
}
const xf = (o: object): Node3D => o as unknown as Node3D;
// A BufferAttribute's accessors (get/set per index) — same getter-gap as above.
interface PosAttr { count: number; getX(i: number): number; getZ(i: number): number; setY(i: number, v: number): void; }
// The vendored Mesh ctor defaults `material = new MeshBasicMaterial()`, so tsc narrows
// the param to MeshBasicMaterial and rejects a MeshStandardMaterial. This thin wrapper
// widens the material param back to the Material base it actually accepts.
const mesh = (g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh =>
  new THREE.Mesh(g, m as THREE.MeshBasicMaterial);

export const ARENA_RADIUS = 600;           // playable world radius (Phase A expansion: ~1.1 km² — four towns + a true frontier band; landmarks/camps/glory-prowl all scale off this)
const GROUND = ARENA_RADIUS + 16;          // ground half-extent (past the edge)

export const BIOME = { VILLAGE: 'village', PLAINS: 'plains', FOREST: 'forest', HILLS: 'hills', WILDS: 'wilds' };

const BIOME_COLOR: Record<string, number> = {
  village: 0x7c8a58,
  plains:  0x6f8050,
  forest:  0x445f39,
  hills:   0x847b69,
  wilds:   0x57523f,
};

// deterministic smooth pseudo-noise in roughly [-2, 2]
function noise(x: number, z: number): number {
  return Math.sin(x * 0.055) * Math.cos(z * 0.061)
       + 0.6 * Math.sin((x + z) * 0.033)
       + 0.5 * Math.cos((x - z) * 0.047);
}

// What biome is at world (x,z)? Stable across rebuilds.
export function biomeAt(x: number, z: number): string {
  const r = Math.hypot(x, z);
  if (r < 16) return BIOME.VILLAGE;                 // central clearing = the town
  if (r > ARENA_RADIUS * 0.74) return BIOME.WILDS;  // dangerous frontier
  const v = noise(x, z);
  if (v > 0.85) return BIOME.FOREST;
  if (v < -0.85) return BIOME.HILLS;
  return BIOME.PLAINS;
}

export function biomeColor(b: string): number { return BIOME_COLOR[b] ?? 0x6f8050; }

// ===========================================================================
// PHASE 3 — terrain that is CONSEQUENTIAL (geography hooks into the sim).
// Everything here is a PURE deterministic function of (x,z): no Math.random(),
// no Date — stable across rebuilds and safe to call on the headless fixed tick.
// ===========================================================================

// --- elevation -------------------------------------------------------------
// A smooth height field in metres. The central village is a flat basin; the
// land rises toward the hills/wilds and dips into a couple of low vales. This
// is the single source of truth: the 3D mesh, agent y, perception (high ground
// sees farther) and movement cost (cliffs slow) all sample it.
const RIDGE_X = ARENA_RADIUS * 0.55, RIDGE_Z = -ARENA_RADIUS * 0.45;  // the great ridge
export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r < 16) return 0;                              // flat village basin
  // base swell that grows toward the frontier, plus rolling noise
  let h = (r / ARENA_RADIUS) * 6 + noise(x, z) * 2.2 + Math.sin(x * 0.02) * Math.cos(z * 0.018) * 3;
  // a named high ridge in the north-east hills (a landmark + a sightline perch)
  const rd = Math.hypot(x - RIDGE_X, z - RIDGE_Z);
  h += Math.max(0, 14 - rd * 0.55);
  // a sunken vale in the south-west (low ground that conceals)
  const vd = Math.hypot(x + ARENA_RADIUS * 0.5, z + ARENA_RADIUS * 0.5);
  h -= Math.max(0, 8 - vd * 0.4);
  return h;
}

// --- water / ravines (movement barriers -> chokepoints) --------------------
// A river arcs across the map; a couple of ravines cut the hills. `barrierAt`
// returns a code: 0 = open ground, 1 = water (river), 2 = ravine. Agents pay a
// heavy movement cost crossing these, so routes funnel through the gaps (fords /
// land-bridges) — emergent chokepoints + ambush sites from pure geometry.
// Cheap: a handful of trig/hypot ops, fully deterministic.
const FORD_X = -8;                                   // the village ford (a gap in the river)
export function barrierAt(x: number, z: number): number {
  // the river: a sinuous band at a roughly-constant signed distance from centre.
  // channel = how far z sits from the river's winding centreline at this x.
  const riverZ = ARENA_RADIUS * 0.32 + Math.sin(x * 0.04) * 22;
  const channel = Math.abs(z - riverZ);
  // TWO fords keep the river a real chokepoint without strangling trade flow: the
  // generous village ford near town, plus a far eastern crossing for the hills.
  const ford = Math.abs(x - FORD_X) < 13 || Math.abs(x - ARENA_RADIUS * 0.55) < 9;
  // the river only runs through the OUTER half of the map — the dense inner trade
  // core stays barrier-free so the economy flows, while the crossing is a real
  // chokepoint between the town and the resource-rich outer regions.
  if (channel < 5 && !ford && Math.hypot(x, z) > ARENA_RADIUS * 0.45) return 1;  // water
  // a ravine raking the north-east hills (skirts the ridge, leaving a land bridge)
  const rav = Math.abs((x - RIDGE_X) * 0.7 + (z - RIDGE_Z)) ;
  if (rav < 4 && Math.hypot(x - RIDGE_X, z - RIDGE_Z) > 10 &&
      Math.hypot(x - RIDGE_X, z - RIDGE_Z) < 46) return 2;       // ravine
  return 0;
}

// --- concealment (perception modifier) -------------------------------------
// 0 = wide open (full sight), up to ~0.6 = heavily concealed. Dense forest and
// low/sunken ground hide; open plains and high ground don't. perceive() folds
// BOTH the seer's vantage and the seen agent's cover into effective vision, so
// high ground sees far and a quarry in deep wood / a vale is hard to spot — the
// substrate for ambush + the spy/disguise belief-asymmetry layer.
export function concealmentAt(x: number, z: number): number {
  const b = biomeAt(x, z);
  let c = 0;
  if (b === BIOME.FOREST) c += 0.45;
  else if (b === BIOME.WILDS) c += 0.25;
  // low ground (below the basin level) adds cover; high ground adds none
  const h = terrainHeight(x, z);
  if (h < -1) c += Math.min(0.3, (-1 - h) * 0.06);
  return Math.max(0, Math.min(0.7, c));
}

// --- regions (economic geography) ------------------------------------------
// The map is carved into named REGIONS with different resource richness and
// danger, so WHERE an agent works shapes its wealth and risk. world.js biases
// POI scatter by each region's `rich` table (which GOODS sites cluster where)
// and the monster spawn frontier reads `danger`. Pure function of (x,z).
export const REGION = {
  HEARTH:   'hearth',     // the safe central vale around the village
  GOLDFURROWS: 'goldfurrows', // fertile plains: food + herb rich, calm
  IRONHILLS:   'ironhills',   // the ore-rich hills: ore + wood, some danger
  THORNWILDS:  'thornwilds',  // the dangerous frontier: scarce but lucrative, monster-ridden
};
// region table: human label + which GOOD sites are favoured there + danger 0..1
interface RegionInfo { label: string; rich: Record<string, number>; danger: number; }
export const REGIONS: Record<string, RegionInfo> = {
  hearth:      { label: 'The Hearth',       rich: { food: 1.2, herb: 1.1 },           danger: 0.0 },
  goldfurrows: { label: 'The Goldfurrows',  rich: { food: 1.6, herb: 1.4 },           danger: 0.1 },
  ironhills:   { label: 'The Ironhills',    rich: { ore: 1.7, wood: 1.3, mine: 1.7 }, danger: 0.35 },
  thornwilds:  { label: 'The Thornwilds',   rich: { ore: 1.2, wood: 1.2 },            danger: 1.0 },
};
export function regionAt(x: number, z: number): string {
  const r = Math.hypot(x, z);
  if (r < 22) return REGION.HEARTH;
  if (r > ARENA_RADIUS * 0.74) return REGION.THORNWILDS;
  // east of centre + hilly -> the Ironhills; the fertile west/south -> Goldfurrows
  const b = biomeAt(x, z);
  if (b === BIOME.HILLS || (x > 10 && z < ARENA_RADIUS * 0.3)) return REGION.IRONHILLS;
  return REGION.GOLDFURROWS;
}

// --- named landmarks (places agents/players can reference) -----------------
// A handful of fixed, named places. nearestLandmark gives the closest within a
// radius for "near Highcairn", region/biography flavour, and (browser) markers.
export interface Landmark { name: string; x: number; z: number; kind: string; }
export const LANDMARKS: Landmark[] = [
  { name: 'Highcairn',    x: RIDGE_X, z: RIDGE_Z,                                  kind: 'peak'  },
  { name: 'The Old Ford', x: FORD_X,  z: ARENA_RADIUS * 0.32 + Math.sin(FORD_X * 0.04) * 22, kind: 'ford' },
  { name: 'Wraithmere',   x: -ARENA_RADIUS * 0.5, z: -ARENA_RADIUS * 0.5,         kind: 'vale'  },
  { name: 'Marketwell',   x: 0,       z: 0,                                       kind: 'town'  },
  { name: 'The Thorngate', x: ARENA_RADIUS * 0.82, z: 0,                          kind: 'gate'  },
];
export function nearestLandmark(x: number, z: number, maxR = Infinity): Landmark | null {
  let best: Landmark | null = null, bd = maxR * maxR;
  for (const l of LANDMARKS) {
    const d = (l.x - x) * (l.x - x) + (l.z - z) * (l.z - z);
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

// Find a random spot in a given biome within a radius band (or null if none).
export function findBiomeSpot(biome: string, minR: number, maxR: number, tries = 40): THREE.Vector3 | null {
  for (let i = 0; i < tries; i++) {
    const a = rng() * Math.PI * 2;
    const r = minR + rng() * (maxR - minR);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (biomeAt(x, z) === biome) return new THREE.Vector3(x, 0, z);
  }
  return null;
}

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export function buildArena(scene: SceneLike): void {
  scene.background = new THREE.Color(0x9ec4e0);
  scene.fog = new THREE.Fog(0x9ec4e0, 70, 220);

  // --- biome-painted, ELEVATED ground (Phase 3) ------------------------------
  // The plane is displaced by terrainHeight(x,z) — the SAME field the sim samples
  // for agent y / perception / movement — so what you SEE (hills, the vale) is
  // what the agents actually act on. Denser subdivision so the relief reads.
  const seg = 160;
  const geo = new THREE.PlaneGeometry(GROUND * 2, GROUND * 2, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = (geo.attributes as Record<string, unknown>).position as unknown as PosAttr;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);                                   // raise the land
    const bar = barrierAt(x, z);
    _c.setHex(bar === 1 ? 0x2f5a7a : bar === 2 ? 0x3a3026 : biomeColor(biomeAt(x, z)));
    // subtle per-vertex value jitter + a touch of height shading
    const j = 1 + (noise(x * 1.7, z * 1.7) * 0.04) + Math.max(-0.06, Math.min(0.1, h * 0.006));
    colors[i * 3] = _c.r * j; colors[i * 3 + 1] = _c.g * j; colors[i * 3 + 2] = _c.b * j;
  }
  geo.computeVertexNormals();
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const ground = mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  xf(ground).receiveShadow = true;
  scene.add(ground);

  // a translucent water plane sitting just below the village basin, so the river
  // channels read as water (the displaced ground dips; this catches the light).
  const water = mesh(
    new THREE.PlaneGeometry(GROUND * 2, GROUND * 2, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x3a6f96, transparent: true, opacity: 0.5, roughness: 0.3, metalness: 0.1 }));
  const waterX = xf(water); waterX.rotation.x = -Math.PI / 2; waterX.position.y = -0.6; waterX.renderOrder = -1;
  scene.add(water);

  // --- trade roads (dirt strips along the inter-town road graph) -------------
  buildRoadStrips(scene);

  // --- scattered terrain props (instanced for cheapness) ---------------------
  buildProps(scene);

  // faint boundary ring at the world edge
  const ring = mesh(
    new THREE.RingGeometry(ARENA_RADIUS, ARENA_RADIUS + 0.6, 160),
    new THREE.MeshBasicMaterial({ color: 0x2c361f, side: THREE.DoubleSide, transparent: true, opacity: 0.5 }));
  const ringX = xf(ring); ringX.rotation.x = -Math.PI / 2; ringX.position.y = 0.02;
  scene.add(ring);

  // --- lighting --------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x46402f, 0.9));
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.55);
  // A directional light's transform + shadow surface (getter-installed; tsc can't see it).
  const sunX = sun as unknown as {
    position: { set(x: number, y: number, z: number): void };
    castShadow: boolean;
    target: object;
    shadow: {
      bias: number;
      mapSize: { set(w: number, h: number): void };
      camera: { left: number; right: number; top: number; bottom: number; near: number; far: number };
    };
  };
  sunX.position.set(40, 70, 28);
  sunX.castShadow = true;
  sunX.shadow.mapSize.set(2048, 2048);
  const s = 48;                       // shadow covers the area around the town
  sunX.shadow.camera.left = -s; sunX.shadow.camera.right = s;
  sunX.shadow.camera.top = s; sunX.shadow.camera.bottom = -s;
  sunX.shadow.camera.near = 1; sunX.shadow.camera.far = 200;
  sunX.shadow.bias = -0.0004;
  scene.add(sun); scene.add(sunX.target);
}

// The visible trade roads: one flat dirt-coloured ribbon per ROADS segment, draped
// over the displaced terrain (vertices sampled every few metres at terrainHeight, the
// SAME field the ground mesh uses, lifted a touch to clear the relief between ground
// vertices). Browser-only decor, guarded exactly like the walls/defenses meshes —
// headless never builds geometry. The sim reads the road GRAPH (sim/roads.js), never
// this mesh.
function buildRoadStrips(scene: SceneLike): void {
  if (typeof document === 'undefined') return;          // browser-only decor
  const HALF_W = 1.6;       // road half-width (a cart-track, not a highway)
  const STEP = 4;           // metres between cross-sections (follows the relief)
  const LIFT = 0.3;         // clear the linearly-interpolated ground between its vertices
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a7355, roughness: 1 });
  for (const s of ROADS) {
    const n = Math.max(2, Math.ceil(s.len / STEP) + 1);   // cross-sections along the segment
    const dx = (s.bx - s.ax) / s.len, dz = (s.bz - s.az) / s.len;
    const px = -dz, pz = dx;                              // lateral (perpendicular) unit
    const verts = new Float32Array(n * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * s.len;
      const cx = s.ax + dx * t, cz = s.az + dz * t;
      for (let side = 0; side < 2; side++) {
        const off = side === 0 ? -HALF_W : HALF_W;
        const x = cx + px * off, z = cz + pz * off;
        const v = (i * 2 + side) * 3;
        verts[v] = x; verts[v + 1] = terrainHeight(x, z) + LIFT; verts[v + 2] = z;
      }
      if (i > 0) {
        const a = (i - 1) * 2, b = i * 2;
        idx.push(a, a + 1, b, b, a + 1, b + 1);   // wound so the face normal points UP
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const strip = mesh(geo, mat);
    xf(strip).receiveShadow = true;
    scene.add(strip);
  }
}

// place ambient trees (forest) + rocks (hills) + grass (plains) via InstancedMesh
interface Prop { x: number; z: number; scale: number; rot: number; y: number; }
function buildProps(scene: SceneLike): void {
  const trunkM: Prop[] = [], crownM: Prop[] = [], rockM: Prop[] = [], grassM: Prop[] = [];
  const step = 4.5;   // wider scatter step on the 2x map keeps prop instance counts ~constant
  for (let x = -ARENA_RADIUS; x <= ARENA_RADIUS; x += step) {
    for (let z = -ARENA_RADIUS; z <= ARENA_RADIUS; z += step) {
      if (Math.hypot(x, z) > ARENA_RADIUS) continue;
      const jx = x + (noise(x * 9, z * 3) ) * 1.2;
      const jz = z + (noise(x * 3, z * 9) ) * 1.2;
      const b = biomeAt(jx, jz);
      const h = noise(jx * 2.1, jz * 2.3);              // 0..1-ish gate for density
      if (b === BIOME.FOREST && h > 0.2) { trunkM.push(spot(jx, jz, 0.4 + h * 0.2)); crownM.push(spot(jx, jz, 0.4 + h * 0.2)); }
      else if (b === BIOME.WILDS && h > 0.9) { trunkM.push(spot(jx, jz, 0.5)); crownM.push(spot(jx, jz, 0.5)); }
      else if (b === BIOME.HILLS && h > 0.1) rockM.push(spot(jx, jz, 0.6 + h * 0.5, true));
      else if ((b === BIOME.PLAINS || b === BIOME.VILLAGE) && h > 0.55) grassM.push(spot(jx, jz, 0.5));
    }
  }
  addInstanced(scene, new THREE.CylinderGeometry(0.16, 0.22, 1.4, 5),
    new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 1 }), trunkM, 0.7, false);
  addInstanced(scene, new THREE.ConeGeometry(1.0, 2.4, 7),
    new THREE.MeshStandardMaterial({ color: 0x335026, roughness: 1, flatShading: true }), crownM, 2.0, true);
  addInstanced(scene, new THREE.IcosahedronGeometry(0.7, 0),
    new THREE.MeshStandardMaterial({ color: 0x7c828b, roughness: 1, flatShading: true }), rockM, 0.4, true);
  addInstanced(scene, new THREE.ConeGeometry(0.18, 0.7, 4),
    new THREE.MeshStandardMaterial({ color: 0x8aa056, roughness: 1 }), grassM, 0.35, false);
}

function spot(x: number, z: number, scale: number, rand = false): Prop {
  return { x, z, scale, rot: rand ? rng() * Math.PI : 0, y: terrainHeight(x, z) };
}

function addInstanced(
  scene: SceneLike,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  list: Prop[],
  yBase: number,
  shadow: boolean,
): void {
  if (!list.length) return;
  const im = new THREE.InstancedMesh(geo, mat as THREE.MeshBasicMaterial, list.length);
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    _p.set(o.x, (o.y || 0) + yBase * o.scale, o.z);
    _q.setFromEuler(new THREE.Euler(0, o.rot, 0));
    _s.set(o.scale, o.scale, o.scale);
    _m.compose(_p, _q, _s);
    im.setMatrixAt(i, _m);
  }
  const imX = xf(im); imX.castShadow = shadow; imX.receiveShadow = false; imX.frustumCulled = true;
  scene.add(im);
}
