//! FAN-OUT UNIT: groups / bands (clan & warband membership). Port the SPIRIT of `js/sim/groups.js`.
//!
//! WHAT TO IMPLEMENT (SERIAL society phase; reads + writes `world.band_leader`):
//! - Band formation: a high-standing / high-level agent with nearby like-minded agents (read the grid
//!   + `beliefs`/`standing`) becomes a leader; nearby eligible agents set `band_leader[i] = leader_id`
//!   (NO_BAND = -1 when unbanded). Cap band size.
//! - Dissolution: a leader who dies (`!alive`) frees its followers (band_leader -> NO_BAND).
//! Determinism: SERIAL ⇒ M-invariant. Deterministic leader/member selection (id order + explicit
//! tie-breaks). Use `world.sim_rng` for rolls. No gold/spawn here.
//! (This is the substrate for later warband/coordination behaviour; Wave-3 just establishes membership.)
//!
//! Stub: no-op.

use crate::world::World;

pub fn tick(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
