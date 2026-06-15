//! FAN-OUT UNIT: chronicle (world-history observer). Ports the SPIRIT of `js/sim/chronicle.js` — the
//! OMNISCIENT OBSERVER LAYER (doc 22 §2): it reads ground truth across the roster to NARRATE/record
//! history; it never drives an agent decision, so reading truth here is sanctioned.
//!
//! WHAT IT DOES (SERIAL society phase, runs FIRST — appends to `world.chronicle`):
//! - Detects notable transitions each tick by comparing against last-tick snapshots held on `World`:
//!   - a DEATH: an agent's `alive` flipped false since last tick.
//!   - a CLASS-UP: an agent's `progression.total_level` rose since last tick.
//!   Each transition appends one numeric `Beat { t, kind, subject, magnitude }` (the render-only text
//!   is generated later from these).
//! - Keeps the log BOUNDED (a ring: cap + drop-oldest) so it never grows without limit over a soak.
//!
//! Determinism: SERIAL ⇒ trivially M-invariant; the detection is a deterministic id-order scan, no
//! rng. PURE OBSERVER — reads truth, writes ONLY `world.chronicle` + its own detection-state columns
//! (`chron_seen_dead` / `chron_prev_level`); it never mutates an agent column. No gold/spawn here.

use crate::components::Beat;
use crate::world::World;

/// Interned `Beat.kind` codes for the observer layer (mirrors `js/sim/chronicle.js` BEAT.* — kept
/// numeric so the determinism hash folds them). RAID = 2 is reserved for the director's spawn beat.
pub const KIND_DEATH: u8 = 0;
pub const KIND_CLASSUP: u8 = 1;

/// Max beats kept in the rolling feed (the ring is bounded so memory never grows over a long run;
/// mirrors `CHRONICLE.cap`). Oldest beats are evicted first.
pub const CAP: usize = 256;

/// Append a beat, evicting the oldest if the ring is at capacity (deterministic, append-only).
fn push(world: &mut World, kind: u8, subject: u32, magnitude: i32) {
    let t = world.tick;
    if world.chronicle.len() >= CAP {
        // drop-oldest. CAP is modest, so the single shift is cheap relative to a full tick.
        world.chronicle.remove(0);
    }
    world.chronicle.push(Beat { t, kind, subject, magnitude });
}

pub fn tick(world: &mut World) {
    let n = world.n;

    // Lazily grow the detection-state to match the roster. New entries are SEEDED from the agent's
    // CURRENT state so a freshly spawned agent never produces a spurious death/class-up on its first
    // observed tick. (Chronicle runs FIRST in the society phase, so agents spawned by a later pass
    // this tick are first seen — and seeded — on the next tick.)
    if world.chron_seen_dead.len() < n {
        for i in world.chron_seen_dead.len()..n {
            world.chron_seen_dead.push(!world.alive[i]);
            world.chron_prev_level.push(world.progression[i].total_level);
        }
    }

    for i in 0..n {
        // CLASS-UP: total_level rose since last tick (recorded before the death check — a dying agent
        // could in principle level on its final tick; both transitions are recorded).
        let lvl = world.progression[i].total_level;
        if lvl > world.chron_prev_level[i] {
            push(world, KIND_CLASSUP, i as u32, lvl as i32);
        }
        world.chron_prev_level[i] = lvl;

        // DEATH: `alive` flipped false this tick (latched: once seen-dead we never re-log; a slot is
        // never resurrected, so `alive` cannot flip back).
        if !world.chron_seen_dead[i] && !world.alive[i] {
            push(world, KIND_DEATH, i as u32, 0);
        }
        world.chron_seen_dead[i] = !world.alive[i];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::FighterState;

    /// A single death logs exactly one DEATH beat (and only once, even across later ticks).
    #[test]
    fn death_logs_exactly_one_beat() {
        let mut w = World::spawn(0xC0FFEE, 8);
        // prime detection-state (no transitions on a fresh world).
        tick(&mut w);
        let before = w.chronicle.len();

        // kill agent 3 (observer reads ground truth — flip the column directly, as the merge would).
        w.alive[3] = false;
        w.combat[3].health = 0.0;
        w.combat[3].state = FighterState::Dead as u8;

        tick(&mut w);
        let deaths: Vec<&Beat> =
            w.chronicle.iter().filter(|b| b.kind == KIND_DEATH && b.subject == 3).collect();
        assert_eq!(deaths.len(), 1, "a death must log exactly one beat");
        assert_eq!(w.chronicle.len(), before + 1, "only the one death beat was appended");

        // a later tick with the agent still dead must NOT re-log it (latched).
        tick(&mut w);
        let deaths_after =
            w.chronicle.iter().filter(|b| b.kind == KIND_DEATH && b.subject == 3).count();
        assert_eq!(deaths_after, 1, "a death must not re-log on subsequent ticks");
    }

    /// A class-up (total_level rising) logs exactly one CLASS-UP beat with the new level in magnitude.
    #[test]
    fn classup_logs_on_level_rise() {
        let mut w = World::spawn(0xC0FFEE, 8);
        tick(&mut w);

        w.progression[2].total_level += 3;
        tick(&mut w);
        let ups: Vec<&Beat> =
            w.chronicle.iter().filter(|b| b.kind == KIND_CLASSUP && b.subject == 2).collect();
        assert_eq!(ups.len(), 1, "a level rise must log exactly one class-up beat");
        assert_eq!(ups[0].magnitude, w.progression[2].total_level as i32);

        // no further rise ⇒ no further beat.
        tick(&mut w);
        let ups_after =
            w.chronicle.iter().filter(|b| b.kind == KIND_CLASSUP && b.subject == 2).count();
        assert_eq!(ups_after, 1, "a flat level must not re-log");
    }

    /// The log stays BOUNDED: many transitions never grow it past CAP, and the newest beat survives.
    #[test]
    fn log_stays_bounded() {
        let mut w = World::spawn(0xC0FFEE, 4);
        tick(&mut w);
        // drive far more than CAP class-ups on a single agent.
        for _ in 0..(CAP * 3) {
            w.progression[0].total_level += 1;
            tick(&mut w);
        }
        assert!(w.chronicle.len() <= CAP, "the chronicle ring must stay bounded by CAP");
        // the most-recent beat reflects the latest level (oldest were evicted, newest kept).
        let last = w.chronicle.last().expect("ring non-empty");
        assert_eq!(last.kind, KIND_CLASSUP);
        assert_eq!(last.magnitude, w.progression[0].total_level as i32);
    }
}
