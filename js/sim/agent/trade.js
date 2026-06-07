// Agent trade interface — the economic Theory-of-Mind surface, extracted from
// Agent as free functions over a passed agent instance (the data-and-functions
// split). These define how an agent values, wants, asks/bids, and settles goods
// against the town-wide market (js/sim/market.js) and adjust its PRICE BELIEFS
// from realised trades and chatting neighbours (gossip). Behaviour-preserving:
// verbatim bodies of the old Agent methods. No cycles — imports config + the
// rpg event bus only.

import { GOODS, COMMODITIES, ECON } from '../simconfig.js';
import { bus, makeEvent } from '../../rpg/events.js';

// --- price beliefs (the economic ToM) ---------------------------------------
export function learnPrice(a, c, price, w) {
  let pb = a.priceBeliefs[c] + w * (price - a.priceBeliefs[c]);
  pb = Math.max(ECON.priceBounds[0], Math.min(ECON.priceBounds[1], pb));
  a.priceBeliefs[c] = +pb.toFixed(2);
}

// SELF demand-awareness from my OWN unsold stock (belief-clean; reads only my inventory).
// The cross-agent rumoured-price drift moved into the gossip BRIDGE (perception.js's
// gossipBeliefs) where reading a chatting neighbour's prices is sanctioned — so this
// cognition-layer step touches no other entity.
//
// DEMAND-AWARENESS: a good this agent is SITTING ON — unsold surplus beyond what it
// keeps — is worth less than it believes. Mark the belief DOWN, proportional to the
// glut (capped per tick). A maker drowning in unsellable stock (a smith with a pile of
// tools, a brewer with crates of potion) cuts its price, deflating the inflated CRAFT
// MARGIN that otherwise herds the whole town into the single dearest good. Self-
// correcting: selling drops the surplus and trades re-learn the price upward. Beliefs
// only (mints nothing); bounded; never throws.
export function priceGossip(a, ctx, dt) {
  if (a.controlled) return;
  for (const c of COMMODITIES) {
    const glut = (a.inventory[c] || 0) - (ECON.keep[c] || 0);
    if (glut > 0) {
      const markdown = 1 - Math.min(ECON.unsoldMarkdownMax, ECON.unsoldMarkdown * glut * dt);
      const pb = Math.max(ECON.priceBounds[0], a.priceBeliefs[c] * markdown);
      a.priceBeliefs[c] = +pb.toFixed(2);
    }
  }
}

// --- trade interface (used by the market in simulation.js) ------------------
export function keepOf(a, c) { return ECON.keep[c] ?? 0; }
export function surplus(a, c) { return a.inventory[c] - a.keepOf(c); }
export function hasSurplus(a, c) { return a.surplus(c) >= 1; }

// The recipe inputs of the good this agent is currently making (or null).
export function tradeInputs(a) {
  const g = a._trade && GOODS[a._trade];
  return g && g.inputs ? g.inputs : null;
}

// units this agent wants to buy / can sell of c (for the standing-order book).
// Off profession now: everyone buys food (always) + a tool/potion if they hold
// none + the inputs for whatever good they are CURRENTLY making.
export function wantQty(a, c) {
  if (a.controlled) return 0;
  if (c === 'food') return Math.max(0, ECON.keep.food - Math.floor(a.inventory.food));
  if (c === 'tool') return a.inventory.tool < 1 ? 1 : 0;
  if (c === 'potion') return a.inventory.potion < 1 ? 1 : 0;  // everyone keeps a remedy
  // buy the recipe inputs for the good I'm currently crafting (tool: wood+ore;
  // potion: herb). Raw producers have no inputs and buy none.
  const inputs = tradeInputs(a);
  if (inputs && inputs[c]) return Math.max(0, 2 - Math.floor(a.inventory[c]));
  return 0;
}
export function sellQty(a, c) { return Math.max(0, Math.floor(a.surplus(c))); }
export function askPrice(a, c) { return a.priceBeliefs[c]; }
export function bidPrice(a, c) { return Math.min(a.priceBeliefs[c], a.gold); }   // can't bid more than you hold

export function applyBuy(a, c, price) {
  a.inventory[c] += 1; a.gold -= price; a.learnPrice(c, price, ECON.priceLearn); a._tradeFlash = 0.6;
  const belief = a.priceBeliefs[c] || price;
  const bargain = Math.max(0, (belief - price) / Math.max(1, belief));
  // damp the IDENTITY weight of a routine trade: every agent buys/sells constantly, so
  // at full weight the universal TRADE/HAGGLE tags swamp the profile and make everyone a
  // generic "merchant", drowning the production vocation. Scaled down, a soul's identity
  // is shaped by what it MAKES — only a DEDICATED trader (many deals) still reads as one.
  bus.emit(makeEvent({
    actorId: a.id, verb: 'buy', tags: ['TRADE', 'BARTER', 'HAGGLE'],
    magnitude: (1 + bargain) * ECON.tradeDeedWeight, t: a._rpgNow,
  }));
}
export function applySell(a, c, price) {
  a.inventory[c] -= 1; a.gold += price; a.learnPrice(c, price, ECON.priceLearn); a._tradeFlash = 0.6;
  const belief = a.priceBeliefs[c] || price;
  const profit = Math.max(0, (price - belief) / Math.max(1, belief));
  bus.emit(makeEvent({
    actorId: a.id, verb: 'sell', tags: ['TRADE', 'PROFIT', 'HAGGLE'],
    magnitude: (1 + profit) * ECON.tradeDeedWeight, t: a._rpgNow,
  }));
}
