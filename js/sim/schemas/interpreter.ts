// The reasoning interpreter — `reason(agent, ctx, catalogue)`. Runs once per agent per
// cognition tick, BETWEEN gossip and decide, over the RESTRICTED cognition ctx (beliefs +
// own state + static mental map; never the roster). For each schema whose `when` holds it
// applies the `infer` (writes a cached belief field) and `respond` (adopts a goal), under
// a priority order + per-(schema,subject) TTL cache so a fired schema doesn't re-fire every
// tick. Bounded: O(#schemas × #beliefs) — the belief table is ~8, so this is a few dozen
// cheap evals per agent. The whole pass is wrapped in try/catch — it NEVER throws on the
// tick (the freeze lesson); a malformed row or a belief pointing at a non-agent percept
// just makes that evaluation false/no-op.
//
// EPISTEMIC POSTURE (this file IS in the static scan): it reads only `agent.*`, the agent's
// own BeliefStore (snapshotted once into a local array, eviction-safe), and `ctx.time`/
// `ctx.map`. It holds no roster handle. The env handed to vocab.js carries the same.

import { SCHEMA } from '../simconfig.js';
import { evalPred, evalInfer, evalRespond } from './vocab.js';
import { STAGE, REASON } from '../trace.js';
import type {
  Agent, CognitionCtx, NormalizedSchema, ReasonEnv, GoalDescriptor, Stage, Reason,
} from '../../../types/sim.js';

// the per-tick claim flag the direct-goal responses contend over.
interface TickState { directClaimed: boolean; }
// the agent's TTL fire-stamp cache (a private detail not on the shared Agent surface).
type ReasonAgent = Agent & {
  _schemaFired?: Record<string, number>;
  _schemaFireCount?: number;
};

// Direct-goal responses (set agent.goal AND stamp a min-dwell lock so decide honours them
// across a one-tick belief flicker). The flagship disposition kinds (hide/shadow/avoid) are
// ALSO direct: a plan-less goal pushed onto the bounded 4-deep stack would (a) never become
// the active a.goal — decide only promotes plan-BEARING stack goals via the 'plan' candidate,
// so its act.js case was unreachable dead code — and (b) evict a real motivation (avenge/grieve)
// from the bottom of the stack while sitting inert for its whole ttl. Setting a.goal + a dwell-
// lock directly (like flee/fight) makes them actually EXECUTE and keeps them OFF the motivation
// stack entirely. They self-terminate: when the situation passes the schema stops firing, the
// lock expires, and decide picks a normal goal next tick. (Phase 2b: these collapse into the
// one steer-fill executor — see act.js dispositions + planner.js goal{Hide,Shadow,Avoid}.)
const DIRECT_GOAL_KINDS = new Set<string>(['flee', 'fight', 'hide', 'shadow', 'avoid']);

export function reason(agent: Agent, ctx: CognitionCtx | null, catalogue: NormalizedSchema[]): void {
  // master gate (byte-stable proof) + empty-catalogue fast-path: nothing executes.
  if (!SCHEMA || !SCHEMA.enabled) return;
  if (!agent || !agent.alive || agent.controlled) return;
  if (!Array.isArray(catalogue) || catalogue.length === 0) return;
  try {
    const ag = agent as ReasonAgent;
    const now = ctx ? ctx.time : 0;
    // snapshot my beliefs ONCE — an infer may mutate a belief field, and a believed-
    // subject loop must not trip on concurrent eviction. Bounded (~8 entries).
    const beliefSnapshot = [...agent.beliefs.all()];
    const envBase: ReasonEnv = {
      agent,
      beliefs: agent.beliefs,
      memory: agent.memory,
      map: ctx ? ctx.map : null,
      ctx,
      now,
      subjectId: null,
    };
    if (!ag._schemaFired) ag._schemaFired = Object.create(null);
    let fired = 0;
    // schemas are evaluated in priority order; the FIRST direct-goal response to fire claims
    // a.goal for the tick. This flag stops a later, lower-priority direct goal from clobbering
    // it (applyRespond reads/sets it). Infer-only and disposition state-writes still run.
    const tickState: TickState = { directClaimed: false };

    // priority-sorted: a high-priority disposition (flee/hide) is considered before a
    // low one (suspect). Stable enough — catalogue is tiny. Don't mutate the catalogue.
    const ordered = catalogue.length > 1
      ? [...catalogue].sort((p, q) => (q.priority || 0) - (p.priority || 0))
      : catalogue;

    for (const s of ordered) {
      if (!s) continue;
      if (s.subject === 'self') {
        envBase.subjectId = null;
        if (fireOne(s, envBase, now, tickState)) fired++;
      } else {
        // subject:'believed' — bind each belief in turn (bounded loop over the snapshot).
        for (const b of beliefSnapshot) {
          if (!b || b.subjectId === agent.id) continue;
          envBase.subjectId = b.subjectId;
          if (fireOne(s, envBase, now, tickState)) { fired++; break; }   // one firing per schema/tick
        }
      }
    }
    ag._schemaFireCount = fired;
  } catch { /* never throw on the tick */ }
}

// evaluate one schema against the bound env; returns whether it fired (passed `when`,
// not TTL-suppressed). Applies infer + respond on a fire.
function fireOne(s: NormalizedSchema, env: ReasonEnv, now: number, tickState: TickState): boolean {
  const ag = env.agent as ReasonAgent;
  const fired = ag._schemaFired || (ag._schemaFired = Object.create(null));
  // TTL CACHE: skip a schema/subject pair re-fired within its ttl seconds.
  const key = `${s.id}|${env.subjectId ?? '*'}`;
  const stamp = fired[key];
  if (stamp != null && (now - stamp) < (s.ttl || 0)) return false;

  if (s.when && !evalPred(s.when, env)) return false;

  // PASSED — record the fire stamp (suppresses re-firing for ttl), then act.
  fired[key] = now;
  // TRACE (write-only, never read back): a schema FIRED — the "why I reasoned this" beat.
  // Only actual fires are logged (bounded; a `when`-false on every other schema/tick would
  // flood the ring). `a` = schema id, subject = the believed subject it fired about. Own data.
  env.agent.trace.note(STAGE.SCHEMA as Stage, REASON.SCHEMA_FIRED as Reason, { t: now, a: s.id, subjectId: env.subjectId });
  if (s.infer) evalInfer(s.infer, env);
  if (s.respond) applyRespond(s, env, now, tickState);
  return true;
}

// adopt the response goal. Direct-goal kinds (flee/fight/hide/shadow/avoid) win the tick by
// setting agent.goal AND stamping a dwell-lock decide honours. The FIRST (highest-priority)
// direct goal of the tick claims a.goal; a later, lower-priority one is suppressed (so a
// hide@.95 isn't clobbered by a shadow@.5 firing afterwards). Anything not a direct kind is
// pushed onto the goal stack with an expiry (none of the flagship rows take this branch today).
function applyRespond(s: NormalizedSchema, env: ReasonEnv, now: number, tickState: TickState): void {
  const g: GoalDescriptor | null = evalRespond(s.respond, env);
  if (!g || !g.kind) return;
  const a = env.agent;
  const ttl = s.ttl || 0;
  if (DIRECT_GOAL_KINDS.has(g.kind)) {
    if (tickState && tickState.directClaimed) return;   // a higher-priority direct goal already won
    a.goal = g;
    if (tickState) tickState.directClaimed = true;
    // SHORT anti-thrash dwell for ALL direct goals (flee/fight AND dispositions). The dwell
    // only debounces the GOAL CHOICE across a one-tick belief flicker — it must stay short so it
    // never blocks decide's goal-stack maintenance (deriveGoals/pruneGoals/predicate-pop) for
    // long (a long lock once stalled the avenge-goal pop after the kill). A disposition persists
    // by RE-FIRING: reason() runs every tick and the TTL cache lets the schema re-claim the goal
    // once its ttl lapses while `when` still holds — so the response recurs without a long lock.
    const dwell = (SCHEMA.goalDwellTicks || 0) / 6;   // ticks → seconds (tickHz=6)
    a._schemaGoalLock = { kind: g.kind, until: now + dwell };
  } else {
    // non-direct response (no flagship row uses this today): a plan-less goal aged off by
    // expiresAt. Kept for catalogue rows that want a passive, stack-borne disposition.
    g.atoms = [];
    g.expiresAt = now + ttl;
    if (a.pushGoal) a.pushGoal(g, env.ctx);
  }
}
