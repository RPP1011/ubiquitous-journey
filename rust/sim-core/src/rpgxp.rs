//! Pure XP / level math (port of `js/rpg/xp.ts` + the `RPG` curve tuning in `js/rpg/rpgconfig.ts`).
//!
//! No state — `systems::progression` owns the per-agent ledgers and calls these pure functions:
//!   - `xp_for_level(level, total_level)` — the canonical cost curve (scales with the class's own
//!     level AND the agent's total level, so polymaths grind).
//!   - `significance(ev, now, ledger)` — the novelty/risk/grind multiplier on each XP gain.
//!   - `xp_from_event(score, sig_mult)` — `score * xpScoreScalar * significance`.
//!   - `sigmoid(x)` — the matcher/significance shaping curve.
//!
//! DETERMINISM: these are pure functions of their arguments (deterministic given the same inputs).
//! They use `f32` like the JS `number` math; the substrate's progression banks XP as integers, so
//! these helpers are the *math reference* (and are unit-tested for parity), not the hot reduce path.

/// `RPG.*` curve tuning (the subset `xp.ts` reads). Mirrors `js/rpg/rpgconfig.ts` `RPG`.
pub mod rpg {
    pub const XP_SCORE_SCALAR: f32 = 0.5;
    pub const XP_NEED_BASE: f32 = 30.0;
    pub const XP_NEED_EXP: f32 = 0.08;

    // significance multiplier
    pub const SIGNIFICANCE_ON: bool = true;
    pub const SIG_BASE: f32 = 1.0;
    pub const SIG_NOVEL_COMBO_MULT: f32 = 2.5;
    pub const SIG_KILL_MULT: f32 = 1.8;
    pub const SIG_RISK_MULT: f32 = 1.5;
    pub const SIG_GRIND_HALF_LIFE_SEC: f32 = 30.0;
    pub const SIG_GRIND_FLOOR: f32 = 0.25;
    pub const SIG_SOLO_MULT: f32 = 1.5;
    pub const SIG_ALLY_DILUTION: f32 = 0.2;
    pub const SIG_CAP: f32 = 4.0;
}

/// xp_needed(level, totalLevel) = xpNeedBase * exp(xpNeedExp*level) * (1 + (totalLevel/100)^2).
/// Cost to go FROM `level` to `level+1`. `total_level` is the agent's summed levels across all
/// classes — so the more you hold, the costlier each. Port of `xpForLevel`.
#[inline]
pub fn xp_for_level(level: f32, total_level: f32) -> f32 {
    let t = total_level / 100.0;
    rpg::XP_NEED_BASE * (rpg::XP_NEED_EXP * level).exp() * (1.0 + t * t)
}

/// The deed slice `significance` reads (the caller maintains these; we never write hidden state):
/// the per-deed novelty/recency cues. `combo_seen` = "has this exact tag-combo been seen before?",
/// `last_same_deed` = the last sim-time the SAME (verb+combo) deed fired, if ever.
#[derive(Clone, Copy, Debug, Default)]
pub struct SigLedger {
    pub combo_seen: bool,
    pub last_same_deed: Option<f32>,
}

/// What `significance` reports back (no hidden writes — the caller folds these into its ledger).
#[derive(Clone, Copy, Debug)]
pub struct SigResult {
    pub mult: f32,
    pub novel: bool,
}

/// The minimal deed view `significance` needs (the slice of an `ActionEvent` it reads).
#[derive(Clone, Copy, Debug)]
pub struct DeedView {
    pub has_tags: bool,
    pub kill: bool,
    pub risk: bool,
    /// deed magnitude (0..1 clamp drives the RISK scaling).
    pub magnitude: f32,
    /// allied combatants beside the actor at deed time, if the deed carries one (combat folds do).
    pub allies: Option<u32>,
}

/// The significance / novelty / risk / grind-decay multiplier on an XP gain (port of `significance`).
///   - novel tag-combo for this agent → big boost.
///   - KILL / RISK tags → combat danger pays more (RISK scales with magnitude).
///   - stakes diluted by company (allies count) — a solo feat amplifies, a crowd divides.
///   - grind decay: repeating the SAME deed within a half-life window decays toward a floor.
pub fn significance(ev: &DeedView, now: f32, led: &SigLedger) -> SigResult {
    if !rpg::SIGNIFICANCE_ON {
        return SigResult { mult: 1.0, novel: false };
    }
    let mut mult = rpg::SIG_BASE;

    // novelty: first time this exact tag-combo appears for the agent.
    let novel = ev.has_tags && !led.combo_seen;
    if novel {
        mult *= rpg::SIG_NOVEL_COMBO_MULT;
    }

    // STAKES DILUTED BY COMPANY (only when the deed carries an allies count).
    if let Some(allies) = ev.allies {
        mult *= if allies == 0 {
            rpg::SIG_SOLO_MULT
        } else {
            1.0 / (1.0 + allies as f32 * rpg::SIG_ALLY_DILUTION)
        };
    }

    // risk / kill emphasis.
    if ev.kill {
        mult *= rpg::SIG_KILL_MULT;
    }
    if ev.risk {
        let m = ev.magnitude.clamp(0.0, 1.0);
        mult *= 1.0 + (rpg::SIG_RISK_MULT - 1.0) * m;
    }

    // grind decay: same verb+combo seen recently → worth less, recency half-life.
    if let Some(last) = led.last_same_deed {
        let dt = (now - last).max(0.0);
        let decayed = if rpg::SIG_GRIND_HALF_LIFE_SEC > 0.0 {
            0.5f32.powf((rpg::SIG_GRIND_HALF_LIFE_SEC - dt) / rpg::SIG_GRIND_HALF_LIFE_SEC)
        } else {
            0.5f32.powf(0.0)
        };
        let grind =
            (1.0 - decayed * (1.0 - rpg::SIG_GRIND_FLOOR)).clamp(rpg::SIG_GRIND_FLOOR, 1.0);
        mult *= grind;
    }

    mult = mult.clamp(0.0, rpg::SIG_CAP);
    SigResult { mult, novel }
}

/// Full XP awarded by an event toward a class, before routing:
/// `xp = classMatchScore * xpScoreScalar * significanceMult`. Port of `xpFromEvent`.
#[inline]
pub fn xp_from_event(score: f32, sig_mult: f32) -> f32 {
    score * rpg::XP_SCORE_SCALAR * sig_mult
}

/// Numerically-stable sigmoid (port of `rpgconfig.ts sigmoid`) — used by the class matcher.
#[inline]
pub fn sigmoid(x: f32) -> f32 {
    if x >= 0.0 {
        let z = (-x).exp();
        1.0 / (1.0 + z)
    } else {
        let z = x.exp();
        z / (1.0 + z)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `xp_for_level` matches the JS curve at the reference points (base at level 0/total 0,
    /// monotone increase with level, and the total-level surcharge).
    #[test]
    fn xp_for_level_curve() {
        // level 0, total 0 → base * exp(0) * (1 + 0) = base.
        assert!((xp_for_level(0.0, 0.0) - rpg::XP_NEED_BASE).abs() < 1e-3);
        // higher level costs strictly more.
        assert!(xp_for_level(5.0, 0.0) > xp_for_level(0.0, 0.0));
        // the total-level surcharge: same level, more total → costlier ((1 + (100/100)^2) = 2x).
        let a = xp_for_level(3.0, 0.0);
        let b = xp_for_level(3.0, 100.0);
        assert!((b - a * 2.0).abs() < 1e-2, "total-level doubles the cost at total=100");
    }

    /// significance: a novel KILL solo deed gets the combo + kill + solo boosts, capped.
    #[test]
    fn significance_novel_kill() {
        let ev = DeedView { has_tags: true, kill: true, risk: false, magnitude: 1.0, allies: Some(0) };
        let led = SigLedger { combo_seen: false, last_same_deed: None };
        let r = significance(&ev, 100.0, &led);
        assert!(r.novel, "first-seen combo is novel");
        // base 1 * novel 2.5 * solo 1.5 * kill 1.8 = 6.75 → clamped to the 4.0 cap.
        assert!((r.mult - rpg::SIG_CAP).abs() < 1e-4, "combined mult clamps to the cap");
    }

    /// significance: grinding the SAME deed immediately damps the gain toward the floor.
    #[test]
    fn significance_grind_damps() {
        let ev = DeedView { has_tags: true, kill: false, risk: false, magnitude: 0.0, allies: None };
        // fresh (never seen the combo, no recent repeat): just the novelty boost.
        let fresh = significance(&ev, 100.0, &SigLedger { combo_seen: false, last_same_deed: None });
        // a stale-combo repeat the same instant: no novelty, heavy grind damp.
        let ground = significance(
            &ev,
            100.0,
            &SigLedger { combo_seen: true, last_same_deed: Some(100.0) },
        );
        assert!(ground.mult < fresh.mult, "an immediate repeat is worth less than a novel deed");
        assert!(ground.mult >= rpg::SIG_GRIND_FLOOR - 1e-4, "never below the grind floor");
    }

    /// significance OFF (would be) and the flat-1 self-consistency of `xp_from_event`.
    #[test]
    fn xp_from_event_scales() {
        assert!((xp_from_event(10.0, 1.0) - 10.0 * rpg::XP_SCORE_SCALAR).abs() < 1e-4);
        assert!((xp_from_event(0.0, 4.0)).abs() < 1e-6);
    }

    /// sigmoid is monotone, centred at 0.5, and stable for large |x|.
    #[test]
    fn sigmoid_shape() {
        assert!((sigmoid(0.0) - 0.5).abs() < 1e-6);
        assert!(sigmoid(50.0) > 0.99);
        assert!(sigmoid(-50.0) < 0.01);
        assert!(sigmoid(1.0) > sigmoid(-1.0));
    }
}
