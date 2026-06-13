// INFERENCE MOTIVES for the `say` primitive (docs/architecture/17 §7 / §8.1) — the speech-acts, the
// first NEW breadth the (primitive, motivation) factoring was for. `say` asserts a belief into an
// audience; a witness must read WHY: counsel (warn), a smear (slander), or praise (vouch). The split
// is decided by the WITNESS'S OWN belief about the subject: a negative remark about someone I already
// distrust reads as a warning; the identical remark about someone I like reads as a smear — one deed,
// two truths, straight from the prior (the §8.1 worked example). Inference rows: prior + likelihood
// only (actor-half inert; speaking is driven by features/speech.ts, not the arbitrate table).

import { registerMotive } from '../motivation/registry.js';
import type { Agent, Deed } from '../../../types/sim.js';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const inert = { eligible: () => false, score: () => 0, bind: () => ({}) };
const valenceOf = (deed: Deed): number => (deed.sceneCues && typeof deed.sceneCues.valence === 'number') ? deed.sceneCues.valence : 0;

// how SUSPECT the witness already holds the subject (its own belief): a hostile/low-standing subject.
function subjectSuspect(o: Agent, deed: Deed): number {
  const sb = deed.targetId != null ? o.beliefs.get(deed.targetId) : null;
  if (!sb) return 0;
  return clamp01((sb.hostile ? 0.6 : 0) + 0.4 * clamp01(-(sb.standing || 0)));
}
// how much the witness LIKES/trusts the subject (the smear-victim reading).
function subjectLiked(o: Agent, deed: Deed): number {
  const sb = deed.targetId != null ? o.beliefs.get(deed.targetId) : null;
  if (!sb) return 0.25;
  return clamp01((sb.standing || 0)) * (sb.hostile ? 0 : 1);
}

registerMotive({
  key: 'warn', primitive: 'say', serves: 'goal', basePrior: 0.3, ...inert,
  // a negative word about someone I ALREADY distrust reads as counsel (you confirm my fear).
  prior: (o, _aid, deed) => clamp01(0.2 + 0.6 * subjectSuspect(o, deed)),
  reads: { tag: 'counsel', likelihood: (deed) => (valenceOf(deed) < 0 ? 0.7 : 0.1) },
});

registerMotive({
  key: 'slander', primitive: 'say', serves: 'goal', basePrior: 0.3, ...inert,
  // the identical negative word about someone I LIKE reads as a smear.
  prior: (o, _aid, deed) => clamp01(0.15 + 0.7 * subjectLiked(o, deed)),
  reads: { tag: 'defamation', likelihood: (deed) => (valenceOf(deed) < 0 ? 0.7 : 0.1) },
});

registerMotive({
  key: 'vouch', primitive: 'say', serves: 'goal', basePrior: 0.3, ...inert,
  // a POSITIVE word reads as praise/endorsement, whoever the subject.
  prior: () => 0.5,
  reads: { tag: 'endorsement', likelihood: (deed) => (valenceOf(deed) > 0 ? 0.8 : 0.1) },
});
