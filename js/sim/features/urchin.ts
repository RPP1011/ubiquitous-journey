// FEATURE: the urchin heist (docs/architecture/10 execution — the flagship). Registers this
// feature's verbs (surveil / approach / burgle), its goal-deriver (a poor, low-standing agent
// forms a steal goal against a believed-prosperous mark), and its effect-landed predicates — ALL
// from THIS file, as DATA rows into the registries (verbs-are-data), so it stays disjoint from
// every other feature. Gated by URCHIN.enabled; off → registers nothing live and the soak is
// byte-stable. Reuses the seam's conserved `pilfer` transfer for the take, and the wealth-cue on
// the belief for picking a mark.
//
// TODO(worktree urchin): implement here, using:
//   import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
//   import { goalSteal } from '../planner.js';
//   - surveil: walk toward the believed mark at standoff; belief.recordAssocSighting('stash', …)
//   - approach: steer to the believed assoc (stash) pos
//   - burgle: when at the stash, ctx.resolver.pilfer(a, markId, believedHaul)
//   - deriver: a poor/despised agent with a believed-rich mark pushes goalSteal(markId, target)
//   - effect-holds: surveil → knows the stash; burgle → gold raised
//   Keep the DERIVER belief-only (epistemic split); the EXECUTORS may read truth (act layer).
export {};
