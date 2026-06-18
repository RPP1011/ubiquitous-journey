//! FAN-OUT UNIT: the Patrician (a diegetic peace-keeper — Discworld's Lord Vetinari). Ports the
//! SPIRIT of `js/sim/patrician.ts`. The Director is the agent of drama; the Patrician is its
//! counterweight. On a slow throttle it scans the town for the single most DANGEROUS feud (the most
//! mutually-hostile pair of living townsfolk — often one the Director just lit) and BROKERS a partial
//! truce, quelling latched intra-town hostility before it becomes a killing.
//!
//! The point is not to remove tension but to MANAGE it: feuds still smoulder, but the city holds, so
//! the world stays interesting without tearing itself apart. Belief-only (it nudges standings; ground
//! truth is untouched) — the OBSERVER layer (it narrates by SEEDING beliefs, never by driving an
//! agent's decision; the epistemic split holds). Runs SERIALLY in the society phase.
//!
//! WHAT THIS IMPLEMENTS (throttled `PATRICIAN_EVERY`):
//! - `_broker` — find the most mutually-soured LATCHED-HOSTILE living-townsfolk pair (scan beliefs in
//!   id order; minimize standing-sum; lowest-id tie-break), then:
//!   - `_reconcile` — if NEITHER side carries a deep grudge (an `Assaulted` memory of the other) and a
//!     `sim_rng` roll passes: a lasting peace. Both standings warm to a warmly-POSITIVE bond and
//!     hostility is cleared. A `BEAT_RECONCILE` chronicle beat marks the saga-worthy feud's-end.
//!   - `_truce` — otherwise a partial damp BOTH ways: warm each standing toward neutral and un-latch
//!     hostility — UNLESS that side holds a deep grudge (`_grudgeSalience`), in which case the forced
//!     peace RESISTS (the nudge is withheld and the hostility is NOT quelled — a forced forgiveness
//!     over real blood is no forgiveness). A resisted brokering leaves the feud smouldering.
//!
//! NOT PORTED (noted): `_leakForsworn` (the broken-vow reputation leak) needs a forsworn/oath-broken
//! marker on the agent that does not exist in the Wave substrate yet — SKIPPED by design; only the
//! truce-brokering core is ported.
//!
//! Determinism: SERIAL society phase ⇒ trivially M-invariant (M=1 ≡ M=N). The reconcile roll draws
//! from `world.sim_rng` (never per-entity rng). No HashMap iteration / float reduce in the scan — the
//! pair search is an integer-keyed id-order scan with an (i32 standing-sum, ids) tie-break. No gold,
//! no spawn ⇒ conservation is untouched.

use crate::components::{Beat, EpisodeKind, Faction};
use crate::world::World;

/// How often the Patrician wakes to broker peace (sparse — the counterweight to the director's drama).
const PATRICIAN_EVERY: u32 = 150;

/// A reconcile is only attempted when NEITHER side carries a deep grudge; this is its `sim_rng` roll
/// (the rest of the time a brokering degrades to a partial truce). Mirrors `PATRICIAN.reconcileChance`.
const RECONCILE_CHANCE: f32 = 0.30;

/// Belief-standing nudge toward neutral applied by a (non-resisted) truce, in the i16 quantization
/// (−32768..32767 ≡ −1..1). Mirrors `PATRICIAN.brokerAmount`. A truce damps but does not befriend.
const BROKER_AMOUNT: i16 = 9_000;

/// The warm POSITIVE standing both sides are lifted to by a lasting reconciliation (so it won't simply
/// re-sour). Mirrors `PATRICIAN.reconcileStanding` (~+0.4). `warm_belief` also un-latches hostility.
const RECONCILE_STANDING: i16 = 13_000;

/// BeatKind for a brokered reconciliation (the feud's-end / saga beat; chronicle-local).
const BEAT_RECONCILE: u8 = 22;

pub fn tick(world: &mut World) {
    // Throttle: only broker on the interval boundary (and never at tick 0).
    if world.tick == 0 || world.tick % PATRICIAN_EVERY != 0 {
        return;
    }
    broker(world);
}

/// Find the single most-mutually-hostile pair of living townsfolk and broker a truce (or, rarely, a
/// lasting reconciliation). A real intra-town FEUD is a LATCHED hostile belief between two townsfolk
/// (what the director's feud / a kin-vendetta leaves behind) — NOT merely a low standing, which a fond
/// pair soured by a spark never crosses. We pick the most bitter such pair (minimum standing-sum;
/// lowest-(a,b) ids break ties for determinism).
fn broker(world: &mut World) {
    let (a, b) = match worst_feud(world) {
        Some(p) => p,
        None => return,
    };

    // A reconciliation (enemies → friends) is impossible if EITHER side carries a deep, salient grudge
    // (an `Assaulted` memory of the other) — a forced forgiveness over real blood is no forgiveness; it
    // degrades to a (still-resisted) truce. `grudge_a`/`grudge_b` are the per-side wounds.
    let grudge_a = world.memory[a as usize].has(EpisodeKind::Assaulted, b);
    let grudge_b = world.memory[b as usize].has(EpisodeKind::Assaulted, a);
    let deep_grudge = grudge_a || grudge_b;

    if !deep_grudge && world.sim_rng.next_f32() < RECONCILE_CHANCE {
        reconcile(world, a, b);
    } else {
        // partial truce BOTH ways; each side resists iff IT holds the deep grudge.
        truce(world, a, b, grudge_a);
        truce(world, b, a, grudge_b);
    }
}

/// A LASTING peace: mutual standing turns warmly POSITIVE (friendship, so it won't simply re-sour) and
/// hostility is cleared (`warm_to` un-latches it). Both directions are seeded. A saga-worthy beat is
/// logged (the marriage-alliance / feud's-end trope).
fn reconcile(world: &mut World, a: u32, b: u32) {
    warm_to(world, a as usize, b, RECONCILE_STANDING);
    warm_to(world, b as usize, a, RECONCILE_STANDING);
    world.chronicle.push(Beat {
        t: world.tick,
        kind: BEAT_RECONCILE,
        subject: a,
        magnitude: b as i32,
    });
}

/// Pull `observer`'s standing toward `subject` back up toward neutral and un-latch the hostility —
/// UNLESS `resisted` (the observer holds a deep grudge about the subject), in which case the nudge is
/// WITHHELD entirely and the latched hostility is left in place: a forced peace over real blood is no
/// forgiveness, and the feud smoulders on (more interesting than silent neutralization).
fn truce(world: &mut World, observer: u32, subject: u32, resisted: bool) {
    if resisted {
        return;
    }
    // a non-resisted truce warms toward neutral; `warm_belief` (amt > 0) clears the hostile flag.
    world.warm_belief(observer as usize, subject, BROKER_AMOUNT);
}

/// Warm `observer`'s standing toward `subject` to at LEAST `target` (a reconciliation lifts to a fixed
/// warm floor, not a relative nudge). Seeds the belief if absent, raises a lower standing to `target`,
/// and un-latches hostility. Leaves an already-warmer bond untouched.
fn warm_to(world: &mut World, observer: usize, subject: u32, target: i16) {
    if let Some(ix) = world.ensure_belief(observer, subject) {
        let b = &mut world.beliefs[observer].bodies[ix];
        if b.standing < target {
            b.standing = target;
        }
        b.flags &= !0x01; // un-latch hostile (a lasting peace)
        if b.confidence < 26_000 {
            b.confidence = 26_000;
        }
    }
}

/// The most mutually-hostile pair of living townsfolk, or `None`. A pair qualifies iff `a` holds a
/// belief about `b` AND at least one of the two beliefs is LATCHED hostile (an actual feud, not a mere
/// low standing). The "bitterness" key is `standing(a→b) + standing(b→a)` (lower = worse); ties break
/// on the lowest `(a, b)` ids. Deterministic id-order scan — no float reduce, no HashMap iteration.
fn worst_feud(world: &World) -> Option<(u32, u32)> {
    let n = world.n;
    let mut best: Option<(i32, u32, u32)> = None; // (standing-sum, a, b)
    for a in 0..n {
        if !is_town(world, a) {
            continue;
        }
        for body in world.facts[a].views() {
            let subj = body.subject;
            let b = subj as usize;
            if b >= n || b == a || !is_town(world, b) {
                continue;
            }
            // the reciprocal belief (b about a), if held.
            let ba = world.facts[b].view(a as u32);
            let a_host = body.flags & 0x01 != 0;
            let b_host = ba.map(|x| x.flags & 0x01 != 0).unwrap_or(false);
            if !(a_host || b_host) {
                continue; // only an actual feud (latched hostility on either side)
            }
            let sum = body.standing as i32 + ba.map(|x| x.standing as i32).unwrap_or(0);
            // minimize the standing-sum; lowest (a, b) ids break ties (deterministic).
            let cand = (sum, a as u32, subj);
            match best {
                Some(cur) if cur <= cand => {}
                _ => best = Some(cand),
            }
        }
    }
    best.map(|(_, a, b)| (a, b))
}

/// A living townsperson (the only faction the Patrician brokers between — an intra-town peace-keeper).
#[inline]
fn is_town(world: &World, i: usize) -> bool {
    world.alive[i] && world.faction[i] == Faction::Townsfolk as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Episode, Faction};
    use crate::world::World;

    /// Seed a one-sided LATCHED-hostile belief: `observer` holds `standing` toward `subject`, hostile.
    fn seed_hostile(w: &mut World, observer: usize, subject: u32, standing: i16) {
        w.sour_belief(observer, subject, 0, true);
        if let Some(ix) = w.beliefs[observer].find(subject) {
            w.beliefs[observer].bodies[ix].standing = standing;
        }
    }

    fn all_townsfolk(w: &mut World) {
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.beliefs[i].len = 0;
            w.memory[i].len = 0;
        }
    }

    /// A mutually-hostile pair (no deep grudge) gets brokered toward neutral / reconciled: both
    /// standings rise above where they started and neither side stays latched hostile.
    #[test]
    fn hostile_pair_gets_reconciled() {
        let mut w = World::spawn(0xA7C1A, 6);
        all_townsfolk(&mut w);
        // 0 and 1 hold a mutual deep-negative latched-hostile feud (no Assaulted memory ⇒ forgivable).
        seed_hostile(&mut w, 0, 1, -20_000);
        seed_hostile(&mut w, 1, 0, -20_000);

        // run brokering directly (deterministic) — repeat so even a truce path lifts standings.
        w.mirror_beliefs_to_facts();
        for _ in 0..8 {
            broker(&mut w);
        }

        let s01 = w.beliefs[0].find(1).map(|ix| w.beliefs[0].bodies[ix].standing).unwrap();
        let s10 = w.beliefs[1].find(0).map(|ix| w.beliefs[1].bodies[ix].standing).unwrap();
        assert!(s01 > -20_000, "0's standing toward 1 should warm toward neutral, got {s01}");
        assert!(s10 > -20_000, "1's standing toward 0 should warm toward neutral, got {s10}");
        let h01 = w.beliefs[0].find(1).map(|ix| w.beliefs[0].bodies[ix].flags & 0x01).unwrap();
        let h10 = w.beliefs[1].find(0).map(|ix| w.beliefs[1].bodies[ix].flags & 0x01).unwrap();
        assert_eq!(h01, 0, "0 should no longer be latched-hostile to 1");
        assert_eq!(h10, 0, "1 should no longer be latched-hostile to 0");
    }

    /// A deep grudge (an `Assaulted` memory) RESISTS the truce: that side's standing/hostility is left
    /// untouched (a forced forgiveness over real blood is no forgiveness), and no reconcile fires.
    #[test]
    fn deep_grudge_resists_brokering() {
        let mut w = World::spawn(0x9C0DE, 6);
        all_townsfolk(&mut w);
        seed_hostile(&mut w, 0, 1, -20_000);
        seed_hostile(&mut w, 1, 0, -20_000);
        // agent 0 was ASSAULTED by 1 ⇒ 0 will not forgive (its side resists; reconcile is blocked).
        w.memory[0].record(Episode {
            kind: EpisodeKind::Assaulted as u8,
            place: 0,
            valence: -1,
            _pad: 0,
            with: 1,
            t: 0,
            salience: 60_000,
            _pad2: 0,
        });

        for _ in 0..8 {
            broker(&mut w);
        }

        // 0 holds the grudge ⇒ its standing toward 1 is unmoved and still latched hostile.
        let s01 = w.beliefs[0].find(1).map(|ix| w.beliefs[0].bodies[ix].standing).unwrap();
        let h01 = w.beliefs[0].find(1).map(|ix| w.beliefs[0].bodies[ix].flags & 0x01).unwrap();
        assert_eq!(s01, -20_000, "the wounded side resists the truce (standing unchanged)");
        assert_eq!(h01, 0x01, "the wounded side stays latched-hostile (no forced forgiveness)");
        // and no reconcile beat was ever logged (a deep grudge blocks the lasting peace).
        assert!(
            !w.chronicle.iter().any(|bt| bt.kind == BEAT_RECONCILE),
            "a deep grudge must block a reconciliation"
        );
    }

    /// No latched hostility ⇒ no feud ⇒ the Patrician does nothing (a merely-low standing is not a
    /// feud; a fond pair soured by a spark never crosses into a brokerable feud).
    #[test]
    fn low_standing_without_hostility_is_not_a_feud() {
        let mut w = World::spawn(0xCA1F, 6);
        all_townsfolk(&mut w);
        // mutual low standing but NOT latched hostile.
        w.sour_belief(0, 1, 5_000, false);
        w.sour_belief(1, 0, 5_000, false);
        assert!(worst_feud(&w).is_none(), "low standing without hostility is not a feud");
    }

    /// Determinism: the full sim (incl. the patrician society pass) is order-independent across rayon
    /// pool sizes (M=1 ≡ M=N), proven via the world golden hash.
    #[test]
    fn society_patrician_m_invariant() {
        use crate::hash::world_hash;
        use crate::{in_pool, run_sim};
        let h1 = in_pool(1, || world_hash(&run_sim(0x9A11, 400, 80)));
        let h4 = in_pool(4, || world_hash(&run_sim(0x9A11, 400, 80)));
        assert_eq!(h1, h4, "patrician society pass must be M-invariant");
    }
}
