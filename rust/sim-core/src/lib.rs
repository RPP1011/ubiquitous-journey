//! sim-core — Wave 0 spike for the Rust ECS sim port (docs/architecture/22-rust-ecs-backend-lld.md).
//!
//! Proves the load-bearing thesis before the full port: a `rayon`-parallel `perceive` over a
//! Struct-of-Arrays roster + a cache-resident, spatially-sorted `Perceivable` surface, that is
//! DETERMINISTIC within Rust (identical golden hash across runs AND across core counts, M=1 ≡ M=8).
//! See the determinism gate in `tests/determinism.rs` and the scaling numbers from `soak_bench`.

// Wave-1 substrate: the component catalog / intent vocabulary / enum variants are defined ahead of
// the systems that consume them (the fan-out fills the `systems::*` stubs), so unused items are
// expected until then. Re-tighten (remove this) once the core systems land.
#![allow(dead_code)]

pub mod abilities;
pub mod components;
pub mod exec;
pub mod experience;
pub mod rpgxp;
pub mod tags;
pub mod grid;
pub mod hash;
pub mod intent;
pub mod mentalmap;
pub mod perceive;
pub mod reason;
pub mod signals;
pub mod planner;
pub mod rng;
pub mod sagas;
pub mod systems;
pub mod world;

use world::World;

/// Run a fresh deterministic sim for `frames` ticks; returns the final world (for hashing/inspection).
pub fn run_sim(seed: u64, n: usize, frames: u32) -> World {
    let mut w = World::spawn(seed, n);
    for _ in 0..frames {
        w.tick();
    }
    w
}

/// Run `f` inside a `rayon` pool of exactly `threads` worker threads — the lever for the M=1 ≡ M=8
/// determinism gate and the scaling bench. (`install` scopes the pool to the closure.)
pub fn in_pool<R: Send>(threads: usize, f: impl FnOnce() -> R + Send) -> R {
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads.max(1))
        .build()
        .expect("build rayon pool")
        .install(f)
}
