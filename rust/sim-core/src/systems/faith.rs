//! Faith / gods (`systems/faith.rs`). A god is sustained by belief (its `believers` count); the more
//! believers, the more contagious it is. Functional power is breadth x depth (components::God); effects
//! aren't wired yet, so this file only tracks belief. Two domains compete for souls today: SETTLEMENT
//! gods (spread among a town's residents) and WILD_SITE gods seated in the wild (they claim souls who go
//! out there). `world.gods` is the registry; `faith[i]` (1-based) is the god agent `i` believes (0 = NO_GOD).
//!
//! Passes (serial society phase, so M-invariant):
//! - POWER: recompute each god's believer count (folded into the world hash).
//! - BOOTSTRAP: until anyone believes, seed each town with a patron town-god flock + a small wild-god cult.
//! - WILD CLAIM: a believer out in the wild (beyond every town's edge — foragers, expeditions, refugees)
//!   may convert to the nearest wild god (chance rises with the god's power). This is how wild faith first
//!   appears, since no resident is in the wild while at home; it then spreads when the convert returns.
//! - SPREAD: a faithless townsperson adopts the locally dominant faith among near neighbours (bandwagon,
//!   sub-linear in the god's global power). Works for any god.
//! - DOUBT: believers lapse at random; crowding raises the lapse rate for a large god; a small god's last
//!   believers are protected. Wild-god faith lapses slowly in the wild and quickly in town.
//!
//! Determinism: serial. SPREAD reads neighbours' faith while writing faith, so it decides against the
//! frozen column then applies. Rolls use a dedicated `world.faith_rng` so faith never perturbs the
//! economy's `sim_rng`. No gold, no spawns.

use crate::components::{Faction, DOMAIN_SETTLEMENT, DOMAIN_WILD_SITE, MAX_VISION, NO_GOD};
use crate::world::World;

const TICK_EVERY: u32 = 3; // ticks between passes.
const BOOT_FLOCK: usize = 14; // believers seeded to each town's patron town-god at bootstrap.
const WILD_CULT_FLOCK: usize = 4; // believers seeded to a wild god in each town at bootstrap (so wild
                                  // faith has a foothold and its rise doesn't depend on a lucky first claim).
const CONVERT_RANGE: f32 = 10.0; // a neighbour within this counts toward a local flock.
const CONVERT_RANGE2: f32 = CONVERT_RANGE * CONVERT_RANGE;
// The grid's 3x3 query is only a superset of CONVERT_RANGE if the range fits one cell.
const _: () = assert!(CONVERT_RANGE <= MAX_VISION, "convert range must fit the grid cell (MAX_VISION)");
const CONVERT_CHANCE: f32 = 0.05; // base per-pass chance a faithless soul adopts a nearby faith.
const POWER_CONVERT_BONUS: f32 = 0.04; // + this per sqrt(flock) (sub-linear bandwagon).
const CONVERT_CHANCE_MAX: f32 = 0.9;
const DOUBT_CHANCE: f32 = 0.012; // base per-pass chance a believer lapses.
const CROWD_DOUBT_AT: f32 = 70.0; // flock size at which crowding ~doubles the lapse rate.
const SMALL_GOD_AT: usize = 1; // <= this many believers => protected (the last believers don't lapse).

// Wild-god claiming.
const WILD_EDGE: f32 = 250.0; // beyond this of every town centre, a soul counts as out in the wild.
const WILD_EDGE2: f32 = WILD_EDGE * WILD_EDGE;
const CLAIM_BASE: f32 = 0.02; // base per-pass claim chance out in the wild (with no flock).
const CLAIM_POWER_BONUS: f32 = 0.012; // + per sqrt(flock).
const CLAIM_CHANCE_MAX: f32 = 0.5;
// Wild-god faith holds in the wild but lapses fast in town, so it stays a transient minority in town
// (only the freshly-claimed carry it back) while town gods keep the towns.
const WILD_LAPSE_OUT: f32 = 0.3; // lapse multiplier out in the wild (slow).
const WILD_LAPSE_TOWN: f32 = 2.5; // lapse multiplier inside a town (fast).

/// Living townsfolk are the only candidates for belief (monsters/raiders have no faith).
#[inline]
fn is_faithful_candidate(w: &World, i: usize) -> bool {
    w.alive[i] && w.faction[i] == Faction::Townsfolk as u8
}

/// Per-god believer tally over the live townsfolk roster. `power[g]` = believers of god id `g`
/// (1-based; slot 0 = NO_GOD is unused). Length = `gods.len() + 1`.
fn tally(w: &World) -> Vec<usize> {
    let mut power = vec![0usize; w.gods.len() + 1];
    for i in 0..w.n {
        if !is_faithful_candidate(w, i) {
            continue;
        }
        let g = w.faith[i] as usize;
        if g != NO_GOD as usize && g <= w.gods.len() {
            power[g] += 1;
        }
    }
    power
}

pub fn tick(world: &mut World) {
    if world.tick % TICK_EVERY != 0 || world.gods.is_empty() {
        return;
    }
    let any = (0..world.n).any(|i| is_faithful_candidate(world, i));
    if !any {
        return;
    }

    let power = tally(world);
    let total: usize = power[1..].iter().sum();
    if total == 0 {
        bootstrap(world);
    } else {
        wild_claim(world, &power);
        spread(world, &power);
        doubt(world, &power);
    }

    let post = tally(world);
    for (gi, g) in world.gods.iter_mut().enumerate() {
        g.believers = post[gi + 1] as u32;
    }
}

/// Seed a starting flock in every town (not just town 0): a BOOT_FLOCK to the town's patron town-god (the
/// pantheon rotates by town so faiths spread out), plus a WILD_CULT_FLOCK to a wild god.
fn bootstrap(world: &mut World) {
    let nt = world.town_centers.len().max(1);
    let town_gods: Vec<u8> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.domain == DOMAIN_SETTLEMENT)
        .map(|(gi, _)| (gi + 1) as u8)
        .collect();
    let wild_gods: Vec<u8> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.domain == DOMAIN_WILD_SITE)
        .map(|(gi, _)| (gi + 1) as u8)
        .collect();
    if town_gods.is_empty() {
        return;
    }
    let mut town_n = vec![0usize; nt];
    let mut wild_n = vec![0usize; nt];
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) || world.faith[i] != NO_GOD {
            continue;
        }
        let t = (world.town[i] as usize).min(nt - 1);
        if town_n[t] < BOOT_FLOCK {
            world.faith[i] = town_gods[t % town_gods.len()];
            town_n[t] += 1;
        } else if !wild_gods.is_empty() && wild_n[t] < WILD_CULT_FLOCK {
            world.faith[i] = wild_gods[t % wild_gods.len()];
            wild_n[t] += 1;
        }
    }
}

/// A believer out in the wild (beyond every town's edge) may convert to the nearest wild god (chance
/// rises with the god's power). It can take the faithless and the town-faithful alike. This is how wild
/// faith first appears; the convert then carries it home where it can spread.
fn wild_claim(world: &mut World, power: &[usize]) {
    let seats: Vec<(usize, [f32; 2], f32)> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.domain == DOMAIN_WILD_SITE)
        .map(|(gi, g)| (gi + 1, g.seat.unwrap_or([0.0, 0.0]), power[gi + 1] as f32))
        .collect();
    if seats.is_empty() {
        return;
    }
    let mut claims: Vec<(usize, u8)> = Vec::new();
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) {
            continue;
        }
        let p = world.pos[i];
        let in_wild = world
            .town_centers
            .iter()
            .all(|c| (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) > WILD_EDGE2);
        if !in_wild {
            continue;
        }
        // nearest wild-god seat (closest, then lowest id).
        let mut best: Option<(usize, f32, f32)> = None;
        for &(gid, home, flock) in &seats {
            let dx = p[0] - home[0];
            let dz = p[1] - home[1];
            let d2 = dx * dx + dz * dz;
            match best {
                Some((_, bd, _)) if d2 >= bd => {}
                _ => best = Some((gid, d2, flock)),
            }
        }
        let Some((gid, _, flock)) = best else { continue };
        if world.faith[i] as usize == gid {
            continue;
        }
        let chance = (CLAIM_BASE + flock.sqrt() * CLAIM_POWER_BONUS).min(CLAIM_CHANCE_MAX);
        if world.faith_rng.next_f32() < chance {
            claims.push((i, gid as u8));
        }
    }
    for (i, g) in claims {
        world.faith[i] = g;
    }
}

/// Each faithless townsperson may adopt the locally dominant faith among its near neighbours. Decide
/// against the frozen faith column, then apply, so neighbour reads are order-independent.
fn spread(world: &mut World, power: &[usize]) {
    let n_gods = world.gods.len();
    let mut adoptions: Vec<(usize, u8)> = Vec::new();
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) || world.faith[i] != NO_GOD {
            continue;
        }
        let mut local = vec![0usize; n_gods + 1];
        let [x, z] = world.pos[i];
        world.grid.for_near(x, z, |p| {
            let j = p.id as usize;
            if j == i || j >= world.n || p.flags & 1 == 0 {
                return; // self, a percept (id >= n), or the dead.
            }
            let g = world.faith[j] as usize;
            if g == NO_GOD as usize || g > n_gods {
                return;
            }
            let dx = p.x - x;
            let dz = p.z - z;
            if dx * dx + dz * dz <= CONVERT_RANGE2 {
                local[g] += 1;
            }
        });
        let mut best_god: u8 = NO_GOD;
        let mut best_n = 0usize;
        for g in 1..=n_gods {
            if local[g] > best_n {
                best_n = local[g];
                best_god = g as u8;
            }
        }
        // one roll per eligible agent (drawn before the no-neighbour early-out, so draw count is stable).
        let roll = world.faith_rng.next_f32();
        if best_god == NO_GOD {
            continue;
        }
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

/// Believers lapse to NO_GOD at random. Crowding raises the rate for a large god; a small god's last
/// believers are protected (running live count). Wild-god faith lapses slowly in the wild, fast in town.
fn doubt(world: &mut World, power: &[usize]) {
    let n_gods = world.gods.len();
    let mut live: Vec<usize> = power.to_vec();
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) {
            continue;
        }
        let g = world.faith[i] as usize;
        if g == NO_GOD as usize || g > n_gods {
            continue;
        }
        if live[g] <= SMALL_GOD_AT {
            continue;
        }
        let mut lapse = DOUBT_CHANCE * (1.0 + power[g] as f32 / CROWD_DOUBT_AT);
        if world.gods[g - 1].domain == DOMAIN_WILD_SITE {
            let p = world.pos[i];
            let in_town = world
                .town_centers
                .iter()
                .any(|c| (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) <= WILD_EDGE2);
            lapse *= if in_town { WILD_LAPSE_TOWN } else { WILD_LAPSE_OUT };
        }
        if world.faith_rng.next_f32() < lapse {
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

    fn power_of(w: &World, g: u8) -> usize {
        (0..w.n)
            .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 && w.faith[i] == g)
            .count()
    }

    #[test]
    fn worldgen_seats_town_and_wild_gods() {
        let w = World::spawn(0x60D5, 5000);
        let town = w.gods.iter().filter(|g| g.domain == DOMAIN_SETTLEMENT).count();
        let wild = w.gods.iter().filter(|g| g.domain == DOMAIN_WILD_SITE).count();
        assert!(town >= 1, "town gods are seated in the towns");
        assert!(wild >= 1, "wild gods are seated at wilderness sites");
    }

    #[test]
    fn bootstrap_then_faith_takes_hold() {
        let mut w = World::spawn(0x_FA17, 400);
        let town_ids: Vec<u8> = w
            .gods
            .iter()
            .enumerate()
            .filter(|(_, g)| g.domain == DOMAIN_SETTLEMENT)
            .map(|(gi, _)| (gi + 1) as u8)
            .collect();
        assert_eq!(town_ids.iter().map(|&g| power_of(&w, g)).sum::<usize>(), 0);
        for _ in 0..240 {
            w.tick();
        }
        let total: usize = town_ids.iter().map(|&g| power_of(&w, g)).sum();
        assert!(total >= BOOT_FLOCK, "a town faith must take hold (got {total} believers)");
    }

    #[test]
    fn a_wild_god_claims_a_soul_in_the_wild() {
        let mut w = World::spawn(0x6104, 400);
        let (gid, seat) = w
            .gods
            .iter()
            .enumerate()
            .find(|(_, g)| g.domain == DOMAIN_WILD_SITE)
            .map(|(gi, g)| (gi + 1, g.seat.unwrap_or([0.0, 0.0])))
            .expect("a wild god is seated");
        let stray = (0..w.n)
            .find(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8)
            .unwrap();
        w.pos[stray] = seat; // out in the wild at the god's seat
        w.faith[stray] = NO_GOD;
        let mut power = vec![0usize; w.gods.len() + 1];
        power[gid] = 30; // an existing flock, so the claim chance is meaningful
        let mut claimed = false;
        for _ in 0..400 {
            wild_claim(&mut w, &power);
            if w.faith[stray] as usize == gid {
                claimed = true;
                break;
            }
        }
        assert!(claimed, "a soul out in the wild near a wild god is claimed");
    }

    #[test]
    fn a_dominant_faith_spreads_to_a_neighbour() {
        let mut w = World::spawn(0x_C0FFEE, 60);
        for i in 0..w.n {
            w.faith[i] = NO_GOD;
        }
        let towns: Vec<usize> = (0..w.n)
            .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8)
            .take(12)
            .collect();
        assert!(towns.len() >= 6, "need a handful of townsfolk for the cluster");
        let target = *towns.last().unwrap();
        for &i in &towns {
            w.pos[i] = [0.0, 0.0];
        }
        let g1 = w.gods.iter().position(|g| g.domain == DOMAIN_SETTLEMENT).map(|p| (p + 1) as u8).unwrap();
        for &i in &towns[..towns.len() - 1] {
            w.faith[i] = g1;
        }
        w.build_surface();
        let power = tally(&w);
        assert!(power[g1 as usize] >= 5, "the local flock must be sizable");
        let mut converted = false;
        for _ in 0..200 {
            spread(&mut w, &power);
            if w.faith[target] == g1 {
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
