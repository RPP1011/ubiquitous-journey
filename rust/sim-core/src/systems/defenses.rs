//! FAN-OUT UNIT: town defences — the home-ground advantage. Ports the SPIRIT of `js/sim/defenses.ts`:
//! the town core is RINGED WITH WATCHTOWERS, fixed emplacements that lay down ranged fire on any
//! town-hostile body that strays into range. Runs SERIALLY in the society phase ⇒ trivially
//! M-invariant.
//!
//! WHY IT EXISTS (the TS rationale, verbatim in spirit): the base sim had no reason to favour the
//! defender — townsfolk fled individually and were picked off — so the only lever on the population
//! was "how many raiders", a knife-edge to extinction. A settlement should be able to HOLD. A tower's
//! killing power does NOT scale with the civilian population: a thriving town and a gutted one defend
//! their core equally well, so even a decimated town can hold its centre and rebuild via births. The
//! robust anti-extinction FLOOR, structural rather than a tuning fudge.
//!
//! WHAT THIS IMPLEMENTS (mirrors `build`/`_apparent`/`tick`/the cooldown + tally):
//! - EVERY settlement rings ITS OWN core. The per-town centres are derived deterministically each
//!   pass (`town_cores`): town 0 anchors at the legacy `world.town_center`; every further town id
//!   present in `world.town` anchors at the CENTROID of its living members. A tower ring is a pure
//!   function of a town's centre, computed fresh each pass (no per-tower mesh/state to persist), so
//!   a freshly-founded or migrated town gets its watchtowers for free, and a gutted one keeps them.
//! - on a cooldown (a tick-modulo throttle), every tower fires on the nearest living APPARENT-hostile
//!   (Raider/Monster by PERCEIVED faction = disguise-or-faction) within range — a disguised infiltrator
//!   reads as a townsperson and is SPARED (the watch is fooled too; the epistemic split honoured).
//! - the shot is an `Intent::Strike{from: TOWER, to, dmg}` so cross-agent damage goes through the
//!   deterministic merge (NEVER a direct write to another agent's combat health). A tower has no agent
//!   id, so `from` is a sentinel (`u32::MAX`); `drain_intents` guards `to < n` and only touches memory
//!   when `from < n`, so a `u32::MAX` source is safe (it just deals damage / flips alive on a kill).
//! - a running shot tally lives in `DefenseState` for tests/inspection.
//!
//! SKIPPED (browser/mesh): the THREE marker group + `dispose` (visuals only); terrain height (the
//! substrate is flat, 2-D). Touches no gold — killing a purseless raider mints nothing (conserved).
//!
//! Determinism: SERIAL ⇒ M=1 ≡ M=N. No rng (towers are threat-driven, not rolled). Town centres are
//! a pure function of `town_center` + the `town`/`pos` columns scanned in id order; tower positions are
//! a pure function of a town centre; every target pick is a scan over id order with (dist, id)
//! tie-breaks — no HashMap / float reduce.

use crate::components::Faction;
use crate::intent::Intent;
use crate::world::{World, NO_DISGUISE};

/// Watchtowers evenly spaced on a ring around the town core (`DEFENSE.towers`).
const TOWERS: usize = 5;
/// Ring radius from the town centre (`DEFENSE.ringR`).
const RING_R: f32 = 16.0;
/// A tower fires on town-hostile bodies within this (`DEFENSE.range`).
const RANGE: f32 = 20.0;
/// Damage per shot — towers HARASS, they don't instakill (`DEFENSE.damage`).
const DAMAGE: f32 = 4.0;
/// Sim-ticks between a tower's shots (the rate of fire). The TS `DEFENSE.fireEvery` is 1.0 sim-second;
/// at the combat tick's DT=0.1 that is ~10 ticks. A tick-modulo throttle mirrors the shared `_acc`
/// timer (all towers fire on the same cadence, as the TS one `_acc` makes them).
const FIRE_EVERY: u32 = 10;

/// A tower has no agent id — its strikes carry this sentinel source (safe in `drain_intents`: it
/// guards `to < n` for the damage and only touches memory when `from < n`).
const TOWER_SOURCE: u32 = u32::MAX;

pub fn tick(world: &mut World) {
    // throttle: only fire on the rate-of-fire cadence (the TS `_acc >= fireEvery`).
    if world.tick == 0 || world.tick % FIRE_EVERY != 0 {
        return;
    }

    let range2 = RANGE * RANGE;

    // EVERY settlement rings its own core. Collect each town's tower shots first (immutable scans
    // over the roster), then push the intents — keeps the borrow of `world` simple and the push
    // order town-then-tower deterministic. The tally is a single GLOBAL sum across all towns.
    let cores = town_cores(world);
    let mut shots: Vec<u32> = Vec::with_capacity(cores.len() * TOWERS);
    for (center, ring_r) in cores {
        for t in 0..TOWERS {
            let ang = (t as f32 / TOWERS as f32) * std::f32::consts::TAU;
            let tx = center[0] + ang.cos() * ring_r;
            let tz = center[1] + ang.sin() * ring_r;
            if let Some(to) = nearest_apparent_hostile(world, tx, tz, range2) {
                shots.push(to);
            }
        }
    }

    for to in shots {
        world.intents.push(Intent::Strike { from: TOWER_SOURCE, to, dmg: DAMAGE });
        world.defenses.shots += 1;
    }
}

/// The per-town `(centre, ring_radius)` list — one entry per settlement, derived DETERMINISTICALLY
/// each pass (no persisted per-town state; a tower ring is a pure function of its town's centre).
///
/// Town 0 anchors at the legacy `world.town_center` (the dense home town's worldgen anchor). Every
/// FURTHER town id present in `world.town` anchors at the CENTROID of its living members — so the
/// "region of towns" gets a watchtower ring per settlement, the cores tracking the clusters as they
/// migrate/grow/shrink. The radius is the fixed `RING_R` (no per-town radius column in this
/// substrate); a town with no living members contributes no ring (its core is undefined).
///
/// Deterministic: the present-town set is gathered by an id-order scan (the `seen` array indexes by
/// town id, no HashMap); each centroid is a sum-then-divide over an id-order scan (no float reduce
/// in any data-dependent order). Serial ⇒ M-invariant.
fn town_cores(world: &World) -> Vec<([f32; 2], f32)> {
    // Highest town id present bounds the (small, dense) id space.
    let max_town = world.town.iter().copied().max().unwrap_or(0) as usize;
    // Per-town living-member centroid accumulator (sum + count), indexed by town id.
    let mut sum: Vec<[f32; 2]> = vec![[0.0, 0.0]; max_town + 1];
    let mut count: Vec<u32> = vec![0; max_town + 1];
    for i in 0..world.n {
        if !world.alive[i] {
            continue;
        }
        let t = world.town[i] as usize;
        sum[t][0] += world.pos[i][0];
        sum[t][1] += world.pos[i][1];
        count[t] += 1;
    }

    let mut cores: Vec<([f32; 2], f32)> = Vec::with_capacity(max_town + 1);
    for t in 0..=max_town {
        let center = if t == 0 {
            // town 0 keeps its worldgen anchor (also what the tests/legacy callers set directly).
            world.town_center
        } else if count[t] > 0 {
            let c = count[t] as f32;
            [sum[t][0] / c, sum[t][1] / c]
        } else {
            continue; // an empty (extinct/never-populated) town fields no towers
        };
        cores.push((center, RING_R));
    }
    cores
}

/// An agent's APPARENT faction — a disguised infiltrator fools the watch (mirrors `_apparent`). Reads
/// the disguise mask if set, else the true faction (the SAME projection `build_surface` shows
/// observers, so the tower is fooled exactly as cognition is).
#[inline]
fn apparent_faction(world: &World, i: usize) -> u8 {
    if world.disguise[i] != NO_DISGUISE {
        world.disguise[i]
    } else {
        world.faction[i]
    }
}

/// The nearest living town-hostile body (Raider/Monster by APPARENT faction) within `range2` of the
/// tower at `(tx, tz)`. Deterministic: closest wins, lowest id breaks ties. `None` if none in range.
#[inline]
fn nearest_apparent_hostile(world: &World, tx: f32, tz: f32, range2: f32) -> Option<u32> {
    let mut best: Option<(f32, u32)> = None;
    for i in 0..world.n {
        if !world.alive[i] {
            continue;
        }
        let f = apparent_faction(world, i);
        if f != Faction::Raider as u8 && f != Faction::Monster as u8 {
            continue; // friend / disguised-as-townsfolk → spared (the watch is fooled)
        }
        let dx = world.pos[i][0] - tx;
        let dz = world.pos[i][1] - tz;
        let d2 = dx * dx + dz * dz;
        if d2 > range2 {
            continue;
        }
        let better = match best {
            None => true,
            Some((bd, bid)) => d2 < bd || (d2 == bd && (i as u32) < bid),
        };
        if better {
            best = Some((d2, i as u32));
        }
    }
    best.map(|(_, id)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::World;

    /// Park every agent far from the core so a hand-placed threat is the only thing in tower range.
    fn clear_field(w: &mut World) {
        for i in 0..w.n {
            w.pos[i] = [10_000.0, 10_000.0];
            w.alive[i] = true;
        }
        w.town_center = [0.0, 0.0];
    }

    /// A tower strikes a near raider: the pass emits a Strike intent at the raider, and the
    /// deterministic merge applies the damage.
    #[test]
    fn tower_strikes_near_raider() {
        let mut w = World::spawn(0xDEF, 8);
        clear_field(&mut w);
        // a raider sitting right on a tower (tower 0 is at (RING_R, 0)).
        w.faction[3] = Faction::Raider as u8;
        w.pos[3] = [RING_R, 0.0];
        let hp_before = w.combat[3].health;

        w.tick = FIRE_EVERY; // land on a firing cadence
        tick(&mut w);
        let strikes: Vec<&Intent> =
            w.intents.items.iter().filter(|i| matches!(i, Intent::Strike { .. })).collect();
        assert!(!strikes.is_empty(), "a tower should fire on a near raider");
        assert!(
            strikes.iter().any(|i| matches!(i, Intent::Strike { to, .. } if *to == 3)),
            "the strike should target the raider (id 3)"
        );

        let gold_before = w.total_gold();
        w.drain_intents();
        assert!(w.combat[3].health < hp_before, "the raider took tower damage");
        assert_eq!(w.total_gold(), gold_before, "tower fire mints/destroys no gold");
    }

    /// A DISGUISED raider (apparent faction = townsfolk) is SPARED — the tower fires on apparent
    /// faction, so the spy mask fools it.
    #[test]
    fn disguised_raider_is_spared() {
        let mut w = World::spawn(0xD15, 8);
        clear_field(&mut w);
        // a true raider on a tower, but wearing a townsfolk disguise.
        w.faction[3] = Faction::Raider as u8;
        w.disguise[3] = Faction::Townsfolk as u8;
        w.pos[3] = [RING_R, 0.0];

        w.tick = FIRE_EVERY;
        tick(&mut w);
        assert!(
            !w.intents.items.iter().any(|i| matches!(i, Intent::Strike { .. })),
            "a disguised raider reads as a townsperson and is NOT fired on"
        );
    }

    /// A tower fires on a raider that is disguised as ANOTHER attacker faction (apparent = Monster) —
    /// the apparent faction is what arms the tower, true faction is irrelevant here.
    #[test]
    fn fires_on_apparent_attacker_faction() {
        let mut w = World::spawn(0xD16, 8);
        clear_field(&mut w);
        // a true townsperson, but APPARENTLY a monster (a percept dressed as a beast) → shot.
        w.faction[3] = Faction::Townsfolk as u8;
        w.disguise[3] = Faction::Monster as u8;
        w.pos[3] = [RING_R, 0.0];

        w.tick = FIRE_EVERY;
        tick(&mut w);
        assert!(
            w.intents.items.iter().any(|i| matches!(i, Intent::Strike { to, .. } if *to == 3)),
            "the tower fires on the APPARENT (monster) faction"
        );
    }

    /// A raider beyond every tower's range is not fired on (towers HARASS the core, not the frontier).
    #[test]
    fn out_of_range_raider_is_safe() {
        let mut w = World::spawn(0xD17, 8);
        clear_field(&mut w);
        w.faction[3] = Faction::Raider as u8;
        w.pos[3] = [RING_R + RANGE + 50.0, 0.0]; // well past the firing radius
        w.tick = FIRE_EVERY;
        tick(&mut w);
        assert!(
            !w.intents.items.iter().any(|i| matches!(i, Intent::Strike { .. })),
            "a raider beyond range draws no fire"
        );
    }

    /// The tower's sentinel source (`u32::MAX`) is safe in the merge: a kill flips `alive` and seeds
    /// no out-of-bounds memory.
    #[test]
    fn tower_kill_is_safe_and_flips_alive() {
        let mut w = World::spawn(0xD18, 8);
        clear_field(&mut w);
        w.faction[3] = Faction::Raider as u8;
        w.pos[3] = [RING_R, 0.0];
        w.combat[3].health = DAMAGE; // one shot kills
        w.tick = FIRE_EVERY;
        tick(&mut w);
        w.drain_intents();
        assert!(!w.alive[3], "the tower's killing shot flips alive (via the sentinel-source Strike)");
        assert!(w.defenses.shots >= 1, "the tally counted the shot");
    }

    /// Two SEPARATE towns each ring their own core: a raider sitting on town A's ring and another on
    /// town B's ring are BOTH fired on, even though B's core is far from the legacy `town_center`.
    /// (Town 0 anchors at `town_center`; town 1 anchors at the centroid of its living members.)
    #[test]
    fn two_towns_each_fire_on_own_core() {
        let mut w = World::spawn(0xD19, 8);
        clear_field(&mut w); // all parked far away, all town 0, town_center = (0,0)

        // Town B's core, far from the origin. Anchor a member of town 1 there so its centroid = core.
        let core_b = [300.0, 300.0];
        w.town[5] = 1;
        w.pos[5] = [core_b[0], core_b[1]]; // the only living town-1 member ⇒ centroid = core_b
        w.faction[5] = Faction::Townsfolk as u8; // a civilian anchor, not itself a target

        // A raider on town A's tower-0 (at town_center + (RING_R,0)).
        w.faction[3] = Faction::Raider as u8;
        w.pos[3] = [RING_R, 0.0];
        // A raider on town B's tower-0 (at core_b + (RING_R,0)).
        w.faction[6] = Faction::Raider as u8;
        w.pos[6] = [core_b[0] + RING_R, core_b[1]];

        w.tick = FIRE_EVERY;
        tick(&mut w);
        let hit = |id: u32| {
            w.intents.items.iter().any(|i| matches!(i, Intent::Strike { to, .. } if *to == id))
        };
        assert!(hit(3), "town A's tower fires on the raider at its own core");
        assert!(hit(6), "town B's tower fires on the raider at ITS own (distant) core");
    }

    /// Determinism: the full sim (incl. the defences society pass) is order-independent across pool sizes.
    #[test]
    fn society_defenses_m_invariant() {
        use crate::hash::world_hash;
        use crate::{in_pool, run_sim};
        let h1 = in_pool(1, || world_hash(&run_sim(0xDEF5, 300, 80)));
        let h4 = in_pool(4, || world_hash(&run_sim(0xDEF5, 300, 80)));
        assert_eq!(h1, h4, "defences society pass must be M-invariant");
    }
}
