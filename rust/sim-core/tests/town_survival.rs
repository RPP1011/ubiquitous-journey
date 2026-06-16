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
