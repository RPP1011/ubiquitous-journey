//! THE NARRATIVE-SIGNAL CATALOG (port of `js/sim/signals.ts`, docs/architecture/13). Small, bounded,
//! EVENT-FOLDED values the observer layer measures so probes (the status sensor, the Gazette, future
//! tropes) have something to read. This is a LIBRARY of fold/sample/read functions over the inline
//! `Signals` column (components.rs) — NOT a tick system. Other systems CALL these (a market clear folds
//! a loss, a combat death folds a deed, the observer pass samples gold/standing/displacement/band).
//!
//! PORTED FAMILIES (the per-agent folds the brief named):
//!   · gold EWMA            — sample_gold / gold_trend                    (Family A)
//!   · loss-tagging         — fold_loss / loss_reason_share              (Family A)
//!   · deed tally           — fold_deed / deed_count / first_deed_at     (Family E)
//!   · oath tally           — fold_oath_sworn / fold_oath_pop / oaths    (Family E)
//!   · streak               — fold_streak / streak_of                    (Family A)
//!   · peril                — fold_peril / perils_survived               (Family A)
//!   · standing EWMA        — sample_standing / standing_trend / fortune_reversals (Family A)
//!   · displacement         — sample_displacement / displacement         (Family A)
//!   · band time            — accrue_band / time_in_band                 (Family A)
//!
//! Plus a small slice of the cross-roster OBSERVER aggregates (read-only, deterministic order over the
//! living Vec): wealth_gini / cohesion-lite / quiet-index helpers. The full Theory-of-Mind observer
//! metrics that need BELIEF FIELDS THIS SUBSTRATE LACKS are SKIPPED + noted at the bottom of this file
//! (suspicionClimate, esteemTruthGap, rumourDepth, presumedDead, … all read `belief.suspicion` /
//! `belief.hops` / `belief.believedWealth` / `belief.sentiment` — none exist on `PersonBelief` yet).
//!
//! DETERMINISM: every per-agent fn is an OWN-ROW read/write (no cross-agent dependency); the roster
//! aggregates iterate the dense Vec in id order (no HashMap iteration). EWMAs are f32 with the same
//! `g + (prev−g)·0.5^(dt/H)` half-life shape as the TS — deterministic, no transcendental beyond
//! `powf` (which is bit-stable on a given target, and these are observer telemetry, NOT in the
//! M-invariance hash path unless a caller folds them into a hashed column).

use crate::components::{
    Band, DeedTag, Faction, LossReason, LossStep, OathKind, OutcomeStatus, Signals, StreakKey,
    LOSS_RING,
};
use crate::world::World;

// ───────────────────────────── SIGNALS config (mirrors `SIGNALS` in simconfig.ts) ─────────────────────────────
// Tuning only — half-lives are ORDERINGS (fast ≈ Gazette cadence, slow ≈ 5×), not measurements.
pub const GOLD_HALF_FAST: f32 = 120.0;
pub const GOLD_HALF_SLOW: f32 = 600.0;
pub const LOSS_MIN: i64 = 1; // a gold step at/below this is noise — not ringed
pub const STAND_HALF_FAST: f32 = 120.0;
pub const STAND_HALF_SLOW: f32 = 600.0;
pub const REVERSAL_GATE: f32 = 15.0; // a (gold fast−slow) sign flip past this gap counts as a reversal
pub const DISP_HALF: f32 = 300.0;
pub const POOR_BAND: i64 = 8; // gold at/below this is the POVERTY band
pub const RICH_BAND: i64 = 120; // gold at/above this is the WEALTH band
pub const OUTLAW_BAND: u16 = 19660; // notoriety at/above this is the OUTLAW band (TS 0.3 of a 0..1 cue;
                                    // here notoriety is a u16 0..65535, so 0.3·65535 ≈ 19660)

/// The shared EWMA step: pull `prev` toward `target` over `dt` ticks with half-life `half`. Matches
/// the TS `target + (prev − target)·0.5^(dt/half)`. `dt` is clamped ≥ 0 by the u32 subtraction guard.
#[inline]
fn ewma(prev: f32, target: f32, dt: u32, half: f32) -> f32 {
    let h = if half > 0.0 { half } else { 1.0 };
    target + (prev - target) * 0.5f32.powf(dt as f32 / h)
}

#[inline]
fn dt_ticks(now: u32, last: u32) -> u32 {
    now.saturating_sub(last)
}

// ═══════════════════════════════ Family A: gold two-timescale EWMA ═══════════════════════════════

/// SAMPLE the gold EWMAs toward the agent's CURRENT gold (a time-anchored exponential average). Called
/// from the observer pass — a periodic sample, not a per-tick scan. Fast tracks recent fortune, slow the
/// long baseline; a sharp drop pulls fast below slow (the RUIN signal). Own-row write. (`sampleGold`.)
pub fn sample_gold(s: &mut Signals, gold: i64, now: u32) {
    let g = gold as f32;
    if !s.g_inited {
        s.g_fast = g;
        s.g_slow = g;
        s.g_t = now;
        s.g_inited = true;
        return;
    }
    let dt = dt_ticks(now, s.g_t);
    s.g_fast = ewma(s.g_fast, g, dt, GOLD_HALF_FAST);
    s.g_slow = ewma(s.g_slow, g, dt, GOLD_HALF_SLOW);
    s.g_t = now;
}

/// The gold TREND — (fast, slow). Falls back to current gold when never sampled. (`goldTrend`.)
pub fn gold_trend(s: &Signals, gold: i64) -> (f32, f32) {
    if s.g_inited {
        (s.g_fast, s.g_slow)
    } else {
        (gold as f32, gold as f32)
    }
}

// ═══════════════════════════════ Family A: tagged downward-gold ring ═══════════════════════════════

/// TAG a downward gold step with its REASON (robbed/fined = involuntary; spent/gifted = voluntary).
/// Folded at the conserved transfer sites (the resolver knows which verb moved the gold). Bounded ring
/// (oldest evicted when full). (`foldLoss`.)
pub fn fold_loss(s: &mut Signals, reason: LossReason, amount: i64, now: u32) {
    if amount <= LOSS_MIN {
        return;
    }
    let step = LossStep { reason: reason as u8, _pad: 0, _pad2: 0, t: now, amt: amount };
    if (s.loss_len as usize) < LOSS_RING {
        s.loss[s.loss_len as usize] = step;
        s.loss_len += 1;
    } else {
        // ring full: overwrite the oldest (head), advance head (FIFO eviction, matching the TS shift).
        s.loss[s.loss_head as usize] = step;
        s.loss_head = (s.loss_head + 1) % LOSS_RING as u8;
    }
}

/// The named-reason SHARE of recent losses, by gold amount, over a window of `window_ticks`. The RUIN
/// detector reads this so a voluntary spend-down never reads as catastrophe. (`lossReasonShare`.)
pub fn loss_reason_share(s: &Signals, reasons: &[LossReason], window_ticks: u32, now: u32) -> f32 {
    let mut named: i64 = 0;
    let mut total: i64 = 0;
    for k in 0..s.loss_len as usize {
        let l = &s.loss[k];
        if dt_ticks(now, l.t) > window_ticks {
            continue;
        }
        total += l.amt;
        if reasons.iter().any(|r| *r as u8 == l.reason) {
            named += l.amt;
        }
    }
    if total > 0 {
        named as f32 / total as f32
    } else {
        0.0
    }
}

// ═══════════════════════════════ Family A: standing EWMA + fortuneReversals ═══════════════════════════════

/// SAMPLE the two roster-mean-standing EWMAs toward `mean` (mirrors sample_gold). SAMPLED in the
/// observer pass (which already computes the mean). ALSO derives fortuneReversals HERE, in the same
/// sample, when a (gold fast−slow) sign flip past the gate is noticed (no separate scan). Own-row write.
/// (`sampleStanding`.)
pub fn sample_standing(s: &mut Signals, mean: f32, now: u32) {
    if !s.s_inited {
        s.s_fast = mean;
        s.s_slow = mean;
        s.s_t = now;
        s.s_inited = true;
        s.rev_n = 0;
        s.rev_t = 0;
        s.last_sign = 0;
    } else {
        let dt = dt_ticks(now, s.s_t);
        s.s_fast = ewma(s.s_fast, mean, dt, STAND_HALF_FAST);
        s.s_slow = ewma(s.s_slow, mean, dt, STAND_HALF_SLOW);
        s.s_t = now;
    }
    // fortuneReversals: count + last-t of (gold fast−slow) SIGN FLIPS past a magnitude gate.
    let gap = s.g_fast - s.g_slow;
    if gap.abs() >= REVERSAL_GATE {
        let sign: i8 = if gap > 0.0 { 1 } else { -1 };
        if s.last_sign != 0 && sign != s.last_sign {
            s.rev_n += 1;
            s.rev_t = now;
        }
        s.last_sign = sign;
    }
}

/// The standing TREND — (fast, slow). Zeros until first sampled. (`standingTrend`.)
pub fn standing_trend(s: &Signals) -> (f32, f32) {
    if s.s_inited {
        (s.s_fast, s.s_slow)
    } else {
        (0.0, 0.0)
    }
}

/// (count, last-at) of fortune reversals. (`fortuneReversals`.)
pub fn fortune_reversals(s: &Signals) -> (u32, u32) {
    (s.rev_n, s.rev_t)
}

// ═══════════════════════════════ Family A: displacement EWMA ═══════════════════════════════

/// SAMPLE an EWMA of distance from the agent's believed home/bed (`home_x`/`home_z` passed by the
/// caller — the own-state truth, observer-read). Exile detection (high displacement + low standing);
/// the wanderer; homecoming beats. (`sampleDisplacement`.)
pub fn sample_displacement(s: &mut Signals, pos: [f32; 2], home: [f32; 2], now: u32) {
    let dx = home[0] - pos[0];
    let dz = home[1] - pos[1];
    let d = (dx * dx + dz * dz).sqrt();
    if !s.disp_inited {
        s.disp = d;
        s.disp_t = now;
        s.disp_inited = true;
        return;
    }
    let dt = dt_ticks(now, s.disp_t);
    s.disp = ewma(s.disp, d, dt, DISP_HALF);
    s.disp_t = now;
}

/// The displacement EWMA. (`displacement`.)
pub fn displacement(s: &Signals) -> f32 {
    s.disp
}

// ═══════════════════════════════ Family A: timeInBand ═══════════════════════════════

/// ACCRUE sim-time spent in a poverty / wealth / outlaw band (endurance stories need DURATION, not
/// crossings). Accumulated in the observer pass off the agent's OWN gold/notoriety band — the band edges
/// checked at the same sample (no separate scan). (`accrueBand`.)
pub fn accrue_band(s: &mut Signals, gold: i64, notoriety: u16, now: u32) {
    let dt = if s.band_inited { dt_ticks(now, s.band_t) } else { 0 };
    s.band_t = now;
    s.band_inited = true;
    let dtf = dt as f32;
    if gold <= POOR_BAND {
        s.band[Band::Poor as usize] += dtf;
    } else if gold >= RICH_BAND {
        s.band[Band::Rich as usize] += dtf;
    }
    if notoriety >= OUTLAW_BAND {
        s.band[Band::Outlaw as usize] += dtf;
    }
}

/// The accrued sim-time in a band. (`timeInBand`.)
pub fn time_in_band(s: &Signals, band: Band) -> f32 {
    s.band[band as usize]
}

// ═══════════════════════════════ Family E: deed tally ═══════════════════════════════

/// FOLD a deed of `tag` at `now` — count + first/last sim-time. The TRUTH side of witnessDeed / the
/// combat fold. (`foldDeed`.)
pub fn fold_deed(s: &mut Signals, tag: DeedTag, now: u32) {
    let d = &mut s.deeds[tag as usize];
    if d.n == 0 {
        d.first = now;
    }
    d.n += 1;
    d.last = now;
}

/// How many deeds of `tag`. (`deedCount`.)
pub fn deed_count(s: &Signals, tag: DeedTag) -> u32 {
    s.deeds[tag as usize].n
}

/// The sim-time of the FIRST deed of a kind (corruption measured from firstTheft onward), or None if
/// never. (`firstDeedAt`.)
pub fn first_deed_at(s: &Signals, tag: DeedTag) -> Option<u32> {
    let d = &s.deeds[tag as usize];
    if d.n > 0 {
        Some(d.first)
    } else {
        None
    }
}

// ═══════════════════════════════ Family E: oath tally ═══════════════════════════════

/// SWEAR an oath of `kind` (a narrative-weight goal pushed). (`foldOathSworn`.)
pub fn fold_oath_sworn(s: &mut Signals, kind: OathKind) {
    s.oaths[kind as usize].sworn = s.oaths[kind as usize].sworn.saturating_add(1);
}

/// POP an oath of `kind`, recording WHY: kept (satisfied) vs abandoned (expired/unreachable). "a man of
/// his word" measured. (`foldOathPop`.)
pub fn fold_oath_pop(s: &mut Signals, kind: OathKind, kept: bool) {
    let o = &mut s.oaths[kind as usize];
    if kept {
        o.kept = o.kept.saturating_add(1);
    } else {
        o.abandoned = o.abandoned.saturating_add(1);
    }
}

/// (sworn, kept, abandoned) for an oath kind. (`oaths`.)
pub fn oath_tally(s: &Signals, kind: OathKind) -> (u16, u16, u16) {
    let o = &s.oaths[kind as usize];
    (o.sworn, o.kept, o.abandoned)
}

// ═══════════════════════════════ Family A: streak + peril ═══════════════════════════════

/// FOLD a watched-act outcome onto a strategy's streak: a consecutive same-status run grows, a change
/// resets to 1 ("third failed heist in a row"). Folded on PLAN_OUTCOME. (`foldStreak`.)
pub fn fold_streak(s: &mut Signals, key: StreakKey, status: OutcomeStatus) {
    let st = &mut s.streak[key as usize];
    if st.status == status as u8 {
        st.run = st.run.saturating_add(1);
    } else {
        st.run = 1;
        st.status = status as u8;
    }
}

/// (status, run) for a watched strategy. (`streakOf`.)
pub fn streak_of(s: &Signals, key: StreakKey) -> (OutcomeStatus, u16) {
    let st = &s.streak[key as usize];
    let status = match st.status {
        1 => OutcomeStatus::Ok,
        2 => OutcomeStatus::Fail,
        3 => OutcomeStatus::Wasteful,
        4 => OutcomeStatus::Peril,
        _ => OutcomeStatus::None,
    };
    (status, st.run)
}

/// COUNT a peril outcome (a veteran of near-misses). Folded on a peril PLAN_OUTCOME. (`foldPeril`.)
pub fn fold_peril(s: &mut Signals) {
    s.perils = s.perils.saturating_add(1);
}

/// How many perils survived. (`perilsSurvived`.)
pub fn perils_survived(s: &Signals) -> u32 {
    s.perils
}

// ═══════════════════════════════ cross-roster OBSERVER aggregates (read-only, deterministic order) ═══════════════════════════════
//
// These walk the dense columns in id order (no HashMap iteration ⇒ deterministic). They read TRUTH
// (the observer layer's privilege) and drive no agent decision (the epistemic split holds). Only the
// ones whose inputs EXIST on this substrate are ported; the belief-field ones are skipped (see bottom).

/// wealthGini — gold concentration 0..1 across living townsfolk (0 = perfectly equal, →1 = one purse
/// holds it all). The classic Gini over the sorted gold vector. Observer-only. (`wealthGini`.)
pub fn wealth_gini(w: &World) -> f32 {
    let mut gs: Vec<i64> = Vec::new();
    for i in 0..w.n {
        if w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 {
            gs.push(w.econ[i].gold.max(0));
        }
    }
    let n = gs.len();
    if n < 2 {
        return 0.0;
    }
    gs.sort_unstable();
    let total: i64 = gs.iter().sum();
    if total <= 0 {
        return 0.0;
    }
    // Gini = 1 − (2·area)/(n·total), area = Σ (cum − g/2) with cum the running prefix sum.
    let mut cum: f64 = 0.0;
    let mut area: f64 = 0.0;
    for &g in &gs {
        cum += g as f64;
        area += cum - (g as f64) / 2.0;
    }
    let gini = 1.0 - (2.0 * area) / (n as f64 * total as f64);
    gini.clamp(0.0, 1.0) as f32
}

/// cohesion — the town's mean IN-TOWN belief-standing vs its mean standing toward OUTSIDERS (non-town,
/// non-monster). Returns (in_town, outsider, split). Factionalisation when the split widens. Reads the
/// belief tables in id order (the standing field DOES exist on PersonBelief). Observer-only. (`cohesion`.)
pub fn cohesion(w: &World) -> (f32, f32, f32) {
    let mut in_sum: i64 = 0;
    let mut in_n: i64 = 0;
    let mut out_sum: i64 = 0;
    let mut out_n: i64 = 0;
    for i in 0..w.n {
        if !w.alive[i] || w.faction[i] != Faction::Townsfolk as u8 {
            continue;
        }
        let bt = &w.beliefs[i];
        for k in 0..bt.len as usize {
            let b = &bt.bodies[k];
            let subj = b.subject as usize;
            if subj >= w.n {
                continue;
            }
            let sf = w.faction[subj];
            if sf == Faction::Townsfolk as u8 {
                in_sum += b.standing as i64;
                in_n += 1;
            } else if sf != Faction::Monster as u8 {
                out_sum += b.standing as i64;
                out_n += 1;
            }
        }
    }
    let in_town = if in_n > 0 { in_sum as f32 / in_n as f32 } else { 0.0 };
    let outsider = if out_n > 0 { out_sum as f32 / out_n as f32 } else { 0.0 };
    (in_town, outsider, in_town - outsider)
}

// ═══════════════════════════════ SKIPPED — need belief fields this substrate LACKS ═══════════════════════════════
//
// These TS signals read belief fields that `components::PersonBelief` does NOT carry yet. Ported here
// would require adding columns the rest of the sim doesn't populate — out of scope for this module:
//   · suspicionClimate / misallocatedSuspicion  — need `belief.suspicion` (no suspicion field)
//   · esteemTruthGap                              — needs `belief.believedWealth` (only `wealth` cue exists,
//                                                    but the TS gap is vs `believedWealth` + roster sentiment)
//   · rumourDepth                                 — needs `belief.hops` (provenance chain length — absent)
//   · presumedDead / loversCrossed                — read `belief.confidence` (EXISTS) but key on a courting
//                                                    relationship / animacy the substrate doesn't model
//   · regardGap / dependence                      — pairwise standing reads (could be ported, but they are
//                                                    pure roster reads with no per-agent fold; deferred)
//   · grievance / scarcity / peaceClock / witnessSet / quietIndex / triangleHints / arcLoad
//                                                 — sim-level sparse Maps (saga registry / per-good price
//                                                    EWMA / chronicle last-beat map) with no Wave-1 column.
// The GOAL-DWELL accumulator (foldGoalDwell / goalDwellOf) is likewise deferred: it folds on decide()'s
// goal-commit seam, which the Rust `decide` system owns — a cleaner home than this read-library.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::Signals;

    /// An EWMA TRACKS: a rising gold pulls fast above slow, a crash pulls fast below slow (the RUIN
    /// signal), and both converge toward a held value.
    #[test]
    fn gold_ewma_tracks() {
        let mut s = Signals::default();
        // first sample seeds both EWMAs to the current value.
        sample_gold(&mut s, 100, 0);
        let (f0, sl0) = gold_trend(&s, 100);
        assert_eq!(f0, 100.0);
        assert_eq!(sl0, 100.0);

        // a sudden windfall: fast reacts faster than slow ⇒ fast > slow.
        sample_gold(&mut s, 1000, 200);
        let (f1, sl1) = gold_trend(&s, 1000);
        assert!(f1 > sl1, "windfall: fast {f1} should lead slow {sl1}");
        assert!(f1 > 100.0 && f1 < 1000.0, "fast moved partway: {f1}");

        // hold the new value long enough: both converge upward toward it.
        for t in (400..6000).step_by(200) {
            sample_gold(&mut s, 1000, t);
        }
        let (f2, sl2) = gold_trend(&s, 1000);
        assert!(f2 > 990.0 && sl2 > 900.0, "converged toward 1000: fast {f2} slow {sl2}");

        // a crash: fast falls below slow — the RUIN signal.
        sample_gold(&mut s, 0, 6100);
        let (f3, sl3) = gold_trend(&s, 0);
        assert!(f3 < sl3, "crash: fast {f3} should fall below slow {sl3}");
    }

    /// A tally COUNTS: deeds accumulate, first/last timestamps stick, and the loss ring tags + bounds.
    #[test]
    fn tallies_count() {
        let mut s = Signals::default();
        assert_eq!(deed_count(&s, DeedTag::Theft), 0);
        assert_eq!(first_deed_at(&s, DeedTag::Theft), None);

        fold_deed(&mut s, DeedTag::Theft, 50);
        fold_deed(&mut s, DeedTag::Theft, 70);
        fold_deed(&mut s, DeedTag::Kill, 90);
        assert_eq!(deed_count(&s, DeedTag::Theft), 2, "two thefts");
        assert_eq!(deed_count(&s, DeedTag::Kill), 1, "one kill");
        assert_eq!(first_deed_at(&s, DeedTag::Theft), Some(50), "first theft sticks");

        // oaths: sworn vs kept vs abandoned.
        fold_oath_sworn(&mut s, OathKind::Avenge);
        fold_oath_sworn(&mut s, OathKind::Avenge);
        fold_oath_pop(&mut s, OathKind::Avenge, true);
        let (sw, kept, ab) = oath_tally(&s, OathKind::Avenge);
        assert_eq!((sw, kept, ab), (2, 1, 0), "two sworn, one kept");

        // streak: a run grows, a status change resets.
        fold_streak(&mut s, StreakKey::Heist, OutcomeStatus::Fail);
        fold_streak(&mut s, StreakKey::Heist, OutcomeStatus::Fail);
        fold_streak(&mut s, StreakKey::Heist, OutcomeStatus::Fail);
        let (st, run) = streak_of(&s, StreakKey::Heist);
        assert!(matches!(st, OutcomeStatus::Fail) && run == 3, "third failed heist in a row");
        fold_streak(&mut s, StreakKey::Heist, OutcomeStatus::Ok);
        let (_, run2) = streak_of(&s, StreakKey::Heist);
        assert_eq!(run2, 1, "a success resets the run");

        // peril count.
        fold_peril(&mut s);
        fold_peril(&mut s);
        assert_eq!(perils_survived(&s), 2);
    }

    /// The loss ring TAGS and bounds: the involuntary share is read over a window, and the ring never
    /// grows past LOSS_RING (oldest evicted).
    #[test]
    fn loss_ring_tags_and_bounds() {
        let mut s = Signals::default();
        // a noise step (≤ LOSS_MIN) is not ringed.
        fold_loss(&mut s, LossReason::Spent, 1, 0);
        assert_eq!(s.loss_len, 0, "noise step ignored");

        fold_loss(&mut s, LossReason::Spent, 100, 10); // voluntary
        fold_loss(&mut s, LossReason::Robbed, 300, 20); // involuntary
        // involuntary share by amount: 300 / 400 = 0.75 over a wide window.
        let share = loss_reason_share(&s, &[LossReason::Robbed, LossReason::Fined], 1000, 30);
        assert!((share - 0.75).abs() < 1e-4, "involuntary share 0.75, got {share}");

        // window excludes the old voluntary step (t=10): only the robbery (t=20) is in [25,30] → 1.0.
        let recent = loss_reason_share(&s, &[LossReason::Robbed], 5, 25);
        assert!((recent - 1.0).abs() < 1e-4, "recent window all-robbed, got {recent}");

        // overflow the ring: it stays bounded at LOSS_RING.
        for t in 0..20u32 {
            fold_loss(&mut s, LossReason::Spent, 50, 100 + t);
        }
        assert_eq!(s.loss_len as usize, LOSS_RING, "ring bounded at LOSS_RING");
    }

    /// Standing EWMA tracks AND derives fortune reversals from gold fast−slow sign flips.
    #[test]
    fn standing_and_reversals() {
        let mut s = Signals::default();
        sample_standing(&mut s, 0.5, 0);
        let (f, sl) = standing_trend(&s);
        assert_eq!((f, sl), (0.5, 0.5), "seeded to mean");

        // drive a gold reversal: up (fast>slow) then a crash (fast<slow) past the gate.
        sample_gold(&mut s, 1000, 0);
        sample_gold(&mut s, 1000, 1000); // converge so fast≈slow≈1000, gap small
        for t in (1000..8000).step_by(500) {
            sample_gold(&mut s, 1000, t);
        }
        sample_standing(&mut s, 0.5, 8000); // gap ~0, may set a sign but no flip yet
        sample_gold(&mut s, 0, 8100); // crash → fast << slow
        sample_standing(&mut s, 0.5, 8100); // notices a negative gap
        sample_gold(&mut s, 5000, 8200); // surge → fast >> slow (a flip)
        sample_standing(&mut s, 0.5, 8200);
        let (n, _) = fortune_reversals(&s);
        assert!(n >= 1, "a fortune reversal was counted, got {n}");
    }

    /// Displacement and band time accrue over sampled intervals.
    #[test]
    fn displacement_and_band() {
        let mut s = Signals::default();
        // at home: displacement 0.
        sample_displacement(&mut s, [0.0, 0.0], [0.0, 0.0], 0);
        assert_eq!(displacement(&s), 0.0);
        // far from home repeatedly: the EWMA climbs toward the distance (3-4-5 = 5).
        for t in (300..6000).step_by(300) {
            sample_displacement(&mut s, [3.0, 4.0], [0.0, 0.0], t);
        }
        assert!(displacement(&s) > 4.5, "displacement climbed toward 5, got {}", displacement(&s));

        // band time: a poor agent accrues poverty-band seconds.
        accrue_band(&mut s, 5, 0, 0); // first sample arms (dt=0)
        accrue_band(&mut s, 5, 0, 100); // 100 ticks poor
        accrue_band(&mut s, 5, 0, 250); // +150 ticks poor
        assert_eq!(time_in_band(&s, Band::Poor), 250.0, "250 ticks in poverty");
        assert_eq!(time_in_band(&s, Band::Rich), 0.0);
    }
}
