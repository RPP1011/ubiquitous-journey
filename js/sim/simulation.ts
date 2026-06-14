// Simulation manager: spawns the professions, runs the fixed-rate decision pass
// and the market double-auction, and tracks emergent average prices. Peaceful —
// no combat — so the human can wander a working market town.

import * as THREE from 'three';
import { Fighter } from '../fighter.js';
import { Agent } from './agent.js';
import { ROSTER, SIM, NAMES, MONSTER, MOTIVE, CAMPS, TOWNS, SCARECROW, BUILD, LOD, KNOW, RECRUIT, OUTLAW, ALMS, GRANARY, PERSONALITY, factionHostile } from './simconfig.js';
import { assignHouse, founderHouse } from './houses.js';
import { ARENA_RADIUS, BIOME, findBiomeSpot, regionAt, REGIONS, terrainHeight } from '../arena.js';
import { resetXpStats } from '../rpg/xpstats.js';
import { resetEconStats } from './econstats.js';
import { Reputation, REP } from './reputation.js';
import { QuestBoard } from '../quest/quest.js';
import { Party } from './party.js';
import { Groups } from './groups.js';
import { Director } from './director.js';
import { Defenses } from './defenses.js';
import { Faith } from './faith.js';
import { Watch } from './watch.js';
import { Expeditions } from './expeditions.js';
import { Patrician } from './patrician.js';
import { Surveyor } from './surveyor.js';
import { Cities } from './cities.js';
import { BuildSites, BUILD_KIND } from './construction.js';
import './features/index.js';   // load the action-grammar features (each self-registers its verbs)
import { seedNarratives } from './seeding.js';
import { Lineage } from './lineage.js';
import { Migration } from './migration.js';
import { Chronicle } from './chronicle.js';
import { SagaStore } from './arcs.js';
import { foldLoss, foldDeed, foldScarcity, noteWitness } from './signals.js';
import { runStatusSensor } from './statusSensor.js';
import { Gazette } from './gazette.js';
import { Reporter } from './reporter.js';
import { Bounties } from './bounties.js';
import { Arbitrage } from './arbitrage.js';
import { Intrigue } from './intrigue.js';
import { runMarket } from './market.js';
import { castSpec } from '../rpg/abilities/interpreter.js';
import { POI_KIND } from './world.js';
import { PLAN } from './planner.js';
import { installDeedRouter, recordDeed } from './deedRouter.js';
import { bus, makeEvent as makeEventRaw } from '../rpg/events.js';
import { onCombatEvents } from './combatEvents.js';
import { MentalMap } from './mentalmap.js';
import { rng, setSeed } from './rng.js';
import { Scarecrow } from './percept.js';
import { reason } from './schemas/interpreter.js';
import { ACTIVE as SCHEMA_CATALOGUE } from './schemas/catalogue.js';
import type {
  Agent as AgentShape, Percept, Perceivable, World as IWorld, MentalMap as IMentalMap,
  Town, FullCtx, CognitionCtx, ResolverFacade, ArcPorts, SiteHandle, MakeFighter,
  Fighter as IFighter, CombatEvent, EntityId, AgentRef, PosSnapshot, AbilitySpec, Personality,
  ActionEvent, ActionEventSpec,
} from '../../types/sim.js';

// events.js infers makeEvent's `tags=[]` default as never[]; re-type at the seam (combatEvents
// does the same). A thin emit helper so the witnessed-deed fold publishes deeds onto the shared bus.
const busEmit = (spec: ActionEventSpec): void => { bus.emit((makeEventRaw as (s: ActionEventSpec) => ActionEvent)(spec)); };

// A spawned town carries more than the shared Town type's id/center (the MentalMap reads
// only those two): the sim also tracks radius + display name. Local widening — runtime-only.
interface SimTown extends Town { radius: number; name: string; }

// A camp's config row (simconfig.js CAMPS[key]) — the fields spawn/reinforce read. The
// source object is untyped JS; this names exactly what we consume (all optional/loose).
interface CampCfg {
  faction: string;
  model?: string;
  scatter?: number;
  name?: string;
  leaderName?: string;
  leaderThreat?: number;
  threat?: number;
  patrolR?: number;
  leashR?: number;
  ringMin?: number;
  ringMax?: number;
  raidActive?: boolean;
  leaders?: number;
  followers?: number;
  reinforceEvery?: number;
  reinforceMax?: number;
}

// A frontier CAMP: a leader + ring of followers anchored off the town core. Pure sim state.
interface Camp {
  key: string;
  faction: string;
  anchor: THREE.Vector3;
  leader: AgentShape | null;
  members: AgentShape[];
  raidActive: boolean;
  _lastReinforce: number;
  _born: number;
}

// A minimal browser-visual scene. The vendored `three` is un-typed JS, so TS cannot see
// Object3D's transform members; this covers exactly what spawn()/_spawn* touch.
interface SceneLike { add(o: { position: THREE.Vector3 }): void; remove(o: unknown): void; }

const rand = (a: number, b: number): number => a + rng() * (b - a);

// Re-typed config views (arena.js / simconfig.js are un-typed JS inferred without string
// index signatures — these name the by-key lookups the spawn paths perform).
const REGIONS_T = REGIONS as Record<string, { danger?: number } | undefined>;
const CAMPS_T = CAMPS as Record<string, CampCfg> | null | undefined;

// Mint the next agent id. Agents use NUMERIC ids (EntityId = number | string), but the agent
// cluster's private AgentCfg narrows cfg.id to `string`; this localises the one needed cast
// so the four spawn call-sites stay clean while keeping ids genuinely numeric at runtime.
const idCfg = (n: number): string => n as unknown as string;

// synthesise a plausible given name from syllables — the fallback when the curated
// NAMES pool is exhausted (large multi-town worlds + generations). Keeps the
// chronicle reading like people, not "Unit47".
const _SYL_A = ['Ar', 'Bel', 'Cor', 'Dra', 'El', 'Fen', 'Gar', 'Hal', 'Il', 'Jor', 'Kel', 'Lor', 'Mor', 'Nor', 'Or', 'Per', 'Quen', 'Ral', 'Sel', 'Tor', 'Ul', 'Ver', 'Wyn', 'Yor', 'Zel'];
const _SYL_B = ['a', 'e', 'i', 'o', 'ae', 'ia', 'ei', 'au'];
const _SYL_C = ['dric', 'wyn', 'mar', 'ric', 'sa', 'lyn', 'don', 'gar', 'the', 'ven', 'na', 'ris', 'mund', 'far', 'dis', 'wald', 'ric', 'beth'];
function synthName(): string {
  const p = (arr: string[]): string => arr[(rng() * arr.length) | 0];
  return p(_SYL_A) + p(_SYL_B) + p(_SYL_C);
}

// Sample a personality. MEDIAN-PRESERVING (config PERSONALITY): every soul first draws the
// ORIGINAL uniform spread for the five legacy traits (exactly as the old sim did — the median
// population, and the economy soak on it, is undisturbed) plus uniform new traits. Then a MINORITY
// (temperamentChance) are nudged toward a named archetype centroid, gaining correlated extremes
// (a greedy-and-dishonest miser, a bold-and-vindictive hothead) — individuality in the TAILS. The
// temperament name is stashed on the non-enumerable `_temperament` key for later narration/epithets;
// cognition reads only the numeric traits, so the label is inert to decisions.
function makePersonality(): Personality {
  const p: Personality = {
    // the five legacy traits — UNCHANGED uniform draws (baseline distribution preserved)
    risk_tolerance: rand(0.2, 0.8),
    social_drive:   rand(0.2, 0.8),
    ambition:       rand(0.3, 0.9),
    altruism:       rand(0.2, 0.8),
    curiosity:      rand(0.2, 0.8),
    // the new traits — a real spread for individuality, but no extreme tails for the bulk
    greed:          rand(0.2, 0.8),
    vindictiveness: rand(0.2, 0.8),
    gregariousness: rand(0.2, 0.8),
    honesty:        rand(0.2, 0.8),
    industry:       rand(0.2, 0.8),
  };
  let temperament = 'everyman';
  if (rng() < PERSONALITY.temperamentChance) {
    const arcs = PERSONALITY.archetypes;
    let total = 0; for (const a of arcs) total += a.w;
    let r = rng() * total, pick = arcs[0];
    for (const a of arcs) { r -= a.w; if (r <= 0) { pick = a; break; } }
    const J = PERSONALITY.jitter, lo = PERSONALITY.lo, hi = PERSONALITY.hi;
    for (const t of PERSONALITY.traits) {
      if (pick.c[t] == null) continue;                       // unpinned traits keep their uniform base
      p[t] = Math.max(lo, Math.min(hi, pick.c[t] + (rng() - 0.5) * 2 * J));
    }
    temperament = pick.name;
  }
  Object.defineProperty(p, '_temperament', { value: temperament, enumerable: false });
  return p;
}

export class Simulation {
  // ───── core roster + world handles ─────
  scene: SceneLike;
  world: IWorld;
  makeFighter: MakeFighter;
  agents: AgentShape[];
  agentsById: Map<EntityId, AgentShape>;
  percepts: Percept[];
  map: IMentalMap | null;
  time: number;
  player?: AgentShape;
  towns?: SimTown[];
  camps?: Record<string, Camp>;

  // ───── internal bookkeeping ─────
  _acc: number;
  _nextId: number;
  _names: string[];
  _houseEverGrew: Set<unknown>;
  houseFeuds: Set<unknown>;
  tradesThisTick: number;
  _busOff: (() => void) | null;
  _resolver?: ResolverFacade;
  _deathSeen?: Set<EntityId>;
  _spawned?: boolean;

  // ───── subsystems (value-imported classes; types inferred from their .js modules) ─────
  reputation: Reputation;
  quests: QuestBoard;
  party: Party;
  groups: Groups;
  defenses: Defenses;
  faith: Faith;
  watch: Watch;
  expeditions: Expeditions;
  patrician: Patrician;
  cities: Cities;
  buildSites: BuildSites;
  surveyor: Surveyor;
  director: Director;
  lineage: Lineage;
  migration: Migration;
  chronicle: Chronicle;
  sagas: SagaStore;
  _arcPortsCache?: ArcPorts;
  _lastReap?: number;
  _decayPhase?: number;   // belief-decay stride phase (rotates 0..K-1; see the ToM pass)
  gazette: Gazette;
  reporter: Reporter;
  bounties: Bounties;
  arbitrage: Arbitrage;
  intrigue: Intrigue;

  constructor(scene: SceneLike, world: IWorld, opts: { makeFighter?: MakeFighter; seed?: number } = {}) {
    this.scene = scene;
    this.world = world;
    // SEEDED DETERMINISM: arm the shared PRNG before any spawn rolls. With no seed this is a no-op
    // (the stream stays unseeded ⇒ rng() === Math.random(), so the unseeded soak is byte-identical);
    // with a seed, every routed stochastic site draws the same sequence ⇒ reproducible runs. Set
    // here (not lazily) so world-build rolls (personalities/names/positions) are already seeded.
    setSeed(opts.seed);
    // body factory: the browser builds visual Fighters (default); a headless
    // harness injects a logic-only HeadlessFighter so the sim runs with no
    // renderer/DOM. Everything downstream only touches the shared interface.
    // the default factory wraps the un-typed visual Fighter (../fighter.js): its real
    // `root` is a THREE.Group whose transform members the vendored stubs don't expose, so
    // the concrete class isn't structurally the shared Fighter — cast the factory to the
    // shared MakeFighter (the only surface the sim ever touches). Contained, runtime-only.
    this.makeFighter = opts.makeFighter || (((model: string, o: { isPlayer?: boolean } = {}) => new Fighter(model, o)) as unknown as MakeFighter);
    this.agents = [];
    this.agentsById = new Map();
    // PERCEPTS: hittable, perceivable PROPS with no mind (Scarecrows). Kept OUT of
    // `agents` — they have no decide/perceive/progression/memory/act, so they must
    // never enter a cognition loop. The perceive seam reads them via ctx.perceivables
    // and the blade lands on them via the `fighters` getter; both default to the bare
    // `agents` array when empty, so the default world is byte-identical (the freeze lesson).
    this.percepts = [];
    // MENTAL MAP: shared, read-only, STATIC geography (gates/POIs/landmarks) the world-
    // model reasons over. Built lazily from a snapshot (see _mentalMap); null until needed.
    this.map = null;
    this.time = 0;
    this._acc = 0;
    this._nextId = 1;
    this._names = NAMES.slice();
    this._houseEverGrew = new Set();   // houses that bore a child (a real LINE worth mourning)
    this.houseFeuds = new Set();        // durable inter-HOUSE feuds (multi-generational; see houses.js)
    this.tradesThisTick = 0;
    resetXpStats();   // XP-allocation telemetry is per-world (read by the Class Codex)
    resetEconStats(); // economics telemetry is per-world (read by the Town & Prices tab)

    // RPG event router: every ActionEvent on the bus is delivered to the actor's
    // Progression (+ autobiographical memory for salient deeds). Wired in
    // deedRouter.js; returns the unsubscribe handle.
    this._busOff = installDeedRouter(this);

    // RPG reputation ledger (player-only). playerId is set later in addPlayer().
    this.reputation = new Reputation(null);

    // emergent quest board: reads live sim state, mints fetch/hunt/recover offers
    this.quests = new QuestBoard(this);

    // the player's recruited companions (leader = this.player, set in addPlayer)
    this.party = new Party(this);

    // emergent NPC social groups (warbands/hearths/guilds/circles) — parties as an
    // AI abstraction beyond the player; forms from mutual standing + proximity.
    this.groups = new Groups(this);

    // TOWN DEFENCES: watchtowers ringing the core give the defender a real
    // home-ground advantage (fixed killing power, independent of civilian numbers)
    // — the structural floor that keeps a pressed town from spiralling to extinction.
    this.defenses = new Defenses(this);

    // FAITH: belief-powered gods (Small Gods). Power = number of believers; the
    // faithful proselytise + receive miracles. Native to the belief engine.
    this.faith = new Faith(this);

    // THE NIGHT WATCH: brave townsfolk mustered to hold the core under a rising
    // captain — an active, mortal, led defence + a civic institution to follow.
    this.watch = new Watch(this);

    // EXPEDITIONS: NPC adventuring parties that sally into the wilds and return with
    // a tale (triumph or loss) — the adventuring arc the town drama lacked.
    this.expeditions = new Expeditions(this);

    // THE PATRICIAN: a diegetic peace-keeper (Vetinari) — the counterforce to the
    // Director, brokering the worst feuds so tension is managed, not catastrophic.
    this.patrician = new Patrician(this);

    // CONSTRUCTION: the town Surveyor allocates plots + commissions a public
    // tavern; BuildSites runs the multi-tick builds (homes + the tavern) and owns
    // finished buildings as walk-through benefit POIs. Sibling of Patrician/Watch;
    // gated on a real spawned town; guarded ticks; gold-neutral (wood + labour only).
    // CITIES: one Z-levelled tile grid per town, centred on the town anchor — the
    // fabric the construction system claims plots from (replacing the Surveyor's
    // continuous lane math). Constructed BEFORE BuildSites/Surveyor so a build
    // commission can always find its town's grid. Grids are seeded in spawn() (the
    // towns don't exist yet here). Pure logic, headless-safe, fully guarded.
    this.cities = new Cities(this);
    this.buildSites = new BuildSites(this);
    this.surveyor = new Surveyor(this);

    // DIRECTOR: a light, config-driven drama nudge. Reads world-state on a slow
    // throttle and rolls weighted seed events (raids/opportunities/crises/sparks)
    // the emergent systems then propagate. Raiders spawn with zero gold (no
    // minting) and are capped (no swarm). See js/sim/director.js.
    this.director = new Director(this);

    // LINEAGE: births (stability-gated) + apprenticeship/mentorship. Renews the
    // population without aging — the other half of the population feedback loop.
    this.lineage = new Lineage(this);

    // MIGRATION: the emigration valve against multi-town population skew — a
    // truth-side census that lets a land-is-cheap rumour reach a few ears in a
    // crowded town (an Inform); the agent decides for itself (features/migrate).
    this.migration = new Migration(this);

    // CHRONICLE: the world's live drama feed. Subscribes to the shared bus (like
    // xpstats/econstats) and distils the deed firehose into NOTABLE story beats —
    // kills, vendettas, prodigies rising, fortunes — plus raids/births sampled from
    // the Director/Lineage tallies. Read-only; bounded ring; never throws on tick.
    this.chronicle = new Chronicle(this);

    // SAGAS: the emergent-arc / saga registry (docs/architecture/12 §3 — THE SPINE). A generic
    // open→escalate→close completed-arc ledger any emergent loop files through (vendettas, rescues,
    // musters, rags-to-riches), surfaced to the chronicle/Gazette. Constructed AFTER chronicle (it
    // files beats through it) and folds the Director's _recordSaga into one shared ledger. Bounded,
    // guarded, lazily swept — no heavy per-tick pass.
    this.sagas = new SagaStore(this);

    // GAZETTE + REPORTER: a roaming gazetteer interviews newsworthy townsfolk and
    // publishes a town newspaper of their emergent adventures (template prose;
    // optional LLM upgrade in the browser). Deterministic on the tick; read-only.
    this.gazette = new Gazette(this);
    this.reporter = new Reporter(this);
    // NPC bounty-hunters: townsfolk READ the Gazette's notices and race the player
    // to the posted bounties — the newspaper as a live labour market.
    this.bounties = new Bounties(this);
    // and traders who read a price report and haul to the dear market (arbitrage).
    this.arbitrage = new Arbitrage(this);

    // INTRIGUE: the dormant ToM DECEPTION layer, switched on. A config fraction of
    // camp followers become SPIES who wear a town cover identity (disguise — read
    // by perception), infiltrate the core, and PLANT FALSE RUMOURS (BeliefStore.
    // plant) into townsfolk to ignite feuds, then exfiltrate. Only BELIEFS are
    // falsified; combat (isHostile) reads true factions. Self-throttled; guarded.
    // Spies are drawn from existing camp bodies (no new spawns, no minted gold);
    // _spawnCamps() must have run first, so spy assignment is lazy (first tick).
    this.intrigue = new Intrigue(this);
  }

  // unsubscribe the bus router (call if the Simulation is ever torn down so
  // listeners don't stack and multiply XP on a fresh instance).
  dispose(): void {
    if (this._busOff) { this._busOff(); this._busOff = null; }
    if (this.quests && this.quests.dispose) this.quests.dispose();
    if (this.party && this.party.disband) this.party.disband();
    if (this.groups && this.groups.disband) this.groups.disband();
    if (this.chronicle && this.chronicle.dispose) this.chronicle.dispose();
    if (this.gazette && this.gazette.dispose) this.gazette.dispose();
    if (this.reporter && this.reporter.dispose) this.reporter.dispose();
    if (this.bounties && this.bounties.dispose) this.bounties.dispose();
    if (this.arbitrage && this.arbitrage.dispose) this.arbitrage.dispose();
    if (this.defenses && this.defenses.dispose) this.defenses.dispose();
    if (this.watch && this.watch.disband) this.watch.disband();
    if (this.expeditions && this.expeditions.disband) this.expeditions.disband();
    if (this.buildSites && this.buildSites.dispose) this.buildSites.dispose();
    if (this.surveyor && this.surveyor.dispose) this.surveyor.dispose();
    if (this.cities && this.cities.dispose) this.cities.dispose();
    this.map = null;                 // rebuilt fresh on the next world
    this.percepts.length = 0;        // drop any props so a rebuilt world starts clean
  }

  _takeName(): string {
    if (this._names.length) return this._names.splice((rng() * this._names.length) | 0, 1)[0];
    // pool exhausted (many towns + generations churn through it) — SYNTHESISE a
    // plausible given name from syllables rather than an ugly "Unit<id>" (which
    // would ride every future chronicle beat). Deterministic-safe (Math.random).
    return synthName();
  }

  spawn(opts: { townsfolkPerTown?: number } = {}): void {
    // OPEN WORLD: several dense town cores (see TOWNS). Each townsperson belongs to
    // ONE town and lives/works/defends within its home band — so the world is big
    // (wilderness + roads between towns) WITHOUT thinning any town's social drama.
    const centers: number[][] = (TOWNS && TOWNS.centers && TOWNS.centers.length) ? TOWNS.centers : [[0, 0]];
    const tr: number = (TOWNS && TOWNS.radius) || 70;
    const tnames: string[] = (TOWNS && TOWNS.names) || [];
    this.towns = centers.map((c, i): SimTown => ({ id: i, center: new THREE.Vector3(c[0], 0, c[1]), radius: tr, name: tnames[i] || `Town ${i + 1}` }));
    // CITIES: drop one CityGrid per town now that the town anchors exist — BEFORE any
    // build can commission a plot. Idempotent + guarded (never throws on a re-spawn).
    this.cities.seed();

    // a town of GENERIC townsfolk — nobody is born into a trade. Each will CHOOSE
    // what to do for a living from GOODS (Agent.chooseOccupation), so the model
    // mix (knight/barbarian) is just cosmetic variety here. They SCATTER across
    // the various resource sites (fields/forests/mines/meadows) so proximity makes
    // them lean toward DIFFERENT first trades — which keeps occupations, classes
    // and (downstream) social-group TYPES diverse instead of collapsing to one.
    const MODELS = ['knight', 'barbarian'];
    const SITES = ['field', 'forest', 'mine', 'meadow', 'market'];
    let cohort = 0;
    for (const row of ROSTER) cohort += row.n;
    // TEST-ONLY count override (guarded): the scaling test (test/scaling.mjs) passes
    // opts.townsfolkPerTown to build sims at several N and prove per-agent reasoning
    // cost stays flat as N grows. When opts is empty this is BYTE-IDENTICAL to the
    // default cohort — soak/depth/scenarios call sim.spawn() with no args and are
    // untouched. The towns/anchors/sites are unchanged; only the per-town headcount.
    const perTown = opts.townsfolkPerTown;
    if (Number.isFinite(perTown) && (perTown as number) > 0) {
      cohort = (perTown as number) | 0;
    }
    // a FULL cohort per town — the open-world point is more dense cores, NOT one
    // town spread thin (spreading the same people thins the drama — measured).
    let gi = 0;
    for (const town of this.towns) {
      for (let k = 0; k < cohort; k++, gi++) {
        const model = MODELS[(rng() * MODELS.length) | 0];
        const fighter = this.makeFighter(model, {});
        // round-robin across site KINDS (lean toward different first trades) within
        // THIS town's home band so it starts socially dense around its own market.
        const site = this.world.randomSiteNear(SITES[k % SITES.length], town.radius * 0.7, town.center);
        const base = site ? site.pos : town.center;
        const px = base.x + rand(-3, 3), pz = base.z + rand(-3, 3);
        // y is cosmetic (sim reasons in x/z) — only lift onto terrain in the browser
        // so headless distances stay flat-plane identical to before.
        const py = typeof document === 'undefined' ? 0 : terrainHeight(px, pz);
        fighter.root.position.set(px, py, pz);
        this.scene.add(fighter.root);
        const agent = new Agent(fighter, {
          id: idCfg(this._nextId++), name: this._takeName(),
          profession: null, personality: makePersonality(),
          faction: 'townsfolk', townsperson: true,
        });
        // home town: every origin-hardcoded subsystem (wander/work/defence/caravan)
        // reads these instead of assuming the world centre.
        agent.townId = town.id;
        agent.townAnchor = town.center;
        agent.townRadius = town.radius;
        assignHouse(agent, founderHouse(gi));   // each founder heads a HOUSE; children carry the surname
        this.agents.push(agent);
        this.agentsById.set(agent.id, agent);
      }
    }

    // monsters lurk where it's DANGEROUS (economic geography): each spawn samples
    // a few frontier spots and keeps the one whose region is most dangerous, so
    // threat concentrates in the Thornwilds (and spills into the Ironhills) while
    // the fertile Goldfurrows stay calm — WHERE you work is WHERE your risk is.
    for (let i = 0; i < MONSTER.count; i++) {
      const fighter = this.makeFighter(MONSTER.model, {});
      let spot = null, bestDanger = -Infinity;
      for (let t = 0; t < 4; t++) {
        const c = findBiomeSpot(BIOME.WILDS, ARENA_RADIUS * 0.74, ARENA_RADIUS * 0.96);
        if (!c) continue;
        const dg = (REGIONS_T[regionAt(c.x, c.z)] || {}).danger || 0;
        if (dg > bestDanger) { bestDanger = dg; spot = c; }
      }
      spot = spot || new THREE.Vector3(ARENA_RADIUS * 0.85, 0, -ARENA_RADIUS * 0.85);
      const sx = spot.x + rand(-3, 3), sz = spot.z + rand(-3, 3);
      const sy = typeof document === 'undefined' ? 0 : terrainHeight(sx, sz);
      fighter.root.position.set(sx, sy, sz);
      this.scene.add(fighter.root);
      const m = new Agent(fighter, {
        id: idCfg(this._nextId++), name: `${MONSTER.name} ${i + 1}`, profession: null,
        personality: makePersonality(), faction: MONSTER.faction,
        combatant: true, threat: MONSTER.threat,
      });
      // territorial: a monster lairs where it spawned and won't chase a victim
      // beyond leashR of it (frontier threats stay on the frontier — anti-massacre).
      m.homeAnchor = new THREE.Vector3(sx, 0, sz);
      m.leashR = MONSTER.leashR ?? 50;
      this.agents.push(m);
      this.agentsById.set(m.id, m);
    }

    // organized FACTION CAMPS: a bandit camp + a rival clan, each a leader plus a
    // few followers seeded at their own frontier camp (see CAMPS). They stand up
    // the multi-faction conflict (data-driven enmity via factionHostile) WITHOUT
    // instantly massacring the town — they start far from the core and escalate.
    this._spawnCamps();
    // raise the town's watchtowers (only for a real spawned town — see Defenses).
    this.defenses.build();
    // plant narrative SEEDS (rival apprentices, …) that grow into legible tropes.
    seedNarratives(this);
    // send out the gazetteer(s) — the press corps that turns the emergent drama
    // into a published town newspaper (the Gazette).
    this.reporter.spawn();
    // MENTAL MAP: snapshot the now-existing static geography (towns/gates/POIs/landmarks)
    // into the shared, read-only places registry the world-model reasons over.
    this.map = MentalMap.build(this.world, this.towns);
    // SCARECROWS (config-gated, default OFF): dress a few field props as raiders so an
    // observer mistakes them for people and may hunt/strike them — yet nothing that assumes
    // a real mind fires. Default-off keeps soak/depth baselines byte-identical.
    if (SCARECROW && SCARECROW.enabled && SCARECROW.count > 0) this._spawnScarecrows();
    // mark a REAL town as raised: the town-scale drama systems (faith, watch,
    // patrician, the director's trope engine) gate on this so they stay inert in the
    // bare controlled sub-sims that construct a Simulation but never spawn() a town.
    this._spawned = true;
  }

  // Spawn the organized camps (bandit camp + rival clan). Each camp is a LEADER
  // (tougher, holds the camp's raid orders the Director may trigger) plus a ring
  // of FOLLOWERS scattered around it. Camp combatants carry NO economy
  // (profession null) so the work/trade paths never touch unguarded state. Fully
  // self-contained: if a camp config is missing it's simply skipped. The camp's
  // leader is recorded on this.camps[key] so the Director can find + order it;
  // absence of a Director just leaves the camp lurking near its own ground.
  _spawnCamps(): void {
    this.camps = {};
    if (!CAMPS_T) return;
    for (const key in CAMPS_T) {
      const C = CAMPS_T[key];
      if (!C) continue;
      // a camp anchor on a frontier ring, away from the town core.
      const ang = rand(0, Math.PI * 2);
      const ringMin = ARENA_RADIUS * (C.ringMin ?? 0.7);
      const ringMax = ARENA_RADIUS * (C.ringMax ?? 0.9);
      const r = rand(ringMin, ringMax);
      const ax = Math.cos(ang) * r, az = Math.sin(ang) * r;
      const camp: Camp = { key, faction: C.faction, anchor: new THREE.Vector3(ax, 0, az), leader: null, members: [], raidActive: !!C.raidActive, _lastReinforce: -Infinity, _born: 0 };

      const nLeaders = C.leaders ?? 1;
      const nFollowers = C.followers ?? 0;
      for (let i = 0; i < nLeaders + nFollowers; i++) {
        // INITIAL camp bodies keep their starter purse (counted in the soak's
        // gold baseline). Reinforcements (mid-run) are gold-neutral — see below.
        this._spawnCampMember(camp, C, i < nLeaders, /*mint*/ true);
      }
      this.camps[key] = camp;
    }
  }

  // build ONE camp member at the camp anchor and register it (shared by initial
  // spawn + reinforcement). `mint=false` forces a zero purse/inventory so a body
  // added MID-RUN never adds gold to the closed loop (conservation must hold).
  _spawnCampMember(camp: Camp, C: CampCfg, isLeader: boolean, mint: boolean): AgentShape {
    const fighter = this.makeFighter(C.model || MONSTER.model, {});
    const sc = isLeader ? 0 : (C.scatter ?? 5);
    const px = camp.anchor.x + rand(-sc, sc), pz = camp.anchor.z + rand(-sc, sc);
    const py = typeof document === 'undefined' ? 0 : terrainHeight(px, pz);
    fighter.root.position.set(px, py, pz);
    this.scene.add(fighter.root);
    camp._born++;
    const name = isLeader ? (C.leaderName || `${C.name} Leader`) : `${C.name} ${camp._born}`;
    const a = new Agent(fighter, {
      id: idCfg(this._nextId++), name, profession: null,
      personality: makePersonality(), faction: C.faction,
      combatant: true, threat: isLeader ? (C.leaderThreat ?? C.threat ?? 1) : (C.threat ?? 1),
    });
    // camp affiliation: members know their home anchor so they patrol it (a frontier
    // lair, not a mob roaming the village — read by act.js wander) and so spies are
    // drawn from camp bodies (intrigue). Guarded everywhere it's consumed.
    a.campKey = camp.key;
    a.campAnchor = camp.anchor;
    a.campPatrolR = C.patrolR ?? 20;
    // territorial: won't chase a foe beyond leashR of the camp (a frontier lair).
    a.homeAnchor = camp.anchor;
    a.leashR = C.leashR ?? 50;
    if (!mint) { a.gold = 0; for (const c in a.inventory) a.inventory[c] = 0; }
    this.agents.push(a);
    this.agentsById.set(a.id, a);
    camp.members.push(a);
    if (isLeader && !camp.leader) camp.leader = a;
    return a;
  }

  // Keep the antagonist FACTIONS alive so the world stays in conflict (and intrigue
  // keeps a spy pool): each camp tops its ranks back up toward its roster size on a
  // cooldown. Reinforcements are gold-neutral (no minting). Without this the camps
  // self-annihilate early (monster↔all + bandit↔rival enmity) and the factions go
  // extinct. Called by the Director on its slow throttle; fully guarded.
  reinforceCamps(): void {
    if (!this.camps) return;
    const now = this.time;
    for (const key in this.camps) {
      const camp = this.camps[key], C: CampCfg | undefined = CAMPS_T ? CAMPS_T[key] : undefined;
      if (!camp || !C) continue;
      camp.members = camp.members.filter((m) => m && m.alive);   // drop the fallen
      const target = (C.leaders ?? 1) + (C.followers ?? 0);
      if (camp.members.length >= target) continue;
      if (now - (camp._lastReinforce || -Infinity) < (C.reinforceEvery ?? 30)) continue;
      const add = Math.min(C.reinforceMax ?? 1, target - camp.members.length);
      const needLeader = !camp.members.some((m) => m && m.alive);   // wiped out -> reseed a chief
      for (let i = 0; i < add; i++) this._spawnCampMember(camp, C, needLeader && i === 0, /*mint*/ false);
      camp._lastReinforce = now;
      if (!camp.leader || !camp.leader.alive) camp.leader = camp.members.find((m) => m && m.alive) || null;
    }
  }

  addPlayer(fighter: IFighter): AgentShape {
    const agent = new Agent(fighter, {
      id: idCfg(this._nextId++), name: 'You', profession: null,
      personality: makePersonality(), controlled: true, faction: 'outsider',
    });
    this.agents.push(agent);
    this.agentsById.set(agent.id, agent);
    this.player = agent;
    this.reputation.setPlayer(agent.id);
    return agent;
  }

  // The fighter bodies the combat resolver iterates. A Scarecrow IS its own body
  // (isHitActive/torsoCenter/takeHit) — not an Agent wrapping a .fighter — so combat-body
  // percepts are concatenated directly. A BUILDING percept (Phase 2a) is a PLACE, not a
  // combat body (no isHitActive/torsoCenter/takeHit/update), so it is EXCLUDED here — it is
  // perceivable (in _perceivables) and raid-damaged separately (construction._raidPass), but
  // the combat/fighter loop never touches it. Fast-path returns the bare agent-fighter array
  // when there are no combat-body percepts (the default world), so nothing changes shape there.
  get fighters(): Array<IFighter | Percept> {
    const f: Array<IFighter | Percept> = this.agents.map((a) => a.fighter);
    if (!this.percepts.length) return f;
    const bodies = this.percepts.filter((p) => typeof p.isHitActive === 'function' && typeof p.update === 'function');
    return bodies.length ? f.concat(bodies) : f;
  }

  // The set perception may SEE: agents + props. A percept is perceivable (truth → belief)
  // but is NOT an agent, so it is consumed ONLY by the perceive loop (never decide/act/
  // gossip/subsystems). Empty-percepts fast-path returns the bare roster reference, so the
  // default world's perceive pass is byte-identical.
  _perceivables(): Perceivable[] {
    return this.percepts.length ? (this.agents as Perceivable[]).concat(this.percepts) : this.agents;
  }

  // Register a perceivable PROP (Scarecrow) or PLACE (finished building) — the test +
  // world-spawn + construction entry point. Lives in `percepts`, never `agents`, so no
  // cognition loop ever touches a mindless body.
  spawnPercept(p: Percept): Percept { this.percepts.push(p); return p; }

  // Remove a perceivable (a gutted/ruined building) so no agent perceives a ghost at the
  // rubble — the symmetric teardown of spawnPercept. Idempotent; guarded; never throws.
  despawnPercept(p: Percept): Percept {
    try { const i = this.percepts.indexOf(p); if (i >= 0) this.percepts.splice(i, 1); } catch { /* */ }
    return p;
  }

  // Config-gated world spawn (bonus): place SCARECROW.count props per town in the
  // SCARECROW.ring annulus, dressed as SCARECROW.appearsAs. Guarded; never throws.
  _spawnScarecrows(): void {
    try {
      const [r0, r1] = SCARECROW.ring || [22, 40];
      const towns = this.towns || [];
      for (const town of towns) {
        const c = town.center;
        for (let i = 0; i < SCARECROW.count; i++) {
          const ang = rng() * Math.PI * 2;
          const r = r0 + rng() * Math.max(0, r1 - r0);
          const x = c.x + Math.cos(ang) * r;
          const z = c.z + Math.sin(ang) * r;
          this.spawnPercept(new Scarecrow({
            id: `scare-${town.id}-${i}`, x, z,
            appearsAs: SCARECROW.appearsAs, hp: SCARECROW.hp,
          }));
        }
      }
    } catch { /* never throw on world build */ }
  }

  // Lazy shared MENTAL MAP, built ONCE from a snapshot of static geography. Passes PLAIN
  // static args (world + towns) into the scan-clean MentalMap.build — mentalmap.js never
  // names sim.*. Rebuilt on spawn() (POIs/towns exist then); cleared on dispose().
  _mentalMap(): IMentalMap { return this.map || (this.map = MentalMap.build(this.world, this.towns)); }

  // FULL BRIDGE ctx: the sanctioned reality-touch + orchestration surface. Handed ONLY
  // to the allowlisted modules (perceive/gossip, onCombatEvents, the combat resolver, and
  // the subsystem ticks) — they legitimately read ground truth to WRITE beliefs / resolve
  // physics. Carries the live roster + player handle.
  // NOTE: `agents` stays the REAL roster (every subsystem + the resolver read it). The NEW
  // `perceivables` sibling carries agents+props and is consumed ONLY by the perceive loop —
  // so a 'bandit' Scarecrow never reaches surveyor/intrigue/director/the AoE scan (the seam
  // is narrow by design, not merely asserted-safe).
  _ctx(): FullCtx { return { agents: this.agents, perceivables: this._perceivables(), agentsById: this.agentsById, world: this.world, map: this._mentalMap(), time: this.time, player: this.player || null, playerId: this.player ? this.player.id : null, buildSites: this.buildSites, cities: this.cities, resolver: this._cogResolver(), arcs: this._arcPorts() }; }

  // The narrator ARC WRITE-PORTS handed to BOTH ctxs (docs/architecture/12 §3). Observer-layer,
  // write-only: a cognition-pass hook (deriveGoals/pruneGoals) can open/append/close a completed-arc
  // record without ever reading the roster. Carries NO roster handle, so the cognition ctx stays
  // clean under the epistemic scan. Built once, lazily; thin binds over sim.sagas.
  _arcPorts(): ArcPorts {
    if (this._arcPortsCache) return this._arcPortsCache;
    const s = this.sagas;
    return (this._arcPortsCache = {
      openArc: (opts) => s.openArc(opts),
      appendArcRound: (opts, text) => s.appendRound(opts, text),
      appendArcBeat: (key, tag, text) => s.appendBeat(key, tag, text),
      closeArc: (key, outcome, text) => s.closeArc(key, outcome, text),
      findArc: (key) => s.findArc(key),
    });
  }

  // LOD RELEVANCE (Phase 3 — Scale): is this agent worth full-fidelity cognition THIS tick?
  // Truth-side (lives in Simulation orchestration — reads own-state + truth, NEVER widens the
  // cognition ctx and is never called from a cognition file, so the epistemic split holds).
  // Short-circuits on the first true; the whole body is try/catch -> the safe default is
  // FULL-FIDELITY (never starve cognition on an error). Relevant if ANY of:
  //   1. in combat / fleeing (active survival goal)
  //   2. a locked pursuit (duel / avenger)
  //   3. an active special role (party / reporter / bounty / arbitrage / expedition / spy)
  //   4. carrying a derived multi-step goal stack
  //   5. a THREAT belief it would act on — uses considerHostile (the SAME predicate decide
  //      acts on), NOT raw b.hostile, so a freshly-perceived monster/raider (hostile=false but
  //      factionHostile===true, conf=1.0) promotes the agent the same tick it is perceived
  //      (perceive runs un-thinned + relevance re-checked every tick => promotion is immediate,
  //      at vision range, before the flee band)
  //   6. a recent goal-kind change (hysteresis vs. stride-edge thrash)
  //   7. near the player (player present)
  //   8. near its OWN town centre (headless fallback; monsters/raiders have no townAnchor and
  //      fall through here — caught by signal 1 when hunting, correctly thinned when idle+distant)
  _isRelevant(a: AgentShape, ctx: FullCtx): boolean {
    try {
      const g = a.goal;
      if (g && (g.kind === 'fight' || g.kind === 'flee')) return true;             // 1
      if (a._duelWith != null || a.avengerOf != null) return true;                 // 2
      if (a.inParty || a.reporter || a.bounty || a.arbitrage || a.expedition || a.spy) return true; // 3
      if (Array.isArray(a.goals) && a.goals.length > 0) return true;               // 4
      const conf = (LOD.hostileConf != null) ? LOD.hostileConf : SIM.actOnBeliefMin; // 5
      for (const b of a.beliefs.all())
        if (a.considerHostile(b) && b.confidence >= conf) return true;
      if ((ctx.time - (a._lastGoalChangeAt || 0)) < LOD.recentWindow) return true; // 6
      // legacy `.root` lives on the index tail (AgentShape declares `pos`, not `root`); the
      // original reads it directly, so cast minimally to preserve the exact runtime check.
      const pp = this.player && (this.player as { root?: { position?: THREE.Vector3 } }).root?.position; // 7
      if (pp && a.pos.distanceTo(pp) < LOD.playerRadius) return true;
      if (a.townAnchor && a.pos.distanceTo(a.townAnchor) < LOD.townCentreRadius) return true; // 8
      return false;
    } catch { return true; }   // safe default: full fidelity
  }

  // RESTRICTED COGNITION ctx: handed to a.decide(ctx) and a.act(dt, ctx). It carries NO
  // live-roster handle (no `agents`, no `agentsById`, no `player` object) — so truth is
  // STRUCTURALLY UNREACHABLE from cognition: a roster scan / lookup simply has nothing to
  // dereference. The few LEGIT cross-agent needs are met without the roster:
  //   · playerId    — a primitive id, so the fear gate reads a's OWN belief about the player
  //   · resolver    — a narrow facade exposing ONLY the sanctioned execution operations
  //                   (vision-gated perception, ability target, conserved market/transfer)
  //   · partyLeader — the controlled player-led party's leader handle, a documented game
  //                   mechanic, supplied to the follow steer-fill (resolveLeaderRef in
  //                   agent/steer.js — // EPISTEMIC-OK) only.
  // NOTE: the return type is pinned via `satisfies CognitionCtx` on the literal (below),
  // NOT an annotation on `()` — the epistemic STRUCTURAL gate (test/suites/epistemic.mjs)
  // regex-scans `_cognitionCtx() {` and asserts the literal carries no roster/player/
  // buildSites key, so the signature must stay bare. `satisfies` still gives the exact-shape
  // compile-time guarantee (excess/missing keys vs CognitionCtx are errors) without widening.
  _cognitionCtx() {
    return {
      world: this.world,
      map: this._mentalMap(),     // shared STATIC geography (places); not the roster
      time: this.time,
      // DEBT #2 RETIRED (Phase 2a): `buildSites` (a DYNAMIC build-state handle) is NO LONGER
      // on the cognition ctx. The comfort path is belief-backed (homeBelief + the static map's
      // shelter/rest Places); buildStep reaches build state through resolver.buildSite (the
      // EXECUTION facade), exactly as the market path consumes the market resolver. So a
      // cognition roster/build-state scan simply has nothing to dereference.
      cities: this.cities,
      playerId: this.player ? this.player.id : null,
      partyLeader: (this.party && this.party.leader) ? this.party.leader : null,
      resolver: this._cogResolver(),
      arcs: this._arcPorts(),       // narrator arc write-ports — observer-layer, write-only (no roster)
    } satisfies CognitionCtx;
  }

  // The cognition RESOLVER: a narrow facade the restricted ctx hands to combatStep /
  // transfers. Cognition holds only these methods — never the internal agentsById — so it
  // cannot scan or dereference arbitrary entities. Every method is vision-/conservation-
  // gated and guarded (never throws on the tick). Built once, lazily.
  _cogResolver(): ResolverFacade {
    if (this._resolver) return this._resolver;
    const sim = this;
    // A build-site's mutable progress fields — the concrete shape behind the opaque
    // SiteHandle (unknown on the facade). The truth-side BuildSites owns it; the facade
    // methods cast their handle to this internally so the public surface stays opaque.
    type SiteState = { woodNeeded: number; woodHave: number; progress: number; lastProgressAt: number; pos: PosSnapshot };
    const resolver: ResolverFacade = {
      // VISION-GATED ACTIVE PERCEPTION: if `observer` can SEE subjectId, write a fresh
      // belief (truth in → belief out, the sanctioned bridge) and return the real agent;
      // else null. Lets combatStep re-acquire a visible quarry without holding the roster.
      perceive(observer, subjectId) {
        try {
          const o = sim.agentsById.get(subjectId);
          if (!o || !o.alive || !observer) return null;
          if (observer.pos.distanceTo(o.pos) > SIM.visionRange) return null;
          observer.beliefs.observe(o.id, o.disguiseFaction || o.faction, o.pos, sim.time, true);
          return o;
        } catch { return null; }
      },
      // ABILITY EXECUTION bridge: cast `spec` from `caster`, resolving area/range targets
      // over the TRUE roster INSIDE the sim (the interpreter is geometric execution, like
      // the combat resolver) — cognition never holds the roster it scans. Returns whether
      // the spec fired. Guarded; never throws on the tick.
      cast(spec, caster) {
        try { return castSpec(spec, caster, sim._ctx()); } catch { return false; }
      },
      // The real Agent for ability casting — ONLY when vision-confirmed alive (a spec
      // resolves on a real body). A belief about a non-agent (a scarecrow) returns null.
      castTarget(observer, subjectId) {
        try {
          const o = sim.agentsById.get(subjectId);
          if (!o || !o.alive || !observer) return null;
          if (observer.pos.distanceTo(o.pos) > SIM.visionRange) return null;
          return o;
        } catch { return null; }
      },
      // BOUNTY/COMPANION target acquisition: the nearest VISIBLE live agent of `faction`
      // hostile-eligible to `observer`. Returns a belief-style ref { id, pos } (a snapshot,
      // not the live object) or null — the execution layer performs the scan so cognition
      // never holds the roster. Vision-gated (only what the observer can actually see).
      nearestVisibleOfFaction(observer, faction) {
        try {
          let best = null, bd = Infinity;
          for (const o of sim.agents) {
            if (!o.alive || o.controlled || o.faction !== faction) continue;
            const d = observer.pos.distanceTo(o.pos);
            if (d <= SIM.visionRange && d < bd) { bd = d; best = o; }
          }
          return best ? { id: best.id, pos: { x: best.pos.x, y: best.pos.y, z: best.pos.z } } : null;
        } catch { return null; }
      },
      // COMPANION leader-fight: the nearest live agent (within vision of the leader) that
      // is faction-hostile to `observer` and not in a party — so a band converges on the
      // leader's fight. Returns { id, pos } or null. Execution-side scan; vision-gated.
      enemyNearLeader(observer, leader) {
        try {
          if (!leader || !leader.alive) return null;
          let best = null, bd = SIM.visionRange * SIM.visionRange;
          for (const o of sim.agents) {
            if (o === observer || o === leader || !o.alive || o.controlled || o.inParty) continue;
            if (!factionHostile(observer.faction, o.faction)) continue;
            const d = leader.pos.distanceToSquared(o.pos);
            if (d < bd) { bd = d; best = o; }
          }
          return best ? { id: best.id, pos: { x: best.pos.x, y: best.pos.y, z: best.pos.z } } : null;
        } catch { return null; }
      },
      // WARBAND strength (recruiter capstone): the leader's OWN believed force — its base plus each
      // living follower banded to it. Execution-side roster scan (the leader knowing its own band is
      // own-state, mediated here exactly like enemyNearLeader returns a ref). Lets a mustered leader
      // decide it is strong enough to MARCH on the believed foe. Returns a number; guarded.
      warbandStrength(leader) {
        try {
          if (!leader || !leader.alive) return 0;
          let n = 0;
          for (const o of sim.agents) if (o.alive && o.bandLeaderId === leader.id) n++;
          return (RECRUIT.selfStrength || 1) + n * (RECRUIT.candidateStrength || 1);
        } catch { return 0; }
      },
      // Live world position of subjectId — ONLY when vision-confirmed (used by the player's
      // controlled `approach`/`fight` execution, which legitimately tracks a seen target).
      // Returns a {x,y,z} snapshot or null. Cognition never gets the live object.
      seenPos(observer, subjectId) {
        try {
          const o = sim.agentsById.get(subjectId);
          if (!o || !o.alive || !observer) return null;
          if (observer.pos.distanceTo(o.pos) > SIM.visionRange) return null;
          return { x: o.pos.x, y: o.pos.y, z: o.pos.z, alive: true };
        } catch { return null; }
      },
      // Is subjectId a real, currently-alive agent? A belief-erasing convenience for the
      // duel/avenger locks — answers liveness WITHOUT exposing the object. Guarded.
      isLiveAgent(subjectId) {
        try { const o = sim.agentsById.get(subjectId); return !!(o && o.alive); }
        catch { return false; }
      },
      // CONSERVED MARKET CLEAR: clear ONE unit of `good` for `a` against a willing
      // counterparty at the market POI (the execution clearing house). buying=true → a
      // buys; else a sells. Belief-priced at the midpoint. Returns true on a settled deal.
      // a never reads cp.gold/pos/priceBeliefs — the resolver does, inside the sim.
      marketClear(a, good, buying) {
        try {
          const m = sim.world && sim.world.nearest(POI_KIND.MARKET, a.pos);
          if (!m) return false;
          if (a.pos.distanceTo(m.pos) > SIM.talkRange) return false;
          let cp = null;
          for (const o of sim.agents) {
            if (o === a || !o.alive || o.controlled || o.faction === 'monster') continue;
            if (o.pos.distanceTo(m.pos) > SIM.talkRange) continue;
            if (buying ? o.sellQty(good) > 0 : (o.wantQty(good) > 0 && o.gold >= 1)) { cp = o; break; }
          }
          if (!cp) return false;
          const price = +(((a.priceBeliefs[good] || 1) + (cp.priceBeliefs[good] || 1)) / 2).toFixed(2);
          if (buying) {
            if (a.gold < price) return false;
            a.applyBuy(good, price); cp.applySell(good, price);
            foldLoss(a, 'spent', price, sim.time);   // signal: a VOLUNTARY outflow (not ruin)
            foldScarcity(sim, good, price, sim.time); // §13 D.scarcity: the clearing price vs its long-run mean
          } else {
            if (a.surplus(good) < 1 || cp.gold < price) return false;
            a.applySell(good, price); cp.applyBuy(good, price);
          }
          return true;
        } catch { return false; }
      },
      // CONSERVED TRANSFER: move item×n OR gold from `from` to the agent `toId`, ONLY when
      // they are co-located (at reach). Fires the RECEIVER's own succour/standing hook via
      // ITS store. Returns true on a landed transfer. The giver never touches to.* — the
      // resolver performs the move inside the sim. Closed money loop (no minting).
      deliverTo(from, toId, payload) {
        try {
          const to = sim.agentsById.get(toId);
          if (!to || !to.alive || !from) return false;
          if (from.pos.distanceTo(to.pos) > (PLAN.reachRange || 2.2) + 0.5) return false;
          const item = payload.item, n = payload.n || 1, gold = payload.gold || 0;
          if (item) {
            if ((from.inventory[item] || 0) < n) return false;
            sim.recordSuccoured(to, from.id, 1);    // receiver records succour (its own memory)
            from.inventory[item] -= n;
            to.inventory[item] = (to.inventory[item] || 0) + n;
          } else if (gold) {
            if ((from.gold || 0) < gold) return false;
            sim.recordSuccoured(to, from.id, 1);
            from.gold -= gold;
            to.gold = (to.gold || 0) + gold;
            foldLoss(from, 'gifted', gold, sim.time);   // signal: a VOLUNTARY outflow (a gift/payment)
            foldDeed(from, 'gift', sim.time);            // §13 E.deedLedger
          } else return false;
          // receiver warms toward the giver via ITS OWN belief store.
          if (to.beliefs) { const rel = to.beliefs.get(from.id); if (rel) rel.standing = Math.min(1, rel.standing + 0.15); }
          return true;
        } catch { return false; }
      },
      // THE PUBLIC LARDER (granary draw): move ONE meal from the town granary's civic stock to
      // `a` — co-location-gated like deliverTo, so the body must actually stand at the larder.
      // The stock was tithed IN KIND off market food clears (market.ts), so no gold moves and
      // nothing is minted; the draw only relocates food the economy already produced. The first
      // meal a granary serves files a chronicle beat (legibility). Returns true on a served
      // meal — false (empty/far/none built) lets the act arm stamp the agent's own bare-larder
      // memory so its next decide falls back to begging. Guarded; never throws on the tick.
      // THE PLACE'S TRUE BENEFIT where the agent actually stands (colocation-gated, like
      // granaryDraw): the standing building under/beside the agent reports its benefit +
      // kind, or null in the open. Execution-side ground truth — act.ts scales the comfort
      // restore by it, and the agent LEARNS the felt quality onto its OWN place-belief
      // (experience is the sanctioned truth→belief bridge). A razed building confers nothing.
      placeBenefitAt(a) {
        try {
          if (!a || !a.alive || !sim.buildSites || !sim.buildSites._buildings) return null;
          let best = null, bestD = Infinity;
          for (const b of sim.buildSites._buildings) {
            if (!b || b.sheltered === false || !b.pos) continue;
            const fp = b.footprint || {};
            const reach = Math.max(fp.w || 3, fp.d || 3) / 2 + 2.2;
            const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
            const d2 = dx * dx + dz * dz;
            if (d2 <= reach * reach && d2 < bestD) { bestD = d2; best = b; }
          }
          if (!best) return null;
          const ben = best.benefit || {};
          return {
            comfort: ben.comfort ?? 1, social: ben.social ?? 0, kind: best.buildKind || 'building',
            // home-banking reads these: standing in MY OWN home, over a CELLAR (the strongbox).
            mine: best.ownerId != null && best.ownerId === a.id,
            cellar: !!best.cellar,
          };
        } catch { return null; }
      },
      granaryDraw(a) {
        try {
          if (!a || !a.alive || !sim.buildSites) return false;
          const g = sim.buildSites.nearest(BUILD_KIND.GRANARY, a.pos);
          if (!g || !g.pos) return false;
          const r = GRANARY.drawRange || 3.4;
          const dx = g.pos.x - a.pos.x, dz = g.pos.z - a.pos.z;
          if (dx * dx + dz * dz > r * r) return false;            // not at the larder
          const meal = GRANARY.drawMeal || 1;
          if ((g.stock || 0) < meal) return false;                // the larder is bare
          g.stock -= meal;
          a.inventory.food = (a.inventory.food || 0) + meal;
          sim.buildSites.stats.granaryMeals = (sim.buildSites.stats.granaryMeals || 0) + 1;
          if (!g._fedOnce) {
            g._fedOnce = true;
            try {
              if (sim.chronicle) sim.chronicle.note('build', a.id,
                `The granary fed its first hungry soul — ${a.name || 'a pauper'} ate from the public larder.`);
            } catch { /* chronicle is best-effort flavour */ }
          }
          return true;
        } catch { return false; }
      },
      // SOLICIT ALMS (the Inform pattern, like the recruiter's offers): carry a beggar's plea to
      // every townsperson within earshot by writing into THEIR perceivable `_pleas` mailbox
      // (bounded; oldest dropped). Each bystander DECIDES for itself in cognition (features/alms
      // deriver: own altruism/kin/surplus) — this only delivers the percept, never a reaction.
      solicitAlms(beggar) {
        try {
          if (!beggar || !beggar.alive) return 0;
          let heard = 0;
          const r2 = (ALMS.almsRange || 9) ** 2;
          for (const o of sim.agents) {
            if (o === beggar || !o.alive || o.controlled || o.faction !== 'townsfolk' || !o.autonomous) continue;
            if (o.pos.distanceToSquared(beggar.pos) > r2) continue;
            // HEARING THE PLEA IS PERCEIVING THE BEGGAR: refresh the listener's belief via the
            // same truth→belief bridge perception uses. Without this the bounded ToM table
            // (SIM.beliefsPerAgent) evicts an unremarkable pauper within ticks at a crowded
            // market, and the donor's repay plan finds no believedPos — you cannot give alms
            // to someone you can't keep in mind. Re-solicited every few seconds, the belief
            // stays alive exactly as long as the begging does.
            try { if (o.beliefs && o.beliefs.observe) o.beliefs.observe(beggar.id, beggar.faction, beggar.pos, sim.time, false); } catch { /* never throw */ }
            const box = (o._pleas || (o._pleas = []));
            const dup = box.find((p) => p.fromId === beggar.id);
            if (dup) { dup.t = sim.time; heard++; continue; }       // refresh, don't multiply
            box.push({ fromId: beggar.id, t: sim.time });
            while (box.length > (ALMS.pleaCap || 4)) box.shift();
            heard++;
          }
          return heard;
        } catch { return 0; }
      },
      // CONSERVED TAKE (docs/architecture/10) — the GENERIC "moved" acquire mechanic: move value
      // from a source to the taker `a`, debiting the source as it credits the taker (no minting).
      // That is ALL it does. It is one operation behind loot / burgle / rob / take — they differ
      // only in the SOURCE and the SOCIAL TRACE, which are the acquire row's DATA, not code here.
      // It bakes in NO reaction: who thinks worse of the taker is a CONSEQUENCE that emerges from
      // perception (witnessDeed), the same way combat outcomes fold back, not a constant stamped on
      // one victim. The caller gates location (at the stash / on the mark / at the corpse). Returns
      // the amount actually taken (gold) or units moved (item). Guarded; never throws.
      take(a, sourceId, payload) {
        try {
          const src = sim.agentsById.get(sourceId);
          if (!src || !a) return 0;
          const gold = payload.gold || 0, item = payload.item, n = payload.n || 1;
          if (gold) {
            const got = Math.min(Math.max(0, gold), src.gold || 0);
            if (got <= 0) return 0;
            src.gold -= got; a.gold = (a.gold || 0) + got;
            foldLoss(src, 'robbed', got, sim.time);   // signal: an INVOLUNTARY loss (the RUIN cause)
            return got;
          }
          if (item) {
            const got = Math.min(Math.max(0, n), src.inventory[item] || 0);
            if (got <= 0) return 0;
            src.inventory[item] -= got; a.inventory[item] = (a.inventory[item] || 0) + got;
            return got;
          }
          return 0;
        } catch { return 0; }
      },
      // WITNESSED DEED → BELIEFS (docs/architecture/10) — the EMERGENT consequence, mirroring
      // onCombatEvents' fold. A wrong by `actor` against `victimId` (theft/robbery/sabotage, named
      // by `kind`) folds into the beliefs of the victim AND every bystander who can SEE the actor —
      // each through ITS OWN belief store, scaled by ITS OWN view (the victim reacts harder than a
      // stranger; a wronged friend harder still). The reaction is the PERCEIVER's, not a constant on
      // one designated victim, and it is WITNESS-GATED (a theft no one sees breeds no suspicion).
      // Also publishes the deed on the shared bus so it feeds the actor's emergent class (a thief
      // builds toward a rogue). `severity` scales the souring. Guarded; never throws on the tick.
      witnessDeed(actor, victimId, kind, severity = 0.4) {
        try {
          if (!actor) return;
          const sev = Math.max(0, Math.min(1, severity));
          const victim = victimId != null ? sim.agentsById.get(victimId) : null;
          // the victim, if it can see the actor, sours + grows suspicious (its own belief), weighted
          // by how much it already valued them (a betrayal by a friend cuts deeper).
          if (victim && victim.alive && !victim.controlled && victim.beliefs && victim.pos.distanceTo(actor.pos) <= SIM.visionRange) {
            const rel = victim.beliefs.get(actor.id) || victim.beliefs.observe(actor.id, actor.faction, actor.pos, sim.time, false);
            if (rel) {
              const betrayal = 1 + Math.max(0, rel.standing || 0);     // valued-then-wronged stings more
              rel.standing = Math.max(-1, (rel.standing || 0) - sev * betrayal);
              rel.suspicion = Math.min(1, (rel.suspicion || 0) + sev);
            }
          }
          foldDeed(actor, kind === 'rob' ? 'theft' : kind, sim.time);   // §13 E.deedLedger (truth side of witnessDeed)
          // §13 F.witnessSet — key this dramatic event (actor:kind:second) so the casting probe can read
          // WHO saw it (the confidant, the lone witness). A short-retention ring; witnesses noted below.
          const deedKey = actor.id + ':' + kind + ':' + Math.floor(sim.time);
          if (victim && victim.alive && !victim.controlled && victim.pos.distanceTo(actor.pos) <= SIM.visionRange) noteWitness(sim, deedKey, victim.id, sim.time);
          // bystanders who see it: most grow suspicious — but a DESPERATE witness admires a robber of
          // the RICH (the Robin Hood mirror, docs/architecture/12 §9.2). FOUR conjuncts (review 5):
          // larcenous/bold AND poor AND NOT allied to the victim AND believes the victim wealthy.
          // Drop any one and it warms a witness whose friend was robbed, or a robbery of a fellow
          // pauper — the wrong story. Per-perceiver, belief-only; the positive mirror of the souring.
          for (const w of sim.agents) {
            if (w === actor || w === victim || !w.alive || w.controlled) continue;
            if (w.pos.distanceTo(actor.pos) > SIM.visionRange) continue;
            const wb = w.beliefs.get(actor.id) || w.beliefs.observe(actor.id, actor.faction, actor.pos, sim.time, false);
            if (!wb) continue;
            noteWitness(sim, deedKey, w.id, sim.time);   // §13 F.witnessSet — a bystander who saw the deed
            const P = w.personality || {};
            const vb = victimId != null ? w.beliefs.get(victimId) : null;
            const admires = kind === 'rob' &&
              (P.risk_tolerance || 0) >= OUTLAW.warmRisk && (P.altruism ?? 0.5) <= OUTLAW.warmAltru &&  // larcenous/bold
              (w.gold || 0) <= OUTLAW.warmPoorGold &&                                                    // poor
              (!vb || (vb.standing || 0) <= OUTLAW.warmAllyBar) &&                                       // not allied to the victim
              (!!vb && (vb.believedWealth || 0) >= OUTLAW.warmVictimWealth);                             // robs the rich (§6)
            if (admires) wb.standing = Math.min(1, (wb.standing || 0) + sev * OUTLAW.warmth);
            else wb.suspicion = Math.min(1, (wb.suspicion || 0) + sev * 0.5);
          }
          // OUTLAW ARC (docs/architecture/12 §3.5): a robbery the town witnessed is an escalation round
          // on the actor's infamy arc (opened by statusSensor when notoriety crosses dreadAt).
          if (kind === 'rob') { try { if (sim.sagas && sim.sagas.findArc('outlaw:' + actor.id)) sim.sagas.appendBeat('outlaw:' + actor.id, 'round', `${actor.name} struck again.`); } catch { /* never throw */ } }
          // the deed feeds the RPG progression (the actor's emergent class) via the shared bus.
          busEmit({ actorId: actor.id, verb: kind, tags: ['THEFT', 'RISK'], targetId: victimId ?? undefined, magnitude: sev, t: sim.time });
          // docs/architecture/17 §6: ALSO emit the public DEED envelope for the ToM inference path. The
          // hardcoded per-perceiver fold above stays authoritative until P4 swaps it; this is additive
          // plumbing (the inbox handler is a no-op stub in P3). A theft-shaped deed drives the `take`
          // primitive, presenting its true surface tag (theft/robbery); cues filled in P4.
          this.publishDeed({
            actorId: actor.id, primitive: 'take', targetId: victimId ?? undefined,
            surfaceTag: kind === 'rob' ? 'robbery' : 'theft', sceneCues: {}, magnitude: sev, t: sim.time,
          });
        } catch { /* never throw on the tick */ }
      },
      // PUBLISH A DEED (docs/architecture/17 §6) — drop the public envelope into the inbox of every
      // agent whose perception covers the act site (vision-gated; execution layer, so the roster scan
      // is sanctioned — the INFERENCE that follows reads only the observer's own beliefs). Bounded
      // inbox; drained each perceive pass by motivation/infer.ts. Guarded; never throws on the tick.
      publishDeed(deed) {
        try {
          if (!deed || deed.actorId == null) return;
          const actor = sim.agentsById.get(deed.actorId);
          if (!actor) return;
          for (const w of sim.agents) {
            if (w === actor || !w.alive || w.controlled) continue;
            if (w.pos.distanceTo(actor.pos) > SIM.visionRange) continue;
            const inbox = w.perceivedDeeds || (w.perceivedDeeds = []);
            inbox.push(deed);
            if (inbox.length > 16) inbox.shift();   // bounded — the oldest unprocessed deed drops
          }
        } catch { /* never throw on the tick */ }
      },
      // SAY (docs/architecture/17 §8.1) — the speech-act primitive: assert an opinion about a subject
      // into the nearby audience. EFFECT (execution, belief-only, per-perceiver): nudge each listener's
      // OWN standing toward the subject by the remark's valence (a planted opinion — like a milder,
      // legitimate rumour; the subject itself is never lectured about itself). Then publish the public
      // `say` DEED so listeners INFER the speaker's motive (warn/slander/vouch — motives/speech.ts).
      // `surfaceTag` is the speaker's PRESENTED cover (honest default; a deceiver overrides — P6).
      // Conserved (belief only, mints nothing); co-location-gated; guarded; never throws on the tick.
      say(speaker, subjectId, valence, opts = {}) {
        try {
          if (!speaker || subjectId == null) return;
          const range = opts.range || SIM.visionRange;
          const v = valence < 0 ? -1 : 1;
          const weight = opts.weight ?? 0.05;
          for (const w of sim.agents) {
            if (w === speaker || !w.alive || w.controlled || w.id === subjectId) continue;
            if (w.pos.distanceTo(speaker.pos) > range) continue;
            const b = w.beliefs.get(subjectId);
            if (b) b.standing = Math.max(-1, Math.min(1, (b.standing || 0) + v * weight));
          }
          this.publishDeed({
            actorId: speaker.id, primitive: 'say', targetId: subjectId,
            surfaceTag: opts.surfaceTag || (v < 0 ? 'counsel' : 'endorsement'),
            sceneCues: { valence: v }, magnitude: Math.min(1, Math.abs(valence)), t: sim.time,
          });
        } catch { /* never throw on the tick */ }
      },
      // PHYSICAL AFFECT (docs/architecture/10) — apply a believed physical-state change to another
      // entity (the Affect rows beyond strike→dead): 'freed' cuts a captive's bonds, 'wrecked'
      // sabotages a target. The PHYSICAL effect only — like combat resolving health; any REACTION
      // (a freed captive's gratitude, an owner's anger) EMERGES from perception, not here. The
      // caller gates location. `_freedBy` lets the freed agent's own logic respond. Returns true on
      // a landed change. Guarded; minimal until richer captivity/structure mechanics land.
      affect(actor, targetId, state) {
        try {
          const t = sim.agentsById.get(targetId);
          if (!t || !actor) return false;
          if (state === 'freed') { t._held = false; t._freedBy = actor.id; return true; }
          if (state === 'wrecked') { t._wrecked = true; return true; }
          return false;
        } catch { return false; }
      },
      // RECRUIT OFFER (docs/architecture/10 §12) — plant an offer the candidate PERCEIVES, the
      // Inform half of recruiting. It writes only the candidate's own `_offers` (a perception),
      // NEVER a goal into it — the candidate weighs the offer and decides for itself. The leader's
      // own prediction (Believes-it-will-follow) is recorded leader-side via recordBelieves. Guarded.
      makeOffer(leader, candidateId, payoff) {
        try {
          const c = sim.agentsById.get(candidateId);
          if (!c || !c.alive || !leader) return false;
          if (!c._offers) c._offers = {};
          c._offers[leader.id] = { from: leader.id, payoff: payoff || 0, t: sim.time };
          return true;
        } catch { return false; }
      },
      // TEACH A RECIPE (graded recipes, docs/architecture/10-lld §6, §19 gap #1) — the conserved
      // tuition transfer. Find a co-located TEACHER (a living agent near the student that already
      // holds the recipe) and move the student's tuition (KNOW.studyTuition) into the teacher's
      // purse — gold moves, never minted (the closed loop). Returns true when a teacher taught, so
      // the study executor only accrues learning against a real instructor (no free lunch). The
      // roster scan is execution (ground truth, legitimately read here, never in cognition). Guarded.
      teachRecipe(student, good) {
        try {
          if (!student || !good) return false;
          let teacher = null;
          for (const t of sim.agents) {
            if (t === student || !t.alive) continue;
            if (!(t.recipes && t.recipes.has(good))) continue;        // must actually know the craft
            if (t.pos.distanceTo(student.pos) > SIM.visionRange) continue;   // co-located (both at the market)
            teacher = t; break;
          }
          if (!teacher) return false;                                 // no instructor present ⇒ no taught session
          const fee = KNOW.studyTuition || 0;
          if (fee > 0 && (student.gold || 0) >= fee) {                // conserved: student → teacher
            student.gold -= fee; teacher.gold = (teacher.gold || 0) + fee;
          }
          return true;
        } catch { return false; }
      },
      // WARBAND JOIN (recruiter follow-through, docs/architecture/10-lld §19 item 4) — the
      // EXECUTION half of forming a recruited NPC band. The follower already DECIDED to join in
      // cognition (recruiter.ts' deriver, off its OWN _offers/standing/personality); this flips the
      // band flags through the SHARED Groups machinery (the very path the player's Party uses), so
      // there is no parallel system and no foreign-mind write (the candidate asked to join itself).
      // Bounded by `cap`; fully guarded (never throws on the tick). Returns whether it joined.
      joinBand(follower, leaderId, cap) {
        try {
          return sim.groups ? sim.groups.joinWarband(follower, leaderId, cap) : false;
        } catch { return false; }
      },
      // MIGRATION SETTLEMENT (the emigration valve) — the EXECUTION half of a migrant's
      // arrival. The agent DECIDED to relocate in cognition (its own perceived land-is-cheap
      // prospect + its own poverty/houselessness/personality — features/migrate.ts) and
      // WALKED the journey; this flips its citizenship (townId/townAnchor/townRadius) to the
      // town it now stands in, re-anchoring wander/work/defence there. Truth-side town
      // lookup; the chronicle notes the move (the Gazette's material). No gold moves, no
      // foreign mind is written. Guarded; returns whether it settled.
      relocate(a, townId) {
        try {
          const towns = sim.towns || [];
          const town = towns[townId];
          if (!a || !a.alive || !town || a.townId === townId) return false;
          const from = (a.townId != null && towns[a.townId]) ? towns[a.townId].name : 'their old town';
          a.townId = town.id;
          a.townAnchor = town.center;
          a.townRadius = town.radius;
          a.wanderTarget = null;        // re-anchor the roam band to the new home immediately
          try {
            if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('migration', a.id,
              `${a.name} left ${from} for ${town.name}, where land is cheap.`);
          } catch { /* chronicle is best-effort flavour */ }
          return true;
        } catch { return false; }
      },
      // BUILD-STATE EXECUTION FACADE (Phase 2a, debt #2 retirement): the truth-side build
      // state (BuildSites), exposed as a narrow set of execution operations — exactly like
      // the market resolver. `buildStep` runs in act() (execution), which legitimately reads
      // ground truth, but it must NOT name `ctx.buildSites` (a dynamic-state handle banned on
      // the cognition ctx). It reaches build state ONLY through this facade. Every method is
      // guarded; returns null/0 on any fault (never throws on the tick).
      buildSite: {
        // resolve-or-commission the agent's committed site; returns an OPAQUE site handle or null.
        resolve(agent, ctx) {
          try {
            const bs = sim.buildSites; if (!bs) return null;
            let site = (agent._buildSiteId != null) ? bs.siteById(agent._buildSiteId) : null;
            if (!site) { site = bs.commission(agent, ctx); if (!site) { agent._buildSiteId = null; return null; } }
            return site;
          } catch { return null; }
        },
        // wood still owed to a site handle (drives the fell-wood branch).
        woodOwed(handle) { try { const h = handle as SiteState | null; return h ? Math.max(0, h.woodNeeded - h.woodHave) : 0; } catch { return 0; } },
        // contribute up to `units` of the agent's carried wood into the site (a pure commodity
        // transfer — closed money loop). Mutates inv.wood + site.woodHave; returns units moved.
        feedWood(agent, handle, units) {
          try {
            const h = handle as SiteState | null;
            if (!h || !agent) return 0;
            const inv = agent.inventory || (agent.inventory = {});
            let moved = 0, want = Math.min(units || 0, h.woodNeeded - h.woodHave, inv.wood || 0);
            while (want > 0 && (inv.wood || 0) > 0 && h.woodHave < h.woodNeeded) {
              inv.wood -= 1; h.woodHave += 1; moved += 1; want -= 1;
            }
            return moved;
          } catch { return 0; }
        },
        // advance progress capped by woodHave/woodNeeded; returns the advance delta (>=0).
        advance(handle, dtSeconds, ctx) {
          try {
            const h = handle as SiteState | null;
            if (!h) return 0;
            const woodCap = h.woodHave / (h.woodNeeded || 1);
            const next = Math.min(woodCap, h.progress + BUILD.progressPerSec * (dtSeconds || 0));
            if (next <= h.progress) return 0;
            const adv = next - h.progress;
            h.progress = next; h.lastProgressAt = (ctx && ctx.time) || h.lastProgressAt;
            return adv;
          } catch { return 0; }
        },
        pos(handle) { try { const h = handle as SiteState | null; return h ? h.pos : null; } catch { return null; } },
        // nearest forest POI to the agent (the fell-wood destination) — execution geography,
        // routed through the facade so buildStep names neither ctx.buildSites NOR ctx.world.
        nearestWood(agent) {
          try { const f = sim.world && sim.world.nearest(POI_KIND.FOREST, agent.pos); return f ? f.pos : null; } catch { return null; }
        },
      },
    };
    this._resolver = resolver;
    return resolver;
  }

  update(dt: number): void {
    this.time += dt;
    this.world.update(dt);
    // DEATH SWEEP: catch agents that died WITHOUT a melee combat event — a ranged/instant
    // ABILITY kill (interpreter applies damage directly, no resolveCombat 'dead' event), a
    // watchtower bolt, etc. — and route their death through the SAME belief/_slain bridge
    // (resolveDeath) the melee path uses, so an out-of-sight avenger's vendetta still closes
    // and witnesses still learn the death however the killing blow was delivered. Idempotent
    // (each id processed once via _deathSeen). Guarded; never throws on the tick.
    this._sweepDeaths();
    const ctx = this._ctx();                  // FULL bridge ctx (perceive/gossip/subsystems/resolver)
    const cog = this._cognitionCtx();         // RESTRICTED cognition ctx (decide/act): no live roster

    for (const a of this.agents) {
      // setLabelVisible is a visual-decor method on the Agent class, not on the shared
      // AgentShape surface (it rides the index tail as `unknown`) — narrow to call it.
      if (!a.alive) { (a.setLabelVisible as (v: boolean) => void)(false); continue; }
      if (a.autonomous) a.drainNeeds(dt);
    }

    this._acc += dt;
    const step = 1 / SIM.tickHz;
    let guard = 4;
    while (this._acc >= step && guard-- > 0) {
      this._acc -= step;
      // LOD SCHEDULING (Phase 3 — Scale): reset the per-tick reasoning-cost counters for
      // EVERY living agent (so a thinned agent reads 0 on its skipped tick — the metric
      // MEASURES the win), then decide who is DUE for the SLOW deliberative passes this
      // tick. Relevant agents are always due (and reset their stride phase); the distant/
      // idle tail is due only every LOD.stride-th tick. Small worlds (N<=fullFidelityBelow)
      // run everyone full-fidelity. Gate is truth-side (Simulation orchestration).
      const lodOn = LOD.enabled && this.agents.length > LOD.fullFidelityBelow;
      for (const a of this.agents) {
        if (!a.alive) continue;
        a._decideCalls = 0; a._decideCands = 0; a._planReplans = 0; a._schemaFireCount = 0;
        a._lodDue = true;
        if (lodOn) {
          a._lodTick = (a._lodTick + 1) | 0;
          if (this._isRelevant(a, ctx)) { a._lodTick = 0; }           // relevant => always due
          else { a._lodDue = (a._lodTick % LOD.stride) === 0; }       // thinned => every Kth tick
        }
      }
      // Theory-of-Mind passes: perceive -> decay -> gossip -> decide (decisions
      // read beliefs, never ground truth). perceive/gossip run EVERY tick
      // (un-thinned): no blind window on a threat, and gossip/group-formation
      // stays cheap + correct regardless of decide cadence.
      for (const a of this.agents) a.perceive(ctx);
      // BELIEF DECAY, STRIDE-AMORTIZED: every fade in decay() is LINEAR in dt (conf -= rate*dt),
      // so decaying each agent every Kth tick with K×step is EXACTLY equivalent in total fade
      // while cutting the every-agent full-table walk to 1/K — what lets the ToM table afford
      // SIM.beliefsPerAgent=50 (the scaling gate failed the 4× table at a per-tick walk). The
      // phase offset (i % K) spreads the walks evenly across ticks; beliefs still fade on
      // schedule to within one stride window (~0.8s at 5 Hz).
      {
        const K = SIM.beliefDecayStride || 4;
        this._decayPhase = (((this._decayPhase as number) || 0) + 1) % K;
        // keyed on the STABLE agent id, never the array index — the reaper splices the roster,
        // and an index-keyed stride would reshuffle every agent's slot on each splice (some
        // decaying twice a window, others skipped for stretches: uneven staleness that measurably
        // cascaded into worse survival decisions). An id keeps each agent's cadence fixed for life.
        for (const a of this.agents)
          if (((typeof a.id === 'number' ? a.id : 0) % K) === this._decayPhase) a.beliefs.decay(step * K);
      }
      for (const a of this.agents) a.gossipBeliefs(ctx);
      // REASONING pass (Phase 2a): the InteractionSchema interpreter evaluates the
      // catalogue per agent over the RESTRICTED cognition ctx (beliefs + own state +
      // static map, never the roster), writing cached beliefs + adopting goals BEFORE
      // decide arbitrates them the same tick. Empty catalogue ⇒ early return ⇒ no-op.
      // AMORTIZED: only DUE agents reason/decide this tick (plan() rides along inside
      // decide's needPlan branch). act(dt)/movement stay every frame (below the loop).
      for (const a of this.agents) { if (a._lodDue) reason(a, cog, SCHEMA_CATALOGUE); }
      for (const a of this.agents) { if (a._lodDue) a.decide(cog); }   // cognition: beliefs + resolver only
      this._runMarket();
      // RPG: behavior-profile decay + class matching on the same fixed-rate tick.
      for (const a of this.agents) a.progression.tick(this.time);
      // episodic memory consolidation (STM -> MTM -> LTM); self-throttled.
      for (const a of this.agents) a.memory.tick(step, this.time);
      // quest board: synth offers (throttled internally) + detect completions.
      // Guarded: board is a no-op when there are no townsfolk / no player yet.
      this.quests.refresh(step);
      this.quests.tick();
      // emergent NPC social groups form/dissolve on the same fixed cadence
      this.groups.tick(ctx, step);
      // town watchtowers fire on town-hostile bodies near the core (home-ground).
      this.defenses.tick(ctx, step);
      // faith: gods gain/lose believers + work miracles (belief-powered Small Gods).
      this.faith.tick(ctx, step);
      // the Night Watch: muster/stand-down civic guards to hold the core.
      this.watch.tick(ctx, step);
      // adventuring parties: muster/steer/resolve expeditions into the wilds.
      this.expeditions.tick(ctx, step);
      // the Patrician: broker the worst feud so managed tension never boils over.
      this.patrician.tick(ctx, step);
      // CONSTRUCTION: survey plots + commission the public tavern, then advance/
      // finish build sites. Surveyor before BuildSites so a freshly-commissioned
      // tavern can begin advancing the same tick. Self-throttled + fully guarded —
      // never throws/stalls the tick (the freeze lesson).
      // CITIES: emergent founding only (bounded, guarded, OFF by default) — runs
      // before surveyor/buildSites so a freshly-founded town has a grid this tick.
      this.cities.tick(ctx, step);
      this.surveyor.tick(ctx, step);
      this.buildSites.tick(ctx, step);
      // INTRIGUE: spies infiltrate + plant false rumours (the ToM deception).
      // Self-throttled, fully guarded — never throws/stalls on the fixed tick.
      this.intrigue.tick(ctx, step);
      // DIRECTOR: light drama nudge (raids/opportunities/crises/sparks);
      // self-throttled, fully guarded — never throws/stalls on the fixed tick.
      this.director.tick(ctx, step);
      // LINEAGE: births (stability-gated) + apprenticeship; self-throttled.
      this.lineage.tick(ctx, step);
      // MIGRATION: per-town census + the land-is-cheap rumour (the emigration
      // valve, truth-side half); self-throttled, bounded, fully guarded.
      this.migration.tick(ctx, step);
      // CHRONICLE: sample the Director/Lineage tallies for raid/birth beats
      // (bus-driven beats are captured by its subscription). Self-throttled; guarded.
      this.chronicle.tick();
      // SAGAS: lazy-expiry sweep of the emergent-arc registry — lapse open arcs past their TTL
      // (graceful dissolve + freeze backstop). Self-throttled (ARCS.sweepSecs); guarded; no scan.
      this.sagas.sweep(this.time);
      // CORPSE REAPER: reap dead agents past their grace TTL so the roster doesn't bloat with corpses
      // (the "tripled population" was 256 unreaped dead). Self-throttled; guarded.
      this._reapCorpses();
      // STATUS SENSOR: the omniscient fall-from-grace probe (docs/architecture/12 §5). Self-throttled
      // (STATUS.passSecs); fires RUIN/SHUNNED/RETIRE beats + ruined/slandered/thwarted memories on a
      // downward crossing. Observer-layer (reads truth + the signal store); guarded; never throws.
      runStatusSensor(this);
      // REPORTER: the gazetteer roams, interviews the most newsworthy soul, and
      // files a story to the Gazette. Deterministic; self-throttled; guarded.
      this.reporter.tick(ctx, step);
      // BOUNTIES: townsfolk read the Gazette and answer posted bounties. Guarded.
      this.bounties.tick(ctx, step);
      // ARBITRAGE: traders read price reports and haul to the dear market. Guarded.
      this.arbitrage.tick(ctx, step);
    }

    for (const a of this.agents) a.act(dt, cog);   // execution: beliefs + resolver only
    this.party.prune();   // drop companions who died this frame
    // reputation drifts every frame (dt seconds): faction rollups fade toward
    // neutral, personal standings drift toward each NPC's faction bias.
    this.reputation.decay(dt, this.agents);
    if (this.player) this.player._updateLabel();
  }

  // Town-wide standing-order double auction (see market.js).
  _runMarket(): void { runMarket(this); }

  // CORPSE REAPER (life-trace finding): dead townsfolk/monsters/rivals were never removed from the
  // roster — only raiders/horrors despawn — so corpses accumulated forever (256 dead vs 92 living in a
  // 30-min trace), bloating every per-agent pass and reading as a tripled "population". Stamp the time
  // of death on first sight, then REAP (scene + roster + index) once a corpse has lingered past
  // SIM.corpseTtl — long enough for looting / obituary / witness folds to have fired. Self-throttled;
  // guarded; never the player. Mirrors raids._despawn's cleanup.
  _reapCorpses(): void {
    try {
      const now = this.time;
      if (now - (this._lastReap ?? -Infinity) < (SIM.corpseReapSecs || 4)) return;
      this._lastReap = now;
      const reap: AgentShape[] = [];
      for (const a of this.agents) {
        if (a.controlled || a.alive) { if (a._diedAt != null) a._diedAt = undefined; continue; }
        if (a._diedAt == null) {                                       // first seen dead — start the grace clock
          a._diedAt = now;
          // STARVED (not slain): combat deaths are chronicled by combatEvents; a death by WANT has
          // no slayer, so the town learns of it here, the first pass the reaper finds the body.
          try { if (a._diedOfHunger) this.chronicle.note('death', a.id, `${a.name || 'A townsperson'} starved in want.`); } catch { /* never throw */ }
          continue;
        }
        if (now - a._diedAt >= (SIM.corpseTtl || 90)) reap.push(a);
      }
      for (const a of reap) {
        // ESCHEAT the corpse's coin (purse + banked stash) to the NEAREST living townsperson — a
        // CONSERVED transfer (closed money loop: gold is never burned), and realistic (a passerby
        // claims the unclaimed purse). If no heir exists yet, leave the corpse this pass rather than
        // leak gold. Inventory goods are NOT a conserved quantity (production/consumption), so they
        // simply leave the world with the corpse.
        const purse = (a.gold || 0) + (a.stash || 0);
        if (purse > 0) {
          let heir: AgentShape | null = null, best = Infinity;
          for (const o of this.agents) {
            if (o === a || !o.alive || o.controlled || o.faction !== 'townsfolk') continue;
            const d = o.pos.distanceToSquared(a.pos);
            if (d < best) { best = d; heir = o; }
          }
          if (!heir) continue;                       // no heir — keep the corpse until one exists (don't leak)
          heir.gold = (heir.gold || 0) + purse; a.gold = 0; a.stash = 0;
        }
        if (a.fighter) { (a.fighter as { alive?: boolean }).alive = false; if (a.fighter.root) this.scene.remove(a.fighter.root); }
        const i = this.agents.indexOf(a);
        if (i >= 0) this.agents.splice(i, 1);
        this.agentsById.delete(a.id);
      }
    } catch { /* never throw on the tick */ }
  }

  // emergent "market price": population-average belief (no central authority).
  avgPrice(c: string): number {
    let sum = 0, n = 0;
    for (const a of this.agents) {
      if (a.controlled || !a.alive) continue;
      sum += a.priceBeliefs[c]; n++;
    }
    return n ? sum / n : 0;
  }

  // What an NPC currently thinks of the player (-1..1) and a short label, for
  // the inspector / dialogue. Delegates to the reputation ledger (falls back to
  // the NPC's faction bias when it holds no personal belief yet).
  playerStanding(npcAgent: AgentShape | null): number { return this.reputation.standing(npcAgent); }
  playerStandingLabel(npcAgent: AgentShape | null): string { return this.reputation.describe(npcAgent); }
  factionStanding(faction: string): number { return this.reputation.factionStanding(faction); }

  // Combat hostility predicate for resolveCombat. Decisions read beliefs; this
  // resolves who a landed blow may actually damage (ground truth + reputation).
  isHostile(attackerFighter: IFighter, targetFighter: IFighter): boolean {
    const A = attackerFighter.agent, T = targetFighter.agent;
    if (!A || !T) return true;
    if (A.controlled) return true;                  // the player hits what they aim at
    if (factionHostile(A.faction, T.faction)) return true;
    // belief/standing-driven (reputation, Phase 3): a soured opinion turns hostile
    const b = A.beliefs.get(T.id);
    return !!(b && (b.hostile || b.standing < -0.6));
  }

  // Turn a salient bus deed into an autobiographical episode (see deedRouter.js).
  _recordDeed(a: AgentShape, ev: ActionEvent): void { recordDeed(this, a, ev); }

  // --- Phase-B memory hooks: succoured + relic-found ------------------------
  // recordSuccoured: a directed transfer (give/pay) or a quest hand-over MOVED
  // value to `receiver` while it was DESPERATE (low food / hunger). That kindness
  // is formative — it becomes a `succoured` episode whose `withId` is the
  // BENEFACTOR, so deriveGoals can lift it into a repay(benefactor) goal. Guarded;
  // never throws on the tick. fromId may be the player or another NPC.
  recordSuccoured(receiver: AgentShape, fromId: EntityId, valence = 1): void {
    if (!receiver || !receiver.memory || fromId == null) return;
    // desperate == genuinely low on food OR hungry; otherwise a gift is just nice,
    // not life-saving, and we don't mint a debt of gratitude from it.
    const hungry = (receiver.needs && receiver.needs.hunger <= MOTIVE.succourHunger) ||
      ((receiver.inventory && receiver.inventory.food) || 0) < 1;
    if (!hungry) return;
    try {
      receiver.memory.record({
        t: this.time, kind: 'succoured', withId: fromId,
        valence, salience: 0.75,
      });
    } catch { /* never throw on the tick */ }
  }

  // recordRelic: an agent obtained a relic at `place` — a delve-worthy episode that
  // deriveGoals lifts into a delve(place) goal (aspirational for NPCs). Guarded.
  recordRelic(agent: AgentShape, place = 'a ruin'): void {
    if (!agent || !agent.memory) return;
    try {
      agent.memory.record({ t: this.time, kind: 'relic', place, valence: 1, salience: 0.7 });
    } catch { /* never throw */ }
  }

  // Fold combat outcomes back into beliefs/reputation/memory (see combatEvents.js).
  onCombatEvents(events: CombatEvent[]): void { onCombatEvents(this, events); }

  // THE _slain / belief-death BRIDGE (shared by the melee combat path in combatEvents.js
  // AND the death sweep below). When `dead` falls — by whoever's hand `killer` (may be null)
  // — stamp every agent that holds an avenge/duel/avenger vendetta against it (the killer
  // too) with the dead id in their OWN `_slain` set, the sanctioned out-of-sight death
  // signal the goal layer reads, and ERASE their stale belief about it. This is what lets a
  // vendetta close the instant its quarry dies, wherever the avenger is, however the killing
  // blow landed. Reads/writes only agent state; never throws (the freeze lesson).
  stampSlain(dead: AgentShape | null, killer: AgentShape | null = null): void {
    if (!dead) return;
    try {
      const id = dead.id;
      if (killer) { (killer._slain || (killer._slain = new Set<EntityId>())).add(id); }
      for (const w of this.agents) {
        if (w === dead || w.controlled) continue;
        // anyone pursuing it (active goal) — OR who COULD re-derive a vendetta against it
        // (a hostile belief, an assaulted/witnessed_death memory of it) — learns it is dead.
        // Stamping the broader set (not just the active goal) closes a race where an
        // avenge goal is transiently absent (mid re-derivation) at the death instant: the
        // `_slain` mark both pops any present goal AND blocks deriveGoals from re-pushing one.
        const byGoal = (Array.isArray(w.goals) && w.goals.some((g) => g && (g.kind === 'avenge' || g.kind === 'defeat') && g.subjectId === id))
          || w._duelWith === id || w.avengerOf === id;
        const bel = w.beliefs && w.beliefs.get(id);
        const byBelief = !!(bel && (bel.hostile || bel.standing < 0));
        const byMemory = !!(w.memory && typeof w.memory.recent === 'function' &&
          w.memory.recent(12).some((e) => e && (e.kind === 'assaulted' || e.kind === 'witnessed_death') && (e.withId === id || e.byId === id)));
        if (byGoal || byBelief || byMemory) {
          (w._slain || (w._slain = new Set<EntityId>())).add(id);
          if (w.beliefs) w.beliefs.erase(id);   // I KNOW it's dead now — drop the stale sighting
        }
      }
    } catch { /* never throw on the tick */ }
  }

  // Catch deaths that did NOT flow through a melee combat 'dead' event (ranged/instant
  // ability kills, tower bolts, scripted removals): for each agent newly not-alive that we
  // haven't yet processed, run the death bridge so vendettas/beliefs resolve. Killer is
  // unknown here (no event), so `_slain` is stamped on the avengers (who close their goal),
  // not on a specific slayer. Idempotent via `_deathSeen`. Guarded.
  _sweepDeaths(): void {
    try {
      if (!this._deathSeen) this._deathSeen = new Set<EntityId>();
      for (const a of this.agents) {
        if (a.alive) continue;
        if (this._deathSeen.has(a.id)) continue;
        this._deathSeen.add(a.id);
        this.stampSlain(a, null);
      }
    } catch { /* never throw on the tick */ }
  }
}
