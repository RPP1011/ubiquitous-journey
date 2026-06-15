//! FAN-OUT UNIT: progression. Port the spirit of `js/rpg/progression.js` + `classes.js`
//! (deeds → weighted behavior_profile → emergent classes + levels).
//!
//! WHAT TO IMPLEMENT (own-write `world` progression columns; reads the drained `Deed` intents):
//! - Add a progression column to `World` is NOT needed for the stub, but the full unit will want a
//!   `behavior_profile: [f32; N_TAGS]`, `total_level`, and held classes per agent. (If you add a
//!   column, do it in `world.rs` — coordinate, since that's a shared file; prefer a dedicated
//!   `Vec<Progression>` column added once.)
//! - Fold each tick's `Deed` intents (verb tag, magnitude) into the actor's behavior_profile, decay
//!   it, periodically match against class templates to grant classes + route XP to levels.
//! Determinism: per-actor own-write; deeds are delivered in the deterministic merge order.
//! NOTE: this unit may need a small shared-file edit (the `Progression` column) — flag it in the PR
//! so integration is clean; everything else stays in this file.
//!
//! Stub: no-op (deterministic).

use crate::world::World;

pub fn tick(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
