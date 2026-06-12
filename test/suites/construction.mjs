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
import { COMFORT, BUILD, SURVEYOR, SCHEMA, HALL, COMMODITIES } from '../../js/sim/simconfig.js';
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

  // ── 7. THE GUILDHALL: an enduring, funded fellowship raises a hall ───────────
  // Hand-assemble a loose GUILD around a living anchor (deterministic — the emergent
  // formation RNG is taken out, the same pinning technique as the builder above), age
  // it past the endurance gate, fund the anchor's wood, and assert the whole arc:
  // commission (the anchor's wood banked into the site, conserved) → completion +
  // the groupHallId stamp on anchor AND members → a member's socialize CONVERGES on
  // the hall (decide pins toPos off its OWN place-belief) → disband clears the stamp.
  await guildhallPhase(ok, sim, dt);

  // ── info ─────────────────────────────────────────────────────────────────────
  const st = sim.buildSites.stats;
  console.log(`INFO  construction: commissioned=${st.commissioned} completed=${st.completed} ` +
    `homes=${st.homes} taverns=${st.taverns} halls=${st.halls} (surveyor plots=${sim.surveyor.stats.plots} taverns=${sim.surveyor.stats.taverns})`);
  if (builder && builder.homeBeliefId != null && !isUnhoused(builder)) {
    // Phase 2a: report from the finished-building record (found by id), not a truth-side home.
    const h = (sim.buildSites._buildings || []).find((b) => b.id === builder.homeBeliefId);
    if (h) console.log(`INFO  construction: ${builder.name} raised ${h.label || (h.buildKind + ' #' + h.id)} ` +
      `— footprint ${h.footprint.w.toFixed(1)}×${h.footprint.d.toFixed(1)}, storeys ${h.storeys}, wealth ${h.wealth}`);
  }
}

// ---------------------------------------------------------------------------
// THE GUILDHALL phase (section 7) — runs inside the live construction sim.
// ---------------------------------------------------------------------------
async function guildhallPhase(ok, sim, dt) {
  const frame = () => {
    sim.update(dt);
    for (const f of sim.fighters) f.update(dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  };

  // three WORKING townsfolk of the MAIN town (its pop carries the ambient public-works
  // labour, the same gate the tavern uses; canWork because the socialize candidate we
  // assert on lives in the economic scheduler). By this point in the suite most folk
  // have emergently grouped, so we also accept a FOLLOWERLESS loose tag-holder and
  // re-roll it into our fixture group (its old tag is just an affiliation label).
  const pool = sim.agents.filter((a) => a.alive && !a.controlled && a.autonomous && a.canWork &&
    a.faction === 'townsfolk' && a.townId === 0 && !a.inParty && a.bandLeaderId == null &&
    !a.watch && !a.expedition && !a.caravanRun && !a.arbitrage && !a.bounty &&
    a.groupHallId == null && sim.agents.every((x) => x.bandLeaderId !== a.id));
  if (pool.length < 3) { ok(true, 'guildhall: SKIP — fewer than 3 free townsfolk this run (RNG edge)'); return; }
  const [L, F1, F2] = pool;
  // assemble the guild the way _join would (flags only; loose groups don't follow).
  L.groupType = 'guild'; L.groupName = 'the Hammerfast Guild';
  // formed "long ago" RELATIVE TO NOW — the endurance gate is decisively open (a flat 0
  // left the age marginal against minAgeSecs at this point in the suite's timeline).
  L._groupFormedAt = sim.time - HALL.minAgeSecs - 10;
  for (const [i, F] of [F1, F2].entries()) {
    F.bandLeaderId = L.id; F.groupType = 'guild'; F.groupName = L.groupName; F.partySlot = i;
  }

  // PIN: keep the trio alive and the membership flags intact for the build window (a
  // wandering recruiter/warband or a stray blade re-rolling the group would make this
  // gate flake — the same RNG-removal pinning the builder above uses). Liveness only +
  // the very flags we hand-set; the hall mechanics themselves are never touched.
  const pinGroup = () => {
    for (const A of [L, F1, F2]) {
      if (!A.alive) continue;
      A.fighter.health = Math.max(A.fighter.health, 80);
      A.needs.hunger = Math.max(A.needs.hunger, 0.8);
      A.inParty = false; A.groupType = 'guild'; A.groupName = L.groupName;
    }
    L.bandLeaderId = null;
    if (F1.alive) F1.bandLeaderId = L.id;
    if (F2.alive) F2.bandLeaderId = L.id;
  };

  // ── 7a. commission: the enduring, funded group lays the foundations ──────────
  // We watch for L's OWN pending hall site (groups._hallSites is keyed by anchor id) —
  // organic fellowships elsewhere may legitimately raise halls of their own now.
  let site = null;
  for (let i = 0; i < 600 && !site && L.groupHallId == null; i++) {
    pinGroup();
    // keep the anchor FUNDED until ITS commission fires (it can sell its wood at market
    // mid-window — the funding itself is what's under test, not the anchor's thrift).
    if (!sim.groups._hallSites.has(L.id)) L.inventory.wood = Math.max(L.inventory.wood || 0, HALL.woodCost);
    frame();   // groups._maybeRaiseHalls runs on the ~1.5s form cadence
    site = sim.groups._hallSites.get(L.id) || null;
  }
  ok(!!site || L.groupHallId != null, 'guildhall: an enduring, funded fellowship commissioned a hall');
  if (!site && L.groupHallId == null) return;
  if (site) ok(site.woodHave >= HALL.woodCost - 1e-6,
    `guildhall: the anchor banked its wood into the site (woodHave=${site.woodHave} >= ${HALL.woodCost})`);

  // ── 7b. completion stamps groupHallId on the anchor AND members ──────────────
  for (let i = 0; i < 9000 && L.groupHallId == null; i++) { pinGroup(); frame(); }
  ok(L.groupHallId != null, `guildhall: the finished hall was stamped on the anchor (groupHallId=${L.groupHallId})`);
  ok(F1.groupHallId === L.groupHallId && F2.groupHallId === L.groupHallId,
    'guildhall: every member carries the same groupHallId stamp');
  const hall = (sim.buildSites._buildings || []).find((b) => b.id === L.groupHallId);
  ok(!!hall && hall.buildKind === 'guildhall',
    `guildhall: the stamped id resolves to a finished guildhall building (${hall && hall.label})`);
  if (!hall) return;

  // ── 7c. a member's socialize CONVERGES ON THE HALL ────────────────────────────
  // First, DISCOVERY BY SIGHT: stand the member within vision of the hall and run real
  // frames until its OWN perception files the place-belief (never a telepathic write).
  // Then assert the decision itself with a DIRECT decide() call (the seeding-suite
  // romeo.decide pattern) under fully pinned needs — deterministic: no wandering
  // monster, market haul or courtship can claim the window between frames.
  const schemaWas = SCHEMA.enabled;
  SCHEMA.enabled = false;
  let converged = false;
  try {
    const M = F1;
    M.pos.set(hall.pos.x + 6, M.pos.y, hall.pos.z + 6);
    M.fighter.root.position.copy(M.pos);
    for (let i = 0; i < 600; i++) {            // discovery: perception files the hall place-belief
      pinGroup();
      if (Math.hypot(M.pos.x - hall.pos.x, M.pos.z - hall.pos.z) > 14) {
        M.pos.set(hall.pos.x + 6, M.pos.y, hall.pos.z + 6);   // position only — beliefs untouched
        M.fighter.root.position.copy(M.pos);
      }
      frame();
      const hb = M.beliefs.get(M.groupHallId);
      if (hb && hb.placeKind && hb.sheltered !== false) break;
    }
    ok(!!M.beliefs.get(M.groupHallId), 'guildhall: the member DISCOVERED its hall by sight (own place-belief filed)');
    // pin the scheduler so socialize is the live want, strip every role/override that
    // pre-empts it (the freeCivilian pattern, minus the band flags our fixture owns),
    // purge person-beliefs (no believed threat → no danger suppression), then decide.
    pinGroup();
    M.watch = false; M.combatant = false; M.expedition = null; M.caravanRun = null;
    M.arbitrage = null; M.bounty = null; M.spy = null; M.reporter = false;
    M._held = null; M._duelWith = null; M.avengerOf = null; M._courtingId = null;
    M.personality.social_drive = 0.9;          // a sociable soul (score isolation, like the builder pin)
    // …whose ambition FAVOURS company: a wealth/mastery soul's ambitionFavor deflates
    // socialize (×0.7) and inflates work (×1.7), which can out-score the gathering for
    // the whole window — the same RNG-removal as the rest of the pin (we assert the
    // hall CONVERGENCE mechanic, not which ambition the lottery dealt this agent).
    M.ambition = { kind: 'belonging', label: 'belong', progress: 0, t0: sim.time, revenge: false,
      base: { mkills: M.life.monsterKills, dist: M.life.dist, social: M.life.social, gold: M.gold, level: 0 } };
    M.needs.social = 0.05;                     // starved of company → socialize wins
    M.needs.hunger = 0.95; M.needs.energy = 0.95;
    M.needs.comfort = 0.95; M.needs.novelty = 0.95;
    // no haul to sell, fed + tooled: keeps the urgency-scaled `market` candidate from
    // out-pulling socialize (the same competing-candidate isolation as the builder pin).
    for (const c of COMMODITIES) M.inventory[c] = 0;
    M.inventory.food = 2; M.inventory.tool = 1;
    M._schemaGoalLock = null;
    try {                                       // purge person-beliefs (keep PLACE beliefs — the hall!)
      const store = M.beliefs && M.beliefs.map;
      if (store) for (const [key, bel] of store) { if (!(bel && bel.placeKind)) store.delete(key); }
    } catch { /* test-only isolation */ }
    M.goal = { kind: 'wander' };
    for (let i = 0; i < 8 && !converged; i++) { // a few cognition ticks (sticky-goal tolerance)
      M.decide(sim._cognitionCtx());
      if (M.goal && M.goal.kind === 'socialize' && M.goal.toPos &&
          Math.hypot(M.goal.toPos.x - hall.pos.x, M.goal.toPos.z - hall.pos.z) < 3) converged = true;
    }
  } finally {
    SCHEMA.enabled = schemaWas;
  }
  ok(converged, 'guildhall: a member\'s socialize converges ON THE HALL (toPos = its own believed hall position)');

  // ── 7d. disband clears the stamp (the hall persists as a town building) ───────
  sim.groups._revert(F1);
  ok(F1.groupHallId == null, 'guildhall: a reverted member loses its groupHallId stamp');
  // revert EVERY remaining follower (the organic _form pass may have recruited extras
  // into our fixture guild over the build window), then prune directly + synchronously
  // so _form can't re-staff the group mid-check.
  for (const F of sim.groups._followersOf(L.id)) sim.groups._revert(F);
  sim.groups._prune();
  ok(L.groupHallId == null, 'guildhall: the dwindled anchor\'s stamp is cleared on dissolution');
  ok((sim.buildSites._buildings || []).some((b) => b.buildKind === 'guildhall'),
    'guildhall: the abandoned hall persists as a town building (flavour, not despawn)');
}
