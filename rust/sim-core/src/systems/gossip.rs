//! FAN-OUT UNIT: gossip. Port the spirit of `js/sim/agent/perception.ts` `gossipBeliefs`
//! (belief spread + relationship accrual between nearby agents).
//!
//! WHAT TO IMPLEMENT (parallel, own-write into `world.beliefs`, cross-READ from `world.beliefs_prev`):
//! - The scheduler has already snapshotted beliefs into `beliefs_prev` (the frozen read set). For
//!   each agent i, find a nearby partner (within talk range — use the grid / `pos`), then merge
//!   that partner's `beliefs_prev[partner]` cells into `beliefs[i]` (adopt more-confident beliefs;
//!   drift `standing`). Reading `beliefs_prev[partner]` (others) + writing `beliefs[i]` (own) is the
//!   §4 double-buffer pattern → race-free, deterministic.
//! - Accrue a small positive `standing` toward a peacefully-chatted partner (relationship EMA).
//! IMPORTANT determinism: pick the partner deterministically (e.g. lowest-id partner within range),
//! NOT "first found in grid order" if that order could vary — grid order IS deterministic here, but
//! prefer an explicit tie-break (lowest id) to be safe. Never write `beliefs[partner]`.
//!
//! Stub: no-op (deterministic).

use crate::world::World;

pub fn gossip(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
