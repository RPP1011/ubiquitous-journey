// ---- planner self-test: GOAP synthesis + the EMERGENCE ------------------
// Build throwaway agents with different MEANS and assert the SAME goal (repay X)
// yields agent-specific plans — proving plans emerge from believed state, not
// from authored recipes (docs/goal-system.md §4.2, tests B2/B3/B4).

import { World } from '../../js/sim/world.js';
import { Agent } from '../../js/sim/agent.js';
import { plan, goalRepay, goalSeekFortune, goalAvenge, goalSteal, goalSate, goalLearn, goalMuster,
  ACQUIRE, Atom, stepEffectHolds, recordBelieves, believesConf, complianceOf } from '../../js/sim/planner.js';
import { URCHIN, QUANTITY, KNOW, ROB, HOLD, RECRUIT } from '../../js/sim/simconfig.js';

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

  // URCHIN — epistemic atoms (Phase 4, Ex.5): the heist backward-chains through know_assoc.
  // `shadow` is the epistemic `gather` (acquire the stash belief); a gossiped stash collapses
  // the plan — a tip is literally plan-cost saved. Forced ON (day-one OFF), restored after.
  {
    const prevUrchin = URCHIN.enabled;
    URCHIN.enabled = true;
    try {
      const mark = mk('Mark'); mark.pos.set(20, 0, 20);
      // an urchin who has SEEN the mark (a belief) but does NOT know where he stashes.
      const pip = debtor('Pip', () => {});
      pip.beliefs.observe(mark.id, mark.faction, mark.pos, ctx.time, false);
      const pNoAssoc = plan(pip, goalSteal(mark.id, 5), ctx);
      ok(pNoAssoc && names(pNoAssoc).join('->') === 'shadow->approach->burgle',
        `planner urchin: stash unknown -> case it first (${names(pNoAssoc).join('->') || 'NULL'})`);

      // the SAME goal, but gossip already supplied the stash: the plan COLLAPSES to approach+burgle.
      const pip2 = debtor('Pip2', () => {});
      const b = pip2.beliefs.observe(mark.id, mark.faction, mark.pos, ctx.time, false);
      b.assoc = { placeKind: 'stash', pos: { x: 22, z: 22 }, conf: 0.8 };
      const pAssoc = plan(pip2, goalSteal(mark.id, 5), ctx);
      ok(pAssoc && names(pAssoc).join('->') === 'approach->burgle',
        `planner urchin: stash gossiped -> plan collapses, a tip is cost saved (${names(pAssoc).join('->') || 'NULL'})`);
    } finally { URCHIN.enabled = prevUrchin; }
  }

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

  // QUANTITY — numeric-threshold composition (docs/architecture/10, Phase 1). Forced ON
  // (day-one OFF), restored after. Proves: the planner COMPOSES several sales toward a gold
  // target (greedy, best price first); an UNREACHABLE target SATISFICES (best partial + the
  // partial flag plan() cools the goal on); a BOLD agent WIDENS into its keep reserve where a
  // timid one will not; and a graded NEED composes several meals toward a level threshold.
  {
    const prevQ = QUANTITY.enabled;
    QUANTITY.enabled = true;
    try {
      const sells = (pl) => pl ? pl.steps.filter((s) => s.prim === 'sell').length : 0;

      // COMPOSITION — one sale of a single good can't cross the target, so the planner ADDS a
      // second acquisition (a sale of another good) until the believed total crosses it. food
      // surplus 5 @6 = 30, ore surplus 7 @5 = 35; 30 alone < 60, so a second sale is composed.
      const rich = debtor('Rich', (a) => { a.inventory.food = 8; a.inventory.ore = 8; a.priceBeliefs.food = 6; a.priceBeliefs.ore = 5; });
      const pRich = plan(rich, goalSeekFortune('market', 60), ctx);
      ok(pRich && !pRich.partial && pRich.steps[0].prim === 'goto' && sells(pRich) >= 2,
        `planner Q1: composes goto + several sales across goods toward a high target (${names(pRich).join('->') || 'NULL'})`);

      // GREEDY — best believed price first. ore@9 outranks food@6, so the first SALE is ore.
      const greedy = debtor('Greedy', (a) => { a.inventory.food = 8; a.inventory.ore = 8; a.priceBeliefs.food = 6; a.priceBeliefs.ore = 9; });
      const pGreedy = plan(greedy, goalSeekFortune('market', 40), ctx);
      const firstSale = pGreedy && pGreedy.steps.find((s) => s.prim === 'sell');
      ok(firstSale && firstSale.bind.good === 'ore',
        `planner Q2: greedy sells the higher-priced good first (${firstSale ? firstSale.bind.good : 'NONE'})`);

      // SATISFICE — an UNREACHABLE target returns the best partial it CAN run (earn what it can),
      // marked .partial with a positive shortfall, NOT a null dead-end. surplus 1 @6 = 6 << 80.
      const poor = debtor('Poor', (a) => { a.inventory.food = 4; a.priceBeliefs.food = 6; });
      const pPoor = plan(poor, goalSeekFortune('market', 80), ctx);
      ok(pPoor && pPoor.partial === true && pPoor.shortfall > 0 && sells(pPoor) >= 1,
        `planner Q3: unreachable target satisfices (partial, shortfall ${pPoor ? pPoor.shortfall : '?'}, ${names(pPoor).join('->') || 'NULL'})`);

      // WIDEN — at exactly the keep reserve (food 3 == keep) a TIMID agent has no surplus and
      // can't reach a small target; a BOLD agent (risk_tolerance past the widen gate) sells into
      // the reserve and reaches it. Same beliefs + means; only nature differs.
      const timid = debtor('Timid', (a) => { a.inventory.food = 3; a.priceBeliefs.food = 6; a.personality.risk_tolerance = 0.3; });
      const bold = debtor('Bold', (a) => { a.inventory.food = 3; a.priceBeliefs.food = 6; a.personality.risk_tolerance = 0.9; });
      const pTimid = plan(timid, goalSeekFortune('market', 10), ctx);
      const pBold = plan(bold, goalSeekFortune('market', 10), ctx);
      ok(pTimid && pTimid.partial === true && sells(pTimid) === 0,
        `planner Q4a: a timid agent won't sell its keep reserve (${names(pTimid).join('->') || 'NULL'})`);
      ok(pBold && !pBold.partial && sells(pBold) >= 1,
        `planner Q4b: a bold agent widens into the reserve and reaches it (${names(pBold).join('->') || 'NULL'})`);

      // GRADED NEED — meeting a need is crossing a level, not a flag: raising hunger 0.1 -> 0.8
      // composes SEVERAL meals (eat twice+ when one is short), eaten from stock.
      const hungry = debtor('Hungry', (a) => { a.inventory.food = 6; a.needs.hunger = 0.1; });
      const pSate = plan(hungry, goalSate('hunger', 0.8), ctx);
      const meals = pSate ? pSate.steps.filter((s) => s.prim === 'consume').length : 0;
      ok(pSate && meals >= 2, `planner Q5: a graded need composes several meals (${meals} consume steps)`);
    } finally { QUANTITY.enabled = prevQ; }
  }

  // KNOW — the knowledge model (docs/architecture/10, Phase 2). Forced ON (day-one OFF),
  // restored after. Proves: Know(topic) sits in a plan like any requirement, satisfied by an
  // observe/ask/study channel; a topic already held confidently is supplied FOR FREE (the step
  // drops out); and CONFIDENCE FOLDS INTO COST — a heist on a shaky stash belief costs more.
  {
    const prevKnow = KNOW.enabled;
    KNOW.enabled = true;
    try {
      // KNOW(recipe) — an agent that does NOT know a craft must LEARN it (observe/ask/study).
      const learner = debtor('Learner', () => {});
      learner.recipes = new Set();   // forget every craft → the recipe is a real requirement
      const pLearn = plan(learner, goalLearn({ kind: 'recipe', good: 'tool' }), ctx);
      const LEARN_CH = new Set(['observe', 'ask', 'study']);
      ok(pLearn && names(pLearn).some((n) => LEARN_CH.has(n)),
        `planner K1: Know(recipe) plans a learn channel (${names(pLearn).join('->') || 'NULL'})`);

      // KNOW(loc) — the cheap `ask` channel is reached for a location (vaguer than observe but
      // quicker), so an agent with no stash belief asks around for it.
      const scout = debtor('Scout', () => {});
      const markK = mk('MarkK'); markK.pos.set(30, 0, 30);
      scout.beliefs.observe(markK.id, markK.faction, markK.pos, ctx.time, false);
      const pAsk = plan(scout, goalLearn({ kind: 'loc', subjectId: markK.id, place: 'stash' }), ctx);
      ok(pAsk && names(pAsk).some((n) => LEARN_CH.has(n)),
        `planner K2: Know(loc) plans a learn channel (${names(pAsk).join('->') || 'NULL'})`);

      // KNOWLEDGE SUPPLIED FOR FREE — an agent that already holds the recipe needs no plan at
      // all (the requirement is already true), so the learn step drops out and plan() is null.
      const adept = debtor('Adept', (a) => { a.recipes = new Set(['tool']); });
      const pKnown = plan(adept, goalLearn({ kind: 'recipe', good: 'tool' }), ctx);
      ok(pKnown === null, 'planner K3: a topic already known confidently needs no plan (free)');

      // CONFIDENCE-INTO-COST — the SAME heist costs MORE when the stash belief is shaky, so the
      // planner would scout again before betting. Two urchins, identical but for assoc confidence.
      const prevUrchin = URCHIN.enabled;
      URCHIN.enabled = true;
      try {
        const markC = mk('MarkC'); markC.pos.set(18, 0, 18);
        const sure = debtor('Sure', () => {});
        const bS = sure.beliefs.observe(markC.id, markC.faction, markC.pos, ctx.time, false);
        bS.assoc = { placeKind: 'stash', pos: { x: 20, z: 20 }, conf: 0.95 };
        const unsure = debtor('Unsure', () => {});
        const bU = unsure.beliefs.observe(markC.id, markC.faction, markC.pos, ctx.time, false);
        bU.assoc = { placeKind: 'stash', pos: { x: 20, z: 20 }, conf: 0.5 };
        const pSure = plan(sure, goalSteal(markC.id, 5), ctx);
        const pUnsure = plan(unsure, goalSteal(markC.id, 5), ctx);
        ok(pSure && pUnsure && pUnsure.cost > pSure.cost + 1e-3,
          `planner K4: confidence folds into cost — shaky stash costs more (${pSure?.cost.toFixed(2)} < ${pUnsure?.cost.toFixed(2)})`);
      } finally { URCHIN.enabled = prevUrchin; }
    } finally { KNOW.enabled = prevKnow; }
  }

  // ACQUIRE — the resource table (docs/architecture/10, Phase 3). The acquire actions are rows
  // of one table carrying the conservation rule: made rows (gather/produce) bring goods into
  // being; moved rows (buy/loot/burgle/rob) relocate existing gold/goods and are debited at the
  // source. Each acquire primitive carries its row's class + social trace into exec.
  {
    const made = new Set(ACQUIRE.filter((r) => r.made).map((r) => r.verb));
    const moved = new Set(ACQUIRE.filter((r) => !r.made).map((r) => r.verb));
    ok(made.has('gather') && made.has('produce') && made.size === 2,
      `planner R1: the MADE rows are exactly gather/produce ([${[...made].join(',')}])`);
    ok(moved.has('buy') && moved.has('loot') && moved.has('burgle') && moved.has('rob'),
      `planner R1: the MOVED rows include buy/loot/burgle/rob ([${[...moved].join(',')}])`);
    ok(ACQUIRE.every((r) => typeof r.socialTrace === 'string' && r.socialTrace.length > 0),
      'planner R1: every acquire row carries a social trace');

    // a made-row step carries its conservation class + trace in exec (the single source of it):
    // an agent with no stock/gold/price GATHERS the good to repay, and the gather step is `made`.
    const tiller = debtor('Tiller', () => {});
    const pGather = plan(tiller, goalRepay(X.id, 1, 'food'), ctx);
    const gStep = pGather && pGather.steps.find((s) => s.prim === 'gather');
    ok(gStep && gStep.exec.made === true && gStep.exec.socialTrace === 'honest_labour',
      `planner R2: a gather step carries made + honest_labour from its row (${gStep ? gStep.exec.socialTrace : 'NO GATHER'})`);

    // ROB — the `person` row, taking gold by force. Gated ON (day-one OFF), restored after. The
    // steal goal now routes through `rob` (reach the mark, take the purse), a MOVED/conserved row.
    const prevRob = ROB.enabled;
    ROB.enabled = true;
    try {
      const markR = mk('MarkR'); markR.pos.set(15, 0, 15);
      const thug = debtor('Thug', () => {});
      thug.beliefs.observe(markR.id, markR.faction, markR.pos, ctx.time, false);
      const pRob = plan(thug, goalSteal(markR.id, 5), ctx);
      const rStep = pRob && pRob.steps.find((s) => s.prim === 'rob');
      ok(rStep && rStep.exec.made === false && rStep.exec.socialTrace === 'robbery',
        `planner R3: ROB generates a moved/robbery acquire (${names(pRob).join('->') || 'NULL'})`);
    } finally { ROB.enabled = prevRob; }
  }

  // HOLD — the hold-until wait step (docs/architecture/10, Phase 4). Forced ON (day-one OFF),
  // restored after. Proves: a plan with a hold_until condition INSERTS a wait at a safe spot and
  // plans THROUGH it; an already-open window needs no wait (the step drops out); the held step
  // ADVANCES the moment the condition becomes believed-true; and it carries its deadline.
  {
    const prevHold = HOLD.enabled;
    HOLD.enabled = true;
    try {
      const lurker = mk('Lurker'); lurker.pos.set(40, 0, 40);   // a believed threat to wait out
      const waiter = debtor('Waiter', () => {});
      waiter.beliefs.observe(lurker.id, lurker.faction, lurker.pos, ctx.time, true);   // believed alive

      // a goal to wait, under cover (at the market), until the threat is believed gone — then it
      // would move. cond = dead(lurker), false now (the belief is fresh) ⇒ a hold step is inserted.
      const waitGoal = {
        kind: 'wait',
        atoms: [Atom.holdUntil(Atom.dead(lurker.id), 'market', ctx.time + 30)],
        predicate: () => false,
      };
      const pWait = plan(waiter, waitGoal, ctx);
      const holdStep = pWait && pWait.steps.find((s) => s.prim === 'hold');
      ok(pWait && holdStep && names(pWait).includes('goto'),
        `planner H1: a hold_until inserts a wait at a safe spot (${names(pWait).join('->') || 'NULL'})`);
      ok(holdStep && holdStep.bind.deadline === ctx.time + 30,
        'planner H2: the held step carries its abandonment deadline');

      // ALREADY OPEN — a condition already believed-true needs no wait, so the hold drops out and
      // (with nothing else to do) the plan is null. dead(unknown) is believed-true (no belief).
      const open = { kind: 'wait', atoms: [Atom.holdUntil(Atom.dead(987654), 'market')], predicate: () => false };
      const pOpen = plan(waiter, open, ctx);
      ok(pOpen === null, 'planner H3: an already-open window needs no wait (hold drops out)');

      // ADVANCE — the held step's effect lands (the plan advances) only when the condition becomes
      // believed-true. With the threat believed alive it waits; once the belief is gone, it advances.
      ok(holdStep && stepEffectHolds(waiter, ctx, holdStep) === false,
        'planner H4: the hold waits while the condition is still false');
      waiter.beliefs.erase(lurker.id);   // the window opens (the threat is no longer believed present)
      ok(holdStep && stepEffectHolds(waiter, ctx, holdStep) === true,
        'planner H4: the hold advances the moment the condition becomes believed-true');
    } finally { HOLD.enabled = prevHold; }
  }

  // RECRUIT — building a force (docs/architecture/10, Phase 5, the recruiter capstone). Forced ON
  // (day-one OFF), restored after. Proves: a believed-force threshold COMPOSES recruits the way a
  // gold target composes sales (greedy, most reliable first); an out-of-reach camp SATISFICES; and
  // both sides are modelled — compliance is a PREDICTION of an independent choice, and the leader's
  // model of "this candidate will follow" is a one-level Believes it records about them.
  {
    const prevRecruit = RECRUIT.enabled;
    RECRUIT.enabled = true;
    try {
      const leader = debtor('Leader', () => {});
      const c1 = mk('C1'); c1.pos.set(6, 0, 6);
      const c2 = mk('C2'); c2.pos.set(7, 0, 7);
      const c3 = mk('C3'); c3.pos.set(8, 0, 8);
      for (const [c, st] of [[c1, 0.9], [c2, 0.6], [c3, 0.3]]) {
        const b = leader.beliefs.observe(c.id, c.faction, c.pos, ctx.time, false);
        b.standing = st;   // believed disposition → compliance prediction
      }
      const recruits = (pl) => pl ? pl.steps.filter((s) => s.prim === 'recruit') : [];

      // COMPOSITION — muster a force to outmatch a believed camp of strength 3 by recruiting.
      const pMuster = plan(leader, goalMuster(3), ctx);
      ok(pMuster && !pMuster.partial && recruits(pMuster).length >= 2,
        `planner M1: muster composes several recruits toward a force target (${recruits(pMuster).length} recruits)`);

      // GREEDY — cheapest RELIABLE force first: the highest-standing candidate is recruited first
      // (a careful leader prefers a few certain followers to many doubtful ones).
      const firstR = recruits(pMuster)[0];
      ok(firstR && firstR.bind.target === c1.id,
        `planner M2: the most reliable candidate is recruited first (#${firstR ? firstR.bind.target : '?'})`);

      // SATISFICE — a camp too strong for the believed candidates can't be out-mustered, so it
      // returns the best partial it CAN raise (and a positive shortfall), like the gold path.
      const pBig = plan(leader, goalMuster(20), ctx);
      ok(pBig && pBig.partial === true && pBig.shortfall > 0,
        `planner M3: an out-of-reach camp satisfices (shortfall ${pBig ? pBig.shortfall.toFixed(2) : '?'})`);

      // COMPLIANCE is a prediction: a loyal friend reads high, a wary stranger low.
      ok(complianceOf(0.9) > complianceOf(-0.1) && complianceOf(0.9) <= 1,
        `planner M4: compliance rises with standing (friend ${complianceOf(0.9).toFixed(2)} > stranger ${complianceOf(-0.1).toFixed(2)})`);

      // BELIEVES, one level — the leader records its model of an independent decision ("they will
      // follow") about the candidate, and reads it back. A flat conf store, capped at one level.
      recordBelieves(leader, c1.id, 'will_follow', 0.8);
      ok(Math.abs(believesConf(leader, c1.id, 'will_follow') - 0.8) < 1e-9 &&
         believesConf(leader, c2.id, 'will_follow') === 0,
        'planner M5: a one-level Believes(candidate, will_follow) records + reads back');
    } finally { RECRUIT.enabled = prevRecruit; }
  }

  // never throws on the tick path even for a junk goal
  let threw = false;
  try { plan(farmer, { atoms: [{ pred: 'nonsense' }] }, ctx); } catch { threw = true; }
  ok(!threw, 'planner: junk goal does not throw');
}
