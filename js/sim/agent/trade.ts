// Agent trade interface — the economic Theory-of-Mind surface, extracted from
// Agent as free functions over a passed agent instance (the data-and-functions
// split). These define how an agent values, wants, asks/bids, and settles goods
// against the town-wide market (js/sim/market.js) and adjust its PRICE BELIEFS
// from realised trades and chatting neighbours (gossip). Behaviour-preserving:
// verbatim bodies of the old Agent methods. No cycles — imports config + the
// rpg event bus only.

import { GOODS, COMMODITIES, ECON, WEALTH } from '../simconfig.js';
import { bus, makeEvent } from '../../rpg/events.js';
import type { Agent, CognitionCtx, ActionEventSpec, ActionEvent } from '../../../types/sim.js';

// events.js infers makeEvent's `tags=[]` default as never[]; retype it to its real spec.
const mkEvent = makeEvent as (spec: ActionEventSpec) => ActionEvent;

// Re-typed config views (simconfig.js is inferred without index signatures under allowJs).
const GOODS_T = GOODS as Record<string, { inputs: Record<string, number> | null }>;
const ECON_KEEP = ECON.keep as Record<string, number>;
const WEALTH_RATIO = (WEALTH.stashRatio || {}) as Record<string, number>;

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
  if (c === 'food') return Math.max(0, ECON.keep.food - Math.floor(a.inventory.food));
  if (c === 'tool') return a.inventory.tool < 1 ? 1 : 0;
  if (c === 'potion') return a.inventory.potion < 1 ? 1 : 0;  // everyone keeps a remedy
  // buy the recipe inputs for the good I'm currently crafting (tool: wood+ore;
  // potion: herb) — but only if I actually KNOW that recipe (else the inputs are
  // useless to me). Always-live + guarded. Raw producers have no inputs and buy none.
  const inputs = tradeInputs(a);
  if (inputs && inputs[c]) {
    if (a._trade && !(a.recipes && a.recipes.has(a._trade))) return 0;
    return Math.max(0, 2 - Math.floor(a.inventory[c]));
  }
  return 0;
}
export function sellQty(a: Agent, c: string): number { return Math.max(0, Math.floor(a.surplus(c))); }
export function askPrice(a: Agent, c: string): number { return a.priceBeliefs[c]; }
export function bidPrice(a: Agent, c: string): number { return Math.min(a.priceBeliefs[c], a.gold); }   // can't bid more than you hold

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
