// ---- the motivation registry (docs/architecture/17 §3) ----------------------------------------
// P1 foundation: the MOTIVATIONS data substrate that keeps motivations-as-data (mirrors the exec
// registry). Exercised in ISOLATION here — register toy rows under test-only primitive keys, assert
// motivesFor filters by primitive, registration is guarded + idempotent, and motiveByKey resolves.
// (Later phases add: arbitration determinism, inference correctness, the deception gates.)
import {
  registerMotive, allMotives, motivesFor, motiveByKey,
} from '../../js/sim/motivation/registry.js';
import { setShadow, shadowStats } from '../../js/sim/motivation/arbitrate.js';
import { deedsProcessed, resetDeedStats, inferMotive } from '../../js/sim/motivation/infer.js';
import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { resolveCombat } from '../../js/combat.js';
import { FeatureStage } from './_stage.mjs';

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

// ---- ToM motive INFERENCE (docs/architecture/17 §7 / P4) ----------------------------------------
// The marquee demo: one identical robbery deed, read by two different witnesses, yields two different
// attributed motives — purely from their own priors (the per-witness divergence the whole design is for).
export function motivationInferenceTest(ok) {
  // I1 — the `take` primitive has its inference candidates registered (theft/robbery/justice).
  const takeMotives = motivesFor('take').map((m) => m.key);
  ok(['theft', 'robbery', 'justice'].every((k) => takeMotives.includes(k)),
    `I1: take-primitive inference motives registered (${takeMotives.join(', ')})`);

  // a minimal observer stub: personality + gold + a tiny belief table (get/set), no full Agent needed.
  const mkObs = (personality, gold, beliefs = {}) => ({
    id: 99, personality, gold,
    beliefs: { _m: new Map(Object.entries(beliefs).map(([k, v]) => [Number(k), v])),
      get(id) { return this._m.get(id); } },
  });
  // a robbery of subject #2 by actor #1, witnessed.
  const deed = { actorId: 1, primitive: 'take', targetId: 2, surfaceTag: 'robbery', sceneCues: {}, magnitude: 0.6, t: 0 };
  const richVictim = { 2: { believedWealth: 0.9, wealthConf: 1 } };

  // WITNESS A — a bold, poor, uncaring soul who believes the victim rich: reads it as JUSTICE.
  const robin = mkObs({ risk_tolerance: 0.8, altruism: 0.2 }, 4, richVictim);
  const rA = inferMotive(robin, deed, {});
  ok(rA.best === 'justice', `I2: a bold/poor/uncaring witness who believes the victim rich reads a robbery as JUSTICE (got ${rA.best} @${rA.conf.toFixed(2)})`);

  // WITNESS B — a comfortable, kindly soul (same deed): reads it as a ROBBERY (a wrong).
  const burgher = mkObs({ risk_tolerance: 0.3, altruism: 0.8 }, 200, richVictim);
  const rB = inferMotive(burgher, deed, {});
  ok(rB.best === 'robbery', `I3: a comfortable, kindly witness reads the SAME robbery as a ROBBERY (got ${rB.best} @${rB.conf.toFixed(2)})`);

  // I4 — the two witnesses genuinely DIVERGE on the identical deed (the whole point).
  ok(rA.best !== rB.best, `I4: one deed, two witnesses, two truths (${rA.best} vs ${rB.best})`);

  // I5 — an illegible primitive (no candidates) returns 'unknown', never throws.
  const r5 = inferMotive(burgher, { ...deed, primitive: 'no-such-primitive' }, {});
  ok(r5.best === 'unknown' && r5.conf === 0, 'I5: a primitive with no candidate motives infers unknown');

  // ── SPEECH-ACTS (P5, docs/architecture/17 §8.1): one negative remark, two readings ──
  ok(['warn', 'slander', 'vouch'].every((k) => motivesFor('say').map((m) => m.key).includes(k)),
    'I6: say-primitive inference motives registered (warn/slander/vouch)');
  const remark = { actorId: 1, primitive: 'say', targetId: 2, surfaceTag: 'counsel', sceneCues: { valence: -1 }, magnitude: 0.4, t: 0 };
  // a witness who already DISTRUSTS the subject reads the negative remark as a WARNING (counsel).
  const wary = mkObs({}, 50, { 2: { hostile: true, standing: -0.3 } });
  const sW = inferMotive(wary, remark, {});
  ok(sW.best === 'warn', `I7: a negative remark about a DISTRUSTED subject reads as a warning (${sW.best} @${sW.conf.toFixed(2)})`);
  // a witness who LIKES the subject reads the IDENTICAL remark as a SMEAR (slander).
  const fond = mkObs({}, 50, { 2: { standing: 0.8, hostile: false } });
  const sS = inferMotive(fond, remark, {});
  ok(sS.best === 'slander', `I8: the SAME remark about a LIKED subject reads as slander (${sS.best} @${sS.conf.toFixed(2)})`);
  ok(sW.best !== sS.best, `I9: one remark, two readings (${sW.best} vs ${sS.best})`);
}

// ---- the deed PATH (P3) + the say EFFECT (P5), deterministic ------------------------------------
// Scripted (not soak-emergent, so never flaky): a published deed is delivered to a co-located witness
// and drained through onWitnessPrimitive; and a `say` plants an opinion in the audience + emits a deed.
export function motivationDeedPathTest(ok, helpers) {
  // D1 — emit→publishDeed→inbox→perceive-drain→onWitnessPrimitive (the P3 plumbing, end to end).
  {
    const st = new FeatureStage(helpers);
    const actor = st.add('Actor', 0, 0);
    const witness = st.add('Witness', 1.0, 0);
    st.believe(witness, actor);                 // a base belief exists to annotate
    resetDeedStats();
    st.ctx().resolver.publishDeed({ actorId: actor.id, primitive: 'take', targetId: actor.id, surfaceTag: 'theft', sceneCues: {}, magnitude: 0.5, t: st.sim.time });
    const f = st.run(() => deedsProcessed() > 0, { maxFrames: 180, pin: [[actor, 0, 0], [witness, 1.0, 0]] });
    ok(deedsProcessed() > 0, `D1: a published deed is delivered + drained through onWitnessPrimitive (processed=${deedsProcessed()}, frame ${f})`);
    st.dispose();
  }
  // D2 — the `say` EFFECT: a negative remark about a subject lowers the audience's standing toward it,
  // and the say deed reaches the inbox (conserved; belief-only).
  {
    const st = new FeatureStage(helpers);
    const speaker = st.add('Speaker', 0, 0);
    const listener = st.add('Listener', 1.0, 0);
    const subject = st.add('Subject', 40, 40);   // off-scene (talked ABOUT, not present)
    st.believe(listener, subject);               // the listener holds a (neutral) opinion of the subject
    const before = listener.beliefs.get(subject.id).standing || 0;
    for (let i = 0; i < 5; i++) st.ctx().resolver.say(speaker, subject.id, -1, { weight: 0.1 });
    const after = listener.beliefs.get(subject.id).standing || 0;
    ok(after < before, `D2: a negative say lowered the audience's standing toward the subject (${before.toFixed(2)} → ${after.toFixed(2)})`);
    st.dispose();
  }
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

  if (st.diverge > 0) {
    const tally = {};
    for (const s of st.samples) { const k = `${s.live}→${s.oracle}`; tally[k] = (tally[k] || 0) + 1; }
    console.log(`INFO  shadow divergences (live arbiter→oracle): ${Object.entries(tally).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  } else {
    console.log(`INFO  shadow: ${st.total} decisions, ZERO divergence — live arbitrate ≡ oracle scoreAndSelect`);
  }
}
