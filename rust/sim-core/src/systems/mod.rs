//! The system phases (docs/architecture/22 §4). Each is ONE file owned by one fan-out unit, filled
//! against the FROZEN `World` substrate. The golden rule every system must keep (and `tests/
//! determinism.rs` enforces): **per-entity own-write in the parallel phase, OR emit an `Intent`** for
//! anything that touches another entity — never write `world.<col>[j]` for `j != self` directly, and
//! never use a `rayon` float reduce / `HashMap` iteration in a behaviour path (it breaks M=1 ≡ M=N).
//!
//! Parallel pattern (own-write):
//! ```ignore
//! let World { ref needs, ref mut goal, .. } = *world;   // disjoint borrows
//! goal.par_iter_mut().enumerate().for_each(|(i, g)| { /* read needs[i], write *g */ });
//! ```
//! Cross-agent pattern (intents): collect per item via `par_iter().filter_map().collect::<Vec<_>>()`,
//! then `world.intents.items.extend(collected)` serially; the scheduler drains them deterministically.

pub mod act;
pub mod combat;
pub mod decide;
pub mod gossip;
pub mod locomotion;
pub mod market;
pub mod needs;
pub mod progression;
// Wave-3 society / observer systems (the SERIAL society phase). Each runs throttled, mutates the
// shared world directly (spawns go via `World::spawn_agent`), and is deterministic by being serial.
pub mod chronicle;
pub mod defenses;
pub mod director;
pub mod expeditions;
pub mod faith;
pub mod groups;
pub mod houses;
pub mod intrigue;
pub mod lineage;
pub mod patrician;
pub mod quests;
pub mod seeding;
pub mod watch;
