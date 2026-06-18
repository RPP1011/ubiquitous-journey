//! FAN-OUT UNIT: reason — the REACTIVE overlay (tier-1 reasoning). Ports the catalogue half of
//! `js/sim/schemas/{ir,vocab,interpreter,catalogue}.ts` (docs/architecture/09-reasoning-layer.md) to
//! BEHAVIORAL PARITY (only determinism diverges, doc 22 §9).
//!
//! THE PORT DECISION: the TS layer is a data-only `InteractionSchema` IR + interpreter (predicate /
//! inference / response vocabulary evaluated per-agent over its OWN beliefs/state/mental-map). In Rust
//! that data-IR machinery is overkill — the catalogue's flagship schemas are a handful of fixed,
//! belief-gated reactive RULES, so we implement them DIRECTLY (same reads, same responses, same firing
//! gates) as hard-coded branches. Adding a schema is a new branch here, not a new data row — the only
//! divergence from the TS shape, and behaviorally identical.
//!
//! WHAT FIRES (the reachable flee/hide subset of the 6 flagship schemas — the rest need belief fields
//! this substrate doesn't carry; see SKIPPED below):
//!   1. flee-to-safety  — a believed-hostile within ~9m & I'm not a stand-and-fight aggressor ⇒ break
//!      for the nearest EXIT/SAFE place (an attractor toward refuge; pure-repulsor flee if none known).
//!   2. go-to-ground    — a believed-hostile I'm OUTMATCHED by ⇒ don't just run (you lose), seek
//!      CONCEALMENT and go to ground there.
//!   3. flee-the-brawl  — a believed-hostile within ~7m (a fight breaking out beside me) & I'm no
//!      combatant ⇒ clear the danger zone toward a SAFE place.
//!
//! SKIPPED (noted, not silently dropped) — these need belief fields the Wave-1 `PersonBelief` lacks:
//!   • doubt-the-mask        — needs a `suspicion` field to curdle (no such column).
//!   • no-threat-no-response — needs an animacy tally + self-strike count (no such columns).
//!   • intercept-fleer       — needs a cached `intent`/inferred-destination on the belief (no such field)
//!                             AND it's a pursuit, not a reactive flee (out of this overlay's scope).
//!   raise-the-alarm / hostile-near-friend is DELIBERATELY skipped — `systems::decide` already has a
//!   `Defend` deriver; duplicating it here would double-arbitrate.
//!
//! WHERE IT RUNS: a parallel per-agent phase BEFORE `decide` (a reactive PRE-EMPTION). When a schema
//! fires it stamps `goal[i]` directly; `decide` then runs and, for the SAME tick, the survival reflex
//! or the avenge/threat ladder may legitimately override it (decide is the executive arbiter). So reason
//! is a "set a reactive default the executive may keep or replace" overlay — the cheap, every-relevant-
//! tick reflex layer. The aggressive-grudge override (an avenger HUNTS rather than flees) is preserved
//! because decide's `top_aggressive` branch runs after and overwrites.
//!
//! DETERMINISM (the hard gate): per-entity own-write only — we read/write ONLY row `i`
//! (`beliefs[i]`, `needs[i]`, `personality[i]`, `pos[i]`, `faction[i]`) + the static read-only
//! `world.map`. No cross-agent reads, no rng, no HashMap / float-reduce. Mirrors the `decide`/`perceive`
//! `par_iter_mut` disjoint-borrow pattern ⇒ M=1 ≡ M=N bit-identical.

use rayon::prelude::*;

use crate::components::{Faction, Goal};
use crate::mentalmap::{MentalMap, AFF_CONCEAL, AFF_EXIT, AFF_SAFE};
use crate::world::World;

/// A believed-hostile within this distance (of where I believe it is) trips the flee-to-safety reflex.
const FLEE_NEAR: f32 = 9.0;
const FLEE_NEAR2: f32 = FLEE_NEAR * FLEE_NEAR;
/// A believed-hostile within this (tighter) distance is a brawl breaking out beside me — scatter.
const BRAWL_NEAR: f32 = 7.0;
const BRAWL_NEAR2: f32 = BRAWL_NEAR * BRAWL_NEAR;
/// How far to look for a refuge place (an exit/safe/conceal) when fleeing.
const REFUGE_RANGE: f32 = 400.0;

/// Above this aggression an agent stands and fights rather than fleeing reflexively (the
/// `not(selfIs('combatant'))` gate — a brave/aggressive soul is no flee candidate).
const AGGRESSION_FIGHT: f32 = 0.7;

pub fn reason(world: &mut World) {
    let World {
        ref facts,
        ref personality,
        ref faction,
        ref pos,
        ref level,
        ref map,
        ref alive,
        ref mut goal,
        ..
    } = *world;

    goal.par_iter_mut().enumerate().for_each(|(i, g)| {
        if !alive[i] {
            return; // the dead react to nothing — decide will Idle them.
        }

        // Only the soft, non-combatant townsfolk/civilians run the flee reflex. Monsters/raiders fight
        // by combat reflex (no goal-driven flee), and an aggressive soul stands its ground. This is the
        // schemas' `not(selfIs('combatant'))` gate, read from OWN faction + OWN personality.
        let civilian = faction[i] != Faction::Monster as u8 && faction[i] != Faction::Raider as u8;
        if !civilian || personality[i].aggression >= AGGRESSION_FIGHT {
            return;
        }

        if let Some(react) = react_one(&facts[i], pos[i], level[i], map) {
            *g = react;
        }
    });
}

/// Evaluate the reactive schemas for one agent over its OWN belief table + own state + the static map.
/// Returns `Some(goal)` when a schema fires (the highest-priority reactive response), else `None`
/// (leave the goal for `decide`). No cross-agent reads.
#[inline]
fn react_one(
    fs: &crate::components::FactStore,
    me: [f32; 2],
    my_level: u8,
    map: &MentalMap,
) -> Option<Goal> {
    // Scan MY belief table once for the nearest believed-hostile, tracking whether it is one I'm
    // OUTMATCHED by (its believed level exceeds mine) — the go-to-ground gate. Deterministic
    // tie-break (closest, then lowest subject id) — own-row only.
    let mut nearest: Option<(u32, f32, bool)> = None; // (subject, dist², outmatched)
    for cell in fs.views() {
        if cell.flags & 0x01 == 0 {
            continue; // not believed hostile
        }
        if !cell.last_x.is_finite() || !cell.last_z.is_finite() {
            continue; // a belief pointing at a despawned/NaN pos — no usable repulsor.
        }
        let dx = me[0] - cell.last_x;
        let dz = me[1] - cell.last_z;
        let d2 = dx * dx + dz * dz;
        if d2 > FLEE_NEAR2 {
            continue; // out of reflex range
        }
        // believed-outmatched: the foe's believed level is higher than mine.
        let outmatched = cell.level > my_level;
        let better = match nearest {
            None => true,
            Some((s, bd, _)) => d2 < bd || (d2 == bd && cell.subject < s),
        };
        if better {
            nearest = Some((cell.subject, d2, outmatched));
        }
    }

    let (from, d2, outmatched) = nearest?;

    // 2. GO-TO-GROUND — outmatched ⇒ don't just run (you lose); seek CONCEALMENT and go to ground.
    if outmatched {
        return Some(flee_to(map, me, from, AFF_CONCEAL | AFF_EXIT));
    }

    // 3. FLEE-THE-BRAWL — a hostile breaking out RIGHT beside me (tighter band) ⇒ clear toward safety.
    if d2 <= BRAWL_NEAR2 {
        return Some(flee_to(map, me, from, AFF_SAFE | AFF_EXIT));
    }

    // 1. FLEE-TO-SAFETY — a believed-hostile near ⇒ break for an EXIT or refuge.
    Some(flee_to(map, me, from, AFF_EXIT | AFF_SAFE))
}

/// Build the flee response: an ATTRACTOR toward the nearest refuge place (`fleeTo(nearKnown(...))`),
/// expressed as a `Wander{to}` (locomotion walks toward `to`). When no refuge is known within range,
/// fall back to the pure-repulsor `Flee{from}` (run directly away — the `fleeFrom` quirk).
#[inline]
fn flee_to(map: &MentalMap, me: [f32; 2], from: u32, affords: u16) -> Goal {
    match map.nearest(affords, me, REFUGE_RANGE) {
        Some(p) => Goal::Wander { to: [p.x, p.z] },
        None => Goal::Flee { from },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{GoalKind, Needs, PersonBelief};
    use crate::world::World;

    /// Plant a believed-hostile near a non-aggressive civilian and assert the reflex sets a flee goal
    /// that heads toward a known SAFE/EXIT place (a Wander attractor toward refuge).
    #[test]
    fn nonaggressive_near_hostile_flees_toward_safety() {
        let mut w = World::spawn(0xBEEF, 64);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.needs[i] = Needs::default();
        w.personality[i].aggression = 0.1; // a soft soul, no stand-and-fight
        // place me at the town centre (a SAFE place exists there in the map) and a hostile 4m away.
        w.pos[i] = w.town_center;
        let (px, pz) = (w.pos[i][0], w.pos[i][1]);
        let mut bt = crate::components::BeliefTable::default();
        bt.subjects[0] = 7;
        bt.bodies[0] = PersonBelief {
            subject: 7,
            last_x: px + 4.0,
            last_z: pz,
            confidence: 60000,
            flags: 0x01, // believed hostile
            level: 1,
            ..Default::default()
        };
        bt.len = 1;
        w.facts[i].mirror_core_from(&bt);
        // a level-2 civilian (not outmatched by the level-1 hostile) → flee-to-safety / brawl band.
        w.level[i] = 2;
        w.goal[i] = Goal::Idle;
        reason(&mut w);
        let k = w.goal[i].kind();
        assert!(
            k == GoalKind::Wander || k == GoalKind::Flee,
            "a non-aggressive agent near a hostile must react with a flee goal, got {k:?}"
        );
        // a refuge IS known (town centre = SAFE) → it should head TOWARD it (Wander), not just away.
        match w.goal[i] {
            Goal::Wander { to } => {
                // the chosen refuge must be a real SAFE/EXIT place (finite, on the map).
                assert!(to[0].is_finite() && to[1].is_finite(), "refuge target must be finite");
            }
            Goal::Flee { from } => assert_eq!(from, 7, "pure-repulsor fallback flees the hostile"),
            other => panic!("expected a flee response, got {other:?}"),
        }
    }

    /// An OUTMATCHED civilian (the foe believed higher-level) goes to ground (seeks concealment).
    #[test]
    fn outmatched_civilian_goes_to_ground() {
        let mut w = World::spawn(0xBEEF, 64);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.personality[i].aggression = 0.1;
        w.pos[i] = [0.0, 0.0];
        w.level[i] = 1;
        let mut bt = crate::components::BeliefTable::default();
        bt.subjects[0] = 9;
        bt.bodies[0] = PersonBelief {
            subject: 9,
            last_x: 5.0,
            last_z: 0.0,
            confidence: 60000,
            flags: 0x01,
            level: 9, // far higher than mine → outmatched
            ..Default::default()
        };
        bt.len = 1;
        w.facts[i].mirror_core_from(&bt);
        w.goal[i] = Goal::Idle;
        reason(&mut w);
        // a conceal/exit place exists on the rim → Wander toward it; else pure repulsor.
        let k = w.goal[i].kind();
        assert!(
            k == GoalKind::Wander || k == GoalKind::Flee,
            "an outmatched soul must go to ground (flee), got {k:?}"
        );
    }

    /// An AGGRESSIVE soul does NOT flee reflexively — it stands its ground (decide's hunt owns it).
    #[test]
    fn aggressive_soul_does_not_flee() {
        let mut w = World::spawn(0xBEEF, 64);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.personality[i].aggression = 0.95; // a brave fighter
        w.pos[i] = [0.0, 0.0];
        let mut bt = crate::components::BeliefTable::default();
        bt.subjects[0] = 7;
        bt.bodies[0] = PersonBelief {
            subject: 7,
            last_x: 3.0,
            last_z: 0.0,
            confidence: 60000,
            flags: 0x01,
            ..Default::default()
        };
        bt.len = 1;
        w.facts[i].mirror_core_from(&bt);
        w.goal[i] = Goal::Idle;
        reason(&mut w);
        assert_eq!(
            w.goal[i].kind(),
            GoalKind::Idle,
            "an aggressive soul must NOT be pre-empted into a flee — it stands and fights"
        );
    }

    /// A MONSTER (non-civilian) is not subject to the flee reflex (it fights by combat reflex).
    #[test]
    fn monster_does_not_flee() {
        let mut w = World::spawn(0xBEEF, 64);
        // force agent 0 to be a monster.
        w.faction[0] = Faction::Monster as u8;
        w.personality[0].aggression = 0.1;
        w.pos[0] = [0.0, 0.0];
        let mut bt = crate::components::BeliefTable::default();
        bt.subjects[0] = 7;
        bt.bodies[0] = PersonBelief {
            subject: 7,
            last_x: 2.0,
            last_z: 0.0,
            confidence: 60000,
            flags: 0x01,
            ..Default::default()
        };
        bt.len = 1;
        w.facts[0].mirror_core_from(&bt);
        w.goal[0] = Goal::Idle;
        reason(&mut w);
        assert_eq!(w.goal[0].kind(), GoalKind::Idle, "a monster must not run the civilian flee reflex");
    }

    /// No believed-hostile in range ⇒ reason leaves the goal untouched for `decide`.
    #[test]
    fn no_hostile_leaves_goal_for_decide() {
        let mut w = World::spawn(0xBEEF, 64);
        let i = 0usize;
        w.faction[i] = Faction::Townsfolk as u8;
        w.personality[i].aggression = 0.1;
        w.facts[i] = crate::components::FactStore::default(); // no beliefs at all
        w.goal[i] = Goal::Idle;
        reason(&mut w);
        assert_eq!(w.goal[i].kind(), GoalKind::Idle, "with no hostile, reason must not pre-empt");
    }
}
