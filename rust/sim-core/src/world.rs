//! The ECS world (docs/architecture/22 §3, §4): SoA columns + a per-tick `Perceivable` projection +
//! the spatial grid + the double-buffered belief snapshot + the intent queue. The Wave-1 substrate:
//! all the core columns + the scheduler phases, with each cognition/execution SYSTEM behind a stub
//! in `systems::*` that the fan-out fills. Every parallel phase is per-entity own-write (or emits
//! intents), so the whole tick stays deterministic (M=1 ≡ M=N).

use crate::components::{
    BeliefTable, CombatBody, Commodity, Economy, Faction, Goal, Mood, Needs, Perceivable,
    Profession, Progression,
};
use crate::grid::Grid;
use crate::intent::{Intent, IntentQueue};
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
    pub goal: Vec<Goal>,
    pub econ: Vec<Economy>,
    pub combat: Vec<CombatBody>,
    pub home: Vec<[f32; 2]>,
    pub town: Vec<u16>,
    pub rng: Vec<DeterministicRng>,
    pub progression: Vec<Progression>,

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
}

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
            goal: Vec::with_capacity(n),
            econ: Vec::with_capacity(n),
            combat: Vec::with_capacity(n),
            home: Vec::with_capacity(n),
            town: Vec::with_capacity(n),
            rng: Vec::with_capacity(n),
            progression: Vec::with_capacity(n),
            beliefs: Vec::with_capacity(n),
            beliefs_prev: Vec::with_capacity(n),
            surface: Vec::with_capacity(n),
            grid: Grid::new(),
            intents: IntentQueue::new(),
            market: [0.0, 0.0],
            work_sites,
            town_center: [0.0, 0.0],
            base_price: [10, 8, 12, 30, 15, 40],
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
            w.beliefs.push(BeliefTable::default());
            w.beliefs_prev.push(BeliefTable::default());
        }
        w
    }

    /// Project the WARM columns into the hot `Perceivable` surface (id order) and counting-sort it
    /// into the grid. Serial, O(n).
    pub fn build_surface(&mut self) {
        let n = self.n;
        self.surface.clear();
        for i in 0..n {
            self.surface.push(Perceivable {
                id: i as u32,
                x: self.pos[i][0],
                z: self.pos[i][1],
                faction: self.faction[i],
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
                Intent::Strike { from: _, to, dmg } => {
                    let to = to as usize;
                    if to >= self.n || !self.alive[to] {
                        continue;
                    }
                    self.combat[to].health -= dmg;
                    if self.combat[to].health <= 0.0 {
                        self.combat[to].health = 0.0;
                        self.combat[to].state = crate::components::FighterState::Dead as u8;
                        self.alive[to] = false;
                    }
                }
                Intent::Deed { actor, verb, magnitude, target: _ } => {
                    let actor = actor as usize;
                    if actor >= self.n {
                        continue;
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
        systems::decide::decide(self); // parallel: own goal from needs/beliefs
        systems::locomotion::step(self); // parallel: own pos toward goal
        self.build_surface(); // serial: project + grid
        perceive(self); // parallel: own beliefs
        self.snapshot_beliefs(); // serial: freeze the read set for gossip
        systems::gossip::gossip(self); // parallel: read prev beliefs, write own
        systems::combat::resolve(self); // parallel decide → Strike intents
        systems::market::clear(self); // parallel decide → Transfer intents
        self.drain_intents(); // serial deterministic merge
        systems::progression::tick(self); // parallel: own progression from deeds
        self.tick += 1;
    }

    /// Like `tick`, but returns the wall-seconds spent in `perceive` (the spike's measured cost,
    /// for `soak_bench`). Mirrors `tick`'s phase order exactly.
    pub fn step_timing(&mut self) -> f64 {
        systems::needs::drain(self);
        systems::decide::decide(self);
        systems::locomotion::step(self);
        self.build_surface();
        let t0 = std::time::Instant::now();
        perceive(self);
        let dt = t0.elapsed().as_secs_f64();
        self.snapshot_beliefs();
        systems::gossip::gossip(self);
        systems::combat::resolve(self);
        systems::market::clear(self);
        self.drain_intents();
        systems::progression::tick(self);
        self.tick += 1;
        dt
    }

    /// Total gold across the roster (purse + stash) — the conservation invariant for tests.
    pub fn total_gold(&self) -> i64 {
        self.econ.iter().map(|e| e.gold + e.stash).sum()
    }
}
