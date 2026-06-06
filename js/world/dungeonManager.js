// DungeonManager: the bridge between the open world and the dungeon sublevels.
// It scatters cave-mouth portals across the wilds, and on entry it (1) builds a
// Dungeon level deep below the map, (2) swaps the scene fog/lighting for gloom,
// (3) spawns monster Agents into the SAME sim roster the overworld uses (so
// combat, the inspector, and the party all "just work"), and (4) teleports the
// player + companions down. Exit / descend reverse or re-run those steps.
//
// Spatial isolation is purely the deep Y offset: overworld agents stay at y≈0,
// dungeon agents at DUNGEON.y, ~400m apart — past every vision/combat radius.

import * as THREE from 'three';
import { Fighter } from '../fighter.js';
import { Agent } from '../sim/agent.js';
import { MONSTER, DUNGEON } from '../sim/simconfig.js';
import { ARENA_RADIUS, BIOME, findBiomeSpot } from '../arena.js';
import { Dungeon } from './dungeon.js';

const DUNGEON_NAMES = [
  'the Sunken Warren', 'Barrow Deep', 'the Gloamcaves', 'Mournhollow',
  'the Rotfen Crypt', 'Direpit', 'the Hollow Steps', 'Ashen Delve',
];
const rand = (a, b) => a + Math.random() * (b - a);

function makePersonality() {
  return {
    risk_tolerance: rand(0.5, 0.95), social_drive: rand(0.1, 0.4),
    ambition: rand(0.3, 0.7), altruism: rand(0.05, 0.3), curiosity: rand(0.2, 0.6),
  };
}

export class DungeonManager {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim = sim;
    this.entrances = [];     // [{ pos, name, mesh }] overworld portals
    this.active = false;
    this.dungeon = null;
    this.depth = 0;
    this._mobIds = [];       // ids of monster agents we spawned for this level
    this._saved = null;      // overworld state to restore on exit
    this._clock = 0;
    this._prevPos = new THREE.Vector3();
    this.lastEvent = '';     // short HUD note ("Entered Barrow Deep", "Looted…")
  }

  // --- overworld portals ----------------------------------------------------
  placeEntrances() {
    const used = DUNGEON_NAMES.slice();
    for (let i = 0; i < DUNGEON.entranceCount; i++) {
      const spot = findBiomeSpot(BIOME.WILDS, ARENA_RADIUS * 0.5, ARENA_RADIUS * 0.95)
        || new THREE.Vector3(rand(-1, 1) * ARENA_RADIUS * 0.7, 0, rand(-1, 1) * ARENA_RADIUS * 0.7);
      const name = used.splice((Math.random() * used.length) | 0, 1)[0] || `Dungeon ${i + 1}`;
      const mesh = this._mouthMesh();
      mesh.position.copy(spot);
      this.scene.add(mesh);
      this.entrances.push({ pos: spot.clone(), name, mesh });
    }
  }

  _mouthMesh() {
    const g = new THREE.Group();
    // a dark stone arch over a black hole — reads as a cave entrance
    const archMat = new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 1 });
    const arch = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.45, 8, 16, Math.PI), archMat);
    arch.position.y = 0.1; arch.rotation.x = Math.PI / 2; arch.rotation.z = Math.PI;
    g.add(arch);
    const holeMat = new THREE.MeshBasicMaterial({ color: 0x05060a });
    const hole = new THREE.Mesh(new THREE.CircleGeometry(1.35, 20), holeMat);
    hole.position.set(0, 1.0, 0.0); hole.rotation.x = 0;
    g.add(hole);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x6a4bff, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 1.7, 24), ringMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
    g.add(ring);
    g.userData.isPortal = true;
    return g;
  }

  // nearest overworld portal within range of pos, or null.
  nearEntrance(pos) {
    let best = null, bd = DUNGEON.entranceRange * DUNGEON.entranceRange;
    for (const e of this.entrances) {
      const d = e.pos.distanceToSquared(pos);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // --- transitions ----------------------------------------------------------
  // The single context action (bound to E): enter / descend / exit as fits.
  // Returns true if it consumed the keypress.
  tryPortal(player) {
    if (!player) return false;
    if (!this.active) {
      const e = this.nearEntrance(player.pos);
      if (e) { this.enter(e); return true; }
      return false;
    }
    if (this._near(player.pos, this.dungeon.stairsPos)) { this.descend(); return true; }
    if (this._near(player.pos, this.dungeon.entrancePos)) { this.exit(); return true; }
    return false;
  }

  _near(a, b) { return a.distanceToSquared(b) <= (this.dungeon.tile * 0.55) ** 2; }

  enter(entrance) {
    if (this.active) return;
    const player = this.sim.player;
    if (!player) return;

    // snapshot the overworld so exit() can restore it exactly
    this._saved = {
      returnPos: entrance.pos.clone(),
      fog: this.scene.fog,
      background: this.scene.background,
      lights: this._overworldLights().map((l) => ({ light: l, intensity: l.intensity })),
    };
    for (const l of this._saved.lights) l.light.intensity *= 0.05;   // sun goes dark
    this.scene.fog = new THREE.Fog(DUNGEON.fog.color, DUNGEON.fog.near, DUNGEON.fog.far);
    this.scene.background = new THREE.Color(DUNGEON.fog.color);

    this.depth = 1;
    this._buildLevel(this.depth);
    this.active = true;
    this.lastEvent = `Entered ${entrance.name} — depth ${this.depth}`;
  }

  descend() {
    if (!this.active) return;
    this._teardownLevel();
    this.depth += 1;
    this._buildLevel(this.depth);
    this.lastEvent = `Descended to depth ${this.depth}`;
  }

  exit() {
    if (!this.active) return;
    this._teardownLevel();
    // restore overworld fog/lights
    if (this._saved) {
      this.scene.fog = this._saved.fog;
      this.scene.background = this._saved.background;
      for (const s of this._saved.lights) s.light.intensity = s.intensity;
      // surface the player + party at the cave mouth
      const player = this.sim.player;
      if (player) player.fighter.root.position.copy(this._saved.returnPos);
      this._gatherParty(this._saved.returnPos, 0);
    }
    this._saved = null;
    this.active = false;
    this.depth = 0;
    this.dungeon = null;
    this.lastEvent = 'Returned to the surface';
  }

  // build a level's geometry + monsters and drop the party at its entrance.
  _buildLevel(level) {
    this.dungeon = new Dungeon(level);
    this.scene.add(this.dungeon.group);
    this._spawnMonsters(this.dungeon);
    const e = this.dungeon.entrancePos;
    const player = this.sim.player;
    if (player) player.fighter.root.position.set(e.x, this.dungeon.y, e.z);
    this._gatherParty(e, this.dungeon.y);
    this._prevPos.copy(player ? player.fighter.root.position : e);
  }

  _teardownLevel() {
    this._despawnMonsters();
    if (this.dungeon) this.dungeon.dispose();
    this.dungeon = null;
  }

  // place party members in a small ring around a point at world-height `y`.
  _gatherParty(center, y) {
    const members = this.sim.party ? this.sim.party.members : [];
    members.forEach((mem, k) => {
      const a = (k / Math.max(1, members.length)) * Math.PI * 2;
      mem.fighter.root.position.set(center.x + Math.cos(a) * 1.6, y, center.z + Math.sin(a) * 1.6);
      mem.wanderTarget = null;
    });
  }

  _spawnMonsters(dungeon) {
    this._mobIds = [];
    for (let k = 0; k < dungeon.monsterSpawns.length; k++) {
      const s = dungeon.monsterSpawns[k];
      const fighter = new Fighter(MONSTER.model, {});
      fighter.root.position.copy(s.pos);
      this.scene.add(fighter.root);
      const m = new Agent(fighter, {
        id: this.sim._nextId++, name: `${MONSTER.name} ${k + 1}`, profession: null,
        personality: makePersonality(), faction: MONSTER.faction,
        combatant: true, threat: MONSTER.threat + dungeon.level * 0.05,
      });
      m.roam = { x: s.pos.x, z: s.pos.z, r: s.roomR };   // pace within its room
      m.gold = 6 + ((Math.random() * 10) | 0) + dungeon.level * 2;   // loot purse
      this.sim.agents.push(m);
      this.sim.agentsById.set(m.id, m);
      this._mobIds.push(m.id);
    }
  }

  _despawnMonsters() {
    for (const id of this._mobIds) {
      const a = this.sim.agentsById.get(id);
      if (!a) continue;
      a.fighter.dispose();
      this.sim.agentsById.delete(id);
      const i = this.sim.agents.indexOf(a);
      if (i >= 0) this.sim.agents.splice(i, 1);
    }
    this._mobIds = [];
  }

  // live monsters still down here (for the "cleared" HUD note + quest hooks).
  remainingMonsters() {
    let n = 0;
    for (const id of this._mobIds) { const a = this.sim.agentsById.get(id); if (a && a.alive) n++; }
    return n;
  }

  _overworldLights() {
    const out = [];
    this.scene.traverse((o) => {
      if (o.isDirectionalLight || o.isHemisphereLight) {
        // skip lights that belong to the (current) dungeon group
        if (this.dungeon && this._inDungeon(o)) return;
        out.push(o);
      }
    });
    return out;
  }
  _inDungeon(o) { let p = o; while (p) { if (p === this.dungeon.group) return true; p = p.parent; } return false; }

  // collide the player against dungeon walls; call only while active.
  collidePlayer(pos) {
    if (!this.active || !this.dungeon) return;
    this.dungeon.collide(pos, this._prevPos);
    this._prevPos.copy(pos);
  }

  // per-frame: torch flicker, wall-collision for the monsters (so they can't
  // chase the player straight through walls), and auto-loot on contact.
  update(dt) {
    if (!this.active || !this.dungeon) return;
    this._clock += dt;
    this.dungeon.flicker(this._clock);
    this._collideMobs();
    const player = this.sim.player;
    if (player && !this.dungeon.treasureTaken) {
      if (player.pos.distanceToSquared(this.dungeon.treasurePos) < 1.6) this._loot(player);
    }
  }

  // keep monsters inside the labyrinth: run the same axis-separated collision the
  // player gets, using a per-agent "last valid position" stashed on the agent.
  _collideMobs() {
    for (const id of this._mobIds) {
      const a = this.sim.agentsById.get(id);
      if (!a || !a.alive) continue;
      const pos = a.fighter.root.position;
      if (!a._dprev) { a._dprev = pos.clone(); pos.y = this.dungeon.y; continue; }
      this.dungeon.collide(pos, a._dprev);
      a._dprev.copy(pos);
    }
  }

  _loot(player) {
    const haul = this.dungeon.takeTreasure();
    if (!haul) return;
    player.gold += haul.gold;
    if (haul.potion) player.inventory.potion = (player.inventory.potion || 0) + 1;
    if (haul.relic) player.relics = (player.relics || 0) + 1;
    player._tradeFlash = 0.8;
    this.lastEvent = haul.relic
      ? `Looted a relic + ${haul.gold}g from the depths!`
      : `Looted ${haul.gold}g from a chest`;
  }

  // a one-line context prompt for the HUD (or '' when nothing is actionable).
  prompt(player) {
    if (!player) return '';
    if (!this.active) {
      const e = this.nearEntrance(player.pos);
      return e ? `Press E to enter ${e.name}` : '';
    }
    if (this._near(player.pos, this.dungeon.stairsPos)) return 'Press E to descend deeper';
    if (this._near(player.pos, this.dungeon.entrancePos)) return 'Press E to leave the dungeon';
    return '';
  }

  // full teardown for a world rebuild.
  dispose() {
    if (this.active) this.exit();
    for (const e of this.entrances) e.mesh.removeFromParent();
    this.entrances = [];
  }
}
