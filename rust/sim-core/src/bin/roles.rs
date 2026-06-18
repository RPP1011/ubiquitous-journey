//! Role-settling probe — run the region sim and report the LEVEL / XP / CLASS distribution across the
//! living townsfolk. Answers: are agents settling into roles? Do they hold a clear PRIMARY class (where
//! XP routes) plus a SECONDARY, or do they sprawl across many weak classes?
//!
//!   cargo run --release --bin roles            # defaults: N=5000, ticks=3000
//!   cargo run --release --bin roles 8000 5000
//!
//! NOTE ON THE MODEL (see systems/progression.rs): there is ONE `total_level` per agent (the summed
//! level), not a per-class level. Held classes are granted in fixed catalogue order, so `classes[0]` is
//! NOT necessarily the strongest. The TRUE primary = the held class with the highest match score against
//! the agent's own behavior_profile (that's the class XP routes into). This bin recomputes that score,
//! so "primary/secondary" here means by mastery, not by grant order.

use sim_core::components::{Faction, NO_CLASS};
use sim_core::systems::progression::*;
use sim_core::world::World;

const CLASS_NAMES: [&str; 10] = [
    "Warrior", "Farmer", "Miner", "Woodcutter", "Blacksmith", "Merchant", "Mason", "Speaker",
    "Hunter", "Survivor",
];

// Mirror of the private TEMPLATES score profiles in systems/progression.rs (key -> (tag, weight)*).
// Used only to rank an agent's held classes by match strength (the XP-routing argmax).
fn template_score(key: u8) -> &'static [(u8, f32)] {
    match key {
        0 => &[(TAG_MELEE, 1.0), (TAG_KILL, 0.8), (TAG_DEFENSE, 0.4), (TAG_RISK, 0.3)],
        1 => &[(TAG_FARMING, 1.0), (TAG_ENDURANCE, 0.3)],
        2 => &[(TAG_MINING, 1.0), (TAG_ENDURANCE, 0.4)],
        3 => &[(TAG_WOODCUT, 1.0), (TAG_ENDURANCE, 0.3)],
        4 => &[(TAG_SMITHING, 1.0), (TAG_CRAFTING, 0.7)],
        5 => &[(TAG_TRADE, 1.0), (TAG_PROFIT, 0.9)],
        6 => &[(TAG_BUILD, 1.0), (TAG_CRAFTING, 0.6), (TAG_ENDURANCE, 0.4)],
        7 => &[(TAG_PERSUADE, 1.0)],
        8 => &[(TAG_EXPLORE, 0.8), (TAG_KILL, 0.8), (TAG_MELEE, 0.5)],
        9 => &[(TAG_ENDURANCE, 1.0), (TAG_EXPLORE, 0.5)],
        _ => &[],
    }
}

fn match_score(profile: &[f32], key: u8) -> f32 {
    template_score(key).iter().map(|&(t, w)| profile[t as usize] * w).sum()
}

/// Rank an agent's held classes by match score, descending. Returns (key, score) pairs.
fn ranked_classes(classes: &[u8], n: u8, profile: &[f32]) -> Vec<(u8, f32)> {
    let mut v: Vec<(u8, f32)> = classes[..n as usize]
        .iter()
        .filter(|&&k| k != NO_CLASS)
        .map(|&k| (k, match_score(profile, k)))
        .collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    v
}

fn pct(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 }
}

fn stddev(v: &[f64], m: f64) -> f64 {
    if v.len() < 2 {
        return 0.0;
    }
    (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let n: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(5000);
    let ticks: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(3000);
    let seed = 0xC00D19u64;

    let mut w = World::spawn(seed, n);
    for _ in 0..ticks {
        w.tick();
    }

    // Collect living townsfolk progression.
    let folk: Vec<usize> = (0..w.n)
        .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8)
        .collect();
    let total = folk.len();

    let classed: Vec<usize> =
        folk.iter().copied().filter(|&i| w.progression[i].n_classes > 0).collect();
    let leveled: Vec<usize> =
        classed.iter().copied().filter(|&i| w.progression[i].total_level > 0).collect();

    println!("ROLES PROBE — N={n}, ticks={ticks}, seed={seed:#x}");
    println!(
        "  living townsfolk: {total}  |  with >=1 class: {} ({:.0}%)  |  with level>0: {} ({:.0}%)",
        classed.len(),
        100.0 * classed.len() as f64 / total.max(1) as f64,
        leveled.len(),
        100.0 * leveled.len() as f64 / total.max(1) as f64,
    );

    // ── LEVEL DISTRIBUTION (among classed agents) ──
    let mut levels: Vec<f64> =
        classed.iter().map(|&i| w.progression[i].total_level as f64).collect();
    levels.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let lm = mean(&levels);
    println!("\nLEVEL DISTRIBUTION (total_level, among {} classed):", classed.len());
    println!(
        "  mean {:.1}  sd {:.1}  min {:.0}  p10 {:.0}  p25 {:.0}  median {:.0}  p75 {:.0}  p90 {:.0}  max {:.0}",
        lm,
        stddev(&levels, lm),
        levels.first().copied().unwrap_or(0.0),
        pct(&levels, 10.0),
        pct(&levels, 25.0),
        pct(&levels, 50.0),
        pct(&levels, 75.0),
        pct(&levels, 90.0),
        levels.last().copied().unwrap_or(0.0),
    );
    // histogram buckets
    let buckets = [0i32, 1, 3, 5, 10, 20, 40, 80, 141];
    let labels = ["0", "1-2", "3-4", "5-9", "10-19", "20-39", "40-79", "80+"];
    let mut hist = [0usize; 8];
    for &l in &levels {
        let lv = l as i32;
        for b in 0..8 {
            if lv >= buckets[b] && lv < buckets[b + 1] {
                hist[b] += 1;
                break;
            }
        }
    }
    let maxh = hist.iter().copied().max().unwrap_or(1).max(1);
    for b in 0..8 {
        let bar = "#".repeat(40 * hist[b] / maxh);
        println!("  lvl {:<6} {:>5} {}", labels[b], hist[b], bar);
    }

    // ── XP-WITHIN-LEVEL (progress toward next level; xp is x1000 fixed-point, 1000 = a level) ──
    // xp is banked "score points"; the cost of the NEXT level escalates with total_level, so report
    // progress as the fraction xp/need (0..1) using the same rpgxp curve the matcher spends against.
    let fracs: Vec<f64> = classed
        .iter()
        .map(|&i| {
            let p = &w.progression[i];
            let need = sim_core::rpgxp::xp_for_level(p.total_level as f32, p.total_level as f32).max(1.0);
            (p.xp as f64 / need as f64).min(1.0)
        })
        .collect();
    println!("\nXP TOWARD NEXT LEVEL (xp/need, 0..1.0): mean {:.2}", mean(&fracs));

    // ── NUMBER OF CLASSES HELD ──
    let mut ncls = [0usize; 5]; // index 0..4
    for &i in &classed {
        ncls[(w.progression[i].n_classes as usize).min(4)] += 1;
    }
    let mean_nc = mean(&classed.iter().map(|&i| w.progression[i].n_classes as f64).collect::<Vec<_>>());
    println!("\nCLASSES HELD PER AGENT (mean {:.2}):", mean_nc);
    for k in 1..=4 {
        let bar = "#".repeat(40 * ncls[k] / classed.len().max(1));
        println!("  {} class{:<3} {:>5} ({:>4.1}%) {}", k, if k == 1 { "" } else { "es" }, ncls[k], 100.0 * ncls[k] as f64 / classed.len().max(1) as f64, bar);
    }

    // ── PRIMARY CLASS FREQUENCY (by match-score argmax = where XP routes) ──
    let mut prim_count = [0usize; 10];
    let mut pair_count: std::collections::HashMap<(u8, u8), usize> = std::collections::HashMap::new();
    let mut primary_shares: Vec<f64> = Vec::new(); // best/(best+second) for multi-class agents
    for &i in &classed {
        let p = &w.progression[i];
        let ranked = ranked_classes(&p.classes, p.n_classes, &p.behavior_profile);
        if ranked.is_empty() {
            continue;
        }
        prim_count[ranked[0].0 as usize] += 1;
        if ranked.len() >= 2 {
            pair_count.entry((ranked[0].0, ranked[1].0)).and_modify(|c| *c += 1).or_insert(1);
            let (b, s) = (ranked[0].1, ranked[1].1);
            if b + s > 0.0 {
                primary_shares.push((b / (b + s)) as f64);
            }
        }
    }
    println!("\nPRIMARY CLASS (by mastery / XP-routing argmax):");
    let mut order: Vec<(usize, usize)> = prim_count.iter().copied().enumerate().collect();
    order.sort_by(|a, b| b.1.cmp(&a.1));
    for (key, cnt) in order {
        if cnt == 0 {
            continue;
        }
        let bar = "#".repeat(40 * cnt / classed.len().max(1));
        println!(
            "  {:<11} {:>5} ({:>4.1}%) {}",
            CLASS_NAMES[key], cnt, 100.0 * cnt as f64 / classed.len().max(1) as f64, bar
        );
    }

    // ── SPECIALIZATION: do multi-class agents have a CLEAR primary? ──
    // primary-share = bestScore / (bestScore + secondScore). 0.5 = a tie (no real primary), 1.0 = the
    // secondary is vestigial (fully settled into one role).
    if !primary_shares.is_empty() {
        primary_shares.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let ms = mean(&primary_shares);
        let strong = primary_shares.iter().filter(|&&s| s >= 0.7).count();
        println!(
            "\nSPECIALIZATION (multi-class agents, primary-share = best/(best+second)):",
        );
        println!(
            "  mean {:.2}  median {:.2}  | {} of {} ({:.0}%) have a CLEAR primary (share >= 0.70)",
            ms,
            pct(&primary_shares, 50.0),
            strong,
            primary_shares.len(),
            100.0 * strong as f64 / primary_shares.len() as f64,
        );
    }

    // ── TOP PRIMARY -> SECONDARY PAIRINGS ──
    let mut pairs: Vec<((u8, u8), usize)> = pair_count.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1));
    println!("\nTOP PRIMARY -> SECONDARY PAIRINGS:");
    for ((a, b), cnt) in pairs.into_iter().take(10) {
        println!("  {:<11} -> {:<11} {:>5}", CLASS_NAMES[a as usize], CLASS_NAMES[b as usize], cnt);
    }

    // ── MONSTERS (brief, separate — they fight, so they accrue warrior/hunter) ──
    let mons: Vec<usize> = (0..w.n)
        .filter(|&i| w.alive[i] && w.faction[i] == Faction::Monster as u8 && w.progression[i].n_classes > 0)
        .collect();
    if !mons.is_empty() {
        let ml = mean(&mons.iter().map(|&i| w.progression[i].total_level as f64).collect::<Vec<_>>());
        println!("\n(monsters with a class: {} | mean level {:.1})", mons.len(), ml);
    }
}
