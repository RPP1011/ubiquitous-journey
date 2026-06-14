// FEATURE: RECIPROCITY — read believedMotive BACK into trust (docs/architecture/17 §8.2, the loop's
// second half). The inference engine (motivation/infer.ts) WRITES `believedMotive`/`motiveConf` onto a
// belief when a witnessed deed is confidently read; nothing yet READS it. This deriver closes the loop:
// each cognition tick it scans the agent's OWN beliefs and folds a confident motive attribution into
// the standing/suspicion of that belief — a confident HOSTILE motive (aggression/theft/robbery/slander)
// COOLS standing + raises suspicion (feeding decide.pickSuspectToAvoid's soft berth); a confident BENIGN
// motive (defense/justice/vouch) WARMS standing. So a witness who reads a blow as defence thinks BETTER
// of the striker, while one who reads it as aggression gives them a wide berth — two truths, two trusts.
//
// EPISTEMIC SPLIT: reads + writes ONLY the deciding agent's OWN beliefs (never the roster, never another
// mind). It does NOT touch decide.ts / arbitrate.ts (the scorer-parity tripwire) — it only mutates the
// agent's own belief fields, which those scorers already read. The fold is SMALL + DEDUPED (applied once
// per distinct attribution, not per tick) + BOUNDED, so it can't ramp standing to a cliff or destabilize
// the soak. ALWAYS-LIVE on the mainline (gating is by branch). One file, one deriver; disjoint.

import { registerDeriver } from '../exec/registry.js';
import { MOTIVE } from '../simconfig.js';
import type { Agent, CognitionCtx } from '../../../types/sim.js';

const HOSTILE_MOTIVES = new Set(['aggression', 'theft', 'robbery', 'slander']);
const BENIGN_MOTIVES = new Set(['defense', 'justice', 'vouch']);
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

// A belief row carries a private bookkeeping marker for the last attribution we folded, so the fold is
// applied ONCE per distinct (motive) read, not re-applied every tick (which would saturate standing).
type FoldableBelief = {
  subjectId: number | string;
  standing: number; suspicion: number;
  believedMotive?: string; motiveConf?: number;
  _reciprocityFolded?: string;
};

registerDeriver((a: Agent, _ctx: CognitionCtx | null) => {
  if (!a || a.controlled || !a.beliefs) return;
  const attributeAt = MOTIVE.attributeAt || 0.45;
  const cool = MOTIVE.reciprocityCool || 0.18;
  const warm = MOTIVE.reciprocityWarm || 0.10;
  const susp = MOTIVE.reciprocitySuspicion || 0.12;
  for (const raw of a.beliefs.all()) {
    const b = raw as unknown as FoldableBelief;
    if (b.subjectId === a.id) continue;                       // never about myself
    const motive = b.believedMotive;
    if (!motive || (b.motiveConf || 0) < attributeAt) continue;   // only a CONFIDENT attribution folds
    // DEDUPE: fold each distinct attribution exactly once (a re-read to the SAME motive does nothing;
    // a CHANGED motive re-arms it — a witness who later reads the same person differently re-trusts).
    if (b._reciprocityFolded === motive) continue;
    b._reciprocityFolded = motive;
    if (HOSTILE_MOTIVES.has(motive)) {
      b.standing = clamp((b.standing || 0) - cool, -1, 1);    // a believed wrong-doer loses my trust
      b.suspicion = clamp((b.suspicion || 0) + susp, 0, 1);   // …and earns a wary berth (soft-avoid)
    } else if (BENIGN_MOTIVES.has(motive)) {
      b.standing = clamp((b.standing || 0) + warm, -1, 1);    // a believed defender / honest soul warms me
    }
    // an unrecognized motive (or 'avenge'/'warn' — ambiguous) folds nothing; just marked, so it won't
    // be re-examined until the attribution changes.
  }
});

export {};
