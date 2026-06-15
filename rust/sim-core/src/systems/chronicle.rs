//! FAN-OUT UNIT: chronicle (world-history observer). Port the SPIRIT of `js/sim/chronicle.js` — the
//! OMNISCIENT OBSERVER LAYER (doc 22 §2): it reads ground truth across the roster to NARRATE/record
//! history; it never drives an agent decision, so reading truth here is sanctioned.
//!
//! WHAT TO IMPLEMENT (SERIAL society phase; appends to `world.chronicle`):
//! - Detect notable transitions each tick and append a numeric `Beat { t, kind, subject, magnitude }`
//!   (the render-only text is generated later from these): e.g. a death (agent flipped `!alive` this
//!   tick — track via a small own-state "seen-dead" set or compare against last tick), a class-up
//!   (progression.total_level rose), a raid (coordinate with director, or detect a raider spawn).
//! - Keep the log BOUNDED (cap + drop oldest) so it doesn't grow without limit over a long run.
//! Determinism: SERIAL ⇒ M-invariant. Pure observer (reads truth, writes only the chronicle) — do NOT
//! mutate agent columns. No rng needed (it's detection, not generation).
//!
//! Stub: no-op.

use crate::world::World;

pub fn tick(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
