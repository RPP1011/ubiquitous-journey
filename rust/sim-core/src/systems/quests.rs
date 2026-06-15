//! FAN-OUT UNIT: quests (the quest board). Port the SPIRIT of `js/quest/quest.js` — emergent +
//! radiant contracts, completion detected from ground truth.
//!
//! WHAT TO IMPLEMENT (SERIAL society phase; mutates `world.quests`):
//! - Keep the board topped up to a floor with radiant `Quest`s (hunt a faction, deliver a good,
//!   delve…) scaled to the world; mint via `world.sim_rng`. A quest's `reward` is paid FROM a giver's
//!   gold on completion (conserved — move, don't mint) or simply marks `done` (Wave-3 may skip payout).
//! - Completion detection from ground truth each tick: e.g. a hunt quest's `got` rises as targets of
//!   `target` faction die (read `alive`); mark `done` when `got >= count`; expire stale quests.
//! - Optionally surface a quest as a goal hint (out of scope for the stub — decide stays as-is).
//! Determinism: SERIAL ⇒ M-invariant. Use `world.sim_rng`. CONSERVATION: reward payout MOVES gold
//! (giver -> claimant), never mints.
//!
//! Stub: no-op.

use crate::world::World;

pub fn tick(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
