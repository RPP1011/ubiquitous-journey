// CITY GRID — the discrete, Z-LEVELLED tile fabric a founded city grows on. Replaces
// the Surveyor's continuous lane math: when a population founds a city (cities.js), it
// drops a CityGrid anchored at the centre. Buildings then claim a TILE FOOTPRINT (a w×d
// block) plus a vertical span of LEVELS — so a house literally IS a stack of tiles, and
// construction can raise it one level at a time (build UP for storeys, DOWN for cellars).
// ROADS are pre-laid on a regular lattice so the blocks between them read as city streets,
// and new buildings must touch a road (no landlocked houses).
//
// PURE DATA + MATH — no THREE, no DOM, fully headless-safe (the sim picks tiles by x/z;
// the mesh/undercity layers are a browser/visual concern layered on top later). The sim
// still LIVES on level 0 (ground): road + ground-floor occupancy drive placement and (later)
// collision, while a building's upper/lower levels are its vertical extent, not a separate
// navigable plane. Never throws on a query — guarded like the rest of the sim spine.

import { CITY } from '../sim/simconfig.js';

// ground-tile state (level 0). A building's footprint stamps BUILDING here; its vertical
// span lives on the building record, since footprints never overlap so vertical is free.
export const TILE = { EMPTY: 0, ROAD: 1, BUILDING: 2, RESERVED: 3 };

// ZONES — the town PLAN (derived from tile position, never stored): a central PLAZA kept
// permanently open (the square the town gathers on — no plot may ever take a plaza tile),
// a CIVIC band fronting it (public works: tavern/granary/guildhall/shrine claim here, so
// the heart of town reads as a square ringed by its institutions), and HOMES beyond (the
// residential blocks). claimPlot takes a zone PREFERENCE — hard only for the plaza;
// civic/homes fall back gracefully when their band is full, so a crowded town still builds.
export const ZONE = { PLAZA: 'plaza', CIVIC: 'civic', HOMES: 'homes' } as const;

// ── FILE-LOCAL shapes (module-private: not part of the shared type layer) ──
/** A tile coordinate in the grid (level-0 footprint cell). */
interface TileXY { tx: number; ty: number; }
/** A building record tracked on the grid (footprint + vertical span). */
interface BuildingRec { tiles: TileXY[]; baseLevel: number; topLevel: number; id: number; }
/** What claimPlot returns to the construction system (consumed loosely there). */
interface PlotClaim {
  centerPos: { x: number; z: number };
  yaw: number;
  tiles: TileXY[];
  baseLevel: number;
  topLevel: number;
  tilesW: number;
  tilesD: number;
}
/** A THREE-like centre — only x/z are read. */
interface CenterLike { x?: number; z?: number; }
/** Per-instance config overrides (tests pass a subset). */
interface CityGridOpts {
  tile?: number; size?: number; block?: number; levelH?: number;
  minLevel?: number; maxLevel?: number;
  plazaR?: number; civicDepth?: number;
}
type Zone = typeof ZONE[keyof typeof ZONE];

export class CityGrid {
  cx: number;
  cz: number;
  tile: number;
  size: number;
  block: number;
  levelH: number;
  minLevel: number;
  maxLevel: number;
  plazaR: number;
  civicDepth: number;
  _ground: Uint8Array;
  _buildings: BuildingRec[];

  // center: THREE-like {x,z} (we only read x/z). opts overrides CITY config (tests).
  constructor(center: CenterLike, opts: CityGridOpts = {}) {
    this.cx = (center && center.x) || 0;
    this.cz = (center && center.z) || 0;
    this.tile = opts.tile || CITY.tile;            // metres per tile
    this.size = opts.size || CITY.gridTiles;       // tiles per side (square)
    this.block = opts.block || CITY.block;         // road lattice period (blocks of block-1 wide)
    this.levelH = opts.levelH || CITY.levelHeight; // metres per Z-level (mesh/visual)
    this.minLevel = opts.minLevel ?? CITY.minLevel;
    this.maxLevel = opts.maxLevel ?? CITY.maxLevel;
    this.plazaR = opts.plazaR ?? ((CITY.zone && CITY.zone.plazaR) || 2);        // plaza half-width, tiles
    this.civicDepth = opts.civicDepth ?? ((CITY.zone && CITY.zone.civicDepth) || 2); // civic band depth past the plaza
    this._ground = new Uint8Array(this.size * this.size); // level-0 tile state
    this._buildings = [];                          // { tiles:[{tx,ty}], baseLevel, topLevel, id }
    this._layRoadLattice();
  }

  // ---- world <-> tile mapping (anchored at the city centre) -------------------
  _idx(tx: number, ty: number): number { return ty * this.size + tx; }
  inBounds(tx: number, ty: number): boolean { return tx >= 0 && ty >= 0 && tx < this.size && ty < this.size; }

  // tile centre -> world x/z. The grid is centred on (cx,cz): tile (s/2,s/2) ~ centre.
  tileToWorld(tx: number, ty: number): { x: number; z: number } {
    const h = this.size / 2;
    return { x: this.cx + (tx - h + 0.5) * this.tile, z: this.cz + (ty - h + 0.5) * this.tile };
  }
  worldToTile(x: number, z: number): TileXY {
    const h = this.size / 2;
    return { tx: Math.floor((x - this.cx) / this.tile + h), ty: Math.floor((z - this.cz) / this.tile + h) };
  }
  // world Y of a given Z-level (cosmetic for the sim; used by the mesh layer).
  levelY(level: number): number { return level * this.levelH; }

  state(tx: number, ty: number): number { return this.inBounds(tx, ty) ? this._ground[this._idx(tx, ty)] : TILE.RESERVED; }

  // a regular ROAD lattice: every `block`-th row and column is a street. The cells
  // between are buildable blocks. Gives instant, readable city streets — the simplest
  // thing that produces real blocks rather than a ring of huts.
  _layRoadLattice(): void {
    const s = this.size, b = Math.max(2, this.block);
    for (let ty = 0; ty < s; ty++) for (let tx = 0; tx < s; tx++) {
      if (tx % b === 0 || ty % b === 0) this._ground[this._idx(tx, ty)] = TILE.ROAD;
    }
  }

  _isEmpty(tx: number, ty: number): boolean { return this.state(tx, ty) === TILE.EMPTY; }
  _isRoad(tx: number, ty: number): boolean { return this.state(tx, ty) === TILE.ROAD; }

  // the town-plan ZONE of a tile, derived from Chebyshev distance to the grid centre:
  // PLAZA (≤ plazaR, never built on), CIVIC (the band fronting it), HOMES (the rest).
  zoneOf(tx: number, ty: number): Zone {
    const h = (this.size - 1) / 2;
    const c = Math.max(Math.abs(tx - h), Math.abs(ty - h));
    if (c <= this.plazaR) return ZONE.PLAZA;
    if (c <= this.plazaR + this.civicDepth) return ZONE.CIVIC;
    return ZONE.HOMES;
  }

  // is any tile of this w×d block (anchored at tx,ty) edge-adjacent to a road? (no
  // landlocked buildings — every house fronts a street, which is also its entrance).
  _touchesRoad(tx: number, ty: number, w: number, d: number): boolean {
    for (let dy = -1; dy <= d; dy++) for (let dx = -1; dx <= w; dx++) {
      const onPerim = dx === -1 || dx === w || dy === -1 || dy === d;
      if (onPerim && this._isRoad(tx + dx, ty + dy)) return true;
    }
    return false;
  }

  // the yaw that faces the nearest fronting road from a w×d block at (tx,ty) — so the
  // door/façade addresses the street. Forward in this sim is (-sin yaw, -cos yaw).
  _faceRoad(tx: number, ty: number, w: number, d: number): number {
    const cxT = tx + w / 2, cyT = ty + d / 2;
    let best: { rx: number; ry: number } | null = null, bestD = Infinity;
    for (let dy = -1; dy <= d; dy++) for (let dx = -1; dx <= w; dx++) {
      if (!this._isRoad(tx + dx, ty + dy)) continue;
      const rx = tx + dx + 0.5, ry = ty + dy + 0.5;
      const dd = (rx - cxT) ** 2 + (ry - cyT) ** 2;
      if (dd < bestD) { bestD = dd; best = { rx, ry }; }
    }
    if (!best) return 0;
    // world-space direction from block centre toward the road tile
    const wx = (best.rx - cxT) * this.tile, wz = (best.ry - cyT) * this.tile;
    return Math.atan2(-wx, -wz);  // matches MODEL forward = (-sin, -cos)
  }

  // CLAIM a buildable plot: the empty w×d block, touching a road, NEAREST the centre
  // (cities densify from the core out). `levels` = how tall (>=1); clamped to the grid's
  // vertical span. Returns { centerPos:{x,z}, yaw, tiles:[{tx,ty}], baseLevel, topLevel,
  // tilesW, tilesD } or null if the city is full. Stamps the footprint as BUILDING.
  claimPlot(w: number, d: number, levels = 1, zone: Zone | null = null, cellars = 0): PlotClaim | null {
    w = Math.max(1, w | 0); d = Math.max(1, d | 0);
    const topLevel = Math.min(this.maxLevel, Math.max(0, (levels | 0) - 1));
    // CELLARS (the undercity): a building may DIG as well as rise — its span extends below
    // ground to baseLevel (clamped at the grid's minLevel). The sim still lives on level 0;
    // a cellar is storage mass under the house (the strongbox the owner banks into).
    const baseLevel = Math.max(this.minLevel, -Math.max(0, cellars | 0));
    // gather candidate anchors, nearest-centre first (stable, deterministic ordering).
    // THE TOWN PLAN constrains them: a footprint may NEVER take a plaza tile (the square
    // stays open, hard), and a requested zone is a soft PREFERENCE — civic works hug the
    // plaza, homes fill the blocks beyond; when the preferred band is full the claim
    // falls back to any legal tile so a crowded town still builds.
    const h = this.size / 2, cands: { tx: number; ty: number; dist: number; inZone: boolean }[] = [];
    for (let ty = 0; ty + d <= this.size; ty++) for (let tx = 0; tx + w <= this.size; tx++) {
      let ok = true, inZone = true;
      for (let dy = 0; dy < d && ok; dy++) for (let dx = 0; dx < w; dx++) {
        if (!this._isEmpty(tx + dx, ty + dy)) { ok = false; break; }
        const z = this.zoneOf(tx + dx, ty + dy);
        if (z === ZONE.PLAZA) { ok = false; break; }            // the square is never built on
        if (zone && z !== zone) inZone = false;                 // footprint strays out of the asked band
      }
      if (!ok || !this._touchesRoad(tx, ty, w, d)) continue;
      const ccx = tx + w / 2, ccy = ty + d / 2;
      cands.push({ tx, ty, dist: (ccx - h) ** 2 + (ccy - h) ** 2, inZone });
    }
    if (!cands.length) return null;
    const preferred = zone ? cands.filter((c) => c.inZone) : cands;
    const pool = preferred.length ? preferred : cands;          // soft fallback (plaza stays hard)
    pool.sort((a, b) => a.dist - b.dist);
    const { tx, ty } = pool[0];
    const tiles: TileXY[] = [];
    for (let dy = 0; dy < d; dy++) for (let dx = 0; dx < w; dx++) { this._ground[this._idx(tx + dx, ty + dy)] = TILE.BUILDING; tiles.push({ tx: tx + dx, ty: ty + dy }); }
    const c = this.tileToWorld(tx + (w - 1) / 2, ty + (d - 1) / 2);
    const rec = { tiles, baseLevel, topLevel, id: this._buildings.length };
    this._buildings.push(rec);
    return { centerPos: c, yaw: this._faceRoad(tx, ty, w, d), tiles, baseLevel, topLevel, tilesW: w, tilesD: d };
  }

  // GROW the settlement by one block-ring per side (the town visibly expands outward).
  // The shift by exactly `block` is load-bearing twice over: it preserves the road-
  // lattice PHASE ((tx+block) % block === tx % block, so old building tiles stay off-road)
  // and every existing tile's WORLD position (h grows by block exactly as tx does, so
  // tileToWorld is unchanged for shifted tiles — no building moves, no mesh re-anchors).
  // Tile records are mutated IN PLACE so callers' held plot references stay valid
  // (release() frees by the same objects). Returns false at the growth cap.
  grow(maxTiles?: number): boolean {
    const cap = maxTiles ?? ((CITY.growth && CITY.growth.maxTiles) || 32);
    const b = Math.max(2, this.block);
    const newSize = this.size + 2 * b;
    if (newSize > cap) return false;
    this.size = newSize;
    this._ground = new Uint8Array(newSize * newSize);
    this._layRoadLattice();
    for (const rec of this._buildings) {
      for (const t of rec.tiles) { t.tx += b; t.ty += b; this._ground[this._idx(t.tx, t.ty)] = TILE.BUILDING; }
    }
    return true;
  }

  // fraction of a zone's BUILDABLE (non-road) tiles still empty — the densification
  // signal: when the residential band runs tight, new homes rise a storey instead of
  // sprawling, and the town grows a ring when even that runs out.
  zoneFreeFrac(zone: Zone): number {
    let free = 0, total = 0;
    for (let ty = 0; ty < this.size; ty++) for (let tx = 0; tx < this.size; tx++) {
      const v = this._ground[this._idx(tx, ty)];
      if (v === TILE.ROAD) continue;
      if (this.zoneOf(tx, ty) !== zone) continue;
      total++;
      if (v === TILE.EMPTY) free++;
    }
    return total ? free / total : 0;
  }

  // release a footprint back to EMPTY (a build abandoned / a building ruined).
  release(tiles: TileXY[]): void {
    if (!tiles) return;
    for (const t of tiles) if (this.inBounds(t.tx, t.ty)) this._ground[this._idx(t.tx, t.ty)] = TILE.EMPTY;
    this._buildings = this._buildings.filter((b) => b.tiles !== tiles);
  }

  // is this world point inside a building footprint on the ground (a solid wall, for
  // collision once we wire it)? Roads + empty ground are passable. Guarded.
  isSolidAt(x: number, z: number): boolean {
    const { tx, ty } = this.worldToTile(x, z);
    return this.state(tx, ty) === TILE.BUILDING;
  }

  // counts for telemetry / tests.
  stats(): { road: number; building: number; empty: number; buildings: number; size: number } {
    let road = 0, building = 0, empty = 0;
    for (let i = 0; i < this._ground.length; i++) { const v = this._ground[i]; if (v === TILE.ROAD) road++; else if (v === TILE.BUILDING) building++; else if (v === TILE.EMPTY) empty++; }
    return { road, building, empty, buildings: this._buildings.length, size: this.size };
  }

  // an ASCII picture of the ground plane — '#' road, '0'..'9' a building's storey count
  // (its topLevel+1, capped), 'o' the open plaza, '.' empty. Lets us EYE the layout
  // headless (no browser).
  ascii(): string {
    const lvlOf = new Map<number, number>();
    for (const b of this._buildings) for (const t of b.tiles) lvlOf.set(t.ty * this.size + t.tx, Math.min(9, (b.topLevel - b.baseLevel) + 1));
    const rows = [];
    for (let ty = 0; ty < this.size; ty++) {
      let r = '';
      for (let tx = 0; tx < this.size; tx++) {
        const v = this._ground[this._idx(tx, ty)];
        r += v === TILE.ROAD ? '#' : v === TILE.BUILDING ? String(lvlOf.get(this._idx(tx, ty)) || 1)
          : (this.zoneOf(tx, ty) === ZONE.PLAZA ? 'o' : '.');
      }
      rows.push(r);
    }
    return rows.join('\n');
  }
}
