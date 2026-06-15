//! Component catalog (the Wave-1 core subset of docs/architecture/22 Appendix A). Everything is
//! `Copy`, scalar, inline (no heap, no pointers) so columns stream and tables sit inline (§3).
//! The FULL catalog (society/news/sparse roles) is the deferred wave; this covers the core sim loop.

pub const VISION: f32 = 22.0;
pub const MAX_VISION: f32 = VISION * 1.5; // grid cell — the 3×3 query is then a superset (§3.1).
pub const BELIEF_CAP: usize = 25;
pub const N_COMMODITIES: usize = 6; // types/economy.ts Commodity (closed set).
pub const N_TAGS: usize = 30; // types/events.ts Tag (closed behaviour vocabulary).

/// types/agent.ts Faction (interned u8).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Faction {
    Townsfolk = 0,
    Monster = 1,
    Raider = 2,
    Watch = 3,
    Player = 4,
}

/// Profession (a subset; index into work-site selection). `None` for monsters/player.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Profession {
    None = 0,
    Farmer = 1,
    Miner = 2,
    Woodcutter = 3,
    Blacksmith = 4,
    Hunter = 5,
    Trader = 6,
}

/// types/economy.ts Commodity (closed; index into the fixed-size Economy arrays).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Commodity {
    Food = 0,
    Wood = 1,
    Ore = 2,
    Tool = 3,
    Herb = 4,
    Potion = 5,
}

/// types/goals.ts GoalKind (the core kinds the Wave-1 systems emit). The variant DATA lives on the
/// `Goal` enum below (cleaner than the TS loose bag).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GoalKind {
    Idle = 0,
    Work = 1,
    Market = 2,
    Wander = 3,
    Eat = 4,
    Rest = 5,
    Comfort = 6,
    Flee = 7,
    Fight = 8,
    Home = 9,
}

/// types/combat.ts FighterState — the directional-melee swing state machine.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FighterState {
    Idle = 0,
    Ready = 1,
    Attack = 2,
    Recover = 3,
    Block = 4,
    Stagger = 5,
    Dead = 6,
}

// ───────────────────────────── HOT — the neighbour read-surface (§3.1) ─────────────────────────────

/// ~32 B AoS row: exactly what others read about an entity, rebuilt + spatially sorted each tick.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Perceivable {
    pub id: u32,
    pub x: f32,
    pub z: f32,
    pub faction: u8, // perceived faction
    pub flags: u8,   // bit0 alive, bit1 held, bit2 building
    pub level: u8,
    pub _pad: u8,
    pub notoriety: u16,
    pub threat: u16,
    pub wealth_cue: u16,
    pub _pad2: u16,
}

// ───────────────────────────── WARM — dense per-agent components ─────────────────────────────

/// types/agent.ts Needs (1 = satisfied).
#[derive(Clone, Copy, Debug)]
pub struct Needs {
    pub hunger: f32,
    pub energy: f32,
    pub social: f32,
    pub comfort: f32,
    pub novelty: f32,
}
impl Default for Needs {
    fn default() -> Self {
        Needs { hunger: 1.0, energy: 1.0, social: 1.0, comfort: 1.0, novelty: 1.0 }
    }
}

/// types/agent.ts Mood (decays; colours decisions).
#[derive(Clone, Copy, Debug, Default)]
pub struct Mood {
    pub fear: f32,
    pub anger: f32,
    pub joy: f32,
    pub pride: f32,
    pub loneliness: f32,
    pub grief: f32,
}

/// types/agent.ts Economy — closed money loop. Fixed-point i64 gold ⇒ exact conservation (§3.3).
#[derive(Clone, Copy, Debug)]
pub struct Economy {
    pub gold: i64, // minor units
    pub stash: i64,
    pub inventory: [i32; N_COMMODITIES],
    pub mastery: [u8; N_COMMODITIES],
    pub price_belief: [u16; N_COMMODITIES],
    pub recipes: u32, // bitset of craftable goods
    pub tool_wear: f32,
    pub trade_kind: u8, // Commodity or 0xFF = none
}
impl Default for Economy {
    fn default() -> Self {
        Economy {
            gold: 0,
            stash: 0,
            inventory: [0; N_COMMODITIES],
            mastery: [0; N_COMMODITIES],
            price_belief: [0; N_COMMODITIES],
            recipes: 0,
            tool_wear: 0.0,
            trade_kind: 0xFF,
        }
    }
}

/// types/combat.ts Fighter — the swing state machine (every agent has one).
#[derive(Clone, Copy, Debug)]
pub struct CombatBody {
    pub state: u8, // FighterState
    pub dir: u8,
    pub block_dir: u8,
    pub has_hit: bool,
    pub health: f32,
    pub target_yaw: f32,
    pub recover: f32,
    pub stagger: f32,
    pub attack_cd: f32,
}
impl Default for CombatBody {
    fn default() -> Self {
        CombatBody {
            state: FighterState::Idle as u8,
            dir: 0,
            block_dir: 0,
            has_hit: false,
            health: 100.0,
            target_yaw: 0.0,
            recover: 0.0,
            stagger: 0.0,
            attack_cd: 0.0,
        }
    }
}

/// types/goals.ts Goal — a Rust enum carrying each kind's data (vs the TS loose bag).
#[derive(Clone, Copy, Debug)]
pub enum Goal {
    Idle,
    Work { site: [f32; 2] },
    Market { site: [f32; 2] },
    Wander { to: [f32; 2] },
    Eat,
    Rest,
    Comfort { to: [f32; 2] },
    Flee { from: u32 },
    Fight { target: u32 },
    Home { to: [f32; 2] },
}
impl Goal {
    pub fn kind(&self) -> GoalKind {
        match self {
            Goal::Idle => GoalKind::Idle,
            Goal::Work { .. } => GoalKind::Work,
            Goal::Market { .. } => GoalKind::Market,
            Goal::Wander { .. } => GoalKind::Wander,
            Goal::Eat => GoalKind::Eat,
            Goal::Rest => GoalKind::Rest,
            Goal::Comfort { .. } => GoalKind::Comfort,
            Goal::Flee { .. } => GoalKind::Flee,
            Goal::Fight { .. } => GoalKind::Fight,
            Goal::Home { .. } => GoalKind::Home,
        }
    }
    /// The locomotion target this goal implies (None ⇒ stand still / in-place verb).
    pub fn move_target(&self) -> Option<[f32; 2]> {
        match self {
            Goal::Work { site } | Goal::Market { site } => Some(*site),
            Goal::Wander { to } | Goal::Comfort { to } | Goal::Home { to } => Some(*to),
            _ => None,
        }
    }
}

// ───────────────────────────── progression (§ js/rpg/progression.js) ─────────────────────────────

/// Max emergent classes held per agent (mirrors `RPG.maxClasses`, kept small + inline).
pub const MAX_CLASSES: usize = 4;
/// A sentinel "no class" key for empty held-class slots.
pub const NO_CLASS: u8 = 0xFF;

/// types/agent.ts Progression — the per-agent class/level brain (the Wave-1 core subset of
/// `js/rpg/progression.js`). Deeds fold (magnitude-scaled, tag-indexed) into `behavior_profile`,
/// which decays each tick and is periodically matched against class templates to grant classes +
/// route XP into `total_level`. Inline/`Copy` (no heap) so it streams like every other column.
#[derive(Clone, Copy, Debug)]
pub struct Progression {
    /// Weighted behaviour tallies, indexed by deed verb/tag (0..N_TAGS). Decays slowly.
    pub behavior_profile: [f32; N_TAGS],
    /// Cached sum of held-class levels (≤ TOTAL_LEVEL_CAP).
    pub total_level: u16,
    /// XP banked toward the next level (fixed-point ×1000, integer ⇒ deterministic).
    pub xp: u32,
    /// Held class template ids (NO_CLASS = empty slot). Small inline array.
    pub classes: [u8; MAX_CLASSES],
    pub n_classes: u8,
}
impl Default for Progression {
    fn default() -> Self {
        Progression {
            behavior_profile: [0.0; N_TAGS],
            total_level: 0,
            xp: 0,
            classes: [NO_CLASS; MAX_CLASSES],
            n_classes: 0,
        }
    }
}
impl Progression {
    /// Is `key` already held? (linear scan of the tiny held-class array.)
    #[inline]
    pub fn holds(&self, key: u8) -> bool {
        self.classes[..self.n_classes as usize].iter().any(|&c| c == key)
    }
}

// ───────────────────────────── the belief table (§3.2) ─────────────────────────────

/// One observer→subject belief cell (the hot N² payload; the dominant per-entity memory).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PersonBelief {
    pub subject: u32,
    pub last_x: f32,
    pub last_z: f32,
    pub confidence: u16,
    pub faction: u8,
    pub level: u8,
    pub notoriety: u16,
    pub threat: u16,
    pub last_tick: u32,
    pub standing: i16, // −32768..32767 quantization of −1..1 (relationship)
    pub flags: u8,     // bit0 hostile
    pub _pad: u8,
}

/// Inline belief table — dense `subjects` match-array beside `bodies`, kept sorted by (dist², id).
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
    /// Index of the belief about `subject`, if held (linear scan of the small match-array).
    #[inline]
    pub fn find(&self, subject: u32) -> Option<usize> {
        self.subjects[..self.len as usize].iter().position(|&s| s == subject)
    }
}
