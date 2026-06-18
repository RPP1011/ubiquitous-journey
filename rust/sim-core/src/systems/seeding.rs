//! FAN-OUT UNIT: seeding — plant the initial relationship CONSTELLATIONS the drama systems grow into
//! recognizable tropes. Ports the SPIRIT of `js/sim/seeding.ts` (doc 22 §9 — the spirit, not the
//! letter): we don't script stories, we seed the starting RELATIONSHIPS + state, then the systems we
//! already have (lineage apprenticeship, the class/XP brain, memory-grudges, the director) play them
//! out. `seed_narratives(world)` runs ONCE, at the END of `World::spawn` (after the map is built),
//! NOT per tick.
//!
//! THE FLAGSHIP TROPE — RIVAL APPRENTICES. A seasoned MASTER of a trade and TWO young apprentices who
//! resent each other. The master is spawned as a SEASONED blacksmith (a smithing-dominant behaviour
//! profile, the blacksmith class granted at a master's level), the apprentices young + smithing-
//! leaning + driven (high ambition). The RIVALRY is planted two ways so it doesn't mellow into
//! friendship: mutual NEGATIVE belief-standing (the relations/decide read) AND a durable `Assaulted`
//! grudge MEMORY on each (which fades 5× slower in the GOAP — the rivalry stays part of who they are).
//! Mentorship is mutual WARM beliefs master<->apprentices (the bond relationship).
//!
//! THE AUTHORING HELPERS — `force_betrayal` / `false_witness`: pure functions that stamp a targeted
//! constellation via the shared belief/memory seed helpers, callable at world build OR from a test.
//!   - force_betrayal(a,b): a TRUSTED b (warm a→b), then the wrong lands (a's standing toward b
//!     craters + a fresh `Assaulted` memory of b) — the seed the avenge/vendetta loop grows.
//!   - false_witness(victim, accuser): brand an innocent — plant SUSPICION (soured standing, NOT
//!     latched-hostile) of the victim into the nearby townsfolk, so the slander spreads as belief.
//!
//! WHAT WE SKIP (doc 22 §9 — out of headless scope): the STRING display-names ("Master Hadrin",
//! "Cael"/"Doran") are render-only — agents are numeric ids here, so the evocative names are dropped.
//! The Director-ARC pushes (`sim.sagas.openArc` / `director._arcs.push` for vendetta/reckoning/accused)
//! are SKIPPED — there is no arc/saga registry in this wave (a later wave's work); the belief/memory
//! seed is the load-bearing half and it survives. The catalog ability arming (`armFromCatalog`) is
//! likewise dropped (no ability-DSL column yet); the granted class + level is the seasoned-master cue.
//!
//! Determinism: runs ONCE in the SERIAL worldgen (`World::spawn`) — no rng, no hash iteration; spawns
//! go through `World::spawn_agent` (0 gold ⇒ never mints), belief/memory seeds are direct serial
//! writes via the world helpers. Trivially M-invariant (it's worldgen, before any parallel phase).

use crate::components::{Beat, Episode, EpisodeKind, Faction, Profession};
use crate::world::World;

// ── tuning (mirrors `SEEDS.rivalApprentices.*` in js/sim/simconfig.ts) ──
/// How many master+2-apprentice trios to plant (`SEEDS.rivalApprentices.trios`).
const TRIOS: usize = 1;
/// The seasoned master's class level (`masterLevel` — seed a veteran, ≥ LINEAGE.masterMinLevel).
const MASTER_LEVEL: u16 = 8;
/// A young apprentice's starting level (level 0/1 so the apprenticeship pass picks them up).
const APPRENTICE_LEVEL: u8 = 1;
/// Driven apprentices work hard → earn XP (`apprenticeAmbition`).
const APPRENTICE_AMBITION: f32 = 0.85;
/// The master keeps to the defended core, so it survives to teach (a low risk-tolerance homebody).
const MASTER_RISK: f32 = 0.25;

/// The trade-identity behaviour tags the master TEACHES (a craft-dominant profile so the class matcher
/// reads it as a blacksmith and XP routes to the trade — `masterTags: {SMITHING, CRAFTING, …}`).
const MASTER_SMITHING: f32 = 30.0;
const MASTER_CRAFTING: f32 = 18.0;
/// A strong APPRENTICE lean toward the trade (`apprenticeTags`) so their early deeds stay a smithing one.
const APPRENTICE_SMITHING: f32 = 22.0;
const APPRENTICE_CRAFTING: f32 = 10.0;

/// The blacksmith class key (matches `systems::progression` TEMPLATES key 4) — the master's granted class.
const BLACKSMITH_KEY: u8 = 4;
/// Behaviour-profile tag indices (mirror `systems::progression::TAG_*`).
const TAG_SMITHING: usize = 6;
const TAG_CRAFTING: usize = 7;

/// The two apprentices' MUTUAL belief-standing drop (`rivalry: -0.55`, on the i16 −1..1 belief scale).
const RIVALRY_DROP: i16 = (0.55 * 32767.0) as i16;
/// The mentorship WARM each way (master<->apprentice) — a felt bond, on the i16 belief scale.
const MENTOR_WARM: i16 = (0.6 * 32767.0) as i16;

/// Salience of a seeded rivalry grudge (drives memory survival + intention priority). High so it
/// endures (mirrors the durable `bond('rival')` the TS records).
const RIVALRY_SALIENCE: u16 = 52_000;

/// The interned `Beat.kind` for a seeded mentorship (the observer feed; render-only text generated
/// later from the Beat). Distinct from every other system's kind (chronicle 0/1, director 2/10/11/12,
/// lineage 3, houses 20, patrician/watch 22, intrigue 30).
pub const BEAT_MENTOR: u8 = 40;

/// Cluster offset for a trio from the town core (a quiet spot inside the defended ring; successive
/// trios spread apart a little — the deterministic `8 + idx*6` base from the TS).
fn trio_base(world: &World, idx: usize) -> [f32; 2] {
    let nt = world.town_centers.len().max(1);
    let c = world.town_centers[idx % nt]; // trio `idx` belongs to town `idx % nt`
    let off = 8.0 + (idx / nt) as f32 * 6.0; // successive trios in the SAME town spread apart
    [c[0] + off, c[1] + off]
}

/// THE ENTRY POINT — plant every seed once. Called at the END of `World::spawn`. A rival-apprentice
/// family is seeded in EVERY settlement (founding drama region-wide, not just town 0): TRIOS families
/// per town, distributed by `idx % n_towns`.
pub fn seed_narratives(world: &mut World) {
    let nt = world.town_centers.len().max(1);
    for idx in 0..(TRIOS * nt) {
        seed_rival_apprentices(world, idx);
    }
}

/// Build one trade family: a veteran master + two rival apprentices, clustered near the town core so
/// the (proximity-gated) apprenticeship pass immediately recognises the master.
fn seed_rival_apprentices(world: &mut World, idx: usize) {
    let base = trio_base(world, idx);
    let town = (idx % world.town_centers.len().max(1)) as u16; // the settlement this family belongs to

    // A homebody master near the defended core. Spawned a SEASONED blacksmith: a craft-dominant
    // profile (so the matcher reads a master + XP routes to smithing), the class granted at a master's
    // level. Spawned via `spawn_agent` ⇒ 0 gold (never mints).
    let master = world.spawn_agent(base, Faction::Townsfolk, Profession::Blacksmith);
    world.personality[master].ambition = 0.6;
    world.personality[master].social_drive = 0.6;
    world.personality[master].risk_tolerance = MASTER_RISK;
    {
        let bp = &mut world.progression[master].behavior_profile;
        bp[TAG_SMITHING] += MASTER_SMITHING;
        bp[TAG_CRAFTING] += MASTER_CRAFTING;
    }
    grant_seeded_class(world, master, BLACKSMITH_KEY, MASTER_LEVEL);

    // Two apprentices flanking the master (well within the apprenticeship range) — young, driven, and
    // already leaning toward the craft.
    let a = world.spawn_agent([base[0] - 3.0, base[1] + 2.0], Faction::Townsfolk, Profession::Blacksmith);
    let b = world.spawn_agent([base[0] + 3.0, base[1] + 2.0], Faction::Townsfolk, Profession::Blacksmith);
    // the whole family belongs to its settlement (spawn_agent defaults town 0 — set it so they live,
    // work, and trade in their OWN town's economy, not town 0's).
    world.town[master] = town;
    world.town[a] = town;
    world.town[b] = town;
    for &ap in &[a, b] {
        world.level[ap] = APPRENTICE_LEVEL;
        world.personality[ap].ambition = APPRENTICE_AMBITION;
        world.personality[ap].risk_tolerance = 0.4;
        let bp = &mut world.progression[ap].behavior_profile;
        bp[TAG_SMITHING] += APPRENTICE_SMITHING;
        bp[TAG_CRAFTING] += APPRENTICE_CRAFTING;
    }

    // THE RIVALRY, two ways so it doesn't simply mellow into friendship:
    //  - mutual NEGATIVE belief-standing (the relations view + decide read it), and
    //  - a durable `Assaulted` grudge MEMORY on each (the GOAP fades grudges slowest, so the rivalry
    //    stays part of who they are). NOT latched-hostile — a rivalry is competition, not a vendetta.
    world.sour_belief(a, b as u32, RIVALRY_DROP, false);
    world.sour_belief(b, a as u32, RIVALRY_DROP, false);
    seed_rivalry_memory(world, a, b as u32);
    seed_rivalry_memory(world, b, a as u32);

    // THE MENTORSHIP — mutual WARM beliefs master<->apprentices (the bond relationship; the
    // apprenticeship pass reinforces it). `warm_belief` both ways = a "bond" per the substrate note.
    world.warm_belief(a, master as u32, MENTOR_WARM);
    world.warm_belief(b, master as u32, MENTOR_WARM);
    world.warm_belief(master, a as u32, MENTOR_WARM);
    world.warm_belief(master, b as u32, MENTOR_WARM);

    // A mentorship Beat so the seeded premise is legible from the first minute (observer feed).
    world.chronicle.push(Beat {
        t: world.tick,
        kind: BEAT_MENTOR,
        subject: master as u32,
        magnitude: a as i32,
    });
}

/// Grant a specific TEMPLATE class at a seeded level (a veteran) — the SoA analogue of TS
/// `grantSeededClass` (`prog._grantClass` + `cls.level = level` + recompute `totalLevel`). Idempotent
/// per class key. `total_level` is the cached sum of held-class levels; here one class carries it.
fn grant_seeded_class(world: &mut World, i: usize, key: u8, level: u16) {
    let prog = &mut world.progression[i];
    if prog.holds(key) {
        return;
    }
    let slot = prog.n_classes as usize;
    if slot >= prog.classes.len() {
        return;
    }
    prog.classes[slot] = key;
    prog.n_classes += 1;
    // a master is at least level 1; the cached total carries the seeded class level (one class held).
    prog.total_level = prog.total_level.saturating_add(level.max(1));
}

/// Record a durable rivalry grudge memory on `observer` about `subject` — an `Assaulted` episode (the
/// kind the GOAP fades SLOWEST), so the felt rivalry survives even after the belief-standing decays.
fn seed_rivalry_memory(world: &mut World, observer: usize, subject: u32) {
    world.memory[observer].record(Episode {
        kind: EpisodeKind::Assaulted as u8,
        place: 0,
        valence: -1,
        _pad: 0,
        with: subject,
        t: world.tick,
        salience: RIVALRY_SALIENCE,
        _pad2: 0,
    });
}

// ============================================================================
// THE AUTHORING / TARGETING HELPERS (js/sim/seeding.ts §4 — the SET-UP axis), ported via the shared
// belief/memory seed helpers. Pure functions; callable at world build OR from a test. The Director-arc
// pushes the TS does alongside these are SKIPPED (no arc registry this wave) — the belief/memory seed
// is the load-bearing half.
// ============================================================================

/// FORCE BETRAYAL — `a` trusts `b`, then `b` wrongs `a`. Warms a→b (the trust), then craters a's
/// standing toward b (latching hostility) AND plants a fresh `Assaulted` memory — the seed the
/// avenge/vendetta loop grows. Returns false if either id is invalid. Mirrors TS `forceBetrayal`
/// (minus the saga/director-arc push).
pub fn force_betrayal(world: &mut World, a: usize, b: usize) -> bool {
    if a >= world.n || b >= world.n || a == b {
        return false;
    }
    // a TRUSTED b first (warm a→b) …
    world.warm_belief(a, b as u32, MENTOR_WARM);
    // … then the wrong lands — a's opinion of b craters and latches hostile (the betrayal).
    world.sour_belief(a, b as u32, (0.9 * 32767.0) as i16, true);
    world.memory[a].record(Episode {
        kind: EpisodeKind::Assaulted as u8,
        place: 0,
        valence: -1,
        _pad: 0,
        with: b as u32,
        t: world.tick,
        salience: 60_000,
        _pad2: 0,
    });
    true
}

/// How near (metres) a witness must be to the victim to absorb the slander (`pos.distanceTo < 30`).
const SLANDER_RANGE2: f32 = 30.0 * 30.0;
/// How far the false-witness rumour sinks the victim's standing in a witness (suspicion, not hostility).
const SLANDER_DROP: i16 = (0.6 * 32767.0) as i16;

/// FALSE WITNESS — brand an innocent. Plant SUSPICION of the victim into the nearby living townsfolk
/// (a soured standing, NOT latched-hostile — a rumour, not a declared feud), so the slander spreads as
/// belief. Returns the number of witnesses poisoned. Mirrors TS `falseWitness` (minus the accuser
/// provenance string + the director-arc push). The `accuser` is accepted for signature parity but,
/// lacking a belief `source` field in this wave, only gates self-exclusion.
pub fn false_witness(world: &mut World, victim: usize, _accuser: Option<usize>) -> usize {
    if victim >= world.n {
        return 0;
    }
    let vpos = world.pos[victim];
    // collect targets first (an immutable scan), then seed (mutable) — no overlapping borrow.
    let mut witnesses: Vec<usize> = Vec::new();
    for w in 0..world.n {
        if w == victim || !world.alive[w] || world.faction[w] != Faction::Townsfolk as u8 {
            continue;
        }
        let dx = world.pos[w][0] - vpos[0];
        let dz = world.pos[w][1] - vpos[1];
        if dx * dx + dz * dz > SLANDER_RANGE2 {
            continue;
        }
        witnesses.push(w);
    }
    for &w in &witnesses {
        world.sour_belief(w, victim as u32, SLANDER_DROP, false);
    }
    witnesses.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::World;

    /// A seeded world holds exactly one rival-apprentice trio: 3 new townsfolk beyond the base roster.
    #[test]
    fn spawn_plants_a_trio() {
        let base = 12usize;
        let w = World::spawn(0x5EED, base);
        // the trio is appended at the end of worldgen (3 agents per trio).
        assert_eq!(w.n, base + 3 * TRIOS, "seeding adds one trio (master + 2 apprentices)");
    }

    /// The trio's three members are the last three ids: a blacksmith master + two blacksmith apprentices.
    fn trio_ids(w: &World) -> (usize, usize, usize) {
        let master = w.n - 3;
        (master, master + 1, master + 2)
    }

    /// The master is a SEASONED blacksmith: granted the blacksmith class, a master's total level, and a
    /// smithing-dominant behaviour profile.
    #[test]
    fn master_is_a_seasoned_blacksmith() {
        let w = World::spawn(0x5EED1, 12);
        let (master, _, _) = trio_ids(&w);
        assert_eq!(w.profession[master], Profession::Blacksmith as u8, "the master smiths");
        assert!(w.progression[master].holds(BLACKSMITH_KEY), "the master holds the blacksmith class");
        assert_eq!(w.progression[master].total_level, MASTER_LEVEL, "a master's level");
        assert!(
            w.progression[master].behavior_profile[TAG_SMITHING] >= MASTER_SMITHING,
            "the master teaches a smithing-dominant identity"
        );
    }

    /// The two apprentices hold a MUTUAL rivalry: each soured toward the other in BOTH belief + memory.
    #[test]
    fn apprentices_are_rivals_both_ways() {
        let w = World::spawn(0x5EED2, 12);
        let (_, a, b) = trio_ids(&w);
        // belief standing soured each way …
        let bel_ab = w.facts[a].view(b as u32).map(|v| v.standing);
        let bel_ba = w.facts[b].view(a as u32).map(|v| v.standing);
        assert!(bel_ab.is_some_and(|s| s < 0), "a resents b (soured standing)");
        assert!(bel_ba.is_some_and(|s| s < 0), "b resents a (soured standing)");
        // … and a durable grudge MEMORY each way.
        assert!(w.memory[a].has(EpisodeKind::Assaulted, b as u32), "a holds a rivalry grudge of b");
        assert!(w.memory[b].has(EpisodeKind::Assaulted, a as u32), "b holds a rivalry grudge of a");
        // the rivalry is NOT latched-hostile (a rivalry is competition, not a vendetta).
        let hostile = w.facts[a].view(b as u32).is_some_and(|v| v.flags & 0x01 != 0);
        assert!(!hostile, "a rivalry is not a latched-hostile vendetta");
    }

    /// Mentorship is a mutual WARM bond master<->each apprentice.
    #[test]
    fn mentorship_is_a_mutual_warm_bond() {
        let w = World::spawn(0x5EED3, 12);
        let (master, a, b) = trio_ids(&w);
        for &ap in &[a, b] {
            let m2a = w.facts[master].view(ap as u32).map(|v| v.standing);
            let a2m = w.facts[ap].view(master as u32).map(|v| v.standing);
            assert!(m2a.is_some_and(|s| s > 0), "the master is fond of the apprentice");
            assert!(a2m.is_some_and(|s| s > 0), "the apprentice is fond of the master");
        }
        // a mentorship Beat is logged (the observer feed).
        assert!(w.chronicle.iter().any(|bt| bt.kind == BEAT_MENTOR), "a mentorship Beat is logged");
    }

    /// Seeding mints NO gold: the trio carries 0 gold (spawned via `spawn_agent`), so the worldgen total
    /// is exactly the base roster's gold.
    #[test]
    fn seeding_conserves_gold() {
        let w = World::spawn(0x5EED4, 12);
        let (master, a, b) = trio_ids(&w);
        for &m in &[master, a, b] {
            assert_eq!(w.econ[m].gold, 0, "a seeded trio member carries 0 gold (no minting)");
            assert_eq!(w.econ[m].stash, 0, "and 0 stash");
        }
    }

    /// `force_betrayal` plants the avenge seed: a's standing toward b craters (latched hostile) and a
    /// fresh `Assaulted` memory of b is recorded.
    #[test]
    fn force_betrayal_plants_the_avenge_seed() {
        let mut w = World::spawn(0xB17A, 8);
        assert!(force_betrayal(&mut w, 0, 1), "a valid betrayal applies");
        let bel = w.facts[0].view(1).expect("a now holds a belief of b");
        assert!(bel.standing < 0, "a's opinion of b craters");
        assert!(bel.flags & 0x01 != 0, "the betrayal latches hostility");
        assert!(w.memory[0].has(EpisodeKind::Assaulted, 1), "a remembers the wrong (the avenge seed)");
        // invalid ids are rejected.
        assert!(!force_betrayal(&mut w, 0, 0), "self-betrayal is rejected");
        assert!(!force_betrayal(&mut w, 999, 1), "out-of-range id is rejected");
    }

    /// `false_witness` poisons the NEARBY townsfolk against an innocent (soured, not hostile), and
    /// leaves the far-away untouched.
    #[test]
    fn false_witness_poisons_the_nearby() {
        let mut w = World::spawn(0xFA15E, 8);
        // make a clean town; co-locate witness 1 with the victim 0, banish witness 2 far away.
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
        }
        w.pos[0] = [0.0, 0.0];
        w.pos[1] = [1.0, 1.0]; // near (< 30 m)
        w.pos[2] = [500.0, 500.0]; // far
        let poisoned = false_witness(&mut w, 0, Some(3));
        assert!(poisoned >= 1, "at least the near witness is poisoned");
        let near = w.facts[1].view(0).map(|v| v.standing);
        assert!(near.is_some_and(|s| s < 0), "the near witness now suspects the victim");
        // suspicion is NOT latched-hostile (a rumour, not a declared feud).
        let near_hostile = w.facts[1].view(0).is_some_and(|v| v.flags & 0x01 != 0);
        assert!(!near_hostile, "false witness plants suspicion, not declared hostility");
        // the far witness is untouched.
        assert!(!w.facts[2].believes(0), "the far witness heard no rumour");
    }

    /// Determinism: a seeded world is M-invariant (M=1 ≡ M=4) — seeding runs at worldgen, before any
    /// parallel phase, so it can't perturb the M-invariant tick.
    #[test]
    fn seeding_is_m_invariant() {
        use crate::hash::world_hash;
        use crate::{in_pool, run_sim};
        let h1 = in_pool(1, || world_hash(&run_sim(0x5EEDA, 80, 300)));
        let h4 = in_pool(4, || world_hash(&run_sim(0x5EEDA, 80, 300)));
        assert_eq!(h1, h4, "seeding must not perturb M-invariance");
    }
}
