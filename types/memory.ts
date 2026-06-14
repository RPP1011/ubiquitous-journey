// Episodic (autobiographical) memory: three consolidating ring buffers of salient
// episodes (js/sim/memory.js) — distinct from the BeliefStore (semantic memory ABOUT
// others). Goal-derivation (grief/gratitude/revenge) and the biography read it.

import type { EntityId } from './core.js';

/** The kind of a remembered episode (memoryPhrase switches on these). */
export type EpisodeKind =
  | 'triumph' | 'bloodshed' | 'assaulted' | 'witnessed_death' | 'witnessed_aggression' | 'survived'
  | 'windfall' | 'milestone' | 'bond' | 'succoured' | 'relic' | 'closure'
  | 'ruined' | 'thwarted' | 'slandered'   // status-sensor episodes (docs/architecture/12 §5)
  | (string & {});   // open: other salient kinds may be recorded

/** One episode — plain data, bounded by ring overwrite. */
export interface Episode {
  t: number;
  kind: EpisodeKind;
  withId?: EntityId;        // the other party (subject of the episode)
  byId?: EntityId;          // the culprit (e.g. the killer in a witnessed_death)
  place?: string;
  valence: number;          // -1..1
  salience: number;         // 0..1 "how notable"
  label?: string;           // e.g. a milestone class name
  _mt?: number;             // consolidation bookkeeping (STM→MTM)
  _lt?: number;             // consolidation bookkeeping (MTM→LTM)
  [k: string]: unknown;
}

/** A fixed-capacity circular buffer (js/sim/memory.js Ring). items() yields newest-first. */
export interface Ring<T> {
  cap: number;
  buf: T[];
  head: number;
  readonly size: number;
  push(item: T): T | null;   // returns whatever it evicted (or null)
  items(): T[];              // newest → oldest
}

/** The three-tier episodic store (js/sim/memory.js Memory). */
export interface Memory {
  stm: Ring<Episode>;        // short-term
  mtm: Ring<Episode>;        // medium-term
  ltm: Ring<Episode>;        // long-term

  record(ep: Episode): void;
  tick(dt: number, now: number): void;
  salient(k?: number): Episode[];   // the formative few, strongest first
  recent(k?: number): Episode[];
}
