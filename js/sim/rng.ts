// SEEDABLE PRNG — the sim's single stochastic tap.
//
// Why a module singleton (not ctx injection): nearly a hundred stochastic call sites are
// scattered across ~35 files (agent acts, steer wander, director rolls, world gen, lineage,
// faith, intrigue, quests, …). Threading an `rng` instance through every ctx/constructor would
// be a vast, destabilising diff. Instead this module owns ONE shared stream that every site taps
// via `rng()` — the same shape the old per-file `rand = () => Math.random()` helpers already had.
//
// Byte-unchanged-when-unseeded is load-bearing (the unseeded soak gate must not move): while no
// seed is set, `rng()` falls straight through to the platform `Math.random()` — the SAME source
// the sim called everywhere before — so an unseeded world emits the identical byte stream.
//
// `setSeed(n)` swaps the tap to a deterministic mulberry32 stream (fast, portable, 32 bits of
// state — ample for a game sim). Two runs with the same seed + same code path draw the identical
// sequence, so they reproduce as far as the routed sites reach. `setSeed(undefined)` (or never
// calling it) restores the platform source. Seed 0 is a real seed (we test `seed === undefined`,
// not falsiness), so `setSeed(0)` is deterministic.
//
// CAVEAT (honest): reproducibility only holds for sites actually routed through `rng()`. Anything
// still calling `Math.random()` directly, plus draw-ORDER differences (LOD amortisation, agent
// roster mutation, Map iteration), can still diverge. See routed/residual notes in the build report.

// mulberry32 — a single-multiply-mix 32-bit generator. Tiny state, well-distributed, deterministic.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The active stream. `null` = unseeded ⇒ fall through to the platform Math.random (byte-identical).
let _stream: (() => number) | null = null;
let _seed: number | undefined = undefined;

// The single tap. Mirrors Math.random()'s contract: a float in [0, 1).
export function rng(): number {
  return _stream === null ? Math.random() : _stream();
}

// Arm (or, with undefined, disarm) the deterministic stream. Seed is coerced to uint32.
export function setSeed(seed?: number): void {
  _seed = seed;
  _stream = seed === undefined ? null : mulberry32(seed >>> 0);
}

// The seed currently armed (undefined ⇒ unseeded / platform random).
export function getSeed(): number | undefined {
  return _seed;
}
