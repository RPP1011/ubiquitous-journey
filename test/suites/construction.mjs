// ---- Phase-1 emergent buildings -----------------------------------------
// Drives the WHOLE sim like the render loop (minus rendering) and asserts the
// invariants for the construction system: a townsperson commissions a HOME,
// builds it over many ticks (paid in WOOD + its own labour — never minted gold),
// and on completion the finished building becomes a walk-through comfort source
// the owner can return to. The system is gold-neutral, so the closed money loop
// must survive any number of commissions/completions; the unhoused-comfort cap is
// the standing demand pressure that makes building worthwhile. We also confirm the
// public TAVERN can be commissioned, and that nothing freezes the fixed tick.
//
// As in soak.mjs the logical building must work FULLY HEADLESS (no DOM): the
// procedural mesh is browser-only, but the BuildSite/Building records, progress,
// benefit and home-assignment all run with no renderer. We drive the sim exactly
// like the render loop (sim.update -> fighter.update -> resolveCombat ->
// onCombatEvents) and pin the builder's conditions each frame so the home finishes
// within the window regardless of seed — the same pinning technique the lineage /
// intrigue sub-sims use to take the RNG out of a controlled invariant.

import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { resolveCombat } from '../../js/combat.js';
import { COMFORT, BUILD, SURVEYOR } from '../../js/sim/simconfig.js';
import { AMBITIONS } from '../../js/sim/motivation.js';

export async function constructionTest(ok, { makeFighter, stubScene }) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  sim.spawn();
  const pf = makeFighter('knight', { isPlayer: true });
  pf.root.position.set(0, 0, 8);
  sim.addPlayer(pf);

  // Progression's lazy ability imports resolve on the microtask queue; the frame
  // loop is fully synchronous, so flush a few turns before frame 0 (mirrors soak).
  await Promise.all([
    import('../../js/rpg/abilities/catalog.js').catch(() => {}),
    import('../../js/rpg/abilities/generate.js').catch(() => {}),
  ]);
  for (let k = 0; k < 5; k++) await Promise.resolve();

  // ── 1. the subsystems construct headless and expose the POI-lookup seam ──────
  ok(sim.buildSites && sim.surveyor, 'construction: subsystems constructed');
  ok(typeof sim.buildSites.nearest === 'function', 'construction: BuildSites exposes nearest()');

  const sumGold = () => sim.agents.reduce((s, a) => s + a.gold, 0);

  // ── pick a deterministic BUILDER ─────────────────────────────────────────────
  // A real, spawned, working townsperson. We PIN its conditions each frame so
  // qualifyHome passes and the build can finish without the builder ever leaving
  // the plot for market detours — the build then completes within the window
  // regardless of the chaotic main RNG.
  const builder = sim.agents.find((a) => !a.controlled && a.canWork && a.faction === 'townsfolk' && !a.home);
  ok(!!builder, 'construction: found a working townsperson to build a home');

  // Wealth gate: grant the surplus ONCE up front (a big cushion above the gate), NOT
  // per frame — a per-frame `Math.max(gold, …)` would RE-MINT gold every time the
  // builder spends on a routine market trip, breaking the very conservation we assert
  // (the construction system itself is gold-neutral; that mint was a test artefact).
  // goldStart is captured AFTER this one-off grant so the grant isn't counted as drift.
  if (builder) builder.gold += BUILD.wealthGate + 200;
  const goldStart = sumGold();

  // pin the chronic-low-comfort gate, and keep the builder supplied with wood +
  // energy so it never has to abandon the plot to rest. Pinning wood is gold-neutral
  // (wood is a commodity, not money), so it stays in the per-frame pin.
  const pinBuilder = () => {
    if (!builder || !builder.alive) return;
    builder.home = builder.home || null;          // unhoused until the build finishes
    builder.needs.comfort = 0.2;                  // low (also keeps the unhoused cap honest)
    builder.needs.energy = 0.9;                   // never too tired to labour
    builder.inventory.wood = Math.max(builder.inventory.wood || 0, BUILD.woodNeeded);  // wood on hand
  };

  // ── drive ~120 sim-seconds exactly like the render loop ──────────────────────
  const FRAMES = 7200, dt = 1 / 60;
  let stage = 'init';
  try {
    for (let i = 0; i < FRAMES; i++) {
      pinBuilder();
      // advance the chronic-comfort streak past the qualify threshold after frame 0
      // (_comfortLowSince is compared to ctx.time in qualifyHome; 0 is "long ago").
      if (i === 1 && builder) builder._comfortLowSince = 0;
      stage = 'sim.update'; sim.update(dt);
      stage = 'fighter.update'; for (const f of sim.fighters) f.update(dt);
      stage = 'resolveCombat';
      const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
      if (ev.length) { stage = 'onCombatEvents'; sim.onCombatEvents(ev); }
      if (builder && builder.home) break;          // home raised — stop early
    }
  } catch (err) {
    ok(false, `construction: threw at stage '${stage}' frame loop -> ${err && err.message}`);
    console.error(err);
    return;
  }
  ok(true, `construction: ${FRAMES} frames ran without throwing`);

  // ── 2. a building completed over the soak, and the builder gained a home ─────
  ok(sim.buildSites.stats.completed >= 1,
    `construction: at least one building completed (${sim.buildSites.stats.completed})`);
  ok(builder && builder.home != null, 'construction: the builder gained a home');

  // ── 3. gold conserved across construction (closed money loop) ────────────────
  // Construction is paid in WOOD + labour; the only gold movement possible is a
  // market wood-buy (applyBuy/applySell MOVES gold between two real agents). So
  // Σ agent.gold is invariant across any number of commissions/completions.
  const goldEnd = sumGold();
  ok(Math.abs(goldEnd - goldStart) < 1e-6,
    `construction: gold conserved (${goldStart.toFixed(2)} -> ${goldEnd.toFixed(2)})`);

  // ── 4a. a HOUSED agent restores comfort at home ──────────────────────────────
  // Stop pinning the builder low, knock its comfort down, and let it choose the
  // `comfort` goal and walk home. A housed agent has NO unhoused cap, so it should
  // climb well above the cap.
  if (builder && builder.home) {
    builder.needs.comfort = 0.2;
    let cstage = 'comfort.init';
    try {
      for (let i = 0; i < 1800; i++) {            // ~30 sim-seconds
        builder.needs.energy = 0.9;               // keep it from detouring to rest
        // a housed agent can still be conscripted (a home no longer shields it); for
        // this phase we verify comfort-restore in isolation, so keep the builder a
        // free, unthreatened civilian standing in its OWN town — a drafted, expedition-
        // bound or in-danger agent suppresses its whole needs scheduler (or is dragged
        // far from home), which would mask the comfort mechanic we're checking.
        if (builder.watch || builder.combatant || builder.inParty || builder.expedition ||
            builder.expeditionOf != null || builder.caravanRun || builder.arbitrage || builder.bounty) {
          builder.watch = false; builder.combatant = false; builder.inParty = false;
          builder.bandLeaderId = null; builder.expedition = null; builder.expeditionOf = null;
          builder.caravanRun = false; builder.arbitrage = false; builder.bounty = null;
          builder.canWork = true;
          // if it was hauled off, set it back near its home town so 30s is enough.
          if (builder.home && builder.pos.distanceTo(builder.home.pos) > 40) builder.pos.copy(builder.home.pos);
        }
        cstage = 'sim.update'; sim.update(dt);
        cstage = 'fighter.update'; for (const f of sim.fighters) f.update(dt);
        cstage = 'resolveCombat';
        const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
        if (ev.length) { cstage = 'onCombatEvents'; sim.onCombatEvents(ev); }
        if (builder.needs.comfort > 0.7) break;
      }
    } catch (err) {
      ok(false, `construction: comfort-restore phase threw at '${cstage}' -> ${err && err.message}`);
      return;
    }
    ok(builder.needs.comfort > 0.6,
      `construction: a housed agent restores comfort at home (${builder.needs.comfort.toFixed(2)})`);
  }

  // ── 4b. the UNHOUSED cap holds (the demand pressure) ─────────────────────────
  // A different, un-housed townsperson: even pinned to full comfort, one drain
  // frame clamps it back down to the low ceiling.
  const unhoused = sim.agents.find((a) => a.alive && !a.controlled && a.faction === 'townsfolk' && !a.home);
  if (unhoused) {
    unhoused.needs.comfort = 1;
    unhoused.drainNeeds(dt);
    ok(unhoused.needs.comfort <= COMFORT.unhousedCap + 1e-6,
      `construction: unhoused comfort capped low (${unhoused.needs.comfort.toFixed(2)} <= ${COMFORT.unhousedCap})`);
  }

  // ── 5. the town commissioned a TAVERN ────────────────────────────────────────
  // The main town spawns >= SURVEYOR.tavernMinPop, so the Surveyor should have
  // commissioned a public tavern over the run (built or still in progress). If pop
  // dipped below the gate, fall back to "a tavern site was at least commissioned".
  const finishedTavern = (sim.buildSites._buildings || []).some((b) => b.kind === 'tavern');
  const anyTavern = sim.buildSites.hasTavern(0) || finishedTavern || sim.surveyor.stats.taverns >= 1;
  ok(anyTavern, `construction: town commissioned a tavern (sites/built=${finishedTavern}, surveyed=${sim.surveyor.stats.taverns})`);

  // ── 6. every NPC still has a comfort need, a goal, and a valid ambition ──────
  ok(sim.agents.every((a) => (a.alive ? (a.needs && typeof a.needs.comfort === 'number') : true)),
    'construction: every living agent has a comfort need');
  ok(sim.agents.every((a) => a.goal && a.goal.kind),
    'construction: every agent has a goal');
  const validAmbition = (a) => a.ambition && (a.ambition.revenge || AMBITIONS[a.ambition.kind]);
  ok(sim.agents.filter((a) => !a.controlled).every(validAmbition),
    'construction: every NPC still has a valid ambition');

  // ── info ─────────────────────────────────────────────────────────────────────
  const st = sim.buildSites.stats;
  console.log(`INFO  construction: commissioned=${st.commissioned} completed=${st.completed} ` +
    `homes=${st.homes} taverns=${st.taverns} (surveyor plots=${sim.surveyor.stats.plots} taverns=${sim.surveyor.stats.taverns})`);
  if (builder && builder.home) {
    const h = builder.home;
    console.log(`INFO  construction: ${builder.name} raised ${h.label || (h.kind + ' #' + h.id)} ` +
      `— footprint ${h.footprint.w.toFixed(1)}×${h.footprint.d.toFixed(1)}, storeys ${h.storeys}, wealth ${h.wealth}`);
  }
}
