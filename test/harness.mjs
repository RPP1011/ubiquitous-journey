// Shared test harness — the tiny pass/fail tally plus the sim/fighter builders
// that every headless suite leans on. Extracted verbatim from headless.mjs so the
// per-domain suites in test/suites/*.mjs can import one copy instead of each
// re-declaring it. No behavior change: same `ok`, same stubScene, same makeFighter.

import { HeadlessFighter } from '../js/headlessFighter.js';

// A pass/fail tally. `makeOk()` returns { ok, failures } where `ok(cond,msg)`
// logs PASS/FAIL and bumps the counter; the runner reads `.count` at the end.
export function makeOk() {
  const state = { count: 0 };
  const ok = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!cond) state.count++;
  };
  return { ok, failures: state };
}

// A no-op Three.Scene stand-in: the sim only ever calls add()/remove() on it.
export const stubScene = { add() {}, remove() {} };

// The headless fighter factory the Simulation is constructed with.
export const makeFighter = (model, o) => new HeadlessFighter(model, o);
