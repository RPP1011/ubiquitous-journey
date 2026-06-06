// TOWN DEFENCES — the home-ground advantage the settlement was missing.
//
// The world had no reason to favour the defender: townsfolk just fled individually
// and were picked off, so the ONLY lever on the population was "how many raiders",
// a knife-edge between a town that plateaus at the cap and one that spirals to
// extinction. A settlement should be able to HOLD. So the town core is ringed with
// WATCHTOWERS: fixed emplacements that lay down ranged fire on any town-hostile body
// that comes within range.
//
// Why this fixes the dynamics structurally (not by tuning): a tower's killing power
// does NOT scale with the civilian population. A thriving town and a decimated one
// defend their core equally well, so even a gutted town can hold its centre and
// rebuild via births instead of being mopped up — the robust floor the artificial
// "minPop reprieve" was faking. Attacking the town is now genuinely costly; raids
// cost the town some who stray, but the core endures.
//
// Epistemic split honoured: a tower fires on PERCEIVED faction — a disguised spy
// (intrigue) reads as a townsperson and is NOT shot (the watch is fooled too), while
// combat elsewhere still resolves on true faction. Closed economy untouched (killing
// a purseless raider mints nothing). Guarded; never throws on the fixed tick.

import * as THREE from 'three';
import { DEFENSE, TOWNS, factionHostile } from './simconfig.js';
import { terrainHeight } from '../arena.js';

export class Defenses {
  constructor(sim) {
    this.sim = sim;
    this.towers = [];
    this._acc = 0;
    this.stats = { shots: 0, kills: 0 };
    // NB: towers are raised by build(), called from Simulation.spawn() — NOT here.
    // Controlled test sub-sims construct a Simulation but never spawn() a town, so
    // they get NO towers and a bare scene that won't snipe their hand-placed agents.
  }

  // ring EACH town core with watchtowers (open world: every town holds its own
  // ground). Towns come from the sim if spawned, else the TOWNS config, else origin.
  build() {
    const n = DEFENSE.towers ?? 5;
    const R = DEFENSE.ringR ?? 16;
    const centers = (this.sim.towns && this.sim.towns.length)
      ? this.sim.towns.map((t) => [t.center.x, t.center.z])
      : ((TOWNS && TOWNS.centers && TOWNS.centers.length) ? TOWNS.centers : [[0, 0]]);
    for (const [cx, cz] of centers) {
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        const x = cx + Math.cos(ang) * R, z = cz + Math.sin(ang) * R;
        const y = typeof document === 'undefined' ? 0 : safeHeight(x, z);
        const tower = { pos: new THREE.Vector3(x, y, z) };
        this.towers.push(tower);
        if (typeof document !== 'undefined') this._mesh(tower);
      }
    }
  }

  // simple browser-only marker so the watchtowers are visible on the map.
  _mesh(tower) {
    try {
      const grp = new THREE.Group();
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.6, 0.9, 6, 8),
        new THREE.MeshStandardMaterial({ color: 0x6b5a44 }));
      post.position.y = 3;
      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(1.3, 1.6, 8),
        new THREE.MeshStandardMaterial({ color: 0x8a3b2e }));
      cap.position.y = 6.6;
      grp.add(post); grp.add(cap);
      grp.position.copy(tower.pos);
      this.sim.scene.add(grp);
      tower.mesh = grp;
    } catch { /* visuals are best-effort */ }
  }

  // an agent's APPARENT faction — a disguised infiltrator fools the watch.
  _apparent(a) { return a.disguiseFaction || a.faction; }

  // fixed-tick: on a cooldown, every tower fires on the nearest town-hostile body
  // in range. Fully guarded — never throws/stalls the fixed loop.
  tick(ctx, dt) {
    try {
      this._acc += dt;
      const every = DEFENSE.fireEvery ?? 1.0;
      if (this._acc < every) return;
      this._acc = 0;
      const range2 = (DEFENSE.range ?? 26) ** 2;
      const dmg = DEFENSE.damage ?? 10;
      for (const t of this.towers) {
        let best = null, bd = range2;
        for (const a of this.sim.agents) {
          if (!a.alive || a.controlled || !a.fighter) continue;
          if (!factionHostile('townsfolk', this._apparent(a))) continue;   // friend/disguised -> spare
          const d = t.pos.distanceToSquared(a.pos);
          if (d < bd) { bd = d; best = a; }
        }
        if (!best) continue;
        // -1 is not a real block direction, so ranged fire is never "blocked".
        const res = best.fighter.takeHit(dmg, -1);
        this.stats.shots++;
        if (res === 'dead') this.stats.kills++;
      }
    } catch { /* never throw on the tick */ }
  }

  dispose() {
    if (typeof document === 'undefined') return;
    for (const t of this.towers) if (t.mesh) { try { this.sim.scene.remove(t.mesh); } catch { /* */ } }
    this.towers = [];
  }
}

// terrain height is a pure function but guard it anyway (never throw at construction).
function safeHeight(x, z) { try { return terrainHeight(x, z); } catch { return 0; } }
