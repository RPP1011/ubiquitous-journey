//! The ECS world (docs/architecture/22 §3, §4): SoA columns + a per-tick `Perceivable` projection +
//! the spatial grid + the double-buffered belief snapshot + the intent queue. The Wave-1 substrate:
//! all the core columns + the scheduler phases, with each cognition/execution SYSTEM behind a stub
//! in `systems::*` that the fan-out fills. Every parallel phase is per-entity own-write (or emits
//! intents), so the whole tick stays deterministic (M=1 ≡ M=N).

use crate::components::{
    BeliefTable, Beat, CombatBody, Commodity, DirectorState, Economy, Episode, EpisodeKind, Experience,
    Faction, Goal, GoalStack, Memory, Mood, Needs, Perceivable, Personality, Plan, Profession,
    Progression, DefenseState, ExpeditionState, Quest, Signals, TropeState, WatchState, NO_BAND, NO_GOD,
};
use crate::grid::Grid;
use crate::intent::{Intent, IntentQueue};
use crate::mentalmap::MentalMap;
use crate::perceive::perceive;
use crate::rng::DeterministicRng;
use crate::systems;

const TOWN_RADIUS: f32 = 180.0;
const ARENA_CLAMP: f32 = 590.0;
pub const N_WORK_SITES: usize = 7; // one per Profession variant (index by `Profession as usize`).

/// A static resource site (built once at worldgen; read-only — not an entity). Minimal Wave-1 set.
#[derive(Clone, Copy, Debug)]
pub struct Poi {
    pub kind: u8, // 0 market, 1 work, 2 rest/home, 3 field…
    pub x: f32,
    pub z: f32,
}

pub struct World {
    pub n: usize,
    pub seed: u64,
    pub tick: u32,

    // ── WARM dense columns (one per concern) ──
    pub pos: Vec<[f32; 2]>,
    pub faction: Vec<u8>,
    pub profession: Vec<u8>,
    pub level: Vec<u8>,
    pub notoriety: Vec<u16>,
    pub threat: Vec<u16>,
    pub wealth: Vec<u16>,
    pub alive: Vec<bool>,
    pub needs: Vec<Needs>,
    pub mood: Vec<Mood>,
    pub personality: Vec<Personality>,
    pub ambition: Vec<u8>, // slow archetypal drive (AMB_*) — biases the livelihood choice in decide
    pub goal: Vec<Goal>,
    pub econ: Vec<Economy>,
    pub combat: Vec<CombatBody>,
    pub home: Vec<[f32; 2]>,
    pub town: Vec<u16>,
    pub rng: Vec<DeterministicRng>,
    pub progression: Vec<Progression>,
    pub ability_cd: Vec<f32>, // per-agent ability-cast cooldown (s); ticked + gated by abilities::cast
    pub signals: Vec<Signals>, // per-agent narrative-signal record (signals.rs folds; observer telemetry)
    // ── Wave-4 GOAP columns: episodic memory + the persistent goal-stack + cached plan ──
    pub memory: Vec<Memory>,
    pub goals: Vec<GoalStack>, // standing intentions (deriveGoals→pushGoal; persists across ticks)
    pub plan: Vec<Plan>,       // cached plan toward the top intention (cursor-advanced; replan-on-change)
    pub experience: Vec<Experience>, // outcome-conditioned caution: per-strategy surcharge (doc 11, experience.rs)
    pub captive_of: Vec<i32>,        // captor id while held prisoner (CAPTIVE_NONE = free) — capture-on-defeat
    pub trade_buff: Vec<u32>,        // tick-deadline of an active trade_edge (haggle) market price buff (0 = none)
    pub recipe: Vec<[f32; crate::components::N_COMMODITIES]>, // graded recipe skill PER GOOD (cross-craft: learn-by-doing, fades unpractised)
    // ── Wave-3 society columns ──
    pub faith: Vec<u8>,         // small-god id (0 = none, NO_GOD)
    pub band_leader: Vec<i32>,  // band/clan leader id (-1 = none, NO_BAND)
    pub house: Vec<u32>,        // dynastic house id (0 = none)
    // ── Wave-H society columns (the society-wave fan-out substrate) ──
    pub epithet: Vec<u8>,       // emergent epithet: 0 none, 1 hero, 2 villain, 3 survivor (houses/combat)
    pub disguise: Vec<u8>,      // apparent faction override (0xFF = none) — intrigue/percept (the spy mask)
    pub role: Vec<u8>,          // institutional role: 0 none, 1 watch, 2 spy, 3 asset, 4 bodyguard, 5 duelist

    // ── belief layer (double-buffered: gossip reads `beliefs_prev`, writes `beliefs`, §4) ──
    pub beliefs: Vec<BeliefTable>,
    pub beliefs_prev: Vec<BeliefTable>,

    // ── HOT per-tick projection + index ──
    pub surface: Vec<Perceivable>,
    pub grid: Grid,

    // ── cross-agent effects (deterministic serial merge) ──
    pub intents: IntentQueue,

    // ── static world (read-only after worldgen) ──
    pub market: [f32; 2],
    pub work_sites: [[f32; 2]; N_WORK_SITES],
    pub town_center: [f32; 2],
    pub base_price: [i64; crate::components::N_COMMODITIES],
    pub map: MentalMap, // affordance-queried static places (read-only after worldgen)

    // ── Wave-3 society/observer state (mutated in the SERIAL society phase) ──
    pub sim_rng: DeterministicRng, // world-level draws for director/lineage/etc. (serial ⇒ deterministic)
    pub director: DirectorState,   // the drama manager's budget/pacing state (serial society phase)
    pub chronicle: Vec<Beat>,      // world-history feed (observer; append-only, bounded by the system)
    pub quests: Vec<Quest>,        // the quest board
    // chronicle detection-state (own to systems::chronicle): last-tick snapshots so the observer can
    // detect transitions (a death = `alive` flipped false; a class-up = `total_level` rose). Additive,
    // observer-only — never read to drive a decision. Lazily sized to `n` by the chronicle system.
    pub chron_seen_dead: Vec<bool>,
    pub chron_prev_level: Vec<u16>,
    /// Per-agent biographical summary (observer; `biography.js`). A throttled pass rolls each living
    /// agent's own state into a compact numeric who-they-were row the chronicle UI reads. Sized to `n`.
    pub biographies: Vec<crate::components::Biography>,
    // ── Wave-H society/observer world state ──
    pub house_feuds: Vec<(u32, u32)>, // active house-vs-house feuds (canonical lo<hi pairs) — houses.rs
    pub watch: WatchState,            // the Night Watch institution's hysteresis/captaincy state (serial)
    pub defenses: DefenseState,       // the watchtower ring's shot tally (serial society phase)
    pub expeditions: ExpeditionState, // wilderness adventuring companies afield (serial society phase)
    pub tropes: TropeState,           // the relationship-trope engine's cooldown/telemetry state (serial)
    pub sagas: crate::sagas::SagaStore, // emergent-saga registry (observer: vendettas/rescues; doc 12/19)
    pub gazette: crate::gazette::Gazette, // the town newspaper (observer; published in the society phase)
    pub econstats: crate::components::EconStats, // economic telemetry (observer; folded in the trade merge)
    pub reporter_last_volume: u64, // trade volume at the last filed report (so each report is a delta)
    pub bounty_target: i32, // the agent id a town bounty is posted on (-1 = none) — bounties.ts
    pub bounty_fund: i64,   // gold (minor units) pledged to whoever claims the bounty (a real, held pool)
    pub caravan_treasury: i64, // gold held by the EXTERNAL market the caravans trade with (arbitrage.ts)
}

/// The commodity a profession OUTPUTS (the canonical good→site/recipe mapping), if any.
#[inline]
pub fn prof_good(prof: u8) -> Option<usize> {
    match prof {
        1 => Some(0), // Farmer → Food
        2 => Some(2), // Miner → Ore
        3 => Some(1), // Woodcutter → Wood
        4 => Some(3), // Blacksmith → Tool
        5 => Some(4), // Hunter → Herb
        6 => Some(5), // Trader → Potion
        _ => None,
    }
}

/// A perceived faction sentinel: no disguise active.
pub const NO_DISGUISE: u8 = 0xFF;
/// `captive_of` sentinel: a free agent (not held prisoner).
pub const CAPTIVE_NONE: i32 = -1;
/// The `role` code for an AVENGER — a kinsman/friend who has taken up the slain's cause (the director
/// role machinery; mirrors `world.role`: 0 none, 1 watch, 2 spy, 3 asset, 4 bodyguard, 5 duelist).
pub const ROLE_AVENGER: u8 = 6;
/// A belief reads as a dear FRIEND (worth avenging) above this standing (i16 quantization).
const AVENGER_FRIEND_BAR: i16 = 4_000;
/// RECIPROCITY warmth: a beneficiary's standing-gain toward its benefactor (strong — a direct kindness
/// received), and the smaller goodwill a bystander takes from merely witnessing the gift.
const RECIPROCITY_WARMTH: i16 = 3_000;
const RECIPROCITY_BYSTANDER_WARMTH: i16 = 800;
/// How hard a fresh avenger's regard for the killer sours (latched hostile — the avenge seed).
const AVENGER_SOUR: i16 = 20_000;
/// Chance a RAIDER's lethal blow on a townsperson TAKES them captive instead of killing (a prisoner of
/// the raid, freed when the captor falls). Drawn from `sim_rng` in the serial merge ⇒ deterministic.
const CAPTURE_CHANCE: f32 = 0.30;
/// Settle stranded estates on this tick cadence — long enough that a fresh corpse can still be looted
/// before its un-looted purse escheats to an heir.
const ESCHEAT_EVERY: u32 = 240;
/// Re-assess earned epithets on this cadence (deeds accrue slowly; no need to scan every tick).
const EPITHET_EVERY: u32 = 120;
/// Run the taught-recipe (study) pass on this cadence (lessons are occasional, not every tick).
const STUDY_EVERY: u32 = 90;
/// Put the gazette to press on this cadence (an edition every so often; newsread reads it each tick).
const GAZETTE_EVERY: u32 = 60;
/// Post/refresh a town bounty on this cadence.
const BOUNTY_EVERY: u32 = 80;
/// Run a caravan to the external market on this cadence (trade is periodic, not every tick).
const CARAVAN_EVERY: u32 = 100;
/// Re-evaluate the workforce balance on this cadence (retraining is slow + occasional).
const OCCUPATION_EVERY: u32 = 150;
/// Refresh the biographical rollups on this cadence (a life-summary moves slowly; observer-only).
const BIOGRAPHY_EVERY: u32 = 200;

impl World {
    /// Worldgen: `n` agents clustered in one dense town with professions, gold, and home anchors.
    pub fn spawn(seed: u64, n: usize) -> World {
        let mut gen = DeterministicRng::seed(seed, 0xA11CE);
        let mut work_sites = [[0.0f32; 2]; N_WORK_SITES];
        for s in work_sites.iter_mut() {
            let r = TOWN_RADIUS * (0.4 + 0.6 * gen.next_f32());
            let a = gen.next_f32() * std::f32::consts::TAU;
            *s = [r * a.cos(), r * a.sin()];
        }
        let mut w = World {
            n,
            seed,
            tick: 0,
            pos: Vec::with_capacity(n),
            faction: Vec::with_capacity(n),
            profession: Vec::with_capacity(n),
            level: Vec::with_capacity(n),
            notoriety: Vec::with_capacity(n),
            threat: Vec::with_capacity(n),
            wealth: Vec::with_capacity(n),
            alive: Vec::with_capacity(n),
            needs: Vec::with_capacity(n),
            mood: Vec::with_capacity(n),
            personality: Vec::with_capacity(n),
            ambition: Vec::with_capacity(n),
            goal: Vec::with_capacity(n),
            econ: Vec::with_capacity(n),
            combat: Vec::with_capacity(n),
            home: Vec::with_capacity(n),
            town: Vec::with_capacity(n),
            rng: Vec::with_capacity(n),
            progression: Vec::with_capacity(n),
            ability_cd: Vec::with_capacity(n),
            signals: Vec::with_capacity(n),
            memory: Vec::with_capacity(n),
            goals: Vec::with_capacity(n),
            plan: Vec::with_capacity(n),
            experience: Vec::with_capacity(n),
            captive_of: Vec::with_capacity(n),
            trade_buff: Vec::with_capacity(n),
            recipe: Vec::with_capacity(n),
            faith: Vec::with_capacity(n),
            band_leader: Vec::with_capacity(n),
            house: Vec::with_capacity(n),
            epithet: Vec::with_capacity(n),
            disguise: Vec::with_capacity(n),
            role: Vec::with_capacity(n),
            beliefs: Vec::with_capacity(n),
            beliefs_prev: Vec::with_capacity(n),
            surface: Vec::with_capacity(n),
            grid: Grid::new(),
            intents: IntentQueue::new(),
            market: [0.0, 0.0],
            work_sites,
            town_center: [0.0, 0.0],
            base_price: [10, 8, 12, 30, 15, 40],
            map: MentalMap::default(),
            sim_rng: DeterministicRng::seed(seed, 0x50C1E7),
            director: DirectorState::default(),
            chronicle: Vec::new(),
            quests: Vec::new(),
            chron_seen_dead: Vec::new(),
            chron_prev_level: Vec::new(),
            biographies: Vec::new(),
            house_feuds: Vec::new(),
            watch: WatchState::default(),
            defenses: DefenseState::default(),
            expeditions: ExpeditionState::default(),
            tropes: TropeState::default(),
            sagas: crate::sagas::SagaStore::default(),
            gazette: crate::gazette::Gazette::default(),
            econstats: crate::components::EconStats::default(),
            reporter_last_volume: 0,
            bounty_target: -1,
            bounty_fund: 0,
            caravan_treasury: 200_000, // the external market's gold (counted in total_gold ⇒ conserved)
        };
        for i in 0..n {
            let r = TOWN_RADIUS * gen.next_f32().sqrt();
            let a = gen.next_f32() * std::f32::consts::TAU;
            let p = [r * a.cos(), r * a.sin()];
            w.pos.push(p);
            let f = if gen.next_f32() < 0.06 { Faction::Monster } else { Faction::Townsfolk };
            w.faction.push(f as u8);
            let prof = if f == Faction::Monster {
                Profession::None
            } else {
                // 1..=6 = the six working professions
                match (gen.next_f32() * 6.0) as u8 {
                    0 => Profession::Farmer,
                    1 => Profession::Miner,
                    2 => Profession::Woodcutter,
                    3 => Profession::Blacksmith,
                    4 => Profession::Hunter,
                    _ => Profession::Trader,
                }
            };
            w.profession.push(prof as u8);
            w.level.push((gen.next_f32() * 12.0) as u8);
            w.notoriety.push((gen.next_f32() * 4000.0) as u16);
            w.threat.push((gen.next_f32() * 8000.0) as u16);
            w.wealth.push((gen.next_f32() * 60000.0) as u16);
            w.alive.push(true);
            w.needs.push(Needs::default());
            w.mood.push(Mood::default());
            // sample the stable archetype traits (uniform 0..1; the worldgen rng keeps it deterministic).
            let pers = Personality {
                ambition: gen.next_f32(),
                curiosity: gen.next_f32(),
                risk_tolerance: gen.next_f32(),
                social_drive: gen.next_f32(),
                altruism: gen.next_f32(),
                aggression: gen.next_f32(),
            };
            // assign a personality-weighted ambition (monsters get wanderlust — they roam, don't trade).
            let amb = if f == Faction::Monster {
                crate::components::AMB_WANDERLUST
            } else {
                crate::components::pick_ambition(&pers, gen.next_f32())
            };
            w.personality.push(pers);
            w.ambition.push(amb);
            w.goal.push(Goal::Idle);
            let mut e = Economy::default();
            e.gold = (40.0 + gen.next_f32() * 80.0) as i64 * 100; // minor units
            e.inventory[Commodity::Food as usize] = (gen.next_f32() * 5.0) as i32;
            w.econ.push(e);
            w.combat.push(CombatBody::default());
            w.home.push(p); // home = spawn point (Wave-1)
            w.town.push(0);
            w.rng.push(DeterministicRng::seed(seed, i as u64));
            w.progression.push(Progression::default());
            w.ability_cd.push(0.0);
            w.signals.push(Signals::default());
            w.memory.push(Memory::default());
            w.goals.push(GoalStack::default());
            w.plan.push(Plan::default());
            w.experience.push(Experience::default());
            w.captive_of.push(CAPTIVE_NONE);
            w.trade_buff.push(0);
            w.recipe.push([1.0; crate::components::N_COMMODITIES]); // trained across the crafts; the unpractised fade (specialisation emerges)
            w.beliefs.push(BeliefTable::default());
            w.beliefs_prev.push(BeliefTable::default());
            w.faith.push(NO_GOD);
            w.band_leader.push(NO_BAND);
            w.house.push(0);
            w.epithet.push(0);
            w.disguise.push(NO_DISGUISE);
            w.role.push(0);
        }
        // build the static affordance map once from the finished geography.
        w.map = MentalMap::build(w.market, &w.work_sites, w.town_center, ARENA_CLAMP);
        // seed the initial relationship constellations (rival apprentices, etc.) for the director.
        systems::seeding::seed_narratives(&mut w);
        w
    }

    /// Dynamically spawn one agent mid-sim (lineage births, director raiders). Pushes a consistent row
    /// to EVERY column with sane defaults; rng seeded by the new STABLE index (slots are never reused,
    /// so the index is a stable id ⇒ deterministic stream). Returns the new id. The caller sets any
    /// non-default fields afterward. IMPORTANT: spawned agents carry 0 gold — NEVER mint (the
    /// gold_conserved gate); move gold via a Transfer/own-write if inheritance is wanted.
    pub fn spawn_agent(&mut self, pos: [f32; 2], faction: Faction, profession: Profession) -> usize {
        let i = self.n;
        self.pos.push(pos);
        self.faction.push(faction as u8);
        self.profession.push(profession as u8);
        self.level.push(1);
        self.notoriety.push(0);
        self.threat.push(0);
        self.wealth.push(0);
        self.alive.push(true);
        self.needs.push(Needs::default());
        self.mood.push(Mood::default());
        self.personality.push(Personality::default());
        self.ambition.push(crate::components::AMB_WANDERLUST);
        self.goal.push(Goal::Idle);
        self.econ.push(Economy::default());
        self.combat.push(CombatBody::default());
        self.home.push(pos);
        self.town.push(0);
        self.rng.push(DeterministicRng::seed(self.seed, i as u64));
        self.progression.push(Progression::default());
        self.ability_cd.push(0.0);
        self.signals.push(Signals::default());
        self.memory.push(Memory::default());
        self.goals.push(GoalStack::default());
        self.plan.push(Plan::default());
        self.experience.push(Experience::default());
        self.captive_of.push(CAPTIVE_NONE);
        self.trade_buff.push(0);
        self.recipe.push([1.0; crate::components::N_COMMODITIES]);
        self.faith.push(NO_GOD);
        self.band_leader.push(NO_BAND);
        self.house.push(0);
        self.epithet.push(0);
        self.disguise.push(NO_DISGUISE);
        self.role.push(0);
        self.beliefs.push(BeliefTable::default());
        self.beliefs_prev.push(BeliefTable::default());
        self.n += 1;
        i
    }

    /// Project the WARM columns into the hot `Perceivable` surface (id order) and counting-sort it
    /// into the grid. Serial, O(n).
    pub fn build_surface(&mut self) {
        let n = self.n;
        self.surface.clear();
        for i in 0..n {
            // PERCEIVED faction (the disguise mask, docs 02): the surface every observer's `perceive`
            // reads shows the APPARENT faction when a disguise is active, not the true `faction[i]`.
            // The load-bearing deception wiring (intrigue spies): cognition is fooled while ground-truth
            // combat (which reads `faction[i]`) still resolves truly.
            let perceived_faction =
                if self.disguise[i] != NO_DISGUISE { self.disguise[i] } else { self.faction[i] };
            self.surface.push(Perceivable {
                id: i as u32,
                x: self.pos[i][0],
                z: self.pos[i][1],
                faction: perceived_faction,
                flags: if self.alive[i] { 1 } else { 0 },
                level: self.level[i],
                _pad: 0,
                notoriety: self.notoriety[i],
                threat: self.threat[i],
                wealth_cue: self.wealth[i],
                _pad2: 0,
            });
        }
        let surface = std::mem::take(&mut self.surface);
        self.grid.rebuild(&surface);
        self.surface = surface;
    }

    /// Snapshot the belief column so gossip can cross-READ neighbours' beliefs (`beliefs_prev`)
    /// while writing its own (`beliefs`) in parallel without a race (the §4 double-buffer).
    pub fn snapshot_beliefs(&mut self) {
        self.beliefs_prev.clone_from(&self.beliefs);
    }

    /// Apply queued cross-agent intents to the world in a FIXED deterministic order (§4). The only
    /// place another entity's columns are written. Conserves gold/inventory; resolves contention by
    /// order (first in the sort wins).
    pub fn drain_intents(&mut self) {
        self.intents.sort_deterministic();
        // take the items out so we can mutate `self` freely while iterating.
        let items = std::mem::take(&mut self.intents.items);
        for it in &items {
            match *it {
                Intent::Transfer { from, to, good, qty, price } => {
                    let (from, to, g) = (from as usize, to as usize, good as usize);
                    if from >= self.n || to >= self.n || g >= crate::components::N_COMMODITIES {
                        continue;
                    }
                    // conserved: only if seller has the goods and buyer the gold.
                    if self.econ[from].inventory[g] >= qty && self.econ[to].gold >= price && qty > 0 {
                        self.econ[from].inventory[g] -= qty;
                        self.econ[to].inventory[g] += qty;
                        self.econ[to].gold -= price;
                        self.econ[from].gold += price;
                        // ECON TELEMETRY (econstats): fold the consummated trade into the observer counters.
                        let es = &mut self.econstats;
                        es.trades += 1;
                        es.volume += qty as u64;
                        es.gold_flowed += price.max(0) as u64;
                        es.good_volume[g] += qty as u64;
                    }
                }
                Intent::Strike { from, to, dmg } => {
                    let (from, to) = (from as usize, to as usize);
                    if to >= self.n || !self.alive[to] {
                        continue;
                    }
                    // a SHIELD buffer (the ability shield op) soaks the blow before health (depletes;
                    // no regen). Overflow carries through to health.
                    let mut dmg = dmg;
                    if self.combat[to].shield > 0.0 {
                        let absorbed = self.combat[to].shield.min(dmg);
                        self.combat[to].shield -= absorbed;
                        dmg -= absorbed;
                    }
                    self.combat[to].health -= dmg;
                    // EPISTEMIC SEED (the vendetta loop): the victim REMEMBERS being struck — an
                    // `assaulted` episode the GOAP layer reads next tick to derive an avenge
                    // intention. Serial write to the victim's OWN memory row (deterministic). Self-
                    // strikes (from == to) leave no grudge.
                    if from != to && from < self.n {
                        self.memory[to].record(Episode {
                            kind: EpisodeKind::Assaulted as u8,
                            place: 0,
                            valence: -1,
                            _pad: 0,
                            with: from as u32,
                            t: self.tick,
                            salience: 50000,
                            _pad2: 0,
                        });
                        // being struck stokes ANGER (decays in needs.rs) — the transient "fight back
                        // when provoked" that complements the persistent avenge grudge. Own-write.
                        self.mood[to].anger = (self.mood[to].anger + 0.35).min(1.0);
                        // OBSERVER: open/escalate the aggressor's vendetta arc against the victim.
                        self.sagas.open_or_touch(
                            crate::sagas::SagaKind::Vendetta,
                            from as u32,
                            to as u32,
                            self.tick,
                        );
                    }
                    // CAPTURE-ON-DEFEAT: a RAIDER's lethal blow on a TOWNSPERSON may take them captive
                    // instead of killing (a prisoner of the raid — freed when the captor falls). Spares
                    // the death + its witness fold; the captive is inert (decide) and held (no starve).
                    if self.combat[to].health <= 0.0
                        && from != to
                        && from < self.n
                        && self.alive[from]
                        && self.faction[from] == Faction::Raider as u8
                        && self.faction[to] == Faction::Townsfolk as u8
                        && self.captive_of[to] == CAPTIVE_NONE
                        && self.sim_rng.next_f32() < CAPTURE_CHANCE
                    {
                        self.captive_of[to] = from as i32;
                        self.combat[to].health = 1.0; // subdued, not slain
                        self.combat[to].state = crate::components::FighterState::Idle as u8;
                        // nearby townsfolk SEE the capture ⇒ believe `to` is held (the rescue seed).
                        self.fold_capture_witnesses(to);
                        continue; // captured — skip the death + slew/witness fold below
                    }
                    if self.combat[to].health <= 0.0 {
                        self.combat[to].health = 0.0;
                        self.combat[to].state = crate::components::FighterState::Dead as u8;
                        self.alive[to] = false;
                        // a death RESOLVES every open arc the deceased was a party to (a tyrant's fall,
                        // a lover's end) — observer bookkeeping.
                        self.sagas.close_subject(to as u32, self.tick);
                        // BOUNTY CLAIM: if the slain was the bounty's target, its slayer claims the fund
                        // (conserved: the held pool → the killer's purse). Clears the bounty.
                        if self.bounty_target == to as i32 && from != to && from < self.n {
                            self.econ[from].gold += self.bounty_fund;
                            self.bounty_fund = 0;
                            self.bounty_target = -1;
                        }
                        // The killer's `_slain` marker: an avenge intention against `to` is now
                        // SETTLED (it pops on this Slew episode rather than hunting a corpse).
                        if from != to && from < self.n {
                            self.memory[from].record(Episode {
                                kind: EpisodeKind::Slew as u8,
                                place: 0,
                                valence: 1,
                                _pad: 0,
                                with: to as u32,
                                t: self.tick,
                                salience: 60000,
                                _pad2: 0,
                            });
                            // fold a Kill into the killer's narrative-signal tallies (doc-13 foldDeed).
                            crate::signals::fold_deed(
                                &mut self.signals[from],
                                crate::components::DeedTag::Kill,
                                self.tick,
                            );
                            // BYSTANDERS LEARN: nearby townsfolk witness the killing and form beliefs
                            // about the killer (the combatEvents master fold — a killer's reputation
                            // now spreads via these witnesses, then gossip carries it further).
                            self.fold_kill_witnesses(from, to);
                            // OBSERVER: a slaying RESOLVES the vendetta between the two (either way it
                            // was burning) — the saga closes.
                            self.sagas.close(crate::sagas::SagaKind::Vendetta, from as u32, to as u32, self.tick);
                            self.sagas.close(crate::sagas::SagaKind::Vendetta, to as u32, from as u32, self.tick);
                            // a MURDER (folk slays folk) enlists an AVENGER who takes up the slain's cause.
                            if self.faction[from] == Faction::Townsfolk as u8
                                && self.faction[to] == Faction::Townsfolk as u8
                            {
                                self.enlist_avenger(from, to);
                            }
                        }
                    }
                }
                Intent::Hand { from, to, gold, good, qty } => {
                    let (f, t, g) = (from as usize, to as usize, good as usize);
                    if f >= self.n || t >= self.n || f == t {
                        continue;
                    }
                    // CONSERVED: move only what `from` actually holds (gold loop closed; goods relocate).
                    if gold > 0 && self.econ[f].gold >= gold {
                        self.econ[f].gold -= gold;
                        self.econ[t].gold += gold;
                    }
                    if qty > 0 && g < crate::components::N_COMMODITIES && self.econ[f].inventory[g] >= qty {
                        self.econ[f].inventory[g] -= qty;
                        self.econ[t].inventory[g] += qty;
                    }
                }
                Intent::Influence { from, to, warm } => {
                    // the plant_belief ability op: shift `to`'s believed standing toward `from`. A
                    // speaker's charm (warm > 0) warms it; a deceiver's rumor (warm < 0) sours it (not
                    // latched-hostile — a deceiver earns wariness, not open enmity). Serial ⇒ deterministic.
                    let (f, t) = (from as usize, to as usize);
                    if f >= self.n || t >= self.n || f == t {
                        continue;
                    }
                    if warm >= 0 {
                        self.warm_belief(t, from, warm);
                    } else {
                        self.sour_belief(t, from, -warm, false);
                    }
                }
                Intent::Deed { actor, verb, magnitude, target } => {
                    let actor = actor as usize;
                    if actor >= self.n {
                        continue;
                    }
                    // fold the deed into the actor's narrative-signal tallies (the doc-13 `foldDeed`):
                    // theft (rob), gift (give/pay). Kills are folded in the Strike merge above. Makes
                    // the signals catalog LIVE (observer telemetry; deterministic serial own-write).
                    let dtag = match verb {
                        12 => Some(crate::components::DeedTag::Theft),
                        10 | 11 => Some(crate::components::DeedTag::Gift),
                        14 => Some(crate::components::DeedTag::Rescue),
                        _ => None,
                    };
                    if let Some(t) = dtag {
                        crate::signals::fold_deed(&mut self.signals[actor], t, self.tick);
                    }
                    // a successful ROB (deed verb 12, from `systems::act`) stamps the robber's `Robbed`
                    // marker about the mark — the `_slain`-style signal that SETTLES the steal intention
                    // (`Atom::Took`). Serial own-write ⇒ deterministic.
                    if verb == 12 && (target as usize) < self.n && target as usize != actor {
                        self.memory[actor].record(Episode {
                            kind: EpisodeKind::Robbed as u8,
                            place: 0,
                            valence: 1,
                            _pad: 0,
                            with: target,
                            t: self.tick,
                            salience: 40000,
                            _pad2: 0,
                        });
                        // CAUTION windfall (doc 11): a heist that PAID emboldens the rob strategy
                        // (negative surcharge, shallow/diminishing) — the burned-hand's opposite. Own-write.
                        crate::experience::record_windfall(
                            &mut self.experience[actor].e[crate::planner::VERB_ROB as usize],
                            self.tick,
                        );
                        // signalsFold (doc 13): the PLAN_OUTCOME handler folds this resolved heist onto
                        // the agent's Heist streak signal ("third successful job in a row") — observer
                        // telemetry the saga/biography layer reads. Own-write, deterministic-serial.
                        crate::signals::fold_streak(
                            &mut self.signals[actor],
                            crate::components::StreakKey::Heist,
                            crate::components::OutcomeStatus::Ok,
                        );
                    }
                    // a LOOT deed (act verb 13) stamps the looter's `Looted` marker about the corpse —
                    // the marker that SETTLES the loot intention (like `Robbed` for the steal). Recovers
                    // the fallen's purse into circulation (the act `Hand` moved it conserved). Own-write.
                    if verb == 13 && (target as usize) < self.n && target as usize != actor {
                        self.memory[actor].record(Episode {
                            kind: EpisodeKind::Looted as u8,
                            place: 0,
                            valence: 1,
                            _pad: 0,
                            with: target,
                            t: self.tick,
                            salience: 35000,
                            _pad2: 0,
                        });
                    }
                    // a FREE deed (act verb 14) cuts a captive's bonds: release the target (captive_of →
                    // free), stamp the rescuer's `Freed` marker (settles its rescue intention), and clear
                    // the rescuer's "captive" belief flag about the freed soul. Serial ⇒ deterministic.
                    if verb == 14 && (target as usize) < self.n && target as usize != actor {
                        let t = target as usize;
                        if self.captive_of[t] != CAPTIVE_NONE {
                            self.captive_of[t] = CAPTIVE_NONE;
                        }
                        self.memory[actor].record(Episode {
                            kind: EpisodeKind::Freed as u8,
                            place: 0,
                            valence: 1,
                            _pad: 0,
                            with: target,
                            t: self.tick,
                            salience: 45000,
                            _pad2: 0,
                        });
                        if let Some(ix) = self.beliefs[actor].find(target) {
                            self.beliefs[actor].bodies[ix].flags &= !0x02; // no longer believed captive
                        }
                        // OBSERVER: a rescue is its own (closed, one-beat) saga.
                        self.sagas.record(crate::sagas::SagaKind::Rescue, actor as u32, target, self.tick);
                    }
                    // a GIVE/PAY deed (act verbs 10/11) stamps the donor's `Gave` marker (settles its
                    // donate/repay) AND a `Succoured` memory on the RECIPIENT (who may repay later) —
                    // the alms→succoured→repay chain. Serial own-writes ⇒ deterministic.
                    if (verb == 10 || verb == 11) && (target as usize) < self.n && target as usize != actor {
                        self.memory[actor].record(Episode {
                            kind: EpisodeKind::Gave as u8,
                            place: 0,
                            valence: 1,
                            _pad: 0,
                            with: target,
                            t: self.tick,
                            salience: 30000,
                            _pad2: 0,
                        });
                        self.memory[target as usize].record(Episode {
                            kind: EpisodeKind::Succoured as u8,
                            place: 0,
                            valence: 1,
                            _pad: 0,
                            with: actor as u32,
                            t: self.tick,
                            salience: 45000,
                            _pad2: 0,
                        });
                        // RECIPROCITY (the sentiment arm): the beneficiary WARMS its `standing` toward
                        // the benefactor — a believed-generous motive folds to trust (the mirror of the
                        // murder-souring witness fold). Drives the donate/repay loop's affect, not just
                        // its bookkeeping. Own-write on the recipient's belief about the donor.
                        self.warm_belief(target as usize, actor as u32, RECIPROCITY_WARMTH);
                        // and BYSTANDERS admire the generous act (the heroism-witness mirror): nearby
                        // living townsfolk who perceive the gift warm a little toward the giver.
                        self.fold_gift_witnesses(actor, target as usize);
                    }
                    // Fold the deed (magnitude-scaled, tag-indexed) into the ACTOR's OWN
                    // behaviour profile, HERE in the deterministic serial merge. This is the
                    // coordination point: `drain_intents` clears the queue, so progression can't
                    // read deeds afterward — instead we accumulate into the own-column right where
                    // the deeds are already being visited in fixed sort order. A pure own-write
                    // per actor (no cross-agent dependency) ⇒ order-independent ⇒ deterministic.
                    // The periodic decay + class-match + XP routing then runs in `progression::tick`.
                    crate::systems::progression::fold_deed(
                        &mut self.progression[actor],
                        verb,
                        magnitude,
                    );
                }
            }
        }
        self.intents.items = items;
        self.intents.clear();
    }

    /// One full tick — the §4 schedule. Cognition phases are per-entity parallel (own-write); the
    /// cross-agent merge is serial + deterministic. Systems are filled by the fan-out.
    pub fn tick(&mut self) {
        systems::needs::drain(self); // parallel: own needs decay + in-place verbs
        crate::reason::reason(self); // parallel: reactive flee/hide overlay (pre-empts decide)
        systems::decide::decide(self); // parallel: own goal from needs/beliefs
        systems::locomotion::step(self); // parallel: own pos toward goal
        self.build_surface(); // serial: project + grid
        perceive(self); // parallel: own beliefs
        self.snapshot_beliefs(); // serial: freeze the read set for gossip
        systems::gossip::gossip(self); // parallel: read prev beliefs, write own
        systems::combat::resolve(self); // parallel decide → Strike intents
        crate::abilities::cast(self); // parallel NPC autocast → extra Strike intents / self-buff own-writes
        self.newsread(); // parallel: fold the gazette's published prices into own price beliefs
        systems::market::clear(self); // parallel decide → Transfer intents
        systems::act::act(self); // parallel on-arrival interaction verbs → Hand/Deed intents
        self.drain_intents(); // serial deterministic merge
        self.release_freed_captives(); // serial: a prisoner whose captor fell is freed
        self.sagas.sweep(self.tick); // serial: drop stale closed sagas (observer registry upkeep)
        systems::progression::tick(self); // parallel: own progression from deeds
        self.society_phase(); // serial: director/lineage/faith/groups/quests/chronicle
        self.tick += 1;
    }

    /// Free any captive whose captor is no longer a living threat (dead / out of bounds) — the prison
    /// falls when the raider holding it does. Serial O(n) sweep ⇒ trivially M-invariant. A freed captive
    /// resumes normal life (decide stops short-circuiting it to Idle once `captive_of == CAPTIVE_NONE`).
    fn release_freed_captives(&mut self) {
        for i in 0..self.n {
            let cap = self.captive_of[i];
            if cap == CAPTIVE_NONE {
                continue;
            }
            let c = cap as usize;
            if c >= self.n || !self.alive[c] {
                self.captive_of[i] = CAPTIVE_NONE; // captor gone ⇒ released
            }
        }
    }

    /// SERIAL society/observer phase (Wave 3): throttled passes that mutate the shared world
    /// (spawn raiders/births, form bands, convert faith, post/complete quests, log history).
    /// Serial ⇒ trivially M-invariant; spawns go through `spawn_agent`; gold is never minted.
    fn society_phase(&mut self) {
        systems::chronicle::tick(self);
        systems::director::tick(self);
        systems::tropes::tick(self); // relationship-trope engine (reunion/betrayal/feud/house-feud…)
        systems::patrician::tick(self); // brokers truces between the most mutually-hostile townsfolk
        systems::watch::tick(self); // musters/stands-down the Night Watch by threat (hysteresis)
        systems::intrigue::tick(self); // spies: disguise masks, false-belief/price plants, unmask
        systems::defenses::tick(self); // watchtower ring fires on apparent town-hostiles near the core
        systems::expeditions::tick(self); // musters/marches/resolves wilderness adventuring companies
        systems::lineage::tick(self);
        systems::faith::tick(self);
        systems::groups::tick(self);
        systems::quests::tick(self);
        if self.tick % ESCHEAT_EVERY == 0 {
            self.escheat_estates(); // a heirless corpse's stranded purse passes to a living heir
        }
        if self.tick % EPITHET_EVERY == 0 {
            systems::houses::earn_epithets(self); // brand hero/villain/survivor from accumulated deeds
        }
        self.forget_recipes(); // use-it-or-lose-it: an unpractised craft skill fades (only the bonus)
        if self.tick % STUDY_EVERY == 0 {
            self.study_recipes(); // the taught route: a rusty crafter learns from a co-located master
        }
        if self.tick % GAZETTE_EVERY == 0 {
            self.publish_gazette(); // the town newspaper goes to press (an edition of briefs + prices)
            systems::chronicle::file_report(self); // the reporter files the cycle's market story
        }
        if self.tick % BOUNTY_EVERY == 0 {
            self.post_bounty(); // post/refresh a town bounty on a threat to the core (a funded reward)
        }
        if self.tick % CARAVAN_EVERY == 0 {
            self.run_caravan(); // a merchant trades the price spread with the external market (arbitrage)
        }
        if self.tick % OCCUPATION_EVERY == 0 {
            self.choose_occupations(); // self-balancing trade reallocation (food-protected)
        }
        if self.tick % BIOGRAPHY_EVERY == 0 {
            self.update_biographies(); // roll each life's deeds/drive/rank into its biographical summary
        }
    }

    /// BIOGRAPHY rollup (`js/sim/biography.js`, the observer): fold each LIVING agent's own state into a
    /// compact who-they-were row — peak level (monotone), earned epithet, arc role, archetypal drive, and
    /// the deed-tag it has committed MOST (its defining act), with a cumulative notable-deed total. Pure
    /// observer telemetry (reads truth, writes only `biographies`); serial id-order ⇒ deterministic.
    fn update_biographies(&mut self) {
        if self.biographies.len() != self.n {
            self.biographies
                .resize(self.n, crate::components::Biography::default());
        }
        for i in 0..self.n {
            if !self.alive[i] {
                continue; // a death freezes the biography at its final state (the eulogy reads it)
            }
            let bio = &mut self.biographies[i];
            // peak level only ever rises (a life's high-water mark, not a current snapshot).
            let lvl = self.progression[i].total_level.min(u8::MAX as u16) as u8;
            if lvl > bio.peak_level {
                bio.peak_level = lvl;
            }
            bio.epithet = self.epithet[i];
            bio.role = self.role[i];
            bio.drive = self.ambition[i];
            // the DEFINING deed: the tag this soul has done most (ties broken by lowest tag index).
            let sig = &self.signals[i];
            let mut best_tag = 0xFFu8;
            let mut best_n = 0u32;
            let mut total = 0u32;
            for t in 0..crate::components::N_DEED_TAGS {
                let n = sig.deeds[t].n;
                total += n;
                if n > best_n {
                    best_n = n;
                    best_tag = t as u8;
                }
            }
            bio.dominant_deed = best_tag;
            // the notable-deed total is monotone (it only accrues over a life).
            let total = total.min(u16::MAX as u32) as u16;
            if total > bio.deed_total {
                bio.deed_total = total;
            }
        }
    }

    /// DYNAMIC OCCUPATION (`agent/occupation.ts chooseOccupation`, the saturation half): the town's
    /// workforce self-balances — an agent in an OVER-supplied trade may RETRAIN into the most
    /// UNDER-supplied one (resetting its recipe skill; learn-by-doing rebuilds it). Gradual (one switch
    /// per pass, rng-gated) and FOOD-PROTECTED (never sheds the farmers below a floor — the marginal-
    /// economy staple stays staffed). Serial, `sim_rng`-gated in fixed order ⇒ deterministic.
    fn choose_occupations(&mut self) {
        const OVER_FACTOR: f32 = 1.5; // a trade with > this × average is "over-supplied"
        const SWITCH_CHANCE: f32 = 0.5; // per-pass probability that one retraining happens
        const FARMER: u8 = 1;
        // count practitioners per profession (1..=6) among living townsfolk.
        let mut counts = [0usize; crate::world::N_WORK_SITES];
        let mut workers = 0usize;
        for i in 0..self.n {
            let p = self.profession[i] as usize;
            if self.alive[i] && self.faction[i] == Faction::Townsfolk as u8 && p >= 1 && p < counts.len() {
                counts[p] += 1;
                workers += 1;
            }
        }
        if workers < 12 {
            return; // too small a workforce to bother rebalancing
        }
        // the least-supplied trade (1..=6).
        let mut under = 1usize;
        for p in 2..counts.len() {
            if counts[p] < counts[under] {
                under = p;
            }
        }
        let avg = workers as f32 / 6.0;
        if (counts[under] as f32) >= avg * 0.8 {
            return; // already balanced enough — leave the workforce be
        }
        if self.sim_rng.next_f32() >= SWITCH_CHANCE {
            return; // gradual: not every pass retrains someone
        }
        let farmer_floor = (workers as f32 * 0.18) as usize; // keep the staple staffed
        // pick an over-supplied agent to retrain (a rotated id-order scan ⇒ fair + deterministic).
        let start = (self.sim_rng.next_f32() * self.n as f32) as usize;
        for k in 0..self.n {
            let i = (start + k) % self.n;
            let p = self.profession[i] as usize;
            if !self.alive[i] || self.faction[i] != Faction::Townsfolk as u8 || p == 0 || p == under {
                continue;
            }
            if (counts[p] as f32) <= avg * OVER_FACTOR {
                continue; // only shed from a genuinely over-supplied trade
            }
            if p as u8 == FARMER && counts[FARMER as usize] <= farmer_floor {
                continue; // FOOD PROTECTION: never thin the farmers below the floor
            }
            self.profession[i] = under as u8; // retrain into the under-supplied trade
            // CROSS-CRAFT: keep the per-good recipe skills — a switcher who once practised the new craft
            // is still skilled at it; one long-unpractised is rusty (its recipe has faded). No reset.
            return; // one retraining per pass (gradual)
        }
    }

    /// Publish a fresh GAZETTE edition (the brief/edition core of `gazette.ts`): snapshot the recent
    /// chronicle into briefs + a price board = the MEDIAN believed price of each good across living
    /// townsfolk (robust + integer ⇒ deterministic). Serial society-phase pass; observer-only.
    fn publish_gazette(&mut self) {
        let mut prices = [0u16; crate::components::N_COMMODITIES];
        for g in 0..crate::components::N_COMMODITIES {
            let mut vals: Vec<u16> = (0..self.n)
                .filter(|&i| self.alive[i] && self.faction[i] == Faction::Townsfolk as u8)
                .map(|i| {
                    let pb = self.econ[i].price_belief[g];
                    if pb > 0 { pb } else { self.base_price[g].clamp(1, u16::MAX as i64) as u16 }
                })
                .collect();
            prices[g] = crate::gazette::median_u16(&mut vals);
        }
        self.gazette.publish(&self.chronicle, prices);
    }

    /// NEWSREAD (`features/newsread.ts`): a living townsperson folds the GAZETTE's published price board
    /// into its OWN price beliefs — a market shock ripples out through the NEWS, not just direct
    /// perception (doc-05 "information as a resource"). A gentle EMA pull; own-write per agent reading a
    /// FROZEN gazette snapshot ⇒ M-invariant. Conserved (beliefs only — no gold moves).
    fn newsread(&mut self) {
        use rayon::prelude::*;
        const NEWS_PULL: f32 = 0.10;
        let gprices = self.gazette.prices; // a Copy snapshot — frozen, read-only across the parallel pass
        let faction = &self.faction;
        let alive = &self.alive;
        self.econ.par_iter_mut().enumerate().for_each(|(i, e)| {
            if !alive[i] || faction[i] != Faction::Townsfolk as u8 {
                return;
            }
            // Skip FOOD (commodity 0): the survival-critical food trade is left to direct price
            // discovery — converging its belief via the news destabilised the marginal economy (the
            // survival-regression lesson). The news moves the SECONDARY goods' beliefs only.
            for g in 1..crate::components::N_COMMODITIES {
                if gprices[g] > 0 {
                    let cur = e.price_belief[g] as f32;
                    let next = cur + (gprices[g] as f32 - cur) * NEWS_PULL;
                    e.price_belief[g] = next.clamp(1.0, u16::MAX as f32) as u16;
                }
            }
        });
    }

    /// FORGET PASS (recipeKnow.ts `forgetTick`): a recipe skill not refreshed by practice fades slowly
    /// (use-it-or-lose-it). Because the recipe only ever ADDS a mastery bonus on top of baseline output,
    /// a fade can at worst remove that bonus — it NEVER reduces baseline production (economy-safe).
    /// Serial own-write ⇒ deterministic.
    fn forget_recipes(&mut self) {
        const RECIPE_FORGET: f32 = 0.0008;
        for arr in self.recipe.iter_mut() {
            for r in arr.iter_mut() {
                *r = (*r - RECIPE_FORGET).max(0.0); // every craft's skill fades unless practised
            }
        }
    }

    /// STUDY + ASK CHANNELS (the knowledge model's taught/asked routes, `features/learning.ts`): a rusty
    /// crafter co-located with a same-craft peer firms its recipe — STUDY under a MASTER (the bigger
    /// gain, paying CONSERVED tuition), or, failing a master, ASK a more-skilled peer (a smaller, vaguer
    /// bump, no tuition — you just ask around). Study is preferred; ask is the fallback. Serial ⇒
    /// deterministic; conserved (gold only moved for tuition); economy-safe (recipe only adds a bonus).
    fn study_recipes(&mut self) {
        const STUDY_GAIN: f32 = 0.12;
        const ASK_GAIN: f32 = 0.04; // the ask channel: vaguer than study, no teacher/tuition needed
        const TUITION: i64 = 500; // minor units, conserved teacher↔student
        const RANGE2: f32 = 8.0 * 8.0;
        const MASTER_BAR: f32 = 0.8;
        for student in 0..self.n {
            let prof = self.profession[student];
            // the craft's good (the recipe slot the lesson firms — cross-craft: indexed PER GOOD).
            let g = match crate::world::prof_good(prof) {
                Some(g) => g,
                None => continue,
            };
            if !self.alive[student] || self.recipe[student][g] >= MASTER_BAR {
                continue; // only a still-learning crafter learns
            }
            let spos = self.pos[student];
            let mut master: Option<usize> = None;
            let mut peer: Option<usize> = None; // a more-skilled (but non-master) co-located peer
            for other in 0..self.n {
                if other == student || self.profession[other] != prof || !self.alive[other] {
                    continue;
                }
                let dx = self.pos[other][0] - spos[0];
                let dz = self.pos[other][1] - spos[1];
                if dx * dx + dz * dz > RANGE2 {
                    continue;
                }
                if self.recipe[other][g] >= MASTER_BAR {
                    master = Some(other);
                    break; // a master is the best teacher — take them
                } else if self.recipe[other][g] > self.recipe[student][g] && peer.is_none() {
                    peer = Some(other); // remember the first more-skilled peer (the ask fallback)
                }
            }
            if let Some(teacher) = master {
                self.recipe[student][g] = (self.recipe[student][g] + STUDY_GAIN).min(1.0); // taught
                if self.econ[student].gold >= TUITION {
                    self.econ[student].gold -= TUITION; // conserved tuition to the teacher
                    self.econ[teacher].gold += TUITION;
                }
            } else if peer.is_some() {
                self.recipe[student][g] = (self.recipe[student][g] + ASK_GAIN).min(1.0); // asked
            }
        }
    }

    /// ESCHEAT (combatEvents `_reapCorpses` heir-pass): a DEAD agent's un-looted purse is stranded out
    /// of the closed money loop forever. This passes it to a living HEIR — a kinsman of the same house
    /// first, else the nearest living townsperson (the estate escheats to the town). Conserved (gold
    /// only MOVES). Throttled so a fresh corpse still has a window to be LOOTED before its estate passes.
    /// Serial id-order ⇒ deterministic.
    fn escheat_estates(&mut self) {
        for i in 0..self.n {
            if self.alive[i] || self.econ[i].gold <= 0 {
                continue; // only the dead with a purse left to settle
            }
            let mut heir: Option<usize> = None;
            // 1. a living kinsman of the same house (lowest id — deterministic).
            let house = self.house[i];
            if house != 0 {
                for h in 0..self.n {
                    if h != i && self.alive[h] && self.house[h] == house {
                        heir = Some(h);
                        break;
                    }
                }
            }
            // 2. else the nearest living townsperson (the estate escheats to the town).
            if heir.is_none() {
                let mut best = (f32::INFINITY, usize::MAX);
                for h in 0..self.n {
                    if h == i || !self.alive[h] || self.faction[h] != Faction::Townsfolk as u8 {
                        continue;
                    }
                    let dx = self.pos[h][0] - self.pos[i][0];
                    let dz = self.pos[h][1] - self.pos[i][1];
                    let d2 = dx * dx + dz * dz;
                    if d2 < best.0 || (d2 == best.0 && h < best.1) {
                        best = (d2, h);
                    }
                }
                if best.1 != usize::MAX {
                    heir = Some(best.1);
                }
            }
            if let Some(h) = heir {
                let purse = self.econ[i].gold;
                self.econ[i].gold -= purse;
                self.econ[h].gold += purse;
            }
        }
    }

    /// Like `tick`, but returns the wall-seconds spent in `perceive` (the spike's measured cost,
    /// for `soak_bench`). Mirrors `tick`'s phase order exactly.
    pub fn step_timing(&mut self) -> f64 {
        systems::needs::drain(self);
        crate::reason::reason(self);
        systems::decide::decide(self);
        systems::locomotion::step(self);
        self.build_surface();
        let t0 = std::time::Instant::now();
        perceive(self);
        let dt = t0.elapsed().as_secs_f64();
        self.snapshot_beliefs();
        systems::gossip::gossip(self);
        systems::combat::resolve(self);
        crate::abilities::cast(self);
        self.newsread();
        systems::market::clear(self);
        systems::act::act(self);
        self.drain_intents();
        self.release_freed_captives();
        self.sagas.sweep(self.tick);
        systems::progression::tick(self);
        self.society_phase();
        self.tick += 1;
        dt
    }

    /// Total gold across the roster (purse + stash) PLUS any gold held in the town bounty fund — the
    /// conservation invariant. A bounty levy moves gold from purses INTO the fund and a claim moves it
    /// back out, so the fund must count or the invariant would spuriously break mid-bounty.
    pub fn total_gold(&self) -> i64 {
        self.econ.iter().map(|e| e.gold + e.stash).sum::<i64>() + self.bounty_fund + self.caravan_treasury
    }

    /// RUN A CARAVAN (`arbitrage.ts` / caravans, the single-town form): a merchant trades with an
    /// EXTERNAL market across a price DIFFERENTIAL — EXPORTING the town's most-surplus non-food good at a
    /// premium (the external market pays the merchant from its `caravan_treasury`) and IMPORTING a luxury
    /// the town pays the external market for. The merchant profits on the spread; goods (un-conserved)
    /// leave/arrive, gold only MOVES between the merchant and the held treasury ⇒ conserved. Food is
    /// NEVER exported (the survival-critical staple stays home). Serial society pass ⇒ deterministic.
    fn run_caravan(&mut self) {
        use crate::components::N_COMMODITIES;
        const EXPORT_QTY: i32 = 4;
        const EXPORT_PREMIUM: i64 = 130; // %: the external market pays 1.3× the home base price
        const IMPORT_QTY: i32 = 2;
        const IMPORT_MARKUP: i64 = 140; // %: the town pays 1.4× to import the luxury
        const LUXURY: usize = 5; // Potion — the imported luxury
        // the caravan merchant = the richest living townsperson (id-order tie-break).
        let mut merchant: Option<usize> = None;
        let mut best_gold = i64::MIN;
        for i in 0..self.n {
            if self.alive[i] && self.faction[i] == Faction::Townsfolk as u8 && self.econ[i].gold > best_gold {
                best_gold = self.econ[i].gold;
                merchant = Some(i);
            }
        }
        let m = match merchant {
            Some(m) => m,
            None => return,
        };
        // EXPORT: the merchant's largest NON-FOOD surplus good (g≥1), sold abroad at a premium.
        let mut eg = 0usize;
        let mut emax = EXPORT_QTY; // require at least an export load
        for g in 1..N_COMMODITIES {
            if self.econ[m].inventory[g] >= emax {
                emax = self.econ[m].inventory[g];
                eg = g;
            }
        }
        if eg != 0 {
            let revenue = self.base_price[eg] * EXPORT_QTY as i64 * EXPORT_PREMIUM / 100;
            if self.caravan_treasury >= revenue {
                self.econ[m].inventory[eg] -= EXPORT_QTY; // goods leave with the caravan
                self.econ[m].gold += revenue;
                self.caravan_treasury -= revenue; // the external market pays
            }
        }
        // IMPORT: bring back a luxury the merchant pays the external market for (gold → treasury).
        let cost = self.base_price[LUXURY] * IMPORT_QTY as i64 * IMPORT_MARKUP / 100;
        if self.econ[m].gold >= cost {
            self.econ[m].gold -= cost;
            self.caravan_treasury += cost;
            self.econ[m].inventory[LUXURY] += IMPORT_QTY; // goods arrive with the caravan
        }
    }

    /// POST A BOUNTY (`bounties.ts`): when a hostile MONSTER/RAIDER is menacing the town core and no
    /// bounty is live, the town pledges a reward on its head — a CONSERVED levy from the wealthiest few
    /// townsfolk into the held `bounty_fund`. Whoever slays the target claims the fund (paid in the kill
    /// branch). A real news-driven labour market: the moneyed pay to be rid of a threat, a fighter earns
    /// it. Serial society pass ⇒ deterministic; gold only MOVES (purses → fund).
    fn post_bounty(&mut self) {
        const LEVY: i64 = 300;
        const CONTRIBUTORS: usize = 4;
        const THREAT_RANGE2: f32 = 200.0 * 200.0;
        // an existing bounty stands until its target falls (the kill branch clears it); just tidy a
        // target that died/escaped to another cause.
        if self.bounty_target != -1 {
            let t = self.bounty_target as usize;
            if t >= self.n || !self.alive[t] {
                self.bounty_target = -1; // claimed/gone — the fund rolls over to the next posting
            }
            return;
        }
        // find a living monster/raider menacing the town core.
        let core = self.town_center;
        let mut target: Option<usize> = None;
        for i in 0..self.n {
            let f = self.faction[i];
            if self.alive[i] && (f == Faction::Monster as u8 || f == Faction::Raider as u8) {
                let dx = self.pos[i][0] - core[0];
                let dz = self.pos[i][1] - core[1];
                if dx * dx + dz * dz <= THREAT_RANGE2 {
                    target = Some(i);
                    break;
                }
            }
        }
        if let Some(tg) = target {
            // levy from the first CONTRIBUTORS able townsfolk (id order — deterministic).
            let mut pledged = 0i64;
            let mut taken = 0usize;
            for c in 0..self.n {
                if taken >= CONTRIBUTORS {
                    break;
                }
                if self.alive[c] && self.faction[c] == Faction::Townsfolk as u8 && self.econ[c].gold >= LEVY {
                    self.econ[c].gold -= LEVY;
                    pledged += LEVY;
                    taken += 1;
                }
            }
            if pledged > 0 {
                self.bounty_fund += pledged;
                self.bounty_target = tg as i32;
            }
        }
    }

    // ── shared belief-seed helpers (the society/observer wave's `_plant`/`_sour`/`_warm`) ──
    // A society pass (director/patrician/intrigue/houses/seeding) narrates by SEEDING beliefs, never by
    // driving an agent's own decision — the epistemic split holds (observer layer). These run SERIALLY
    // in the society phase, so direct cross-row belief writes are deterministic.

    /// Find or insert `observer`'s belief cell about `subject`, seeding a fresh one from the subject's
    /// current cues. Returns the index, or `None` if the table is full (perception beliefs aren't evicted).
    pub fn ensure_belief(&mut self, observer: usize, subject: u32) -> Option<usize> {
        let s = subject as usize;
        if observer >= self.n || s >= self.n || s == observer {
            return None;
        }
        let (spos, sfac, slvl, now) = (self.pos[s], self.faction[s], self.level[s], self.tick);
        let bt = &mut self.beliefs[observer];
        if let Some(ix) = bt.find(subject) {
            return Some(ix);
        }
        let len = bt.len as usize;
        if len < crate::components::BELIEF_CAP {
            bt.subjects[len] = subject;
            bt.bodies[len] = crate::components::PersonBelief {
                subject,
                last_x: spos[0],
                last_z: spos[1],
                confidence: 40_000,
                faction: sfac,
                level: slvl,
                notoriety: 0,
                threat: 0,
                wealth: 0,
                last_tick: now,
                standing: 0,
                flags: 0,
                _pad: 0,
            };
            bt.len += 1;
            return Some(len);
        }
        None
    }

    /// Sour `observer`'s belief-standing toward `subject` (a grievance seed); optionally latch hostility.
    pub fn sour_belief(&mut self, observer: usize, subject: u32, drop: i16, hostile: bool) {
        if let Some(ix) = self.ensure_belief(observer, subject) {
            let b = &mut self.beliefs[observer].bodies[ix];
            b.standing = b.standing.saturating_sub(drop);
            if hostile {
                b.flags |= 0x01;
            }
            if b.confidence < 26_000 {
                b.confidence = 26_000;
            }
        }
    }

    /// COMBAT-EVENTS WITNESS FOLD (the master `onCombatEvents` bystander half, `js/sim/combatEvents.ts`):
    /// when `victim` falls to `killer`, every nearby TOWNSPERSON who could see it forms a belief — the
    /// epistemic seed that makes a killer's reputation SPREAD (gossip then carries it further). Without
    /// this only the victim+killer learned, so a murderer walked away anonymous. Serial id-order scan in
    /// `drain_intents` ⇒ deterministic cross-row writes; own-writes per witness (memory + belief).
    ///
    /// What a witness takes away depends on WHO died:
    /// - a neighbour murdered by another townsperson ⇒ grief (`WitnessedDeath`) + the killer is now
    ///   believed a hostile MURDERER (soured + latched) — witnesses fear/flee/gossip them.
    /// - a neighbour taken by a monster/raider ⇒ grief + reinforced fear of the predator.
    /// - a monster/raider slain by a townsperson ⇒ ADMIRATION of the slayer (warmed standing) — the
    ///   emergent renown of a monster-hunter.
    fn fold_kill_witnesses(&mut self, killer: usize, victim: usize) {
        const WITNESS_RANGE2: f32 = 30.0 * 30.0;
        let vpos = self.pos[victim];
        let vfac = self.faction[victim];
        let kfac = if killer < self.n { self.faction[killer] } else { 255 };
        let tf = Faction::Townsfolk as u8;
        let victim_is_folk = vfac == tf;
        for w in 0..self.n {
            if w == killer || w == victim || !self.alive[w] || self.faction[w] != tf {
                continue; // only living townsfolk witness, grieve, and gossip
            }
            let dx = self.pos[w][0] - vpos[0];
            let dz = self.pos[w][1] - vpos[1];
            if dx * dx + dz * dz > WITNESS_RANGE2 {
                continue;
            }
            // grief for a fallen neighbour (drives the grieve disposition). Not for a slain monster.
            if victim_is_folk {
                self.memory[w].record(Episode {
                    kind: EpisodeKind::WitnessedDeath as u8,
                    place: 0,
                    valence: -1,
                    _pad: 0,
                    with: victim as u32,
                    t: self.tick,
                    salience: 48_000,
                    _pad2: 0,
                });
            }
            // the reputational fold on the KILLER (belief-seed; gossip spreads it).
            if killer < self.n {
                if victim_is_folk && kfac == tf {
                    self.sour_belief(w, killer as u32, 3_500, true); // a murderer among us
                } else if victim_is_folk {
                    self.sour_belief(w, killer as u32, 2_000, true); // a predator that took a neighbour
                } else if kfac == tf {
                    self.warm_belief(w, killer as u32, 1_500); // a townsperson who slew a monster — a hero
                }
            }
        }
    }

    /// CAPTURE-WITNESS fold: when `captive` is taken, nearby living townsfolk form/refresh a belief that
    /// it is HELD (PersonBelief flag 0x02) at its last-seen spot — the epistemic seed a would-be rescuer
    /// reads to mount a rescue. Serial id-order scan in `drain_intents` ⇒ deterministic cross-row writes.
    fn fold_capture_witnesses(&mut self, captive: usize) {
        const WITNESS_RANGE2: f32 = 30.0 * 30.0;
        let cpos = self.pos[captive];
        let tf = Faction::Townsfolk as u8;
        for w in 0..self.n {
            if w == captive || !self.alive[w] || self.faction[w] != tf {
                continue;
            }
            let dx = self.pos[w][0] - cpos[0];
            let dz = self.pos[w][1] - cpos[1];
            if dx * dx + dz * dz > WITNESS_RANGE2 {
                continue;
            }
            if let Some(ix) = self.ensure_belief(w, captive as u32) {
                let b = &mut self.beliefs[w].bodies[ix];
                b.flags |= 0x02; // believed captive
                b.last_x = cpos[0];
                b.last_z = cpos[1];
                if b.confidence < 40_000 {
                    b.confidence = 40_000;
                }
            }
        }
    }

    /// ENLIST AN AVENGER (the director's avenger role machinery): when a townsperson is MURDERED by
    /// another townsperson, a living kinsman (same house) — or, failing that, a dear believed-friend —
    /// takes up the slain's cause. They gain an `Assaulted` memory about the killer (the avenge deriver's
    /// seed, so they HUNT the murderer through the existing GOAP loop) + a latched-hostile belief, and
    /// wear the `ROLE_AVENGER` mark. Serial id-order in `drain_intents` ⇒ deterministic. At most one
    /// avenger per murder (the nearest in id order). Composes the murder → avenger → vendetta arc.
    fn enlist_avenger(&mut self, killer: usize, victim: usize) {
        let tf = Faction::Townsfolk as u8;
        let mut avenger: Option<usize> = None;
        // 1. a living KINSMAN of the slain (same house).
        let vhouse = self.house[victim];
        if vhouse != 0 {
            for h in 0..self.n {
                if h != killer && h != victim && self.alive[h] && self.faction[h] == tf && self.house[h] == vhouse {
                    avenger = Some(h);
                    break;
                }
            }
        }
        // 2. else a dear believed-FRIEND of the slain (someone who held them in high regard).
        if avenger.is_none() {
            for h in 0..self.n {
                if h == killer || h == victim || !self.alive[h] || self.faction[h] != tf {
                    continue;
                }
                if self.beliefs[h].find(victim as u32).map_or(false, |ix| {
                    self.beliefs[h].bodies[ix].standing > AVENGER_FRIEND_BAR
                }) {
                    avenger = Some(h);
                    break;
                }
            }
        }
        if let Some(av) = avenger {
            self.memory[av].record(Episode {
                kind: EpisodeKind::Assaulted as u8, // the avenge-deriver seed (they hunt the killer)
                place: 0,
                valence: -1,
                _pad: 0,
                with: killer as u32,
                t: self.tick,
                salience: 55000,
                _pad2: 0,
            });
            self.sour_belief(av, killer as u32, AVENGER_SOUR, true); // believe the killer a hostile foe
            self.role[av] = ROLE_AVENGER;
        }
    }

    /// Warm `observer`'s belief-standing toward `subject` (a real warming un-latches hostility).
    pub fn warm_belief(&mut self, observer: usize, subject: u32, amt: i16) {
        if let Some(ix) = self.ensure_belief(observer, subject) {
            let b = &mut self.beliefs[observer].bodies[ix];
            b.standing = b.standing.saturating_add(amt);
            if amt > 0 {
                b.flags &= !0x01;
            }
            if b.confidence < 26_000 {
                b.confidence = 26_000;
            }
        }
    }

    /// RECIPROCITY witness fold (the generosity mirror of `fold_kill_witnesses`): nearby living
    /// townsfolk who perceive a gift WARM a little toward the giver — generosity earns believed
    /// goodwill, just as murder earns believed enmity. Serial id-order scan in `drain_intents` ⇒
    /// deterministic cross-row writes; own-write per witness on its belief about the donor.
    fn fold_gift_witnesses(&mut self, donor: usize, recipient: usize) {
        const WITNESS_RANGE2: f32 = 30.0 * 30.0;
        let dpos = self.pos[donor];
        let tf = Faction::Townsfolk as u8;
        for w in 0..self.n {
            if w == donor || w == recipient || !self.alive[w] || self.faction[w] != tf {
                continue;
            }
            let dx = self.pos[w][0] - dpos[0];
            let dz = self.pos[w][1] - dpos[1];
            if dx * dx + dz * dz > WITNESS_RANGE2 {
                continue;
            }
            self.warm_belief(w, donor as u32, RECIPROCITY_BYSTANDER_WARMTH);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{EpisodeKind, Faction};

    /// COMBAT-EVENTS WITNESS FOLD: a townsperson murdered by another townsperson, seen by a nearby
    /// neighbour, leaves that witness grieving AND believing the killer is a hostile murderer (the
    /// reputational seed). A far-off townsperson learns nothing (out of sight).
    #[test]
    fn witnesses_learn_a_murderer() {
        let mut w = World::spawn(0x5177, 8);
        let (killer, victim, near, far) = (0usize, 1usize, 2usize, 3usize);
        for &i in &[killer, victim, near, far] {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.beliefs[i].clear();
            w.memory[i] = crate::components::Memory::default();
        }
        w.pos[victim] = [0.0, 0.0];
        w.pos[killer] = [1.0, 0.0];
        w.pos[near] = [5.0, 0.0]; // within witness range
        w.pos[far] = [400.0, 0.0]; // far out of sight
        w.combat[victim].health = 1.0; // a single strike fells the victim
        w.intents.push(Intent::Strike { from: killer as u32, to: victim as u32, dmg: 10.0 });
        w.drain_intents();

        assert!(!w.alive[victim], "the victim fell");
        assert!(
            w.memory[near].has(EpisodeKind::WitnessedDeath, victim as u32),
            "the near witness grieves the fallen neighbour"
        );
        let b = w.beliefs[near].find(killer as u32).expect("the witness now holds a belief about the killer");
        assert!(
            w.beliefs[near].bodies[b].flags & 0x01 != 0,
            "the witness believes the killer is a hostile murderer"
        );
        assert!(
            w.beliefs[far].find(killer as u32).is_none(),
            "a far-off townsperson out of sight learns nothing"
        );
    }

    /// A townsperson who slays a MONSTER is admired by nearby townsfolk (warmed standing) — the
    /// emergent renown of a monster-hunter (the heroism half of the witness fold).
    #[test]
    fn witnesses_admire_a_monster_slayer() {
        let mut w = World::spawn(0x5178, 8);
        let (hero, beast, near) = (0usize, 1usize, 2usize);
        w.faction[hero] = Faction::Townsfolk as u8;
        w.faction[beast] = Faction::Monster as u8;
        w.faction[near] = Faction::Townsfolk as u8;
        for &i in &[hero, beast, near] {
            w.alive[i] = true;
            w.beliefs[i].clear();
        }
        w.pos[beast] = [0.0, 0.0];
        w.pos[hero] = [1.0, 0.0];
        w.pos[near] = [4.0, 0.0];
        w.combat[beast].health = 1.0;
        w.intents.push(Intent::Strike { from: hero as u32, to: beast as u32, dmg: 10.0 });
        w.drain_intents();

        let b = w.beliefs[near].find(hero as u32).expect("the witness forms a belief about the hero");
        assert!(w.beliefs[near].bodies[b].standing > 0, "the monster-slayer is admired");
        assert!(w.beliefs[near].bodies[b].flags & 0x01 == 0, "a hero is not believed hostile");
    }

    /// BIOGRAPHY: the observer rollup captures who a soul was — its defining deed (the tag it did most),
    /// peak level (monotone), earned epithet, and a cumulative notable-deed total.
    #[test]
    fn a_biography_captures_a_defining_life() {
        let mut w = World::spawn(0xB10, 4);
        let hero = 0usize;
        w.alive[hero] = true;
        w.faction[hero] = Faction::Townsfolk as u8;
        w.epithet[hero] = 1; // branded a hero
        w.ambition[hero] = 3; // some archetypal drive
        // a life of rescues (the defining deed) plus one theft.
        crate::signals::fold_deed(&mut w.signals[hero], crate::components::DeedTag::Rescue, 10);
        crate::signals::fold_deed(&mut w.signals[hero], crate::components::DeedTag::Rescue, 20);
        crate::signals::fold_deed(&mut w.signals[hero], crate::components::DeedTag::Rescue, 30);
        crate::signals::fold_deed(&mut w.signals[hero], crate::components::DeedTag::Theft, 40);

        w.update_biographies();
        let bio = w.biographies[hero];
        assert_eq!(bio.epithet, 1, "the earned epithet is captured");
        assert_eq!(bio.drive, 3, "the archetypal drive is captured");
        assert_eq!(
            bio.dominant_deed,
            crate::components::DeedTag::Rescue as u8,
            "the defining deed is the one done most (rescue)"
        );
        assert_eq!(bio.deed_total, 4, "all four notable deeds are tallied");

        // peak level is monotone: a later drop does not lower it.
        w.progression[hero].total_level = 7;
        w.update_biographies();
        assert_eq!(w.biographies[hero].peak_level, 7, "peak level rose");
        w.progression[hero].total_level = 2;
        w.update_biographies();
        assert_eq!(w.biographies[hero].peak_level, 7, "peak level never falls back");
    }

    /// RECIPROCITY: a gift (act verb 10) WARMS the beneficiary's believed standing toward the giver,
    /// and a nearby bystander who witnesses the generosity warms a little too (the goodwill mirror of
    /// the murder-souring witness fold). A far-off townsperson, out of sight, learns nothing.
    #[test]
    fn a_gift_earns_believed_goodwill() {
        let mut w = World::spawn(0x6175, 8);
        let (giver, recip, near, far) = (0usize, 1usize, 2usize, 3usize);
        for &i in &[giver, recip, near, far] {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.beliefs[i].clear();
            w.memory[i] = crate::components::Memory::default();
        }
        w.pos[giver] = [0.0, 0.0];
        w.pos[recip] = [1.0, 0.0];
        w.pos[near] = [5.0, 0.0]; // within witness range
        w.pos[far] = [400.0, 0.0]; // far out of sight
        w.intents.push(Intent::Deed { actor: giver as u32, verb: 10, magnitude: 1, target: recip as u32 });
        w.drain_intents();

        let rb = w.beliefs[recip].find(giver as u32).expect("the beneficiary holds a belief about the giver");
        assert!(
            w.beliefs[recip].bodies[rb].standing >= RECIPROCITY_WARMTH,
            "the beneficiary warms toward its benefactor"
        );
        assert!(
            w.memory[recip].has(EpisodeKind::Succoured, giver as u32),
            "the beneficiary remembers being succoured (drives later repayment)"
        );
        let nb = w.beliefs[near].find(giver as u32).expect("the bystander forms a belief about the giver");
        assert!(w.beliefs[near].bodies[nb].standing > 0, "a bystander admires the generosity");
        assert!(
            w.beliefs[far].find(giver as u32).is_none(),
            "a far-off townsperson out of sight takes nothing from the gift"
        );
    }

    /// STUDY CHANNEL: a rusty crafter co-located with a master of the same craft firms up its recipe and
    /// pays conserved tuition to the teacher (gold moved, not minted).
    #[test]
    fn a_rusty_crafter_studies_under_a_master() {
        let mut w = World::spawn(0x57D1, 6);
        let (student, master) = (0usize, 1usize);
        w.profession[student] = 4; // both blacksmiths
        w.profession[master] = 4;
        w.alive[student] = true;
        w.alive[master] = true;
        w.recipe[student][3] = 0.4; // rusty at the Tool craft (blacksmith → good 3)
        w.recipe[master][3] = 1.0; // a master
        w.pos[student] = [0.0, 0.0];
        w.pos[master] = [2.0, 0.0]; // co-located
        w.econ[student].gold = 5_000;
        let total = w.total_gold();
        let teacher_gold = w.econ[master].gold;
        w.study_recipes();
        assert!(w.recipe[student][3] > 0.4, "the student's recipe firmed up under the master");
        assert!(w.econ[master].gold > teacher_gold, "the teacher was paid tuition");
        assert_eq!(w.total_gold(), total, "tuition is conserved (moved, not minted)");
    }

    /// ASK CHANNEL: with no master nearby, a rusty crafter ASKS a more-skilled co-located peer for a
    /// smaller, tuition-free recipe nudge.
    #[test]
    fn a_crafter_asks_a_more_skilled_peer() {
        let mut w = World::spawn(0x57D2, 6);
        let (student, peer) = (0usize, 1usize);
        w.profession[student] = 4;
        w.profession[peer] = 4;
        w.alive[student] = true;
        w.alive[peer] = true;
        w.recipe[student][3] = 0.3; // blacksmith → Tool good 3
        w.recipe[peer][3] = 0.6; // more skilled, but NOT a master
        w.pos[student] = [0.0, 0.0];
        w.pos[peer] = [2.0, 0.0];
        w.econ[student].gold = 5_000;
        let total = w.total_gold();
        w.study_recipes();
        assert!(w.recipe[student][3] > 0.3, "asking a peer nudged the recipe up");
        assert!(w.recipe[student][3] < 0.42, "the ask bump is smaller than a taught lesson");
        assert_eq!(w.total_gold(), total, "asking pays no tuition (gold untouched + conserved)");
    }

    /// AVENGER ROLE: a townsperson murdered by another townsperson enlists a living KINSMAN as an
    /// avenger — who gains the grudge (an Assaulted memory + a latched-hostile belief about the killer,
    /// so the avenge loop hunts them) and wears the ROLE_AVENGER mark.
    #[test]
    fn a_murder_enlists_a_kinsman_avenger() {
        let mut w = World::spawn(0x4A6E, 6);
        let (killer, victim, kinsman) = (0usize, 1usize, 2usize);
        for &i in &[killer, victim, kinsman] {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.memory[i] = crate::components::Memory::default();
            w.role[i] = 0;
        }
        w.house[victim] = 5;
        w.house[kinsman] = 5; // same house ⇒ the kinsman avenges
        w.combat[victim].health = 1.0; // a single blow is lethal
        w.intents.push(Intent::Strike { from: killer as u32, to: victim as u32, dmg: 10.0 });
        w.drain_intents();

        assert!(!w.alive[victim], "the victim was murdered");
        assert_eq!(w.role[kinsman], ROLE_AVENGER, "the kinsman is enlisted as an avenger");
        assert!(
            w.memory[kinsman].has(EpisodeKind::Assaulted, killer as u32),
            "the avenger holds the grudge (the avenge-loop seed)"
        );
        let ix = w.beliefs[kinsman].find(killer as u32).expect("the avenger now tracks the killer");
        assert!(w.beliefs[kinsman].bodies[ix].flags & 0x01 != 0, "the avenger believes the killer hostile");
    }

    /// ESCHEAT: a dead agent's stranded purse passes to a living KINSMAN (same house) — conserved, so
    /// gold re-enters circulation instead of stranding on the corpse forever.
    #[test]
    fn estate_escheats_to_a_living_kinsman() {
        let mut w = World::spawn(0xE57A, 6);
        let (deceased, kin, stranger) = (0usize, 1usize, 2usize);
        w.alive[deceased] = false;
        w.econ[deceased].gold = 5_000;
        w.house[deceased] = 7;
        w.house[kin] = 7; // same house
        w.alive[kin] = true;
        w.house[stranger] = 9; // a different house — should NOT inherit over the kinsman
        w.alive[stranger] = true;
        let total = w.total_gold();
        let kin_before = w.econ[kin].gold;
        w.escheat_estates();
        assert_eq!(w.econ[deceased].gold, 0, "the corpse's purse was settled");
        assert_eq!(w.econ[kin].gold, kin_before + 5_000, "the kinsman inherited the estate");
        assert_eq!(w.total_gold(), total, "gold conserved (moved to the heir, not minted)");
    }

    /// With no kin, the estate escheats to the nearest living townsperson (the town inherits).
    #[test]
    fn heirless_estate_escheats_to_the_town() {
        let mut w = World::spawn(0xE57B, 6);
        let (deceased, near, far) = (0usize, 1usize, 2usize);
        w.alive[deceased] = false;
        w.econ[deceased].gold = 3_000;
        w.house[deceased] = 0; // no house ⇒ no kin
        w.pos[deceased] = [0.0, 0.0];
        for &h in &[near, far] {
            w.faction[h] = Faction::Townsfolk as u8;
            w.alive[h] = true;
            w.house[h] = 0;
        }
        w.pos[near] = [3.0, 0.0];
        w.pos[far] = [300.0, 0.0];
        let total = w.total_gold();
        let near_before = w.econ[near].gold;
        w.escheat_estates();
        assert_eq!(w.econ[near].gold, near_before + 3_000, "the nearest townsperson inherits");
        assert_eq!(w.total_gold(), total, "gold conserved");
    }

    /// CAPTURE-ON-DEFEAT: a raider's lethal blows on townsfolk take SOME prisoner (captive, alive) and
    /// kill the rest — the mechanic fires (rng-gated) and never both kills and captures the same victim.
    #[test]
    fn raider_lethal_blows_capture_some_and_kill_others() {
        let mut w = World::spawn(0xCAFE, 24);
        let raider = 0usize;
        w.faction[raider] = Faction::Raider as u8;
        w.alive[raider] = true;
        let victims: Vec<usize> = (1..24).collect();
        for &v in &victims {
            w.faction[v] = Faction::Townsfolk as u8;
            w.alive[v] = true;
            w.combat[v].health = 1.0; // a single blow is lethal
            w.captive_of[v] = CAPTIVE_NONE;
            w.intents.push(Intent::Strike { from: raider as u32, to: v as u32, dmg: 10.0 });
        }
        w.drain_intents();
        let captured = victims.iter().filter(|&&v| w.captive_of[v] != CAPTIVE_NONE).count();
        let killed = victims.iter().filter(|&&v| !w.alive[v]).count();
        assert!(captured > 0, "the raid should take at least one prisoner over many lethal blows");
        assert!(killed > 0, "and kill at least one");
        for &v in &victims {
            // never both: a captive is alive + held by the raider; a corpse is not held.
            if w.captive_of[v] != CAPTIVE_NONE {
                assert!(w.alive[v], "a captive is alive");
                assert_eq!(w.captive_of[v], raider as i32, "held by the raider");
            } else {
                assert!(!w.alive[v], "an un-captured victim of a lethal blow is dead");
            }
        }
    }

    /// A captive is RELEASED the moment its captor falls (the prison falls when the raider does).
    #[test]
    fn captive_freed_when_captor_dies() {
        let mut w = World::spawn(0xCAB1, 4);
        let (captor, prisoner) = (0usize, 1usize);
        w.alive[captor] = true;
        w.alive[prisoner] = true;
        w.captive_of[prisoner] = captor as i32;
        w.release_freed_captives();
        assert_eq!(w.captive_of[prisoner], captor as i32, "still held while the captor lives");
        w.alive[captor] = false; // the captor falls
        w.release_freed_captives();
        assert_eq!(w.captive_of[prisoner], CAPTIVE_NONE, "the prisoner is freed when the captor dies");
    }

    /// A SHIELD buffer soaks Strike damage before health: a blow smaller than the shield leaves health
    /// untouched and depletes the shield; the overflow of a bigger blow carries through to health.
    #[test]
    fn shield_absorbs_before_health() {
        let mut w = World::spawn(0x5417, 4);
        let (atk, def) = (0usize, 1usize);
        w.combat[def].health = 100.0;
        w.combat[def].shield = 25.0;
        // a 10-dmg blow: fully soaked by the shield.
        w.intents.push(Intent::Strike { from: atk as u32, to: def as u32, dmg: 10.0 });
        w.drain_intents();
        assert_eq!(w.combat[def].health, 100.0, "a sub-shield blow leaves health untouched");
        assert!((w.combat[def].shield - 15.0).abs() < 1e-3, "the shield depleted by the blow");
        // a 40-dmg blow: 15 soaks the shield, 25 carries to health.
        w.intents.push(Intent::Strike { from: atk as u32, to: def as u32, dmg: 40.0 });
        w.drain_intents();
        assert!((w.combat[def].shield).abs() < 1e-3, "the shield is spent");
        assert!((w.combat[def].health - 75.0).abs() < 1e-3, "the overflow carried through to health");
    }

    /// CROSS-CRAFT: recipe skill is PER GOOD, so an agent retains its knowledge of a craft it has
    /// practised even after retraining — a switcher who once mastered a trade is still skilled at it.
    #[test]
    fn recipe_skill_is_per_craft_and_retained_across_a_switch() {
        let mut w = World::spawn(0xC2A5, 4);
        let a = 0usize;
        // a blacksmith who is a master of Tools (good 3) but rusty at Wood (good 1).
        w.profession[a] = 4;
        w.recipe[a][3] = 1.0; // mastered Tools
        w.recipe[a][1] = 0.2; // barely knows Wood
        // it retrains into woodcutting (profession 3 → Wood).
        w.profession[a] = 3;
        // its Tool mastery is RETAINED (cross-craft) — not wiped by the switch…
        assert!((w.recipe[a][3] - 1.0).abs() < 1e-6, "the old craft's mastery is retained");
        // …and it starts the new craft rusty (its Wood recipe is what it had learned: low).
        assert!(w.recipe[a][1] < 0.8, "the new craft starts below mastery (must be re-learned)");
        // distinct per-good slots, not one shared skill.
        assert_ne!(w.recipe[a][3], w.recipe[a][1], "recipe skill is per craft, not a single value");
    }

    /// DYNAMIC OCCUPATION: an over-supplied trade sheds a worker into the most under-supplied one, but
    /// the FOOD floor is never breached (farmers stay staffed).
    #[test]
    fn occupations_rebalance_but_protect_food() {
        let mut w = World::spawn(0x0CC0, 60);
        // make everyone a townsperson; pile them all into ONE trade (blacksmith=4) — wildly unbalanced.
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.profession[i] = 4;
        }
        // run several passes — the workforce should spread out of the over-supplied smithy.
        let smiths0 = (0..w.n).filter(|&i| w.profession[i] == 4).count();
        for _ in 0..50 {
            w.choose_occupations();
        }
        let smiths1 = (0..w.n).filter(|&i| w.profession[i] == 4).count();
        assert!(smiths1 < smiths0, "the over-supplied smithy shed workers ({smiths0} -> {smiths1})");
        // and some retrained into other trades (the workforce diversified).
        let distinct = (1u8..=6).filter(|&p| (0..w.n).any(|i| w.profession[i] == p)).count();
        assert!(distinct > 1, "the workforce diversified into multiple trades, got {distinct}");

        // FOOD PROTECTION: with the farmers already at/under the floor, none are shed.
        let mut w2 = World::spawn(0x0CC1, 60);
        for i in 0..w2.n {
            w2.faction[i] = Faction::Townsfolk as u8;
            w2.alive[i] = true;
            w2.profession[i] = if i < 6 { 1 } else { 4 }; // only 6 farmers (at/under the floor), rest smiths
        }
        let farmers0 = (0..w2.n).filter(|&i| w2.profession[i] == 1).count();
        for _ in 0..50 {
            w2.choose_occupations();
        }
        let farmers1 = (0..w2.n).filter(|&i| w2.profession[i] == 1).count();
        assert!(farmers1 >= farmers0, "the food floor protected the farmers ({farmers0} -> {farmers1})");
    }

    /// CARAVAN / ARBITRAGE: a merchant exports surplus + imports a luxury across the external price
    /// differential — profiting on the spread; gold conserved (it only moves merchant↔external treasury).
    #[test]
    fn a_caravan_trades_the_spread_conserving_gold() {
        use crate::components::N_COMMODITIES;
        let mut w = World::spawn(0xCA64, 6);
        let merchant = 0usize;
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.econ[i].gold = 0;
        }
        w.econ[merchant].gold = 50_000; // the richest — the caravan merchant
        w.econ[merchant].inventory = [0; N_COMMODITIES];
        w.econ[merchant].inventory[3] = 10; // a surplus of Tools to export
        let total = w.total_gold();
        let gold0 = w.econ[merchant].gold;
        let tools0 = w.econ[merchant].inventory[3];

        w.run_caravan();
        assert!(w.econ[merchant].inventory[3] < tools0, "the merchant exported surplus tools");
        // it earned export revenue (and spent some on the luxury import) — net it traded the spread.
        assert_ne!(w.econ[merchant].gold, gold0, "the merchant's purse changed (it traded abroad)");
        assert!(w.econ[merchant].inventory[5] > 0, "it imported a luxury (Potion)");
        assert_eq!(w.total_gold(), total, "gold conserved across the caravan (purse ↔ external treasury)");
    }

    /// BOUNTY: a threat to the core is posted (a conserved levy into the fund), and its slayer claims
    /// the fund — gold conserved across the whole cycle (purses → fund → slayer).
    #[test]
    fn a_bounty_is_funded_then_claimed_conserving_gold() {
        let mut w = World::spawn(0xB047, 8);
        let (slayer, threat) = (0usize, 1usize);
        // wealthy townsfolk to fund the bounty.
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.econ[i].gold = 5_000;
        }
        // a monster menacing the core.
        w.faction[threat] = Faction::Monster as u8;
        w.pos[threat] = w.town_center;
        let total = w.total_gold();

        w.post_bounty();
        assert_eq!(w.bounty_target, threat as i32, "the threat to the core is posted");
        assert!(w.bounty_fund > 0, "the town pledged a reward (levied into the fund)");
        assert_eq!(w.total_gold(), total, "the levy is conserved (purses → fund)");
        let fund = w.bounty_fund;
        let slayer_gold = w.econ[slayer].gold;

        // the slayer fells the bounty target → claims the fund.
        w.combat[threat].health = 1.0;
        w.intents.push(Intent::Strike { from: slayer as u32, to: threat as u32, dmg: 10.0 });
        w.drain_intents();
        assert!(!w.alive[threat], "the threat was slain");
        assert_eq!(w.econ[slayer].gold, slayer_gold + fund, "the slayer claimed the bounty fund");
        assert_eq!(w.bounty_target, -1, "the bounty is cleared once claimed");
        assert_eq!(w.total_gold(), total, "gold conserved across the whole bounty cycle");
    }

    /// ECON TELEMETRY: a cleared Transfer (a trade) folds into the observer econstats counters.
    #[test]
    fn a_trade_folds_into_econstats() {
        let mut w = World::spawn(0xEC57, 4);
        w.econ[0].inventory[Commodity::Food as usize] = 5;
        w.econ[1].gold = 10_000;
        let trades0 = w.econstats.trades;
        // a 3-unit Food trade from 0 to 1 at price 600.
        w.intents.push(Intent::Transfer { from: 0, to: 1, good: Commodity::Food as u8, qty: 3, price: 600 });
        w.drain_intents();
        assert_eq!(w.econstats.trades, trades0 + 1, "the trade was counted");
        assert_eq!(w.econstats.volume, 3, "3 units of volume");
        assert_eq!(w.econstats.gold_flowed, 600, "600 gold flowed");
        assert_eq!(w.econstats.good_volume[Commodity::Food as usize], 3, "per-good volume tracked");
    }

    /// A `Hand` intent moves gold + goods one way and CONSERVES the totals (the resolver primitive
    /// behind give/pay/rob/loot/teach).
    #[test]
    fn hand_moves_and_conserves() {
        let mut w = World::spawn(0x4A11D, 4);
        w.econ[0].gold = 5_000;
        w.econ[0].inventory[Commodity::Food as usize] = 3;
        w.econ[1].gold = 100;
        w.econ[1].inventory[Commodity::Food as usize] = 0;
        let gold_before = w.total_gold();
        let food_before: i32 = w.econ.iter().map(|e| e.inventory[Commodity::Food as usize]).sum();

        w.intents.push(Intent::Hand { from: 0, to: 1, gold: 1_200, good: Commodity::Food as u8, qty: 2 });
        w.drain_intents();

        assert_eq!(w.econ[0].gold, 3_800, "giver debited");
        assert_eq!(w.econ[1].gold, 1_300, "receiver credited");
        assert_eq!(w.econ[0].inventory[Commodity::Food as usize], 1, "giver lost 2 food");
        assert_eq!(w.econ[1].inventory[Commodity::Food as usize], 2, "receiver gained 2 food");
        assert_eq!(w.total_gold(), gold_before, "gold conserved");
        let food_after: i32 = w.econ.iter().map(|e| e.inventory[Commodity::Food as usize]).sum();
        assert_eq!(food_after, food_before, "goods conserved");
    }

    /// A handover only moves what the giver actually holds (no minting / no debt).
    #[test]
    fn hand_clamps_to_holdings() {
        let mut w = World::spawn(0x4A11E, 4);
        w.econ[0].gold = 500;
        let total = w.total_gold();
        w.intents.push(Intent::Hand { from: 0, to: 1, gold: 9_999, good: 0, qty: 0 });
        w.drain_intents();
        assert_eq!(w.econ[0].gold, 500, "can't give gold it doesn't have");
        assert_eq!(w.total_gold(), total, "no minting");
    }
}
