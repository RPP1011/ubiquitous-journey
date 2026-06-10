// ---- the recruiter, live (docs/architecture/10 execution) -------------------------------
// Drives recruit's BELIEF half end-to-end with RECRUIT forced on: a leader approaches a candidate
// and makes an OFFER it perceives, recording the leader's OWN one-level prediction that the
// candidate will follow. Asserts the no-foreign-mind-write boundary: (1) the leader holds a Believes
// prediction; (2) the candidate PERCEIVED an offer (its own _offers); (3) the offer shifted the
// candidate's OWN belief (it warmed toward the leader) — no goal was written into it from outside.
import { FeatureStage } from './_stage.mjs';
import { goalMuster, believesConf } from '../../js/sim/planner.js';
import { RECRUIT, WARBAND } from '../../js/sim/simconfig.js';

export function recruitTest(ok, helpers) {
  recruitBeliefHalf(ok, helpers);
  warbandFollowThrough(ok, helpers);
  warbandSmoke(ok, helpers);
}

function recruitBeliefHalf(ok, helpers) {
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

// ---- the recruiter FOLLOW-THROUGH (WARBAND, docs/architecture/10-lld §19 item 4) ----------
// Proves the missing half: a warmed candidate forms its OWN decision to MARCH with an NPC leader,
// reusing the SAME band machinery the player's Party uses (NOT a parallel system). Flag forced ON;
// restored in finally. Asserts the candidate actually JOINS an NPC leader's band (the band flags
// flip), and then FOLLOWS (decide commits 'follow' once banded, off belief about the NPC leader).
function warbandFollowThrough(ok, helpers) {
  const prevR = RECRUIT.enabled, prevW = WARBAND.enabled;
  RECRUIT.enabled = true; WARBAND.enabled = true;
  try {
    const st = new FeatureStage(helpers);
    // BOTH are ordinary NPCs (no controlled flag) — the leader is NOT the player. This is the
    // whole point: a band led by ANY agent, the player special only for input.
    const leader = st.add('Bran', 0, 0, { personality: { risk_tolerance: 0.9 } });
    const cand = st.add('Sela', 4, 0, { personality: { risk_tolerance: 0.5 } });
    // the candidate already knows + likes the NPC leader (its OWN belief — the join cue), and has
    // PERCEIVED an offer from it (the Inform the recruiter executor plants). No goal was written in.
    cand.beliefs.observe(leader.id, leader.faction, leader.pos, st.sim.time, false);
    const crel = cand.beliefs.get(leader.id); if (crel) crel.standing = 0.7;   // well past joinStanding
    cand._offers = { [leader.id]: { from: leader.id, payoff: 1, t: st.sim.time } };
    ok(!cand.inParty && cand.bandLeaderId == null, 'warband 0: candidate starts unbanded');
    // run the frame loop — the follower-side deriver decides to join, joinBand flips the band flags.
    const ran = st.run(() => cand.inParty && cand.bandLeaderId === leader.id,
      { maxFrames: 800, pin: [[leader, 0, 0], [cand, 4, 0]], refresh: [[cand, leader]] });
    ok(cand.inParty && cand.bandLeaderId === leader.id,
      `warband 1: the candidate JOINED the NPC leader's band — its OWN decision flipped the shared band flags (bandLeaderId=${cand.bandLeaderId}, ${ran}f)`);
    ok(cand.groupType === 'warband' && cand.combatant === true,
      `warband 2: it joined as a warband combatant (groupType=${cand.groupType}, combatant=${cand.combatant}) — exactly the Party.recruit flag set`);
    ok(!cand._offers || !cand._offers[leader.id],
      'warband 3: the offer was SPENT on joining (not re-fired every tick)');
    // banded, no believed-hostile near: decide() must route through _decideParty and commit 'follow'.
    st.run(() => false, { maxFrames: 20, pin: [[leader, 0, 0], [cand, 4, 0]], refresh: [[cand, leader]] });
    ok(cand.goal && cand.goal.kind === 'follow',
      `warband 4: a banded follower with no foe near commits to FOLLOW the NPC leader (goal=${cand.goal && cand.goal.kind}) — the existing follow machinery, no AI fork`);
    st.dispose();
  } finally { RECRUIT.enabled = prevR; WARBAND.enabled = prevW; }
}

// ---- NPC-leader-with-flag-ON smoke (the soak-invariant guard for the live path) ------------
// A small populated run with WARBAND (+RECRUIT) ON stays STABLE: gold conserved to the cent, no
// freeze (the frame loop completes every frame), and the town is not wiped. The whole point of
// reusing the conserved/generic machinery is that turning the flag on adds bands without breaking
// any hard invariant. Flag restored in finally.
function warbandSmoke(ok, helpers) {
  const prevR = RECRUIT.enabled, prevW = WARBAND.enabled;
  RECRUIT.enabled = true; WARBAND.enabled = true;
  try {
    const st = new FeatureStage(helpers);
    const N = 10;
    const agents = [];
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2;
      agents.push(st.add('Town' + i, Math.cos(ang) * 5, Math.sin(ang) * 5,
        { profession: 'farmer', personality: { risk_tolerance: 0.6 + 0.3 * (i % 2) } }));
    }
    // seed a couple of pending offers so the live join path actually fires this run (each from a
    // would-be leader the candidate already likes — its own belief is the join cue).
    const L = agents[0];
    for (let i = 1; i <= 3; i++) {
      const c = agents[i];
      c.beliefs.observe(L.id, L.faction, L.pos, st.sim.time, false);
      const r = c.beliefs.get(L.id); if (r) r.standing = 0.6;
      c._offers = { [L.id]: { from: L.id, payoff: 1, t: st.sim.time } };
    }
    const goldBefore = st.totalGold();
    let threw = false;
    try { st.run(() => false, { maxFrames: 600 }); } catch { threw = true; }
    const goldAfter = st.totalGold();
    const alive = st.sim.agents.filter((a) => a.alive).length;
    ok(!threw, 'warband smoke 1: no freeze — the frame loop completed every frame with the flag ON');
    ok(Math.abs(goldAfter - goldBefore) < 1e-6,
      `warband smoke 2: gold conserved to the cent (${goldBefore.toFixed(2)} -> ${goldAfter.toFixed(2)})`);
    ok(alive >= N - 1, `warband smoke 3: the town is not wiped (${alive}/${N} alive)`);
    st.dispose();
  } finally { RECRUIT.enabled = prevR; WARBAND.enabled = prevW; }
}
