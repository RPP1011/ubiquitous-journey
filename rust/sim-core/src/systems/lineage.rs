//! FAN-OUT UNIT: lineage (births / mortality / population). Port the SPIRIT of `js/sim/lineage.js`.
//!
//! WHAT TO IMPLEMENT (SERIAL society phase; mutates the world):
//! - Throttle (every N ticks). Maintain a soft population cap: when living townsfolk are below the
//!   cap and a stable couple exists, spawn a child via `world.spawn_agent(pos, Faction::Townsfolk,
//!   profession)` near a parent; optionally inherit a `house`/a trait; log a `Beat` (kind=birth).
//! - Mortality bookkeeping (the corpse reaper / old age) can live here too — but agents already go
//!   `alive=false` via combat/starvation; lineage need only react (e.g. log a death Beat once).
//! Determinism: SERIAL ⇒ M-invariant. Use `world.sim_rng` for rolls. CONSERVATION: a child carries 0
//! gold (or inherit by MOVING gold from a parent — conserved); never mint.
//! Pairing must be deterministic (scan in id order, pick the first eligible couple, etc.).
//!
//! Stub: no-op.

use crate::world::World;

pub fn tick(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
