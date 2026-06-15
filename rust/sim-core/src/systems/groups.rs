//! FAN-OUT UNIT: groups / bands (clan & warband membership). Ports the SPIRIT of `js/sim/groups.js`.
//!
//! WHAT THIS IMPLEMENTS (SERIAL society phase; reads + writes `world.band_leader`):
//! - Dissolution (every tick): a follower whose leader is gone (`!alive`, or — defensively — no longer
//!   itself a leaderless anchor) is freed back to `NO_BAND`. Death dissolves the band, mirroring
//!   `Groups._prune` (a leader's death reverts every follower).
//! - Formation (throttled): on a `FORM_EVERY`-tick cadence, eligible high-standing/high-level anchors
//!   recruit nearby, like-minded, unbanded townsfolk into their band — capped at `MAX_FOLLOWERS`.
//!   "Like-minded" = MUTUAL positive belief-standing (each holds a belief about the other with
//!   `standing >= JOIN_STANDING`), the SoA analogue of `js/sim/groups.js`'s `lf.standing/fl.standing`
//!   gate. Members are found via the spatial grid (3×3 superset) + the exact distance reject, then the
//!   roster columns — exactly the kind of legal whole-roster read a serial society pass may do.
//!
//! Determinism: the whole pass is SERIAL ⇒ trivially M-invariant (M=1 ≡ M=N). Anchors are visited in
//! id order; within an anchor, candidates are gathered from the grid then SORTED by (dist², id) so the
//! pick is order-independent; `world.sim_rng` gates the per-anchor recruit roll in fixed id order. No
//! gold, no spawn. (Substrate for later warband/coordination behaviour; Wave-3 establishes membership.)

use crate::components::{Faction, NO_BAND};
use crate::world::World;

/// Form bands on this tick cadence (throttle). Dissolution still runs EVERY tick.
const FORM_EVERY: u32 = 16;
/// Max followers a single leader may hold (band-size cap; mirrors `GROUP_TYPES.*.maxFollowers`).
const MAX_FOLLOWERS: usize = 4;
/// A candidate must be within this radius of the anchor to join (`BAND.joinRange`).
const JOIN_RANGE: f32 = 18.0;
/// Mutual minimum belief-standing to associate (`BAND.joinStanding`), in the i16 quantization
/// (−32768..32767 ≡ −1..1); ~+0.15.
const JOIN_STANDING: i16 = 5000;
/// Minimum level for an agent to ANCHOR a band (high-level/high-standing leads; low-level follows).
const LEADER_MIN_LEVEL: u8 = 6;
/// Per-anchor probability (each formation tick) that it actually tries to recruit — keeps band growth
/// gradual + emergent rather than everyone banding the instant they're eligible.
const RECRUIT_CHANCE: f32 = 0.35;

pub fn tick(world: &mut World) {
    dissolve_dead(world);
    if world.tick % FORM_EVERY == 0 {
        form_bands(world);
    }
}

/// EVERY-tick dissolution: free any follower whose leader is no longer a valid living anchor. A leader
/// is valid iff it is alive AND itself unbanded (band_leader == NO_BAND) — so a dead leader OR a leader
/// that somehow became a follower releases its flock (mirrors `Groups._prune`'s "leader gone ⇒ revert").
fn dissolve_dead(world: &mut World) {
    let n = world.n;
    for i in 0..n {
        let lid = world.band_leader[i];
        if lid == NO_BAND {
            continue;
        }
        let l = lid as usize;
        let leader_ok = l < n && world.alive[l] && world.band_leader[l] == NO_BAND;
        if !leader_ok {
            world.band_leader[i] = NO_BAND;
        }
    }
}

/// THROTTLED formation: scan anchors in id order; each eligible leaderless townsperson may (by an
/// `sim_rng` roll) recruit the best nearby like-minded unbanded peers up to the cap.
fn form_bands(world: &mut World) {
    let n = world.n;
    for leader in 0..n {
        if !is_eligible_leader(world, leader) {
            continue;
        }
        // serial per-anchor roll (deterministic: draws from the world stream in fixed id order).
        if world.sim_rng.next_f32() >= RECRUIT_CHANCE {
            continue;
        }
        recruit_for(world, leader);
    }
}

/// An agent that may ANCHOR a band: alive townsfolk, not already in someone else's band, and a strong
/// enough individual (level gate — the `js` "high-standing/high-level" anchor).
fn is_eligible_leader(world: &World, i: usize) -> bool {
    world.alive[i]
        && world.faction[i] == Faction::Townsfolk as u8
        && world.band_leader[i] == NO_BAND
        && world.level[i] >= LEADER_MIN_LEVEL
}

/// An agent that may JOIN `leader`'s band as a follower: alive townsfolk, unbanded, NOT the leader, and
/// NOT itself an anchor of an existing band (a leader doesn't become someone else's follower).
fn is_eligible_member(world: &World, i: usize, leader: usize) -> bool {
    i != leader
        && world.alive[i]
        && world.faction[i] == Faction::Townsfolk as u8
        && world.band_leader[i] == NO_BAND
        && !is_band_anchor(world, i)
}

/// Does `i` currently anchor a band (i.e. does anyone follow it)? Linear roster scan — fine in the
/// serial society pass, and the result feeds a deterministic decision.
fn is_band_anchor(world: &World, i: usize) -> bool {
    let id = i as i32;
    world.band_leader.iter().any(|&l| l == id)
}

/// Count current followers of `leader` (for the cap).
fn follower_count(world: &World, leader: usize) -> usize {
    let id = leader as i32;
    world.band_leader.iter().filter(|&&l| l == id).count()
}

/// Mutual positive belief-standing between `a` and `b`: each must hold a belief about the other with
/// `standing >= JOIN_STANDING` (the SoA analogue of the `lf`/`fl` gate in `js/sim/groups.js`).
fn mutually_likes(world: &World, a: usize, b: usize) -> bool {
    standing_toward(world, a, b as u32) >= JOIN_STANDING
        && standing_toward(world, b, a as u32) >= JOIN_STANDING
}

/// `observer`'s believed standing toward `subject` (i16 quantization), or i16::MIN if no belief is
/// held (no opinion ⇒ won't clear the positive gate ⇒ strangers don't band).
fn standing_toward(world: &World, observer: usize, subject: u32) -> i16 {
    let bt = &world.beliefs[observer];
    match bt.find(subject) {
        Some(idx) => bt.bodies[idx].standing,
        None => i16::MIN,
    }
}

/// Grow `leader`'s band: gather all eligible, near, mutually-liked candidates, sort them by (dist², id)
/// for an order-independent pick, and admit them in that order up to the cap. Writes only
/// `world.band_leader[candidate]` (a townsperson's own membership column).
fn recruit_for(world: &mut World, leader: usize) {
    let mut taken = follower_count(world, leader);
    if taken >= MAX_FOLLOWERS {
        return;
    }
    let lpos = world.pos[leader];
    let range2 = JOIN_RANGE * JOIN_RANGE;

    // Gather candidate ids from the 3×3 grid block (a superset of those within JOIN_RANGE), then apply
    // the exact distance + eligibility + mutual-standing rejects. We sort below so the admission order
    // is independent of the grid's (already-deterministic) traversal order. NOTE: the grid surface is
    // projected mid-tick (before `drain_intents` kills anyone), so it may carry a this-tick-dead
    // agent's stale `alive` flag — but `is_eligible_member` re-reads the LIVE `world.alive[j]` column,
    // so a freshly-dead candidate is rejected there (we never trust the grid flag for liveness).
    let mut cands: Vec<(f32, u32)> = Vec::new();
    world.grid.for_near(lpos[0], lpos[1], |p| {
        let j = p.id as usize;
        let dx = lpos[0] - p.x;
        let dz = lpos[1] - p.z;
        let d2 = dx * dx + dz * dz;
        if d2 <= range2 && is_eligible_member(world, j, leader) && mutually_likes(world, leader, j) {
            cands.push((d2, p.id));
        }
    });
    // deterministic order: closest first, ties broken by lowest id. `total_cmp` is a total order
    // (never panics, even on a NaN position) — keeps the sort deterministic + robust.
    cands.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));

    for (_, id) in cands {
        if taken >= MAX_FOLLOWERS {
            break;
        }
        world.band_leader[id as usize] = leader as i32;
        taken += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::Faction;
    use crate::world::World;

    /// Give `observer` a belief of `standing` toward `subject` (so we can wire mutual liking).
    fn make_like(w: &mut World, observer: usize, subject: u32, standing: i16) {
        let bt = &mut w.beliefs[observer];
        let idx = bt.len as usize;
        bt.subjects[idx] = subject;
        bt.bodies[idx].subject = subject;
        bt.bodies[idx].standing = standing;
        bt.len += 1;
    }

    fn reset_townsfolk(w: &mut World) {
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.level[i] = 1;
            w.band_leader[i] = NO_BAND;
            w.beliefs[i].len = 0;
        }
    }

    /// A band forms: a high-level anchor with a nearby, mutually-liked, unbanded peer recruits it.
    #[test]
    fn a_band_forms() {
        let mut w = World::spawn(0xB00B, 4);
        reset_townsfolk(&mut w);
        // 0 = leader (high level), 1 = follower; co-located + mutual liking.
        w.level[0] = 10;
        w.pos[0] = [0.0, 0.0];
        w.pos[1] = [2.0, 0.0];
        make_like(&mut w, 0, 1, 20000);
        make_like(&mut w, 1, 0, 20000);
        w.build_surface(); // recruit_for reads the grid

        // run formation directly (deterministic; the roll uses sim_rng) until it fires.
        let mut joined = false;
        for _ in 0..50 {
            form_bands(&mut w);
            if w.band_leader[1] == 0 {
                joined = true;
                break;
            }
        }
        assert!(joined, "follower 1 should have joined anchor 0's band");
    }

    /// A dead leader frees its followers back to NO_BAND.
    #[test]
    fn dead_leader_frees_followers() {
        let mut w = World::spawn(0xDEAD, 3);
        reset_townsfolk(&mut w);
        // 1 and 2 follow leader 0.
        w.band_leader[1] = 0;
        w.band_leader[2] = 0;
        // leader still alive ⇒ followers stay.
        dissolve_dead(&mut w);
        assert_eq!(w.band_leader[1], 0, "live leader keeps its band");
        assert_eq!(w.band_leader[2], 0, "live leader keeps its band");
        // leader dies ⇒ band dissolves.
        w.alive[0] = false;
        dissolve_dead(&mut w);
        assert_eq!(w.band_leader[1], NO_BAND, "dead leader frees follower 1");
        assert_eq!(w.band_leader[2], NO_BAND, "dead leader frees follower 2");
    }

    /// No mutual liking ⇒ no band (strangers don't associate), and the cap is respected.
    #[test]
    fn no_liking_no_band_and_cap() {
        let mut w = World::spawn(0xCAFE, 8);
        reset_townsfolk(&mut w);
        for i in 0..w.n {
            w.pos[i] = [i as f32 * 1.5, 0.0]; // all within JOIN_RANGE of agent 0
        }
        w.level[0] = 10;
        // make 1..=6 mutually like the leader (more than the cap of MAX_FOLLOWERS).
        for j in 1..=6u32 {
            make_like(&mut w, 0, j, 20000);
            make_like(&mut w, j as usize, 0, 20000);
        }
        // agent 7 likes the leader but the leader does NOT like it back (one-sided ⇒ rejected).
        make_like(&mut w, 7, 0, 20000);
        w.build_surface();

        // force recruitment (bypass the roll) repeatedly so the cap is the only limiter.
        for _ in 0..20 {
            recruit_for(&mut w, 0);
        }
        let followers = follower_count(&w, 0);
        assert_eq!(followers, MAX_FOLLOWERS, "cap must bound the band size");
        assert_eq!(w.band_leader[7], NO_BAND, "one-sided liking must not band");
    }

    /// Determinism: the full sim (incl. the groups society pass) is order-independent across rayon pool
    /// sizes (M=1 ≡ M=N), proven via the world golden hash.
    #[test]
    fn society_groups_m_invariant() {
        use crate::hash::world_hash;
        use crate::{in_pool, run_sim};
        let h1 = in_pool(1, || world_hash(&run_sim(0x6120, 300, 80)));
        let h4 = in_pool(4, || world_hash(&run_sim(0x6120, 300, 80)));
        assert_eq!(h1, h4, "groups society pass must be M-invariant");
    }
}
