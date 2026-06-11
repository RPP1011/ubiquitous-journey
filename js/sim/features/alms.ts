// FEATURE: alms — charity decided by CHARACTER (the starvation follow-through). A destitute
// hungry townsperson begs at the market (decide's `beg` candidate; act's beg arm solicits via
// resolver.solicitAlms, which writes a plea into bystanders' perceivable `_pleas` mailbox — the
// recruiter-offer Inform pattern). THIS file is the DONOR half: a deriver that reads the agent's
// OWN mailbox and decides, off its OWN personality and surplus, whether the plea moves it:
//   · KIN are always moved (family feeds family);
//   · strangers move only the ALTRUISTIC (personality.altruism ≥ ALMS.donorAltruismMin);
//   · and only real SURPLUS is given (gold above ALMS.donorSurplusGold stays a donor's own).
// A moved donor pushes the existing REPAY plan (goto→pay): the conserved deliverTo transfer
// fires the receiver's succour hook (gratitude emerges), folds deedLedger('gift'), and the
// `_repaid` stamp means one gift per pauper per donor — charity, not a pension. The uncaring
// walk past, and that too is legible: ALTRUISM becomes a behaviour an observer can read.
//
// EPISTEMIC SPLIT: reads ONLY the agent's own state (_pleas mailbox, personality, kinIds, gold,
// goals) — the plea is a PERCEIVED event delivered by execution, exactly like a recruit offer.
// Bounded (pleaCap mailbox, TTL-pruned here); guarded; never throws (the freeze lesson).

import { registerDeriver } from '../exec/registry.js';
import { goalRepay } from '../planner.js';
import { ALMS } from '../simconfig.js';
import type { Agent, CognitionCtx, EntityId } from '../../../types/sim.js';

registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  const aa = a as Agent & { _pleas?: { fromId: EntityId; t: number }[] };
  if (!aa || !aa._pleas || !aa._pleas.length || aa.controlled || aa.faction !== 'townsfolk') return;
  if (!aa.townsperson) return;   // inert-fixture contract: a scenario cast member donates nothing
  const now = ctx ? ctx.time : 0;
  // prune stale pleas first (a bounded mailbox never grows; a forgotten plea simply lapses)
  aa._pleas = aa._pleas.filter((p) => p && now - p.t <= (ALMS.pleaTtl || 20));
  if (!aa._pleas.length) return;
  // only real SURPLUS is given — a donor near the breadline keeps its coin
  const give = ALMS.giveAmt || 4;
  if ((aa.gold || 0) < (ALMS.donorSurplusGold || 12) + give) return;
  const P = aa.personality || ({} as { altruism?: number });
  const kin = aa.kinIds;
  for (const p of aa._pleas) {
    if (p.fromId === aa.id) continue;
    const isKin = Array.isArray(kin) && kin.indexOf(p.fromId) !== -1;
    if (!isKin && (P.altruism ?? 0.5) < (ALMS.donorAltruismMin || 0.55)) continue;   // unmoved — walks past
    if ((aa._repaid && aa._repaid[String(p.fromId)]) ||
        (Array.isArray(aa.goals) && aa.goals.some((g) => g.kind === 'repay' && g.subjectId === p.fromId))) continue;
    const g = goalRepay(p.fromId, give);
    g.priority = 0.6; g.from = 'alms'; g.expiresAt = now + 45;
    aa.pushGoal(g, ctx);
    break;   // one act of charity at a time — the plan walks over and pays
  }
});

export {};
