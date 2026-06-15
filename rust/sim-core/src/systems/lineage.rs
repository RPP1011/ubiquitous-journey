//! FAN-OUT UNIT: lineage (births / population). Ports the SPIRIT of `js/sim/lineage.js` — the
//! renewal-without-aging population loop: a stable, fit couple bears a child townsperson over time,
//! the child inherits a fraction of a parent's behaviour tags (so trades run in families) and a
//! parent's house, and growth is soft-capped (Director raids are the real population control).
//!
//! WHY THIS IS DETERMINISTIC (the M-invariance gate): the whole pass runs in the SERIAL society
//! phase (`World::society_phase`), so it is trivially M-invariant (M=1 ≡ M=N). It draws ONLY from
//! `world.sim_rng` (the world-level serial stream — never a per-entity `rng[i]`), throttles on
//! `world.tick`, and selects couples by a fixed id-order scan with explicit tie-breaks. Spawns go
//! through `world.spawn_agent` (children carry 0 gold by construction); a dowry is MOVED from a
//! parent (debit parent / credit child) and clamped to what the parent holds — never minted, so the
//! `gold_conserved` gate holds.
//!
//! WHAT THE JS DOES THAT WE DON'T (doc 22 §9 — port the SPIRIT, not the letter): the JS keeps
//! persistent `mateId` couples, per-pair gestation maps, courtship scoring, apprenticeship, feuds,
//! and reconciliation. Wave-3 has no `mate`/`memory`/`personality` columns, so we port the load-
//! bearing loop — births under a soft cap from a deterministically-chosen fit couple, with tag +
//! house + (conserved) dowry inheritance — and leave the social-graph drama to a later wave.

use crate::components::{Beat, Faction, Profession, N_TAGS};
use crate::world::World;

// ── tuning (mirrors `LINEAGE.*` in js/sim/simconfig.ts, re-expressed in ticks) ──
/// Throttle: run the births pass every N ticks (the JS `tickEvery` is sim-seconds; in ticks this is
/// the analogue cadence — frequent enough to grow a quiet town, sparse enough to stay cheap).
const TICK_EVERY: u32 = 16;
/// Per-town living-townsfolk soft cap (`LINEAGE.popSoftCap`). Wave-3 is a single town ⇒ ×1.
const POP_SOFT_CAP: usize = 28;
/// Both parents' hunger must be ≥ this to be "well-enough fed" (`LINEAGE.fedHunger`).
const FED_HUNGER: f32 = 0.4;
/// How close two townsfolk must be (metres) to court / be a couple (`LINEAGE.mateRange`).
const MATE_RANGE: f32 = 16.0;
/// Mutual belief-standing each must hold of the other to be "fond" (`LINEAGE.pairStanding`,
/// quantized to the i16 belief scale: −1..1 → −32768..32767).
const PAIR_STANDING: i16 = (0.3 * 32767.0) as i16;
/// Gold MOVED from the richer parent to the child (never minted; `LINEAGE.dowry`, ×100 minor units
/// to match the worldgen gold scale).
const DOWRY: i64 = 6 * 100;
/// Top-N of a parent's behaviour tags the child inherits, at this fraction (`LINEAGE.inheritTag*`).
const INHERIT_TAG_TOP: usize = 3;
const INHERIT_TAG_FRACTION: f32 = 0.3;
/// Beat kind id for a birth (the numeric `BeatKind` interning — see `components::Beat`).
const BEAT_BIRTH: u8 = 3;
/// Keep the chronicle bounded so a long run can't grow it without limit.
const CHRONICLE_CAP: usize = 4096;

/// Is `i` an alive townsperson eligible to be a parent? (never a monster/raider/player.)
#[inline]
fn is_civ(w: &World, i: usize) -> bool {
    w.alive[i] && w.faction[i] == Faction::Townsfolk as u8
}

/// Count of living townsfolk (the soft-cap gate).
fn living_townsfolk(w: &World) -> usize {
    (0..w.n).filter(|&i| is_civ(w, i)).count()
}

/// Is agent `i` fed enough to parent?
#[inline]
fn fed(w: &World, i: usize) -> bool {
    w.needs[i].hunger >= FED_HUNGER
}

/// Does `a` hold a fond (high-standing) belief about `b`? Belief-only read (the epistemic split).
#[inline]
fn fond_toward(w: &World, a: usize, b: usize) -> bool {
    let bt = &w.beliefs[a];
    if let Some(idx) = bt.find(b as u32) {
        bt.bodies[idx].standing >= PAIR_STANDING
    } else {
        false
    }
}

/// Squared distance between two agents.
#[inline]
fn dist2(w: &World, a: usize, b: usize) -> f32 {
    let dx = w.pos[a][0] - w.pos[b][0];
    let dz = w.pos[a][1] - w.pos[b][1];
    dx * dx + dz * dz
}

pub fn tick(world: &mut World) {
    if world.tick % TICK_EVERY != 0 {
        return;
    }
    // Soft cap: a town at/over capacity bears no children (Director raids are the population control).
    if living_townsfolk(world) >= POP_SOFT_CAP {
        return;
    }

    // Deterministically pick ONE couple per pass: the first (lowest-id) eligible parent `a`, paired
    // with the nearest eligible, fond, co-located, fit partner `b` (tie-break: lower id). Scanning in
    // id order with explicit tie-breaks ⇒ the choice is independent of thread count. Both must be fond
    // OF EACH OTHER (mutual belief standing) — births read beliefs, never ground truth.
    let mr2 = MATE_RANGE * MATE_RANGE;
    let mut couple: Option<(usize, usize)> = None;
    'outer: for a in 0..world.n {
        if !is_civ(world, a) || !fed(world, a) {
            continue;
        }
        let mut best: Option<(usize, f32)> = None;
        for b in 0..world.n {
            if b == a || !is_civ(world, b) || !fed(world, b) {
                continue;
            }
            if !fond_toward(world, a, b) || !fond_toward(world, b, a) {
                continue;
            }
            let d2 = dist2(world, a, b);
            if d2 > mr2 {
                continue;
            }
            // nearest wins; tie-break on lower partner id (b ascends, so the first match for an equal
            // distance is already the lowest id — but compare explicitly for clarity/robustness).
            match best {
                Some((bb, bd)) if !(d2 < bd || (d2 == bd && b < bb)) => {}
                _ => best = Some((b, d2)),
            }
        }
        if let Some((b, _)) = best {
            couple = Some((a, b));
            break 'outer;
        }
    }

    let (a, b) = match couple {
        Some(c) => c,
        None => return, // no fit, fond, co-located couple this pass → no birth
    };

    birth(world, a, b);
}

/// Spawn one child near its parents, inherit a fraction of each parent's top behaviour tags + a
/// parent's house, MOVE a conserved dowry from the richer parent, and log a birth Beat.
fn birth(world: &mut World, a: usize, b: usize) {
    // Birthplace: midpoint of the parents, jittered with the WORLD serial rng (never a per-entity
    // stream — keeps the draw deterministic in the serial phase).
    let jx = world.sim_rng.next_signed() * 2.0;
    let jz = world.sim_rng.next_signed() * 2.0;
    let px = (world.pos[a][0] + world.pos[b][0]) * 0.5 + jx;
    let pz = (world.pos[a][1] + world.pos[b][1]) * 0.5 + jz;

    // A child is born professionless (it discovers a trade emergently, like a fresh townsperson).
    let child = world.spawn_agent([px, pz], Faction::Townsfolk, Profession::None);

    // INHERIT BEHAVIOUR TAGS: a fraction of each parent's top-N tags, additive (a tag a child gets
    // from BOTH parents stacks), so trades/temperaments run in families. Read the parents' profiles
    // first (immutably) so the borrow checker is happy, then a pure own-write to the new row.
    let mut add = [0.0f32; N_TAGS];
    accumulate_inherited(&world.progression[a].behavior_profile, &mut add);
    accumulate_inherited(&world.progression[b].behavior_profile, &mut add);
    let cp = &mut world.progression[child].behavior_profile;
    for t in 0..N_TAGS {
        cp[t] += add[t];
    }

    // INHERIT HOUSE: the child carries a parent's surname down the bloodline (prefer parent `a`'s
    // house; fall back to `b`'s). 0 = no house, so an unhoused couple yields an unhoused child.
    let house = if world.house[a] != 0 { world.house[a] } else { world.house[b] };
    world.house[child] = house;

    // DOWRY — gold CONSERVED: the child spawns with 0 gold (spawn_agent default); move a small dowry
    // from the RICHER parent, clamped to what that parent actually holds. Debit parent / credit child
    // ⇒ the total never changes (the gold_conserved gate). Never mint.
    let richer = if world.econ[a].gold >= world.econ[b].gold { a } else { b };
    let dowry = DOWRY.min(world.econ[richer].gold.max(0));
    if dowry > 0 {
        world.econ[richer].gold -= dowry;
        world.econ[child].gold += dowry;
    }

    // CHRONICLE: log a birth beat (the observer feed). Keep it bounded — drop the oldest if at cap.
    if world.chronicle.len() >= CHRONICLE_CAP {
        world.chronicle.remove(0);
    }
    world.chronicle.push(Beat {
        t: world.tick,
        kind: BEAT_BIRTH,
        subject: child as u32,
        magnitude: house as i32,
    });
}

/// Add `INHERIT_TAG_FRACTION` of the parent profile's top-`INHERIT_TAG_TOP` tags into `out`. Top-N
/// is chosen by value, tie-broken by lower tag index (a fixed, deterministic ordering).
fn accumulate_inherited(parent: &[f32; N_TAGS], out: &mut [f32; N_TAGS]) {
    // Find the top-N tag indices by descending value (deterministic: stable selection over a fixed
    // small array, lower index wins ties). N_TAGS is tiny (≤30) so an O(N·top) selection is fine.
    let mut chosen = [usize::MAX; INHERIT_TAG_TOP];
    let mut n_chosen = 0usize;
    while n_chosen < INHERIT_TAG_TOP {
        let mut best: Option<usize> = None;
        for t in 0..N_TAGS {
            if parent[t] <= 0.0 || chosen[..n_chosen].contains(&t) {
                continue;
            }
            match best {
                Some(bt) if !(parent[t] > parent[bt] || (parent[t] == parent[bt] && t < bt)) => {}
                _ => best = Some(t),
            }
        }
        match best {
            Some(t) => {
                chosen[n_chosen] = t;
                n_chosen += 1;
            }
            None => break, // fewer than N nonzero tags
        }
    }
    for &t in &chosen[..n_chosen] {
        out[t] += parent[t] * INHERIT_TAG_FRACTION;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::PersonBelief;
    use crate::world::World;

    /// Force agents `a` and `b` into a fit, fond, co-located couple so a birth can fire.
    fn make_couple(w: &mut World, a: usize, b: usize) {
        for &i in &[a, b] {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.needs[i].hunger = 1.0;
        }
        // co-locate
        w.pos[b] = [w.pos[a][0] + 1.0, w.pos[a][1]];
        // mutual high-standing beliefs
        set_fond(w, a, b);
        set_fond(w, b, a);
    }

    fn set_fond(w: &mut World, a: usize, b: usize) {
        let bt = &mut w.beliefs[a];
        let slot = bt.len as usize;
        bt.subjects[slot] = b as u32;
        bt.bodies[slot] = PersonBelief { subject: b as u32, standing: 30000, ..Default::default() };
        bt.len += 1;
    }

    /// Births grow the population under the cap, and the child is a 0-gold townsperson.
    #[test]
    fn birth_grows_population_child_zero_gold() {
        let mut w = World::spawn(0xB117, 6);
        // make a clean small town (no monsters) so the cap isn't relevant and births can fire.
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.econ[i].gold = 0; // no dowry source ⇒ child must end at exactly 0 gold
        }
        make_couple(&mut w, 0, 1);
        let n0 = w.n;
        // run the births pass directly on a throttle tick.
        w.tick = TICK_EVERY;
        tick(&mut w);
        assert_eq!(w.n, n0 + 1, "a fit, fond, co-located couple should bear one child");
        let child = w.n - 1;
        assert_eq!(w.econ[child].gold, 0, "a child with no dowry source carries 0 gold");
        assert_eq!(w.faction[child], Faction::Townsfolk as u8, "the child is a townsperson");
        // a birth beat was logged.
        assert!(w.chronicle.iter().any(|b| b.kind == BEAT_BIRTH), "a birth Beat is logged");
    }

    /// A dowry MOVES gold (conserved): parent loses exactly what the child gains; total unchanged.
    #[test]
    fn dowry_is_conserved() {
        let mut w = World::spawn(0xD0E7, 6);
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.econ[i].gold = 0;
        }
        w.econ[0].gold = 10_000; // richer parent can afford the dowry
        make_couple(&mut w, 0, 1);
        let total_before = w.total_gold();
        w.tick = TICK_EVERY;
        tick(&mut w);
        let child = w.n - 1;
        assert_eq!(w.total_gold(), total_before, "dowry must conserve total gold");
        assert_eq!(w.econ[child].gold, DOWRY, "child receives the dowry");
        assert_eq!(w.econ[0].gold, 10_000 - DOWRY, "the richer parent paid the dowry");
    }

    /// The soft cap halts growth: at/over POP_SOFT_CAP no child is born.
    #[test]
    fn soft_cap_halts_growth() {
        let mut w = World::spawn(0xCA9, POP_SOFT_CAP + 4);
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
        }
        make_couple(&mut w, 0, 1);
        let n0 = w.n;
        w.tick = TICK_EVERY;
        tick(&mut w);
        assert_eq!(w.n, n0, "no birth when the town is at the soft cap");
    }

    /// The child inherits a fraction of a parent's dominant behaviour tag.
    #[test]
    fn child_inherits_behaviour_tags() {
        let mut w = World::spawn(0x1A6, 6);
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.econ[i].gold = 0;
        }
        w.progression[0].behavior_profile[5] = 10.0; // parent 0 is strong in tag 5
        make_couple(&mut w, 0, 1);
        w.tick = TICK_EVERY;
        tick(&mut w);
        let child = w.n - 1;
        let inherited = w.progression[child].behavior_profile[5];
        assert!(inherited > 0.0, "child inherits some of a parent's dominant tag");
        assert!((inherited - 10.0 * INHERIT_TAG_FRACTION).abs() < 1e-4, "inherits the configured fraction");
    }
}
