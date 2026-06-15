//! FAN-OUT UNIT: market / economy. Port the spirit of `js/sim/market.js` (the localized double-
//! auction) + the trade interface in `agent.ts` — as INTENTS into the conserved merge.
//!
//! WHAT TO IMPLEMENT (parallel decide → `Intent::Transfer`; the scheduler merges + conserves):
//! - Agents standing at the market (`goal[i] == Market`, near `world.market`) with a surplus to sell
//!   or a want to buy produce `Intent::Transfer{from:seller, to:buyer, good, qty, price}` against a
//!   willing counterparty. Price from belief/midpoint (`econ[i].price_belief`, `world.base_price`).
//!   Drift `price_belief` toward observed clears (own-write).
//! - Pairing buyers↔sellers deterministically is the tricky bit: a simple Wave-1 approach is to
//!   build, per commodity, the sorted lists of sellers and buyers at market (by id), then pair them
//!   in order and emit transfers. Do this in ONE serial pass (it's cheap, market-only subset) OR a
//!   parallel collect with deterministic ordering — just keep it order-independent.
//! - Production (a worker at its work site makes goods) can also live here or in needs/work: bump
//!   `econ[i].inventory[good]` (own-write), emit a `Deed` for progression.
//! Conservation: gold is fixed-point `i64`; the merge only moves it (never mints). Keep it exact.
//!
//! Stub: no-op (deterministic).

use crate::world::World;

pub fn clear(_world: &mut World) {
    // TODO(fan-out): implement per the doc above.
}
