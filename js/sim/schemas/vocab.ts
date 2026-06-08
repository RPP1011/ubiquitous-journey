// The shared reasoning vocabulary — the reuse lever. Two layers over one IR:
//
//   · BUILDERS (author-time): tiny pure functions that return IR `{ op, args }` Nodes.
//     The catalogue rows are written by calling these (never hand-rolled nodes), so a
//     typo'd op is impossible at author time and `validate()` (ir.js) is the backstop.
//   · EVALUATORS (interpret-time): the implementation behind each op-name. The
//     interpreter dispatches `PRED_EVAL[node.op]` / `INFER_EVAL` / `RESP_EVAL`, passing
//     an `env` of the agent's OWN world-model: { agent, beliefs, memory, map, ctx, now }.
//
// EPISTEMIC POSTURE (this file IS in the static scan, test/suites/epistemic.mjs): every
// evaluator reads ONLY the agent's own state (`agent.*`), its own BeliefStore (resolved
// to a handle named `b`), its episodic memory, and the shared STATIC mental map — never
// a live roster, never a foreign true-state field. `resolveSubj` returns an ID STRING
// (never a dereferenced object), and the belief handle is named `b` and the id `id` —
// neither is in the foreign-deref identifier set — so the scan cannot fire. `'self'`
// resolves to `agent.faction` (the identifier `agent` is safe). Every evaluator is
// guarded and returns a benign default on any anomaly; the interpreter never throws.

import { inferDestination } from '../beliefs.js';
import { SIM, SCHEMA, factionHostile } from '../simconfig.js';
import type {
  EntityId, Comparator, SubjectRef, PredNode, InferNode, RespNode,
  ReasonEnv, GoalDescriptor, Episode,
} from '../../../types/sim.js';

// the three evaluator signatures the interpreter dispatches against.
type PredEvalFn = (node: PredNode, env: ReasonEnv) => boolean;
type InferEvalFn = (node: InferNode, env: ReasonEnv) => void;
type RespEvalFn = (node: RespNode, env: ReasonEnv) => GoalDescriptor | null;

// ---------------------------------------------------------------------------------------
// BUILDERS — author-time. Each returns a serializable IR Node { op, args }.
// ---------------------------------------------------------------------------------------

// predicate combinators
export const all = (...kids: PredNode[]): PredNode => ({ op: 'all', args: [kids] });
export const any = (...kids: PredNode[]): PredNode => ({ op: 'any', args: [kids] });
export const not = (x: PredNode): PredNode => ({ op: 'not', args: [x] });

// leaf predicates
export const believe = (ref: SubjectRef, field: string, cmp: Comparator, val: unknown): PredNode =>
  ({ op: 'believe', args: [ref, field, cmp, val] });
export const witnessed = (ref: SubjectRef, deedTag: string): PredNode => ({ op: 'witnessed', args: [ref, deedTag] });
export const selfNeed = (need: string, cmp: Comparator, val: number): PredNode => ({ op: 'selfNeed', args: [need, cmp, val] });
export const selfIs = (tag: string): PredNode => ({ op: 'selfIs', args: [tag] });
export const outmatchedBy = (ref: SubjectRef): PredNode => ({ op: 'outmatchedBy', args: [ref] });
export const nearKnown = (affords: string, range: number): PredNode => ({ op: 'nearKnown', args: [affords, range] });
// nearSubject(ref, range): is the bound believed subject's BELIEVED position (belief lastPos)
// within `range` of me? A real proximity gate over my own belief + own pos (no roster scan) —
// the form schema #5 (flee-the-brawl) needs (nearKnown('me',…) is a degenerate always-true).
export const nearSubject = (ref: SubjectRef, range: number): PredNode => ({ op: 'nearSubject', args: [ref, range] });
export const perceivedNow = (ref: SubjectRef): PredNode => ({ op: 'perceivedNow', args: [ref] });
export const selfEngaged = (ref: SubjectRef, strikes: number): PredNode => ({ op: 'selfEngaged', args: [ref, strikes] });
export const observedAnimacy = (ref: SubjectRef): PredNode => ({ op: 'observedAnimacy', args: [ref] });

// inference ops (write a cached higher-order belief field, TTL'd by the interpreter)
export const setIntent = (kind: string): InferNode => ({ op: 'setIntent', args: [kind] });
export const inferDest = (strategy: string): InferNode => ({ op: 'inferDestination', args: [strategy] });
export const raise = (field: string, amount: number): InferNode => ({ op: 'raise', args: [field, amount] });
// raise `field` by `amount`, then once it crosses `thresh` apply each revision in
// `sets` (an array of [field, value] pairs) to the belief — e.g. schema #6 accrues
// inertEvidence and, above threshold, sets BOTH hostile:false AND inert:true (the
// latter overrides the faction prior in considerHostile, the real disengage trigger).
export const raiseThenSet = (field: string, amount: number, thresh: number, sets: Array<[string, unknown]>): InferNode =>
  ({ op: 'raiseThenSet', args: [field, amount, thresh, sets] });

// response ops (adopt a goal / disposition the motivation+planner already execute)
export const goal = (kind: string, args?: Record<string, unknown>): RespNode => ({ op: 'goal', args: [kind, args || {}] });
export const intercept = (ref: SubjectRef): RespNode => ({ op: 'intercept', args: [ref] });
export const fleeTo = (affords: string[]): RespNode => ({ op: 'fleeTo', args: [affords] });
export const shadow = (ref: SubjectRef): RespNode => ({ op: 'shadow', args: [ref] });
export const avoid = (ref: SubjectRef, affords: string[]): RespNode => ({ op: 'avoid', args: [ref, affords] });
export const hide = (affords: string[]): RespNode => ({ op: 'hide', args: [affords] });

// ---------------------------------------------------------------------------------------
// SUBJECT BINDING — a schema's `subject:'believed'` ranges over the agent's beliefs; the
// interpreter binds one belief per evaluation as env.subjectId. A ref string '@x'/'@q'/…
// is a placeholder for THAT bound subject; the literal 'self' means the agent itself.
// resolveSubj returns an ID STRING (never an object) — scan-clean by construction.
// ---------------------------------------------------------------------------------------
function resolveSubj(ref: unknown, env: ReasonEnv): EntityId | null {
  if (ref === 'self') return env.agent.id;
  // any '@'-prefixed placeholder resolves to the currently-bound believed subject.
  if (typeof ref === 'string' && ref[0] === '@') return env.subjectId;
  return (ref ?? null) as EntityId | null;   // a literal id (rare)
}

// numeric comparator dispatch used by believe/selfNeed.
function cmpVal(a: unknown, op: unknown, b: unknown): boolean {
  // relational ops coerce like the original loose JS (`a < b`); equality stays strict.
  const na = a as number, nb = b as number;
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<':  return na < nb;
    case '<=': return na <= nb;
    case '>':  return na > nb;
    case '>=': return na >= nb;
    default:   return false;
  }
}

// ---------------------------------------------------------------------------------------
// PREDICATE EVALUATORS — boolean, over the agent's own world-model. All guarded.
// ---------------------------------------------------------------------------------------
export const PRED_EVAL: Record<string, PredEvalFn> = {
  all(node, env) {
    const kids = (node.args[0] || []) as PredNode[];
    for (const k of kids) if (!evalPred(k, env)) return false;
    return true;
  },
  any(node, env) {
    const kids = (node.args[0] || []) as PredNode[];
    for (const k of kids) if (evalPred(k, env)) return true;
    return false;
  },
  not(node, env) { return !evalPred(node.args[0] as PredNode, env); },

  // believe(ref, field, cmp, val): read a field off MY belief about the resolved subject.
  // 'self' as a val resolves to my own faction (for the disguise schema). Guarded: no
  // belief → false (I can't reason about a subject I hold no belief on).
  believe(node, env) {
    const [ref, field, cmp, val] = node.args;
    const id = resolveSubj(ref, env);
    if (id == null) return false;
    const b = env.beliefs.get(id);
    if (!b) return false;
    let want: unknown = val;
    if (val === 'self') want = env.agent.faction;          // identifier `agent` — scan-safe
    const have = (b as unknown as Record<string, unknown>)[field as string];
    return cmpVal(have, cmp, want);
  },

  // witnessed(ref, deedTag): did my episodic memory record a deed of `deedTag` by the
  // resolved subject? 'HOSTILE_ACT' is an alias for the hostile memory kinds. Belief-free
  // (memory is own-state). Guarded; never throws.
  witnessed(node, env) {
    const [ref, deedTag] = node.args;
    const id = resolveSubj(ref, env);
    if (id == null || !env.memory) return false;
    const kinds = deedTagKinds(deedTag as string);
    try {
      const eps = memEpisodes(env.memory);
      for (const e of eps) {
        if (!e) continue;
        const matchSubject = e.byId === id || e.withId === id;
        if (matchSubject && kinds.has(e.kind)) return true;
      }
    } catch { /* fall through */ }
    return false;
  },

  // selfNeed(need, cmp, val): compare one of MY needs (own-state).
  selfNeed(node, env) {
    const [need, cmp, val] = node.args;
    const needs = env.agent.needs;                          // identifier `agent` — scan-safe
    if (!needs) return false;
    const have = needs[need as string];
    if (typeof have !== 'number') return false;
    return cmpVal(have, cmp, val);
  },

  // selfIs(tag): a coarse self-classification over my own flags. 'combatant' is the one
  // the flagship schemas need (a fighter doesn't flee/hide like a civilian).
  selfIs(node, env) {
    const [tag] = node.args;
    const me = env.agent;                                   // identifier `me` — not banned
    switch (tag) {
      case 'combatant': return !!me.combatant;
      case 'townsfolk': return me.faction === 'townsfolk';
      case 'autonomous': return !!me.autonomous;
      default: return false;
    }
  },

  // outmatchedBy(ref): do I believe the resolved subject can beat me? A coarse threat
  // comparison from MY belief + my own level — never the subject's true stats. Uses the
  // believed faction's danger (monster/bandit read as dangerous) as a proxy when I have
  // no finer model. Guarded.
  outmatchedBy(node, env) {
    const [ref] = node.args;
    const id = resolveSubj(ref, env);
    if (id == null) return false;
    const b = env.beliefs.get(id);
    if (!b) return false;
    const me = env.agent;
    if (me.combatant) return false;                         // I back myself in a fight
    // a believed-hostile of a fighting faction outmatches a civilian me.
    return !!b.hostile || factionHostile(me.faction, b.lastFaction);
  },

  // nearKnown(affords, range): is there a STATIC mental-map place affording any of
  // `affords` within `range` of me? A geography query, NOT a roster scan. The pseudo-
  // affordance 'me' means "near my own position" (a degenerate always-true within range),
  // and 'threat' means "near a believed-hostile's lastPos" (a belief read). Guarded.
  nearKnown(node, env) {
    const [affords, range] = node.args;
    const r = typeof range === 'number' ? range : Infinity;
    if (affords === 'me') return true;                      // I am, trivially, near myself
    if (affords === 'threat') return nearAnyHostile(env, r);
    if (!env.map) return false;
    try {
      const place = env.map.nearest(affords as string | string[], env.agent.pos, env.agent.townId, r);
      return !!place;
    } catch { return false; }
  },

  // nearSubject(ref, range): is the bound believed subject within `range` of me, by MY belief
  // of where it is (belief lastPos)? Confidence-gated (a too-faint belief is not "near" — I
  // don't react to a brawl I'm barely sure happened). Belief + own-pos only; the real proximity
  // gate flee-the-brawl needs. Guarded: no belief / no lastPos → false (not near).
  nearSubject(node, env) {
    const [ref, range] = node.args;
    const r = typeof range === 'number' ? range : Infinity;
    const id = resolveSubj(ref, env);
    if (id == null) return false;
    const b = env.beliefs.get(id);
    if (!b || !b.lastPos) return false;
    if (b.confidence < SIM.actOnBeliefMin) return false;
    const me = env.agent;
    const dx = me.pos.x - b.lastPos.x, dz = me.pos.z - b.lastPos.z;
    return Math.hypot(dx, dz) <= r;
  },

  // perceivedNow(ref): did I SEE the subject this very tick? (belief.lastTick === now,
  // stamped by perception.observe). Used to gate "I've LOST sight of it" (intercept).
  perceivedNow(node, env) {
    const [ref] = node.args;
    const id = resolveSubj(ref, env);
    if (id == null) return false;
    const b = env.beliefs.get(id);
    return !!b && b.lastTick === env.now;
  },

  // selfEngaged(ref, strikes): have I struck the subject at least `strikes` times? Reads
  // MY OWN strikeLog (own-state, written by combatEvents on my landed blows) — counts hits
  // on a PROP too (the scarecrow case), since the log is keyed on the target id, not on a
  // believed agent. Guarded; absent log → 0.
  selfEngaged(node, env) {
    const [ref, strikes] = node.args;
    const id = resolveSubj(ref, env);
    if (id == null) return false;
    const log = env.agent.strikeLog;
    const rec = log && log.get ? log.get(id) : null;
    return !!rec && (rec.count || 0) >= ((strikes as number) || 1);
  },

  // observedAnimacy(ref): have I observed the subject act ALIVE (move/strike/block/harm me)
  // since I started engaging it? Reads the belief's animacy tally (written by perception +
  // combatEvents). A scarecrow never accrues one → false → schema #6 can fire. Guarded.
  observedAnimacy(node, env) {
    const [ref] = node.args;
    const id = resolveSubj(ref, env);
    if (id == null) return false;
    const b = env.beliefs.get(id);
    const t = b && b.animacyTally;
    if (!t) return false;
    return (t.struck || 0) + (t.blocked || 0) + (t.harmedMe || 0) + (t.moved || 0) > 0;
  },
};

// dispatch one predicate node; guarded so a bad node is false, never a throw.
export function evalPred(node: PredNode | null | undefined, env: ReasonEnv): boolean {
  try {
    if (!node || typeof node.op !== 'string') return false;
    const fn = PRED_EVAL[node.op];
    return fn ? !!fn(node, env) : false;
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------
// INFERENCE EVALUATORS — write a cached higher-order belief field (TTL owned by interpreter).
// ---------------------------------------------------------------------------------------
export const INFER_EVAL: Record<string, InferEvalFn> = {
  // setIntent(kind): stamp the resolved subject's belief with an intent. For subject:'self'
  // this is a no-op-ish self-note (the agent's own goal carries the intent); for a believed
  // subject it records 'flee'/'hunt'/… that intercept reads.
  setIntent(node, env) {
    const [kind] = node.args;
    const id = env.subjectId != null ? env.subjectId : env.agent.id;
    const b = env.beliefs.get(id);
    if (b) b.intent = kind as string | null;
  },

  // inferDestination(strategy): the ToM core — infer WHERE the believed quarry is making
  // for (beliefs + static map), caching belief.destPos. Delegates to beliefs.inferDestination.
  inferDestination(node, env) {
    const [strategy] = node.args;
    const id = env.subjectId;
    if (id == null) return;
    const b = env.beliefs.get(id);
    if (!b) return;
    inferDestination(env.agent, b, (strategy as string) || b.intent || 'flee', env.map, env.now);
  },

  // raise(field, amount): bump a scalar field on the bound belief (suspicion/inertEvidence…).
  raise(node, env) {
    const [field, amount] = node.args;
    const id = env.subjectId != null ? env.subjectId : env.agent.id;
    const b = env.beliefs.get(id);
    if (b) {
      const bag = b as unknown as Record<string, number>;
      const f = field as string;
      bag[f] = (bag[f] || 0) + ((amount as number) || 0);
    }
  },

  // raiseThenSet(field, amount, thresh, sets): accrue contradicting evidence on `field`,
  // and once it crosses `thresh` apply every [setField, setVal] revision in `sets` to the
  // belief (schema #6: inertEvidence → hostile:false + inert:true). Guarded.
  raiseThenSet(node, env) {
    const [field, amount, thresh, sets] = node.args;
    const id = env.subjectId != null ? env.subjectId : env.agent.id;
    const b = env.beliefs.get(id);
    if (!b) return;
    const bag = b as unknown as Record<string, unknown>;
    const f = field as string;
    bag[f] = ((bag[f] as number) || 0) + ((amount as number) || 0);
    if ((bag[f] as number) >= (thresh as number) && Array.isArray(sets)) {
      for (const pair of sets) { if (Array.isArray(pair)) bag[pair[0] as string] = pair[1]; }
    }
  },
};

export function evalInfer(node: InferNode | null | undefined, env: ReasonEnv): void {
  try {
    if (!node || typeof node.op !== 'string') return;
    const fn = INFER_EVAL[node.op];
    if (fn) fn(node, env);
  } catch { /* never throw on the tick */ }
}

// ---------------------------------------------------------------------------------------
// RESPONSE EVALUATORS — adopt a goal/disposition. Each returns a GOAL DESCRIPTOR
// { kind, ... } (or null); the interpreter pushes/sets it. They never mutate the agent
// directly so the interpreter owns dwell-locks + expiry. Belief/map reads only.
// ---------------------------------------------------------------------------------------
export const RESP_EVAL: Record<string, RespEvalFn> = {
  goal(node, env) {
    const [kind, extra] = node.args;
    return { kind: kind as string, ...(extra as Record<string, unknown> || {}), subjectId: env.subjectId ?? undefined };
  },
  // intercept(ref): cut the believed quarry off at its inferred destination (a fight goal
  // toward destPos). Reads the belief's destPos/lastPos — no live truth.
  intercept(node, env) {
    const [ref] = node.args;
    const id = resolveSubj(ref, env);
    if (id == null) return null;
    const b = env.beliefs.get(id);
    if (!b) return null;
    const at = b.destPos || b.lastPos;
    return { kind: 'fight', targetId: id, toPos: at ? { x: at.x, z: at.z } : null };
  },
  // fleeTo(affords): break for the nearest static place affording any of `affords`.
  fleeTo(node, env) {
    const [affords] = node.args;
    const at = nearKnownPos(env, affords);
    return { kind: 'flee', toPos: at, srcKind: 'refuge' };
  },
  // shadow(ref): trail a suspected mask at a distance (collapse-fodder — see planner.js).
  shadow(node, env) {
    const [ref] = node.args;
    const id = resolveSubj(ref, env);
    if (id == null) return null;
    return { kind: 'shadow', subjectId: id };
  },
  // avoid(ref, affords): clear a danger zone — repel from the believed brawl, attract to
  // the nearest safe place (collapse-fodder).
  avoid(node, env) {
    const [ref, affords] = node.args;
    const id = resolveSubj(ref, env);
    const b = id != null ? env.beliefs.get(id) : null;
    const around = b && b.lastPos ? { x: b.lastPos.x, z: b.lastPos.z } : null;
    const to = nearKnownPos(env, affords);
    return { kind: 'avoid', around, toPos: to };
  },
  // hide(affords): seek concealment and go still (collapse-fodder).
  hide(node, env) {
    const [affords] = node.args;
    const at = nearKnownPos(env, affords);
    return { kind: 'hide', toPos: at };
  },
};

export function evalRespond(node: RespNode | null | undefined, env: ReasonEnv): GoalDescriptor | null {
  try {
    if (!node || typeof node.op !== 'string') return null;
    const fn = RESP_EVAL[node.op];
    return fn ? fn(node, env) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------
// helpers (all guarded, belief/map/own-state only)
// ---------------------------------------------------------------------------------------

// the world-position of the nearest known place affording any of `affords`, as a plain
// {x,z} (so the goal carries a static-geography point, never a live ref). Null if none.
function nearKnownPos(env: ReasonEnv, affords: unknown): { x: number; z: number } | null {
  if (!env.map) return null;
  try {
    const place = env.map.nearest(affords as string | string[], env.agent.pos, env.agent.townId, Infinity);
    return place && place.pos ? { x: place.pos.x, z: place.pos.z } : null;
  } catch { return null; }
}

// is any believed-hostile within `r` of me? (belief lastPos read; bounded by my ~8 beliefs).
function nearAnyHostile(env: ReasonEnv, r: number): boolean {
  try {
    const me = env.agent;
    for (const b of env.beliefs.all()) {
      if (b.subjectId === me.id) continue;
      if (!(b.hostile || factionHostile(me.faction, b.lastFaction))) continue;
      if (b.confidence < SIM.actOnBeliefMin) continue;
      const dx = me.pos.x - b.lastPos.x, dz = me.pos.z - b.lastPos.z;
      if (Math.hypot(dx, dz) <= r) return true;
    }
  } catch { /* fall through */ }
  return false;
}

// map a deed tag (incl. the 'HOSTILE_ACT' alias) to the episodic memory kinds it covers.
function deedTagKinds(deedTag: string): Set<string> {
  if (deedTag === 'HOSTILE_ACT' || deedTag === 'STRUCK') {
    return new Set(['assaulted', 'witnessed_death', 'survived']);
  }
  return new Set([deedTag]);
}

// flatten an agent's episodic memory rings into one array (guarded; empty on anomaly).
function memEpisodes(memory: ReasonEnv['memory']): Episode[] {
  const out: Episode[] = [];
  try {
    if (memory.stm && memory.stm.items) out.push(...memory.stm.items());
    if (memory.mtm && memory.mtm.items) out.push(...memory.mtm.items());
    if (memory.ltm && memory.ltm.items) out.push(...memory.ltm.items());
  } catch { /* return what we have */ }
  return out;
}

// SCHEMA reserved for evaluators that read its thresholds (e.g. future inert tuning).
export { SCHEMA };
