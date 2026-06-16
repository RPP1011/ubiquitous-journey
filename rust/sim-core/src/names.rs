//! Procedural NAMING (port of the `js/sim/houses.js` surname generator + the procedural name path). A
//! DETERMINISTIC id → name mapping built from fixed syllable tables: the same id always yields the same
//! name, with no per-entity state, so it is identical across runs/threads by construction (render-facing
//! only — a name NEVER drives a decision, so it is not part of the determinism hash). The render layer /
//! gazette turns numeric agent ids and chronicle beats into readable prose with this.

/// Given-name syllable banks (onset + nucleus/coda). Small, fixed, deterministic.
const GIVEN_A: &[&str] = &[
    "Al", "Bre", "Cor", "Dun", "El", "Fen", "Gar", "Hal", "Im", "Jor", "Kel", "Lor", "Mer", "Ned",
    "Os", "Pel", "Quin", "Ros", "Sel", "Tor", "Ul", "Ver", "Wyn", "Yar",
];
const GIVEN_B: &[&str] = &[
    "wen", "ric", "dis", "mund", "a", "is", "or", "wyn", "ith", "an", "el", "ara", "on", "ius",
];

/// Surname banks (descriptive + place-y, like the TS `HOUSES`/`EPITHETS` material).
const SUR_A: &[&str] = &[
    "Black", "Stone", "Iron", "Fair", "Green", "Ash", "Oak", "Storm", "Frost", "Gold", "Red",
    "White", "Hart", "Wolf", "Raven", "Thorn",
];
const SUR_B: &[&str] = &[
    "wood", "ford", "field", "ridge", "vale", "bourne", "stead", "moor", "crest", "mere", "hollow",
    "gate", "hall", "brook",
];

#[inline]
fn pick<'a>(bank: &'a [&'a str], h: u32) -> &'a str {
    bank[(h as usize) % bank.len()]
}

/// A stable scramble of `id` (a tiny integer hash) so adjacent ids don't yield adjacent names.
#[inline]
fn scramble(id: u32) -> u32 {
    let mut x = id.wrapping_mul(2654435761).wrapping_add(0x9E3779B9);
    x ^= x >> 15;
    x = x.wrapping_mul(0x85EBCA6B);
    x ^= x >> 13;
    x
}

/// The given name for an agent id (deterministic).
pub fn given_name(id: u32) -> String {
    let h = scramble(id);
    format!("{}{}", pick(GIVEN_A, h), pick(GIVEN_B, h >> 8))
}

/// The surname for an agent id, keyed by its HOUSE when it has one (house members share a surname), else
/// by the agent id itself.
pub fn surname(id: u32, house: u16) -> String {
    let key = if house != 0 { scramble(house as u32 ^ 0xB055E5) } else { scramble(id ^ 0x5A17) };
    format!("{}{}", pick(SUR_A, key), pick(SUR_B, key >> 8))
}

/// The full name (given + surname) for an agent.
pub fn full_name(id: u32, house: u16) -> String {
    format!("{} {}", given_name(id), surname(id, house))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_deterministic_and_varied() {
        // same id ⇒ same name (stable across calls).
        assert_eq!(full_name(7, 0), full_name(7, 0));
        // different ids ⇒ (almost always) different names.
        assert_ne!(given_name(1), given_name(2));
        // house members SHARE a surname; non-house members key off their own id.
        assert_eq!(surname(10, 42), surname(99, 42), "a shared house ⇒ a shared surname");
    }
}
