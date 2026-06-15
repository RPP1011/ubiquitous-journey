//! FAN-OUT UNIT: progression. Ports the SPIRIT of `js/rpg/progression.js` + `js/rpg/classes.js`
//! (deeds → weighted behavior_profile → emergent classes + levels) onto the Rust SoA world.
//!
//! WHAT THIS DOES (own-write per actor; deterministic):
//! - `fold_deed` accumulates a drained `Intent::Deed` (verb tag-index + magnitude) into the actor's
//!   `behavior_profile`, magnitude-scaled and per-tag clamped. It is called from `World::drain_intents`
//!   in the DETERMINISTIC SERIAL MERGE (the deeds are already visited there in fixed sort order, and
//!   each fold is a pure own-write to a single actor's column ⇒ order-independent ⇒ deterministic).
//! - `tick` runs once per tick AFTER the merge: per agent (parallel, own-write only) it DECAYS the
//!   profile, then periodically MATCHES it against a few class templates to grant emergent classes,
//!   and ROUTES XP from accumulated behaviour into `total_level`.
//!
//! COORDINATION NOTE (the schedule/drain question in the unit brief): `drain_intents` clears the
//! intent queue, so a post-drain progression phase can't read the deeds. Rather than touch the
//! schedule or stash a scratch tally, we fold each deed into its actor's own column INSIDE the merge
//! (where it's already iterated deterministically). `tick` then only needs the per-agent state — no
//! deed list. This keeps the schedule in `world.rs` byte-identical (no reorder) and the fold trivially
//! deterministic.
//!
//! DETERMINISM: per-actor own-write; no rayon float-reduce / HashMap in behaviour paths; the matcher's
//! template scan is a fixed-order loop. No randomness (progression doesn't draw from `rng[i]`).

use rayon::prelude::*;

use crate::components::{Progression, N_TAGS};
use crate::world::World;

// ── tag indices (the closed `types/events.ts` Tag vocabulary, in declaration order = N_TAGS) ──
// A deed's `verb` byte indexes straight into `behavior_profile` (the Rust port has no Tag enum;
// the producing system tags a deed with the tag-index it exercises). Named here for the templates.
pub const TAG_MELEE: u8 = 0;
pub const TAG_DEFENSE: u8 = 1;
pub const TAG_KILL: u8 = 2;
pub const TAG_RISK: u8 = 3;
#[allow(dead_code)]
pub const TAG_BERSERK: u8 = 4;
#[allow(dead_code)]
pub const TAG_DUEL: u8 = 5;
pub const TAG_SMITHING: u8 = 6;
pub const TAG_CRAFTING: u8 = 7;
#[allow(dead_code)]
pub const TAG_TOOLMAKING: u8 = 8;
pub const TAG_BUILD: u8 = 9;
pub const TAG_FARMING: u8 = 10;
pub const TAG_MINING: u8 = 11;
pub const TAG_WOODCUT: u8 = 12;
#[allow(dead_code)]
pub const TAG_FORAGE: u8 = 13;
pub const TAG_TRADE: u8 = 14;
pub const TAG_PROFIT: u8 = 15;
#[allow(dead_code)]
pub const TAG_HAGGLE: u8 = 16;
#[allow(dead_code)]
pub const TAG_BARTER: u8 = 17;
pub const TAG_PERSUADE: u8 = 18;
#[allow(dead_code)]
pub const TAG_GOSSIP: u8 = 19;
pub const TAG_ENDURANCE: u8 = 23;
pub const TAG_EXPLORE: u8 = 24;

// ── tuning (mirrors `RPG.*`; kept inline as Wave-1 has no rpgconfig column) ──
const PROFILE_MAX: f32 = 100.0; // RPG.profileMax — per-tag tally clamp.
const PROFILE_DECAY: f32 = 0.999; // slow per-tick forgetting (RPG.profileDecayPerSec analogue).
const MATCH_INTERVAL: u32 = 8; // run the heavy matcher every N ticks (RPG.matchIntervalSec analogue).
const BEHAVIOR_SUM_GATE: f32 = 4.0; // need this much total behaviour before matching (RPG.behaviorSumGate).
const TOTAL_LEVEL_CAP: u16 = 140; // RPG.totalLevelCap.
const XP_PER_LEVEL: u32 = 1000; // banked-XP (×1000 fixed-point) needed per level.

/// A class template: a representative requirement tag+threshold (ALL-of in JS; we keep the single
/// dominant one — the Wave-1 core subset) and a small score profile used both to gate the grant and
/// to weight XP routing. `key` is the held-class id (stored in `Progression.classes`).
struct ClassTemplate {
    key: u8,
    req_tag: u8,
    req_thresh: f32,
    /// (tag, weight) score pairs — the weighted dot that decides match strength.
    score: &'static [(u8, f32)],
}

/// The class catalogue (the Wave-1 subset of `js/rpg/classes.js` CLASS_TEMPLATES). Stable order ⇒
/// deterministic grant priority. Keys are small ints (0..) used as held-class ids.
const TEMPLATES: &[ClassTemplate] = &[
    ClassTemplate { key: 0, req_tag: TAG_MELEE, req_thresh: 6.0,
        score: &[(TAG_MELEE, 1.0), (TAG_KILL, 0.8), (TAG_DEFENSE, 0.4), (TAG_RISK, 0.3)] }, // warrior
    ClassTemplate { key: 1, req_tag: TAG_FARMING, req_thresh: 6.0,
        score: &[(TAG_FARMING, 1.0), (TAG_ENDURANCE, 0.3)] }, // farmer
    ClassTemplate { key: 2, req_tag: TAG_MINING, req_thresh: 6.0,
        score: &[(TAG_MINING, 1.0), (TAG_ENDURANCE, 0.4)] }, // miner
    ClassTemplate { key: 3, req_tag: TAG_WOODCUT, req_thresh: 6.0,
        score: &[(TAG_WOODCUT, 1.0), (TAG_ENDURANCE, 0.3)] }, // woodcutter
    ClassTemplate { key: 4, req_tag: TAG_SMITHING, req_thresh: 5.0,
        score: &[(TAG_SMITHING, 1.0), (TAG_CRAFTING, 0.7)] }, // blacksmith
    ClassTemplate { key: 5, req_tag: TAG_TRADE, req_thresh: 10.0,
        score: &[(TAG_TRADE, 1.0), (TAG_PROFIT, 0.9)] }, // merchant
    ClassTemplate { key: 6, req_tag: TAG_BUILD, req_thresh: 5.0,
        score: &[(TAG_BUILD, 1.0), (TAG_CRAFTING, 0.6), (TAG_ENDURANCE, 0.4)] }, // mason
    ClassTemplate { key: 7, req_tag: TAG_PERSUADE, req_thresh: 4.0,
        score: &[(TAG_PERSUADE, 1.0)] }, // speaker
    ClassTemplate { key: 8, req_tag: TAG_EXPLORE, req_thresh: 4.0,
        score: &[(TAG_EXPLORE, 0.8), (TAG_KILL, 0.8), (TAG_MELEE, 0.5)] }, // hunter
    ClassTemplate { key: 9, req_tag: TAG_ENDURANCE, req_thresh: 5.0,
        score: &[(TAG_ENDURANCE, 1.0), (TAG_EXPLORE, 0.5)] }, // survivor
];

/// Fold one deed into the actor's behaviour profile: add `magnitude` weight to `behavior_profile[verb]`,
/// clamped to `PROFILE_MAX`. Out-of-range verb tags are ignored (defensive — a deed may carry a
/// flavour verb outside the closed tag vocabulary). Pure own-write ⇒ deterministic regardless of the
/// order deeds are merged in.
#[inline]
pub fn fold_deed(prog: &mut Progression, verb: u8, magnitude: u16) {
    let t = verb as usize;
    if t >= N_TAGS {
        return;
    }
    let w = magnitude.max(1) as f32;
    prog.behavior_profile[t] = (prog.behavior_profile[t] + w).min(PROFILE_MAX);
}

/// Total behaviour weight carried (the cheap "done enough of anything?" gate).
#[inline]
fn behavior_sum(p: &[f32; N_TAGS]) -> f32 {
    let mut s = 0.0;
    for &v in p.iter() {
        s += v;
    }
    s
}

/// Weighted dot(profile, template.score) — the raw match strength (kept linear; JS runs it through a
/// sigmoid, but for grant-gating + routing a monotone linear score preserves the ordering and stays
/// branch-free + deterministic).
#[inline]
fn match_score(p: &[f32; N_TAGS], t: &ClassTemplate) -> f32 {
    let mut dot = 0.0;
    for &(tag, w) in t.score {
        dot += p[tag as usize] * w;
    }
    dot
}

/// Per-tick progression for every agent: parallel own-write only (each agent touches ONLY its own
/// `progression[i]`), so the phase is bit-identical across rayon core counts.
pub fn tick(world: &mut World) {
    let interval_due = world.tick % MATCH_INTERVAL == 0;
    world.progression.par_iter_mut().for_each(|prog| {
        // 1) slow forgetting so stale identities fade (keeps the profile responsive).
        for v in prog.behavior_profile.iter_mut() {
            *v *= PROFILE_DECAY;
            if *v < 0.01 {
                *v = 0.0;
            }
        }

        // 2) periodic matcher: grant newly-qualifying classes + route XP into levels.
        if interval_due {
            run_matcher(prog);
        }
    });
}

/// Grant qualifying classes (fixed-order template scan, respecting the held-class cap) and route XP
/// from accumulated behaviour into `total_level`. Own-write only.
fn run_matcher(prog: &mut Progression) {
    let sum = behavior_sum(&prog.behavior_profile);
    if sum <= BEHAVIOR_SUM_GATE {
        return;
    }

    // GRANT: walk the catalogue in stable order; grant any template whose requirement is met and
    // whose match score clears the gate, until the held-class array is full.
    for t in TEMPLATES {
        if (prog.n_classes as usize) >= prog.classes.len() {
            break;
        }
        if prog.holds(t.key) {
            continue;
        }
        if prog.behavior_profile[t.req_tag as usize] < t.req_thresh {
            continue;
        }
        if match_score(&prog.behavior_profile, t) < t.req_thresh {
            continue;
        }
        let slot = prog.n_classes as usize;
        prog.classes[slot] = t.key;
        prog.n_classes += 1;
    }

    // ROUTE XP: if the agent holds any class, the strength of its single best-matching template
    // (deterministic argmax over the fixed catalogue order) earns banked XP this interval, which
    // resolves into levels against a flat curve. No class yet ⇒ XP defers (the profile already
    // recorded the deeds; a future interval grants a class and starts levelling). Capped.
    if prog.n_classes == 0 || prog.total_level >= TOTAL_LEVEL_CAP {
        return;
    }
    let mut best = 0.0f32;
    for &key in &prog.classes[..prog.n_classes as usize] {
        if let Some(t) = TEMPLATES.iter().find(|t| t.key == key) {
            let s = match_score(&prog.behavior_profile, t);
            if s > best {
                best = s;
            }
        }
    }
    // XP gain ∝ best match strength (×100 → integer ⇒ deterministic, no float banking).
    let gain = (best * 100.0) as u32;
    prog.xp += gain;
    while prog.xp >= XP_PER_LEVEL && prog.total_level < TOTAL_LEVEL_CAP {
        prog.xp -= XP_PER_LEVEL;
        prog.total_level += 1;
    }
    if prog.total_level >= TOTAL_LEVEL_CAP {
        prog.xp = 0; // capped: stop banking (mirrors JS).
    }
    // grant any class-tier ability milestones the new level unlocks (the JS CLASS_MILESTONES grant;
    // pure own-write on the `abilities` column — the autocaster reads it next tick).
    crate::abilities::grant_milestones(prog);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::Intent;
    use crate::world::World;

    /// `fold_deed` accumulates magnitude into the right tag and clamps at PROFILE_MAX.
    #[test]
    fn fold_deed_accumulates_and_clamps() {
        let mut p = Progression::default();
        fold_deed(&mut p, TAG_MELEE, 3);
        fold_deed(&mut p, TAG_MELEE, 2);
        assert_eq!(p.behavior_profile[TAG_MELEE as usize], 5.0);
        // out-of-range verb is ignored.
        fold_deed(&mut p, 200, 5);
        assert_eq!(behavior_sum(&p.behavior_profile), 5.0);
        // clamps at PROFILE_MAX.
        fold_deed(&mut p, TAG_MELEE, u16::MAX);
        assert_eq!(p.behavior_profile[TAG_MELEE as usize], PROFILE_MAX);
    }

    /// A run of MELEE deeds folded through the real merge + tick grants [Warrior] and levels it.
    #[test]
    fn melee_deeds_grant_class_and_level() {
        let mut w = World::spawn(0xC0FFEE, 4);
        // hammer agent 0 with melee deeds across several ticks, going through the real schedule.
        for _ in 0..40 {
            for _ in 0..3 {
                w.intents.push(Intent::Deed { actor: 0, verb: TAG_MELEE, magnitude: 4, target: 1 });
                w.intents.push(Intent::Deed { actor: 0, verb: TAG_KILL, magnitude: 2, target: 1 });
            }
            w.tick();
        }
        let p = &w.progression[0];
        assert!(p.behavior_profile[TAG_MELEE as usize] > 6.0, "profile should record the melee work");
        assert!(p.holds(0), "agent should have been granted [Warrior] (key 0)");
        assert!(p.total_level > 0, "warrior should have levelled from routed XP");
    }

    /// Determinism: folding the same deeds in two different push orders yields the same profile
    /// (own-write per actor ⇒ order-independent).
    #[test]
    fn fold_is_order_independent() {
        let mut a = Progression::default();
        let mut b = Progression::default();
        fold_deed(&mut a, TAG_FARMING, 3);
        fold_deed(&mut a, TAG_TRADE, 1);
        fold_deed(&mut a, TAG_FARMING, 2);
        fold_deed(&mut b, TAG_FARMING, 2);
        fold_deed(&mut b, TAG_TRADE, 1);
        fold_deed(&mut b, TAG_FARMING, 3);
        assert_eq!(a.behavior_profile, b.behavior_profile);
    }
}
