//! Wave-0 gates (docs/architecture/22 §9): the HARD determinism gate (M=1 ≡ M=8 + run-to-run) and
//! the grid superset-correctness gate. These are the spike's pass/fail.

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

/// THE hard gate: identical result regardless of `rayon` core count (M=1 ≡ M=8). Breaks instantly
/// if any non-deterministic parallelism (float reduce, HashMap order, slot-indexed RNG) sneaks in.
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

/// Grid superset correctness: the candidates `perceive` considers (from the 3×3 grid query) must
/// include EVERY agent within VISION — i.e. the spatial cull never drops an in-range subject.
/// We verify it via the belief table: with N small enough that few agents exceed the cap-25 cull,
/// the formed beliefs (the nearest 25) must equal the nearest 25 of the brute-force in-range set.
#[test]
fn grid_superset_matches_bruteforce() {
    let w = run_sim(SEED, N, 30);
    let mut checked = 0usize;
    for i in 0..w.n {
        let mut reference = in_range_reference(&w, i);
        // the spike keeps the nearest BELIEF_CAP; restrict the reference the same way (nearest-first).
        reference.sort_by(|&a, &b| {
            let da = dist2(&w, i, a as usize);
            let db = dist2(&w, i, b as usize);
            da.partial_cmp(&db).unwrap().then(a.cmp(&b))
        });
        reference.truncate(sim_core::components::BELIEF_CAP);

        let bt = &w.beliefs[i];
        let mut formed: Vec<u32> = bt.subjects[..bt.len as usize].to_vec();
        formed.sort_unstable();
        reference.sort_unstable();
        assert_eq!(
            formed, reference,
            "agent {i}: formed beliefs != nearest-{} in-range reference",
            sim_core::components::BELIEF_CAP
        );
        checked += 1;
    }
    assert!(checked > 0);
}

fn dist2(w: &World, i: usize, j: usize) -> f32 {
    let dx = w.pos[i][0] - w.pos[j][0];
    let dz = w.pos[i][1] - w.pos[j][1];
    dx * dx + dz * dz
}
