//! The (Wave-0 subset of the) component catalog. The FULL catalog is pinned in
//! docs/architecture/22 Appendix A; this spike materializes only what the parallel `perceive`
//! pass exercises — the hot path — and leaves the long tail (Goal/Plan/Progression/society state)
//! to the deferred per-system wave. Everything here is `Copy`, scalar, and inline (no heap, no
//! pointers) so columns stream and the belief table sits inline per entity (§3).

/// Max believed sight range — the grid cell size, so a 3×3 query is a guaranteed superset (§3.1, §4).
/// `MAX_VISION = VISION × max-vantage(1.5)`; concealment only shrinks, so this is the upper bound.
pub const VISION: f32 = 22.0;
pub const MAX_VISION: f32 = VISION * 1.5;
/// Per-entity belief-table capacity (the TS `SIM.beliefsPerAgent`). The cap-25 eviction is the
/// order-sensitive policy doc 21 found load-bearing; here it's an explicit, deterministic
/// "keep the N nearest" (ties broken by id) so the result is independent of `rayon` ordering.
pub const BELIEF_CAP: usize = 25;

/// types/agent.ts Faction (closed enum; interned to u8 on the hot path).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Faction {
    Townsfolk = 0,
    Monster = 1,
    Raider = 2,
    Watch = 3,
    Player = 4,
}

/// The ~32 B AoS neighbour read-surface (§3.1): exactly what others read about an entity, packed
/// and (rebuilt + spatially sorted) each tick. Two fit per 64 B cache line.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Perceivable {
    pub id: u32,         // stable entity id
    pub x: f32,
    pub z: f32,
    pub faction: u8,     // PERCEIVED faction (a disguise would already be folded in)
    pub flags: u8,       // bit0 alive, bit1 held, bit2 building
    pub level: u8,       // believed class level cue
    pub _pad: u8,
    pub notoriety: u16,  // quantized believed scalars
    pub threat: u16,
    pub wealth_cue: u16, // precomputed once per subject (the per-subject inventory sum, doc 21)
    pub _pad2: u16,
}

/// One observer→subject belief cell (the hot N² payload). The TS `BeliefState` is ~40 fields; this
/// spike keeps the subset `perceive` writes. Quantized — it's ×BELIEF_CAP per agent (the dominant
/// per-entity memory, doc 22 §3.2), so every byte counts.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PersonBelief {
    pub subject: u32,
    pub last_x: f32,
    pub last_z: f32,
    pub confidence: u16, // 0..=65535 quantization of 0..1
    pub faction: u8,
    pub level: u8,
    pub notoriety: u16,
    pub threat: u16,
    pub last_tick: u32,
    pub flags: u8, // bit0 hostile, bit1 captive
    pub _pad: [u8; 3],
}

/// The inline belief table (§3.2): a dense `subjects` match-array beside the `bodies`. Kept sorted
/// by (distance, id) so the cap-`BELIEF_CAP` eviction ("keep the nearest") is deterministic.
#[derive(Clone)]
pub struct BeliefTable {
    pub len: u8,
    pub subjects: [u32; BELIEF_CAP],
    pub bodies: [PersonBelief; BELIEF_CAP],
}

impl Default for BeliefTable {
    fn default() -> Self {
        BeliefTable {
            len: 0,
            subjects: [u32::MAX; BELIEF_CAP],
            bodies: [PersonBelief::default(); BELIEF_CAP],
        }
    }
}

impl BeliefTable {
    #[inline]
    pub fn clear(&mut self) {
        self.len = 0;
    }
}
