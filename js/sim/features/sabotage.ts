// FEATURE: SABOTAGE — the dormant `wreck` Affect row given a live target (docs/architecture/10 §8,
// §19 item 3: "wreck stays dormant — no enemy-owned structure entity to target"). This feature is
// exactly that missing trigger. Registers ONE goal-deriver (no new verbs — it reuses the always-live
// `wreck` executor + effect-holds in affect.ts and the `wreck` planner primitive). Disjoint by
// construction: it adds a row, touches no shared control flow.
//
// A strongly-grudging, bold/uncaring agent that believes a RIVAL owns a specific building (a place
// it spatially associates with a deeply-soured person-belief) derives a wrecked(buildingId) goal →
// the planner chains [goto(building) → wreck]. The `wreck` executor calls resolver.affect on the
// `B:`-namespaced id, which GUTS the building's walls; BuildSites._raidPass then recomputes shelter
// from the gutted struct and flips its believed `sheltered`/`alive` — so the OWNER discovers the ruin
// BY SIGHT and re-routes via the homecoming path (no telepathy). The town's displacement backstop
// rebuilds it later. Conserved: wrecking destroys wood parts, never gold.
//
// EPISTEMIC SPLIT (hard): the DECISION reads only the agent's OWN beliefs — a soured standing on a
// rival, and a place-belief (a building it has SEEN) whose believed position sits near where it
// believes that rival keeps to. "The rival owns this" is thus a fallible spatial INFERENCE over the
// agent's own map, exactly like the urchin's stash `assoc` — never a roster/ownerId read.
//
// GATE HARD on circumstance × character — a deep grudge (circumstance) AND a vindictive, bold,
// uncaring soul (character) — mirroring urchin.ts's discipline, so arson is RARE and emergent rather
// than a town-wide torching. ALWAYS-LIVE on the mainline (gating is by branch, not an in-code flag).

import { registerDeriver } from '../exec/registry.js';
import { goalWreck } from '../planner.js';
import { SABOTAGE, SIM } from '../simconfig.js';
import type { Agent, CognitionCtx, BeliefState } from '../../../types/sim.js';

// The agent's most-soured CONFIDENT rival belief (a real grudge, not a passing dislike), or null.
// Own-belief only. A foe it considers hostile is a COMBAT matter (handled by the fight/avenge path),
// so we skip the actively-hostile — sabotage is the SPITEFUL, deniable strike at someone you resent
// but aren't openly at war with (the cover the wreck mechanic is for).
function worstRival(a: Agent): BeliefState | null {
  if (!a.beliefs) return null;
  let worst: BeliefState | null = null, lowest = SABOTAGE.grudgeStanding;
  for (const b of a.beliefs.all()) {
    if (!b || b.subjectId === a.id || b.placeKind) continue;          // a person-belief, not a place
    if ((b.confidence || 0) < SIM.actOnBeliefMin) continue;           // too faint a grudge to act on
    if (b.hostile || (a.considerHostile && a.considerHostile(b))) continue;   // open foes are a combat matter
    if ((b.standing || 0) <= lowest) { lowest = b.standing || 0; worst = b; }
  }
  return worst;
}

// A building place-belief whose believed position sits near the rival's believed position — "the
// rival's home/workshop", inferred spatially over the agent's OWN map (fallible, like an `assoc`).
// Skip the agent's OWN home (placeKind 'home') and any building it already believes razed. Own-belief
// only — never an ownerId/roster read.
function rivalBuilding(a: Agent, rival: BeliefState): BeliefState | null {
  if (!a.beliefs) return null;
  const r2 = (SABOTAGE.ownerRadius || 10) ** 2;
  let pick: BeliefState | null = null, bestD = r2;
  for (const b of a.beliefs.all()) {
    if (!b || !b.placeKind || b.placeKind === 'home') continue;       // a building I've seen, not my own home
    if (b.sheltered === false) continue;                              // already believe it razed — nothing to wreck
    const dx = b.lastPos.x - rival.lastPos.x, dz = b.lastPos.z - rival.lastPos.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; pick = b; }
  }
  return pick;
}

// THE LIVE DERIVER (belief + own-personality ONLY). The hard circumstance × character gate keeps
// arson vanishingly rare: a real grudge (circumstance) held by a vindictive, bold, uncaring soul
// (character — the choice). Most souls never qualify, exactly like the urchin's larcenous corner.
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!a || !a.alive || a.controlled || a.faction === 'monster') return;
  if (!a.beliefs || !a.personality) return;
  const p = a.personality;
  // CHARACTER GATE: vindictive AND bold AND uncaring. The forgiving, the timid, and the kind never
  // burn a rival's home — character is the choice, the grudge is only the circumstance.
  if ((p.vindictiveness ?? 0) < SABOTAGE.vindictivenessMin) return;
  if ((p.risk_tolerance ?? 0) < SABOTAGE.riskMin) return;
  if ((p.altruism ?? 1) > SABOTAGE.altruismMax) return;

  const rival = worstRival(a);
  if (!rival) return;                                  // no real grudge — circumstance absent
  const bld = rivalBuilding(a, rival);
  if (!bld) return;                                    // I associate no building with this rival
  const g = goalWreck(bld.subjectId);
  g.priority = SABOTAGE.priority; g.from = 'sabotage';
  g.expiresAt = (ctx ? ctx.time : 0) + (SABOTAGE.expiry || 120);
  a.pushGoal(g, ctx);
});

export {};
