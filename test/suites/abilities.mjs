// ---- procedural ability generation (Phase 1) -------------------------------
// generateAbility mints a VALID, deterministic AbilitySpec for any class from its
// dominant deed-tags, scaled by tier. Assert: every generated spec passes the IR
// trust boundary, distinct tag-profiles yield distinct abilities, power/cooldown
// scale with tier, and the same (classKey,tier) is byte-stable (determinism).

import { generateAbility } from '../../js/rpg/abilities/generate.js';
import { validate as validateSpec, spec as irSpec, effect as irEffect } from '../../js/rpg/abilities/ir.js';
import { castSpec } from '../../js/rpg/abilities/interpreter.js';
import { slowMul, abilityStatus } from '../../js/rpg/abilities/effects.js';
import { ABILITY_CATALOG } from '../../js/rpg/abilities/catalog.js';
import { goTo } from '../../js/sim/agent/movement.js';
import { trySelfCastAbility, produce } from '../../js/sim/agent/act.js';
import { ABILITY } from '../../js/rpg/rpgconfig.js';
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
  plantBeliefSignTest(ok);
  selfCastTest(ok);
  economyOpsTest(ok);
}

// ---- the economy ops: trade_edge (haggle) + craft_boost (master_craft) -------
// haggle opens a bargaining window the trade ask/bid honour (harder ask, softer
// bid — the clearing midpoint shifts, both parties still exchange the same price);
// master_craft opens a produce-speed window produce() honours. Both expire.
function economyOpsTest(ok) {
  // HAGGLE: cast stamps the window; ask/bid shift inside it, recover after.
  const m = fixtureAgent('Merchant', 0, 0);
  m.gold = 100;
  ok(castSpec(ABILITY_CATALOG.haggle, m, { agents: [m], time: 50 }) === true, 'haggle: cast fired');
  ok((m._haggleEdgeUntil || 0) === 62, `haggle: bargaining window stamped (until=${m._haggleEdgeUntil})`);
  m.priceBeliefs.food = 10;
  m._simNow = 50;                                 // inside the window
  const ask = m.askPrice('food'), bid = m.bidPrice('food');
  ok(ask > 10 && bid < 10, `haggle: harder bargain inside the window (ask=${ask}, bid=${bid})`);
  m._simNow = 63;                                 // expired
  ok(m.askPrice('food') === 10 && m.bidPrice('food') === 10, 'haggle: ask/bid recover after expiry');

  // MASTER CRAFT: cast stamps the window; produce runs craftBoostMul faster inside it.
  const smith = fixtureAgent('Smith', 0, 0);
  ok(castSpec(ABILITY_CATALOG.master_craft, smith, { agents: [smith], time: 50 }) === true, 'master_craft: cast fired');
  ok((smith._craftBoostUntil || 0) === 60, `master_craft: boost window stamped (until=${smith._craftBoostUntil})`);
  const yieldOf = (boosted) => {
    const w = fixtureAgent('Worker', 0, 0);
    w._trade = 'wood'; w._simNow = 50;
    if (boosted) w._craftBoostUntil = 60;
    const before = w.inventory.wood || 0;
    produce(w, 0.2);
    return (w.inventory.wood || 0) - before;
  };
  const fast = yieldOf(true), slow2 = yieldOf(false);
  ok(slow2 > 0 && Math.abs(fast - slow2 * ABILITY.craftBoostMul) < 1e-9,
    `master_craft: produce speed x${ABILITY.craftBoostMul} inside the window (${fast.toFixed(3)} vs ${slow2.toFixed(3)} units)`);
}

// ---- NPC self-cast on the survival path --------------------------------------
// A badly hurt agent holding a ready self-targeted heal/shield spec casts it (the
// combatStep survival hook calls trySelfCastAbility on the cast cadence); a hale
// one keeps its cooldown; an ability-less monster never throws.
function selfCastTest(ok) {
  const sw = ABILITY_CATALOG.second_wind;

  const hurt = fixtureAgent('Bleeder', 0, 0);
  hurt.grantAbility(sw);
  hurt.fighter.health = 30;
  const did = trySelfCastAbility(hurt, { time: 5 });
  ok(did === true, 'self-cast: a hurt warrior with second_wind casts it');
  ok(hurt.fighter.health > 30, `self-cast: health restored (30 -> ${hurt.fighter.health.toFixed(0)})`);
  const st = abilityStatus(hurt.fighter);
  ok(!!st && st.shield > 0, `self-cast: shield armed (${st && st.shield})`);
  ok(trySelfCastAbility(hurt, { time: 5.1 }) === false, 'self-cast: cooldown holds (no instant re-cast)');

  const hale = fixtureAgent('Hale', 5, 0);
  hale.grantAbility(sw);
  const hp0 = hale.fighter.health;
  ok(trySelfCastAbility(hale, { time: 5 }) === false, 'self-cast: a healthy warrior does NOT cast');
  ok(hale.fighter.health === hp0, 'self-cast: healthy warrior untouched');

  // a hurt ability-less monster (profession null, empty abilities) is a clean no-op.
  const mob = fixtureAgent('Mob', 9, 0, { faction: 'monster' });
  mob.fighter.health = 10;
  let threw = false, r = null;
  try { r = trySelfCastAbility(mob, { time: 5 }); } catch { threw = true; }
  ok(!threw && r === false, 'self-cast: ability-less monster is a guarded no-op (never throws)');
}

// ---- plant_belief sign semantics ---------------------------------------------
// amount < 0 = CHARM: raises the target's standing toward the caster, no suspicion.
// amount > 0 = DECEIVE: plants suspicion + sours standing. (The pre-fix code had
// the sign backwards — a charm smeared its own caster.)
function plantBeliefSignTest(ok) {
  const mkSocial = (id, amount) => irSpec({
    id, name: `[${id}]`, classKey: 'proc:test',
    header: { target: 'any', range: 6, cooldown: 1, area: { kind: 'self' }, delivery: { kind: 'instant' } },
    effects: [irEffect('plant_belief', { amount })],
  });

  // CHARM: a speaker charms a stranger -> goodwill, no suspicion.
  const charmer = fixtureAgent('Charmer', 0, 0);
  const mark = fixtureAgent('Mark', 0, 2);
  ok(castSpec(mkSocial('test_charm', -0.4), charmer, { agents: [charmer, mark], time: 10 }) === true,
    'plant_belief: charm cast landed');
  const cb = mark.beliefs.get(charmer.id);
  ok(!!cb && cb.standing > 0, `plant_belief: charm RAISED the mark's standing toward the caster (${cb && cb.standing.toFixed(2)})`);
  ok(!!cb && cb.suspicion === 0 && !cb.hostile, 'plant_belief: charm planted no suspicion/hostility');

  // DECEIVE: a trickster plants a rumor -> suspicion + soured standing.
  const trickster = fixtureAgent('Trickster', 10, 0);
  const dupe = fixtureAgent('Dupe', 10, 2);
  ok(castSpec(mkSocial('test_rumor', 0.5), trickster, { agents: [trickster, dupe], time: 10 }) === true,
    'plant_belief: deceive cast landed');
  const db = dupe.beliefs.get(trickster.id);
  ok(!!db && db.suspicion >= 0.5, `plant_belief: deceive planted suspicion (${db && db.suspicion.toFixed(2)})`);
  ok(!!db && db.standing < 0, `plant_belief: deceive SOURED standing (${db && db.standing.toFixed(2)})`);
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
