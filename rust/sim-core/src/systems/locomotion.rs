//! FAN-OUT UNIT: locomotion / steer. Port the spirit of `js/sim/agent/steer.ts` + `movement.ts`
//! (the potential-field steer-fills) — the on-arrival world-interaction VERB stays in its own system
//! (needs/market/combat), here is just locomotion.
//!
//! WHAT TO IMPLEMENT (parallel, own-write — `world.pos`, reading `world.goal`, `world.rng`):
//! - For each agent, get `goal[i].move_target()`. If `Some(target)`, step `pos[i]` toward it at a
//!   per-tick speed (clamp arrival); if `None` (Eat/Rest/Fight in place), don't move.
//! - `Goal::Flee{from}` should move AWAY from the believed threat position (read `beliefs[i]`'s cell
//!   for `from`'s `last_x/last_z`) — a repulsor.
//! - `Goal::Wander` drifts toward its random `to`, regenerating when reached (use `rng[i]`).
//! - Clamp to ±ARENA. Keep it own-write (pos[i] + rng[i] only).
//! Determinism: per-entity; positions read here are own (`pos[i]`); reading a believed target from
//! `beliefs[i]` is own-state. Do NOT read other agents' live `pos` (use beliefs / the goal target).
//!
//! Stub: no movement (deterministic).

use crate::world::World;

pub fn step(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
