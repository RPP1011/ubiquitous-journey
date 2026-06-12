// ---- tile-city integration ----------------------------------------------
// Targeted invariant suite for the two STANDALONE logical modules the founded-city
// integration is built on: the Z-levelled tile fabric (js/world/cityGrid.js) and the
// component-shell building model (js/world/buildingParts.js). Both are pure data + math
// (no THREE, no DOM), so we assert them directly — no full sim required. The soak run
// exercises the LIVE wiring (claim plots + raids + shelter) implicitly; this file pins
// the underlying mechanics deterministically.
//
// (a) CityGrid: no two buildings share a tile; every building fronts a road; roads are
//     never paved over; level spans stay within the grid's vertical bounds; world<->tile
//     round-trips; isSolidAt reads the footprint; a full grid returns null (never throws).
// (b) buildingParts: a shell generates + shelters; a raid (strikes + a torch + tickFire)
//     reduces walls and COLLAPSES unsupported parts; a gutted home reports sheltered=false.
//
// The rng-taking part fns (torch / tickFire) default to the platform random source but
// accept a seeded rng arg — we feed a local mulberry32 so the fire outcomes are
// deterministic and don't ride the global random source. Matches the (ok, {makeFighter,
// stubScene}) suite signature; synchronous (no meshes, no awaits).

import { CityGrid, TILE, ZONE } from '../../js/world/cityGrid.js';
import { wallRadiusFor, setWallRadiusFromGrid, resetWallRadii, collideWalls } from '../../js/sim/walls.js';
import { TOWNS } from '../../js/sim/simconfig.js';
import {
  generateShell, shelterReport, strikeNearestWall, torch, tickFire, anyBurning,
  settle, damagePart, PART, MATERIAL,
} from '../../js/world/buildingParts.js';
import { CITY } from '../../js/sim/simconfig.js';

// a tiny seeded PRNG so the rng-driven part fns (torch/tickFire) are deterministic in
// the test — same idiom the rest of the project uses for repeatable headless outcomes.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// signature is unused (these modules need no fighters/scene) but kept for parity with
// the sibling suites so the runner can call every suite the same way.
export function cityTest(ok, { makeFighter, stubScene } = {}) {
  cityGridInvariants(ok);
  cityZoning(ok);
  cityGrowth(ok);
  cityWalls(ok);
  buildingPartsRaid(ok);
}

// GRID-ALIGNED WALLS: the ring's default radius derives from the grid extent (the whole
// plan sits inside the wall), an off-gate crossing is blocked while the axis-street gate
// passes, and a GROWN town's ring moves out — the old wall line stops blocking.
function cityWalls(ok) {
  resetWallRadii();
  const expect = (CITY.gridTiles / 2) * CITY.tile + (TOWNS.wall.margin ?? 4);
  const R = wallRadiusFor(0);
  ok(R === expect, `cityWalls: the default radius derives from the grid extent (${R} = ${CITY.gridTiles}/2·${CITY.tile}+${TOWNS.wall.margin ?? 4})`);

  const [cx, cz] = TOWNS.centers[0];
  const a = Math.PI / 4;                              // 45°: safely between the axis gates
  const inX = cx + Math.cos(a) * (R - 2), inZ = cz + Math.sin(a) * (R - 2);
  const blocked = { x: cx + Math.cos(a) * (R + 2), y: 0, z: cz + Math.sin(a) * (R + 2) };
  collideWalls(blocked, inX, inZ);
  ok(Math.hypot(blocked.x - cx, blocked.z - cz) < R, 'cityWalls: an off-gate crossing is blocked (parked inside the ring)');

  const through = { x: cx + R + 2, y: 0, z: cz };     // the +x axis gate = the lattice street exit
  collideWalls(through, cx + R - 2, cz);
  ok(Math.hypot(through.x - cx, through.z - cz) > R, 'cityWalls: the axis-street gate lets the body through');

  setWallRadiusFromGrid(0, CITY.gridTiles + 2 * CITY.block, CITY.tile);
  ok(wallRadiusFor(0) > R, `cityWalls: a grown town's ring moves out with the plan (${R} -> ${wallRadiusFor(0)})`);
  const freed = { x: cx + Math.cos(a) * (R + 2), y: 0, z: cz + Math.sin(a) * (R + 2) };
  collideWalls(freed, inX, inZ);                      // the same off-gate step across the OLD line
  ok(Math.hypot(freed.x - cx, freed.z - cz) > R, 'cityWalls: the old wall line no longer blocks after growth');
  resetWallRadii();
}

// SETTLEMENT GROWTH: a full grid grows a block-ring per side — and the shift-by-block
// remap preserves BOTH the road-lattice phase and every standing building's exact world
// position (held plot references stay valid: tiles are mutated in place).
function cityGrowth(ok) {
  const grid = new CityGrid({ x: 0, z: 0 });
  ok(grid.zoneFreeFrac(ZONE.HOMES) === 1, 'cityGrow: a fresh residential band reads fully free');

  const p0 = grid.claimPlot(2, 2, 2, ZONE.CIVIC);
  const t0 = p0.tiles[0];
  const before = grid.tileToWorld(t0.tx, t0.ty);
  const sizeBefore = grid.size;

  // fill the old bounds to exhaustion — the densification signal must have fired well before.
  while (grid.claimPlot(1, 1, 1)) { /* fill */ }
  ok(grid.zoneFreeFrac(ZONE.HOMES) < ((CITY.growth && CITY.growth.denseBelow) || 0.35),
    'cityGrow: a packed residential band reads TIGHT (the build-UP signal)');

  ok(grid.grow() && grid.size === sizeBefore + 2 * grid.block,
    `cityGrow: the town grows a block-ring per side (${sizeBefore} -> ${grid.size})`);
  const after = grid.tileToWorld(t0.tx, t0.ty);   // same tile OBJECT, remapped coords
  ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.z - before.z) < 1e-9,
    'cityGrow: a standing building keeps its EXACT world position through growth');
  ok(grid.isSolidAt(before.x, before.z), 'cityGrow: the footprint survives the remap (still solid)');
  ok(grid.state(0, 0) === TILE.ROAD, 'cityGrow: the road-lattice phase is preserved (corner is a street)');
  ok(!!grid.claimPlot(1, 1, 1, ZONE.HOMES), 'cityGrow: the new ring takes fresh home claims');

  // growth respects its cap: grow to the cap, then refuse.
  let grew = 0;
  while (grid.grow()) grew++;
  ok(grid.size <= ((CITY.growth && CITY.growth.maxTiles) || 32) && !grid.grow(),
    `cityGrow: growth stops at the cap (size ${grid.size})`);

  // CELLARS: a claim may DIG — baseLevel goes below ground, clamped at the grid's minLevel.
  const dug = grid.claimPlot(1, 1, 2, ZONE.HOMES, 1);
  ok(!!dug && dug.baseLevel === -1 && dug.topLevel >= 1,
    `cityGrow: a cellared claim spans below ground (base=${dug && dug.baseLevel}, top=${dug && dug.topLevel})`);
  const deep = grid.claimPlot(1, 1, 1, ZONE.HOMES, 99);
  ok(!!deep && deep.baseLevel === grid.minLevel,
    `cityGrow: digging clamps at the grid's minLevel (base=${deep && deep.baseLevel})`);
}

// THE TOWN PLAN (zones): the plaza stays open under any pressure; civic claims hug the
// plaza; home claims keep to the residential blocks while space remains; and when the
// asked band is full the claim falls back softly instead of failing the build.
function cityZoning(ok) {
  const grid = new CityGrid({ x: 0, z: 0 });

  // a CIVIC claim (the tavern) lands in the civic band — fronting the plaza.
  const civic = grid.claimPlot(2, 2, 2, ZONE.CIVIC);
  ok(!!civic && civic.tiles.every((t) => grid.zoneOf(t.tx, t.ty) === ZONE.CIVIC),
    'cityZone: a civic claim lands wholly in the civic band (the plaza front)');

  // a HOMES claim keeps out of the civic band while residential space remains.
  const home = grid.claimPlot(1, 1, 1, ZONE.HOMES);
  ok(!!home && home.tiles.every((t) => grid.zoneOf(t.tx, t.ty) === ZONE.HOMES),
    'cityZone: a home claim keeps to the residential blocks');

  // fill the grid to exhaustion with home claims: NO building tile may ever be plaza,
  // and the claims must eventually overflow softly into civic (fallback) before null.
  let p, claimed = 0, civicFallback = 0;
  while ((p = grid.claimPlot(1, 1, 1, ZONE.HOMES))) {
    claimed++;
    for (const t of p.tiles) if (grid.zoneOf(t.tx, t.ty) === ZONE.CIVIC) civicFallback++;
    if (claimed > 500) break;   // backstop (cannot happen on a 16-grid)
  }
  ok(claimed > 10, `cityZone: the town keeps building to exhaustion (${claimed} homes)`);
  ok(civicFallback > 0, `cityZone: a full residential band falls back SOFTLY into civic (${civicFallback} tiles)`);
  const plazaTaken = grid._buildings.some((b) => b.tiles.some((t) => grid.zoneOf(t.tx, t.ty) === ZONE.PLAZA));
  ok(!plazaTaken, 'cityZone: the plaza is NEVER built on, even at full occupancy (the square stays open)');

  // the ascii eyeball: plaza renders open ('o') so a layout glance shows the square.
  ok(grid.ascii().includes('o'), 'cityZone: ascii renders the open plaza');
}

// (a) CITYGRID INVARIANTS — the road lattice + plot allocator must keep the city
// well-formed: footprints never overlap, every building fronts a road, roads are never
// consumed, vertical spans stay in bounds, and the world<->tile map round-trips.
function cityGridInvariants(ok) {
  const grid = new CityGrid({ x: 0, z: 0 });
  const fresh = grid.stats();                 // road count BEFORE any claim
  const roadStart = fresh.road;

  // claim a handful of plots of varied footprint + height. Some may return null once the
  // small core fills — that's fine; we only assert over the ones that succeeded.
  const want = [[1, 1, 1], [2, 2, 2], [1, 1, 2], [3, 1, 1], [2, 1, 3]];
  const plots = [];
  for (const [w, d, lv] of want) { const p = grid.claimPlot(w, d, lv); if (p) plots.push(p); }
  ok(plots.length >= 2, `cityGrid: claimed multiple plots (${plots.length}/${want.length})`);

  // NO TWO BUILDINGS SHARE A TILE — every claimed tile is unique across all plots.
  const tileKeys = new Set();
  let total = 0, dup = false;
  for (const p of plots) for (const t of p.tiles) {
    total++; const k = `${t.tx},${t.ty}`; if (tileKeys.has(k)) dup = true; tileKeys.add(k);
  }
  ok(!dup && tileKeys.size === total, `cityGrid: no two buildings share a tile (${total} tiles, ${tileKeys.size} unique)`);

  // EVERY BUILDING FRONTS A ROAD — at least one perimeter-adjacent tile is ROAD (re-derive
  // the ring around each footprint straight from grid.state, the ground truth).
  const fronts = (p) => {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const t of p.tiles) { minx = Math.min(minx, t.tx); maxx = Math.max(maxx, t.tx); miny = Math.min(miny, t.ty); maxy = Math.max(maxy, t.ty); }
    for (let ty = miny - 1; ty <= maxy + 1; ty++) for (let tx = minx - 1; tx <= maxx + 1; tx++) {
      const onRing = tx < minx || tx > maxx || ty < miny || ty > maxy;
      if (onRing && grid.state(tx, ty) === TILE.ROAD) return true;
    }
    return false;
  };
  ok(plots.every(fronts), 'cityGrid: every building fronts a road (no landlocked houses)');

  // NO ROAD PAVED OVER — every claimed tile reads BUILDING now (never ROAD), and the
  // grid's total road count is unchanged from the fresh lattice (claims only take EMPTY).
  const allBuilding = plots.every((p) => p.tiles.every((t) => grid.state(t.tx, t.ty) === TILE.BUILDING));
  ok(allBuilding, 'cityGrid: claimed tiles are all stamped BUILDING');
  ok(grid.stats().road === roadStart, `cityGrid: no road paved over (road ${roadStart} -> ${grid.stats().road})`);

  // LEVEL SPANS WITHIN BOUNDS — 0 <= base <= top <= maxLevel, and top reflects the
  // requested storeys (clamped). The single-storey plot spans exactly level 0.
  const spans = plots.every((p) => 0 <= p.baseLevel && p.baseLevel <= p.topLevel && p.topLevel <= CITY.maxLevel);
  ok(spans, 'cityGrid: level spans stay within the grid bounds (0..maxLevel)');
  const flat = grid.claimPlot(1, 1, 1);
  ok(!flat || flat.topLevel === 0, `cityGrid: a 1-storey plot spans exactly level 0 (top=${flat ? flat.topLevel : 'n/a'})`);

  // WORLD<->TILE ROUND-TRIPS — for a sample of tiles, mapping a tile to its world centre
  // and back yields the same (tx,ty).
  let roundOk = true;
  for (let tx = 1; tx < grid.size; tx += 3) for (let ty = 1; ty < grid.size; ty += 3) {
    const w = grid.tileToWorld(tx, ty);
    const back = grid.worldToTile(w.x, w.z);
    if (back.tx !== tx || back.ty !== ty) roundOk = false;
  }
  ok(roundOk, 'cityGrid: world<->tile round-trips exactly');

  // isSolidAt — a point inside a claimed footprint is solid; a road point is not; after
  // releasing the footprint the same point reads passable again.
  const p0 = plots[0];
  const t0 = p0.tiles[0];
  const wc = grid.tileToWorld(t0.tx, t0.ty);
  ok(grid.isSolidAt(wc.x, wc.z), 'cityGrid: isSolidAt is true inside a building footprint');
  // tile (0,0) is on the road lattice (every block-th line, starting at 0) — not solid.
  const rw = grid.tileToWorld(0, 0);
  ok(grid.state(0, 0) === TILE.ROAD && !grid.isSolidAt(rw.x, rw.z), 'cityGrid: isSolidAt is false on a road tile');
  grid.release(p0.tiles);
  ok(!grid.isSolidAt(wc.x, wc.z), 'cityGrid: released footprint reads passable again');
  // and the freed tiles can be RE-CLAIMED without overlapping a still-standing plot.
  const reclaim = grid.claimPlot(1, 1, 1);
  const live = new Set();
  for (const p of plots) if (p !== p0) for (const t of p.tiles) live.add(`${t.tx},${t.ty}`);
  const reuseOk = reclaim && reclaim.tiles.every((t) => !live.has(`${t.tx},${t.ty}`));
  ok(reuseOk, 'cityGrid: freed tiles re-claim without overlapping a standing building');

  // FULL GRID — claim until the core is exhausted; the allocator must eventually return
  // null (never throw) when no road-fronted empty block remains.
  let exhausted = false, guard = 0;
  try {
    while (guard++ < 5000) { if (grid.claimPlot(1, 1, 1) === null) { exhausted = true; break; } }
  } catch (err) { ok(false, `cityGrid: claim loop threw -> ${err && err.message}`); return; }
  ok(exhausted, `cityGrid: a full grid returns null without throwing (after ${guard} claims)`);
}

// (b) BUILDINGPARTS RAID / COLLAPSE / SHELTER — a procedural shell takes damage piece by
// piece: strikes peel walls off, an unsupported upper storey collapses, and a torched wood
// home burns out and stops sheltering. rng-driven steps use a SEEDED prng for determinism.
function buildingPartsRaid(ok) {
  // a multi-storey footprint plot (a 2x2 block, two storeys) — built by hand so we don't
  // depend on a CityGrid claim's exact tile coords. baseLevel 0, topLevel 1 (+ roof at 2).
  const mkPlot = () => ({
    tiles: [{ tx: 5, ty: 5 }, { tx: 6, ty: 5 }, { tx: 5, ty: 6 }, { tx: 6, ty: 6 }],
    baseLevel: 0, topLevel: 1, yaw: 0,
  });

  // a fresh shell SHELTERS — walls near-full, intact mass positive.
  const struct = generateShell(mkPlot(), { material: MATERIAL.WOOD });
  const r0 = shelterReport(struct);
  ok(r0.sheltered === true, 'buildingParts: a fresh shell shelters');
  ok(r0.wallFrac > 0.99 && r0.intact > 0, `buildingParts: fresh shell is intact (wallFrac=${r0.wallFrac.toFixed(2)}, intact=${r0.intact})`);

  // RAID REDUCES WALLS — battering the façade peels wall/door parts off: both the wall
  // fraction and the raw part count must strictly fall.
  const wallBefore = shelterReport(struct).wallFrac;
  const partsBefore = struct.parts.size;
  let hits = 0;
  // strike the door-facing tile repeatedly with heavy blows; big dmg removes parts fast.
  while (shelterReport(struct).wallFrac >= wallBefore && hits < 200) {
    if (strikeNearestWall(struct, 5, 5, CITY.part.woodHp + 5) === null) break;
    hits++;
  }
  const wallAfter = shelterReport(struct).wallFrac;
  ok(wallAfter < wallBefore, `buildingParts: a raid reduces walls (wallFrac ${wallBefore.toFixed(2)} -> ${wallAfter.toFixed(2)})`);
  ok(struct.parts.size < partsBefore, `buildingParts: struck parts are removed (${partsBefore} -> ${struct.parts.size})`);

  // COLLAPSES UNSUPPORTED PARTS — on a fresh shell, breach the GROUND floor beneath an
  // upper-storey stack (remove one base-level part) and SETTLE: the part directly above
  // it, the roof above THAT, and any further stack fall too — so the count drops by MORE
  // than the single part we destroyed (the structural cascade, not just the tile we hit).
  const tower = generateShell(mkPlot(), { material: MATERIAL.WOOD });
  // ensure there's something to pull down above (5,5): an upper-storey part + roof exist
  // by construction (topLevel 1 + roof at 2). Knock out the ground-floor part at (5,5).
  const aboveBefore = [...tower.parts.keys()].filter((k) => {
    const [tx, ty] = k.split(',').map(Number); return tx === 5 && ty === 5;
  }).length;
  const sizeBeforeCollapse = tower.parts.size;
  const destroyed = damagePart(tower, 5, 5, 0, CITY.part.woodHp + 5);   // remove the base part
  ok(destroyed === true, 'buildingParts: a ground-floor part is destroyed by a heavy blow');
  const collapsed = settle(tower);
  const removedTotal = sizeBeforeCollapse - tower.parts.size;
  ok(collapsed >= 1, `buildingParts: unsupported parts above a breach collapse (${collapsed} fell)`);
  ok(removedTotal > 1 && aboveBefore > 1, `buildingParts: the collapse cascades beyond the struck tile (${removedTotal} parts gone from one breach)`);
  // nothing left above the ground floor still floats over an empty cell.
  const floating = [...tower.parts.keys()].some((k) => {
    const [tx, ty, lv] = k.split(',').map(Number);
    return lv > tower.base && !tower.parts.has(`${tx},${ty},${lv - 1}`);
  });
  ok(!floating, 'buildingParts: after settling no part floats unsupported');

  // TORCH + tickFire GUTS A WOOD HOME — ignite a flammable part with a SEEDED rng, then
  // advance the fire with that same seeded rng: the wood shell burns out, stops sheltering,
  // and the fire eventually consumes itself (anyBurning goes false — no perpetual flame).
  const rng = mulberry32(0xC17E);                 // deterministic fire outcomes
  const home = generateShell(mkPlot(), { material: MATERIAL.WOOD });
  ok(shelterReport(home).sheltered === true, 'buildingParts: the home shelters before the torch');
  let lit = false;
  for (let i = 0; i < 50 && !lit; i++) lit = torch(home, 5, 5, rng);   // seeded ignition
  ok(lit && anyBurning(home), 'buildingParts: a torch ignites the wood home (seeded rng)');

  const dt = 1 / 6;                               // fixed-tick cadence (seconds-scale fire)
  let burnedOut = false;
  for (let i = 0; i < 600; i++) {
    tickFire(home, dt, rng);                      // seeded spread/consume
    if (!anyBurning(home)) { burnedOut = true; break; }
  }
  const rep = shelterReport(home);
  ok(rep.sheltered === false, `buildingParts: a gutted home stops sheltering (wallFrac=${rep.wallFrac.toFixed(2)}, roofFrac=${rep.roofFrac.toFixed(2)})`);
  ok(burnedOut && !anyBurning(home), 'buildingParts: the fire consumes itself and burns out (no perpetual flame)');
}
