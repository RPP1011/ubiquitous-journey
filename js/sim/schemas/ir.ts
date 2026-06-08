// The InteractionSchema IR — the data-only shape the reasoning interpreter evaluates,
// the social analogue of the ability AbilitySpec (js/rpg/abilities/ir.js) and the trope
// engine. A schema is a fully-serializable DATA ROW: a `when` predicate tree over the
// agent's OWN beliefs + own state + mental map (never truth), an optional `infer` that
// writes a cached higher-order belief, and a `respond` that adopts a goal/disposition.
//
// This file is DATA + a trust boundary only — it executes nothing. `validate(s)` rejects
// a row that names an unknown predicate/inference/response op so a malformed authored row
// degrades to inert (the interpreter skips it) rather than throwing on the tick (the
// freeze lesson). It is PURE — no sim/agent/belief reads — so it is not in the epistemic
// scan; the evaluators that DO read beliefs live in vocab.js (which IS scanned).
//
// A predicate / inference / response NODE is `{ op, args }` produced by the vocab.js
// builders. The interpreter (interpreter.js) dispatches on node.op against the evaluator
// maps. Authors never write nodes by hand — they call the builders — but the IR is the
// contract those builders and the interpreter agree on.

// The op-name vocabularies — the closed set of legal node ops. The interpreter holds the
// implementations; this file holds only the NAMES, so validate() can reject typos without
// importing the (belief-reading) evaluators. Keep these in sync with vocab.js.
import type {
  PredNode, AuthoredSchema, NormalizedSchema,
} from '../../../types/sim.js';

export const PRED_OPS = new Set<string>([
  'all', 'any', 'not',
  'believe', 'witnessed', 'selfNeed', 'selfIs', 'outmatchedBy',
  'nearKnown', 'nearSubject', 'perceivedNow', 'selfEngaged', 'observedAnimacy',
]);
export const INFER_OPS = new Set<string>([
  'setIntent', 'inferDestination', 'raise', 'raiseThenSet',
]);
export const RESP_OPS = new Set<string>([
  'goal', 'intercept', 'fleeTo', 'shadow', 'avoid', 'hide',
]);

// the subjects a schema reasons about: my own situation, or a believed other.
export const SUBJECTS = new Set<string>(['self', 'believed']);

// scheduler defaults + bounds for the bounded/cached/LOD interpreter.
export const LIMITS = {
  priorityDefault: 0.5,
  ttlDefault: 4,
  costDefault: 1,
};

// schema(o) — normalize an authored row into a complete InteractionSchema, filling the
// scheduler defaults. Pure; never throws. Returns the row (with defaults applied).
export function schema(o: AuthoredSchema | null | undefined): NormalizedSchema | null {
  if (!o || typeof o !== 'object') return null;
  return {
    id: o.id || '(anon)',
    // keep the AUTHORED subject verbatim — validate() is the trust boundary that rejects an
    // unknown one (we don't silently coerce a typo'd subject to 'self', which would let a
    // malformed row slip past the gate).
    subject: o.subject,
    when: o.when || null,                 // a predicate Node (or null = always-true)
    infer: o.infer || null,               // an inference Node (or null)
    respond: o.respond || null,           // a response Node (or null = no-op)
    priority: typeof o.priority === 'number' ? o.priority : LIMITS.priorityDefault,
    ttl: typeof o.ttl === 'number' ? o.ttl : LIMITS.ttlDefault,
    cost: typeof o.cost === 'number' ? o.cost : LIMITS.costDefault,
  };
}

// validate(s) — the trust boundary. Recursively walks the when/infer/respond node trees
// and returns false if any node names an op outside the legal vocabularies. A bad row is
// dropped by the catalogue (ACTIVE = SCHEMAS.filter(validate)) so it never reaches the
// interpreter. Pure; guarded; never throws.
export function validate(s: NormalizedSchema | null): s is NormalizedSchema {
  try {
    if (!s || !SUBJECTS.has(s.subject)) return false;
    if (s.when && !validatePred(s.when)) return false;
    if (s.infer && !INFER_OPS.has(s.infer.op)) return false;
    if (s.respond && !RESP_OPS.has(s.respond.op)) return false;
    return true;
  } catch { return false; }
}

// recursive predicate-tree validation: all/any take a list of child nodes, not takes one.
function validatePred(node: PredNode | null | undefined): boolean {
  if (!node || typeof node.op !== 'string') return false;
  if (!PRED_OPS.has(node.op)) return false;
  if (node.op === 'all' || node.op === 'any') {
    const kids = node.args && node.args[0];
    if (!Array.isArray(kids)) return false;
    for (const k of kids) if (!validatePred(k)) return false;
    return true;
  }
  if (node.op === 'not') {
    return validatePred((node.args && node.args[0]) as PredNode | null | undefined);
  }
  return true;   // a leaf predicate (believe/selfNeed/…): args are scalars, op-name vetted above
}
