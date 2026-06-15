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

/// Grid superset correctness — the REAL invariant: the spatial grid's 3×3 query is a SUPERSET of
/// every in-range neighbour (the cull never silently drops a candidate). Tested at the grid level,
/// independent of belief-table eviction: once gossip adds hearsay, a confident hearsay belief may
/// legitimately evict a low-confidence far-glimpse from the cap-25 table, so the post-eviction belief
/// set is NOT a superset of in-range — but the grid candidate set always is, and that's what matters.
#[test]
fn grid_superset_no_dropped_neighbours() {
    let mut w = World::spawn(SEED, N);
    for _ in 0..20 {
        w.tick();
    }
    w.build_surface(); // rebuild the grid to match the agents' current (moved) positions.
    for i in 0..w.n {
        let reference = in_range_reference(&w, i);
        let mut got = std::collections::HashSet::new();
        w.grid.for_near(w.pos[i][0], w.pos[i][1], |p| {
            got.insert(p.id);
        });
        for j in reference {
            assert!(got.contains(&j), "agent {i}: grid dropped in-range neighbour {j}");
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
