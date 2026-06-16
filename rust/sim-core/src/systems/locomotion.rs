//! FAN-OUT UNIT: locomotion / steer. Port the spirit of `js/sim/agent/steer.ts` + `movement.ts`
//! (the potential-field steer-fills) — the on-arrival world-interaction VERB stays in its own system
//! (needs/market/combat), here is just locomotion.
//!
//! WHAT IS IMPLEMENTED (parallel, own-write — `world.pos` + `world.rng`, reading `world.goal`,
//! `world.beliefs`):
//! - For each agent, `goal[i].move_target()`. `Some(target)` ⇒ step `pos[i]` toward it at a per-tick
//!   speed (clamp on arrival); `None` (Eat/Rest/Fight in place) ⇒ stand still.
//! - `Goal::Flee{from}` ⇒ move AWAY from the believed threat position (read `beliefs[i]`'s cell for
//!   `from`'s `last_x/last_z`) — a pure repulsor; project a synthetic away-point and step toward it.
//!   A faded/absent belief leaves no repulsor pos ⇒ drift radially outward from origin (the TS
//!   `fleeFrom(null)` quirk).
//! - `Goal::Wander{to}` drifts toward its random `to`, regenerating a fresh roam point (via `rng[i]`)
//!   once within arrival of the old one — so a wanderer always has a live target.
//! - Clamp `pos` to ±ARENA.
//!
//! Determinism (the hard gate): per-entity own-write only — we write ONLY `pos[i]` and `rng[i]`.
//! Reading a believed target from `beliefs[i]` is own-state; we never read another agent's live
//! `pos`. Randomness only via `rng[i]`. No rayon float-reduce / HashMap on this path. This mirrors
//! the `perceive` disjoint-borrow + `par_iter_mut` pattern, so M=1 ≡ M=N stays bit-identical.

use rayon::prelude::*;

use crate::components::{BeliefTable, Goal};
use crate::rng::DeterministicRng;
use crate::world::World;

/// Distance walked per cognition tick (the locomotion step). The Rust port reasons one step per
/// fixed tick (no sub-frame dt), so this is the whole per-tick displacement.
const STEP: f32 = 2.5;
/// Movement multiplier while SLOWED (the `slow` ability op) — half pace.
const SLOW_MUL: f32 = 0.5;
/// Within this of the target ⇒ "arrived": snap to the target (attractor) / regenerate (wander).
const ARRIVE: f32 = 1.0;
/// Synthetic away-point distance for a pure-repulsor flee (TS `STEER.fleeAway`): a flee never
/// "arrives", it just keeps stepping outward.
const FLEE_AWAY: f32 = 6.0;
/// Hard arena clamp (matches `ARENA_CLAMP` in worldgen).
const ARENA: f32 = 590.0;
/// Town-band radius a wanderer regenerates its roam point within (around its home).
const WANDER_RADIUS: f32 = 60.0;

pub fn step(world: &mut World) {
    let World {
        ref mut pos,
        ref mut rng,
        ref goal,
        ref beliefs,
        ref home,
        ref combat,
        ..
    } = *world;

    // par_iter over the two own-write columns (pos + rng) zipped; goal/beliefs/home/combat are read-only.
    // IndexedParallelIterator preserves index `i`, so every read below is own-row.
    pos.par_iter_mut()
        .zip(rng.par_iter_mut())
        .enumerate()
        .for_each(|(i, (p, r))| {
            // a SLOWED body (the ability `slow` op, e.g. frost_bolt) moves at half pace while it lasts.
            let mul = if combat[i].slow > 0.0 { SLOW_MUL } else { 1.0 };
            step_one(p, r, &goal[i], &beliefs[i], home[i], STEP * mul);
        });
}

/// One agent's locomotion: own pos `p`, own rng `r`, own goal/beliefs, own home anchor. No
/// cross-entity reads — `beliefs` is this agent's own belief table.
#[inline]
fn step_one(
    p: &mut [f32; 2],
    r: &mut DeterministicRng,
    goal: &Goal,
    beliefs: &BeliefTable,
    home: [f32; 2],
    step: f32,
) {
    match goal {
        // FLEE — a pure repulsor away from where I BELIEVE the threat is. Project a synthetic
        // away-point FLEE_AWAY metres along the away-vector and step toward it (so it never
        // "arrives"). A faded/absent belief leaves no repulsor pos ⇒ the away-vector falls back to
        // the agent's own position vector (radially outward from origin) — the TS fleeFrom(null) quirk.
        Goal::Flee { from } => {
            // own-state read: the belief cell about `from` in MY table (never the live roster).
            let threat = beliefs
                .find(*from)
                .map(|idx| &beliefs.bodies[idx])
                .filter(|b| b.last_x.is_finite() && b.last_z.is_finite())
                .map(|b| [b.last_x, b.last_z]);
            // away-vector: from-threat-to-me when known, else radially-from-origin (== my pos).
            let (mut ax, mut az) = match threat {
                Some(t) => (p[0] - t[0], p[1] - t[1]),
                None => (p[0], p[1]),
            };
            if ax == 0.0 && az == 0.0 {
                // degenerate (standing exactly on the threat / origin): no preferred direction.
                clamp_arena(p);
                return;
            }
            let l = (ax * ax + az * az).sqrt();
            ax /= l;
            az /= l;
            let target = [p[0] + ax * FLEE_AWAY, p[1] + az * FLEE_AWAY];
            step_toward(p, target, step);
        }

        // WANDER — amble toward the random roam point; regenerate a fresh one (own rng) once within
        // arrival of the current one, so a wanderer always has a live target to walk to.
        Goal::Wander { to } => {
            let mut target = *to;
            if dist2(*p, target) <= ARRIVE * ARRIVE {
                // NOTE: the regenerated target is consumed THIS tick; `decide` owns the goal data, so
                // we can't write it back into `goal[i]` here (read-only borrow). That's fine — the
                // agent heads for a fresh point and `decide` restamps `to` on its next pass.
                target = fresh_roam(r, home);
            }
            step_toward(p, target, step);
        }

        // ATTRACTOR goals (Work/Market/Comfort/Home) — walk straight at the static/belief target,
        // clamp on arrival.
        _ => {
            if let Some(target) = goal.move_target() {
                step_toward(p, target, step);
            }
            // None (Idle/Eat/Rest/Fight) ⇒ stand still (the in-place verb runs in its own system).
        }
    }
    clamp_arena(p);
}

/// Step `p` toward `target` by at most STEP; snap exactly on arrival (clamp). Never overshoots.
#[inline]
fn step_toward(p: &mut [f32; 2], target: [f32; 2], step: f32) {
    let dx = target[0] - p[0];
    let dz = target[1] - p[1];
    let d = (dx * dx + dz * dz).sqrt();
    if d <= ARRIVE {
        // arrived: snap to the target so the column is stable (no jitter at the goal).
        p[0] = target[0];
        p[1] = target[1];
        return;
    }
    let s = (step / d).min(1.0); // clamp: never step past the target
    p[0] += dx * s;
    p[1] += dz * s;
}

/// A fresh roam point in the town band around `home` (own rng only — deterministic per entity).
#[inline]
fn fresh_roam(r: &mut DeterministicRng, home: [f32; 2]) -> [f32; 2] {
    let ang = r.next_f32() * std::f32::consts::TAU;
    let rad = r.next_f32() * WANDER_RADIUS;
    [home[0] + ang.cos() * rad, home[1] + ang.sin() * rad]
}

/// Hard arena clamp: pull a position back onto the ±ARENA disc (matches worldgen's clamp).
#[inline]
fn clamp_arena(p: &mut [f32; 2]) {
    let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
    if r > ARENA {
        let k = ARENA / r;
        p[0] *= k;
        p[1] *= k;
    }
}

#[inline]
fn dist2(a: [f32; 2], b: [f32; 2]) -> f32 {
    let dx = a[0] - b[0];
    let dz = a[1] - b[1];
    dx * dx + dz * dz
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Goal, PersonBelief};
    use crate::world::World;

    /// A Goal::Work target makes the agent step toward the site (and arrive over several ticks).
    #[test]
    fn work_goal_steps_toward_site() {
        let mut w = World::spawn(0xABCD, 8);
        let i = 0usize;
        let site = [w.pos[i][0] + 30.0, w.pos[i][1] + 40.0]; // 50m away
        // freeze every OTHER agent so only i moves (Idle ⇒ no move_target).
        for k in 0..w.n {
            w.goal[k] = Goal::Idle;
        }
        w.goal[i] = Goal::Work { site };
        let start = w.pos[i];
        let d0 = super::dist2(start, site).sqrt();
        // one step closes ~STEP metres.
        step(&mut w);
        let d1 = super::dist2(w.pos[i], site).sqrt();
        assert!(d1 < d0, "agent should move closer to its work site");
        assert!((d0 - d1 - STEP).abs() < 1e-3, "should close ~STEP per tick, got {}", d0 - d1);
        // walk to arrival and assert it clamps exactly on the site, no overshoot.
        for _ in 0..100 {
            step(&mut w);
        }
        let dn = super::dist2(w.pos[i], site).sqrt();
        assert!(dn <= ARRIVE + 1e-3, "agent should arrive and clamp at the site, dist={dn}");
    }

    /// Idle / no-move_target goals leave the position unchanged.
    #[test]
    fn idle_goal_does_not_move() {
        let mut w = World::spawn(0xABCD, 4);
        for k in 0..w.n {
            w.goal[k] = Goal::Idle;
        }
        let before: Vec<[f32; 2]> = w.pos.clone();
        step(&mut w);
        assert_eq!(before, w.pos, "idle agents must not move");
    }

    /// Flee moves the agent AWAY from a believed threat position.
    #[test]
    fn flee_moves_away_from_believed_threat() {
        let mut w = World::spawn(0xABCD, 4);
        for k in 0..w.n {
            w.goal[k] = Goal::Idle;
        }
        let i = 0usize;
        w.pos[i] = [0.0, 0.0];
        // plant a believed threat (subject id 99) to the +x side.
        let threat_id = 99u32;
        let bt = &mut w.beliefs[i];
        bt.subjects[0] = threat_id;
        bt.bodies[0] =
            PersonBelief { subject: threat_id, last_x: 10.0, last_z: 0.0, ..Default::default() };
        bt.len = 1;
        w.goal[i] = Goal::Flee { from: threat_id };
        step(&mut w);
        // should move in -x (away from the threat at +x).
        assert!(w.pos[i][0] < 0.0, "flee should move away from threat (-x), got {:?}", w.pos[i]);
    }

    /// Wander regenerates a fresh roam point on arrival and keeps moving (never freezes at a stale to).
    #[test]
    fn wander_regenerates_on_arrival() {
        let mut w = World::spawn(0xABCD, 4);
        for k in 0..w.n {
            w.goal[k] = Goal::Idle;
        }
        let i = 0usize;
        w.pos[i] = [0.0, 0.0];
        w.home[i] = [0.0, 0.0];
        // `to` is the agent's current pos ⇒ already "arrived" ⇒ must regenerate + step somewhere.
        w.goal[i] = Goal::Wander { to: [0.0, 0.0] };
        step(&mut w);
        assert!(
            super::dist2(w.pos[i], [0.0, 0.0]) > 0.0,
            "wander should regenerate + move off the arrival spot"
        );
    }
}
