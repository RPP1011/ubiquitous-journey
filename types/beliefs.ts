// The Theory-of-Mind belief layer (js/sim/beliefs.js): the N² per-(observer→subject)
// table. A BeliefState is a multi-concern bag (person-belief + place-belief). Decisions
// read beliefs only — never ground truth — which is what makes deception work.

import type { Vector3 } from 'three';
import type { EntityId } from './core.js';

/** One observed-action liveness tally on a belief (lazy; null until the subject acts alive). */
export interface AnimacyTally {
  struck: number;
  blocked: number;
  harmedMe: number;
  moved: number;
}

/** One observer→subject belief row (the spec's per-(observer,subject) cell). */
export interface BeliefState {
  subjectId: EntityId;
  lastFaction: string | null;       // believed faction (a disguise can fake this)
  lastPos: Vector3;                 // NON-NULL: always constructed (the mental-map anchor)
  heading: Vector3;                 // last-seen unit direction of motion (observed)
  destId: string | null;            // believed destination key (a Place.id) or null
  destPos: Vector3 | null;          // resolved world pos of that destination (static) or null
  intent: string | null;            // 'flee'|'raid'|'home'|… — why it's headed there
  destInferredAt: number;           // sim-time the dest was inferred (TTL cache)
  notoriety: number;                // believed player fame (fear gate)
  lastTick: number;
  confidence: number;               // 0..1, decays over time
  hostile: boolean;                 // do I think this subject is hostile to me?
  suspicion: number;                // 0..1, "something's off about them"
  standing: number;                 // -1..1, my opinion (reputation)
  knownDeeds: unknown[];            // recent deeds I've witnessed/heard (loose by design)
  source: string;                   // provenance tag (SOURCE.*.tag)
  hops: number;                     // provenance depth (0 = first-hand)
  rumorBorn: boolean;               // hostility curdled from gossip, not witnessed
  animacyTally: AnimacyTally | null;
  placeKind: string | null;         // 'building'|'home'|'tavern' — null for a person-belief
  sheltered: boolean | null;        // believed shelter state of a place-belief
  inertEvidence: number;            // higher-order reasoning scalar (schema #6)
  inert: boolean;                   // revised "proven harmless" (overrides hostile + faction prior)

  // record one piece of liveness evidence ('struck'|'blocked'|'harmedMe'|'moved'). Guarded.
  recordAnimacy(kind: 'struck' | 'blocked' | 'harmedMe' | 'moved'): void;
}

/** Options accepted by BeliefStore.plant (deception). */
export interface PlantOpts {
  faction?: string | null;
  pos?: Vector3;
  tick?: number;
  hostile?: boolean;
  suspicion?: number;
  confidence?: number;
}

/** The N² per-observer belief table (js/sim/beliefs.js BeliefStore). There is NO `set`. */
export interface BeliefStore {
  observerId: EntityId;
  map: Map<EntityId, BeliefState>;

  get(subjectId: EntityId): BeliefState | null;   // returns NULL, not undefined
  all(): IterableIterator<BeliefState>;
  observe(subjectId: EntityId, faction: string | null, pos: Vector3, tick: number, hostile: boolean): BeliefState;
  mergeFrom(other: BeliefState, src: unknown): void;   // src is a SOURCE.* descriptor
  plant(subjectId: EntityId, opts: PlantOpts): BeliefState;
  erase(subjectId: EntityId): void;
  decay(dt: number): void;
}
