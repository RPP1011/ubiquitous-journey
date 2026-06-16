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
    Interact = 10,
    Gather = 11,    // forage a RAW good at a resource node (capital-free, any agent — the gather verb)
    Socialize = 12, // seek company at a gathering place — restores the SOCIAL need (the socialize fill)
    Sightsee = 13,  // visit a novel place — restores the NOVELTY need (the sightsee fill)
    Observe = 14,   // go watch an uncertain-but-valuable subject first-hand to FIRM the belief (scout)
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
    /// Starvation clock (ticks hunger has sat empty). Needs-owned — NOT `combat.stagger`, which the
    /// combat swing machine owns (the two would fight over one f32). Integration fix.
    pub starve: f32,
}
impl Default for Needs {
    fn default() -> Self {
        Needs { hunger: 1.0, energy: 1.0, social: 1.0, comfort: 1.0, novelty: 1.0, starve: 0.0 }
    }
}

/// types/agent.ts Personality — the five+ stable traits (0..1) that bias an agent's ARCHETYPAL
/// behaviour: ambition assignment, the risk/altruism gates crime turns on (urchin/affect/sabotage),
/// social drive for bonding/courtship, curiosity for wanderlust/scouting, aggression for stand-and-
/// fight. Sampled once at spawn; read all over the cognition layer. Inline/`Copy` like every column.
#[derive(Clone, Copy, Debug)]
pub struct Personality {
    pub ambition: f32,
    pub curiosity: f32,
    pub risk_tolerance: f32,
    pub social_drive: f32,
    pub altruism: f32,
    pub aggression: f32,
}
impl Default for Personality {
    fn default() -> Self {
        Personality {
            ambition: 0.5,
            curiosity: 0.5,
            risk_tolerance: 0.5,
            social_drive: 0.5,
            altruism: 0.5,
            aggression: 0.5,
        }
    }
}

/// Ambition kinds — the slow archetypal drive each agent carries (`js/sim/motivation.js` AMBITIONS).
/// A data-only bias on the existing decide() choices, not a new behaviour.
pub const AMB_WEALTH: u8 = 0; // amass wealth → trade more
pub const AMB_MASTERY: u8 = 1; // master a craft → work more
pub const AMB_RENOWN: u8 = 2; // win renown → stand and fight (via aggression)
pub const AMB_WANDERLUST: u8 = 3; // see the world → roam more
pub const AMB_BELONGING: u8 = 4; // belong → seek company

/// Assign an ambition weighted by personality (mirrors `assignAmbition`'s weight functions), using a
/// single uniform draw `r` ∈ [0,1). Deterministic. Monsters/raiders get wanderlust by default.
pub fn pick_ambition(p: &Personality, r: f32) -> u8 {
    let w = [
        0.15 + 1.3 * p.ambition,                       // wealth
        0.12 + 0.78 * p.ambition + 0.52 * p.curiosity, // mastery
        0.06 + 1.3 * p.risk_tolerance,                 // renown
        0.09 + 1.3 * p.curiosity,                      // wanderlust
        0.09 + 1.3 * p.social_drive,                   // belonging
    ];
    let total: f32 = w.iter().sum();
    let mut acc = r * total;
    for (i, &wi) in w.iter().enumerate() {
        acc -= wi;
        if acc <= 0.0 {
            return i as u8;
        }
    }
    AMB_WEALTH
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
    /// A temporary damage BUFFER (the ability `shield` op, e.g. second_wind): incoming Strike damage is
    /// absorbed here before health. 0 = no shield. Set by a self-cast; depleted by blows (no regen).
    pub shield: f32,
    /// Control-effect timers (seconds), the ability DSL's debuff ops. While >0 each one bites, then it
    /// ticks down (DT/combat tick) to 0. `stun` = frozen (can't act); `slow` = locomotion at half pace;
    /// `expose` = takes amplified Strike damage (the combo-setter). Set by an `Intent::Afflict`.
    pub stun: f32,
    pub slow: f32,
    pub expose: f32,
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
            shield: 0.0,
            stun: 0.0,
            slow: 0.0,
            expose: 0.0,
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
    /// Hunt a believed-hostile/avenge target: `target` is the subject id (combat strikes it when in
    /// reach, reading its BELIEVED pos); `to` is the approach point locomotion walks toward (the
    /// target's last-believed position, refreshed each cognition tick by `decide`). Carrying `to` is
    /// what lets an avenger/raider actually CLOSE the distance — previously a Fight stood still.
    Fight { target: u32, to: [f32; 2] },
    Home { to: [f32; 2] },
    /// Approach a subject and perform a non-combat world-interaction verb on arrival (give/pay/rob/
    /// loot/free/wreck/…). `to` is the approach point (the subject's believed pos, refreshed each tick);
    /// the `act` phase fires `verb` when in reach. The non-combat sibling of `Fight`.
    Interact { verb: u8, target: u32, to: [f32; 2] },
    /// Forage a RAW good (`good`) at a resource node (`site`) — the capital-free GATHER verb, open to
    /// ANY agent regardless of profession (unlike `Work`, which mints only the agent's own output).
    /// Locomotion walks to `site`; the market production pass mints one unit of `good` on arrival. This
    /// is what lets a destitute non-farmer actually feed itself (the subsistence forage path).
    Gather { site: [f32; 2], good: u8 },
    /// Seek company at a gathering place (`to`) — the socialize fill. Locomotion walks there; needs.rs
    /// restores the SOCIAL need on arrival (the soft-need satisfier that was previously missing).
    Socialize { to: [f32; 2] },
    /// Visit a novel place (`to`) — the sightsee fill. Restores the NOVELTY need on arrival.
    Sightsee { to: [f32; 2] },
    /// Go watch an uncertain-but-valuable subject first-hand (`to` = its believed position) to FIRM the
    /// belief — the scout/observe channel of the knowledge model. No on-arrival verb: perceive raises
    /// the belief's confidence on sight (first-hand watching IS the learning).
    Observe { to: [f32; 2] },
}

/// The non-combat interaction verbs a `Goal::Interact` carries (the conserved social/economic acts).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InteractVerb {
    Give = 0, // hand a good to the target (gift / repay-in-kind)
    Pay = 1,  // hand coin to the target (repay-in-coin)
    Rob = 2,  // take coin from the target by force
    Loot = 3, // take coin from a fallen target
    Free = 4, // cut a captive's bonds (dormant until captivity state lands)
    Wreck = 5, // sabotage a structure (dormant until building state lands)
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
            Goal::Interact { .. } => GoalKind::Interact,
            Goal::Gather { .. } => GoalKind::Gather,
            Goal::Socialize { .. } => GoalKind::Socialize,
            Goal::Sightsee { .. } => GoalKind::Sightsee,
            Goal::Observe { .. } => GoalKind::Observe,
        }
    }
    /// The locomotion target this goal implies (None ⇒ stand still / in-place verb). A Fight now
    /// steps toward its believed approach point (`to`), so the hunter closes the gap before striking.
    pub fn move_target(&self) -> Option<[f32; 2]> {
        match self {
            Goal::Work { site } | Goal::Market { site } | Goal::Gather { site, .. } => Some(*site),
            Goal::Wander { to }
            | Goal::Comfort { to }
            | Goal::Home { to }
            | Goal::Socialize { to }
            | Goal::Sightsee { to }
            | Goal::Observe { to } => Some(*to),
            Goal::Fight { to, .. } | Goal::Interact { to, .. } => Some(*to),
            _ => None,
        }
    }
}

// ───────────────────────────── progression (§ js/rpg/progression.js) ─────────────────────────────

/// Max emergent classes held per agent (mirrors `RPG.maxClasses`, kept small + inline).
pub const MAX_CLASSES: usize = 4;
/// A sentinel "no class" key for empty held-class slots.
pub const NO_CLASS: u8 = 0xFF;
/// Max known abilities held per agent (granted at class tier milestones).
pub const MAX_ABILITIES: usize = 4;
/// A sentinel "no ability" id for empty known-ability slots (mirrors `abilities::NO_ABILITY`).
pub const NO_ABILITY: u16 = u16::MAX;

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
    /// Known ability ids (catalog indices; NO_ABILITY = empty slot). Granted at class tier milestones.
    pub abilities: [u16; MAX_ABILITIES],
}
impl Default for Progression {
    fn default() -> Self {
        Progression {
            behavior_profile: [0.0; N_TAGS],
            total_level: 0,
            xp: 0,
            classes: [NO_CLASS; MAX_CLASSES],
            n_classes: 0,
            abilities: [NO_ABILITY; MAX_ABILITIES],
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
    pub wealth: u16, // believed wealth cue (perceived prosperity — the heist/esteem signal)
    pub last_tick: u32,
    pub standing: i16, // −32768..32767 quantization of −1..1 (relationship)
    pub flags: u8,     // bit0 hostile · bit1 believed building/place
    pub hops: u8,      // gossip provenance: 0 = first-hand (perceived), +1 each retelling (a rumor fades)
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

// ───────────────────────────── Wave-3 society / observer value types ─────────────────────────────

/// One world-history beat (the chronicle observer — `types/news.ts` Beat, numeric Wave-3 form; the
/// render-only text is generated later from these). Numeric so the determinism hash covers it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Beat {
    pub t: u32,
    pub kind: u8, // BeatKind: death|kill|raid|birth|faith|union|… (interned)
    pub subject: u32,
    pub magnitude: i32,
}

/// A quest-board entry (`types/news.ts`/`quest.ts`, Wave-3 numeric form). Completion detected from
/// ground truth each tick.
#[derive(Clone, Copy, Debug)]
pub struct Quest {
    pub kind: u8, // hunt|deliver|delve|bounty…
    pub target: u32,
    pub good: u8,
    pub count: u16,
    pub got: u16,
    pub reward: i64,
    pub giver: u32,
    pub expire: u32,
    pub done: bool,
}

/// The Night Watch institution's serial-phase state (hysteresis + captaincy). `js/sim/watch.ts`.
#[derive(Clone, Copy, Debug)]
pub struct WatchState {
    pub calm: u32,    // sim-ticks since the core was last threatened (the stand-down hysteresis clock)
    pub captain: i32, // current captain agent id (-1 = none / no watch). A change logs a beat.
}
impl Default for WatchState {
    fn default() -> Self {
        WatchState { calm: 0, captain: -1 }
    }
}

/// The watchtower ring's serial-phase tally. `js/sim/defenses.ts`.
#[derive(Clone, Copy, Debug, Default)]
pub struct DefenseState {
    pub shots: u32, // total tower shots fired (the TS `stats.shots`). Kills aren't tower-attributable
                    // (a tower's Strike lands a tick later in the merge), so only shots is tallied.
}

/// The wilderness-expedition subsystem's serial-phase state (`js/sim/expeditions.ts`). A roster of
/// companies currently afield + a throttle clock + a kill/triumph tally. SIMPLIFIED port: the
/// dungeon-delve substrate (teleport / `_descend` / `_endDelve`) is intentionally dropped (there is
/// no dungeon in the Rust port) — a company instead marches to a WILDERNESS ring, fights a few
/// spawned "horrors" there, and returns. Mirrors the TS `Expeditions` class fields.
#[derive(Clone, Debug, Default)]
pub struct ExpeditionState {
    pub acc: u32,                // ticks since the last formation attempt (the `_acc` throttle).
    pub last_form: u32,          // tick of the last company formed (the `_lastForm` cooldown clock).
    pub companies: Vec<Company>, // companies currently afield (the TS `active` list, captain-keyed).
    // telemetry — read by tests/inspection, never asserted on internally (the TS `stats`).
    pub mounted: u32,  // total companies ever formed.
    pub triumphs: u32, // returns with no fallen (and foes slain).
    pub losses: u32,   // returns with a fallen / a lost captain / a wiped company.
    pub slain: u32,    // total horrors slain across all expeditions.
}

/// One adventuring company afield. The captain leads followers whose `band_leader == captain`.
#[derive(Clone, Copy, Debug)]
pub struct Company {
    pub captain: u32,        // the captain agent id (leads the band).
    pub phase: u8,           // 0 out (marching to the wilds), 1 hunt (fighting horrors), 2 return.
    pub target: [f32; 2],    // the current march point (the wilderness ring, then home).
    pub started_at: u32,     // tick the company set out.
    pub hunt_until: u32,     // tick the hunt ends (timer) once in the wilds.
    pub kills_at0: u32,      // baseline horror-kill tally at muster (so the slain count is the delta).
    pub horrors: [i32; MAX_HORRORS], // spawned horror ids (-1 = empty slot).
    pub n_horrors: u8,       // how many horror slots are filled.
    pub members: [i32; MAX_COMPANY], // captain + followers (-1 = empty slot); stable for the run.
    pub n_members: u8,
}
impl Default for Company {
    fn default() -> Self {
        Company {
            captain: 0,
            phase: 0,
            target: [0.0, 0.0],
            started_at: 0,
            hunt_until: 0,
            kills_at0: 0,
            horrors: [-1; MAX_HORRORS],
            n_horrors: 0,
            members: [-1; MAX_COMPANY],
            n_members: 0,
        }
    }
}

/// Max horrors spawned per expedition (the `EXPEDITION.delveMonsters`/`huntMonsters` analogue).
pub const MAX_HORRORS: usize = 5;
/// Max company size (captain + up to `partySize-1` followers).
pub const MAX_COMPANY: usize = 6;

/// Number of relationship-trope kinds the trope engine cooldowns (`systems::tropes`).
pub const N_TROPES: usize = 18;

/// The relationship-trope engine's serial-phase cooldown/telemetry state (`js/sim/director/tropes.ts`).
#[derive(Clone, Copy, Debug)]
pub struct TropeState {
    pub last_any_at: u32,              // global one-trope-per-window clock (the TS `_lastTropeAt`)
    pub last_kind_at: [u32; N_TROPES], // per-kind cooldown clocks (the TS `_kindAt[flag]`)
    pub fires: u32,                    // telemetry: total relationship-tropes fired (read by tests)
}
impl Default for TropeState {
    fn default() -> Self {
        TropeState { last_any_at: u32::MAX, last_kind_at: [u32::MAX; N_TROPES], fires: 0 }
    }
}

pub const NO_BAND: i32 = -1; // band_leader sentinel (not in a band).
pub const NO_GOD: u8 = 0; // faith sentinel (no faith).

// ───────────────────────────── episodic memory (the goal-derivation source, §ToM) ─────────────────────────────
//
// The thin Rust analogue of `js/sim/memory.js` — a tiny, bounded, per-agent ring of salient episodes
// the GOAP layer reads to DERIVE intentions (an `assaulted` episode → an avenge goal; a `windfall` →
// seek-fortune). Inline/`Copy` so it streams like every other column. Written ONLY in serial phases
// (the intent merge stamps assault/slew; the director's serial society pass stamps windfall) ⇒
// deterministic; read (own-row only) in the parallel `decide`.

pub const MEMORY_CAP: usize = 8;

/// types/memory.ts MemoryKind (the Wave-4 GOAP subset). Numeric so the determinism hash covers it.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EpisodeKind {
    Assaulted = 0,      // `with` struck me — derives an avenge intention (the flagship vendetta seed)
    Slew = 1,           // I dealt `with` its death blow — the `_slain` marker that SETTLES an avenge
    Windfall = 2,       // a fortune to be had at `place` — derives a seek-fortune intention
    WitnessedDeath = 3, // saw `with` fall — a grief disposition (plan-less)
    Robbed = 4,         // I robbed `with` — the marker that SETTLES a steal intention (like Slew)
    Succoured = 5,      // `with` helped me while I was desperate — derives a repay intention
    Gave = 6,           // I gave to `with` — the marker that SETTLES a donate intention
    Looted = 7,         // I stripped `with`'s corpse — the marker that SETTLES a loot intention
    Freed = 8,          // I cut `with`'s bonds — the marker that SETTLES a rescue intention
}

/// One salient episode (the dense, inline memory cell).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Episode {
    pub kind: u8,
    pub place: u8,
    pub valence: i8,
    pub _pad: u8,
    pub with: u32,     // the other party (avenge culprit / slain victim / …); u32::MAX = none
    pub t: u32,        // sim-tick recorded (intention TTLs measure from here)
    pub salience: u16, // how vivid — drives eviction (the salient survive) + intention priority
    pub _pad2: u16,
}

/// A bounded per-agent episodic memory (the salient survive; the dull are evicted).
#[derive(Clone, Copy, Debug)]
pub struct Memory {
    pub len: u8,
    pub items: [Episode; MEMORY_CAP],
}
impl Default for Memory {
    fn default() -> Self {
        Memory { len: 0, items: [Episode::default(); MEMORY_CAP] }
    }
}
impl Memory {
    /// Record an episode. DEDUP by (kind, with): a fresh assault from the same foe REFRESHES the
    /// existing entry (no churn, no inflation). When full, evict the lowest-salience slot iff the
    /// newcomer is at least as salient (so the vivid survive). Serial-only ⇒ order-independent.
    pub fn record(&mut self, ep: Episode) {
        for k in 0..self.len as usize {
            let e = &mut self.items[k];
            if e.kind == ep.kind && e.with == ep.with {
                *e = ep;
                return;
            }
        }
        if (self.len as usize) < MEMORY_CAP {
            self.items[self.len as usize] = ep;
            self.len += 1;
            return;
        }
        let mut lo = 0usize;
        for k in 1..MEMORY_CAP {
            if self.items[k].salience < self.items[lo].salience {
                lo = k;
            }
        }
        if ep.salience >= self.items[lo].salience {
            self.items[lo] = ep;
        }
    }
    /// Do I hold an episode of `kind` about `with`? (the `_slain`/grief lookups.)
    #[inline]
    pub fn has(&self, kind: EpisodeKind, with: u32) -> bool {
        self.items[..self.len as usize].iter().any(|e| e.kind == kind as u8 && e.with == with)
    }
    /// The most SALIENT episode held — the agent's most vivid memory (`memory.js` salient()). Recency
    /// breaks ties (a fresh shock outweighs an old one of equal vividness) ⇒ order-independent.
    #[inline]
    pub fn salient(&self) -> Option<&Episode> {
        self.items[..self.len as usize]
            .iter()
            .max_by_key(|e| (e.salience, e.t))
    }
    /// STM/MTM/LTM tier of an episode by AGE (`memory.js` consolidation tiers): a fresh memory is
    /// short-term (0), an older one medium-term (1), the oldest long-term/consolidated (2).
    #[inline]
    pub fn tier(now: u32, ep_t: u32) -> u8 {
        const STM_AGE: u32 = 300; // recent ⇒ short-term
        const MTM_AGE: u32 = 1500; // then medium-term; beyond ⇒ long-term
        let age = now.saturating_sub(ep_t);
        if age <= STM_AGE {
            0
        } else if age <= MTM_AGE {
            1
        } else {
            2
        }
    }
}

// ───────────────────────────── the goal stack + plan cache (the GOAP skeleton, §motivation.js) ─────────────────────────────
//
// The faithful Rust port of the persistent goal stack (`agent.goals` + `pushGoal`/`pruneGoals`) and the
// cached plan (`_currentPlanStep`). Intentions PERSIST across ticks (a vendetta lasts), carry their own
// priority/expiry/flags, and dedup by identity — so the stack-dependent features later (oaths, caution,
// narrative-closure XP, arc resolution) have the persistent goal object they bolt onto. Inline/`Copy`.

/// types/goals.ts GoalKind for the STACK layer (the intentions deriveGoals pushes). Distinct from the
/// executor `GoalKind` (the active locomotion goal) — these are the agent's standing INTENTIONS.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IntentionKind {
    Avenge = 0,      // hunt a culprit down (from an `assaulted` memory) — predicate: believed-dead
    SeekFortune = 1, // raise gold to a target (from a `windfall` memory) — predicate: gold ≥ target
    Repay = 2,       // discharge a debt to a benefactor (from `succoured`) — predicate: delivered
    Grieve = 3,      // plan-less mourning (from `witnessed_death`) — pops on expiry only
    Wary = 4,        // plan-less wariness disposition (from `survived`) — pops on expiry
    Glory = 5,       // plan-less return-to-glory pull (from `triumph`) — pops on expiry
    Shun = 6,        // plan-less shame-avoidance (from `forsworn`) — pops on expiry
    Delve = 7,       // venture to a place (from `relic`) — pops on expiry/relic flag
    Steal = 8,       // rob a believed-rich mark (the urchin heist) — predicate: robbed/gold target
    Defend = 9,      // a brave soul fights a believed-hostile threatening a believed-friend (Dead pred)
    Donate = 10,     // a wealthy altruist gives to a believed-poor neighbour (alms) — pred: gave marker
    Sate = 11,       // a hungry, foodless soul forages/buys a meal (subsistence) — pred: holds food
    Loot = 12,       // strip a slain foe's purse (from a `slew` memory) — pred: looted marker
    Rescue = 13,     // free a believed-captive friend (cut their bonds) — pred: freed marker
    Know = 14,       // LEARN a topic (firm an own-craft recipe) — the `goalLearn` goal-stack abstraction
}

pub const NONE_ID: u32 = u32::MAX;

/// ECONOMIC TELEMETRY (`econstats.ts`): observer counters accumulated from the trade merge — total
/// trades cleared, units moved, gold that changed hands, and per-good volume. Read by diagnostics /
/// the render layer; never drives a decision. Folded serially ⇒ deterministic.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct EconStats {
    pub trades: u64,                        // trades cleared
    pub volume: u64,                        // total units traded
    pub gold_flowed: u64,                   // gold (minor units) moved across trades
    pub good_volume: [u64; N_COMMODITIES],  // units traded per commodity
}

/// Number of strategy slots in the caution store — one per planner verb id (the v1 `expKey` is the
/// primitive NAME, and the verbs are a small closed set, so a fixed array indexed by verb id replaces
/// the TS `Map` with no HashMap-order non-determinism). See `experience.rs` (docs/architecture/11).
pub const N_STRAT: usize = 12;

/// One strategy's learned caution record (the belief-table shape: signed surcharge / last-write time /
/// write count). `s` > 0 = burned (this strategy feels dearer); `s` < 0 = emboldened by success.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct ActExp {
    pub s: f32,  // signed surcharge (decayed lazily toward 0)
    pub t: u32,  // sim-tick of last write (for lazy half-life decay)
    pub n: u16,  // write count (diminishing-windfall input)
    pub _pad: u16,
}

/// The per-agent outcome-conditioned caution store (doc 11): a signed surcharge per STRATEGY (verb),
/// written when a watched act falls short / is wasted / turns perilous, eroded by time and success,
/// and read inside the planner's `cost`. NATURE stays fixed — this never touches `Personality`.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Experience {
    pub e: [ActExp; N_STRAT], // indexed by planner verb id
}
impl Default for Experience {
    fn default() -> Self {
        Self { e: [ActExp::default(); N_STRAT] }
    }
}

/// One standing intention on the goal stack (the persistent goal object). Mirrors the TS Goal's
/// kind/subjectId/place/priority/expiresAt/bornAt/flags; `atoms`/`predicate` are dispatched by `kind`.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Intention {
    pub kind: u8,       // IntentionKind
    pub flags: u8,      // bit0 unreachable, bit1 xp_awarded, bit2 hardened (lifelong vendetta)
    pub priority: u16,  // quantized 0..1 ×1000 (arbitration order)
    pub subject: u32,   // EntityId the intention is about (NONE_ID = none)
    pub place: u8,      // POI/place id (0 = none)
    pub _pad: [u8; 3],
    pub amt: i64,       // gold target / level threshold
    pub born: u32,      // tick the intention was first pushed (TTL + min-age gates measure from here)
    pub expire: u32,    // tick it cools out (0 = never — a hardened vendetta)
}
impl Intention {
    pub const F_UNREACHABLE: u8 = 0x01;
    pub const F_XP_AWARDED: u8 = 0x02;
    pub const F_HARDENED: u8 = 0x04;
    /// Identity for dedup/refresh (kind + subject + place) — `pushGoal`'s dedup key.
    #[inline]
    pub fn ident(&self) -> (u8, u32, u8) {
        (self.kind, self.subject, self.place)
    }
}

/// Hard cap on stacked intentions (mirrors `PLAN.stackDepth`; LIFO, lowest-priority dropped when full).
pub const GOAL_STACK_CAP: usize = 4;

/// The per-agent persistent intention stack.
#[derive(Clone, Copy, Debug)]
pub struct GoalStack {
    pub len: u8,
    pub items: [Intention; GOAL_STACK_CAP],
}
impl Default for GoalStack {
    fn default() -> Self {
        GoalStack {
            len: 0,
            items: [Intention {
                kind: 0,
                flags: 0,
                priority: 0,
                subject: NONE_ID,
                place: 0,
                _pad: [0; 3],
                amt: 0,
                born: 0,
                expire: 0,
            }; GOAL_STACK_CAP],
        }
    }
}
impl GoalStack {
    /// Push (or REFRESH) an intention. Dedup by `ident()`: a repeat refreshes the existing entry's
    /// expiry/priority (idempotent re-derivation — the whole point of the persistent stack). When full,
    /// evict the lowest-priority incumbent iff the newcomer outranks it. Returns true if it landed.
    pub fn push(&mut self, it: Intention) -> bool {
        for k in 0..self.len as usize {
            if self.items[k].ident() == it.ident() {
                // refresh: keep the EARLIER born (so min-age/closure gates see the true age), keep a
                // hardened flag, take the longer expiry + higher priority.
                let cur = &mut self.items[k];
                cur.priority = cur.priority.max(it.priority);
                cur.flags |= it.flags & Intention::F_HARDENED;
                cur.expire = if cur.expire == 0 || it.expire == 0 { 0 } else { cur.expire.max(it.expire) };
                cur.amt = it.amt;
                return true;
            }
        }
        if (self.len as usize) < GOAL_STACK_CAP {
            self.items[self.len as usize] = it;
            self.len += 1;
            return true;
        }
        // full: replace the lowest-priority incumbent if we outrank it.
        let mut lo = 0usize;
        for k in 1..GOAL_STACK_CAP {
            if self.items[k].priority < self.items[lo].priority {
                lo = k;
            }
        }
        if it.priority > self.items[lo].priority {
            self.items[lo] = it;
            return true;
        }
        false
    }
    /// The highest-priority intention (arbitration winner), with deterministic tie-break by
    /// (kind, subject) so the choice is order-independent. Returns the index.
    pub fn top_idx(&self) -> Option<usize> {
        let mut best: Option<usize> = None;
        for k in 0..self.len as usize {
            best = Some(match best {
                None => k,
                Some(b) => {
                    let (p, q) = (&self.items[k], &self.items[b]);
                    if p.priority > q.priority
                        || (p.priority == q.priority && (p.kind, p.subject) < (q.kind, q.subject))
                    {
                        k
                    } else {
                        b
                    }
                }
            });
        }
        best
    }
    /// Remove the intention at `idx` (compacting swap-removal preserves determinism — order is
    /// re-derived from `top_idx`, never positional).
    pub fn remove(&mut self, idx: usize) {
        let n = self.len as usize;
        if idx >= n {
            return;
        }
        for k in idx..n - 1 {
            self.items[k] = self.items[k + 1];
        }
        self.len -= 1;
    }
}

/// One compiled plan step (serializable — the persistent cached plan a feature's caution trail attaches
/// to). `verb`/`place_kind` are interned; the executor systems read the compiled `Goal`, this is the
/// planner's own bookkeeping for cursor-advance + replan detection.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PlanStep {
    pub verb: u8,       // planner Verb (goto/gather/produce/buy/sell/approach/attack/…)
    pub place_kind: u8, // 0 market, 1 node(good), 2 subject
    pub good: u8,       // commodity for node/gather/produce/buy/sell
    pub _pad: u8,
    pub subject: u32, // subject for approach/attack/subject-place (NONE_ID = none)
    pub n: u16,
    pub _pad2: u16,
}

/// Hard cap on emitted plan length (mirrors `PLAN.maxPlan`).
pub const PLAN_CAP: usize = 8;

/// The per-agent cached plan toward the top intention. Re-used across ticks (cursor advances as each
/// step's effect lands); rebuilt only when the served goal changes or the plan is exhausted/infeasible.
#[derive(Clone, Copy, Debug)]
pub struct Plan {
    pub len: u8,
    pub cur: u8,           // cursor — the step being executed now
    pub goal_kind: u8,     // which IntentionKind this plan serves (replan trigger; 0xFF = no plan)
    pub goal_subject: u32, // and its subject (replan trigger)
    pub steps: [PlanStep; PLAN_CAP],
}
impl Default for Plan {
    fn default() -> Self {
        Plan {
            len: 0,
            cur: 0,
            goal_kind: 0xFF,
            goal_subject: NONE_ID,
            steps: [PlanStep::default(); PLAN_CAP],
        }
    }
}
impl Plan {
    /// Does this cached plan still serve intention `(kind, subject)` and have an un-executed step left?
    #[inline]
    pub fn serves(&self, kind: u8, subject: u32) -> bool {
        self.goal_kind == kind && self.goal_subject == subject && (self.cur as usize) < self.len as usize
    }
    /// The current (cursor) step, if any.
    #[inline]
    pub fn current(&self) -> Option<PlanStep> {
        if (self.cur as usize) < self.len as usize {
            Some(self.steps[self.cur as usize])
        } else {
            None
        }
    }
    /// Discard the cached plan (force a replan next visit).
    #[inline]
    pub fn clear(&mut self) {
        self.len = 0;
        self.cur = 0;
        self.goal_kind = 0xFF;
        self.goal_subject = NONE_ID;
    }
}

// ───────────────────────────── director (the drama manager) ─────────────────────────────
//
// The persistent budget/pacing state of the points-budget trope engine (the Rust analogue of the
// `js/sim/director/*` cluster — ported to its SPIRIT, not its 20 tropes). Mutated only in the SERIAL
// society phase ⇒ trivially deterministic; rolls come from `World::sim_rng`.

#[derive(Clone, Copy, Debug)]
pub struct DirectorState {
    pub points: i64,        // drama BUDGET — accrues with prosperity, drained by deaths, spent on tropes
    pub tension: f32,       // peril gauge (living attacker count); a high peak that resolves opens relief
    pub relief_until: u32,  // tick until which new drama is suppressed (the post-peak breather)
    pub last_trope_at: u32, // any-trope cooldown clock
    pub last_raid_at: u32,  // raid-specific cooldown clock
    pub last_pop: i32,      // last sampled town population (-1 = unsampled; death-detection + accrual)
    pub had_threat: bool,   // tension was at/above the peak last eval (peak-resolved detector)
    // telemetry — read by tests/inspection, never asserted on internally.
    pub raids: u32,
    pub feuds: u32,
    pub opportunities: u32,
    pub crises: u32,
}
impl Default for DirectorState {
    fn default() -> Self {
        DirectorState {
            points: 0,
            tension: 0.0,
            relief_until: 0,
            last_trope_at: 0,
            last_raid_at: 0,
            last_pop: -1,
            had_threat: false,
            raids: 0,
            feuds: 0,
            opportunities: 0,
            crises: 0,
        }
    }
}

// ───────────────────────────── narrative-signal catalog (§ js/sim/signals.ts, docs/architecture/13) ─────────────────────────────
//
// The dense, inline Rust analogue of the per-agent `_signals` record (`js/sim/signals.ts`). The TS
// stores it as a lazily-created bag of JS Maps/arrays per agent; here it is ONE inline `Copy` struct
// in a dense column (the determinism mandate — no HashMap in the read surface). It holds the bounded,
// EVENT-FOLDED values the observer layer measures so probes (the status sensor, the Gazette, future
// tropes) have something to read. This is a LIBRARY of fold/sample/read functions over this struct
// (see `signals.rs`), CALLED by other systems — not itself a tick system.
//
// Determinism divergence vs TS (the allowed kind, per the port bar): the TS keeps `Record<reason,…>`
// maps + a `loss[]` array of objects + a `dwell` Record; here those become fixed-size inline arrays
// indexed by interned enums (LossReason, DeedTag, OathKind, StreakKey). EWMAs are f32 (the TS uses
// JS doubles); the half-life math is the same `g + (prev−g)·0.5^(dt/H)` shape.

/// Loss-reason taxonomy (the TS `reason` string, interned). Involuntary causes (robbed/fined) are
/// the ones the RUIN detector requires; voluntary (spent/gifted) must NOT read as catastrophe.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LossReason {
    Spent = 0,  // voluntary — a purchase / market clear
    Gifted = 1, // voluntary — a give/pay
    Robbed = 2, // INVOLUNTARY — taken by force
    Fined = 3,  // INVOLUNTARY — a penalty
}
pub const N_LOSS_REASONS: usize = 4;

/// Deed-tally tags (the TS `_deeds` Record key, interned). The TRUTH side of witnessDeed / the combat
/// fold (Family E) — feeds epithets, obituaries, esteemTruthGap. Kept tiny + fixed.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeedTag {
    Theft = 0,
    Kill = 1,
    Rescue = 2,
    Gift = 3,
    Free = 4,
}
pub const N_DEED_TAGS: usize = 5;

/// Oath-kind taxonomy (the TS `_oaths` Record key — the narrative-weight goals, Family E). "a man of
/// his word" measured: sworn vs kept vs abandoned per kind.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OathKind {
    Avenge = 0,
    Repay = 1,
    Court = 2,
    Rescue = 3,
}
pub const N_OATH_KINDS: usize = 4;

/// Streak-strategy taxonomy (the TS `_streak` Record key — the watched strategies a PLAN_OUTCOME folds
/// "third failed heist in a row" onto, Family A). Fixed small vocabulary.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StreakKey {
    Heist = 0,
    Hunt = 1,
    Trade = 2,
    Duel = 3,
}
pub const N_STREAK_KEYS: usize = 4;

/// Outcome-status of a watched act (the TS `status` string a streak runs on).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OutcomeStatus {
    None = 0,
    Ok = 1,
    Fail = 2,
    Wasteful = 3,
    Peril = 4,
}

/// Gold band for `timeInBand` (Family A — endurance stories need DURATION, not just crossings).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Band {
    Poor = 0,
    Rich = 1,
    Outlaw = 2,
}
pub const N_BANDS: usize = 3;

/// Bound on the ringed tagged-loss steps (mirrors `SIGNALS.lossRing`).
pub const LOSS_RING: usize = 8;

/// One tagged downward-gold step (the TS `LossStep`, inline). `reason` is interned; `t` measures the
/// window in `lossReasonShare`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct LossStep {
    pub reason: u8, // LossReason
    pub _pad: u8,
    pub _pad2: u16,
    pub t: u32,
    pub amt: i64, // gold (minor units) lost in this step
}

/// One deed tally (the TS `DeedTally` — count + first/last sim-time). `first` is the corruption-
/// measured-from-firstTheft beat; `last` the recency.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct DeedTally {
    pub n: u32,
    pub first: u32,
    pub last: u32,
    pub _pad: u32,
}

/// One oath tally (the TS `OathTally` — sworn vs kept vs abandoned).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct OathTally {
    pub sworn: u16,
    pub kept: u16,
    pub abandoned: u16,
    pub _pad: u16,
}

/// One streak run (the TS `StreakState` — current status + consecutive run length).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct StreakState {
    pub status: u8, // OutcomeStatus
    pub _pad: u8,
    pub run: u16, // consecutive same-status outcomes
}

/// The per-agent narrative-signal record (the inline `Copy` analogue of the TS `_signals` bag + the
/// `_deeds`/`_oaths`/`_streak`/`_perils` tallies that lived on the agent). One dense column row.
#[derive(Clone, Copy, Debug)]
pub struct Signals {
    // ── Family A: gold two-timescale EWMA (sampleGold / goldTrend) ──
    pub g_fast: f32,
    pub g_slow: f32,
    pub g_t: u32, // last gold-sample sim-tick
    pub g_inited: bool,

    // ── Family A: tagged downward-gold ring (foldLoss / lossReasonShare) ──
    pub loss: [LossStep; LOSS_RING],
    pub loss_len: u8,
    pub loss_head: u8, // ring write cursor (oldest is evicted when full)

    // ── Family A: standing EWMA + fortuneReversals (sampleStanding / standingTrend / fortuneReversals) ──
    pub s_fast: f32,
    pub s_slow: f32,
    pub s_t: u32,
    pub s_inited: bool,
    pub rev_n: u32,    // fortune-reversal count (gold fast−slow sign flips past the gate)
    pub rev_t: u32,    // last reversal sim-tick
    pub last_sign: i8, // last (g_fast−g_slow) sign (0 = none yet)

    // ── Family A: displacement EWMA (sampleDisplacement / displacement) ──
    pub disp: f32,
    pub disp_t: u32,
    pub disp_inited: bool,

    // ── Family A: timeInBand accumulators (accrueBand / timeInBand) ──
    pub band: [f32; N_BANDS], // seconds in poor / rich / outlaw
    pub band_t: u32,
    pub band_inited: bool,

    // ── Family E: deed tally (foldDeed / deedCount / firstDeedAt) ──
    pub deeds: [DeedTally; N_DEED_TAGS],

    // ── Family E: oath tally (foldOathSworn / foldOathPop / oaths) ──
    pub oaths: [OathTally; N_OATH_KINDS],

    // ── Family A: streak (foldStreak / streakOf) + peril count (foldPeril / perilsSurvived) ──
    pub streak: [StreakState; N_STREAK_KEYS],
    pub perils: u32,
}
impl Default for Signals {
    fn default() -> Self {
        Signals {
            g_fast: 0.0,
            g_slow: 0.0,
            g_t: 0,
            g_inited: false,
            loss: [LossStep::default(); LOSS_RING],
            loss_len: 0,
            loss_head: 0,
            s_fast: 0.0,
            s_slow: 0.0,
            s_t: 0,
            s_inited: false,
            rev_n: 0,
            rev_t: 0,
            last_sign: 0,
            disp: 0.0,
            disp_t: 0,
            disp_inited: false,
            band: [0.0; N_BANDS],
            band_t: 0,
            band_inited: false,
            deeds: [DeedTally::default(); N_DEED_TAGS],
            oaths: [OathTally::default(); N_OATH_KINDS],
            streak: [StreakState::default(); N_STREAK_KEYS],
            perils: 0,
        }
    }
}

/// Per-agent biographical summary (the `js/sim/biography.js` observer — a who-they-were/what-drove-them
/// rollup the chronicle UI surfaces). Pure OBSERVER telemetry: a throttled pass folds the agent's own
/// already-tracked state (peak level, earned epithet, arc role, dominant deed, drive) into one compact
/// numeric row — the render layer turns it into prose later. Monotone where it should be (peak level
/// only rises; the deed total only accrues) so a life reads as a cumulative arc, not a snapshot.
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Biography {
    pub peak_level: u8,    // the highest level the agent ever reached
    pub epithet: u8,       // the earned title (0 none / 1 hero / 2 villain / 3 survivor)
    pub role: u8,          // the institutional/arc role at last assessment
    pub drive: u8,         // the archetypal ambition code (AMB_*)
    pub dominant_deed: u8, // the DeedTag the agent has done MOST (0xFF = no notable deed yet)
    pub deed_total: u16,   // cumulative count of notable deeds (peak over the life)
    pub defining_moment: u8, // the EpisodeKind of the agent's most SALIENT memory (its defining event)
    pub stm: u8,           // how many memories sit in the short-term tier right now (recency texture)
}
