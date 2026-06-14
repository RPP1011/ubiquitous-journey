// The town-wide standing-order double auction, extracted from Simulation as a
// free function over the sim instance (orchestration vs. mechanics split).
//
// Town-wide standing-order book (the spec's posted-Bid model): every agent
// posts asks (surplus) and bids (wants, capped by gold) from wherever it is,
// matched cheapest-ask to highest-bid at the midpoint. Beliefs learn toward
// the realised clearing price; unfilled orders drift toward each other
// (decentralised tatonnement) so prices converge to competitive levels.

import { COMMODITIES, ECON, BASE_PRICE, GRANARY } from './simconfig.js';
import { POI_KIND } from './world.js';
import { BUILD_KIND } from './construction.js';
import { recordTrade } from './econstats.js';
import { noteSnub } from './signals.js';
import { addObligation } from './obligations.js';
import type { Agent, Commodity, EntityId } from '../../types/sim.js';

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

// THE STANDING SKEW (NPC↔NPC, item 1) — the seller's OWN belief-standing toward the buyer slides
// the clearing price WITHIN the [ask..bid] band: a believed friend (standing>0) gets it nearer the
// ask (cheaper), a disliked buyer (standing<0) nearer the bid (gouged). The SAME returned price
// governs BOTH transfers (seller receives exactly what buyer pays), so the money loop stays closed —
// favour only shifts WHERE in the band the deal lands. Belief-only (the seller reads its own store);
// guarded; falls back to the plain midpoint on any gap. The player is handled by reputation.ts, not here.
function npcFavoredPrice(seller: Agent, buyer: Agent, ask: number, bid: number, mid: number): number {
  try {
    if (!seller || !buyer || !seller.beliefs) return mid;
    const b = seller.beliefs.get(buyer.id);
    if (!b) return mid;                                   // a stranger gets the neutral midpoint
    const standing = clamp(b.standing || 0, -1, 1);
    if (!standing) return mid;
    const half = (bid - ask) / 2;                          // head-room either side of the midpoint
    // friend (standing>0): slide DOWN toward the ask (cheaper for the buyer); foe (standing<0): UP.
    const shifted = mid - standing * half * (ECON.npcFavorMax || 0);
    return +clamp(shifted, ask, bid).toFixed(2);
  } catch { return mid; }
}

// TOOL QUALITY (item 3) — believed quality 0..1 of a tool from this seller, from its tool-mastery.
// A high-mastery smith's tool carries a premium; quality → 1 at qualityMasteryRef units. Guarded.
function toolQuality(seller: Agent): number {
  const m = (seller && seller.mastery && seller.mastery.tool) || 0;
  return m <= 0 ? 0 : Math.min(1, m / (ECON.qualityMasteryRef || 16));
}

// Stamp the buyer's believed tool quality (the MEAN of what it holds — a fine tool lifts it,
// a crude one drags it). Per-agent _toolQuality (lazy; bounded to one scalar). Guarded.
function stampQuality(buyer: Agent, quality: number): void {
  try {
    if (!buyer) return;
    const held = Math.max(1, Math.floor(buyer.inventory && buyer.inventory.tool || 1));
    const prev = buyer._toolQuality || 0;
    buyer._toolQuality = +clamp((prev * (held - 1) + quality) / held, 0, 1).toFixed(3);
  } catch { /* never throw on the tick */ }
}

// CREDIT (item 4) — does this seller extend credit to this buyer? Reads the seller's OWN
// belief-standing toward the buyer (the epistemic split: trust is believed, not omniscient).
// Only a small loan, only to a well-trusted buyer with a confident belief. Player excluded
// (player↔NPC credit is out of scope for this slice). Guarded; defaults to no credit.
function extendsCredit(seller: Agent, buyer: Agent, value: number): boolean {
  try {
    if (!seller || !buyer || !seller.beliefs || buyer.controlled || seller.controlled) return false;
    if (value > (ECON.creditMax || 0)) return false;             // only small loans
    const b = seller.beliefs.get(buyer.id);
    if (!b) return false;                                        // a stranger gets no credit
    if ((b.confidence || 0) < 0.3) return false;                 // must actually know them
    return (b.standing || 0) >= (ECON.creditStanding ?? 0.4);    // and trust them
  } catch { return false; }
}

// A CREDIT CLEAR — the GOOD moves now (conserved: it leaves the seller, joins the buyer); NO gold
// moves (so gold conservation is untouched). The buyer arms a deferred 'repay' obligation to this
// specific seller, due at creditTerm; settled later by the ledger feature (pays the coin), or
// lapsed into a DEFAULT (foldObligationDefault + the standing/FORSWORN hit in the ledger settle).
// Both sides still learn the price (a real deal happened). Guarded; never throws on the tick.
function creditClear(seller: Agent, buyer: Agent, c: Commodity, price: number, sim: Sim): void {
  try {
    if (!seller.inventory || !buyer.inventory) return;
    seller.inventory[c] = (seller.inventory[c] || 0) - 1;       // the good leaves the seller
    buyer.inventory[c] = (buyer.inventory[c] || 0) + 1;         // and joins the buyer
    seller.learnPrice(c, price, ECON.priceLearn);
    buyer.learnPrice(c, price, ECON.priceLearn);
    seller._tradeFlash = 0.6; buyer._tradeFlash = 0.6;
    const now = sim.time || 0;
    // arm the buyer's debt: a 'repay' to the creditor fired on next MEETING it (the natural "here's
    // your coin"). The ledger feature discharges it into a goalRepay (→ pay → conserved gold transfer)
    // when the debtor next perceives the creditor; if it never settles within creditTerm the obligation
    // LAPSES into a DEFAULT (foldObligationDefault + the gossiped FORSWORN-style standing hit, ledger.ts).
    addObligation(buyer, {
      trigger: 'meet', action: 'repay', counterparty: seller.id, amount: price,
      at: now, expiry: now + (ECON.creditTerm || 240),
    });
  } catch { /* never throw on the tick */ }
}

// runMarket/economicSlight/sour take the live Simulation instance (the EXECUTION side:
// the auction clears over the whole roster + reputation ledger). simulation.js is a LATER
// cluster, so the instance is typed loosely here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any; /* Simulation — ported in a later cluster */

// A deal is fair by the math, but selfish folk feel robbed at the extremes: a
// SHORTAGE price (well above base) galls the buyer (a gouger!), a GLUT price (well
// below) galls the seller (a lowballer!). We sour the slighted party's standing
// toward the counterparty, scaled by their greed — the ambient negative opinion the
// economy otherwise never produced. Only between known NPCs (never the player, whose
// standing is the reputation ledger's job). Guarded; never throws on the tick.
function economicSlight(seller: Agent, buyer: Agent, c: Commodity, price: number, sim: Sim): void {
  try {
    const base = (BASE_PRICE as Record<string, number>)[c]; if (!base) return;
    const m = ECON.slightMargin ?? 0.3, amt = ECON.slightAmount ?? 0.05;
    const pid = sim.reputation && sim.reputation.playerId;
    // sharper deals gall harder: scale by how far past the margin the price ran (cap 3x).
    const hi = price / base - 1, lo = 1 - price / base;
    if (hi >= m) sour(buyer, seller, amt * Math.min(3, hi / m), sim, pid);     // shortage: buyer resents the gouging seller
    else if (lo >= m) sour(seller, buyer, amt * Math.min(3, lo / m), sim, pid); // glut: seller resents the lowballing buyer
  } catch { /* never throw */ }
}
function sour(who: Agent, at: Agent, amt: number, sim: Sim, pid: EntityId | null): void {
  if (!who || !at || who.id === pid || at.id === pid || !who.beliefs) return;  // player standing is the rep ledger's job
  // a deal IS a first-hand meeting — establish the belief if vision never did, so the
  // grudge actually lands (two traders can both be "at market" yet out of each other's sight).
  let b = who.beliefs.get(at.id);
  if (!b) b = who.beliefs.observe(at.id, at.faction, at.pos, sim.time, false);
  const greed = (who.personality && (who.personality.greed ?? who.personality.ambition)) ?? 0.5;
  b.standing = Math.max(-1, b.standing - amt * (0.4 + greed));               // the greedier, the harder they take it
  noteSnub(who, sim.time);   // SIGNAL ([13] §3): a felt slight — perceivable evidence the `slandered` memory reads
}

// THE GRANARY TITHE — a tax IN KIND: when a FOOD trade clears at a town with a built granary,
// a small fraction (GRANARY.titheFrac) of the just-cleared unit moves from the buyer's pack
// into the public larder's stock. Food is produced/consumed (not a conserved quantity like
// gold — gold is NEVER minted/burned here), so the tithe is a real deduction that reads as a
// market tax, not a mint. The granary is found cheaply via BuildSites.nearest (the buildings
// list), distance-gated so only the local town's market pays into its own larder. A full
// larder levies nothing. Guarded; never throws on the tick (the freeze lesson).
function titheGranary(sim: Sim, buyer: Agent): void {
  try {
    const bs = sim.buildSites;
    if (!bs || !bs.nearest || !buyer || !buyer.inventory) return;
    const g = bs.nearest(BUILD_KIND.GRANARY, buyer.pos);
    if (!g || !g.pos) return;
    const r = GRANARY.titheRange || 80;
    const dx = g.pos.x - buyer.pos.x, dz = g.pos.z - buyer.pos.z;
    if (dx * dx + dz * dz > r * r) return;                       // not this town's market
    const frac = GRANARY.titheFrac || 0.15;
    if ((g.stock || 0) >= (GRANARY.stockCap || 12)) return;      // larder full — no tax levied
    // NEVER tax a subsistence buyer's only meal: the tithe falls on PROVISIONING buys (the
    // buyer still holds a whole meal after it), not on a hungry pauper's single unit — the
    // first probe found the unexempted tax STARVING the very margin the larder exists for.
    if ((buyer.inventory.food || 0) < 1 + frac) return;
    buyer.inventory.food -= frac;
    g.stock = Math.min(GRANARY.stockCap || 12, (g.stock || 0) + frac);
  } catch { /* never throw on the tick */ }
}

export function runMarket(sim: Sim): void {
  sim.tradesThisTick = 0;
  // LOGISTICS: trade only clears between agents physically AT a market (within
  // ECON.marketRange of a market POI) — goods don't teleport across the map. A
  // remote producer has to HAUL its load in (the `market` goal) to deal here.
  const mr2 = (ECON.marketRange || 18) ** 2;
  const atMarket = (a: Agent): boolean => {
    const m = sim.world && sim.world.nearest ? sim.world.nearest(POI_KIND.MARKET, a.pos) : null;
    return !!m && a.pos.distanceToSquared(m.pos) <= mr2;
  };
  const traders: Agent[] = sim.agents.filter((a: Agent) => a.alive && a.autonomous && a.faction !== 'monster' && atMarket(a));
  if (traders.length < 2) return;

  for (const c of COMMODITIES as readonly Commodity[]) {
    const sellers = traders.filter((a) => a.sellQty(c) > 0)
      .map((a) => ({ a, ask: a.askPrice(c) })).sort((x, y) => x.ask - y.ask);
    const buyers = traders.filter((a) => a.wantQty(c) > 0 && a.gold >= 1)
      .map((a) => ({ a, bid: a.bidPrice(c) })).sort((x, y) => y.bid - x.bid);

    const soldThisTick = new Set<EntityId>(), boughtThisTick = new Set<EntityId>();   // who actually cleared (vs merely holding stock)
    let i = 0, j = 0, budget = ECON.tradesPerCommodityPerTick;
    while (i < sellers.length && j < buyers.length && budget > 0) {
      const s = sellers[i], b = buyers[j];
      if (s.a === b.a) { j++; continue; }
      if (b.bid < s.ask) break;                 // no overlap left
      const price = +((b.bid + s.ask) / 2).toFixed(2);
      if (s.a.sellQty(c) < 1) { i++; continue; }

      const pid = sim.reputation.playerId;
      const sellerIsPlayer = s.a.id === pid, buyerIsPlayer = b.a.id === pid;

      // CLEARING PRICE — a SINGLE conserved price both sides exchange (gold the buyer pays =
      // gold the seller receives), so the money loop stays closed. Within the [ask..bid] band it
      // is slid by (item 1) the seller NPC's belief-standing toward the buyer and (item 3) the
      // tool's believed quality. The player branches keep reputation.ts's asymmetric favor
      // (player↔NPC standing is the rep ledger's business; the player is exempt from the NPC sum).
      let clearPrice = price;
      if (pid != null && (sellerIsPlayer || buyerIsPlayer)) {
        // legacy player favor (asymmetric by design — only the player's own slot is skewed).
        let sPrice = price, bPrice = price;
        if (buyerIsPlayer) bPrice = sim.reputation.favoredPrice(price, sim.reputation.standing(s.a), true);
        if (sellerIsPlayer) sPrice = sim.reputation.favoredPrice(price, sim.reputation.standing(b.a), false);
        // the player pays bPrice / is paid sPrice; the NPC counterparty takes the symmetric `price`.
        const sBeliefP = s.a.priceBeliefs[c], bBeliefP = b.a.priceBeliefs[c];
        if (b.a.gold < bPrice) { j++; continue; }
        s.a.applySell(c, sPrice); b.a.applyBuy(c, bPrice);
        soldThisTick.add(s.a.id); boughtThisTick.add(b.a.id);
        budget--; sim.tradesThisTick++;
        recordTrade({ t: sim.time, commodity: c, price, sellerId: s.a.id, buyerId: b.a.id, sellerBelief: sBeliefP, buyerBelief: bBeliefP });
        economicSlight(s.a, b.a, c, price, sim);
        if (c === 'food') titheGranary(sim, b.a);
        if (s.a.sellQty(c) < 1) i++;
        if (b.a.wantQty(c) < 1) j++;
        continue;
      }

      // NPC↔NPC: slide the midpoint within the band by the seller's standing toward the buyer.
      clearPrice = npcFavoredPrice(s.a, b.a, s.ask, b.bid, price);
      // tool-quality premium: a high-mastery smith's tool claims a slice of the seller's head-room
      // [clearPrice..bid] (the buyer pays it, the seller receives it — conserved). Believed quality
      // is stamped on the buyer below so its later valuation/wear can read it.
      let quality = 0;
      if (c === 'tool') {
        quality = toolQuality(s.a);
        if (quality > 0) clearPrice = +clamp(clearPrice + quality * (ECON.qualityPremiumMax || 0) * (b.bid - clearPrice), s.ask, b.bid).toFixed(2);
      }

      // CREDIT (item 4) — a trusted-but-cash-short buyer takes the good on credit: the GOOD moves
      // now, the COIN is a deferred 'repay' obligation due at creditTerm. No gold moves on a credit
      // clear (gold conserved by construction); the buyer owes a real debt to this specific seller,
      // armed in its ledger and gossiped on default (the FORSWORN path). Only small loans, only to
      // the well-trusted (seller's OWN belief-standing), capped per agent.
      const onCredit = b.a.gold < clearPrice && extendsCredit(s.a, b.a, clearPrice);
      if (!onCredit && b.a.gold < clearPrice) { j++; continue; }

      // capture each side's price belief BEFORE the trade mutates it (applySell/applyBuy call
      // learnPrice), so the econ ledger sees the pre-clear beliefs.
      const sBelief = s.a.priceBeliefs[c];
      const bBelief = b.a.priceBeliefs[c];
      if (onCredit) {
        creditClear(s.a, b.a, c, clearPrice, sim);   // good moves; gold deferred to the ledger
      } else {
        s.a.applySell(c, clearPrice);
        b.a.applyBuy(c, clearPrice);
      }
      if (c === 'tool' && quality > 0) stampQuality(b.a, quality);  // buyer remembers a fine tool
      soldThisTick.add(s.a.id); boughtThisTick.add(b.a.id);
      budget--; sim.tradesThisTick++;
      // economics telemetry: record this clear (guarded; never throws). The clearing price is the
      // standing/quality-skewed midpoint — the SAME value both sides exchanged (conserved).
      recordTrade({
        t: sim.time, commodity: c, price: clearPrice,
        sellerId: s.a.id, buyerId: b.a.id,
        sellerBelief: sBelief, buyerBelief: bBelief,
      });
      // the slight reads the MARKET signal (the unskewed midpoint vs base), not the interpersonal
      // favor — a gouge is about scarcity, not about who you already (dis)like.
      economicSlight(s.a, b.a, c, price, sim);   // selfish friction -> ambient grudges
      if (c === 'food') titheGranary(sim, b.a);  // the granary tithe: a tax in kind on food clears

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
