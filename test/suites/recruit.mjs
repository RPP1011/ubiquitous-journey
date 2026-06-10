// ---- the recruiter, live (docs/architecture/10 execution) -------------------------------
// Drives recruit's BELIEF half end-to-end with RECRUIT forced on: a leader approaches a candidate
// and makes an OFFER it perceives, recording the leader's OWN one-level prediction that the
// candidate will follow. Asserts the no-foreign-mind-write boundary: (1) the leader holds a Believes
// prediction; (2) the candidate PERCEIVED an offer (its own _offers); (3) the offer shifted the
// candidate's OWN belief (it warmed toward the leader) — no goal was written into it from outside.
import { FeatureStage } from './_stage.mjs';
import { goalMuster, believesConf } from '../../js/sim/planner.js';
import { RECRUIT } from '../../js/sim/simconfig.js';

export function recruitTest(ok, helpers) {
  const prev = RECRUIT.enabled;
  RECRUIT.enabled = true;
  try {
    const st = new FeatureStage(helpers);
    const leader = st.add('Tor', 0, 0, { personality: { risk_tolerance: 0.9 } });
    const cand = st.add('Edda', 6, 0);
    for (const k in leader.needs) leader.needs[k] = 1;
    // the leader believes the candidate is well-disposed (the cue compliance reads); the candidate
    // already knows the leader (so a perceived offer can shift its OWN standing).
    leader.beliefs.observe(cand.id, cand.faction, cand.pos, st.sim.time, false);
    const lrel = leader.beliefs.get(cand.id); if (lrel) lrel.standing = 0.6;
    cand.beliefs.observe(leader.id, leader.faction, leader.pos, st.sim.time, false);
    const cBefore = cand.beliefs.get(leader.id).standing;
    // a muster the lone candidate can satisfy (self 1 + candidate ≈0.8 ≥ 1.5) — so it is not an
    // immediately-cooled unreachable threshold; the leader commits and makes the offer.
    leader.pushGoal(goalMuster(1.5), st.ctx());
    const ran = st.run(() => believesConf(leader, cand.id, 'follow') > 0 && !!(cand._offers && cand._offers[leader.id]),
      { maxFrames: 1500, pin: [[cand, 6, 0]], refresh: [[leader, cand]] });
    ok(believesConf(leader, cand.id, 'follow') > 0,
      `recruit 1: the leader holds a one-level prediction the candidate will follow (conf=${believesConf(leader, cand.id, 'follow').toFixed(2)}, ${ran}f)`);
    ok(!!(cand._offers && cand._offers[leader.id]),
      'recruit 2: the candidate PERCEIVED an offer (its own _offers) — an Inform, not a foreign write');
    // run a few more frames so the follower-side deriver warms the candidate toward the leader.
    st.run(() => false, { maxFrames: 30, pin: [[cand, 6, 0], [leader, 6, 0]] });
    const cAfter = cand.beliefs.get(leader.id).standing;
    ok(cAfter > cBefore,
      `recruit 3: the offer shifted the candidate's OWN belief — it warmed toward the leader (${cBefore.toFixed(2)} -> ${cAfter.toFixed(2)})`);
    st.dispose();
  } finally { RECRUIT.enabled = prev; }
}
