// BUILDING PARTS — a building is not a monolith but a sparse set of COMPONENT tiles:
// each cell (tx,ty,level) holds a part (WALL / FLOOR / ROOF / DOOR) with its own hp and
// MATERIAL. The shell is generated PROCEDURALLY from a CityGrid plot (footprint × storey
// span): perimeter cells become walls, a road-facing wall becomes the door, interior cells
// floors, and a roof caps the top — no predefined template, every building unique to its plot.
//
// Why components: so RAIDS can take a building apart piece by piece. A raider smashes the
// nearest wall; a torch ignites wood; FIRE spreads across adjacent flammable parts and
// consumes them. A building only SHELTERS (confers its comfort benefit) while enough of its
// walls + roof survive — so a breached or burnt-out home quietly turns its owner back into
// someone who needs to rebuild (construction = replacing the missing parts).
//
// PURE DATA + MATH — no THREE, no DOM; headless-safe. The mesh layer reads the same parts to
// draw (and to drop) geometry. Guarded; never throws on a query.

import { CITY } from '../sim/simconfig.js';
import { rng as simRng } from '../sim/rng.js';

// `as const` so the part/material values are literal unions (not widened `string`),
// matching the PartType/Material types below at every call site.
export const PART = { WALL: 'wall', FLOOR: 'floor', ROOF: 'roof', DOOR: 'door' } as const;
export const MATERIAL = { WOOD: 'wood', STONE: 'stone' } as const;

// ── FILE-LOCAL shapes (module-private: not part of the shared type layer) ──
type PartType = typeof PART[keyof typeof PART];
type Material = typeof MATERIAL[keyof typeof MATERIAL];
/** One component tile of a building (its own hp + material + burning state). */
interface Part { type: PartType; material: Material; hp: number; maxHp: number; burning: number; }
/** The procedural shell of a building: a sparse map of component parts. */
export interface Structure {
  parts: Map<string, Part>;
  foot: Set<string>;
  base: number;
  top: number;
  orig: { wall: number; roof: number; count: number };
}
/** A plot as returned by CityGrid.claimPlot (only these fields are read here). */
interface Plot { tiles: { tx: number; ty: number }[]; baseLevel: number; topLevel: number; yaw?: number; }
/** Per-shell options (currently only the wall/floor material). */
interface ShellOpts { material?: Material; }
/** Per-strike options (fire flag drives ignition). */
interface DamageOpts { fire?: boolean; }

const key = (tx: number, ty: number, lv: number): string => `${tx},${ty},${lv}`;
const matHp = (mat: Material): number => (mat === MATERIAL.STONE ? CITY.part.stoneHp : CITY.part.woodHp);
const flammable = (mat: Material): boolean => mat === MATERIAL.WOOD;

// build the procedural shell for a plot. `plot` is what CityGrid.claimPlot returns:
// { tiles:[{tx,ty}], baseLevel, topLevel, yaw }. Returns a Structure:
//   { parts: Map<key, {type,material,hp,maxHp,burning}>, foot:Set<"tx,ty">, base, top }
export function generateShell(plot: Plot, opts: ShellOpts = {}): Structure {
  const material = opts.material || MATERIAL.WOOD;
  const foot = new Set(plot.tiles.map((t) => key(t.tx, t.ty, 0)).map((k) => k.slice(0, k.lastIndexOf(','))));
  const inFoot = (tx: number, ty: number): boolean => foot.has(`${tx},${ty}`);
  const isPerim = (tx: number, ty: number): boolean => !inFoot(tx - 1, ty) || !inFoot(tx + 1, ty) || !inFoot(tx, ty - 1) || !inFoot(tx, ty + 1);
  const parts = new Map<string, Part>();
  const add = (tx: number, ty: number, lv: number, type: PartType, mat: Material = material): Map<string, Part> => parts.set(key(tx, ty, lv), { type, material: mat, hp: matHp(mat), maxHp: matHp(mat), burning: 0 });

  // walls (perimeter) + floors (interior), one storey per level
  for (let lv = plot.baseLevel; lv <= plot.topLevel; lv++) {
    for (const t of plot.tiles) add(t.tx, t.ty, lv, isPerim(t.tx, t.ty) ? PART.WALL : PART.FLOOR);
  }
  // the door: the ground-level perimeter cell most in the plot's FACING direction (the
  // façade addresses the street). forward = (-sin yaw, -cos yaw); tile axes track x/z.
  const fx = -Math.sin(plot.yaw || 0), fy = -Math.cos(plot.yaw || 0);
  let cx = 0, cy = 0; for (const t of plot.tiles) { cx += t.tx; cy += t.ty; } cx /= plot.tiles.length; cy /= plot.tiles.length;
  let door: { tx: number; ty: number } | null = null, bestDot = -Infinity;
  for (const t of plot.tiles) {
    if (!isPerim(t.tx, t.ty)) continue;
    const dot = (t.tx - cx) * fx + (t.ty - cy) * fy;
    if (dot > bestDot) { bestDot = dot; door = t; }
  }
  if (door) { const p = parts.get(key(door.tx, door.ty, plot.baseLevel)); if (p) p.type = PART.DOOR; }

  // roof cap: a roof part over each footprint tile at one level above the top storey.
  for (const t of plot.tiles) add(t.tx, t.ty, plot.topLevel + 1, PART.ROOF);

  // record the ORIGINAL wall/roof mass so integrity is measured against what was BUILT —
  // a destroyed part must drop the fraction, not silently leave the accounting.
  let wall0 = 0, roof0 = 0;
  for (const p of parts.values()) { if (p.type === PART.WALL || p.type === PART.DOOR) wall0 += p.maxHp; else if (p.type === PART.ROOF) roof0 += p.maxHp; }
  return { parts, foot, base: plot.baseLevel, top: plot.topLevel, orig: { wall: wall0, roof: roof0, count: parts.size } };
}

// shelter report — the fraction of walls/roof still standing, and whether the building
// still keeps the weather out (the gate on whether it confers its benefit at all).
export function shelterReport(struct: Structure): { wallFrac: number; roofFrac: number; sheltered: boolean; intact: number } {
  let wallH = 0, roofH = 0;
  for (const p of struct.parts.values()) {
    if (p.type === PART.WALL || p.type === PART.DOOR) wallH += Math.max(0, p.hp);
    else if (p.type === PART.ROOF) roofH += Math.max(0, p.hp);
  }
  // measured against the ORIGINAL mass — destroyed/collapsed parts contribute 0, so the
  // fraction falls as the raid takes the building apart.
  const o = struct.orig || { wall: wallH, roof: roofH };
  const wallFrac = o.wall ? wallH / o.wall : 0;
  const roofFrac = o.roof ? roofH / o.roof : 1;   // a building with no modelled roof still counts as covered
  const sheltered = wallFrac >= CITY.part.shelterMin && roofFrac >= CITY.part.shelterMin;
  return { wallFrac, roofFrac, sheltered, intact: intactCount(struct) };
}

function intactCount(struct: Structure): number { let n = 0; for (const p of struct.parts.values()) if (p.hp > 0) n++; return n; }

// damage a specific part. On reaching 0 hp the part is REMOVED (a hole / collapse). `fire`
// damage can also IGNITE a flammable part it doesn't yet destroy. Returns true if destroyed.
export function damagePart(struct: Structure, tx: number, ty: number, lv: number, amount: number, opts: DamageOpts = {}): boolean {
  const k = key(tx, ty, lv);
  const p = struct.parts.get(k);
  if (!p) return false;
  p.hp -= amount;
  if (opts.fire && flammable(p.material) && p.hp > 0) p.burning = Math.max(p.burning, 1);
  if (p.hp <= 0) { struct.parts.delete(k); return true; }
  return false;
}

// the raid's reach into a building: damage the toughest-standing WALL/DOOR nearest a point
// (a raider battering the façade). Returns the part type hit, or null if nothing left to hit.
export function strikeNearestWall(struct: Structure, tx: number, ty: number, dmg: number, opts: DamageOpts = {}): PartType | null {
  let best: string | null = null, bestD = Infinity;
  for (const [k, p] of struct.parts) {
    if (p.type !== PART.WALL && p.type !== PART.DOOR) continue;
    const [px, py] = k.split(',').map(Number);
    const d = (px - tx) ** 2 + (py - ty) ** 2;
    if (d < bestD) { bestD = d; best = k; }
  }
  if (!best) return null;
  const p = struct.parts.get(best); const [px, py, pl] = best.split(',').map(Number);
  const type = p ? p.type : null;
  damagePart(struct, px, py, pl, dmg, opts);
  return type;
}

// a thrown torch: ignite a flammable part near a point (the spark a raid spreads from).
export function torch(struct: Structure, tx: number, ty: number, rng: () => number = simRng): boolean {
  for (const [k, p] of struct.parts) {
    if (!flammable(p.material)) continue;
    const [px, py] = k.split(',').map(Number);
    if (Math.abs(px - tx) <= 1 && Math.abs(py - ty) <= 1) {
      if (rng() < CITY.part.fireIgnite) { p.burning = 1; return true; }
    }
  }
  return false;
}

// fire spreads to the 4 horizontal neighbours AND climbs/drops a storey (biased upward —
// fire climbs). A torch can gut a whole wood house if it isn't put out.
const FIRE_NB: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, 1], [0, 0, -1]];

// advance any spreading fire: burning parts lose hp and (probabilistically) ignite adjacent
// flammable parts; consumed parts are removed, then the structure SETTLES (anything left
// unsupported collapses). Returns the count destroyed this step (incl. collapse).
export function tickFire(struct: Structure, dt: number, rng: () => number = simRng): number {
  let destroyed = 0;
  const burning: [string, Part][] = [];
  for (const [k, p] of struct.parts) if (p.burning > 0) burning.push([k, p]);
  for (const [k, p] of burning) {
    p.hp -= CITY.part.firePerSec * dt;
    if (p.hp <= 0) { struct.parts.delete(k); destroyed++; continue; }
    if (rng() < CITY.part.fireSpread * dt) {
      const [px, py, pl] = k.split(',').map(Number);
      const [dx, dy, dz] = FIRE_NB[(rng() * FIRE_NB.length) | 0];
      const np = struct.parts.get(key(px + dx, py + dy, pl + dz));
      if (np && flammable(np.material) && np.burning <= 0) np.burning = 1;
    }
  }
  destroyed += settle(struct);
  return destroyed;
}

// COLLAPSE: a part above the ground floor with nothing under it falls — and that can
// cascade (removing a floor pulls down the storey above, and the roof with it). The ground
// floor rests on the earth. Iterated to a fixed point. Returns how many parts collapsed.
// This is what makes a raid's destruction structural: breach the ground floor and the
// whole house comes down, not just the tiles you hit.
export function settle(struct: Structure): number {
  let removed = 0, changed = true;
  while (changed) {
    changed = false;
    for (const k of [...struct.parts.keys()]) {
      const [tx, ty, lv] = k.split(',').map(Number);
      if (lv <= struct.base) continue;                 // ground floor is supported by the ground
      if (!struct.parts.has(key(tx, ty, lv - 1))) { struct.parts.delete(k); removed++; changed = true; }
    }
  }
  return removed;
}

export function anyBurning(struct: Structure): boolean { for (const p of struct.parts.values()) if (p.burning > 0) return true; return false; }

// an ASCII slice of one level — W wall · D door · . floor · R roof · * burning · (space) gone.
export function asciiLevel(struct: Structure, lv: number, foot: Set<string>): string {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const f of foot) { const [x, y] = f.split(',').map(Number); minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  const rows = [];
  for (let y = miny; y <= maxy; y++) {
    let r = '';
    for (let x = minx; x <= maxx; x++) {
      const p = struct.parts.get(key(x, y, lv));
      if (!p) r += foot.has(`${x},${y}`) ? ' ' : '.';
      else if (p.burning > 0) r += '*';
      else r += p.type === PART.WALL ? 'W' : p.type === PART.DOOR ? 'D' : p.type === PART.ROOF ? 'R' : '.';
    }
    rows.push(r);
  }
  return rows.join('\n');
}
