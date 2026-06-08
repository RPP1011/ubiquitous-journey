// Sim-wide economics telemetry: a per-world ledger of EVERY market trade and the
// belief surface around it. Populated by Simulation._runMarket on each clear;
// reset per world (mirror of js/rpg/xpstats.js). Pure aggregation — it never
// influences behaviour, so it's safe on the fixed tick. Every entry point is
// guarded and never throws.
//
// Per commodity we keep bounded aggregates:
//   - trade count + cumulative volume (gold turned over)
//   - clearing price: a short ring (recent mean) + the last clear
//   - believed price ACROSS the two counterparties at clear time (mean + spread)
//   - belief impact: gap between mean belief and the realised clearing price
//   - believed scarcity: mean believed price / BASE_PRICE (1 == "normal")
// plus a bounded ring of the most-recent trades for a live feed.

import { BASE_PRICE, COMMODITIES } from './simconfig.js';
import type { Commodity, Trade, EntityId } from '../../types/sim.js';

const CLEAR_RING = 24;     // recent clearing prices kept per commodity (for the avg)
const FEED_RING = 14;      // recent trades kept globally for the feed

// per-commodity running aggregate record (bounded).
interface CommodityRecord {
  commodity: string;
  n: number;             // trade count
  volume: number;        // cumulative gold turned over (price summed)
  lastPrice: number;     // most recent clearing price
  clears: number[];      // ring of recent clearing prices (bounded CLEAR_RING)
  beliefSum: number;     // running sum of per-trade mean belief (seller+buyer)/2
  beliefSumSq: number;   // running sum of squares (for dispersion across trades)
  beliefN: number;       // count of belief samples (== n, kept explicit/guarded)
  lastBeliefMean: number;// last trade's mean belief
  lastBeliefSpread: number; // last trade's |seller-buyer| belief gap
}

// one entry in the recent-trades live feed.
interface FeedEntry {
  t: number;
  commodity: string;
  price: number;
  sellerId?: EntityId;
  buyerId?: EntityId;
  beliefMean: number;
}

// per-commodity aggregate record
function blank(c: string): CommodityRecord {
  return {
    commodity: c,
    n: 0,
    volume: 0,
    lastPrice: 0,
    clears: [],
    beliefSum: 0,
    beliefSumSq: 0,
    beliefN: 0,
    lastBeliefMean: 0,
    lastBeliefSpread: 0,
  };
}

const _byCommodity = new Map<string, CommodityRecord>();
const _feed: FeedEntry[] = [];  // bounded ring of recent { t, commodity, price, ... }
let _totalTrades = 0;
let _totalVolume = 0;

function _rec(c: string): CommodityRecord {
  let r = _byCommodity.get(c);
  if (!r) { r = blank(c); _byCommodity.set(c, r); }
  return r;
}

export function resetEconStats() {
  _byCommodity.clear();
  _feed.length = 0;
  _totalTrades = 0;
  _totalVolume = 0;
}

// Record one cleared trade. Guarded: bad/missing fields degrade to neutral
// values, never throw. `commodity` + `price` are the load-bearing fields; the
// beliefs are optional (default to the clearing price if absent).
export function recordTrade(trade: Trade | null | undefined): void {
  try {
    if (!trade) return;
    const c = trade.commodity;
    if (!c) return;
    const price = +trade.price || 0;
    const sBel = typeof trade.sellerBelief === 'number' && Number.isFinite(trade.sellerBelief) ? trade.sellerBelief : price;
    const bBel = typeof trade.buyerBelief === 'number' && Number.isFinite(trade.buyerBelief) ? trade.buyerBelief : price;
    const beliefMean = (sBel + bBel) / 2;
    const spread = Math.abs(sBel - bBel);

    const r = _rec(c);
    r.n += 1;
    r.volume += price;
    r.lastPrice = price;
    r.clears.push(price);
    if (r.clears.length > CLEAR_RING) r.clears.shift();
    r.beliefSum += beliefMean;
    r.beliefSumSq += beliefMean * beliefMean;
    r.beliefN += 1;
    r.lastBeliefMean = beliefMean;
    r.lastBeliefSpread = spread;

    _totalTrades += 1;
    _totalVolume += price;

    _feed.push({
      t: +trade.t || 0, commodity: c, price,
      sellerId: trade.sellerId, buyerId: trade.buyerId,
      beliefMean: +beliefMean.toFixed(2),
    });
    if (_feed.length > FEED_RING) _feed.shift();
  } catch { /* never throw on the tick */ }
}

// Derived view for one commodity: clearing (recent avg + last) vs base, volume,
// believed mean ± spread (dispersion across recent trades), belief-vs-clearing
// gap (impact) and a believed-scarcity ratio. Returns null until it has data.
export function commodityStats(c: string) {
  const r = _byCommodity.get(c);
  if (!r || r.n === 0) return null;
  const base = BASE_PRICE[c as keyof typeof BASE_PRICE] || 0;
  const clearAvg = r.clears.length
    ? r.clears.reduce((s, p) => s + p, 0) / r.clears.length : r.lastPrice;
  const beliefMean = r.beliefN ? r.beliefSum / r.beliefN : r.lastBeliefMean;
  // dispersion of the per-trade mean beliefs (std dev), a proxy for disagreement
  const variance = r.beliefN > 1
    ? Math.max(0, r.beliefSumSq / r.beliefN - beliefMean * beliefMean) : 0;
  const beliefSpread = Math.sqrt(variance);
  return {
    commodity: c,
    base,
    n: r.n,
    volume: r.volume,
    clearLast: r.lastPrice,
    clearAvg,
    // up/down vs base: +1 dearer, -1 cheaper, 0 ~at base
    trend: base ? (clearAvg > base * 1.05 ? 1 : clearAvg < base * 0.95 ? -1 : 0) : 0,
    beliefMean,
    beliefSpread,                            // disagreement across recent trades
    lastSpread: r.lastBeliefSpread,          // last counterparties' belief gap
    // belief impact: how far the crowd's belief sits from the realised price
    beliefGap: beliefMean - clearAvg,
    // believed scarcity: mean belief relative to the good's base price (1==normal)
    scarcity: base ? beliefMean / base : 1,
  };
}

// All commodities that have any aggregate data, in COMMODITIES order.
export function allCommodityStats() {
  const out = [];
  for (const c of COMMODITIES) {
    const s = commodityStats(c);
    if (s) out.push(s);
  }
  return out;
}

// Recent-trades feed (newest last), a shallow copy so callers can't mutate it.
export function recentTrades(n = FEED_RING) {
  const k = Math.max(0, Math.min(n, _feed.length));
  return _feed.slice(_feed.length - k);
}

export function econTotals() {
  return { trades: _totalTrades, volume: _totalVolume, commodities: _byCommodity.size };
}

// How many distinct commodities have recorded at least one trade.
export function tradedCommodityCount() {
  let n = 0;
  for (const r of _byCommodity.values()) if (r.n > 0) n++;
  return n;
}
