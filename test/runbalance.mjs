// RUN BALANCE — not a gate. Plays the three-run sequence headless over N seeds and tabulates
// stage wins, objectives met, and who fled. Use it after touching combat rules, AI or quests.
//
//   bun test/runbalance.mjs [seeds=12]
import { setSeed } from '../js/sim/rng.js';
import { stubScene, makeFighter } from './harness.mjs';
import { createSession } from '../js/app/session.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import { RunController, memoryStore } from '../js/app/run/run.js';
import { playRunHeadless } from '../js/app/run/autopilot.js';
const stats = {}; let runsOk = 0, runsN = 0; const fled = {};
const N = +(process.argv[2] || 12);
for (let seed = 1; seed <= N; seed++) {
  setSeed(seed * 101);
  const store = memoryStore();
  for (let i = 0; i < 3; i++) {
    const s = createSession({ scene: stubScene, makeFighter, townsfolkPerTown: 4, player: { fighter: new HeadlessFighter('knight', { isPlayer: true }) } });
    const rc = new RunController(s, store); rc.setupHub();
    const rep = playRunHeadless(rc, i);
    if (!rep) { s.dispose(); continue; }
    runsN++; if (rep.success) runsOk++;
    for (const st of rep.stages) {
      const k = st.stage.id; stats[k] ??= { n: 0, won: 0, obj: 0 };
      stats[k].n++; if (st.outcome === 'victory' || st.outcome === 'truce') stats[k].won++; if (st.objectiveMet) stats[k].obj++;
      for (const d of st.deeds) if (/ ran at /.test(d.label)) fled[d.about] = (fled[d.about] || 0) + 1;
    }
    s.dispose();
  }
}
console.log('runs ok', runsOk, '/', runsN);
for (const [k, v] of Object.entries(stats)) console.log(k.padEnd(12), `won ${v.won}/${v.n}  objective ${v.obj}/${v.n}`);
console.log('fled', JSON.stringify(fled));
