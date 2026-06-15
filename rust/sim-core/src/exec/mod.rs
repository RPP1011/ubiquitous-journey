//! The execution/derivation registry (the Rust port of `js/sim/exec/registry.ts`). TS registers
//! executors/derivers/effect-holds/plan-outcomes dynamically at import time; Rust can't (no import
//! side-effects), so the registry is a STATIC data table — each feature contributes a row, additive
//! and merge-friendly (one block per feature, like the Wave-2/3 system fan-outs). This is the seam the
//! Wave-D feature layer hooks into:
//!   - DERIVERS — turn OWN beliefs/memory/needs into standing intentions (run each cognition tick).
//!   - (executors / effect-holds / plan-outcomes land alongside as the executor layer + caution port.)
//!
//! Everything here is OWN-state and total (never panics), so the determinism + epistemic-split
//! invariants hold: a deriver writes only the agent's own goal stack, reading only its own row.

pub mod derivers;
pub mod registry;
