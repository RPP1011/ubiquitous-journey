//! FAN-OUT UNIT: tropes — the relationship-trope engine (`js/sim/director/tropes.ts`). A SECOND drama
//! instigator beside `director.rs`: where the director owns the points-budget tropes that LIGHT a
//! dormant loop (raid/feud/opportunity/crisis), this ports the ~19 RELATIONSHIP tropes — the warm/dark
//! filler that gives the social fabric texture (reunions, betrayals, miser-reformed, debts repaid,
//! house feuds, slander). It does NOT edit `director.rs`; it runs as its own serial society pass.
//!
//! THE SPIRIT (doc 22 §9): the trope SUBSTRATE (families, simmering dislikes, durable bonds) is dense
//! at any size — what's scarce is the SPARK. The dispatcher scans LIVE townsfolk for a constellation
//! that ALMOST forms a known trope and supplies the missing piece (a belief/memory seed); the emergent
//! systems (perception, the GOAP avenge/repay loops, the patrician, lineage) play it out and the
//! chronicle narrates it. Each instigator returns true iff it FIRED; the dispatcher fires the FIRST
//! whose constellation exists this roll, in PRIORITY order (the rare/dramatic ones first so they're
//! never crowded out), arms the global + per-kind cooldowns, and stops.
//!
//! WHAT WE PORT (reachable with the Wave-H substrate — belief seeds, episodic memory, houses):
//!   reunion           — two same-house living townsfolk not yet bonded → warm BOTH + a `Succoured`
//!                       (positive) memory each (the closest substrate analogue of the TS reunion mem).
//!   unlikely_friendship — A bears enmity (a soured/hostile belief, OR a house feud) toward B → warm
//!                       ONE side, breaking the symmetry (gossip/proximity carry the rest, like TS).
//!   betrayal          — a DURABLE bond (A warmly trusts B) turns: B craters its belief toward A,
//!                       LATCHES hostile, and A records an `Assaulted` grudge — a lasting wound the
//!                       avenge loop grows (the seed of a reckoning).
//!   miser_reformed    — a hoarder (low altruism) with gold + a poor neighbour → a CONSERVED gold gift
//!                       (debit miser / credit poor — never mints) + the poor's gratitude (warmth).
//!   debt_repaid       — a holder of a `Succoured` memory repays its saviour: a CONSERVED small gift +
//!                       a warming of the bond both ways.
//!   house_feud        — two SIZEABLE houses not yet feuding → `set_house_feud` (children inherit it).
//!   false_witness     — an ugly whisper poisons an INNOCENT's name: plant SOURED standing (NOT
//!                       latched-hostile) of a target into a few neighbours; gossip spreads it, decay
//!                       heals it. The target's TRUTH is untouched (the epistemic split).
//!   feud              — deepen a simmering pair (the most mutually-soured) into open enmity: sour BOTH
//!                       ways AND LATCH hostile (so chatting-affinity can't rebuild it within a tick).
//!   vendetta          — amplify a REAL grievance (a townsperson already mistrusts someone) into a
//!                       sworn vendetta: LATCH the existing belief hostile. Never manufactured.
//!
//! WHAT WE SKIP (substrate absent — noted, doc 22 §9 "spirit not letter"):
//!   spy_unmasked / favored_rise / mistaken_jealousy / star_crossed — disguise+price plants live in
//!     `intrigue.rs` already (spy), and `mateId`/`_courtingId`/`priceBeliefs`-spike state is absent.
//!   rival_apprentices / mentor_pride / prodigal_return — no `masterId`/`kinIds`/`ambition.kind`
//!     columns in this wave (the director's seeding plants the one apprentice trio; no per-tick reach).
//!   prophet — faith proselytising lives in `faith.rs`. tyrant_market — needs a per-trade price-belief
//!     column + a producer's `_trade` tag (absent). boast_backfires folds into false_witness's family
//!     (a planted-belief trope); only the dark slander variant is ported (the warm boast needs an
//!     `ambition.kind == renown` cue that is absent).
//!
//! Determinism: SERIAL society phase ⇒ trivially M-invariant. ALL randomness draws from
//! `world.sim_rng` (never per-entity rng); every constellation scan walks living townsfolk in ID
//! ORDER from a deterministic rng-chosen start offset (the TS `_spotlight` focus-rotation analogue),
//! so no HashMap iteration / float reduce taints the behaviour path. CONSERVATION: the two gift tropes
//! move gold debit-one / credit-other (never mint); no trope spawns. No belief write ever reads ground
//! truth to DRIVE a decision — it only SEEDS the observer's belief/memory (the epistemic split holds).

use crate::components::{Beat, Episode, EpisodeKind, Faction, N_TROPES};
use crate::systems::houses::{are_houses_feuding, set_house_feud};
use crate::world::World;

// ── pacing (mirror `DIRECTOR.tropes.*` / `DIRECTOR.tropeKindCooldown`) ──────────────────────────────

/// How often the trope dispatcher wakes (sparse — the warm/dark filler beneath the director's drama).
const EVAL_EVERY: u32 = 130;
/// Minimum ticks between ANY two relationship tropes (the global `_lastTropeAt` window).
const TROPE_COOLDOWN: u32 = 90;
/// Minimum ticks before the SAME KIND may fire again (the decisive variety lever — forces the feed to
/// rotate through the whole catalogue instead of repeating one trope). Mirrors `tropeKindCooldown`.
const KIND_COOLDOWN: u32 = 110;

/// A trope needs at least this many living townsfolk to have a constellation worth lighting.
const MIN_FOLK: usize = 3;

// ── tuning (the belief/memory seed magnitudes, in the i16 standing quantization −32768..32767 ≡ −1..1).

/// Warmth applied by a reunion / a repaid debt / gratitude (the TS `warmAmt`/0.3–0.4 family ≈ +0.3).
const WARM_AMT: i16 = 10_000;
/// Extra warmth the unlikely-friendship spark carries (`warmAmt + 0.1`), nudged a touch higher to
/// overcome the enmity it bridges.
const FRIENDSHIP_WARM: i16 = 13_000;
/// How far a betrayal CRATERS the betrayer→victim standing (the TS `betrayalDrop` ≈ 0.6).
const BETRAYAL_DROP: i16 = 20_000;
/// The wounded victim's own soured trust toward the betrayer (TS `ab.standing -= 0.4`).
const BETRAYAL_WOUND: i16 = 13_000;
/// How far a feud sours BOTH standings (the TS `feudDrop` ≈ 0.5).
const FEUD_DROP: i16 = 16_000;
/// How far false-witness slander sours a neighbour's standing toward the target (`slanderDrop` ≈ 0.35).
const SLANDER_DROP: i16 = 11_000;

/// A bond counts as DURABLE (betrayable) when the truster's standing is at least this warm
/// (the TS `ab.standing >= 0.5`).
const DURABLE_BOND: i16 = 16_000;
/// A grievance counts as a REAL one (vendetta material / a feud's preferred pair) below this standing
/// (the TS `b.standing < -0.35` / `-0.15`).
const GRIEVANCE_STANDING: i16 = -11_000;

/// Salience stamped on a seeded `Assaulted`/`Succoured` memory (drives intention priority + survival).
const MEM_SALIENCE: u16 = 52_000;

/// Hoarder gate: altruism below this is "close-fisted" (the TS `altruism < 0.25`).
const MISER_ALTRUISM: f32 = 0.25;
/// A miser needs at least this much gold to be in a position to give (the TS `miserGold` ≈ 40).
const MISER_GOLD: i64 = 40;
/// The gift the reformed miser parts with (conserved transfer; the TS `miserGift` ≈ 15).
const MISER_GIFT: i64 = 15;
/// A "poor" neighbour the miser is moved to help holds less than this (the TS `poor.gold < 8`).
const POOR_GOLD: i64 = 8;
/// The token a repaid debt moves back to the saviour (conserved; the TS `min(8, gold)`).
const DEBT_GIFT: i64 = 8;

/// A house must field at least this many living members to be "sizeable" enough to feud (TS `>= 2`).
const HOUSE_MIN_MEMBERS: usize = 2;
/// Cap on simultaneous live house feuds (the TS `houseFeudCap`).
const HOUSE_FEUD_CAP: usize = 3;
/// How many neighbours a false-witness whisper poisons (the TS `touched >= 3`).
const SLANDER_K: usize = 3;

const HOSTILE_BIT: u8 = 0x01;

// ── interned BeatKinds (distinct from chronicle 0/1, director 2/10/11/12, lineage 3, houses 20,
//    patrician/watch 22, intrigue 30, seeding 40). The relationship-trope feed gets the 50-block. ──
const BEAT_REUNION: u8 = 50;
const BEAT_FRIENDSHIP: u8 = 51;
const BEAT_BETRAYAL: u8 = 52;
const BEAT_MISER: u8 = 53;
const BEAT_DEBT: u8 = 54;
const BEAT_HOUSE_FEUD: u8 = 55;
const BEAT_SLANDER: u8 = 56;
const BEAT_FEUD: u8 = 57;
const BEAT_VENDETTA: u8 = 58;
const BEAT_JEALOUSY: u8 = 59;
const BEAT_RIVALRY: u8 = 60;

/// MISTAKEN JEALOUSY: a believed FRIEND this warm is dear enough to be jealous OVER…
const JEALOUSY_FRIEND_BOND: i16 = 10_000;
/// …and the misunderstanding COOLS that warmth this much — but never craters/latches (it's recoverable).
const JEALOUSY_SOUR: i16 = 8_000;
/// RIVAL APPRENTICES: only the low-LEVEL (still learning their craft) become rivals; a mild mutual chill.
const RIVAL_MAX_LEVEL: u8 = 4;
const RIVALRY_SOUR: i16 = 6_000;

/// The relationship-trope KINDS — the per-kind cooldown index (`TropeState.last_kind_at[kind]`). The
/// dispatcher tries them in PRIORITY order (scarce/dramatic first), NOT this declaration order.
#[derive(Clone, Copy)]
#[repr(usize)]
enum TropeKind {
    Betrayal = 0,
    Vendetta = 1,
    HouseFeud = 2,
    UnlikelyFriendship = 3,
    Feud = 4,
    Reunion = 5,
    MiserReformed = 6,
    DebtRepaid = 7,
    FalseWitness = 8,
    MistakenJealousy = 9,
    RivalApprentices = 10,
}
// (N_TROPES in components.rs must equal the count above.)
const _: () = assert!(N_TROPES == 11);

pub fn tick(world: &mut World) {
    // Throttle: only consider drama on the evaluation boundary (never at tick 0).
    if world.tick == 0 || world.tick % EVAL_EVERY != 0 {
        return;
    }
    let now = world.tick;

    // Global one-trope-per-window gate (the TS `sim.time - _lastTropeAt < cooldown`).
    let mut st = world.tropes;
    if st.last_any_at != u32::MAX && now.saturating_sub(st.last_any_at) < TROPE_COOLDOWN {
        return;
    }

    let folk = living_townsfolk(world);
    if folk.len() < MIN_FOLK {
        return;
    }
    // The `_spotlight` focus-rotation: a deterministic start offset so different agents are tried over
    // time even though each scan walks in id order (rng draws are serial ⇒ M-invariant).
    let off = (world.sim_rng.next_f32() * folk.len() as f32) as usize % folk.len();

    // PRIORITY order: scarce/dramatic tropes FIRST (a betrayal / a sworn vendetta / a house feud are
    // major beats and must not be crowded out by the reliable warm filler), the warm filler LAST.
    // (kind, instigator) — fired left-to-right; the first whose constellation EXISTS wins this roll.
    type Row = (TropeKind, fn(&mut World, &[u32], usize, u32) -> bool);
    let rows: [Row; 11] = [
        (TropeKind::Betrayal, do_betrayal),
        (TropeKind::Vendetta, do_vendetta),
        (TropeKind::HouseFeud, do_house_feud),
        (TropeKind::MistakenJealousy, do_mistaken_jealousy),
        (TropeKind::UnlikelyFriendship, do_unlikely_friendship),
        (TropeKind::RivalApprentices, do_rival_apprentices),
        (TropeKind::Feud, do_feud),
        (TropeKind::Reunion, do_reunion),
        (TropeKind::MiserReformed, do_miser_reformed),
        (TropeKind::DebtRepaid, do_debt_repaid),
        (TropeKind::FalseWitness, do_false_witness),
    ];

    for (kind, fire) in rows {
        let k = kind as usize;
        // skip a KIND that fired within its per-kind cooldown — forces the feed to rotate on.
        let last = st.last_kind_at[k];
        if last != u32::MAX && now.saturating_sub(last) < KIND_COOLDOWN {
            continue;
        }
        if fire(world, &folk, off, now) {
            st.last_any_at = now;
            st.last_kind_at[k] = now;
            st.fires += 1;
            world.tropes = st;
            return;
        }
    }
    // nothing fired — still write back (no-op, keeps the clocks consistent if a later edit mutates st).
    world.tropes = st;
}

// ── the tropes (each returns true iff it fired; scans folk in id order from `off`) ───────────────────

/// REUNION — two long-parted townsfolk of ONE house recognize their shared blood: warm BOTH and record
/// a positive (`Succoured`) memory each. Skipped silently when no houses exist (the base sim has none
/// until lineage breeds them — matching the TS `a.house` guard).
fn do_reunion(world: &mut World, folk: &[u32], off: usize, now: u32) -> bool {
    let len = folk.len();
    for i in 0..len {
        let a = folk[(off + i) % len];
        let ha = world.house[a as usize];
        if ha == 0 {
            continue;
        }
        for &b in folk {
            if b == a || world.house[b as usize] != ha {
                continue;
            }
            // not already warmly bonded (the TS "not already close kin" gate, modelled as standing).
            if standing(world, a, b) >= WARM_AMT {
                continue;
            }
            world.warm_belief(a as usize, b, WARM_AMT);
            world.warm_belief(b as usize, a, WARM_AMT);
            remember(world, a, EpisodeKind::Succoured, b, now);
            remember(world, b, EpisodeKind::Succoured, a, now);
            push_beat(world, BEAT_REUNION, a, b as i32);
            return true;
        }
    }
    false
}

/// UNLIKELY FRIENDSHIP — two who bear each other ill will (a soured/hostile belief OR a house feud)
/// strike up a bond: warm ONE side to break the symmetry (gossip/proximity carry the rest).
fn do_unlikely_friendship(world: &mut World, folk: &[u32], off: usize, _now: u32) -> bool {
    let len = folk.len();
    for i in 0..len {
        let a = folk[(off + i) % len];
        let bt = &world.beliefs[a as usize];
        // collect a candidate B (an enmity belief) without holding the borrow across the mutate.
        let mut pick: Option<u32> = None;
        for k in 0..bt.len as usize {
            let body = &bt.bodies[k];
            let b = body.subject;
            if b as usize >= world.n || b == a || !is_town(world, b as usize) {
                continue;
            }
            let enmity = body.standing < GRIEVANCE_STANDING || (body.flags & HOSTILE_BIT) != 0;
            let house_rift = house_feud_between(world, a, b);
            if enmity || house_rift {
                pick = Some(b);
                break;
            }
        }
        if let Some(b) = pick {
            world.warm_belief(a as usize, b, FRIENDSHIP_WARM);
            push_beat(world, BEAT_FRIENDSHIP, a, b as i32);
            return true;
        }
    }
    false
}

/// BETRAYAL — a DURABLE bond turns. `a` warmly trusts `b`; `b` betrays them: `b`'s belief toward `a`
/// craters AND latches hostile, `a`'s trust is wounded, and `a` records an `Assaulted` grudge (the seed
/// the avenge loop grows). A real shift (not a lie) and a lasting wound.
fn do_betrayal(world: &mut World, folk: &[u32], off: usize, now: u32) -> bool {
    let len = folk.len();
    for i in 0..len {
        let a = folk[(off + i) % len];
        // find a partner B that A warmly TRUSTS (a betrayable bond) and who isn't already hostile to A.
        let bt = &world.beliefs[a as usize];
        let mut pick: Option<u32> = None;
        for k in 0..bt.len as usize {
            let body = &bt.bodies[k];
            let b = body.subject;
            if b as usize >= world.n || b == a || !is_town(world, b as usize) {
                continue;
            }
            if body.standing < DURABLE_BOND {
                continue; // only a durable, trusting bond can be betrayed
            }
            // B must not already be latched-hostile to A (no trust left to betray).
            if (world.beliefs[b as usize].find(a))
                .map(|ix| world.beliefs[b as usize].bodies[ix].flags & HOSTILE_BIT != 0)
                .unwrap_or(false)
            {
                continue;
            }
            pick = Some(b);
            break;
        }
        if let Some(b) = pick {
            // B turns on A: crater + LATCH hostile.
            world.sour_belief(b as usize, a, BETRAYAL_DROP, true);
            // A's trust is wounded (soured but not latched — A is the wronged, not the aggressor).
            world.sour_belief(a as usize, b, BETRAYAL_WOUND, false);
            // A carries the grudge — the avenge loop's seed (the wronged hunts the betrayer).
            remember(world, a, EpisodeKind::Assaulted, b, now);
            push_beat(world, BEAT_BETRAYAL, a, b as i32);
            return true;
        }
    }
    false
}

/// MISER REFORMED — a hoarder (low altruism, some gold) is moved to give to a poor neighbour: a
/// CONSERVED gold transfer (debit miser / credit poor — never mints) + the poor's gratitude (warmth).
fn do_miser_reformed(world: &mut World, folk: &[u32], off: usize, now: u32) -> bool {
    let len = folk.len();
    for i in 0..len {
        let m = folk[(off + i) % len];
        let mi = m as usize;
        if world.personality[mi].altruism >= MISER_ALTRUISM || world.econ[mi].gold < MISER_GOLD {
            continue;
        }
        // a poor neighbour (id-order scan).
        let poor = folk.iter().copied().find(|&p| p != m && world.econ[p as usize].gold < POOR_GOLD);
        if let Some(poor) = poor {
            let gift = MISER_GIFT.min(world.econ[mi].gold.max(0));
            if gift <= 0 {
                continue;
            }
            world.econ[mi].gold -= gift; // CLOSED LOOP — a transfer, never a mint
            world.econ[poor as usize].gold += gift;
            // the giving softens the miser; gratitude warms the poor toward the miser.
            world.personality[mi].altruism = (world.personality[mi].altruism + 0.25).clamp(0.0, 1.0);
            world.warm_belief(poor as usize, m, WARM_AMT + 3_000);
            remember(world, poor, EpisodeKind::Succoured, m, now);
            push_beat(world, BEAT_MISER, m, poor as i32);
            return true;
        }
    }
    false
}

/// DEBT REPAID — a holder of a `Succoured` memory repays its saviour: a CONSERVED token gift back + a
/// warming of the bond both ways (honour kept).
fn do_debt_repaid(world: &mut World, folk: &[u32], off: usize, _now: u32) -> bool {
    let len = folk.len();
    for i in 0..len {
        let a = folk[(off + i) % len];
        // find a living-townsperson saviour A was Succoured by (id-order scan of A's memory).
        let mut saviour: Option<u32> = None;
        let mem = world.memory[a as usize];
        for e in mem.items[..mem.len as usize].iter() {
            if e.kind == EpisodeKind::Succoured as u8
                && e.with != u32::MAX
                && e.with != a
                && (e.with as usize) < world.n
                && is_town(world, e.with as usize)
            {
                saviour = Some(e.with);
                break;
            }
        }
        if let Some(s) = saviour {
            // settle the debt with a token gift (conserved) — then warm the bond both ways.
            let gift = DEBT_GIFT.min(world.econ[a as usize].gold.max(0));
            if gift > 0 {
                world.econ[a as usize].gold -= gift;
                world.econ[s as usize].gold += gift;
            }
            world.warm_belief(s as usize, a, WARM_AMT);
            world.warm_belief(a as usize, s, WARM_AMT - 3_000);
            // settle the standing intention: drop the Succoured marker so the debt isn't repaid forever.
            forget(world, a, EpisodeKind::Succoured, s);
            push_beat(world, BEAT_DEBT, a, s as i32);
            return true;
        }
    }
    false
}

/// HOUSE FEUD — two SIZEABLE houses not yet feuding fall into open enmity (children will inherit it).
/// Capped at `HOUSE_FEUD_CAP` live feuds. Skipped silently when fewer than two sizeable houses exist.
fn do_house_feud(world: &mut World, folk: &[u32], _off: usize, _now: u32) -> bool {
    if world.house_feuds.len() >= HOUSE_FEUD_CAP {
        return false;
    }
    // the sizeable houses (≥ HOUSE_MIN_MEMBERS living members), gathered in first-seen id order (a small
    // linear dedup — no HashSet iteration, so the choice is deterministic).
    let mut houses: Vec<u32> = Vec::new();
    for &a in folk {
        let h = world.house[a as usize];
        if h != 0 && !houses.contains(&h) {
            houses.push(h);
        }
    }
    houses.retain(|&h| folk.iter().filter(|&&a| world.house[a as usize] == h).count() >= HOUSE_MIN_MEMBERS);
    for (xi, &ha) in houses.iter().enumerate() {
        for &hb in &houses[xi + 1..] {
            if !are_houses_feuding(world, ha, hb) {
                set_house_feud(world, ha, hb);
                // log against the first living member of house A (the observer the beat rides on).
                let voice = folk.iter().copied().find(|&a| world.house[a as usize] == ha).unwrap_or(0);
                push_beat(world, BEAT_HOUSE_FEUD, voice, hb as i32);
                return true;
            }
        }
    }
    false
}

/// FALSE WITNESS — an ugly whisper poisons an INNOCENT's name: plant SOURED standing (NOT latched
/// hostile — it can heal) of a target into a few neighbours. The target's ground truth is untouched.
fn do_false_witness(world: &mut World, folk: &[u32], off: usize, _now: u32) -> bool {
    let len = folk.len();
    // the target is the spotlight townsperson; the slanderers are the OTHER folk (need at least 2).
    let target = folk[off % len];
    let mut touched = 0usize;
    for &g in folk {
        if touched >= SLANDER_K {
            break;
        }
        if g == target {
            continue;
        }
        world.sour_belief(g as usize, target, SLANDER_DROP, false); // NOT latched — slander can heal
        touched += 1;
    }
    if touched >= 2 {
        push_beat(world, BEAT_SLANDER, target, touched as i32);
        true
    } else {
        false
    }
}

/// FEUD — deepen a simmering pair into open enmity. Prefer the pair that ALREADY mistrusts most (the
/// most-negative existing belief); sour BOTH ways AND LATCH hostile (so the chatting-affinity in
/// perception can't rebuild the standing within a tick and evaporate the feud). If the two belong to
/// different houses, the quarrel becomes a HOUSE feud their lines inherit.
fn do_feud(world: &mut World, folk: &[u32], off: usize, _now: u32) -> bool {
    // most-negative existing (a→b) belief among living townsfolk pairs (id-order scan, deterministic
    // min: lowest standing wins, lowest (a,b) ids break ties).
    let len = folk.len();
    let mut best: Option<(i32, u32, u32)> = None; // (standing, a, b)
    for i in 0..len {
        let a = folk[(off + i) % len];
        let bt = &world.beliefs[a as usize];
        for k in 0..bt.len as usize {
            let body = &bt.bodies[k];
            let b = body.subject;
            if b as usize >= world.n || b == a || !is_town(world, b as usize) {
                continue;
            }
            let cand = (body.standing as i32, a, b);
            match best {
                Some(cur) if cur <= cand => {}
                _ => best = Some(cand),
            }
        }
    }
    // fallback: the first two distinct folk (a chance proximity feud) if no belief pair exists.
    let (a, b) = match best {
        Some((_, a, b)) => (a, b),
        None => {
            if len < 2 {
                return false;
            }
            (folk[off % len], folk[(off + 1) % len])
        }
    };
    if a == b {
        return false;
    }
    world.sour_belief(a as usize, b, FEUD_DROP, true); // LATCH hostile both ways
    world.sour_belief(b as usize, a, FEUD_DROP, true);
    push_beat(world, BEAT_FEUD, a, b as i32);
    // HOUSE FEUD: a cross-house quarrel sets their LINES against each other (lineage inherits it).
    let (ha, hb) = (world.house[a as usize], world.house[b as usize]);
    if ha != 0 && hb != 0 && ha != hb && !are_houses_feuding(world, ha, hb) {
        set_house_feud(world, ha, hb);
    }
    true
}

/// VENDETTA — amplify a REAL grievance into a sworn vendetta: find a townsperson holding a genuine
/// grievance (a soured or already-hostile belief about a living townsperson) and LATCH it hostile so
/// the avenge machinery picks it up. Never manufactured — only fires when an actual grievance exists.
fn do_vendetta(world: &mut World, folk: &[u32], off: usize, _now: u32) -> bool {
    let len = folk.len();
    for i in 0..len {
        let a = folk[(off + i) % len];
        let bt = &world.beliefs[a as usize];
        let mut pick: Option<u32> = None;
        for k in 0..bt.len as usize {
            let body = &bt.bodies[k];
            let b = body.subject;
            if b as usize >= world.n || b == a || !is_town(world, b as usize) {
                continue;
            }
            // a genuine grievance: a real soured standing, but NOT already latched (else nothing to do).
            if body.standing < GRIEVANCE_STANDING && (body.flags & HOSTILE_BIT) == 0 {
                pick = Some(b);
                break;
            }
        }
        if let Some(b) = pick {
            world.sour_belief(a as usize, b, 0, true); // latch the EXISTING grievance hostile
            push_beat(world, BEAT_VENDETTA, a, b as i32);
            return true;
        }
    }
    false
}

/// MISTAKEN JEALOUSY — a misunderstanding strains a real friendship: `a` warmly trusts `b`, but comes
/// (unfoundedly) to suspect them, so `a`'s warmth toward `b` COOLS — without latching hostile (it is a
/// recoverable misunderstanding, not a true betrayal; `b` is unaware and unchanged). The one-sided,
/// reversible cooling that the patrician's reconcile pass can later mend.
fn do_mistaken_jealousy(world: &mut World, folk: &[u32], off: usize, _now: u32) -> bool {
    let len = folk.len();
    for i in 0..len {
        let a = folk[(off + i) % len];
        let bt = &world.beliefs[a as usize];
        let mut pick: Option<u32> = None;
        for k in 0..bt.len as usize {
            let body = &bt.bodies[k];
            let b = body.subject;
            if b as usize >= world.n || b == a || !is_town(world, b as usize) {
                continue;
            }
            // a dear, trusting friend (not already cooled/hostile) — someone to be jealous OVER.
            if body.standing >= JEALOUSY_FRIEND_BOND && (body.flags & HOSTILE_BIT) == 0 {
                pick = Some(b);
                break;
            }
        }
        if let Some(b) = pick {
            world.sour_belief(a as usize, b, JEALOUSY_SOUR, false); // cool, but DON'T latch — recoverable
            push_beat(world, BEAT_JEALOUSY, a, b as i32);
            return true;
        }
    }
    false
}

/// RIVAL APPRENTICES — two still-learning souls of the SAME craft fall into a professional rivalry: a
/// MILD mutual chill (soured both ways, not latched — a competitive edge, not enmity). Only the
/// low-level (apprentices) qualify; masters have nothing left to prove. Seeds the kind of relationship
/// the director can later escalate (a rivalry that hardens) or the patrician reconcile.
fn do_rival_apprentices(world: &mut World, folk: &[u32], off: usize, _now: u32) -> bool {
    let len = folk.len();
    for i in 0..len {
        let a = folk[(off + i) % len];
        let (pa, la) = (world.profession[a as usize], world.level[a as usize]);
        if pa == 0 || la > RIVAL_MAX_LEVEL {
            continue; // no craft, or already past apprenticeship
        }
        // find a DIFFERENT apprentice of the SAME craft (deterministic: first in the rotated scan).
        for j in 0..len {
            let b = folk[(off + j) % len];
            if b == a {
                continue;
            }
            if world.profession[b as usize] == pa
                && world.level[b as usize] <= RIVAL_MAX_LEVEL
                // don't manufacture a rivalry where a bond already exists either way.
                && world.beliefs[a as usize].find(b).is_none()
                && world.beliefs[b as usize].find(a).is_none()
            {
                world.sour_belief(a as usize, b, RIVALRY_SOUR, false);
                world.sour_belief(b as usize, a, RIVALRY_SOUR, false);
                push_beat(world, BEAT_RIVALRY, a, b as i32);
                return true;
            }
        }
    }
    false
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

/// Living-townsfolk ids in id order (the constellation pool every trope scans). Deterministic.
fn living_townsfolk(world: &World) -> Vec<u32> {
    (0..world.n)
        .filter(|&i| world.alive[i] && world.faction[i] == Faction::Townsfolk as u8)
        .map(|i| i as u32)
        .collect()
}

#[inline]
fn is_town(world: &World, i: usize) -> bool {
    i < world.n && world.alive[i] && world.faction[i] == Faction::Townsfolk as u8
}

/// `observer`'s current believed standing toward `subject` (0 if no belief is held).
#[inline]
fn standing(world: &World, observer: u32, subject: u32) -> i16 {
    let bt = &world.beliefs[observer as usize];
    bt.find(subject).map(|ix| bt.bodies[ix].standing).unwrap_or(0)
}

/// Do `a` and `b`'s HOUSES feud? (false if either is houseless.)
#[inline]
fn house_feud_between(world: &World, a: u32, b: u32) -> bool {
    let (ha, hb) = (world.house[a as usize], world.house[b as usize]);
    ha != 0 && hb != 0 && are_houses_feuding(world, ha, hb)
}

/// Record an episodic memory of `kind` about `with` on `observer` (the avenge/repay seed). DEDUP by
/// (kind, with) is handled by `Memory::record`.
fn remember(world: &mut World, observer: u32, kind: EpisodeKind, with: u32, now: u32) {
    let valence = if matches!(kind, EpisodeKind::Assaulted) { -1 } else { 1 };
    world.memory[observer as usize].record(Episode {
        kind: kind as u8,
        place: 0,
        valence,
        _pad: 0,
        with,
        t: now,
        salience: MEM_SALIENCE,
        _pad2: 0,
    });
}

/// Drop a memory of `kind` about `with` on `observer` (settles a repaid debt so it isn't repaid again).
fn forget(world: &mut World, observer: u32, kind: EpisodeKind, with: u32) {
    let mem = &mut world.memory[observer as usize];
    let mut w = 0usize;
    for r in 0..mem.len as usize {
        let keep = !(mem.items[r].kind == kind as u8 && mem.items[r].with == with);
        if keep {
            mem.items[w] = mem.items[r];
            w += 1;
        }
    }
    mem.len = w as u8;
}

/// Push a relationship-trope chronicle beat (the observer feed; render-only text generated later).
fn push_beat(world: &mut World, kind: u8, subject: u32, magnitude: i32) {
    world.chronicle.push(Beat { t: world.tick, kind, subject, magnitude });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::Faction;
    use crate::world::World;

    /// Make the whole roster living townsfolk with clean beliefs/memory (a blank slate for a trope).
    fn all_townsfolk(w: &mut World) {
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.beliefs[i].len = 0;
            w.memory[i].len = 0;
            w.house[i] = 0;
        }
    }

    /// A BETRAYAL craters the bond AND latches hostility: the betrayer ends up latched-hostile to the
    /// victim with a deeply-soured standing, and the victim carries an `Assaulted` grudge.
    #[test]
    fn betrayal_craters_a_bond_and_latches_hostility() {
        let mut w = World::spawn(0xBE7A, 6);
        all_townsfolk(&mut w);
        // agent 0 warmly TRUSTS agent 1 (a durable, betrayable bond).
        w.warm_belief(0, 1, 20_000);
        let folk = living_townsfolk(&w);
        assert!(do_betrayal(&mut w, &folk, 0, 100), "a durable bond should be betrayable");

        // the betrayer (1) is now latched-hostile to the victim (0), with a soured standing.
        let ix = w.beliefs[1].find(0).expect("the betrayer now holds a belief about the victim");
        let body = w.beliefs[1].bodies[ix];
        assert_eq!(body.flags & HOSTILE_BIT, HOSTILE_BIT, "the betrayer latches hostile to the victim");
        assert!(body.standing < 0, "the betrayer's standing toward the victim is soured, got {}", body.standing);
        // the victim (0) carries the `Assaulted` grudge the avenge loop grows.
        assert!(w.memory[0].has(EpisodeKind::Assaulted, 1), "the victim resents the betrayer");
        // and a betrayal beat is logged.
        assert!(w.chronicle.iter().any(|b| b.kind == BEAT_BETRAYAL), "a betrayal beat is logged");
    }

    /// MISTAKEN JEALOUSY cools a dear friendship one-sidedly WITHOUT latching hostility (recoverable).
    #[test]
    fn mistaken_jealousy_cools_a_friendship_without_latching() {
        let mut w = World::spawn(0x9EA1, 6);
        all_townsfolk(&mut w);
        w.warm_belief(0, 1, 18_000); // agent 0 dearly trusts agent 1
        let before = w.beliefs[0].bodies[w.beliefs[0].find(1).unwrap()].standing;
        let folk = living_townsfolk(&w);
        assert!(do_mistaken_jealousy(&mut w, &folk, 0, 100), "a dear friendship can be strained");
        let body = w.beliefs[0].bodies[w.beliefs[0].find(1).unwrap()];
        assert!(body.standing < before, "the warmth cooled, got {} (was {before})", body.standing);
        assert_eq!(body.flags & HOSTILE_BIT, 0, "a misunderstanding does NOT latch hostile");
        assert!(w.chronicle.iter().any(|b| b.kind == BEAT_JEALOUSY), "a jealousy beat is logged");
    }

    /// RIVAL APPRENTICES: two low-level souls of the same craft fall into a mild MUTUAL rivalry.
    #[test]
    fn rival_apprentices_form_a_mutual_chill() {
        let mut w = World::spawn(0x9EA2, 6);
        all_townsfolk(&mut w);
        // two apprentices of the same craft (profession 4 = blacksmith), still low level.
        w.profession[0] = 4;
        w.level[0] = 1;
        w.profession[1] = 4;
        w.level[1] = 2;
        // everyone else a different craft so the pair (0,1) is the rivalry.
        for i in 2..w.n {
            w.profession[i] = 1;
        }
        let folk = living_townsfolk(&w);
        assert!(do_rival_apprentices(&mut w, &folk, 0, 100), "two same-craft apprentices become rivals");
        let a = w.beliefs[0].bodies[w.beliefs[0].find(1).expect("0 now regards 1")];
        let b = w.beliefs[1].bodies[w.beliefs[1].find(0).expect("1 now regards 0")];
        assert!(a.standing < 0 && b.standing < 0, "a MUTUAL chill");
        assert_eq!(a.flags & HOSTILE_BIT, 0, "a rivalry is a chill, not open enmity");
        assert!(w.chronicle.iter().any(|b| b.kind == BEAT_RIVALRY), "a rivalry beat is logged");
    }

    /// A HOUSE FEUD is recorded between two sizeable houses (and the canonical pair is queryable).
    #[test]
    fn house_feud_is_recorded() {
        let mut w = World::spawn(0xF0F0, 8);
        all_townsfolk(&mut w);
        // two sizeable houses: {0,1} in house 7, {2,3} in house 9 (each ≥ HOUSE_MIN_MEMBERS).
        w.house[0] = 7;
        w.house[1] = 7;
        w.house[2] = 9;
        w.house[3] = 9;
        let folk = living_townsfolk(&w);
        assert!(do_house_feud(&mut w, &folk, 0, 100), "two sizeable houses should fall into feud");
        assert!(are_houses_feuding(&w, 7, 9), "the two houses are recorded as feuding");
        assert!(are_houses_feuding(&w, 9, 7), "the feud is canonical (queryable either way)");
        assert!(w.chronicle.iter().any(|b| b.kind == BEAT_HOUSE_FEUD), "a house-feud beat is logged");
    }

    /// REUNION warms two same-house souls both ways and records a positive memory each.
    #[test]
    fn reunion_warms_same_house_kin() {
        let mut w = World::spawn(0x4E11, 6);
        all_townsfolk(&mut w);
        w.house[0] = 4;
        w.house[1] = 4; // same house, not yet bonded
        let folk = living_townsfolk(&w);
        assert!(do_reunion(&mut w, &folk, 0, 100), "two same-house souls should reunite");
        assert!(standing(&w, 0, 1) >= WARM_AMT, "0 warms toward 1");
        assert!(standing(&w, 1, 0) >= WARM_AMT, "1 warms toward 0");
        assert!(w.memory[0].has(EpisodeKind::Succoured, 1) && w.memory[1].has(EpisodeKind::Succoured, 0));
    }

    /// MISER REFORMED moves gold debit-one / credit-other — total gold is CONSERVED (never minted).
    #[test]
    fn miser_gift_conserves_gold() {
        let mut w = World::spawn(0xC0FFEE, 6);
        all_townsfolk(&mut w);
        // a close-fisted hoarder (0) with gold; a pauper (1) nearby.
        w.personality[0].altruism = 0.1;
        w.econ[0].gold = 50;
        w.econ[1].gold = 2;
        let before = w.total_gold();
        let folk = living_townsfolk(&w);
        assert!(do_miser_reformed(&mut w, &folk, 0, 100), "a hoarder with a poor neighbour should give");
        assert_eq!(w.total_gold(), before, "a miser's gift is a transfer — gold is conserved");
        assert!(w.econ[1].gold > 2, "the pauper is richer");
        assert!(w.econ[0].gold < 50, "the miser is poorer");
        assert!(w.personality[0].altruism > 0.1, "the giving softens the miser");
        assert!(w.memory[1].has(EpisodeKind::Succoured, 0), "the pauper remembers the kindness");
    }

    /// A FEUD sours BOTH ways and LATCHES hostility (so perception can't rebuild it within a tick).
    #[test]
    fn feud_latches_mutual_hostility() {
        let mut w = World::spawn(0xFEED5, 6);
        all_townsfolk(&mut w);
        // a simmering dislike 0→1 so the "prefer the most-soured pair" path picks them.
        w.sour_belief(0, 1, 5_000, false);
        let folk = living_townsfolk(&w);
        assert!(do_feud(&mut w, &folk, 0, 100), "a simmering pair should erupt into a feud");
        let h01 = w.beliefs[0].find(1).map(|ix| w.beliefs[0].bodies[ix].flags & HOSTILE_BIT).unwrap();
        let h10 = w.beliefs[1].find(0).map(|ix| w.beliefs[1].bodies[ix].flags & HOSTILE_BIT).unwrap();
        assert_eq!(h01, HOSTILE_BIT, "0 latches hostile to 1");
        assert_eq!(h10, HOSTILE_BIT, "1 latches hostile to 0");
    }

    /// VENDETTA latches an EXISTING grievance hostile but never manufactures one from nothing.
    #[test]
    fn vendetta_latches_a_real_grievance_only() {
        let mut w = World::spawn(0x7E57, 6);
        all_townsfolk(&mut w);
        let folk = living_townsfolk(&w);
        // no grievance exists ⇒ no vendetta.
        assert!(!do_vendetta(&mut w, &folk, 0, 100), "a vendetta is never manufactured from nothing");
        // a real soured (un-latched) grievance 0→1 ⇒ it latches hostile.
        w.sour_belief(0, 1, 15_000, false);
        assert!(do_vendetta(&mut w, &folk, 0, 100), "a real grievance is sworn into a vendetta");
        let ix = w.beliefs[0].find(1).unwrap();
        assert_eq!(w.beliefs[0].bodies[ix].flags & HOSTILE_BIT, HOSTILE_BIT, "the grievance is latched hostile");
    }

    /// DEBT REPAID moves a token back to the saviour (conserved) and clears the Succoured marker.
    #[test]
    fn debt_repaid_conserves_and_settles() {
        let mut w = World::spawn(0xDEB7, 6);
        all_townsfolk(&mut w);
        // agent 0 was Succoured by agent 2; 0 holds some gold to repay.
        remember(&mut w, 0, EpisodeKind::Succoured, 2, 0);
        w.econ[0].gold = 20;
        let before = w.total_gold();
        let folk = living_townsfolk(&w);
        assert!(do_debt_repaid(&mut w, &folk, 0, 100), "a Succoured holder should repay its saviour");
        assert_eq!(w.total_gold(), before, "the repayment is a transfer — gold is conserved");
        assert!(!w.memory[0].has(EpisodeKind::Succoured, 2), "the settled debt's marker is cleared");
        assert!(standing(&w, 2, 0) > 0, "the saviour warms toward the one who repaid");
    }

    /// Determinism: the full sim (incl. the relationship-trope society pass) is order-independent
    /// across rayon pool sizes (M=1 ≡ M=N), proven via the world golden hash.
    #[test]
    fn society_tropes_m_invariant() {
        use crate::hash::world_hash;
        use crate::{in_pool, run_sim};
        let h1 = in_pool(1, || world_hash(&run_sim(0x77A9, 600, 80)));
        let h4 = in_pool(4, || world_hash(&run_sim(0x77A9, 600, 80)));
        assert_eq!(h1, h4, "the relationship-trope society pass must be M-invariant");
    }
}
