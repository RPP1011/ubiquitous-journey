//! The behaviour-TAG vocabulary (port of `js/rpg/tags.ts` + the `Tag` union in `types/events.ts`).
//!
//! Tags are the atoms of identity in the sim: every deed an agent performs carries a few of them,
//! and `systems::progression::fold_deed` accumulates them (magnitude-weighted) into the per-agent
//! `behavior_profile`, which the class matcher tests against templates. The vocabulary is CLOSED and
//! its DECLARATION ORDER is load-bearing — the index of each tag is its raw `u8` identity, used both
//! as the `behavior_profile` column index and the deed `verb` byte. The order here is byte-identical
//! to `types/events.ts`'s `Tag` union and to the `TAG_*` consts already in `systems::progression`.
//!
//! Also ports the FNV-1a hash (`js/rpg/tags.ts fnv1a`/`comboKey`) used for cheap novelty/combo keys,
//! and `sanitize` (the `sanitizeTags` typo-filter). Determinism: pure, no float reduce, no HashMap.

use crate::components::N_TAGS;

/// The closed behaviour-tag vocabulary in DECLARATION ORDER (`types/events.ts` `Tag`). The numeric
/// value of each variant is its index into `behavior_profile` and its deed `verb` byte. `N_TAGS`
/// (= 30) MUST equal `Tag::COUNT`.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tag {
    // combat
    Melee = 0,
    Defense = 1,
    Kill = 2,
    Risk = 3,
    Berserk = 4,
    Duel = 5,
    // craft
    Smithing = 6,
    Crafting = 7,
    Toolmaking = 8,
    Build = 9,
    // gather
    Farming = 10,
    Mining = 11,
    Woodcut = 12,
    Forage = 13,
    // trade
    Trade = 14,
    Profit = 15,
    Haggle = 16,
    Barter = 17,
    // social
    Persuade = 18,
    Gossip = 19,
    Deceive = 20,
    Lead = 21,
    Charm = 22,
    // survival
    Endurance = 23,
    Explore = 24,
    Heal = 25,
    Wander = 26,
    Hunger = 27,
    Flee = 28,
    Stealth = 29,
}

impl Tag {
    /// Number of tags in the closed vocabulary (must equal `components::N_TAGS`).
    pub const COUNT: usize = 30;

    /// The canonical UPPER-CASE tag name (matches `js/rpg/tags.ts` `TAG_LIST` / the `Tag` union).
    /// Used for the FNV combo-key hash so a Rust combo key collides with the JS one.
    #[inline]
    pub fn name(self) -> &'static str {
        TAG_NAMES[self as usize]
    }

    /// The tag at index `i`, or `None` if out of the closed range (the `sanitize`/`isTag` guard).
    #[inline]
    pub fn from_index(i: u8) -> Option<Tag> {
        if (i as usize) < Tag::COUNT {
            // SAFETY: the enum is `repr(u8)` with contiguous values 0..COUNT, and `i` is in range.
            Some(unsafe { core::mem::transmute::<u8, Tag>(i) })
        } else {
            None
        }
    }

    /// Parse a canonical tag name into its `Tag` (the inverse of `name`). `None` for unknown names —
    /// the `isTag` membership guard. Linear scan over the tiny closed vocabulary.
    #[inline]
    pub fn from_name(s: &str) -> Option<Tag> {
        TAG_NAMES.iter().position(|&n| n == s).and_then(|i| Tag::from_index(i as u8))
    }
}

/// Canonical names in DECLARATION ORDER (index = `Tag as usize`). Mirrors `TAG_LIST`.
pub const TAG_NAMES: [&str; Tag::COUNT] = [
    "MELEE", "DEFENSE", "KILL", "RISK", "BERSERK", "DUEL", // combat
    "SMITHING", "CRAFTING", "TOOLMAKING", "BUILD", // craft
    "FARMING", "MINING", "WOODCUT", "FORAGE", // gather
    "TRADE", "PROFIT", "HAGGLE", "BARTER", // trade
    "PERSUADE", "GOSSIP", "DECEIVE", "LEAD", "CHARM", // social
    "ENDURANCE", "EXPLORE", "HEAL", "WANDER", "HUNGER", "FLEE", "STEALTH", // survival
];

// Compile-time guard: the Rust vocabulary size matches the component column width. If a tag is
// added/removed, `N_TAGS` must move with it or this fails to compile.
const _: () = assert!(Tag::COUNT == N_TAGS, "Tag::COUNT must equal components::N_TAGS");

// ── FNV-1a, 32-bit (port of `js/rpg/tags.ts fnv1a`) ──
// Deterministic, dependency-free. Folds over the UTF-8 bytes; the JS folds over UTF-16 code units,
// but every tag name is ASCII so the two agree byte-for-byte on the closed vocabulary.

const FNV32_OFFSET: u32 = 0x811c9dc5;
const FNV32_PRIME: u32 = 0x0100_0193;

/// FNV-1a over a byte string → unsigned 32-bit (`fnv1a`). Uses wrapping mul (`Math.imul` semantics).
#[inline]
pub fn fnv1a(s: &str) -> u32 {
    let mut h = FNV32_OFFSET;
    for &b in s.as_bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(FNV32_PRIME);
    }
    h
}

/// Hash an UNORDERED set of tags into one stable key (`comboKey`): sort the names so `{A,B}` and
/// `{B,A}` collide, join with `|`, then FNV. Deterministic regardless of input order.
pub fn combo_key(tags: &[Tag]) -> u32 {
    let mut names: Vec<&str> = tags.iter().map(|t| t.name()).collect();
    names.sort_unstable();
    fnv1a(&names.join("|"))
}

/// Filter an arbitrary tag-index list down to the known closed vocabulary (drops out-of-range typos —
/// the `sanitizeTags` guard). Returns the in-vocabulary `Tag`s in input order.
pub fn sanitize(indices: &[u8]) -> Vec<Tag> {
    indices.iter().filter_map(|&i| Tag::from_index(i)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Rust enum indices match the JS `types/events.ts` declaration order exactly (a few spot
    /// checks against the `progression` TAG_* consts that are already in the substrate).
    #[test]
    fn indices_match_substrate() {
        assert_eq!(Tag::Melee as u8, 0);
        assert_eq!(Tag::Build as u8, 9);
        assert_eq!(Tag::Endurance as u8, 23);
        assert_eq!(Tag::Explore as u8, 24);
        assert_eq!(Tag::Stealth as u8, 29);
        assert_eq!(Tag::COUNT, N_TAGS);
        // the progression consts and the enum agree.
        assert_eq!(Tag::Melee as u8, crate::systems::progression::TAG_MELEE);
        assert_eq!(Tag::Farming as u8, crate::systems::progression::TAG_FARMING);
    }

    /// name ↔ index round-trips across the whole vocabulary.
    #[test]
    fn name_roundtrip() {
        for i in 0..Tag::COUNT as u8 {
            let t = Tag::from_index(i).unwrap();
            assert_eq!(t as u8, i);
            assert_eq!(Tag::from_name(t.name()), Some(t));
        }
        assert!(Tag::from_index(30).is_none());
        assert!(Tag::from_name("NOPE").is_none());
    }

    /// FNV-1a matches the JS reference algorithm over ASCII.
    #[test]
    fn fnv1a_known_values() {
        // empty string → the offset basis unchanged.
        assert_eq!(fnv1a(""), FNV32_OFFSET);
        // distinct strings differ; identical strings agree.
        assert_ne!(fnv1a("MELEE"), fnv1a("KILL"));
        assert_eq!(fnv1a("MELEE"), fnv1a("MELEE"));
    }

    /// combo_key is ORDER-INDEPENDENT (the whole point — {A,B} == {B,A}).
    #[test]
    fn combo_key_order_independent() {
        let a = combo_key(&[Tag::Melee, Tag::Kill]);
        let b = combo_key(&[Tag::Kill, Tag::Melee]);
        assert_eq!(a, b);
        assert_eq!(a, fnv1a("KILL|MELEE")); // sorted join
    }

    /// sanitize drops out-of-vocabulary indices, keeps the rest in order.
    #[test]
    fn sanitize_filters() {
        let got = sanitize(&[0, 200, 29, 30]);
        assert_eq!(got, vec![Tag::Melee, Tag::Stealth]);
    }
}
