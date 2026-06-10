// ---- the per-agent authoring / targeting API (docs/architecture/12 §4 — the SET-UP axis) --------
// The authoring layer pins a CHOSEN pair and plants the targeted constellation, opening the matching
// emergent arc AND pushing a PRE-TARGETED Director arc (chosen principals, not _shuffle roulette).
// This is what makes the trope suite deterministic. We assert the immediate, deterministic effects.

import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { pin, forceBetrayal, falseWitness, starCross, captureTarget } from '../../js/sim/seeding.js';
import { arcKey } from '../../js/sim/arcs.js';

export function seedingTest(ok, { makeFighter, stubScene }) {
  const P = () => ({ risk_tolerance: 0.6, social_drive: 0.4, ambition: 0.5, altruism: 0.4, curiosity: 0.4 });
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  let nid = 1;
  const add = (name, house) => {
    const a = new Agent(makeFighter('knight', {}), { id: nid++, name, profession: null, personality: P(), faction: 'townsfolk', townsperson: true });
    if (house) a.house = house;
    sim.agents.push(a); sim.agentsById.set(a.id, a); return a;
  };
  const ada = add('Ada', 'Vale'), bram = add('Bram', 'Thorn'), cael = add('Cael'), wren = add('Wren');
  const totalGold = () => sim.agents.reduce((s, a) => s + (a.gold || 0), 0);

  // PIN — a conserved gold set (closed money loop) + a stamped field.
  {
    const g0 = totalGold(), want = (ada.gold || 0) + 40;
    pin(sim, ada.id, { gold: want, role: 'protagonist' });
    ok(ada.gold === want && ada.seedRole === 'protagonist', 'seeding PIN: a chosen field is stamped + gold set to target');
    ok(Math.abs(totalGold() - g0) < 1e-6, `seeding PIN: gold is a CONSERVED set (total ${g0.toFixed(0)} -> ${totalGold().toFixed(0)})`);
  }

  // FORCE BETRAYAL — a trusts then is wronged by b: vendetta arc opens, a holds the grudge, a
  // pre-targeted Director 'reckoning' is queued with the CHOSEN principals.
  {
    const okB = forceBetrayal(sim, ada.id, bram.id);
    ok(okB && sim.sagas.findArc(arcKey('vendetta', ada.id, bram.id)) != null, 'seeding FORCE_BETRAYAL: the vendetta arc opened on the chosen pair');
    ok(ada.memory.recent().some((e) => e.kind === 'assaulted' && e.withId === bram.id), 'seeding FORCE_BETRAYAL: the wronged party holds the grudge memory');
    ok((ada.beliefs.get(bram.id) || {}).standing < 0, 'seeding FORCE_BETRAYAL: a soured on b (holder->subject convention)');
    ok(sim.director._arcs.some((arc) => arc.kind === 'reckoning' && arc.wronged === ada.id && arc.betrayer === bram.id),
      'seeding FORCE_BETRAYAL: a PRE-TARGETED reckoning arc is queued (chosen principals, not _shuffle)');
  }

  // FALSE WITNESS — brand an innocent: nearby townsfolk grow suspicious; the accuser rides as
  // provenance; a pre-targeted Director 'accused' arc names the chosen victim.
  {
    const okF = falseWitness(sim, cael.id, bram.id);
    ok(okF, 'seeding FALSE_WITNESS: suspicion was planted into nearby townsfolk');
    ok(sim.director._arcs.some((arc) => arc.kind === 'accused' && arc.b === cael.id && arc.accuser === bram.id),
      'seeding FALSE_WITNESS: a PRE-TARGETED accused arc names the chosen victim + carries the accuser as provenance');
  }

  // STAR-CROSS — aim it at a chosen pair: mutual courtship intent, the romance arc, and the house feud.
  {
    const okS = starCross(sim, ada.id, bram.id);
    ok(okS && ada._courtingId === bram.id && bram._courtingId === ada.id, 'seeding STAR_CROSS: mutual _courtingId set on the chosen pair');
    ok(sim.sagas.findArc(arcKey('romance', ada.id, bram.id)) != null, 'seeding STAR_CROSS: the romance arc opened');
    ok(sim.director._arcs.some((arc) => arc.kind === 'romance' && arc.a === ada.id && arc.b === bram.id),
      'seeding STAR_CROSS: a PRE-TARGETED romance arc names the chosen pair');
  }

  // CAPTURE TARGET — stage a rescue: the captive bridge state + the rescue arc (keyed on the victim).
  {
    const okC = captureTarget(sim, wren.id, bram.id);
    ok(okC && wren._held === true && wren._captorId === bram.id, 'seeding CAPTURE_TARGET: the captive bridge state is set');
    ok(sim.sagas.findArc('rescue:' + wren.id) != null, 'seeding CAPTURE_TARGET: the rescue arc opened (keyed on the victim)');
  }

  sim.dispose();
}

// ---- the romance ENACTMENT: the court STEER fill (docs/architecture/12 §8) ----------------------
// Star-Crossed was narrated but never lived. With `_courtingId` set + the partner BELIEVED reachable,
// a courting agent commits a 'court' goal and the lovers visibly SEEK each other (fillCourt).
export function romanceTest(ok, { makeFighter, stubScene }) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  let nid = 1;
  const add = (name, x, z) => {
    const a = new Agent(makeFighter('knight', {}), { id: nid++, name, profession: null, personality: { risk_tolerance: 0.8, social_drive: 0.6, ambition: 0.3, altruism: 0.5, curiosity: 0.3 }, faction: 'townsfolk', townsperson: true });
    a.fighter.root.position.set(x, 0, z);
    for (const k in a.needs) a.needs[k] = 1;     // sated, so nothing out-pulls the courtship
    sim.agents.push(a); sim.agentsById.set(a.id, a); return a;
  };
  const romeo = add('Romeo', 0, 0), juliet = add('Juliet', 6, 0);
  romeo._courtingId = juliet.id; juliet._courtingId = romeo.id;
  // each holds a confident belief about the other (a fresh sighting).
  romeo.beliefs.observe(juliet.id, juliet.faction, juliet.pos, 0, false).confidence = 1;
  juliet.beliefs.observe(romeo.id, romeo.faction, romeo.pos, 0, false).confidence = 1;

  romeo.decide(sim._cognitionCtx());
  ok(romeo.goal && romeo.goal.kind === 'court', `romance: a courting agent commits a 'court' goal (${romeo.goal && romeo.goal.kind})`);

  const gap0 = romeo.pos.distanceTo(juliet.pos);
  for (let i = 0; i < 240; i++) { sim.update(1 / 60); for (const f of sim.fighters) f.update(1 / 60); }
  const gap1 = romeo.pos.distanceTo(juliet.pos);
  ok(gap1 < gap0 - 0.5, `romance: the lovers SEEK each other — the gap shrinks (${gap0.toFixed(1)} -> ${gap1.toFixed(1)})`);
  sim.dispose();
}
