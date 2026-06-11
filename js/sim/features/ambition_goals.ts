// FEATURE: persistent-ambition activity (Phase B1). THE CORE INSIGHT: ambitionFavor
// (motivation.ts) only MULTIPLIES a candidate that already EXISTS — so when no enemy/opportunity
// is in sight, nothing competes with the tiny wander floor (WEIGHT.wander) and an ambitious agent
// drifts aimlessly. The fix: an ambition DERIVES A STANDING INTENT that decide() turns into a
// candidate, so a candidate is CREATED that out-scores wander. The intent PERSISTS (it tracks the
// agent's own slow ambition, which itself persists over minutes) yet needs/flee/comfort and any
// higher-priority goal-stack PLAN still out-score the ambition candidate and interrupt — a hungry
// or threatened agent still tends itself; the ambition activity resumes when those urges clear.
// ALWAYS-LIVE on the mainline (gating is by branch). Registers ONE deriver row as an import
// side-effect (verbs-are-data), mirroring recruiter.ts.
//
// WHY OWN-STATE, NOT THE a.goals STACK: the intent is stamped on a dedicated own-state field
// (a._ambitionIntent), NOT pushed onto a.goals. The goal stack carries SPECIFIC, completing
// intentions (avenge/repay/muster/…) whose lifecycle the planner + the goal-stack tests own
// ("the stack drains to empty on completion"); a perpetual ambition standing goal would never
// drain, crowding that invariant. So the standing intent lives beside the stack: decide() reads
// it to MINT the ambition-activity candidate, and the matching steer-fill (fillSeekGlory/
// fillJourney/fillPursueCraft/fillSeekKin) motors the body. The candidate is scored BELOW the
// plan candidate, so a live memory-derived plan always wins — no stack contention needed.
//
// EPISTEMIC SPLIT: the deriver reads ONLY the agent's OWN state (a.ambition.kind, a.faction,
// a.controlled) — never the roster. The SPATIAL coordination (walk to the frontier / a
// distant landmark / my worksite / a believed friend) belongs to the steer-fills, which resolve
// their destination from own-state + the static map. Heavily guarded; bounded; never throws.

import { registerDeriver } from '../exec/registry.js';
import type { Agent, CognitionCtx } from '../../../types/sim.js';

// The standing-activity KIND each ambition pursues when otherwise idle (own-state). Four reuse an
// EXISTING measured behaviour so the activity is the SAME act the ambition is about — wealth/mastery
// WORK (produce goods to sell / hone a craft), belonging SOCIALISES, wanderlust SIGHTSEES (purposeful
// exploration). Renown uses the one NEW kind, seek_glory: a march to the frontier prowl band where
// the EXISTING fight candidate fires on contact (a renown-seeker proves itself in BATTLE, not by
// standing at a worksite). WEALTH is INCLUDED (the life-trace fix): its planner-backed seek_fortune
// goal is rare and ambitionFavor only MULTIPLIES candidates that already exist, so when labour stops
// paying (a glutted market) a wealth-seeker had nothing competing with the wander floor and drifted —
// it was the single biggest pool of aimless wander. Standing 'work' gives it productive idle time
// (keep producing the surplus it sells); chooseOccupation runs on the work commit, same as mastery.
export const AMBITION_ACTIVITY_KIND: Record<string, string> = {
  wealth: 'work',
  mastery: 'work',
  renown: 'seek_glory',
  wanderlust: 'sightsee',
  belonging: 'socialize',
};

// THE STANDING-INTENT DERIVER: per cognition tick, stamp the activity kind for the agent's CURRENT
// ambition onto own-state, so decide()'s ambition-activity candidate can read it. Cleared when the
// agent has no eligible ambition (so a just-rerolled wealth/■ ambition stops minting an activity).
// BANDED (inParty) agents keep their stamp too: decideParty doesn't score candidates, but its
// lost-leader fallback reads the intent — a follower whose track of its leader decays lives its
// OWN ambition instead of camping aimless wander (the single biggest drift pool the trace found).
// Gated on OWN-STATE ONLY. Guarded; bounded (one field write); never throws (the freeze lesson).
registerDeriver((a: Agent, _ctx: CognitionCtx | null) => {
  const aa = a as Agent & { _ambitionIntent?: string | null };
  if (!a || a.controlled || a.faction === 'monster') { aa._ambitionIntent = null; return; }
  const amb = a.ambition;
  let kind = amb && amb.kind ? AMBITION_ACTIVITY_KIND[amb.kind] : undefined;
  // WHEN THE INTENDED ACTIVITY IS UNAVAILABLE — resolve the fallback HERE (own-state), so every
  // reader (the decide() candidate, decideParty's lost-leader fallback, act's broken-off fight)
  // sees one already-actionable kind: a `work` ambition on a NON-WORKER (a combatant townsperson,
  // a child with no profession yet) can't stand at a worksite — a combatant proves itself at the
  // frontier instead (its body fights), everyone else sightsees (purposeful exploration, available
  // to all). So an ambition ALWAYS stamps a purposeful activity, never a dead 'work' letter.
  if (kind === 'work' && !a.canWork) kind = a.combatant ? 'seek_glory' : 'sightsee';
  aa._ambitionIntent = kind || null;
});

export {};
