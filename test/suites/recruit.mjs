// ---- the recruiter, live (docs/architecture/10 execution) -------------------------------
// Drives recruit's BELIEF half end-to-end (always-live on the mainline): a leader approaches a
// candidate and makes an OFFER it perceives, recording the leader's OWN one-level prediction that the
// candidate will follow. Asserts the no-foreign-mind-write boundary: (1) the leader holds a Believes
// prediction; (2) the candidate PERCEIVED an offer (its own _offers); (3) the offer shifted the
// candidate's OWN belief (it warmed toward the leader) — no goal was written into it from outside.
import { FeatureStage } from './_stage.mjs';
import { goalMuster, believesConf } from '../../js/sim/planner.js';
import { WARBAND, RECRUIT } from '../../js/sim/simconfig.js';

export function recruitTest(ok, helpers) {
  recruitBeliefHalf(ok, helpers);
  warbandFollowThrough(ok, helpers);
  warbandDirectedAssault(ok, helpers);
  warbandDefection(ok, helpers);
  recursiveTomRecruit(ok, helpers);
  warbandSmoke(ok, helpers);
}

// ---- DEFECTION / MUTINY: a warband fractures FROM WITHIN (the mirror of the join) ----------
// Proves a follower whose OWN belief of its leader has soured (a witnessed band-mate's death it
// lays at the leader's feet, or any other belief-souring) decides FOR ITSELF to mutiny: it drops
// the band flags through the shared revert seam and re-plants a low standing on its former leader.
// Reads only the follower's own beliefs/memory — never the roster, no Director fiat.
function warbandDefection(ok, helpers) {
  {
    // (A) a follower whose belief of the leader is already SOURED below the bar -> mutinies.
    const st = new FeatureStage(helpers);
    const leader = st.add('Cad', 0, 0, { personality: { risk_tolerance: 0.9 } });
    const f1 = st.add('Mal', 1, 0), f2 = st.add('Nye', -1, 0);
    for (const f of [f1, f2]) { f.bandLeaderId = leader.id; f.inParty = true; f.groupType = 'warband'; f.combatant = true; }
    // Mal's OWN belief of its leader has curdled (a snub / forsworn leader / combat feedback — any
    // ordinary belief-souring); past the mutiny bar. Nye still thinks well of the leader (stays).
    f1.beliefs.observe(leader.id, leader.faction, leader.pos, st.sim.time, false);
    const mr = f1.beliefs.get(leader.id); if (mr) mr.standing = (WARBAND.defectStanding || -0.25) - 0.2;
    f2.beliefs.observe(leader.id, leader.faction, leader.pos, st.sim.time, false);
    const nr = f2.beliefs.get(leader.id); if (nr) nr.standing = 0.6;
    ok(f1.bandLeaderId === leader.id && f2.bandLeaderId === leader.id, 'defect 0: both start in the band');
    const ran = st.run(() => f1.bandLeaderId == null, { maxFrames: 400, pin: [[leader, 0, 0], [f1, 1, 0], [f2, -1, 0]] });
    ok(f1.bandLeaderId == null && !f1.inParty,
      `defect 1: a soured follower mutinied — its OWN decision dropped the band flags (bandLeaderId=${f1.bandLeaderId}, ${ran}f)`);
    ok((f1.beliefs.get(leader.id).standing) <= (WARBAND.defectSour || -0.5) + 1e-6,
      `defect 2: the deserter re-planted a low standing on its former leader (${f1.beliefs.get(leader.id).standing.toFixed(2)}) — the fracture`);
    ok((leader.beliefs.get(f1.id) ? leader.beliefs.get(f1.id).standing : 99) <= (WARBAND.defectSour || -0.5) + 1e-6,
      'defect 3: the leader thinks worse of the deserter (the visible fracture, execution-side perception)');
    ok(f2.bandLeaderId === leader.id,
      'defect 4: a loyal band-mate (its own belief still warm) does NOT mutiny — the split is per-follower belief');
    st.dispose();
  }
  {
    // (B) GRIEF DRIVES IT: a follower starts loyal, then WITNESSES a liked band-mate fall — its own
    // memory erodes the leader's standing past the bar, and it deserts. No external standing edit.
    const st = new FeatureStage(helpers);
    const leader = st.add('Orm', 0, 0, { personality: { risk_tolerance: 0.9 } });
    const griever = st.add('Pell', 1, 0), fallen = st.add('Rua', -1, 0);
    for (const f of [griever, fallen]) { f.bandLeaderId = leader.id; f.inParty = true; f.groupType = 'warband'; f.combatant = true; }
    griever.beliefs.observe(leader.id, leader.faction, leader.pos, st.sim.time, false);
    const gr = griever.beliefs.get(leader.id); if (gr) gr.standing = 0.1;   // loyal-ish, but fragile
    griever.beliefs.observe(fallen.id, fallen.faction, fallen.pos, st.sim.time, false);
    const fr = griever.beliefs.get(fallen.id); if (fr) fr.standing = 0.7;   // a dear band-mate
    // the griever's OWN memory: it saw Rua fall just now (a fresh grievance it lays at the leader).
    st.inject(griever, { t: st.sim.time, kind: 'witnessed_death', withId: fallen.id, valence: -0.8, salience: 0.9 });
    const ran = st.run(() => griever.bandLeaderId == null, { maxFrames: 400, pin: [[leader, 0, 0], [griever, 1, 0]] });
    ok(griever.bandLeaderId == null && !griever.inParty,
      `defect 5: a fresh witnessed band-mate death soured the leader past the bar — the griever deserted (${ran}f)`);
    st.dispose();
  }
}

// ---- RECURSIVE ToM RECRUITMENT: recruit those who ALSO believe the foe a threat (an easier sell) --
// Proves the muster gate goes one level deeper than the `follow` prediction: a would-be leader that
// believes a candidate is ALSO near/aware of the foe (its OWN belief about the candidate's belief of
// the foe) makes a MORE COMPELLING offer to it. The leader reads only two of its own beliefs
// (candidate position + foe) — never a roster read to decide.
function recursiveTomRecruit(ok, helpers) {
  const offerPayoffFor = (sharedFoe) => {
    const st = new FeatureStage(helpers);
    const leader = st.add('Sig', 0, 0, { personality: { risk_tolerance: 0.9 } });
    const cand = st.add('Tove', 6, 0);
    for (const k in leader.needs) leader.needs[k] = 1;
    leader.beliefs.observe(cand.id, cand.faction, cand.pos, st.sim.time, false);
    const lrel = leader.beliefs.get(cand.id); if (lrel) lrel.standing = 0.6;
    cand.beliefs.observe(leader.id, leader.faction, leader.pos, st.sim.time, false);
    if (sharedFoe) {
      // the leader believes a hostile foe sits RIGHT BY the candidate (so it infers the candidate
      // fears it too — a shared grievance). The foe is NOT a recruit candidate (it is hostile).
      const foe = st.add('Vrak', 7, 0, { faction: 'bandit', combatant: true });
      leader.beliefs.observe(foe.id, foe.faction, foe.pos, st.sim.time, true);
    }
    leader.pushGoal(goalMuster(1.5), st.ctx());
    st.run(() => !!(cand._offers && cand._offers[leader.id]),
      { maxFrames: 1500, pin: sharedFoe ? [[cand, 6, 0]] : [[cand, 6, 0]], refresh: [[leader, cand]] });
    const off = cand._offers && cand._offers[leader.id];
    const payoff = off ? off.payoff : 0;
    const follow = believesConf(leader, cand.id, 'follow');
    st.dispose();
    return { payoff, follow };
  };
  const base = offerPayoffFor(false);
  const shared = offerPayoffFor(true);
  ok(base.payoff > 0 && shared.payoff > 0, `rtom 0: both candidates received an offer (base=${base.payoff.toFixed(2)}, shared=${shared.payoff.toFixed(2)})`);
  ok(shared.payoff > base.payoff + 1e-6,
    `rtom 1: the leader makes a MORE COMPELLING offer to a candidate it believes also fears the foe (${base.payoff.toFixed(2)} -> ${shared.payoff.toFixed(2)}) — recursive ToM, one level deeper`);
  ok(shared.follow > base.follow + 1e-6,
    `rtom 2: the leader's one-level follow-prediction is firmer for the shared-foe candidate (${base.follow.toFixed(2)} -> ${shared.follow.toFixed(2)})`);
}

// ---- the recruiter CAPSTONE: muster -> MARCH on the foe (the missing directed-assault half) ----
// Proves the leader, once it actually leads a band strong enough to outmatch a believed foe, turns
// that band ONTO the foe (goal 'assault') instead of forever recruiting — and that a LONE would-be
// leader musters (recruits) first. Belief-only target; the band converges via decideParty.
function warbandDirectedAssault(ok, helpers) {
  {
    // (A) a leader that ALREADY leads two followers + believes a foe -> turns the band on it.
    const st = new FeatureStage(helpers);
    const leader = st.add('Ulf', 0, 0, { personality: { risk_tolerance: 0.9 } });
    leader.canWork = true; leader.combatant = true;          // a war-leader fights (won't flee mid-march)
    for (const k in leader.needs) leader.needs[k] = 1;
    const foe = st.add('Grol', 16, 0, { faction: 'bandit', combatant: true });
    const f1 = st.add('Ace', 1, 0), f2 = st.add('Bo', -1, 0);
    for (const f of [f1, f2]) { f.bandLeaderId = leader.id; f.inParty = true; f.groupType = 'warband'; f.combatant = true; }
    leader.beliefs.observe(foe.id, foe.faction, foe.pos, st.sim.time, true);   // believes the foe hostile
    const ranA = st.run(() => leader.goals.some((g) => g.kind === 'assault' && g.subjectId === foe.id),
      { maxFrames: 90, pin: [[foe, 16, 0], [leader, 0, 0], [f1, 1, 0], [f2, -1, 0]], refresh: [[leader, foe]] });
    ok(leader.goals.some((g) => g.kind === 'assault' && g.subjectId === foe.id),
      `warband 5: a mustered leader (band ≥ target) turns the band ONTO the believed foe — goal 'assault' (${ranA}f)`);
    st.dispose();

    // (B) a LONE would-be leader (no band) musters (recruits) first — does NOT assault alone.
    const st2 = new FeatureStage(helpers);
    const lone = st2.add('Sten', 0, 0, { personality: { risk_tolerance: 0.9 } });
    lone.canWork = true;
    for (const k in lone.needs) lone.needs[k] = 1;
    const foe2 = st2.add('Vok', 16, 0, { faction: 'bandit', combatant: true });
    lone.beliefs.observe(foe2.id, foe2.faction, foe2.pos, st2.sim.time, true);
    st2.run(() => lone.goals.some((g) => g.kind === 'muster'),
      { maxFrames: 90, pin: [[foe2, 16, 0], [lone, 0, 0]], refresh: [[lone, foe2]] });
    ok(lone.goals.some((g) => g.kind === 'muster') && !lone.goals.some((g) => g.kind === 'assault'),
      'warband 6: a LONE would-be leader musters (recruits) first — it does not assault alone');
    // ARC (docs/architecture/12 §3.5, muster-flicker fix): a muster alone — no follower ridden yet, no
    // march committed — does NOT open an arc. The arc opens LAZILY on the first real escalation, so a
    // never-escalated muster files no 0-round tale (the warband-arc-churn fix).
    ok(st2.sim.sagas.findArc('warband:' + lone.id) == null,
      'warband 7: a bare muster does NOT open a warband arc (opens lazily on the first escalation)');
    st2.dispose();
  }
}

function recruitBeliefHalf(ok, helpers) {
  {
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
  }
}

// ---- the recruiter FOLLOW-THROUGH (WARBAND, docs/architecture/10-lld §19 item 4) ----------
// Proves the missing half: a warmed candidate forms its OWN decision to MARCH with an NPC leader,
// reusing the SAME band machinery the player's Party uses (NOT a parallel system; always-live on the
// mainline). Asserts the candidate actually JOINS an NPC leader's band (the band flags flip), and
// then FOLLOWS (decide commits 'follow' once banded, off belief about the NPC leader).
function warbandFollowThrough(ok, helpers) {
  {
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
    // ARC (docs/architecture/12 §3.5, muster-flicker fix): the follower riding to the banner is the
    // FIRST real escalation — it LAZILY opens the warband arc with >= 1 round (a retained tale).
    const warArc = st.sim.sagas.findArc('warband:' + leader.id);
    ok(warArc != null && warArc.rounds >= 1,
      `warband 3b: the follower riding the banner lazily opened the warband arc with a round (rounds=${warArc && warArc.rounds})`);
    // banded, no believed-hostile near: decide() must route through _decideParty and commit 'follow'.
    st.run(() => false, { maxFrames: 20, pin: [[leader, 0, 0], [cand, 4, 0]], refresh: [[cand, leader]] });
    ok(cand.goal && cand.goal.kind === 'follow',
      `warband 4: a banded follower with no foe near commits to FOLLOW the NPC leader (goal=${cand.goal && cand.goal.kind}) — the existing follow machinery, no AI fork`);
    st.dispose();
  }
}

// ---- NPC-leader-with-flag-ON smoke (the soak-invariant guard for the live path) ------------
// A small populated run with the recruiter/warband path live stays STABLE: gold conserved to the
// cent, no freeze (the frame loop completes every frame), and the town is not wiped. The whole point
// of reusing the conserved/generic machinery is that the live path adds bands without breaking any
// hard invariant.
function warbandSmoke(ok, helpers) {
  {
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
  }
}
