// Resource sites scattered across the open world, each rooted in the biome that
// fits it: fields in plains, woods in forest, mines in hills, the market + forge
// in the central village. Locations are common knowledge (shared state); site
// kinds line up with PROFESSIONS[*].site so an agent finds "its" workplace.

import * as THREE from 'three';
import { ARENA_RADIUS, BIOME, findBiomeSpot } from '../arena.js';

export const POI_KIND = {
  FIELD: 'field', FOREST: 'forest', MINE: 'mine', FORGE: 'forge',
  MARKET: 'market', REST: 'rest',
};

export class World {
  constructor(scene) {
    this.scene = scene;
    this.pois = [];
    this._build();
  }

  _add(kind, pos, mesh) {
    const poi = { kind, pos: pos.clone(), mesh };
    this.pois.push(poi);
    if (mesh) { mesh.position.copy(pos); this.scene.add(mesh); }
    return poi;
  }

  _scatter(kind, biome, count, minR, maxR, make) {
    for (let i = 0; i < count; i++) {
      const p = findBiomeSpot(biome, minR, maxR) ||
        new THREE.Vector3(Math.cos(i) * (minR + maxR) / 2, 0, Math.sin(i) * (minR + maxR) / 2);
      this._add(kind, p, make());
    }
  }

  _build() {
    // central village: market + forge + a couple of campfires
    this.market = this._add(POI_KIND.MARKET, new THREE.Vector3(0, 0, 0), makeMarket());
    this._add(POI_KIND.FORGE, new THREE.Vector3(6, 0, -4), makeForge());
    this._add(POI_KIND.FORGE, new THREE.Vector3(-7, 0, 5), makeForge());
    for (const [x, z] of [[-4, 6], [5, 4], [0, -7], [9, 2]]) {
      this._add(POI_KIND.REST, new THREE.Vector3(x, 0, z), makeCampfire());
    }

    // resources out in their terrain
    this._scatter(POI_KIND.FIELD,  BIOME.PLAINS, 4, 20, 52, makeField);
    this._scatter(POI_KIND.FOREST, BIOME.FOREST, 4, 20, 55, makeWoods);
    this._scatter(POI_KIND.MINE,   BIOME.HILLS,  4, 24, 58, makeMine);
    // a few wilderness campfires for travellers
    this._scatter(POI_KIND.REST, BIOME.PLAINS, 3, 24, 50, makeCampfire);
  }

  nearest(kind, pos) {
    let best = null, bestD = Infinity;
    for (const p of this.pois) {
      if (p.kind !== kind) continue;
      const d = p.pos.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  dispose() {
    for (const p of this.pois) if (p.mesh) this.scene.remove(p.mesh);
    this.pois = [];
  }

  update(dt) { /* static for now */ }
}

// ---- site meshes -----------------------------------------------------------
function makeField() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xd8b24a, roughness: 1 });
  for (let i = 0; i < 20; i++) {
    const w = new THREE.Mesh(new THREE.ConeGeometry(0.12, 1.0, 5), mat);
    w.position.set((Math.random() - 0.5) * 5, 0.5, (Math.random() - 0.5) * 5);
    w.castShadow = true; g.add(w);
  }
  return g;
}

function makeWoods() {
  const g = new THREE.Group();
  const leaf = new THREE.MeshStandardMaterial({ color: 0x2f6d33, roughness: 1, flatShading: true });
  const bark = new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 1 });
  for (let i = 0; i < 7; i++) {
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1.0), bark);
    trunk.position.y = 0.5;
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.9, 7), leaf);
    crown.position.y = 1.6; crown.castShadow = true;
    t.add(trunk); t.add(crown);
    t.position.set((Math.random() - 0.5) * 5, 0, (Math.random() - 0.5) * 5);
    g.add(t);
  }
  return g;
}

function makeMine() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x6f7681, roughness: 1, flatShading: true });
  for (let i = 0; i < 9; i++) {
    const r = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45 + Math.random() * 0.6, 0), mat);
    r.position.set((Math.random() - 0.5) * 4.5, 0.3, (Math.random() - 0.5) * 4.5);
    r.rotation.set(Math.random(), Math.random(), Math.random());
    r.castShadow = true; g.add(r);
  }
  // a pit-entrance timber
  const beam = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x4a3526 }));
  beam.position.y = 1.1; g.add(beam);
  return g;
}

function makeForge() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.2),
    new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.8 }));
  base.position.y = 0.25; base.castShadow = true;
  const anvil = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x55585f }));
  anvil.position.set(0.9, 0.45, 0);
  const fire = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.6, 8),
    new THREE.MeshBasicMaterial({ color: 0xff7a1e }));
  fire.position.y = 0.6;
  const light = new THREE.PointLight(0xff8030, 6, 9, 2); light.position.y = 1;
  g.add(base, anvil, fire, light);
  return g;
}

function makeMarket() {
  const g = new THREE.Group();
  const well = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.7, 14),
    new THREE.MeshStandardMaterial({ color: 0x808890, roughness: 0.9 }));
  well.position.y = 0.35; well.castShadow = true; g.add(well);
  const cols = [0xc94f4f, 0x4f86d6, 0x5f9f4f, 0xd8b24a, 0xb060c0, 0xe0a040];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const stall = new THREE.Group();
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x6a4b2f }));
    post.position.y = 0.6;
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 1.0),
      new THREE.MeshStandardMaterial({ color: cols[i] }));
    top.position.y = 1.2;
    stall.add(post, top);
    stall.position.set(Math.cos(a) * 3.6, 0, Math.sin(a) * 3.6);
    g.add(stall);
  }
  return g;
}

function makeCampfire() {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.1, 6, 16),
    new THREE.MeshStandardMaterial({ color: 0x5a4632 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.1;
  const fire = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.6, 8),
    new THREE.MeshBasicMaterial({ color: 0xff8a2a }));
  fire.position.y = 0.45;
  g.add(ring, fire);
  return g;
}
