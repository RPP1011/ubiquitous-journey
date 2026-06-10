// A single Daggerfall-style dungeon level: a procedurally-carved tile maze with
// rooms, rendered as real 3D geometry (floor, wall pillars, ceiling, torches) in
// a THREE.Group. The whole thing is built at DUNGEON.y — far below the overworld
// — so the open-world sim and the dungeon never interact spatially.
//
// This module owns LAYOUT + GEOMETRY + COLLISION only. Spawning monsters, moving
// the player in/out, and swapping the fog/lighting are the DungeonManager's job;
// it reads the marker positions (entrance / stairs / treasure / monsterSpawns)
// this class exposes.

import * as THREE from 'three';
import { rng } from '../sim/rng.js';
import { DUNGEON } from '../sim/simconfig.js';

// ── THREE cast-view (vendored three's transform members are invisible to tsc;
// see js/sim/world.ts). A minimal local node view + a typed constructor map.
interface Vec3 {
  x: number; y: number; z: number;
  set(x: number, y: number, z: number): Vec3;
  copy(v: { x: number; y: number; z: number }): Vec3;
  clone(): Vec3;
  distanceToSquared(v: Vec3): number;
}
interface Obj3D {
  position: Vec3;
  rotation: { x: number; y: number; z: number };
  castShadow: boolean;
  receiveShadow: boolean;
  visible: boolean;
  name: string;
  intensity: number;
  geometry?: { dispose?: () => void; rotateX(a: number): void };
  add(...o: unknown[]): void;
  traverse(cb: (o: Obj3D) => void): void;
  removeFromParent(): void;
  setMatrixAt(i: number, m: unknown): void;
  instanceMatrix: { needsUpdate: boolean };
}
type Ctor0<T> = new () => T;
type Ctor1<T> = new (...args: unknown[]) => T;
interface T3Shape {
  Group: Ctor0<Obj3D>;
  Vector3: new (x?: number, y?: number, z?: number) => Vec3;
  Matrix4: new () => { makeTranslation(x: number, y: number, z: number): unknown };
  Mesh: Ctor1<Obj3D>;
  InstancedMesh: Ctor1<Obj3D>;
  PointLight: Ctor1<Obj3D>;
  HemisphereLight: Ctor1<Obj3D>;
  BoxGeometry: Ctor1<unknown>;
  PlaneGeometry: Ctor1<unknown>;
  RingGeometry: Ctor1<unknown>;
  SphereGeometry: Ctor1<unknown>;
  MeshStandardMaterial: Ctor1<{ dispose?: () => void }>;
  MeshBasicMaterial: Ctor1<{ dispose?: () => void }>;
  DoubleSide: number;
}
const T3 = THREE as unknown as T3Shape;

// loot dropped from a treasure chest (consumed by DungeonManager._loot).
interface Haul { gold: number; relic: boolean; potion: boolean; }
// one budgeted torch light (a flickering point light + its base/phase).
interface TorchLight { light: Obj3D; base: number; phase: number; }

const TAU = Math.PI * 2;

type Grid = number[][];
type Cell = [number, number];

// --- maze carving (recursive backtracker over odd cells) --------------------
function carveMaze(S: number): Grid {
  const g: Grid = Array.from({ length: S }, () => new Array(S).fill(1)); // 1=wall 0=floor
  const inb = (x: number, y: number): boolean => x > 0 && y > 0 && x < S - 1 && y < S - 1;
  const stack: Cell[] = [[1, 1]];
  g[1][1] = 0;
  const dirs = [[2, 0], [-2, 0], [0, 2], [0, -2]];
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const opts: [number, number, number, number][] = [];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (inb(nx, ny) && g[ny][nx] === 1) opts.push([nx, ny, dx, dy]);
    }
    if (!opts.length) { stack.pop(); continue; }
    const [nx, ny, dx, dy] = opts[(rng() * opts.length) | 0];
    g[y + dy / 2][x + dx / 2] = 0;
    g[ny][nx] = 0;
    stack.push([nx, ny]);
  }
  return g;
}

// punch a few extra openings (braid the maze) and clear some 3x3 rooms so it
// reads as a Daggerfall labyrinth of chambers rather than a perfect maze.
function openRoomsAndLoops(g: Grid, S: number): void {
  const rooms = 2 + ((rng() * 3) | 0);
  for (let r = 0; r < rooms; r++) {
    const cx = 2 + ((rng() * (S - 4)) | 0);
    const cy = 2 + ((rng() * (S - 4)) | 0);
    for (let j = cy - 1; j <= cy + 1; j++)
      for (let i = cx - 1; i <= cx + 1; i++)
        if (i > 0 && j > 0 && i < S - 1 && j < S - 1) g[j][i] = 0;
  }
  const loops = (S * S * 0.04) | 0;
  for (let k = 0; k < loops; k++) {
    const i = 1 + ((rng() * (S - 2)) | 0);
    const j = 1 + ((rng() * (S - 2)) | 0);
    g[j][i] = 0;
  }
}

// BFS distances from (sx,sy) over floor cells; returns the farthest floor cell.
function farthestFloor(g: Grid, S: number, sx: number, sy: number): { far: Cell; dist: Grid } {
  const dist: Grid = Array.from({ length: S }, () => new Array(S).fill(-1));
  const q: Cell[] = [[sx, sy]];
  dist[sy][sx] = 0;
  let far: Cell = [sx, sy], fd = 0;
  while (q.length) {
    const [x, y] = q.shift() as Cell;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
      if (g[ny][nx] !== 0 || dist[ny][nx] !== -1) continue;
      dist[ny][nx] = dist[y][x] + 1;
      if (dist[ny][nx] > fd) { fd = dist[ny][nx]; far = [nx, ny]; }
      q.push([nx, ny]);
    }
  }
  return { far, dist };
}

export class Dungeon {
  level: number;
  tile: number;
  y: number;
  hasRelic: boolean;
  treasureTaken: boolean;
  S: number;
  half: number;
  grid: Grid;
  entranceCell: Cell;
  stairsCell: Cell;
  treasureCell: Cell;
  entrancePos: Vec3;
  stairsPos: Vec3;
  treasurePos: Vec3;
  monsterSpawns: { pos: Vec3; roomR: number }[];
  _materials: { dispose?: () => void }[];
  _torchLights: TorchLight[];
  group: Obj3D;
  _wallGeo?: { dispose?: () => void };
  chestMesh?: Obj3D;
  chestGlow?: Obj3D;

  constructor(level = 1) {
    this.level = level;
    this.tile = DUNGEON.tile;
    this.y = DUNGEON.y;
    this.hasRelic = level >= DUNGEON.relicDepth;
    this.treasureTaken = false;

    const S = 2 * DUNGEON.radius + 1;
    this.S = S;
    this.half = (S - 1) / 2;
    const g = carveMaze(S);
    openRoomsAndLoops(g, S);
    this.grid = g;

    // entrance fixed near a corner; stairs + treasure at the maze's far end.
    this.entranceCell = [1, 1] as Cell;
    const { far } = farthestFloor(g, S, 1, 1);
    this.stairsCell = far;
    // treasure a step off the stairs (or the stairs cell itself if cramped)
    this.treasureCell = this._floorNeighbor(far) || far;

    this.entrancePos = this.cellToWorld(...this.entranceCell);
    this.stairsPos = this.cellToWorld(...this.stairsCell);
    this.treasurePos = this.cellToWorld(...this.treasureCell);

    this.monsterSpawns = this._pickMonsterSpawns();
    this._materials = [];
    this._torchLights = [];
    this.group = new T3.Group();
    this.group.name = `dungeon-L${level}`;
    this._build();
  }

  // --- coordinate helpers ---------------------------------------------------
  cellToWorld(i: number, j: number): Vec3 {
    return new T3.Vector3((i - this.half) * this.tile, this.y, (j - this.half) * this.tile);
  }
  _cellIndex(x: number, z: number): Cell {
    return [Math.round(x / this.tile + this.half), Math.round(z / this.tile + this.half)];
  }
  isFloor(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.S && j < this.S && this.grid[j][i] === 0;
  }
  walkableAt(x: number, z: number): boolean { const [i, j] = this._cellIndex(x, z); return this.isFloor(i, j); }

  // axis-separated collision so the player slides along walls instead of sticking.
  // mutates `pos`; `prev` is last frame's position (assumed valid/floor).
  collide(pos: Vec3, prev: Vec3): void {
    if (this._blocked(pos.x, prev.z)) pos.x = prev.x;
    if (this._blocked(pos.x, pos.z)) pos.z = prev.z;
    pos.y = this.y;
  }
  _blocked(x: number, z: number): boolean {
    const r = 0.55;   // player footprint half-width
    return !(this.walkableAt(x + r, z + r) && this.walkableAt(x - r, z + r) &&
             this.walkableAt(x + r, z - r) && this.walkableAt(x - r, z - r));
  }

  _floorNeighbor([i, j]: Cell): Cell | null {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
      if (this.isFloor(i + dx, j + dy)) return [i + dx, j + dy];
    return null;
  }

  _allFloorCells(): Cell[] {
    const out: Cell[] = [];
    for (let j = 0; j < this.S; j++) for (let i = 0; i < this.S; i++) if (this.grid[j][i] === 0) out.push([i, j]);
    return out;
  }

  _pickMonsterSpawns(): { pos: Vec3; roomR: number }[] {
    const count = DUNGEON.baseMonsters + DUNGEON.monstersPerLevel * (this.level - 1);
    const cells = this._allFloorCells().filter(([i, j]) => Math.abs(i - 1) + Math.abs(j - 1) > 3);
    const spots: { pos: Vec3; roomR: number }[] = [];
    for (let n = 0; n < count && cells.length; n++) {
      const idx = (rng() * cells.length) | 0;
      const [i, j] = cells.splice(idx, 1)[0];
      spots.push({ pos: this.cellToWorld(i, j), roomR: this.tile * 1.3 });
    }
    return spots;
  }

  // --- geometry -------------------------------------------------------------
  _mat(opts: Record<string, unknown>): { dispose?: () => void } { const m = new T3.MeshStandardMaterial(opts); this._materials.push(m); return m; }

  _build(): void {
    const S = this.S, T = this.tile, H = DUNGEON.wallH;
    const span = S * T;

    // floor + ceiling slabs
    const floorMat = this._mat({ color: 0x2b2722, roughness: 1 });
    const floor = new T3.Mesh(new T3.PlaneGeometry(span, span), floorMat);
    floor.geometry!.rotateX(-Math.PI / 2);
    floor.position.set(0, this.y, 0);
    floor.receiveShadow = true;
    this.group.add(floor);

    const ceilMat = this._mat({ color: 0x14110e, roughness: 1 });
    const ceil = new T3.Mesh(new T3.PlaneGeometry(span, span), ceilMat);
    ceil.geometry!.rotateX(Math.PI / 2);
    ceil.position.set(0, this.y + H, 0);
    this.group.add(ceil);

    // wall pillars: one box per wall tile that borders a floor tile (skip the
    // solid interior — only the visible faces of the labyrinth get geometry).
    const wallCells: Cell[] = [];
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        if (this.grid[j][i] !== 1) continue;
        let borders = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (this.isFloor(i + dx, j + dy)) { borders = true; break; }
        }
        if (borders) wallCells.push([i, j]);
      }
    }
    const wallMat = this._mat({ color: 0x3a342c, roughness: 0.95 });
    const wallGeo = new T3.BoxGeometry(T, H, T) as { dispose?: () => void };
    const walls = new T3.InstancedMesh(wallGeo, wallMat, wallCells.length);
    walls.castShadow = true; walls.receiveShadow = true;
    const m = new T3.Matrix4();
    wallCells.forEach(([i, j], k) => {
      const p = this.cellToWorld(i, j);
      m.makeTranslation(p.x, this.y + H / 2, p.z);
      walls.setMatrixAt(k, m);
    });
    walls.instanceMatrix.needsUpdate = true;
    this.group.add(walls);
    this._wallGeo = wallGeo;

    // dim fill light so the dungeon isn't pitch black between torches
    const amb = new T3.HemisphereLight(0x3a4055, 0x100c08, 0.35);
    amb.position.set(0, this.y + H, 0);
    this.group.add(amb);

    this._buildMarkers();
    this._buildTorches(wallCells);
  }

  _buildMarkers(): void {
    // entrance: blue ring you step on to leave (level 1) — always a way out.
    const up = this._padMesh(0x4f9dff);
    up.position.copy(this.entrancePos); up.position.y = this.y + 0.06;
    this.group.add(up);

    // stairs down: orange pad to descend deeper.
    const down = this._padMesh(0xe0894e);
    down.position.copy(this.stairsPos); down.position.y = this.y + 0.06;
    this.group.add(down);
    // a little stepped block so "stairs" read visually
    const stepMat = this._mat({ color: 0x4a4036, roughness: 1, emissive: 0x140a04, emissiveIntensity: 0.4 });
    const steps = new T3.Mesh(new T3.BoxGeometry(this.tile * 0.7, 0.5, this.tile * 0.7), stepMat);
    steps.position.copy(this.stairsPos); steps.position.y = this.y + 0.25;
    this.group.add(steps);

    // treasure: a glowing chest. Removed when looted.
    const chestMat = this._mat({ color: 0x8a6a2c, roughness: 0.6, emissive: 0xffcc44, emissiveIntensity: 0.5 });
    const chest = new T3.Mesh(new T3.BoxGeometry(0.9, 0.7, 0.6), chestMat);
    chest.position.copy(this.treasurePos); chest.position.y = this.y + 0.35;
    chest.castShadow = true;
    this.group.add(chest);
    this.chestMesh = chest;
    const glow = new T3.PointLight(0xffcc55, this.hasRelic ? 1.4 : 0.7, 6);
    glow.position.copy(this.treasurePos); glow.position.y = this.y + 0.9;
    this.group.add(glow);
    this.chestGlow = glow;
  }

  _padMesh(color: number): Obj3D {
    const mat = new T3.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: T3.DoubleSide });
    this._materials.push(mat);
    const ring = new T3.Mesh(new T3.RingGeometry(this.tile * 0.28, this.tile * 0.42, 28), mat);
    ring.rotation.x = -Math.PI / 2;
    return ring;
  }

  _buildTorches(wallCells: Cell[]): void {
    // place a handful of torches at floor tiles next to walls, lit by point
    // lights (budgeted). A small emissive sconce marks each.
    const floors = this._allFloorCells().filter(([i, j]) => {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
        if (i + dx >= 0 && j + dy >= 0 && i + dx < this.S && j + dy < this.S && this.grid[j + dy][i + dx] === 1) return true;
      return false;
    });
    // even-ish spread: shuffle then take up to the budget
    for (let n = floors.length - 1; n > 0; n--) { const k = (rng() * (n + 1)) | 0; [floors[n], floors[k]] = [floors[k], floors[n]]; }
    const take = Math.min(DUNGEON.maxTorches, floors.length);
    const sconceMat = this._mat({ color: 0x000000, emissive: 0xff7a1e, emissiveIntensity: 1.4, roughness: 1 });
    for (let n = 0; n < take; n++) {
      const p = this.cellToWorld(...floors[n]);
      const light = new T3.PointLight(0xff8a32, 1.6, this.tile * 4.5, 1.6);
      light.position.set(p.x, this.y + DUNGEON.wallH * 0.62, p.z);
      this.group.add(light);
      this._torchLights.push({ light, base: 1.6, phase: rng() * TAU });
      const sconce = new T3.Mesh(new T3.SphereGeometry(0.12, 6, 5), sconceMat);
      sconce.position.copy(light.position);
      this.group.add(sconce);
    }
  }

  // gentle per-frame torch flicker (driven by the manager with a running clock).
  flicker(t: number): void {
    for (const tl of this._torchLights) {
      tl.light.intensity = tl.base * (0.8 + 0.2 * Math.sin(t * 9 + tl.phase) * Math.cos(t * 3.3 + tl.phase));
    }
  }

  // hide the chest once its loot has been taken.
  takeTreasure(): Haul | null {
    if (this.treasureTaken) return null;
    this.treasureTaken = true;
    if (this.chestMesh) this.chestMesh.visible = false;
    if (this.chestGlow) this.chestGlow.visible = false;
    return { gold: 20 + this.level * 12, relic: this.hasRelic, potion: rng() < 0.6 };
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
    });
    if (this._wallGeo) this._wallGeo.dispose?.();
    for (const mat of this._materials) mat.dispose?.();
    this.group.removeFromParent();
    this._torchLights.length = 0;
  }
}
