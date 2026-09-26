// App-layer Session (js/app/session.ts): the canonical frame step + the run lifecycle.
// Asserts: a headless session builds and steps; the one-live-session guard holds; the
// player's death ends the run exactly once with a summary; dispose releases the slot.

import { createSession } from '../../js/app/session.js';
import { HeadlessFighter } from '../../js/headlessFighter.js';

export function sessionTest(ok, { stubScene, makeFighter }) {
  const s = createSession({
    scene: stubScene, makeFighter, townsfolkPerTown: 4,
    player: { fighter: new HeadlessFighter('knight', { isPlayer: true }) },
  });
  ok(!!s.player && s.sim.player === s.player, 'session: player agent is the sim player');

  let threw = false;
  try { createSession({ scene: stubScene, makeFighter }); } catch { threw = true; }
  ok(threw, 'session: a second live session is refused');

  let crashed = null;
  try { for (let i = 0; i < 120; i++) s.step(1 / 60); } catch (e) { crashed = e; }
  ok(!crashed && s.runState === 'running', `session: 120 steps run clean (${crashed ? crashed.message : 'ok'})`);

  let ends = 0, got = null;
  s.onRunEnd((sum) => { ends++; got = sum; });
  s.player.fighter.takeHit(1e6, 'down');
  for (let i = 0; i < 5; i++) s.step(1 / 60);
  ok(ends === 1 && s.runState === 'ended', `session: player death ends the run once (fired ${ends}x)`);
  ok(!!got && got.reason === 'death' && Array.isArray(got.beats), 'session: run summary carries reason + chronicle beats');

  s.dispose();
  let s2 = null;
  try { s2 = createSession({ scene: stubScene, makeFighter, townsfolkPerTown: 2 }); } catch { /* reported below */ }
  ok(!!s2 && s2.player === null, 'session: dispose releases the slot; a playerless session builds');
  if (s2) {
    for (let i = 0; i < 30; i++) s2.step(1 / 60);
    ok(s2.runState === 'running', 'session: a playerless run never ends by death');
    s2.dispose();
  }
}
