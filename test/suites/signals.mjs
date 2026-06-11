// ---- the narrative-signal catalog + the status-delta sensor (docs/architecture/13 + 12 §5) ------
// Drives the signal store + statusSensor DIRECTLY against fake agents/sim so the gating is
// deterministic. The gates are the doc-13 §10 regressions the reviews demanded:
//   S1  transfer fold     — a robbery vs an equal-size purchase: SAME goldFast drop, DIFFERENT
//                           lossReason mix; RUIN fires only on the robbery (review-3 regression).
//   S2  hysteresis        — ruin → recover past recoverFrac → fall again ⇒ fires TWICE (rule 3).
//   S4  snubsFelt feeds   — true mean collapses with ZERO snubs ⇒ SHUNNED beat fires, `slandered`
//                           memory does NOT; three snubs ⇒ the memory fires (review-1 regression).

import { foldLoss, noteSnub, lossReasonShare, snubsFelt, goldTrend, sampleGold,
  foldDeed, deedCount, foldOathSworn, foldOathPop, oaths, notePeaceBreak, peaceClock,
  foldScarcity, scarcityMean, foldGrievance, grievanceOf, isOneSided,
  esteemTruthGap, doomedVenture, misallocatedSuspicion,
  foldStreak, streakOf, foldPeril, perilsSurvived, firstDeedAt, debtBetween,
  wealthGini, suspicionClimate, arcLoad,
  sampleStanding, standingTrend, fortuneReversals, sampleDisplacement, displacement,
  accrueBand, timeInBand, regardGap, dependence, foldObligationDefault, defaultsOf, creditLoad,
  cohesion, presumedDead, loversCrossed, rumourDepth, noteBeat, quietIndex,
  noteWitness, witnessSet, triangleHints } from '../../js/sim/signals.js';
import { statusSensor } from '../../js/sim/statusSensor.js';
import { gossipBeliefs } from '../../js/sim/agent/perception.js';
import { SagaStore } from '../../js/sim/arcs.js';
import { BeliefState, BeliefStore } from '../../js/sim/beliefs.js';
import { recognizeWealth } from '../../js/sim/agent/decide.js';
import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { setSeed } from '../../js/sim/rng.js';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';

// a real THREE.Vector3 — observe() does lastPos.copy(pos), so a plain {x,z} won't do.
function vec3(x, y, z) { return new THREE.Vector3(x, y, z); }

function mkAgent(id, gold, name = 'A' + id) {
  return {
    id, name, gold, alive: true, controlled: false, faction: 'townsfolk',
    beliefs: new Map(),
    memory: { eps: [], record(ep) { this.eps.push(ep); } },
  };
}
function mkSim(agents) {
  const sim = { time: 0, agents, agentsById: new Map(agents.map((a) => [a.id, a])),
    chronicle: { notes: [], note(kind, subj, text) { this.notes.push({ kind, subj, text }); } } };
  sim.sagas = new SagaStore(sim);
  return sim;
}
const kinds = (a) => a.memory.eps.map((e) => e.kind);

export function signalsTest(ok) {
  // S1 — transfer fold + ruin gating. Two agents, identical gold trajectory (100 → 50); one ROBBED,
  // one SPENT. Same goldFast; only the robbery has an involuntary loss share ⇒ only it ruins.
  {
    const robbed = mkAgent(1, 100), spender = mkAgent(2, 100);
    const sim = mkSim([robbed, spender, mkAgent(9, 50)]);   // a 3rd holds no beliefs → mean 0 (no shun)
    // t=0 baseline sample (fast=slow=100), then the loss, then sample again at t=130.
    sim.time = 0; statusSensor(robbed, sim, 0); statusSensor(spender, sim, 0);
    robbed.gold = 50; foldLoss(robbed, 'robbed', 50, 0);
    spender.gold = 50; foldLoss(spender, 'spent', 50, 0);
    sim.time = 130; statusSensor(robbed, sim, 130); statusSensor(spender, sim, 130);

    const tr = goldTrend(robbed), ts = goldTrend(spender);
    ok(Math.abs(tr.fast - ts.fast) < 1e-6 && Math.abs(tr.slow - ts.slow) < 1e-6,
      `signals S1: a robbery and an equal purchase produce the SAME goldFast/Slow (${tr.fast.toFixed(1)})`);
    ok(lossReasonShare(robbed, ['robbed', 'fined'], 300, 130) === 1 && lossReasonShare(spender, ['robbed', 'fined'], 300, 130) === 0,
      'signals S1: the involuntary loss share differs (robbed 1.0 vs spent 0.0)');
    ok(kinds(robbed).includes('ruined'), 'signals S1: RUIN fires on the robbery (fast fall + involuntary cause)');
    ok(!kinds(spender).includes('ruined'), 'signals S1: RUIN does NOT fire on the equal voluntary spend-down');
  }

  // S2 — hysteresis: ruin → recover past the band → fall again ⇒ the `ruined` memory fires TWICE.
  {
    const a = mkAgent(1, 100);
    const sim = mkSim([a, mkAgent(9, 50)]);
    sim.time = 0; statusSensor(a, sim, 0);
    a.gold = 50; foldLoss(a, 'robbed', 50, 0);
    sim.time = 130; statusSensor(a, sim, 130);
    ok(kinds(a).filter((k) => k === 'ruined').length === 1, 'signals S2: ruin fires once on the first fall');
    // RECOVER: gold back to 100, sampled long enough that fast climbs back past the recover band.
    a.gold = 100;
    sim.time = 1200; statusSensor(a, sim, 1200);     // fast & slow both relax up to ~100 → _ruined clears
    // FALL AGAIN: a fresh robbery drops it once more.
    a.gold = 50; foldLoss(a, 'robbed', 50, 1200);
    sim.time = 1330; statusSensor(a, sim, 1330);
    ok(kinds(a).filter((k) => k === 'ruined').length === 2, 'signals S2: a second fall after recovery fires ruin AGAIN (hysteresis)');
  }

  // S4 — snubsFelt is the slander gate, NOT the roster mean. Part A: the true mean collapses with
  // ZERO perceivable snubs ⇒ the SHUNNED beat fires (narrator) but the `slandered` memory does not.
  {
    const a = mkAgent(1, 100);
    const h1 = mkAgent(2, 100), h2 = mkAgent(3, 100);
    h1.beliefs.set(a.id, { standing: -0.5 }); h2.beliefs.set(a.id, { standing: -0.5 });   // true mean -0.5
    const sim = mkSim([a, h1, h2]);
    sim.time = 0; statusSensor(a, sim, 0);
    ok(sim.chronicle.notes.some((n) => n.kind === 'shunned'), 'signals S4: the SHUNNED beat fires off the true roster mean (narrator)');
    ok(!kinds(a).includes('slandered'), 'signals S4: with ZERO perceivable snubs, the `slandered` MEMORY does NOT fire');
    // Part B: three felt snubs ⇒ the memory now fires (perceivable evidence the victim accumulated).
    noteSnub(a, 1); noteSnub(a, 1); noteSnub(a, 1);
    sim.time = 1; statusSensor(a, sim, 1);
    ok(kinds(a).includes('slandered'), 'signals S4: three felt snubs DO fire the `slandered` memory');
  }

  // never throws on a bare agent (the freeze lesson).
  {
    let threw = false;
    try { sampleGold({ id: 7 }, 0); foldLoss(null, 'x', 1, 0); snubsFelt({ id: 7 }, 0); statusSensor({ id: 7 }, mkSim([]), 0); }
    catch { threw = true; }
    ok(!threw, 'signals: malformed/missing inputs never throw');
  }
}

// ---- TASK A: gossip-about-self feeds snubsFelt (docs/architecture/13 §3 snubsFelt) --------------
// When an agent PERCEIVES a chatting neighbour holding a NEGATIVE opinion of ITSELF (soured standing
// and/or raised suspicion), it overhears them speaking ill of it — a perceivable snub that bumps
// snubsFelt (the own-state input for `slandered`). Positive / neutral / other-subject gossip does NOT.
// Driven through the real gossipBeliefs bridge with real BeliefStores for determinism.
export function gossipSnubTest(ok) {
  // a chatting agent `a` (the receiver/overhearer) beside a neighbour `o` (the teller). Place them
  // within talkRange and give each a real BeliefStore so gossipBeliefs iterates them as in the sim.
  const mk = (id) => {
    const a = {
      id, alive: true, controlled: false, faction: 'townsfolk',
      pos: vec(0, 0), beliefs: new BeliefStore(id),
    };
    return a;
  };
  const ctx = { time: 10, agents: [] };
  const run = (recv, teller) => { ctx.agents = [recv, teller]; gossipBeliefs(recv, ctx); };

  // A1 — a teller who SOURED on me (standing well below the snub bar) ⇒ I feel a snub.
  {
    const a = mk(1), o = mk(2); o.pos = vec(1, 0);   // adjacent
    const tb = o.beliefs._ensure(a.id); tb.standing = -0.6; tb.confidence = 0.9;
    run(a, o);
    ok(snubsFelt(a, 10) >= 1, `gossip A1: overhearing a neighbour who SOURED on me bumps snubsFelt (${snubsFelt(a, 10).toFixed(2)})`);
  }
  // A2 — a teller who merely SUSPECTS me (suspicion above the bar, standing neutral) ⇒ also a snub.
  {
    const a = mk(1), o = mk(2); o.pos = vec(1, 0);
    const tb = o.beliefs._ensure(a.id); tb.standing = 0; tb.suspicion = 0.5; tb.confidence = 0.9;
    run(a, o);
    ok(snubsFelt(a, 10) >= 1, `gossip A2: overhearing a neighbour who SUSPECTS me bumps snubsFelt (${snubsFelt(a, 10).toFixed(2)})`);
  }
  // A3 — a teller who likes me (positive standing, no suspicion) ⇒ NO snub.
  {
    const a = mk(1), o = mk(2); o.pos = vec(1, 0);
    const tb = o.beliefs._ensure(a.id); tb.standing = 0.5; tb.confidence = 0.9;
    run(a, o);
    ok(snubsFelt(a, 10) === 0, 'gossip A3: a neighbour who LIKES me produces no snub');
  }
  // A4 — a teller holding only OTHER-subject opinions (a sour view of #9, none of me) ⇒ NO snub.
  {
    const a = mk(1), o = mk(2); o.pos = vec(1, 0);
    const ob = o.beliefs._ensure(9); ob.standing = -0.9; ob.confidence = 0.9;   // hates #9, not me
    run(a, o);
    ok(snubsFelt(a, 10) === 0, 'gossip A4: a teller souring on a THIRD party (not me) produces no snub');
  }
  // A5 — bounded: one ingest pass yields at most one snub (the `break` limits to one partner/tick).
  {
    const a = mk(1), o = mk(2); o.pos = vec(1, 0);
    const tb = o.beliefs._ensure(a.id); tb.standing = -0.9; tb.confidence = 0.9;
    run(a, o);
    const after1 = snubsFelt(a, 10);
    ok(after1 >= 1 && after1 < 2, `gossip A5: a single ingest pass yields at most one snub (${after1.toFixed(2)})`);
  }
}

// ---- believed-wealth field + recognition channel (docs/architecture/12 §6) ---------------------
// W1 the cue bridge firms believedWealth + wealthConf; W2 decay fades the confidence; W3 the
// recognition channel WARMS a deferential agent's standing toward a believed-rich, non-suspect local
// and W4 the envious mirror COOLS a proud-and-self-serving one (review 6); W5 a believed-SUSPECT
// local earns no deference.
export function wealthTest(ok) {
  // W1 — recordWealthCue nudges the estimate toward `implies` and firms confidence (evidence-accrual).
  {
    const b = new BeliefState(5);
    ok(b.believedWealth === 0 && b.wealthConf === 0, 'wealth W1: a fresh belief holds no wealth estimate');
    b.recordWealthCue(0.8, 0.5); b.recordWealthCue(0.8, 0.5);
    ok(b.believedWealth > 0.4 && b.wealthConf > 0.5, `wealth W1: a repeated cue firms the estimate (w=${b.believedWealth.toFixed(2)} c=${b.wealthConf.toFixed(2)})`);
  }

  // W3/W4 — the recognition channel: a deferential observer warms, an envious one cools, toward a
  // confidently-believed-rich, non-suspect subject. Build a belief store on each observer.
  const mkObs = (pers) => {
    const a = { id: 1, personality: pers, beliefs: new Map() };
    const b = new BeliefState(2); b.believedWealth = 0.9; b.wealthConf = 0.9; b.standing = 0; b.suspicion = 0;
    a.beliefs.set(2, b); a.beliefs.map = a.beliefs;   // recognizeWealth reads beliefs.map.values()
    return { a, b };
  };
  {
    const { a, b } = mkObs({ altruism: 0.7, ambition: 0.3, social_drive: 0.6 });   // deferential
    recognizeWealth(a);
    ok(b.standing > 0, `wealth W3: a deferential agent WARMS toward the believed-rich (${b.standing.toFixed(3)})`);
  }
  {
    const { a, b } = mkObs({ altruism: 0.2, ambition: 0.8, social_drive: 0.3 });   // proud + self-serving
    recognizeWealth(a);
    ok(b.standing < 0, `wealth W4: an envious agent COOLS toward the believed-rich (the envious mirror) (${b.standing.toFixed(3)})`);
  }
  // W5 — a believed-SUSPECT rich local earns no deference (the suspect gate).
  {
    const { a, b } = mkObs({ altruism: 0.7, ambition: 0.3, social_drive: 0.6 });
    b.suspicion = 0.9;
    recognizeWealth(a);
    ok(b.standing === 0, 'wealth W5: a believed-suspect rich local earns no deference (suspect gate)');
  }
}

// ---- the broader doc-13 catalog: Families C/D/E priority-cut signals -----------------------------
// deedLedger, oaths(with pop reasons), peaceClock, scarcity, grievance(slope/one-sidedness), and the
// irony probes esteemTruthGap / doomedVenture / misallocatedSuspicion. Driven directly for determinism.
export function catalogTest(ok) {
  // E.deedLedger — counts by tag.
  {
    const a = { id: 1 };
    foldDeed(a, 'theft', 0); foldDeed(a, 'theft', 5); foldDeed(a, 'rescue', 9);
    ok(deedCount(a, 'theft') === 2 && deedCount(a, 'rescue') === 1, 'catalog deedLedger: deeds tally by tag');
  }
  // E.oaths — sworn + kept/abandoned by POP REASON (rule 4).
  {
    const a = { id: 1 };
    foldOathSworn(a, 'avenge'); foldOathSworn(a, 'avenge'); foldOathPop(a, 'avenge', 'kept'); foldOathPop(a, 'avenge', 'abandoned');
    const t = oaths(a).avenge;
    ok(t.sworn === 2 && t.kept === 1 && t.abandoned === 1, 'catalog oaths: sworn vs kept vs abandoned recorded with the reason');
  }
  // D.peaceClock — time since the last violent townsperson death.
  {
    const sim = { };
    notePeaceBreak(sim, 100);
    ok(peaceClock(sim, 130) === 30, 'catalog peaceClock: counts the quiet since the last killing');
  }
  // D.scarcity — the long-run price mean tracks (a glut pulls it down, a famine up).
  {
    const sim = { };
    foldScarcity(sim, 'food', 4, 0); foldScarcity(sim, 'food', 12, 600);
    const mean = scarcityMean(sim, 'food');
    ok(mean > 4 && mean < 12, `catalog scarcity: the long-run mean tracks the clearing price (${mean.toFixed(1)})`);
  }
  // B.grievance — rounds + ONE-SIDEDNESS (all blows one direction = persecution, not a feud).
  {
    const sim = { };
    foldGrievance(sim, 1, 2, 0); foldGrievance(sim, 1, 2, 10); foldGrievance(sim, 1, 2, 20);   // 1 always strikes 2
    const g = grievanceOf(sim, 2, 1);
    ok(g && g.rounds === 3, 'catalog grievance: blows tally as rounds (order-normalised key)');
    ok(isOneSided(g), 'catalog grievance: all blows one direction reads as ONE-SIDED (persecution)');
    foldGrievance(sim, 2, 1, 30);   // 2 strikes back → no longer one-sided
    ok(!isOneSided(grievanceOf(sim, 1, 2)), 'catalog grievance: a blow returned makes it a two-sided feud');
  }
  // C.esteemTruthGap — the CELEBRATED VILLAIN (esteemed despite dark deeds).
  {
    const villain = { id: 1, gold: 10, alive: true };
    foldDeed(villain, 'theft', 0); foldDeed(villain, 'kill', 0);
    const fan = { id: 2, alive: true, beliefs: new Map([[1, { standing: 0.7, believedWealth: 0.2, suspicion: 0 }]]) };
    const sim = { agents: [villain, fan], agentsById: new Map([[1, villain], [2, fan]]) };
    const gap = esteemTruthGap(sim, villain);
    ok(gap.standingGap > 0 && gap.darkDeeds === 2, `catalog esteemTruthGap: a celebrated villain reads a positive standing gap (${gap.standingGap.toFixed(2)})`);
  }
  // C.doomedVenture — hunting the already-dead ("marching on a ghost").
  {
    const ghost = { id: 9, alive: false };
    const hunter = { id: 1, goals: [{ kind: 'avenge', subjectId: 9 }] };
    const sim = { agents: [hunter, ghost], agentsById: new Map([[9, ghost], [1, hunter]]) };
    ok(doomedVenture(sim, hunter) === true, 'catalog doomedVenture: an avenge goal on a dead target is a doomed venture');
  }
  // C.misallocatedSuspicion — the innocent accused (suspicion with no true theft).
  {
    const innocent = { id: 1, alive: true };   // no theft deeds
    const a = { id: 2, alive: true, beliefs: new Map([[1, { suspicion: 0.6 }]]) };
    const b = { id: 3, alive: true, beliefs: new Map([[1, { suspicion: 0.5 }]]) };
    const sim = { agents: [innocent, a, b], agentsById: new Map() };
    ok(misallocatedSuspicion(sim, innocent) > 0.5, 'catalog misallocatedSuspicion: suspicion of an innocent (no theft) is flagged');
  }

  // A.streak — consecutive same-status outcomes per strategy; a different status resets the run.
  {
    const a = { id: 1 };
    foldStreak(a, 'burgle', 'shortfall', 0); foldStreak(a, 'burgle', 'shortfall', 1); foldStreak(a, 'burgle', 'shortfall', 2);
    ok(streakOf(a, 'burgle').run === 3 && streakOf(a, 'burgle').status === 'shortfall', 'catalog streak: three failures in a row read run=3');
    foldStreak(a, 'burgle', 'windfall', 3);
    ok(streakOf(a, 'burgle').run === 1, 'catalog streak: a different outcome resets the run');
  }
  // E.perilsSurvived + firsts.
  {
    const a = { id: 1 };
    foldPeril(a, 0); foldPeril(a, 5);
    ok(perilsSurvived(a) === 2, 'catalog perilsSurvived: peril outcomes tally');
    foldDeed(a, 'theft', 12);
    ok(firstDeedAt(a, 'theft') === 12 && firstDeedAt(a, 'kill') === null, 'catalog firsts: the first-deed timestamp is recorded');
  }
  // B.debt — net unpaid obligation to a counterparty (a pure read over the ledger).
  {
    const a = { id: 1, _obligations: [{ action: 'pay', counterparty: 7, amount: 5 }, { action: 'pay', counterparty: 7, amount: 3 }, { action: 'pay', counterparty: 9, amount: 2 }] };
    ok(debtBetween(a, 7) === 8 && debtBetween(a, 9) === 2, 'catalog debt: net obligation summed per counterparty');
  }
  // D.wealthGini + suspicionClimate.
  {
    const mk = (id, gold) => ({ id, gold, alive: true, controlled: false, faction: 'townsfolk', beliefs: { all: () => [] } });
    const equal = { agents: [mk(1, 50), mk(2, 50), mk(3, 50)] };
    const skew = { agents: [mk(1, 0), mk(2, 0), mk(3, 150)] };
    ok(wealthGini(equal) < 0.05, `catalog wealthGini: an equal town reads ~0 (${wealthGini(equal).toFixed(2)})`);
    ok(wealthGini(skew) > 0.5, `catalog wealthGini: one house holding it all reads high (${wealthGini(skew).toFixed(2)})`);
    const villainEra = { agents: [
      { id: 2, alive: true, controlled: false, beliefs: { all: () => [{ subjectId: 99, suspicion: 0.8 }] } },
      { id: 3, alive: true, controlled: false, beliefs: { all: () => [{ subjectId: 99, suspicion: 0.7 }] } },
    ] };
    const clim = suspicionClimate(villainEra);
    ok(clim.mass > 1 && clim.top1Share > 0.9, `catalog suspicionClimate: a NAMED-villain era concentrates suspicion (top1 ${clim.top1Share.toFixed(2)})`);
  }
  // F.arcLoad — open arcs sharing an agent as principal.
  {
    const sim = { time: 0, agentsById: new Map(), chronicle: { note() {} } };
    sim.sagas = new SagaStore(sim);
    sim.sagas.openArc({ kind: 'vendetta', key: 'v', principals: [1, 2] });
    sim.sagas.openArc({ kind: 'rescue', key: 'r', principals: [1, 9] });
    ok(arcLoad(sim, { id: 1 }) === 2 && arcLoad(sim, { id: 2 }) === 1, 'catalog arcLoad: counts open arcs by principal (protagonist pressure)');
  }
}

// ---- the doc-13 SECOND SLICE: the catalog tail folded on existing seams --------------------------
// standingFast/Slow + fortuneReversals + displacement + timeInBand (A); regardGap + dependence +
// triangleHints (B); presumedDead + loversCrossed (C); creditLoad + cohesion (D); rumourDepth +
// quietIndex + witnessSet (F). Driven directly for determinism (same house pattern).
function vec(x, z) { return { x, z, distanceTo(p) { return Math.hypot((p.x || 0) - x, (p.z || 0) - z); } }; }

export function catalogTailTest(ok) {
  // A.standingFast/Slow — two EWMAs of the roster mean; a sharp social drop pulls fast below slow.
  {
    const a = { id: 1, gold: 100 };
    sampleStanding(a, 0.5, 0); sampleStanding(a, 0.5, 600);   // settle both EWMAs near +0.5
    sampleStanding(a, -0.5, 720);                              // a sharp cooling — fast moves first
    const tr = standingTrend(a);
    ok(tr.fast < tr.slow, `tail standing: a sharp social cooling pulls standingFast below standingSlow (${tr.fast.toFixed(2)} < ${tr.slow.toFixed(2)})`);
  }
  // A.fortuneReversals — a (goldFast−goldSlow) sign flip past the gate increments the counter.
  {
    const a = { id: 1, gold: 100 };
    sampleGold(a, 0); sampleGold(a, 600);            // settle fast/slow near 100 (gap ~0)
    a.gold = 0; sampleGold(a, 700); sampleStanding(a, 0, 700);   // fast dives below slow → negative gap
    a.gold = 200; sampleGold(a, 1500); sampleStanding(a, 0, 1500); // fast climbs above slow → SIGN FLIP
    const r = fortuneReversals(a);
    ok(r.count >= 1, `tail fortuneReversals: a fast/slow sign flip past the gate is counted (${r.count})`);
  }
  // A.displacement — EWMA of distance from the believed home; a far-from-home agent reads high.
  {
    const home = { lastPos: vec(0, 0) };
    const a = { id: 1, gold: 50, pos: vec(30, 40), homeBelief() { return home; } };   // 50m from home
    sampleDisplacement(a, 0); sampleDisplacement(a, 600);
    ok(displacement(a) > 20, `tail displacement: an agent far from its believed home reads high displacement (${displacement(a).toFixed(0)})`);
    const b = { id: 2, gold: 50, pos: vec(0, 0), homeBelief() { return home; } };       // at home
    sampleDisplacement(b, 0); sampleDisplacement(b, 600);
    ok(displacement(b) < 1, `tail displacement: an agent at home reads ~0 (${displacement(b).toFixed(1)})`);
  }
  // A.timeInBand — sim-time accrues in the POVERTY band while gold stays low.
  {
    const a = { id: 1, gold: 3 };   // below poorBand
    accrueBand(a, 0); accrueBand(a, 100); accrueBand(a, 250);
    ok(timeInBand(a, 'poor') === 250 && timeInBand(a, 'rich') === 0, `tail timeInBand: poverty time accrues ("the long winter") (${timeInBand(a, 'poor')})`);
  }
  // B.regardGap — standing(a→b) − standing(b→a): unrequited regard (romance/betrayal fuel).
  {
    const a = { id: 1, beliefs: new Map([[2, { standing: 0.8 }]]) };
    const b = { id: 2, beliefs: new Map([[1, { standing: 0.1 }]]) };
    ok(Math.abs(regardGap(a, b) - 0.7) < 1e-6, `tail regardGap: a one-sided regard reads the gap (${regardGap(a, b).toFixed(2)})`);
  }
  // B.dependence — the share of a's positive-standing mass on ONE other (the pre-cast mourner).
  {
    const a = { id: 1, beliefs: { all: () => [{ subjectId: 2, standing: 0.9 }, { subjectId: 3, standing: 0.1 }, { subjectId: 4, standing: -0.5 }] } };
    const d = dependence(a);
    ok(d.share > 0.85 && d.onId === 2, `tail dependence: everything rides on one person (share ${d.share.toFixed(2)} on #${d.onId})`);
  }
  // B.triangleHints — a third party shared across two open arcs (a staged collision).
  {
    const sim = { time: 0, agentsById: new Map(), chronicle: { note() {} } };
    sim.sagas = new SagaStore(sim);
    sim.sagas.openArc({ kind: 'rivalry', key: 'r1', principals: [1, 9] });   // 9 is in both
    sim.sagas.openArc({ kind: 'rivalry', key: 'r2', principals: [2, 9] });
    const hints = triangleHints(sim);
    ok(hints.some((h) => h.thirdId === 9 && h.arcs === 2), 'tail triangleHints: a third party shared by two arcs is a collision hint');
  }
  // C.presumedDead — k agents hold a decayed (presumed-gone) belief about a LIVE agent.
  {
    const a = { id: 1, alive: true };
    const o1 = { id: 2, alive: true, controlled: false, beliefs: new Map([[1, { confidence: 0.01 }]]) };
    const o2 = { id: 3, alive: true, controlled: false, beliefs: new Map([[1, { confidence: 0.9 }]]) };
    const sim = { agents: [a, o1, o2] };
    ok(presumedDead(sim, a) === 1, 'tail presumedDead: one stale belief about a living agent reads k=1 (return-of-the-presumed-dead)');
  }
  // C.loversCrossed — a courting pair where one believes the other gone (the Romeo misinformation).
  {
    const a = { id: 1, alive: true, beliefs: new Map([[2, { confidence: 0.01 }]]) };   // a thinks b gone
    const b = { id: 2, alive: true, beliefs: new Map([[1, { confidence: 0.9 }]]) };
    ok(loversCrossed(a, b) === true, 'tail loversCrossed: a courting pair, one believing the other departed, is flagged');
    const c = { id: 3, alive: true, beliefs: new Map([[2, { confidence: 0.9 }]]) };
    const d = { id: 2, alive: true, beliefs: new Map([[3, { confidence: 0.9 }]]) };   // each sees the other clearly
    ok(loversCrossed(c, d) === false, 'tail loversCrossed: a pair who both see each other clearly is NOT crossed');
  }
  // D.creditLoad — actives counted; a lapsed obligation folds a default (the credit-crisis arc).
  {
    const a = { id: 1, alive: true, _obligations: [{ action: 'pay', counterparty: 7, amount: 5 }] };
    const b = { id: 2, alive: true };
    foldObligationDefault(b, 2);
    const cl = creditLoad({ agents: [a, b] });
    ok(cl.actives === 1 && cl.defaults === 2 && defaultsOf(b) === 2, `tail creditLoad: actives + defaults tally (a=${cl.actives} d=${cl.defaults})`);
    ok(cl.defaultRate > 0.6, `tail creditLoad: a high default rate reads as crisis (${cl.defaultRate.toFixed(2)})`);
  }
  // D.cohesion — the town warm in-group but cold toward outsiders (factionalisation).
  {
    const t1 = { id: 1, alive: true, controlled: false, faction: 'townsfolk', beliefs: { all: () => [{ subjectId: 2, standing: 0.6 }, { subjectId: 9, standing: -0.7 }] } };
    const sim = { agents: [t1], agentsById: new Map([[2, { faction: 'townsfolk' }], [9, { faction: 'bandit' }]]) };
    const c = cohesion(sim);
    ok(c.inTown > 0 && c.outsider < 0 && c.split > 1, `tail cohesion: a town warm within, cold to outsiders, splits (${c.split.toFixed(2)})`);
  }
  // F.rumourDepth — max provenance hops over the roster (the distortion index).
  {
    const sim = { agents: [
      { id: 2, alive: true, controlled: false, beliefs: new Map([[9, { hops: 1 }]]) },
      { id: 3, alive: true, controlled: false, beliefs: new Map([[9, { hops: 3 }]]) },
    ] };
    ok(rumourDepth(sim, 9) === 3, 'tail rumourDepth: the deepest provenance chain reads as the distortion index');
  }
  // F.quietIndex — sim-time since an agent last appeared in a beat; resets on noteBeat.
  {
    const sim = {};
    ok(quietIndex(sim, { id: 1 }, 500) === 500, 'tail quietIndex: an agent never in a beat is maximally quiet');
    noteBeat(sim, 1, 100);
    ok(quietIndex(sim, { id: 1 }, 130) === 30, 'tail quietIndex: the forgotten-man clock counts since the last beat');
  }
  // F.witnessSet — who saw a keyed dramatic event (the casting probe), de-duped + bounded.
  {
    const sim = {};
    noteWitness(sim, 'A:rob:5', 2, 5); noteWitness(sim, 'A:rob:5', 3, 5); noteWitness(sim, 'A:rob:5', 2, 5);   // 2 deduped
    const ws = witnessSet(sim, 'A:rob:5');
    ok(ws.length === 2 && ws.includes(2) && ws.includes(3), `tail witnessSet: the witnesses of a deed are retained, de-duped (${ws.length})`);
    ok(witnessSet(sim, 'nope').length === 0, 'tail witnessSet: an unseen deed has an empty witness set');
  }
  // never throws on malformed/missing inputs (the freeze lesson).
  {
    let threw = false;
    try {
      sampleStanding(null, 0, 0); sampleDisplacement({ id: 7 }, 0); accrueBand({ id: 7 }, 0);
      regardGap(null, null); dependence({ id: 7 }); creditLoad({ agents: [null] }); cohesion({ agents: [null] });
      presumedDead({ agents: [] }, { id: 7, alive: true }); loversCrossed(null, null);
      rumourDepth({ agents: [null] }, 1); noteBeat({}, null, 0); quietIndex({}, null, 0);
      noteWitness({}, '', null, 0); witnessSet({}, 'x'); triangleHints({});
    } catch { threw = true; }
    ok(!threw, 'tail catalog: malformed/missing inputs never throw (the freeze lesson)');
  }
}

// ---- the probe-authored-memory WHITELIST (docs/architecture/12 §10/§11 — review 1's enforcement) -
// The observer pass may DISPLAY off truth (beats/arc-closes) but may AUTHOR a memory only off
// own-state or a perceivable-evidence counter — NEVER a roster aggregate. Without this gate the
// observer layer is a standing hole through which any future sensor could courier foreign truth into
// cognition with a one-line memory.record. We scan the status-probe source and assert every episode
// kind it AUTHORS is on the whitelist, and that `slandered` reads snubsFelt (not the mean).
export function whitelistTest(ok) {
  // own-state (own gold/inventory/experience) + perceivable-evidence counters only. A roster
  // aggregate (mean standing) is NOT allowed as the read class behind a probe-authored memory.
  const ALLOWED = new Set(['ruined', 'thwarted', 'slandered']);
  const PROBE_FILES = ['js/sim/statusSensor.ts'];   // extend as new observer probes author episodes
  for (const f of PROBE_FILES) {
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { /* */ }
    ok(src.length > 0, `whitelist: probe source ${f} is readable`);
    // the episode kinds the probe AUTHORS — only the `record(a, { … kind: 'X' … })` calls (NOT arc
    // `openArc({kind:…})`, which are arc kinds, not memory episodes).
    const authored = [...new Set([...src.matchAll(/record\(\s*a\s*,\s*\{[^}]*?kind:\s*'([a-z_]+)'/g)].map((m) => m[1]))];
    const offending = authored.filter((k) => !ALLOWED.has(k));
    ok(offending.length === 0,
      `whitelist: ${f} authors ONLY own-state/perceivable episode kinds (authored: [${authored.join(',')}]; offending: ${offending.join(',') || 'none'})`);
  }
  // and the load-bearing one: slandered must read snubsFelt, never the roster mean (review 1).
  const ss = (() => { try { return readFileSync('js/sim/statusSensor.ts', 'utf8'); } catch { return ''; } })();
  const slanderBlock = ss.slice(Math.max(0, ss.indexOf('snubsFelt(a, now)')), ss.indexOf("kind: 'slandered'") + 40);
  ok(/snubsFelt/.test(ss) && /snubs\s*>=\s*STATUS\.snubThreshold[^]*?kind:\s*'slandered'/.test(ss),
    'whitelist: the `slandered` memory is gated on snubsFelt (perceivable evidence), not the roster mean');
}

// ---- outlaw warming + NPC notoriety + the outlaw arc (docs/architecture/12 §9) ------------------
// O1 a poor/bold witness WARMS toward a robber of the believed-rich (the Robin Hood four-conjunct);
// O2 a kind/comfortable witness SOURS on the same robbery (the conjuncts genuinely gate);
// O3 NPC notoriety crossing dreadAt opens the `outlaw` arc.
export function outlawTest(ok, { makeFighter, stubScene }) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  let nid = 1;
  const add = (name, pers, cfg = {}) => {
    const a = new Agent(makeFighter('knight', {}), { id: nid++, name, profession: null, personality: pers, faction: 'townsfolk', ...cfg });
    sim.agents.push(a); sim.agentsById.set(a.id, a); return a;
  };
  const robber = add('Rob', { risk_tolerance: 0.5, altruism: 0.5, ambition: 0.5, social_drive: 0.3 }, { faction: 'bandit' });
  const victim = add('Rich', { risk_tolerance: 0.5, altruism: 0.5, ambition: 0.5, social_drive: 0.3 });
  const poorBold = add('Poor', { risk_tolerance: 0.9, altruism: 0.1, ambition: 0.5, social_drive: 0.3 });
  const kindRich = add('Soft', { risk_tolerance: 0.9, altruism: 0.8, ambition: 0.5, social_drive: 0.3 });
  poorBold.gold = 5; kindRich.gold = 200;
  robber.fighter.root.position.set(0, 0, 0);
  poorBold.fighter.root.position.set(1, 0, 0);
  kindRich.fighter.root.position.set(1, 0, 1);
  victim.fighter.root.position.set(2, 0, 0);
  // both witnesses believe the victim WEALTHY and are not allied to it.
  for (const w of [poorBold, kindRich]) { const vb = w.beliefs.observe(victim.id, victim.faction, victim.pos, 0, false); vb.believedWealth = 0.9; vb.wealthConf = 0.9; vb.standing = 0; }

  const before = (poorBold.beliefs.get(robber.id) || {}).standing || 0;
  sim._ctx().resolver.witnessDeed(robber, victim.id, 'rob', 0.5);
  const after = (poorBold.beliefs.get(robber.id) || {}).standing || 0;
  ok(after > before, `outlaw O1: a poor/bold witness WARMS toward a robber of the believed-rich (${before.toFixed(2)} -> ${after.toFixed(2)})`);
  const soft = (kindRich.beliefs.get(robber.id) || {}).standing || 0;
  ok(soft <= 0, `outlaw O2: a kind/comfortable witness does NOT warm on the same robbery (${soft.toFixed(2)})`);

  // O3 — NPC notoriety crossing dreadAt opens the outlaw arc (the statusSensor probe).
  robber.notoriety = 0.5;
  statusSensor(robber, sim, sim.time);
  ok(sim.sagas.findArc('outlaw:' + robber.id) != null, 'outlaw O3: NPC notoriety crossing dreadAt opens the outlaw arc');

  // O4 — the outlaw run down: a killing blow closes the arc 'brought_down' (the combat death fold).
  sim.onCombatEvents([{ type: 'dead', attacker: { agent: victim, id: victim.id }, target: { agent: robber, id: robber.id } }]);
  ok(sim.sagas.recentClosed().some((x) => x.kind === 'outlaw' && x.outcome === 'brought_down'),
    'outlaw O4: a slain rising outlaw closes the arc brought_down');

  // O5 — a war-leader cut down before mustering: the warband arc closes 'routed' (item-1 path).
  sim.sagas.openArc({ kind: 'warband', key: 'warband:' + kindRich.id, principals: [kindRich.id] });
  sim.onCombatEvents([{ type: 'dead', attacker: { agent: poorBold, id: poorBold.id }, target: { agent: kindRich, id: kindRich.id } }]);
  ok(sim.sagas.recentClosed().some((x) => x.kind === 'warband' && x.outcome === 'routed'),
    'outlaw O5: a war-leader cut down closes the warband arc routed');
  sim.dispose();
}

// ---- TASK B: suspicion-gated soft-avoidance — "cross the street" (docs/architecture/13 §3) -------
// A merely-SUSPECTED, soured-but-NOT-hostile neighbour I believe is close earns a faint, low-priority
// berth (an `avoid` goal whose `around` is the suspect's believed pos), SHORT of fleeing — and it
// must NOT out-prioritise work/survival. Belief-only (my own suspicion/standing/hostile/lastPos).
export function softAvoidTest(ok, { makeFighter, stubScene }) {
  // SEED the shared PRNG: `decide()` lazily rolls each fresh agent's AMBITION off rng() the first
  // time, and a wanderlust roll lifts `wander` via ambitionFavor past the deliberately-faint 0.35
  // avoid — so without a seed S-B1 flakes ~1/5 (the avoid berth is a wisp, not a dictator, by design).
  // Pinning the seed makes the ambition rolls deterministic so the goal-ordering assertions are stable.
  // The seed is passed THROUGH the Simulation opts (its constructor calls setSeed(opts.seed), which
  // would otherwise clobber a bare setSeed here); restored to unseeded at the end so later suites keep
  // their stochastic soak behaviour.
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter, seed: 1234 });
  let nid = 1;
  const P = () => ({ risk_tolerance: 0.5, altruism: 0.5, ambition: 0.5, social_drive: 0.3, curiosity: 0.4 });
  const add = (name, x, z, cfg = {}) => {
    const a = new Agent(makeFighter('knight', {}), { id: nid++, name, profession: null, personality: P(), faction: 'townsfolk', townsperson: true, ...cfg });
    a.fighter.root.position.set(x, 0, z);
    sim.agents.push(a); sim.agentsById.set(a.id, a); return a;
  };
  const cog = () => sim._cognitionCtx();

  // S-B1 — a believed-SUSPECT (suspicion above the bar, standing cool, NOT hostile) within range
  // produces a soft-avoid berth. To isolate the social discomfort from the economic scheduler we
  // make this agent a non-worker (canWork=false), so its only !inDanger candidates are avoid+wander
  // — avoid (weight 0.35) decisively beats wander (~0.15) and becomes the goal, steering OFF the
  // suspect's believed pos. (S-B3 below proves a WORKER does NOT let it override work.)
  {
    const a = add('Wary', 0, 0); a.canWork = false;
    const sb = a.beliefs.observe(2, 'townsfolk', vec3(3, 0, 0), 0, false);   // believe #2 is 3m away
    sb.suspicion = 0.6; sb.standing = -0.1; sb.hostile = false; sb.confidence = 0.9;
    a.decide(cog());
    ok(a.goal && a.goal.kind === 'avoid', `softavoid S-B1: a near believed-suspect earns a soft-avoid berth (goal=${a.goal && a.goal.kind})`);
    ok(a.goal && a.goal.around && Math.abs(a.goal.around.x - 3) < 1e-6,
      'softavoid S-B1: the berth is centred on where I BELIEVE the suspect is (around = belief lastPos)');
  }

  // S-B2 — a NEUTRAL neighbour (no suspicion, warm-enough standing) earns NO berth: same setup, but
  // the belief is unsuspicious → the avoid candidate never fires (the agent just wanders).
  {
    const a = add('Calm', 0, 0); a.canWork = false;
    const nb = a.beliefs.observe(2, 'townsfolk', vec3(3, 0, 0), 0, false);
    nb.suspicion = 0.0; nb.standing = 0.2; nb.hostile = false; nb.confidence = 0.9;
    a.decide(cog());
    ok(a.goal && a.goal.kind !== 'avoid', `softavoid S-B2: a neutral neighbour earns NO berth (goal=${a.goal && a.goal.kind})`);
  }

  // S-B3 — the berth must NOT out-prioritise WORK. A normal WORKER (canWork=true) with the SAME near
  // suspect still chooses to work — the soft-avoid is a wisp of discomfort, not a behaviour override.
  {
    const a = add('Busy', 0, 0);
    a.gold = 0;   // a real wealth motive so `work` scores well above the soft-avoid floor
    const sb = a.beliefs.observe(2, 'townsfolk', vec3(3, 0, 0), 0, false);
    sb.suspicion = 0.6; sb.standing = -0.1; sb.hostile = false; sb.confidence = 0.9;
    a.decide(cog());
    ok(a.goal && a.goal.kind !== 'avoid', `softavoid S-B3: the soft-avoid does NOT out-prioritise work (goal=${a.goal && a.goal.kind})`);
  }

  // S-B4 — a believed-HOSTILE close by is the SURVIVAL flee's business, not this faint wariness: the
  // soft-avoid predicate explicitly skips hostiles (it must never duplicate/override the flee path).
  {
    const a = add('Threatened', 0, 0); a.canWork = false;
    const hb = a.beliefs.observe(2, 'bandit', vec3(3, 0, 0), 0, true);   // hostile sighting
    hb.suspicion = 0.6; hb.standing = -0.8; hb.hostile = true; hb.confidence = 0.9;
    a.decide(cog());
    ok(a.goal && a.goal.kind !== 'avoid', `softavoid S-B4: a believed-hostile drives flee/fight, not the soft-avoid (goal=${a.goal && a.goal.kind})`);
  }
  setSeed(undefined);   // restore the platform RNG so subsequent suites stay unseeded
  sim.dispose();
}
