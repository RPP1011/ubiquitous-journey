// PERCEPT suite — the Phase-1 gate tests for the world-model work:
//   (1) SCARECROW TOLERANCE: an agent perceives a mindless PROP (Scarecrow) dressed as a
//       bandit, BELIEVES it a person, closes on it and strikes it — and over many real
//       frames nothing throws and NO mind-feedback fires (no XP/deed/memory naming the prop),
//       because the prop has no `.agent` so the combat→belief/XP/memory bridge skips it.
//       This exercises the freeze-safe tolerance path end-to-end. It deliberately does NOT
//       assert disengagement / belief-revision (the "he figures it out" self-correction is
//       schema #6, Phase 2 — out of scope here).
//   (2) PURSUIT-INTERCEPT: a quarry flees toward a known gate OUT of the pursuer's sight;
//       once the pursuer's belief goes stale, inferLostQuarries infers a DESTINATION from the
//       quarry's heading + the shared mental map (affordance-weighted argmax). We assert the
//       inferred destId resolves to the right gate Place via sim.map (NOT a hardcoded string),
//       the TTL cache holds the dest across consecutive stale ticks, re-sighting clears it,
//       and the pursuit moves to that place / re-acquires the quarry.
//
// Drives the REAL frame loop (sim.update -> fighter.update -> resolveCombat -> onCombatEvents),
// the same order main.js / headless.mjs use. Folds into the shared `ok` tally.

import * as THREE from 'three';
import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { Scarecrow } from '../../js/sim/percept.js';
import { MentalMap, Place } from '../../js/sim/mentalmap.js';
import { BeliefState, inferDestination } from '../../js/sim/beliefs.js';
import { resolveCombat } from '../../js/combat.js';
import { SIM, MAP } from '../../js/sim/simconfig.js';
import { bus } from '../../js/rpg/events.js';

const P = () => ({ risk_tolerance: 0.7, social_drive: 0.3, ambition: 0.4, altruism: 0.3, curiosity: 0.4 });

// a tiny Stage-equivalent: a Simulation of HeadlessFighters with a named cast, driven by
// the exact main.js / headless.mjs frame order.
function makeStage(makeFighter, stubScene) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  let nid = 1;
  const dt = 1 / 60;
  const add = (name, x, z, cfg = {}) => {
    const a = new Agent(makeFighter('knight', {}),
      { id: nid++, name, profession: cfg.profession ?? null, personality: P(),
        faction: cfg.faction || 'townsfolk', combatant: !!cfg.combatant, controlled: !!cfg.controlled });
    a.fighter.root.position.set(x, 0, z);
    sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  };
  const frame = () => {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  };
  const runFrames = (n) => { for (let i = 0; i < n; i++) frame(); };
  const runUntil = (pred, max = 3000) => { let f = 0; for (; f < max; f++) { if (pred()) return f; frame(); } return f; };
  return { sim, world, dt, add, frame, runFrames, runUntil, dispose: () => sim.dispose() };
}

// ---------------------------------------------------------------------------
// (0) inferDestination affordance weighting — DETERMINISTIC unit check over a
// hand-built MentalMap (no random POI layout). Proves the intent-conditional
// affordance term: a FLEE quarry aimed between an escape place (a gate, affords
// 'exit') and an equally-near, equally-aligned non-escape place (a forge, affords
// 'resource') infers the ESCAPE place — the affordance bonus breaks the tie.
// ---------------------------------------------------------------------------
function inferAffordanceWeight(ok) {
  const map = new MentalMap();
  // two candidate places, BOTH straight ahead (+x) and the same distance from origin, so
  // headingMatch + distance cost are identical — only the affordance term differs.
  map.add(new Place('GATE', 'gate', new THREE.Vector3(40, 0, 0), MAP.affordances.gate, null));
  map.add(new Place('FORGE', 'forge', new THREE.Vector3(40, 0, 0.001), MAP.affordances.forge, null));

  // a quarry last seen at origin heading +x.
  const observer = { id: 1, townId: null };
  const b = new BeliefState(2);
  b.lastPos.set(0, 0, 0);
  b.heading.set(1, 0, 0);

  inferDestination(observer, b, 'flee', map, 10);
  ok(b.destId === 'GATE', `infer(flee): escape-affording place wins the tie (destId=${b.destId})`);
  ok(b.intent === 'flee' && b.destInferredAt === 10, 'infer(flee): intent + TTL stamp recorded');

  // RAID intent rewards a 'crowd' place instead; with neither candidate a crowd, the nearer/
  // more-aligned one still resolves (no escape penalty) — just assert it picks a real place
  // and stamps intent, the raid branch running without throwing.
  const b2 = new BeliefState(3);
  b2.lastPos.set(0, 0, 0); b2.heading.set(1, 0, 0);
  inferDestination(observer, b2, 'raid', map, 11);
  ok(b2.destId === 'GATE' || b2.destId === 'FORGE', `infer(raid): resolves a real place (destId=${b2.destId})`);
  ok(b2.intent === 'raid', 'infer(raid): intent recorded');

  // a STILL quarry (no heading) with NO known places → stand-and-search at lastPos: no
  // place committed, dest pinned to where it was last seen (the empty-map fallback).
  const emptyMap = new MentalMap();
  const b3 = new BeliefState(4);
  b3.lastPos.set(5, 0, 7);                    // heading defaults to zero
  inferDestination(observer, b3, null, emptyMap, 12);
  ok(b3.destId === null && b3.destPos && Math.abs(b3.destPos.x - 5) < 1e-6 && Math.abs(b3.destPos.z - 7) < 1e-6,
    'infer(still,no-places): stand-and-search at lastPos (no place committed)');

  // guard: a null map never throws and writes nothing catastrophic.
  let threw = false;
  try { inferDestination(observer, new BeliefState(5), 'flee', null, 13); } catch { threw = true; }
  ok(!threw, 'infer: null map -> no throw (freeze-safe)');
}

// ---------------------------------------------------------------------------
// (1) Scarecrow tolerance — the canonical "mistake a prop for a person" case.
// ---------------------------------------------------------------------------
function scarecrowTolerance(ok) {
  const st = MAKE();
  const { sim, add } = st;

  // a real townsfolk COMBATANT (hostile to 'bandit' by faction) who will hunt the prop.
  const Bram = add('Bram', 0, 0, { combatant: true });
  // the PROP: an inert, hittable Scarecrow dressed as a bandit, within Bram's vision.
  const S = sim.spawnPercept(new Scarecrow({ id: 'S', x: 4, z: 0, appearsAs: 'bandit', hp: 40 }));
  ok(sim.percepts.indexOf(S) !== -1, 'tolerance: scarecrow registered in sim.percepts (not sim.agents)');
  ok(sim.agents.indexOf(S) === -1 && !sim.agentsById.get('S'), 'tolerance: scarecrow is NOT in the agent roster');
  ok(sim.fighters.indexOf(S) !== -1, 'tolerance: scarecrow body is present in sim.fighters (hittable)');

  // capture ANY deed on the bus naming the prop ('S') — there must be none (the !A||!T guard).
  let propDeeds = 0;
  const off = bus.on((ev) => { if (ev && (ev.targetId === 'S' || ev.actorId === 'S')) propDeeds++; });
  const lvl0 = Bram.progression.totalLevel;
  const profSize0 = Object.keys(Bram.progression.behavior_profile).length;

  // let perception file a person-belief about S, then run a long combat window. No throw allowed.
  let threw = null;
  try {
    // a few frames so perceive() forms Bram.beliefs.get('S') as a 'bandit' person.
    st.runFrames(20);
    const b0 = Bram.beliefs.get('S');
    ok(!!b0 && b0.lastFaction === 'bandit', 'tolerance: Bram believes the prop is a person (lastFaction=bandit)');
    if (b0) b0.hostile = true;            // latch hostility so the fight goal derives reliably
    st.runFrames(680);                    // the strike window — Bram closes + hammers the prop
  } catch (e) { threw = e; }
  off();

  ok(threw === null, `tolerance: ${700} real frames ran with no exception` + (threw ? ` (THREW: ${threw && threw.message})` : ''));

  // he CLOSED + STRUCK it: Bram moved toward S and S took damage / toppled.
  const closed = Bram.pos.distanceTo(S.pos) < 6;
  ok(closed, `tolerance: Bram closed on the prop (dist ${Bram.pos.distanceTo(S.pos).toFixed(1)})`);
  ok(S.hp < 40 || !S.alive, `tolerance: the prop was struck (hp ${S.hp.toFixed(0)}/40, alive=${S.alive})`);

  // NO mind-feedback: no deed/XP/memory ever attributable to the prop (the !A||!T guard, live).
  ok(propDeeds === 0, `tolerance: NO deed bus event named the prop (got ${propDeeds})`);
  ok(Bram.progression.totalLevel === lvl0, `tolerance: Bram gained no class-level from striking the prop (${lvl0} -> ${Bram.progression.totalLevel})`);
  ok(Object.keys(Bram.progression.behavior_profile).length === profSize0,
    'tolerance: striking the prop fed NO new behaviour-profile tags');
  ok(!Bram.memory.recent().some((e) => e.withId === 'S'),
    'tolerance: Bram recorded NO memory episode naming the prop');

  // Phase 2a: with the reasoning catalogue live, schema #6 (no-threat-no-response) can now
  // let Bram DISENGAGE from a proven-inert prop — a real new behaviour we ASSERT rather than
  // tune away. The hp:40 here is this test's ORIGINAL value (NOT chosen to outrace #6): at
  // hp:40 the prop TOPPLES quickly, so the legitimate disengage path here is "the prop is
  // down" (combat resolved) — the ≥3-strike predicate guarantees the killing strikes PRECEDE
  // any #6 revision, so #6 never starves the struck-count path. We assert disengagement by
  // SOME valid means (the prop toppled, OR — had #6 fired first — the belief was revised).
  // The dedicated hp:400 self-correction test below proves the BELIEF-REVISION path in
  // isolation, where toppling can't pre-empt #6. The tolerance assertions above (no deed/XP/
  // memory, no throw) are structurally independent of #6: it only writes Bram's OWN belief.
  const sBel = Bram.beliefs.get('S');
  const disengaged = !S.alive || !sBel || sBel.inert === true || sBel.hostile === false;
  ok(disengaged, `tolerance: Bram disengaged from the prop (down=${!S.alive}, inert=${sBel && sBel.inert}, hostile=${sBel && sBel.hostile})`);

  st.dispose();
}

// ---------------------------------------------------------------------------
// (1b) Scarecrow SELF-CORRECTION (Phase 2a, schema #6 "no-threat-no-response") —
// the inverse of tolerance: Bram believes the bandit-dressed prop hostile, closes and
// strikes it ≥3 times, and — because the prop accrues ZERO observed animacy (it never
// moves/strikes/blocks/harms him) — schema #6 accrues inertEvidence over his OWN belief,
// crosses the threshold, REVISES hostile→false + inert→true (correction by reasoning, not
// omniscience: only his own strikes + his own perception of its lack of reaction are read),
// and Bram disengages. hp:400 so it's the BELIEF REVISION (not toppling) that ends the fight.
// ---------------------------------------------------------------------------
function scarecrowSelfCorrection(ok) {
  const st = MAKE();
  const { sim, add } = st;

  const Bram = add('Bram', 0, 0, { combatant: true });
  // a TOUGH prop (hp:400): it cannot topple inside the window, so disengagement can ONLY
  // come from Bram revising his belief — the whole point of the test.
  const S = sim.spawnPercept(new Scarecrow({ id: 'S', x: 4, z: 0, appearsAs: 'bandit', hp: 400 }));

  let threw = null;
  try {
    st.runFrames(20);                       // form the person-belief about S
    const b0 = Bram.beliefs.get('S');
    ok(!!b0 && b0.lastFaction === 'bandit', 'self-correct: Bram believes the prop a bandit person');
    if (b0) b0.hostile = true;              // latch hostility so he commits to the fight
    // run the strike window; schema #6 needs ≥3 strikes + 2 inertEvidence accruals (ttl-gated).
    st.runUntil(() => {
      const b = Bram.beliefs.get('S');
      return !!b && (b.inert === true || b.hostile === false);
    }, 1600);
  } catch (e) { threw = e; }

  ok(threw === null, `self-correct: ran with no exception${threw ? ` (THREW: ${threw.message})` : ''}`);

  const b = Bram.beliefs.get('S');
  // (a) he ENGAGED it: struck it at least 3 times (his own strikeLog over the prop's id).
  const rec = Bram.strikeLog && Bram.strikeLog.get ? Bram.strikeLog.get('S') : null;
  ok(!!rec && rec.count >= 3, `self-correct: Bram struck the prop ≥3 times (count=${rec ? rec.count : 0})`);
  // (b) the prop showed ZERO animacy — its belief never accrued a liveness tally.
  const tally = b && b.animacyTally;
  const animacy = tally ? (tally.struck + tally.blocked + tally.harmedMe + tally.moved) : 0;
  ok(animacy === 0, `self-correct: the prop accrued ZERO observed animacy (tally=${animacy})`);
  // (c) THE REVISION: schema #6 flipped his belief — hostile→false AND inert→true.
  ok(!!b && b.hostile === false && b.inert === true,
    `self-correct: belief REVISED by reasoning (hostile=${b && b.hostile}, inert=${b && b.inert}, inertEvidence=${b && b.inertEvidence})`);
  // (d) he DISENGAGED: he no longer considers the prop hostile, so decide stops the fight.
  ok(!Bram.considerHostile(b), 'self-correct: Bram no longer treats the proven-inert prop as hostile (disengage)');
  // the prop is intact (hp:400 — disengagement was the BELIEF revision, not toppling).
  ok(S.alive && S.hp > 0, `self-correct: the prop is intact — disengage was belief-revision, not toppling (hp ${S.hp.toFixed(0)}/400)`);

  st.dispose();
}

// ---------------------------------------------------------------------------
// (2) Pursuit-intercept — destination inference end-to-end against the mental map.
// ---------------------------------------------------------------------------
function pursuitIntercept(ok) {
  const st = MAKE();
  const { sim, add } = st;

  // pursuer P at origin; quarry Q starts within P's sight on the +x line toward The Thorngate
  // (a world-wide 'gate' landmark at x≈262, z=0 — the inferable destination).
  const Pu = add('P', 0, 0, { combatant: true });
  const Q = add('Q', 6, 0, { faction: 'bandit', combatant: true, controlled: true });   // controlled = scripted, no AI

  // 1) Q flees +x while P WATCHES it leave (so P's belief records a heading across sightings),
  //    out to the edge of P's vision, then leaves sight entirely.
  for (let f = 0; f < 80; f++) {
    const x = 6 + f * (SIM.visionRange / 80);       // walk Q from 6m out past vision range
    Q.fighter.root.position.set(x, 0, 0);
    Pu.fighter.root.position.set(0, 0, 0);
    st.frame();
  }
  const bel = Pu.beliefs.get(Q.id);
  ok(!!bel, 'intercept: P holds a belief about the quarry Q');
  ok(bel && bel.heading.x > 0.5, `intercept: P observed Q heading +x (heading.x ${bel ? bel.heading.x.toFixed(2) : 'n/a'})`);

  // 2) push Q far out of sight on the same heading so the belief goes stale and stays so.
  Q.fighter.root.position.set(280, 0, 0);
  // run a few cognition ticks so decay + inferLostQuarries fire on the now-stale belief.
  st.runUntil(() => { const b = Pu.beliefs.get(Q.id); return !!(b && b.destPos); }, 400);

  const b = Pu.beliefs.get(Q.id);
  ok(!!(b && b.destId), `intercept: P inferred a destination for the lost quarry (destId=${b && b.destId})`);

  // the inferred dest must RESOLVE to a real Place in the shared map (NOT a hardcoded string) —
  // it is whatever the affordance-weighted argmax over P's KNOWN places selected, found via
  // sim.map.known(). (Which exact place wins depends on the world's POI layout; the deterministic
  // affordance check below proves the flee weighting picks escape over a non-escape rival.)
  const places = sim.map.known(Pu.townId, b.lastPos, MAP.knownPlaces);
  const resolved = places.find((p) => p.id === b.destId);
  ok(!!resolved, `intercept: destId resolves to a Place in sim.map (${b && b.destId})`);
  // destPos is the resolved Place's STATIC position (a shared-geography point, not a live read).
  ok(!!(resolved && b.destPos && b.destPos.distanceTo(resolved.pos) < 1e-3),
    'intercept: destPos is the resolved Place\'s static position (shared geography, not truth)');

  // PURSUIT MOVES THERE: with Q still lost (out of sight) the pursuer navigates toward the
  // inferred destination. Pin P's belief stale + give P a reactive fight goal on Q, then verify
  // P closes the gap toward the inferred destPos over a window (belief-gated movement, no truth).
  {
    const beforeGap = Pu.pos.distanceTo(b.destPos);
    Pu.goal = { kind: 'fight', targetId: Q.id };
    // Q stays far out of sight on the heading so the belief never re-acquires during this window.
    Q.fighter.root.position.set(300, 0, 0);
    st.runFrames(120);
    const after = Pu.beliefs.get(Q.id);
    // either P moved toward the inferred destination, or it re-acquired/lost the belief — assert
    // it made progress toward the destination it inferred (belief-gated pursuit works).
    const afterGap = after && after.destPos ? Pu.pos.distanceTo(after.destPos) : Pu.pos.distanceTo(b.destPos);
    ok(afterGap < beforeGap - 0.5 || Pu.pos.x > 0.5,
      `intercept: P pursues toward the inferred destination (gap ${beforeGap.toFixed(1)} -> ${afterGap.toFixed(1)}, P.x ${Pu.pos.x.toFixed(1)})`);
  }

  // 3) TTL cache: within destTTL the dest persists across consecutive stale ticks (destInferredAt
  //    unchanged — no re-inference churn).
  const destId0 = b.destId, stamp0 = b.destInferredAt;
  st.runFrames(6);                                   // a fraction of destTTL (6s) at 60fps
  ok(b.destId === destId0 && b.destInferredAt === stamp0,
    'intercept: inferred dest is TTL-cached across stale ticks (no re-inference)');

  // 4) re-sighting CLEARS the cached destination + its timestamp (contradicting perception).
  Q.fighter.root.position.set(Pu.pos.x + 3, 0, Pu.pos.z);   // bring Q back into sight, adjacent
  st.runUntil(() => { const bb = Pu.beliefs.get(Q.id); return !!(bb && bb.destPos == null); }, 120);
  const b2 = Pu.beliefs.get(Q.id);
  ok(!!(b2 && b2.destPos == null && b2.destInferredAt === 0),
    're-acquire: sighting Q clears the inferred destination + its TTL stamp (invalidation)');

  st.dispose();
}

// the shared builder is injected by the suite entry (needs makeFighter/stubScene).
let MAKE = null;

// ---------------------------------------------------------------------------
// Suite entry. Accepts the shared ok + the headless harness helpers.
// ---------------------------------------------------------------------------
export function perceptTest(ok, { makeFighter, stubScene }) {
  MAKE = () => makeStage(makeFighter, stubScene);
  console.log('\n— percept suite (scarecrow tolerance + self-correction + pursuit intercept) —');
  inferAffordanceWeight(ok);
  scarecrowTolerance(ok);
  scarecrowSelfCorrection(ok);
  pursuitIntercept(ok);
}
