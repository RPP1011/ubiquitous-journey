// ---- the motivation registry (docs/architecture/17 §3) ----------------------------------------
// P1 foundation: the MOTIVATIONS data substrate that keeps motivations-as-data (mirrors the exec
// registry). Exercised in ISOLATION here — register toy rows under test-only primitive keys, assert
// motivesFor filters by primitive, registration is guarded + idempotent, and motiveByKey resolves.
// (Later phases add: arbitration determinism, inference correctness, the deception gates.)
import {
  registerMotive, allMotives, motivesFor, motiveByKey,
} from '../../js/sim/motivation/registry.js';
import { setShadow, shadowStats } from '../../js/sim/motivation/arbitrate.js';
import { deedsProcessed, resetDeedStats } from '../../js/sim/motivation/infer.js';
import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { resolveCombat } from '../../js/combat.js';

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

// ---- the SHADOW check (docs/architecture/17 P1) -------------------------------------------------
// Drive a full town with the row-based arbiter (arbitrate) running ALONGSIDE the live scoreAndSelect,
// and assert the chosen `kind` matches tick-for-tick within ε. This is the gate that must be green
// BEFORE the swap: the rows reproduce decide()'s scorer behaviour-equivalently. The shadow never
// drives the sim, so the soak's own invariants (above) prove the live path is unchanged.
export async function motivationShadowTest(ok, { makeFighter, stubScene }) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  sim.spawn();
  const pf = makeFighter('knight', { isPlayer: true });
  pf.root.position.set(0, 0, 8);
  sim.addPlayer(pf);
  await Promise.all([
    import('../../js/rpg/abilities/catalog.js').catch(() => {}),
    import('../../js/rpg/abilities/generate.js').catch(() => {}),
  ]);
  for (let k = 0; k < 5; k++) await Promise.resolve();

  setShadow(true);
  resetDeedStats();
  const FRAMES = 8000, dt = 1 / 60;
  let stage = 'init';
  try {
    for (let i = 0; i < FRAMES; i++) {
      stage = 'sim.update'; sim.update(dt);
      for (const f of sim.fighters) f.update(dt);
      const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
      if (ev.length) sim.onCombatEvents(ev);
    }
  } catch (err) {
    setShadow(false);
    ok(false, `shadow: drove the sim threw at '${stage}' -> ${err && err.message}`);
    return;
  }
  const st = shadowStats();
  setShadow(false);

  // S1 — the shadow actually ran (decisions were scored).
  ok(st.total > 1000, `S1: shadow observed real decision traffic (${st.total} comparisons)`);
  // S2 — the row arbiter reproduces scoreAndSelect's chosen kind within ε. Target ε = 0 (identical
  // logic over a shared scratch); a tiny tolerance guards float/ordering edge cases.
  const EPS = 0.001;
  ok(st.rate <= EPS,
    `S2: arbitrate matches scoreAndSelect tick-for-tick (diverge ${st.diverge}/${st.total} = ${(st.rate * 100).toFixed(3)}% ≤ ${(EPS * 100).toFixed(1)}%)`);
  // S3/S4 — P2: every deciding agent carries the committed (primitive, motivation) pair, and the
  // primitive matches its motive kind (the un-fusing — docs/architecture/17 §1).
  const withMotive = sim.agents.filter((a) => !a.controlled && a.motive && typeof a.motive.primitive === 'string');
  ok(withMotive.length > 0, `S3: agents carry a committed (primitive,motivation) pair (${withMotive.length})`);
  const PRIM = { wander: 'locomote', work: 'produce', eat: 'consume', fight: 'strike', flee: 'locomote', comfort: 'locomote' };
  const mismatches = withMotive.filter((a) => PRIM[a.motive.key] && a.motive.primitive !== PRIM[a.motive.key]);
  ok(mismatches.length === 0,
    `S4: committed primitive matches the motive kind (${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'})`);

  // S5 — P3: the deed path is LIVE — witnessed theft-shaped deeds reached the inbox and were drained
  // through onWitnessPrimitive (proves emit→publishDeed→inbox→perceive-drain→handler, not silently dead).
  ok(deedsProcessed() > 0, `S5: witnessed deeds flowed through the inference path (${deedsProcessed()} processed)`);

  if (st.diverge > 0) {
    const tally = {};
    for (const s of st.samples) { const k = `${s.live}→${s.oracle}`; tally[k] = (tally[k] || 0) + 1; }
    console.log(`INFO  shadow divergences (live arbiter→oracle): ${Object.entries(tally).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  } else {
    console.log(`INFO  shadow: ${st.total} decisions, ZERO divergence — live arbitrate ≡ oracle scoreAndSelect`);
  }
}
