// FEATURE: the Affect rows — rob / free / wreck (docs/architecture/10 execution). Registers those
// verbs, their goal-derivers, and effect-landed predicates — all from THIS file as DATA rows.
// Gated by ROB.enabled (rob) and AFFECT.enabled (free/wreck); off → nothing live, soak byte-stable.
// Reuses the seam's resolver: `pilfer` (rob — conserved theft by force), `cutBonds` (free a
// captive), `sabotage` (wreck a target).
//
// TODO(worktree affect): implement here, using:
//   import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
//   import { goalFree, goalWreck } from '../planner.js';
//   - rob(mark): approach the believed mark; on reach, ctx.resolver.pilfer(a, markId, believedHaul)
//   - free(captive): approach; on reach, ctx.resolver.cutBonds(a, captiveId)
//   - wreck(target): approach; on reach, ctx.resolver.sabotage(a, targetId)
//   - derivers (as the breadth needs): e.g. a rescuer who believes a friend is held pushes goalFree
//   - effect-holds: rob → gold raised; free → captive believed freed; wreck → target believed wrecked
//   Keep DERIVERS belief-only (epistemic split); EXECUTORS may read truth (act layer).
export {};
