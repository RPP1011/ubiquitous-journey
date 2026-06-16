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
    // ── Wave-H society/observer world state ──
    pub house_feuds: Vec<(u32, u32)>, // active house-vs-house feuds (canonical lo<hi pairs) — houses.rs
    pub watch: WatchState,            // the Night Watch institution's hysteresis/captaincy state (serial)
    pub defenses: DefenseState,       // the watchtower ring's shot tally (serial society phase)
    pub expeditions: ExpeditionState, // wilderness adventuring companies afield (serial society phase)
    pub tropes: TropeState,           // the relationship-trope engine's cooldown/telemetry state (serial)
}

/// A perceived faction sentinel: no disguise active.
pub const NO_DISGUISE: u8 = 0xFF;

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
            house_feuds: Vec::new(),
            watch: WatchState::default(),
            defenses: DefenseState::default(),
            expeditions: ExpeditionState::default(),
            tropes: TropeState::default(),
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
                    }
                }
                Intent::Strike { from, to, dmg } => {
                    let (from, to) = (from as usize, to as usize);
                    if to >= self.n || !self.alive[to] {
                        continue;
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
                    }
                    if self.combat[to].health <= 0.0 {
                        self.combat[to].health = 0.0;
                        self.combat[to].state = crate::components::FighterState::Dead as u8;
                        self.alive[to] = false;
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
        systems::market::clear(self); // parallel decide → Transfer intents
        systems::act::act(self); // parallel on-arrival interaction verbs → Hand/Deed intents
        self.drain_intents(); // serial deterministic merge
        systems::progression::tick(self); // parallel: own progression from deeds
        self.society_phase(); // serial: director/lineage/faith/groups/quests/chronicle
        self.tick += 1;
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
        systems::market::clear(self);
        systems::act::act(self);
        self.drain_intents();
        systems::progression::tick(self);
        self.society_phase();
        self.tick += 1;
        dt
    }

    /// Total gold across the roster (purse + stash) — the conservation invariant for tests.
    pub fn total_gold(&self) -> i64 {
        self.econ.iter().map(|e| e.gold + e.stash).sum()
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
