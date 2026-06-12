// ---- expeditions: proper quests (march / provision / retreat / explore) ----------------
// Drives the Expeditions subsystem DIRECTLY against a crafted company (no long soak):
//   E1 the provision gate — no rations, no place in the line;
//   E2 a formed company MARCHES out (phase 'out', a surface target) instead of teleporting;
//   E3 arrival at the mouth descends the planned delve (underground, horrors spawned);
//   E4 a bleeding captain CALLS THE RETREAT — survivors climb out AT THE MOUTH and march
//      home (phase 'return'), the retreat is counted, and the books aren't double-kept;
//   E5 the homeward arrival disbands quietly (flags restored, expedition over);
//   E6 distance marched on expedition folds EXPLORE deeds (the explorer identity emitter).

import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { EXPEDITION } from '../../js/sim/simconfig.js';

export function expeditionTest(ok, { makeFighter, stubScene }) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  let nid = 9700;
  const pers = { risk_tolerance: 0.9, altruism: 0.4, ambition: 0.6, social_drive: 0.4 };
  const mk = (name) => {
    const a = new Agent(makeFighter('knight', {}), { id: nid++, name, profession: null, personality: pers, faction: 'townsfolk' });
    a.inventory.food = EXPEDITION.provisionFood || 1;   // provisioned by default
    sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  };
  const exp = sim.expeditions;

  // E1 — the provision gate: the same soul, with and without rations.
  const hungry = mk('Hungry');
  hungry.inventory.food = 0;
  ok(!exp._brave(hungry), 'expedition E1a: no rations, no place in the line (the provision gate)');
  hungry.inventory.food = EXPEDITION.provisionFood || 1;
  ok(exp._brave(hungry), 'expedition E1b: provisioned, the same soul may march');

  // E2 — a formed company MARCHES out (no teleport): surface target, banded followers.
  const cap = mk('Captain'), f1 = mk('First'), f2 = mk('Second');
  exp._form(cap, [f1, f2]);
  const E = cap.expedition;
  ok(!!E && E.phase === 'out' && !!E.target && Math.abs(E.target.y) < 1e-9,
    `expedition E2a: the company sets out on the SURFACE (phase=${E && E.phase})`);
  ok(f1.bandLeaderId === cap.id && f1.inParty && f1.combatant,
    'expedition E2b: followers band-follow the captain (the warband path)');

  // force the delve plan deterministically, then walk the captain to the mouth.
  E.delvePlanned = true;
  cap.pos.set(E.target.x, 0, E.target.z);
  exp._advance(cap);
  ok(E.delve === true && E.phase === 'delve' && cap._underground === true && (E.horrorIds || []).length > 0,
    `expedition E3: arrival at the mouth descends the delve (horrors=${(E.horrorIds || []).length})`);
  ok(!!E.mouth && Math.hypot(E.mouth.x, E.mouth.z) > 10,
    'expedition E3b: the mouth (the ascent point) is remembered out on the ring');

  // E4 — the COMPANY bleeds below retreatHp (the captain reads his company, never just
  // his own wounds): the RETREAT is called; survivors climb out at the mouth and the
  // company marches home (phase return), books kept once.
  for (const m of [cap, f1, f2]) m.fighter.health = (EXPEDITION.retreatHp || 0.4) * 100 * 0.5;
  exp._advanceDelve(cap);
  ok((exp.stats.retreats || 0) === 1 && E.resolved === true && E.phase === 'return' && E.delve === false,
    `expedition E4a: the captain calls the retreat — and the company turns for home (retreats=${exp.stats.retreats})`);
  ok(cap._underground === false && cap.pos.distanceTo(E.mouth) < 8,
    `expedition E4b: the survivors climb out AT THE MOUTH (${cap.pos.distanceTo(E.mouth).toFixed(1)}m from it), not at home`);
  const lossesAtMouth = exp.stats.losses || 0;

  // E6 — the march home folds EXPLORE deeds off the odometer.
  const explore0 = (cap.progression && cap.progression.behavior_profile.EXPLORE) || 0;
  cap.life.dist += (EXPEDITION.exploreDeedDist || 40) * 2 + 1;
  exp._advance(cap);
  const explore1 = (cap.progression && cap.progression.behavior_profile.EXPLORE) || 0;
  ok(explore1 > explore0,
    `expedition E6: distance marched folds EXPLORE deeds (${explore0.toFixed(1)} -> ${explore1.toFixed(1)}) — the explorer identity is reachable`);

  // E5 — home: the company disbands quietly; the deep's books were closed at the mouth.
  cap.pos.set(0, 0, 0);
  exp._advance(cap);
  ok(cap.expedition == null && f1.bandLeaderId == null && !f1.inParty && f1.expeditionOf == null,
    'expedition E5a: home — flags restored, the company disbanded');
  ok((exp.stats.losses || 0) === lossesAtMouth,
    'expedition E5b: the homeward arrival does not double-count the tale');

  // ── FELLOWSHIP, not mercenary company ─────────────────────────────────────────
  // E7: formation prefers the BONDED over the brave-but-strange — and a timid spouse
  //     comes anyway (the courage gate waived by bond.override, never the provisions);
  // E8: a devoted captain does not turn at first blood — a cold one does;
  // E9: survivors who march home together are warmed toward each other (comrade bonds).
  {
    const cap2 = mk('Frodo');
    cap2.personality = { ...pers, altruism: 0.9 };
    const spouse = mk('Sam');
    spouse.personality = { ...pers, risk_tolerance: 0.1 };   // timid — fails the courage gate
    spouse.mateId = cap2.id; cap2.mateId = spouse.id;        // …but wed to the captain
    const stranger = mk('Boromir');                          // brave, unbonded
    stranger.personality = { ...pers, risk_tolerance: 0.95 };

    ok(exp._bondTo(spouse, cap2) > exp._bondTo(stranger, cap2),
      `expedition E7a: the spouse outranks the brave stranger by BOND (${exp._bondTo(spouse, cap2).toFixed(2)} > ${exp._bondTo(stranger, cap2).toFixed(2)})`);
    spouse.inventory.food = 0;
    const pool = [spouse, stranger].filter((a) => exp._brave(a));
    ok(!pool.includes(spouse), 'expedition E7b: the bond never waives the PROVISION gate (Sam still packs the pots)');
    spouse.inventory.food = EXPEDITION.provisionFood || 1;

    exp._form(cap2, [spouse, stranger]);
    const E2 = cap2.expedition;
    E2.delvePlanned = true;
    cap2.pos.set(E2.target.x, 0, E2.target.z);
    exp._advance(cap2);

    // E8 — first blood: the devoted captain holds; then gut his devotion and he turns.
    stranger.fighter.health = 0; stranger.fighter.alive = false;   // Boromir falls
    // make the bond mutual + warm so loyalty clears the hold line.
    cap2.beliefs._ensure(spouse.id).standing = 0.9;
    spouse.beliefs._ensure(cap2.id).standing = 0.9;
    const retreats0 = exp.stats.retreats || 0;
    exp._advanceDelve(cap2);
    ok((exp.stats.retreats || 0) === retreats0 && E2.delve === true,
      'expedition E8a: a DEVOTED captain does not turn at first blood — loyalty holds the line');
    cap2.personality.altruism = 0;                                  // a colder man
    exp._advanceDelve(cap2);
    ok((exp.stats.retreats || 0) === retreats0 + 1 && E2.phase === 'return',
      'expedition E8b: the same blood, a cold captain — the retreat is called');

    // E9 — homecoming forges comrades: standing warms pairwise + the bond memory.
    const s0 = (cap2.beliefs.get(spouse.id) || {}).standing || 0;
    cap2.pos.set(0, 0, 0);
    exp._advance(cap2);
    const s1 = (cap2.beliefs.get(spouse.id) || {}).standing || 0;
    ok(s1 > s0, `expedition E9a: shared peril warms the survivors toward each other (${s0.toFixed(2)} -> ${s1.toFixed(2)})`);
    ok(cap2.memory.stm.items().some((e) => e.kind === 'bond' && e.rel === 'comrade'),
      'expedition E9b: the homecoming files the comrade bond memory (the group machinery will find them)');
  }

  sim.dispose();
}
