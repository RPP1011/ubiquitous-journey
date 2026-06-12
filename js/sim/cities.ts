// CITIES — the FOUNDING subsystem: the bridge between a town and the discrete,
// Z-levelled tile fabric its buildings grow on. A sibling of Patrician/Watch/
// Surveyor (constructed in Simulation, ticked on the fixed loop, gated on a real
// spawned town). It owns one CityGrid (js/world/cityGrid.js) per town, centred on
// the town anchor, and is the LOOKUP the construction system claims plots from —
// replacing the Surveyor's continuous lane math with tile footprints + a vertical
// span of LEVELS (storeys up / cellars down), all reasoned on level 0.
//
// Responsibilities (and ONLY these — SRP):
//   • seed():       one CityGrid per existing sim.towns entry, at world build.
//   • gridFor():    the grid a town's buildings claim from (lazy-seeds defensively).
//   • claimPlot():  the convenience the BuildSites construction system calls.
//   • release():    free a footprint when a build is abandoned / a building ruined.
//   • tick():       a SIMPLE, bounded, guarded EMERGENT-founding check (a dense,
//                   persistent cluster of townsfolk far from every existing city
//                   founds a new one). Self-throttled, capped, OFF by default.
//
// PURE LOGIC + GRIDS — no THREE, no DOM in the logical path (the CityGrid is pure
// data; town.center is read x/z only). Fully HEADLESS-SAFE. Every entry point is
// wrapped so it NEVER throws on the fixed tick (the freeze lesson) — an unguarded
// access inside the tick would freeze the sim. Touches NO gold: founding mints no
// money and grids hold none, so the closed money loop is untouched. This is an
// EXECUTION system (it reads ground-truth positions to place/found) — the agent's
// *choice* to build stays belief-based in decide.js, so the epistemic split holds.

import { CityGrid } from '../world/cityGrid.js';
import { CITY } from './simconfig.js';
import { BEAT } from './chronicle.js';
import { setWallRadiusFromGrid, rebuildWalls } from './walls.js';
import type { FullCtx } from '../../types/sim.js';

// `Simulation` lives in another cluster (still .js) and `CityGrid` is an untyped
// world/* module — both cross this file as `any` deliberately (opaque to this port).
type Sim = any;             // Simulation is out-of-cluster (still .js)
type Grid = any;            // CityGrid (untyped world/* module)

export class Cities {
  sim: Sim;
  _grids: Map<number, Grid>;
  _acc: number;
  _foundSince: Map<string, number>;
  stats: { grids: number; founded: number };

  constructor(sim: Sim) {
    this.sim = sim;
    this._grids = new Map();        // townId -> CityGrid
    this._acc = 0;                  // emergent-founding self-throttle accumulator
    this._foundSince = new Map();   // coarse-cell key -> sim-time the cluster first persisted
    this.stats = { grids: 0, founded: 0 };
    // No bus subscription (this module owns grids, it neither emits nor consumes
    // deeds) — so a rebuilt world can never double-route anything through here.
  }

  // SEED a grid per existing town. Called once, from Simulation.spawn() AFTER
  // this.towns is built and BEFORE any build commission. Idempotent + guarded, so a
  // double-seed (or a stray re-spawn) can't multiply grids or throw on the tick.
  seed() {
    try {
      if (!CITY.enabled || !this.sim.towns) return;
      for (const town of this.sim.towns) {
        if (!town || this._grids.has(town.id)) continue;
        this._grids.set(town.id, new CityGrid(town.center, {}));
        this.stats.grids++;
      }
    } catch { /* never throw */ }
  }

  // LOOKUP the construction system uses. Returns the town's CityGrid or null;
  // lazy-seeds defensively if a town appeared after init (an emergent founding, or a
  // commission racing a fresh spawn) so a stale townId never returns null mid-run.
  gridFor(townId: number): Grid | null {
    try {
      let g = this._grids.get(townId);
      if (g) return g;
      const town = (this.sim.towns || []).find((t: { id: number }) => t && t.id === townId);
      if (town) { g = new CityGrid(town.center, {}); this._grids.set(townId, g); this.stats.grids++; return g; }
      return null;
    } catch { return null; }
  }

  // CONVENIENCE the BuildSites construction system calls: claim a tile plot in a
  // town. Returns the CityGrid.claimPlot result — { centerPos:{x,z}, yaw, tiles,
  // baseLevel, topLevel, tilesW, tilesD } — or null (city full / no such town).
  // Guarded so a bad townId can never throw inside the build commission.
  claimPlot(townId: number, w: number, d: number, levels = 1, zone: string | null = null, cellars = 0) {
    try {
      const g = this.gridFor(townId);
      if (!g) return null;
      let p = g.claimPlot(w, d, levels, zone, cellars);
      // SETTLEMENT GROWTH: a full town doesn't refuse the build — it grows a block-ring
      // (world positions preserved; see CityGrid.grow) and tries once more. The growth
      // cap (CITY.growth.maxTiles) is the real "city full". Chronicled: a town outgrowing
      // its bounds is a story.
      if (!p && CITY.growth && CITY.growth.enabled !== false && g.grow()) {
        p = g.claimPlot(w, d, levels, zone, cellars);
        // THE WALL FOLLOWS THE PLAN: a grown town's ring moves out to enclose the new
        // blocks (collision is per-town + dynamic; the visual re-lays browser-side).
        try {
          setWallRadiusFromGrid(townId, g.size, g.tile);
          if (typeof document !== 'undefined') rebuildWalls();
        } catch { /* walls are best-effort */ }
        try {
          const town = (this.sim.towns || []).find((t: any) => t && t.id === townId);
          if (this.sim.chronicle) this.sim.chronicle.note(BEAT.BUILD, null,
            `${(town && town.name) || 'The town'} has outgrown its old bounds — new streets are laid beyond the edge, and the wall moves with them.`);
        } catch { /* chronicle is best-effort flavour */ }
      }
      return p;
    } catch { return null; }
  }

  // is a town's RESIDENTIAL band running tight? (the densification signal — construction
  // gives new homes an extra storey instead of sprawl when this is true). Guarded.
  homesTight(townId: number): boolean {
    try {
      const g = this.gridFor(townId);
      return !!g && g.zoneFreeFrac('homes') < ((CITY.growth && CITY.growth.denseBelow) || 0.35);
    } catch { return false; }
  }

  // RELEASE a footprint back to the grid (a build was abandoned / a building ruined),
  // so the plot frees up for the town to rebuild on. Guarded no-op on bad args.
  release(townId: number, tiles: unknown) {
    try { const g = this.gridFor(townId); if (g && tiles) g.release(tiles); }
    catch { /* */ }
  }

  // SIMPLE EMERGENT FOUNDING (bounded, guarded, never-throws). Self-throttled to
  // CITY.found.checkEvery. A persistent dense cluster of townsfolk FAR from every
  // existing city centre founds a new one — but it is hard-capped by CITY.found.
  // maxCities so it can never run away. Ships DISABLED (CITY.found.enabled default
  // false) — drop it the moment it risks the green build; the rest of Cities stands.
  tick(ctx: FullCtx, dt: number) {
    try {
      if (!CITY.enabled || !this.sim._spawned) return;
      this._acc += dt;
      const every = (CITY.found && CITY.found.checkEvery) || 30;
      if (this._acc < every) return;
      this._acc = 0;
      if (!CITY.found || !CITY.found.enabled) return;                 // OFF by default
      if ((this.sim.towns || []).length >= (CITY.found.maxCities || 6)) return;  // hard cap
      this._maybeFound(ctx);
    } catch { /* never throw on the tick (freeze lesson) */ }
  }

  // ground-truth scan (EXECUTION layer): bucket townsfolk into coarse cells, find the
  // densest cell whose centroid sits FAR from every existing town, and — if that
  // cluster has PERSISTED long enough — found a new town there. All numbers come from
  // CITY.found (tuning lives in config). Fully guarded.
  _maybeFound(ctx: FullCtx) {
    const F = CITY.found || {};
    const minDist = F.minDist || 120;
    const minCluster = F.minCluster || 8;
    const persist = F.persistSecs || 120;
    const t = (ctx && ctx.time) || this.sim.time || 0;
    const cell = Math.max(8, minDist * 0.5);   // coarse cell ~half the keep-out radius

    // bucket living, autonomous townsfolk by coarse cell; track each cell's centroid.
    const cells = new Map<string, { n: number; sx: number; sz: number }>();
    for (const a of this.sim.agents) {
      if (!a || !a.alive || !a.autonomous || a.faction !== 'townsfolk' || !a.pos) continue;
      const cx = Math.floor(a.pos.x / cell), cz = Math.floor(a.pos.z / cell);
      const k = `${cx},${cz}`;
      let c = cells.get(k);
      if (!c) { c = { n: 0, sx: 0, sz: 0 }; cells.set(k, c); }
      c.n++; c.sx += a.pos.x; c.sz += a.pos.z;
    }

    // the densest cell that clears the cluster floor AND sits far from every town.
    let best: { x: number; z: number } | null = null, bestN = 0, bestKey: string | null = null;
    for (const [k, c] of cells) {
      if (c.n < minCluster || c.n <= bestN) continue;
      const x = c.sx / c.n, z = c.sz / c.n;
      let farEnough = true;
      for (const town of (this.sim.towns || [])) {
        if (!town || !town.center) continue;
        const dx = x - town.center.x, dz = z - town.center.z;
        if (dx * dx + dz * dz < minDist * minDist) { farEnough = false; break; }
      }
      if (!farEnough) continue;
      best = { x, z }; bestN = c.n; bestKey = k;
    }

    // PERSISTENCE: a cluster must hold for persist seconds before it founds a town —
    // a momentary crowd (a passing caravan, a battle) must not spawn a city. Prune the
    // stale watch-keys so the map can't grow unbounded.
    if (!best || bestKey == null) { this._foundSince.clear(); return; }
    for (const k of [...this._foundSince.keys()]) if (k !== bestKey) this._foundSince.delete(k);
    const since = this._foundSince.get(bestKey);
    if (since == null) { this._foundSince.set(bestKey, t); return; }
    if ((t - since) < persist) return;                                // not persistent yet
    this._foundSince.delete(bestKey);

    this._found(best, ctx);
  }

  // FOUND a new town at a centre: push a town record onto sim.towns (so all the
  // town-anchored subsystems see it), seed its grid, and chronicle the moment. No
  // gold is minted — a founding is purely a new anchor + an empty grid. Guarded.
  _found(center: { x: number; z: number }, ctx: FullCtx) {
    try {
      const towns = this.sim.towns || (this.sim.towns = []);
      const id = towns.length;
      const tr = (towns[0] && towns[0].radius) || 70;
      const name = this._foundName(id);
      // mirror Simulation.spawn()'s town record shape: a THREE-like centre is enough
      // (CityGrid reads x/z only), but reuse a Vector3 if the town centres are ones.
      const Ctor = towns[0] && towns[0].center && towns[0].center.constructor;
      const ctr = Ctor ? new Ctor(center.x, 0, center.z) : { x: center.x, y: 0, z: center.z };
      const town = { id, center: ctr, radius: tr, name, founded: (ctx && ctx.time) || this.sim.time || 0 };
      towns.push(town);
      this.seed();                                                    // drop the new town's grid
      this.stats.founded++;
      try {
        if (this.sim.chronicle) this.sim.chronicle.note(BEAT.BUILD, null,
          `A new settlement, ${name}, was founded in the wilds.`);
      } catch { /* chronicle is best-effort flavour */ }
    } catch { /* never throw on a founding */ }
  }

  // pick a not-yet-used name from the town name pool, falling back to an ordinal.
  _foundName(id: number): string {
    try {
      const names = (this.sim.towns && this.sim.towns.length && (this.sim._townNames || null)) || null;
      void names;
      // The configured pool lives on the spawn side; here we just avoid collisions
      // with names already in use, else synthesise a stable ordinal name.
      const used = new Set((this.sim.towns || []).map((t: { name?: string }) => t && t.name));
      const pool = (this.sim.townNamePool || []);
      for (const n of pool) if (!used.has(n)) return n;
      return `Settlement ${id + 1}`;
    } catch { return `Settlement ${id + 1}`; }
  }

  // symmetric teardown — drop the grids (they hold no gold, meshes or bus listeners).
  dispose() { this._grids.clear(); this._foundSince.clear(); }
}
