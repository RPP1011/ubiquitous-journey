// FEATURE: newsread — NEWS MOVES PRICES. A townsperson standing near a market who "reads the
// paper" shifts its OWN price belief for a reported staple toward the Gazette's PRINTED median.
// So a published "ore runs short in Eastmarket" makes the local sellers there raise their asks
// before a hauler ever arrives — information itself becomes a price signal, not just realised trade.
//
// EPISTEMIC SPLIT: this reads the PUBLISHED Gazette (an OBSERVER-written artifact — the same kind of
// sanctioned source as overhearing a neighbour's belief in the gossip bridge) and writes the agent's
// OWN priceBeliefs. It never reads the roster to decide; the paper is already in the world. The
// Gazette desk wrote truth to PRINT the paper; the agent reads only the printed median (its content),
// exactly the shape of an overheard rumour — LOW confidence, capped, decaying as the article ages.
//
// MINTS NOTHING: only a belief moves. The market still clears at the mutually-agreed midpoint of two
// beliefs and gold only transfers — so this nudges who is willing to deal at what price, not the money.
//
// Registered as a DERIVER (runs each cognition tick per agent); it derives no GOAL, it just folds the
// printed median into belief — like subsistence/signalsFold, a belief-tick pass that happens to add no
// goal. Guarded throughout; never throws on the tick (the freeze lesson).

import { registerDeriver } from '../exec/registry.js';
import { ECON, COMMODITIES } from '../simconfig.js';
import type { Agent, CognitionCtx } from '../../../types/sim.js';

// A published market article, as the Gazette files it (gatherDispatches → brief). Untyped extra fields
// on StoryBrief ([k:string]:unknown), read defensively.
interface MarketBrief { kind?: string; good?: string; med?: number; originTown?: number | null; t?: number }

registerDeriver((a: Agent, ctx: CognitionCtx | null): void => {
  if (!a || a.controlled || !a.autonomous || a.inParty) return;
  if (!a.townsperson || a.faction === 'monster') return;
  if (!a.priceBeliefs) return;
  if (!ctx || !ctx.world || !ctx.world.nearest) return;

  // Only a reader physically AT a market reads its paper (the news is posted there). Same logistics
  // gate the market clearing uses (ECON.marketRange of a MARKET POI) — distant folk don't get it.
  const mkt = ctx.world.nearest('market', a.pos);
  if (!mkt) return;
  const mr = (ECON.marketRange || 18);
  if (a.pos.distanceToSquared(mkt.pos) > mr * mr) return;

  // The published paper is an observer artifact reached via the agent's opaque sim back-ref (the same
  // handle movement.ts reads for the city grid). Reading the PRINTED median ≈ overhearing a rumour.
  const sim = a.sim as { gazette?: { recent?(n?: number): MarketBrief[] | { brief: MarketBrief; t?: number }[] } } | undefined;
  const gz = sim && sim.gazette;
  if (!gz || !gz.recent) return;
  let arts: { brief?: MarketBrief; t?: number }[];
  try { arts = (gz.recent(20) as { brief?: MarketBrief; t?: number }[]) || []; } catch { return; }
  if (!arts.length) return;

  const now = ctx.time;
  const maxAge = (ECON.newsReadMaxAge != null ? ECON.newsReadMaxAge : 90);
  const rate = (ECON.newsReadRate != null ? ECON.newsReadRate : 0.05);
  const cap = (ECON.newsReadStep != null ? ECON.newsReadStep : 0.5);
  const [lo, hi] = (ECON.priceBounds || [1, 40]);

  for (const art of arts) {
    const b = art && art.brief;
    if (!b || b.kind !== 'market') continue;
    const good = b.good;
    if (!good || !COMMODITIES.includes(good)) continue;
    const med = b.med;
    if (typeof med !== 'number' || !isFinite(med)) continue;
    // local news only: a market story for THIS reader's town (the printed median reflects supply here).
    if (b.originTown != null && a.townId != null && b.originTown !== a.townId) continue;
    // freshness: stale paper carries no signal; older articles nudge less (linear age fade).
    const age = now - (typeof b.t === 'number' ? b.t : (art.t || now));
    if (age < 0 || age > maxAge) continue;
    const fresh = 1 - age / maxAge;                 // 1 fresh → 0 stale

    const cur = a.priceBeliefs[good];
    if (typeof cur !== 'number') continue;
    let delta = (med - cur) * rate * fresh;         // close part of the gap toward the printed median
    if (delta > cap) delta = cap; else if (delta < -cap) delta = -cap;   // a nudge, never a whipsaw
    let next = cur + delta;
    if (next < lo) next = lo; else if (next > hi) next = hi;             // keep within sane price bounds
    a.priceBeliefs[good] = next;
  }
});

export {};
