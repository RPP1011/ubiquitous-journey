//! FAN-OUT UNIT: decide. Port the spirit of `js/sim/agent/decide.ts` + `js/sim/motivation.js`
//! (goal derivation). NOT the full GOAP planner — a pragmatic scorer is fine (no TS parity, doc 22 §9).
//!
//! WHAT THIS IMPLEMENTS (parallel, own-write — `world.goal`, reading `world.needs`, `world.beliefs`,
//! `world.faction`, `world.profession`, `world.pos`, and the static `world.market`/`work_sites`/`home`):
//! Per agent, settle `goal[i]` from OWN needs + OWN beliefs (the epistemic split — never read another
//! agent's live columns to decide):
//!   1. A genuine survival need wins — the LARGEST deficit of hunger/energy/comfort, once it dips
//!      below its seek threshold, picks `Eat` / `Rest` / `Comfort{home}` respectively.
//!   2. Else a believed-hostile in `beliefs[i]` (cell `flags` bit0 set) near where I believe it is →
//!      `Flee{from}` (the nearest such subject, deterministic id tie-break).
//!   3. Else a working townsperson works its craft, with an occasional rng-gated `Market{market}` trip.
//!   4. Else `Wander{random point near town}` (via `rng[i]`).
//! Determinism: read/write only row `i` (`beliefs[i]`/`rng[i]`/`needs[i]`/`pos[i]` are own-state);
//! randomness only via `world.rng[i]`. No cross-agent reads, no HashMap / float-reduce.

use rayon::prelude::*;

use crate::components::{Faction, Goal, Profession, BELIEF_CAP};
use crate::world::World;

/// Need thresholds — a need is only a candidate once it dips below its seek bar (so a satisfied
/// agent goes about its economic life instead of constantly "eating" at full hunger).
const HUNGER_SEEK: f32 = 0.4;
const ENERGY_SEEK: f32 = 0.35;
const COMFORT_SEEK: f32 = 0.45;

/// Per-tick chance a profession-holder takes a market trip instead of working (rng-gated).
const MARKET_CHANCE: f32 = 0.08;

/// A believed-hostile within this distance of where I believe it is sends me fleeing.
const FLEE_RANGE: f32 = 40.0;
const FLEE_RANGE2: f32 = FLEE_RANGE * FLEE_RANGE;

/// Town radius wander points are drawn within (matches worldgen's cluster radius).
const TOWN_RADIUS: f32 = 180.0;

pub fn decide(world: &mut World) {
    let market = world.market;
    let town_center = world.town_center;

    let World {
        ref needs,
        ref beliefs,
        ref faction,
        ref profession,
        ref pos,
        ref home,
        ref work_sites,
        ref alive,
        ref mut goal,
        ref mut rng,
        ..
    } = *world;

    // Zip `goal` + `rng` so each row owns BOTH its goal slot and its rng stream mutably (the wander/
    // market draws need `rng[i]` mut). Every other read is by-index into shared (`ref`) columns.
    goal.par_iter_mut().zip(rng.par_iter_mut()).enumerate().for_each(|(i, (g, my_rng))| {
        // The dead make no decisions (keep a stable goal — needs/locomotion already guard `alive`).
        if !alive[i] {
            *g = Goal::Idle;
            return;
        }

        let need = &needs[i];

        // 1. SURVIVAL FIRST: the LARGEST deficit below its seek bar claims the body, so a
        //    starving-and-tired agent eats before it rests. Ties resolve hunger > energy > comfort.
        let hunger_def = if need.hunger < HUNGER_SEEK { HUNGER_SEEK - need.hunger } else { 0.0 };
        let energy_def = if need.energy < ENERGY_SEEK { ENERGY_SEEK - need.energy } else { 0.0 };
        let comfort_def = if need.comfort < COMFORT_SEEK { COMFORT_SEEK - need.comfort } else { 0.0 };

        if hunger_def > 0.0 || energy_def > 0.0 || comfort_def > 0.0 {
            if hunger_def >= energy_def && hunger_def >= comfort_def {
                *g = Goal::Eat;
            } else if energy_def >= comfort_def {
                *g = Goal::Rest;
            } else {
                *g = Goal::Comfort { to: home[i] };
            }
            return;
        }

        // 2. THREAT: flee the NEAREST believed-hostile near where I believe it is (belief-only —
        //    `beliefs[i]` is my own state; bit0 of `flags` is the latched-hostile bit). A distant
        //    remembered foe doesn't send me running (range-gated off the believed last position).
        let bt = &beliefs[i];
        let (mx, mz) = (pos[i][0], pos[i][1]);
        let mut flee_from: Option<u32> = None;
        let mut best_d2 = FLEE_RANGE2;
        for b in 0..(bt.len as usize).min(BELIEF_CAP) {
            let cell = &bt.bodies[b];
            if cell.flags & 0x01 == 0 {
                continue; // not believed hostile
            }
            let dx = mx - cell.last_x;
            let dz = mz - cell.last_z;
            let d2 = dx * dx + dz * dz;
            // nearest hostile in reach; deterministic tie-break on subject id (lowest wins).
            if d2 < best_d2 || (d2 == best_d2 && flee_from.map_or(true, |s| cell.subject < s)) {
                best_d2 = d2;
                flee_from = Some(cell.subject);
            }
        }
        if let Some(from) = flee_from {
            *g = Goal::Flee { from };
            return;
        }

        // 3. LIVELIHOOD: a working townsperson works its craft, with an occasional market trip to
        //    trade. Monsters / player (Profession::None) fall through to wander. rng-gated so the
        //    market trip is sprinkled in deterministically (own stream).
        let prof = profession[i];
        if prof != Profession::None as u8 && faction[i] == Faction::Townsfolk as u8 {
            if my_rng.next_f32() < MARKET_CHANCE {
                *g = Goal::Market { site: market };
            } else {
                // work_sites is indexed by (Profession - 1); None=0 occupies no site slot.
                let site_idx = (prof as usize - 1).min(work_sites.len() - 1);
                *g = Goal::Work { site: work_sites[site_idx] };
            }
            return;
        }

        // 4. WANDER: a random point near the town centre (own rng stream; uniform over the disc).
        let r = TOWN_RADIUS * my_rng.next_f32().sqrt();
        let a = my_rng.next_f32() * std::f32::consts::TAU;
        let to = [town_center[0] + r * a.cos(), town_center[1] + r * a.sin()];
        *g = Goal::Wander { to };
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{GoalKind, Needs};
    use crate::world::World;

    #[test]
    fn hungry_agent_picks_eat() {
        let mut w = World::spawn(0xBEEF, 64);
        // Starve agent 0; clear any believed-hostile so survival is the clear winner.
        w.needs[0].hunger = 0.0;
        w.needs[0].energy = 1.0;
        w.needs[0].comfort = 1.0;
        w.beliefs[0].clear();
        decide(&mut w);
        assert_eq!(w.goal[0].kind(), GoalKind::Eat, "a starving agent must choose Eat");
    }

    #[test]
    fn satisfied_townsperson_works_or_trades() {
        let mut w = World::spawn(0xBEEF, 64);
        // Satisfy every working townsperson and clear their hostile beliefs.
        let mut found = false;
        for i in 0..w.n {
            if w.profession[i] != Profession::None as u8 && w.faction[i] == Faction::Townsfolk as u8 {
                w.needs[i] = Needs::default();
                w.beliefs[i].clear();
                found = true;
            }
        }
        assert!(found, "spawn should produce working townsfolk");
        decide(&mut w);
        for i in 0..w.n {
            if w.profession[i] != Profession::None as u8 && w.faction[i] == Faction::Townsfolk as u8 {
                let k = w.goal[i].kind();
                assert!(
                    k == GoalKind::Work || k == GoalKind::Market,
                    "agent {i}: a satisfied working townsperson should Work/Market, got {k:?}"
                );
            }
        }
    }

    #[test]
    fn believed_hostile_triggers_flee() {
        let mut w = World::spawn(0xBEEF, 64);
        w.needs[0] = Needs::default();
        let px = w.pos[0][0];
        let pz = w.pos[0][1];
        let bt = &mut w.beliefs[0];
        bt.clear();
        // plant one believed-hostile cell right next to me.
        bt.subjects[0] = 7;
        bt.bodies[0].subject = 7;
        bt.bodies[0].last_x = px + 2.0;
        bt.bodies[0].last_z = pz + 2.0;
        bt.bodies[0].flags = 0x01;
        bt.len = 1;
        decide(&mut w);
        match w.goal[0] {
            Goal::Flee { from } => assert_eq!(from, 7, "should flee the planted hostile"),
            other => panic!("expected Flee, got {other:?}"),
        }
    }
}
