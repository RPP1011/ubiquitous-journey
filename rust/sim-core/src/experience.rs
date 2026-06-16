//! OUTCOME-CONDITIONED CAUTION — the store (docs/architecture/11). The Rust port of
//! `js/sim/experience.ts` + the `js/sim/features/caution.ts` plan-outcome handler, to behavioral
//! parity (determinism the only divergence: a fixed per-verb array replaces the JS `Map`, so there is
//! no HashMap-order non-determinism, and no `maxKeys` eviction is needed — the verb set is closed).
//!
//! This is the BURNED-HAND half of regret: an agent learns about its STRATEGIES from its own outcomes
//! the way it learns about the WORLD from perception. A signed surcharge per strategy — burned (dearer)
//! when a watched act falls short / is wasted / turns perilous, emboldened (cheaper) by genuine success
//! — eroded by time and by success, read inside the planner's `cost` beside the travel/act costs.
//! Own-state only; bounded; lazily decayed (no per-tick pass); never panics. NATURE STAYS FIXED — this
//! never mutates `Personality`; decay is always toward 0.

use crate::components::{ActExp, Experience};

// CAUTION config (mirrors `simconfig.ts` CAUTION; tuned for the fixed tick, doc 22 §9).
/// The surcharge halves every `HALF_LIFE` ticks since it was last written.
const HALF_LIFE: f32 = 72.0;
/// Burn clamp on the positive (timid) side — strongly dissuasive, never infeasible (no-timidity-lock).
const CAP: f32 = 8.0;
/// Emboldening clamp on the negative (keen) side — cap/4: keen, not invincible.
const CAP_DISCOUNT: f32 = 2.0;
/// Base burns per outcome class: a wasted venture < a shortfall < a near-death peril.
const BURN_SHORTFALL: f32 = 2.0;
const BURN_WASTE: f32 = 1.5;
const BURN_PERIL: f32 = 4.0;
/// Genuine success writes the opposing (negative) entry — loss-averse (|windfall| ≪ burns), diminishing.
const WINDFALL: f32 = -0.75;
/// Attribution: a failure on a CONFIDENT belief was bad luck and writes little (burn ×= 1 − conf·this).
const LUCK_DISCOUNT: f32 = 0.7;
/// felt = s · (1 − risk_tolerance · this), POSITIVE side only — the bold shrug off burns, keep streaks.
const RT_RELIEF: f32 = 0.6;
/// Caution threshold shared with `decide`/derivers: at/above this FELT surcharge a watched strategy is
/// "burned" enough that a fresh venture isn't worth arming (the thief who learned his lesson). Set so
/// even the boldest (rt≈1, who feel only `CAP·(1−RT_RELIEF)` ≈ 3.2 at a maxed burn) eventually retire
/// after enough failures — there is no permanent recklessness, but a couple of burns won't deter.
pub const BURNED_BAR: f32 = 3.0;

/// The outcome class of a watched act's realized-vs-believed yield (the §4.2 three-band classifier).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Yield {
    Shortfall,
    Neutral,
    Windfall,
}

#[inline]
fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// The surcharge decayed to `now` (lazy half-life). 0 when never written.
#[inline]
pub fn decayed(e: &ActExp, now: u32) -> f32 {
    if e.t == 0 && e.s == 0.0 {
        return 0.0;
    }
    let dt = now.saturating_sub(e.t) as f32;
    e.s * 0.5_f32.powf(dt / HALF_LIFE)
}

/// THE single write path: fold `delta` onto the decayed base, clamp asymmetrically (burns to `CAP`,
/// emboldening only to `CAP_DISCOUNT`), stamp the time + bump the count.
#[inline]
fn write(e: &mut ActExp, delta: f32, now: u32) {
    let base = decayed(e, now);
    e.s = (base + delta).clamp(-CAP_DISCOUNT, CAP);
    e.t = now;
    e.n = e.n.saturating_add(1);
}

/// BURN — a shortfall / waste / peril outcome. ATTRIBUTION (§5): a failure on a CONFIDENT belief was
/// bad luck and writes little; a knowing gamble writes a lot. `conf` is the plan-time confidence the
/// watched bet leaned on (0..1).
pub fn record_burn(e: &mut ActExp, status: Yield, conf: f32, now: u32) {
    let base = match status {
        Yield::Shortfall => BURN_SHORTFALL,
        Yield::Windfall => return, // a windfall is not a burn
        Yield::Neutral => return,  // mediocrity teaches nothing
    };
    let factor = 1.0 - clamp01(conf) * LUCK_DISCOUNT;
    write(e, base * factor, now);
}

/// BURN a wasted venture (a plan that became infeasible — the quarry slipped, the trip died on the road).
pub fn record_waste(e: &mut ActExp, conf: f32, now: u32) {
    let factor = 1.0 - clamp01(conf) * LUCK_DISCOUNT;
    write(e, BURN_WASTE * factor, now);
}

/// BURN a perilous venture (a watched act that nearly got the agent killed).
pub fn record_peril(e: &mut ActExp, conf: f32, now: u32) {
    let factor = 1.0 - clamp01(conf) * LUCK_DISCOUNT;
    write(e, BURN_PERIL * factor, now);
}

/// WINDFALL — genuine success writes the OPPOSING (negative) entry, loss-averse and DIMINISHING (the
/// 10th success teaches less than the 1st), so streaks embolden but shallowly.
pub fn record_windfall(e: &mut ActExp, now: u32) {
    let n = e.n as f32;
    write(e, WINDFALL / (1.0 + n * 0.25), now);
}

/// THE COGNITION READ — added to a primitive's `cost` in the planner. Own-state only; 0 when unknown.
/// May be NEGATIVE (emboldened). `rt` (risk_tolerance) shrinks the POSITIVE side only — the bold shrug
/// off burns but still enjoy streaks.
#[inline]
pub fn felt_surcharge(store: &Experience, verb: u8, rt: f32, now: u32) -> f32 {
    let i = verb as usize;
    if i >= store.e.len() {
        return 0.0;
    }
    let mut s = decayed(&store.e[i], now);
    if s > 0.0 {
        s *= 1.0 - clamp01(rt) * RT_RELIEF;
    }
    s
}

/// YIELD CLASSIFICATION (§4.2) — three bands. The NEUTRAL band is load-bearing: a mildly-disappointing
/// outcome (≥ ratio·expected but < expected) writes NOTHING, so the loss-aversion asymmetry can't
/// invert in aggregate across many ordinary outcomes. Only genuine surprise — either way — writes.
const SHORTFALL_RATIO: f32 = 0.5;
pub fn classify_yield(expected: f32, realized: f32) -> Yield {
    if !(expected > 0.0) {
        return Yield::Neutral; // nothing believed at stake ⇒ nothing learned
    }
    if realized < SHORTFALL_RATIO * expected {
        return Yield::Shortfall;
    }
    if realized < expected {
        return Yield::Neutral;
    }
    Yield::Windfall
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burn_then_decay_toward_zero() {
        let mut e = ActExp::default();
        record_burn(&mut e, Yield::Shortfall, 0.0, 100);
        let hot = decayed(&e, 100);
        assert!(hot > 0.0, "a shortfall burns the strategy");
        let cooled = decayed(&e, 100 + HALF_LIFE as u32);
        assert!((cooled - hot * 0.5).abs() < 1e-3, "surcharge halves over one half-life");
    }

    #[test]
    fn confident_failure_burns_little() {
        let (mut bold, mut sure) = (ActExp::default(), ActExp::default());
        record_burn(&mut bold, Yield::Shortfall, 0.0, 10); // a knowing gamble
        record_burn(&mut sure, Yield::Shortfall, 1.0, 10); // confident-and-wrong = bad luck
        assert!(decayed(&sure, 10) < decayed(&bold, 10), "a confident bet that fails burns less");
    }

    #[test]
    fn windfall_is_loss_averse_and_diminishing() {
        let mut e = ActExp::default();
        record_windfall(&mut e, 10);
        let first = decayed(&e, 10);
        assert!(first < 0.0, "success emboldens (negative surcharge)");
        assert!(first.abs() < BURN_SHORTFALL, "a windfall is smaller than a burn (loss-averse)");
    }

    #[test]
    fn felt_surcharge_relief_for_the_bold() {
        let mut store = Experience::default();
        record_burn(&mut store.e[7], Yield::Shortfall, 0.0, 5); // burn verb 7 (rob)
        let timid = felt_surcharge(&store, 7, 0.0, 5);
        let bold = felt_surcharge(&store, 7, 1.0, 5);
        assert!(bold < timid, "the bold feel a burn less keenly");
        assert!(bold > 0.0, "but still feel it (no free pass)");
    }
}
