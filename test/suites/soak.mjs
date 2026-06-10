// ---- full-sim soak ------------------------------------------------------
// Drives the WHOLE sim for ~200 sim-seconds exactly like the render loop minus
// rendering, then asserts the cross-cutting invariants: gold conservation, trades
// across multiple commodities with reconciling econ telemetry, belief formation,
// ambition progress, emergent social groups, episodic memory, XP allocation, and
// ability milestones. The econ assertions live here (not a separate file) because
// they read the ledger this single soak run produced — splitting them would mean
// re-running the sim. No behavior change from the monolith.

import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { SIM, INTRIGUE, SEEDS, LINEAGE } from '../../js/sim/simconfig.js';
import { resolveCombat } from '../../js/combat.js';
import { AMBITIONS } from '../../js/sim/motivation.js';
import { memoryPhrase } from '../../js/sim/memory.js';
import { xpByVerb, xpTotal } from '../../js/rpg/xpstats.js';
import { allCommodityStats, econTotals, tradedCommodityCount, recentTrades } from '../../js/sim/econstats.js';
import { validate as validateSpec } from '../../js/rpg/abilities/ir.js';

export async function soak(ok, { makeFighter, stubScene }) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  sim.spawn();
  const pf = makeFighter('knight', { isPlayer: true });
  pf.root.position.set(0, 0, 8);
  sim.addPlayer(pf);

  // Agent construction kicked off Progression's lazy ability imports (catalog +
  // generator). They resolve on the microtask queue; the soak's frame loop is
  // fully synchronous, so without a yield those imports would never settle and
  // no milestone could grant. Await the same (cached) modules + flush a few
  // microtask turns so Progression's `.then` callbacks populate before frame 0.
  await Promise.all([
    import('../../js/rpg/abilities/catalog.js').catch(() => {}),
    import('../../js/rpg/abilities/generate.js').catch(() => {}),
    import('../../js/rpg/abilities/ir.js').catch(() => {}),
  ]);
  for (let k = 0; k < 5; k++) await Promise.resolve();

  const sumGold = () => sim.agents.reduce((s, a) => s + a.gold + (a.stash || 0), 0);
  const goldStart = sumGold();
  const npcCount = sim.agents.filter((a) => !a.controlled).length;
  ok(npcCount > 0, `spawn: ${npcCount} NPCs + player`);

  // every NPC should leave the constructor with a valid ambition
  const validAmbition = (a) => a.ambition && (a.ambition.revenge || AMBITIONS[a.ambition.kind]);
  ok(sim.agents.filter((a) => !a.controlled).every(validAmbition), 'motivation: every NPC has a valid ambition');

  // drive it exactly like the render loop, minus rendering
  const FRAMES = 12000, dt = 1 / 60;     // ~200 sim-seconds
  let trades = 0, stage = 'init';
  const typesSeen = new Set();   // group TYPES that emerge at ANY point (de-flakes the snapshot)
  // Phase 2b STEER REGRESSION NET (additive — does NOT touch depthMetrics.js, the depth
  // gate's own measuring instrument). The steering-substrate refactor collapses the ~12
  // locomotion goal.kind branches in act.js into steer-fills dispatched by goal.kind. The
  // collapse must PRESERVE the behavioural repertoire: every goal.kind the old code
  // produced must still appear. We sample the distinct goal.kind set over the run and
  // assert it is a SUPERSET of a pre-refactor baseline (kinds that reliably emerge each
  // run; RNG-rarer ones — plan/arbitrage/expedition — are deliberately excluded so this
  // never flakes). A kind silently vanishing (a fill that idles forever, a mis-keyed
  // dispatch) trips this BEFORE it could deflate the depth repertoire score.
  const goalKindsSeen = new Set();
  // DIRECTOR watch: town population must never be INSTANTLY wiped (anti-massacre
  // valve) — sample the living-townsfolk count over the run and keep the minimum.
  const townPop = () => sim.agents.filter((a) => a.alive && !a.controlled && a.faction === 'townsfolk').length;
  const townStart = townPop();
  let townMin = townStart;
  try {
    for (let i = 0; i < FRAMES; i++) {
      stage = 'sim.update'; sim.update(dt);
      stage = 'fighter.update'; for (const f of sim.fighters) f.update(dt);
      stage = 'resolveCombat';
      const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
      if (ev.length) { stage = 'onCombatEvents'; sim.onCombatEvents(ev); }
      trades += sim.tradesThisTick;
      // sample group TYPES OFTEN (every ~1s, not every 10s): a type can form and
      // dissolve between sparse samples, so coarse sampling under-observes the
      // diversity that genuinely emerged. Finer sampling strengthens the OBSERVATION
      // (it never lowers the >=2 bar) — it just stops us missing a transient type.
      if (i % 60 === 0) for (const a of sim.agents) if (!a.controlled && a.groupType) typesSeen.add(a.groupType);
      if (i % 120 === 0) { const p = townPop(); if (p < townMin) townMin = p; }
      // sample the distinct goal.kind set every ~0.5s (the steer-collapse regression net).
      if (i % 30 === 0) for (const a of sim.agents) if (a.goal && a.goal.kind) goalKindsSeen.add(a.goal.kind);
    }
  } catch (err) {
    ok(false, `soak: threw at stage '${stage}' frame loop -> ${err && err.message}`);
    console.error(err);
    return;
  }
  ok(true, `soak: ${FRAMES} frames ran without throwing`);

  // STEER-COLLAPSE REGRESSION NET (Phase 2b, additive): the distinct goal.kind set the
  // soak produced must be a SUPERSET of the pre-refactor baseline — no locomotion
  // behaviour disappeared when its act.js branch became a steer-fill. The baseline is
  // the set of kinds that reliably emerge each run (RNG-rare plan/arbitrage/expedition
  // are excluded so this is a hard floor, never a flake).
  const STEER_BASELINE = ['avoid', 'build', 'caravan', 'comfort', 'eat', 'fight', 'flee',
    'follow', 'hide', 'market', 'reporter', 'rest', 'shadow', 'sightsee', 'socialize',
    'spy', 'wander', 'work'];
  const missing = STEER_BASELINE.filter((k) => !goalKindsSeen.has(k));
  ok(missing.length === 0,
    `steer: behavioural repertoire preserved — every baseline goal.kind still emerges ` +
    `(${goalKindsSeen.size} distinct${missing.length ? ', MISSING: ' + missing.join(', ') : ''})`);

  // invariants after the soak
  const goldEnd = sumGold();
  ok(Math.abs(goldEnd - goldStart) < 1e-6, `economy: gold conserved (${goldStart.toFixed(2)} -> ${goldEnd.toFixed(2)})`);
  ok(trades > 0, `economy: trades occurred (${trades})`);

  // DIRECTOR: over the run the drama director should have fired at least one
  // RAID (the difficulty curve / population valve), and the town must NOT have
  // been instantly wiped — its living population stayed bounded above zero (the
  // anti-massacre safety valve). Gold conservation is asserted above and holds
  // BECAUSE spawned raiders carry no purse (they never mint gold).
  const dir = sim.director;
  ok(dir && dir.stats.raids >= 1, `director: fired at least one raid (${dir ? dir.stats.raids : 0} raids, ${dir ? dir.stats.spawned : 0} raiders spawned)`);
  ok(townMin > 0, `director: town not instantly wiped (townsfolk min=${townMin}, start=${townStart})`);
  // every director-spawned raider carries ZERO gold — spawning must not mint money.
  const raiderGold = sim.agents.filter((a) => /^Raider /.test(a.name)).reduce((s, a) => s + a.gold, 0);
  ok(raiderGold === 0, `director: spawned raiders carry no gold (sum=${raiderGold})`);
  console.log(`INFO  director: raids=${dir ? dir.stats.raids : 0} opps=${dir ? dir.stats.opportunities : 0} crises=${dir ? dir.stats.crises : 0} sparks=${dir ? dir.stats.sparks : 0} spawned=${dir ? dir.stats.spawned : 0}`);

  // economics telemetry (Phase 2): the econstats ledger recorded trades across
  // MULTIPLE commodities, and its aggregates RECONCILE internally — the global
  // totals must equal the sum of the per-commodity rows (a closed-loop sanity
  // check on the ledger: nothing recorded, dropped or double-counted).
  const econ = econTotals();
  const tradedGoods = tradedCommodityCount();
  const econRows = allCommodityStats();
  ok(econ.trades > 0, `econstats: ledger recorded trades (${econ.trades})`);
  ok(tradedGoods >= 2, `econstats: trades recorded across multiple commodities (${tradedGoods} goods)`);
  ok(econRows.length >= 2 && econRows.every((r) => r.n > 0 && r.beliefMean > 0),
    `econstats: per-commodity aggregates populated (${econRows.map((r) => r.commodity).join(', ')})`);
  // totals reconcile with the per-commodity rows (count AND volume), and the
  // recorded clearing volume is positive — telemetry conserves what the market did.
  const rowTrades = econRows.reduce((s, r) => s + r.n, 0);
  const rowVolume = econRows.reduce((s, r) => s + r.volume, 0);
  ok(rowTrades === econ.trades, `econstats: per-commodity counts reconcile with total (${rowTrades} == ${econ.trades})`);
  ok(Math.abs(rowVolume - econ.volume) < 1e-6 && econ.volume > 0,
    `econstats: per-commodity volume reconciles with total (${rowVolume.toFixed(2)} == ${econ.volume.toFixed(2)})`);
  ok(recentTrades(8).length > 0, 'econstats: recent-trades feed populated');
  console.log(`INFO  econ: ` + econRows.map((r) =>
    `${r.commodity} clr${r.clearAvg.toFixed(1)}/base${r.base} bel${r.beliefMean.toFixed(1)}±${r.beliefSpread.toFixed(1)} sc${r.scarcity.toFixed(2)}`).join('  '));

  const beliefs = sim.agents.reduce((s, a) => s + [...a.beliefs.all()].length, 0);
  ok(beliefs > 0, `ToM: agents formed beliefs (${beliefs} total)`);

  // CHRONICLE (drama §5): the live drama feed distilled the deed firehose into at
  // least one NOTABLE beat over the run, and every beat is well-formed — carries a
  // sim-TIMESTAMP and human phrasing with a NAME (a non-empty text string). The
  // ring is bounded by CHRONICLE.cap (read-only telemetry; never throws on tick).
  const chron = sim.chronicle;
  const beats = chron ? chron.recent(200) : [];
  ok(beats.length >= 1, `chronicle: recorded a notable beat (${beats.length} in the feed)`);
  ok(beats.every((b) => typeof b.t === 'number' && typeof b.text === 'string' && b.text.length > 0),
    'chronicle: every beat has a sim-timestamp and named phrasing');
  console.log(`INFO  chronicle: ${beats.length} beats · latest: ` +
    (beats.length ? `[${Math.round(beats[0].t)}s] ${beats[0].text}` : '(none)'));

  const progressed = sim.agents.some((a) => !a.controlled && a.ambition && a.ambition.progress > 0);
  ok(progressed, 'motivation: at least one ambition made progress');

  // social groups: emergent NPC bands/guilds/circles should form from affinity
  const members = sim.agents.filter((a) => !a.controlled && a.bandLeaderId != null);
  const byType = {};
  for (const m of members) byType[m.groupType] = (byType[m.groupType] || 0) + 1;
  ok(members.length > 0, `groups: NPC social groups formed (${members.length} members)`);
  ok(typesSeen.size >= 2, `groups: more than one group TYPE emerged over the run (${[...typesSeen].join(', ') || 'none'})`);
  console.log(`INFO  group types: ${Object.entries(byType).map(([k, v]) => `${k}:${v}`).join('  ') || 'none'}`);

  // episodic memory: agents accumulate episodes and consolidate the formative ones
  const withStm = sim.agents.filter((a) => a.memory.stm.size > 0).length;
  const withLtm = sim.agents.filter((a) => a.memory.ltm.size > 0);
  ok(withStm > 0, `memory: agents recorded episodes (${withStm} hold short-term memories)`);
  ok(withLtm.length > 0, `memory: formative episodes consolidated to long-term (${withLtm.length} hold LTM)`);
  // print a couple of biographies (the narrative payoff)
  const nameOf = (id) => { const x = sim.agentsById.get(id); return x ? x.name : 'someone'; };
  for (const a of sim.agents.filter((x) => x.memory.salient(1).length).slice(0, 3)) {
    console.log(`INFO  ${a.name}'s life: ` + a.memory.salient(3).map((e) => memoryPhrase(e, nameOf)).join(' · '));
  }

  // XP-allocation telemetry: deeds routed XP to classes during the soak
  const verbs = xpByVerb();
  ok(verbs.length > 0 && verbs.some((v) => v.xp > 0),
    `xp: actions allocated XP across ${verbs.length} verbs (${Math.round(xpTotal())} xp total)`);
  console.log(`INFO  top XP verbs: ` + verbs.slice(0, 6).map((v) => `${v.verb}:${Math.round(v.xp)}(×${v.n})`).join('  '));

  // ability milestones (Phase 2): EVERY agent that holds a class should hold >=1
  // VALID ability — abilities are minted at tier milestones from the class's
  // dominant tags, so PROCEDURAL classes (which have no catalog entry) now earn
  // them too. Assert both: classed agents are armed, AND it works for proc:* keys.
  const classed = sim.agents.filter((a) => a.progression && a.progression.classes.size > 0);
  const allArmed = classed.every((a) => a.abilities.size > 0 &&
    [...a.abilities.values()].every((s) => validateSpec(s)));
  ok(classed.length > 0 && allArmed,
    `abilities: every classed agent holds a valid ability (${classed.length} classed agents)`);
  // the whole point of Phase 2: procedural-class holders are armed via generation.
  const procHolders = classed.filter((a) =>
    [...a.progression.classes.keys()].some((k) => String(k).startsWith('proc:')));
  const procArmed = procHolders.filter((a) => a.abilities.size > 0);
  ok(procHolders.length > 0 && procArmed.length === procHolders.length,
    `abilities: procedural-class agents earned generated abilities (${procArmed.length}/${procHolders.length})`);
  console.log(`INFO  abilities: ${classed.reduce((s, a) => s + a.abilities.size, 0)} granted across ` +
    `${classed.length} classed agents (${procHolders.length} hold a procedural class)`);

  // INTRIGUE (the dormant ToM DECEPTION layer, switched on). Report what the
  // chaotic main run produced (seed-variable, so report-only): spies assigned,
  // disguises worn, false rumours planted, exfiltrations. Then ASSERT the invariant
  // on a DETERMINISTIC sub-sim where outcomes don't ride the soak's RNG.
  const intr = sim.intrigue;
  console.log(`INFO  intrigue: ${intr ? intr.stats.spies : 0} spies, ${intr ? intr.stats.plants : 0} rumours planted, ${intr ? intr.stats.exfils : 0} exfils during the soak`);
  await intriguePlantCheck(ok, { makeFighter, stubScene });

  // LINEAGE (births + apprenticeship). Report births from the chaotic main run
  // (seed-variable, so report-only), then ASSERT the invariant on a deterministic
  // STABLE-town sub-sim where outcomes don't depend on the soak's RNG.
  console.log(`INFO  lineage: ${sim.lineage.births} births, ${sim.lineage.apprenticeships} apprenticeships during the soak`);
  await lineageBirthCheck(ok, { makeFighter, stubScene });

  // NARRATIVE SEEDING — assert the rival-apprentices trope is PLANTED correctly at
  // world build (a deterministic spawn-time check; the trope then plays out via the
  // emergent systems, which we don't re-assert here since outcomes ride the RNG).
  seedingCheck(ok, { makeFighter, stubScene });

  // report-only (not asserted — these vary run to run)
  const alive = sim.agents.filter((a) => a.alive).length;
  const kills = sim.agents.reduce((s, a) => s + (a.life ? a.life.kills : 0), 0);
  const offers = sim.quests.offers.length;
  console.log(`INFO  alive=${alive}/${sim.agents.length}  kills=${kills}  questOffers=${offers}  ` +
    `t=${sim.time.toFixed(0)}s`);
  // a tasting of who's chasing what
  for (const a of sim.agents.filter((x) => !x.controlled).slice(0, 5)) {
    console.log(`INFO   ${a.name}: ${a.ambition ? a.ambition.label : '-'} ` +
      `(${Math.round((a.ambition?.progress || 0) * 100)}%)  doing:${a.goal?.kind}`);
  }
}

// LINEAGE birth invariant — a DETERMINISTIC stable-town sub-sim so the assertion
// doesn't ride the main soak's RNG. We stand up a tiny town (2 fond, fed,
// co-located townsfolk + nothing hostile) and pin those conditions each frame.
// The Director holds ALL events below DIRECTOR.minPopForEvents (this town is far
// under it), so the pair stays stable — exactly the "safe + fed -> births" gate.
// We assert: a child is BORN (population grows), the child INHERITED a parent's
// behaviour tag (lineage carries trades), GOLD is CONSERVED (dowry MOVED, never
// minted), and nothing threw (no freeze on the fixed tick).
async function lineageBirthCheck(ok, { makeFighter, stubScene }) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  // ISOLATE births from emergent groups: two fond, co-located townsfolk can form a
  // WARBAND (groups.js flips combatant=true mid-tick, BEFORE lineage's pass reads
  // it), and Lineage only bears children from a non-combatant pair — so the lone
  // test pair would flake to 0 births whenever it grouped as a warband. This sub-sim
  // verifies the BIRTH gate, not grouping; silence the groups tick so the pair stays
  // the intended civilian couple. (_fond still holds via the pinned belief-standing.)
  sim.groups.tick = () => {};

  // two fond parents, co-located, with DISTINCT marker tags in their profiles so
  // an inherited tag is unambiguously traceable to a parent (not coincidental).
  const mkCiv = (name, x, z) => {
    const f = makeFighter('knight', {});
    f.root.position.set(x, 0, z);
    stubScene.add(f.root);
    const a = new Agent(f, {
      id: sim._nextId++, name, profession: null,
      personality: { risk_tolerance: 0.3, social_drive: 0.7, ambition: 0.5, altruism: 0.6, curiosity: 0.5 },
      faction: 'townsfolk', townsperson: true,
    });
    sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  };
  const A = mkCiv('Mother', 0, 0);
  const B = mkCiv('Father', 1.2, 0);
  // a unique tag only the parents carry — its presence on a child proves descent.
  A.progression.behavior_profile.LINEAGE_MARK_A = 8;
  B.progression.behavior_profile.LINEAGE_MARK_B = 8;
  const goldStart = sim.agents.reduce((s, a) => s + a.gold + (a.stash || 0), 0);

  let stage = 'init';
  const dt = 1 / 60;
  try {
    // ~80 sim-seconds: comfortably past gestationSecs even with the tick throttle.
    for (let i = 0; i < 4800 && sim.lineage.births === 0; i++) {
      // PIN the stability gate every frame: keep the pair fed and mutually fond,
      // and keep them adjacent (they have no work site to wander to here anyway).
      for (const p of [A, B]) {
        if (!p.alive) continue;
        p.needs.hunger = 0.9; p.needs.energy = 0.9;
        // keep them CIVILIANS: two fond townsfolk can emergently form a *warband*
        // (groups.js flips combatant=true), and Lineage only bears children from a
        // non-combatant (hearth) pair — so pin combatant off to hold the intended
        // "peaceful couple" gate steady (otherwise the sub-sim flakes to 0 births).
        p.combatant = false;
      }
      const ab = A.beliefs._ensure(B.id); ab.standing = 0.6; ab.confidence = 1; ab.lastFaction = 'townsfolk';
      const ba = B.beliefs._ensure(A.id); ba.standing = 0.6; ba.confidence = 1; ba.lastFaction = 'townsfolk';
      A.fighter.root.position.set(0, 0, 0);
      B.fighter.root.position.set(1.2, 0, 0);
      stage = 'sim.update'; sim.update(dt);
    }
  } catch (err) {
    ok(false, `lineage: stable-town sub-sim threw at '${stage}' -> ${err && err.message}`);
    return;
  }

  ok(sim.lineage.births > 0, `lineage: births occur when the town is stable (${sim.lineage.births} born)`);

  // a NEW townsperson exists beyond the two founders (population can grow)
  const children = sim.agents.filter((a) => a.faction === 'townsfolk' && a !== A && a !== B);
  ok(children.length > 0, `lineage: population grew — ${children.length} child(ren) spawned`);

  // the child inherited at least one parent's marker tag (trades run in families)
  const inherited = children.some((c) => {
    const bp = c.progression && c.progression.behavior_profile;
    return bp && ((bp.LINEAGE_MARK_A || 0) > 0 || (bp.LINEAGE_MARK_B || 0) > 0);
  });
  ok(inherited, 'lineage: a child inherited a parent behaviour tag');

  // GOLD CONSERVED — a dowry is MOVED from a parent to the child, never minted.
  const goldEnd = sim.agents.reduce((s, a) => s + a.gold + (a.stash || 0), 0);
  ok(Math.abs(goldEnd - goldStart) < 1e-6,
    `lineage: gold conserved across birth (${goldStart.toFixed(2)} -> ${goldEnd.toFixed(2)})`);
  const child0 = children[0];
  if (child0) console.log(`INFO  lineage: child "${child0.name}" gold=${child0.gold} ` +
    `markA=${(child0.progression.behavior_profile.LINEAGE_MARK_A || 0).toFixed(1)} ` +
    `markB=${(child0.progression.behavior_profile.LINEAGE_MARK_B || 0).toFixed(1)}`);
}

// NARRATIVE SEEDING invariant — a fresh spawned town must contain the planted
// rival-apprentices trope in its correct STARTING shape: a seasoned, ARMED master
// of the trade (recognisable as a master by the apprenticeship pass), two young
// apprentices bound to that master, and a mutual rivalry between them. We assert
// the SEED (spawn-time), not the playout (which rides the RNG and is shown by the
// rollout instead). Skips cleanly when seeding is disabled.
function seedingCheck(ok, { makeFighter, stubScene }) {
  if (!SEEDS || !SEEDS.enabled || !SEEDS.rivalApprentices || !SEEDS.rivalApprentices.enabled) {
    ok(true, 'seeding: disabled (skipped)');
    return;
  }
  const cfg = SEEDS.rivalApprentices;
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  sim.spawn();

  const master = sim.agents.find((a) => a.seedRole === 'master');
  const masterOk = !!master &&
    master.progression.classes.has(cfg.classKey) &&
    master.progression.totalLevel >= LINEAGE.masterMinLevel &&
    master.abilities.size > 0;
  ok(masterOk, `seeding: a seasoned ARMED master of the trade is planted (${master ? master.name + ' ' + (master.progression.primaryClass() || {}).name + ' L' + master.progression.totalLevel + ' arms:' + master.abilities.size : 'none'})`);

  const apps = sim.agents.filter((a) => a.seedRole === 'apprentice');
  ok(apps.length === 2 && master && apps.every((a) => a.masterId === master.id),
    `seeding: two apprentices are bound to the master (${apps.length})`);

  const rivalrous = apps.length === 2 &&
    (apps[0].beliefs.get(apps[1].id) || {}).standing < 0 &&
    (apps[1].beliefs.get(apps[0].id) || {}).standing < 0 &&
    apps[0].rivalId === apps[1].id && apps[1].rivalId === apps[0].id;
  ok(rivalrous, 'seeding: the two apprentices are seeded as rivals (mutual ill-will)');
  if (master) console.log(`INFO  seeding: ${master.name} [${cfg.classKey}] L${master.progression.totalLevel} + rivals ${apps.map((a) => a.name).join(' / ')}`);
}

// INTRIGUE plant invariant — a DETERMINISTIC sub-sim so the assertion doesn't ride
// the chaotic main soak's RNG (a spy on the frontier may or may not survive the
// trek). We stand up a tiny embedded scene at the town CORE: one disguised SPY,
// an OBSERVER townsperson within talk range, a peaceful VICTIM townsperson it will
// FRAME, and a BYSTANDER townsperson beside the observer (the gossip relay). We
// PIN their positions each frame so the spy stays embedded, drive the real sim
// (so Intrigue.tick runs the live plant logic), and assert the ToM DECEPTION
// invariants:
//   1. the spy PLANTS a false belief — the observer comes to believe the innocent
//      victim is HOSTILE, written with RUMOR provenance (not witnessed truth);
//   2. it PROPAGATES — gossip carries the false hostility to at least one further
//      observer (the bystander), igniting a spreading feud from a lie;
//   3. it FADES — left un-reinforced, the planted belief's confidence DECAYS over
//      time (rumours die if nobody repeats them);
//   4. the EPISTEMIC SPLIT holds — the spy's TRUE faction is unchanged (combat
//      stays truthful), and GOLD is conserved (deception mints nothing);
//   5. nothing threw (no freeze on the fixed tick).
async function intriguePlantCheck(ok, { makeFighter, stubScene }) {
  if (!INTRIGUE || !INTRIGUE.enabled) { ok(true, 'intrigue: disabled (skipped)'); return; }
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  // ISOLATE the deception mechanics from RENEWAL: with births on, a newborn
  // townsperson wanders into sight of the framed victim and then GOSSIPS back to the
  // observer, reinforcing the planted belief's confidence (rumor -> talked) — which
  // is realistic in the live world but breaks this controlled 4-actor decay test.
  // Silence lineage (and the director, which births could push past its pop gate).
  sim.lineage.tick = () => {};
  sim.director.tick = () => {};

  const mk = (name, faction, x, z, extra = {}) => {
    const f = makeFighter('knight', {});
    f.root.position.set(x, 0, z);
    stubScene.add(f.root);
    const a = new Agent(f, {
      id: sim._nextId++, name, profession: null,
      personality: { risk_tolerance: 0.3, social_drive: 0.7, ambition: 0.5, altruism: 0.6, curiosity: 0.5 },
      faction, townsperson: faction === 'townsfolk', ...extra,
    });
    sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  };

  // The geometry matters: spy beside the observer at the core (within talkRange),
  // the innocent VICTIM within the spy's frameRadius but BEYOND the observer's
  // visionRange — so the observer never directly SEES the victim and overwrites
  // the planted lie with witnessed truth; its only knowledge of the victim is the
  // rumour. The bystander hugs the observer as a pure GOSSIP relay (it can't see
  // the victim either, so its belief can ONLY come second-hand — the spreading lie).
  const observer = mk('Observer', 'townsfolk', 0, 0);
  const bystander = mk('Bystander', 'townsfolk', 1.0, 0);      // gossip relay (near observer)
  const VZ = SIM.visionRange + 1;                              // just beyond sight
  const victim = mk('Victim', 'townsfolk', 2, VZ);             // innocent, in spy's frame range
  // the SPY: a real bandit wearing a town cover identity (disguise). combatant so
  // it never runs the economy path; we hand it the spy state the subsystem would.
  const spy = mk('Spy', 'bandit', 2, 0, { combatant: true });
  spy.disguiseFaction = INTRIGUE.disguiseAs;
  spy.spy = { homeKey: 'bandit', anchor: null, phase: 'scout', plantCd: 0 };
  // register the spy with the live Intrigue subsystem and mark assignment done so
  // it doesn't try to (re)draw spies from camps (there are none in this sub-sim).
  sim.intrigue.spies = [spy];
  sim.intrigue._assigned = true;
  sim.intrigue.stats.spies = 1;

  const trueFactionBefore = spy.faction;       // must be UNCHANGED by deception
  const goldStart = sim.agents.reduce((s, a) => s + a.gold + (a.stash || 0), 0);

  let stage = 'init';
  const dt = 1 / 60;
  try {
    // ~50 sim-seconds: comfortably past INTRIGUE.tickEvery + the initial plantCd.
    for (let i = 0; i < 3000 && sim.intrigue.stats.plants === 0; i++) {
      // PIN the embedded scene so the spy stays beside the observer and the VICTIM
      // is the only townsperson in the spy's frame range — the bystander is held
      // far away during the plant so the spy unambiguously frames OUR victim. Keep
      // the spy under cover (its position re-pinned) and out of incidental fights.
      observer.fighter.root.position.set(0, 0, 0);
      bystander.fighter.root.position.set(60, 0, 60);     // out of frame for now
      victim.fighter.root.position.set(2, 0, VZ);
      spy.fighter.root.position.set(2, 0, 0);
      stage = 'sim.update'; sim.update(dt);
    }
  } catch (err) {
    ok(false, `intrigue: plant sub-sim threw at '${stage}' -> ${err && err.message}`);
    return;
  }

  // 1. the spy planted a false belief.
  ok(sim.intrigue.stats.plants > 0, `intrigue: a spy planted a false rumour (${sim.intrigue.stats.plants})`);
  const ob = observer.beliefs.get(victim.id);
  ok(!!ob && ob.hostile && ob.source === 'rumor',
    `intrigue: observer holds a FALSE hostile belief about an innocent (source=${ob ? ob.source : 'none'})`);

  // 2. it PROPAGATES — drive a little longer so gossip carries the lie onward, and
  // assert at least one FURTHER townsperson came to believe the innocent hostile.
  try {
    for (let i = 0; i < 600; i++) {
      observer.fighter.root.position.set(0, 0, 0);
      bystander.fighter.root.position.set(1.0, 0, 0);
      victim.fighter.root.position.set(2, 0, VZ);
      spy.fighter.root.position.set(2, 0, 0);
      sim.update(dt);
    }
  } catch (err) { ok(false, `intrigue: propagation phase threw -> ${err && err.message}`); return; }
  const spread = sim.agents.filter((a) =>
    a.faction === 'townsfolk' && a !== observer && a.id !== victim.id &&
    (() => { const b = a.beliefs.get(victim.id); return !!(b && b.hostile); })()).length;
  ok(spread >= 1, `intrigue: the false rumour PROPAGATED to >=1 further observer (${spread} believe the lie)`);

  // 3. it FADES — snapshot the planted belief's confidence, then let it DECAY with
  // no reinforcement (move the spy far away so it can't re-plant) and assert the
  // confidence dropped. Decay is the provenance model: an un-repeated rumour dies.
  const ob2 = observer.beliefs.get(victim.id);
  const confBefore = ob2 ? ob2.confidence : 0;
  spy.fighter.root.position.set(500, 0, 500);   // exile the spy: no more planting
  spy.spy = null;                               // and stop it acting as a spy
  try {
    for (let i = 0; i < 1800; i++) {            // ~30s of pure decay
      observer.fighter.root.position.set(0, 0, 0);
      victim.fighter.root.position.set(2, 0, VZ);
      // keep the bystander away so it can't re-gossip the lie back to the observer
      bystander.fighter.root.position.set(60, 0, 60);
      sim.update(dt);
    }
  } catch (err) { ok(false, `intrigue: decay phase threw -> ${err && err.message}`); return; }
  const ob3 = observer.beliefs.get(victim.id);
  const confAfter = ob3 ? ob3.confidence : 0;
  ok(confAfter < confBefore, `intrigue: the planted belief DECAYS over time (conf ${confBefore.toFixed(2)} -> ${confAfter.toFixed(2)})`);

  // 4. EPISTEMIC SPLIT — the spy's TRUE faction is untouched (only beliefs were
  // falsified), and GOLD is conserved (deception mints nothing).
  ok(spy.faction === trueFactionBefore, `intrigue: spy's TRUE faction unchanged by disguise (${spy.faction})`);
  const goldEnd = sim.agents.reduce((s, a) => s + a.gold + (a.stash || 0), 0);
  ok(Math.abs(goldEnd - goldStart) < 1e-6, `intrigue: gold conserved (${goldStart.toFixed(2)} -> ${goldEnd.toFixed(2)})`);
  console.log(`INFO  intrigue: planted feud — Observer believes Victim hostile (conf ${confBefore.toFixed(2)}->${confAfter.toFixed(2)}), spread to ${spread}`);
}
