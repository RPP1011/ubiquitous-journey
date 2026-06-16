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

    // EMERGENT SPECIALIZATION: per-town profession mix. A town's "dominant share" = the fraction of its
    // workers in its single biggest trade; higher = more specialised. Identical worldgen, so any spread
    // above the uniform 1/6 baseline emerged from the mastery-aware per-town reallocation + trade.
    let names = ["", "Farm", "Mine", "Wood", "Smith", "Hunt", "Trade"];
    let mut town_counts = vec![[0usize; 7]; nt];
    for i in 0..w.n {
        if w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 {
            let p = w.profession[i] as usize;
            if p >= 1 && p <= 6 {
                town_counts[(w.town[i] as usize).min(nt - 1)][p] += 1;
            }
        }
    }
    let mut shares = 0f32;
    let mut nonzero = 0;
    let mut doms: Vec<&str> = Vec::new();
    for c in &town_counts {
        let total: usize = c[1..=6].iter().sum();
        if total == 0 {
            continue;
        }
        let (dom, dn) = (1..=6).map(|p| (p, c[p])).max_by_key(|&(_, n)| n).unwrap();
        shares += dn as f32 / total as f32;
        doms.push(names[dom]);
        nonzero += 1;
    }
    println!(
        "\nEMERGENT SPECIALIZATION (uniform baseline = 0.17 dominant share):"
    );
    println!(
        "  mean dominant-craft share across towns: {:.2}",
        if nonzero > 0 { shares / nonzero as f32 } else { 0.0 }
    );
    println!("  each town's dominant trade: {:?}", doms);

    // Gods: town gods vs wild gods, by believer count. Wild gods grow by claiming souls out in the wild,
    // so any wild power at all means wild faith has been carried back into the towns.
    use sim_core::components::GOD_WILD;
    let town_power: u32 = w.gods.iter().filter(|g| g.origin != GOD_WILD).map(|g| g.power).sum();
    let wild_power: u32 = w.gods.iter().filter(|g| g.origin == GOD_WILD).map(|g| g.power).sum();
    let faithless = (0..w.n)
        .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 && w.faith[i] == 0)
        .count();
    println!("\nGODS (believer count):");
    println!(
        "  town gods: {}   |   wild gods: {}   |   faithless: {}",
        town_power, wild_power, faithless
    );
    let mut gl: Vec<String> = Vec::new();
    for (gi, g) in w.gods.iter().enumerate() {
        let kind = if g.origin == GOD_WILD { "wild" } else { "town" };
        gl.push(format!("g{}:{}({})", gi + 1, g.power, kind));
    }
    println!("  per-god: {:?}", gl);
}
