// ---- procedural ability generation (Phase 1) -------------------------------
// generateAbility mints a VALID, deterministic AbilitySpec for any class from its
// dominant deed-tags, scaled by tier. Assert: every generated spec passes the IR
// trust boundary, distinct tag-profiles yield distinct abilities, power/cooldown
// scale with tier, and the same (classKey,tier) is byte-stable (determinism).

import { generateAbility } from '../../js/rpg/abilities/generate.js';
import { validate as validateSpec, spec as irSpec, effect as irEffect } from '../../js/rpg/abilities/ir.js';
import { castSpec } from '../../js/rpg/abilities/interpreter.js';
import { slowMul } from '../../js/rpg/abilities/effects.js';
import { goTo } from '../../js/sim/agent/movement.js';
import { Agent } from '../../js/sim/agent.js';
import { makeFighter } from '../harness.mjs';

// a minimal standalone agent fixture (no Simulation needed — movement + the cast
// interpreter only read the agent itself + the ctx handed in).
let _nid = 9000;
function fixtureAgent(name, x, z, cfg = {}) {
  const a = new Agent(makeFighter('knight', {}), {
    id: _nid++, name, profession: null,
    personality: { risk_tolerance: 0.5, social_drive: 0.5, ambition: 0.5, altruism: 0.5, curiosity: 0.5 },
    faction: 'townsfolk', ...cfg,
  });
  a.fighter.root.position.set(x, 0, z);
  return a;
}

export function proceduralAbilityTest(ok) {
  const tiers = [1, 5, 10, 20];   // RPG.tierLevels
  // three representative emergent identities (most classes are now procedural)
  const profiles = {
    warriorish:  { classKey: 'proc:melee|kill',     name: '[Iron Slayer]',   tags: ['MELEE', 'KILL', 'RISK'] },
    producerish: { classKey: 'proc:smithing|craft', name: '[Forging Smith]', tags: ['SMITHING', 'CRAFTING', 'ENDURANCE'] },
    socialish:   { classKey: 'proc:deceive|charm',  name: '[Veiled Charmer]', tags: ['DECEIVE', 'CHARM', 'GOSSIP'] },
    defensive:   { classKey: 'proc:defense|heal',   name: '[Warded Mender]', tags: ['DEFENSE', 'HEAL', 'ENDURANCE'] },
  };

  // 1) every generated spec across every profile/tier passes validate()
  let allValid = true, count = 0;
  const byProfile = {};
  for (const k in profiles) {
    byProfile[k] = [];
    for (const t of tiers) {
      const s = generateAbility(profiles[k], t);
      count++;
      if (!s || !validateSpec(s)) { allValid = false; }
      byProfile[k].push(s);
    }
  }
  ok(allValid, `procgen: all ${count} generated specs pass ir.validate()`);

  // 2) determinism — same (classKey,tier) yields a byte-identical spec
  const a = generateAbility(profiles.warriorish, 5);
  const b = generateAbility(profiles.warriorish, 5);
  ok(a && b && JSON.stringify(a) === JSON.stringify(b),
    'procgen: deterministic — same class@tier yields an identical spec');

  // 3) distinctness — different tag-profiles produce different abilities at the
  //    same tier (themed by their dominant tags, not a single shared template).
  const t10ids = new Set(Object.keys(profiles).map((k) => {
    const s = generateAbility(profiles[k], 10);
    return s ? s.id : null;
  }));
  ok(t10ids.size === Object.keys(profiles).length,
    `procgen: distinct profiles yield distinct abilities (${t10ids.size} unique ids)`);

  // 4) scaling — power (max |amount|) and cooldown both grow tier1 -> tier20.
  const powOf = (s) => Math.max(0, ...s.effects.map((e) => Math.abs(e.amount)));
  const w1 = generateAbility(profiles.warriorish, 1);
  const w20 = generateAbility(profiles.warriorish, 20);
  ok(powOf(w20) > powOf(w1),
    `procgen: power scales with tier (${powOf(w1)} -> ${powOf(w20)})`);
  ok(w20.header.cooldown > w1.header.cooldown,
    `procgen: cooldown scales with tier (${w1.header.cooldown} -> ${w20.header.cooldown})`);

  // 5) themed correctly — warrior-ish is a damage ability, defensive heals/shields
  const warriorDamages = byProfile.warriorish.every((s) => s.effects.some((e) => e.op === 'damage'));
  ok(warriorDamages, 'procgen: combat-tagged profile themes to a damage ability');
  const defensiveGuards = byProfile.defensive.every((s) =>
    s.effects.some((e) => e.op === 'shield' || e.op === 'heal'));
  ok(defensiveGuards, 'procgen: defensive-tagged profile themes to shield/heal');

  // 6) robustness — empty/garbage tags still mint a valid spec (never throws/null
  //    on the milestone path: the freeze lesson applies to the grant path too).
  let threw = false, fallback = null;
  try { fallback = generateAbility({ classKey: 'proc:weird', tags: [] }, 3); } catch { threw = true; }
  ok(!threw && fallback && validateSpec(fallback),
    'procgen: empty-tag class still yields a valid spec (no throw)');

  slowWindowTest(ok);
}

// ---- the slow op is REAL (movement honours the window) ----------------------
// Cast a pure-slow spec at a fixture target, then drive the target's locomotion
// through the shared stepper (goTo -> _stepAlong): while sim-time sits inside the
// slow window the step shrinks by slowFactor; past expiry it fully recovers.
function slowWindowTest(ok) {
  const caster = fixtureAgent('Chiller', 0, 2, { faction: 'monster' });
  const target = fixtureAgent('Runner', 0, 0);
  const slowSpec = irSpec({
    id: 'test_slow', name: '[Test Chill]', classKey: 'proc:test',
    header: { target: 'enemy', range: 6, cooldown: 1, area: { kind: 'self' }, delivery: { kind: 'instant' } },
    effects: [irEffect('slow', { amount: 0.4, dur: 3 })],
  });
  ok(validateSpec(slowSpec), 'slow: the fixture slow spec passes ir.validate()');

  const cast = castSpec(slowSpec, caster, { agents: [caster, target], time: 100 });
  ok(cast === true, 'slow: cast landed on the hostile fixture target');
  ok(slowMul(target.fighter, 100) === 0.4, 'slow: slowMul reads 0.4 inside the window');
  ok(slowMul(target.fighter, 103.5) === 1, 'slow: slowMul reads 1 past expiry');

  // step the body once INSIDE the window, then once PAST it (same start, same path,
  // same terrain) — the displacement ratio must be exactly the slowFactor.
  const dt = 0.1;
  const stepFrom = (simNow) => {
    target.fighter.root.position.set(0, 0, 0);
    target._simNow = simNow;
    goTo(target, { x: 40, z: 0 }, dt);
    return Math.hypot(target.pos.x, target.pos.z);
  };
  const slowed = stepFrom(100);      // inside the 100..103 window
  const free = stepFrom(103.5);      // expired
  ok(slowed > 0 && free > 0, `slow: the fixture actually moved (slowed=${slowed.toFixed(3)}m, free=${free.toFixed(3)}m)`);
  ok(Math.abs(slowed - free * 0.4) < 1e-9,
    `slow: in-window speed is slowFactor x normal (${slowed.toFixed(3)} vs ${free.toFixed(3)}m per step)`);
}
