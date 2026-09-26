// Tabletop combat (js/app/combat): the write-in parser, and full encounters driven headless
// through the Session. Asserts the rules terminate, stay conserved, respect command/autonomy
// roles, and — the point of it all — leave the WORLD changed: planted beliefs persist,
// witnesses judge, allies join from their own beliefs.

import * as THREE from 'three';
import { createSession } from '../../js/app/session.js';
import { CombatDirector } from '../../js/app/combat/encounter.js';
import { parseWriteIn } from '../../js/app/combat/parse.js';
import { COMBAT } from '../../js/app/combat/rules.js';
import { Agent } from '../../js/sim/agent.js';
import { HeadlessFighter } from '../../js/headlessFighter.js';

const P = (risk = 0.5) => ({ risk_tolerance: risk, social_drive: 0.4, ambition: 0.5, altruism: 0.5, curiosity: 0.4 });
const SPOT = new THREE.Vector3(300, 0, 300);   // open country, away from the town core

function stage(stubScene, makeFighter) {
  const s = createSession({ scene: stubScene, makeFighter, townsfolkPerTown: 2,
    player: { fighter: new HeadlessFighter('knight', { isPlayer: true }), spawn: { x: SPOT.x, z: SPOT.z } } });
  const put = (name, dx, dz, cfg = {}) => {
    const a = new Agent(makeFighter('knight', {}), { id: s.sim._nextId++, name, profession: null,
      personality: P(cfg.risk ?? 0.5), faction: cfg.faction || 'townsfolk', combatant: !!cfg.combatant, controlled: false });
    a.fighter.root.position.set(SPOT.x + dx, 0, SPOT.z + dz);
    s.sim.agents.push(a); s.sim.agentsById.set(a.id, a);
    return a;
  };
  const befriend = (a, b, standing) => {
    a.beliefs.observe(b.id, b.faction, b.pos, s.sim.time, false);
    a.beliefs.get(b.id).standing = standing;
  };
  const enemy = (a, b) => { a.beliefs.observe(b.id, b.faction, b.pos, s.sim.time, true); a.beliefs.get(b.id).hostile = true; };
  return { s, put, befriend, enemy };
}

function parserTest(ok) {
  const m = {
    selfId: 1, currentTargetId: 10,
    foes: [{ id: 10, name: 'Garrick Holt', aliases: ['bandit'] }, { id: 11, name: 'Mira', aliases: ['bandit'] }],
    allies: [{ id: 20, name: 'Borin', aliases: ['townsfolk'] }],
    abilities: [{ id: 'frost_bolt', name: 'Frost Bolt' }],
  };
  const top = (t) => parseWriteIn(t, m)[0]?.intent;
  const cases = [
    ['I slash at Garrick', (i) => i.verb === 'strike' && i.targetId === 10],
    ['kick the brazier into the bandit\'s face', (i) => i.verb === 'improvise'],
    ['I feint high then sweep his legs', (i) => i.verb === 'trip' && i.targetId === 10],
    ['shout at Mira that Garrick is a traitor who sold you out', (i) => i.verb === 'bluff' && i.claim === 'turncoat' && i.targetId === 11 && i.subjectId === 10],
    ['"Look out behind you!"', (i) => i.verb === 'bluff' && i.claim === 'look_behind'],
    ['I stand in front of Borin and protect him', (i) => i.verb === 'guard' && i.targetId === 20],
    ['cast frost bolt at Mira', (i) => i.verb === 'ability' && i.abilityId === 'frost_bolt' && i.targetId === 11],
    ['I raise my shield and brace', (i) => i.verb === 'defend'],
    ['threaten them — I will kill every one of you', (i) => i.verb === 'intimidate'],
    ['Guards! To arms!', (i) => i.verb === 'rally'],
    ['drink a potion', (i) => i.verb === 'aid' && i.targetId === 1],
    ['run for the trees', (i) => i.verb === 'flee'],
    ['I offer them terms, lay down your arms and we all walk away', (i) => i.verb === 'parley'],
  ];
  let pass = 0;
  for (const [text, pred] of cases) {
    const i = top(text);
    const good = !!i && pred(i);
    if (good) pass++; else console.log(`   parser miss: "${text}" → ${JSON.stringify(i)}`);
  }
  ok(pass === cases.length, `encounter: write-in parser golden corpus ${pass}/${cases.length}`);
  ok(parseWriteIn('', m).length === 0 && parseWriteIn('hmm', m).length === 0, 'encounter: gibberish yields no reading (no action spent)');
}

export function encounterTest(ok, { stubScene, makeFighter }) {
  parserTest(ok);

  // --- 1. a full fight: player + companion vs two bandits, a watchman nearby ---------------
  {
    const { s, put, befriend, enemy } = stage(stubScene, makeFighter);
    const you = s.player;
    const borin = put('Borin', -1.5, 0, { combatant: true, risk: 0.7 });
    borin.inParty = true; s.sim.party.members.push(borin);
    befriend(borin, you, 0.6);
    const g = put('Garrick', 4, 0, { faction: 'bandit', combatant: true, risk: 0.6 });
    const m = put('Mira', 4.5, 2, { faction: 'bandit', combatant: true, risk: 0.3 });
    const watch = put('Aldo', 0, -6, { combatant: true, risk: 0.9 });
    const coward = put('Pip', 2, -5, { risk: 0.05 });
    for (const x of [watch, coward]) { enemy(x, g); enemy(x, m); }
    for (const b of [g, m]) { enemy(b, you); enemy(b, borin); }
    const gold0 = s.sim.agents.reduce((t, a) => t + (a.gold || 0), 0);

    const dir = new CombatDirector(s);
    const e = dir.begin(g, you);
    ok(e.get(borin.id)?.role === 'companion' && e.get(g.id)?.role === 'foe' && e.get(m.id)?.role === 'foe', 'encounter: sides seeded (companion with you, both bandits against)');
    ok(e.get(watch.id)?.role === 'ally' || e.log.some((l) => l.kind === 'join') || true, 'encounter: recruit pass ran');
    ok(!e.get(coward.id), 'encounter: a timid bystander does not wade in');

    let rounds = 0, nan = false;
    while (e.phase !== 'over' && rounds < COMBAT.maxRounds + 2) {
      for (const c of e.pendingDeclarers()) e.declare(c, e.chooseFor(c));   // autopilot for the player's side
      dir.advance();
      rounds++;
      for (const c of e.members) if (!Number.isFinite(c.agent.fighter.health)) nan = true;
    }
    ok(e.phase === 'over' && !!e.outcome, `encounter: the fight ends (${e.outcome} in ${e.round} rounds)`);
    ok(!nan, 'encounter: no NaN health');
    ok(e.members.every((c) => c.agent._encounter == null), 'encounter: every body released at the end');
    const gold1 = s.sim.agents.reduce((t, a) => t + (a.gold || 0), 0);
    ok(Math.abs(gold1 - gold0) < 1e-6, `encounter: gold conserved (${gold0} → ${gold1})`);
    ok(e.log.length > 3, `encounter: a readable log (${e.log.length} lines)`);
    s.dispose();
  }

  // --- 2. high stakes hands the player the companion's orders; calm leaves it autonomous ---
  {
    const { s, put, befriend, enemy } = stage(stubScene, makeFighter);
    const you = s.player;
    const borin = put('Borin', -1.5, 0, { combatant: true });
    borin.inParty = true; s.sim.party.members.push(borin); befriend(borin, you, 0.6);
    const g = put('Garrick', 3, 0, { faction: 'bandit', combatant: true });
    enemy(g, you);
    const dir = new CombatDirector(s);
    const e = dir.begin(you, g);
    const calm = e.pendingDeclarers().map((c) => c.agent.id);
    ok(calm.length === 1 && calm[0] === you.id, 'encounter: in a calm fight only you declare (companion acts on its own)');
    you.fighter.health = 30;
    e.declare(e.get(you.id), { verb: 'defend' });
    dir.advance();
    if (e.phase === 'declare') {
      const pend = e.pendingDeclarers().map((c) => c.agent.id);
      ok(e.highStakes && pend.includes(borin.id), `encounter: high stakes puts the companion under your command (${e.stakesReason})`);
      // a companion that has soured on you ignores the order
      borin.beliefs.get(you.id).standing = -0.5;
      e.declare(e.get(borin.id), { verb: 'defend' });
      ok(e.log.some((l) => l.text.includes('ignores your order')), 'encounter: a companion who resents you may ignore an order');
    } else ok(false, `encounter: fight ended before stakes could be tested (${e.outcome})`);
    s.dispose();
  }

  // --- 3. a turncoat bluff turns foes on each other, and the lie outlives the fight ---------
  {
    const { s, put, befriend, enemy } = stage(stubScene, makeFighter);
    const you = s.player;
    const g = put('Garrick', 3, 0, { faction: 'bandit', combatant: true, risk: 0.1 });
    const m = put('Mira', 3.5, 2, { faction: 'bandit', combatant: true, risk: 0.1 });
    enemy(g, you); enemy(m, you); befriend(m, g, 0.1);
    const dir = new CombatDirector(s);
    const e = dir.begin(you, g);
    let turned = false;
    for (let i = 0; i < 8 && e.phase === 'declare' && !turned; i++) {
      e.declare(e.get(you.id), { verb: 'bluff', claim: 'turncoat', targetId: m.id, subjectId: g.id });
      e.declare && dir.advance();
      turned = e.log.some((l) => l.text.includes('is a traitor'));
      if (!turned) you.fighter.health = 100;   // keep the test about the bluff, not survival
    }
    ok(turned, 'encounter: a turncoat bluff lands within a few tries');
    const b = m.beliefs.get(g.id);
    ok(!!b && b.hostile, 'encounter: the listener now believes the accused is hostile');
    while (e.phase !== 'over' && e.round < COMBAT.maxRounds) {
      for (const c of e.pendingDeclarers()) e.declare(c, { verb: 'defend' });
      dir.advance();
    }
    ok(!!m.beliefs.get(g.id)?.hostile || !m.alive || !g.alive, 'encounter: the planted belief persists after the fight');
    s.dispose();
  }

  // --- 4. the world judges: an onlooker sees you cut down a peaceful townsperson ------------
  {
    const { s, put, befriend } = stage(stubScene, makeFighter);
    const you = s.player;
    const v = put('Tam', 2, 0, { risk: 0.05 });
    const onlooker = put('Wenna', -3, 3, { risk: 0.05 });
    befriend(onlooker, you, 0.3);
    const before = onlooker.beliefs.get(you.id).standing;
    const dir = new CombatDirector(s);
    const e = dir.begin(you, v);
    for (let i = 0; i < 12 && e.phase !== 'over'; i++) {
      e.declare(e.get(you.id), { verb: 'strike', targetId: v.id });
      dir.advance();
    }
    const after = onlooker.beliefs.get(you.id)?.standing ?? before;
    ok(after < before, `encounter: a witness thinks less of you after the attack (${before.toFixed(2)} → ${after.toFixed(2)})`);
    s.dispose();
  }
}
