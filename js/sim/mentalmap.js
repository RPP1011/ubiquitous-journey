// The MENTAL MAP — an agent's known PLACES, the static-geography half of the
// world-model (the other half is its BeliefStore of subjects). A handful of
// read-only, SHARED, STATIC entries — town gates (walls), POIs (world), landmarks
// (arena) — queried by AFFORDANCE ('exit'/'conceal'/'safe'/'crowd'/'resource'),
// NEVER by scanning the roster. It holds no live entity position: a believed
// home/hideout is a BELIEF field, never a shared Place (a razed home must not
// poison shared geography). This is what `inferDestination` reasons over to guess
// WHERE a lost quarry is making for, with no omniscient read.
//
// EPISTEMIC POSTURE (this file is in the static scan, test/suites/epistemic.mjs):
// it is built from PLAIN static args — `build(world, towns)` — and never names
// `sim.*`. It dereferences ONLY static geography fields (.kind/.pos/.x/.z/.name) —
// never a true-state field (.alive/.faction/.inventory/.gold/...) — and no local is
// named from the foreign-deref identifier set (the dest param is `dest`, not `to`).
// So the scan cannot fire on it. Every query is guarded; it never throws on the tick.

import * as THREE from 'three';
import { LANDMARKS } from '../arena.js';
import { TOWNS, MAP } from './simconfig.js';

const _tmp = new THREE.Vector3();

// A PLACE — an immutable snapshot of one static location. `pos` is a CLONED vector
// (never a live mesh/_wp reference — those must not leak into the shared map).
export class Place {
  constructor(id, kind, pos, affords /* string[] */, townId = null) {
    this.id = id;
    this.kind = kind;
    this.pos = pos.clone ? pos.clone() : new THREE.Vector3(pos.x || 0, 0, pos.z || 0);
    this.pos.y = 0;                       // y is cosmetic; reason on the ground plane
    this.name = id;
    this.townId = townId;                 // null = a world-wide landmark (known to all)
    this._affordSet = new Set(affords || []);
  }
  // OR-semantics, matching the spec's affords('exit','conceal'): does this place
  // afford ANY of the queried tags?
  affords(...tags) { for (const t of tags) if (this._affordSet.has(t)) return true; return false; }
}

export class MentalMap {
  constructor() {
    this.places = [];
    this._byTown = new Map();             // townId -> Place[] (town-scoped gates/centre/POIs)
    this._world = [];                     // townId===null places (landmarks), known to everyone
  }

  // Build ONCE from a snapshot of static geography. PLAIN ARGS (never `sim`): world is
  // a World (its .pois), towns is the spawned town list (or undefined for bare sub-sims).
  static build(world, towns) {
    const m = new MentalMap();
    try { m._addLandmarks(); } catch { /* keep going */ }
    try { m._addTowns(towns); } catch { /* keep going */ }
    try { m._addPOIs(world, towns); } catch { /* keep going */ }
    return m;
  }

  add(place) {
    if (!place) return;
    this.places.push(place);
    if (place.townId == null) { this._world.push(place); return; }
    let arr = this._byTown.get(place.townId);
    if (!arr) { arr = []; this._byTown.set(place.townId, arr); }
    arr.push(place);
  }

  // arena LANDMARKS — world-wide (townId:null), so a harness agent with no townId
  // still knows them (e.g. The Thorngate, the inferable flight destination).
  _addLandmarks() {
    if (!LANDMARKS) return;
    for (const L of LANDMARKS) {
      const affords = (MAP.affordances && MAP.affordances[L.kind]) || [];
      this.add(new Place(`L:${L.name}`, L.kind, new THREE.Vector3(L.x, 0, L.z), affords, null));
    }
  }

  // town GATES (computed from TOWNS.wall, mirroring walls.js GATES math) + town CENTRES.
  // Guarded: no spawned towns, or no wall config, simply adds nothing.
  _addTowns(towns) {
    if (!towns || !towns.length) return;
    const wall = (TOWNS && TOWNS.wall) || {};
    const R = wall.radius || 0;
    const gates = wall.gates || 0;
    for (const town of towns) {
      if (!town || !town.center) continue;
      const cx = town.center.x, cz = town.center.z, t = town.id;
      this.add(new Place(`T:${t}:centre`, 'town', new THREE.Vector3(cx, 0, cz),
        (MAP.affordances && MAP.affordances.town) || [], t));
      if (R > 0 && gates > 0) {
        const aff = (MAP.affordances && MAP.affordances.gate) || [];
        for (let g = 0; g < gates; g++) {
          const ga = (g / gates) * Math.PI * 2;
          const gx = cx + Math.cos(ga) * R, gz = cz + Math.sin(ga) * R;
          this.add(new Place(`T:${t}:gate${g}`, 'gate', new THREE.Vector3(gx, 0, gz), aff, t));
        }
      }
    }
  }

  // resource POIs — snapshot at build time (positions vary per rebuild; the array is
  // live, so we clone each pos). Assign a townId by nearest town centre. We admit the
  // market plus a few nearest resource POIs per town; `known()` slices to the cap anyway.
  _addPOIs(world, towns) {
    const pois = world && world.pois;
    if (!pois || !pois.length) return;
    const centres = (towns && towns.length)
      ? towns.map((t) => ({ id: t.id, c: t.center }))
      : null;
    let n = 0;
    for (const poi of pois) {
      if (!poi || !poi.pos) continue;
      const kind = poi.kind;
      const affords = (MAP.affordances && MAP.affordances[kind]) || [];
      // nearest town centre owns this POI (null when no spawned towns -> world-wide).
      let townId = null;
      if (centres) {
        let bd = Infinity;
        for (const e of centres) {
          const d = _tmp.copy(poi.pos).sub(e.c).lengthSq();
          if (d < bd) { bd = d; townId = e.id; }
        }
      }
      this.add(new Place(`P:${n++}:${kind}`, kind, poi.pos, affords, townId));
    }
  }

  // The per-agent VIEW: the ~`cap` places an agent in `townId` knows, nearest `near`
  // first. World-wide landmarks are ALWAYS included; a town's gates/centre/POIs are
  // added when townId is known. Robust to townId == null/undefined (the harness/Stage
  // case): returns landmarks only — never `Map.get(undefined)`. Never throws.
  known(townId, near, cap) {
    try {
      const out = this._world.slice();              // landmarks: known to all
      if (townId != null) {
        const arr = this._byTown.get(townId);
        if (arr) for (const p of arr) out.push(p);
      }
      if (near) {
        out.sort((p, q) =>
          _d2(p.pos, near) - _d2(q.pos, near));
      }
      const lim = cap ?? MAP.knownPlaces;
      return out.length > lim ? out.slice(0, lim) : out;
    } catch { return []; }
  }

  // DORMANT forward-hook for Phase 2's nearKnown(): the nearest known place that
  // affords any of `affords` within `range` of `fromPos`. Consumed by nothing in
  // Phase 1 (exists so it cannot be mistaken for a leak vector). Never throws.
  nearest(affords, fromPos, townId, range = Infinity) {
    try {
      const tags = Array.isArray(affords) ? affords : [affords];
      let best = null, bd = range * range;
      for (const p of this.known(townId, fromPos, this.places.length)) {
        if (!p.affords(...tags)) continue;
        const d = _d2(p.pos, fromPos);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    } catch { return null; }
  }

  // Unit direction from `fromPos` toward a destination place `dest`, written into `out`
  // (static math; a null dest yields the zero vector). `dest`, not `to` (scan-clean).
  dirTo(fromPos, dest, out) {
    const o = out || new THREE.Vector3();
    try {
      if (!fromPos || !dest) return o.set(0, 0, 0);
      const dx = dest.pos.x - fromPos.x, dz = dest.pos.z - fromPos.z;
      const dl = Math.hypot(dx, dz);
      if (dl < 1e-6) return o.set(0, 0, 0);
      return o.set(dx / dl, 0, dz / dl);
    } catch { return o.set(0, 0, 0); }
  }

  // Raw Euclidean cost from `fromPos` to destination place `dest` (memoized terrain
  // cost is a Phase-2 upgrade). A null dest costs Infinity. Never throws.
  cost(fromPos, dest) {
    try {
      if (!fromPos || !dest) return Infinity;
      return Math.hypot(dest.pos.x - fromPos.x, dest.pos.z - fromPos.z);
    } catch { return Infinity; }
  }
}

// squared ground-plane distance between a Place pos and a query point (both static / belief).
function _d2(p, q) {
  const dx = p.x - q.x, dz = p.z - q.z;
  return dx * dx + dz * dz;
}
