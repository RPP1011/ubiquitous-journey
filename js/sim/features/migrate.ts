// FEATURE: migrate — emigration decided by CHARACTER (the population-skew valve's
// cognition half; truth-side census/rumour in js/sim/migration.js, config MIGRATE).
// A truth-side pass lets word reach a few ears in a crowded town that land is cheap
// in a sparse one (an Inform into the agent's own `_prospects` mailbox — the
// recruiter-offer / alms-plea pattern). THIS deriver is the agent weighing it:
//   · only the POOR are tempted (gold below MIGRATE.poorGold — the circumstance);
//   · only the UNHOUSED and UNWED (no homeBeliefId, no mateId) — the rooted stay;
//   · only the RESTLESS or the STRIVERS (curiosity ≥ wanderlustMin OR ambition ≥
//     ambitionMin) — personality is the choice, poverty just opens the door;
//   · and NO JOURNEY WITHOUT RATIONS (food ≥ provisionFood — the no-campaign-
//     without-rations precedent; the road is a map-length from a meal).
// A tempted soul weighs each prospect ONCE (acceptChance) — even the eligible may
// decide to stay, and a declined prospect is spent. An accepted one becomes an
// ordinary goal-stack journey (goalMigrate → [goto] — flee/eat still preempt), and
// only ON ARRIVAL does the agent request the citizenship flip through
// ctx.resolver.relocate (execution; the joinBand pattern — no self-teleport, no
// foreign write). A journey that runs out its clock just lapses: the agent stays
// a citizen of the town it never really left.
//
// EPISTEMIC SPLIT: reads ONLY the agent's own state (_prospects mailbox, gold,
// inventory, personality, homeBeliefId, mateId, goals, own pos) — the prospect is
// a PERCEIVED rumour delivered by the observer layer, exactly like a recruit offer.
// Bounded (prospectCap mailbox, TTL-pruned here); guarded; never throws.

import { registerDeriver } from '../exec/registry.js';
import { goalMigrate } from '../planner.js';
import { MIGRATE } from '../simconfig.js';
import { rng } from '../rng.js';
import type { Agent, CognitionCtx } from '../../../types/sim.js';

type Prospect = { townId: number; name?: string; x: number; z: number; t: number };
type Migrating = { townId: number; x: number; z: number; until: number };

registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  const aa = a as Agent & { _prospects?: Prospect[]; _migrating?: Migrating | null };
  if (!aa || !aa.alive || aa.controlled || aa.faction !== 'townsfolk') return;
  if (!aa.townsperson) return;   // inert-fixture contract: a scenario cast member never uproots
  const now = ctx ? ctx.time : 0;

  // ALREADY ON THE ROAD: watch my own journey. Arrived → request the citizenship
  // flip (execution); clock run out → give up the road and stay who I was.
  if (aa._migrating) {
    const m = aa._migrating;
    const arrived = Math.hypot(aa.pos.x - m.x, aa.pos.z - m.z) <= (MIGRATE.settleRadius || 25);
    if (arrived) {
      const res = ctx ? ctx.resolver : null;
      if (res && res.relocate) res.relocate(aa, m.townId);
      aa._migrating = null;            // settled (or the flip failed — either way the journey is over)
    } else if (now >= m.until) {
      aa._migrating = null;            // the road defeated them — still a citizen of the old town
      if (Array.isArray(aa.goals)) for (const g of aa.goals) {
        if (g.kind === 'migrate') g.expiresAt = now;   // pruneGoals retires the stale journey
      }
    }
    return;                            // one move at a time — no new prospects mid-journey
  }

  // WEIGH THE PROSPECTS (own mailbox; prune stale ones first — a bounded mailbox
  // never grows, a forgotten rumour simply lapses).
  if (!aa._prospects || !aa._prospects.length) return;
  aa._prospects = aa._prospects.filter((p) => p && now - p.t <= (MIGRATE.prospectTtl || 60));
  if (!aa._prospects.length) return;

  // the ROOTED stay: the housed, the wedded, the banded, the comfortable.
  if (aa.homeBeliefId != null || aa.mateId != null) return;
  if (aa.inParty || aa.bandLeaderId != null || aa.guardianOf != null) return;
  if ((aa.gold || 0) >= (MIGRATE.poorGold || 14)) return;            // circumstance: nothing keeps me
  const P = aa.personality || ({} as { curiosity?: number; ambition?: number });
  const restless = (P.curiosity ?? 0.5) >= (MIGRATE.wanderlustMin || 0.55);
  const striving = (P.ambition ?? 0.5) >= (MIGRATE.ambitionMin || 0.7);
  if (!restless && !striving) return;                                // character: the settled ignore it

  for (const p of aa._prospects.splice(0)) {                         // each prospect weighed ONCE (spent)
    if (!p || p.townId === aa.townId) continue;
    if ((aa.inventory && aa.inventory.food || 0) < (MIGRATE.provisionFood || 2)) continue;  // no rations, no road
    if (rng() > (MIGRATE.acceptChance || 0.5)) continue;             // slept on it; decided to stay
    const g = goalMigrate(p.townId, p.x, p.z);
    g.priority = MIGRATE.priority || 0.65;
    g.from = 'migrate';
    g.expiresAt = now + (MIGRATE.journeySecs || 300);
    aa.pushGoal(g, ctx);
    aa._migrating = { townId: p.townId, x: p.x, z: p.z, until: now + (MIGRATE.journeySecs || 300) };
    break;                                                           // one move at a time
  }
});

export {};
