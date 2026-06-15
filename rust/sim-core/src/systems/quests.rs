//! FAN-OUT UNIT: quests (the quest board). Port the SPIRIT of `js/quest/quest.js` — emergent +
//! radiant contracts, completion detected from ground truth.
//!
//! AS BUILT (SERIAL society phase; mutates `world.quests`):
//! - The board is kept topped up to a floor (`RADIANT_FLOOR`) with RADIANT quests, minted on a
//!   throttle via `world.sim_rng` (world-level stream — NOT per-entity rng, so the serial phase stays
//!   trivially M-invariant). Two kinds are minted: HUNT (slay N agents of a `target` faction — the
//!   flagship, since monsters die from combat already) and DELIVER (a goods contract that simply rides
//!   the board until it expires; the player path settles it in the JS sim). The `giver` is a living
//!   townsperson chosen by a deterministic id-order scan (cursor advanced per mint so a pass doesn't
//!   reuse one giver).
//! - Completion is detected from GROUND TRUTH each tick. A hunt quest stores its quota in `count` and
//!   its kill tally in `got`; `got` is recomputed every tick as `baseline_living - current_living`
//!   (the number of `target`-faction agents that have died since posting), where the baseline living
//!   count was captured into the quest at post time. When `got >= count` (the quota) the quest is
//!   `done` and its `reward` is PAID from the giver's purse to a deterministic claimant (the highest-id
//!   living townsperson other than the giver). Gold is MOVED, never minted (the gold_conserved gate);
//!   a broke giver pays only what it can afford.
//! - Stale quests EXPIRE: a quest past its `expire` tick (and not done) is dropped from the board.
//! Determinism: SERIAL ⇒ M-invariant. Use `world.sim_rng`. CONSERVATION: reward payout MOVES gold
//! (giver -> claimant), never mints.

use crate::components::{Faction, Quest, N_COMMODITIES};
use crate::world::World;

/// How many ticks between board refreshes (mint passes). Mirrors `QUEST.refreshEvery` in spirit.
const REFRESH_EVERY: u32 = 30;
/// Keep at least this many live (un-done) quests posted (mirrors `QUEST.radiantFloor`).
const RADIANT_FLOOR: usize = 3;
/// Ticks a freshly-minted quest lives before it expires unfulfilled.
const QUEST_TTL: u32 = 600;
/// Monsters a hunt quest asks for (mirrors `QUEST.bountyCount`).
const HUNT_QUOTA: u16 = 2;
/// Goods a deliver quest asks for (mirrors `QUEST.deliverQty`).
const DELIVER_QTY: u16 = 3;
/// Quest kind tags (numeric Wave-3 form of the `type` string).
const KIND_HUNT: u8 = 0;
const KIND_DELIVER: u8 = 1;
/// Reward purses (minor units), conserved on payout.
const HUNT_REWARD: i64 = 2200;
const DELIVER_REWARD: i64 = 1400;

pub fn tick(world: &mut World) {
    // 1) Completion + expiry from ground truth (every tick — cheap, reads `alive`).
    resolve_board(world);

    // 2) Mint pass (throttled): top the board up to the radiant floor.
    if world.tick % REFRESH_EVERY == 0 {
        refresh_board(world);
    }
}

/// Count living agents of a faction (ground-truth read — the observer layer, not a decision).
fn living_of_faction(world: &World, faction: u8) -> u16 {
    let mut c: u16 = 0;
    for i in 0..world.n {
        if world.alive[i] && world.faction[i] == faction {
            c = c.saturating_add(1);
        }
    }
    c
}

/// First living townsperson at or after `from`, scanning in id order (deterministic).
fn first_living_townsperson(world: &World, from: usize) -> Option<usize> {
    (from..world.n).find(|&i| world.alive[i] && world.faction[i] == Faction::Townsfolk as u8)
}

/// Highest-id living townsperson other than `exclude` (the deterministic claimant stand-in).
fn last_living_townsperson(world: &World, exclude: u32) -> Option<usize> {
    (0..world.n).rev().find(|&i| {
        world.alive[i] && world.faction[i] == Faction::Townsfolk as u8 && i as u32 != exclude
    })
}

/// Detect completion + expiry across the board. Mutates `world.quests` and (on payout) `world.econ`.
fn resolve_board(world: &mut World) {
    // Take the board out so we can mutate `world.econ` freely while iterating (serial; no race).
    let mut quests = std::mem::take(&mut world.quests);
    let now = world.tick;
    for q in quests.iter_mut() {
        if q.done {
            continue;
        }
        if q.kind == KIND_HUNT {
            // `got` = how many target-faction agents have died since posting, recomputed from the
            // living-at-post baseline packed into `target` (see `pack_target`) vs current living.
            let baseline = hunt_baseline(q);
            let remaining = living_of_faction(world, hunt_faction(q));
            q.got = baseline.saturating_sub(remaining);
            if q.got >= q.count && q.count > 0 {
                complete(world, q);
            }
        }
        // DELIVER quests have no NPC delivery mechanic in Wave-3 — they ride until they expire.
    }
    // Drop done + expired quests.
    quests.retain(|q| !q.done && now < q.expire);
    world.quests = quests;
}

// ── hunt-quest field packing ─────────────────────────────────────────────────────────────────────
// A hunt quest needs THREE numbers: the target faction, the kill quota, and the living-at-post
// baseline (so `got` = baseline − current-living can be recomputed each tick without extra state).
// `count` holds the quota; `got` holds the running kill tally; the `target` u32 packs
// (baseline << 8 | faction): faction in the low byte, baseline (≤ u16) in the next two bytes.
#[inline]
fn pack_target(faction: u8, baseline: u16) -> u32 {
    (faction as u32) | ((baseline as u32) << 8)
}
#[inline]
fn hunt_faction(q: &Quest) -> u8 {
    (q.target & 0xFF) as u8
}
#[inline]
fn hunt_baseline(q: &Quest) -> u16 {
    ((q.target >> 8) & 0xFFFF) as u16
}

/// Pay a completed quest's reward from the giver's purse to a deterministic claimant (gold MOVES,
/// never minted). Marks the quest `done`.
fn complete(world: &mut World, q: &mut Quest) {
    q.done = true;
    q.got = q.count;
    let giver = q.giver as usize;
    // A dead patron can't pay a bounty (mirrors JS `_fail(q, 'giver lost')`). The quest is still
    // marked done + retired; no gold moves (conserved).
    if giver >= world.n || !world.alive[giver] {
        return;
    }
    let Some(claimant) = last_living_townsperson(world, q.giver) else {
        return; // no one to pay — leave the giver's gold untouched (still conserved)
    };
    // Pay what the giver can afford — conserved (move giver -> claimant, never mint).
    let pay = q.reward.max(0).min(world.econ[giver].gold.max(0));
    if pay > 0 {
        world.econ[giver].gold -= pay;
        world.econ[claimant].gold += pay;
    }
}

/// Mint radiant quests until the board is back to the floor (throttled caller).
fn refresh_board(world: &mut World) {
    // Count only LIVE (un-done) quests toward the floor.
    let live = world.quests.iter().filter(|q| !q.done).count();
    if live >= RADIANT_FLOOR {
        return;
    }
    let mut need = RADIANT_FLOOR - live;
    let now = world.tick;
    // Deterministic giver rotation: scan townsfolk in id order, advancing the cursor each mint so two
    // quests minted in the same pass don't share a giver.
    let mut cursor = 0usize;
    while need > 0 {
        let Some(giver) = first_living_townsperson(world, cursor) else {
            break; // no eligible giver left
        };
        cursor = giver + 1;

        // Roll the kind on the WORLD rng (serial ⇒ deterministic). Favour hunts when monsters live.
        let baseline = living_of_faction(world, Faction::Monster as u8);
        let roll = world.sim_rng.next_f32();
        let q = if baseline > 0 && roll < 0.6 {
            // HUNT: slay up to HUNT_QUOTA monsters (capped at how many currently exist).
            let quota = HUNT_QUOTA.min(baseline).max(1);
            Quest {
                kind: KIND_HUNT,
                target: pack_target(Faction::Monster as u8, baseline),
                good: 0,
                count: quota,
                got: 0,
                reward: HUNT_REWARD,
                giver: giver as u32,
                expire: now + QUEST_TTL,
                done: false,
            }
        } else {
            // DELIVER: a goods contract (commodity index rolled on the world rng).
            let good = (world.sim_rng.next_f32() * N_COMMODITIES as f32) as u8;
            Quest {
                kind: KIND_DELIVER,
                target: 0,
                good: good.min(N_COMMODITIES as u8 - 1),
                count: DELIVER_QTY,
                got: 0,
                reward: DELIVER_REWARD,
                giver: giver as u32,
                expire: now + QUEST_TTL,
                done: false,
            }
        };
        world.quests.push(q);
        need -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Economy, Faction, Profession};
    use crate::world::World;

    #[test]
    fn board_stays_topped_up() {
        let mut w = World::spawn(0xC0FFEE, 200);
        for _ in 0..(REFRESH_EVERY + 2) {
            w.tick();
        }
        let live = w.quests.iter().filter(|q| !q.done).count();
        assert!(live >= RADIANT_FLOOR, "board should top up to the floor, got {live}");
        for q in &w.quests {
            assert!((q.giver as usize) < w.n, "giver id in range");
            assert!(w.tick < q.expire, "live quest not expired");
        }
    }

    #[test]
    fn kill_advances_hunt_to_done() {
        let mut w = World::spawn(0xABCDE, 0);
        let g = w.spawn_agent([0.0, 0.0], Faction::Townsfolk, Profession::Trader);
        let claimant = w.spawn_agent([1.0, 0.0], Faction::Townsfolk, Profession::Trader);
        let m = w.spawn_agent([2.0, 0.0], Faction::Monster, Profession::None);
        w.econ[g] = Economy { gold: 10_000, ..Economy::default() };
        let before_total = w.total_gold();

        // Hunt for 1 monster; baseline = 1 living monster.
        w.quests.push(Quest {
            kind: KIND_HUNT,
            target: pack_target(Faction::Monster as u8, 1),
            good: 0,
            count: 1,
            got: 0,
            reward: HUNT_REWARD,
            giver: g as u32,
            expire: w.tick + QUEST_TTL,
            done: false,
        });

        // Not yet complete — monster still alive.
        resolve_board(&mut w);
        assert_eq!(w.quests.len(), 1, "quest stays while monster lives");
        assert!(!w.quests[0].done);
        assert_eq!(w.quests[0].got, 0, "no kills yet");

        // Kill the monster (ground truth), then resolve: got reaches quota and pays out.
        w.alive[m] = false;
        let giver_gold_before = w.econ[g].gold;
        let claimant_gold_before = w.econ[claimant].gold;
        resolve_board(&mut w);

        assert!(w.quests.is_empty(), "completed quest retired");
        assert_eq!(w.econ[g].gold, giver_gold_before - HUNT_REWARD, "giver paid");
        assert_eq!(w.econ[claimant].gold, claimant_gold_before + HUNT_REWARD, "claimant paid");
        assert_eq!(w.total_gold(), before_total, "gold conserved on payout");
    }

    #[test]
    fn payout_never_mints_when_giver_broke() {
        let mut w = World::spawn(0x1234, 0);
        let g = w.spawn_agent([0.0, 0.0], Faction::Townsfolk, Profession::Trader);
        let claimant = w.spawn_agent([1.0, 0.0], Faction::Townsfolk, Profession::Trader);
        let m = w.spawn_agent([2.0, 0.0], Faction::Monster, Profession::None);
        w.econ[g] = Economy { gold: 500, ..Economy::default() }; // less than the reward
        let before_total = w.total_gold();
        w.quests.push(Quest {
            kind: KIND_HUNT,
            target: pack_target(Faction::Monster as u8, 1),
            good: 0,
            count: 1,
            got: 0,
            reward: HUNT_REWARD, // 2200 > 500
            giver: g as u32,
            expire: w.tick + QUEST_TTL,
            done: false,
        });
        w.alive[m] = false;
        resolve_board(&mut w);
        assert_eq!(w.econ[g].gold, 0, "giver paid all it had, not negative");
        assert_eq!(w.econ[claimant].gold, 500, "claimant got exactly what was available");
        assert_eq!(w.total_gold(), before_total, "gold conserved (no mint) even when broke");
    }

    #[test]
    fn stale_quest_expires() {
        let mut w = World::spawn(0x9999, 0);
        let g = w.spawn_agent([0.0, 0.0], Faction::Townsfolk, Profession::Trader);
        w.tick = 1000;
        w.quests.push(Quest {
            kind: KIND_DELIVER,
            target: 0,
            good: 0,
            count: DELIVER_QTY,
            got: 0,
            reward: DELIVER_REWARD,
            giver: g as u32,
            expire: 999, // already past
            done: false,
        });
        resolve_board(&mut w);
        assert!(w.quests.is_empty(), "expired quest dropped from the board");
    }
}
