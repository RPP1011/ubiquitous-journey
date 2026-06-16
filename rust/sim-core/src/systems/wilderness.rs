//! WILDERNESS LIFE (`systems/wilderness.rs`) — the spaces BETWEEN the settlements are not empty. Monster
//! LAIRS (wilderness dens, placed at worldgen) maintain a garrison of predators: when a lair's territory
//! thins out (its monsters wandered off, were slain by an expedition, or fell in a raid), it spawns a
//! fresh one — so the frontier never fully tames. A newborn predator drifts toward the nearest
//! settlement's borderland, so the wild stays a standing threat that feeds the raid/bounty/expedition
//! systems with material.
//!
//! Serial (society phase) ⇒ trivially M-invariant. Spawns go through `World::spawn_agent` (0 gold ⇒ the
//! gold-conservation gate holds). Bounded by a global monster cap tied to the living population, so the
//! wilderness can never outbreed the world.

use crate::components::{Faction, Goal, Profession};
use crate::world::World;

/// Run the lair pass on this cadence (predators breed slowly, not every tick).
pub const LAIR_EVERY: u32 = 45;
/// A lair keeps roughly this many living monsters within its territory.
const GARRISON: usize = 4;
/// A lair's territory radius (squared) — the range its garrison count is measured over.
const TERRITORY2: f32 = 150.0 * 150.0;
/// Total wild monsters are capped at this fraction of the living townsfolk (the wild can menace the
/// region but never swamp it — and the cap shrinks with the population it preys on).
const MONSTER_CAP_FRAC: f32 = 0.12;
/// A floor so a tiny/depopulated world still has a few predators afield.
const MONSTER_FLOOR: usize = 6;

/// Top up each lair's garrison (one spawn per lair per pass, under a global cap). A new predator starts
/// at its den and drifts toward the nearest settlement's edge — civilisation's standing wilderness threat.
pub fn tick(world: &mut World) {
    if world.tick % LAIR_EVERY != 0 || world.lair_pos.is_empty() {
        return;
    }
    let mon = Faction::Monster as u8;
    let town = Faction::Townsfolk as u8;
    let townsfolk = (0..world.n).filter(|&i| world.alive[i] && world.faction[i] == town).count();
    let monsters = (0..world.n).filter(|&i| world.alive[i] && world.faction[i] == mon).count();
    let cap = (((townsfolk as f32) * MONSTER_CAP_FRAC) as usize).max(MONSTER_FLOOR);
    if monsters >= cap {
        return;
    }
    let mut budget = cap - monsters;
    let lairs = world.lair_pos.clone();
    for &lp in &lairs {
        if budget == 0 {
            break;
        }
        // is this lair's territory already garrisoned?
        let near = (0..world.n)
            .filter(|&i| {
                world.alive[i] && world.faction[i] == mon && {
                    let dx = world.pos[i][0] - lp[0];
                    let dz = world.pos[i][1] - lp[1];
                    dx * dx + dz * dz <= TERRITORY2
                }
            })
            .count();
        if near >= GARRISON {
            continue;
        }
        // spawn a predator just outside the den mouth (a little jitter).
        let a = world.sim_rng.next_f32() * std::f32::consts::TAU;
        let r = 8.0 + world.sim_rng.next_f32() * 16.0;
        let pos = [lp[0] + r * a.cos(), lp[1] + r * a.sin()];
        let id = world.spawn_agent(pos, Faction::Monster, Profession::None);
        world.threat[id] = 6_000 + (world.sim_rng.next_f32() * 4_000.0) as u16;
        world.level[id] = 1 + (world.sim_rng.next_f32() * 6.0) as u8;
        world.ambition[id] = crate::components::AMB_WANDERLUST;
        // a TERRITORIAL predator: it wanders its den's ground, a standing danger to anyone crossing the
        // wild (expeditions, caravans, the player) — the towns' own sieges are the director's job.
        let wa = world.sim_rng.next_f32() * std::f32::consts::TAU;
        let wr = world.sim_rng.next_f32() * 90.0;
        world.goal[id] = Goal::Wander { to: [lp[0] + wr * wa.cos(), lp[1] + wr * wa.sin()] };
        budget -= 1;
    }
}
