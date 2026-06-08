// The InteractionSchema CATALOGUE — the flagship reasoning behaviours as DATA ROWS,
// authored with the vocab.js builders and vetted by ir.validate(). The interpreter
// (interpreter.js) evaluates ACTIVE per agent per cognition tick. A new social behaviour
// is a row here, never a new branch in decide.js.
//
// EPISTEMIC POSTURE: every predicate/inference/response reads only the AGENT'S OWN belief
// table, own state, episodic memory, and the static mental map (vocab.js evaluators are in
// the scan). A row is fully serializable data; a typo'd op is rejected by validate() and the
// row degrades to inert (never throws on the tick).
//
// PRIORITY BANDS (SCHEMA config doc): flee .9 · intercept .85 · hide .95 · suspect .5 ·
// brawl .7 · inert .6. The interpreter sorts by priority so a high one is considered first.

import { schema, validate } from './ir.js';
import {
  all, any, not,
  believe, witnessed, selfNeed, selfIs, outmatchedBy, nearKnown, nearSubject, perceivedNow,
  selfEngaged, observedAnimacy,
  setIntent, inferDest, raise, raiseThenSet,
  goal, intercept, fleeTo, shadow, avoid,
} from './vocab.js';
import { SCHEMA } from '../simconfig.js';
import type { AuthoredSchema, NormalizedSchema } from '../../../types/sim.js';

// The 6 flagship interactions (docs/architecture/09-reasoning-layer.md §"flagship interactions").
// Each is ~6 lines reusing the SAME primitives — a new behaviour is a row, not a branch.
export const SCHEMAS: AuthoredSchema[] = [
  // 1. QUARRY — believe I'm hunted and I'm no fighter → break for an EXIT or COVER.
  //    (No `safety` need exists in this build; the spec's selfNeed('safety',…) clause is
  //    rendered by the believed-hostile + not-combatant test, which is the same condition.)
  {
    id: 'flee-to-safety', subject: 'self',
    when: all(
      nearKnown('threat', 9),                 // a believed-hostile is within 9m of me…
      not(selfIs('combatant')),               // …and I'm no fighter
    ),
    infer: setIntent('flee'),
    respond: fleeTo(['exit', 'conceal']),     // run to the nearest known exit/cover
    priority: 0.9, ttl: 4,
  },

  // 2. PURSUER — infer WHERE the quarry is making for, and cut it off there (Theory of Mind).
  {
    id: 'intercept-fleer', subject: 'believed',
    when: all(
      believe('@q', 'hostile', '==', true),
      believe('@q', 'intent', '==', 'flee'),
      not(perceivedNow('@q')),                // I've lost sight of it
    ),
    infer: inferDest('flee'),                 // → belief('@q').destPos = <place>
    respond: intercept('@q'),                 // fight goal toward the inferred destination
    priority: 0.85, ttl: 6,
  },

  // 3. HIDE — outmatched, don't just run (you lose); seek CONCEALMENT and go quiet.
  {
    id: 'go-to-ground', subject: 'believed',
    when: all(
      believe('@hunter', 'hostile', '==', true),
      outmatchedBy('@hunter'),                // I believe it can beat me
    ),
    infer: setIntent('hide'),
    respond: goal('hide', { affords: ['conceal'] }),   // disposition (act.js seeks cover, goes still)
    priority: 0.95, ttl: 8,
  },

  // 4. SUSPECT A DISGUISE — a "friend" whose deed contradicts its face (intrigue, no truth read).
  {
    id: 'doubt-the-mask', subject: 'believed',
    when: all(
      believe('@x', 'lastFaction', '==', 'self'),     // wears MY faction's colours…
      witnessed('@x', 'HOSTILE_ACT'),                 // …yet I saw it act hostile
      believe('@x', 'hostile', '==', false),          // …but I've NOT yet concluded it hostile —
                                                       // this is the SUSPICION stage (curdling toward
                                                       // hostile). Once I'm sure (avenge/fight already
                                                       // drives me) shadowing it is regressive, so the
                                                       // schema yields to the committed hostile intent.
    ),
    infer: raise('suspicion', 0.4),                   // curdles toward 'hostile' on repeat
    respond: shadow('@x'),                            // trail it at a stand-off (disposition)
    priority: 0.5, ttl: 30,
  },

  // 5. BYSTANDER — believe a fight is breaking out nearby → clear the danger zone.
  {
    id: 'flee-the-brawl', subject: 'believed',
    when: all(
      any(witnessed('@a', 'STRUCK'), believe('@a', 'hostile', '==', true)),
      nearSubject('@a', 7),                            // the brawl @a is within 7m of me (real gate)
      not(selfIs('combatant')),
    ),
    infer: setIntent('flee'),
    respond: avoid('@a', ['safe']),                   // steer away from it toward a safe place
    priority: 0.7, ttl: 3,
  },

  // 6. UNMASK THE INERT — a "hostile" I've struck repeatedly that never fights back, flees,
  //    blocks, or harms me is, by MY OWN evidence, no threat at all (scarecrow/corpse/statue).
  //    Belief REVISED from contradicting observation — correction by reasoning, not omniscience.
  {
    id: 'no-threat-no-response', subject: 'believed',
    when: all(
      believe('@x', 'hostile', '==', true),
      selfEngaged('@x', 3),                            // I've hit it several times…
      not(observedAnimacy('@x')),                      // …yet zero reaction (no move/strike/block/harm)
    ),
    // accrue inertEvidence; above threshold revise BOTH hostile:false AND inert:true (the
    // latter overrides the faction prior in considerHostile — the real disengage trigger).
    infer: raiseThenSet('inertEvidence', 1, SCHEMA.inertThreshold, [['hostile', false], ['inert', true]]),
    respond: goal('wander'),                           // lose interest, move on (existing kind)
    // ttl gates RE-firing (so evidence accrues over "a few unanswered blows", not every 6Hz
    // tick) — sized so inertThreshold accruals complete in a handful of seconds, matching the
    // spec's "after a few blows" intent (not the 20s the priority-band note loosely sketched).
    priority: 0.6, ttl: 4,
  },
];

// the live set the interpreter runs: drop any row that fails validation (degrades to
// inert rather than throwing on the tick). Normalized through schema() for defaults.
export const ACTIVE: NormalizedSchema[] = SCHEMAS.map(schema).filter(validate);
