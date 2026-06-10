// FEATURE: the knowledge channels (docs/architecture/10 + 10-lld §6, §13). Registers the observe /
// ask / study verbs over the knowledge model, a learn-goal deriver (a crafter that lacks a recipe it
// wants forms a Know(recipe) goal), and their effect-landed predicates — all from THIS file as DATA
// rows. Gated by KNOW.enabled; off → registers nothing live, soak byte-stable.
//
// Each channel WRITES into the topic's HOME (a belief-table field for facts about others, own-state
// for a recipe), differing in cost / trust / side-effect: observe (first-hand, slow, trusted), ask
// (cheap, vaguer), study (taught — a recipe). Conserved-safe: knowledge writes touch no gold.
// NOTE (gap, see 10-lld §19): recipes are still a binary Set, and study's tuition is a PLANNING
// cost, not yet a literal conserved gold transfer to a teacher — both are follow-ups.

import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
import { goalLearn, knowsTopic, stepTargetPos } from '../planner.js';
import { KNOW, SIM, RECIPES } from '../simconfig.js';
import { POI_KIND } from '../world.js';
import { steer } from '../agent/steer.js';
import { goTo } from '../agent/movement.js';
import { learnRecipe, forgetTick } from '../recipeKnow.js';
import type { Agent, CognitionCtx, PlanStep, KnowTopic } from '../../../types/sim.js';

// Accrue `gain` confidence into a topic's HOME (own-state). The one place knowledge is WRITTEN.
function accrueTopic(a: Agent, topic: KnowTopic | undefined, gain: number, now: number): void {
  if (!topic || !a) return;
  switch (topic.kind) {
    case 'recipe':
      learnRecipe(a, topic.good, gain, 0, now);                      // graded conf (§6) ⇒ half-learned firms up; binary ⇒ Set.add
      break;
    case 'whereabouts': {
      const b = topic.subjectId != null && a.beliefs ? a.beliefs.get(topic.subjectId) : null;
      if (b) b.confidence = Math.min(1, (b.confidence || 0) + gain);
      break;
    }
    case 'loc': {
      const b = topic.subjectId != null && a.beliefs ? a.beliefs.get(topic.subjectId) : null;
      if (b) b.recordAssocSighting(topic.place || 'stash', b.lastPos, gain, 1);
      break;
    }
    case 'strength': {
      if (!a._strengthBelief) a._strengthBelief = new Map();
      const k = topic.place || '';
      const e = a._strengthBelief.get(k);
      a._strengthBelief.set(k, { value: e ? e.value : 1, conf: Math.min(1, (e ? e.conf : 0) + gain) });
      break;
    }
    case 'secret': {
      if (!a._secretBelief) a._secretBelief = new Map();
      const e = topic.subjectId != null ? a._secretBelief.get(topic.subjectId) : null;
      if (topic.subjectId != null) a._secretBelief.set(topic.subjectId, { conf: Math.min(1, (e ? e.conf : 0) + gain) });
      break;
    }
    default: break;   // price needs a market read; left to the market/gossip path
  }
}

// Where does first-hand watching of this topic happen? A subject topic → the subject's believed
// position; a recipe/strength/place topic → the relevant POI (workshop ≈ market for teaching).
function observePos(a: Agent, ctx: CognitionCtx, topic: KnowTopic | undefined) {
  if (!topic) return null;
  if (topic.subjectId != null) return stepTargetPos(a, ctx, { subjectId: topic.subjectId });
  return stepTargetPos(a, ctx, POI_KIND.MARKET);
}

// observe(topic): first-hand, slow, trusted. Walk to where the topic can be watched, then accrue
// confidence into its home each tick on station. No gold (conserved).
registerExecutor('observe', (a, step, dt, ctx) => {
  if (!KNOW.enabled) { a.fighter.setMoving(0); return; }
  const topic = (step.bind || {}).topic as KnowTopic | undefined;
  const tp = observePos(a, ctx, topic);
  if (tp && a.pos.distanceTo(tp) > (SIM.arriveDist || 1.5) + 0.5) { steer(a, { attractors: [{ pos: tp }] }, dt); return; }
  a.fighter.setMoving(0);
  accrueTopic(a, topic, (KNOW.observeGain || 0.18) * dt, ctx.time);
});

// ask(topic): cheap, vaguer, one-shot. You ask whoever is around; a single nudge to the home (it
// also tips the subject off — a richer side-effect left for later). No travel, no gold.
registerExecutor('ask', (a, step, _dt, ctx) => {
  if (!KNOW.enabled) { a.fighter.setMoving(0); return; }
  const topic = (step.bind || {}).topic as KnowTopic | undefined;
  accrueTopic(a, topic, KNOW.askGain || 0.3, ctx.time);
  a.fighter.setMoving(0);
});

// study(topic=recipe): taught instruction. Walk to where teaching happens (the market), then learn
// the recipe. With graded recipes (§6) the session pays TUITION to a co-located teacher (a conserved
// transfer, resolver.teachRecipe) and adds graded confidence — so a recipe takes a few taught
// sessions and there is no free lunch (no teacher present ⇒ no taught learning, the apprentice
// waits / re-plans). Off (binary) ⇒ one visit teaches it outright, exactly as before (byte-stable).
registerExecutor('study', (a, step, dt, ctx) => {
  if (!KNOW.enabled) { a.fighter.setMoving(0); return; }
  const topic = (step.bind || {}).topic as KnowTopic | undefined;
  const tp = stepTargetPos(a, ctx, POI_KIND.MARKET);
  if (tp && !goTo(a, tp, dt)) return;                                // still travelling to tuition
  a.fighter.setMoving(0);
  if (RECIPES.graded) {
    const good = topic && topic.kind === 'recipe' ? topic.good : null;
    if (good && ctx.resolver && ctx.resolver.teachRecipe && ctx.resolver.teachRecipe(a, good)) {
      learnRecipe(a, good, RECIPES.studyGain || 0.34, 0, ctx.time);  // taught + tuition paid ⇒ firm it up
    }
  } else {
    accrueTopic(a, topic, 1, ctx.time);                             // binary: one visit teaches it
  }
});

// effect-landed: the topic is now held confidently enough to act on (the executor wrote evidence).
const learned = (a: Agent, _ctx: CognitionCtx, step: PlanStep) => knowsTopic(a, (step.bind || {}).topic as KnowTopic);
registerEffectHolds('observe', learned);
registerEffectHolds('ask', learned);
registerEffectHolds('study', learned);

// THE LIVE DERIVER (own-state only): a crafter that wants to make a recipe-gated good it does NOT
// know forms a Know(recipe) goal. Dormant unless recipes are actually withheld (RECIPES gate);
// correct + unit-tested regardless. Bounded by pushGoal dedup.
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!KNOW.enabled) return;
  if (!a || !a.alive || a.controlled || a.faction === 'monster') return;
  const good = a._trade;
  if (!good || !a.recipes || a.recipes.has(good)) return;            // nothing to learn
  const g = goalLearn({ kind: 'recipe', good });
  g.priority = 0.45; g.from = 'apprentice';
  g.expiresAt = (ctx ? ctx.time : 0) + 160;
  a.pushGoal(g, ctx);
});

// THE FORGET PASS (graded recipes, §6) — a per-cognition-tick maintenance hook (registered as a
// deriver, the feature's per-agent tick, like the ledger settle): keep the agent's PRACTISED craft
// sharp and let every OTHER recipe fade (use-it-or-lose-it), dropping a faded one out of the
// craftable Set. Own-state only; gated by RECIPES.graded (off ⇒ no-op, byte-stable).
registerDeriver((a: Agent, ctx: CognitionCtx | null) => {
  if (!KNOW.enabled || !RECIPES.graded || !a || !a.alive) return;
  forgetTick(a, ctx ? ctx.time : 0, a._trade);
});

export {};
