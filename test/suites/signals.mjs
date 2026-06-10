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
  esteemTruthGap, doomedVenture, misallocatedSuspicion } from '../../js/sim/signals.js';
import { statusSensor } from '../../js/sim/statusSensor.js';
import { SagaStore } from '../../js/sim/arcs.js';
import { BeliefState } from '../../js/sim/beliefs.js';
import { recognizeWealth } from '../../js/sim/agent/decide.js';
import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { readFileSync } from 'node:fs';

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
