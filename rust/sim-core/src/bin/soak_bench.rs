//! Wave-0 perf + determinism bench (docs/architecture/22 §9): run the same deterministic sim in
//! `rayon` pools of 1/2/4/8 threads; print the `perceive` wall (the scaling) and assert the golden
//! hash is identical across all thread counts (the M-invariance gate).
//!
//!   cargo run --release --bin soak_bench            # defaults: N=2000, frames=200
//!   cargo run --release --bin soak_bench 5000 100   # N=5000, frames=100

use sim_core::hash::world_hash;
use sim_core::in_pool;
use sim_core::world::World;

fn main() {
    let mut args = std::env::args().skip(1);
    let n: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(2000);
    let frames: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(200);
    let seed: u64 = 0xC00D19;

    let cores = std::thread::available_parallelism()
        .map(|c| c.get())
        .unwrap_or(8);
    let mut thread_counts: Vec<usize> = [1usize, 2, 4, 8, 16, 24, 32, 48, 64]
        .into_iter()
        .filter(|&t| t <= cores.max(1))
        .collect();
    if !thread_counts.contains(&cores.max(1)) {
        thread_counts.push(cores.max(1)); // always include the full core count
    }

    println!(
        "sim-core soak_bench — N={} frames={} cores={} seed={:#x}",
        n, frames, cores, seed
    );
    println!("{:>8} | {:>14} | {:>14} | {:>10} | {}", "threads", "perceive (ms)", "per-tick (ms)", "speedup", "golden hash");

    let mut hashes: Vec<u64> = Vec::new();
    let mut base_ms = 0f64;
    for (idx, &t) in thread_counts.iter().enumerate() {
        let (perceive_ms, hsh) = in_pool(t, || {
            let mut w = World::spawn(seed, n);
            let mut acc = 0f64;
            for _ in 0..frames {
                acc += w.step_timing();
            }
            (acc * 1000.0, world_hash(&w))
        });
        if idx == 0 {
            base_ms = perceive_ms;
        }
        let per_tick = perceive_ms / frames as f64;
        let speedup = if perceive_ms > 0.0 { base_ms / perceive_ms } else { 0.0 };
        println!(
            "{:>8} | {:>14.1} | {:>14.3} | {:>9.2}x | {:#018x}",
            t, perceive_ms, per_tick, speedup, hsh
        );
        hashes.push(hsh);
    }

    let invariant = hashes.windows(2).all(|w| w[0] == w[1]);
    println!(
        "\nM-invariance (golden hash identical across thread counts): {}",
        if invariant { "PASS" } else { "FAIL" }
    );
    std::process::exit(if invariant { 0 } else { 1 });
}
