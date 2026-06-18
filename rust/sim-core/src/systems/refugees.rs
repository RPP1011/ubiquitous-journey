//! REFUGEES (`systems/refugees.rs`) — population FLOWS from devastated settlements to safe ones. When a
//! town is gutted (its living population has fallen well below the regional norm — raided, overrun by a
//! lair's predators, or feuded into the ground), its endangered survivors EMIGRATE to the nearest
//! healthier town: their allegiance (`town`) and home anchor move there, and they forget their razed
//! home (construction raises them a new one in the haven). Ghost towns hollow out; havens swell — the
//! region writes its own history of boom and ruin.
//!
//! Serial (society phase) ⇒ trivially M-invariant. CAPPED to a trickle per pass (the marginal-economy
//! lesson: a sudden mass exodus would destabilise the rest/work routing). No gold is minted — only
//! allegiance + the home anchor move; the haven's existing food economy absorbs the newcomers gradually.

use crate::components::Faction;
use crate::world::World;

/// Run the refugee pass on this cadence (an exodus is a slow, grinding thing).
pub const REFUGEE_EVERY: u32 = 70;
/// A town holding under this fraction of the regional-average population is "in crisis" (its folk flee).
const CRISIS_FRAC: f32 = 0.5;
/// At most this many souls resettle per pass (a trickle, not a stampede).
const PER_PASS: usize = 2;
/// Felt-danger gate (beliefs only): a refugee flees only with a real press of believed hostiles upon it.
const DANGER_RANGE2: f32 = 60.0 * 60.0;
const DANGER_COUNT: usize = 2;

pub fn tick(world: &mut World) {
    if world.tick % REFUGEE_EVERY != 0 {
        return;
    }
    let nt = world.town_centers.len();
    if nt < 2 {
        return; // a single-town world has nowhere to flee
    }
    let town = Faction::Townsfolk as u8;
    // per-town living-townsfolk census (the crisis / haven signal).
    let mut pop = vec![0usize; nt];
    for i in 0..world.n {
        if world.alive[i] && world.faction[i] == town {
            pop[(world.town[i] as usize).min(nt - 1)] += 1;
        }
    }
    let total: usize = pop.iter().sum();
    let avg = total as f32 / nt as f32;
    let crisis_bar = (avg * CRISIS_FRAC) as usize;

    let mut moved = 0usize;
    for i in 0..world.n {
        if moved >= PER_PASS {
            break;
        }
        if !world.alive[i] || world.faction[i] != town {
            continue;
        }
        let t = (world.town[i] as usize).min(nt - 1);
        if pop[t] >= crisis_bar {
            continue; // the home town is holding — no reason to abandon it
        }
        // only the endangered flee (a real press of BELIEVED hostiles nearby — the epistemic split).
        let mut threats = 0usize;
        for cell in world.facts[i].views() {
            if cell.flags & 0x01 == 0 {
                continue;
            }
            let dx = world.pos[i][0] - cell.last_x;
            let dz = world.pos[i][1] - cell.last_z;
            if dx * dx + dz * dz <= DANGER_RANGE2 {
                threats += 1;
            }
        }
        if threats < DANGER_COUNT {
            continue;
        }
        // flee to the NEAREST haven (a town at/above the regional average) other than home.
        let mut dest: Option<usize> = None;
        let mut bestd = f32::MAX;
        for d in 0..nt {
            if d == t || (pop[d] as f32) < avg {
                continue;
            }
            let dx = world.town_centers[d][0] - world.pos[i][0];
            let dz = world.town_centers[d][1] - world.pos[i][1];
            let dd = dx * dx + dz * dz;
            if dd < bestd {
                bestd = dd;
                dest = Some(d);
            }
        }
        if let Some(d) = dest {
            world.town[i] = d as u16; // swears its allegiance to the haven (works/trades there now)
            // the home anchor sets out toward the haven (a third of the way — a journey, not a teleport).
            world.home[i][0] += (world.town_centers[d][0] - world.home[i][0]) * 0.34;
            world.home[i][1] += (world.town_centers[d][1] - world.home[i][1]) * 0.34;
            world.home_belief_id[i] = u32::MAX; // the razed/abandoned home is forgotten; rebuild in the haven
            moved += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::World;

    /// A gutted town's endangered survivor flees to the nearest healthy haven.
    #[test]
    fn a_refugee_flees_a_gutted_town_for_a_haven() {
        let mut w = World::spawn(0xF1EE, 2000);
        let nt = w.town_centers.len();
        assert!(nt >= 2, "need a region");
        // pick a town and gut it: kill all but one of its townsfolk so it falls into crisis.
        let victim_town = 0usize;
        let mut survivor = None;
        let mut seen = 0;
        for i in 0..w.n {
            if w.faction[i] == Faction::Townsfolk as u8 && w.town[i] as usize == victim_town {
                seen += 1;
                if seen == 1 {
                    survivor = Some(i);
                } else {
                    w.alive[i] = false; // the town is overrun
                }
            }
        }
        let s = survivor.expect("the town had dwellers");
        // place the survivor under a believed press of hostiles (the felt danger that drives flight).
        w.pos[s] = w.town_centers[victim_town];
        let mut bt = crate::components::BeliefTable::default();
        for k in 0..3 {
            bt.subjects[k] = 900 + k as u32;
            bt.bodies[k] = crate::components::PersonBelief {
                subject: 900 + k as u32,
                last_x: w.pos[s][0] + 1.0,
                last_z: w.pos[s][1],
                confidence: 50_000,
                flags: 0x01, // believed hostile
                ..Default::default()
            };
            bt.len += 1;
        }
        w.facts[s].mirror_core_from(&bt);
        // align the pass cadence and run it.
        w.tick = REFUGEE_EVERY;
        tick(&mut w);
        assert_ne!(
            w.town[s] as usize, victim_town,
            "the lone survivor of a gutted town flees to a haven"
        );
    }
}
