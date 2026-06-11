// FEATURE: subsistence — the LIVE TRIGGER for the dormant goalSate (the survival breadth step
// CLAUDE.md documented: "hold/goalSate have no live trigger"). Hunger was only ever a REACTIVE
// utility candidate (eat/market), never POSED to the planner as a goal — so a destitute agent
// (no food, no coin, role-gated out of `work`) had no legal route to a meal and starved beside
// a field it could have foraged. This deriver hands the planner the problem; the EXISTING
// vocabulary already solves it, choosing by cost between:
//   · consume(food) ← have(food) ← BUY at the market (has coin), or
//   · consume(food) ← have(food) ← GATHER at a field — capital-free foraging (RAW_GOODS:
//     "a raw resource an agent can gather at a node without a profession").
// So how a hungry soul survives EMERGES from its means: the moneyed shop, the broke forage,
// the larcenous (urchin gate) steal, the desperate-but-decent beg (alms) — and which path a
// pauper takes is itself a personality statement.
//
// EPISTEMIC SPLIT: reads ONLY own state (needs/inventory/goals); the planner routes over the
// agent's OWN beliefs/static map. Idempotent (one live sate goal); guarded; never throws.

import { registerDeriver } from '../exec/registry.js';
import { goalSate } from '../planner.js';
import { ECON, SUBSIST } from '../simconfig.js';
import type { Agent, CognitionCtx } from '../../../types/sim.js';

registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!a || a.controlled || a.faction === 'monster' || !a.autonomous || a.inParty) return;
  if (!a.townsperson) return;   // inert-fixture contract: bare scenario casts derive nothing
  if (!a.needs || a.needs.hunger >= (ECON.eatUrgent || 0.45)) return;        // not in want
  if ((a.inventory.food || 0) > 0.05) return;                                 // carrying — just eat
  if (Array.isArray(a.goals) && a.goals.some((g) => g.kind === 'sate')) {     // already posed: refresh
    const live = a.goals.find((g) => g.kind === 'sate');
    if (live && ctx) live.expiresAt = ctx.time + (SUBSIST.ttl || 60);
    return;
  }
  const g = goalSate('hunger', SUBSIST.sateTo || 0.7);
  g.priority = SUBSIST.priority || 0.85;     // survival-grade: above ambition/groups, below avenge
  g.from = 'subsistence';
  g.expiresAt = (ctx ? ctx.time : 0) + (SUBSIST.ttl || 60);
  a.pushGoal(g, ctx);
});

export {};
