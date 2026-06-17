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
    let nogods = args.next().as_deref() == Some("nogods"); // A/B: clear the pantheon to measure its effect
    let seed = 0xC00D19u64;

    let mut w = World::spawn(seed, n);
    if nogods {
        w.gods.clear(); // no gods => faith bootstrap/effects do nothing (the control run)
        println!("[A/B CONTROL: no gods]");
    }
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

    // Gods: settlement gods vs wild-site gods, by believer count. Wild gods grow by claiming souls out
    // in the wild, so any wild believers at all means wild faith has been carried back into the towns.
    use sim_core::components::DOMAIN_WILD_SITE;
    let town_bel: u32 = w.gods.iter().filter(|g| g.domain != DOMAIN_WILD_SITE).map(|g| g.believers).sum();
    let wild_bel: u32 = w.gods.iter().filter(|g| g.domain == DOMAIN_WILD_SITE).map(|g| g.believers).sum();
    let faithless = (0..w.n)
        .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 && w.faith[i] == 0)
        .count();
    println!("\nGODS (believers | breadth x depth = power):");
    println!(
        "  town-god believers: {}   |   wild-god believers: {}   |   faithless: {}",
        town_bel, wild_bel, faithless
    );
    let dname = |d: u8| match d {
        0 => "town",
        1 => "wild",
        2 => "war",
        3 => "dread",
        4 => "comfort",
        5 => "fortune",
        6 => "craft",
        7 => "death",
        _ => "?",
    };
    let mut gl: Vec<String> = Vec::new();
    for (gi, g) in w.gods.iter().enumerate() {
        gl.push(format!(
            "g{}:{}bel {}x{}={}p({})",
            gi + 1, g.believers, g.breadth, g.depth, g.power(), dname(g.domain)
        ));
    }
    println!("  per-god: {:?}", gl);
    let contracted = (0..w.n).filter(|&i| w.contract_god[i] != 0).count();
    let mut tithed = vec![0usize; w.gods.len() + 1];
    for i in 0..w.n {
        let c = w.contract_god[i] as usize;
        if c > 0 && c <= w.gods.len() {
            tithed[c] += 1;
        }
    }
    let recruiters = (1..=w.gods.len()).filter(|&c| tithed[c] > 0).count();
    println!(
        "  contracts: {} followers under contract, held by {} gods   |   shrine fund: {}",
        contracted, recruiters, w.shrine_fund
    );
    let born = w.chronicle.iter().filter(|b| b.kind == 70).count();
    let died = w.chronicle.iter().filter(|b| b.kind == 71).count();
    let living = w.gods.iter().filter(|g| g.active).count();
    println!(
        "  pantheon: {} living of {} slots   |   gods born {} · gods died {} (recent chronicle)",
        living, w.gods.len(), born, died
    );

    // FAITH EFFECT: do wild-god believers actually run hotter (anger) and fight more than town believers?
    use sim_core::components::GoalKind;
    let mut tot = [0usize; 3]; // 0 town-faith, 1 wild-faith, 2 faithless
    let mut anger_sum = [0f32; 3];
    let mut fighting = [0usize; 3];
    for i in 0..w.n {
        if !(w.alive[i] && w.faction[i] == Faction::Townsfolk as u8) {
            continue;
        }
        let g = w.faith[i] as usize;
        let cls = if g == 0 {
            2
        } else if w.gods[g - 1].domain == DOMAIN_WILD_SITE {
            1
        } else {
            0
        };
        tot[cls] += 1;
        anger_sum[cls] += w.mood[i].anger;
        if matches!(w.goal[i].kind(), GoalKind::Fight) {
            fighting[cls] += 1;
        }
    }
    let avg = |s: f32, n: usize| if n > 0 { s / n as f32 } else { 0.0 };
    println!("\nFAITH EFFECT (mood-coloured behaviour):");
    println!(
        "  town-faithful: avg-anger {:.2}, fighting {}/{}",
        avg(anger_sum[0], tot[0]), fighting[0], tot[0]
    );
    println!(
        "  wild-faithful: avg-anger {:.2}, fighting {}/{}",
        avg(anger_sum[1], tot[1]), fighting[1], tot[1]
    );
    println!(
        "  faithless:     avg-anger {:.2}, fighting {}/{}",
        avg(anger_sum[2], tot[2]), fighting[2], tot[2]
    );
}
