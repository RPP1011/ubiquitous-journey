// ---- the arc / saga registry (docs/architecture/12 §3 — THE SPINE) ----------------------------
// The generic open→escalate→close completed-arc ledger any emergent loop files through. These gates
// drive the store DIRECTLY (a fake sim with a mutable `time` + a name map + a capture-chronicle), so
// they assert the lifecycle, the keying dedup, the bounded eviction (review 2/4), the UNCONDITIONAL
// close (review 1), and the re-arm/hysteresis the doc's review rounds demanded. A5–A7 (the E2E
// emergent vendetta, Gazette consumption, the director fold) ride the full sim in arcs-e2e below.

import { SagaStore, arcKey } from '../../js/sim/arcs.js';
import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { deriveGoals } from '../../js/sim/motivation.js';
import { gatherDispatches } from '../../js/sim/gazette.js';

// a fake owning sim: a mutable clock + a name registry + a chronicle that just records notes.
function fakeSim() {
  const notes = [];
  return {
    time: 0,
    agentsById: new Map([[1, { name: 'Ada' }], [2, { name: 'Bram' }], [3, { name: 'Cael' }]]),
    chronicle: { note: (kind, subj, text, arc) => notes.push({ kind, subj, text, arc }) },
    _notes: notes,
  };
}

export function arcsTest(ok) {
  // A1 — open is IDEMPOTENT on key: a second open returns the SAME arc (one arcId), not a new one.
  {
    const sim = fakeSim();
    const s = new SagaStore(sim);
    const a1 = s.openArc({ kind: 'vendetta', key: arcKey('vendetta', 1, 2), principals: [1, 2], text: 'It begins.' });
    const a2 = s.openArc({ kind: 'vendetta', key: arcKey('vendetta', 1, 2), principals: [1, 2] });
    ok(a1 && a2 && a1.arcId === a2.arcId, 'arcs A1: openArc is idempotent on key (one arc, same arcId)');
    ok(s._open.size === 1, 'arcs A1: only one arc is open for the key');
  }

  // A2 — append/close lifecycle: a round grows rounds; close sets outcome+closedAt, moves to _closed.
  {
    const sim = fakeSim();
    const s = new SagaStore(sim);
    s.openArc({ kind: 'vendetta', key: 'v', principals: [1, 2] });
    sim.time = 10; s.appendBeat('v', 'round', 'a blow');
    sim.time = 20; s.appendBeat('v', 'round', 'another');
    const arc = s.findArc('v');
    ok(arc && arc.rounds === 2, 'arcs A2: appendBeat grows rounds');
    sim.time = 30;
    const closed = s.closeArc('v', 'fulfilled', 'settled');
    ok(closed && closed.outcome === 'fulfilled' && closed.closedAt === 30, 'arcs A2: closeArc sets outcome + closedAt');
    ok(s.findArc('v') === null && s._closed.length === 1, 'arcs A2: closed arc leaves _open, enters _closed');
  }

  // A3 — keying dedup: two WITNESSES of one murder derive the SAME vendetta arc (symmetric key sorts).
  {
    const sim = fakeSim();
    const s = new SagaStore(sim);
    const a = s.openArc({ kind: 'vendetta', key: arcKey('vendetta', 2, 1), principals: [2, 1] });  // order A
    const b = s.openArc({ kind: 'vendetta', key: arcKey('vendetta', 1, 2), principals: [1, 2] });  // order B
    ok(a && b && a.arcId === b.arcId, 'arcs A3: symmetric key — either order opens ONE arc');
  }

  // A4 — lapsed sweep: an open arc past its expiry is swept closed('lapsed'); bounds hold.
  {
    const sim = fakeSim();
    const s = new SagaStore(sim);
    s.openArc({ kind: 'rescue', key: 'r', principals: [1, 2], expiry: 50 });
    s.appendBeat('r', 'round', 'a real escalation');   // a ROUNDED tale — retention is for stories
    s.findArc('r').expiry = 50;                        // pin the fixture expiry (a round re-arms the TTL)
    s.openArc({ kind: 'rescue', key: 'r0', principals: [3, 4], expiry: 50 });   // never escalates
    sim.time = 40; s.sweep(40);
    ok(s.findArc('r') !== null, 'arcs A4: an unexpired open arc survives the sweep');
    sim.time = 60; s.sweep(60);
    const lapsed = s._closed.find((x) => x.key === 'r');
    ok(s.findArc('r') === null && lapsed && lapsed.outcome === 'lapsed', 'arcs A4: an arc past expiry is swept lapsed');
    // a 0-ROUND lapse files NO tale (the never-escalated-muster precedent) but still arms the
    // re-open refractory, so the same key cannot immediately re-file the same non-story.
    ok(s.findArc('r0') === null && !s._closed.find((x) => x.key === 'r0'),
      'arcs A4b: a never-escalated (0-round) lapse files no tale');
    ok(s.openArc({ kind: 'rescue', key: 'r0', principals: [3, 4] }) === null,
      'arcs A4c: the 0-round lapse still arms the re-open refractory');
  }

  // A8 — eviction EXCLUDES the just-opened arc, evicts the WEAKEST INCUMBENT (review 2). Three
  // incumbents with descending rounds (A:2, B:1, C:0); a fresh arc D (0 rounds) then forces a
  // cap-3 eviction pass → C (the fewest-rounds incumbent) is closed('crowded_out'), D survives.
  {
    const sim = fakeSim();
    const s = new SagaStore(sim);
    s.openArc({ kind: 'vendetta', key: 'A', principals: [1] }); s.appendBeat('A', 'round'); s.appendBeat('A', 'round');
    s.openArc({ kind: 'vendetta', key: 'B', principals: [1] }); s.appendBeat('B', 'round');
    s.openArc({ kind: 'vendetta', key: 'C', principals: [1] });   // 0 rounds — the weakest incumbent
    const D = s.openArc({ kind: 'vendetta', key: 'D', principals: [1] });   // newborn, 0 rounds
    s._enforceMaxOpen(D, 3);                                       // drive eviction down to cap 3, excluding D
    ok(s.findArc('D') !== null, 'arcs A8: the just-opened arc is never evicted (a new story gets a seat)');
    const evicted = s._closed.find((x) => x.outcome === 'crowded_out');
    ok(evicted && evicted.key === 'C', 'arcs A8: eviction closes the fewest-rounds incumbent via crowded_out');
    ok(s.findArc('A') !== null && s.findArc('B') !== null, 'arcs A8: the rounds-bearing incumbents survive');
  }

  // A9 — closeArc is UNCONDITIONAL (review 1): the store never declines to close, so eviction/sweep
  // always shrink _open. (The mutual-feud guard lives at the CALL SITE, not here — A10.)
  {
    const sim = fakeSim();
    const s = new SagaStore(sim);
    s.openArc({ kind: 'vendetta', key: 'v', principals: [1, 2] });
    const c = s.closeArc('v', 'fulfilled');
    ok(c && s._open.size === 0, 'arcs A9: closeArc always closes (no decline) — _open shrinks');
    ok(s.closeArc('missing', 'x') === null, 'arcs A9: closing an absent key is a guarded no-op (null)');
  }

  // A10 — a fresh round RE-ARMS expiry (review 2): a slow feud must outlive an open-and-shut one.
  {
    const sim = fakeSim();
    const s = new SagaStore(sim);
    const arc = s.openArc({ kind: 'vendetta', key: 'v', principals: [1, 2], expiry: 100 });
    const e0 = arc.expiry;
    sim.time = 90; s.appendBeat('v', 'round', 'a fresh blow');
    ok(arc.expiry > e0, 'arcs A10: a round beat pushes expiry forward (re-arms the TTL)');
    // and the re-armed arc survives a sweep that would have lapsed the original expiry.
    sim.time = 110; s.sweep(110);
    ok(s.findArc('v') !== null, 'arcs A10: the re-armed feud is not lapsed at the old expiry');
  }

  // re-ignition back-link: a NEW arc on a closed key carries meta.parentArcId (the feud rekindles).
  {
    const sim = fakeSim();
    const s = new SagaStore(sim);
    const first = s.openArc({ kind: 'vendetta', key: 'v', principals: [1, 2] });
    s.closeArc('v', 'fulfilled');
    const second = s.openArc({ kind: 'vendetta', key: 'v', principals: [1, 2] });
    ok(second && second.arcId !== first.arcId && second.rounds === 0, 'arcs: re-ignition is a fresh arc (new id, rounds reset)');
    ok(second.meta && second.meta.parentArcId === first.arcId, 'arcs: re-ignition back-links parentArcId to the prior closed arc');
  }

  // recentClosed: only FRESH closed arcs, newest-first.
  {
    const sim = fakeSim();
    const s = new SagaStore(sim);
    s.openArc({ kind: 'vendetta', key: 'old', principals: [1] }); sim.time = 0; s.closeArc('old', 'fulfilled');
    sim.time = 1000; s.openArc({ kind: 'vendetta', key: 'new', principals: [1] }); s.closeArc('new', 'fulfilled');
    const fresh = s.recentClosed(120);
    ok(fresh.length === 1 && fresh[0].key === 'new', 'arcs: recentClosed returns only fresh arcs, newest-first');
  }

  // never throws on malformed input (the freeze lesson).
  {
    const s = new SagaStore(fakeSim());
    let threw = false;
    try { s.openArc(null); s.appendBeat('nope', 'round'); s.closeArc('nope', 'x'); s.sweep(0); } catch { threw = true; }
    ok(!threw, 'arcs: malformed/missing calls never throw');
  }
}

// A5–A7 — the registry through the REAL sim (docs/architecture/12 §3.6): an emergent vendetta opens
// at the avenge derive and CLOSES on the killing blow; the Gazette consumes the closed arc; a Director
// _recordSaga lands in the SAME shared ledger. Drives the full Simulation, not the bare store.
export function arcsE2ETest(ok, { makeFighter, stubScene }) {
  const P = () => ({ risk_tolerance: 0.7, social_drive: 0.3, ambition: 0.4, altruism: 0.3, curiosity: 0.4 });
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  let nid = 1;
  const add = (name, cfg = {}) => {
    const a = new Agent(makeFighter('knight', {}),
      { id: nid++, name, profession: null, personality: P(), faction: 'townsfolk', ...cfg });
    sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  };
  const avenger = add('Avenger');     // a townsperson who will carry the grudge
  const foe = add('Foe');             // the one they swear vengeance on

  // A5 (open): the avenger holds an `assaulted` memory of the foe → deriveGoals pushes avenge AND
  // opens the vendetta arc on the symmetric key. We record the episode directly and derive once.
  avenger.memory.record({ t: sim.time, kind: 'assaulted', withId: foe.id, valence: -1, salience: 0.95 });
  avenger.memory.tick(9999, sim.time);   // force a consolidation so the episode reaches salient() (MTM/LTM)
  deriveGoals(avenger, sim._cognitionCtx());
  const vk = arcKey('vendetta', avenger.id, foe.id);
  ok(sim.sagas.findArc(vk) != null, 'arcs A5: the avenge derive OPENED a vendetta arc in sim.sagas');
  ok(avenger.goals.some((g) => g.kind === 'avenge' && g.subjectId === foe.id), 'arcs A5: avenge goal pushed alongside');

  // A5 (close): the killing blow between the feud pair closes the arc 'fulfilled'. Feed a lethal
  // combat event through the real onCombatEvents fold (the observer-layer site that closes it).
  sim.onCombatEvents([{ type: 'dead', attacker: { agent: avenger, id: avenger.id }, target: { agent: foe, id: foe.id } }]);
  const closedV = sim.sagas.recentClosed().find((x) => x.kind === 'vendetta');
  ok(closedV != null, 'arcs A5: the killing blow CLOSED the vendetta arc (a closed emergent saga exists)');
  ok(closedV && closedV.outcome === 'fulfilled', 'arcs A5: the closed vendetta outcome is `fulfilled`');
  ok(sim.sagas.findArc(vk) == null, 'arcs A5: the arc left _open on close');

  // A6 (gazette): the closed emergent arc flows into the dispatch collector as a `saga` brief.
  const dispatches = gatherDispatches(sim);
  const sagaBrief = dispatches.find((d) => d && d.brief && d.brief.kind === 'saga' && d.brief.saga &&
    d.brief.saga.sagaKind === 'vendetta');
  ok(sagaBrief != null, 'arcs A6: sim.sagas.recentClosed() flows into gatherDispatches as a saga brief');

  // A7 (director fold): a Director _recordSaga lands in the SAME sim.sagas ledger (one source).
  sim.director._recordSaga({ sagaKind: 'reckoning', key: 'fold-test', a: 'Ada', l: 'Bram', rel: 'one who trusted them' });
  const folded = sim.sagas.recentClosed().find((x) => x.kind === 'reckoning' && x.meta && x.meta.director);
  ok(folded != null, 'arcs A7: a Director _recordSaga folds into the shared sim.sagas ledger');
  const dispatches2 = gatherDispatches(sim);
  ok(dispatches2.some((d) => d && d.brief && d.brief.kind === 'saga' && d.brief.saga && d.brief.saga.sagaKind === 'reckoning'),
    'arcs A7: the folded director saga renders unchanged through the one Gazette source');

  sim.dispose();
}
