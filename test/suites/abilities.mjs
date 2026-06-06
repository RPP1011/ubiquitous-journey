// ---- procedural ability generation (Phase 1) -------------------------------
// generateAbility mints a VALID, deterministic AbilitySpec for any class from its
// dominant deed-tags, scaled by tier. Assert: every generated spec passes the IR
// trust boundary, distinct tag-profiles yield distinct abilities, power/cooldown
// scale with tier, and the same (classKey,tier) is byte-stable (determinism).

import { generateAbility } from '../../js/rpg/abilities/generate.js';
import { validate as validateSpec } from '../../js/rpg/abilities/ir.js';

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
}
