// ---- planner self-test: GOAP synthesis + the EMERGENCE ------------------
// Build throwaway agents with different MEANS and assert the SAME goal (repay X)
// yields agent-specific plans — proving plans emerge from believed state, not
// from authored recipes (docs/goal-system.md §4.2, tests B2/B3/B4).

import { World } from '../../js/sim/world.js';
import { Agent } from '../../js/sim/agent.js';
import { plan, goalRepay, goalSeekFortune, goalAvenge } from '../../js/sim/planner.js';

export function plannerSelfTest(ok, { makeFighter, stubScene }) {
  const P = () => ({ risk_tolerance: 0.5, social_drive: 0.5, ambition: 0.5, altruism: 0.5, curiosity: 0.5 });
  const world = new World(stubScene);
  let id = 1;
  const agentsById = new Map();
  const ctx = { agents: [], agentsById, world, time: 0, player: null };
  const mk = (name) => {
    const a = new Agent(makeFighter('knight', {}),
      { id: id++, name, profession: null, personality: P(), faction: 'townsfolk' });
    agentsById.set(a.id, a); ctx.agents.push(a);
    return a;
  };

  // benefactor X, a fixed nearby townsperson
  const X = mk('X'); X.pos.set(2, 0, 2);

  // a blank-slate debtor near X; `setup` gives it its means; it BELIEVES X's pos
  const debtor = (name, setup) => {
    const a = mk(name);
    for (const c in a.inventory) a.inventory[c] = 0;
    a.gold = 0; a.pos.set(5, 0, 5);
    setup(a);
    a.beliefs.observe(X.id, X.faction, X.pos, ctx.time, false);  // believed position
    return a;
  };

  const names = (pl) => pl ? pl.steps.map((s) => s.prim) : [];
  const last = (pl) => pl && pl.steps.length ? pl.steps[pl.steps.length - 1].prim : null;

  // B2 — food-rich farmer: gives from stock, NO market/buy/gather/pay step.
  const farmer = debtor('Farmer', (a) => { a.inventory.food = 6; });
  const pFarmer = plan(farmer, goalRepay(X.id, 2, 'food'), ctx);
  ok(pFarmer && last(pFarmer) === 'give', `planner B2: food-rich farmer plans give (${names(pFarmer).join('->') || 'NULL'})`);
  ok(pFarmer && !names(pFarmer).some((n) => n === 'buy' || n === 'gather' || n === 'pay'),
    'planner B2: farmer gifts from stock (no acquire/pay step)');

  // B3 — coin-rich merchant, goal accepts coin: uses pay, not give.
  const merchant = debtor('Merchant', (a) => { a.gold = 80; });
  const pMerch = plan(merchant, goalRepay(X.id, 6, 'coin'), ctx);
  ok(pMerch && last(pMerch) === 'pay', `planner B3: coin-rich merchant plans pay (${names(pMerch).join('->') || 'NULL'})`);
  ok(pMerch && !names(pMerch).includes('give'), 'planner B3: merchant pays coin (no give step)');

  // B4 — goods-less + coined laborer near a cheap market, goal demands a good:
  // acquire-first multi-step ending in give (the branch nobody authored).
  const laborer = debtor('Laborer', (a) => { a.gold = 40; a.pos.set(0.5, 0, 0.5); a.priceBeliefs.food = 3; });
  const pLab = plan(laborer, goalRepay(X.id, 1, 'food'), ctx);
  const acquiredThenGave = pLab && last(pLab) === 'give' &&
    names(pLab).some((n) => n === 'buy' || n === 'gather');
  ok(acquiredThenGave, `planner B4: laborer acquires-then-gives (${names(pLab).join('->') || 'NULL'})`);

  // EMERGENCE: same goal, three DIFFERENT plans from three lived understandings.
  const sigF = names(pFarmer).join('>'), sigM = names(pMerch).join('>'), sigL = names(pLab).join('>');
  ok(sigF !== sigM && sigM !== sigL && sigF !== sigL,
    `planner: emergence — distinct plans per means [${sigF}] [${sigM}] [${sigL}]`);

  // B1 — well-formed: every step's precondition is satisfiable by prior steps'
  // effects from believed state (last step targets X). Re-check the farmer chain.
  ok(pFarmer && pFarmer.steps[0].prim === 'goto', 'planner B1: plan opens by travelling to the target');
  ok(pFarmer && pFarmer.steps[pFarmer.steps.length - 1].bind.to === X.id,
    'planner B1: final transfer targets the benefactor X');

  // B5 — cost picks the cheaper means: agent with BOTH stock food AND gold (goal
  // accepts a good) gifts from stock; remove the stock and it must acquire.
  const both = debtor('Both', (a) => { a.inventory.food = 6; a.gold = 80; });
  const pBoth = plan(both, goalRepay(X.id, 1, 'food'), ctx);
  ok(pBoth && !names(pBoth).some((n) => n === 'buy' || n === 'gather'),
    `planner B5: with stock+gold, gifts from stock (${names(pBoth).join('->') || 'NULL'})`);
  for (const c in both.inventory) both.inventory[c] = 0;          // strip the stock
  const pBoth2 = plan(both, goalRepay(X.id, 1, 'food'), ctx);
  ok(pBoth2 && names(pBoth2).some((n) => n === 'buy' || n === 'gather'),
    `planner B5: stock removed -> switches to acquire (${names(pBoth2).join('->') || 'NULL'})`);

  // B6 — belief divergence: two agents identical except believed price/position
  // plan the SAME goal at DIFFERENT cost.
  const near = debtor('Near', (a) => { a.gold = 80; a.pos.set(2.5, 0, 2.5); });
  const far = debtor('Far', (a) => { a.gold = 80; a.pos.set(45, 0, 45); });
  const pNear = plan(near, goalRepay(X.id, 6, 'coin'), ctx);
  const pFar = plan(far, goalRepay(X.id, 6, 'coin'), ctx);
  ok(pNear && pFar && Math.abs(pNear.cost - pFar.cost) > 1e-3,
    `planner B6: belief divergence — same goal, different cost (${pNear?.cost.toFixed(2)} vs ${pFar?.cost.toFixed(2)})`);

  // B7 — infeasible -> graceful null (no gold, no stock, no profession, X unknown).
  const stuck = mk('Stuck');
  for (const c in stuck.inventory) stuck.inventory[c] = 0;
  stuck.gold = 0; stuck.pos.set(5, 0, 5);
  const pStuck = plan(stuck, goalRepay(999, 1, 'food'), ctx);   // unknown subject
  ok(pStuck === null, 'planner B7: infeasible goal returns null (no throw)');

  // seek_fortune: gold target met by selling surplus at the (believed) market.
  const trader = debtor('Trader', (a) => { a.gold = 20; a.inventory.food = 8; a.priceBeliefs.food = 6; });
  const pFortune = plan(trader, goalSeekFortune('market', 25), ctx);
  ok(pFortune && pFortune.steps.some((s) => s.prim === 'sell'),
    `planner: seek_fortune plans a sale to reach gold target (${names(pFortune).join('->') || 'NULL'})`);

  // avenge: subject dead -> chains goto + attack on the believed position.
  const foe = mk('Foe'); foe.pos.set(8, 0, 8);
  const avenger = debtor('Avenger', (a) => { a.combatant = true; });
  avenger.beliefs.observe(foe.id, foe.faction, foe.pos, ctx.time, true);
  const pAvenge = plan(avenger, goalAvenge(foe.id), ctx);
  ok(pAvenge && names(pAvenge).includes('attack'),
    `planner: avenge chains an attack on the believed target (${names(pAvenge).join('->') || 'NULL'})`);

  // never throws on the tick path even for a junk goal
  let threw = false;
  try { plan(farmer, { atoms: [{ pred: 'nonsense' }] }, ctx); } catch { threw = true; }
  ok(!threw, 'planner: junk goal does not throw');
}
