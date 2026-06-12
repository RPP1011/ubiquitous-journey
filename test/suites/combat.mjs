// ---- deterministic combat unit: does the math blade actually connect? ----
// Two fighters 2m apart (inside TUNE.reach 2.3). One faces & swings; we step the
// frame loop and confirm a hit lands — this exercises the chest-height weapon
// points + hit-window timing that the soak relies on.

import { resolveCombat } from '../../js/combat.js';
import { DIR, TUNE } from '../../js/constants.js';
import { RPG } from '../../js/rpg/rpgconfig.js';
import { significance } from '../../js/rpg/xp.js';

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

  // LEVELS BUY REAL POWER: a veteran's swing lands harder than a novice's.
  {
    const swing = (level) => {
      const x = makeFighter('knight', {}), y = makeFighter('knight', {});
      x.agent = { faction: 'a', progression: { totalLevel: level } };
      y.agent = { faction: 'b' };
      x.root.position.set(0, 0, 0); y.root.position.set(0, 0, -2);
      x.setFacing(Math.atan2(0, 2));
      x.ready(DIR.UP); x.release();
      for (let i = 0; i < 60 && x.state === 'attack' && y.health === TUNE.maxHealth; i++) {
        x.update(1 / 60); y.update(1 / 60);
        resolveCombat([x, y], null, null);
      }
      return TUNE.maxHealth - y.health;
    };
    const novice = swing(0), veteran = swing(25);
    ok(veteran > novice && Math.abs(novice - TUNE.damage) < 1e-6,
      `combat: levels scale the swing (novice ${novice.toFixed(0)} dmg, level-25 veteran ${veteran.toFixed(0)}) -- the gap is closable`);
    ok(swing(1000) <= TUNE.damage * (RPG.levelDamageCap || 2.5) + 1e-6,
      'combat: the level-damage ceiling holds (no runaway veteran)');
  }

  // STAKES ARE DILUTED BY COMPANY: significance divides by allies, amplifies solo.
  {
    const prog = { _comboSeen: new Set(), _deedLast: new Map() };
    const ev = (allies) => ({ verb: 'strike', tags: ['MELEE'], magnitude: 0.5, allies });
    const solo = significance(ev(0), prog, 0).mult;
    prog._comboSeen.clear(); prog._deedLast.clear();
    const mob = significance(ev(100), prog, 0).mult;
    prog._comboSeen.clear(); prog._deedLast.clear();
    const craft = significance({ verb: 'strike', tags: ['MELEE'], magnitude: 0.5 }, prog, 0).mult;
    ok(solo > mob * 10,
      `combat: slaying alone vs in a mob of 100 are vastly different stakes (sig ${solo.toFixed(2)} vs ${mob.toFixed(3)})`);
    ok(Math.abs(craft - solo / (RPG.sigSoloMult || 1.5)) < 1e-9,
      'combat: a deed without an allies count is neither diluted nor solo-amplified');
  }
}
