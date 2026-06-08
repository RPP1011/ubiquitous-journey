// The reasoning layer (js/sim/schemas/{ir,vocab,interpreter}.js): the data-only
// InteractionSchema IR the interpreter evaluates over the agent's OWN world-model.
// A node is `{ op, args }`; the builders produce them, the interpreter dispatches on op.

import type { EntityId } from './core.js';
import type { Agent } from './agent.js';
import type { BeliefStore } from './beliefs.js';
import type { Memory } from './memory.js';
import type { MentalMap } from './world.js';
import type { CognitionCtx } from './ctx.js';
import type { Goal } from './goals.js';

/** Numeric comparator (vocab.js cmpVal). */
export type Comparator = '==' | '!=' | '<' | '<=' | '>' | '>=';

/** A schema's subject scope: my own situation, or a believed other (ir.js SUBJECTS). */
export type Subject = 'self' | 'believed';

/** A ref in a node's args: 'self', an '@'-prefixed placeholder for the bound subject, or a literal id. */
export type SubjectRef = 'self' | `@${string}` | EntityId;

/** A predicate node (op-name vetted against PRED_OPS; args are scalars or child nodes). */
export interface PredNode {
  op: 'all' | 'any' | 'not' | 'believe' | 'witnessed' | 'selfNeed' | 'selfIs'
    | 'outmatchedBy' | 'nearKnown' | 'nearSubject' | 'perceivedNow' | 'selfEngaged'
    | 'observedAnimacy';
  args: unknown[];   // leaf scalars, or [PredNode[]] for all/any, or [PredNode] for not
}

/** An inference node (op-name vetted against INFER_OPS). */
export interface InferNode {
  op: 'setIntent' | 'inferDestination' | 'raise' | 'raiseThenSet';
  args: unknown[];
}

/** A response node (op-name vetted against RESP_OPS). */
export interface RespNode {
  op: 'goal' | 'intercept' | 'fleeTo' | 'shadow' | 'avoid' | 'hide';
  args: unknown[];
}

/** An authored schema row (before schema() fills scheduler defaults). */
export interface AuthoredSchema {
  id?: string;
  subject: Subject;
  when?: PredNode | null;
  infer?: InferNode | null;
  respond?: RespNode | null;
  priority?: number;
  ttl?: number;
  cost?: number;
}

/** A normalized schema row (schema() applied: id + defaults present). */
export interface NormalizedSchema {
  id: string;
  subject: Subject;
  when: PredNode | null;
  infer: InferNode | null;
  respond: RespNode | null;
  priority: number;
  ttl: number;
  cost: number;
}

/** The env the interpreter hands each evaluator — the agent's OWN world-model only. */
export interface ReasonEnv {
  agent: Agent;
  beliefs: BeliefStore;
  memory: Memory;
  map: MentalMap | null;
  ctx: CognitionCtx | null;
  now: number;
  subjectId: EntityId | null;   // the bound believed subject (null for subject:'self')
}

/** A goal descriptor a response evaluator returns (a Goal with extra response fields). */
export interface GoalDescriptor extends Goal {
  // RESP_EVAL outputs carry the same loose extra fields a Goal already permits.
  [k: string]: unknown;
}
