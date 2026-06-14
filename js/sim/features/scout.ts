// FEATURE: belief-driven SCOUTING (docs/architecture/10 — the knowledge model put to PROACTIVE use).
// Registers ONE goal-deriver (no new verbs — it reuses the always-live observe/ask channels and their
// effect-holds from learning.ts). Disjoint by construction: it adds a row, touches no shared code.
//
// THE DORMANT LOW-CONFIDENCE BAND, TURNED ACTIVE. The knowledge model already lets an agent that
// NEEDS a fact scout for it (the spy's Know(loc), the apprentice's Know(recipe)). This deriver makes
// the CURIOUS scout UNPROMPTED: when an agent holds a belief that is both UNCERTAIN (confidence in a
// middle window — known-of, but not yet trusted) and WORTH RESOLVING (a believed-rich mark, a believed
// relic place, or a once-close friend it has lost track of), it forms a Know() goal to go RESOLVE it —
// the planner picks observe (first-hand, trusted) or ask (cheap, vaguer). The agent acts to firm up
// what it is unsure of, rather than letting a juicy-but-shaky belief decay unexamined.
//
// EPISTEMIC SPLIT (hard): every read is the agent's OWN belief — its confidences, its believed wealth,
// its standing. Never the roster, never ground truth. The whole point is that the agent investigates
// because it is UNSURE; what it learns may confirm or refute the hunch (observe/ask write its own
// belief honestly). Selective by character (a curiosity gate) + a confidence window, so it is
// occasional investigation, not constant milling. Bounded: pushGoal dedups by goal kind, the goal
// cools on its expiry. ALWAYS-LIVE on the mainline (gating is by branch, not an in-code flag).

import { registerDeriver } from '../exec/registry.js';
import { goalLearn } from '../planner.js';
import { SCOUT } from '../simconfig.js';
import type { Agent, CognitionCtx, KnowTopic } from '../../../types/sim.js';

// Is a belief's confidence in the SCOUT window — firm enough to be a real hunch (not perceptual
// noise), but below the act-on floor (not yet trusted enough to commit on)? The uncertainty band the
// investigation targets. Own-belief only.
function inWindow(conf: number): boolean {
  return conf >= SCOUT.confLo && conf < SCOUT.confHi;
}

// THE LIVE DERIVER (belief + own-personality ONLY). A curious agent scans its OWN beliefs for the
// single most worth-resolving uncertain one and forms a Know() goal to investigate it. The "worth"
// cues (a juicy mark, a relic place, a lost friend) are all read off the agent's own belief fields,
// so the choice of WHAT to scout is itself belief-grounded — exactly as fallible as any other ToM read.
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!a || !a.alive || a.controlled || a.faction === 'monster') return;
  if (!a.beliefs || !a.personality) return;
  // CHARACTER GATE: only the CURIOUS go out of their way to resolve a hunch. The incurious let a
  // shaky belief sit; curiosity is the disposition that turns uncertainty into a trip.
  if ((a.personality.curiosity ?? 0) < SCOUT.curiosityMin) return;

  let topic: KnowTopic | null = null, best = 0;
  for (const b of a.beliefs.all()) {
    if (!b || b.subjectId === a.id) continue;
    if (!inWindow(b.confidence || 0)) continue;          // only the genuinely UNCERTAIN are worth scouting
    // WORTH cue 1 — a believed-RICH mark whose wealth I am unsure of: confirming it is worth a look
    // (the wealth-cue prosperity belief, the same the urchin's estimate reads — own-belief only).
    if (!b.placeKind && (b.believedWealth || 0) >= SCOUT.wealthCue) {
      const score = (b.believedWealth || 0) * (1 - (b.wealthConf || 0));   // juicy AND unsure ⇒ scout it
      if (score > best) { best = score; topic = { kind: 'whereabouts', subjectId: b.subjectId }; }
      continue;
    }
    // WORTH cue 2 — a once-close FRIEND I have lost track of (a positive standing on a faded belief):
    // I go looking to firm up where they are (their whereabouts), the social mirror of the mark scout.
    if (!b.placeKind && (b.standing || 0) > 0) {
      const score = (b.standing || 0) * (1 - (b.confidence || 0));         // dear AND uncertain ⇒ seek them
      if (score > best) { best = score; topic = { kind: 'whereabouts', subjectId: b.subjectId }; }
    }
  }
  if (!topic) return;
  const g = goalLearn(topic);
  g.priority = SCOUT.priority; g.from = 'scout';
  g.expiresAt = (ctx ? ctx.time : 0) + (SCOUT.expiry || 90);
  a.pushGoal(g, ctx);
});

export {};
