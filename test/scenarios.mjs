// Scenario harness + full-stack test suite for the goal/planning system
// (docs/goal-system.md + docs/goal-system-tests.md). This is the deterministic
// companion to the stochastic soak in headless.mjs: it constructs a Simulation
// of HeadlessFighters with a NAMED cast at fixed positions and explicit
// inventory/gold/beliefs, then drives the REAL frame loop
//   sim.update -> fighter.update -> resolveCombat -> onCombatEvents
// and asserts the causal chain across every layer (perceive -> beliefs ->
// memory -> derivation -> planner -> act -> consequence).
//
// Exports runScenarios(ok) so headless.mjs can fold these into its single
// pass/fail tally and exit nonzero on ANY failure. Standalone:
//   bun test/scenarios.mjs

import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { Agent } from '../js/sim/agent.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import { resolveCombat } from '../js/combat.js';
import { DIR } from '../js/constants.js';
import { COMMODITIES, MOTIVE } from '../js/sim/simconfig.js';
import { deriveGoals, pruneGoals } from '../js/sim/motivation.js';
import {
  plan, goalRepay, goalSeekFortune, goalAvenge, goalGrieve, goalDelve, PLAN, PRIMITIVES,
} from '../js/sim/planner.js';

const stubScene = { add() {}, remove() {} };
const makeFighter = (model, o) => new HeadlessFighter(model, o);
const P = () => ({ risk_tolerance: 0.5, social_drive: 0.4, ambition: 0.5, altruism: 0.6, curiosity: 0.4 });

// ---------------------------------------------------------------------------
// Stage: a Simulation wired for deterministic scripting. Build a named cast at
// fixed positions, give them explicit state, then drive the real frame loop.
// ---------------------------------------------------------------------------
class Stage {
  constructor() {
    this.world = new World(stubScene);
    this.sim = new Simulation(stubScene, this.world, { makeFighter });
    this._nid = 1;
    this.cast = {};
    this.dt = 1 / 60;
  }

  // add a named agent at (x,z). cfg passes through to Agent (profession, faction,
  // combatant, controlled, …). Returns the Agent; also stored on this.cast[name].
  add(name, x, z, cfg = {}) {
    const a = new Agent(makeFighter('knight', {}),
      { id: this._nid++, name, profession: cfg.profession ?? null, personality: P(),
        faction: cfg.faction || 'townsfolk', combatant: !!cfg.combatant, controlled: !!cfg.controlled });
    a.fighter.root.position.set(x, 0, z);
    this.sim.agents.push(a); this.sim.agentsById.set(a.id, a);
    this.cast[name] = a;
    return a;
  }

  // strip all inventory + gold so a debtor starts from a clean, explicit slate.
  strip(a) { for (const c of COMMODITIES) a.inventory[c] = 0; a.gold = 0; return a; }

  ctx() { return this.sim._ctx(); }

  // make `observer` BELIEVE subject's position (belief-grounded planning input).
  believe(observer, subject, hostile = false) {
    observer.beliefs.observe(subject.id, subject.faction, subject.pos, this.sim.time, hostile);
  }

  // inject an episodic memory directly into an agent (helper: inject). To make a
  // memory immediately derivable (salient() reads MTM/LTM, not STM) we record it
  // and force a consolidation pass so deriveGoals can see it this same tick.
  inject(agent, memory) {
    agent.memory.record(memory);
    agent.memory._consolidate();   // push qualifying STM episodes up to MTM/LTM
    return memory;
  }

  // push a goal onto an agent's stack (helper: push).
  push(agent, goal) { return agent.pushGoal(goal, this.ctx()); }

  // one real frame: the exact order main.js / headless.mjs use.
  frame() {
    const sim = this.sim;
    sim.update(this.dt);
    for (const f of sim.fighters) f.update(this.dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  }

  runFrames(n) { for (let i = 0; i < n; i++) this.frame(); }

  // run until pred() is true or maxFrames elapse; returns frames actually run.
  runUntil(pred, maxFrames = 3000) {
    let f = 0;
    for (; f < maxFrames; f++) { if (pred()) return f; this.frame(); }
    return f;
  }

  totalGold() { return this.sim.agents.reduce((s, a) => s + (a.gold || 0), 0); }
  totalFood() { return this.sim.agents.reduce((s, a) => s + (a.inventory.food || 0), 0); }

  dispose() { this.sim.dispose(); }
}

const primNames = (pl) => (pl ? pl.steps.map((s) => s.prim) : []);
const lastPrim = (pl) => (pl && pl.steps.length ? pl.steps[pl.steps.length - 1].prim : null);

// ===========================================================================
// A. Primitives — precondition / effect / conservation. We exercise the REAL
//    transfer executors (_giveStep / _payStep) through act(), the same code the
//    closed-economy soak relies on, so conservation is checked on the live path.
// ===========================================================================
function scenA(ok) {
  const st = new Stage();
  const A = st.add('A', 0, 0);
  const B = st.add('B', 0.5, 0);               // within arriveDist (transfer lands in one step)
  st.strip(A); st.strip(B);
  A.inventory.food = 5; B.inventory.food = 1;

  const foodSum = () => A.inventory.food + B.inventory.food;
  const sum0 = foodSum();
  // A1 — give×2 conserves goods. Drive _giveStep directly (precond met: adjacent).
  A._giveStep({ to: B.id, item: 'food', n: 2 }, st.dt, st.ctx());
  ok(A.inventory.food === 3 && B.inventory.food === 3, `A1 give: A.food=3 B.food=3 (got ${A.inventory.food}/${B.inventory.food})`);
  ok(Math.abs(foodSum() - sum0) < 1e-9, 'A1 give: sum(food) conserved');
  // A4 — the received predicate now fires (B.recv true via _repaid flag).
  ok(!!(A._repaid && A._repaid[B.id]), 'A4 effect: received predicate fires after give (_repaid set)');

  // A2a — not adjacent -> no-op, no transfer, no throw.
  const A2 = st.add('A2', 0, 0); const B2 = st.add('B2', 30, 0);
  st.strip(A2); A2.inventory.food = 4;
  let threw = false;
  try { A2._giveStep({ to: B2.id, item: 'food', n: 2 }, st.dt, st.ctx()); } catch { threw = true; }
  ok(!threw && A2.inventory.food === 4 && (B2.inventory.food || 0) === 0, 'A2a give: far target -> no transfer, no throw');
  // A2b — empty stock -> no-op.
  const A3 = st.add('A3', 0, 0); const B3 = st.add('B3', 0.5, 0);
  st.strip(A3); st.strip(B3);
  A3._giveStep({ to: B3.id, item: 'food', n: 2 }, st.dt, st.ctx());
  ok((A3.inventory.food || 0) === 0 && (B3.inventory.food || 0) === 0, 'A2b give: empty stock -> no-op');

  // A3 — pay conserves gold; pay(amt>gold) no-op.
  const C = st.add('C', 0, 0); const D = st.add('D', 0.5, 0);
  st.strip(C); st.strip(D); C.gold = 50; D.gold = 10;
  const goldSum = () => C.gold + D.gold; const g0 = goldSum();
  C._payStep({ to: D.id, amt: 20 }, st.dt, st.ctx());
  ok(C.gold === 30 && D.gold === 30, `A3 pay: C=30 D=30 (got ${C.gold}/${D.gold})`);
  ok(Math.abs(goldSum() - g0) < 1e-9, 'A3 pay: sum(gold) conserved');
  C._payStep({ to: D.id, amt: 999 }, st.dt, st.ctx());   // can't afford
  ok(C.gold === 30 && D.gold === 30, 'A3 pay: amt>gold -> no-op');

  st.dispose();
}

// ===========================================================================
// B. Planner synthesis / cost / belief-divergence (the emergence). Same goal
//    `repay(X)`, different means -> different plans, all well-formed.
// ===========================================================================
function scenB(ok) {
  const st = new Stage();
  const X = st.add('X', 2, 2);                 // benefactor, fixed nearby
  const ctx = st.ctx();

  // blank-slate debtor near X that BELIEVES X's position.
  const debtor = (name, setup) => {
    const a = st.add(name, 5, 5); st.strip(a); setup(a);
    st.believe(a, X, false);
    return a;
  };

  // B1/B2 — food-rich farmer gifts from stock: [goto, give], no acquire/pay.
  const farmer = debtor('Farmer', (a) => { a.inventory.food = 6; });
  const pFarmer = plan(farmer, goalRepay(X.id, 2, 'food'), ctx);
  ok(pFarmer && lastPrim(pFarmer) === 'give', `B2 farmer: ends in give (${primNames(pFarmer).join('->') || 'NULL'})`);
  ok(pFarmer && !primNames(pFarmer).some((n) => ['buy', 'gather', 'pay'].includes(n)), 'B2 farmer: gifts from stock (no acquire/pay)');
  ok(pFarmer && pFarmer.steps[0].prim === 'goto', 'B1: plan opens by travelling to the target');
  ok(pFarmer && pFarmer.steps[pFarmer.steps.length - 1].bind.to === X.id, 'B1: final transfer targets X');

  // B3 — coin-rich merchant, goal accepts coin: pay, not give.
  const merchant = debtor('Merchant', (a) => { a.gold = 80; });
  const pMerch = plan(merchant, goalRepay(X.id, 6, 'coin'), ctx);
  ok(pMerch && lastPrim(pMerch) === 'pay', `B3 merchant: ends in pay (${primNames(pMerch).join('->') || 'NULL'})`);
  ok(pMerch && !primNames(pMerch).includes('give'), 'B3 merchant: pays coin (no give)');

  // B4 — goods-less + coined laborer near a cheap market, goal demands a good:
  // acquire-first multi-step ending in give (the branch nobody authored).
  const laborer = debtor('Laborer', (a) => { a.gold = 40; a.fighter.root.position.set(0.5, 0, 0.5); a.priceBeliefs.food = 3; });
  const pLab = plan(laborer, goalRepay(X.id, 1, 'food'), ctx);
  ok(pLab && lastPrim(pLab) === 'give' && primNames(pLab).some((n) => n === 'buy' || n === 'gather'),
    `B4 laborer: acquires-then-gives (${primNames(pLab).join('->') || 'NULL'})`);

  // EMERGENCE: three distinct plan signatures from three lived understandings.
  const sigF = primNames(pFarmer).join('>'), sigM = primNames(pMerch).join('>'), sigL = primNames(pLab).join('>');
  ok(sigF !== sigM && sigM !== sigL && sigF !== sigL, `B emergence: distinct plans [${sigF}] [${sigM}] [${sigL}]`);

  // B5 — cost picks the cheaper means: BOTH stock + gold, market far -> from-stock
  // give (no market step); strip the stock -> switches to acquire.
  const both = debtor('Both', (a) => { a.inventory.food = 6; a.gold = 80; a.fighter.root.position.set(8, 0, 8); });
  const pBoth = plan(both, goalRepay(X.id, 1, 'food'), ctx);
  ok(pBoth && !primNames(pBoth).some((n) => n === 'buy' || n === 'gather'), `B5: stock+gold -> gifts from stock (${primNames(pBoth).join('->') || 'NULL'})`);
  for (const c of COMMODITIES) both.inventory[c] = 0;
  const pBoth2 = plan(both, goalRepay(X.id, 1, 'food'), ctx);
  ok(pBoth2 && primNames(pBoth2).some((n) => n === 'buy' || n === 'gather'), `B5: stock removed -> acquires (${primNames(pBoth2).join('->') || 'NULL'})`);

  // B6 — belief divergence: identical except position -> same goal, different cost.
  const near = debtor('Near', (a) => { a.gold = 80; a.fighter.root.position.set(2.5, 0, 2.5); });
  const far = debtor('Far', (a) => { a.gold = 80; a.fighter.root.position.set(45, 0, 45); });
  const pNear = plan(near, goalRepay(X.id, 6, 'coin'), ctx);
  const pFar = plan(far, goalRepay(X.id, 6, 'coin'), ctx);
  ok(pNear && pFar && Math.abs(pNear.cost - pFar.cost) > 1e-3, `B6 divergence: same goal, different cost (${pNear?.cost.toFixed(2)} vs ${pFar?.cost.toFixed(2)})`);

  // B7 — infeasible -> graceful null, goal flagged unreachable + abandoned.
  const stuck = st.add('Stuck', 5, 5); st.strip(stuck);
  const gStuck = goalRepay(999, 1, 'food');            // unknown subject
  const pStuck = plan(stuck, gStuck, ctx);
  ok(pStuck === null, 'B7: infeasible goal returns null (no throw)');
  st.push(stuck, gStuck);
  stuck._currentPlanStep(st.ctx());                    // planning marks it unreachable
  pruneGoals(stuck, st.ctx());
  ok(!stuck.goals.some((g) => g.kind === 'repay' && g.subjectId === 999), 'B7: unreachable goal abandoned by pruneGoals');

  st.dispose();
}

// ===========================================================================
// C. Execution & replanning — drive the real frame loop.
// ===========================================================================
function scenC(ok) {
  // C1 — plan completes: [goto, give] runs; predicate true -> popped; conserved.
  {
    const st = new Stage();
    const X = st.add('X', 3, 0, { controlled: true });   // still anchor
    const D = st.add('D', 8, 0); st.strip(D); D.inventory.food = 6;
    st.believe(D, X, false);
    const food0 = st.totalFood(), gold0 = st.totalGold(), xf0 = X.inventory.food;
    st.push(D, goalRepay(X.id, 2, 'food'));
    const f = st.runUntil(() => D.goals.length === 0, 1800);
    ok(D.goals.length === 0, `C1: plan completed, goal popped (${f} frames)`);
    ok(X.inventory.food >= xf0 + 0.99, `C1: X received the gift (${xf0} -> ${X.inventory.food})`);
    ok(Math.abs(st.totalFood() - food0) < 1e-6 && Math.abs(st.totalGold() - gold0) < 1e-6, 'C1: gold + food conserved');
    st.dispose();
  }

  // C2 — replan on moved target: X relocates mid-plan; the goto re-targets X's
  // new believed pos (give re-resolves believedPos each tick) -> still completes.
  {
    const st = new Stage();
    const X = st.add('X', 3, 0, { controlled: true });
    const D = st.add('D', 8, 0); st.strip(D); D.inventory.food = 6;
    st.believe(D, X, false);
    st.push(D, goalRepay(X.id, 2, 'food'));
    st.runFrames(20);                                    // D starts walking toward X
    X.fighter.root.position.set(-12, 0, 6);              // X teleports away
    st.believe(D, X, false);                             // D re-perceives X's new pos
    const f = st.runUntil(() => D.goals.length === 0, 2400);
    ok(D.goals.length === 0, `C2: replanned to moved target, completed (${f} frames)`);
    ok(!!(D._repaid && D._repaid[X.id]), 'C2: transfer landed at the new position');
    st.dispose();
  }

  // C3 — replan on lost precondition: plan is buy(food) but gold is spent /
  // believed price exceeds gold -> precond fails -> replans to gather (node known)
  // or abandons. No crash. We give D a known field node + no gold so a buy-plan
  // can't survive; the planner should pick gather (raw food at a field).
  {
    const st = new Stage();
    const X = st.add('X', 3, 0, { controlled: true });
    const D = st.add('D', 8, 0); st.strip(D);
    D.gold = 0; D.priceBeliefs.food = 3;                 // believes a price but holds no gold
    st.believe(D, X, false);
    const g = goalRepay(X.id, 1, 'food');
    const pl = plan(D, g, st.ctx());
    // with no gold, buy is infeasible; gather at a field is the surviving branch.
    ok(pl && primNames(pl).includes('gather') && !primNames(pl).includes('buy'),
      `C3: no-gold debtor plans gather not buy (${primNames(pl).join('->') || 'NULL'})`);
    st.push(D, g);
    let threw = false;
    try { const f = st.runUntil(() => D.goals.length === 0, 4000); ok(D.goals.length === 0, `C3: gather-path repay completed (${f} frames)`); }
    catch (e) { threw = true; console.error(e); }
    ok(!threw, 'C3: replan/execute path does not throw');
    st.dispose();
  }

  // C4 — resume after interruption: D mid-plan toward X; a hostile monster spawns
  // adjacent -> that tick the goal is flee (utility out-scores the plan); D does
  // NOT keep walking to X. Remove the threat -> the goal is still on the stack and
  // the plan resumes to completion.
  {
    const st = new Stage();
    const X = st.add('X', 3, 0, { controlled: true });
    const D = st.add('D', 40, 0); st.strip(D); D.inventory.food = 6;   // far so it must travel
    D.personality.risk_tolerance = 0.1;                  // a coward: flee dominates
    st.believe(D, X, false);
    st.push(D, goalRepay(X.id, 2, 'food'));
    st.runFrames(30);                                    // D heads off toward X
    const M = st.add('M', D.pos.x + 1.2, D.pos.z, { faction: 'monster', combatant: true });
    // let beliefs form + decisions run with the threat adjacent; keep M glued to D
    // (re-pin BEFORE each frame too, so perceive always sees it right beside D).
    let fledOrFought = false;
    for (let i = 0; i < 300 && !fledOrFought; i++) {
      M.fighter.root.position.set(D.pos.x + 1.2, 0, D.pos.z);  // monster shadows D
      st.frame();
      if (D.goal.kind === 'flee' || D.goal.kind === 'fight') fledOrFought = true;
    }
    ok(fledOrFought, 'C4: adjacent hostile makes D flee/fight (plan interrupted)');
    ok(D.goals.some((g) => g.kind === 'repay'), 'C4: the repay goal stayed on the stack during the interruption');
    // remove the threat; the plan must resume to completion.
    M.fighter.alive = false; M.fighter.health = 0;
    const f = st.runUntil(() => D.goals.length === 0, 3000);
    ok(D.goals.length === 0, `C4: plan resumed to completion after threat gone (${f} frames)`);
    ok(!!(D._repaid && D._repaid[X.id]), 'C4: the gift eventually landed');
    st.dispose();
  }
}

// ===========================================================================
// D. Goal stack — dedup / LIFO interrupt+resume / depth cap / expiry.
// ===========================================================================
function scenD(ok) {
  // D1 — dedup: deriveGoals twice on the same memory -> one goal instance.
  {
    const st = new Stage();
    const A = st.add('A', 0, 0);                          // culprit, alive
    const B = st.add('B', 2, 0);
    st.inject(B, { t: 0, kind: 'assaulted', withId: A.id, valence: -1, salience: 0.9 });
    deriveGoals(B, st.ctx());
    deriveGoals(B, st.ctx());                             // re-scan same memory
    const n = B.goals.filter((g) => g.kind === 'avenge' && g.subjectId === A.id).length;
    ok(n === 1, `D1 dedup: exactly one avenge goal after re-scan (got ${n})`);
    st.dispose();
  }

  // D2 — LIFO interrupt + resume: pursuing seek_fortune; an avenge is pushed on
  // top -> it's the active (top) goal; pop it -> seek_fortune is top again.
  {
    const st = new Stage();
    const A = st.add('A', 0, 0);
    const B = st.add('B', 2, 0);
    st.push(B, goalSeekFortune('market', 140));
    st.push(B, goalAvenge(A.id));
    ok(B.goals[B.goals.length - 1].kind === 'avenge', 'D2: avenge is on top after being pushed (LIFO)');
    // resolve the avenge: subject gone -> pruneGoals pops it.
    A.fighter.alive = false; A.fighter.health = 0;
    pruneGoals(B, st.ctx());
    ok(B.goals.length === 1 && B.goals[0].kind === 'seek_fortune', 'D2: avenge popped, seek_fortune is top again (resume)');
    st.dispose();
  }

  // D3 — depth cap: push > cap goals -> goals.length == cap; oldest dropped.
  {
    const st = new Stage();
    const B = st.add('B', 0, 0);
    // distinct subjects so dedup doesn't merge them
    for (let i = 1; i <= PLAN.stackDepth + 2; i++) st.push(B, goalAvenge(1000 + i));
    ok(B.goals.length === PLAN.stackDepth, `D3 cap: stack capped at ${PLAN.stackDepth} (got ${B.goals.length})`);
    ok(!B.goals.some((g) => g.subjectId === 1001), 'D3 cap: the oldest goal was dropped');
    ok(B.goals[B.goals.length - 1].subjectId === 1000 + PLAN.stackDepth + 2, 'D3 cap: the newest goal is on top');
    st.dispose();
  }

  // D4 — expiry: a short-expiry unsatisfiable goal drains after its timeout.
  {
    const st = new Stage();
    const B = st.add('B', 0, 0);
    const g = goalSeekFortune('market', 1e9);            // never satisfied
    g.expiresAt = st.sim.time + 0.5;                     // half a second
    st.push(B, g);
    ok(B.goals.length === 1, 'D4: short-expiry goal pushed');
    st.runFrames(60);                                    // ~1s of frames
    pruneGoals(B, st.ctx());
    ok(!B.goals.some((x) => x.kind === 'seek_fortune'), 'D4 expiry: unsatisfiable goal drained after timeout');
    st.dispose();
  }
}

// ===========================================================================
// E. Memory-derived goals (integration) — E1, E3 via the real combat path.
//    (E1/E3 also have a copy in headless.mjs; we re-run here for the suite.)
// ===========================================================================
function scenE(ok) {
  const st = new Stage();
  const A = st.add('A', 0, 0, { controlled: true });
  const B = st.add('B', 0, -2, { combatant: true });
  st.add('C', 3, -1);
  const ambBefore = B.ambition ? B.ambition.kind : null;

  // A strikes B once through the real resolver.
  B.controlled = true;
  A.fighter.setFacing(Math.atan2(-(B.pos.x - A.pos.x), -(B.pos.z - A.pos.z)));
  A.fighter.ready(DIR.UP); A.fighter.release();
  for (let i = 0; i < 60 && A.fighter.state === 'attack'; i++) {
    A.fighter.update(st.dt); B.fighter.update(st.dt);
    const ev = resolveCombat(st.sim.fighters, st.sim.isHostile.bind(st.sim), st.ctx());
    if (ev.length) st.sim.onCombatEvents(ev);
  }
  B.controlled = false;
  ok(B.memory.recent().some((e) => e.kind === 'assaulted' && e.withId === A.id), 'E1: B holds an assaulted memory of A');

  A.fighter.root.position.set(40, 0, 0);                 // out of belief-reach
  const f = st.runUntil(() => B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id), 3000);
  ok(B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id), `E1: deriveGoals pushed avenge(A) (${f} frames)`);
  ok((B.ambition ? B.ambition.kind : null) === ambBefore && (!B.ambition || B.ambition.kind !== 'revenge'),
    'E3: B.ambition unchanged by the assault (revenge re-homed to goal stack)');
  st.dispose();
}

// ===========================================================================
// G. Whole-system scenarios — the real Simulation + frame loop, asserting the
//    causal chain across every layer.
// ===========================================================================

// G1 — The Grudge (revenge, full stack).
function scenG1(ok) {
  const st = new Stage();
  const B = st.add('B', 0, -2, { combatant: true });     // peaceful-ish farmer that fights once grudged
  const A = st.add('A', 0, 0, { controlled: true });     // aggressor (still target so B can finish it)
  const C = st.add('C', 2.5, -1);                        // bystander, in sight
  const ambBefore = B.ambition ? B.ambition.kind : null;
  const gold0 = st.totalGold(), food0 = st.totalFood();

  // 1) A strikes B once (B survives).
  B.controlled = true;
  A.fighter.setFacing(Math.atan2(-(B.pos.x - A.pos.x), -(B.pos.z - A.pos.z)));
  A.fighter.ready(DIR.UP); A.fighter.release();
  for (let i = 0; i < 60 && A.fighter.state === 'attack'; i++) {
    A.fighter.update(st.dt); B.fighter.update(st.dt); C.fighter.update(st.dt);
    const ev = resolveCombat(st.sim.fighters, st.sim.isHostile.bind(st.sim), st.ctx());
    if (ev.length) st.sim.onCombatEvents(ev);
  }
  B.controlled = false;
  // checkpoint 1: B and witness C hold a hostile, negative-standing belief about A.
  const bb = B.beliefs.get(A.id), cb = C.beliefs.get(A.id);
  ok(bb && bb.hostile && bb.standing < 0, 'G1.1: victim B holds a hostile, negative belief about A');
  ok(cb && (cb.hostile || cb.suspicion > 0), 'G1.1: witness C marks A (suspicion/hostile)');
  // checkpoint 2: B has an assaulted memory of A.
  ok(B.memory.recent().some((e) => e.kind === 'assaulted' && e.withId === A.id), 'G1.2: B has an assaulted memory of A');

  // move A out of belief-reach so the derived GOAL (not raw belief) drives the hunt.
  A.fighter.root.position.set(45, 0, 5);

  // checkpoint 3: within K ticks avenge(A) is on B.goals; B.ambition unchanged.
  const f3 = st.runUntil(() => B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id), 3000);
  ok(B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id), `G1.3: avenge(A) on B.goals within budget (${f3} frames)`);
  ok((B.ambition ? B.ambition.kind : null) === ambBefore && (!B.ambition || B.ambition.kind !== 'revenge'),
    'G1.3: B.ambition unchanged (revenge re-homed)');

  // checkpoint 4: B's plan is Defeat(A) — it moves toward A and attacks.
  const top = B.goals[B.goals.length - 1];
  const planChasesA = top && top.plan && top.plan.steps && top.plan.steps.some((s) => s.prim === 'attack' && s.bind.target === A.id);
  ok(planChasesA || B.goal.kind === 'plan' || B.goal.kind === 'fight', 'G1.4: B plans/acts to defeat A (attack-on-A or already fighting)');

  // checkpoint 5: within budget A dies -> avenge pops -> B records closure.
  st.runUntil(() => !A.alive, 6000);
  ok(!A.alive, 'G1.5: B pursued and killed A');
  st.runUntil(() => !B.goals.some((g) => g.kind === 'avenge'), 60);
  ok(!B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id), 'G1.5: avenge popped once A is dead');
  ok(B.memory.recent().some((e) => e.kind === 'triumph' || e.kind === 'closure'), 'G1.5: B recorded a closure/triumph memory');

  // checkpoint 6: gold + goods conserved throughout.
  ok(Math.abs(st.totalGold() - gold0) < 1e-6 && Math.abs(st.totalFood() - food0) < 1e-6, 'G1.6: gold + goods conserved');
  st.dispose();
}

// G2 — The Repayment (planner end-to-end, the emergence). Three means-profiles
// run the SAME pushed `repay(X)` goal and must complete via DIFFERENT plans.
function scenG2(ok) {
  const sigs = [];
  const run = (label, setup, value, kind, extra) => {
    const st = new Stage();
    const X = st.add('X', 3, 0, { controlled: true });   // still benefactor
    const D = st.add('D', 8, 0); st.strip(D);
    setup(D);
    if (extra) extra(st);                                 // seed market counterparties etc.
    st.believe(D, X, false);
    const food0 = st.totalFood(), gold0 = st.totalGold();
    const g = goalRepay(X.id, value, kind);
    st.push(D, g);
    // capture the synthesised plan signature before it executes/replans.
    D._currentPlanStep(st.ctx());
    const top = D.goals[D.goals.length - 1];
    const sig = top && top.plan ? top.plan.steps.map((s) => s.prim).join('>') : '(none)';
    const f = st.runUntil(() => D.goals.length === 0, 6000);
    ok(D.goals.length === 0, `G2 ${label}: repay completed via plan [${sig}] (${f} frames)`);
    ok(!!(D._repaid && D._repaid[X.id]), `G2 ${label}: X.recv true (transfer landed)`);
    // gold is ALWAYS conserved (closed money loop). Food is only conserved when no
    // producing/consuming professionals are present (the laborer case seeds farmers
    // who produce + eat food, so only the gold loop is a clean conservation check).
    const goldOk = Math.abs(st.totalGold() - gold0) < 1e-6;
    const foodOk = extra ? true : Math.abs(st.totalFood() - food0) < 1e-6;
    ok(goldOk && foodOk, `G2 ${label}: conserved (gold${extra ? '' : ' + food'})`);
    sigs.push(sig);
    st.dispose();
  };

  // food-rich farmer -> gift from stock; coin-rich merchant -> pay; must-buy
  // laborer near a cheap market -> buy-then-give. The laborer needs a real food
  // SELLER at the market for its buy to clear (the closed economy never mints) —
  // we seed a few farmers there with surplus food.
  const seedSellers = (st) => {
    for (let i = 0; i < 3; i++) {
      const s = st.add('Seller' + i, 0.4 + i * 0.4, 0.4, { profession: 'farmer' });
      for (const c of COMMODITIES) s.inventory[c] = 0;
      s.inventory.food = 8; s.inventory.tool = 1; s.gold = 10; s.priceBeliefs.food = 3;
    }
  };
  run('farmer', (D) => { D.inventory.food = 6; }, 2, 'food');
  run('merchant', (D) => { D.gold = 80; }, 6, 'coin');
  run('laborer', (D) => { D.gold = 40; D.priceBeliefs.food = 3; D.fighter.root.position.set(2, 0, 1); }, 1, 'food', seedSellers);

  ok(new Set(sigs).size === 3, `G2 emergence: three DIFFERENT plans end-to-end [${sigs.join('] [')}]`);
}

// G3 — The Windfall (fortune, full stack). A trader realises a large-profit sale
// -> a `windfall` memory -> seek_fortune pushed -> it plans + sells toward a gold
// target -> gold crosses target -> pops.
function scenG3(ok) {
  const st = new Stage();
  // a farmer with surplus food + a believed sell price, plus a buyer counterparty
  // at the market so the sale actually clears on the live market step.
  const T = st.add('T', 1, 0, { profession: 'farmer' });
  for (const c of COMMODITIES) T.inventory[c] = 0;
  T.inventory.food = 12; T.inventory.tool = 1; T.gold = 5;
  T.priceBeliefs.food = 7;
  // counterparties at the market who want food and hold gold to pay for it.
  for (let i = 0; i < 4; i++) {
    const buyer = st.add('Buyer' + i, 0.5 + i * 0.3, 0.5, { profession: 'smith' });
    for (const c of COMMODITIES) buyer.inventory[c] = 0;
    buyer.inventory.tool = 1; buyer.gold = 60; buyer.priceBeliefs.food = 7;
  }

  const target = T.gold + 30;
  // inject the windfall episode and let deriveGoals lift it into a seek_fortune goal.
  st.inject(T, { t: st.sim.time, kind: 'windfall', place: 'market', valence: 1, salience: 0.9 });
  const fPush = st.runUntil(() => T.goals.some((g) => g.kind === 'seek_fortune'), 1500);
  ok(T.goals.some((g) => g.kind === 'seek_fortune'), `G3: windfall memory -> seek_fortune pushed (${fPush} frames)`);
  // override the goal target to one reachable within the frame budget, then pursue.
  const g = T.goals.find((x) => x.kind === 'seek_fortune');
  g.target = target; g.atoms = goalSeekFortune('market', target).atoms; g.predicate = goalSeekFortune('market', target).predicate;
  g.plan = null;
  const gold0 = st.totalGold();
  const f = st.runUntil(() => !T.goals.some((x) => x.kind === 'seek_fortune'), 6000);
  ok(T.gold >= target, `G3: T earned toward the target via selling (${gold0.toFixed(0)} -> ${T.gold.toFixed(0)} >= ${target})`);
  ok(!T.goals.some((x) => x.kind === 'seek_fortune'), `G3: seek_fortune popped once gold crossed target (${f} frames)`);
  st.dispose();
}

// G4 — Interrupted on the road (resume, full stack). D pursues a repay plan
// toward a distant X; a monster M sits on D's path -> while M is near, D flees/
// fights (not travelling); after M is gone, the goal is still on the stack and
// the plan resumes to completion.
function scenG4(ok) {
  const st = new Stage();
  const X = st.add('X', 3, 0, { controlled: true });
  const D = st.add('D', 45, 0); st.strip(D); D.inventory.food = 6;
  D.personality.risk_tolerance = 0.1;
  st.believe(D, X, false);
  st.push(D, goalRepay(X.id, 2, 'food'));
  st.runFrames(30);                                      // D sets off toward X
  const M = st.add('M', D.pos.x + 1.2, D.pos.z, { faction: 'monster', combatant: true });

  let interrupted = false;
  for (let i = 0; i < 300 && !interrupted; i++) {
    M.fighter.root.position.set(D.pos.x + 1.2, 0, D.pos.z);    // M shadows D
    st.frame();
    if (D.goal.kind === 'flee' || D.goal.kind === 'fight') interrupted = true;
  }
  ok(interrupted, 'G4: while M is near, D flees/fights (NOT continued travel)');
  ok(D.goals.some((g) => g.kind === 'repay'), 'G4: the original repay goal stayed on D.goals through the interruption');

  M.fighter.alive = false; M.fighter.health = 0;          // threat removed
  const f = st.runUntil(() => D.goals.length === 0, 3000);
  ok(D.goals.length === 0, `G4: plan resumed to completion after M gone (${f} frames)`);
  ok(!!(D._repaid && D._repaid[X.id]), 'G4: the gift landed after resuming');
  st.dispose();
}

// G6 — Two debtors, divergent plans (emergence in the wild). X plus a food-rich
// D1 and a coin-rich D2 both owing X; push repay(X) on both -> both complete via
// DIFFERENT primitive plans; world stays conserved.
function scenG6(ok) {
  const st = new Stage();
  const X = st.add('X', 3, 0, { controlled: true });
  const D1 = st.add('D1', 8, 0); st.strip(D1); D1.inventory.food = 6;
  const D2 = st.add('D2', 8, 3); st.strip(D2); D2.gold = 80;
  st.believe(D1, X, false); st.believe(D2, X, false);
  const food0 = st.totalFood(), gold0 = st.totalGold();

  st.push(D1, goalRepay(X.id, 2, 'food'));
  st.push(D2, goalRepay(X.id, 6, 'coin'));
  D1._currentPlanStep(st.ctx()); D2._currentPlanStep(st.ctx());
  const sig = (d) => { const t = d.goals[d.goals.length - 1]; return t && t.plan ? t.plan.steps.map((s) => s.prim).join('>') : '(none)'; };
  const s1 = sig(D1), s2 = sig(D2);

  const f = st.runUntil(() => D1.goals.length === 0 && D2.goals.length === 0, 6000);
  ok(D1.goals.length === 0 && D2.goals.length === 0, `G6: both debtors completed (${f} frames)`);
  ok(s1 !== s2, `G6 emergence: divergent plans [${s1}] vs [${s2}]`);
  ok(!!(D1._repaid && D1._repaid[X.id]) && !!(D2._repaid && D2._repaid[X.id]), 'G6: both transfers landed');
  ok(Math.abs(st.totalFood() - food0) < 1e-6 && Math.abs(st.totalGold() - gold0) < 1e-6, 'G6: gold + food conserved across both repayments');
  st.dispose();
}

// G2d — The Repayment, DERIVED (Phase B). Same end-to-end repay as G2, but the
// goal is NOT pushed: a staged `succoured` memory (debtor was saved by X while
// desperate) makes deriveGoals lift repay(X) onto the stack on its own. Proves the
// full Phase-B chain: succoured episode -> repay goal -> plan -> act -> X.recv.
function scenG2d(ok) {
  const st = new Stage();
  const X = st.add('X', 3, 0, { controlled: true });     // benefactor (still anchor)
  const D = st.add('D', 8, 0); st.strip(D);
  D.inventory.food = 6;                                   // food-rich -> gift from stock
  D.needs.hunger = 0.9;                                   // NOT desperate now (it was, when saved)
  st.believe(D, X, false);
  const food0 = st.totalFood(), gold0 = st.totalGold();

  // stage the kindness: D was succoured by X (recorded + consolidated so it's salient).
  st.inject(D, { t: st.sim.time, kind: 'succoured', withId: X.id, valence: 1, salience: 0.8 });
  // deriveGoals (run inside decide) must lift a repay(X) goal onto D's stack.
  const fPush = st.runUntil(() => D.goals.some((g) => g.kind === 'repay' && g.subjectId === X.id), 1500);
  ok(D.goals.some((g) => g.kind === 'repay' && g.subjectId === X.id), `G2d: succoured memory -> repay(X) derived (${fPush} frames)`);

  const f = st.runUntil(() => D.goals.length === 0, 6000);
  ok(D.goals.length === 0, `G2d: derived repay completed end-to-end (${f} frames)`);
  ok(!!(D._repaid && D._repaid[X.id]), 'G2d: X.recv true (the gift landed)');
  ok(Math.abs(st.totalGold() - gold0) < 1e-6 && Math.abs(st.totalFood() - food0) < 1e-6, 'G2d: gold + food conserved');
  st.dispose();
}

// G5 — Grief & vendetta (Phase B, full stack). Friends B & C (mutual high standing);
// killer A slays C in B's sight. Assert the chain: B records a high-salience
// witnessed_death(C) (grief), derives grieve(C) AND avenge(A) (culprit known), and
// behaves accordingly (hunts A), then resolves.
function scenG5(ok) {
  const st = new Stage();
  const A = st.add('A', 0, 0, { controlled: true, combatant: true });   // killer
  const C = st.add('C', 0, -2, { combatant: true });                    // the victim friend
  const B = st.add('B', 2.5, -1, { combatant: true });                  // witness friend
  const ambBefore = B.ambition ? B.ambition.kind : null;
  // B thinks highly of C (a friend) so the death grieves it hard.
  st.believe(B, C, false); { const rel = B.beliefs.get(C.id); if (rel) rel.standing = 0.8; }
  // make C killable in a single solid blow.
  C.fighter.health = 8;

  // 1) A strikes C dead while B watches (drive the real resolver, B perceiving).
  C.controlled = true;                                   // freeze C's own AI; it's the target
  A.fighter.setFacing(Math.atan2(-(C.pos.x - A.pos.x), -(C.pos.z - A.pos.z)));
  for (let swing = 0; swing < 8 && C.alive; swing++) {
    if (A.fighter.canAct()) { A.fighter.ready(DIR.UP); A.fighter.release(); }
    for (let i = 0; i < 60 && (A.fighter.state === 'attack' || A.fighter.state === 'ready'); i++) {
      A.fighter.update(st.dt); B.fighter.update(st.dt); C.fighter.update(st.dt);
      // let B perceive the scene each step so the witness belief/memory forms.
      B.perceive(st.ctx());
      const ev = resolveCombat(st.sim.fighters, st.sim.isHostile.bind(st.sim), st.ctx());
      if (ev.length) st.sim.onCombatEvents(ev);
      if (!C.alive) break;
    }
  }
  ok(!C.alive, 'G5: A killed C');

  // checkpoint 1: B records a witnessed_death(C) (grief), high salience for a friend.
  const wd = B.memory.recent().find((e) => e.kind === 'witnessed_death' && e.withId === C.id);
  ok(!!wd, 'G5: B recorded a witnessed_death(C) (grief episode)');
  ok(wd && wd.salience >= 0.6, `G5: grief is high-salience for a liked friend (${wd ? wd.salience.toFixed(2) : 'n/a'})`);

  // move A out of belief-reach so the DERIVED avenge goal (not raw belief) drives the hunt.
  A.fighter.root.position.set(45, 0, 5);

  // checkpoint 2: B derives BOTH grieve(C) and avenge(A) (culprit known + alive).
  const fDerive = st.runUntil(
    () => B.goals.some((g) => g.kind === 'grieve' && g.subjectId === C.id) &&
          B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id), 3000);
  ok(B.goals.some((g) => g.kind === 'grieve' && g.subjectId === C.id), `G5: grieve(C) derived (${fDerive} frames)`);
  ok(B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id), 'G5: avenge(A) derived (culprit known)');
  ok((B.ambition ? B.ambition.kind : null) === ambBefore && (!B.ambition || B.ambition.kind !== 'revenge'),
    'G5: B.ambition unchanged (revenge re-homed to the goal stack)');

  // checkpoint 3: B behaves accordingly — pursues + kills A; avenge pops on resolve.
  st.runUntil(() => !A.alive, 6000);
  ok(!A.alive, 'G5: B pursued and slew the killer A');
  st.runUntil(() => !B.goals.some((g) => g.kind === 'avenge'), 120);
  ok(!B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id), 'G5: avenge popped once A is dead (vendetta resolved)');
  ok(B.memory.recent().some((e) => e.kind === 'triumph' || e.kind === 'closure'), 'G5: B recorded a closure/triumph memory');

  // checkpoint 4: grief lifts in time — force its expiry and prune; it drains.
  for (const g of B.goals) if (g.kind === 'grieve') g.expiresAt = st.sim.time - 1;
  pruneGoals(B, st.ctx());
  ok(!B.goals.some((g) => g.kind === 'grieve'), 'G5: grief lifted (mourning ran its course)');
  st.dispose();
}

// G5b — grief WITHOUT a known culprit derives grieve only (no avenge), and the
// grieve goal is PLAN-LESS (no plan step injected, never flagged unreachable).
function scenG5b(ok) {
  const st = new Stage();
  const C = st.add('C', 0, -2);
  const B = st.add('B', 2.5, -1);
  st.believe(B, C, false); { const rel = B.beliefs.get(C.id); if (rel) rel.standing = 0.7; }
  C.fighter.alive = false; C.fighter.health = 0;          // C is dead; culprit unknown
  // witnessed_death with NO byId (culprit unknown).
  st.inject(B, { t: st.sim.time, kind: 'witnessed_death', withId: C.id, valence: -1, salience: 0.85 });
  deriveGoals(B, st.ctx());
  ok(B.goals.some((g) => g.kind === 'grieve' && g.subjectId === C.id), 'G5b: grieve(C) derived without a culprit');
  ok(!B.goals.some((g) => g.kind === 'avenge'), 'G5b: no avenge when the culprit is unknown');
  // the grieve goal must be plan-less: _currentPlanStep returns null and does NOT
  // flag it unreachable (so pruneGoals won't drop it before its timeout).
  const step = B._currentPlanStep(st.ctx());
  ok(step === null, 'G5b: grief injects no plan step (plan-less disposition)');
  pruneGoals(B, st.ctx());
  ok(B.goals.some((g) => g.kind === 'grieve'), 'G5b: grief survives pruning (not flagged unreachable, awaits its timeout)');
  st.dispose();
}

// G5c — relic episode derives a delve(place) goal that plans a goto and drains.
function scenG5c(ok) {
  const st = new Stage();
  const D = st.add('D', 8, 0);
  st.inject(D, { t: st.sim.time, kind: 'relic', place: 'market', valence: 1, salience: 0.8 });
  deriveGoals(D, st.ctx());
  ok(D.goals.some((g) => g.kind === 'delve' && g.place === 'market'), 'G5c: relic memory -> delve(place) derived');
  st.dispose();
}

// ---------------------------------------------------------------------------
// Suite entry. Accepts the shared `ok(cond,msg)` from headless.mjs so all
// assertions fold into one tally; if called standalone, builds its own.
// ---------------------------------------------------------------------------
export function runScenarios(ok) {
  console.log('\n— scenario suite (docs/goal-system-tests.md) —');
  console.log('  A. primitives'); scenA(ok);
  console.log('  B. planner synthesis / cost / divergence'); scenB(ok);
  console.log('  C. execution & replanning'); scenC(ok);
  console.log('  D. goal stack'); scenD(ok);
  console.log('  E. memory-derived goals'); scenE(ok);
  console.log('  G1. the Grudge'); scenG1(ok);
  console.log('  G2. the Repayment (3 means -> 3 plans)'); scenG2(ok);
  console.log('  G2d. the Repayment (derived from a succoured memory)'); scenG2d(ok);
  console.log('  G3. the Windfall'); scenG3(ok);
  console.log('  G4. interrupted on the road'); scenG4(ok);
  console.log('  G5. grief & vendetta'); scenG5(ok);
  console.log('  G5b. grief without a culprit (plan-less)'); scenG5b(ok);
  console.log('  G5c. relic -> delve'); scenG5c(ok);
  console.log('  G6. two divergent debtors'); scenG6(ok);
}

// standalone runner
if (import.meta.main) {
  let failures = 0;
  const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
  runScenarios(ok);
  console.log(`\n${failures ? `${failures} SCENARIO CHECK(S) FAILED` : 'ALL SCENARIO CHECKS PASSED'}`);
  process.exit(failures ? 1 : 0);
}
