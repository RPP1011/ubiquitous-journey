//! FAN-OUT UNIT: decide. Ports `js/sim/agent/decide.ts` + `js/sim/motivation.js` (goal derivation)
//! + the GOAP layer (`js/sim/planner.ts`) — to their SPIRIT (doc 22 §9, NO TS parity).
//!
//! WHAT THIS IMPLEMENTS (parallel, own-write — `world.goal`/`world.rng`, reading own `needs`/`beliefs`/
//! `memory`/`econ`/`pos`/… + the static world). Per agent, settle `goal[i]` in priority order — every
//! read is OWN state (the epistemic split: never another agent's live columns):
//!   1. SURVIVAL — the largest need deficit past its seek bar claims the body (Eat/Rest/Comfort).
//!   2. AVENGE (GOAP) — a live grudge: an `assaulted` memory whose culprit I haven't slain, isn't
//!      stale, and I can still locate (a belief about it). I plan `Dead(culprit)` through the
//!      backward-chaining `planner`; its first step compiles to a MOVING Fight that hunts the foe.
//!   3. THREAT — a believed-hostile near where I believe it is, with no grudge to settle ⇒ Flee.
//!   4. SEEK-FORTUNE (GOAP) — a `windfall` memory while poor ⇒ plan `GoldGe(target)` (sell surplus
//!      at the believed market). The director's OPPORTUNITY trope plants these.
//!   5. LIVELIHOOD — a working townsperson works its craft, with the occasional market trip.
//!   6. WANDER — a random point near town.
//!
//! Determinism: read/write only row `i`; randomness only via `rng[i]`; the planner is a pure per-agent
//! search over own state. No cross-agent reads, no HashMap / float-reduce ⇒ M=1 ≡ M=N.

use rayon::prelude::*;

use crate::components::{
    BeliefTable, EpisodeKind, Faction, Goal, Memory, Profession, BELIEF_CAP,
};
use crate::planner::{plan, Atom, Pv};
use crate::world::World;

/// Need thresholds — a need is only a candidate once it dips below its seek bar.
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

/// How long a grudge stays live (ticks) before it cools out (mirrors `MOTIVE.avengeExpiry`).
const AVENGE_EXPIRY: u32 = 1200;
/// How long a heard-of windfall stays actionable (ticks).
const FORTUNE_EXPIRY: u32 = 1800;
/// The gold a seek-fortune intention drives toward (minor units, ~140 gold).
const FORTUNE_TARGET: i64 = 14_000;

pub fn decide(world: &mut World) {
    let market = world.market;
    let town_center = world.town_center;
    let now = world.tick;
    let base_price = world.base_price;

    let World {
        ref needs,
        ref beliefs,
        ref memory,
        ref econ,
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

    goal.par_iter_mut().zip(rng.par_iter_mut()).enumerate().for_each(|(i, (g, my_rng))| {
        // The dead make no decisions (keep a stable goal — needs/locomotion already guard `alive`).
        if !alive[i] {
            *g = Goal::Idle;
            return;
        }

        let need = &needs[i];
        let townsfolk = faction[i] == Faction::Townsfolk as u8;

        // 1. SURVIVAL FIRST: the LARGEST deficit below its seek bar claims the body.
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

        // Build the believed-state view the GOAP planner reasons over (OWN state + static world).
        let pv = Pv {
            pos: pos[i],
            gold: econ[i].gold,
            inventory: econ[i].inventory,
            price_belief: econ[i].price_belief,
            profession: profession[i],
            beliefs: &beliefs[i],
            memory: &memory[i],
            market,
            work_sites,
            base_price: &base_price,
        };

        // 2. AVENGE (GOAP): a live grudge I can still locate → hunt the culprit down. Townsfolk carry
        //    grudges; monsters/raiders fight by reflex (combat's nearest-hostile) without a goal-plan.
        if townsfolk {
            if let Some(culprit) = pick_avenge(&memory[i], &beliefs[i], now) {
                if let Some(planned) = plan(Atom::Dead(culprit), &pv) {
                    *g = planned;
                    return;
                }
            }
        }

        // 3. THREAT: flee the NEAREST believed-hostile near where I believe it is (no grudge to settle).
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
            if d2 < best_d2 || (d2 == best_d2 && flee_from.map_or(true, |s| cell.subject < s)) {
                best_d2 = d2;
                flee_from = Some(cell.subject);
            }
        }
        if let Some(from) = flee_from {
            *g = Goal::Flee { from };
            return;
        }

        // 4. SEEK-FORTUNE (GOAP): a heard-of windfall while poor → raise gold by selling a surplus.
        if townsfolk && has_live_windfall(&memory[i], now) && econ[i].gold < FORTUNE_TARGET {
            if let Some(planned) = plan(Atom::GoldGe(FORTUNE_TARGET), &pv) {
                *g = planned;
                return;
            }
        }

        // 5. LIVELIHOOD: a working townsperson works its craft, with an occasional market trip.
        let prof = profession[i];
        if prof != Profession::None as u8 && townsfolk {
            if my_rng.next_f32() < MARKET_CHANCE {
                *g = Goal::Market { site: market };
            } else {
                let site_idx = (prof as usize - 1).min(work_sites.len() - 1);
                *g = Goal::Work { site: work_sites[site_idx] };
            }
            return;
        }

        // 6. WANDER: a random point near the town centre (own rng stream; uniform over the disc).
        let r = TOWN_RADIUS * my_rng.next_f32().sqrt();
        let a = my_rng.next_f32() * std::f32::consts::TAU;
        let to = [town_center[0] + r * a.cos(), town_center[1] + r * a.sin()];
        *g = Goal::Wander { to };
    });
}

/// Pick the culprit of a LIVE grudge: an `assaulted` episode whose foe I have NOT slain, that has not
/// gone stale, and that I can still LOCATE (I hold a belief about it — else I can't hunt it). Among the
/// candidates, the most VIVID wins (salience), then the most RECENT, then the lowest id (deterministic).
/// Own-state only (my memory + my beliefs). Returns the culprit id, or None.
fn pick_avenge(memory: &Memory, beliefs: &BeliefTable, now: u32) -> Option<u32> {
    let mut best: Option<(u16, u32, u32)> = None; // (salience, t, neg-culprit-for-tiebreak)
    for k in 0..memory.len as usize {
        let ep = &memory.items[k];
        if ep.kind != EpisodeKind::Assaulted as u8 {
            continue;
        }
        let culprit = ep.with;
        if now.saturating_sub(ep.t) > AVENGE_EXPIRY {
            continue; // the grudge cooled
        }
        if memory.has(EpisodeKind::Slew, culprit) {
            continue; // already settled — I struck it down
        }
        if beliefs.find(culprit).is_none() {
            continue; // lost all track — can't hunt what I can't locate
        }
        // most salient, then most recent, then lowest culprit id.
        let better = match best {
            None => true,
            Some((bs, bt_, bc)) => {
                ep.salience > bs
                    || (ep.salience == bs && ep.t > bt_)
                    || (ep.salience == bs && ep.t == bt_ && culprit < bc)
            }
        };
        if better {
            best = Some((ep.salience, ep.t, culprit));
        }
    }
    best.map(|(_, _, culprit)| culprit)
}

/// Do I hold a still-actionable `windfall` memory? (own state only.)
fn has_live_windfall(memory: &Memory, now: u32) -> bool {
    memory.items[..memory.len as usize]
        .iter()
        .any(|ep| ep.kind == EpisodeKind::Windfall as u8 && now.saturating_sub(ep.t) <= FORTUNE_EXPIRY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Episode, GoalKind, Needs, PersonBelief};
    use crate::world::World;

    #[test]
    fn hungry_agent_picks_eat() {
        let mut w = World::spawn(0xBEEF, 64);
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
        let mut found = false;
        for i in 0..w.n {
            if w.profession[i] != Profession::None as u8 && w.faction[i] == Faction::Townsfolk as u8 {
                w.needs[i] = Needs::default();
                w.beliefs[i].clear();
                w.memory[i] = Memory::default();
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
        w.memory[0] = Memory::default();
        let px = w.pos[0][0];
        let pz = w.pos[0][1];
        let bt = &mut w.beliefs[0];
        bt.clear();
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

    /// A grudge (assaulted memory) about a believed-locatable foe ⇒ the avenger HUNTS rather than
    /// flees: it overrides the flee reflex with a moving Fight toward the culprit.
    #[test]
    fn grudge_overrides_flee_with_a_hunt() {
        let mut w = World::spawn(0xBEEF, 64);
        // pick a townsperson so the grudge layer applies.
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.needs[i] = Needs::default();
        let (px, pz) = (w.pos[i][0], w.pos[i][1]);
        // I believe foe 7 is hostile + nearby (would normally make me flee)…
        let bt = &mut w.beliefs[i];
        bt.clear();
        bt.subjects[0] = 7;
        bt.bodies[0] = PersonBelief {
            subject: 7,
            last_x: px + 5.0,
            last_z: pz,
            confidence: 60000,
            flags: 0x01,
            ..Default::default()
        };
        bt.len = 1;
        // …but it once struck me, so I hunt it instead.
        w.memory[i] = Memory::default();
        w.memory[i].record(Episode {
            kind: EpisodeKind::Assaulted as u8,
            with: 7,
            t: w.tick,
            salience: 50000,
            ..Default::default()
        });
        decide(&mut w);
        match w.goal[i] {
            Goal::Fight { target, .. } => assert_eq!(target, 7, "should hunt the foe that struck me"),
            other => panic!("a grudge should override flee with a Fight, got {other:?}"),
        }
    }
}
