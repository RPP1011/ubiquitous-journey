// ---- deterministic combat unit: does the math blade actually connect? ----
// Two fighters 2m apart (inside TUNE.reach 2.3). One faces & swings; we step the
// frame loop and confirm a hit lands — this exercises the chest-height weapon
// points + hit-window timing that the soak relies on.

import { resolveCombat } from '../../js/combat.js';
import { DIR, TUNE } from '../../js/constants.js';

export function combatUnit(ok, { makeFighter }) {
  const a = makeFighter('knight', {}), b = makeFighter('knight', {});
  a.agent = { faction: 'a' }; b.agent = { faction: 'b' };
  a.root.position.set(0, 0, 0);
  b.root.position.set(0, 0, -2);                 // due north, within reach
  a.setFacing(Math.atan2(-(0), -(-2)));          // face the target (dx=0, dz=-2)

  let hits = 0;
  for (let swing = 0; swing < 3 && b.alive; swing++) {
    a.ready(DIR.UP); a.release();
    for (let i = 0; i < 60 && a.state === 'attack'; i++) {
      a.update(1 / 60); b.update(1 / 60);
      const ev = resolveCombat([a, b], null, null);
      hits += ev.filter((e) => e.type === 'hit' || e.type === 'dead').length;
    }
    for (let i = 0; i < 30 && !a.canAct(); i++) { a.update(1 / 60); b.update(1 / 60); }
  }
  ok(hits >= 1, `combat: melee connects headless (${hits} hit(s), target hp ${Math.round(b.health)})`);
  ok(b.health < TUNE.maxHealth, 'combat: target actually took damage');
}
