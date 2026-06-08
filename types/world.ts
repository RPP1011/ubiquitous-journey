// The static-geography half of the world-model: POIs (js/sim/world.js) and the shared
// read-only mental map of Places queried by affordance (js/sim/mentalmap.js).

import type { Vector3 } from 'three';
import type { Vec2Like } from './core.js';

/** A resource POI / site in the open world (js/sim/world.js World.pois entry). */
export interface Poi {
  kind: string;                 // POI_KIND.* ('field'|'forest'|'mine'|'market'|…)
  pos: Vector3;
  region: string | null;
  mesh?: unknown;               // a THREE.Group in the browser, undefined headless
}

/** The static world (POIs/biomes). A THREE.Scene-backed registry of resource sites. */
export interface World {
  scene?: unknown;              // THREE.Scene in the browser; opaque to the sim
  pois: Poi[];
  market?: Poi;                 // town 0's market (the legacy singleton)
  landmarkMeshes?: unknown[];   // browser-visual landmark meshes

  nearest(kind: string, pos: Vector3): Poi | null;
  randomSite(kind: string): Poi | null;
  randomSiteNear(kind: string, maxR: number, center?: Vec2Like): Poi | null;
  randomSiteInRegion(kind: string, region: string | null): Poi | null;
  update(dt: number): void;
  dispose(): void;
}

/** A spawned town (TOWNS in simconfig; each agent has a townAnchor). */
export interface Town {
  id: number;
  center: Vector3;
}

/** A PLACE — an immutable snapshot of one static location (js/sim/mentalmap.js Place). */
export interface Place {
  id: string;
  kind: string;
  pos: Vector3;                 // a CLONED vector (never a live mesh ref)
  name: string;
  townId: number | null;        // null = a world-wide landmark (known to all)

  // OR-semantics: does this place afford ANY of the queried tags?
  affords(...tags: string[]): boolean;
}

/** The shared static places registry (js/sim/mentalmap.js MentalMap). */
export interface MentalMap {
  places: Place[];

  add(place: Place): void;
  // the ~`cap` places an agent in `townId` knows, nearest `near` first.
  known(townId: number | null | undefined, near: Vec2Like | null, cap?: number): Place[];
  // nearest known place affording any of `affords` within `range` of `fromPos`.
  nearest(affords: string | string[], fromPos: Vec2Like, townId: number | null | undefined, range?: number): Place | null;
  // unit direction from `fromPos` toward `dest`, written into `out`.
  dirTo(fromPos: Vec2Like, dest: Place | null, out?: Vector3): Vector3;
  cost(fromPos: Vec2Like, dest: Place | null): number;
}
