// The motivation layer (docs/architecture/17) — a "verb" factored into a (primitive, motivation)
// pair: the public observable act vs the private short-term impetus behind it. THIS FILE owns the IR
// types; the registry (js/sim/motivation/registry.ts) holds the rows and the arbiter
// (js/sim/motivation/arbitrate.ts) scores them. PURE TYPES — no runtime code.
//
// Two halves, split exactly along the epistemic boundary (docs/architecture/17 §2):
//  · ACTOR half (cognition: beliefs + own-state ONLY) — eligible/score/bind: how a motive is SELECTED.
//  · OBSERVER half (belief: the witness's OWN memory/beliefs ONLY) — prior/reads/consequence: how a
//    witnessed primitive is INFERRED back to a motive (§7).
// The observer half is OPTIONAL on the type because the build is phased: the P1 scorer-rehost rows
// implement only the actor half; inference (P4) fills prior/reads/consequence.

import type { EntityId } from './core.js';
import type { Agent } from './agent.js';
import type { CognitionCtx, FullCtx } from './ctx.js';

/** The params a motive's bind produces — spread onto the committed goal/motive (loose, like Goal extras). */
export type MotiveBind = Record<string, unknown>;

/** Which layer a motive ultimately serves (annotation for the inspector/recursive-ToM, NOT read by
 *  arbitration). 'reflex' = a pure need/danger impetus with no goal above it (flee/eat). */
export type MotiveServes = 'goal' | 'need' | 'ambition' | 'reflex';

/** The OBSERVABLE envelope a primitive emits — ground truth, but only what perception can carry (§4/§6). */
export interface Deed {
  actorId: EntityId;
  primitive: string;             // 'strike' | 'say' | 'take' | …  (the PUBLIC act)
  targetId?: EntityId;
  surfaceTag?: string;           // the signature.tag the actor PRESENTED (may be a lie — §7.4)
  sceneCues: SceneCues;          // co-incident, co-perceived scene facts, FROZEN at emit (§4a)
  magnitude: number;             // 0..1 how weighty the act is — the puzzle/salience gate (§7.2a)
  t: number;
}

/** The public signature a motivation presents when its primitive is witnessed (§4). */
export interface Signature {
  tag: string;                   // surface social-trace it APPEARS as ('robbery','counsel',…)
  likelihood(obs: Deed, cues: Cues): number;   // P(this observed primitive + cues | this motive), 0..1
}

/** The posterior an observer forms over the candidate motives for a witnessed primitive (§7.1). */
export interface MotivePosterior {
  best: string;                  // argmax motive key (or 'unknown')
  conf: number;                  // posterior mass on `best` (LOW when ambiguous)
  dist: Record<string, number>;  // normalized
}

/** A cue's scope (§4a). scene = frozen on the deed; observer = a per-witness QUERY at inference. */
export type CueScope = 'scene' | 'observer';
export interface CueSpec {
  key: string;
  scope: CueScope;
  kind: 'bool' | 'scalar';       // scalar ∈ [0,1]
  read: (who: Agent, deed: Deed, ctx: FullCtx) => number;   // bool → 0|1
}
export type SceneCues = Record<string, number>;   // frozen on the deed
export type Cues = Record<string, number>;          // deed.sceneCues ∪ the observer-cue query results

/** One short-term impetus. Selects a primitive (actor half) AND defines how it reads (observer half). */
export interface Motivation {
  key: string;                   // 'avenge','defend','slander','warn','work','eat',…  (unique)
  primitive: string;             // executor key it drives: 'strike','say','take','locomote',…
  serves: MotiveServes;

  // ── ACTOR HALF (cognition: beliefs + own-state ONLY) ───────────────────────────────────────────
  eligible(a: Agent, ctx: CognitionCtx): boolean;    // gate (character × circumstance)
  score(a: Agent, ctx: CognitionCtx): number;        // impetus strength this tick (>0 to compete)
  bind(a: Agent, ctx: CognitionCtx): MotiveBind;     // params for the primitive / committed-goal extras
  goalRef?(a: Agent): EntityId | string | null;      // the goal/need it serves (inspector + recursive ToM)

  // ── OBSERVER HALF (belief: the witness's OWN memory/beliefs ONLY) — OPTIONAL until P4 (§7) ──────
  prior?(observer: Agent, actorId: EntityId, deed: Deed, ctx: FullCtx): number;
  reads?: Signature;
  consequence?(observer: Agent, actorId: EntityId, conf: number, ctx: FullCtx): void;
  basePrior?: number;            // stranger fallback when no confident belief exists
}
