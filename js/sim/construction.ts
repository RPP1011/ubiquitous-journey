// EMERGENT BUILDINGS (Phase 1) — private homes + one public tavern per town,
// paid in WOOD + the owner's own LABOUR time, never in minted gold.
//
// The town had a standing-but-unanswered demand: townsfolk could socialize and
// rest, but nobody could ever HOUSE themselves — comfort had no source. Phase 1
// closes that loop with capital the agents raise THEMSELVES. A 4th need, comfort,
// drains over time; an UNHOUSED agent's comfort is clamped to a low ceiling
// (COMFORT.unhousedCap), and that ceiling is the persistent demand pressure that
// makes a home worth building. A chronically-uncomfortable, wealthy townsperson
// commissions a private home; the Surveyor (its sibling) also commissions ONE
// tavern per town once the population is dense enough — the social hub that
// finally answers the original "buildings → socialization" goal.
//
// This module owns the construction ALGORITHM and the building records. It is the
// economic/execution layer, so it reads ground truth (positions, market) freely —
// the epistemic split is preserved because the agent's *choice* to build lives in
// decide.js and reads only the agent's own state (qualifyHome touches no one else).
//
// CLOSED MONEY LOOP: construction mints/burns no gold. A building is paid in WOOD
// (a renewable commodity gatherers produce) consumed into the site, plus the
// owner's labour time. The only gold that ever MOVES is a market buy of wood via
// the existing applyBuy/applySell pair (gold passes between two real agents). The
// town "fund" backing the tavern is a wood+labour abstraction, NOT a gold pool.
//
// HEADLESS/VISUAL SPLIT: the LOGICAL building (owner, kind, pos, footprint,
// progress, benefit) builds and works fully with no DOM. Only the procedural MESH
// is browser-only — generateBuilding is dynamically imported (so the mesh module
// never enters the headless graph) under a `typeof document` guard, mirroring
// defenses.js / walls.js. FREEZE LESSON: every building path is gated on
// a.canWork + guards optional fields, and the tick body is wrapped so it never
// throws inside the fixed loop.

import * as THREE from 'three';
import { rng } from './rng.js';
import { BUILD, SURVEYOR, CITY, MAP, HALL, DEVELOP } from './simconfig.js';
import { bus, makeEvent } from '../rpg/events.js';
import { terrainHeight } from '../arena.js';
import { BEAT } from './chronicle.js';
import { PERCEPT_KIND } from './percept.js';
import { Place } from './mentalmap.js';
import type { Agent, CognitionCtx } from '../../types/sim.js';

// EXECUTION layer: construction reads ground truth (positions, market, the CityGrid) and
// mutates the world; it takes the live Simulation instance, typed loosely (simulation.js is a
// LATER cluster). The internal BuildSite/Building records are module-private dynamic record
// shapes (no shared type — they live only here), so they are typed as `any` with intent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any; /* Simulation — ported in a later cluster */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BuildSite = any;   // a dynamic in-progress site record (owner/kind/plot/struct/progress/…)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Building = any;    // a dynamic finished-building percept record (id 'B:n'/kind/benefit/…)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;         // the build-tick context (only ctx.time is read); callers vary, kept loose

// the affordance table (data-driven), so a registered public Place advertises its affordances
// (a tavern shelter/rest, a granary larder, a guildhall crowd/social). Viewed as a string-keyed
// record for the kind-indexed lookup in _finalize.
const MAP_AFF = (((MAP && MAP.affordances) || {}) as unknown) as Record<string, string[]>;
import {
  generateShell, shelterReport, anyBurning, torch, strikeNearestWall, tickFire, MATERIAL,
} from '../world/buildingParts.js';
import { ZONE } from '../world/cityGrid.js';

// Construction's own POI kinds, so callers (act.js/decide.js) never need World to
// learn about buildings — BuildSites is itself the nearest()-style lookup. (These are
// the BUILD-TYPE of a site/building, kept on `buildKind`; a finished building's `.kind`
// is the PERCEPT kind so perception can file a place-belief about it.)
export const BUILD_KIND = { HOME: 'home', TAVERN: 'tavern', GRANARY: 'granary', GUILDHALL: 'guildhall', SHRINE: 'shrine' };

// is this BUILD type an owner-less PUBLIC work raised through the shared commission/labour path
// (wood + ambient labour, never gold)? The tavern and granary come from the town fund; the
// guildhall is commissioned by a fellowship (its anchor banks the wood); a SHRINE by a town's
// congregation (the dominant god's faithful) — all build the same way.
const isPublicKind = (kind: string): boolean =>
  kind === BUILD_KIND.TAVERN || kind === BUILD_KIND.GRANARY || kind === BUILD_KIND.GUILDHALL || kind === BUILD_KIND.SHRINE;

// BELIEF-BACKED HOUSING TEST (Phase 2a): is this agent unhoused, AS FAR AS IT KNOWS? Reads
// ONLY the agent's OWN belief about its home (homeBelief) — never a truth-side Building. An
// agent with no home-belief, or one whose home-belief has been revised to sheltered=false
// (it DISCOVERED the ruin by sight), is unhoused. This is the cognition-visible housing state
// the comfort/build demand reads; the world's truth-side building bookkeeping is separate.
// Pure + guarded (own-state only); never throws on a fixture missing fields.
export function isUnhoused(a: Agent): boolean {
  try {
    const b = (a && a.homeBeliefId != null && a.beliefs) ? a.beliefs.get(a.homeBeliefId) : null;
    return !b || b.sheltered === false;
  } catch { return true; }
}

// ROI / QUALIFY HELPER (pure, exported for decide.js + tests). True iff a
// townsperson genuinely wants — and can afford to start — a private home:
// chronically low comfort + a surplus-gold wealth gate, no home yet, not already
// building. Reads ONLY the agent's own state (epistemic split intact) and never
// throws on a professionless / fixture agent missing fields.
export function qualifyHome(agent: Agent, ctx: Ctx): boolean {
  try {
    if (!agent || !BUILD.enabled) return false;
    if (!agent.canWork || agent.faction !== 'townsfolk') return false;
    if (!isUnhoused(agent) || agent._buildSiteId) return false;  // housed (believes) / already building
    if (!agent.needs || typeof agent.needs.comfort !== 'number') return false;
    if (agent._comfortLowSince == null) return false;            // never been chronically low
    const t = (ctx && ctx.time) || 0;
    if ((t - (agent._comfortLowSince as number)) < BUILD.qualifyComfortStreak) return false;   // not chronic yet
    if ((agent.gold || 0) < BUILD.wealthGate) return false;      // wealth gate (surplus, NOT spent)
    return true;
  } catch { return false; }
}

// Is this townsperson set on raising a home — already committed to a site, OR a
// latent home-builder (no home, holds the wealth gate, and comfort has begun its
// chronic-low streak)? Used by the civic recruiters (Watch/expeditions/bounties/
// caravans) so they DON'T conscript someone away from a capital project they're
// about to start: the home-building demand-pressure pre-empts a conscription that
// would otherwise grab the builder during the qualify streak and never let go.
// Pure + guarded (reads only the agent's own state); never throws on a fixture.
export function isHomeBuilder(agent: Agent): boolean {
  try {
    if (!agent || !BUILD.enabled) return false;
    if (!agent.canWork || agent.faction !== 'townsfolk' || !isUnhoused(agent)) return false;
    if (agent._buildSiteId != null) return true;                 // committed to a site
    if (agent._comfortLowSince == null) return false;            // not even chronically low yet
    if (!agent.needs || typeof agent.needs.comfort !== 'number') return false;
    return (agent.gold || 0) >= BUILD.wealthGate;                // wealthy + chronically uncomfortable
  } catch { return false; }
}

// Wood a home costs (exported so decide/tests can read it without reaching into config).
export function homeWoodCost(): number { return BUILD.woodNeeded; }

// a tiny seeded PRNG (mulberry32) so per-building param derivation + mesh geometry
// are reproducible from building.seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// the lazily-imported mesh generator (browser-only). null until the first browser
// finalize resolves the dynamic import — mirrors Progression's fault-tolerant
// lazy ability-catalog import: the logical building never waits on it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _gen: ((rng: () => number, opts: any) => any) | null = null;

export class BuildSites {
  sim: Sim;
  _sites: BuildSite[];
  _buildings: Building[];
  _nextId: number;
  _acc: number;
  _pending: Building[];
  _displaced: Array<{ ownerId: unknown; town: unknown; plotPos: THREE.Vector3; at: number }>;
  stats: { commissioned: number; completed: number; homes: number; taverns: number; granaries: number; granaryMeals: number; halls: number; shrines: number };

  constructor(sim: Sim) {
    this.sim = sim;
    this._sites = [];        // active BuildSites (in progress)
    this._buildings = [];    // finished Buildings (POIs with live benefit)
    this._nextId = 1;
    this._acc = 0;
    this._pending = [];      // finished buildings awaiting the lazy mesh import (browser)
    // TRUTH-SIDE DISPLACEMENT QUEUE (Phase 2a backstop): owners whose home was razed.
    // Each entry { ownerId, town, plotPos, at }. Drained in tick() with a grace timer:
    // if the owner stays away (truth: still no building carrying his ownerId) past the
    // grace window, the TOWN re-commissions the rebuild on his behalf. Reads ground-truth
    // building presence ONLY — never an owner's beliefs (demand bookkeeping stays truth-side).
    this._displaced = [];
    // granaryMeals counts larder draws served (resolver.granaryDraw bumps it) — telemetry only.
    this.stats = { commissioned: 0, completed: 0, homes: 0, taverns: 0, granaries: 0, granaryMeals: 0, halls: 0, shrines: 0 };
    // No bus subscription: this module EMITS deeds (build), it doesn't consume
    // them, so a rebuilt world can't double-route XP through here. No mesh either.
  }

  // ---- param derivation -----------------------------------------------------
  // Bias geometry params from kind+wealth+a seeded rng. These only STEER the
  // parametric generator (footprint/storeys/palette); the generator assembles the
  // unique geometry. seed is stamped per commission so no two builds are identical.
  _paramsFor(kind: string, wealth: number, seed: number, dense = false) {
    const r = mulberry32(seed);
    const F = CITY.foot || {};
    if (kind === BUILD_KIND.TAVERN) {
      return {
        footprint: { w: 6 + r() * 2, d: 6 + r() * 2 },
        storeys: 2,
        // FOOTPRINT-IN-TILES (CityGrid claim) — a grander 2×2..3×3 block, 2 storeys.
        tiles: { w: (F.tavernW || 2) + (r() < 0.5 ? 1 : 0), d: (F.tavernD || 2) + (r() < 0.5 ? 1 : 0), levels: F.tavernLevels || 2 },
        wealth: SURVEYOR.tavernWealth,
        palette: (r() * 6) | 0,
        seed,
      };
    }
    if (kind === BUILD_KIND.GRANARY) {
      return {
        footprint: { w: 5 + r() * 1.5, d: 4 + r() },
        storeys: 1,
        // FOOTPRINT-IN-TILES — a long low civic store, a single storey.
        tiles: { w: F.granaryW || 2, d: F.granaryD || 1, levels: F.granaryLevels || 1 },
        wealth: SURVEYOR.granaryWealth,
        palette: (r() * 6) | 0,
        seed,
      };
    }
    if (kind === BUILD_KIND.SHRINE) {
      // a god's shrine: a small, tall build — a spire on a single tile, modest wood.
      return {
        footprint: { w: 3 + r() * 1.2, d: 3 + r() * 1.2 },
        storeys: F.shrineLevels || 2,
        tiles: { w: F.shrineW || 1, d: F.shrineD || 1, levels: F.shrineLevels || 2 },
        wealth: SURVEYOR.shrineWealth,
        palette: (r() * 6) | 0,
        seed,
      };
    }
    if (kind === BUILD_KIND.GUILDHALL) {
      // a fellowship's hall: tavern-grade (a public place of standing), fixed 2×2 block.
      return {
        footprint: { w: 5.5 + r() * 2, d: 5.5 + r() * 2 },
        storeys: F.hallLevels || 2,
        tiles: { w: F.hallW || 2, d: F.hallD || 2, levels: F.hallLevels || 2 },
        wealth: SURVEYOR.tavernWealth,
        palette: (r() * 6) | 0,
        seed,
      };
    }
    // home: a modest dwelling, occasionally two storeys for a wealthier owner — and
    // DENSITY BEFORE SPRAWL: in a town whose residential band runs tight (`dense`, the
    // cities.homesTight signal) every new home rises at least two storeys (capped at
    // CITY.growth.homeMaxLevels), so a crowded town visibly builds UP.
    const cap = (CITY.growth && CITY.growth.homeMaxLevels) || 3;
    const wealthy2 = wealth >= 2 && r() < 0.35;
    const levels = Math.min(cap, dense ? 2 + (wealthy2 ? 1 : 0) : (wealthy2 ? 2 : 1));
    // THE CELLAR (undercity): a dense town digs under its tall houses, and a wealthy owner
    // digs a strongbox either way -- the room the home-banking stash lives in.
    const cellars = (dense || wealth >= 2) ? 1 : 0;
    return {
      footprint: { w: 3 + r() * 2, d: 3 + r() * 2 },
      storeys: levels,
      // FOOTPRINT-IN-TILES — a 1×1 plot; storeys from wealth + town density.
      tiles: { w: F.homeW || 1, d: F.homeD || 1, levels, cellars },
      wealth,
      palette: (r() * 6) | 0,
      seed,
    };
  }

  // ---- plot / building lookup (so other code never needs World changes) -----
  // ALL active sites + finished buildings, as {pos, footprint} — the Surveyor's
  // overlap check reads this to keep new plots clear of existing ones.
  plots() {
    const out = [];
    for (const s of this._sites) out.push({ pos: s.pos, footprint: s.footprint });
    for (const b of this._buildings) out.push({ pos: b.pos, footprint: b.footprint });
    return out;
  }

  // nearest FINISHED building of `kind` (BUILD_KIND.*) by x/z squared distance,
  // or null. Mirrors World.nearest so act.js can call it the same way.
  nearest(kind: string, pos: THREE.Vector3): Building | null {
    let best: Building | null = null, bd = Infinity;
    for (const b of this._buildings) {
      if (b.buildKind !== kind) continue;    // build-type (home/tavern); b.kind is now the PERCEPT kind
      if (b.sheltered === false) continue;   // a razed/burnt building confers no benefit
      const dx = b.pos.x - pos.x, dz = b.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // Phase-1 walk-through: every finished building is accessible. The name leaves
  // room for Phase-2 occupancy/capacity.
  nearestAccessible(kind: string, pos: THREE.Vector3): Building | null { return this.nearest(kind, pos); }

  // true if a tavern exists OR is under construction in this town (so the Surveyor
  // never double-commissions one).
  hasTavern(townId: unknown): boolean {
    for (const s of this._sites) if (s.kind === BUILD_KIND.TAVERN && s.town === townId) return true;
    for (const b of this._buildings) if (b.buildKind === BUILD_KIND.TAVERN && b.town === townId) return true;
    return false;
  }

  // true if a granary exists OR is under construction in this town (the Surveyor's
  // one-larder-per-town gate, mirroring hasTavern).
  hasGranary(townId: unknown): boolean {
    for (const s of this._sites) if (s.kind === BUILD_KIND.GRANARY && s.town === townId) return true;
    for (const b of this._buildings) if (b.buildKind === BUILD_KIND.GRANARY && b.town === townId) return true;
    return false;
  }

  // does a town already have (or is raising) a shrine? — the congregation commissions ONE.
  hasShrine(townId: unknown): boolean {
    for (const s of this._sites) if (s.kind === BUILD_KIND.SHRINE && s.town === townId) return true;
    for (const b of this._buildings) if (b.buildKind === BUILD_KIND.SHRINE && b.town === townId) return true;
    return false;
  }

  // the standing, still-sheltered shrines of a god (faith.ts reads this for the
  // shrine-amplified miracle — a holy place only works while it stands). Guarded.
  shrinesFor(god: string): Building[] {
    const out: Building[] = [];
    for (const b of this._buildings) if (b.buildKind === BUILD_KIND.SHRINE && b.god === god && b.sheltered !== false) out.push(b);
    return out;
  }

  // an active BuildSite by id (act.js resolves agent._buildSiteId each tick).
  siteById(id: unknown): BuildSite | null {
    if (id == null) return null;
    for (const s of this._sites) if (s.id === id && !s.done) return s;
    return null;
  }

  // count of active PRIVATE home sites in a town (paces the town vs the cap).
  _activeHomesIn(townId: unknown): number {
    let n = 0;
    for (const s of this._sites) if (s.kind === BUILD_KIND.HOME && s.town === townId) n++;
    return n;
  }

  // ---- commissioning --------------------------------------------------------
  // A townsperson chooses to build (from act.js). Re-checks qualifyHome (so a
  // stale decide candidate is a safe no-op), asks the Surveyor for a plot, and
  // creates the BuildSite. Returns the site, or null (no room / at cap / unqualified).
  commission(agent: Agent, ctx: Ctx): BuildSite | null {
    try {
      if (!qualifyHome(agent, ctx)) return null;
      const town = this._townOf(agent.townId);
      if (!town) return null;
      if (this._activeHomesIn(town.id) >= BUILD.maxConcurrentPerTown) return null;   // pace the town
      const seed = (rng() * 1e9) | 0;
      if (!this.sim.cities) return null;
      // DENSITY BEFORE SPRAWL: a tight residential band makes new homes rise a storey.
      const p = this._paramsFor(BUILD_KIND.HOME, 1, seed, this.sim.cities.homesTight(town.id));
      // CLAIM A TILE PLOT from the town's CityGrid (replaces the Surveyor's lane math).
      const tp = p.tiles;
      const plot = this.sim.cities.claimPlot(town.id, tp.w, tp.d, tp.levels, ZONE.HOMES, tp.cellars || 0);   // the residential blocks
      if (!plot) return null;                                                          // city full: try later
      const site = this._makeSite({
        kind: BUILD_KIND.HOME, ownerId: agent.id, town: town.id, plot, params: p,
        woodNeeded: BUILD.woodNeeded, benefit: BUILD.homeBenefit, ctx,
      });
      this._sites.push(site);
      agent._buildSiteId = site.id;
      this.stats.commissioned++;
      return site;
    } catch { return null; }
  }

  // A PUBLIC work: the Surveyor commissions the town tavern / granary; Groups commissions a
  // fellowship's GUILDHALL through the same path. Owner-less; townsfolk build it via their
  // build goal + the small ambient town-labour accrual in tick. No gold changes hands — the
  // town "fund" is wood + labour only (a hall's wood is banked by the group's anchor).
  commissionPublic(town: { id: unknown }, kind: string, _plotIgnored: unknown, ctx: Ctx, extra: { god?: string } | null = null): BuildSite | null {
    try {
      if (!town) return null;
      const granary = kind === BUILD_KIND.GRANARY;
      const shrine = kind === BUILD_KIND.SHRINE;
      const seed = (rng() * 1e9) | 0;
      const p = this._paramsFor(kind, granary ? SURVEYOR.granaryWealth : (shrine ? SURVEYOR.shrineWealth : SURVEYOR.tavernWealth), seed);
      // CLAIM the public work's own tile plot from the CityGrid (the passed plot, an
      // old Surveyor lane allocation, is ignored — the grid guarantees non-overlap).
      if (!this.sim.cities) return null;
      const tp = p.tiles;
      // public works claim the CIVIC band: the plaza front, so the heart of town reads as
      // a square ringed by its institutions (soft preference — see CityGrid.claimPlot).
      const plot = this.sim.cities.claimPlot(town.id, tp.w, tp.d, tp.levels, ZONE.CIVIC);
      if (!plot) return null;
      const hall = kind === BUILD_KIND.GUILDHALL;
      const site = this._makeSite({
        kind, ownerId: null, town: town.id, plot, params: p,
        // a granary confers no needs benefit — its worth is the larder STOCK (the draw path).
        woodNeeded: granary ? SURVEYOR.granaryWood : (hall ? HALL.woodCost : (shrine ? SURVEYOR.shrineWood : SURVEYOR.tavernWood)),
        benefit: granary ? { comfort: 0, social: 0 } : (hall ? HALL.benefit : (shrine ? SURVEYOR.shrineBenefit : SURVEYOR.tavernBenefit)), ctx,
      });
      if (shrine && extra && extra.god) site.god = extra.god;   // the congregation's god — names the shrine
      this._sites.push(site);
      this.stats.commissioned++;
      return site;
    } catch { return null; }
  }

  // assemble a BuildSite record from a plot + derived params.
  // The plot (CityGrid claim) + params (derived geometry) are dynamic internal records, so
  // this arg bag is typed loosely (BuildSite is `any` — these records have no shared type).
  _makeSite({ kind, ownerId, town, plot, params, woodNeeded, benefit, ctx }: {
    kind: string; ownerId: unknown; town: unknown; plot: BuildSite; params: BuildSite;
    woodNeeded: number; benefit: { comfort?: number; social?: number }; ctx: Ctx;
  }): BuildSite {
    const t = (ctx && ctx.time) || 0;
    // the claimed plot is a CityGrid claim: centerPos {x,z} (not a Vector3), yaw, tiles,
    // baseLevel/topLevel. Keep the tile claim so we can build the parts shell + release.
    const sitePlot = { tiles: plot.tiles, baseLevel: plot.baseLevel, topLevel: plot.topLevel, yaw: plot.yaw || 0 };
    // generate the component shell now (pure + headless-safe): a public work (tavern/granary/
    // guildhall) is stone (grander, tougher), a home wood (cheaper, flammable). The struct is
    // the destructible source.
    const material = isPublicKind(kind) ? MATERIAL.STONE : MATERIAL.WOOD;
    let struct = null;
    try { struct = generateShell(sitePlot, { material }); } catch { struct = null; }
    return {
      id: this._nextId++,
      kind,
      ownerId,
      town,
      pos: new THREE.Vector3(plot.centerPos.x, 0, plot.centerPos.z),
      yaw: plot.yaw || 0,
      footprint: params.footprint,
      storeys: params.storeys,
      wealth: params.wealth,
      palette: params.palette,
      seed: params.seed,
      // tile claim + parts shell (the grid footprint + its destructible mass).
      plotTiles: plot.tiles,
      plot: sitePlot,
      struct,
      builtLevel: (plot.baseLevel || 0) - 1,   // staged-build cursor (nothing raised yet)
      woodNeeded,
      woodHave: 0,
      progress: 0,
      benefit: { comfort: benefit.comfort || 0, social: benefit.social || 0 },
      done: false,
      building: null,
      bornAt: t,
      lastProgressAt: t,
    };
  }

  _townOf(townId: unknown): BuildSite {   // a dynamic town record (no shared type)
    const towns = this.sim.towns || [];
    for (const tw of towns) if (tw.id === townId) return tw;
    return towns[0] || null;
  }

  // ---- the fixed-tick pass --------------------------------------------------
  // Progress accrual + wood reservation happen in act.js when the owner/labourer
  // stands on the plot. Here we only (a) seed a small ambient town-labour accrual
  // for the public tavern so it completes without a hiring market, (b) abandon
  // stalled sites, and (c) finalize completed ones. Fully guarded — never throws.
  tick(ctx: Ctx, dt: number): void {
    try {
      if (!BUILD.enabled || !this.sim._spawned) return;
      this._acc += dt;
      // attach any meshes whose lazy generator import has since resolved (browser).
      if (_gen && this._pending.length) this._flushPending();

      for (let i = this._sites.length - 1; i >= 0; i--) {
        const site = this._sites[i];
        if (site.done) continue;

        // PUBLIC WORKS (tavern/granary/guildhall): abstracted town labour. While the town
        // holds enough townsfolk, the work rises a little each tick (capped by the wood that
        // passing builders have actually contributed — so the commodity loop holds; a hall's
        // wood was banked up-front by the group's anchor, a real inventory).
        // A TOWN-FUNDED rebuild (the displacement backstop) rises the same way, so a
        // displaced owner's home is restored even if he never returns to build it.
        if ((site.ownerId == null && isPublicKind(site.kind)) || site.townFunded) {
          this._townLabour(site, ctx, dt);
        }

        // ABANDON: no progress for too long → the owner gives up, free the plot.
        if ((ctx.time - site.lastProgressAt) > BUILD.abandonAfter) {
          this._abandon(site, i);
          continue;
        }
        // COMPLETION: the plot's progress reached 1 → raise the building.
        if (site.progress >= 1) {
          this._finalize(site, ctx);
          this._sites.splice(i, 1);
        }
      }

      // RAID DAMAGE pass over finished buildings (the strike+fire+shelter passes own
      // where raiders hit, the fire spread, and the shelter-loss consequences). Reads
      // the public sim.director._raiders field; fully guarded inside the fixed tick.
      this._raidPass(ctx, dt);
      // TRUTH-SIDE displacement backstop: rebuild a displaced owner's home after a grace
      // window if he never returned to discover the ruin and re-commission it himself.
      this._drainDisplaced(ctx);
      // MOVE-IN: unhoused townsfolk take over vacant developer homes they come near (config DEVELOP).
      this._claimVacantHomes();
    } catch { /* never throw on the fixed tick (freeze lesson) */ }
  }

  // a raider standing next to a building batters its nearest wall and occasionally
  // torches it; any burning building advances its fire; a building that loses shelter
  // stops conferring its benefit (a home frees its owner, a public hub drops off
  // nearest()), files a razing beat, and a gutted one is ruined (tiles released). All
  // accesses guarded on b.struct / grid / ground-truth so it never throws on the tick.
  _raidPass(ctx: Ctx, dt: number): void {
    if (!this._buildings.length) return;
    const raiders = (this.sim.director && this.sim.director._raiders) || [];
    const R = CITY.raid || {};
    const reach2 = (R.reach || 6) * (R.reach || 6);
    for (let i = this._buildings.length - 1; i >= 0; i--) {
      const b = this._buildings[i];
      if (!b || !b.struct) continue;
      const grid = this.sim.cities && this.sim.cities.gridFor(b.town);

      // STRIKE/TORCH: any raider within reach hits the shell (needs the grid to map
      // its world pos onto the building's tile coords).
      if (grid && raiders.length) {
        for (const r of raiders) {
          if (!r || !r.alive || !r.pos) continue;
          const dx = r.pos.x - b.pos.x, dz = r.pos.z - b.pos.z;
          if (dx * dx + dz * dz > reach2) continue;
          const { tx, ty } = grid.worldToTile(r.pos.x, r.pos.z);
          if (rng() < (R.strikeChance || 1.2) * dt) strikeNearestWall(b.struct, tx, ty, R.strikeDmg || 14);
          if (rng() < (R.torchChance || 0.25) * dt) torch(b.struct, tx, ty);
        }
      }

      // FIRE: advance any spreading fire (consumes parts + collapses unsupported mass).
      if (anyBurning(b.struct)) tickFire(b.struct, dt, rng);

      // SHELTER re-eval: when a building loses shelter, kill its benefit and file a best-
      // effort razing beat. The owner is NOT unhoused here by fiat (debt #1 retired) — the
      // world no longer writes the owner's cognition. Instead the PERCEIVABLE state flips
      // (b.alive = b.sheltered), so an owner who walks home DISCOVERS the loss by sight; and
      // a TRUTH-SIDE displacement record (the demand backstop) is filed so housing stock
      // still recovers if the owner never returns.
      const rep = shelterReport(b.struct);
      const wasSheltered = b.sheltered !== false;
      b.sheltered = rep.sheltered;
      // a building's perceivable liveness tracks its shelter — perception reads o.alive and
      // writes the believed `sheltered`, so a torched-but-standing home advertises alive=false.
      b.alive = b.sheltered;
      if (wasSheltered && !b.sheltered) {
        if (b.buildKind === BUILD_KIND.HOME && b.ownerId != null) {
          this._recordDisplaced(b);   // TRUTH-SIDE demand backstop (no cognition write)
        }
        try {
          if (this.sim.chronicle) {
            const verb = anyBurning(b.struct) ? 'put to the torch' : 'broken open';
            this.sim.chronicle.note(BEAT.BUILD, b.ownerId,
              `${b.label || 'A building'} in ${this._townName(b.town)} was ${verb} by raiders.`);
          }
        } catch { /* chronicle is best-effort flavour */ }
      }
      // RUIN: a fully gutted building is removed + its tiles freed (rebuild demand).
      if (rep.intact === 0) this._ruin(b);
    }
  }

  // ambient town-labour accrual for a public site (tavern/granary). A grown town funds
  // it from its "fund" — an abstract WOOD + LABOUR pool, NOT gold (the closed money
  // loop is untouched): population both supplies the wood (a renewable commodity) and
  // raises the frame. Wood is fed in first (so woodHave keeps pace), then progress
  // accrues capped by it. No owner has to haul materials to a public work.
  _townLabour(site: BuildSite, ctx: Ctx, dt: number): void {
    let pop = 0;
    for (const a of this.sim.agents) {
      if (a.alive && !a.controlled && a.faction === 'townsfolk' && a.townId === site.town) pop++;
    }
    // each public kind keeps its own labour-pool gate (a granary commissions — and so must
    // rise — at a smaller town than a tavern would).
    const minPop = (site.kind === BUILD_KIND.GRANARY) ? SURVEYOR.granaryMinPop : SURVEYOR.tavernMinPop;
    if (pop < minPop) return;
    // the town fund delivers wood at the same cadence it raises the frame, so the
    // public build is never starved of materials (wood minted here is a commodity).
    const inc = BUILD.progressPerSec * dt * (BUILD.tavernTownLabor || 0.5);
    if (site.woodHave < site.woodNeeded) {
      site.woodHave = Math.min(site.woodNeeded, site.woodHave + (site.woodNeeded * inc));
    }
    const woodCap = site.woodHave / (site.woodNeeded || 1);
    const next = Math.min(woodCap, site.progress + inc);
    if (next > site.progress) { site.progress = next; site.lastProgressAt = ctx.time; }
  }

  // ---- completion -----------------------------------------------------------
  // Promote a finished site to a Building: benefit goes live, the home is recorded
  // on its owner, a chronicle beat is filed, and (browser-only) the procedural mesh
  // is attached. All field accesses guarded.
  _finalize(site: BuildSite, ctx: Ctx): void {
    const building: Building = {
      // NAMESPACED percept id (Phase 2a fix): a building's belief-keying id MUST be disjoint
      // from agent ids, which are bare integers from Simulation._nextId (1..N). Buildings and
      // agents share ONE per-observer BeliefStore keyed by raw id, so a bare integer here would
      // COLLIDE with a live agent's id — a perceived building would then overwrite (and be
      // overwritten by) a person-belief on the same key, corrupting home/place AND person state.
      // The `B:` prefix gives buildings their own namespace (mirrors the Scarecrow's `scare-…`
      // string ids and the static-map Place key below). homeBeliefId/homeBuildingOf compare this
      // same prefixed id, so the seam stays consistent.
      id: `B:${this._nextId++}`,
      // PERCEPT SURFACE (Phase 2a, places-as-percepts): a finished building is a percept.
      // `kind` is the PERCEPT kind (so perception files a place-belief about it); the BUILD
      // type (home/tavern) is preserved on `buildKind` (read by nearest/hasTavern/raid/ruin).
      kind: PERCEPT_KIND.BUILDING,
      buildKind: site.kind,
      ownerId: site.ownerId,
      town: site.town,
      pos: site.pos.clone(),
      yaw: site.yaw,
      footprint: site.footprint,
      storeys: site.storeys,
      wealth: site.wealth,
      palette: site.palette,
      seed: site.seed,
      benefit: site.benefit,
      // carry the tile claim + destructible parts shell onto the finished building so
      // raids can take it apart and ruin can release its plot.
      struct: site.struct,
      plotTiles: site.plotTiles,
      cellar: !!(site.plot && site.plot.baseLevel < 0),   // the strongbox room (home banking reads it)
      sheltered: true,
      // perceivable liveness mirrors shelter: a finished, intact building reads alive=true,
      // a torched one alive=false. Perception writes the believed `sheltered` from this.
      alive: true,
      faction: null,            // a place has no faction (perception records 'unknown')
      disguiseFaction: null,    // never disguised; keeps appearanceOf()/perceive() guards happy
      label: null,
      mesh: null,
    };
    // THE PUBLIC LARDER: a finished granary carries civic food STOCK (tithed in kind off
    // market food clears — market.ts; drawn one meal at a time by resolver.granaryDraw).
    // Food is produced/consumed, never a conserved quantity like gold, so the stock field
    // mints nothing. `_fedOnce` latches the first-meal chronicle beat.
    if (site.kind === BUILD_KIND.GRANARY) { building.stock = 0; building._fedOnce = false; }
    if (site.kind === BUILD_KIND.SHRINE) building.god = site.god || null;   // whose shrine this is (faith reads it)
    this._buildings.push(building);
    site.done = true;
    site.building = building;
    // register the building as a PERCEPT so agents can SEE it (and discover its home/shelter
    // state by sight). It lives in sim.percepts (never sim.agents), so no cognition/gossip/
    // subsystem loop touches a mindless body — exactly like a Scarecrow.
    try { if (this.sim.spawnPercept) this.sim.spawnPercept(building); } catch { /* */ }

    const owner = site.ownerId != null ? this.sim.agentsById.get(site.ownerId) : null;
    if (site.kind === BUILD_KIND.HOME && owner) {
      // debt #1 retired: the world no longer writes owner.home (cognition state). The owner
      // DISCOVERS his finished home by perceiving it (perception sets homeBeliefId). We only
      // release his build-site commitment here (truth-side bookkeeping).
      owner._buildSiteId = null;
    }

    // narrative: name the house, file a chronicle beat, seed the owner's memory.
    // (a GUILDHALL carries its fellowship's coined name — stamped on the site by Groups
    // at commission — so the chronicle reads "The Hammerfast Guild raised its hall.")
    const hn = owner ? (owner.house ? `${owner.house} House` : `${owner.name}'s house`) : 'a new house';
    building.label = site.kind === BUILD_KIND.TAVERN ? 'the tavern'
      : site.kind === BUILD_KIND.GRANARY ? 'the granary'
      : site.kind === BUILD_KIND.SHRINE ? (site.god ? `the shrine of ${site.god}` : 'the shrine')
      : (site.kind === BUILD_KIND.GUILDHALL ? (site.groupName ? `the hall of ${site.groupName}` : 'the guildhall') : hn);
    const town = this._townOf(site.town);
    const townName = (town && town.name) || 'the town';
    try {
      if (this.sim.chronicle) {
        if (site.kind === BUILD_KIND.TAVERN) {
          this.sim.chronicle.note('build', null,
            `${townName} raised a tavern — a hearth for the town to gather.`);
        } else if (site.kind === BUILD_KIND.GRANARY) {
          this.sim.chronicle.note('build', null,
            `${townName} raised a granary — a public larder against famine.`);
        } else if (site.kind === BUILD_KIND.GUILDHALL) {
          this.sim.chronicle.note('build', null,
            `${site.groupName ? site.groupName.charAt(0).toUpperCase() + site.groupName.slice(1) : 'A fellowship'} raised its hall in ${townName}.`);
        } else if (site.kind === BUILD_KIND.SHRINE) {
          this.sim.chronicle.note('build', null,
            `The faithful of ${site.god || 'the gods'} raised a shrine in ${townName}.`);
          // THE GOD'S BOON (doc 15 PR1, the faith:shrine seam): the LOCAL faithful receive
          // an event-born blessing, conditioned while_faithful — apostasy makes it fizzle,
          // and the chronicle will say the mercy left their hands. Execution-side roster
          // read (this is the build system); each grant is graced/validated inside
          // grantEventAbility.
          try {
            if (site.god) {
              for (const m of this.sim.agents) {
                if (!m.alive || m.controlled || m.faction !== 'townsfolk' || m.townId !== site.town) continue;
                if (m.faith !== site.god || !m.progression || !m.progression.grantEventAbility) continue;
                m.progression.grantEventAbility({
                  seam: 'faith:shrine', t: (ctx && ctx.time) || 0, archetype: 'defensive',
                  register: 'holy', tags: ['HEAL'], god: site.god,
                  requires: [{ kind: 'while_faithful', god: site.god }],
                  originText: `given at the raising of the shrine of ${site.god}`,
                });
              }
            }
          } catch { /* grants are best-effort flavour */ }
        } else if (owner) {
          // a PRIVATE custom-built home names its builder; a VACANT developer unit (no owner yet)
          // is narrated by the block-level "broke ground on a row of N homes" beat, not per hut.
          this.sim.chronicle.note('build', site.ownerId,
            `${owner.name} raised ${hn} in ${townName}.`);
        }
      }
    } catch { /* chronicle is best-effort flavour */ }
    try {
      if (owner && owner.memory) {
        owner.memory.record({ t: (ctx && ctx.time) || 0, kind: 'closure', withId: owner.id, valence: 1, salience: 0.6 });
      }
    } catch { /* memory is best-effort flavour */ }

    // procedural mesh (browser only) — never blocks the logical building.
    if (typeof document !== 'undefined') this._attachMesh(building);

    this.stats.completed++;
    if (building.buildKind === BUILD_KIND.TAVERN) this.stats.taverns++;
    else if (building.buildKind === BUILD_KIND.GRANARY) this.stats.granaries++;
    else if (building.buildKind === BUILD_KIND.GUILDHALL) this.stats.halls++;
    else if (building.buildKind === BUILD_KIND.SHRINE) this.stats.shrines++;
    else this.stats.homes++;

    // PLACES-AS-STATIC-GEOGRAPHY (Phase 2a): register a finished PUBLIC work as a shared,
    // STATIC mental-map Place (position only, never `sheltered`) so the belief-backed paths
    // can reach it — the tavern via map.nearest(['shelter','rest']) (comfort), the granary
    // via map.nearest(['larder']) (the destitute's draw trip); the hall advertises gather/
    // social, NOT shelter/rest (see MAP.affordances). HOMES are deliberately NOT added to
    // the shared map (a razed home must not poison shared geography — the owner reaches his
    // home through his OWN belief, homeBeliefId). Guarded; never throws.
    try {
      if (isPublicKind(building.buildKind) && this.sim.map && typeof this.sim.map.add === 'function') {
        const pk = building.buildKind;
        const fallback = pk === BUILD_KIND.GRANARY ? ['larder']
          : pk === BUILD_KIND.GUILDHALL ? ['crowd', 'social']
          : pk === BUILD_KIND.SHRINE ? ['safe', 'sanctify'] : ['shelter', 'rest'];
        this.sim.map.add(new Place(building.id, pk, building.pos,
          (MAP_AFF[pk] || fallback), building.town));
      }
    } catch { /* the shared map is best-effort static geography */ }
  }

  // ---- mesh (browser-only, fully guarded) -----------------------------------
  // Lazily import the parametric generator on first browser finalize (so the mesh
  // module never enters the headless graph), then attach this building's geometry.
  // If the import hasn't resolved yet, queue the building and flush when it does.
  _attachMesh(building: Building): void {
    try {
      if (_gen) { this._build1(building); return; }
      this._pending.push(building);
      // kick the import once; subsequent finalizes just queue until it resolves.
      import('../world/buildingGen.js')
        .then((m) => { _gen = m.generateBuilding; this._flushPending(); })
        .catch(() => { /* degrade to no mesh — the logical building still works */ });
    } catch { /* visuals are best-effort */ }
  }

  _flushPending(): void {
    if (!_gen) return;
    const q = this._pending; this._pending = [];
    for (const b of q) this._build1(b);
  }

  // generate + place one building's mesh (browser only; deterministic per seed).
  _build1(building: Building): void {
    try {
      if (!_gen) { this._pending.push(building); return; }
      const rng = mulberry32(building.seed);
      const group = _gen(rng, {
        kind: building.buildKind,   // the mesh generator keys on the BUILD type (home/tavern)
        wealth: building.wealth,
        footprint: building.footprint,
        storeys: building.storeys,
        palette: building.palette,
        seed: building.seed,
      });
      if (!group) return;
      // lift onto the terrain surface like World._add (browser-only path anyway).
      let y = 0; try { y = terrainHeight(building.pos.x, building.pos.z); } catch { /* keep 0 */ }
      group.position.set(building.pos.x, y, building.pos.z);
      group.rotation.y = building.yaw || 0;
      this.sim.scene.add(group);
      building.mesh = group;
    } catch { /* never let a bad mesh break the sim */ }
  }

  // ---- teardown -------------------------------------------------------------
  _abandon(site: BuildSite, i: number): void {
    try {
      if (site.ownerId != null) {
        const owner = this.sim.agentsById.get(site.ownerId);
        if (owner && owner._buildSiteId === site.id) owner._buildSiteId = null;
      }
    } catch { /* */ }
    // RELEASE the claimed tiles so the abandoned plot frees up for the town to rebuild.
    try { if (this.sim.cities && site.plotTiles) this.sim.cities.release(site.town, site.plotTiles); } catch { /* */ }
    this._sites.splice(i, 1);
  }

  // RUIN a finished building that has been gutted: remove it from the roster, DESPAWN its
  // percept (no more place to perceive), free its grid tiles (rebuild demand returns), and
  // drop its mesh (browser). Debt #1 retired: the world no longer writes owner.home — a HOME
  // owner whose home is gutted-and-despawned discovers the loss either by sight (a torched-
  // but-standing home is the common case; this full-ruin path leaves no percept) OR via
  // BELIEF DECAY (his stale home-belief is never re-confirmed, so confidence falls below the
  // act-on threshold and the comfort path stops trusting it — see decide.nearestComfortSource).
  // The TRUTH-SIDE displacement record (filed on shelter loss in _raidPass) drives the town
  // rebuild backstop. Closed-money-loop safe — releasing tiles destroys wood parts, not gold.
  _ruin(b: Building): void {
    try {
      const i = this._buildings.indexOf(b);
      if (i >= 0) this._buildings.splice(i, 1);
      // mark it down + despawn the percept so no agent perceives a ghost-home at the rubble.
      b.alive = false; b.sheltered = false;
      try { if (this.sim.despawnPercept) this.sim.despawnPercept(b); } catch { /* */ }
      if (b.buildKind === BUILD_KIND.HOME && b.ownerId != null) this._recordDisplaced(b);
      try { if (this.sim.cities && b.plotTiles) this.sim.cities.release(b.town, b.plotTiles); } catch { /* */ }
      if (typeof document !== 'undefined' && b.mesh) { try { this.sim.scene.remove(b.mesh); } catch { /* */ } }
    } catch { /* never throw on the tick */ }
  }

  // TRUTH-SIDE displacement record (the demand backstop): note that a home owner has been
  // displaced. Deduped per owner. Reads ground truth only (no cognition write). The grace
  // drain in tick() decides if the town must rebuild on the owner's behalf.
  _recordDisplaced(b: Building): void {
    try {
      if (!b || b.ownerId == null) return;
      if (this._displaced.some((d) => d.ownerId === b.ownerId)) return;
      this._displaced.push({ ownerId: b.ownerId, town: b.town, plotPos: b.pos.clone(), at: this.sim.time || 0 });
    } catch { /* */ }
  }

  // Drain the displacement queue (TRUTH-SIDE demand backstop). For each displaced owner: if
  // the town now holds a sheltered building carrying his ownerId he has re-housed → clear the
  // record. Else, once the grace window elapses, the TOWN re-commissions a rebuild on his
  // behalf (town-funded labour, like the tavern — mints no gold) and clears the record. This
  // keeps housing stock from permanently decaying when an owner never returns to discover his
  // ruin, WITHOUT the world writing the owner's cognition. Reads ground truth only. Guarded.
  _drainDisplaced(ctx: Ctx): void {
    if (!this._displaced.length) return;
    const grace = BUILD.rebuildGraceTicks || 120;
    for (let i = this._displaced.length - 1; i >= 0; i--) {
      const d = this._displaced[i];
      // re-housed already? (truth: a sheltered home with his ownerId exists, or a site is up)
      const housed = this._buildings.some((b) => b.buildKind === BUILD_KIND.HOME && b.ownerId === d.ownerId && b.sheltered !== false);
      const building = this._sites.some((s) => s.kind === BUILD_KIND.HOME && s.ownerId === d.ownerId);
      if (housed || building) { this._displaced.splice(i, 1); continue; }
      if ((ctx.time - d.at) < grace) continue;                 // still within grace; wait
      // grace elapsed and the owner never re-housed → the town rebuilds on his behalf.
      const town = this._townOf(d.town);
      const owner = this.sim.agentsById ? this.sim.agentsById.get(d.ownerId) : null;
      if (town && this._activeHomesIn(town.id) < BUILD.maxConcurrentPerTown) {
        const site = this._townFundedHome(town, owner, ctx);
        if (site) this._displaced.splice(i, 1);               // committed; record discharged
      }
    }
  }

  // Town-funded rebuild of a displaced owner's home: a HOME site with the owner's id but no
  // personal labour required — it rises via the same ambient town-labour path the tavern uses
  // (_townLabour). Mints no gold (wood+labour abstraction). Returns the site or null.
  // THE RESIDENTIAL DEVELOPER (config DEVELOP) — the town raises housing in CHUNKS, as
  // infrastructure, instead of leaving every soul to grind its own hut. When the town carries
  // unhoused demand and the grid has room, break ground on a ROW of homes at once on the public
  // town-funded path (_townFundedHome → _townLabour, wood+labour, gold-neutral). Each unit is
  // assigned to a specific unhoused townsperson, who then DISCOVERS it by sight (homeBeliefId),
  // exactly as the displacement backstop's owner discovers his town-rebuilt home — so the
  // epistemic split holds (perception still binds the home; the developer only SUPPLIES it).
  // Truth-side (an omniscient town authority reads who lacks a roof, like the Surveyor reads
  // pop) — it supplies/narrates, never drives an agent's cognition. Called from Surveyor.tick.
  // Guarded; never throws on the fixed tick (the freeze lesson).
  developHousing(town: { id: unknown }, ctx: Ctx): void {
    try {
      if (!DEVELOP.enabled || !town || !this.sim.cities) return;
      // the in-flight block: town-funded home sites already standing in this town.
      let active = 0;
      for (const s of this._sites) if (s.kind === BUILD_KIND.HOME && s.town === town.id && s.townFunded) active++;
      const cap = DEVELOP.maxActiveSites || 24;
      if (active >= cap) return;
      // DEMAND (truth-side, mirrors _drainDisplaced): townsfolk of this town with no sheltered home
      // of their own AND no home site already serving them (private OR a prior developer unit) — so
      // the developer never double-houses anyone.
      const unhoused: Agent[] = [];
      for (const a of this.sim.agents) {
        if (!a.alive || a.controlled || a.faction !== 'townsfolk' || a.townId !== town.id) continue;
        if (this._buildings.some((b) => b.buildKind === BUILD_KIND.HOME && b.ownerId === a.id && b.sheltered !== false)) continue;
        if (this._sites.some((s) => s.kind === BUILD_KIND.HOME && s.ownerId === a.id)) continue;
        unhoused.push(a);
      }
      // SUPPLY already in the pipe: finished VACANT homes waiting to be moved into, plus the
      // in-flight block. Build only the DEFICIT (unhoused minus stock) so vacant stock doesn't
      // pile up faster than agents claim it — the town builds to demand, not endlessly.
      let vacant = 0;
      for (const b of this._buildings) if (b.buildKind === BUILD_KIND.HOME && b.ownerId == null && b.sheltered !== false) vacant++;
      const deficit = unhoused.length - vacant - active;
      if (deficit < (DEVELOP.minUnhoused || 3)) return;
      // break ground on a CHUNK this round — bounded by the block size, the remaining site cap,
      // and the deficit. Homes are raised VACANT (ownerId null); an unhoused soul moves into the
      // nearest one it comes upon (_claimVacantHomes). claimPlot null (grid full) stops the row.
      const want = Math.min(DEVELOP.blockSize || 10, cap - active, deficit);
      let raised = 0;
      for (let k = 0; k < want; k++) {
        const site = this._townFundedHome(town as BuildSite, null, ctx);   // vacant: no owner yet
        if (!site) break;                                  // grid full — stop the row here
        raised++;
      }
      if (raised > 0 && this.sim.chronicle) {
        try {
          this.sim.chronicle.note('build', null,
            `${this._townName(town.id)} broke ground on ${raised === 1 ? 'a new home' : `a row of ${raised} new homes`}.`);
        } catch { /* chronicle is best-effort flavour */ }
      }
    } catch { /* never throw on the fixed tick (freeze lesson) */ }
  }

  // MOVE-IN — an unhoused townsperson who comes within sight of a VACANT developer home takes it
  // as their own. This is the truth-side ownership assignment (a world allocation, like the raid /
  // displacement passes); the agent then DISCOVERS the home through its OWN perception, which binds
  // homeBeliefId by sight — so cognition still owns the belief and the epistemic split holds. Any
  // vacant home works (not one pre-assigned plot), which is what makes discovery robust: an agent
  // criss-crossing town to work/market/comfort passes some empty house and simply moves in. A
  // finished home claimed here is no longer counted as vacant supply. Guarded; never throws.
  _claimVacantHomes(): void {
    try {
      if (!DEVELOP.enabled) return;
      const r2 = (DEVELOP.moveInRange || 22) ** 2;
      for (const b of this._buildings) {
        if (b.buildKind !== BUILD_KIND.HOME || b.ownerId != null || b.sheltered === false) continue;  // vacant homes only
        // the nearest still-unhoused townsperson of this town within sight of the empty house moves in.
        let claimant: Agent | null = null, bestD = r2;
        for (const a of this.sim.agents) {
          if (!a.alive || a.controlled || a.faction !== 'townsfolk' || a.townId !== b.town) continue;
          if (a.homeBeliefId != null) continue;                          // already believes itself housed
          if (this._buildings.some((x) => x.buildKind === BUILD_KIND.HOME && x.ownerId === a.id)) continue;  // already owns one (truth)
          const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z;
          const d = dx * dx + dz * dz;
          if (d < bestD) { bestD = d; claimant = a; }
        }
        if (claimant) b.ownerId = claimant.id;   // truth move-in; perception binds homeBeliefId next tick (sight)
      }
    } catch { /* never throw on the fixed tick */ }
  }

  _townFundedHome(town: BuildSite, owner: Agent | null, ctx: Ctx): BuildSite | null {
    try {
      if (!this.sim.cities) return null;
      const seed = (rng() * 1e9) | 0;
      const p = this._paramsFor(BUILD_KIND.HOME, 1, seed, this.sim.cities.homesTight(town.id));
      const tp = p.tiles;
      const plot = this.sim.cities.claimPlot(town.id, tp.w, tp.d, tp.levels, ZONE.HOMES, tp.cellars || 0);
      if (!plot) return null;
      const site = this._makeSite({
        kind: BUILD_KIND.HOME, ownerId: owner ? owner.id : null, town: town.id, plot, params: p,
        woodNeeded: BUILD.woodNeeded, benefit: BUILD.homeBenefit, ctx,
      });
      site.townFunded = true;   // _townLabour raises it without the owner hauling materials
      this._sites.push(site);
      this.stats.commissioned++;
      return site;
    } catch { return null; }
  }

  // a town's display name (reuse _townOf) for chronicle beats. Guarded.
  _townName(townId: unknown): string {
    try { const tw = this._townOf(townId); return (tw && tw.name) || 'the town'; }
    catch { return 'the town'; }
  }

  dispose() {
    if (typeof document !== 'undefined') {
      for (const b of this._buildings) {
        if (b.mesh) { try { this.sim.scene.remove(b.mesh); } catch { /* */ } }
      }
    }
    this._sites = [];
    this._buildings = [];
    this._pending = [];
    this._displaced = [];
  }
}

// THREE is referenced via the records' Vector3.clone()s; keep the import explicit
// for parity with the sibling subsystems (defenses.js / walls.js).
void THREE;
