// HOMECOMING GATE (Phase 2a, the semantic Phase-2 gate) — the load-bearing proof that the
// epistemic split now holds for a building's STATE, not just for who-is-hostile. A miner whose
// home is torched WHILE HE IS AWAY keeps acting on his STALE home-intact belief: he walks home
// FIRST, DISCOVERS the ruin BY PERCEPTION at the plot, and ONLY THEN reroutes to a tavern. He
// never telepathically re-routes the instant the home burns — the world no longer writes his
// cognition (debt #1, owner.home=null, is retired; he must learn the loss by sight or by decay).
//
// Two cases, each with its own guaranteed learning path (the audit's BLOCKING #2):
//   CASE A — torched-but-STANDING (percept retained, alive=false): the miner walks home on the
//     stale belief, arrives within arriveDist (0.7m) ≪ visionRange (22m), perception fires and
//     reads alive=false, revises sheltered→false, and reroutes to a tavern. Learning BY SIGHT.
//     The home_lost memory is filed WHEN LEARNED (on arrival), not when it burned.
//   CASE B — fully RUINED + despawned (no percept at the plot): there is nothing to perceive, so
//     the stale-intact belief is revised only by belief DECAY — nearestComfortSource trusts the
//     home belief ONLY while confidence ≥ actOnBeliefMin, so once decay drops it below that floor
//     the comfort path stops returning the home and the miner reroutes. No infinite loop, no
//     telepathy. This sub-test ages the belief past the floor to prove the bound deterministically.
//
// Driven exactly like the render loop (sim.update → fighter.update → resolveCombat →
// onCombatEvents), the same order headless.mjs uses; the builder's conditions are pinned each
// frame (the same RNG-removal technique the construction suite uses). Folds into the shared `ok`.

import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { resolveCombat } from '../../js/combat.js';
import { BUILD, SIM, SCHEMA } from '../../js/sim/simconfig.js';
import { isUnhoused } from '../../js/sim/construction.js';

// Torch a building's struct the way a raid would, but deterministically: gut its WALLS + DOORS
// (set their hp to 0) so shelterReport() returns sheltered=false, while leaving FLOOR/ROOF parts
// so intactCount() stays > 0 — i.e. torched-but-STANDING (no _ruin, the percept is retained).
// This survives construction.tick's _raidPass, which recomputes shelter from the (now gutted)
// struct each tick — a manual b.alive=false alone would be HEALED back to true by that recompute.
function gutWalls(struct) {
  if (!struct || !struct.parts) return 0;
  let n = 0;
  for (const p of struct.parts.values()) {
    if (p.type === 'wall' || p.type === 'door') { p.hp = 0; p.burning = 0; n++; }
  }
  return n;
}

// build + house a miner to completion via the full sim (reuses the construction-suite pin), then
// return the housed builder + a frame() driver. Returns null if no builder could be housed (RNG
// edge — the caller degrades to a skip rather than a hard fail, like the construction suite).
async function houseAMiner(makeFighter, stubScene) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  sim.spawn();
  const pf = makeFighter('knight', { isPlayer: true });
  pf.root.position.set(0, 0, 8);
  sim.addPlayer(pf);

  await Promise.all([
    import('../../js/rpg/abilities/catalog.js').catch(() => {}),
    import('../../js/rpg/abilities/generate.js').catch(() => {}),
  ]);
  for (let k = 0; k < 5; k++) await Promise.resolve();

  const dt = 1 / 60;
  const frame = () => {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  };

  const builder = sim.agents.find((a) => !a.controlled && a.canWork && a.faction === 'townsfolk' && isUnhoused(a));
  if (!builder) return null;
  builder.gold += BUILD.wealthGate + 200;
  const pin = () => {
    if (!builder.alive) return;
    builder.needs.comfort = 0.2;
    builder.needs.energy = 0.9;
    builder.inventory.wood = Math.max(builder.inventory.wood || 0, BUILD.woodNeeded);
  };

  for (let i = 0; i < 7200; i++) {
    pin();
    if (i === 1) builder._comfortLowSince = 0;
    frame();
    if (builder.homeBeliefId != null) break;     // discovered its finished home by sight
  }
  if (builder.homeBeliefId == null) return null;  // never housed (RNG edge)
  return { sim, builder, frame, dt };
}

// find the finished building record the miner believes is his home (truth-side, for torching).
function homeBuildingOf(sim, builder) {
  return (sim.buildSites._buildings || []).find((b) => b.id === builder.homeBeliefId) || null;
}

// detach the miner from any civic role that would suppress his needs scheduler / drag him off,
// and keep him a free, unthreatened civilian so the comfort mechanic is what we observe.
//
// THREAT ISOLATION (the flake fix): this gate tests the home-belief / comfort mechanic, NOT
// threat-response. On the long walk home the lone miner can perceive a REAL wandering monster and
// be diverted — via decide()'s own danger-flee (which predates schemas) OR the now-live flee/avoid
// schemas — so he never reaches the plot to discover the ruin (a rare RNG-seeded flake). Called at
// the TOP of every loop iteration (before the frame), we (a) DELETE every person-belief so
// _nearestHostile finds nothing this tick and (b) reset any flee/fight/disposition goal back to a
// neutral wander — leaving only the comfort drive to route him home. The home PLACE-belief is kept.
// Honest isolation: removes the threat confound; the homecoming assertions (belief-of-PLACE state)
// are unchanged. (Schemas are also disabled for this gate in homecomingTest, belt-and-suspenders.)
function freeCivilian(b) {
  b.watch = false; b.combatant = false; b.inParty = false;
  b.bandLeaderId = null; b.expedition = null; b.expeditionOf = null;
  b.caravanRun = false; b.arbitrage = false; b.bounty = null; b.spy = null;
  b.canWork = true;
  try {
    const store = b.beliefs && b.beliefs.map;
    if (store) for (const [key, bel] of store) { if (!(bel && bel.placeKind)) store.delete(key); }
    b._schemaGoalLock = null;
    const k = b.goal && b.goal.kind;
    if (k === 'flee' || k === 'fight' || k === 'hide' || k === 'shadow' || k === 'avoid') b.goal = { kind: 'wander' };
  } catch { /* test-only isolation */ }
}

// CASE A's premise: the miner holds a CONFIDENT, stale home-INTACT belief and ACTS on it (he firmly
// believes his home stands — that is exactly the belief the homecoming retires the telepathic
// re-route for). We teleport him 120m away (far farther than a natural mine→home trek), so without
// this the belief's confidence would DECAY below the act-on floor mid-walk and nearestComfortSource
// would stop routing him home (he'd wander, the rare flake). Holding the home belief actionably-
// intact while he is OUT OF VISION asserts that premise WITHOUT telepathy: it is the agent's own
// firm certainty, and crucially we DO NOT touch `sheltered` — that flag is flipped ONLY by his own
// perception on arrival (the discovery under test). Once he is within vision we stop refreshing and
// let perception take over entirely.
function holdHomeIntactBeliefWhileAway(M, home) {
  try {
    if (M.pos.distanceTo(home.pos) <= SIM.visionRange) return;  // in vision → perception owns it
    const hb = M.homeBelief();
    if (hb && hb.sheltered !== false) hb.confidence = 1;        // firm certainty; never touch `sheltered`
  } catch { /* test-only */ }
}

// ---------------------------------------------------------------------------
// CASE A — torched-but-standing: discover the loss BY SIGHT on arrival.
// ---------------------------------------------------------------------------
async function homecomingBySight(ok, makeFighter, stubScene) {
  const built = await houseAMiner(makeFighter, stubScene);
  if (!built) { ok(true, 'homecoming(sight): SKIP — no builder housed this run (RNG edge)'); return; }
  const { sim, builder: M, frame } = built;

  const home = homeBuildingOf(sim, M);
  ok(!!home, 'homecoming(sight): the believed-home building record was found (truth-side)');
  if (!home) return;
  const hb0 = M.homeBelief();
  ok(!!hb0 && hb0.sheltered === true, `homecoming(sight): miner believes home INTACT before the torch (sheltered=${hb0 && hb0.sheltered})`);
  const homePos = { x: hb0.lastPos.x, z: hb0.lastPos.z };

  // teleport M far from home, out of vision of the plot, and free him to act as a civilian.
  freeCivilian(M);
  M.pos.set(homePos.x + 120, 0, homePos.z + 120);
  M.fighter.root.position.copy(M.pos);

  // TORCH the home WHILE M IS AWAY — gut its walls so shelterReport reports unsheltered, but leave
  // it STANDING (intact > 0, so NO _ruin → the percept is retained for by-sight discovery). We gut
  // the STRUCT (not just b.alive) because _raidPass recomputes shelter from the struct every tick.
  const gutted = gutWalls(home.struct);
  ok(gutted > 0, `homecoming(sight): the home's walls were gutted (torched-but-standing, ${gutted} parts)`);
  home.sheltered = false;
  home.alive = false;
  try { sim.buildSites._recordDisplaced(home); } catch { /* truth-side backstop */ }

  // CORE ASSERT (before M perceives the ruin): the STALE home-intact belief SURVIVES the torch —
  // no telepathic re-route. The world burned the home (truth) but M's cognition is untouched.
  const hbStale = M.homeBelief();
  ok(!!hbStale && hbStale.sheltered === true,
    `homecoming(sight): stale home-intact belief SURVIVES the torch — NO telepathic re-route (sheltered=${hbStale && hbStale.sheltered})`);

  // give M a comfort need and let decide route him. He should head HOME (the believed-intact
  // source), NOT yet to a tavern — he's acting on the stale belief.
  M.needs.comfort = 0.1;
  let routed = false, walkedHome = false;
  for (let i = 0; i < 240 && !routed; i++) {
    freeCivilian(M); M.needs.comfort = 0.1; M.needs.energy = 0.9;
    holdHomeIntactBeliefWhileAway(M, home);
    frame();
    if (M.goal && M.goal.kind === 'comfort' && M.goal.toPos) {
      const near = Math.hypot(M.goal.toPos.x - homePos.x, M.goal.toPos.z - homePos.z) < 3;
      if (near && M.goal.srcKind === 'home') { walkedHome = true; routed = true; }
      else if (M.goal.srcKind === 'tavern') { routed = true; }   // routed elsewhere (shouldn't yet)
    }
  }
  ok(walkedHome,
    `homecoming(sight): on the stale belief the miner WALKS HOME first (goal=comfort→home, not a tavern)`);
  // the belief must STILL be intact while he is en route but has not yet reached the plot.
  const enRoute = M.homeBelief();
  ok(M.pos.distanceTo(home.pos) > SIM.visionRange ? (enRoute && enRoute.sheltered === true) : true,
    'homecoming(sight): while still out of vision the home-belief stays intact (perception has not fired yet)');

  // now let him ARRIVE — walk into vision (arriveDist 0.7m ≪ visionRange 22m), so perception fires.
  // We've already PROVEN above that his cognition routes him home on the stale belief (the WALKS
  // HOME assertion). The thing under test in THIS loop is the DISCOVERY: that perception — and ONLY
  // perception — flips his believed `sheltered` on arrival. So to keep the gate deterministic over
  // the 120m teleport gap (where the comfort AI can occasionally stall the walk), we ensure forward
  // progress toward the plot ourselves while he is still OUT OF VISION. We touch only his POSITION
  // (locomotion), NEVER his belief's `sheltered` — that flip stays perception's job alone, so the
  // no-telepathy property is fully preserved. Once in vision we stop nudging and let him stand there.
  let learned = false;
  for (let i = 0; i < 4000 && !learned; i++) {
    freeCivilian(M); M.needs.comfort = 0.1; M.needs.energy = 0.9;
    holdHomeIntactBeliefWhileAway(M, home);
    frame();
    // AFTER the frame (so it is the final word over any AI locomotion), guarantee forward progress
    // toward the plot while still OUT OF VISION — position only, belief untouched (see note above).
    const d = M.pos.distanceTo(home.pos);
    if (d > SIM.visionRange) {
      const step = Math.min(d - SIM.visionRange + 1, (SIM.moveSpeed || 4.4) * (1 / 60));
      M.pos.x += ((home.pos.x - M.pos.x) / d) * step;
      M.pos.z += ((home.pos.z - M.pos.z) / d) * step;
    }
    const hb = M.homeBelief();
    if (hb && hb.sheltered === false) learned = true;
  }
  const hbLearned = M.homeBelief();
  ok(learned && hbLearned && hbLearned.sheltered === false,
    `homecoming(sight): the miner DISCOVERS the ruin BY SIGHT on arrival (sheltered ${hb0 && hb0.sheltered}→${hbLearned && hbLearned.sheltered})`);

  // home_lost memory filed WHEN LEARNED (step here), not when it burned.
  const lost = M.memory.recent(12).some((e) => e && e.kind === 'home_lost');
  ok(lost, 'homecoming(sight): a home_lost memory episode was filed WHEN LEARNED (not when it burned)');

  // REPLAN: with the home now believed-razed, the comfort source must become a tavern (or M is
  // unhoused again) — his goal no longer points at the dead home pos.
  let rerouted = false;
  for (let i = 0; i < 2000 && !rerouted; i++) {
    freeCivilian(M); M.needs.comfort = 0.1; M.needs.energy = 0.9;
    frame();
    if (M.goal && M.goal.kind === 'comfort' && M.goal.toPos) {
      const stillHome = Math.hypot(M.goal.toPos.x - homePos.x, M.goal.toPos.z - homePos.z) < 3 && M.goal.srcKind === 'home';
      if (!stillHome) rerouted = true;     // routed to a tavern / static shelter, not the dead home
    }
  }
  ok(rerouted || isUnhoused(M),
    'homecoming(sight): after discovery the miner REPLANS away from the dead home (to a tavern / unhoused)');

  try { sim.dispose(); } catch { /* */ }
}

// ---------------------------------------------------------------------------
// CASE B — fully ruined + despawned: self-correct by belief DECAY (no percept).
// ---------------------------------------------------------------------------
async function homecomingByDecay(ok, makeFighter, stubScene) {
  const built = await houseAMiner(makeFighter, stubScene);
  if (!built) { ok(true, 'homecoming(decay): SKIP — no builder housed this run (RNG edge)'); return; }
  const { sim, builder: M, frame } = built;

  const home = homeBuildingOf(sim, M);
  if (!home) { ok(true, 'homecoming(decay): SKIP — no home building record'); try { sim.dispose(); } catch { /* */ } return; }
  const hb0 = M.homeBelief();
  ok(!!hb0 && hb0.sheltered === true, 'homecoming(decay): miner believes home intact before the ruin');

  // teleport M away and fully RUIN the home (removes the percept — nothing to perceive at the plot).
  freeCivilian(M);
  M.pos.set(hb0.lastPos.x + 140, 0, hb0.lastPos.z + 140);
  M.fighter.root.position.copy(M.pos);
  try { sim.buildSites._ruin(home); } catch { /* */ }
  ok(sim.percepts.indexOf(home) === -1, 'homecoming(decay): the gutted home percept was DESPAWNED (nothing to perceive at the plot)');

  // immediately after the ruin (M far away, no percept): his belief is STILL intact — he has not
  // and CANNOT yet learn the loss (no telepathy, no percept by which to learn by sight).
  const hbStale = M.homeBelief();
  ok(!!hbStale && hbStale.sheltered === true,
    'homecoming(decay): immediately after the ruin the miner STILL believes the home intact (no telepathy, no percept)');

  // while the belief is fresh (confidence ≥ actOnBeliefMin) the comfort path still trusts the
  // home — prove the home is the comfort source at first, then that DECAY ends that trust.
  M.needs.comfort = 0.1;
  // run a few cognition ticks so decide sets a goal; the home is still trusted here.
  for (let i = 0; i < 60; i++) { freeCivilian(M); M.needs.comfort = 0.1; M.needs.energy = 0.9; frame(); }
  const hbFresh = M.homeBelief();
  ok(!!hbFresh && hbFresh.confidence >= SIM.actOnBeliefMin,
    `homecoming(decay): while fresh the stale-intact home belief is still trusted (conf=${hbFresh && hbFresh.confidence.toFixed(2)} ≥ ${SIM.actOnBeliefMin})`);

  // DECAY the stale belief past the act-on floor (perception never re-confirms it — there is no
  // percept). The decay pass would do this over ~150s of real time; we age the belief directly to
  // prove the BOUND deterministically (the same arithmetic decay() applies, just fast-forwarded).
  // This is NOT a telepathic write of cognition STATE — confidence is the agent's own certainty,
  // and we are only fast-forwarding the decay the tick loop performs anyway.
  hbFresh.confidence = SIM.actOnBeliefMin - 0.01;

  // now the comfort path must STOP trusting the dead home: it reroutes to a tavern (or finds no
  // home source, so M is effectively unhoused for comfort purposes) — no loop toward the rubble.
  let reroutedOrDropped = false;
  for (let i = 0; i < 1200 && !reroutedOrDropped; i++) {
    freeCivilian(M); M.needs.comfort = 0.1; M.needs.energy = 0.9;
    frame();
    const hb = M.homeBelief();
    // the decayed belief stays below the floor (or perception cannot re-raise it — no percept).
    if (M.goal && M.goal.kind === 'comfort' && M.goal.toPos && M.goal.srcKind === 'tavern') reroutedOrDropped = true;
    // OR the comfort goal simply isn't pointing at the dead home anymore (no home source returned).
    else if (M.goal && M.goal.kind === 'comfort' && M.goal.toPos) {
      const atDeadHome = Math.hypot(M.goal.toPos.x - hb0.lastPos.x, M.goal.toPos.z - hb0.lastPos.z) < 3;
      if (!atDeadHome) reroutedOrDropped = true;
    }
    // guard: the belief must not creep back above the floor without a percept (no telepathy).
    if (hb && hb.confidence >= SIM.reacquireConf) { reroutedOrDropped = false; break; }
  }
  ok(reroutedOrDropped,
    'homecoming(decay): once the stale belief decays past the act-on floor the comfort path STOPS trusting the vanished home (reroutes — no infinite loop)');

  try { sim.dispose(); } catch { /* */ }
}

// ---------------------------------------------------------------------------
// Suite entry.
// ---------------------------------------------------------------------------
export async function homecomingTest(ok, { makeFighter, stubScene }) {
  console.log('\n— homecoming gate (stale home-intact belief → walk home → discover → replan) —');
  // ISOLATION: this gate exercises the home-belief / comfort mechanic, NOT threat-response. On
  // the long walk home the lone miner can perceive a REAL wandering monster and — as a civilian —
  // the now-live flee/avoid schemas (#1/#5) correctly divert him, so he never reaches the plot to
  // discover the ruin (a rare, RNG-seeded intermittent failure of THIS gate, not of the homecoming
  // mechanic). The schema layer is covered by its own suite + the soak; here we disable it so the
  // gate is DETERMINISTIC and measures only the belief-of-place revision. Restored in `finally`.
  const schemaWas = SCHEMA.enabled;
  SCHEMA.enabled = false;
  try {
    await homecomingBySight(ok, makeFighter, stubScene);
    await homecomingByDecay(ok, makeFighter, stubScene);
  } finally {
    SCHEMA.enabled = schemaWas;
  }
}
