//! Liveness probe — run the region sim and report its emergent VITAL SIGNS: how the settlements spread
//! and diverged, the standing wilderness threat, the demographic churn (births, deaths, refugee flows),
//! and the drama the observer layer recorded. A diagnostic for "is the world alive?", not a gate.
//!
//!   cargo run --release --bin liveness            # defaults: N=5000, ticks=3000
//!   cargo run --release --bin liveness 8000 5000

use sim_core::components::Faction;
use sim_core::world::World;

fn townsfolk(w: &World) -> usize {
    (0..w.n).filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8).count()
}
fn monsters(w: &World) -> usize {
    (0..w.n).filter(|&i| w.alive[i] && w.faction[i] == Faction::Monster as u8).count()
}
fn per_town(w: &World) -> Vec<usize> {
    let nt = w.town_centers.len();
    let mut p = vec![0usize; nt];
    for i in 0..w.n {
        if w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 {
            p[(w.town[i] as usize).min(nt - 1)] += 1;
        }
    }
    p
}

fn main() {
    let mut args = std::env::args().skip(1);
    let n: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(5000);
    let ticks: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(3000);
    let seed = 0xC00D19u64;

    let mut w = World::spawn(seed, n);
    let nt = w.town_centers.len();
    let pop0 = per_town(&w);
    let tf0 = townsfolk(&w);
    let lairs = w.lair_pos.len();
    let bushes = w.forage_pos.len();

    println!("REGION @ worldgen — N={n}, seed={seed:#x}");
    println!(
        "  {nt} settlements (sizes {}-{}), {lairs} wilderness lairs, {bushes} berry bushes",
        pop0.iter().min().copied().unwrap_or(0),
        pop0.iter().max().copied().unwrap_or(0),
    );
    println!("  founding townsfolk: {tf0}, monsters: {}", monsters(&w));

    for _ in 0..ticks {
        w.tick();
    }

    let pop = per_town(&w);
    let tf = townsfolk(&w);
    // beat histogram
    let mut births = 0u32;
    let mut raids = 0u32;
    let mut other = 0u32;
    for b in &w.chronicle {
        match b.kind {
            3 => births += 1,
            2 => raids += 1,
            _ => other += 1,
        }
    }
    // demographic divergence: which towns boomed / hollowed
    let mut boom = 0usize;
    let mut ghost = 0usize;
    for t in 0..nt {
        if pop[t] >= pop0[t] + pop0[t] / 4 {
            boom += 1;
        } else if pop[t] * 2 < pop0[t] {
            ghost += 1;
        }
    }

    println!("\nAFTER {ticks} ticks:");
    println!("  townsfolk {tf0} -> {tf}   |   living monsters: {}   |   total roster: {}", monsters(&w), w.n);
    println!(
        "  settlements: {} boomed (+25%), {} hollowed (-50%), per-town pop {:?}",
        boom, ghost, pop
    );
    println!(
        "  drama: {} chronicle beats ({} births, {} raids, {} other) | open vendettas {} | rescues {}",
        w.chronicle.len(),
        births,
        raids,
        other,
        w.sagas.open_count(sim_core::sagas::SagaKind::Vendetta),
        w.sagas.open_count(sim_core::sagas::SagaKind::Rescue),
    );
    println!("  quests on the board: {}", w.quests.len());
}
