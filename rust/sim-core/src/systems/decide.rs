//! FAN-OUT UNIT: decide. Port the spirit of `js/sim/agent/decide.ts` + `js/sim/motivation.js`
//! (goal derivation). NOT the full GOAP planner — a pragmatic scorer is fine (no TS parity, doc 22 §9).
//!
//! WHAT TO IMPLEMENT (parallel, own-write — `world.goal`, reading `world.needs`, `world.beliefs`,
//! `world.faction`, `world.profession`, `world.pos`, and the static `world.market`/`work_sites`/`home`):
//! - Choose `goal[i]` from needs + beliefs: e.g. lowest need wins — hunger→`Eat`, energy→`Rest`,
//!   comfort→`Comfort{home}`; else a believed-hostile in range → `Flee{from}` (read `beliefs[i]`
//!   for a hostile cell); else if has a profession → `Work{work_sites[prof]}`; occasionally
//!   `Market{market}` to trade; else `Wander{random point near town}` (use `rng[i]`).
//! Determinism: read/write only row `i` (beliefs[i] is own). Use `rng[i]` for any randomness.
//!
//! Stub: everyone idles (deterministic).

use crate::world::World;

pub fn decide(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
