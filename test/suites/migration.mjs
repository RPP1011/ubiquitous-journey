// ---- the emigration valve, live (config MIGRATE) -----------------------------------------
// A crowded-vs-sparse two-town fixture proving both halves of the population valve:
//   · the truth-side CENSUS pass stamps a land-is-cheap prospect into a few ears in the
//     CROWDED town only (an Inform — the recruiter-offer mailbox pattern, never a goal write);
//   · an ELIGIBLE perceiver (poor + unhoused + unwed + restless + provisioned) DECIDES off its
//     own state, walks the journey as the `migrate` candidate (own-state intent + fillMigrate),
//     and on ARRIVAL execution flips its citizenship (resolver.relocate) — the chronicle notes it;
//   · the ROOTED do not go: a housed/wealthy perceiver ignores the same rumour, and an
//     unprovisioned one stays put (no journey without rations).
import * as THREE from 'three';
import { FeatureStage } from './_stage.mjs';
import { MIGRATE } from '../../js/sim/simconfig.js';

// raise two towns on a bare stage: town 0 (the rumour source) at the origin, town 1
// (land-is-cheap) a journey away. Members are pinned to a town by the same flags spawn() sets.
function twoTowns(st, sparseAt = [80, 80]) {
  st.sim.towns = [
    { id: 0, center: new THREE.Vector3(0, 0, 0), radius: 30, name: 'Crowded' },
    { id: 1, center: new THREE.Vector3(sparseAt[0], 0, sparseAt[1]), radius: 30, name: 'Sparse' },
  ];
}
function citizen(st, a, townId) {
  a.townsperson = true;
  a.townId = townId;
  const t = st.sim.towns[townId];
  a.townAnchor = t.center; a.townRadius = t.radius;
  return a;
}

export function migrationTest(ok, helpers) {
  censusRumourHalf(ok, helpers);
  migrantJourney(ok, helpers);
  rootedStay(ok, helpers);
}

// ---- the CENSUS/RUMOUR half (truth-side; js/sim/migration.js) ----------------------------
function censusRumourHalf(ok, helpers) {
  const st = new FeatureStage(helpers);
  twoTowns(st);
  // ten in the crowded town, two in the sparse one (mean 6: 10 ≥ 7.2 crowded, 2 ≤ 5.1 sparse).
  const crowd = [];
  for (let i = 0; i < 10; i++) crowd.push(citizen(st, st.add(`C${i}`, i, 0), 0));
  const s1 = citizen(st, st.add('S1', 80, 80), 1);
  const s2 = citizen(st, st.add('S2', 82, 80), 1);
  // drive the pass directly (deterministic cadence; rumourChance makes WHO hears it vary,
  // so run enough passes that some ear in the crowd reliably catches the word).
  for (let k = 0; k < 25; k++) st.sim.migration.tick(null, MIGRATE.tickEvery);
  const heard = crowd.filter((a) => a._prospects && a._prospects.some((p) => p.townId === 1));
  ok(heard.length > 0,
    `migration 1: the census let word reach the CROWDED town — ${heard.length} ear(s) hold a land-is-cheap prospect`);
  ok(!(s1._prospects && s1._prospects.length) && !(s2._prospects && s2._prospects.length),
    'migration 2: the SPARSE town hears no rumour about itself (prospects flow crowded → sparse only)');
  ok(crowd.every((a) => !a._prospects || a._prospects.length <= MIGRATE.prospectCap),
    'migration 3: the prospect mailbox stays bounded (≤ prospectCap)');
  st.dispose();
}

// ---- the MIGRANT half: an eligible perceiver relocates (deriver → journey → settle) -------
function migrantJourney(ok, helpers) {
  const st = new FeatureStage(helpers);
  twoTowns(st, [60, 0]);   // a real journey, but short enough to walk inside the frame budget
  // the eligible candidate: poor, unhoused, unwed, RESTLESS (curiosity), provisioned (rations).
  const mig = citizen(st, st.add('Tomas', 0, 0, { personality: { curiosity: 0.9, ambition: 0.3, risk_tolerance: 0.5 } }), 0);
  st.strip(mig);
  mig.inventory.food = 3;                      // provisioned — the no-rations gate passes
  for (const k in mig.needs) mig.needs[k] = 1; // fed + rested: the journey wins the arbitration
  // a perceived prospect (the Inform the census would deliver) — re-stamped until the one-shot
  // weighing (acceptChance) accepts, since a weighed prospect is SPENT either way.
  let frames = 0;
  for (; frames < 6000 && mig.townId !== 1; frames++) {
    if (!mig._migrating && mig.townId === 0) {
      mig._prospects = [{ townId: 1, name: 'Sparse', x: 60, z: 0, t: st.sim.time }];
    }
    for (const k in mig.needs) mig.needs[k] = Math.max(mig.needs[k], 0.8);   // keep survival out of the way
    st.frame();
  }
  ok(mig.townId === 1 && mig.townAnchor === st.sim.towns[1].center,
    `migration 4: the poor/unhoused/restless migrant WALKED to the sparse town and settled — citizenship flipped (${frames}f)`);
  ok(Math.hypot(mig.pos.x - 60, mig.pos.z - 0) <= MIGRATE.settleRadius + 1,
    'migration 5: the flip happened ON ARRIVAL (the body stands in the new town — no teleport)');
  ok(st.sim.chronicle.recent(50).some((b) => b.kind === 'migration' && /Tomas/.test(b.text) && /Sparse/.test(b.text)),
    'migration 6: the chronicle noted the move ("left … for Sparse, where land is cheap")');
  st.dispose();
}

// ---- the ROOTED stay: wealth/housing and an empty pack both refuse the road ---------------
function rootedStay(ok, helpers) {
  const st = new FeatureStage(helpers);
  twoTowns(st, [60, 0]);
  // wealthy + housed: the same rumour moves them not at all.
  const rich = citizen(st, st.add('Hild', 2, 0, { personality: { curiosity: 0.9, ambition: 0.9 } }), 0);
  rich.gold = 50; rich.homeBeliefId = 'B:99'; rich.inventory.food = 3;
  // poor + restless but UNPROVISIONED: tempted, yet no journey without rations.
  const bare = citizen(st, st.add('Pip', -2, 0, { personality: { curiosity: 0.9 } }), 0);
  st.strip(bare);
  for (let f = 0; f < 240; f++) {
    rich._prospects = [{ townId: 1, x: 60, z: 0, t: st.sim.time }];
    bare._prospects = [{ townId: 1, x: 60, z: 0, t: st.sim.time }];
    st.frame();
  }
  ok(!rich._migrating && rich.townId === 0,
    'migration 7: the housed/wealthy perceiver ignores the rumour — the rooted stay');
  ok(!bare._migrating && bare.townId === 0,
    'migration 8: an unprovisioned candidate does not take the road (no journey without rations)');
  st.dispose();
}
