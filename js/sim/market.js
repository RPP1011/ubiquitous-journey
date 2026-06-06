// The town-wide standing-order double auction, extracted from Simulation as a
// free function over the sim instance (orchestration vs. mechanics split).
//
// Town-wide standing-order book (the spec's posted-Bid model): every agent
// posts asks (surplus) and bids (wants, capped by gold) from wherever it is,
// matched cheapest-ask to highest-bid at the midpoint. Beliefs learn toward
// the realised clearing price; unfilled orders drift toward each other
// (decentralised tatonnement) so prices converge to competitive levels.

import { COMMODITIES, ECON, BASE_PRICE } from './simconfig.js';
import { POI_KIND } from './world.js';
import { recordTrade } from './econstats.js';

// A deal is fair by the math, but selfish folk feel robbed at the extremes: a
// SHORTAGE price (well above base) galls the buyer (a gouger!), a GLUT price (well
// below) galls the seller (a lowballer!). We sour the slighted party's standing
// toward the counterparty, scaled by their greed — the ambient negative opinion the
// economy otherwise never produced. Only between known NPCs (never the player, whose
// standing is the reputation ledger's job). Guarded; never throws on the tick.
function economicSlight(seller, buyer, c, price, sim) {
  try {
    const base = BASE_PRICE[c]; if (!base) return;
    const m = ECON.slightMargin ?? 0.3, amt = ECON.slightAmount ?? 0.05;
    const pid = sim.reputation && sim.reputation.playerId;
    // sharper deals gall harder: scale by how far past the margin the price ran (cap 3x).
    const hi = price / base - 1, lo = 1 - price / base;
    if (hi >= m) sour(buyer, seller, amt * Math.min(3, hi / m), sim, pid);     // shortage: buyer resents the gouging seller
    else if (lo >= m) sour(seller, buyer, amt * Math.min(3, lo / m), sim, pid); // glut: seller resents the lowballing buyer
  } catch { /* never throw */ }
}
function sour(who, at, amt, sim, pid) {
  if (!who || !at || who.id === pid || at.id === pid || !who.beliefs) return;  // player standing is the rep ledger's job
  // a deal IS a first-hand meeting — establish the belief if vision never did, so the
  // grudge actually lands (two traders can both be "at market" yet out of each other's sight).
  let b = who.beliefs.get(at.id);
  if (!b) b = who.beliefs.observe(at.id, at.faction, at.pos, sim.time, false);
  const greed = (who.personality && (who.personality.greed ?? who.personality.ambition)) ?? 0.5;
  b.standing = Math.max(-1, b.standing - amt * (0.4 + greed));               // the greedier, the harder they take it
}

export function runMarket(sim) {
  sim.tradesThisTick = 0;
  // LOGISTICS: trade only clears between agents physically AT a market (within
  // ECON.marketRange of a market POI) — goods don't teleport across the map. A
  // remote producer has to HAUL its load in (the `market` goal) to deal here.
  const mr2 = (ECON.marketRange || 18) ** 2;
  const atMarket = (a) => {
    const m = sim.world && sim.world.nearest ? sim.world.nearest(POI_KIND.MARKET, a.pos) : null;
    return !!m && a.pos.distanceToSquared(m.pos) <= mr2;
  };
  const traders = sim.agents.filter((a) => a.alive && a.autonomous && a.faction !== 'monster' && atMarket(a));
  if (traders.length < 2) return;

  for (const c of COMMODITIES) {
    const sellers = traders.filter((a) => a.sellQty(c) > 0)
      .map((a) => ({ a, ask: a.askPrice(c) })).sort((x, y) => x.ask - y.ask);
    const buyers = traders.filter((a) => a.wantQty(c) > 0 && a.gold >= 1)
      .map((a) => ({ a, bid: a.bidPrice(c) })).sort((x, y) => y.bid - x.bid);

    const soldThisTick = new Set(), boughtThisTick = new Set();   // who actually cleared (vs merely holding stock)
    let i = 0, j = 0, budget = ECON.tradesPerCommodityPerTick;
    while (i < sellers.length && j < buyers.length && budget > 0) {
      const s = sellers[i], b = buyers[j];
      if (s.a === b.a) { j++; continue; }
      if (b.bid < s.ask) break;                 // no overlap left
      const price = +((b.bid + s.ask) / 2).toFixed(2);
      if (s.a.sellQty(c) < 1) { i++; continue; }
      if (b.a.gold < price) { j++; continue; }

      // RPG price favor: when the player is the counterparty, skew the clearing
      // price by the seller/buyer NPC's standing toward the player (beloved =>
      // buys cheaper, sells dearer). Capped at REP.priceFavorMax.
      let sPrice = price, bPrice = price;
      const pid = sim.reputation.playerId;
      if (pid != null) {
        if (b.a.id === pid) bPrice = sim.reputation.favoredPrice(price, sim.reputation.standing(s.a), true);
        if (s.a.id === pid) sPrice = sim.reputation.favoredPrice(price, sim.reputation.standing(b.a), false);
      }
      // capture each side's price belief BEFORE the trade mutates it (applySell/
      // applyBuy call learnPrice), so the econ ledger sees the pre-clear beliefs.
      const sBelief = s.a.priceBeliefs[c];
      const bBelief = b.a.priceBeliefs[c];
      s.a.applySell(c, sPrice);
      b.a.applyBuy(c, bPrice);
      soldThisTick.add(s.a.id); boughtThisTick.add(b.a.id);
      budget--; sim.tradesThisTick++;
      // economics telemetry: record this clear (guarded; never throws). The
      // clearing price is the midpoint `price`; sPrice/bPrice are the player
      // reputation skew applied to the actual transfer, not the market signal.
      recordTrade({
        t: sim.time, commodity: c, price,
        sellerId: s.a.id, buyerId: b.a.id,
        sellerBelief: sBelief, buyerBelief: bBelief,
      });
      economicSlight(s.a, b.a, c, price, sim);   // selfish friction -> ambient grudges



      if (s.a.sellQty(c) < 1) i++;
      if (b.a.wantQty(c) < 1) j++;
    }

    // tatonnement: only the TRULY UNFILLED adjust — a seller who found NO buyer marks
    // down (a real glut), a buyer who got NOTHING marks up (a real shortage). Agents
    // who DID clear already learned toward the price; re-nudging them by leftover stock
    // is the bug that let a hoarding monopolist self-undercut (the more it held, the
    // cheaper it priced). Now scarcity can actually lift a sole seller's price.
    for (const a of traders) {
      if (a.sellQty(c) > 0 && !soldThisTick.has(a.id)) a.learnPrice(c, a.priceBeliefs[c] * ECON.tatonnementDown, 1);
      if (a.wantQty(c) > 0 && a.gold >= 1 && !boughtThisTick.has(a.id)) a.learnPrice(c, a.priceBeliefs[c] * ECON.tatonnementUp, 1);
    }
  }
}
