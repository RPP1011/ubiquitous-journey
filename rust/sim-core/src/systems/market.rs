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

use crate::components::{BeliefTable, Commodity, Economy, Faction, Goal, GoalKind, N_COMMODITIES};
use crate::intent::Intent;
use crate::tags::{motive, outcome, Tag};
use crate::world::World;

/// The action tag(s) for producing/gathering commodity `g` (Food→Farming, Tool→Smithing+Crafting, …).
#[inline]
fn good_tag(g: usize) -> u64 {
    match g {
        0 => Tag::Farming.bit(),
        1 => Tag::Woodcut.bit(),
        2 => Tag::Mining.bit(),
        3 => Tag::Smithing.bit() | Tag::Crafting.bit(),
        4 => Tag::Forage.bit(),
        5 => Tag::Crafting.bit(),
        _ => 0,
    }
}

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
/// Cap on capital-free foraging — a forager gathers only enough to subsist (a handful of meals), not a
/// hoard. Lower than `PRODUCE_CAP`: foraging is a survival fallback, not a trade.
const FORAGE_CAP: i32 = 4;
/// Graded recipe (recipeKnow.ts): a skill at/above this counts as MASTERY (the extra-output bonus); the
/// recipe rises by `RECIPE_LEARN` each time the craft is practised, and fades when it isn't (forget pass).
const MASTER_BAR: f32 = 0.8;
const RECIPE_LEARN: f32 = 0.05;

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

/// Max fraction a seller skews its price by how it REGARDS the buyer (the `npcFavoredPrice` / motive-
/// trust gap): a friend gets a discount, a disliked buyer a markup.
const FAVOR: f32 = 0.20;
/// The price edge an active `trade_edge` (haggle) ability buff grants the SELLER (haggles its sale up).
const TRADE_EDGE: f32 = 0.15;
/// Max fraction the PLAYER's faction reputation skews its buy price (a hero's discount / a pariah's markup).
const PLAYER_REP_FAVOR: f32 = 0.25;
/// The extra discount a seller gives a believed HOUSEMATE buyer (the `assoc` kinship bonus).
const KIN_FAVOR: f32 = 0.1;

/// The seller's price skew toward `buyer`, from its OWN belief-standing about them: ≈0.8 for a dear
/// friend (a deal), ≈1.2 for a despised buyer (gouged), 1.0 for a stranger. Clamped so trade never
/// becomes impossible. The relationship-aware clearing that makes reputation MATTER in the market.
#[inline]
fn standing_skew(bt: &BeliefTable, buyer: u32, seller_house: u16) -> f32 {
    match bt.find(buyer) {
        Some(ix) => {
            let b = &bt.bodies[ix];
            let st = (b.standing as f32 / 32767.0).clamp(-1.0, 1.0); // −1..1
            let mut skew = (1.0 - st * FAVOR).clamp(1.0 - FAVOR, 1.0 + FAVOR);
            // ASSOCIATION (kinship): a seller gives a believed HOUSEMATE (assoc == own house) a small
            // extra discount — kin look after their own at the stalls.
            if seller_house != 0 && b.assoc == seller_house {
                skew *= 1.0 - KIN_FAVOR;
            }
            skew
        }
        None => 1.0, // no opinion ⇒ the neutral midpoint
    }
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
            // the worker's site is `prof-1` — the SAME index `decide` sends a Work goal to, and the
            // canonical good→site mapping (`good_site_index(produced_good(prof)) == prof-1`). (Was `prof`
            // — an off-by-one that meant profession production NEVER fired in the live sim, so the town
            // subsisted entirely on the foraging path; fixing it makes the craft economy real.)
            let ti = (world.town[i] as usize).min(world.work_sites.len() - 1);
            let site = world.work_sites[ti][(prof as usize - 1).min(crate::world::N_WORK_SITES - 1)];
            if within(world.pos[i], site, WORK_RANGE) && world.econ[i].inventory[g] < PRODUCE_CAP {
                world.econ[i].inventory[g] += 1;
                // GRADED RECIPE (recipeKnow.ts): a MASTER of the craft yields an EXTRA unit — a bonus on
                // top of the baseline, so a rusty/half-learned recipe never produces LESS than before
                // (economy-safe by construction: the marginal food supply is never reduced). And working
                // the craft sharpens the recipe (learn-by-doing); it fades unpractised (the forget pass).
                if world.recipe[i][g] >= MASTER_BAR && world.econ[i].inventory[g] < PRODUCE_CAP {
                    world.econ[i].inventory[g] += 1;
                }
                world.recipe[i][g] = (world.recipe[i][g] + RECIPE_LEARN).min(1.0);
                deeds.push(Intent::deed(i as u32, i as u32, 1, good_tag(g), motive::HABIT, outcome::GAINED | outcome::SUCCESS));
            }
        }
        // GATHER (capital-free foraging) — ANY agent with a Gather goal AT the node forages one unit of
        // its RAW good (Food/Wood/Ore/Herb), profession-independent. This is the first-class gather
        // executor the planner's forage path needs (the subsistence starvation-gap fix): a destitute
        // non-farmer who walked to a field actually comes away with a meal. Capped like production; the
        // good is minted (goods are intentionally not gold-conserved, like the production pass above).
        if let Goal::Gather { site, good } = world.goal[i] {
            let g = good as usize;
            if g < N_COMMODITIES
                && within(world.pos[i], site, WORK_RANGE)
                && world.econ[i].inventory[g] < FORAGE_CAP
            {
                world.econ[i].inventory[g] += 1;
                deeds.push(Intent::deed(i as u32, i as u32, 1, Tag::Forage.bit() | good_tag(g), motive::SURVIVAL | motive::HUNGER, outcome::GAINED | outcome::SUCCESS));
            }
        }
    }
    world.intents.items.extend(deeds);

    // ── 2. PARTICIPANTS ─────────────────────────────────────────────────────────────────────────
    // alive, non-monster, with the Market goal, AT the market. Collected in ascending id order, so
    // the per-commodity seller/buyer sub-lists inherit that order (deterministic pairing).
    // MULTI-TOWN: each town's market clears its OWN local participants (the two markets are far enough
    // apart that a participant is only ever in range of its own town's market — so the economies are
    // distinct; the caravan bridges the price gap between them). Transfers accrue across towns.
    let base = world.base_price;
    let mut transfers: Vec<Intent> = Vec::new();
    let markets = world.markets.clone();
    for &market in &markets {
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
            continue;
        }
        run_auction(world, &participants, &base, &mut transfers);
    }
    world.intents.items.extend(transfers);
}

/// Clear one market's id-sorted `participants` (the per-town double auction). Appends Transfer intents to
/// `transfers`; own-writes each trader's believed price. Extracted so each town's market clears alone.
fn run_auction(world: &mut World, participants: &[usize], base: &[i64; N_COMMODITIES], transfers: &mut Vec<Intent>) {
    // ── 3. AUCTION ──────────────────────────────────────────────────────────────────────────────
    // Per commodity, pair id-sorted sellers↔buyers in order at the midpoint of their believed prices.
    // A per-participant running gold BUDGET (spent only on emitted buys, carried ACROSS commodities)
    // keeps a buyer from being matched beyond what it can pay this tick — so every emitted transfer
    // actually clears in the merge, and `learn_price` fires only on trades that truly consummate
    // (no learning from rejected intents). Seller stock is bounded per-commodity by `sell_left`.
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

            // clearing price = midpoint of the two believed prices, SKEWED by how the seller regards the
            // buyer (npcFavoredPrice): a friend gets a deal, a despised buyer is gouged. Conserved — the
            // skew only moves WHERE the midpoint sits, the transfer still moves gold one-for-one.
            let ask = believed_price(&world.econ[s], base, g);
            let bid = believed_price(&world.econ[b], base, g);
            let mid = (ask + bid) / 2; // major units (the neutral midpoint)
            // TRADE_EDGE (the haggle ability buff): a seller with an active buff haggles its sale UP.
            let edge = if world.trade_buff[s] > world.tick { 1.0 + TRADE_EDGE } else { 1.0 };
            // PLAYER REPUTATION (reputation.js): when the PLAYER is the buyer, its standing with the town
            // skews the price — a celebrated hero is given a discount, a feared pariah is gouged. The
            // diegetic payoff of the reputation ledger (a deed's standing comes back at the stalls).
            let rep_skew = if b as i32 == world.player {
                let r = (world.player_rep[Faction::Townsfolk as usize] as f32 / 5000.0).clamp(-1.0, 1.0);
                (1.0 - r * PLAYER_REP_FAVOR).clamp(1.0 - PLAYER_REP_FAVOR, 1.0 + PLAYER_REP_FAVOR)
            } else {
                1.0
            };
            let clear =
                ((mid as f32) * standing_skew(&world.beliefs[s], b as u32, world.house[s] as u16) * edge * rep_skew).round() as i64;
            let clear = clear.max(1);
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
            learn_price(&mut world.econ[s], base, g, clear);
            learn_price(&mut world.econ[b], base, g, clear);

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Commodity, Faction, GoalKind, Goal, Profession};
    use crate::world::World;

    /// The standing-skew prices a trade by how the SELLER regards the buyer: a dear friend gets a
    /// discount (< 1), a despised buyer a markup (> 1), a stranger the neutral midpoint (1.0).
    #[test]
    fn standing_skews_the_clearing_price() {
        use crate::components::PersonBelief;
        let mut friendly = BeliefTable::default();
        friendly.subjects[0] = 9;
        friendly.bodies[0] = PersonBelief { subject: 9, standing: 30000, ..Default::default() };
        friendly.len = 1;
        let mut hostile = BeliefTable::default();
        hostile.subjects[0] = 9;
        hostile.bodies[0] = PersonBelief { subject: 9, standing: -30000, ..Default::default() };
        hostile.len = 1;
        let empty = BeliefTable::default();

        let deal = standing_skew(&friendly, 9, 0);
        let gouge = standing_skew(&hostile, 9, 0);
        let neutral = standing_skew(&empty, 9, 0);
        assert!(deal < 1.0, "a friend gets a discount, got {deal}");
        assert!(gouge > 1.0, "a despised buyer is gouged, got {gouge}");
        assert!((neutral - 1.0).abs() < 1e-6, "a stranger pays the neutral midpoint");
        assert!(deal >= 1.0 - FAVOR - 1e-6 && gouge <= 1.0 + FAVOR + 1e-6, "skew is clamped to ±FAVOR");
    }

    /// GRADED RECIPE: a MASTER at its work site produces an EXTRA unit (baseline + bonus); a half-learned
    /// recipe produces only the baseline — never less. Practising sharpens the recipe (learn-by-doing).
    #[test]
    fn recipe_mastery_yields_a_production_bonus() {
        let mut w = World::spawn(0xEC1, 6);
        let (master, rusty) = (0usize, 1usize);
        // both farmers (profession 1 → Food) standing at the farm site (work_sites[0]).
        let farm = w.work_sites[0][0]; // the Farmer production site (prof 1 → site prof-1 = 0)
        for &i in &[master, rusty] {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.profession[i] = 1;
            w.town[i] = 0; // both belong to town 0 (whose farm site they stand at)
            w.pos[i] = farm;
            w.econ[i].inventory = [0; N_COMMODITIES];
        }
        w.recipe[master][0] = 1.0; // a master of the Food craft (good 0)
        w.recipe[rusty][0] = 0.5; // half-learned (below MASTER_BAR)
        // everyone else idle/away so only these two produce.
        for i in 2..w.n {
            w.profession[i] = 0;
        }
        let master_skill = w.recipe[master][0];
        clear(&mut w);
        assert_eq!(w.econ[master].inventory[0], 2, "a master yields baseline + mastery bonus");
        assert_eq!(w.econ[rusty].inventory[0], 1, "a half-learned recipe yields only the baseline");
        assert!(w.recipe[rusty][0] > 0.5, "practising sharpened the rusty recipe (learn-by-doing)");
        assert!((w.recipe[master][0] - master_skill).abs() < 0.06, "a master's recipe stays at the cap");
    }

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
        w.markets[0] = [0.0, 0.0];
        w.pos[s] = [0.0, 0.0];
        w.pos[b] = [1.0, 0.0];
        // Trader produces nothing, so production never perturbs the test inventories.
        w.profession[s] = Profession::Trader as u8;
        w.profession[b] = Profession::Trader as u8;
        w.goal[s] = Goal::Market { site: w.markets[0] };
        w.goal[b] = Goal::Market { site: w.markets[0] };
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
