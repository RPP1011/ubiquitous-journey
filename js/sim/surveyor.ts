// TOWN SURVEYOR — the planning office that turns a town's empty home-band into
// orderly building plots, and commissions the one PUBLIC work a town needs to
// gather: a tavern.
//
// Phase-1 buildings are EMERGENT (no hand-placed lots): a chronically-uncomfortable,
// wealthy townsperson decides — in decide.js, reading only its OWN state — that it
// wants a home. When it commits (act.js), it asks the Surveyor for a plot. The
// Surveyor hands out the NEXT FREE SLOT along one of a few lanes radiating from the
// town core: just past the central plaza, inside the home band, facing the street,
// and non-overlapping with any other plot or world POI. Pure math — no mesh, no
// gold, no ground-truth about agents' minds — so it runs identically in the browser
// and under `bun test/headless.mjs`. The MESH for a finished building belongs to
// construction.js / world/buildingGen.js, never here.
//
// The Surveyor also runs a town-side hand: when a town has grown past a population
// threshold and has no tavern, the official commissions ONE from the town "fund"
// (a labour/wood abstraction, NOT a gold pool — the closed money loop is untouched).
// Townsfolk raise it via their build goal. This closes the loop the whole system is
// for: buildings give the town somewhere to gather.
//
// Sibling of Patrician/Watch/Defenses: constructed in Simulation, ticked on the
// fixed loop (self-throttled), gated on a real spawned town (inert in the bare
// controlled sub-sims that never spawn()), and fully guarded so it never throws or
// stalls the tick (the freeze lesson). All numbers live in SURVEYOR in simconfig.js.

import * as THREE from 'three';
import { SURVEYOR, TOWNS } from './simconfig.js';
import type { FullCtx } from '../../types/sim.js';

// `Simulation` lives in another cluster (still .js) — it crosses this file as `any`
// deliberately (opaque to this port). A town is a sim.towns entry, typed loosely here.
type Sim = any;             // Simulation is out-of-cluster
interface Town { id: number; center: THREE.Vector3; radius?: number; }
interface Cursor { lane: number; ring: number; }

export class Surveyor {
  sim: Sim;
  _acc: number;
  stats: { plots: number; taverns: number; granaries: number };
  _cursors: Map<number, Cursor>;

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this.stats = { plots: 0, taverns: 0, granaries: 0 };
    // per-town lane cursors for next-free-slot bookkeeping. Keyed by town id →
    // { lane, ring }; lazily created the first time a town hands out a plot. The
    // cursor only HINTS where to start scanning — the real reject test is the
    // overlap check against live plots/POIs, so a missed/abandoned slot is reused.
    this._cursors = new Map();
  }

  // PURE-MATH plot allocation. `town` is a sim.towns entry { id, center:Vector3,
  // radius }. Returns { pos:Vector3 (y=0), yaw } facing the core lane, or null if
  // no free slot fits inside the home band (caller treats null as "no room, later").
  allocatePlot(town: Town | null | undefined, footprint: { w: number; d: number }): { pos: THREE.Vector3; yaw: number } | null {
    if (!town || !town.center) return null;
    const center = town.center;
    const lanes = Math.max(1, SURVEYOR.lanes | 0);
    const innerR = SURVEYOR.laneInnerR;
    const step = SURVEYOR.laneStep || 1;
    const plaza = SURVEYOR.plazaR;
    const outerR = Math.min(SURVEYOR.maxPlotR, town.radius ?? SURVEYOR.maxPlotR);
    const clear2 = SURVEYOR.plotClear * SURVEYOR.plotClear;

    // bounded scan: rings from the cursor's ring up to the outer band. We loop the
    // ring index modulo a finite count so a full pass is guaranteed to terminate.
    const cur = this._cursorFor(town.id);
    const maxRing = Math.max(1, Math.ceil((outerR - innerR) / step) + 1);
    const total = maxRing * lanes;

    for (let n = 0; n < total; n++) {
      // advance the cursor lane-first, then ring (fills a ring before stepping out)
      const ring = cur.ring + ((cur.lane + n) / lanes | 0);
      const lane = (cur.lane + n) % lanes;
      const radius = innerR + ring * step;
      if (radius < plaza || radius > outerR) continue;
      // small fixed per-ring stagger so successive rings interleave (no radial
      // canyons): half a lane every other ring.
      const stagger = (ring & 1) ? (Math.PI / lanes) : 0;
      const theta = (lane / lanes) * Math.PI * 2 + stagger;
      const x = center.x + Math.cos(theta) * radius;
      const z = center.z + Math.sin(theta) * radius;

      if (this._collides(x, z, clear2)) continue;

      // accepted: advance the cursor PAST this slot so the next request starts
      // beyond it (next-free-slot), then return the plot. Door faces the core.
      cur.lane = lane + 1;
      cur.ring = ring;
      if (cur.lane >= lanes) { cur.lane = 0; cur.ring = ring + 1; }
      const yaw = Math.atan2(center.z - z, center.x - x);
      this.stats.plots++;
      return { pos: new THREE.Vector3(x, 0, z), yaw };
    }
    return null;
  }

  // reject a candidate that sits too close (x/z, squared) to any existing build
  // plot/building OR any world POI. Ground truth — this is the execution layer.
  _collides(x: number, z: number, clear2: number): boolean {
    const bs = this.sim.buildSites;
    if (bs && bs.plots) {
      const plots = bs.plots();
      for (let i = 0; i < plots.length; i++) {
        const p = plots[i].pos;
        const dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz < clear2) return true;
      }
    }
    const world = this.sim.world;
    if (world && world.pois) {
      const pois = world.pois;
      for (let i = 0; i < pois.length; i++) {
        const p = pois[i].pos;
        const dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz < clear2) return true;
      }
    }
    return false;
  }

  _cursorFor(townId: number): Cursor {
    let c = this._cursors.get(townId);
    if (!c) { c = { lane: 0, ring: 0 }; this._cursors.set(townId, c); }
    return c;
  }

  // commission ONE public tavern for a town once it's grown and has none. The town
  // "fund" is townsfolk labour + wood (handled by BuildSites), NOT gold — so no
  // money is minted or burned. Private; called from tick per town.
  // population gate shared by the public-work commissions: living townsfolk anchored
  // to THIS town (the same count _townLabour folds truth-side in construction.js).
  _townPop(town: Town, ctx: FullCtx): number {
    let pop = 0;
    const agents = ctx.agents || this.sim.agents || [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.alive && !a.controlled && a.faction === 'townsfolk' && a.townId === town.id) pop++;
    }
    return pop;
  }

  _maybeCommissionTavern(town: Town, ctx: FullCtx) {
    if (!SURVEYOR.tavernEnabled) return;
    const bs = this.sim.buildSites;
    if (!bs || !bs.commissionPublic) return;
    if (bs.hasTavern && bs.hasTavern(town.id)) return;   // already built/under way
    if (this._townPop(town, ctx) < SURVEYOR.tavernMinPop) return;   // population gate

    // a tavern is grander: footprint biases buildingGen but the plot only needs a
    // clearance, so a square footprint hint is enough for the overlap test.
    const plot = this.allocatePlot(town, { w: 7, d: 7 });
    if (!plot) return;                                   // no room — try next pass

    bs.commissionPublic(town, 'tavern', plot, ctx);
    this.stats.taverns++;
  }

  // commission ONE public granary for a town once it's grown and has none — the town's
  // larder against famine (stocked by the market tithe, drawn by the destitute). Mirrors
  // the tavern commission exactly: town fund = wood + labour, never gold.
  _maybeCommissionGranary(town: Town, ctx: FullCtx) {
    if (!SURVEYOR.granaryEnabled) return;
    const bs = this.sim.buildSites;
    if (!bs || !bs.commissionPublic) return;
    if (bs.hasGranary && bs.hasGranary(town.id)) return;  // already built/under way
    if (this._townPop(town, ctx) < SURVEYOR.granaryMinPop) return;  // population gate

    // a long low store; like the tavern, the footprint hint only feeds the overlap test.
    const plot = this.allocatePlot(town, { w: 6, d: 5 });
    if (!plot) return;                                    // no room — try next pass

    bs.commissionPublic(town, 'granary', plot, ctx);
    this.stats.granaries++;
  }

  // fixed-tick: survey each town for the public works it lacks (tavern, granary).
  // Self-throttled and fully guarded — never throws or stalls the loop (freeze lesson).
  // Inert until a town is actually spawned (bare controlled sub-sims get nothing).
  tick(ctx: FullCtx, dt: number) {
    try {
      if (!SURVEYOR.enabled || !this.sim._spawned) return;
      this._acc += dt;
      if (this._acc < SURVEYOR.tickEvery) return;
      this._acc = 0;
      const towns = this.sim.towns || [];
      for (let i = 0; i < towns.length; i++) {
        this._maybeCommissionTavern(towns[i], ctx);
        this._maybeCommissionGranary(towns[i], ctx);
      }
    } catch { /* never throw on the tick */ }
  }

  // no meshes, no bus subscription — provided for symmetry with Defenses/Walls so
  // a rebuilt world tears down cleanly. (TOWNS is imported only to keep the lane
  // geometry's origin in one place if a future pass reads it directly.)
  dispose() { this._cursors && this._cursors.clear(); }
}

// keep the config-origin reference live (mirrors walls.js reading TOWNS.centers).
void TOWNS;
