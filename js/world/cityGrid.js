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

export class CityGrid {
  // center: THREE-like {x,z} (we only read x/z). opts overrides CITY config (tests).
  constructor(center, opts = {}) {
    this.cx = (center && center.x) || 0;
    this.cz = (center && center.z) || 0;
    this.tile = opts.tile || CITY.tile;            // metres per tile
    this.size = opts.size || CITY.gridTiles;       // tiles per side (square)
    this.block = opts.block || CITY.block;         // road lattice period (blocks of block-1 wide)
    this.levelH = opts.levelH || CITY.levelHeight; // metres per Z-level (mesh/visual)
    this.minLevel = opts.minLevel ?? CITY.minLevel;
    this.maxLevel = opts.maxLevel ?? CITY.maxLevel;
    this._ground = new Uint8Array(this.size * this.size); // level-0 tile state
    this._buildings = [];                          // { tiles:[{tx,ty}], baseLevel, topLevel, id }
    this._layRoadLattice();
  }

  // ---- world <-> tile mapping (anchored at the city centre) -------------------
  _idx(tx, ty) { return ty * this.size + tx; }
  inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.size && ty < this.size; }

  // tile centre -> world x/z. The grid is centred on (cx,cz): tile (s/2,s/2) ~ centre.
  tileToWorld(tx, ty) {
    const h = this.size / 2;
    return { x: this.cx + (tx - h + 0.5) * this.tile, z: this.cz + (ty - h + 0.5) * this.tile };
  }
  worldToTile(x, z) {
    const h = this.size / 2;
    return { tx: Math.floor((x - this.cx) / this.tile + h), ty: Math.floor((z - this.cz) / this.tile + h) };
  }
  // world Y of a given Z-level (cosmetic for the sim; used by the mesh layer).
  levelY(level) { return level * this.levelH; }

  state(tx, ty) { return this.inBounds(tx, ty) ? this._ground[this._idx(tx, ty)] : TILE.RESERVED; }

  // a regular ROAD lattice: every `block`-th row and column is a street. The cells
  // between are buildable blocks. Gives instant, readable city streets — the simplest
  // thing that produces real blocks rather than a ring of huts.
  _layRoadLattice() {
    const s = this.size, b = Math.max(2, this.block);
    for (let ty = 0; ty < s; ty++) for (let tx = 0; tx < s; tx++) {
      if (tx % b === 0 || ty % b === 0) this._ground[this._idx(tx, ty)] = TILE.ROAD;
    }
  }

  _isEmpty(tx, ty) { return this.state(tx, ty) === TILE.EMPTY; }
  _isRoad(tx, ty) { return this.state(tx, ty) === TILE.ROAD; }

  // is any tile of this w×d block (anchored at tx,ty) edge-adjacent to a road? (no
  // landlocked buildings — every house fronts a street, which is also its entrance).
  _touchesRoad(tx, ty, w, d) {
    for (let dy = -1; dy <= d; dy++) for (let dx = -1; dx <= w; dx++) {
      const onPerim = dx === -1 || dx === w || dy === -1 || dy === d;
      if (onPerim && this._isRoad(tx + dx, ty + dy)) return true;
    }
    return false;
  }

  // the yaw that faces the nearest fronting road from a w×d block at (tx,ty) — so the
  // door/façade addresses the street. Forward in this sim is (-sin yaw, -cos yaw).
  _faceRoad(tx, ty, w, d) {
    const cxT = tx + w / 2, cyT = ty + d / 2;
    let best = null, bestD = Infinity;
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
  claimPlot(w, d, levels = 1) {
    w = Math.max(1, w | 0); d = Math.max(1, d | 0);
    const topLevel = Math.min(this.maxLevel, Math.max(0, (levels | 0) - 1));
    // gather candidate anchors, nearest-centre first (stable, deterministic ordering)
    const h = this.size / 2, cands = [];
    for (let ty = 0; ty + d <= this.size; ty++) for (let tx = 0; tx + w <= this.size; tx++) {
      let ok = true;
      for (let dy = 0; dy < d && ok; dy++) for (let dx = 0; dx < w; dx++) if (!this._isEmpty(tx + dx, ty + dy)) { ok = false; break; }
      if (!ok || !this._touchesRoad(tx, ty, w, d)) continue;
      const ccx = tx + w / 2, ccy = ty + d / 2;
      cands.push({ tx, ty, dist: (ccx - h) ** 2 + (ccy - h) ** 2 });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.dist - b.dist);
    const { tx, ty } = cands[0];
    const tiles = [];
    for (let dy = 0; dy < d; dy++) for (let dx = 0; dx < w; dx++) { this._ground[this._idx(tx + dx, ty + dy)] = TILE.BUILDING; tiles.push({ tx: tx + dx, ty: ty + dy }); }
    const c = this.tileToWorld(tx + (w - 1) / 2, ty + (d - 1) / 2);
    const rec = { tiles, baseLevel: 0, topLevel, id: this._buildings.length };
    this._buildings.push(rec);
    return { centerPos: c, yaw: this._faceRoad(tx, ty, w, d), tiles, baseLevel: 0, topLevel, tilesW: w, tilesD: d };
  }

  // release a footprint back to EMPTY (a build abandoned / a building ruined).
  release(tiles) {
    if (!tiles) return;
    for (const t of tiles) if (this.inBounds(t.tx, t.ty)) this._ground[this._idx(t.tx, t.ty)] = TILE.EMPTY;
    this._buildings = this._buildings.filter((b) => b.tiles !== tiles);
  }

  // is this world point inside a building footprint on the ground (a solid wall, for
  // collision once we wire it)? Roads + empty ground are passable. Guarded.
  isSolidAt(x, z) {
    const { tx, ty } = this.worldToTile(x, z);
    return this.state(tx, ty) === TILE.BUILDING;
  }

  // counts for telemetry / tests.
  stats() {
    let road = 0, building = 0, empty = 0;
    for (let i = 0; i < this._ground.length; i++) { const v = this._ground[i]; if (v === TILE.ROAD) road++; else if (v === TILE.BUILDING) building++; else if (v === TILE.EMPTY) empty++; }
    return { road, building, empty, buildings: this._buildings.length, size: this.size };
  }

  // an ASCII picture of the ground plane — '#' road, '0'..'9' a building's storey count
  // (its topLevel+1, capped), '.' empty. Lets us EYE the layout headless (no browser).
  ascii() {
    const lvlOf = new Map();
    for (const b of this._buildings) for (const t of b.tiles) lvlOf.set(t.ty * this.size + t.tx, Math.min(9, (b.topLevel - b.baseLevel) + 1));
    const rows = [];
    for (let ty = 0; ty < this.size; ty++) {
      let r = '';
      for (let tx = 0; tx < this.size; tx++) {
        const v = this._ground[this._idx(tx, ty)];
        r += v === TILE.ROAD ? '#' : v === TILE.BUILDING ? String(lvlOf.get(this._idx(tx, ty)) || 1) : '.';
      }
      rows.push(r);
    }
    return rows.join('\n');
  }
}
