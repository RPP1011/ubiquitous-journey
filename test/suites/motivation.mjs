// ---- the motivation registry (docs/architecture/17 §3) ----------------------------------------
// P1 foundation: the MOTIVATIONS data substrate that keeps motivations-as-data (mirrors the exec
// registry). Exercised in ISOLATION here — register toy rows under test-only primitive keys, assert
// motivesFor filters by primitive, registration is guarded + idempotent, and motiveByKey resolves.
// (Later phases add: arbitration determinism, inference correctness, the deception gates.)
import {
  registerMotive, allMotives, motivesFor, motiveByKey,
} from '../../js/sim/motivation/registry.js';

export function motivationTest(ok) {
  // toy rows — test-only primitive keys so they never collide with the live motive set.
  const mk = (key, primitive, serves = 'reflex') => ({
    key, primitive, serves,
    eligible: () => true, score: () => 1, bind: () => ({}),
  });
  const avenge = mk('test-avenge', 'test-strike', 'goal');
  const defend = mk('test-defend', 'test-strike', 'reflex');
  const warn = mk('test-warn', 'test-say', 'goal');
  const before = allMotives().length;
  registerMotive(avenge); registerMotive(defend); registerMotive(warn);

  // M1 — motivesFor returns exactly the rows that drive that primitive.
  const strikes = motivesFor('test-strike');
  ok(strikes.length === 2 && strikes.includes(avenge) && strikes.includes(defend),
    `M1: motivesFor('test-strike') returns both strike motives (got ${strikes.length})`);

  // M2 — it filters by primitive (a different primitive yields its own rows only).
  ok(motivesFor('test-say').length === 1 && motivesFor('test-say')[0] === warn,
    'M2: motivesFor filters by primitive (one say motive)');

  // M3 — an unknown primitive yields the empty set, never throws.
  ok(motivesFor('test-nonexistent').length === 0, 'M3: unknown primitive → empty set (no throw)');

  // M4 — registration is idempotent: re-registering the same row adds no duplicate.
  registerMotive(avenge);
  ok(motivesFor('test-strike').length === 2, 'M4: re-registering the same motive is idempotent');

  // M5 — a bad arg is a guarded no-op (never throws, never grows the table).
  const n = allMotives().length;
  registerMotive(null); registerMotive({}); registerMotive({ key: 'x', primitive: 'y' /* no score */ });
  ok(allMotives().length === n, 'M5: registering a bad motive is a guarded no-op');

  // M6 — motiveByKey resolves the unique key (the inference write-back path), undefined when absent.
  ok(motiveByKey('test-warn') === warn && motiveByKey('test-absent') === undefined,
    'M6: motiveByKey resolves a key and returns undefined for an unknown one');

  // M7 — exactly the three toy rows were added (no leakage, no double-count).
  ok(allMotives().length === before + 3, `M7: exactly 3 toy motives registered (Δ=${allMotives().length - before})`);
}
