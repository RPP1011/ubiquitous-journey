// INFERENCE MOTIVES for the `strike` primitive (docs/architecture/17 §7 / §8.2) — how a witness READS
// a blow: as legitimate DEFENSE, as plain AGGRESSION, or (the grudge mirror) as AVENGE. These are the
// flagship "two witnesses, two truths" rows (§8.2): the SAME strike reads as defense to a witness who
// saw the victim throw the first punch (its OWN iSawProvocation cue) and as aggression to one who did
// not — straight from the prior×likelihood, over the observer's OWN memory/beliefs (never the roster).
//
// INFERENCE rows: they carry prior() + reads.likelihood (the observer half); their actor-half
// (eligible/score/bind) is inert — striking is driven by combat.js / the fight path, not the arbitrate
// table. Registered as data — one file, disjoint (imported by motives/index.ts).

import { registerMotive } from '../motivation/registry.js';
import { MOTIVE } from '../simconfig.js';
import type { Agent, Deed, EntityId } from '../../../types/sim.js';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const inert = { eligible: () => false, score: () => 0, bind: () => ({}) };

// Did I (the observer) recently see the VICTIM act the aggressor — throw the first blow? Reads the
// observer's OWN episodic memory only (witnessed_aggression byId === the strike's target), within the
// provocation window. This is the §8.2 cue: two witnesses to the same strike legitimately disagree
// because only ONE of them saw the victim start it. Bounded scan of the recent rings; never throws.
function sawVictimProvoke(o: Agent, deed: Deed): boolean {
  try {
    if (deed.targetId == null || !o.memory || !o.memory.stm) return false;
    const window = MOTIVE.provocationWindow || 30;
    const eps = [...o.memory.stm.items(), ...o.memory.mtm.items()];
    for (const e of eps) {
      if (!e || e.kind !== 'witnessed_aggression') continue;
      if (e.byId !== deed.targetId) continue;                    // the VICTIM was the earlier aggressor
      if ((deed.t - (e.t || 0)) > window) continue;              // still within the provocation window
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

// Do I (the observer) already BELIEVE the strike's target hostile / disliked? Then a blow on them
// reads more readily as defence. Own-belief only.
function targetBelievedHostile(o: Agent, deed: Deed): number {
  const tb = deed.targetId != null ? o.beliefs.get(deed.targetId) : null;
  if (!tb) return 0;
  return clamp01((tb.hostile ? 0.6 : 0) + 0.4 * clamp01(-(tb.standing || 0)));
}

registerMotive({
  key: 'defense', primitive: 'strike', serves: 'goal', basePrior: 0.25, ...inert,
  // a blow reads as DEFENCE when I myself saw the victim provoke it, OR I already hold the victim
  // hostile/disliked (they had it coming, by my lights). The observer cue iSawProvocation (assembled
  // in infer.ts) dominates: a witness who saw the first punch is near-certain it was self-defence.
  prior: (o: Agent, _actorId: EntityId, deed: Deed) =>
    clamp01((sawVictimProvoke(o, deed) ? 0.7 : 0.1) + 0.4 * targetBelievedHostile(o, deed)),
  reads: { tag: 'defense', likelihood: (_deed, cues) =>
    clamp01(0.2 + 0.7 * (cues.iSawProvocation || 0) + ((_deed.surfaceTag === 'defense') ? 0.2 : 0)) },
});

registerMotive({
  key: 'aggression', primitive: 'strike', serves: 'goal', basePrior: 0.5, ...inert,
  // the honest default: an unprovoked blow reads as aggression. A LETHAL blow (high magnitude) reads
  // more readily as raw violence; the presented 'aggression' tag mildly confirms it (no cover to hide).
  prior: () => 0.5,
  reads: { tag: 'aggression', likelihood: (deed, cues) =>
    clamp01(0.5 + 0.3 * (deed.magnitude || 0) - 0.4 * (cues.iSawProvocation || 0) +
      ((deed.surfaceTag === 'aggression') ? 0.15 : 0)) },
});

registerMotive({
  key: 'avenge', primitive: 'strike', serves: 'goal', basePrior: 0.05, ...inert,
  // THE GRUDGE MIRROR: only a witness whose OWN memory holds the ACTOR having been wronged by the
  // TARGET reads the blow as just vengeance (a blood-debt I know about). Reads my own episodic memory
  // (a witnessed_aggression / witnessed_death where byId === the TARGET, withId/about the ACTOR), so a
  // bystander ignorant of the feud never sees avenge. Bounded ring scan; own-state only.
  prior: (o: Agent, actorId: EntityId, deed: Deed) => {
    try {
      if (deed.targetId == null || !o.memory || !o.memory.stm) return 0.02;
      const eps = [...o.memory.stm.items(), ...o.memory.mtm.items(), ...o.memory.ltm.items()];
      for (const e of eps) {
        if (!e) continue;
        // I saw the TARGET earlier wrong the ACTOR (aggress against, or kill someone close to, them).
        const wrongedActor = e.byId === deed.targetId &&
          (e.withId === actorId || e.kind === 'witnessed_death');
        if ((e.kind === 'witnessed_aggression' || e.kind === 'witnessed_death') && wrongedActor) {
          return clamp01(0.3 + 0.5 * (e.salience || 0));
        }
      }
    } catch { /* fall through */ }
    return 0.02;
  },
  reads: { tag: 'avenge', likelihood: (deed) => clamp01(0.2 + 0.5 * (deed.magnitude || 0)) },
});
