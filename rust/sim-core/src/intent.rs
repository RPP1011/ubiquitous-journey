//! Cross-agent effects as INTENTS (docs/architecture/22 §4). The parallel phase never writes another
//! entity's columns; instead a system pushes an `Intent`, and a SERIAL merge applies them to the
//! world in a FIXED deterministic order (by target, then source) — so contention/conservation
//! resolve identically regardless of `rayon`. Effects land "a tick behind", by design.
//!
//! Wave-1 covers the core verbs (transfer, strike, deed); the full set is the deferred wave.

#[derive(Clone, Copy, Debug)]
pub enum Intent {
    /// Move `qty` of commodity `good` from `from`'s inventory to `to` (conserved). Economy.
    Transfer { from: u32, to: u32, good: u8, qty: i32, price: i64 },
    /// `from` strikes `to` for `dmg`. Combat resolution.
    Strike { from: u32, to: u32, dmg: f32 },
    /// A witnessed/published deed — a multi-faceted tagged action fed to progression / signals / memory /
    /// (later) god-domains. `truth` = the ground-truth action tags (what really happened); `believed` =
    /// the actor's-perspective tags (what it thought it was doing — usually == truth, but e.g. striking
    /// a percept believing it a person carries Melee in `believed`, not `truth`); `motive` = a `tags::
    /// motive` bitset (why); `outcome` = a `tags::outcome` bitset (the result). Each is "as many as apply".
    Deed { actor: u32, target: u32, magnitude: u16, truth: u64, believed: u64, motive: u32, outcome: u32 },
    /// A one-way CONSERVED handover: move `gold` (minor units) and/or `qty` of commodity `good` from
    /// `from` to `to` (only what `from` actually holds). The resolver's `deliverTo`/`take` as an
    /// intent — the primitive behind give/pay (from=self) and rob/loot (from=victim) and teach (tuition).
    Hand { from: u32, to: u32, gold: i64, good: u8, qty: i32 },
    /// A social INFLUENCE: shift `to`'s believed standing toward `from` by `warm` (the `plant_belief`
    /// ability op — a speaker's charm warms it, a trickster's rumor sours it). Not conserved (belief is
    /// not a quantity); applied serially via warm/sour_belief so it's the deterministic epistemic write.
    Influence { from: u32, to: u32, warm: i16 },
    /// A control AFFLICTION: the ability DSL's debuff ops applied to `to` by `from`. `op` is the
    /// `EffectOp` code (Stun=2/Slow=3/Knockback=4/Expose=7), `amount` the magnitude (knockback distance),
    /// `dur` the timer seconds. Sets a CombatBody timer (stun/slow/expose) or shoves position (knockback).
    Afflict { from: u32, to: u32, op: u8, amount: f32, dur: f32 },
}

impl Intent {
    /// Build a Deed whose believed action matches the truth (the common case — no perception gap).
    /// `truth` is a `Tag::bit()` OR-set; `motive`/`outcome` are `tags::motive`/`tags::outcome` bitsets.
    #[inline]
    pub fn deed(actor: u32, target: u32, magnitude: u16, truth: u64, motive: u32, outcome: u32) -> Intent {
        Intent::Deed { actor, target, magnitude, truth, believed: truth, motive, outcome }
    }

    /// The deterministic merge sort key: (target, source, discriminant). Same key ⇒ FIFO of push,
    /// which is itself deterministic because the parallel phase visits agents 0..n.
    #[inline]
    pub fn order_key(&self) -> (u32, u32, u8) {
        match *self {
            Intent::Transfer { from, to, .. } => (to, from, 0),
            Intent::Strike { from, to, .. } => (to, from, 1),
            Intent::Deed { actor, target, .. } => (target, actor, 2),
            Intent::Hand { from, to, .. } => (to, from, 3),
            Intent::Influence { from, to, .. } => (to, from, 4),
            Intent::Afflict { from, to, .. } => (to, from, 5),
        }
    }
}

/// A per-tick intent queue. Systems append during the parallel phase (each system collects into a
/// thread-local/`Vec` then extends this), then the scheduler `drain`s it in deterministic order.
#[derive(Default)]
pub struct IntentQueue {
    pub items: Vec<Intent>,
}

impl IntentQueue {
    pub fn new() -> Self {
        IntentQueue { items: Vec::new() }
    }
    #[inline]
    pub fn push(&mut self, i: Intent) {
        self.items.push(i);
    }
    pub fn clear(&mut self) {
        self.items.clear();
    }
    /// Sort into the fixed merge order. Stable so equal keys keep push order (deterministic).
    pub fn sort_deterministic(&mut self) {
        self.items.sort_by_key(|i| i.order_key());
    }
}
