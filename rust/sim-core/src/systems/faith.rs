//! FAN-OUT UNIT: faith (small gods whose power scales with believers). Port the SPIRIT of
//! `js/sim/faith.js`.
//!
//! WHAT TO IMPLEMENT (SERIAL society phase; reads + writes `world.faith`):
//! - Tally believers per god (count of `faith[i] == g`). A god's "power" scales with its flock.
//! - Conversion: occasionally an agent adopts the faith of a confident, well-regarded neighbour (or
//!   the locally dominant faith). Read neighbours via the grid/positions; set `faith[i]` (own).
//! - A faith with too few believers fades (its members may drift to `NO_GOD`).
//! Determinism: SERIAL ⇒ M-invariant. If you read neighbours' faith while writing faith, do it in a
//! read-then-write pass (snapshot the column or compute all updates then apply) so it's order-stable.
//! Use `world.sim_rng` for rolls. No gold/spawn here.
//!
//! Stub: no-op.

use crate::world::World;

pub fn tick(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
