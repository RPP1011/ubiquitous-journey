//! FAN-OUT UNIT: combat. Port the spirit of `js/combat.js` + the fight branch of `act.ts`
//! (target a believed-hostile, strike, resolve) — but as INTENTS, not direct writes.
//!
//! WHAT TO IMPLEMENT (parallel decide → `Intent::Strike`; the scheduler merges them):
//! - For each agent whose `goal[i]` is `Fight{target}` (or who has an in-range believed-hostile in
//!   `beliefs[i]`), if in melee range and off cooldown, produce an `Intent::Strike{from:i, to:target,
//!   dmg}`. Advance the agent's OWN `combat[i]` swing state machine (own-write is fine).
//! - Collect intents in parallel: `let strikes: Vec<Intent> = (0..n).into_par_iter().filter_map(..)
//!   .collect();` then `world.intents.items.extend(strikes);` (serial extend).
//! - The merge (in `World::drain_intents`) applies damage to `combat[to].health`, flips `alive` on
//!   death, and conserves. Death/loot can emit a `Deed` intent for progression.
//! Determinism: the strike DECISION reads only own beliefs + the believed target's pos (own belief);
//! the damage APPLICATION is the deterministic serial merge. Never write `combat[target]` directly.
//!
//! Stub: no-op (deterministic).

use crate::world::World;

pub fn resolve(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
