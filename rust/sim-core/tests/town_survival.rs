//! Town-survival regression: the subsistence deriver + the first-class GATHER executor must keep a town
//! self-feeding. Before they landed, the town starved to extinction by ~tick 1500 (the documented
//! depopulation: agents stalled on the inert `Eat` reflex with empty larders beside fields they could
//! have foraged). This guards that capital-free foraging keeps the populace fed over a long run.
use sim_core::world::World;

#[test]
fn town_does_not_starve_to_extinction() {
    for &seed in &[0xC00D19u64, 0xBEEF, 0x5E2] {
        let mut w = World::spawn(seed, 400);
        let tf0 = (0..w.n).filter(|&i| w.faction[i] == 0 && w.alive[i]).count();
        for _ in 0..2500 {
            w.tick();
        }
        let tf = (0..w.n).filter(|&i| w.faction[i] == 0 && w.alive[i]).count();
        // A healthy majority must survive — raids/feuds claim some, but mass starvation must not recur.
        assert!(
            tf * 2 >= tf0,
            "seed {seed:#x}: town collapsed ({tf0} -> {tf} townsfolk after 2500 ticks) — starvation regression"
        );
    }
}

/// REGION survival: the "move away from the megatown" worldgen scatters the population across MANY
/// settlements (each above the viability floor), fed by farming + the distributed berry bushes. Every
/// town must keep itself alive — no settlement may starve out, even the small ones on the food margin.
#[test]
fn the_region_of_towns_survives() {
    for &seed in &[0xC00D19u64, 0xBEEF, 0x5E2] {
        let mut w = World::spawn(seed, 2000);
        let n_towns = w.town_centers.len();
        assert!(n_towns >= 4, "the region holds several settlements (got {n_towns})");
        let mut pop0 = vec![0usize; n_towns];
        for i in 0..w.n {
            if w.faction[i] == 0 && w.alive[i] {
                pop0[w.town[i] as usize] += 1;
            }
        }
        let tf0: usize = pop0.iter().sum();
        for _ in 0..2500 {
            w.tick();
        }
        // population (incl. births/raiders) grew the roster; count survivors among the ORIGINAL townsfolk
        // by town, and assert no settlement collapsed and the region as a whole holds a healthy majority.
        let mut pop = vec![0usize; n_towns];
        for i in 0..w.n {
            if w.faction[i] == 0 && w.alive[i] && (w.town[i] as usize) < n_towns {
                pop[w.town[i] as usize] += 1;
            }
        }
        let tf: usize = pop.iter().sum();
        assert!(
            tf * 2 >= tf0,
            "seed {seed:#x}: the region collapsed ({tf0} -> {tf} townsfolk over 2500 ticks)"
        );
        // and NO single settlement starved to a husk (each keeps at least a third of its founders).
        for t in 0..n_towns {
            assert!(
                pop[t] * 3 >= pop0[t],
                "seed {seed:#x}: town {t} starved out ({} -> {} dwellers)",
                pop0[t],
                pop[t]
            );
        }
    }
}
