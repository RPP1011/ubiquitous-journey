//! FAN-OUT UNIT: faith (small gods whose power scales with believers). Ports the SPIRIT of
//! `js/sim/faith.js` — Discworld *Small Gods*: a god's power IS its number of believers, so belief
//! feeds back on itself (belief → power → contagion → more belief), while a god grown great holds
//! many in name only and the nominal lapse faster (the self-limiting term), and a tiny flock fades.
//!
//! WHAT THIS DOES (SERIAL society phase ⇒ trivially M-invariant):
//! - BOOTSTRAP: once townsfolk exist and nobody yet believes, anoint a small starting flock to each
//!   god (round-robin in id order) so several faiths contend from the outset.
//! - SPREAD: a faithless townsperson adopts the locally-dominant faith among its near neighbours. The
//!   per-pass chance rises SUB-LINEARLY (√flock) with that god's global power (a thriving faith is
//!   contagious — bandwagon — but not so contagious it sweeps the map).
//! - DOUBT: believers lapse to NO_GOD at random, EXCEPT a small god's final believers (protected so
//!   the faith smoulders), and CROWDING raises the lapse rate for a god grown great.
//!
//! Determinism: the SERIAL society phase makes this trivially M-invariant. SPREAD reads neighbours'
//! faith while writing faith, so it runs READ-then-WRITE: it computes the global per-god tallies and
//! collects every adoption against the FROZEN faith column first, then applies them (order-stable).
//! Rolls go through `world.sim_rng` (the world-level stream, not per-entity rng). Touches no gold and
//! never spawns. (No TS parity — doc 22 §9; the tuning below mirrors the SPIRIT of FAITH, not its values.)

use crate::components::{Faction, MAX_VISION, NO_GOD};
use crate::world::World;

// ── tuning (mirrors the SPIRIT of FAITH in js/sim/simconfig.ts) ──
const N_GODS: u8 = 3; // pantheon size; god ids are 1..=N_GODS (NO_GOD = 0).
const TICK_EVERY: u32 = 3; // ticks between spread/doubt passes (throttle).
const BOOT_FLOCK: usize = 5; // believers anointed to EACH god at bootstrap.
const CONVERT_RANGE: f32 = 6.0; // a neighbour must be within this to count toward a local flock.
const CONVERT_RANGE2: f32 = CONVERT_RANGE * CONVERT_RANGE; // squared (compared without a sqrt).
// The grid's 3×3 query is only a superset of `CONVERT_RANGE` if the convert radius fits one cell
// (cell size = MAX_VISION). If this ever fails, spread would silently miss edge-of-cell believers.
const _: () = assert!(CONVERT_RANGE <= MAX_VISION, "convert range must fit the grid cell (MAX_VISION)");
const CONVERT_CHANCE: f32 = 0.05; // base per-pass chance a faithless soul adopts a nearby faith.
const POWER_CONVERT_BONUS: f32 = 0.04; // + this per √(flock) (sub-linear bandwagon).
const CONVERT_CHANCE_MAX: f32 = 0.9; // cap on the per-pass conversion chance.
const DOUBT_CHANCE: f32 = 0.012; // base per-pass chance a believer lapses.
const CROWD_DOUBT_AT: f32 = 70.0; // flock size at which crowding ~doubles the lapse rate.
const SMALL_GOD_AT: usize = 1; // ≤ this many believers ⇒ protected (the last of the faithful).

/// Living, autonomous townsfolk are the only candidates for belief (monsters/raiders/player have no
/// faith). `i` must be a valid agent index.
#[inline]
fn is_faithful_candidate(w: &World, i: usize) -> bool {
    w.alive[i] && w.faction[i] == Faction::Townsfolk as u8
}

/// Per-god believer tally over the live townsfolk roster. Index by god id; slot 0 (NO_GOD) is unused.
/// Also reports whether any townsfolk exist at all (so the caller can early-out on an empty town).
fn tally_power(w: &World) -> ([usize; N_GODS as usize + 1], bool) {
    let mut power = [0usize; N_GODS as usize + 1];
    let mut any = false;
    for i in 0..w.n {
        if !is_faithful_candidate(w, i) {
            continue;
        }
        any = true;
        let g = w.faith[i] as usize;
        if g != NO_GOD as usize && g <= N_GODS as usize {
            power[g] += 1;
        }
    }
    (power, any)
}

pub fn tick(world: &mut World) {
    // Throttle: spread/doubt only every N ticks (cheap, and matches the JS pacing).
    if world.tick % TICK_EVERY != 0 {
        return;
    }

    let (power, any_townsfolk) = tally_power(world);
    if !any_townsfolk {
        return; // town not populated yet (or all dead) — nothing to do.
    }

    // BOOTSTRAP: if nobody believes yet, anoint a starting flock to each god and return (this pass's
    // `power` snapshot is all-zero anyway, so there's nothing to spread/doubt this tick).
    let total_believers: usize = power[1..].iter().sum();
    if total_believers == 0 {
        bootstrap(world);
        return;
    }

    spread(world, &power);
    doubt(world, &power);
}

/// Anoint BOOT_FLOCK believers to each god, round-robin over the faithless in id order so several
/// faiths contend from the outset. Deterministic (id order, fixed quota per god).
fn bootstrap(world: &mut World) {
    let mut anointed = [0usize; N_GODS as usize + 1];
    let mut next_god: u8 = 1;
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) || world.faith[i] != NO_GOD {
            continue;
        }
        // advance to the next god that still needs believers (all full ⇒ stop).
        let mut tries = 0u8;
        while anointed[next_god as usize] >= BOOT_FLOCK && tries < N_GODS {
            next_god = if next_god >= N_GODS { 1 } else { next_god + 1 };
            tries += 1;
        }
        if anointed[next_god as usize] >= BOOT_FLOCK {
            break; // every god has its full boot flock.
        }
        world.faith[i] = next_god;
        anointed[next_god as usize] += 1;
        next_god = if next_god >= N_GODS { 1 } else { next_god + 1 };
    }
}

/// PROSELYTISE: each faithless townsperson may adopt the locally-dominant faith among its near
/// neighbours. READ-then-WRITE: every adoption is decided against the FROZEN faith column (collected
/// into `adoptions`), then applied after the scan — so neighbour reads are order-independent.
fn spread(world: &mut World, power: &[usize; N_GODS as usize + 1]) {
    let mut adoptions: Vec<(usize, u8)> = Vec::new();
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) || world.faith[i] != NO_GOD {
            continue;
        }
        // Tally nearby believers per god (within convert range), reading the grid + the frozen column.
        let mut local = [0usize; N_GODS as usize + 1];
        let [x, z] = world.pos[i];
        world.grid.for_near(x, z, |p| {
            let j = p.id as usize;
            if j == i || j >= world.n || p.flags & 1 == 0 {
                return; // self, a mind-less PERCEPT (id ≥ n), or the dead (flags bit0 = alive).
            }
            let g = world.faith[j] as usize;
            if g == NO_GOD as usize || g > N_GODS as usize {
                return;
            }
            let dx = p.x - x;
            let dz = p.z - z;
            if dx * dx + dz * dz <= CONVERT_RANGE2 {
                local[g] += 1;
            }
        });
        // Pick the locally dominant god (most nearby believers; lowest id breaks ties — deterministic).
        let mut best_god: u8 = NO_GOD;
        let mut best_n = 0usize;
        for g in 1..=N_GODS as usize {
            if local[g] > best_n {
                best_n = local[g];
                best_god = g as u8;
            }
        }
        // Draw EXACTLY ONE roll per eligible faithless agent — before the no-neighbour early-out — so
        // the rng stream advances independently of local geometry (a believer being in range or not
        // never changes how many draws this agent consumes). Keeps consumption order-stable.
        let roll = world.sim_rng.next_f32();
        if best_god == NO_GOD {
            continue; // no believers nearby — nothing to adopt (roll already consumed above).
        }
        // Conversion chance scales SUB-LINEARLY with the god's GLOBAL power (bandwagon, √flock).
        let flock = power[best_god as usize] as f32;
        let chance = (CONVERT_CHANCE + flock.sqrt() * POWER_CONVERT_BONUS).min(CONVERT_CHANCE_MAX);
        if roll < chance {
            adoptions.push((i, best_god));
        }
    }
    for (i, g) in adoptions {
        world.faith[i] = g;
    }
}

/// DOUBT: believers lapse to NO_GOD at random. The crowding lapse rate uses the pre-pass `power`
/// snapshot (stable for the whole pass — a god grown great holds many in name only). A small god's
/// FINAL believers are protected so the faith smoulders and can be revived: protection tests a RUNNING
/// live count (decremented as believers lapse within this pass), so a flock can never be wiped fully
/// to zero in a single pass even if several roll to lapse at once. Apostasy is an OWN-write (no
/// neighbour read) and the id-order scan keeps the running count deterministic.
fn doubt(world: &mut World, power: &[usize; N_GODS as usize + 1]) {
    // Running live believer count per god (seeded from the snapshot, decremented on each lapse).
    let mut live = *power;
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) {
            continue;
        }
        let g = world.faith[i] as usize;
        if g == NO_GOD as usize || g > N_GODS as usize {
            continue;
        }
        if live[g] <= SMALL_GOD_AT {
            continue; // protect the last of the faithful (smoulder, don't extinguish).
        }
        // Crowding scales the lapse rate with the SNAPSHOT flock (great gods shed nominal believers).
        let lapse = DOUBT_CHANCE * (1.0 + power[g] as f32 / CROWD_DOUBT_AT);
        if world.sim_rng.next_f32() < lapse {
            world.faith[i] = NO_GOD;
            live[g] -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Faction, NO_GOD};
    use crate::hash::world_hash;
    use crate::world::World;

    /// Count living townsfolk believers of god `g`.
    fn power_of(w: &World, g: u8) -> usize {
        (0..w.n)
            .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 && w.faith[i] == g)
            .count()
    }

    #[test]
    fn bootstrap_then_faith_takes_hold() {
        let mut w = World::spawn(0x_FA17, 400);
        // Initially nobody believes.
        assert_eq!((1..=N_GODS).map(|g| power_of(&w, g)).sum::<usize>(), 0);
        // Run enough society phases for bootstrap + several spread passes.
        for _ in 0..240 {
            w.tick();
        }
        let total: usize = (1..=N_GODS).map(|g| power_of(&w, g)).sum();
        assert!(
            total >= N_GODS as usize * BOOT_FLOCK,
            "faith must take hold and not collapse below the boot flock (got {total} believers)"
        );
    }

    #[test]
    fn a_dominant_faith_spreads_to_a_neighbour() {
        // Construct the geometry directly (the spawn scatter is too sparse for the convert range):
        // pin a faithless `target` co-located with a dense believer flock of god 1, then drive
        // `spread` directly against a built surface so locomotion can't disperse the cluster.
        let mut w = World::spawn(0x_C0FFEE, 60);
        for i in 0..w.n {
            w.faith[i] = NO_GOD;
        }
        // The first several townsfolk: make them a co-located god-1 flock; the last stays faithless.
        let towns: Vec<usize> = (0..w.n)
            .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8)
            .take(12)
            .collect();
        assert!(towns.len() >= 6, "need a handful of townsfolk for the cluster");
        let target = *towns.last().unwrap();
        for &i in &towns {
            w.pos[i] = [0.0, 0.0]; // co-locate the whole cluster within convert range.
        }
        for &i in &towns[..towns.len() - 1] {
            w.faith[i] = 1; // everyone but the target believes god 1.
        }
        w.build_surface(); // grid now reflects the co-located cluster.

        let (power, _) = tally_power(&w);
        assert!(power[1] >= 5, "the local flock must be sizable");
        let mut converted = false;
        for _ in 0..200 {
            spread(&mut w, &power);
            if w.faith[target] == 1 {
                converted = true;
                break;
            }
        }
        assert!(converted, "a faithless soul amid a dominant flock should convert");
    }

    #[test]
    fn faith_is_deterministic() {
        let run = || {
            let mut w = World::spawn(0x_DEED, 300);
            for _ in 0..150 {
                w.tick();
            }
            world_hash(&w)
        };
        assert_eq!(run(), run(), "faith must be run-to-run deterministic");
    }
}
