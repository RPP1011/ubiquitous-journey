//! The DERIVER registry (the `DERIVERS` table + `runDerivers`). A goal-deriver turns the agent's OWN
//! beliefs/memory into standing intentions pushed onto its persistent goal stack. Adding a feature =
//! appending a row to `DERIVERS` + its fn (additive, fan-out-friendly). Order is fixed ⇒ deterministic.

use crate::components::{BeliefTable, Experience, GoalStack, Memory, Personality, N_COMMODITIES};

/// The read-only OWN-state view a deriver reasons over (the epistemic split: own row + static world,
/// never the live roster). Mirrors the believed slice the planner's `Pv` exposes, for derivation.
pub struct DeriveCtx<'a> {
    pub faction: u8,
    pub profession: u8,
    pub gold: i64,
    pub inventory: [i32; N_COMMODITIES],
    pub pos: [f32; 2],
    pub personality: Personality,
    /// Own hunger need (0..1, lower = hungrier) — read by the subsistence deriver to pose a meal goal.
    pub hunger: f32,
    /// Own outcome-conditioned caution store (doc 11) — read by watched-strategy derivers (the steal
    /// gate: a thief whose heists keep failing stops arming new ones — the burned hand).
    pub experience: Experience,
    pub beliefs: &'a BeliefTable,
    pub memory: &'a Memory,
    pub now: u32,
}

/// A goal-deriver: pushes/refreshes standing intentions on the stack from the agent's own state.
/// Total (never panics) ⇒ one deriver's behaviour never blocks another's; writes only the stack.
pub type Deriver = fn(&mut GoalStack, &DeriveCtx);

/// The registered derivers, in fixed order. The CORE memory→goal derivers are the first block; the
/// Wave-D feature derivers (urchin steal, ledger repay, recruiter muster, …) append here.
pub static DERIVERS: &[Deriver] = &[
    super::derivers::avenge,
    super::derivers::seek_fortune,
    super::derivers::grieve,
    super::derivers::steal,
    super::derivers::defend,
    super::derivers::donate,
    super::derivers::repay,
    super::derivers::subsistence,
    super::derivers::loot,
];

/// Run every registered deriver over the agent's goal stack (own-state only ⇒ deterministic).
#[inline]
pub fn run_derivers(gstack: &mut GoalStack, ctx: &DeriveCtx) {
    for d in DERIVERS {
        d(gstack, ctx);
    }
}
