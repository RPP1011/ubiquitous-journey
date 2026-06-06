// Hearsay (the telephone game) — unit checks for belief CONTENT garbling as it
// passes mouth to mouth. Exercises the pure BeliefStore directly (no full sim), so
// it's deterministic and fast. Asserts the four promises of the mechanic:
//   1. provenance deepens with every retelling (hops 0,1,2,… capped), and the
//      provenance LABEL tracks it (for the narrative layer's hedging);
//   2. a CHARGED negative opinion COMPOUNDS toward the extreme down a chain
//      (outrage grows in the telling) — bad news faster than good;
//   3. MILD goodwill spreads undistorted + damped (the social fabric survives);
//   4. compounded SUSPICION can curdle into a FALSE hostility (a feud from pure
//      talk), but NEVER on a first-hand belief (seeing for yourself beats a tale).

import { BeliefStore, provenanceLabel, provenanceTag } from '../../js/sim/beliefs.js';
import { SOURCE, HEARSAY } from '../../js/sim/simconfig.js';

const SUBJ = 7;
const POS = { x: 0, y: 0, z: 0 };

// Build a chain of N tellers; teller 0 SEES the subject first-hand (hops 0) with
// the seeded belief fields, then each passes it to the next. Returns the belief
// each teller ends up holding about the subject.
function chain(n, seed) {
  const tellers = [];
  for (let i = 0; i < n; i++) tellers.push(new BeliefStore(1000 + i));
  const b0 = tellers[0].observe(SUBJ, 'townsfolk', POS, 0, false);
  Object.assign(b0, seed);                       // seed standing/suspicion on the first-hand belief
  for (let i = 1; i < n; i++) tellers[i].mergeFrom(tellers[i - 1].get(SUBJ), SOURCE.TALKED);
  return tellers.map((t) => t.get(SUBJ));
}

export function hearsayTest(ok) {
  // 1 — provenance deepens and is labelled
  {
    const b = chain(6, { standing: -0.5 });
    const hops = b.map((x) => x.hops);
    ok(hops[0] === 0 && hops[1] === 1 && hops[2] === 2 && hops[3] === 3,
      `hearsay: hops deepen with each retelling (${hops.join(',')})`);
    ok(hops[hops.length - 1] === HEARSAY.maxHops, `hearsay: provenance depth caps at maxHops (${hops[hops.length - 1]})`);
    ok(provenanceLabel(b[0]) === 'seen first-hand', 'hearsay: first-hand belief labelled "seen first-hand"');
    ok(provenanceLabel(b[3]) === 'a thirdhand rumour', `hearsay: 3-hop belief reads as a thirdhand rumour ("${provenanceLabel(b[3])}")`);
    ok(provenanceTag(b[0]) === 'seen' && provenanceTag(b[2]) === '2nd-hand', 'hearsay: compact provenance tags track depth');
  }

  // 2 — a charged NEGATIVE opinion compounds toward the extreme in the retelling
  {
    const b = chain(6, { standing: -0.45 });
    ok(b[1].standing < b[0].standing, `hearsay: one retelling already worsens a bad opinion (${b[0].standing.toFixed(2)} -> ${b[1].standing.toFixed(2)})`);
    ok(b[5].standing < -0.9, `hearsay: a bad rumour compounds toward ruin down the chain (ends ${b[5].standing.toFixed(2)})`);
    // bad news outruns good: a +0.45 opinion does NOT plunge as fast as -0.45 sinks
    const good = chain(6, { standing: 0.45 });
    ok(Math.abs(b[3].standing) > Math.abs(good[3].standing), 'hearsay: bad news amplifies harder than good (negBias)');
  }

  // 3 — mild talk spreads undistorted + damped (no poisoning of ordinary goodwill)
  {
    const b = chain(5, { standing: 0.2 });        // below chargeThresh
    ok(b[4].standing > 0 && b[4].standing <= 0.2 + 1e-6,
      `hearsay: mild goodwill spreads without exaggeration (${b[0].standing.toFixed(2)} -> ${b[4].standing.toFixed(2)})`);
  }

  // 4 — suspicion can curdle into a FALSE hostility down a chain (probabilistic),
  //     but a FIRST-HAND belief never tips no matter how lurid the whisper.
  {
    let tipped = 0;
    for (let trial = 0; trial < 60; trial++) {
      const b = chain(6, { standing: -0.6 });     // a charged bad name; compounds toward ruin
      if (b.some((x) => x.hostile && x.rumorBorn)) tipped++;
    }
    ok(tipped > 0, `hearsay: a blackened name curdles into a false feud (${tipped}/60 chains caught fire)`);

    // a witness who saw for themselves (hops 0) must NEVER curdle, however foul the talk:
    let witnessTipped = false;
    for (let trial = 0; trial < 60 && !witnessTipped; trial++) {
      const eye = new BeliefStore(1);
      const wb = eye.observe(SUBJ, 'townsfolk', POS, 0, false);
      wb.standing = -0.95;                          // a dim view, but their OWN view
      const gossip = new BeliefStore(2);
      const gb = gossip.observe(SUBJ, 'townsfolk', POS, 0, false);
      gb.standing = -1; gb.hops = 4;                // venomous, much-retold hearsay
      for (let k = 0; k < 8; k++) eye.mergeFrom(gb, SOURCE.TALKED);   // know-better branch (hops stay 0)
      if (wb.hostile) witnessTipped = true;
    }
    ok(!witnessTipped, 'hearsay: a first-hand belief is immune to the rumour-tip (seeing beats hearsay)');
  }
}
