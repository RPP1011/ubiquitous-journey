// Job sites + market. Locations are common knowledge (plain shared state). Site
// kinds line up with PROFESSIONS[*].site so an agent can find "its" workplace.

import * as THREE from 'three';
import { ARENA_RADIUS } from '../arena.js';

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

  _add(kind, x, z, mesh) {
    const poi = { kind, pos: new THREE.Vector3(x, 0, z), mesh };
    this.pois.push(poi);
    if (mesh) { mesh.position.set(x, 0, z); this.scene.add(mesh); }
    return poi;
  }

  _build() {
    const R = ARENA_RADIUS;

    // --- field (food): golden wheat tufts ---
    {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0xd8b24a, roughness: 1 });
      for (let i = 0; i < 16; i++) {
        const w = new THREE.Mesh(new THREE.ConeGeometry(0.12, 1.0, 5), mat);
        w.position.set((Math.random() - 0.5) * 4, 0.5, (Math.random() - 0.5) * 4);
        w.castShadow = true; g.add(w);
      }
      this._add(POI_KIND.FIELD, -R * 0.62, R * 0.5, g);
    }

    // --- forest (wood): conifer trees ---
    {
      const g = new THREE.Group();
      const leaf = new THREE.MeshStandardMaterial({ color: 0x2f6d33, roughness: 1 });
      const bark = new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 1 });
      for (let i = 0; i < 6; i++) {
        const t = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.8), bark);
        trunk.position.y = 0.4;
        const crown = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.6, 7), leaf);
        crown.position.y = 1.4; crown.castShadow = true;
        t.add(trunk); t.add(crown);
        t.position.set((Math.random() - 0.5) * 4.5, 0, (Math.random() - 0.5) * 4.5);
        g.add(t);
      }
      this._add(POI_KIND.FOREST, R * 0.6, R * 0.5, g);
    }

    // --- mine (ore): grey rocks ---
    {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x7c828b, roughness: 1, flatShading: true });
      for (let i = 0; i < 7; i++) {
        const r = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4 + Math.random() * 0.5, 0), mat);
        r.position.set((Math.random() - 0.5) * 4, 0.3, (Math.random() - 0.5) * 4);
        r.rotation.set(Math.random(), Math.random(), Math.random());
        r.castShadow = true; g.add(r);
      }
      this._add(POI_KIND.MINE, -R * 0.62, -R * 0.55, g);
    }

    // --- forge (tools): anvil + fire ---
    {
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
      const light = new THREE.PointLight(0xff8030, 7, 9, 2); light.position.y = 1;
      g.add(base); g.add(anvil); g.add(fire); g.add(light);
      this._add(POI_KIND.FORGE, R * 0.6, -R * 0.55, g);
    }

    // --- market (centre): well + colourful stalls ---
    {
      const g = new THREE.Group();
      const well = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.7, 14),
        new THREE.MeshStandardMaterial({ color: 0x808890, roughness: 0.9 }));
      well.position.y = 0.35; well.castShadow = true; g.add(well);
      const canopyCols = [0xc94f4f, 0x4f86d6, 0x5f9f4f, 0xd8b24a];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const stall = new THREE.Group();
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.1),
          new THREE.MeshStandardMaterial({ color: 0x6a4b2f }));
        post.position.y = 0.6;
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 1.0),
          new THREE.MeshStandardMaterial({ color: canopyCols[i] }));
        top.position.y = 1.2;
        stall.add(post); stall.add(top);
        stall.position.set(Math.cos(a) * 3.2, 0, Math.sin(a) * 3.2);
        g.add(stall);
      }
      this.market = this._add(POI_KIND.MARKET, 0, 0, g);
    }

    // --- a couple of campfires (rest) ---
    for (const [x, z] of [[-R * 0.2, R * 0.05], [R * 0.18, -R * 0.05]]) {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.1, 6, 16),
        new THREE.MeshStandardMaterial({ color: 0x5a4632 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.1;
      const fire = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.6, 8),
        new THREE.MeshBasicMaterial({ color: 0xff8a2a }));
      fire.position.y = 0.45;
      g.add(ring); g.add(fire);
      this._add(POI_KIND.REST, x, z, g);
    }
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

  update(dt) { /* job sites are static; nothing to tick for now */ }
}
