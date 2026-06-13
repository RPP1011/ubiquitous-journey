// The Theory-of-Mind belief layer (js/sim/beliefs.js): the N² per-(observer→subject)
// table. A BeliefState is a multi-concern bag (person-belief + place-belief). Decisions
// read beliefs only — never ground truth — which is what makes deception work.

import type { Vector3 } from 'three';
import type { EntityId, Vec2Like } from './core.js';

/** One observed-action liveness tally on a belief (lazy; null until the subject acts alive). */
export interface AnimacyTally {
  struck: number;
  blocked: number;
  harmedMe: number;
  moved: number;
}

/** A consolidated subject↔place ASSOCIATION (e.g. assoc(mark,'stash')=P) — built from
 *  repeated surveil sightings (the urchin's `shadow`) or supplied first by gossip. The
 *  epistemic-gather precondition `know_assoc` reads `!!belief.assoc`. null = none held. */
export interface AssocBelief {
  placeKind: string;        // role tag for the associated place: 'stash' | …
  pos: Vec2Like;            // believed location of that place (own-belief, not ground truth)
  conf: number;            // 0..1 confidence P
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
  placeKind: string | null;         // 'building'|'home'|'tavern'|'shrine'|'granary'|'guildhall' — null for a person-belief
  sheltered: boolean | null;        // believed shelter state of a place-belief
  placeGod: string | null;          // whose shrine I believe this is (perceived surface field)
  benefitFelt: number | null;       // comfort quality EXPERIENCED here (0..1; act.ts stamps while resting)
  captive: boolean;                 // believed-held: perception sets it from a seen _held subject (CAPTIVE → free deriver)
  inertEvidence: number;            // higher-order reasoning scalar (schema #6)
  inert: boolean;                   // revised "proven harmless" (overrides hostile + faction prior)
  assoc: AssocBelief | null;        // subject↔place association (the urchin's stash belief); null = none
  assocSightings: number;           // raw surveil-sighting accumulator (pre-consolidation)
  believedWealth: number;           // believed prosperity of the subject, 0..1 (docs/architecture/12 §6)
  wealthConf: number;               // how sure (firmed by first-hand cues, faded by decay)
  // docs/architecture/17 §7.2a: the LAST SALIENT motive this observer attributed to the subject (the
  // ToM inference output) + how sure. Sparse — written ONLY when a confident read of a notable act
  // lands (most cells never carry one); the deception layer fools exactly this. Optional/decaying.
  believedMotive?: string;
  motiveConf?: number;
  believedKindness?: number;        // a slow character estimate (0..1), like believedWealth (§4a)

  // record one piece of liveness evidence ('struck'|'blocked'|'harmedMe'|'moved'). Guarded.
  recordAnimacy(kind: 'struck' | 'blocked' | 'harmedMe' | 'moved'): void;
  // nudge the believed-wealth estimate toward `implies` (0..1) by `weight` — a perceived
  // prosperity cue (a fat trade, fine gear, an owned home). Belief, never ground truth. Guarded.
  recordWealthCue(implies: number, weight: number): void;
  // accumulate one surveil sighting of the subject near a `placeKind`; after `minSightings`
  // confirmations it CONSOLIDATES into `assoc` (conf grows by `gainConf`/sighting). Guarded.
  recordAssocSighting(placeKind: string, pos: Vec2Like, gainConf: number, minSightings: number): void;
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
  mergePlaceFrom(other: BeliefState | null | undefined, src: unknown): void;   // place-shaped hearsay (buildings)
  plant(subjectId: EntityId, opts: PlantOpts): BeliefState;
  erase(subjectId: EntityId): void;
  decay(dt: number): void;
}
