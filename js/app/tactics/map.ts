// The tactical BATTLE MAP: a square grid cut out of the real world around a fight.
//
//   heights    terrainHeight sampled per tile, quantised to half-metre LEVELS (FFT-style). A unit
//              climbs at most JUMP levels per step; a drop of FALL_SAFE+ levels hurts.
//   ground     grass / dirt / stone / water / mud, from the world's biome + river/ravine fields.
//              Grass and hay burn; water douses and slows.
//   props      things that are really there — the market's crates and barrels, a rest site's
//              campfire, the forge's brazier, a well, trees at a treeline, buildings — each with a
//              material, weight, cover value, and the verbs it affords (push, throw, tip, climb,
//              ignite, douse). A scene can also place its own.
//
// Everything here is plain data + pure queries (headless, deterministic via rng()).

import { terrainHeight, biomeAt, barrierAt, BIOME } from '../../arena.js';
import { rng } from '../../sim/rng.js';

export const TILE = 2;            // metres per tile
export const LEVEL = 0.5;         // metres per height level
export const JUMP = 2;            // levels a unit may climb in one step
export const FALL_SAFE = 3;       // a drop of more than this many levels hurts

export type Ground = 'grass' | 'dirt' | 'stone' | 'water' | 'mud' | 'ash';
export type Cover = 0 | 1 | 2;    // none / half / full

export interface Tile {
  x: number; z: number;           // grid coords
  wx: number; wz: number;         // world centre
  h: number;                      // height in LEVELS
  ground: Ground;
  burning: number;                // rounds of fire left on this tile
  wet: number;                    // rounds it stays doused (cannot burn)
  smoke: number;                  // rounds of a blinding cloud (flour, thick smoke)
  wall: boolean;                  // impassable, full cover (a building)
}

export type PropKind =
  | 'crate' | 'barrel' | 'oil' | 'hay' | 'campfire' | 'brazier' | 'bucket' | 'flour' | 'rocks'
  | 'table' | 'cart' | 'tree' | 'well' | 'log' | 'torch' | 'relic' | 'tent';

export interface Prop {
  id: string;
  kind: PropKind;
  name: string;
  nouns: readonly string[];
  x: number; z: number;
  hp: number;
  weight: 0 | 1 | 2;              // 0 light (throwable), 1 heavy (pushable/kickable), 2 fixed
  cover: Cover;
  blocks: boolean;                // units cannot stand here (unless climbable)
  climbable: boolean;             // units may stand ON it (+height)
  flammable: boolean;
  burning: number;
  fireSource: boolean;            // lights things adjacent (campfire, brazier, torch)
  liquid: boolean;                // douses (bucket, well)
  blinding: boolean;              // bursts into a cloud when thrown (flour)
  tipped: boolean;                // a kicked-over table/cart/brazier
}

const PROP_DEFS: Record<PropKind, Omit<Prop, 'id' | 'x' | 'z' | 'burning' | 'tipped'>> = {
  crate:    { kind: 'crate', name: 'a crate', nouns: ['crate', 'crates', 'box'], hp: 20, weight: 1, cover: 1, blocks: true, climbable: true, flammable: true, fireSource: false, liquid: false, blinding: false },
  barrel:   { kind: 'barrel', name: 'a barrel', nouns: ['barrel', 'keg', 'cask'], hp: 20, weight: 1, cover: 1, blocks: true, climbable: false, flammable: true, fireSource: false, liquid: false, blinding: false },
  oil:      { kind: 'oil', name: 'a lamp-oil barrel', nouns: ['oil', 'oil barrel', 'lamp oil'], hp: 12, weight: 1, cover: 1, blocks: true, climbable: false, flammable: true, fireSource: false, liquid: false, blinding: false },
  hay:      { kind: 'hay', name: 'a hay bale', nouns: ['hay', 'bale', 'straw', 'haystack'], hp: 15, weight: 1, cover: 1, blocks: true, climbable: true, flammable: true, fireSource: false, liquid: false, blinding: false },
  campfire: { kind: 'campfire', name: 'the campfire', nouns: ['campfire', 'fire', 'embers', 'coals', 'flames'], hp: 99, weight: 2, cover: 0, blocks: false, climbable: false, flammable: false, fireSource: true, liquid: false, blinding: false },
  brazier:  { kind: 'brazier', name: 'a brazier', nouns: ['brazier', 'coals', 'forge', 'embers'], hp: 30, weight: 1, cover: 0, blocks: true, climbable: false, flammable: false, fireSource: true, liquid: false, blinding: false },
  bucket:   { kind: 'bucket', name: 'a bucket of water', nouns: ['bucket', 'water', 'pail'], hp: 5, weight: 0, cover: 0, blocks: false, climbable: false, flammable: false, fireSource: false, liquid: true, blinding: false },
  flour:    { kind: 'flour', name: 'a sack of flour', nouns: ['flour', 'sack'], hp: 5, weight: 0, cover: 0, blocks: false, climbable: false, flammable: false, fireSource: false, liquid: false, blinding: true },
  rocks:    { kind: 'rocks', name: 'loose rocks', nouns: ['rock', 'rocks', 'stone', 'stones'], hp: 99, weight: 0, cover: 0, blocks: false, climbable: false, flammable: false, fireSource: false, liquid: false, blinding: false },
  table:    { kind: 'table', name: 'a trestle table', nouns: ['table', 'trestle', 'stall'], hp: 20, weight: 1, cover: 1, blocks: true, climbable: true, flammable: true, fireSource: false, liquid: false, blinding: false },
  cart:     { kind: 'cart', name: 'a handcart', nouns: ['cart', 'wagon', 'handcart'], hp: 40, weight: 1, cover: 2, blocks: true, climbable: true, flammable: true, fireSource: false, liquid: false, blinding: false },
  tree:     { kind: 'tree', name: 'a tree', nouns: ['tree', 'trunk', 'oak', 'pine'], hp: 60, weight: 2, cover: 1, blocks: true, climbable: false, flammable: true, fireSource: false, liquid: false, blinding: false },
  well:     { kind: 'well', name: 'the well', nouns: ['well'], hp: 99, weight: 2, cover: 1, blocks: true, climbable: false, flammable: false, fireSource: false, liquid: true, blinding: false },
  log:      { kind: 'log', name: 'a fallen log', nouns: ['log', 'branch', 'bough'], hp: 30, weight: 1, cover: 1, blocks: false, climbable: true, flammable: true, fireSource: false, liquid: false, blinding: false },
  relic:    { kind: 'relic', name: 'the silver reliquary', nouns: ['relic', 'reliquary', 'silver', 'casket'], hp: 99, weight: 0, cover: 0, blocks: false, climbable: false, flammable: false, fireSource: false, liquid: false, blinding: false },
  tent:     { kind: 'tent', name: 'a tent', nouns: ['tent', 'canvas', 'awning'], hp: 15, weight: 2, cover: 1, blocks: true, climbable: false, flammable: true, fireSource: false, liquid: false, blinding: false },
  torch:    { kind: 'torch', name: 'a torch', nouns: ['torch', 'brand'], hp: 5, weight: 0, cover: 0, blocks: false, climbable: false, flammable: false, fireSource: true, liquid: false, blinding: false },
};

/** What each world POI kind contributes to a battle map. */
const POI_PROPS: Record<string, PropKind[]> = {
  market: ['crate', 'crate', 'barrel', 'oil', 'table', 'table', 'flour', 'cart'],
  rest: ['campfire', 'log', 'bucket', 'torch'],
  forge: ['brazier', 'barrel', 'bucket', 'crate'],
  well: ['well', 'bucket'],
  hut: ['barrel', 'crate'],
  field: ['hay', 'hay', 'cart'],
  meadow: ['hay', 'log'],
  forest: ['tree', 'tree', 'log'],
  mine: ['rocks', 'cart', 'crate', 'torch'],
};

export const key = (x: number, z: number): string => `${x},${z}`;
export const DIRS: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export interface WorldLike { pois?: ReadonlyArray<{ kind: string; pos: { x: number; z: number } }> }
export interface PerceptLike { id: unknown; pos?: { x: number; z: number } }

export class BattleMap {
  readonly n: number;
  readonly ox: number; readonly oz: number;   // world coords of tile (0,0)'s corner
  readonly tiles: Tile[] = [];
  readonly props = new Map<string, Prop>();
  private nextProp = 1;

  constructor(center: { x: number; z: number }, n = 16, opts: { world?: WorldLike | null; percepts?: ReadonlyArray<PerceptLike>; bare?: boolean } = {}) {
    this.n = n;
    this.ox = Math.round(center.x / TILE) * TILE - (n / 2) * TILE;
    this.oz = Math.round(center.z / TILE) * TILE - (n / 2) * TILE;
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const wx = this.ox + x * TILE + TILE / 2, wz = this.oz + z * TILE + TILE / 2;
        const bar = safe(() => barrierAt(wx, wz), 0);
        const biome = safe(() => biomeAt(wx, wz), BIOME.PLAINS);
        const ground: Ground = bar === 1 ? 'water' : bar === 2 ? 'stone' : biome === BIOME.VILLAGE ? 'dirt' : biome === BIOME.HILLS ? 'stone' : 'grass';
        this.tiles.push({ x, z, wx, wz, h: Math.round(safe(() => terrainHeight(wx, wz), 0) / LEVEL), ground, burning: 0, wet: 0, smoke: 0, wall: false });
      }
    }
    if (opts.bare) return;
    // buildings wall off their footprint
    for (const b of opts.percepts ?? []) {
      if (typeof b.id !== 'string' || !b.id.startsWith('B:') || !b.pos) continue;
      const c = this.tileAtWorld(b.pos.x, b.pos.z);
      if (!c) continue;
      for (const t of this.tiles) if (Math.abs(t.x - c.x) <= 1 && Math.abs(t.z - c.z) <= 1) t.wall = true;
    }
    // POIs scatter their props on free tiles nearby
    for (const poi of opts.world?.pois ?? []) {
      const kinds = POI_PROPS[poi.kind];
      const c = kinds && this.tileAtWorld(poi.pos.x, poi.pos.z);
      if (!c) continue;
      for (const k of kinds) { const t = this.freeNear(c.x, c.z, 3); if (t) this.addProp(k, t.x, t.z); }
    }
    // forest ground grows trees
    for (const t of this.tiles) {
      if (t.wall || this.propAt(t.x, t.z)) continue;
      if (safe(() => biomeAt(t.wx, t.wz), '') === BIOME.FOREST && rng() < 0.18) this.addProp('tree', t.x, t.z);
    }
  }

  // ---- lookup -------------------------------------------------------------------------------

  inside(x: number, z: number): boolean { return x >= 0 && z >= 0 && x < this.n && z < this.n; }
  tile(x: number, z: number): Tile | null { return this.inside(x, z) ? this.tiles[z * this.n + x] : null; }
  tileAtWorld(wx: number, wz: number): Tile | null { return this.tile(Math.floor((wx - this.ox) / TILE), Math.floor((wz - this.oz) / TILE)); }
  propAt(x: number, z: number): Prop | undefined { for (const p of this.props.values()) if (p.x === x && p.z === z) return p; return undefined; }
  edge(x: number, z: number): boolean { return x === 0 || z === 0 || x === this.n - 1 || z === this.n - 1; }

  /** World-space y of the level-0 floor (a stage may soften raw terrain into readable steps). */
  baseY = 0;

  /**
   * Where a tile's surface is DRAWN: never below the real terrain mesh (so bodies and the grid
   * are visible), raised by the tile's tactical height and any climbable prop.
   */
  surfaceY(x: number, z: number, withProp = true): number {
    const t = this.tile(x, z); if (!t) return 0;
    const floor = Math.max(safe(() => terrainHeight(t.wx, t.wz), 0), this.baseY + t.h * LEVEL);
    return floor + (withProp ? this.standH(x, z) - t.h : 0) * LEVEL;
  }

  /** Standing height of a tile (a climbable prop lifts you onto it). */
  standH(x: number, z: number): number {
    const t = this.tile(x, z); if (!t) return 0;
    const p = this.propAt(x, z);
    return t.h + (p && p.climbable && !p.tipped ? 2 : 0);
  }

  /** Can a unit end a move / stand here (ignoring other units)? */
  standable(x: number, z: number): boolean {
    const t = this.tile(x, z);
    if (!t || t.wall) return false;
    const p = this.propAt(x, z);
    return !p || !p.blocks || p.climbable;
  }

  addProp(kind: PropKind, x: number, z: number, over: Partial<Prop> = {}): Prop {
    const p: Prop = { ...PROP_DEFS[kind], id: `p${this.nextProp++}`, x, z, burning: 0, tipped: false, ...over };
    this.props.set(p.id, p);
    return p;
  }

  removeProp(p: Prop): void { this.props.delete(p.id); }

  freeNear(cx: number, cz: number, r: number): Tile | null {
    const cand: Tile[] = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const t = this.tile(cx + dx, cz + dz);
      if (t && !t.wall && t.ground !== 'water' && !this.propAt(t.x, t.z)) cand.push(t);
    }
    return cand.length ? cand[Math.floor(rng() * cand.length)] : null;
  }

  /** A prop named in free text ("kick the brazier") — the longest noun match wins. */
  propNamed(text: string, near?: { x: number; z: number }, reach = 99): Prop | undefined {
    const t = ` ${text.toLowerCase().replace(/[^a-z ]/g, ' ')} `;
    let best: Prop | undefined, score = -1;
    for (const p of this.props.values()) {
      if (near && Math.abs(p.x - near.x) + Math.abs(p.z - near.z) > reach) continue;
      for (const n of p.nouns) {
        if (!t.includes(` ${n} `) && !t.includes(` ${n}s `)) continue;
        const d = near ? Math.abs(p.x - near.x) + Math.abs(p.z - near.z) : 0;
        const s = n.length * 10 - d;
        if (s > score) { best = p; score = s; }
      }
    }
    return best;
  }

  // ---- sight & cover --------------------------------------------------------------------------

  /** Line of sight between tiles: walls, full-cover props, smoke and ridges block it. */
  sees(ax: number, az: number, bx: number, bz: number): boolean {
    const h0 = this.standH(ax, az) + 3, h1 = this.standH(bx, bz) + 3;
    const steps = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    for (let i = 1; i < steps; i++) {
      const x = Math.round(ax + ((bx - ax) * i) / steps), z = Math.round(az + ((bz - az) * i) / steps);
      const t = this.tile(x, z); if (!t) return false;
      if (t.wall || t.smoke > 0) return false;
      const p = this.propAt(x, z);
      if (p && p.cover === 2 && !p.tipped) return false;
      const lineH = h0 + ((h1 - h0) * i) / steps;
      if (t.h > lineH) return false;
    }
    return true;
  }

  /**
   * Cover a defender at (dx,dz) has against an attacker at (ax,az): the best cover on the
   * defender's neighbouring tiles that faces the attacker. 0 when flanked (XCOM rules).
   */
  coverAgainst(dx: number, dz: number, ax: number, az: number): Cover {
    const vx = ax - dx, vz = az - dz;
    const len = Math.hypot(vx, vz) || 1;
    let best: Cover = 0;
    for (const [sx, sz] of DIRS) {
      if ((sx * vx + sz * vz) / len < 0.5) continue;            // this side doesn't face the attacker
      const t = this.tile(dx + sx, dz + sz);
      if (!t) continue;
      if (t.wall) { best = 2; continue; }
      const p = this.propAt(t.x, t.z);
      if (p && p.cover > best) best = p.tipped ? 1 : p.cover;
      if (this.standH(t.x, t.z) - this.standH(dx, dz) >= 3 && best < 1) best = 1;   // a ledge
    }
    return best;
  }
}

function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }
