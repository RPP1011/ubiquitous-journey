//! FAN-OUT UNIT: houses — dynastic feuds + emergent epithet branding. Ports the SPIRIT of
//! `js/sim/houses.js` (the house-feud Set + the oathbreaker/epithet brand). HELPERS-ONLY — there is no
//! per-tick behaviour in `houses.js` (it's a vocabulary both `Simulation` (founders) and `Lineage`
//! (births) call), so this module adds NO society_phase call: just free functions + the world
//! `house_feuds` Vec + the `epithet` column they maintain.
//!
//! WHAT WE PORT (the load-bearing, headless-scoped half):
//! - HOUSE FEUDS — a durable feud between two HOUSES (not two people): children born into a feuding
//!   house inherit the grudge (lineage queries `feuding_house_of`), and the strife outlives its
//!   founders until something heals it. TS stores a `Set` of canonical "A|B" string keys; the SoA
//!   analogue is `world.house_feuds: Vec<(u32,u32)>` of canonical lo<hi NUMERIC house-id pairs
//!   (`assignHouse`'s string surname → the existing numeric `world.house` id). Membership is a linear
//!   scan of a small Vec (kept deduped) — no `HashSet` iteration (determinism: no float/hash-order in a
//!   behaviour path). Every helper keeps the pair canonical so `(A,B)` and `(B,A)` are one feud.
//! - EPITHET BRAND — the emergent dynastic title (`brandForsworn` + the hero/villain/survivor brand the
//!   combat/society layers earn). Writes `world.epithet[i]` IDEMPOTENTLY: a soul already named (epithet
//!   != 0) is never re-branded (an earned hero/villain title is never clobbered), mirroring the TS
//!   `if (a.epithet) return null` guard. The brand logs an observer Beat (the news the title rides on).
//!
//! WHAT WE SKIP (doc 22 §9 — port the SPIRIT, not the letter): the STRING/DISPLAY-NAME composition
//! (`assignHouse`/`founderHouse`/the surname pool + "Aldric Vael the Bold" name folding) is render-only
//! and OUT OF HEADLESS SCOPE — names are strings in TS, modelled here as the numeric `world.house` id
//! and the numeric `world.epithet` code. The chronicle text is generated later from the Beat.
//!
//! Determinism: all helpers are pure own-/world-state edits with NO rng and NO hash iteration; the feud
//! Vec is scanned/maintained in insertion order with canonical pairs. Called from SERIAL phases
//! (lineage births, an observer brand) ⇒ trivially M-invariant. No gold, no spawn.

use crate::components::Beat;
use crate::world::World;

/// Interned `Beat.kind` for an epithet brand (the observer feed; render-only text generated later).
/// Distinct from chronicle's DEATH=0 / CLASSUP=1 and director's RAID=2 / lineage's BIRTH=3.
pub const KIND_EPITHET: u8 = 20;

// ── epithet codes (mirror the `world.epithet` column doc: 0 none / 1 hero / 2 villain / 3 survivor) ──
pub const EPITHET_NONE: u8 = 0;
pub const EPITHET_HERO: u8 = 1;
pub const EPITHET_VILLAIN: u8 = 2;
pub const EPITHET_SURVIVOR: u8 = 3;

/// Default oathbreaker threshold (`HOUSES.forswornBrandAt` — break ≥3 sworn words to earn the dark
/// title). A breaker of sworn words is branded a VILLAIN (the negative dynastic counterpart to "the Bold").
pub const FORSWORN_BRAND_AT: u32 = 3;

/// Canonical (lo, hi) ordering of a house pair so `(A,B)` and `(B,A)` are the same feud — the numeric
/// analogue of TS `houseFeudKey`'s `h1 < h2 ? "h1|h2" : "h2|h1"`.
#[inline]
fn canon(h1: u32, h2: u32) -> (u32, u32) {
    if h1 <= h2 {
        (h1, h2)
    } else {
        (h2, h1)
    }
}

/// A feud needs two REAL houses (house 0 is the "no house" sentinel), and a house never feuds itself
/// (mirrors the TS `h1 && h2 && h1 !== h2` gate).
#[inline]
fn valid_pair(h1: u32, h2: u32) -> bool {
    h1 != 0 && h2 != 0 && h1 != h2
}

/// Are houses `h1` and `h2` currently at feud? (linear scan of the small `house_feuds` Vec — no hash
/// iteration). The SoA analogue of TS `areHousesFeuding`.
pub fn are_houses_feuding(world: &World, h1: u32, h2: u32) -> bool {
    if !valid_pair(h1, h2) {
        return false;
    }
    let key = canon(h1, h2);
    world.house_feuds.iter().any(|&p| p == key)
}

/// Open a durable feud between two houses (idempotent — re-arming an existing feud is a no-op). Returns
/// true iff a NEW feud was recorded. Mirrors TS `setHouseFeud` (Set.add of the canonical key).
pub fn set_house_feud(world: &mut World, h1: u32, h2: u32) -> bool {
    if !valid_pair(h1, h2) {
        return false;
    }
    let key = canon(h1, h2);
    if world.house_feuds.iter().any(|&p| p == key) {
        return false; // already feuding — dedup (a Set never holds duplicates)
    }
    world.house_feuds.push(key);
    true
}

/// Heal a feud between two houses (e.g. a cross-house marriage). Returns true iff a feud was removed.
/// Mirrors TS `endHouseFeud` (Set.delete). Removed by `position`+`remove` (membership is set semantics,
/// never positional, so any reader is order-independent; the canonical pairs keep it deterministic).
pub fn end_house_feud(world: &mut World, h1: u32, h2: u32) -> bool {
    if !valid_pair(h1, h2) {
        return false;
    }
    let key = canon(h1, h2);
    if let Some(idx) = world.house_feuds.iter().position(|&p| p == key) {
        world.house_feuds.remove(idx);
        true
    } else {
        false
    }
}

/// One house that `house` is at feud with (or `None`) — so a child born into the house can INHERIT the
/// grudge. Returns the FIRST feuding partner in insertion order (deterministic). Mirrors TS
/// `feudingHouseOf` (the linear scan that splits the "A|B" key).
pub fn feuding_house_of(world: &World, house: u32) -> Option<u32> {
    if house == 0 {
        return None;
    }
    for &(a, b) in &world.house_feuds {
        if a == house {
            return Some(b);
        }
        if b == house {
            return Some(a);
        }
    }
    None
}

/// Brand agent `i` with an emergent epithet, IDEMPOTENTLY: an already-named soul (epithet != 0) is
/// never re-branded — an earned hero/villain title is never clobbered (the TS `if (a.epithet) return`
/// guard). Returns true iff the brand was newly applied (and a Beat logged). The shared primitive
/// behind every dynastic title (the combat layer's hero/villain/survivor, the oathbreaker villain).
pub fn brand_epithet(world: &mut World, i: usize, epithet: u8) -> bool {
    if i >= world.n || epithet == EPITHET_NONE {
        return false;
    }
    if world.epithet[i] != EPITHET_NONE {
        return false; // already named — never clobber an earned title (idempotent)
    }
    world.epithet[i] = epithet;
    // OBSERVER BEAT — the title rides the news (render-only text generated later from this beat).
    world.chronicle.push(Beat {
        t: world.tick,
        kind: KIND_EPITHET,
        subject: i as u32,
        magnitude: epithet as i32,
    });
    true
}

/// THE OATHBREAKER BRAND (betrayal-as-choice): a soul who has broken ENOUGH sworn words
/// (`forsworn >= at`) earns the dark VILLAIN epithet — the negative dynastic counterpart to "the Bold".
/// Idempotent (`brand_epithet` won't clobber an existing title) and threshold-gated. Returns true iff
/// newly branded. Mirrors TS `brandForsworn` (the `life.forsworn >= forswornBrandAt` gate); the
/// `forsworn` count is passed in by the caller (the obligation-ledger layer owns the count — there is
/// no `forsworn` column in this wave, so the helper is parameterised on it).
pub fn brand_forsworn(world: &mut World, i: usize, forsworn: u32, at: u32) -> bool {
    if forsworn < at {
        return false;
    }
    brand_epithet(world, i, EPITHET_VILLAIN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::World;

    /// A feud is symmetric (canonical), idempotent to arm, and queryable both ways.
    #[test]
    fn feud_is_canonical_and_idempotent() {
        let mut w = World::spawn(0x40051, 4);
        // arm a feud between houses 7 and 3 — recorded as canonical (3,7).
        assert!(set_house_feud(&mut w, 7, 3), "a fresh feud is recorded");
        assert_eq!(w.house_feuds.len(), 1);
        assert_eq!(w.house_feuds[0], (3, 7), "stored in canonical lo<hi order");
        // queryable in EITHER direction.
        assert!(are_houses_feuding(&w, 7, 3));
        assert!(are_houses_feuding(&w, 3, 7));
        // re-arming the SAME pair (either way) is a no-op (set semantics, no duplicate).
        assert!(!set_house_feud(&mut w, 3, 7), "re-arming an existing feud is a no-op");
        assert_eq!(w.house_feuds.len(), 1, "no duplicate pair");
    }

    /// A house never feuds itself, and the 0 sentinel ("no house") never participates.
    #[test]
    fn no_self_or_houseless_feud() {
        let mut w = World::spawn(0x40052, 4);
        assert!(!set_house_feud(&mut w, 5, 5), "a house can't feud itself");
        assert!(!set_house_feud(&mut w, 0, 5), "the no-house sentinel can't feud");
        assert!(!set_house_feud(&mut w, 5, 0), "the no-house sentinel can't feud (either side)");
        assert!(w.house_feuds.is_empty(), "no invalid feud was recorded");
        assert!(!are_houses_feuding(&w, 5, 5));
        assert!(!are_houses_feuding(&w, 0, 5));
    }

    /// Healing a feud removes it; a child inheriting then finds none.
    #[test]
    fn feud_can_be_healed() {
        let mut w = World::spawn(0x40053, 4);
        set_house_feud(&mut w, 2, 9);
        assert!(are_houses_feuding(&w, 2, 9));
        assert!(end_house_feud(&mut w, 9, 2), "the feud is healed (canonical, either way)");
        assert!(!are_houses_feuding(&w, 2, 9), "no longer feuding");
        assert!(!end_house_feud(&mut w, 2, 9), "healing an absent feud returns false");
    }

    /// `feuding_house_of` finds the partner from either side — the grudge a newborn inherits.
    #[test]
    fn feuding_house_inherits() {
        let mut w = World::spawn(0x40054, 4);
        set_house_feud(&mut w, 4, 11);
        assert_eq!(feuding_house_of(&w, 4), Some(11), "house 4 feuds house 11");
        assert_eq!(feuding_house_of(&w, 11), Some(4), "and symmetrically");
        assert_eq!(feuding_house_of(&w, 6), None, "an unfeuding house has no grudge");
        assert_eq!(feuding_house_of(&w, 0), None, "the no-house sentinel never feuds");
    }

    /// Branding is idempotent: an earned title is never clobbered, and exactly one Beat is logged.
    #[test]
    fn epithet_brand_is_idempotent() {
        let mut w = World::spawn(0x40055, 4);
        let beats0 = w.chronicle.len();
        assert!(brand_epithet(&mut w, 1, EPITHET_HERO), "first brand applies");
        assert_eq!(w.epithet[1], EPITHET_HERO);
        assert_eq!(w.chronicle.len(), beats0 + 1, "one epithet beat logged");
        // a second brand (even a different title) must NOT clobber the earned one.
        assert!(!brand_epithet(&mut w, 1, EPITHET_VILLAIN), "an earned title is never clobbered");
        assert_eq!(w.epithet[1], EPITHET_HERO, "the hero title survives");
        assert_eq!(w.chronicle.len(), beats0 + 1, "no second beat");
        // the none-epithet and out-of-range index are rejected.
        assert!(!brand_epithet(&mut w, 2, EPITHET_NONE), "branding NONE is a no-op");
        assert!(!brand_epithet(&mut w, 999, EPITHET_HERO), "out-of-range index is rejected");
    }

    /// The oathbreaker brand is threshold-gated and brands a VILLAIN.
    #[test]
    fn forsworn_brand_threshold() {
        let mut w = World::spawn(0x40056, 4);
        // below threshold ⇒ no brand.
        assert!(!brand_forsworn(&mut w, 0, FORSWORN_BRAND_AT - 1, FORSWORN_BRAND_AT));
        assert_eq!(w.epithet[0], EPITHET_NONE);
        // at/over threshold ⇒ branded a villain (a breaker of sworn words).
        assert!(brand_forsworn(&mut w, 0, FORSWORN_BRAND_AT, FORSWORN_BRAND_AT));
        assert_eq!(w.epithet[0], EPITHET_VILLAIN);
        // already named ⇒ a later breach doesn't re-brand (idempotent).
        assert!(!brand_forsworn(&mut w, 0, FORSWORN_BRAND_AT + 5, FORSWORN_BRAND_AT));
    }

    /// The SURVIVOR epithet code is a valid, distinct brand (used by the combat/survival layer).
    #[test]
    fn survivor_epithet_brands() {
        let mut w = World::spawn(0x40058, 4);
        assert!(brand_epithet(&mut w, 3, EPITHET_SURVIVOR));
        assert_eq!(w.epithet[3], EPITHET_SURVIVOR);
    }

    /// Determinism: a feud-maintaining run is M-invariant (M=1 ≡ M=N) via the world golden hash. (Houses
    /// is helpers-only — no society_phase pass — so this just confirms adding the module + column doesn't
    /// perturb the existing M-invariant sim.)
    #[test]
    fn houses_m_invariant() {
        use crate::hash::world_hash;
        use crate::{in_pool, run_sim};
        let h1 = in_pool(1, || world_hash(&run_sim(0x40057, 300, 80)));
        let h4 = in_pool(4, || world_hash(&run_sim(0x40057, 300, 80)));
        assert_eq!(h1, h4, "houses module must not perturb M-invariance");
    }
}
