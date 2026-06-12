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
import { COMFORT, BUILD, SURVEYOR, SCHEMA } from '../../js/sim/simconfig.js';
import { AMBITIONS } from '../../js/sim/motivation.js';
import { isUnhoused } from '../../js/sim/construction.js';

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
  // Phase 2a: home is now a BELIEF (homeBeliefId / isUnhoused) — the old `!a.home` read was
  // the telepathy this retires (the world used to write owner.home into cognition). Find an
  // unhoused working townsperson via the belief-backed predicate.
  const builder = sim.agents.find((a) => !a.controlled && a.canWork && a.faction === 'townsfolk' && isUnhoused(a));
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
    // Phase 2a: "unhoused" is now belief-backed (homeBeliefId). We keep comfort low to hold
    // the chronic-demand streak; the builder becomes housed only once it PERCEIVES the home
    // it finished (homeBeliefId set by perception). No more truth-side builder.home write.
    builder.needs.comfort = 0.2;                  // low (also keeps the unhoused cap honest)
    builder.needs.energy = 0.9;                   // never too tired to labour
    builder.inventory.wood = Math.max(builder.inventory.wood || 0, BUILD.woodNeeded);  // wood on hand
    // THREAT ISOLATION (same intent as the market-detour pin): a real wandering monster near the
    // plot can divert the civilian builder off it — via decide()'s own danger-flee or the now-live
    // flee/avoid schemas — before it PERCEIVES its finished home. Purge person-beliefs each frame so
    // _nearestHostile finds nothing and reset any flee/fight/disposition goal; building needs no
    // person-belief, and the home PLACE-belief is kept. (Schemas are also off in this loop.)
    try {
      const store = builder.beliefs && builder.beliefs.map;
      if (store) for (const [key, bel] of store) { if (!(bel && bel.placeKind)) store.delete(key); }
      builder._schemaGoalLock = null;
      const k = builder.goal && builder.goal.kind;
      if (k === 'flee' || k === 'fight' || k === 'hide' || k === 'shadow' || k === 'avoid') builder.goal = { kind: 'wander' };
      // KEEP HIM AT THE PLOT until he perceives his finished home: once the build is complete
      // (a finished building carries his ownerId) but he has not yet bound homeBeliefId, a routine
      // market/wander step could carry him out of vision (22m) of the just-built home in the one
      // tick before perception fires — a rare timing flake of the discovery break. Snapping his
      // position to the plot guarantees the next perceive sees it. Position only; the discovery
      // itself is still perception's job (no telepathic homeBeliefId write).
      if (builder.homeBeliefId == null) {
        const mine = (sim.buildSites._buildings || []).find((b) => b.ownerId === builder.id);
        if (mine && mine.pos) builder.pos.set(mine.pos.x, builder.pos.y, mine.pos.z);
      }
    } catch { /* test-only isolation */ }
  };

  // ── drive ~120 sim-seconds exactly like the render loop ──────────────────────
  // ISOLATION: disable the schema layer for this fixture. It tests the build → discover-home-by-
  // sight mechanic, NOT threat-response; with schemas live, a wandering monster near the plot can
  // (via the now-executing flee/avoid schemas #1/#5) divert the civilian builder off the plot
  // before it perceives its finished home — a rare RNG-seeded flake of THIS gate, not the build
  // mechanic. The schema layer has its own suite + the soak; here we take it out of the controlled
  // invariant (the same "remove the RNG confound" technique this suite already uses). Restored below.
  const schemaWas = SCHEMA.enabled;
  SCHEMA.enabled = false;
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
      // Phase 2a: stop once the builder has DISCOVERED its finished home by sight
      // (homeBeliefId bound by perception) — the discovery that replaces the old
      // omniscient owner.home=building write.
      if (builder && builder.homeBeliefId != null) break;
    }
  } catch (err) {
    ok(false, `construction: threw at stage '${stage}' frame loop -> ${err && err.message}`);
    console.error(err);
    return;
  } finally {
    // restore the schema gate the moment the discovery loop ends — only THIS loop needed it off
    // (the build → discover-home invariant); the rest of the suite is schema-agnostic.
    SCHEMA.enabled = schemaWas;
  }
  ok(true, `construction: ${FRAMES} frames ran without throwing`);

  // ── 2. a building completed over the soak, and the builder gained a home ─────
  ok(sim.buildSites.stats.completed >= 1,
    `construction: at least one building completed (${sim.buildSites.stats.completed})`);
  // Phase 2a: the builder gained a home means it DISCOVERED its finished home by sight — a
  // bound homeBeliefId whose belief reads sheltered=true, and isUnhoused() now false. The old
  // `builder.home != null` was the world writing cognition (telepathy); discovery replaces it.
  const hbel = builder && builder.homeBelief();
  ok(builder && builder.homeBeliefId != null && hbel && hbel.sheltered === true && !isUnhoused(builder),
    `construction: the builder discovered its home by sight (homeBeliefId=${builder && builder.homeBeliefId}, sheltered=${hbel && hbel.sheltered})`);

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
  // climb well above the cap. Phase 2a: "housed" is belief-backed (homeBelief), and the
  // home position is the believed lastPos (not a truth-side builder.home.pos).
  if (builder && !isUnhoused(builder)) {
    const homePos = () => { const b = builder.homeBelief(); return b ? b.lastPos : null; };
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
          // if it was hauled off, set it back near its home (believed pos) so 30s is enough.
          const hp = homePos();
          if (hp && builder.pos.distanceTo(hp) > 40) builder.pos.copy(hp);
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
  const unhoused = sim.agents.find((a) => a.alive && !a.controlled && a.faction === 'townsfolk' && isUnhoused(a));
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
  // Phase 2a: a finished building's .kind is the PERCEPT kind; the build-type is on buildKind.
  const finishedTavern = (sim.buildSites._buildings || []).some((b) => b.buildKind === 'tavern');
  const anyTavern = sim.buildSites.hasTavern(0) || finishedTavern || sim.surveyor.stats.taverns >= 1;
  ok(anyTavern, `construction: town commissioned a tavern (sites/built=${finishedTavern}, surveyed=${sim.surveyor.stats.taverns})`);

  // ── 5b. the GRANARY — commissioned at the pop threshold, tithed, drawn from ──
  // The main town also clears SURVEYOR.granaryMinPop (<= tavernMinPop), so the Surveyor
  // should have commissioned the public larder over the same run. Then drive the two
  // mechanics directly (unit-style, RNG-free): a FOOD market clear near the granary
  // tithes a fraction into its stock, and a destitute standing at the larder draws a
  // meal through the resolver facade.
  const anyGranary = sim.buildSites.hasGranary(0) || sim.surveyor.stats.granaries >= 1;
  ok(anyGranary, `construction: town commissioned a granary (surveyed=${sim.surveyor.stats.granaries})`);

  // a finished granary building to exercise stock/draw against. If the run's window left
  // it mid-build, force-finish the site through the sim's own finalize path (progress=1 →
  // BuildSites.tick promotes it) — the mechanic under test is stock/draw, not build pacing.
  let granary = (sim.buildSites._buildings || []).find((b) => b.buildKind === 'granary');
  if (!granary) {
    const site = (sim.buildSites._sites || []).find((s) => s.kind === 'granary');
    if (site) {
      site.woodHave = site.woodNeeded; site.progress = 1;
      sim.buildSites.tick(sim._ctx(), 0.5);
      granary = (sim.buildSites._buildings || []).find((b) => b.buildKind === 'granary');
    }
  }
  ok(!!granary, 'construction: a granary building stands (built or force-finalized)');

  if (granary) {
    // TITHE: two real townsfolk at the market POI nearest the granary; the seller holds a
    // food surplus, the buyer coin and an empty pack. A cleared food trade should move
    // titheFrac into the larder's stock. (Gold checks are over — this is food in kind.)
    const { runMarket } = await import('../../js/sim/market.js');
    const { GRANARY } = await import('../../js/sim/simconfig.js');
    const mpoi = sim.world.nearest('market', granary.pos);
    const folk = sim.agents.filter((a) => a.alive && !a.controlled && a.faction === 'townsfolk' && a.autonomous);
    const seller = folk[0], buyer = folk[1];
    const stock0 = granary.stock || 0;
    if (mpoi && seller && buyer) {
      seller.pos.set(mpoi.pos.x, 0, mpoi.pos.z);
      buyer.pos.set(mpoi.pos.x + 1, 0, mpoi.pos.z);
      seller.inventory.food = 10; seller.needs.hunger = 1;
      buyer.inventory.food = 0; buyer.needs.hunger = 0.5; buyer.gold = Math.max(buyer.gold, 100);
      // pin the price beliefs so OUR buyer always clears: the book is busy (other townsfolk at
      // the stalls out-bid a modest belief — the seeded flake this retires), so the buyer bids
      // the TOP of the book (10) and the seller asks the floor (1) — guaranteed overlap and
      // first match, whatever the run's drifted beliefs look like.
      seller.priceBeliefs.food = 1; buyer.priceBeliefs.food = 10;
      // the tithe exempts a subsistence buyer's only meal, so the buyer must clear at least
      // twice (holding a whole meal by the second unit) — loop runMarket until the stock moves.
      for (let i = 0; i < 8 && (granary.stock || 0) <= stock0; i++) runMarket(sim);
    }
    ok((granary.stock || 0) > stock0,
      `construction: a cleared food trade tithed the granary (stock ${stock0.toFixed(2)} -> ${(granary.stock || 0).toFixed(2)})`);

    // DRAW: a destitute (no food, no coin) standing at the larder is served ONE meal —
    // stock down, pack up — through the co-location-gated resolver facade.
    const pauper = folk.find((a) => a !== seller && a !== buyer) || buyer;
    if (pauper) {
      pauper.inventory.food = 0; pauper.gold = 0;
      pauper.pos.set(granary.pos.x + 0.5, 0, granary.pos.z);
      granary.stock = Math.max(granary.stock || 0, (GRANARY.drawMeal || 1) + 1);
      const before = granary.stock;
      const served = sim._cogResolver().granaryDraw(pauper);
      ok(served && (pauper.inventory.food || 0) >= (GRANARY.drawMeal || 1) && granary.stock < before,
        `construction: a destitute drew a meal from the larder (served=${served}, food=${(pauper.inventory.food || 0).toFixed(2)}, stock ${before.toFixed(2)} -> ${granary.stock.toFixed(2)})`);
      // a draw beyond the stock is refused (the larder can run bare — beg's turn).
      granary.stock = 0;
      ok(!sim._cogResolver().granaryDraw(pauper), 'construction: a bare larder serves nothing');
    }
  }

  // ── 6. every NPC still has a comfort need, a goal, and a valid ambition ──────
  ok(sim.agents.every((a) => (a.alive ? (a.needs && typeof a.needs.comfort === 'number') : true)),
    'construction: every living agent has a comfort need');
  // A HELD captive legitimately has goal=null (decide.ts: captivity suspends agency until rescue),
  // and the dead/player are exempt too — so assert a goal only for agents that actually run decide.
  // (Without this guard the check flaked ~1/14 when someone was captive on the asserting tick.)
  ok(sim.agents.every((a) => (a.alive && !a.controlled && !a._held) ? (a.goal && a.goal.kind) : true),
    'construction: every active (non-captive) agent has a goal');
  const validAmbition = (a) => a.ambition && (a.ambition.revenge || AMBITIONS[a.ambition.kind]);
  ok(sim.agents.filter((a) => !a.controlled).every(validAmbition),
    'construction: every NPC still has a valid ambition');

  // ── info ─────────────────────────────────────────────────────────────────────
  const st = sim.buildSites.stats;
  console.log(`INFO  construction: commissioned=${st.commissioned} completed=${st.completed} ` +
    `homes=${st.homes} taverns=${st.taverns} granaries=${st.granaries} ` +
    `(surveyor plots=${sim.surveyor.stats.plots} taverns=${sim.surveyor.stats.taverns} granaries=${sim.surveyor.stats.granaries})`);
  if (builder && builder.homeBeliefId != null && !isUnhoused(builder)) {
    // Phase 2a: report from the finished-building record (found by id), not a truth-side home.
    const h = (sim.buildSites._buildings || []).find((b) => b.id === builder.homeBeliefId);
    if (h) console.log(`INFO  construction: ${builder.name} raised ${h.label || (h.buildKind + ' #' + h.id)} ` +
      `— footprint ${h.footprint.w.toFixed(1)}×${h.footprint.d.toFixed(1)}, storeys ${h.storeys}, wealth ${h.wealth}`);
  }
}
