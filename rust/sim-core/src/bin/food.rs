//! Food-economy probe — run the region sim and report whether farmers actually FEED the settlements.
//! Measures the three candidate bottlenecks separately: raw production capacity, farmer UPTIME (are
//! they standing at the field producing, or off doing other things?), and DISTRIBUTION (does food
//! reach non-farmers, or do smiths/miners starve while the granary sits full?).
//!
//!   cargo run --release --bin food            # defaults: N=5000, ticks=2000
//!   cargo run --release --bin food 5000 4000

use sim_core::components::{Commodity, Faction, GoalKind};
use sim_core::world::World;

const WORK_RANGE2: f32 = 6.0 * 6.0; // mirror market.rs WORK_RANGE
const FOOD: usize = Commodity::Food as usize;

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[i.min(sorted.len() - 1)]
}
fn mean(v: &[f64]) -> f64 {
    if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 }
}

fn report(w: &World, label: &str) {
    let nt = w.town_centers.len();
    let folk: Vec<usize> = (0..w.n)
        .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8)
        .collect();
    let farmers: Vec<usize> = folk.iter().copied().filter(|&i| w.profession[i] == 1).collect();

    // hunger distribution
    let mut hunger: Vec<f64> = folk.iter().map(|&i| w.needs[i].hunger as f64).collect();
    hunger.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let seeking = folk.iter().filter(|&&i| w.needs[i].hunger < 0.4).count(); // HUNGER_SEEK
    let famished = folk.iter().filter(|&&i| w.needs[i].hunger < 0.15).count();
    let starving = folk.iter().filter(|&&i| w.needs[i].starve > 0.0).count();

    // farmer uptime: fraction of farmers standing at their own farm site this tick
    let at_field = farmers
        .iter()
        .filter(|&&i| {
            let t = (w.town[i] as usize).min(w.work_sites.len() - 1);
            let s = w.work_sites[t][0]; // farmer site index = prof-1 = 0
            let (dx, dz) = (w.pos[i][0] - s[0], w.pos[i][1] - s[1]);
            dx * dx + dz * dz <= WORK_RANGE2
        })
        .count();
    // farmer goal mix
    let mut goal_work = 0;
    let mut goal_eat = 0;
    let mut goal_market = 0;
    let mut goal_other = 0;
    for &i in &farmers {
        match w.goal[i].kind() {
            GoalKind::Work => goal_work += 1,
            GoalKind::Eat => goal_eat += 1,
            GoalKind::Market => goal_market += 1,
            _ => goal_other += 1,
        }
    }

    // food on hand: farmers vs non-farmers
    let nonf: Vec<usize> = folk.iter().copied().filter(|&i| w.profession[i] != 1).collect();
    let f_food = mean(&farmers.iter().map(|&i| w.econ[i].inventory[FOOD] as f64).collect::<Vec<_>>());
    let nf_food = mean(&nonf.iter().map(|&i| w.econ[i].inventory[FOOD] as f64).collect::<Vec<_>>());
    let nf_empty = nonf.iter().filter(|&&i| w.econ[i].inventory[FOOD] == 0).count();
    let granary: i32 = w.granary_stock.iter().sum();
    let gran_full = w.granary_stock.iter().filter(|&&s| s >= 800).count();

    // anomaly check: PRODUCE_CAP is 64, so how do farmers hold more?
    let f_max = farmers.iter().map(|&i| w.econ[i].inventory[FOOD]).max().unwrap_or(0);
    let f_overcap = farmers.iter().filter(|&&i| w.econ[i].inventory[FOOD] > 64).count();
    let world_food: i64 = (0..w.n).filter(|&i| w.alive[i]).map(|i| w.econ[i].inventory[FOOD] as i64).sum::<i64>() + granary as i64;
    println!(
        "  [debug] farmer food max {}  over-cap(>64) {}  | total world food (alive inv + granary) {}",
        f_max, f_overcap, world_food
    );
    // who is the single biggest food holder, and what are they? (trace the stockpiling path)
    if let Some(top) = (0..w.n).filter(|&i| w.alive[i]).max_by_key(|&i| w.econ[i].inventory[FOOD]) {
        println!(
            "  [debug] TOP holder: id {} prof {} faction {} gold {} food {} | full inv {:?} | goal {:?}",
            top, w.profession[top], w.faction[top], w.econ[top].gold,
            w.econ[top].inventory[FOOD], w.econ[top].inventory, w.goal[top].kind()
        );
    }

    println!("── {label} ──");
    println!(
        "  pop {}  farmers {} ({:.1}%)  | {} towns",
        folk.len(),
        farmers.len(),
        100.0 * farmers.len() as f64 / folk.len().max(1) as f64,
        nt
    );
    println!(
        "  HUNGER: mean {:.2}  p10 {:.2}  p25 {:.2}  median {:.2}  | seeking(<0.4) {} ({:.0}%)  famished(<0.15) {}  starving(clock>0) {}",
        mean(&hunger),
        pct(&hunger, 10.0),
        pct(&hunger, 25.0),
        pct(&hunger, 50.0),
        seeking,
        100.0 * seeking as f64 / folk.len().max(1) as f64,
        famished,
        starving,
    );
    println!(
        "  FARMER UPTIME: {}/{} at field ({:.0}%)  | goals: work {} eat {} market {} other {}",
        at_field,
        farmers.len(),
        100.0 * at_field as f64 / farmers.len().max(1) as f64,
        goal_work,
        goal_eat,
        goal_market,
        goal_other,
    );
    println!(
        "  FOOD ON HAND: farmer avg {:.1}  non-farmer avg {:.1}  | non-farmers empty {}/{} ({:.0}%)",
        f_food,
        nf_food,
        nf_empty,
        nonf.len(),
        100.0 * nf_empty as f64 / nonf.len().max(1) as f64,
    );
    println!(
        "  GRANARY: total stock {}  | full silos {}/{}",
        granary, gran_full, nt
    );

    // theoretical balance: consumption = pop * HUNGER_DRAIN/EAT_RATE food/tick; capacity = farmers * 1/tick
    let consume = folk.len() as f64 * 0.0040 / 0.34;
    let capacity = farmers.len() as f64; // 1 food/tick at full uptime (ignoring mastery bonus)
    let realized = at_field as f64; // food/tick actually being produced right now
    println!(
        "  BALANCE: need ~{:.1} food/tick | capacity(full uptime) {:.0} | realized(now) {:.0}  -> {}",
        consume,
        capacity,
        realized,
        if realized >= consume { "SURPLUS" } else { "DEFICIT" }
    );
}

fn main() {
    let mut args = std::env::args().skip(1);
    let n: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(5000);
    let ticks: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(2000);
    // optional 3rd arg: target farmer % per town (the "small squad" stress test — demote the rest to
    // Trader, pure consumers). e.g. `food 5000 2000 3` keeps only ~3% farmers and checks the town eats.
    let squad_pct: Option<i32> = args.next().and_then(|s| s.parse().ok());
    let seed = 0xC00D19u64;

    let mut w = World::spawn(seed, n);

    if let Some(pct) = squad_pct {
        // per town, keep ~pct% of townsfolk as farmers (id order), demote the surplus to Trader.
        let nt = w.town_centers.len();
        let mut pop = vec![0i32; nt];
        for i in 0..w.n {
            if w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 {
                pop[(w.town[i] as usize).min(nt - 1)] += 1;
            }
        }
        let quota: Vec<i32> = pop.iter().map(|&p| (p * pct / 100).max(1)).collect();
        let mut kept = vec![0i32; nt];
        let mut demoted = 0;
        for i in 0..w.n {
            if w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 && w.profession[i] == 1 {
                let t = (w.town[i] as usize).min(nt - 1);
                if kept[t] < quota[t] {
                    kept[t] += 1;
                } else {
                    w.profession[i] = 6; // Trader — produces nothing, eats like everyone
                    demoted += 1;
                }
            }
        }
        let farmers: i32 = kept.iter().sum();
        println!(
            "[SQUAD STRESS TEST] target {}% farmers/town: kept {} farmers, demoted {} to Trader\n",
            pct, farmers, demoted
        );
    }
    let snaps = [ticks / 4, ticks / 2, ticks];
    println!("FOOD PROBE — N={n}, seed={seed:#x}\n");
    let mut t = 0u32;
    for &s in &snaps {
        while t < s {
            w.tick();
            t += 1;
        }
        report(&w, &format!("tick {t}"));
        println!();
    }
}
