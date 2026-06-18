//! The ability DSL (port of `js/rpg/abilities/{ir,catalog,interpreter,effects}.ts`).
//!
//! An `AbilitySpec` is the single source of truth — DATA, never code, never eval'd (`ir.ts`). The
//! catalog ports all 12 hand-authored specs as `const` data; `CLASS_MILESTONES` maps a granted class
//! at a level to its ability; a SIMPLIFIED interpreter (`cast`) runs once per tick as a parallel
//! own-write phase: an NPC holding a known OFFENSIVE ability with a believed-hostile in range emits an
//! EXTRA `Intent::Strike` for the ability's damage (block/expose kept simple), and a self-targeted
//! heal/shield own-writes the caster's own `combat[i]` row. Cross-agent damage stays on the intent
//! merge (never a direct write to another agent's column) — the determinism contract.
//!
//! WHAT'S SIMPLIFIED vs JS (noted breadth): no real cooldown ledger (a per-spec `cooldown` field is
//! carried + a per-agent timer gates re-casts), no projectile travel (ranged lands same tick like the
//! combat melee), no AoE multi-target (the strongest single offensive ability fires at one believed
//! foe), and the social/economy ops (plant_belief/scry/trade_edge/craft_boost) + control ops
//! (stun/slow/knockback/expose) are carried in the IR + validated but NOT executed by the headless
//! autocaster (no player keys headless; those ops are belief/economy-layer effects the NPC autopilot
//! doesn't drive). Heal + shield (self) ARE executed. See the per-section notes.
//!
//! DETERMINISM: `cast` is per-agent own-write (advances own `combat[i]`/`ability_cd[i]`, reads own
//! beliefs only) and emits intents collected in id order; the cross-agent damage is the serial merge.
//! M=1 ≡ M=N holds. Randomness, if any, would draw from `rng[i]` only (the autocaster is deterministic
//! without it — it fires whenever ready + in range).

use rayon::prelude::*;

use crate::components::{BeliefTable, FighterState};
use crate::intent::Intent;
use crate::tags::Tag;
use crate::world::World;

/// A cast deed: the action carries the ability's own tag plus `Cast` (believed == truth for a cast).
#[inline]
fn cast_deed(actor: u32, target: u32, magnitude: u16, grants_tag: u8) -> Intent {
    let truth = (1u64 << grants_tag) | Tag::Cast.bit();
    Intent::Deed { actor, target, magnitude, truth, believed: truth, motive: 0, outcome: crate::tags::outcome::SUCCESS }
}

// ───────────────────────────── the IR (port of `ir.ts`) ─────────────────────────────

/// The effect op (`EffectOp` whitelist in `ir.ts`). Numeric so a spec is `Copy`/inline.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EffectOp {
    Damage = 0,
    Heal = 1,
    Stun = 2,
    Slow = 3,
    Knockback = 4,
    Dash = 5,
    Shield = 6,
    Expose = 7,
    PlantBelief = 8,
    Scry = 9,
    TradeEdge = 10,
    CraftBoost = 11,
}
impl EffectOp {
    /// Ops that affect the CASTER regardless of the foe list (`CASTER_OPS` in `interpreter.ts`).
    #[inline]
    pub fn is_caster_op(self) -> bool {
        matches!(
            self,
            EffectOp::Heal | EffectOp::Shield | EffectOp::Dash | EffectOp::TradeEdge | EffectOp::CraftBoost
        )
    }
    /// Ops that HARM a target — never applied to allies (`HOSTILE_OPS` friendly-fire guard).
    #[inline]
    pub fn is_hostile_op(self) -> bool {
        matches!(
            self,
            EffectOp::Damage | EffectOp::Stun | EffectOp::Slow | EffectOp::Knockback | EffectOp::Expose
        )
    }
}

/// The area footprint kind (`AreaKind`). `r`/`deg`/`len` ride on the spec's area fields.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AreaKind {
    SelfArea = 0, // 'self' — no AoE footprint (single-target / self-buff)
    Circle = 1,
    Cone = 2,
    Line = 3,
}

/// Projectile/zone delivery (`DeliveryKind`). The headless autocaster lands ranged same-tick (no
/// projectile travel — a noted simplification), but the kind is carried + validated.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeliveryKind {
    Instant = 0,
    Projectile = 1,
    Zone = 2,
}

/// Who the range scan considers (`TargetKind`).
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TargetKind {
    SelfTarget = 0,
    Enemy = 1,
    Ally = 2,
    Any = 3,
}

/// Effect trigger gate (`Trigger`). `None` = unconditional.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    None = 0,
    OnHit = 1,
    OnKill = 2,
    TargetHpBelow = 3,
    CasterHpBelow = 4,
}

/// Hard numeric ceilings (`LIMITS` in `ir.ts`) — `validate` rejects out-of-bounds specs.
pub mod limits {
    pub const AMOUNT: f32 = 200.0;
    pub const DUR: f32 = 12.0;
    pub const RANGE: f32 = 30.0;
    pub const COOLDOWN: f32 = 120.0;
    pub const CAST_TIME: f32 = 6.0;
    pub const AREA_R: f32 = 14.0;
    pub const SPEED: f32 = 60.0;
    pub const EFFECTS: usize = 6;
}

/// Max effects carried inline per spec (mirrors `LIMITS.effects` cap; every catalog spec has ≤ 2).
pub const MAX_EFFECTS: usize = limits::EFFECTS;

/// One IR effect (`AbilityEffect` + `Trigger` + flavour `tags`). Inline/`Copy`. `tags` is reduced to
/// a single optional behaviour `Tag` (the flavour tags the cast deed contributes; the JS carries a
/// list, but the deed-fold only needs the behaviour identity — `grants_tag` on the spec covers it).
#[derive(Clone, Copy, Debug)]
pub struct Effect {
    pub op: EffectOp,
    pub amount: f32,
    pub dur: f32,
    pub chance: f32,
    pub when: Trigger,
}
impl Effect {
    /// Terse constructor with `ir.ts effect()` defaults (chance 1, no trigger).
    pub const fn new(op: EffectOp, amount: f32) -> Effect {
        Effect { op, amount, dur: 0.0, chance: 1.0, when: Trigger::None }
    }
    pub const fn with_dur(mut self, dur: f32) -> Effect {
        self.dur = dur;
        self
    }
    pub const fn with_when(mut self, when: Trigger) -> Effect {
        self.when = when;
        self
    }
}

/// The header (`AbilityHeader`) folded inline onto the spec.
#[derive(Clone, Copy, Debug)]
pub struct Header {
    pub target: TargetKind,
    pub range: f32,
    pub cooldown: f32,
    pub cast_time: f32,
    pub area: AreaKind,
    pub area_r: f32,   // circle/cone radius or line length (0 for self)
    pub area_deg: f32, // cone angle (0 otherwise)
    pub delivery: DeliveryKind,
    pub delivery_speed: f32, // projectile speed / zone radius (0 for instant)
}

/// A validated, DATA-ONLY ability (`AbilitySpec`). Fully inline/`Copy` — the catalog is `const`.
/// `id` is the catalog index (the interned ability id headless; the player-key UI is N/A). `class_key`
/// is the NUMERIC Rust class id (`systems::progression` TEMPLATES key) the ability belongs to, or
/// `NO_CLASS` for the JS classes with no Rust template (brawler/trickster — noted breadth).
#[derive(Clone, Copy, Debug)]
pub struct AbilitySpec {
    pub id: u16,
    pub class_key: u8,
    pub tier: u8,
    pub header: Header,
    pub n_effects: u8,
    pub effects: [Effect; MAX_EFFECTS],
    pub grants_tag: Tag, // the dominant behaviour tag the cast contributes (the deed verb)
}

impl AbilitySpec {
    /// The effects actually present.
    #[inline]
    pub fn effects(&self) -> &[Effect] {
        &self.effects[..self.n_effects as usize]
    }

    /// The spec's primary damage (the first `damage` effect's amount, else 0) — `damageOf`.
    #[inline]
    pub fn damage_of(&self) -> f32 {
        for e in self.effects() {
            if e.op == EffectOp::Damage {
                return e.amount;
            }
        }
        0.0
    }

    /// Is this a self-heal/shield ability the autocaster should self-cast (any caster-op effect with
    /// a self target)? Used to drive the self-buff own-write branch.
    #[inline]
    pub fn is_self_support(&self) -> bool {
        self.header.target == TargetKind::SelfTarget
            && self.effects().iter().any(|e| matches!(e.op, EffectOp::Heal | EffectOp::Shield))
    }

    /// Is this an offensive ability the autocaster should fire at a believed-hostile (an enemy-target
    /// spec carrying a `damage` effect)? `read_mind`/`silver_tongue`/`haggle`/`master_craft` are not.
    #[inline]
    pub fn is_offensive(&self) -> bool {
        self.header.target == TargetKind::Enemy && self.damage_of() > 0.0
    }

    /// Is this a pure DEBUFF — an enemy-target ability with NO damage but a control op (stun/slow/expose/
    /// knockback)? The autocaster casts it to soften a believed hostile (expose_weakness's combo setup).
    #[inline]
    pub fn is_debuff(&self) -> bool {
        self.header.target == TargetKind::Enemy
            && self.damage_of() == 0.0
            && self.effects().iter().any(|e| {
                matches!(
                    e.op,
                    EffectOp::Stun | EffectOp::Slow | EffectOp::Knockback | EffectOp::Expose
                )
            })
    }

    /// Is this a SOCIAL ability the autocaster should cast at a nearby agent — a non-damaging spec
    /// carrying a `plant_belief` effect (silver_tongue charm / plant_rumor deceit / haggle)? The op that
    /// reaches into the epistemic layer: it shifts how the target REGARDS the caster.
    #[inline]
    pub fn is_social(&self) -> bool {
        self.damage_of() == 0.0 && self.effects().iter().any(|e| e.op == EffectOp::PlantBelief)
    }

    /// Is this a SCRY ability (read_mind) — a spec carrying a `scry` effect? The autocaster casts it to
    /// firm up its vaguest belief from the truth (an ability-sanctioned reveal).
    #[inline]
    pub fn is_scry(&self) -> bool {
        self.effects().iter().any(|e| e.op == EffectOp::Scry)
    }

    /// Is this a CRAFT-BOOST ability (master_craft) — a spec carrying a `craft_boost` effect? The
    /// autocaster fires it as a self-buff: an immediate burst of the crafter's trade-good.
    #[inline]
    pub fn is_craft_boost(&self) -> bool {
        self.effects().iter().any(|e| e.op == EffectOp::CraftBoost)
    }

    /// The first `plant_belief` effect's amount (the charm/deceit magnitude), else 0 — `plantOf`.
    #[inline]
    pub fn plant_of(&self) -> f32 {
        for e in self.effects() {
            if e.op == EffectOp::PlantBelief {
                return e.amount;
            }
        }
        0.0
    }

    /// True if this ability "rides the swing" (melee): enemy-targeted, instant, non-circle, short reach
    /// (`isMelee` in `ir.ts`). The autocaster treats melee + ranged offensives the same (both emit a
    /// Strike); the flag is kept for parity/inspection.
    #[inline]
    pub fn is_melee(&self) -> bool {
        self.header.target == TargetKind::Enemy
            && self.header.delivery == DeliveryKind::Instant
            && self.header.area != AreaKind::Circle
            && self.header.range <= 3.0
    }

    /// The WHITELIST trust boundary (`ir.validate`). A well-formed, in-bounds, data-only spec.
    /// (The Rust IR is already type-safe — the enums ARE the whitelist — so `validate` is the numeric
    /// bounds + structural check: range/cooldown/cast/area/delivery/effect magnitudes + at least one
    /// effect, capped.)
    pub fn validate(&self) -> bool {
        let h = &self.header;
        if !in_range(h.range, 0.0, limits::RANGE) {
            return false;
        }
        if !in_range(h.cooldown, 0.0, limits::COOLDOWN) {
            return false;
        }
        if !in_range(h.cast_time, 0.0, limits::CAST_TIME) {
            return false;
        }
        // area bounds
        match h.area {
            AreaKind::Circle => {
                if !in_range(h.area_r, 0.0, limits::AREA_R) {
                    return false;
                }
            }
            AreaKind::Cone => {
                if !in_range(h.area_r, 0.0, limits::AREA_R) || !in_range(h.area_deg, 0.0, 360.0) {
                    return false;
                }
            }
            AreaKind::Line => {
                if !in_range(h.area_r, 0.0, limits::AREA_R) {
                    return false;
                }
            }
            AreaKind::SelfArea => {}
        }
        // delivery bounds
        match h.delivery {
            DeliveryKind::Projectile => {
                if !in_range(h.delivery_speed, 0.0, limits::SPEED) {
                    return false;
                }
            }
            DeliveryKind::Zone => {
                if !in_range(h.delivery_speed, 0.0, limits::AREA_R) {
                    return false;
                }
            }
            DeliveryKind::Instant => {}
        }
        // effects: 1..=LIMITS.effects, each in bounds.
        let n = self.n_effects as usize;
        if n == 0 || n > limits::EFFECTS {
            return false;
        }
        for e in self.effects() {
            if !in_range(e.amount, -limits::AMOUNT, limits::AMOUNT) {
                return false;
            }
            if !in_range(e.dur, 0.0, limits::DUR) {
                return false;
            }
            if !in_range(e.chance, 0.0, 1.0) {
                return false;
            }
        }
        true
    }
}

#[inline]
fn in_range(x: f32, lo: f32, hi: f32) -> bool {
    x.is_finite() && x >= lo && x <= hi
}

// ───────────────────────────── the catalog (port of `catalog.ts`) ─────────────────────────────
//
// The 12 hand-authored specs as `const` data. `id` is the index into `CATALOG`. `class_key` is the
// NUMERIC Rust class id from `systems::progression` TEMPLATES (warrior 0, blacksmith 4, merchant 5,
// speaker 7, hunter 8). The JS `brawler`/`trickster` classes have NO Rust template, so their specs
// (whirlwind/cleaving_blow/read_mind/plant_rumor) carry `NO_CLASS` — present + validated but not
// milestone-reachable in the current Rust class set (noted breadth).

use crate::components::NO_CLASS;

// numeric class keys (mirror `systems::progression` TEMPLATES order).
const CK_WARRIOR: u8 = 0;
const CK_BLACKSMITH: u8 = 4;
const CK_MERCHANT: u8 = 5;
const CK_SPEAKER: u8 = 7;
const CK_HUNTER: u8 = 8;

// stable ability ids = CATALOG indices.
pub const ID_POWER_STRIKE: u16 = 0;
pub const ID_LUNGE: u16 = 1;
pub const ID_WHIRLWIND: u16 = 2;
pub const ID_SECOND_WIND: u16 = 3;
pub const ID_CLEAVING_BLOW: u16 = 4;
pub const ID_SILVER_TONGUE: u16 = 5;
pub const ID_PLANT_RUMOR: u16 = 6;
pub const ID_READ_MIND: u16 = 7;
pub const ID_HAGGLE: u16 = 8;
pub const ID_MASTER_CRAFT: u16 = 9;
pub const ID_FROST_BOLT: u16 = 10;
pub const ID_EXPOSE_WEAKNESS: u16 = 11;

/// Sentinel "no ability" id for empty known-ability slots.
pub const NO_ABILITY: u16 = u16::MAX;

const NO_EFFECT: Effect = Effect::new(EffectOp::Damage, 0.0);

/// Build a spec with up to two effects, padding the inline array. `const`-friendly.
const fn mk(
    id: u16,
    class_key: u8,
    tier: u8,
    header: Header,
    effects: &[Effect],
    grants_tag: Tag,
) -> AbilitySpec {
    let mut arr = [NO_EFFECT; MAX_EFFECTS];
    let n = effects.len();
    // const fn: manual copy of the (≤2) effects.
    let mut i = 0;
    while i < n {
        arr[i] = effects[i];
        i += 1;
    }
    AbilitySpec { id, class_key, tier, header, n_effects: n as u8, effects: arr, grants_tag }
}

const fn hdr(
    target: TargetKind,
    range: f32,
    cooldown: f32,
    area: AreaKind,
    area_r: f32,
    area_deg: f32,
    delivery: DeliveryKind,
    delivery_speed: f32,
) -> Header {
    Header { target, range, cooldown, cast_time: 0.0, area, area_r, area_deg, delivery, delivery_speed }
}

/// The 12-spec catalog (`ABILITY_CATALOG`), index = ability id.
pub static CATALOG: [AbilitySpec; 12] = [
    // power_strike — warrior t1: enemy melee, 46 dmg.
    mk(
        ID_POWER_STRIKE, CK_WARRIOR, 1,
        hdr(TargetKind::Enemy, 2.6, 5.0, AreaKind::SelfArea, 0.0, 0.0, DeliveryKind::Instant, 0.0),
        &[Effect::new(EffectOp::Damage, 46.0)],
        Tag::Melee,
    ),
    // lunge — warrior t2: dash + 34 pierce.
    mk(
        ID_LUNGE, CK_WARRIOR, 2,
        hdr(TargetKind::Enemy, 2.8, 7.0, AreaKind::SelfArea, 0.0, 0.0, DeliveryKind::Instant, 0.0),
        &[Effect::new(EffectOp::Dash, 3.0), Effect::new(EffectOp::Damage, 34.0)],
        Tag::Melee,
    ),
    // whirlwind — brawler t2 (NO Rust template): circle AoE 30 + knockback.
    mk(
        ID_WHIRLWIND, NO_CLASS, 2,
        hdr(TargetKind::Enemy, 3.2, 11.0, AreaKind::Circle, 3.2, 0.0, DeliveryKind::Instant, 0.0),
        &[
            Effect::new(EffectOp::Damage, 30.0),
            Effect::new(EffectOp::Knockback, 1.6).with_when(Trigger::OnHit),
        ],
        Tag::Melee,
    ),
    // second_wind — warrior t3: self heal (caster_hp_below) + shield.
    mk(
        ID_SECOND_WIND, CK_WARRIOR, 3,
        hdr(TargetKind::SelfTarget, 0.0, 24.0, AreaKind::SelfArea, 0.0, 0.0, DeliveryKind::Instant, 0.0),
        &[
            Effect::new(EffectOp::Heal, 45.0).with_when(Trigger::CasterHpBelow),
            Effect::new(EffectOp::Shield, 25.0).with_dur(6.0),
        ],
        Tag::Heal,
    ),
    // cleaving_blow — brawler t1 (NO Rust template): cone 38 dmg.
    mk(
        ID_CLEAVING_BLOW, NO_CLASS, 1,
        hdr(TargetKind::Enemy, 2.8, 6.0, AreaKind::Cone, 2.8, 100.0, DeliveryKind::Instant, 0.0),
        &[Effect::new(EffectOp::Damage, 38.0)],
        Tag::Melee,
    ),
    // silver_tongue — speaker t1: charm (plant_belief −0.4).
    mk(
        ID_SILVER_TONGUE, CK_SPEAKER, 1,
        hdr(TargetKind::Any, 6.0, 12.0, AreaKind::SelfArea, 0.0, 0.0, DeliveryKind::Instant, 0.0),
        &[Effect::new(EffectOp::PlantBelief, -0.4)],
        Tag::Charm,
    ),
    // plant_rumor — trickster t2 (NO Rust template): deceive (plant_belief +0.5) circle.
    mk(
        ID_PLANT_RUMOR, NO_CLASS, 2,
        hdr(TargetKind::Any, 6.0, 15.0, AreaKind::Circle, 6.0, 0.0, DeliveryKind::Instant, 0.0),
        &[Effect::new(EffectOp::PlantBelief, 0.5)],
        Tag::Deceive,
    ),
    // read_mind — trickster t1 (NO Rust template): scry.
    mk(
        ID_READ_MIND, NO_CLASS, 1,
        hdr(TargetKind::Any, 7.0, 10.0, AreaKind::SelfArea, 0.0, 0.0, DeliveryKind::Instant, 0.0),
        &[Effect::new(EffectOp::Scry, 0.0)],
        Tag::Gossip,
    ),
    // haggle — merchant t1: a little charm + the trade_edge window.
    mk(
        ID_HAGGLE, CK_MERCHANT, 1,
        hdr(TargetKind::Any, 5.0, 8.0, AreaKind::SelfArea, 0.0, 0.0, DeliveryKind::Instant, 0.0),
        &[
            Effect::new(EffectOp::PlantBelief, -0.2),
            Effect::new(EffectOp::TradeEdge, 0.0).with_dur(12.0),
        ],
        Tag::Barter,
    ),
    // master_craft — blacksmith t2: self craft_boost window.
    mk(
        ID_MASTER_CRAFT, CK_BLACKSMITH, 2,
        hdr(TargetKind::SelfTarget, 0.0, 20.0, AreaKind::SelfArea, 0.0, 0.0, DeliveryKind::Instant, 0.0),
        &[Effect::new(EffectOp::CraftBoost, 0.0).with_dur(10.0)],
        Tag::Crafting,
    ),
    // frost_bolt — hunter t1: ranged projectile 28 + slow.
    mk(
        ID_FROST_BOLT, CK_HUNTER, 1,
        hdr(TargetKind::Enemy, 10.0, 6.0, AreaKind::SelfArea, 0.0, 0.0, DeliveryKind::Projectile, 16.0),
        &[
            Effect::new(EffectOp::Damage, 28.0),
            Effect::new(EffectOp::Slow, 0.5).with_dur(3.0).with_when(Trigger::OnHit),
        ],
        Tag::Kill,
    ),
    // expose_weakness — hunter t2: ranged expose (combo setup) — no damage.
    mk(
        ID_EXPOSE_WEAKNESS, CK_HUNTER, 2,
        hdr(TargetKind::Enemy, 10.0, 9.0, AreaKind::SelfArea, 0.0, 0.0, DeliveryKind::Instant, 0.0),
        &[Effect::new(EffectOp::Expose, 1.5).with_dur(4.0)],
        Tag::Risk,
    ),
];

/// `CLASS_MILESTONES`: which (numeric class key, level) grants which catalog ability id. Mirrors the
/// JS `CLASS_MILESTONES` for the classes that HAVE a Rust template (warrior/blacksmith/merchant/
/// speaker/hunter). The brawler/trickster rows are omitted (no Rust class) — noted breadth.
pub static CLASS_MILESTONES: &[(u8, u16, u16)] = &[
    // (class_key, level, ability_id)
    (CK_WARRIOR, 1, ID_POWER_STRIKE),
    (CK_WARRIOR, 4, ID_LUNGE),
    (CK_WARRIOR, 8, ID_SECOND_WIND),
    (CK_HUNTER, 1, ID_FROST_BOLT),
    (CK_HUNTER, 5, ID_EXPOSE_WEAKNESS),
    (CK_SPEAKER, 2, ID_SILVER_TONGUE),
    (CK_MERCHANT, 1, ID_HAGGLE),
    (CK_BLACKSMITH, 3, ID_MASTER_CRAFT),
];

/// The ability id a class unlocks at EXACTLY `level`, if any (`milestoneAt`). Fixed-order scan.
#[inline]
pub fn milestone_at(class_key: u8, level: u16) -> Option<u16> {
    CLASS_MILESTONES
        .iter()
        .find(|&&(ck, lv, _)| ck == class_key && lv == level)
        .map(|&(_, _, id)| id)
}

// ───────────────────────────── the interpreter (SIMPLIFIED `cast` phase) ─────────────────────────────

/// Fixed cognition-tick duration (seconds) — mirrors `systems::combat::DT`. Drives the cast cadence.
const DT: f32 = 0.1;
/// Self-cast health-fraction gate (`ABILITY.selfCastHpFrac`): below this HP fraction an NPC spends its
/// cast on a READY self-heal/shield instead of attacking.
const SELF_CAST_HP_FRAC: f32 = 0.5;
/// Max health (TUNE.maxHealth) — the fraction the heal trigger / self-cast gate measure against.
const MAX_HEALTH: f32 = 100.0;
/// Cap on the stacked shield buffer (a self-cast can't pile an unbounded damage soak).
const SHIELD_CAP: f32 = 60.0;
/// Per-level damage scaling (mirrors combat's offence curve) applied to the ability's base damage.
const LVL_DMG_PER_LEVEL: f32 = 0.06;
const LVL_DMG_CAP: f32 = 2.5;
/// plant_belief amount (0..1-ish) → i16 standing units. Sized so a silver_tongue (−0.4) warms ~1200
/// (a meaningful nudge against the ~±10k standing scale), a plant_rumor (+0.5) sours ~1500.
const PLANT_SCALE: f32 = 3_000.0;
/// Units of trade-good a master-craft flourish yields per cast, capped so it can't hoard unboundedly.
const CRAFT_BOOST_UNITS: i32 = 3;
const CRAFT_BOOST_CAP: i32 = 64;
/// How long (ticks) a haggle's trade_edge price-buff lasts after the cast (mirrors the spec's `dur`).
const TRADE_BUFF_TICKS: u32 = 120;

/// Does this spec carry a `trade_edge` effect (the haggler's market price buff)?
#[inline]
fn has_trade_edge(spec: &AbilitySpec) -> bool {
    spec.effects().iter().any(|e| e.op == EffectOp::TradeEdge)
}

/// The commodity a profession OUTPUTS (mirrors the planner/market produced-good table), if any.
#[inline]
fn produced_good(prof: u8) -> Option<usize> {
    match prof {
        1 => Some(0), // Farmer → Food
        2 => Some(2), // Miner → Ore
        3 => Some(1), // Woodcutter → Wood
        4 => Some(3), // Blacksmith → Tool
        5 => Some(4), // Hunter → Herb
        6 => Some(5), // Trader → Potion
        _ => None,
    }
}

/// The SIMPLIFIED autocaster — a parallel own-write phase run after combat (see `World::tick`).
/// For each living agent that holds a known ability:
///   - if hurt (HP < SELF_CAST_HP_FRAC of max) and it holds a READY self-heal/shield ability, it
///     self-casts: own-write heal/shield to its OWN `combat[i]` (health up to max; shield deferred —
///     see note), burns the ability cooldown, and emits a cast deed.
///   - else if it holds a READY OFFENSIVE ability and has a believed-hostile in that ability's range,
///     it fires an EXTRA `Intent::Strike` for the ability's (level-scaled) damage + a cast deed.
/// Cross-agent damage rides the intent merge; self-effects are own-writes. Determinism: own-read +
/// own-write + id-order intent collect.
pub fn cast(world: &mut World) {
    let now = world.tick;
    let World {
        ref pos,
        ref faction,
        ref level,
        ref alive,
        ref profession,
        ref progression,
        ref mut facts,
        ref mut combat,
        ref mut ability_cd,
        ref mut econ,
        ref mut trade_buff,
        ..
    } = *world;

    // Each agent emits 0..2 intents (own-write to combat[i]/ability_cd[i]); collected in id order.
    // `Emit` carries the up-to-two intents inline so the `flat_map` stays branch-free + ordered.
    let out: Vec<Intent> = combat
        .par_iter_mut()
        .zip(ability_cd.par_iter_mut())
        .zip(facts.par_iter_mut())
        .zip(econ.par_iter_mut())
        .zip(trade_buff.par_iter_mut())
        .enumerate()
        .map(|(i, ((((cb, cd), bel), ec), tbuff))| {
            let mut emit = Emit::none();
            if !alive[i] || cb.state == FighterState::Dead as u8 {
                return emit;
            }
            // tick the per-agent ability cooldown (own-write).
            if *cd > 0.0 {
                *cd = (*cd - DT).max(0.0);
            }
            if *cd > 0.0 {
                return emit; // still recharging — one cadence shared across known abilities.
            }

            let known = &progression[i].abilities;
            // doc 25: a scratch belief table loaded from facts for the ability reads below (scry does
            // its own load/store when it writes). Codec round-trip == old struct behaviour.
            let belbt = bel.to_belief_table();

            // ── 1) self-support: hurt + holds a ready self-heal/shield → own-write + cast deed ──
            if cb.health < SELF_CAST_HP_FRAC * MAX_HEALTH {
                if let Some(spec) = first_known(known, |s| s.is_self_support()) {
                    apply_self_support(cb, &spec); // own-write to the caster's combat row
                    *cd = spec.header.cooldown;
                    emit.push(cast_deed(i as u32, i as u32, 1, spec.grants_tag as u8));
                    return emit;
                }
            }

            // ── 2) offensive: holds a ready damage ability + a believed-hostile in range → Strike ──
            if let Some(off) = first_known(known, |s| s.is_offensive()) {
                if let Some((to, _)) = nearest_hostile_in_range(&belbt, pos[i], off.header.range)
                {
                    // level-scaled damage on the ability's base (offence-only, like combat.js).
                    let mult = (1.0 + level[i] as f32 * LVL_DMG_PER_LEVEL).min(LVL_DMG_CAP);
                    let dmg = off.damage_of() * mult;
                    *cd = off.header.cooldown;
                    emit.push(Intent::Strike { from: i as u32, to, dmg });
                    emit.push(cast_deed(i as u32, to, dmg.max(0.0) as u16, off.grants_tag as u8));
                    // CONTROL OPS: any stun/slow/knockback/expose effect the offensive ability carries is
                    // applied to the same target (the ability DSL's debuff ops — e.g. frost_bolt's slow).
                    for e in off.effects() {
                        if let Some(a) = afflict_intent(e, i as u32, to) {
                            emit.push(a);
                        }
                    }
                }
            }

            // ── 2b) debuff: a non-damaging ENEMY-target ability carrying a control op (expose_weakness)
            //        — cast at a believed hostile in range to SET UP the kill (expose ⇒ amplified blows).
            if emit.n == 0 {
                if let Some(db) = first_known(known, |s| s.is_debuff()) {
                    if let Some((to, _)) = nearest_hostile_in_range(&belbt, pos[i], db.header.range) {
                        *cd = db.header.cooldown;
                        for e in db.effects() {
                            if let Some(a) = afflict_intent(e, i as u32, to) {
                                emit.push(a);
                            }
                        }
                        emit.push(cast_deed(i as u32, to, 0, db.grants_tag as u8));
                    }
                }
            }

            // ── 3) social: nothing else fired + holds a ready plant_belief ability + a believed agent
            //       in range → Influence (charm warms / deceit sours the target's regard of the caster).
            //       The ability DSL's reach into the epistemic layer — a speaker/trickster shapes belief.
            if emit.n == 0 {
                if let Some(soc) = first_known(known, |s| s.is_social()) {
                    if let Some(to) = nearest_believed_in_range(&belbt, pos[i], soc.header.range, i as u32)
                    {
                        // amount sign: negative = charm (warm), positive = deceit (sour). Scaled into
                        // the i16 standing units the belief table uses.
                        let warm = (-soc.plant_of() * PLANT_SCALE).clamp(-30_000.0, 30_000.0) as i16;
                        *cd = soc.header.cooldown;
                        // a haggle also arms the TRADE_EDGE: a market price-buff window on the caster.
                        if has_trade_edge(&soc) {
                            *tbuff = now + TRADE_BUFF_TICKS;
                        }
                        emit.push(Intent::Influence { from: i as u32, to, warm });
                        emit.push(cast_deed(i as u32, to, 1, soc.grants_tag as u8));
                    }
                }
            }

            // ── 4) scry: nothing else fired + holds a ready Scry ability (read_mind) → FIRM the
            //       caster's vaguest believed-agent-in-range from the TRUTH (reveal its position +
            //       faction, raise confidence). An OWN-write to the caster's belief row reading the
            //       target's stable (already-moved) pos/faction column — a sanctioned ability truth-read,
            //       like perceive. No cross-agent intent (the scryer learns; the target is untouched).
            if emit.n == 0 {
                if let Some(scry) = first_known(known, |s| s.is_scry()) {
                    // doc 25: load scratch from facts, firm the vaguest belief, store back.
                    let mut bt = bel.to_belief_table();
                    if let Some(bix) = vaguest_belief_in_range(&bt, pos[i], scry.header.range, i as u32) {
                        let subj = bt.bodies[bix].subject as usize;
                        if subj < pos.len() {
                            let b = &mut bt.bodies[bix];
                            b.last_x = pos[subj][0];
                            b.last_z = pos[subj][1];
                            b.faction = faction[subj];
                            b.confidence = b.confidence.max(58_000); // now KNOWN, first-hand-firm
                        }
                        *cd = scry.header.cooldown;
                        emit.push(cast_deed(i as u32, bt.bodies[bix].subject, 1, scry.grants_tag as u8));
                        bel.mirror_core_from(&bt);
                    }
                }
            }

            // ── 5) craft_boost: nothing else fired + holds a ready master-craft ability + plies a
            //       producing trade → an immediate BURST of its trade-good (own-write inventory). The
            //       craft_boost op made live: a master crafter's flourish of extra output.
            if emit.n == 0 {
                if let Some(cb_spec) = first_known(known, |s| s.is_craft_boost()) {
                    if let Some(good) = produced_good(profession[i]) {
                        let inv = &mut ec.inventory[good];
                        if *inv < CRAFT_BOOST_CAP {
                            *inv = (*inv + CRAFT_BOOST_UNITS).min(CRAFT_BOOST_CAP);
                            *cd = cb_spec.header.cooldown;
                            emit.push(cast_deed(i as u32, i as u32, CRAFT_BOOST_UNITS as u16, cb_spec.grants_tag as u8));
                        }
                    }
                }
            }
            emit
        })
        // `flat_map_iter`: the inner per-agent iterator is SERIAL (a tiny 0..2 fan-out) — rayon keeps
        // the outer parallelism but the order within an agent (strike before deed) is preserved.
        .flat_map_iter(|e| e.into_iter())
        .collect();

    world.intents.items.extend(out);
}

/// Up to four intents from one agent's cast (offensive: strike + deed + control-op afflicts; debuff:
/// afflict(s) + deed; self-support: one deed).
struct Emit {
    items: [Option<Intent>; 4],
    n: usize,
}
impl Emit {
    #[inline]
    fn none() -> Emit {
        Emit { items: [None, None, None, None], n: 0 }
    }
    #[inline]
    fn push(&mut self, it: Intent) {
        if self.n < self.items.len() {
            self.items[self.n] = Some(it);
            self.n += 1;
        }
    }
    #[inline]
    fn into_iter(self) -> impl Iterator<Item = Intent> {
        self.items.into_iter().flatten()
    }
}

/// Build an `Intent::Afflict` for a control-op effect (stun/slow/knockback/expose) aimed at `to`, or
/// `None` for a non-control effect (damage/heal/…). The deterministic merge applies it to the target.
#[inline]
fn afflict_intent(e: &Effect, from: u32, to: u32) -> Option<Intent> {
    match e.op {
        EffectOp::Stun | EffectOp::Slow | EffectOp::Knockback | EffectOp::Expose => Some(Intent::Afflict {
            from,
            to,
            op: e.op as u8,
            amount: e.amount,
            dur: e.dur,
        }),
        _ => None,
    }
}

/// Apply a self-support spec's heal/shield to the caster's OWN combat row (own-write only).
/// Heal raises health toward max (gated by `caster_hp_below` when the effect carries it — we only get
/// here when already hurt). Shield is NOTED-SKIPPED: the `CombatBody` has no shield-buffer column, so
/// the shield effect is a no-op here (would need a new column — out of scope for this unit). The heal
/// alone delivers the "self-heal restores health" behaviour.
fn apply_self_support(cb: &mut crate::components::CombatBody, spec: &AbilitySpec) {
    for e in spec.effects() {
        match e.op {
            EffectOp::Heal => {
                // honour `caster_hp_below` (true here by construction) / unconditional.
                cb.health = (cb.health + e.amount).min(MAX_HEALTH);
            }
            // shield: raise the damage-buffer (capped) — soaked by the next blows in the Strike merge.
            EffectOp::Shield => {
                cb.shield = (cb.shield + e.amount).min(SHIELD_CAP);
            }
            _ => {}
        }
    }
}

/// The first known ability (own ids) matching `pred`, resolved through the catalog. Fixed-order scan
/// over the tiny known-ability array ⇒ deterministic.
#[inline]
fn first_known(known: &[u16], pred: impl Fn(&AbilitySpec) -> bool) -> Option<AbilitySpec> {
    for &id in known {
        if id == NO_ABILITY {
            continue;
        }
        let spec = &CATALOG[id as usize];
        if pred(spec) {
            return Some(*spec);
        }
    }
    None
}

/// Nearest believed-hostile within `range` (believed pos), reading the agent's OWN belief table only.
/// Same epistemic discipline + deterministic tie-break (lowest subject id) as `combat::nearest_hostile`.
#[inline]
fn nearest_hostile_in_range(bt: &BeliefTable, from: [f32; 2], range: f32) -> Option<(u32, usize)> {
    let r2 = range * range;
    let mut best: Option<(u32, usize, f32)> = None;
    for idx in 0..bt.len as usize {
        let b = &bt.bodies[idx];
        if b.flags & 1 == 0 {
            continue; // not believed hostile
        }
        let dx = from[0] - b.last_x;
        let dz = from[1] - b.last_z;
        let d2 = dx * dx + dz * dz;
        if d2 > r2 {
            continue;
        }
        let better = match best {
            None => true,
            Some((bid, _, bd)) => d2 < bd || (d2 == bd && b.subject < bid),
        };
        if better {
            best = Some((b.subject, idx, d2));
        }
    }
    best.map(|(id, idx, _)| (id, idx))
}

/// Nearest believed agent within `range` (any — friend or stranger, not just hostile), reading the
/// agent's OWN belief table only. The charm/deceit target: whoever the speaker can reach. Deterministic
/// tie-break by lowest subject id; `self_id` is never targeted.
#[inline]
fn nearest_believed_in_range(bt: &BeliefTable, from: [f32; 2], range: f32, self_id: u32) -> Option<u32> {
    let r2 = range * range;
    let mut best: Option<(u32, f32)> = None;
    for idx in 0..bt.len as usize {
        let b = &bt.bodies[idx];
        if b.subject == self_id {
            continue;
        }
        let dx = from[0] - b.last_x;
        let dz = from[1] - b.last_z;
        let d2 = dx * dx + dz * dz;
        if d2 > r2 {
            continue;
        }
        let better = match best {
            None => true,
            Some((bid, bd)) => d2 < bd || (d2 == bd && b.subject < bid),
        };
        if better {
            best = Some((b.subject, d2));
        }
    }
    best.map(|(id, _)| id)
}

/// The belief-table INDEX of the caster's VAGUEST (lowest-confidence) believed agent within `range` —
/// the one a scry would most usefully firm up. Deterministic tie-break (lowest subject id); never self.
#[inline]
fn vaguest_belief_in_range(bt: &BeliefTable, from: [f32; 2], range: f32, self_id: u32) -> Option<usize> {
    let r2 = range * range;
    let mut best: Option<(usize, u16, u32)> = None; // (idx, confidence, subject)
    for idx in 0..bt.len as usize {
        let b = &bt.bodies[idx];
        if b.subject == self_id {
            continue;
        }
        let dx = from[0] - b.last_x;
        let dz = from[1] - b.last_z;
        if dx * dx + dz * dz > r2 {
            continue;
        }
        let better = match best {
            None => true,
            Some((_, bc, bs)) => b.confidence < bc || (b.confidence == bc && b.subject < bs),
        };
        if better {
            best = Some((idx, b.confidence, b.subject));
        }
    }
    best.map(|(idx, _, _)| idx)
}

// ───────────────────────────── milestone grant (called from progression::tick) ─────────────────────────────

/// Grant any ability whose `(class_key, level)` milestone the agent has now reached, for each held
/// class, into the agent's known-ability set (dedup; capped). Pure own-write on the `abilities`
/// column. Mirrors `Progression`'s milestone grant: when a class's level clears a milestone level we
/// grant its catalog ability. The Rust progression tracks `total_level` (summed), not per-class
/// levels, so we gate on `total_level >= milestone_level` for each HELD class (a faithful-enough
/// approximation — a held class that has earned total levels unlocks its tiered abilities in order).
pub fn grant_milestones(prog: &mut crate::components::Progression) {
    let lvl = prog.total_level;
    for c in 0..prog.n_classes as usize {
        let ck = prog.classes[c];
        for &(mck, mlv, aid) in CLASS_MILESTONES {
            if mck == ck && lvl >= mlv {
                add_ability(prog, aid);
            }
        }
    }
}

/// Add `aid` to the known-ability set if absent and a slot is free (dedup + cap). Own-write.
#[inline]
pub fn add_ability(prog: &mut crate::components::Progression, aid: u16) {
    if prog.abilities.iter().any(|&a| a == aid) {
        return; // already known
    }
    for slot in prog.abilities.iter_mut() {
        if *slot == NO_ABILITY {
            *slot = aid;
            return;
        }
    }
    // full: keep the earliest grants (mirrors a fixed-capacity known set).
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::World;

    /// Every catalog spec validates (the whitelist trust boundary accepts the hand-authored set).
    #[test]
    fn catalog_validates() {
        for s in CATALOG.iter() {
            assert!(s.validate(), "catalog spec id {} failed validate()", s.id);
        }
        // a deliberately out-of-bounds spec is rejected.
        let mut bad = CATALOG[ID_POWER_STRIKE as usize];
        bad.effects[0].amount = 9_999.0; // > LIMITS.amount
        assert!(!bad.validate(), "an over-cap damage spec must be rejected");
    }

    /// The offensive/self-support classification matches the catalog roles.
    #[test]
    fn classification() {
        assert!(CATALOG[ID_POWER_STRIKE as usize].is_offensive());
        assert!(CATALOG[ID_FROST_BOLT as usize].is_offensive());
        assert!(!CATALOG[ID_SECOND_WIND as usize].is_offensive());
        assert!(CATALOG[ID_SECOND_WIND as usize].is_self_support());
        assert!(!CATALOG[ID_READ_MIND as usize].is_offensive()); // social, no damage
        assert!(CATALOG[ID_POWER_STRIKE as usize].is_melee());
        assert!(!CATALOG[ID_FROST_BOLT as usize].is_melee()); // ranged
    }

    /// milestone_at maps the right class@level to the right ability.
    #[test]
    fn milestones_map() {
        assert_eq!(milestone_at(CK_WARRIOR, 1), Some(ID_POWER_STRIKE));
        assert_eq!(milestone_at(CK_WARRIOR, 4), Some(ID_LUNGE));
        assert_eq!(milestone_at(CK_HUNTER, 1), Some(ID_FROST_BOLT));
        assert_eq!(milestone_at(CK_WARRIOR, 99), None);
    }

    /// An NPC holding an offensive ability with a believed-hostile in range emits an EXTRA strike.
    #[test]
    fn autocast_offensive_emits_strike() {
        let mut w = World::spawn(0xAB17, 2);
        w.pos[0] = [0.0, 0.0];
        w.pos[1] = [3.0, 0.0]; // outside melee REACH (2.3) but inside frost_bolt range (10)
        // agent 0 knows frost_bolt and is at full health.
        add_ability(&mut w.progression[0], ID_FROST_BOLT);
        w.ability_cd[0] = 0.0;
        w.combat[0].state = FighterState::Idle as u8;
        // believes agent 1 hostile at (3,0).
        let mut bt = crate::components::BeliefTable::default();
        bt.len = 1;
        bt.subjects[0] = 1;
        bt.bodies[0].subject = 1;
        bt.bodies[0].last_x = 3.0;
        bt.bodies[0].last_z = 0.0;
        bt.bodies[0].flags = 1;
        w.facts[0].mirror_core_from(&bt);
        let hp_before = w.combat[1].health;

        cast(&mut w);
        let n_strikes = w
            .intents
            .items
            .iter()
            .filter(|i| matches!(i, Intent::Strike { .. }))
            .count();
        assert_eq!(n_strikes, 1, "an offensive autocast emits one extra strike");
        assert!(w.ability_cd[0] > 0.0, "the ability went on cooldown");

        w.drain_intents();
        assert!(w.combat[1].health < hp_before, "the believed target took ability damage");
    }

    /// A charmer (silver_tongue) casts at a nearby agent → an Influence intent that WARMS how that
    /// agent regards the caster (the plant_belief ability op reaching into the epistemic layer).
    #[test]
    fn autocast_social_charm_warms_target_regard() {
        let mut w = World::spawn(0xAB1A, 4);
        let (speaker, mark) = (0usize, 1usize);
        w.pos[speaker] = [0.0, 0.0];
        w.pos[mark] = [3.0, 0.0]; // inside silver_tongue range (6)
        add_ability(&mut w.progression[speaker], ID_SILVER_TONGUE);
        w.ability_cd[speaker] = 0.0;
        w.combat[speaker].state = FighterState::Idle as u8;
        // the speaker believes a (non-hostile) agent is nearby.
        let mut bt = crate::components::BeliefTable::default();
        bt.len = 1;
        bt.subjects[0] = mark as u32;
        bt.bodies[0].subject = mark as u32;
        bt.bodies[0].last_x = 3.0;
        bt.bodies[0].last_z = 0.0;
        bt.bodies[0].flags = 0; // not hostile
        w.facts[speaker].mirror_core_from(&bt);
        w.facts[mark] = crate::components::FactStore::default();

        cast(&mut w);
        assert!(
            w.intents.items.iter().any(|i| matches!(i, Intent::Influence { .. })),
            "a social cast emits an Influence intent"
        );
        assert!(w.ability_cd[speaker] > 0.0, "the social ability went on cooldown");
        assert!(
            !w.intents.items.iter().any(|i| matches!(i, Intent::Strike { .. })),
            "a charm is not a strike"
        );
        w.drain_intents();
        assert!(
            w.facts[mark].view(speaker as u32).expect("the mark now regards the charmer").standing > 0,
            "the charm warmed how the mark regards the speaker"
        );
    }

    /// A hurt NPC holding a self-heal ability self-casts → its OWN health is restored (own-write).
    #[test]
    fn autocast_self_heal_restores_health() {
        let mut w = World::spawn(0xAB18, 2);
        add_ability(&mut w.progression[0], ID_SECOND_WIND);
        w.ability_cd[0] = 0.0;
        w.combat[0].health = 20.0; // below SELF_CAST_HP_FRAC * 100 = 50
        let before = w.combat[0].health;

        cast(&mut w);
        assert!(w.combat[0].health > before, "self-heal restored own health");
        // second_wind heals 45 from 20 → 65 (capped at max 100).
        assert!((w.combat[0].health - 65.0).abs() < 1e-3, "healed by the spec amount");
        assert!(w.combat[0].shield > 0.0, "second_wind also raised a damage shield");
        assert!(w.ability_cd[0] > 0.0, "the self-cast went on cooldown");
        // no cross-agent strike from a self-cast.
        assert!(!w.intents.items.iter().any(|i| matches!(i, Intent::Strike { .. })));
    }

    /// A scryer (read_mind) firms its VAGUEST nearby belief from the truth — confidence up, position
    /// refreshed to the target's actual location (the ability-sanctioned reveal; an own-write).
    #[test]
    fn autocast_scry_firms_a_vague_belief() {
        let mut w = World::spawn(0xAB1B, 4);
        let (seer, mark) = (0usize, 1usize);
        w.pos[seer] = [0.0, 0.0];
        w.pos[mark] = [5.0, 2.0]; // the TRUTH
        add_ability(&mut w.progression[seer], ID_READ_MIND);
        w.ability_cd[seer] = 0.0;
        w.combat[seer].state = FighterState::Idle as u8;
        // a vague, stale belief about the mark (low confidence, wrong position) within read_mind range.
        let mut bt = crate::components::BeliefTable::default();
        bt.len = 1;
        bt.subjects[0] = mark as u32;
        bt.bodies[0].subject = mark as u32;
        bt.bodies[0].last_x = 5.0;
        bt.bodies[0].last_z = 0.0; // stale (true is z=2.0)
        bt.bodies[0].confidence = 1_000; // vague
        w.facts[seer].mirror_core_from(&bt);

        cast(&mut w);
        let b = w.facts[seer].view(mark as u32).unwrap();
        assert!(b.confidence > 1_000, "scry firmed the belief's confidence");
        assert!((b.last_z - 2.0).abs() < 1e-3, "scry refreshed the position from the truth");
        assert!(w.ability_cd[seer] > 0.0, "the scry went on cooldown");
        // scry is a self-learn — no cross-agent strike/influence emitted.
        assert!(!w.intents.items.iter().any(|i| matches!(i, Intent::Strike { .. } | Intent::Influence { .. })));
    }

    /// A merchant's haggle arms the TRADE_EDGE: a market price-buff window on the caster (so its next
    /// sales clear higher — the trade_edge ability op made live).
    #[test]
    fn autocast_haggle_arms_the_trade_edge() {
        let mut w = World::spawn(0xAB1D, 4);
        let merchant = 0usize;
        add_ability(&mut w.progression[merchant], ID_HAGGLE);
        w.ability_cd[merchant] = 0.0;
        w.combat[merchant].state = FighterState::Idle as u8; // full health (no self-heal)
        w.pos[merchant] = [0.0, 0.0];
        // a believed agent in haggle range (the charm's target).
        let mut bt = crate::components::BeliefTable::default();
        bt.len = 1;
        bt.subjects[0] = 1;
        bt.bodies[0].subject = 1;
        bt.bodies[0].last_x = 2.0;
        w.facts[merchant].mirror_core_from(&bt);
        assert_eq!(w.trade_buff[merchant], 0, "no buff before the haggle");
        cast(&mut w);
        assert!(w.trade_buff[merchant] > w.tick, "haggle arms a trade_edge price-buff window");
    }

    /// A master crafter (master_craft) self-casts → an immediate burst of its trade-good (the
    /// craft_boost op made live: an own-write to the caster's inventory).
    #[test]
    fn autocast_craft_boost_yields_trade_goods() {
        let mut w = World::spawn(0xAB1C, 4);
        let smith = 0usize;
        w.profession[smith] = 4; // Blacksmith → produces Tool (index 3)
        add_ability(&mut w.progression[smith], ID_MASTER_CRAFT);
        w.ability_cd[smith] = 0.0;
        w.combat[smith].state = FighterState::Idle as u8; // full health (no self-heal)
        let tools_before = w.econ[smith].inventory[3];
        cast(&mut w);
        assert!(
            w.econ[smith].inventory[3] > tools_before,
            "the master crafter's flourish yielded trade-goods"
        );
        assert!(w.ability_cd[smith] > 0.0, "the craft_boost went on cooldown");
        // a self-buff emits no cross-agent strike/influence.
        assert!(!w.intents.items.iter().any(|i| matches!(i, Intent::Strike { .. } | Intent::Influence { .. })));
    }

    /// No believed-hostile in range ⇒ no offensive strike (peace stays peaceful).
    #[test]
    fn no_target_no_strike() {
        let mut w = World::spawn(0xAB19, 2);
        add_ability(&mut w.progression[0], ID_FROST_BOLT);
        w.ability_cd[0] = 0.0;
        // a far-away hostile, beyond frost_bolt's 10m range.
        let mut bt = crate::components::BeliefTable::default();
        bt.len = 1;
        bt.subjects[0] = 1;
        bt.bodies[0].subject = 1;
        bt.bodies[0].last_x = 50.0;
        bt.bodies[0].flags = 1;
        w.facts[0].mirror_core_from(&bt);
        cast(&mut w);
        assert!(!w.intents.items.iter().any(|i| matches!(i, Intent::Strike { .. })));
    }

    /// grant_milestones unlocks the warrior's tier abilities as total level rises.
    #[test]
    fn grant_milestones_unlocks() {
        let mut prog = crate::components::Progression::default();
        // hold warrior (key 0) at total level 4.
        prog.classes[0] = CK_WARRIOR;
        prog.n_classes = 1;
        prog.total_level = 4;
        grant_milestones(&mut prog);
        assert!(prog.abilities.contains(&ID_POWER_STRIKE), "lvl 1 milestone granted");
        assert!(prog.abilities.contains(&ID_LUNGE), "lvl 4 milestone granted");
        assert!(!prog.abilities.contains(&ID_SECOND_WIND), "lvl 8 milestone not yet reached");
    }

    /// M-invariance of the cast phase: a packed brawl of autocasters lands the same final health
    /// across rayon thread counts.
    fn autocast_brawl_health(threads: usize) -> Vec<u32> {
        crate::in_pool(threads, || {
            let mut w = World::spawn(0xCA57, 48);
            for i in 0..w.n {
                w.pos[i] = [(i % 4) as f32 * 0.5, (i / 4) as f32 * 0.5];
                add_ability(&mut w.progression[i], ID_POWER_STRIKE);
                w.ability_cd[i] = 0.0;
                w.combat[i].state = FighterState::Idle as u8;
                if i > 0 {
                    let p = w.pos[i - 1];
                    let mut bt = crate::components::BeliefTable::default();
                    bt.len = 1;
                    bt.subjects[0] = (i - 1) as u32;
                    bt.bodies[0].subject = (i - 1) as u32;
                    bt.bodies[0].last_x = p[0];
                    bt.bodies[0].last_z = p[1];
                    bt.bodies[0].flags = 1;
                    w.facts[i].mirror_core_from(&bt);
                }
            }
            for _ in 0..8 {
                cast(&mut w);
                w.drain_intents();
            }
            w.combat.iter().map(|c| c.health.to_bits()).collect()
        })
    }

    #[test]
    fn autocast_m_invariant() {
        let h1 = autocast_brawl_health(1);
        let h4 = autocast_brawl_health(4);
        let h8 = autocast_brawl_health(8);
        assert!(h1.iter().any(|&h| h != 100.0f32.to_bits()), "the brawl must deal ability damage");
        assert_eq!(h1, h4, "cast collection diverged at M=4");
        assert_eq!(h1, h8, "cast collection diverged at M=8");
    }
}
