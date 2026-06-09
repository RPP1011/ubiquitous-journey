// FEATURE: the knowledge channels & recipe-learning lifecycle (docs/architecture/10 execution).
// Registers observe / ask / study verbs, a learn-goal deriver (a crafter that lacks a recipe it
// wants forms a Know(recipe) goal), and their effect-landed predicates — all from THIS file as
// DATA rows. Gated by KNOW.enabled; off → registers nothing live, soak byte-stable. Conserved-safe
// (recipes are a Set; study pays tuition through the market resolver — no minting).
//
// TODO(worktree learning): implement here, using:
//   import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
//   import { goalLearn } from '../planner.js';
//   - observe(topic): watch first-hand; accrue evidence into the topic's home (recipe/whereabouts)
//   - ask(topic): be told by a nearby agent who holds it (gossip-style, lower confidence)
//   - study(topic): at a teacher/market, pay tuition (resolver), add the recipe to a.recipes
//   - deriver: a producer wanting a good whose recipe it lacks pushes goalLearn({kind:'recipe',good})
//   - effect-holds: observe/ask/study → knowsTopic(a, topic)
//   Keep the DERIVER belief/own-state only (epistemic split).
export {};
