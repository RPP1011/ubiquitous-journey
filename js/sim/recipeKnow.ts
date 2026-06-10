// GRADED RECIPE KNOWLEDGE (docs/architecture/10-lld §6, §19 gap #1). The recipe lifecycle in one
// place: read / accrue / decay-and-forget, plus keeping the binary `a.recipes` Set (the view the
// produce / trade / occupation gates read) in sync with the graded confidence.
//
// MODEL: `a.recipes` (Set<good>) stays the "confidently known ⇒ craftable" view; `a._recipeKnow`
// (Map<good,{conf,hops,t}>) is the graded backing — the belief table's value/confidence/provenance/
// last-updated, applied to OWN craft knowledge. A recipe is in the Set iff its graded conf is at or
// above RECIPES.craftMinConf, so a HALF-LEARNED recipe (below that) sits in the map, known-of but not
// yet craftable, until more study/watching firms it; and one that decays below the bar is dropped
// from the Set — FORGOTTEN (a craft that no living holder practises eventually dies out of a town).
//
// ALWAYS-LIVE on the mainline: recipe knowledge is graded everywhere. Own-state only
// (cognition-safe); guarded; never throws on the tick.

import { RECIPES } from './simconfig.js';
import type { Agent } from '../../types/sim.js';

// keep the craftable Set in sync with the graded confidence for one good.
function syncSet(a: Agent, good: string, conf: number): void {
  if (!a.recipes) return;
  if (conf >= (RECIPES.craftMinConf ?? 0.45)) a.recipes.add(good);
  else a.recipes.delete(good);
}

// believed confidence in a recipe (0..1): the graded map (with a 1.0 fallback for a recipe that
// is in the seeded Set but not yet mirrored into the map).
export function recipeConf(a: Agent, good: string | null | undefined): number {
  if (!a || !good) return 0;
  const e = a._recipeKnow ? a._recipeKnow.get(good) : null;
  if (e) return e.conf || 0;
  return a.recipes && a.recipes.has(good) ? 1 : 0;   // seeded-but-not-mirrored ⇒ treat as fully known
}

// accrue `gain` confidence into a recipe (a study session / a stretch of watching a crafter). `hops`
// is the provenance of the channel (0 = taught/first-hand, higher = vaguer).
export function learnRecipe(a: Agent, good: string | null | undefined, gain: number, hops: number, now: number): void {
  if (!a || !good) return;
  if (!a._recipeKnow) a._recipeKnow = new Map();
  const e = a._recipeKnow.get(good);
  const conf = Math.min(1, (e ? e.conf : 0) + Math.max(0, gain || 0));
  a._recipeKnow.set(good, { conf, hops: e ? Math.min(e.hops, hops) : hops, t: now });
  syncSet(a, good, conf);
}

// per-cognition-tick maintenance: lazy-seed the map from a producer's seeded Set, keep the agent's
// PRACTISED craft (`tradeGood`) fresh (a working master never forgets its own trade), and FORGET
// every other recipe a little — the use-it-or-lose-it fade. Sub-threshold goods drop out of the
// craftable Set; fully-faded ones are pruned. Own-state; bounded by the recipe set.
export function forgetTick(a: Agent, now: number, tradeGood: string | null | undefined): void {
  if (!a || !a.recipes) return;
  if (!a._recipeKnow) a._recipeKnow = new Map();
  // lazy-seed: a producer born knowing recipes (Set populated, map empty) starts each at full conf.
  if (a._recipeKnow.size === 0 && a.recipes.size > 0) {
    for (const g of a.recipes) a._recipeKnow.set(g, { conf: 1, hops: 0, t: now });
  }
  const decay = RECIPES.forgetPerTick ?? 0;
  for (const [good, e] of a._recipeKnow) {
    if (good === tradeGood) { e.conf = 1; e.t = now; a.recipes.add(good); continue; }  // practised ⇒ stays sharp
    e.conf = Math.max(0, e.conf - decay);
    if (e.conf <= 0) { a._recipeKnow.delete(good); a.recipes.delete(good); continue; }
    syncSet(a, good, e.conf);
  }
}
