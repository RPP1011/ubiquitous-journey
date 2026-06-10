// Longer-term motivations ("ambitions"): a persistent drive each NPC carries
// that tilts its per-tick utility choice toward a preferred action, so agents
// live visible arcs instead of only servicing immediate needs (eat/rest/trade).
//
// Design: ambitions are DATA-ONLY and bias the EXISTING decide() candidates
// (work / fight / socialize / wander / …) rather than introducing new act()
// behaviours. That keeps the fixed-tick loop's surface tiny and safe (the
// "freeze lesson"): there is no new movement/combat code an ambition can throw
// inside. Ambitions read the agent's OWN state + counters (epistemic split — no
// omniscient world truth). Progress is measured from lightweight per-agent
// counters (agent.life) plus the gold/level the agent genuinely holds.

import { MOTIVE, SIM } from './simconfig.js';
import { RPG } from '../rpg/rpgconfig.js';
import { goalAvenge, goalSeekFortune, goalRepay, goalGrieve, goalDelve } from './planner.js';
import { arcKey } from './arcs.js';
import { runDerivers, runPlanOutcome } from './exec/registry.js';
import { STAGE, REASON } from './trace.js';
import type { Agent, CognitionCtx, Goal, Personality, AmbitionSnapshot, EntityId, Stage, Reason } from '../../types/sim.js';

// STAGE/REASON are runtime constants in the (still-JS) trace.js, so allowJs widens their
// members to `string`; Trace.note wants the narrow Stage/Reason literal unions. These
// re-narrow at the boundary (the values ARE valid literals) — one cast, not per-call.
const ST = STAGE as Record<string, Stage>;
const RS = REASON as Record<string, Reason>;

// The revenge branch is a documented-INERT legacy path (revenge re-homed to the goal
// stack), but `amb.subjectId` is still read in it — a field the shared Ambition type
// (live ambitions never set revenge) lacks. Widen locally for that dead read only.
type RevengeAmbition = { subjectId?: EntityId } & NonNullable<Agent['ambition']>;

// TRACE (write-only, never read back): a goal genuinely landed on the stack. pushGoal
// DEDUPS — it returns the EXISTING goal on a repeat — so we log only a FRESH push (the
// returned object IS the one we built). Own-state; guarded; never throws on the tick.
function traceDerived(a: Agent, ctx: CognitionCtx | null, built: Goal | null, pushed: Goal | null): void {
  // pushGoal DEDUPS — on a repeat it returns the EXISTING goal, not `built` — so a
  // mismatch means "already on the stack, not a fresh derive". note() is internally
  // guarded (never throws); an Agent always carries `.trace`.
  if (!built || pushed !== built) return;
  a.trace.note(ST.GOAL, RS.GOAL_DERIVED, {
    t: ctx ? ctx.time : 0, subjectId: built.subjectId ?? null, a: built.kind || null,
  });
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lvl = (a: Agent) => (a.progression ? a.progression.totalLevel || 0 : 0);

// BELIEF-BASED liveness: do I still hold a confident-enough belief that `subjectId`
// exists? A subject I've lost all track of (belief gone / faded below the act threshold)
// reads as "believed gone". This replaces every omniscient `o.alive` read in the goal
// layer — the epistemic split: I act on what I BELIEVE, and the combat bridge's `_slain`
// signal handles the case where I truly killed someone out of my own sight.
function beliefAlive(a: Agent | null, subjectId: EntityId): boolean {
  if (!a || !a.beliefs) return false;
  const b = a.beliefs.get(subjectId);
  return !!(b && b.confidence >= SIM.actOnBeliefMin);
}

// Ambition catalogue. `favors` multiplies the score of matching decide() action
// kinds (1 = neutral). `weight(P)` is the assignment propensity from personality.
// `progress(a)` returns 0..1 toward fulfilment; cumulative kinds read a baseline
// snapshot captured at assignment in `a.ambition.base`.
/** One archetypal ambition's definition (data-only; favors + weight + progress). */
interface AmbitionDef {
  label: string;
  favors: Record<string, number>;
  weight: (P: Personality) => number;
  progress: (a: Agent) => number;
}

export const AMBITIONS: Record<string, AmbitionDef> = {
  wealth: {
    label: 'amass wealth', favors: { work: 1.7, socialize: 0.7 },
    weight: (P) => 0.25 + P.ambition,
    progress: (a) => clamp01(a.gold / MOTIVE.wealthTarget),
  },
  mastery: {
    label: 'master a craft', favors: { work: 1.6, rest: 1.1 },
    weight: (P) => 0.2 + 0.6 * P.ambition + 0.4 * P.curiosity,
    progress: (a) => clamp01(lvl(a) / MOTIVE.masteryLevel),
  },
  renown: {
    label: 'win renown', favors: { fight: 1.9, flee: 0.5, wander: 1.2 },
    weight: (P) => 0.1 + P.risk_tolerance,
    progress: (a) => clamp01((a.life.monsterKills - (a.ambition ? a.ambition.base.mkills : 0)) / MOTIVE.renownKills),
  },
  wanderlust: {
    label: 'see the world', favors: { wander: 2.6, work: 0.7 },
    weight: (P) => 0.15 + P.curiosity,
    progress: (a) => clamp01((a.life.dist - (a.ambition ? a.ambition.base.dist : 0)) / MOTIVE.wanderDist),
  },
  belonging: {
    label: 'belong', favors: { socialize: 2.0, wander: 0.9 },
    weight: (P) => 0.15 + P.social_drive,
    progress: (a) => clamp01((a.life.social - (a.ambition ? a.ambition.base.social : 0)) / MOTIVE.socialAmount),
  },
};

// Revenge USED to be a dynamic ambition override; it is now re-homed to the goal
// stack (an `avenge` goal from the `assaulted` memory). `ambition.revenge` is thus
// never set true any more, so the favors map + the `amb.revenge` branches below are
// inert — kept only so the slow-ambition layer reads cleanly if revenge ever
// returns as an ambition. Aggression now flows through hasAggressiveGoal.
const REVENGE_FAVORS: Record<string, number> = { fight: 2.2, flee: 0.4, work: 0.6, wander: 0.7 };

const MONSTER_POOL = ['renown', 'wanderlust'];          // ambitions that mean something for a monster
const TOWN_POOL = ['wealth', 'mastery', 'renown', 'wanderlust', 'belonging'];

function snapshot(a: Agent): Record<string, number> {
  return { mkills: a.life.monsterKills, dist: a.life.dist, social: a.life.social, gold: a.gold, level: lvl(a) };
}

// Pick an ambition kind weighted by personality from the agent's eligible pool.
// `avoid` lets a just-completed ambition not immediately repeat.
export function assignAmbition(a: Agent, now = 0, avoid: string | null = null): void {
  if (!a || a.controlled || !a.life) return;
  const pool = (a.faction === 'monster' ? MONSTER_POOL : TOWN_POOL).filter((k) => k !== avoid);
  const P = a.personality || {};
  const ws = pool.map((k) => Math.max(0.01, AMBITIONS[k].weight(P)));
  const total = ws.reduce((s, w) => s + w, 0);
  let r = Math.random() * total, kind = pool[0];
  for (let i = 0; i < pool.length; i++) { r -= ws[i]; if (r <= 0) { kind = pool[i]; break; } }
  a.ambition = { kind, label: AMBITIONS[kind].label, base: snapshot(a), progress: 0, t0: now, revenge: false };
}

// REVENGE RE-HOMED (Phase 3): being attacked no longer mutates the agent's
// ambition. The `assaulted` episodic memory is now the single source of revenge —
// deriveGoals (below) reads it and pushes an `avenge` GOAL onto the goal stack.
// The ambition layer (slow archetypal bias) and the goal stack (memory-derived
// intentions) stay separate layers. `ambitionWantsFight` generalises to "has an
// aggressive goal on the stack" so the vengeful still stand and fight.

// Per-tick: advance progress, resolve revenge, and complete + reroll when met.
export function updateAmbition(a: Agent, ctx: CognitionCtx): void {
  const amb = a.ambition;
  if (!amb) { assignAmbition(a, ctx.time); return; }
  const now = ctx.time;
  if (amb.revenge) {
    // BELIEF/BRIDGE-BASED "believed dead": the wrongdoer is satisfied-dead when a combat
    // bridge stamped it on my `_slain` set (a sanctioned onCombatEvents write) OR I hold
    // no confident belief about it any more (I've lost all track of it). No roster read.
    const subjectId = (amb as RevengeAmbition).subjectId as EntityId;   // inert legacy read
    const done = (a._slain && a._slain.has(subjectId)) || !beliefAlive(a, subjectId);
    const stale = now - amb.t0 > MOTIVE.revengeTimeout;          // or the grudge simply cools
    amb.progress = done ? 1 : clamp01((now - amb.t0) / MOTIVE.revengeTimeout) * 0.4;
    if (done || stale) assignAmbition(a, now);
    return;
  }
  const def = AMBITIONS[amb.kind];
  amb.progress = def ? def.progress(a) : 0;
  if (amb.progress >= 1 && now - amb.t0 > MOTIVE.reassignGrace) {
    a.mood.anger = Math.max(0, a.mood.anger - 0.1);             // a small beat of contentment
    assignAmbition(a, now, amb.kind);                           // fresh goal; avoid an instant repeat
  }
}

// Multiplier an ambition applies to a candidate action's score in decide().
export function ambitionFavor(a: Agent, kind: string): number {
  const amb = a.ambition; if (!amb) return 1;
  const favors = amb.revenge ? REVENGE_FAVORS : (AMBITIONS[amb.kind] && AMBITIONS[amb.kind].favors);
  const f = favors && favors[kind];
  if (f == null) return 1;
  return 1 + (f - 1) * MOTIVE.pull;
}

// Does this agent currently want to FIGHT a believed enemy rather than flee it?
// (renown-seekers stand their ground; so does anyone carrying an aggressive GOAL
// — i.e. an `avenge` intention on the stack: revenge is re-homed to the goal
// layer, so we read the stack instead of a revenge ambition.)
const AGGRESSIVE_GOALS = new Set(['avenge', 'defeat']);
export function hasAggressiveGoal(a: Agent | null): boolean {
  return !!(a && Array.isArray(a.goals) && a.goals.some((g) => g && AGGRESSIVE_GOALS.has(g.kind)));
}
export function ambitionWantsFight(a: Agent): boolean {
  const amb = a.ambition;
  return hasAggressiveGoal(a) || (!!amb && amb.kind === 'renown');
}

// --- goal stack: memory-derived goals (docs §5) -----------------------------
// deriveGoals scans the agent's OWN salient memories and PUSHES intentions onto
// the goal stack (the epistemic split's create-from-memory side). pruneGoals
// drops satisfied / expired / stale goals (the drain side). Both guard every
// access and never throw (the freeze lesson). Push dedups by (kind, subject/
// place) inside agent.pushGoal, so re-scanning the same memory is idempotent (D1).
//
// | episode (memory.kind)         | goal pushed                          |
// |-------------------------------|--------------------------------------|
// | assaulted (culprit)           | avenge(withId)        ← revenge re-homed
// | windfall  (place)             | seek_fortune(place)                  |
// | succoured (benefactor)        | repay(withId)         ← Phase B
// | witnessed_death (liked subj)  | grieve(withId) (+avenge(byId) if known)  Phase B
// | relic    (place)              | delve(place)          ← Phase B
// VENDETTA ARC OPEN (docs/architecture/12 §3.5). When an avenge goal is derived, file/refresh the
// completed-arc record for the feud so an EMERGENT vendetta the agents run themselves produces a
// closed saga (not just scattered beats). Idempotent on the symmetric key (either party's derive,
// or a re-derive next tick, opens the SAME arc). Write-only narrator port — NO roster read, no name
// (the named escalation/close beats are filed observer-side in combatEvents). Townsfolk-only, to
// match the resolution path that closes it; raider brawls aren't vendettas. Guarded.
function openVendettaArc(a: Agent, ctx: CognitionCtx | null, foeId: EntityId): void {
  try {
    if (!ctx || !ctx.arcs || foeId == null || a.faction !== 'townsfolk') return;
    ctx.arcs.openArc({ kind: 'vendetta', key: arcKey('vendetta', a.id, foeId), principals: [a.id, foeId] });
  } catch { /* never throw on the tick */ }
}

export function deriveGoals(a: Agent, ctx: CognitionCtx | null): void {
  if (!a || a.controlled || !a.memory || typeof a.pushGoal !== 'function') return;
  if (a.faction === 'monster') return;              // monsters carry no grudge-goals
  // FEATURE DERIVERS (docs/architecture/10): run every registered goal-deriver as a DATA row —
  // each feature adds its derivation from its own file, not a branch hand-added here. Each is
  // independently guarded inside runDerivers, so one feature's fault never blocks another. Empty
  // until a feature registers, so this is a no-op (byte-stable) on the base sim.
  runDerivers(a, ctx);
  let salient;
  try { salient = a.memory.salient(); } catch { return; }
  if (!Array.isArray(salient)) return;
  const now = ctx ? ctx.time : 0;
  for (const ep of salient) {
    if (!ep) continue;
    try {
      if (ep.kind === 'assaulted' && ep.withId != null) {
        // don't avenge oneself, or a culprit a combat BRIDGE has already marked slain by
        // me (_slain). We do NOT require the culprit to be in sight — the whole point is to
        // HUNT one that fled out of belief-reach (the avenge goal drives destination-intent
        // pursuit). No roster/liveness read here.
        if (ep.withId === a.id || (a._slain && a._slain.has(ep.withId))) continue;
        const g = goalAvenge(ep.withId);
        g.priority = 0.9; g.from = 'assaulted';
        g.expiresAt = now + (MOTIVE.avengeExpiry || 120);
        traceDerived(a, ctx, g, a.pushGoal(g, ctx));
        openVendettaArc(a, ctx, ep.withId);   // narrative spine: the feud is now a tracked arc (§12 §3.5)
      } else if (ep.kind === 'windfall') {
        const g = goalSeekFortune(ep.place || 'market', MOTIVE.fortuneTarget || 140);
        g.priority = 0.6; g.from = 'windfall';
        g.expiresAt = now + (MOTIVE.fortuneExpiry || 180);
        traceDerived(a, ctx, g, a.pushGoal(g, ctx));
      } else if (ep.kind === 'succoured' && ep.withId != null) {
        // a kindness received while desperate -> repay the benefactor (give OR pay).
        // Can't repay one's own self or a benefactor I believe is gone (no confident
        // belief left). Belief-based; no roster read.
        if (ep.withId === a.id || !beliefAlive(a, ep.withId)) continue;
        const g = goalRepay(ep.withId, 1, 'any');
        g.priority = 0.7; g.from = 'succoured';
        g.expiresAt = now + (MOTIVE.repayExpiry || 240);
        traceDerived(a, ctx, g, a.pushGoal(g, ctx));
      } else if (ep.kind === 'witnessed_death' && ep.withId != null) {
        // saw a (liked) friend fall -> mourn them; if the killer is known (and I haven't
        // already slain it), carry a vendetta. The witnessed_death memory IS the evidence
        // of death (I saw it / word reached me), so no liveness read is needed to grieve.
        // Grieve is plan-less (just decays); avenge plans + drives the hunt.
        const grief = goalGrieve(ep.withId);
        grief.priority = 0.55; grief.from = 'witnessed_death';
        grief.expiresAt = now + (MOTIVE.grieveExpiry || 90);
        traceDerived(a, ctx, grief, a.pushGoal(grief, ctx));
        const haveCulprit = ep.byId != null && ep.byId !== a.id && !(a._slain && a._slain.has(ep.byId));
        if (haveCulprit) {
          const av = goalAvenge(ep.byId as EntityId);
          av.priority = 0.85; av.from = 'witnessed_death';
          av.expiresAt = now + (MOTIVE.avengeExpiry || 120);
          traceDerived(a, ctx, av, a.pushGoal(av, ctx));
          openVendettaArc(a, ctx, ep.byId as EntityId);   // the blood-feud is now a tracked arc (§12 §3.5)
        }
      } else if (ep.kind === 'relic') {
        // found / heard of a relic in a place -> delve there (aspirational for NPCs).
        const g = goalDelve(ep.place || 'a ruin');
        g.priority = 0.5; g.from = 'relic';
        g.expiresAt = now + (MOTIVE.delveExpiry || 200);
        traceDerived(a, ctx, g, a.pushGoal(g, ctx));
      }
    } catch { /* never throw on the tick */ }
  }
}

// NARRATIVE BEAT (PHASE 1): FULFILLING a goal-stack goal — avenging a wrong,
// repaying a debt, seeking a fortune, delving a ruin, grieving a friend — is the
// closure of a lived arc, and previously granted NO xp (only a closure memory).
// Grant grind-immune xp scaled by the closure salience and the goal-kind bonus
// (avenge/delve pay more than grieve/repay). Called from BOTH closure sites (the
// planner's _execPlanStep pop and pruneGoals' reactive pop) so the award is
// uniform however the goal resolved. Guarded; never throws on the tick.
//   salience — the closure episode's salience (avenge records 'triumph' @0.5,
//              others 'closure' @0.5; reuse that so the memory model is the
//              single notability signal).
export function awardGoalClosureXP(a: Agent, goal: Goal, now: number, salience = 0.5): void {
  if (!a || !goal || !a.progression || typeof a.progression.addNarrativeXP !== 'function') return;
  // GUARD against re-firing: a goal derived from a still-salient memory can be
  // re-pushed the instant it's popped and (if its predicate is already true) pop
  // again next tick — a loop that would mint xp every frame. Award ONCE per goal
  // object (`_xpAwarded`), and only for a goal that was genuinely PURSUED (lived
  // at least `narrativeGoalMinAgeSec`) — an instantly-satisfied re-derivation
  // grants nothing. The closure MEMORY is dedup-collapsed, so it's harmless; the
  // xp is not, so it must be gated here.
  if (goal._xpAwarded) return;
  const born = typeof goal.bornAt === 'number' ? goal.bornAt : now;
  const minAge = RPG.narrativeGoalMinAgeSec || 0;
  if (now - born < minAge) { goal._xpAwarded = true; return; }   // burn the flag, no reward
  goal._xpAwarded = true;
  const goalBonus = RPG.narrativeGoalBonus as Record<string, number> | undefined;
  const bonus = (goalBonus && goalBonus[goal.kind as string]) ?? 1;
  try { a.progression.addNarrativeXP(salience, now, bonus); } catch { /* never throw on the tick */ }
}

// drop goals whose subject/place is gone, whose predicate is satisfied, or which
// timed out. Kept here (sibling of updateAmbition) so all goal-stack policy lives
// in motivation.js. Returns nothing; mutates a.goals in place. Bounded + guarded.
// CAUTION (doc 11 §4.4) — the WASTE emit: a goal that DIED ON THE ROAD (set out, travelled toward a
// watched act, never reached it, gave up) prices the strategy. Emitted ONLY where a goal ends by
// expiry/unreachable — never on a predicate-satisfied pop (satisfied-by-other-means costs nothing),
// never on a plan swap (re-planning is free). Own-state; always-live; guarded.
function cautionWaste(a: Agent, ctx: CognitionCtx | null, g: Goal): void {
  if (!ctx) return;
  const tr = g._cautionTrail;
  if (tr && tr.step && !tr.acted && !tr.resolved) {
    tr.resolved = true;
    try { runPlanOutcome(a, ctx, { status: 'waste', step: tr.step, goal: g }); } catch { /* never throw */ }
  }
}

export function pruneGoals(a: Agent, ctx: CognitionCtx | null): void {
  if (!a || !Array.isArray(a.goals) || !a.goals.length) return;
  const now = ctx ? ctx.time : 0;
  a.goals = a.goals.filter((g: Goal) => {
    if (!g) return false;
    if (g.expiresAt != null && now >= g.expiresAt) { cautionWaste(a, ctx, g); return false; }
    if (typeof g.predicate === 'function') {
      try {
        if (g.predicate(a, ctx)) {
          // closure on completion (memory <-> goals feedback): a satisfied goal
          // popping here — e.g. an avenge goal whose subject died via the reactive
          // `fight` path rather than the planner's give/pay step — still records a
          // closure/triumph memory, so the biography reflects the resolution
          // however it was reached. Guarded; never throws on the tick.
          if (a.memory && typeof a.memory.record === 'function') {
            try {
              a.memory.record({
                t: now, kind: g.kind === 'avenge' ? 'triumph' : 'closure',
                withId: g.subjectId, valence: 1, salience: 0.5,
              });
            } catch { /* never throw */ }
          }
          awardGoalClosureXP(a, g, now, 0.5);   // narrative-beat xp for the closure
          // TRACE (write-only): the goal's predicate became satisfied — it pops. Own-state.
          // note() is internally guarded (never throws); a.trace always exists on an Agent.
          a.trace.note(ST.GOAL, RS.GOAL_POPPED, {
            t: now, subjectId: g.subjectId ?? null, a: g.kind || null,
          });
          return false;
        }
      } catch { /* keep on error */ }
    }
    if (g._unreachable) { cautionWaste(a, ctx, g); return false; }   // flagged by the planner as infeasible
    return true;
  });
}

// Compact descriptor for the relations/inspector UI.
export function ambitionText(a: Agent): AmbitionSnapshot | null {
  const amb = a.ambition; if (!amb) return null;
  return { label: amb.label, progress: amb.progress || 0, revenge: !!amb.revenge };
}
