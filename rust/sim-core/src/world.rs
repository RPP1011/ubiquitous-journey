//! The double-buffered ECS world (docs/architecture/22 §3, §4) — SoA columns + a per-tick
//! `Perceivable` projection + the spatial grid. Wave-0 subset: only the columns the parallel
//! `perceive` (and a trivial parallel `move`) exercise. Both phases are per-entity own-write
//! (read shared `prev` columns / write own row), so they're `rayon::par_iter_mut` and deterministic.

use rayon::prelude::*;

use crate::components::{BeliefTable, Faction, Perceivable};
use crate::grid::Grid;
use crate::perceive::perceive;
use crate::rng::DeterministicRng;

const TOWN_RADIUS: f32 = 180.0; // dense single town (the TS megatown), so perceive does real work.
const MOVE_STEP: f32 = 0.4; // per-tick drift; keeps the grid rebuild + beliefs meaningful.
const ARENA_CLAMP: f32 = 590.0;

pub struct World {
    pub n: usize,
    pub seed: u64,
    pub tick: u32,

    // ── WARM columns (stable-slot order). `pos` is the frozen read-set during perceive; `beliefs`
    //    is the own-write set. (Movement writes `pos` in its OWN phase, before the surface is built.)
    pub pos: Vec<[f32; 2]>,
    pub faction: Vec<u8>,
    pub level: Vec<u8>,
    pub notoriety: Vec<u16>,
    pub threat: Vec<u16>,
    pub wealth: Vec<u16>,
    pub rng: Vec<DeterministicRng>,
    pub beliefs: Vec<BeliefTable>,

    // ── HOT per-tick projection + index (rebuilt each tick) ──
    pub surface: Vec<Perceivable>,
    pub grid: Grid,
}

impl World {
    /// Worldgen: spawn `n` agents clustered in one dense town. Deterministic from `seed`.
    pub fn spawn(seed: u64, n: usize) -> World {
        let mut gen = DeterministicRng::seed(seed, 0xA11CE);
        let mut w = World {
            n,
            seed,
            tick: 0,
            pos: Vec::with_capacity(n),
            faction: Vec::with_capacity(n),
            level: Vec::with_capacity(n),
            notoriety: Vec::with_capacity(n),
            threat: Vec::with_capacity(n),
            wealth: Vec::with_capacity(n),
            rng: Vec::with_capacity(n),
            beliefs: Vec::with_capacity(n),
            surface: Vec::with_capacity(n),
            grid: Grid::new(),
        };
        for i in 0..n {
            // uniform-in-disk town placement (sqrt for area-uniformity)
            let r = TOWN_RADIUS * gen.next_f32().sqrt();
            let a = gen.next_f32() * std::f32::consts::TAU;
            w.pos.push([r * a.cos(), r * a.sin()]);
            // mostly townsfolk, a few monsters on the fringe (gives factions some spread)
            let f = if gen.next_f32() < 0.06 { Faction::Monster } else { Faction::Townsfolk };
            w.faction.push(f as u8);
            w.level.push((gen.next_f32() * 12.0) as u8);
            w.notoriety.push((gen.next_f32() * 4000.0) as u16);
            w.threat.push((gen.next_f32() * 8000.0) as u16);
            w.wealth.push((gen.next_f32() * 60000.0) as u16);
            w.rng.push(DeterministicRng::seed(seed, i as u64));
            w.beliefs.push(BeliefTable::default());
        }
        w
    }

    /// Parallel movement: each agent drifts by its OWN rng stream. Own-write (pos + rng), so the
    /// result is independent of how `rayon` schedules — the simplest M-invariant phase.
    fn move_agents(&mut self) {
        let World { ref mut pos, ref mut rng, .. } = *self;
        pos.par_iter_mut().zip(rng.par_iter_mut()).for_each(|(p, r)| {
            p[0] = (p[0] + r.next_signed() * MOVE_STEP).clamp(-ARENA_CLAMP, ARENA_CLAMP);
            p[1] = (p[1] + r.next_signed() * MOVE_STEP).clamp(-ARENA_CLAMP, ARENA_CLAMP);
        });
    }

    /// Project the WARM columns into the hot `Perceivable` surface (id order) and counting-sort it
    /// into the grid (cell-major). Serial + O(n) — cheap (§4).
    pub fn build_surface(&mut self) {
        let n = self.n;
        self.surface.clear();
        for i in 0..n {
            self.surface.push(Perceivable {
                id: i as u32,
                x: self.pos[i][0],
                z: self.pos[i][1],
                faction: self.faction[i],
                flags: 1, // alive
                level: self.level[i],
                _pad: 0,
                notoriety: self.notoriety[i],
                threat: self.threat[i],
                wealth_cue: self.wealth[i],
                _pad2: 0,
            });
        }
        // take the surface out so grid (a sibling field) can borrow it without aliasing `self`.
        let surface = std::mem::take(&mut self.surface);
        self.grid.rebuild(&surface);
        self.surface = surface;
    }

    /// One full tick: move (parallel) → rebuild grid (serial) → perceive (parallel) → advance clock.
    pub fn tick(&mut self) {
        self.move_agents();
        self.build_surface();
        perceive(self);
        self.tick += 1;
    }

    /// Like `tick`, but returns the wall-seconds spent in `perceive` (the spike's measured cost).
    pub fn step_timing(&mut self) -> f64 {
        self.move_agents();
        self.build_surface();
        let t0 = std::time::Instant::now();
        perceive(self);
        let dt = t0.elapsed().as_secs_f64();
        self.tick += 1;
        dt
    }
}
