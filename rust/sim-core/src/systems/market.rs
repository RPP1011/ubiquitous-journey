//! FAN-OUT UNIT: market / economy. Port the spirit of `js/sim/market.ts` (the localized double-
//! auction) + the trade interface in `js/sim/agent/trade.ts` — as INTENTS into the conserved merge.
//!
//! WHAT THIS IMPLEMENTS (port spirit, not TS parity — doc 22 §9):
//! - Participants = agents AT the market (`goal[i] == Market`, within `MARKET_RANGE` of `world.market`,
//!   alive, non-monster). Each has, per commodity, a SELL surplus (`inventory[g]` over a keep floor)
//!   or a BUY want (under a desire floor) that it can afford.
//! - Per commodity we build the id-sorted lists of sellers and buyers and pair them in order at the
//!   belief MIDPOINT. Each pairing emits `Intent::Transfer{from:seller, to:buyer, good, qty:1, price}`.
//!   The scheduler's serial merge (`World::drain_intents`) moves gold/goods atomically and conserves
//!   (gold is fixed-point `i64` — only moved, never minted).
//! - Both parties drift their OWN `price_belief[g]` toward the clear (own-write; no cross-agent write).
//! - Production: a worker standing at its own work site bumps its OWN `inventory[good]` (own-write)
//!   and emits a `Deed` for progression — this is what feeds the surplus the auction then clears.
//!
//! DETERMINISM: the pairing is a single SERIAL pass over the (small) market subset in a FIXED order
//! (commodity, then ascending seller-id, then ascending buyer-id), so it is order-independent and
//! identical across rayon core counts. No randomness is needed here (any would route through
//! `world.rng[i]`). The actual gold/good movement is the deterministic serial merge — this pass only
//! PROPOSES transfers + writes its own rows. No HashMap / no float-reduce on the behaviour path.

use crate::components::{Commodity, Economy, Faction, GoalKind, N_COMMODITIES};
use crate::intent::Intent;
use crate::world::World;

/// Within this distance of `world.market` an agent counts as "at the stalls" (mirrors the JS
/// `ECON.marketRange`; squared-compared). Goods don't teleport — a remote producer must HAUL in.
const MARKET_RANGE: f32 = 18.0;

/// Per-commodity KEEP floor: stock at/under this is held back (subsistence / working stock); only the
/// surplus ABOVE it is offered to the sell book. (Food is provisioned a little deeper.)
const KEEP: [i32; N_COMMODITIES] = [3, 1, 1, 1, 1, 1];
/// Per-commodity WANT floor: an agent under this wants to buy up to it (one unit per tick).
const WANT: [i32; N_COMMODITIES] = [4, 0, 0, 1, 0, 1];

/// A worker AT its own work site produces one unit of its good per tick (so the auction has stock).
const WORK_RANGE: f32 = 6.0;
/// Cap on self-produced working inventory so it can't grow unbounded (the auction drains the rest).
const PRODUCE_CAP: i32 = 64;

/// The belief→price drift toward an observed clear, as a 1/256 fraction (own-write learning rate).
const PRICE_LEARN_NUM: i64 = 64; // 64/256 = 0.25

#[inline]
fn within(pos: [f32; 2], site: [f32; 2], range: f32) -> bool {
    let dx = pos[0] - site[0];
    let dz = pos[1] - site[1];
    dx * dx + dz * dz <= range * range
}

/// The commodity a profession produces, if any (Trader/None/monster → none). Indices match the
/// `Profession` enum (1..=6) in components.rs.
#[inline]
fn produced_good(prof: u8) -> Option<usize> {
    match prof {
        1 => Some(Commodity::Food as usize), // Farmer
        2 => Some(Commodity::Ore as usize),  // Miner
        3 => Some(Commodity::Wood as usize), // Woodcutter
        4 => Some(Commodity::Tool as usize), // Blacksmith
        5 => Some(Commodity::Herb as usize), // Hunter
        _ => None,                           // Trader (6) / None (0) / monster
    }
}

/// This agent's believed unit price (major units) for good `g`, falling back to base when unlearned.
#[inline]
fn believed_price(e: &Economy, base: &[i64; N_COMMODITIES], g: usize) -> i64 {
    let pb = e.price_belief[g] as i64;
    if pb > 0 {
        pb
    } else {
        base[g]
    }
}

/// Drift `price_belief[g]` toward `clear` (major units): own-write EMA, clamped to a positive u16.
#[inline]
fn learn_price(e: &mut Economy, base: &[i64; N_COMMODITIES], g: usize, clear: i64) {
    let cur = believed_price(e, base, g);
    let next = cur + (clear - cur) * PRICE_LEARN_NUM / 256;
    e.price_belief[g] = next.clamp(1, u16::MAX as i64) as u16;
}

/// Units of `g` this agent offers to sell (surplus above the keep floor).
#[inline]
fn sell_qty(e: &Economy, g: usize) -> i32 {
    (e.inventory[g] - KEEP[g]).max(0)
}

/// Units of `g` this agent wants to buy this tick (1 while it is below the want floor, else 0).
#[inline]
fn want_qty(e: &Economy, g: usize) -> i32 {
    i32::from(WANT[g] > 0 && e.inventory[g] < WANT[g])
}

pub fn clear(world: &mut World) {
    // ── 1. PRODUCTION (own-write) ──────────────────────────────────────────────────────────────
    // A worker standing at its own work site makes one unit of its good (this is what stocks the
    // sell book). Bump its OWN inventory + emit a Deed for progression. Serial id-order pass over
    // all agents writing only row `i` — deterministic and own-write.
    let mut deeds: Vec<Intent> = Vec::new();
    for i in 0..world.n {
        if !world.alive[i] {
            continue;
        }
        let prof = world.profession[i];
        if let Some(g) = produced_good(prof) {
            let site = world.work_sites[(prof as usize).min(crate::world::N_WORK_SITES - 1)];
            if within(world.pos[i], site, WORK_RANGE) && world.econ[i].inventory[g] < PRODUCE_CAP {
                world.econ[i].inventory[g] += 1;
                deeds.push(Intent::Deed { actor: i as u32, verb: 0, magnitude: 1, target: i as u32 });
            }
        }
    }
    world.intents.items.extend(deeds);

    // ── 2. PARTICIPANTS ─────────────────────────────────────────────────────────────────────────
    // alive, non-monster, with the Market goal, AT the market. Collected in ascending id order, so
    // the per-commodity seller/buyer sub-lists inherit that order (deterministic pairing).
    let market = world.market;
    let mut participants: Vec<usize> = Vec::new();
    for i in 0..world.n {
        if world.alive[i]
            && world.faction[i] != Faction::Monster as u8
            && matches!(world.goal[i].kind(), GoalKind::Market)
            && within(world.pos[i], market, MARKET_RANGE)
        {
            participants.push(i);
        }
    }
    if participants.len() < 2 {
        return;
    }

    // ── 3. AUCTION ──────────────────────────────────────────────────────────────────────────────
    // Per commodity, pair id-sorted sellers↔buyers in order at the midpoint of their believed prices.
    // A per-participant running gold BUDGET (spent only on emitted buys, carried ACROSS commodities)
    // keeps a buyer from being matched beyond what it can pay this tick — so every emitted transfer
    // actually clears in the merge, and `learn_price` fires only on trades that truly consummate
    // (no learning from rejected intents). Seller stock is bounded per-commodity by `sell_left`.
    let base = world.base_price;
    let mut transfers: Vec<Intent> = Vec::new();
    let mut gold_budget: Vec<i64> = participants.iter().map(|&i| world.econ[i].gold).collect();
    // map agent id → its index in `participants` (for the budget lookup; participants is id-sorted
    // and tiny, so a binary search stays deterministic + cheap — no HashMap on the behaviour path).
    let budget_idx = |id: usize| participants.binary_search(&id).ok();
    for g in 0..N_COMMODITIES {
        let sellers: Vec<usize> =
            participants.iter().copied().filter(|&i| sell_qty(&world.econ[i], g) > 0).collect();
        let buyers: Vec<usize> =
            participants.iter().copied().filter(|&i| want_qty(&world.econ[i], g) > 0).collect();
        if sellers.is_empty() || buyers.is_empty() {
            continue;
        }

        // remaining capacity this tick, indexed parallel to the sorted seller/buyer lists.
        let mut sell_left: Vec<i32> = sellers.iter().map(|&i| sell_qty(&world.econ[i], g)).collect();
        let mut buy_left: Vec<i32> = buyers.iter().map(|&i| want_qty(&world.econ[i], g)).collect();

        let (mut si, mut bi) = (0usize, 0usize);
        while si < sellers.len() && bi < buyers.len() {
            if sell_left[si] <= 0 {
                si += 1;
                continue;
            }
            if buy_left[bi] <= 0 {
                bi += 1;
                continue;
            }
            let s = sellers[si];
            let b = buyers[bi];
            if s == b {
                // can't trade with yourself; skip this buyer slot (a seller may also be a buyer of g).
                bi += 1;
                continue;
            }

            // clearing price = midpoint of the two believed prices (major) → minor-unit transfer price.
            let ask = believed_price(&world.econ[s], &base, g);
            let bid = believed_price(&world.econ[b], &base, g);
            let clear = (ask + bid) / 2; // major units
            let price_minor = clear * 100; // gold is fixed-point ×100

            // affordability against the buyer's REMAINING budget (already net of its earlier emitted
            // buys this tick), so the emitted transfer is one the merge will actually apply. Stock is
            // bounded by `sell_left`; this keeps the book honest so a tapped-out buyer advances.
            let b_slot = budget_idx(b).expect("buyer is a participant");
            if gold_budget[b_slot] < price_minor {
                bi += 1;
                continue;
            }

            transfers.push(Intent::Transfer {
                from: s as u32,
                to: b as u32,
                good: g as u8,
                qty: 1,
                price: price_minor,
            });
            gold_budget[b_slot] -= price_minor; // reserve the spend for the rest of the tick

            // both sides drift their OWN belief toward the clear (own-write; s != b ⇒ distinct rows).
            // The trade is guaranteed to consummate (budget+stock reserved), so this learns a REAL clear.
            learn_price(&mut world.econ[s], &base, g, clear);
            learn_price(&mut world.econ[b], &base, g, clear);

            sell_left[si] -= 1;
            buy_left[bi] -= 1;
            if sell_left[si] <= 0 {
                si += 1;
            }
            if buy_left[bi] <= 0 {
                bi += 1;
            }
        }
    }

    world.intents.items.extend(transfers);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Commodity, Faction, GoalKind, Goal, Profession};
    use crate::world::World;

    /// A seller with surplus + a buyer who wants it, both at the market → a transfer that conserves
    /// total gold and moves exactly one unit of the good.
    #[test]
    fn seller_buyer_at_market_clears_and_conserves() {
        let mut w = World::spawn(0xBEEF, 8);
        let (s, b) = (0usize, 1usize);
        // isolate the pair: everyone else dead so only s↔b participate.
        for i in 0..w.n {
            w.alive[i] = i == s || i == b;
        }
        w.faction[s] = Faction::Townsfolk as u8;
        w.faction[b] = Faction::Townsfolk as u8;
        w.market = [0.0, 0.0];
        w.pos[s] = [0.0, 0.0];
        w.pos[b] = [1.0, 0.0];
        // Trader produces nothing, so production never perturbs the test inventories.
        w.profession[s] = Profession::Trader as u8;
        w.profession[b] = Profession::Trader as u8;
        w.goal[s] = Goal::Market { site: w.market };
        w.goal[b] = Goal::Market { site: w.market };
        let food = Commodity::Food as usize;
        w.econ[s].inventory[food] = KEEP[food] + 3; // surplus to sell
        w.econ[b].inventory[food] = 0; // wants food
        w.econ[s].gold = 0;
        w.econ[b].gold = 100_000;

        assert!(matches!(w.goal[s].kind(), GoalKind::Market));
        assert!(want_qty(&w.econ[b], food) > 0);
        assert!(sell_qty(&w.econ[s], food) > 0);

        let gold_before = w.total_gold();
        let s_food_before = w.econ[s].inventory[food];
        let b_food_before = w.econ[b].inventory[food];

        clear(&mut w);
        w.drain_intents();

        assert_eq!(gold_before, w.total_gold(), "gold must be conserved");
        assert_eq!(w.econ[s].inventory[food], s_food_before - 1, "seller gave up one unit");
        assert_eq!(w.econ[b].inventory[food], b_food_before + 1, "buyer received one unit");
        assert!(w.econ[s].gold > 0, "seller was paid");
        assert!(w.econ[b].gold < 100_000, "buyer paid");
    }
}
