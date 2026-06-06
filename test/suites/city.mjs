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

import { CityGrid, TILE } from '../../js/world/cityGrid.js';
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
  buildingPartsRaid(ok);
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
