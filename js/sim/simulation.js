// Simulation manager: spawns the professions, runs the fixed-rate decision pass
// and the market double-auction, and tracks emergent average prices. Peaceful —
// no combat — so the human can wander a working market town.

import * as THREE from 'three';
import { Fighter } from '../fighter.js';
import { Agent } from './agent.js';
import { ROSTER, SIM, NAMES, MONSTER, MOTIVE, CAMPS, TOWNS, factionHostile } from './simconfig.js';
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
import { BuildSites } from './construction.js';
import { seedNarratives } from './seeding.js';
import { Lineage } from './lineage.js';
import { Chronicle } from './chronicle.js';
import { Gazette } from './gazette.js';
import { Reporter } from './reporter.js';
import { Bounties } from './bounties.js';
import { Arbitrage } from './arbitrage.js';
import { Intrigue } from './intrigue.js';
import { runMarket } from './market.js';
import { installDeedRouter, recordDeed } from './deedRouter.js';
import { onCombatEvents } from './combatEvents.js';

const rand = (a, b) => a + Math.random() * (b - a);

// synthesise a plausible given name from syllables — the fallback when the curated
// NAMES pool is exhausted (large multi-town worlds + generations). Keeps the
// chronicle reading like people, not "Unit47".
const _SYL_A = ['Ar', 'Bel', 'Cor', 'Dra', 'El', 'Fen', 'Gar', 'Hal', 'Il', 'Jor', 'Kel', 'Lor', 'Mor', 'Nor', 'Or', 'Per', 'Quen', 'Ral', 'Sel', 'Tor', 'Ul', 'Ver', 'Wyn', 'Yor', 'Zel'];
const _SYL_B = ['a', 'e', 'i', 'o', 'ae', 'ia', 'ei', 'au'];
const _SYL_C = ['dric', 'wyn', 'mar', 'ric', 'sa', 'lyn', 'don', 'gar', 'the', 'ven', 'na', 'ris', 'mund', 'far', 'dis', 'wald', 'ric', 'beth'];
function synthName() {
  const p = (arr) => arr[(Math.random() * arr.length) | 0];
  return p(_SYL_A) + p(_SYL_B) + p(_SYL_C);
}

function makePersonality() {
  return {
    risk_tolerance: rand(0.2, 0.8),
    social_drive:   rand(0.2, 0.8),
    ambition:       rand(0.3, 0.9),
    altruism:       rand(0.2, 0.8),
    curiosity:      rand(0.2, 0.8),
  };
}

export class Simulation {
  constructor(scene, world, opts = {}) {
    this.scene = scene;
    this.world = world;
    // body factory: the browser builds visual Fighters (default); a headless
    // harness injects a logic-only HeadlessFighter so the sim runs with no
    // renderer/DOM. Everything downstream only touches the shared interface.
    this.makeFighter = opts.makeFighter || ((model, o = {}) => new Fighter(model, o));
    this.agents = [];
    this.agentsById = new Map();
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

    // CHRONICLE: the world's live drama feed. Subscribes to the shared bus (like
    // xpstats/econstats) and distils the deed firehose into NOTABLE story beats —
    // kills, vendettas, prodigies rising, fortunes — plus raids/births sampled from
    // the Director/Lineage tallies. Read-only; bounded ring; never throws on tick.
    this.chronicle = new Chronicle(this);

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
  dispose() {
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
  }

  _takeName() {
    if (this._names.length) return this._names.splice((Math.random() * this._names.length) | 0, 1)[0];
    // pool exhausted (many towns + generations churn through it) — SYNTHESISE a
    // plausible given name from syllables rather than an ugly "Unit<id>" (which
    // would ride every future chronicle beat). Deterministic-safe (Math.random).
    return synthName();
  }

  spawn() {
    // OPEN WORLD: several dense town cores (see TOWNS). Each townsperson belongs to
    // ONE town and lives/works/defends within its home band — so the world is big
    // (wilderness + roads between towns) WITHOUT thinning any town's social drama.
    const centers = (TOWNS && TOWNS.centers && TOWNS.centers.length) ? TOWNS.centers : [[0, 0]];
    const tr = (TOWNS && TOWNS.radius) || 70;
    const tnames = (TOWNS && TOWNS.names) || [];
    this.towns = centers.map((c, i) => ({ id: i, center: new THREE.Vector3(c[0], 0, c[1]), radius: tr, name: tnames[i] || `Town ${i + 1}` }));
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
    // a FULL cohort per town — the open-world point is more dense cores, NOT one
    // town spread thin (spreading the same people thins the drama — measured).
    let gi = 0;
    for (const town of this.towns) {
      for (let k = 0; k < cohort; k++, gi++) {
        const model = MODELS[(Math.random() * MODELS.length) | 0];
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
          id: this._nextId++, name: this._takeName(),
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
        const dg = (REGIONS[regionAt(c.x, c.z)] || {}).danger || 0;
        if (dg > bestDanger) { bestDanger = dg; spot = c; }
      }
      spot = spot || new THREE.Vector3(ARENA_RADIUS * 0.85, 0, -ARENA_RADIUS * 0.85);
      const sx = spot.x + rand(-3, 3), sz = spot.z + rand(-3, 3);
      const sy = typeof document === 'undefined' ? 0 : terrainHeight(sx, sz);
      fighter.root.position.set(sx, sy, sz);
      this.scene.add(fighter.root);
      const m = new Agent(fighter, {
        id: this._nextId++, name: `${MONSTER.name} ${i + 1}`, profession: null,
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
  _spawnCamps() {
    this.camps = {};
    if (!CAMPS) return;
    for (const key in CAMPS) {
      const C = CAMPS[key];
      if (!C) continue;
      // a camp anchor on a frontier ring, away from the town core.
      const ang = rand(0, Math.PI * 2);
      const ringMin = ARENA_RADIUS * (C.ringMin ?? 0.7);
      const ringMax = ARENA_RADIUS * (C.ringMax ?? 0.9);
      const r = rand(ringMin, ringMax);
      const ax = Math.cos(ang) * r, az = Math.sin(ang) * r;
      const camp = { key, faction: C.faction, anchor: new THREE.Vector3(ax, 0, az), leader: null, members: [], raidActive: !!C.raidActive, _lastReinforce: -Infinity, _born: 0 };

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
  _spawnCampMember(camp, C, isLeader, mint) {
    const fighter = this.makeFighter(C.model || MONSTER.model, {});
    const sc = isLeader ? 0 : (C.scatter ?? 5);
    const px = camp.anchor.x + rand(-sc, sc), pz = camp.anchor.z + rand(-sc, sc);
    const py = typeof document === 'undefined' ? 0 : terrainHeight(px, pz);
    fighter.root.position.set(px, py, pz);
    this.scene.add(fighter.root);
    camp._born++;
    const name = isLeader ? (C.leaderName || `${C.name} Leader`) : `${C.name} ${camp._born}`;
    const a = new Agent(fighter, {
      id: this._nextId++, name, profession: null,
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
  reinforceCamps() {
    if (!this.camps) return;
    const now = this.time;
    for (const key in this.camps) {
      const camp = this.camps[key], C = CAMPS[key];
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

  addPlayer(fighter) {
    const agent = new Agent(fighter, {
      id: this._nextId++, name: 'You', profession: null,
      personality: makePersonality(), controlled: true, faction: 'outsider',
    });
    this.agents.push(agent);
    this.agentsById.set(agent.id, agent);
    this.player = agent;
    this.reputation.setPlayer(agent.id);
    return agent;
  }

  get fighters() { return this.agents.map((a) => a.fighter); }
  _ctx() { return { agents: this.agents, agentsById: this.agentsById, world: this.world, time: this.time, player: this.player, buildSites: this.buildSites, cities: this.cities }; }

  update(dt) {
    this.time += dt;
    this.world.update(dt);
    const ctx = this._ctx();

    for (const a of this.agents) {
      if (!a.alive) { a.setLabelVisible(false); continue; }
      if (a.autonomous) a.drainNeeds(dt);
    }

    this._acc += dt;
    const step = 1 / SIM.tickHz;
    let guard = 4;
    while (this._acc >= step && guard-- > 0) {
      this._acc -= step;
      // Theory-of-Mind passes: perceive -> decay -> gossip -> decide (decisions
      // read beliefs, never ground truth).
      for (const a of this.agents) a.perceive(ctx);
      for (const a of this.agents) a.beliefs.decay(step);
      for (const a of this.agents) a.gossipBeliefs(ctx);
      for (const a of this.agents) a.decide(ctx);
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
      // CHRONICLE: sample the Director/Lineage tallies for raid/birth beats
      // (bus-driven beats are captured by its subscription). Self-throttled; guarded.
      this.chronicle.tick();
      // REPORTER: the gazetteer roams, interviews the most newsworthy soul, and
      // files a story to the Gazette. Deterministic; self-throttled; guarded.
      this.reporter.tick(ctx, step);
      // BOUNTIES: townsfolk read the Gazette and answer posted bounties. Guarded.
      this.bounties.tick(ctx, step);
      // ARBITRAGE: traders read price reports and haul to the dear market. Guarded.
      this.arbitrage.tick(ctx, step);
    }

    for (const a of this.agents) a.act(dt, ctx);
    this.party.prune();   // drop companions who died this frame
    // reputation drifts every frame (dt seconds): faction rollups fade toward
    // neutral, personal standings drift toward each NPC's faction bias.
    this.reputation.decay(dt, this.agents);
    if (this.player) this.player._updateLabel();
  }

  // Town-wide standing-order double auction (see market.js).
  _runMarket() { return runMarket(this); }

  // emergent "market price": population-average belief (no central authority).
  avgPrice(c) {
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
  playerStanding(npcAgent) { return this.reputation.standing(npcAgent); }
  playerStandingLabel(npcAgent) { return this.reputation.describe(npcAgent); }
  factionStanding(faction) { return this.reputation.factionStanding(faction); }

  // Combat hostility predicate for resolveCombat. Decisions read beliefs; this
  // resolves who a landed blow may actually damage (ground truth + reputation).
  isHostile(attackerFighter, targetFighter) {
    const A = attackerFighter.agent, T = targetFighter.agent;
    if (!A || !T) return true;
    if (A.controlled) return true;                  // the player hits what they aim at
    if (factionHostile(A.faction, T.faction)) return true;
    // belief/standing-driven (reputation, Phase 3): a soured opinion turns hostile
    const b = A.beliefs.get(T.id);
    return !!(b && (b.hostile || b.standing < -0.6));
  }

  // Turn a salient bus deed into an autobiographical episode (see deedRouter.js).
  _recordDeed(a, ev) { return recordDeed(this, a, ev); }

  // --- Phase-B memory hooks: succoured + relic-found ------------------------
  // recordSuccoured: a directed transfer (give/pay) or a quest hand-over MOVED
  // value to `receiver` while it was DESPERATE (low food / hunger). That kindness
  // is formative — it becomes a `succoured` episode whose `withId` is the
  // BENEFACTOR, so deriveGoals can lift it into a repay(benefactor) goal. Guarded;
  // never throws on the tick. fromId may be the player or another NPC.
  recordSuccoured(receiver, fromId, valence = 1) {
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
  recordRelic(agent, place = 'a ruin') {
    if (!agent || !agent.memory) return;
    try {
      agent.memory.record({ t: this.time, kind: 'relic', place, valence: 1, salience: 0.7 });
    } catch { /* never throw */ }
  }

  // Fold combat outcomes back into beliefs/reputation/memory (see combatEvents.js).
  onCombatEvents(events) { return onCombatEvents(this, events); }
}
