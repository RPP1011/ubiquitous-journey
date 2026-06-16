//! SMALL GODS (`systems/faith.rs`) — a Pratchett *Small Gods* × Pale Lights synthesis. A god is
//! CONSTITUTED by belief: its power IS the fervour of its believers, so belief feeds back on itself
//! (belief -> power -> contagion -> more belief). Two ORIGINS contend for the same souls across the
//! Glare/Gloam axis: WARM hearth-gods seated at a town's shrine (they spread among the settled), and
//! ELDRITCH gloam-gods seated at a wilderness lair (old hungry things that CLAIM souls who stray into
//! the dark). The registry is `world.gods`; `faith[i]` (1-based) is which god agent `i` believes.
//!
//! PASSES (SERIAL society phase ⇒ trivially M-invariant):
//! - POWER: recompute each god's believer count (the substance) — folded into the world hash.
//! - BOOTSTRAP: until anyone believes, anoint a starting flock to each WARM god (the towns begin pious;
//!   the gloam-gods start at nothing and grow only by feeding).
//! - CLAIM (eldritch): a soul out in the WILD (beyond every town's edge — a forager, an expedition, a
//!   refugee crossing) stands in the gloam and may be taken by the nearest dark god (chance rises with
//!   the god's power). The dark even steals the warm-faithful; this is how eldritch faith SEEDS, then
//!   rides the claimed soul's faith home — but the Glare burns it back out of the lit towns (DOUBT).
//! - SPREAD: a faithless townsperson adopts the locally-dominant faith among near neighbours (bandwagon,
//!   sub-linear in the god's global power). Works for ANY god, so a dark faith carried home contends.
//! - DOUBT: believers lapse at random; crowding lifts the lapse rate for a god grown great; a small
//!   god's last believers are protected (it smoulders); ELDRITCH faith lapses slower (the dark holds on).
//!
//! Determinism: serial ⇒ M-invariant. SPREAD reads neighbours' faith while writing faith, so it is
//! READ-then-WRITE (decide against the frozen column, then apply). Rolls go through a DEDICATED
//! `world.faith_rng` stream so faith tuning never perturbs the economy's `sim_rng`. No gold, no spawns.

use crate::components::{Faction, GOD_ELDRITCH, GOD_WARM, MAX_VISION, NO_GOD};
use crate::world::World;

const TICK_EVERY: u32 = 3; // ticks between passes (throttle).
const BOOT_FLOCK: usize = 14; // believers anointed to EACH town's patron warm god at bootstrap (enough
                              // to seed local dominance so spread can take hold in a spread-out town).
const DARKLING_FLOCK: usize = 4; // a secret cult anointed to a gloam-god in EACH town at bootstrap (the
                                 // dark's foothold — the Glare burns most out, but ≥1 smoulders and the
                                 // wild-claims amplify it; makes the gloam's rise reliable).
const CONVERT_RANGE: f32 = 10.0; // a neighbour must be within this to count toward a local flock.
const CONVERT_RANGE2: f32 = CONVERT_RANGE * CONVERT_RANGE;
// The grid's 3×3 query is only a superset of CONVERT_RANGE if the convert radius fits one cell.
const _: () = assert!(CONVERT_RANGE <= MAX_VISION, "convert range must fit the grid cell (MAX_VISION)");
const CONVERT_CHANCE: f32 = 0.05; // base per-pass chance a faithless soul adopts a nearby faith.
const POWER_CONVERT_BONUS: f32 = 0.04; // + this per √(flock) (sub-linear bandwagon).
const CONVERT_CHANCE_MAX: f32 = 0.9;
const DOUBT_CHANCE: f32 = 0.012; // base per-pass chance a believer lapses.
const CROWD_DOUBT_AT: f32 = 70.0; // flock size at which crowding ~doubles the lapse rate.
const SMALL_GOD_AT: usize = 1; // ≤ this many believers ⇒ protected (the last of the faithful).

// ── ELDRITCH claiming (the Gloam reaching for souls who stray into the wild) ──
const GLOAM_EDGE: f32 = 250.0; // beyond this of EVERY town centre, a soul stands in the wild/the gloam.
const GLOAM_EDGE2: f32 = GLOAM_EDGE * GLOAM_EDGE;
const CLAIM_BASE: f32 = 0.02; // base per-pass chance out in the gloam (faint with no flock; snowballs).
const CLAIM_POWER_BONUS: f32 = 0.012; // + per √(flock) — the dark grows hungrier as it feeds.
const CLAIM_CHANCE_MAX: f32 = 0.5;
// The Glare/Gloam axis as apostasy: the dark holds fast in the WILD but is BURNED OUT of the lit towns,
// so eldritch faith is transient at the hearth (only the freshly-claimed carry it home) and warm gods
// keep the towns — a standing frontier struggle, not a conquest.
const ELDRITCH_WILD_LAPSE: f32 = 0.3; // multiplier on doubt out in the gloam (the dark holds)
const ELDRITCH_LIGHT_LAPSE: f32 = 2.5; // multiplier in a lit town (the Glare burns the dark out)

/// Living, autonomous townsfolk are the only candidates for belief (monsters/raiders have no faith).
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
        return; // town not populated yet (or all dead).
    }

    let power = tally(world);
    let total: usize = power[1..].iter().sum();
    if total == 0 {
        bootstrap(world); // the towns begin pious to their hearth-gods.
    } else {
        eldritch_claim(world, &power); // the gloam seeds itself among wilderness-strayers...
        spread(world, &power); // ...then any faith rides neighbour-to-neighbour
        doubt(world, &power);
    }

    // POWER: recompute the substance of each god from the post-pass faithful (folded into the hash).
    let post = tally(world);
    for (gi, g) in world.gods.iter_mut().enumerate() {
        g.power = post[gi + 1] as u32;
    }
}

/// Anoint a starting flock in EVERY town (not just town 0 — the old id-order anoint concentrated all
/// faith in the first town and the rest stayed godless). Each settlement gets a patron WARM god (the
/// pantheon rotates by town so faiths spread out geographically) plus a small DARKLING cult to a
/// gloam-god — so both the town faiths and the dark's foothold contend from the outset, region-wide.
fn bootstrap(world: &mut World) {
    let nt = world.town_centers.len().max(1);
    let warm: Vec<u8> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.origin == GOD_WARM)
        .map(|(gi, _)| (gi + 1) as u8)
        .collect();
    let gloam: Vec<u8> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.origin == GOD_ELDRITCH)
        .map(|(gi, _)| (gi + 1) as u8)
        .collect();
    if warm.is_empty() {
        return;
    }
    let mut warm_n = vec![0usize; nt];
    let mut dark_n = vec![0usize; nt];
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) || world.faith[i] != NO_GOD {
            continue;
        }
        let t = (world.town[i] as usize).min(nt - 1);
        if warm_n[t] < BOOT_FLOCK {
            world.faith[i] = warm[t % warm.len()]; // the town's patron hearth-god
            warm_n[t] += 1;
        } else if !gloam.is_empty() && dark_n[t] < DARKLING_FLOCK {
            world.faith[i] = gloam[t % gloam.len()]; // the town's secret darkling cult
            dark_n[t] += 1;
        }
    }
}

/// ELDRITCH CLAIM: a soul out in the WILD (beyond every town's edge — a forager, a marching expedition,
/// a refugee crossing) stands in the gloam and may be taken by the nearest hungry god (chance rises with
/// the god's power). It steals the faithless AND the warm-faithful — the temptation of the deep dark.
/// This is how eldritch faith first APPEARS (no townsperson is ever in the wild while safe at home),
/// then it rides the claimed soul's faith home to spread among neighbours.
fn eldritch_claim(world: &mut World, power: &[usize]) {
    // gloam-god seats: (1-based id, seat, flock).
    let seats: Vec<(usize, [f32; 2], f32)> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.origin == GOD_ELDRITCH)
        .map(|(gi, g)| (gi + 1, g.home, power[gi + 1] as f32))
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
        // out in the wild? (beyond GLOAM_EDGE of EVERY town centre — standing in the gloam).
        let in_wild = world
            .town_centers
            .iter()
            .all(|c| (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) > GLOAM_EDGE2);
        if !in_wild {
            continue;
        }
        // the NEAREST gloam-god reaches for it (closest seat, then lowest id — deterministic).
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
            continue; // already this god's own
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

/// PROSELYTISE: each faithless townsperson may adopt the locally-dominant faith among its near
/// neighbours. READ-then-WRITE against the frozen faith column so neighbour reads are order-independent.
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
                return; // self, a percept (id ≥ n), or the dead.
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
        // one roll per eligible agent (consumed before the no-neighbour early-out — order-stable).
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

/// DOUBT: believers lapse to NO_GOD at random. Crowding lifts the rate for a god grown great; a small
/// god's final believers are protected (smoulder, don't extinguish, via a running live count); ELDRITCH
/// faith lapses slower (the dark holds on). Own-write; id-order scan keeps the running count deterministic.
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
            continue; // protect the last of the faithful.
        }
        let mut lapse = DOUBT_CHANCE * (1.0 + power[g] as f32 / CROWD_DOUBT_AT);
        if world.gods[g - 1].origin == GOD_ELDRITCH {
            // the dark holds in the wild, but the Glare burns it out of the lit towns.
            let p = world.pos[i];
            let in_light = world
                .town_centers
                .iter()
                .any(|c| (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) <= GLOAM_EDGE2);
            lapse *= if in_light { ELDRITCH_LIGHT_LAPSE } else { ELDRITCH_WILD_LAPSE };
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
    fn worldgen_seats_warm_and_eldritch_gods() {
        let w = World::spawn(0x60D5, 5000);
        let warm = w.gods.iter().filter(|g| g.origin == GOD_WARM).count();
        let eldritch = w.gods.iter().filter(|g| g.origin == GOD_ELDRITCH).count();
        assert!(warm >= 1, "warm hearth-gods are seated in the towns");
        assert!(eldritch >= 1, "eldritch gloam-gods are seated at lairs");
    }

    #[test]
    fn bootstrap_then_faith_takes_hold() {
        let mut w = World::spawn(0x_FA17, 400);
        let warm_ids: Vec<u8> = w
            .gods
            .iter()
            .enumerate()
            .filter(|(_, g)| g.origin == GOD_WARM)
            .map(|(gi, _)| (gi + 1) as u8)
            .collect();
        assert_eq!(warm_ids.iter().map(|&g| power_of(&w, g)).sum::<usize>(), 0);
        for _ in 0..240 {
            w.tick();
        }
        let total: usize = warm_ids.iter().map(|&g| power_of(&w, g)).sum();
        assert!(total >= BOOT_FLOCK, "a town faith must take hold (got {total} believers)");
    }

    #[test]
    fn the_gloam_claims_a_soul_that_strays_to_a_lair() {
        let mut w = World::spawn(0x6104, 400);
        let (gid, seat) = w
            .gods
            .iter()
            .enumerate()
            .find(|(_, g)| g.origin == GOD_ELDRITCH)
            .map(|(gi, g)| (gi + 1, g.home))
            .expect("a gloam-god is seated");
        let stray = (0..w.n)
            .find(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8)
            .unwrap();
        w.pos[stray] = seat; // a soul wanders to the very mouth of the lair
        w.faith[stray] = NO_GOD;
        // a flock already feeds this dark god, so its reach is real.
        let mut power = vec![0usize; w.gods.len() + 1];
        power[gid] = 30;
        let mut claimed = false;
        for _ in 0..400 {
            eldritch_claim(&mut w, &power);
            if w.faith[stray] as usize == gid {
                claimed = true;
                break;
            }
        }
        assert!(claimed, "a soul that strays into the gloam near a hungry god is claimed");
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
        // a warm god id (the first warm hearth-god).
        let g1 = w.gods.iter().position(|g| g.origin == GOD_WARM).map(|p| (p + 1) as u8).unwrap();
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
