// The run loop end to end, headless: three consecutive runs (three quests, nine battles in
// different environments) under a persistent save. Asserts the loop completes, companions
// develop in ways their traits and your choices explain, and the hub knows what you did —
// with provenance, per person, and differently for different people.

import { createSession } from '../../js/app/session.js';
import { HeadlessFighter } from '../../js/headlessFighter.js';
import { RunController, memoryStore } from '../../js/app/run/run.js';
import { playRunHeadless } from '../../js/app/run/autopilot.js';

export function runsTest(ok, { stubScene, makeFighter }) {
  const store = memoryStore();
  const reports = [];
  const talk = {};
  const pipBravery = [];
  for (let i = 0; i < 3; i++) {
    const s = createSession({ scene: stubScene, makeFighter, townsfolkPerTown: 4,
      player: { fighter: new HeadlessFighter('knight', { isPlayer: true }) } });
    const rc = new RunController(s, store);
    rc.setupHub();
    if (i === 0) talk.before = rc.talk('reeve').map((l) => l.text).join(' ');
    pipBravery.push(rc.save.profiles.pip.traits.bravery);
    const rep = playRunHeadless(rc, i, (l) => console.log('   ' + l));
    reports.push(rep);
    rc.setupHub();
    talk[i] = Object.fromEntries(['reeve', 'marta', 'anselm', 'hilde', 'tom', 'nan'].map((k) => [k, rc.talk(k).map((l) => l.text).join(' ')]));
    rc.markSeen();
    s.dispose();
  }
  const save = store.data;
  pipBravery.push(save.profiles.pip.traits.bravery);
  ok(reports.every((r) => r && r.stages.length >= 2), `runs: three runs played (${reports.map((r) => r && `${r.quest.id}:${r.stages.length} stages`).join(', ')})`);
  ok(reports.filter((r) => r && r.success).length >= 2, `runs: most runs succeed (${reports.map((r) => r && r.success).join(', ')})`);
  ok(new Set(reports.flatMap((r) => r.stages.map((s) => s.stage.biome))).size >= 3, 'runs: stages span at least three environments');
  ok(save.deeds.length >= 6, `runs: deeds recorded (${save.deeds.length})`);
  // companions changed, and the record says why
  const moved = Object.values(save.profiles).filter((p) => p.memories.length >= 2);
  ok(moved.length >= 3, `runs: at least three companions carry memories (${moved.map((p) => `${p.key}:${p.memories.length}`).join(' ')})`);
  ok(pipBravery[3] !== pipBravery[0], `runs: Pip's bravery developed across runs (${pipBravery.map((x) => x.toFixed(2)).join(' → ')})`);
  // the hub knows — first-hand or by rumour — and people react differently
  const heardCount = Object.values(save.hub.heard).reduce((n, l) => n + l.length, 0);
  ok(heardCount >= 10, `runs: the town heard about it (${heardCount} tellings)`);
  const hops = new Set(Object.values(save.hub.heard).flat().map((h) => h.hops));
  ok(hops.size >= 2, `runs: tales travel at different distances (hops seen: ${[...hops].join(',')})`);
  const standings = Object.values(save.hub.standing);
  ok(Math.max(...standings) - Math.min(...standings) > 0.3, `runs: opinions diverge by person (${Object.entries(save.hub.standing).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' ')})`);
  ok(talk[0].tom !== talk[2].tom || talk[0].anselm !== talk[1].anselm, 'runs: what people say changes between visits');
  ok(/told me|Word at|swears|saw/.test(Object.values(talk[1]).join(' ')), 'runs: hub lines name where they heard it');
  ok(talk.before !== talk[0].reeve, 'runs: the reeve talks differently after the first run');
  console.log('   hub after run 1 —', JSON.stringify(talk[0], null, 1).slice(0, 1400));
}
