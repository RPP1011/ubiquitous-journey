// Agent trade interface — the economic Theory-of-Mind surface, extracted from
// Agent as free functions over a passed agent instance (the data-and-functions
// split). These define how an agent values, wants, asks/bids, and settles goods
// against the town-wide market (js/sim/market.js) and adjust its PRICE BELIEFS
// from realised trades and chatting neighbours (gossip). Behaviour-preserving:
// verbatim bodies of the old Agent methods. No cycles — imports config + the
// rpg event bus only.

import { GOODS, COMMODITIES, ECON, WEALTH, BASE_PRICE } from '../simconfig.js';
import { ABILITY } from '../../rpg/rpgconfig.js';
import { bus, makeEvent } from '../../rpg/events.js';
import type { Agent, CognitionCtx, ActionEventSpec, ActionEvent } from '../../../types/sim.js';

// events.js infers makeEvent's `tags=[]` default as never[]; retype it to its real spec.
const mkEvent = makeEvent as (spec: ActionEventSpec) => ActionEvent;

// Re-typed config views (simconfig.js is inferred without index signatures under allowJs).
const GOODS_T = GOODS as Record<string, { inputs: Record<string, number> | null }>;
const ECON_KEEP = ECON.keep as Record<string, number>;
const WEALTH_RATIO = (WEALTH.stashRatio || {}) as Record<string, number>;
const BASE_PRICE_T = BASE_PRICE as Record<string, number>;

// Deterministically move a fraction of a freshly-spawned agent's PURSE into its
// STASH per the WEALTH config. Day-one baseline-identical: WEALTH.enabled is false,
// so this returns immediately and stash stays 0 (the soak is byte-stable). When
// enabled, it is a pure TRANSFER purse→stash (conserves a.gold+a.stash — no mint).
// Guarded for professionless agents: monsters/player have profession:null and no
// _trade, so they fall to the default ratio but, being given no startGold split
// while disabled, keep their whole purse. Never throws.
export function seedStash(a: Agent): void {
  try {
    if (!WEALTH || !WEALTH.enabled) return;          // OFF ⇒ no-op (byte-stable migration)
    if (!a || a.controlled || a.faction === 'monster') return;  // player/monsters: all purse
    const key = a._trade || a.profession || 'default';
    const ratio = (WEALTH.stashRatio && (WEALTH_RATIO[key] ?? WEALTH_RATIO.default)) || 0;
    const bank = Math.max(0, Math.floor(((a.gold || 0) - (WEALTH.minPurse || 0)) * ratio));
    if (bank <= 0) return;
    a.gold -= bank;                                  // TRANSFER, not a mint
    a.stash = (a.stash || 0) + bank;
  } catch { /* never throw on construct */ }
}

// --- price beliefs (the economic ToM) ---------------------------------------
export function learnPrice(a: Agent, c: string, price: number, w: number): void {
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
export function priceGossip(a: Agent, _ctx: CognitionCtx, dt: number): void {
  if (a.controlled) return;
  for (const c of COMMODITIES) {
    const glut = (a.inventory[c] || 0) - (ECON_KEEP[c] || 0);
    if (glut > 0) {
      const markdown = 1 - Math.min(ECON.unsoldMarkdownMax, ECON.unsoldMarkdown * glut * dt);
      const pb = Math.max(ECON.priceBounds[0], a.priceBeliefs[c] * markdown);
      a.priceBeliefs[c] = +pb.toFixed(2);
    }
  }
}

// --- trade interface (used by the market in simulation.js) ------------------
export function keepOf(a: Agent, c: string): number { return ECON_KEEP[c] ?? 0; }
export function surplus(a: Agent, c: string): number { return a.inventory[c] - a.keepOf(c); }
export function hasSurplus(a: Agent, c: string): boolean { return a.surplus(c) >= 1; }

// The recipe inputs of the good this agent is currently making (or null).
export function tradeInputs(a: Agent): Record<string, number> | null {
  const g = a._trade ? GOODS_T[a._trade] : null;
  return g && g.inputs ? g.inputs : null;
}

// units this agent wants to buy / can sell of c (for the standing-order book).
// Off profession now: everyone buys food (always) + a tool/potion if they hold
// none + the inputs for whatever good they are CURRENTLY making.
export function wantQty(a: Agent, c: string): number {
  if (a.controlled) return 0;
  // CAMPAIGN RATIONS: a townsfolk COMBATANT (frontier fighter, guard) provisions DEEPER — its
  // patrol carries it far from the stalls and danger keeps interrupting the trip back, so a
  // civilian larder (~keep.food meals ≈ 5 min) starves it in practice (the starvation probe's
  // famine was all gold-rich fighters). It BUYS the bigger pack — the money loop stays closed.
  if (c === 'food') {
    const keep = ECON.keep.food * ((a.combatant && a.faction === 'townsfolk') ? (ECON.rationMul || 2) : 1);
    return Math.max(0, keep - Math.floor(a.inventory.food));  // food is consumed, not hoarded — no speculation
  }
  // the base consumption/production want, then any SPECULATIVE hoard on top (a non-perishable good
  // a wealthy ambitious soul sees as glutted — see speculativeWant). Both are plain BUY transfers.
  let want = 0;
  if (c === 'tool') want = a.inventory.tool < 1 ? 1 : 0;
  else if (c === 'potion') want = a.inventory.potion < 1 ? 1 : 0;  // everyone keeps a remedy
  else {
    // buy the recipe inputs for the good I'm currently crafting (tool: wood+ore; potion: herb) —
    // but only if I actually KNOW that recipe (else the inputs are useless to me). Always-live +
    // guarded. Raw producers have no inputs and buy none.
    const inputs = tradeInputs(a);
    if (inputs && inputs[c]) {
      if (a._trade && !(a.recipes && a.recipes.has(a._trade))) return 0;
      want = Math.max(0, 2 - Math.floor(a.inventory[c]));
    }
  }
  return want + speculativeWant(a, c);
}

// SPECULATION / HOARDING (item 2) — a wealthy, ambitious soul buys a glutted non-perishable good to
// HOLD, betting the tâtonnement lifts the price later. The glut signal is BELIEF-CLEAN: the agent's
// OWN price belief for the good (which the market drove DOWN toward the depressed clearing price) has
// fallen well below the good's base price — so it perceives the good as cheap right now. Gated on a
// wealth-driving ambition + spare gold, capped per good, so it stays rare. Returns the EXTRA units to
// bid beyond its consumption/production want. Pure buy demand; the buy itself (applyBuy) is conserved.
// Reads only own personality / ambition / gold / priceBeliefs / inventory — never the roster. Guarded.
function speculativeWant(a: Agent, c: string): number {
  try {
    if (c === 'food') return 0;                                  // food perishes — provisioned, never hoarded
    const P = a.personality || {};
    const driven = (a.ambition && a.ambition.kind === 'wealth') || (P.ambition ?? 0) >= (ECON.specAmbitionMin || 0.6);
    if (!driven) return 0;
    if ((a.gold || 0) < (ECON.specMinSpareGold || 30)) return 0;  // only with walking-around money to spare
    const base = BASE_PRICE_T[c]; if (!base) return 0;
    const belief = a.priceBeliefs[c] || base;
    if (belief >= base * (ECON.specBelowFrac || 0.75)) return 0;   // not a glut — its belief hasn't fallen enough
    const held = a.inventory[c] || 0;
    const cap = ECON.specMaxHold || 4;
    if (held >= cap) return 0;                                    // already holding my speculative fill
    return 1;                                                     // bid one more unit of the cheap good to hold
  } catch { return 0; }
}
// SPECULATIVE HOLD — the SELL half of item-2 speculation. speculativeWant buys a glutted
// non-perishable betting the price recovers; selling it back by the blind surplus rule would
// dump it at the SAME depressed price it was bought at (sell low — the opposite of the bet).
// So while the agent's OWN price belief for that good is still BELOW base (the glut hasn't
// lifted), it HOLDS the speculative stock back from the sell book — and RELEASES it once its
// belief recovers to base (the bet paid off; now it's worth selling). Belief-gated + conserved
// (this only defers the sale; gold still only transfers at clear time). Only the speculator's
// own held stock is held back — food (perishable) and non-speculators sell as before. Guarded.
function specHold(a: Agent, c: string): number {
  try {
    if (c === 'food') return 0;                                     // perishable — never a hold
    const P = a.personality || {};
    const driven = (a.ambition && a.ambition.kind === 'wealth') || (P.ambition ?? 0) >= (ECON.specAmbitionMin || 0.6);
    if (!driven) return 0;                                          // only speculators hold (symmetry with the buy side)
    const base = BASE_PRICE_T[c]; if (!base) return 0;
    const belief = a.priceBeliefs[c] || base;
    if (belief >= base * (ECON.specSellAtFrac ?? 1)) return 0;       // belief recovered ≥ base → release the hold, sell
    // still cheap → hold up to the speculative cap (above that, the excess is ordinary surplus to clear)
    return Math.min(a.inventory[c] || 0, ECON.specMaxHold || 4);
  } catch { return 0; }
}
export function sellQty(a: Agent, c: string): number {
  return Math.max(0, Math.floor(a.surplus(c)) - specHold(a, c));
}

// THE HAGGLE EDGE (the trade_edge ability op): while my OWN bargaining window is
// open (_haggleEdgeUntil, vs the per-frame sim-time stamp) I drive a harder bargain
// — ask a few percent MORE, bid a few percent LESS (ABILITY.haggleEdge; clamped to
// priceBounds). CLOSED MONEY LOOP by construction: the market still clears at the
// bid/ask MIDPOINT exchanged by BOTH parties (market.js), so the edge only shifts
// the price they agree on — never the amounts transferred. The risk is real too: a
// harder ask/bid can lose the match entirely. Own-state read only (belief-clean).
const haggling = (a: Agent): boolean => (a._haggleEdgeUntil || 0) > (a._simNow || 0);

export function askPrice(a: Agent, c: string): number {
  const p = a.priceBeliefs[c];
  return haggling(a) ? Math.min(ECON.priceBounds[1], +(p * (1 + (ABILITY.haggleEdge || 0))).toFixed(2)) : p;
}
export function bidPrice(a: Agent, c: string): number {
  let p = a.priceBeliefs[c];
  if (haggling(a)) p = Math.max(ECON.priceBounds[0], +(p * (1 - (ABILITY.haggleEdge || 0))).toFixed(2));
  return Math.min(p, a.gold);   // can't bid more than you hold
}

export function applyBuy(a: Agent, c: string, price: number): void {
  a.inventory[c] += 1; a.gold -= price; a.learnPrice(c, price, ECON.priceLearn); a._tradeFlash = 0.6;
  const belief = a.priceBeliefs[c] || price;
  const bargain = Math.max(0, (belief - price) / Math.max(1, belief));
  // damp the IDENTITY weight of a routine trade: every agent buys/sells constantly, so
  // at full weight the universal TRADE/HAGGLE tags swamp the profile and make everyone a
  // generic "merchant", drowning the production vocation. Scaled down, a soul's identity
  // is shaped by what it MAKES — only a DEDICATED trader (many deals) still reads as one.
  bus.emit(mkEvent({
    actorId: a.id, verb: 'buy', tags: ['TRADE', 'BARTER', 'HAGGLE'],
    magnitude: (1 + bargain) * ECON.tradeDeedWeight, t: a._rpgNow,
  }));
}
export function applySell(a: Agent, c: string, price: number): void {
  a.inventory[c] -= 1; a.gold += price; a.learnPrice(c, price, ECON.priceLearn); a._tradeFlash = 0.6;
  const belief = a.priceBeliefs[c] || price;
  const profit = Math.max(0, (price - belief) / Math.max(1, belief));
  bus.emit(mkEvent({
    actorId: a.id, verb: 'sell', tags: ['TRADE', 'PROFIT', 'HAGGLE'],
    magnitude: (1 + profit) * ECON.tradeDeedWeight, t: a._rpgNow,
  }));
}
