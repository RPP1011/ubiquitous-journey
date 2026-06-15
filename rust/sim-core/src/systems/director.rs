//! FAN-OUT UNIT: director (drama manager). Port the SPIRIT of `js/sim/director.js` — a points-budget
//! trope engine that injects situations when the world goes quiet, on cooldowns.
//!
//! AS BUILT (SERIAL society phase — runs once/tick, mutates the world):
//! - Throttle: only evaluate every `EVAL_EVERY` ticks (`world.tick % EVAL_EVERY == 0`).
//! - "Quiet" probe: count living attackers (Raiders + Monsters) on the roster. The world is quiet
//!   when that count sits at/under `QUIET_THRESHOLD` — i.e. there is no active threat to escalate.
//! - Cooldown: at least `RAID_COOLDOWN` ticks must have elapsed since the last raid (derived from the
//!   last raid Beat in the chronicle). The quiet probe is also self-limiting: while a fresh wave is
//!   alive it fails, so no raid stacks on a raid.
//! - The flagship trope = a RAID: when quiet + cooldown elapsed, spawn a wave of `Faction::Raider`
//!   via `world.spawn_agent(pos, Faction::Raider, Profession::None)` at the town fringe (a ring
//!   beyond the town radius), give each a `Goal::Fight` at a believed-juicy townsperson + a threat
//!   cue, and log a single raid `Beat` to `world.chronicle`.
//!
//! Determinism: SERIAL phase ⇒ trivially M-invariant. World-level rolls via `world.sim_rng` (NOT
//! per-entity rng). CONSERVATION: spawned raiders carry 0 gold (spawn_agent default) — never mint.

use crate::components::{Beat, Faction, Goal, Profession};
use crate::world::World;

/// How often the director wakes to consider a trope (drama should be sparse).
const EVAL_EVERY: u32 = 120;
/// Minimum ticks between raids — the drama cooldown.
const RAID_COOLDOWN: u32 = 360;
/// The world is "quiet" (ripe for a raid) when at most this many attackers are alive.
const QUIET_THRESHOLD: usize = 1;
/// Wave size — how many raiders descend on the town.
const WAVE_SIZE: usize = 4;
/// Raiders spawn on a ring this far beyond the town radius (the "fringe").
const TOWN_RADIUS: f32 = 180.0;
const FRINGE_MARGIN: f32 = 60.0;
/// Threat cue stamped on a freshly-spawned raider (so townsfolk perceive them as dangerous).
const RAID_THREAT: u16 = 7000;
/// BeatKind for a raid (matches the interned order in `components::Beat`: death|kill|raid|…).
const BEAT_RAID: u8 = 2;

pub fn tick(world: &mut World) {
    // Throttle: only consider drama on the evaluation boundary.
    if world.tick == 0 || world.tick % EVAL_EVERY != 0 {
        return;
    }
    // Cooldown: never two raids inside `RAID_COOLDOWN` ticks (derived from the last raid Beat).
    if let Some(last) = last_raid_tick(world) {
        if world.tick.saturating_sub(last) < RAID_COOLDOWN {
            return;
        }
    }

    // "Quiet" probe (omniscient observer read — a spawn/narration decision, not an agent decision):
    // count living attackers. A standing threat means the story is already busy; don't pile on.
    let attackers = world
        .alive
        .iter()
        .zip(world.faction.iter())
        .filter(|(&a, &f)| a && (f == Faction::Raider as u8 || f == Faction::Monster as u8))
        .count();
    if attackers > QUIET_THRESHOLD {
        return;
    }

    // Pick a believed-juicy victim: the wealthiest living townsperson (deterministic; lowest id on a
    // tie). Falls back to None (the wave then wanders the centre) if the town is empty.
    let victim = wealthiest_townsperson(world);

    // Spawn the wave on the fringe ring. World-level rolls only (`sim_rng`), so M-invariant.
    let center = world.town_center;
    let mut spawned = 0usize;
    for _ in 0..WAVE_SIZE {
        let a = world.sim_rng.next_f32() * std::f32::consts::TAU;
        let r = TOWN_RADIUS + FRINGE_MARGIN + world.sim_rng.next_f32() * FRINGE_MARGIN;
        let pos = [center[0] + r * a.cos(), center[1] + r * a.sin()];
        let id = world.spawn_agent(pos, Faction::Raider, Profession::None);
        world.threat[id] = RAID_THREAT;
        world.goal[id] = match victim {
            Some(v) => Goal::Fight { target: v },
            None => Goal::Wander { to: center },
        };
        spawned += 1;
    }

    // Log a single raid Beat (the chronicle observer). Magnitude = wave size; subject = the target.
    world.chronicle.push(Beat {
        t: world.tick,
        kind: BEAT_RAID,
        subject: victim.unwrap_or(0),
        magnitude: spawned as i32,
    });
}

/// The tick of the most recent raid Beat, if any (scan from the end — raids are rare, tail is hot).
fn last_raid_tick(world: &World) -> Option<u32> {
    world.chronicle.iter().rev().find(|b| b.kind == BEAT_RAID).map(|b| b.t)
}

/// The wealthiest living townsperson's id (deterministic: highest wealth, lowest id breaks ties).
fn wealthiest_townsperson(world: &World) -> Option<u32> {
    let mut best: Option<(u16, u32)> = None;
    for i in 0..world.n {
        if !world.alive[i] || world.faction[i] != Faction::Townsfolk as u8 {
            continue;
        }
        let w = world.wealth[i];
        match best {
            Some((bw, _)) if w <= bw => {}
            _ => best = Some((w, i as u32)),
        }
    }
    best.map(|(_, id)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::GoalKind;
    use crate::world::World;

    /// Run the world forward until the director fires a raid, capped so the test can't hang.
    fn run_until_raid(w: &mut World, max_ticks: u32) -> bool {
        for _ in 0..max_ticks {
            w.tick();
            if w.chronicle.iter().any(|b| b.kind == BEAT_RAID) {
                return true;
            }
        }
        false
    }

    #[test]
    fn raid_fires_when_world_is_quiet() {
        // The default roster has ~6% monsters; the director fires once the attacker count drops to
        // the quiet threshold. A generous horizon reaches a quiet window and a raid.
        let mut w = World::spawn(0xD11EC7, 80);
        assert!(
            run_until_raid(&mut w, 8000),
            "director should eventually inject a raid when the world goes quiet"
        );
    }

    #[test]
    fn spawned_raiders_carry_zero_gold_and_conserve() {
        let mut w = World::spawn(0xD11EC7, 80);
        let gold_before = w.total_gold();
        assert!(run_until_raid(&mut w, 8000), "need a raid to inspect the raiders");
        for i in 0..w.n {
            if w.faction[i] == Faction::Raider as u8 {
                assert_eq!(w.econ[i].gold, 0, "raider {i} must spawn with 0 gold (no minting)");
                assert_eq!(w.econ[i].stash, 0, "raider {i} must spawn with 0 stash");
            }
        }
        assert_eq!(w.total_gold(), gold_before, "spawning raiders must not change total gold");
    }

    #[test]
    fn raid_logs_a_beat_and_spawns_a_wave() {
        let mut w = World::spawn(0xD11EC7, 80);
        let raiders_before = w.faction.iter().filter(|&&f| f == Faction::Raider as u8).count();
        assert!(run_until_raid(&mut w, 8000), "director should inject a raid");
        let beat = w.chronicle.iter().find(|b| b.kind == BEAT_RAID).expect("a raid Beat is logged");
        assert!(beat.magnitude > 0, "raid Beat magnitude is the wave size");
        let raiders_after = w.faction.iter().filter(|&&f| f == Faction::Raider as u8).count();
        assert!(
            raiders_after >= raiders_before + beat.magnitude as usize,
            "a wave of raiders should have been spawned"
        );
        // Newly-spawned raiders march on a believed-juicy victim (or wander if the town emptied).
        let any_raider_fighting = (0..w.n).any(|i| {
            w.faction[i] == Faction::Raider as u8 && w.goal[i].kind() == GoalKind::Fight
        });
        assert!(any_raider_fighting, "raiders should be set on a Fight goal");
    }

    #[test]
    fn director_respects_cooldown() {
        // Two raids must be at least RAID_COOLDOWN ticks apart.
        let mut w = World::spawn(0xD11EC7, 80);
        let mut raid_ticks = Vec::new();
        for _ in 0..12000 {
            let before = w.chronicle.len();
            w.tick();
            for b in &w.chronicle[before..] {
                if b.kind == BEAT_RAID {
                    raid_ticks.push(b.t);
                }
            }
        }
        for pair in raid_ticks.windows(2) {
            assert!(
                pair[1].saturating_sub(pair[0]) >= RAID_COOLDOWN,
                "raids at {} and {} violate the cooldown",
                pair[0],
                pair[1]
            );
        }
    }
}
