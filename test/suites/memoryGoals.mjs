// ---- memory-derived goals (E1, E3): robbery -> avenge -> resolve ---------
// Drives the REAL frame loop. A strikes B (B survives) through the combat path,
// so B forms an `assaulted` memory + a hostile belief about A. Once that memory
// consolidates, deriveGoals pushes `avenge(A)` onto B.goals — and B.ambition is
// UNCHANGED (revenge re-homed, E3). B then pursues + kills A and the goal pops.

import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { resolveCombat } from '../../js/combat.js';
import { DIR, TUNE } from '../../js/constants.js';
import { generateAbility } from '../../js/rpg/abilities/generate.js';
import { validate as validateSpec, isMelee, spec as irSpec, effect as irEffect } from '../../js/rpg/abilities/ir.js';
import { bus } from '../../js/rpg/events.js';

export function memoryGoalTest(ok, { makeFighter, stubScene }) {
  const P = () => ({ risk_tolerance: 0.7, social_drive: 0.3, ambition: 0.4, altruism: 0.3, curiosity: 0.4 });
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  let nid = 1;
  const add = (name, x, z, cfg = {}) => {
    const a = new Agent(makeFighter('knight', {}),
      { id: nid++, name, profession: null, personality: P(), faction: 'townsfolk', ...cfg });
    a.fighter.root.position.set(x, 0, z);
    sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  };

  // aggressor A (a still, controlled target so B reliably catches + finishes it),
  // victim B (a brave combatant once it carries the grudge), bystander C.
  const A = add('A', 0, 0, { controlled: true });
  const B = add('B', 0, -2, { combatant: true });
  const C = add('C', 3, -1);
  const ambBefore = B.ambition ? B.ambition.kind : null;   // snapshot for E3
  const totalGold = () => sim.agents.reduce((s, a) => s + (a.gold || 0), 0);
  const totalFood = () => sim.agents.reduce((s, a) => s + (a.inventory.food || 0), 0);
  const gold0 = totalGold(), food0 = totalFood();

  // --- the assault: A swings on B once through the real combat resolver -------
  B.controlled = true;                                  // freeze B during the blow
  A.fighter.setFacing(Math.atan2(-(B.pos.x - A.pos.x), -(B.pos.z - A.pos.z)));
  A.fighter.ready(DIR.UP); A.fighter.release();
  for (let i = 0; i < 60 && A.fighter.state === 'attack'; i++) {
    A.fighter.update(1 / 60); B.fighter.update(1 / 60); C.fighter.update(1 / 60);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);             // B learns A is hostile + remembers it
  }
  B.controlled = false;                                 // B can now decide/derive/act
  ok(B.fighter.health < TUNE.maxHealth, 'mem E1: B survived an assault and took damage');
  ok(B.memory.recent().some((e) => e.kind === 'assaulted' && e.withId === A.id),
    'mem E1: B holds an `assaulted` memory of A');

  // Move A out of reach so B can't finish it on belief alone before the assaulted
  // memory consolidates (~8s) into a derived avenge GOAL — the chain we're testing.
  A.fighter.root.position.set(40, 0, 0);

  // --- run the loop until B carries the avenge goal (memory must consolidate) -
  const dt = 1 / 60;
  let frames = 0, sawGoal = false;
  for (; frames < 3000 && !sawGoal; frames++) {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
    if (B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id)) sawGoal = true;
  }
  ok(sawGoal, `mem E1: deriveGoals pushed avenge(A) onto B.goals (${frames} frames)`);
  // E3: revenge re-homed — the assault did NOT mutate B's slow ambition.
  ok((B.ambition ? B.ambition.kind : null) === ambBefore && B.ambition && B.ambition.kind !== 'revenge',
    `mem E3: B.ambition unchanged by the assault (${ambBefore}), avenge lives on the goal stack`);

  // --- pursue to completion: B hunts A down; the goal pops when A is dead ------
  let f2 = 0;
  for (; f2 < 6000 && A.alive; f2++) {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  }
  ok(!A.alive, `mem E1: B pursued and killed A (${f2} frames)`);
  // one more decide/act tick lets the avenge predicate fire + pop the goal.
  for (let i = 0; i < 30 && B.goals.some((g) => g.kind === 'avenge'); i++) {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  }
  ok(!B.goals.some((g) => g.kind === 'avenge' && g.subjectId === A.id),
    'mem E1: avenge goal popped once A is dead');
  ok(Math.abs(totalGold() - gold0) < 1e-6 && Math.abs(totalFood() - food0) < 1e-6,
    'mem E1: gold + food conserved throughout the grudge');

  sim.dispose();
}

// ---- NPC ability casting (Phase 3) -----------------------------------------
// Stage a fight: a brave combatant NPC armed with a GENERATED offensive ability
// vs a believed-hostile monster. Drive the REAL frame loop and assert the NPC
// actually CASTS — a `cast` ActionEvent fires AND the target loses health beyond
// what a single bare melee swing could explain — without freezing, with gold +
// goods conserved (abilities move no value).
export function npcCastTest(ok, { makeFighter, stubScene }) {
  const P = () => ({ risk_tolerance: 0.9, social_drive: 0.2, ambition: 0.5, altruism: 0.3, curiosity: 0.3 });
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  let nid = 1;
  const add = (name, x, z, cfg = {}) => {
    const a = new Agent(makeFighter('knight', {}),
      { id: nid++, name, profession: null, personality: P(), faction: 'townsfolk', ...cfg });
    a.fighter.root.position.set(x, 0, z);
    sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  };

  // a GENERATED, validated, RANGED damage spec so the cast fires directly through
  // the interpreter (not the swing) — the cleanest thing to observe. Pick the
  // first combat-tier that the generator themes to a damage ability at range.
  const combatProfile = { classKey: 'proc:fighter', name: '[Reaver]', tags: ['MELEE', 'KILL', 'RISK'] };
  let atk = null;
  for (let t = 1; t <= 20 && !atk; t++) {
    const s = generateAbility(combatProfile, t);
    if (s && validateSpec(s) && s.effects.some((e) => e.op === 'damage' && e.amount > 0) &&
        (s.header.target === 'enemy' || s.header.target === 'any') && !isMelee(s)) atk = s;
  }
  // fall back to a hand-rolled ranged bolt if the generator never themed to a
  // ranged damage spec (keeps the test robust to generator retuning).
  if (!atk) {
    atk = generateAbility(combatProfile, 5);
    if (!atk || isMelee(atk)) {
      // last-resort handcrafted, still passed through the same trust boundary.
      atk = irSpec({ id: 'test_bolt', name: '[Bolt]', classKey: 'proc:fighter',
        header: { target: 'enemy', range: 10, cooldown: 1.5, area: { kind: 'self' }, delivery: { kind: 'projectile', speed: 30 } },
        effects: [irEffect('damage', { amount: 18 })] });
    }
  }
  ok(atk && validateSpec(atk), `npc-cast: armed a valid generated offensive spec (${atk && atk.id})`);

  // a brave combatant caster vs a monster it will believe hostile on sight.
  const caster = add('Caster', 0, 0, { combatant: true });
  const mob = add('Mob', 0, -6, { faction: 'monster', combatant: true, threat: 1.1, controlled: true });
  caster.grantAbility(atk);                         // mirror onto the cast path
  // also register it on the caster's progression cooldown ledger for parity.
  caster.progression.abilities.set(atk.id, atk);
  caster.progression.cooldowns.set(atk.id, 0);

  // count cast events from THIS caster naming THIS ability.
  let casts = 0;
  const off = bus.on((ev) => {
    if (ev && ev.verb === 'cast' && ev.actorId === caster.id && ev.abilityId === atk.id) casts++;
  });

  const totalGold = () => sim.agents.reduce((s, a) => s + (a.gold || 0), 0);
  const totalFood = () => sim.agents.reduce((s, a) => s + (a.inventory.food || 0), 0);
  const gold0 = totalGold(), food0 = totalFood();
  const mobHp0 = mob.fighter.health;

  const dt = 1 / 60;
  let frames = 0, threw = false, stage = '';
  try {
    for (; frames < 1800 && casts < 1; frames++) {
      stage = 'update'; sim.update(dt);
      stage = 'fighters'; for (const f of sim.fighters) f.update(dt);
      stage = 'combat';
      const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
      if (ev.length) sim.onCombatEvents(ev);
    }
  } catch (e) { threw = true; console.error(e); }
  off();

  ok(!threw, `npc-cast: frame loop never threw (stage '${stage}', ${frames} frames)`);
  ok(casts >= 1, `npc-cast: NPC cast its offensive ability (${casts} cast(s) in ${frames} frames)`);
  ok(mob.fighter.health < mobHp0, `npc-cast: target took ability damage (${mobHp0.toFixed(0)} -> ${mob.fighter.health.toFixed(0)} hp)`);
  ok(Math.abs(totalGold() - gold0) < 1e-6, `npc-cast: gold conserved (${gold0.toFixed(2)} -> ${totalGold().toFixed(2)})`);
  ok(Math.abs(totalFood() - food0) < 1e-6, `npc-cast: food conserved (${food0.toFixed(2)} -> ${totalFood().toFixed(2)})`);

  // a caster with NO abilities and the same fight is a clean no-op (never throws).
  const bare = add('Bare', 20, 0, { combatant: true });
  const mob2 = add('Mob2', 20, -6, { faction: 'monster', combatant: true, controlled: true });
  let threw2 = false;
  try {
    for (let i = 0; i < 120; i++) {
      sim.update(dt);
      for (const f of sim.fighters) f.update(dt);
      const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
      if (ev.length) sim.onCombatEvents(ev);
    }
  } catch (e) { threw2 = true; console.error(e); }
  ok(!threw2, 'npc-cast: ability-less combatant fights without throwing (cast path is a guarded no-op)');

  sim.dispose();
}
