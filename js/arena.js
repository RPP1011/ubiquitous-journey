// The open world: a large biome-painted ground (plains / forest / hills /
// wilds), scattered terrain props, lighting and sky. Exports a deterministic
// biomeAt(x,z) so the rest of the sim can place resources in the right terrain
// and (later) vary movement/encounters by biome.

import * as THREE from 'three';

export const ARENA_RADIUS = 72;            // playable world radius
const GROUND = ARENA_RADIUS + 16;          // ground half-extent (past the edge)

export const BIOME = { VILLAGE: 'village', PLAINS: 'plains', FOREST: 'forest', HILLS: 'hills', WILDS: 'wilds' };

const BIOME_COLOR = {
  village: 0x7c8a58,
  plains:  0x6f8050,
  forest:  0x445f39,
  hills:   0x847b69,
  wilds:   0x57523f,
};

// deterministic smooth pseudo-noise in roughly [-2, 2]
function noise(x, z) {
  return Math.sin(x * 0.055) * Math.cos(z * 0.061)
       + 0.6 * Math.sin((x + z) * 0.033)
       + 0.5 * Math.cos((x - z) * 0.047);
}

// What biome is at world (x,z)? Stable across rebuilds.
export function biomeAt(x, z) {
  const r = Math.hypot(x, z);
  if (r < 16) return BIOME.VILLAGE;                 // central clearing = the town
  if (r > ARENA_RADIUS * 0.74) return BIOME.WILDS;  // dangerous frontier
  const v = noise(x, z);
  if (v > 0.85) return BIOME.FOREST;
  if (v < -0.85) return BIOME.HILLS;
  return BIOME.PLAINS;
}

export function biomeColor(b) { return BIOME_COLOR[b] ?? 0x6f8050; }

// Find a random spot in a given biome within a radius band (or null if none).
export function findBiomeSpot(biome, minR, maxR, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = minR + Math.random() * (maxR - minR);
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

export function buildArena(scene) {
  scene.background = new THREE.Color(0x9ec4e0);
  scene.fog = new THREE.Fog(0x9ec4e0, 55, 150);

  // --- biome-painted ground (vertex colours over a subdivided plane) ---------
  const seg = 96;
  const geo = new THREE.PlaneGeometry(GROUND * 2, GROUND * 2, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    _c.setHex(biomeColor(biomeAt(x, z)));
    // subtle per-vertex value jitter so big patches aren't flat
    const j = 1 + (noise(x * 1.7, z * 1.7) * 0.04);
    colors[i * 3] = _c.r * j; colors[i * 3 + 1] = _c.g * j; colors[i * 3 + 2] = _c.b * j;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);

  // --- scattered terrain props (instanced for cheapness) ---------------------
  buildProps(scene);

  // faint boundary ring at the world edge
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(ARENA_RADIUS, ARENA_RADIUS + 0.6, 160),
    new THREE.MeshBasicMaterial({ color: 0x2c361f, side: THREE.DoubleSide, transparent: true, opacity: 0.5 }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
  scene.add(ring);

  // --- lighting --------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x46402f, 0.9));
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.55);
  sun.position.set(40, 70, 28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 48;                       // shadow covers the area around the town
  sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
  sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0004;
  scene.add(sun); scene.add(sun.target);
}

// place ambient trees (forest) + rocks (hills) + grass (plains) via InstancedMesh
function buildProps(scene) {
  const trunkM = [], crownM = [], rockM = [], grassM = [];
  const step = 3.2;
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

function spot(x, z, scale, rand = false) {
  return { x, z, scale, rot: rand ? Math.random() * Math.PI : 0 };
}

function addInstanced(scene, geo, mat, list, yBase, shadow) {
  if (!list.length) return;
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    _p.set(o.x, yBase * o.scale, o.z);
    _q.setFromEuler(new THREE.Euler(0, o.rot, 0));
    _s.set(o.scale, o.scale, o.scale);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
  }
  mesh.castShadow = shadow; mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  scene.add(mesh);
}
