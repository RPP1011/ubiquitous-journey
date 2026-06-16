//! FAN-OUT UNIT: needs. Port from `js/sim/agent.js` `drainNeeds` + the eat/rest/comfort verbs in
//! `js/sim/agent/act.ts`.
//!
//! WHAT TO IMPLEMENT (parallel, own-write — `world.needs`, `world.econ`, `world.mood`):
//! - Decay each agent's `Needs` over the tick (hunger/energy/social/comfort/novelty toward 0).
//! - In-place satisfaction when the agent's GOAL says so: `Goal::Eat` consumes a Food unit from
//!   `econ[i].inventory` and raises `needs[i].hunger`; `Goal::Rest` raises energy; `Goal::Comfort`
//!   raises comfort. (Locomotion has already walked them to the spot; here is the on-arrival verb.)
//! - Starvation: when hunger sits at 0, this is where a death/`alive=false` would be flagged
//!   (Wave-1 may skip the kill).
//! Determinism: read/write only row `i`. No cross-agent access.
//!
//! The JS source runs `drainNeeds` per RENDER FRAME with a real `dt`; the Rust port runs cognition
//! at a FIXED rate, so each call here is one fixed tick. We fold the JS per-second rates into
//! per-tick constants (no TS parity needed, doc 22 §9) and tune on their own terms. Mood's fast
//! valences (fear/anger) decay here too, mirroring the JS `drainNeeds` tail.

use rayon::prelude::*;

use crate::components::{Commodity, FighterState, GoalKind};
use crate::world::World;

// Per-tick drains (the "needs fade toward 0" half of `drainNeeds`). Tuned for the fixed tick, not
// the JS per-second rate (doc 22 §9 — port the concept, tune on its own terms).
const HUNGER_DRAIN: f32 = 0.0040;
const ENERGY_DRAIN: f32 = 0.0030;
const SOCIAL_DRAIN: f32 = 0.0020;
const COMFORT_DRAIN: f32 = 0.0015;
const NOVELTY_DRAIN: f32 = 0.0015;

// Per-tick restores (the on-arrival eat/rest/comfort verbs).
const EAT_RATE: f32 = 0.34; // one Food unit feeds this much hunger per bite.
const REST_RATE: f32 = 0.020;
const COMFORT_RATE: f32 = 0.020;
// Soft-need restores: a steady trickle while at market / wandering / working — outpaces the drain, so a
// normally-active townsperson stays content WITHOUT a dedicated trip (the marginal-economy lesson).
const SOCIAL_RATE: f32 = 0.04; // company (at the market / among coworkers) restores the social need.
const NOVELTY_RATE: f32 = 0.04; // fresh ground (wandering / at the fields) restores the novelty need.

// Mood valences decay toward 0 (the `drainNeeds` tail). Fast for fear/anger.
const FEAR_DECAY: f32 = 0.030;
const ANGER_DECAY: f32 = 0.022;

/// Ticks hunger may sit empty before starvation flags the agent dead (Wave-1 kill).
const STARVE_TICKS: u16 = 600;

#[inline]
fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

/// Has the agent ARRIVED at its goal's move target (so a soft-need place-visit counts)? Within a small
/// on-station radius of the target (locomotion snaps exactly on arrival, so this is generous slack).
#[inline]
fn at_goal(p: [f32; 2], goal: crate::components::Goal) -> bool {
    match goal.move_target() {
        Some(t) => {
            let (dx, dz) = (p[0] - t[0], p[1] - t[1]);
            dx * dx + dz * dz <= 4.0 // within 2m of the place
        }
        None => true,
    }
}

pub fn drain(world: &mut World) {
    let World {
        ref mut needs,
        ref mut econ,
        ref mut mood,
        ref mut alive,
        ref mut combat,
        ref goal,
        ref pos,
        ref captive_of,
        ..
    } = *world;

    // Zip the mutable columns so each closure invocation gets a DISJOINT `&mut` to row `i` of every
    // column (no index-into-a-captured-`&mut`, which rayon rightly forbids — that would alias). `goal`
    // is read-only and indexed by the enumerated `i`.
    needs
        .par_iter_mut()
        .zip(econ.par_iter_mut())
        .zip(mood.par_iter_mut())
        .zip(alive.par_iter_mut())
        .zip(combat.par_iter_mut())
        .enumerate()
        .for_each(|(i, ((((n, e), m), live), body))| {
            // dead agents neither drain nor satisfy.
            if !*live {
                return;
            }
            // a CAPTIVE is frozen — held and fed by its captor, it neither drains nor starves (so an
            // inert prisoner doesn't waste away before it can be freed). Mood still cools, below.
            if captive_of[i] != crate::world::CAPTIVE_NONE {
                m.fear = (m.fear - FEAR_DECAY).max(0.0);
                m.anger = (m.anger - ANGER_DECAY).max(0.0);
                return;
            }

            // 1. DECAY — every need fades toward 0 this tick.
            n.hunger = clamp01(n.hunger - HUNGER_DRAIN);
            n.energy = clamp01(n.energy - ENERGY_DRAIN);
            n.social = clamp01(n.social - SOCIAL_DRAIN);
            n.comfort = clamp01(n.comfort - COMFORT_DRAIN);
            n.novelty = clamp01(n.novelty - NOVELTY_DRAIN);

            // 2. ON-ARRIVAL VERB — satisfy per the agent's current goal (own row only). Locomotion
            //    has already walked the agent to the spot; this is the in-place verb.
            match goal[i].kind() {
                GoalKind::Eat => {
                    // consume one Food unit from inventory and raise hunger (conserved: inventory is
                    // the only source — no food ⇒ no relief, hunger keeps falling).
                    let food = &mut e.inventory[Commodity::Food as usize];
                    if *food > 0 && n.hunger < 1.0 {
                        *food -= 1;
                        n.hunger = clamp01(n.hunger + EAT_RATE);
                    }
                }
                GoalKind::Rest | GoalKind::Home => {
                    n.energy = clamp01(n.energy + REST_RATE);
                    // home/hearth also trickles comfort back (the JS rest verb restores comfort too).
                    n.comfort = clamp01(n.comfort + COMFORT_RATE);
                }
                GoalKind::Comfort => {
                    n.comfort = clamp01(n.comfort + COMFORT_RATE);
                }
                // SOFT NEEDS satisfied PASSIVELY as a side-effect of what agents already do — so they
                // never need to steal foraging time for a dedicated trip (the marginal-economy lesson:
                // dedicated soft-need trips destabilized the food supply). Company comes from being
                // among others at the MARKET; novelty from WANDERing to fresh ground; both trickle while
                // WORKing/GATHERing among coworkers in the fields. The explicit Socialize/Sightsee fills
                // (below) remain for the rare SEVERE depletion an agent's routine didn't cover.
                GoalKind::Market => {
                    n.social = clamp01(n.social + SOCIAL_RATE);
                }
                GoalKind::Wander => {
                    n.novelty = clamp01(n.novelty + NOVELTY_RATE);
                }
                GoalKind::Work | GoalKind::Gather => {
                    n.social = clamp01(n.social + SOCIAL_RATE * 0.4);
                    n.novelty = clamp01(n.novelty + NOVELTY_RATE * 0.4);
                }
                GoalKind::Socialize => {
                    if at_goal(pos[i], goal[i]) {
                        n.social = clamp01(n.social + SOCIAL_RATE);
                    }
                }
                GoalKind::Sightsee => {
                    if at_goal(pos[i], goal[i]) {
                        n.novelty = clamp01(n.novelty + NOVELTY_RATE);
                    }
                }
                _ => {}
            }

            // 3. MOOD valences fade toward calm (the `drainNeeds` tail).
            m.fear = (m.fear - FEAR_DECAY).max(0.0);
            m.anger = (m.anger - ANGER_DECAY).max(0.0);

            // 4. STARVATION — hunger at empty is a clock; long enough and the agent dies. The clock
            //    is the NEEDS-owned `n.starve` (integration fix: NOT `combat.stagger`, which the
            //    combat swing machine owns and would overwrite each tick). Reset the moment food
            //    returns. Death flips `alive` + the fighter state, mirroring the Strike merge.
            if n.hunger <= 0.0 {
                n.starve += 1.0;
                if n.starve >= STARVE_TICKS as f32 {
                    *live = false;
                    body.state = FighterState::Dead as u8;
                    body.health = 0.0;
                }
            } else {
                n.starve = 0.0;
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Commodity, Goal};
    use crate::world::World;

    #[test]
    fn needs_decay_toward_zero() {
        let mut w = World::spawn(7, 64);
        for g in w.goal.iter_mut() {
            *g = Goal::Idle; // a goal that does NOT satisfy hunger.
        }
        let before: Vec<f32> = w.needs.iter().map(|n| n.hunger).collect();
        super::drain(&mut w);
        for (i, n) in w.needs.iter().enumerate() {
            if w.alive[i] {
                assert!(n.hunger <= before[i], "hunger must not rise while idle");
                assert!((0.0..=1.0).contains(&n.hunger), "hunger stays in [0,1]");
            }
        }
    }

    #[test]
    fn eat_consumes_food_and_raises_hunger() {
        let mut w = World::spawn(11, 4);
        let i = 0;
        w.alive[i] = true;
        w.goal[i] = Goal::Eat;
        w.needs[i].hunger = 0.2;
        w.econ[i].inventory[Commodity::Food as usize] = 3;
        super::drain(&mut w);
        assert_eq!(
            w.econ[i].inventory[Commodity::Food as usize],
            2,
            "one Food unit consumed"
        );
        assert!(w.needs[i].hunger > 0.2, "eating raises hunger");
    }

    #[test]
    fn eat_without_food_does_not_satisfy() {
        let mut w = World::spawn(12, 4);
        let i = 0;
        w.alive[i] = true;
        w.goal[i] = Goal::Eat;
        w.needs[i].hunger = 0.2;
        w.econ[i].inventory[Commodity::Food as usize] = 0;
        super::drain(&mut w);
        assert_eq!(w.econ[i].inventory[Commodity::Food as usize], 0);
        assert!(w.needs[i].hunger <= 0.2, "no food ⇒ hunger only decayed");
    }

    #[test]
    fn socialize_at_the_place_restores_social() {
        let mut w = World::spawn(15, 4);
        let i = 0;
        w.alive[i] = true;
        w.pos[i] = [10.0, 10.0];
        w.goal[i] = Goal::Socialize { to: [10.0, 10.0] }; // already arrived at the gathering place
        w.needs[i].social = 0.2;
        super::drain(&mut w);
        assert!(w.needs[i].social > 0.2, "socializing on station restores the social need");
    }

    #[test]
    fn socialize_enroute_does_not_restore() {
        let mut w = World::spawn(16, 4);
        let i = 0;
        w.alive[i] = true;
        w.pos[i] = [0.0, 0.0];
        w.goal[i] = Goal::Socialize { to: [100.0, 0.0] }; // still far from the place
        w.needs[i].social = 0.2;
        super::drain(&mut w);
        assert!(w.needs[i].social <= 0.2, "no restore until arrived (only decayed en route)");
    }

    #[test]
    fn rest_raises_energy() {
        let mut w = World::spawn(13, 4);
        let i = 0;
        w.alive[i] = true;
        w.goal[i] = Goal::Rest;
        w.needs[i].energy = 0.3;
        super::drain(&mut w);
        assert!(w.needs[i].energy > 0.3, "resting raises energy");
    }

    #[test]
    fn starvation_eventually_kills() {
        let mut w = World::spawn(14, 2);
        let i = 0;
        w.alive[i] = true;
        w.goal[i] = Goal::Idle;
        w.needs[i].hunger = 0.0;
        w.econ[i].inventory[Commodity::Food as usize] = 0;
        for _ in 0..(STARVE_TICKS as usize + 2) {
            super::drain(&mut w);
        }
        assert!(!w.alive[i], "an agent that never eats eventually starves");
    }
}
