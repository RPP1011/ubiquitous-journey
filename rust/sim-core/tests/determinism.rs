//! Wave-1 gates (docs/architecture/22 §9): the HARD determinism gate (M=1 ≡ M=N + run-to-run), the
//! grid superset-correctness gate, and gold conservation. These stay green as the fan-out fills the
//! system stubs — a system that breaks any of them is non-deterministic or non-conserving.

use sim_core::hash::world_hash;
use sim_core::perceive::in_range_reference;
use sim_core::world::World;
use sim_core::{in_pool, run_sim};

const SEED: u64 = 0xC00D19;
const N: usize = 800;
const FRAMES: u32 = 120;

/// Run-to-run determinism: same seed + same code ⇒ identical golden hash.
#[test]
fn run_to_run_deterministic() {
    let a = world_hash(&run_sim(SEED, N, FRAMES));
    let b = world_hash(&run_sim(SEED, N, FRAMES));
    assert_eq!(a, b, "two identical runs must produce identical golden hashes");
}

/// THE hard gate: identical result regardless of `rayon` core count (M=1 ≡ M=N).
#[test]
fn m_invariant_across_core_counts() {
    let h1 = in_pool(1, || world_hash(&run_sim(SEED, N, FRAMES)));
    let h2 = in_pool(2, || world_hash(&run_sim(SEED, N, FRAMES)));
    let h4 = in_pool(4, || world_hash(&run_sim(SEED, N, FRAMES)));
    let h8 = in_pool(8, || world_hash(&run_sim(SEED, N, FRAMES)));
    assert_eq!(h1, h2, "M=1 vs M=2 diverged");
    assert_eq!(h1, h4, "M=1 vs M=4 diverged");
    assert_eq!(h1, h8, "M=1 vs M=8 diverged");
}

/// Grid superset correctness: every agent within VISION must end up with a belief (the spatial cull
/// drops no in-range subject). N is small enough here that in-range counts stay under the cap, so
/// the SUBSET relation must hold exactly.
#[test]
fn grid_superset_no_dropped_neighbours() {
    let w = run_sim(SEED, N, 20);
    for i in 0..w.n {
        let reference = in_range_reference(&w, i);
        if reference.len() > sim_core::components::BELIEF_CAP {
            continue; // over cap: only the nearest survive — not a superset case
        }
        let bt = &w.beliefs[i];
        let held: std::collections::HashSet<u32> =
            bt.subjects[..bt.len as usize].iter().copied().collect();
        for j in reference {
            assert!(held.contains(&j), "agent {i}: in-range neighbour {j} has no belief");
        }
    }
}

/// Gold is conserved (fixed-point i64; the merge only moves it, never mints). Holds trivially until
/// the market system lands, then guards it.
#[test]
fn gold_conserved() {
    let mut w = World::spawn(SEED, N);
    let start = w.total_gold();
    for _ in 0..FRAMES {
        w.tick();
    }
    assert_eq!(start, w.total_gold(), "gold must be conserved across the run");
}
