// FEATURE: aspiration APPRENTICESHIP (docs/architecture/10 §6 — the knowledge model, learning side).
// Registers ONE goal-deriver (no new verbs — it reuses the always-live study/observe channels and
// their effect-holds + the graded-recipe machinery from learning.ts / recipeKnow.ts). Disjoint by
// construction: it adds a row, touches no shared code.
//
// A `mastery`-ambition agent that BELIEVES a high-skill neighbour practises a craft IT LACKS forms a
// Know(recipe) goal → the planner inserts `study`, whose executor pays conserved TUITION to a
// co-located teacher (resolver.teachRecipe) and accrues GRADED recipe confidence (recipeKnow). This is
// the AMBITION to broaden — a master-in-the-making picking up a SECOND craft — distinct from
// learning.ts's deriver, which only firms up the agent's OWN trade (a producer who lacks its own
// recipe). The two are disjoint: learning fires on `a._trade`; this fires on a DIFFERENT craft the
// mastery soul aspires to, chosen by a believed-teacher cue.
//
// EPISTEMIC SPLIT (hard): every read is the agent's OWN state — its ambition, its recipes Set, and a
// believed-teacher CUE read off its OWN person-beliefs (a confident, prosperous-seeming, not-disliked
// neighbour reads as an established crafter — a believed-skill proxy, exactly as fallible as the
// urchin's wealth cue). It never reads the roster or who truly knows what; resolver.teachRecipe does
// the ground-truth teacher match at execution (and there is simply no taught session if none is near,
// so the apprentice waits / the goal cools — no free lunch). Bounded: pushGoal dedups by goal kind;
// the goal cools on its expiry. ALWAYS-LIVE on the mainline (gating is by branch, not an in-code flag).

import { registerDeriver } from '../exec/registry.js';
import { goalLearn } from '../planner.js';
import { tradeMargin } from '../agent/occupation.js';
import { APPRENTICE, RECIPES } from '../simconfig.js';
import type { Agent, CognitionCtx } from '../../../types/sim.js';

// Do I BELIEVE someone nearby plies `good`? The believedOccupation cue (doc 18 M2) banked on a
// person-belief — own-belief only, never the roster. A craft for which I believe a practitioner
// exists is one I can actually apprentice to (a teacher is plausibly about), so it breaks ties
// toward learnable crafts. Fallible (the cue can be stale/wrong → no teacher present → the goal
// cools), exactly like every other belief read here.
function believesPractitionerOf(a: Agent, good: string): boolean {
  if (!a.beliefs) return false;
  for (const b of a.beliefs.all()) {
    if (!b || b.subjectId === a.id || b.placeKind) continue;
    if (b.believedOccupation === good) return true;
  }
  return false;
}

// Does the agent hold a believed-ESTABLISHED-crafter cue among its OWN beliefs? A neighbour believed
// prosperous (a full pack / fine gear — the wealth cue) AND not disliked reads as a settled master
// worth apprenticing to. Belief-only — never the roster, never who truly practises a craft. This is
// the gate that makes the aspiration land on REAL towns (where prosperous crafters exist) yet stays a
// fallible read (a flashy idler reads "established" too — the apprentice simply finds no teacher and
// the goal cools, the same honesty estimateHaul runs on).
function believesAMaster(a: Agent): boolean {
  if (!a.beliefs) return false;
  for (const b of a.beliefs.all()) {
    if (!b || b.subjectId === a.id || b.placeKind) continue;          // a person-belief, not a place
    if ((b.believedWealth || 0) < APPRENTICE.teacherWealthCue) continue;
    if ((b.standing || 0) < APPRENTICE.teacherStanding) continue;     // not someone I resent
    return true;
  }
  return false;
}

// THE LIVE DERIVER (own-state + own-belief ONLY). A mastery soul that lacks a gated craft AND believes
// an established crafter is about forms a Know(recipe) goal for the BEST-MARGIN such craft it lacks. The
// planner then routes [goldGe(tuition) → at(market) → study]; study pays the teacher (conserved) and
// firms the recipe. Dormant unless a mastery soul genuinely lacks a craft (with seedKnown 'all' every
// born producer knows its gated recipes) — correct + unit-tested regardless; fires for lineage
// children born WITHOUT a craft (RECIPES.childInheritP) and for any mastery soul that never produced.
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!a || !a.alive || a.controlled || a.faction === 'monster') return;
  if (!a.recipes || !a.ambition || a.ambition.kind !== 'mastery') return;   // the broaden-my-craft ambition
  const gated = (RECIPES.gated as string[]) || [];
  // The BEST craft to pick up by EXPLOITED KNOWLEDGE (doc 18 §3 — the apprentice proxy gap): not the
  // first gated craft I lack, but the one with the best believed NET MARGIN (`tradeMargin`, my OWN
  // price beliefs), with a tie-break BONUS for a craft I believe a practitioner already plies (so the
  // aspiration lands where a teacher is plausibly about). learning.ts owns my OWN trade; this is a
  // DIFFERENT one I aspire to, so my current trade good is skipped. Belief-only; the chooser leaves the
  // ground-truth teacher match to resolver.teachRecipe.
  let want: string | null = null, bestScore = -Infinity;
  for (const good of gated) {
    if (good === a._trade) continue;                  // my own trade is learning.ts's business
    if (a.recipes.has(good)) continue;                // already craft it
    let score = tradeMargin(a, good);                 // believed effective value of the labour
    if (believesPractitionerOf(a, good)) score *= (APPRENTICE.knownTeacherBonus || 1.5);
    if (score > bestScore) { bestScore = score; want = good; }
  }
  if (!want) return;                                  // already knows every gated craft
  if (!believesAMaster(a)) return;                    // no believed master to apprentice to (belief cue)
  const g = goalLearn({ kind: 'recipe', good: want });
  g.priority = APPRENTICE.priority; g.value = bestScore; g.from = 'apprentice';
  g.expiresAt = (ctx ? ctx.time : 0) + (APPRENTICE.expiry || 160);
  a.pushGoal(g, ctx);
});

export {};
