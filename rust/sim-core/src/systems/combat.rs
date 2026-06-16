//! FAN-OUT UNIT: combat. Port the spirit of `js/combat.js` + the fight branch of `act.ts`
//! (target a believed-hostile, strike, resolve) — but as INTENTS, not direct writes.
//!
//! WHAT THIS IMPLEMENTS (parallel decide → `Intent::Strike`; the scheduler merges them):
//! - Each agent picks a believed-hostile target from its OWN belief table: either the subject of its
//!   `Goal::Fight{target}`, or — when no Fight goal — the nearest in-range belief flagged hostile
//!   (`flags` bit0). It reads the target's BELIEVED position (`last_x/last_z` on the belief cell),
//!   never the live roster — so an agent can swing where it *thinks* the foe is (the epistemic split).
//! - It advances its OWN `combat[i]` swing state machine (own-write): cooldowns/timers tick down, a
//!   swing goes Idle/Ready → Attack → Recover → Idle. When in melee reach, off cooldown, and able to
//!   act (not Dead/Stagger/Block), it starts a swing this tick and emits an `Intent::Strike{from,to,
//!   dmg}` plus an `Intent::Deed` (for progression). Damage scales with attacker level (levels buy
//!   power, mirroring `combat.js`).
//! - Strikes are collected in parallel then extended onto the queue serially; the deterministic merge
//!   in `World::drain_intents` applies the damage to `combat[to]` and flips `alive` on a kill. This
//!   system NEVER writes another agent's column — only its own `combat[i]`/`rng[i]` + emitted intents.
//!
//! Determinism: the decision reads only own state (`pos[i]`, `goal[i]`, `beliefs[i]`); randomness is
//! drawn only from `rng[i]`; the collect→extend keeps id order; the cross-agent damage is the serial
//! merge. So M=1 ≡ M=N holds.

use rayon::prelude::*;

use crate::components::{BeliefTable, Faction, FighterState, Goal};
use crate::intent::Intent;
use crate::world::World;

/// Fixed cognition-tick duration (seconds). Only sets the swing CADENCE — determinism is independent
/// of its value (every agent advances by the same constant each tick).
const DT: f32 = 0.1;
/// Melee reach (believed-pos to target) in metres — `TUNE.reach` in `js/constants.ts`.
const REACH: f32 = 2.3;
/// Base swing damage — `TUNE.damage` in `js/constants.ts`.
const BASE_DAMAGE: f32 = 24.0;
/// Per-level damage multiplier and its cap (mirrors `RPG.levelDamagePerLevel`/`levelDamageCap`).
const LVL_DMG_PER_LEVEL: f32 = 0.06;
const LVL_DMG_CAP: f32 = 2.5;
/// Recover window after a swing connects (seconds) before the body returns to Idle.
const RECOVER_TIME: f32 = 0.35;
/// Attack-cooldown band after a swing (seconds) — `TUNE.attackCooldownMin/Max`.
const CD_MIN: f32 = 1.3;
const CD_SPAN: f32 = 1.5; // max = 2.8
/// Verb tag for a melee strike deed (Wave-1: an opaque tag id consumed by progression).
const VERB_STRIKE: u8 = 0;

pub fn resolve(world: &mut World) {
    let World {
        ref pos,
        ref goal,
        ref level,
        ref alive,
        ref faction,
        ref beliefs,
        ref mut combat,
        ref mut rng,
        ..
    } = *world;

    // Parallel decide: each agent advances its OWN combat body + rng (own-write) and optionally emits
    // a strike+deed pair. `zip` keeps the two mutable own columns aligned to the same index `i`.
    let strikes: Vec<Intent> = combat
        .par_iter_mut()
        .zip(rng.par_iter_mut())
        .enumerate()
        .filter_map(|(i, (cb, r))| {
            // dead bodies don't fight (the merge already parked them in Dead).
            if !alive[i] || cb.state == FighterState::Dead as u8 {
                return None;
            }

            // ── advance the OWN swing state machine (own-write) ──
            // control-effect timers tick down (the ability debuff ops). A STUNNED body is frozen — it
            // can neither swing nor be re-targeted this tick (returns below).
            if cb.stun > 0.0 {
                cb.stun = (cb.stun - DT).max(0.0);
            }
            if cb.slow > 0.0 {
                cb.slow = (cb.slow - DT).max(0.0);
            }
            if cb.expose > 0.0 {
                cb.expose = (cb.expose - DT).max(0.0);
            }
            if cb.stun > 0.0 {
                return None; // frozen by a stun — no action this tick
            }
            if cb.attack_cd > 0.0 {
                cb.attack_cd = (cb.attack_cd - DT).max(0.0);
            }
            if cb.stagger > 0.0 {
                cb.stagger = (cb.stagger - DT).max(0.0);
                if cb.stagger == 0.0 && cb.state == FighterState::Stagger as u8 {
                    cb.state = FighterState::Idle as u8;
                }
            }
            if cb.recover > 0.0 {
                cb.recover = (cb.recover - DT).max(0.0);
                if cb.recover == 0.0 && cb.state == FighterState::Recover as u8 {
                    cb.state = FighterState::Idle as u8;
                }
            }

            // ── pick a believed-hostile target from OWN beliefs ──
            let bt = &beliefs[i];
            let target = match goal[i] {
                // an explicit fight goal: act on it ONLY while the belief about it survives.
                Goal::Fight { target, .. } => bt.find(target).map(|idx| (target, idx)),
                // no fight goal: the nearest in-range belief flagged hostile (bit0) is fair game. A
                // RAIDER with no one to fight PILLAGES — it wrecks the nearest building it believes it
                // sees (affect:wreck, reaching the percept's health). Townsfolk never wreck (no fallback).
                _ => nearest_hostile(bt, pos[i]).or_else(|| {
                    if faction[i] == Faction::Raider as u8 {
                        nearest_building(bt, pos[i])
                    } else {
                        None
                    }
                }),
            };
            let (to, bidx) = target?;

            // believed position of the foe (NOT its live pos — the split): swing where I think it is.
            let b = &bt.bodies[bidx];
            let dx = pos[i][0] - b.last_x;
            let dz = pos[i][1] - b.last_z;
            let dist2 = dx * dx + dz * dz;
            if dist2 > REACH * REACH {
                return None; // out of melee reach: locomotion closes the gap on a later tick.
            }

            // ── in reach: can I start a swing this tick? ──
            let busy = cb.state == FighterState::Attack as u8
                || cb.state == FighterState::Stagger as u8
                || cb.state == FighterState::Block as u8;
            if cb.attack_cd > 0.0 || busy {
                return None;
            }

            // start + resolve the swing in one tick (the believed hit lands; the merge applies it).
            cb.state = FighterState::Attack as u8;
            cb.has_hit = true;
            cb.recover = RECOVER_TIME;
            cb.attack_cd = CD_MIN + r.next_f32() * CD_SPAN;

            // levels buy real power (offence-only), mirroring combat.js.
            let mult = (1.0 + level[i] as f32 * LVL_DMG_PER_LEVEL).min(LVL_DMG_CAP);
            let dmg = BASE_DAMAGE * mult;

            // emit BOTH the strike (applied by the deterministic merge) and a deed (progression).
            Some(StrikePair {
                strike: Intent::Strike { from: i as u32, to, dmg },
                deed: Intent::Deed {
                    actor: i as u32,
                    verb: VERB_STRIKE,
                    magnitude: dmg as u16,
                    target: to,
                },
            })
        })
        .flat_map(|pair| [pair.strike, pair.deed])
        .collect();

    // serial extend: keeps the per-agent push order (id order) the merge then sorts deterministically.
    world.intents.items.extend(strikes);
}

/// A striker's pair of intents (the damage strike + the progression deed), emitted together.
struct StrikePair {
    strike: Intent,
    deed: Intent,
}

/// Nearest believed-hostile (belief `flags` bit0) to `from`, by believed position. Reads only the
/// agent's OWN belief table — no roster access. Returns `(subject_id, belief_index)`.
#[inline]
fn nearest_hostile(bt: &BeliefTable, from: [f32; 2]) -> Option<(u32, usize)> {
    let mut best: Option<(u32, usize, f32)> = None;
    for idx in 0..bt.len as usize {
        let b = &bt.bodies[idx];
        if b.flags & 1 == 0 {
            continue; // not believed hostile
        }
        let dx = from[0] - b.last_x;
        let dz = from[1] - b.last_z;
        let d2 = dx * dx + dz * dz;
        let better = match best {
            None => true,
            // closer wins; ties break on lowest subject id (order-independent / deterministic).
            Some((bid, _, bd)) => d2 < bd || (d2 == bd && b.subject < bid),
        };
        if better {
            best = Some((b.subject, idx, d2));
        }
    }
    best.map(|(id, idx, _)| (id, idx))
}

/// Nearest believed BUILDING (belief `flags` bit1) to `from` — the raider's pillage target (affect:wreck).
/// Reads only the agent's OWN beliefs; the wreck resolves on the building percept's health. Deterministic
/// tie-break on lowest subject id. Returns `(subject_id, belief_index)`.
#[inline]
fn nearest_building(bt: &BeliefTable, from: [f32; 2]) -> Option<(u32, usize)> {
    let mut best: Option<(u32, usize, f32)> = None;
    for idx in 0..bt.len as usize {
        let b = &bt.bodies[idx];
        if b.flags & 0x02 == 0 {
            continue; // not a believed building
        }
        let dx = from[0] - b.last_x;
        let dz = from[1] - b.last_z;
        let d2 = dx * dx + dz * dz;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::FighterState;
    use crate::world::World;

    /// Two adjacent agents, one believing the other hostile → a strike intent is emitted, the merge
    /// applies the damage, and the believed target loses health.
    #[test]
    fn adjacent_hostile_yields_strike_and_damage() {
        let mut w = World::spawn(0xBEEF, 2);
        // place them in melee reach of each other.
        w.pos[0] = [0.0, 0.0];
        w.pos[1] = [1.0, 0.0];
        // agent 0 believes agent 1 is hostile (the only thing combat needs to decide to swing).
        let bt = &mut w.beliefs[0];
        bt.len = 1;
        bt.subjects[0] = 1;
        bt.bodies[0].subject = 1;
        bt.bodies[0].last_x = 1.0;
        bt.bodies[0].last_z = 0.0;
        bt.bodies[0].flags = 1; // bit0 hostile
        // make sure the attacker is free to swing.
        w.combat[0].attack_cd = 0.0;
        w.combat[0].state = FighterState::Idle as u8;
        let hp_before = w.combat[1].health;

        // run JUST the combat decision, then the deterministic merge.
        resolve(&mut w);
        let n_strikes = w
            .intents
            .items
            .iter()
            .filter(|i| matches!(i, Intent::Strike { .. }))
            .count();
        assert_eq!(n_strikes, 1, "one strike intent expected");
        assert_eq!(w.combat[0].state, FighterState::Attack as u8, "attacker swung");
        assert!(w.combat[0].attack_cd > 0.0, "attack went on cooldown");

        w.drain_intents();
        assert!(w.combat[1].health < hp_before, "the believed target took damage");
    }

    /// No hostile belief ⇒ no strike (idle peace stays peaceful and deterministic).
    #[test]
    fn no_hostile_no_strike() {
        let mut w = World::spawn(0xBEEF, 2);
        w.pos[0] = [0.0, 0.0];
        w.pos[1] = [1.0, 0.0];
        // a belief that is NOT flagged hostile must not trigger a swing.
        let bt = &mut w.beliefs[0];
        bt.len = 1;
        bt.subjects[0] = 1;
        bt.bodies[0].subject = 1;
        bt.bodies[0].last_x = 1.0;
        bt.bodies[0].flags = 0;
        resolve(&mut w);
        assert!(
            !w.intents.items.iter().any(|i| matches!(i, Intent::Strike { .. })),
            "no hostile belief ⇒ no strike"
        );
    }

    /// Many agents all swinging at once: the strike path is order-independent regardless of how rayon
    /// splits the work (the soak's golden hash never fires a strike — the stub beliefs are peaceful —
    /// so the collect→merge ordering is only exercised here). Same final health across thread counts.
    fn brawl_final_health(threads: usize) -> Vec<u32> {
        crate::in_pool(threads, || {
            let mut w = World::spawn(0xF1A7, 64);
            // pack everyone into one melee cluster and make each believe its lower-id neighbour hostile.
            for i in 0..w.n {
                w.pos[i] = [(i % 4) as f32 * 0.5, (i / 4) as f32 * 0.5];
                w.combat[i].state = FighterState::Idle as u8;
                w.combat[i].attack_cd = 0.0;
                if i > 0 {
                    let p = &w.pos[i - 1];
                    let (px, pz) = (p[0], p[1]);
                    let bt = &mut w.beliefs[i];
                    bt.len = 1;
                    bt.subjects[0] = (i - 1) as u32;
                    bt.bodies[0].subject = (i - 1) as u32;
                    bt.bodies[0].last_x = px;
                    bt.bodies[0].last_z = pz;
                    bt.bodies[0].flags = 1;
                }
            }
            // a few ticks of pure combat + the deterministic merge.
            for _ in 0..6 {
                resolve(&mut w);
                w.drain_intents();
            }
            w.combat.iter().map(|c| c.health.to_bits()).collect()
        })
    }

    #[test]
    fn brawl_m_invariant() {
        let h1 = brawl_final_health(1);
        let h4 = brawl_final_health(4);
        let h8 = brawl_final_health(8);
        assert!(h1.iter().any(|&h| h != 100.0f32.to_bits()), "the brawl must actually deal damage");
        assert_eq!(h1, h4, "strike collection diverged at M=4");
        assert_eq!(h1, h8, "strike collection diverged at M=8");
    }

    /// Out of reach ⇒ no strike even when hostile (locomotion must close first).
    #[test]
    fn out_of_reach_no_strike() {
        let mut w = World::spawn(0xBEEF, 2);
        w.pos[0] = [0.0, 0.0];
        let bt = &mut w.beliefs[0];
        bt.len = 1;
        bt.subjects[0] = 1;
        bt.bodies[0].subject = 1;
        bt.bodies[0].last_x = 50.0; // far away
        bt.bodies[0].last_z = 0.0;
        bt.bodies[0].flags = 1;
        resolve(&mut w);
        assert!(
            !w.intents.items.iter().any(|i| matches!(i, Intent::Strike { .. })),
            "out of reach ⇒ no strike"
        );
    }
}
