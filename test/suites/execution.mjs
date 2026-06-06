// ---- plan EXECUTION end-to-end (C1 / G2) --------------------------------
// Push a `repay(X)` goal onto a debtor and drive the REAL frame loop; the plan
// is injected as the high-priority candidate in decide() and executed in act().
// Assert: predicate flips true, goal pops, the benefactor actually receives the
// value, and gold/goods stay conserved across the whole run (no minting).

import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { resolveCombat } from '../../js/combat.js';
import { goalRepay } from '../../js/sim/planner.js';

export function executionTest(ok, { makeFighter, stubScene }) {
  const P = () => ({ risk_tolerance: 0.4, social_drive: 0.5, ambition: 0.5, altruism: 0.6, curiosity: 0.5 });
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });

  let nid = 1;
  const place = (a, x, z) => { a.fighter.root.position.set(x, 0, z); return a; };
  const add = (name, prof, x, z) => {
    const a = new Agent(makeFighter('knight', {}), { id: nid++, name, profession: prof, personality: P(), faction: 'townsfolk' });
    place(a, x, z); sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  };

  // benefactor X + a food-rich debtor D. Both professionless so neither eats nor
  // produces food — the only food movement is the gift, making the gift a clean
  // conservation check (the closed loop: a pure transfer, never minting).
  const X = add('X', null, 3, 0); X.controlled = true;   // a still anchor (no wander)
  const D = add('D', null, 8, 0);
  for (const c in D.inventory) D.inventory[c] = 0;
  D.inventory.food = 6; D.gold = 0;
  D.beliefs.observe(X.id, X.faction, X.pos, 0, false);   // D believes X's position

  const totalFood = () => sim.agents.reduce((s, a) => s + (a.inventory.food || 0), 0);
  const totalGold = () => sim.agents.reduce((s, a) => s + (a.gold || 0), 0);
  const food0 = totalFood(), gold0 = totalGold(), xFood0 = X.inventory.food;

  // push the goal: X must receive 2 food from D (a gift from stock -> [goto, give]).
  const g = D.pushGoal(goalRepay(X.id, 2, 'food'), sim._ctx());
  ok(D.goals.length === 1 && D.goals[0].kind === 'repay', 'exec C1: repay goal pushed onto debtor');

  const dt = 1 / 60;
  let frames = 0;
  for (; frames < 1800 && D.goals.length; frames++) {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  }
  ok(D.goals.length === 0, `exec C1: plan ran to completion, goal popped (${frames} frames)`);
  ok(!!(D._repaid && D._repaid[X.id]), 'exec C1: transfer landed (_repaid flag set)');
  ok(X.inventory.food >= xFood0 + 0.99, `exec C1: benefactor received the gift (${xFood0.toFixed(1)} -> ${X.inventory.food.toFixed(1)} food)`);
  ok(Math.abs(totalFood() - food0) < 1e-6, `exec C1: food conserved (${food0.toFixed(2)} -> ${totalFood().toFixed(2)})`);
  ok(Math.abs(totalGold() - gold0) < 1e-6, `exec C1: gold conserved (${gold0.toFixed(2)} -> ${totalGold().toFixed(2)})`);

  // a PUSHED coin debt (pay path) end-to-end: distinct primitive, gold MOVES.
  const Y = add('Y', null, 2, 2); Y.controlled = true;   // still anchor
  const M = add('M', null, 7, 7);
  for (const c in M.inventory) M.inventory[c] = 0;
  M.gold = 50; M.inventory.tool = 0;
  M.beliefs.observe(Y.id, Y.faction, Y.pos, sim.time, false);
  const gold1 = totalGold(), yGold0 = Y.gold;
  M.pushGoal(goalRepay(Y.id, 8, 'coin'), sim._ctx());
  let f2 = 0;
  for (; f2 < 1800 && M.goals.length; f2++) {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  }
  ok(M.goals.length === 0, `exec C1(pay): coin repay completed, goal popped (${f2} frames)`);
  ok(Y.gold >= yGold0 + 8, `exec C1(pay): benefactor received coin (${yGold0} -> ${Y.gold})`);
  ok(Math.abs(totalGold() - gold1) < 1e-6, 'exec C1(pay): gold conserved across the pay');

  // junk goal pushed onto an agent does not throw inside decide()/act().
  let threw = false;
  try {
    D.goals = [{ kind: 'junk', subjectId: 999, predicate: () => false, atoms: [{ pred: 'nonsense' }] }];
    for (let i = 0; i < 30; i++) {
      sim.update(dt);
      for (const f of sim.fighters) f.update(dt);
      const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
      if (ev.length) sim.onCombatEvents(ev);
    }
  } catch (e) { threw = true; console.error(e); }
  ok(!threw, 'exec: junk goal on the stack does not throw through decide/act');

  sim.dispose();
}
