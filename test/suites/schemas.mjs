// SCHEMAS suite (Phase 2a, Step 1) — unit-tests the InteractionSchema framework in
// ISOLATION (no sim run): the IR trust boundary (validate accepts well-formed rows /
// rejects an unknown-op row), each vocab evaluator over a HAND-BUILT BeliefState + a fake
// own-state agent + a hand-built MentalMap, and the animacy tally. Then two stability
// proofs: (a) FRAMEWORK byte-stability — reason() is a structural no-op with the empty
// Step-1 catalogue, touching no goal; (b) the interpreter never throws on a malformed row
// or a belief pointing at no agent (the freeze lesson).
//
// Folds into the shared `ok` tally. No Simulation is constructed here (the substrate
// output-stability proof — animacy/strikeLog writes live, catalogue empty — is the FULL
// soak in soak.mjs, which already runs with the writes wired).

import * as THREE from 'three';
import { BeliefStore, BeliefState } from '../../js/sim/beliefs.js';
import { MentalMap, Place } from '../../js/sim/mentalmap.js';
import { Memory } from '../../js/sim/memory.js';
import { schema, validate } from '../../js/sim/schemas/ir.js';
import {
  all, any, not, believe, witnessed, selfNeed, selfIs, outmatchedBy,
  nearKnown, perceivedNow, selfEngaged, observedAnimacy,
  setIntent, raiseThenSet, goal, fleeTo, intercept,
} from '../../js/sim/schemas/vocab.js';
import { evalPred, evalInfer, evalRespond } from '../../js/sim/schemas/vocab.js';
import { reason } from '../../js/sim/schemas/interpreter.js';
import { SCHEMA } from '../../js/sim/simconfig.js';

// a minimal own-state agent stand-in: id, faction, needs, pos, combatant, a BeliefStore,
// a strikeLog (via the real _logStrike shape), and Memory. NOT an Agent — just the surface
// the evaluators read. townId null so it knows world-wide landmarks only.
function fakeAgent(id, over = {}) {
  const a = {
    id, faction: over.faction || 'townsfolk', combatant: !!over.combatant,
    controlled: false, alive: true, autonomous: true, townId: over.townId ?? null,
    needs: over.needs || { hunger: 0.8, energy: 0.8, social: 0.8, comfort: 0.8, novelty: 0.8, safety: 0.8 },
    pos: new THREE.Vector3(over.x || 0, 0, over.z || 0),
    beliefs: new BeliefStore(id), memory: new Memory(),
    strikeLog: null, goals: [],
    pushGoal(g) { this.goals.push(g); return g; },
  };
  // a tiny _logStrike mirroring agent.js (own-state count keyed on target id).
  a._logStrike = (tid, now) => {
    if (!a.strikeLog) a.strikeLog = new Map();
    const r = a.strikeLog.get(tid);
    if (r) r.count += 1; else a.strikeLog.set(tid, { count: 1, first: now || 0 });
  };
  return a;
}

function makeEnv(a, subjectId, map) {
  return { agent: a, beliefs: a.beliefs, memory: a.memory, map: map || null, ctx: { time: 100, map }, now: 100, subjectId };
}

// (A) IR validate — accepts well-formed rows (incl. nested all/any/not) and rejects an
// unknown-op row, so a typo'd schema degrades to inert.
function irValidate(ok) {
  const good = schema({
    id: 'flee', subject: 'self',
    when: all(any(believe('@h', 'hostile', '==', true), nearKnown('exit', 9)),
              not(selfIs('combatant')), selfNeed('safety', '<', 0.4)),
    infer: setIntent('flee'), respond: fleeTo(['exit', 'conceal']), priority: 0.9, ttl: 4,
  });
  ok(validate(good), 'ir: a well-formed flagship row validates');

  const goodBelieved = schema({
    id: 'inert', subject: 'believed',
    when: all(believe('@x', 'hostile', '==', true), selfEngaged('@x', 3), not(observedAnimacy('@x'))),
    infer: raiseThenSet('inertEvidence', 1, 2, [['hostile', false], ['inert', true]]),
    respond: goal('wander'), priority: 0.6, ttl: 20,
  });
  ok(validate(goodBelieved), 'ir: the schema-#6 (believed) row validates');

  // unknown predicate op → rejected.
  const badPred = schema({ id: 'bad', subject: 'self', when: { op: 'teleport', args: [] } });
  ok(!validate(badPred), 'ir: a row with an unknown predicate op is REJECTED (degrades inert)');
  // unknown response op → rejected.
  const badResp = schema({ id: 'bad2', subject: 'self', respond: { op: 'nuke', args: [] } });
  ok(!validate(badResp), 'ir: a row with an unknown response op is REJECTED');
  // bad subject → rejected.
  ok(!validate(schema({ id: 'bad3', subject: 'martian' })), 'ir: a row with a bad subject is REJECTED');

  // defaults filled.
  const d = schema({ id: 'd', subject: 'self' });
  ok(d.priority === 0.5 && d.ttl === 4 && d.cost === 1, 'ir: scheduler defaults filled (priority/ttl/cost)');
}

// (B) predicate evaluators over hand-built beliefs/state/map.
function predEvaluators(ok) {
  const map = new MentalMap();
  map.add(new Place('GATE', 'gate', new THREE.Vector3(5, 0, 0), ['exit', 'safe'], null));

  const a = fakeAgent(1, { faction: 'townsfolk' });
  // a hostile belief about subject 2, seen this tick (lastTick=now).
  const b = a.beliefs._ensure(2);
  b.hostile = true; b.lastFaction = 'bandit'; b.confidence = 1; b.lastTick = 100;
  b.lastPos.set(3, 0, 0);

  ok(evalPred(believe('@x', 'hostile', '==', true), makeEnv(a, 2, map)), 'pred: believe(hostile==true) true');
  ok(!evalPred(believe('@x', 'hostile', '==', false), makeEnv(a, 2, map)), 'pred: believe(hostile==false) false');
  ok(evalPred(believe('@x', 'confidence', '>=', 0.5), makeEnv(a, 2, map)), 'pred: believe(confidence>=.5) true');
  // believe with 'self' literal resolves to my faction.
  const friend = a.beliefs._ensure(3); friend.lastFaction = 'townsfolk'; friend.confidence = 1;
  ok(evalPred(believe('@x', 'lastFaction', '==', 'self'), makeEnv(a, 3, map)),
    "pred: believe(lastFaction=='self') resolves 'self' to my faction");

  ok(evalPred(selfNeed('safety', '<', 0.9), makeEnv(a, null, map)), 'pred: selfNeed(safety<.9) true');
  ok(!evalPred(selfNeed('safety', '>', 0.99), makeEnv(a, null, map)), 'pred: selfNeed(safety>.99) false');

  ok(!evalPred(selfIs('combatant'), makeEnv(a, null, map)), 'pred: selfIs(combatant) false for a civilian');
  ok(evalPred(not(selfIs('combatant')), makeEnv(a, null, map)), 'pred: not(selfIs(combatant)) true for a civilian');

  ok(evalPred(outmatchedBy('@x'), makeEnv(a, 2, map)), 'pred: outmatchedBy a believed-hostile (civilian) true');

  // nearKnown resolves the static Place: a is 5m from the gate; range 6 hits, range 4 misses.
  ok(evalPred(nearKnown('exit', 6), makeEnv(a, null, map)), 'pred: nearKnown(exit,6) finds the gate Place');
  ok(!evalPred(nearKnown('exit', 4), makeEnv(a, null, map)), 'pred: nearKnown(exit,4) too far (no place)');

  // perceivedNow: seen this tick (lastTick===now) true; a stale belief false.
  ok(evalPred(perceivedNow('@x'), makeEnv(a, 2, map)), 'pred: perceivedNow true when lastTick===now');
  b.lastTick = 90;
  ok(!evalPred(perceivedNow('@x'), makeEnv(a, 2, map)), 'pred: perceivedNow false when belief is stale');

  // selfEngaged reads the strikeLog (own action count) — counts strikes on ANY target id.
  ok(!evalPred(selfEngaged('@x', 3), makeEnv(a, 2, map)), 'pred: selfEngaged false before any strike');
  a._logStrike(2, 100); a._logStrike(2, 100); a._logStrike(2, 100);
  ok(evalPred(selfEngaged('@x', 3), makeEnv(a, 2, map)), 'pred: selfEngaged(>=3) true after 3 logged strikes');

  // witnessed reads episodic memory; HOSTILE_ACT aliases the hostile kinds.
  a.memory.record({ t: 100, kind: 'assaulted', withId: 4, valence: -1, salience: 0.6 });
  ok(evalPred(witnessed('@x', 'HOSTILE_ACT'), makeEnv(a, 4, map)), "pred: witnessed('HOSTILE_ACT') reads an 'assaulted' memory");
  ok(!evalPred(witnessed('@x', 'HOSTILE_ACT'), makeEnv(a, 99, map)), 'pred: witnessed false for an unrelated subject');
}

// (C) the ANIMACY tally + observedAnimacy evaluator.
function animacy(ok) {
  const a = fakeAgent(1);
  const b = a.beliefs._ensure(2);
  b.hostile = true; b.confidence = 1;
  ok(b.animacyTally === null, 'animacy: tally is null (lazy) before any observed action');
  ok(!evalPred(observedAnimacy('@x'), makeEnv(a, 2)), 'animacy: observedAnimacy false on a null tally');
  b.recordAnimacy('struck');
  ok(b.animacyTally && b.animacyTally.struck === 1, 'animacy: recordAnimacy allocates + increments');
  ok(evalPred(observedAnimacy('@x'), makeEnv(a, 2)), 'animacy: observedAnimacy true after a recorded action');
  // a bad kind is a no-op (never throws).
  let threw = false; try { b.recordAnimacy('nonsense'); } catch { threw = true; }
  ok(!threw && b.animacyTally.struck === 1, 'animacy: an unknown kind is a guarded no-op');
}

// (D) inference + response evaluators produce the expected belief writes / goal descriptors.
function inferResp(ok) {
  const map = new MentalMap();
  map.add(new Place('GATE', 'gate', new THREE.Vector3(10, 0, 0), ['exit', 'safe'], null));
  const a = fakeAgent(1);
  const b = a.beliefs._ensure(2);
  b.hostile = true; b.confidence = 1; b.lastPos.set(4, 0, 0);

  // setIntent writes the belief's intent.
  evalInfer(setIntent('flee'), makeEnv(a, 2, map));
  ok(b.intent === 'flee', 'infer: setIntent writes belief.intent');

  // raiseThenSet accrues inertEvidence and, once over threshold, revises BOTH hostile:false
  // AND inert:true (the inert flag overrides the faction prior in considerHostile — the
  // real disengage trigger for schema #6).
  const REV = [['hostile', false], ['inert', true]];
  evalInfer(raiseThenSet('inertEvidence', 1, 2, REV), makeEnv(a, 2, map));
  ok(b.inertEvidence === 1 && b.hostile === true && b.inert === false, 'infer: raiseThenSet below threshold accrues, keeps hostile');
  evalInfer(raiseThenSet('inertEvidence', 1, 2, REV), makeEnv(a, 2, map));
  ok(b.inertEvidence === 2 && b.hostile === false && b.inert === true, 'infer: raiseThenSet at threshold REVISES hostile→false + inert→true');

  // fleeTo resolves the nearest exit place into a static {x,z} toPos.
  const fg = evalRespond(fleeTo(['exit']), makeEnv(a, null, map));
  ok(fg && fg.kind === 'flee' && fg.toPos && Math.abs(fg.toPos.x - 10) < 1e-6, 'resp: fleeTo → flee goal toward the exit place');

  // intercept builds a fight goal toward the belief's destPos/lastPos.
  const ig = evalRespond(intercept('@x'), makeEnv(a, 2, map));
  ok(ig && ig.kind === 'fight' && ig.targetId === 2 && ig.toPos && Math.abs(ig.toPos.x - 4) < 1e-6,
    'resp: intercept → fight goal toward the believed lastPos');
}

// (E) interpreter stability: empty catalogue is a no-op; a malformed row / no-agent belief
// never throws; the master gate disables the pass.
function interpreterStability(ok) {
  const a = fakeAgent(1);
  a.goal = { kind: 'work' };
  // empty catalogue → reason is a structural no-op (goal untouched).
  reason(a, { time: 100, map: null }, []);
  ok(a.goal.kind === 'work', 'interp: empty catalogue leaves the goal untouched (byte-stable no-op)');

  // master gate OFF → reason no-ops even with a row.
  const row = schema({ id: 'x', subject: 'self', when: selfNeed('safety', '<', 1), respond: goal('hide') });
  const prev = SCHEMA.enabled; SCHEMA.enabled = false;
  reason(a, { time: 100, map: null }, [row]);
  ok(a.goal.kind === 'work' && (!a.goals || a.goals.length === 0), 'interp: SCHEMA.enabled=false disables the pass');
  SCHEMA.enabled = prev;

  // a malformed row (op the evaluator lacks) + a belief that points at no real agent never
  // throws — the pass is guarded end-to-end (freeze lesson).
  let threw = null;
  try {
    a.beliefs._ensure(7).hostile = true;   // a believed subject with no roster entry
    reason(a, { time: 100, map: null }, [{ subject: 'believed', when: { op: 'bogus', args: [] }, respond: goal('x') }]);
  } catch (e) { threw = e; }
  ok(threw === null, 'interp: a malformed row + a no-agent belief never throws (' + (threw ? threw.message : 'clean') + ')');
}

export function schemasTest(ok) {
  console.log('\n— schemas suite (IR + vocab + interpreter, Step 1) —');
  irValidate(ok);
  predEvaluators(ok);
  animacy(ok);
  inferResp(ok);
  interpreterStability(ok);
}
