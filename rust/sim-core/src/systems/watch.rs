//! FAN-OUT UNIT: the Night Watch — a civic guard institution (Discworld's City Watch). Ports the
//! SPIRIT of `js/sim/watch.ts`: the town has only passive defenders; this adds MORTAL, LED ones.
//! Brave free townsfolk are MUSTERED to hold the town core when raiders threaten, the watch SWELLS
//! with the danger and STANDS DOWN in peace (hysteresis), and the senior watchman is the CAPTAIN
//! (a Vimes who rises). Runs SERIALLY in the society phase ⇒ trivially M-invariant.
//!
//! WHAT THIS IMPLEMENTS (mirrors `_threat`/`_willing`/`_muster`/`_release`/`_captaincy`):
//! - `_threat` — count living town-hostile bodies (Raiders + Monsters) near the town core; that
//!   count is the muster SIGNAL. (An observer-layer institution reads ground truth to size itself —
//!   like the director's `attacker_count`; it never drives an individual NPC's epistemic decision.)
//! - hysteresis — a `calm` counter ticks up while quiet and resets to 0 the instant a threat appears,
//!   so the watch doesn't thrash in/out of duty on every flicker (and a captaincy stays put).
//! - `_muster` — when `have < target`, enlist up to the target the BRAVEST (highest level, lowest-id
//!   tie-break) free (band_leader==NO_BAND, role==0) living townsfolk whose `risk_tolerance` clears
//!   the bar: `role[i] = WATCH` AND a `Goal::Fight` at the nearest believed/apparent threat so they
//!   ENGAGE (combat.rs then strikes any believed-hostile in reach). A watchman holds the line.
//! - `_release` — in calm (after `STAND_DOWN_AFTER` ticks), release the MOST-JUNIOR surge watchman
//!   (lowest level, lowest-id tie-break) back to role=0, one per pass, never below `BASE`.
//! - `_captaincy` — the senior watchman (highest level, lowest-id tie-break) commands; a change of
//!   captain logs a beat.
//!
//! SCOPE NOTE: EVERY town in the region guards its own core. The watch loops over `world.town_centers`
//! (per-town geometry), and each town musters from its OWN townsfolk (`world.town[i] == t`) with its
//! OWN per-town hysteresis clock + captain (`WatchState.calm[t]` / `.captain[t]`). The browser/mesh +
//! the leash/patrol anchors are skipped (no `homeAnchor`/`campAnchor` columns; the Fight goal already
//! leashes a watchman to a NEAR threat, and combat reaches no further than its REACH). Touches no gold.
//!
//! Determinism: SERIAL ⇒ M=1 ≡ M=N. No rng (watch is threat-driven, not rolled). Every selection is a
//! deterministic scan over id order with explicit (key, id) tie-breaks — no HashMap / float reduce.

use crate::components::{Beat, Faction, Goal, WatchState, NO_BAND};
use crate::world::World;

/// Watch role marker (matches `world.role` convention: 0 none, 1 watch).
const ROLE_NONE: u8 = 0;
const ROLE_WATCH: u8 = 1;

/// Muster passes run on this tick cadence (the TS `WATCH.tickEvery`, 4 sim-seconds → ticks here).
const EVERY: u32 = 4;
/// Standing watch in peacetime — the watch never falls below this while a town exists (`WATCH.base`).
const BASE: usize = 2;
/// + watchmen per town-hostile body near the core, ×1000 (integer math ⇒ deterministic; the TS
/// `WATCH.perThreat` = 0.7).
const PER_THREAT_MILLI: usize = 700;
/// A hostile within this of the core counts as a threat (`WATCH.threatRange`).
const THREAT_RANGE: f32 = 64.0;
/// Hard cap on watch size (`WATCH.max`).
const MAX_WATCH: usize = 8;
/// Settlement-god believers per extra watchman a town can muster (pious towns guard harder).
const FAITH_PER_WATCH: usize = 45;
/// Min `risk_tolerance` to volunteer — the brave answer the call (`WATCH.recruitRisk`).
const RECRUIT_RISK: f32 = 0.45;
/// Ticks of CALM before a surge watchman is released, one per pass (`WATCH.standDownAfter`).
const STAND_DOWN_AFTER: u32 = 30;

/// Chronicle beat kind (interned; watch-local). Per the task: `kind: 22`.
const BEAT_WATCH: u8 = 22;

pub fn tick(world: &mut World) {
    // throttle: only muster on the cadence (the TS `_acc >= tickEvery`).
    if world.tick == 0 || world.tick % EVERY != 0 {
        return;
    }
    let now = world.tick;
    let n_towns = world.town_centers.len();

    // lazily size the per-town state to the region (mirrors chron_seen_dead's lazy resize to `n`).
    let mut st = std::mem::take(&mut world.watch);
    if st.calm.len() != n_towns {
        st.calm.resize(n_towns, 0);
        st.captain.resize(n_towns, -1);
    }

    // FAITH: a town's settlement-god believers swell its watch (pious towns guard their core harder).
    let mut faithful = vec![0usize; n_towns];
    for i in 0..world.n {
        if world.alive[i] && world.faction[i] == Faction::Townsfolk as u8 {
            let g = world.faith[i] as usize;
            if g != 0
                && g <= world.gods.len()
                && world.gods[g - 1].domain == crate::components::DOMAIN_SETTLEMENT
            {
                faithful[(world.town[i] as usize).min(n_towns - 1)] += 1;
            }
        }
    }

    // each town guards its OWN core from its OWN townsfolk, with its own hysteresis + captain.
    for t in 0..n_towns {
        let threat = threat_count(world, t);

        // hysteresis: any threat resets THIS town's calm timer; otherwise calm accrues by the interval.
        st.calm[t] = if threat > 0 { 0 } else { st.calm[t].saturating_add(EVERY) };

        // muster target swells with the threat AND the town's faith (a pious town raises a bigger watch
        // and tolerates a higher ceiling), capped.
        let fb = faithful[t] / FAITH_PER_WATCH;
        let target = (BASE + fb + (threat * PER_THREAT_MILLI + 500) / 1000).min(MAX_WATCH + fb);
        let have = watch_count(world, t);

        if have < target {
            muster(world, t, target, have);
        } else if have > target && st.calm[t] >= STAND_DOWN_AFTER {
            release_one(world, t);
        }

        captaincy(world, &mut st, t, now);
    }

    world.watch = st;
}

// ── threat (the muster signal) ─────────────────────────────────────────────────────────────────

/// Count living town-hostile bodies (Raiders + Monsters) within `THREAT_RANGE` of town `t`'s core.
/// Observer-layer read of ground truth (sizes the institution; never drives an NPC's own decision),
/// mirroring `Watch._threat`'s roster scan + the director's `attacker_count`.
fn threat_count(world: &World, t: usize) -> usize {
    let c = world.town_centers[t];
    let r2 = THREAT_RANGE * THREAT_RANGE;
    let mut n = 0usize;
    for i in 0..world.n {
        if !world.alive[i] {
            continue;
        }
        let f = world.faction[i];
        if f != Faction::Raider as u8 && f != Faction::Monster as u8 {
            continue;
        }
        let dx = world.pos[i][0] - c[0];
        let dz = world.pos[i][1] - c[1];
        if dx * dx + dz * dz <= r2 {
            n += 1;
        }
    }
    n
}

// ── muster ─────────────────────────────────────────────────────────────────────────────────────

/// Current watch size for town `t` (count of role==WATCH living townsfolk anchored to town `t`).
fn watch_count(world: &World, t: usize) -> usize {
    (0..world.n)
        .filter(|&i| {
            world.alive[i] && world.role[i] == ROLE_WATCH && world.town[i] as usize == t
        })
        .count()
}

/// Enlist town `t`'s bravest free townsfolk (highest level, lowest-id tie-break) until ITS watch
/// reaches `target`. Each enlistee: role=WATCH + a `Goal::Fight` at the nearest threat to that town's
/// core so combat engages it. Deterministic: candidates sorted by (−level, id).
fn muster(world: &mut World, t: usize, target: usize, mut have: usize) {
    // gather willing candidates of THIS town (the TS `_willing` filter), veterans-first, lowest-id ties.
    let mut pool: Vec<u32> = (0..world.n)
        .filter(|&i| is_willing(world, t, i))
        .map(|i| i as u32)
        .collect();
    pool.sort_by(|&a, &b| {
        world.level[b as usize]
            .cmp(&world.level[a as usize])
            .then(a.cmp(&b))
    });

    let foe = nearest_threat(world, t);
    let mut k = 0usize;
    while have < target && k < pool.len() {
        let id = pool[k] as usize;
        k += 1;
        enlist(world, id, foe);
        have += 1;
    }
}

/// A willing recruit for town `t`: alive townsperson ANCHORED to town `t`, free (unbanded), not
/// already serving, brave enough (`risk_tolerance >= RECRUIT_RISK`). Mirrors `Watch._willing`.
fn is_willing(world: &World, t: usize, i: usize) -> bool {
    world.alive[i]
        && world.faction[i] == Faction::Townsfolk as u8
        && world.town[i] as usize == t
        && world.role[i] == ROLE_NONE
        && world.band_leader[i] == NO_BAND
        && world.personality[i].risk_tolerance >= RECRUIT_RISK
}

/// Re-flag `i` as a watchman and set it on the believed/apparent threat so it ENGAGES (combat.rs
/// reads its beliefs; a Fight goal makes it close + strike). If no threat is in sight, mark the role
/// only — combat's `nearest_hostile` still fires on any believed-hostile in reach.
fn enlist(world: &mut World, i: usize, foe: Option<u32>) {
    world.role[i] = ROLE_WATCH;
    if let Some(t) = foe {
        let to = world.pos[t as usize];
        world.goal[i] = Goal::Fight { target: t, to };
    }
}

/// The nearest living town-hostile body to town `t`'s core (the believed/apparent threat its watch
/// forms up on). Deterministic: closest wins, lowest id breaks ties. `None` if the core is calm.
fn nearest_threat(world: &World, t: usize) -> Option<u32> {
    let c = world.town_centers[t];
    let r2 = THREAT_RANGE * THREAT_RANGE;
    let mut best: Option<(f32, u32)> = None;
    for i in 0..world.n {
        if !world.alive[i] {
            continue;
        }
        let f = world.faction[i];
        if f != Faction::Raider as u8 && f != Faction::Monster as u8 {
            continue;
        }
        let dx = world.pos[i][0] - c[0];
        let dz = world.pos[i][1] - c[1];
        let d2 = dx * dx + dz * dz;
        if d2 > r2 {
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

// ── release (hysteresis stand-down) ──────────────────────────────────────────────────────────────

/// In calm, release town `t`'s MOST-JUNIOR surge watchman (lowest level, lowest-id tie-break) back to
/// civilian life — one per pass, never below `BASE`. Mirrors `Watch._releaseOne`.
fn release_one(world: &mut World, t: usize) {
    if watch_count(world, t) <= BASE {
        return;
    }
    let mut junior: Option<u32> = None;
    for i in 0..world.n {
        if !world.alive[i] || world.role[i] != ROLE_WATCH || world.town[i] as usize != t {
            continue;
        }
        let better = match junior {
            None => true,
            Some(j) => {
                world.level[i] < world.level[j as usize]
                    || (world.level[i] == world.level[j as usize] && (i as u32) < j)
            }
        };
        if better {
            junior = Some(i as u32);
        }
    }
    if let Some(j) = junior {
        revert(world, j as usize);
    }
}

/// Stand a watchman down: clear its role + drop the fight goal (the TS `_revert`, sans the
/// homeAnchor/canWork columns the substrate doesn't carry).
fn revert(world: &mut World, i: usize) {
    world.role[i] = ROLE_NONE;
    if matches!(world.goal[i], Goal::Fight { .. }) {
        world.goal[i] = Goal::Idle;
    }
}

// ── captaincy ────────────────────────────────────────────────────────────────────────────────────

/// Town `t`'s senior watchman (highest level, lowest-id tie-break) commands; a change of captain logs
/// a beat (the beat carries that town's new captain). Mirrors `Watch._captaincy` / `_seniorOf`.
fn captaincy(world: &mut World, st: &mut WatchState, t: usize, now: u32) {
    match senior_watchman(world, t) {
        Some(c) => {
            if st.captain[t] != c as i32 {
                st.captain[t] = c as i32;
                world.chronicle.push(Beat { t: now, kind: BEAT_WATCH, subject: c, magnitude: 1 });
            }
        }
        None => st.captain[t] = -1,
    }
}

/// Town `t`'s highest-level living watchman (lowest-id tie-break). `None` if its watch is empty.
fn senior_watchman(world: &World, t: usize) -> Option<u32> {
    let mut best: Option<u32> = None;
    for i in 0..world.n {
        if !world.alive[i] || world.role[i] != ROLE_WATCH || world.town[i] as usize != t {
            continue;
        }
        let better = match best {
            None => true,
            Some(b) => {
                world.level[i] > world.level[b as usize]
                    || (world.level[i] == world.level[b as usize] && (i as u32) < b)
            }
        };
        if better {
            best = Some(i as u32);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::Faction;
    use crate::world::World;

    /// Set up a calm single town (town 0) at the origin: all living townsfolk anchored to town 0, no
    /// role, unbanded, brave enough to volunteer.
    fn calm_town(w: &mut World) {
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.role[i] = ROLE_NONE;
            w.band_leader[i] = NO_BAND;
            w.personality[i].risk_tolerance = 0.9; // all brave
            w.goal[i] = Goal::Idle;
            w.town[i] = 0;
        }
        w.town_center = [0.0, 0.0];
        w.town_centers = vec![[0.0, 0.0]];
        w.town_radius = vec![180.0];
    }

    /// Spawn a raider at the core (a live threat the watch must answer).
    fn place_threat(w: &mut World, i: usize, dist: f32) {
        w.faction[i] = Faction::Raider as u8;
        w.alive[i] = true;
        w.pos[i] = [dist, 0.0];
    }

    /// A threat near the core MUSTERS watchmen above the peacetime base.
    #[test]
    fn threat_musters_watchmen() {
        let mut w = World::spawn(0x7A7C, 12);
        calm_town(&mut w);
        // turn agents 0..2 into raiders right on the core.
        for i in 0..3 {
            place_threat(&mut w, i, 5.0);
        }
        w.tick = EVERY; // land on a muster cadence
        tick(&mut w);
        let watch = watch_count(&w, 0);
        assert!(watch > BASE, "a near threat should muster a surge watch (got {watch}, base {BASE})");
        assert!(watch <= MAX_WATCH, "watch is capped");
        // at least one mustered watchman is set on a Fight goal (engages the threat).
        let any_fighting = (0..w.n).any(|i| {
            w.role[i] == ROLE_WATCH && matches!(w.goal[i], Goal::Fight { .. })
        });
        assert!(any_fighting, "a watchman should be set to engage the threat");
    }

    /// Calm (after the stand-down window) RELEASES surge watchmen back toward the base.
    #[test]
    fn calm_releases_watchmen() {
        let mut w = World::spawn(0x6A1B, 12);
        calm_town(&mut w);
        // manually muster a full surge (no threats present → just flag roles).
        for i in 0..MAX_WATCH {
            w.role[i] = ROLE_WATCH;
        }
        assert_eq!(watch_count(&w, 0), MAX_WATCH);
        // no threats ⇒ threat_count==0 ⇒ calm accrues; advance enough passes to release down to BASE.
        // each pass releases one once calm >= STAND_DOWN_AFTER.
        let mut last = watch_count(&w, 0);
        for p in 1..200u32 {
            w.tick = p * EVERY;
            tick(&mut w);
            let now = watch_count(&w, 0);
            assert!(now <= last, "watch only shrinks while calm");
            last = now;
            if now == BASE {
                break;
            }
        }
        assert_eq!(watch_count(&w, 0), BASE, "calm must release surge watchmen down to the base, no lower");
    }

    /// A captaincy emits a chronicle beat, and the captain is the senior (highest-level) watchman.
    #[test]
    fn senior_takes_command() {
        let mut w = World::spawn(0xCA97, 12);
        calm_town(&mut w);
        for i in 0..3 {
            place_threat(&mut w, i, 5.0);
        }
        // make agent 5 clearly the most senior so it must be captain.
        for i in 0..w.n {
            w.level[i] = 1;
        }
        w.level[5] = 10;
        w.tick = EVERY;
        tick(&mut w);
        assert_eq!(w.watch.captain[0], 5, "the senior watchman commands");
        assert!(
            w.chronicle.iter().any(|b| b.kind == BEAT_WATCH && b.subject == 5),
            "a change of captain logs a watch beat"
        );
    }

    /// EVERY town guards its own core: with two separated, each-threatened towns, each musters its OWN
    /// townsfolk and crowns its OWN senior as captain — independently.
    #[test]
    fn two_towns_each_get_their_own_captain() {
        let mut w = World::spawn(0x7717, 16);
        // build a region of TWO towns, far apart so their threat ranges never overlap.
        let c0 = [0.0f32, 0.0];
        let c1 = [500.0f32, 0.0];
        w.town_centers = vec![c0, c1];
        w.town_radius = vec![180.0, 180.0];
        // agents 0..8 belong to town 0 (sitting at its core); 8..16 belong to town 1 (at its core).
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.role[i] = ROLE_NONE;
            w.band_leader[i] = NO_BAND;
            w.personality[i].risk_tolerance = 0.9;
            w.goal[i] = Goal::Idle;
            w.level[i] = 1;
            let t = if i < 8 { 0u16 } else { 1u16 };
            w.town[i] = t;
            w.pos[i] = w.town_centers[t as usize];
        }
        // a clear senior in each town: agent 2 leads town 0, agent 11 leads town 1.
        w.level[2] = 9;
        w.level[11] = 9;
        // plant a raider on EACH town's core (turn two townsfolk-slots' neighbours into raiders).
        // use agents from the OTHER end so we don't consume a town's own roster — spawn fresh threats
        // by repurposing a couple of agents per town into raiders sitting on that core.
        w.faction[7] = Faction::Raider as u8;
        w.pos[7] = c0; // threatens town 0
        w.faction[15] = Faction::Raider as u8;
        w.pos[15] = c1; // threatens town 1

        w.tick = EVERY;
        tick(&mut w);

        // each town crowned its own senior, drawn from its own townsfolk.
        assert_eq!(w.watch.captain.len(), 2, "per-town captaincy state sized to the region");
        assert_eq!(w.watch.captain[0], 2, "town 0's senior commands town 0's watch");
        assert_eq!(w.watch.captain[1], 11, "town 1's senior commands town 1's watch");
        // both towns mustered a surge above base from their OWN people.
        assert!(watch_count(&w, 0) > BASE, "town 0 mustered against its threat");
        assert!(watch_count(&w, 1) > BASE, "town 1 mustered against its threat");
        // every watchman serves the town it belongs to (no cross-town conscription).
        for i in 0..w.n {
            if w.role[i] == ROLE_WATCH {
                let t = w.town[i] as usize;
                assert!(t < 2, "watchman {i} has a valid town");
            }
        }
        // both captaincy beats were logged.
        assert!(w.chronicle.iter().any(|b| b.kind == BEAT_WATCH && b.subject == 2));
        assert!(w.chronicle.iter().any(|b| b.kind == BEAT_WATCH && b.subject == 11));
    }

    /// Determinism: the full sim (incl. the watch society pass) is order-independent across pool sizes.
    #[test]
    fn society_watch_m_invariant() {
        use crate::hash::world_hash;
        use crate::{in_pool, run_sim};
        let h1 = in_pool(1, || world_hash(&run_sim(0x5A1E, 300, 80)));
        let h4 = in_pool(4, || world_hash(&run_sim(0x5A1E, 300, 80)));
        assert_eq!(h1, h4, "watch society pass must be M-invariant");
    }
}
