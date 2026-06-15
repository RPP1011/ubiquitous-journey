//! FAN-OUT UNIT: director (drama manager). Port the SPIRIT of `js/sim/director.js` — a points-budget
//! trope engine that injects situations when the world goes quiet, on cooldowns.
//!
//! WHAT TO IMPLEMENT (SERIAL society phase — runs once/tick, may mutate the world):
//! - Throttle: only act every N ticks (`world.tick % N == 0`).
//! - Read the roster cheaply (living townsfolk count, recent conflict) to decide when it's "quiet".
//! - The flagship trope = a RAID: when quiet + a cooldown elapsed, spawn a wave of raiders via
//!   `world.spawn_agent(pos, Faction::Raider, Profession::None)` at the town fringe, give them
//!   `Goal::Fight`/threat, and log a `Beat` (kind=raid) to `world.chronicle`.
//! - Keep a small budget/cooldown as own state on `World` if needed (or derive from `world.tick`).
//! Determinism: SERIAL phase ⇒ trivially M-invariant. Use `world.sim_rng` for any rolls (NOT per-entity
//! rng). CONSERVATION: spawned raiders carry 0 gold (spawn_agent default) — never mint.
//!
//! Stub: no-op.

use crate::world::World;

pub fn tick(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
