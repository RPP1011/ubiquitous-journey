// FEATURE: the Affect rows — rob / free / wreck (docs/architecture/10 execution). Registers those
// verbs, their goal-derivers, and effect-landed predicates — all from THIS file as DATA rows.
// Gated by ROB.enabled (rob) and AFFECT.enabled (free/wreck); off → nothing live, soak byte-stable.
// Reuses the seam's GENERIC resolver mechanics: `take` (conserved value move), `witnessDeed` (the
// emergent souring — per-perceiver, witness-gated), `affect` (physical-state change freed/wrecked).
//
// TODO(worktree affect): implement here, using:
//   import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
//   import { goalFree, goalWreck } from '../planner.js';
//   - rob(mark): approach; on reach, ctx.resolver.take(a, markId, { gold: believedHaul }) then
//     ctx.resolver.witnessDeed(a, markId, 'robbery') — the reaction EMERGES, don't hardcode it.
//   - free(captive): approach; on reach, ctx.resolver.affect(a, captiveId, 'freed') — the freed
//     captive's gratitude EMERGES from it perceiving _freedBy, not a baked-in response.
//   - wreck(target): approach; on reach, ctx.resolver.affect(a, targetId, 'wrecked')
//   - derivers (as the breadth needs): e.g. a rescuer who believes a friend is held pushes goalFree
//   - effect-holds: rob → gold raised; free → captive believed freed; wreck → target believed wrecked
//   Keep DERIVERS belief-only (epistemic split); EXECUTORS may read truth (act layer).
export {};
