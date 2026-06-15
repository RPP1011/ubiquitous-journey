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
    /// A witnessed/published deed (actor, verb tag, magnitude) — fed to progression/witness folds.
    Deed { actor: u32, verb: u8, magnitude: u16, target: u32 },
    /// A one-way CONSERVED handover: move `gold` (minor units) and/or `qty` of commodity `good` from
    /// `from` to `to` (only what `from` actually holds). The resolver's `deliverTo`/`take` as an
    /// intent — the primitive behind give/pay (from=self) and rob/loot (from=victim) and teach (tuition).
    Hand { from: u32, to: u32, gold: i64, good: u8, qty: i32 },
}

impl Intent {
    /// The deterministic merge sort key: (target, source, discriminant). Same key ⇒ FIFO of push,
    /// which is itself deterministic because the parallel phase visits agents 0..n.
    #[inline]
    pub fn order_key(&self) -> (u32, u32, u8) {
        match *self {
            Intent::Transfer { from, to, .. } => (to, from, 0),
            Intent::Strike { from, to, .. } => (to, from, 1),
            Intent::Deed { actor, target, .. } => (target, actor, 2),
            Intent::Hand { from, to, .. } => (to, from, 3),
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
