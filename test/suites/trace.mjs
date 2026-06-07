// REASONING-TRACE suite — asserts the trace SUBSTRATE + the implemented write-sites
// (docs/reasoning-traces.md). Matches on the `code` ENUM (stable), never the rendered
// string (cosmetic). The deferred decide/act/planner arbitration entries (BEHAVIOUR_WON
// /RUNNERUP/INTERRUPTED/RESUMED) land post-2b, so they are NOT exercised here.
//
// Covered:
//   • substrate — note() appends, recent() is newest-first, the ring CAPS at TRACE.depth,
//     newestT() tracks the latest, traceLabel renders every code without throwing;
//   • DEST_INFERRED — perception's inferLostQuarries commits a place for a lost quarry;
//   • GOAL_DERIVED  — motivation's deriveGoals pushes a memory-derived goal;
//   • SCHEMA_FIRED  — the substrate carries the schema codes (the live schema interpreter
//     lands post-2b; asserted via a direct note so the code/label are exercised now);
//   • the write-only SCAN RULE — trips on an injected `x = a.trace` READ, clean on the
//     sanctioned `a.trace.note(...)` write.

import * as THREE from 'three';
import { Agent } from '../../js/sim/agent.js';
import { Trace, STAGE, REASON, VERDICT, traceLabel } from '../../js/sim/trace.js';
import { TRACE, MAP } from '../../js/sim/simconfig.js';
import { MentalMap, Place } from '../../js/sim/mentalmap.js';
import { perceive } from '../../js/sim/agent/perception.js';
import { deriveGoals } from '../../js/sim/motivation.js';

export function traceTest(ok, { makeFighter }) {
  // --- substrate: append + newest-first + ring cap ---------------------------
  {
    const tr = new Trace(4);                       // tiny ring to prove the cap
    ok(tr.recent().length === 0, 'trace: a fresh ring is empty');
    ok(tr.newestT() === null, 'trace: a fresh ring has no newest stamp');
    for (let i = 0; i < 10; i++) tr.note(STAGE.GOAL, REASON.GOAL_DERIVED, { t: i, a: 'k' + i });
    const r = tr.recent();
    ok(r.length === 4, `trace: ring caps at depth (held ${r.length}/4)`);
    ok(r[0].t === 9 && r[1].t === 8, 'trace: recent() is newest-first');
    ok(r[3].t === 6, 'trace: oldest beyond the cap was overwritten (t=6 is the floor)');
    ok(tr.newestT() === 9, 'trace: newestT() tracks the latest entry');
    ok(tr.recent(2).length === 2, 'trace: recent(n) bounds the view');
  }

  // --- substrate: note() never throws on bad input; guarded ------------------
  {
    const tr = new Trace(4);
    let threw = false;
    try {
      tr.note();                                   // no stage/code
      tr.note(STAGE.INFER);                         // no code → ignored
      tr.note(STAGE.INFER, REASON.DEST_INFERRED);   // no opts object
      tr.note(STAGE.INFER, REASON.DEST_INFERRED, { subjectId: null, a: null, b: null });
    } catch { threw = true; }
    ok(!threw, 'trace: note() never throws on missing/empty args (the freeze lesson)');
    // only the two well-formed DEST_INFERRED notes land (the code-less ones are dropped).
    ok(tr.recent().every((e) => e.code === REASON.DEST_INFERRED), 'trace: code-less notes are dropped');
  }

  // --- substrate: traceLabel renders EVERY code without throwing -------------
  {
    let threw = false, rendered = 0;
    try {
      for (const code of Object.values(REASON)) {
        const s = traceLabel({ t: 1, stage: STAGE.SCHEMA, code, verdict: VERDICT.FIRED, subjectId: 7, a: 'x', b: 0.5 });
        if (typeof s === 'string' && s.length) rendered++;
      }
      // malformed / empty inputs must also render to a string, never throw.
      traceLabel(null); traceLabel({}); traceLabel({ code: 'unknown_code', stage: 's' });
    } catch { threw = true; }
    ok(!threw, 'trace: traceLabel renders without throwing on any code (incl. null/unknown)');
    ok(rendered === Object.keys(REASON).length, `trace: traceLabel produced text for all ${rendered} codes`);
  }

  // --- substrate: SCHEMA codes exist + carry the schema id (interpreter post-2b)
  {
    const tr = new Trace();
    tr.note(STAGE.SCHEMA, REASON.SCHEMA_FIRED, { t: 1, a: 'flee-to-safety', verdict: VERDICT.FIRED });
    tr.note(STAGE.SCHEMA, REASON.SCHEMA_SUPPRESSED, { t: 1, a: 'intercept-fleer', b: 'not-perceived', verdict: VERDICT.SUPPRESSED });
    const r = tr.recent();
    ok(r.some((e) => e.code === REASON.SCHEMA_FIRED && e.a === 'flee-to-safety'),
      'trace: a SCHEMA_FIRED entry records the schema id');
    ok(r.some((e) => e.code === REASON.SCHEMA_SUPPRESSED && e.b === 'not-perceived'),
      'trace: a SCHEMA_SUPPRESSED entry records the failing predicate hint');
  }

  // --- write-site: DEST_INFERRED via perception's inferLostQuarries ----------
  {
    const a = new Agent(makeFighter('knight', {}),
      { id: 901, name: 'Pursuer', profession: null, faction: 'townsfolk',
        personality: { risk_tolerance: 0.7, social_drive: 0.3, ambition: 0.4, altruism: 0.3, curiosity: 0.4 } });
    a.fighter.root.position.set(0, 0, 0);
    // a believed quarry seen moving +x (toward The Thorngate at +x), now LOST (stale tick,
    // confident, no dest yet) → inferLostQuarries must commit a destination + log it.
    const sub = 902;
    const b = a.beliefs._ensure(sub);
    b.lastFaction = 'bandit';
    b.lastPos.set(2, 0, 0);
    b.heading.set(1, 0, 0);                          // heading +x toward the gate
    b.confidence = 1.0;
    b.lastTick = 5;                                  // seen at t=5
    b.destPos = null; b.destId = null;
    // Phase-1 inferDestination is an affordance-weighted argmax over the agent's KNOWN
    // places, so the lost-quarry pursuit needs a mental map: a gate at +x (affords 'exit')
    // straight along the quarry's believed heading. A bandit is hostile→intent 'flee', so
    // the escape-affording gate wins and a destination commits (firing DEST_INFERRED).
    const map = new MentalMap();
    map.add(new Place('THE-GATE', 'gate', new THREE.Vector3(40, 0, 0), MAP.affordances.gate, null));
    // perceive at a LATER tick with NOBODY in sight: the sighting loop is a no-op, then
    // inferLostQuarries runs over the stale-but-confident belief and infers a place.
    perceive(a, { agents: [], time: 20, map });
    ok(b.destPos != null, 'trace: inferDestination committed a place for the lost quarry');
    const dest = a.trace.recent().find((e) => e.code === REASON.DEST_INFERRED && e.subjectId === sub);
    ok(!!dest, 'trace: a lost-quarry pursuit emits DEST_INFERRED');
    ok(dest && dest.stage === STAGE.INFER, 'trace: DEST_INFERRED is stamped at the INFER stage');
  }

  // --- write-site: GOAL_DERIVED via motivation's deriveGoals -----------------
  {
    const a = new Agent(makeFighter('knight', {}),
      { id: 911, name: 'Wronged', faction: 'townsfolk',
        personality: { risk_tolerance: 0.7, social_drive: 0.3, ambition: 0.4, altruism: 0.3, curiosity: 0.4 } });
    a.fighter.root.position.set(0, 0, 0);
    // a believed-live culprit so the avenge guard (beliefAlive not required for assaulted,
    // but the goal must not be self/already-slain) lets the push through.
    const culprit = 912;
    a.goals = [];
    // record an `assaulted` memory of the culprit, then consolidate STM→MTM→LTM so
    // deriveGoals (which reads memory.salient() = LTM+MTM) sees it.
    a.memory.record({ t: 1, kind: 'assaulted', withId: culprit, valence: -1, salience: 0.9 });
    a.memory._consolidate();
    ok(a.memory.salient().some((e) => e.kind === 'assaulted'), 'trace: the assaulted memory consolidated to salience');
    deriveGoals(a, { time: 3 });
    const derived = a.trace.recent().find((e) => e.code === REASON.GOAL_DERIVED);
    ok(!!derived, 'trace: a memory-derived goal emits GOAL_DERIVED');
    ok(derived && derived.a === 'avenge' && derived.subjectId === culprit,
      'trace: GOAL_DERIVED records the goal kind + source subject');
    // idempotence: re-deriving the SAME memory must NOT log a second GOAL_DERIVED (pushGoal dedups).
    const before = a.trace.recent().filter((e) => e.code === REASON.GOAL_DERIVED).length;
    deriveGoals(a, { time: 4 });
    const after = a.trace.recent().filter((e) => e.code === REASON.GOAL_DERIVED).length;
    ok(after === before, 'trace: a deduped re-derive does NOT re-log GOAL_DERIVED');
  }

  // --- the write-only SCAN RULE: trips on a READ, clean on the note() write ---
  // The epistemic scan's rule (docs §enforcement): in cognition files the ONLY sanctioned
  // `.trace` touch is `…trace.note(…)`. The regex flags `.trace` NOT followed by `.note`.
  // (Mirrors the scan's TRACE_READ literal — asserted here so the rule's LOGIC is tested.)
  {
    const TRACE_READ = /\.trace\b(?!\.note\b)/;
    ok(TRACE_READ.test('const x = a.trace;'), 'scan-rule: trips on an injected `x = a.trace` READ');
    ok(TRACE_READ.test('a.trace.recent(2)'), 'scan-rule: trips on a `.trace.recent(...)` READ');
    ok(!TRACE_READ.test('a.trace.note(STAGE.GOAL, REASON.GOAL_DERIVED, {})'),
      'scan-rule: the sanctioned `a.trace.note(...)` WRITE is clean');
  }

  // --- config: the substrate honours TRACE.depth + TRACE.enabled -------------
  {
    ok(TRACE && typeof TRACE.depth === 'number' && TRACE.depth >= 1, `trace: TRACE.depth configured (${TRACE && TRACE.depth})`);
    // default ring uses TRACE.depth.
    const tr = new Trace();
    ok(tr.depth === TRACE.depth, 'trace: a default ring caps at TRACE.depth');
  }
}
