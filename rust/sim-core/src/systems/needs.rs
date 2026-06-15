//! FAN-OUT UNIT: needs. Port from `js/sim/agent.js` `drainNeeds` + the eat/rest/comfort verbs in
//! `js/sim/agent/act.ts`.
//!
//! WHAT TO IMPLEMENT (parallel, own-write — `world.needs`, `world.econ`, `world.mood`):
//! - Decay each agent's `Needs` over the tick (hunger/energy/social/comfort/novelty toward 0).
//! - In-place satisfaction when the agent's GOAL says so: `Goal::Eat` consumes a Food unit from
//!   `econ[i].inventory` and raises `needs[i].hunger`; `Goal::Rest` raises energy; `Goal::Comfort`
//!   raises comfort. (Locomotion has already walked them to the spot; here is the on-arrival verb.)
//! - Starvation: when hunger sits at 0, this is where a death/`alive=false` would be flagged
//!   (Wave-1 may skip the kill).
//! Determinism: read/write only row `i`. No cross-agent access.
//!
//! Stub: no-op (the substrate compiles + stays deterministic until this is filled).

use crate::world::World;

pub fn drain(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
