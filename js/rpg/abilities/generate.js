// Procedural ability generation. The world refactor dropped fixed professions and
// made occupation emergent, so MOST classes are now PROCEDURAL (key "proc:...") —
// they match no CLASS_TEMPLATE and therefore have NO hand-authored catalog entry
// (catalog.js + CLASS_MILESTONES key only on template classes). This module fills
// that gap: it MINTS a valid AbilitySpec for any class from its dominant deed-tags,
// scaled by tier, so emergent identities still earn [Skills].
//
// Hard rules (mirrors generate-side of the trust boundary in ir.validate):
//   - Output MUST pass ir.validate() and stay within ir.LIMITS. We clamp every
//     number before building the spec, then validate() before returning (null on
//     the impossible-but-defensive failure — callers must treat null as "no grant").
//   - DETERMINISTIC: every choice is seeded from fnv1a(classKey | tier | index).
//     No Math.random(), no Date — same (classKey, tier) -> byte-identical spec,
//     so the headless suite stays reproducible.
//
// Theming: a class's dominant tags pick the ability ARCHETYPE:
//   combat (MELEE/KILL/RISK/BERSERK/DUEL) -> damage (melee swing or projectile)
//   defensive (DEFENSE/ENDURANCE/HEAL)    -> shield / heal on self
//   trade/social (TRADE/PERSUADE/...)     -> utility (slow / stun / plant_belief / scry)
// Tier scales POWER ~exponentially (amount) and COOLDOWN ~linearly (longer waits).

import { spec, effect, validate, LIMITS } from './ir.js';
import { fnv1a } from '../tags.js';

// ---- deterministic seeded picks --------------------------------------------
// A tiny xorshift-ish stream seeded by an FNV hash of the identity string, so a
// (classKey,tier) pair yields a stable sequence of choices with no global RNG.
function seedFor(classKey, tier, salt = 0) {
  return fnv1a(`${classKey || 'proc'}|${tier}|${salt}`);
}
// advance a 32-bit state (xorshift32) -> next unsigned 32-bit
function nextState(s) {
  s ^= (s << 13); s >>>= 0;
  s ^= (s >>> 17);
  s ^= (s << 5);  s >>>= 0;
  return s >>> 0;
}
// a small deterministic stream object: .pick(arr) and .frac() (0..1)
function stream(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return {
    next() { s = nextState(s); return s; },
    frac() { return this.next() / 0x100000000; },
    pick(arr) { return arr[this.next() % arr.length]; },
  };
}

// ---- tag -> archetype classification ---------------------------------------
const COMBAT_TAGS    = new Set(['MELEE', 'KILL', 'RISK', 'BERSERK', 'DUEL']);
const DEFENSIVE_TAGS = new Set(['DEFENSE', 'ENDURANCE', 'HEAL', 'FLEE']);
const UTILITY_TAGS   = new Set([
  'TRADE', 'PROFIT', 'HAGGLE', 'BARTER',
  'PERSUADE', 'GOSSIP', 'DECEIVE', 'LEAD', 'CHARM', 'STEALTH',
  'SMITHING', 'CRAFTING', 'TOOLMAKING',
  'FARMING', 'MINING', 'WOODCUT', 'FORAGE', 'EXPLORE', 'WANDER',
]);

// rank the supplied tags into the three archetypes; returns the winning
// archetype + the (sorted) tags that voted for it (used for flavour + grantsTags).
function classifyArchetype(tags) {
  const list = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [];
  let combat = 0, defensive = 0, utility = 0;
  for (const t of list) {
    if (COMBAT_TAGS.has(t)) combat++;
    else if (DEFENSIVE_TAGS.has(t)) defensive++;
    else if (UTILITY_TAGS.has(t)) utility++;
  }
  // tie-break combat > defensive > utility; default to combat when no tags voted
  if (combat >= defensive && combat >= utility) return 'combat';
  if (defensive >= utility) return 'defensive';
  return 'utility';
}

// ---- tier scaling -----------------------------------------------------------
// tier is the milestone tier index (1..N from RPG.tierLevels); we accept any
// positive integer. Power grows ~exponentially, cooldown ~linearly. Everything is
// clamped to LIMITS at the call site so this can never exceed the trust ceiling.
function tierIndex(tier) {
  const t = Math.floor(Number(tier));
  return isFinite(t) && t >= 1 ? t : 1;
}
// exponential-ish power curve, clamped to [lo, hi].
function scalePow(base, growth, tier, lo, hi) {
  const v = base * Math.pow(growth, tier - 1);
  return Math.max(lo, Math.min(hi, v));
}
function scaleLin(base, perTier, tier, lo, hi) {
  const v = base + perTier * (tier - 1);
  return Math.max(lo, Math.min(hi, v));
}
const clampAmt = (x) => Math.max(-LIMITS.amount, Math.min(LIMITS.amount, x));
const clampDur = (x) => Math.max(0, Math.min(LIMITS.dur, x));
const clampCd  = (x) => Math.max(0, Math.min(LIMITS.cooldown, x));
const clampR   = (x) => Math.max(0, Math.min(LIMITS.areaR, x));
const round1   = (x) => Math.round(x * 10) / 10;

// ---- display-name helper ----------------------------------------------------
// Wandering-Inn bracketed [Skill] flavour, themed by archetype + a deterministic
// adjective so two tiers of the same class read as a progression.
const ARCH_NOUN = {
  combat:    ['Strike', 'Cleave', 'Onslaught', 'Reaver', 'Rend'],
  defensive: ['Bulwark', 'Ward', 'Resolve', 'Aegis', 'Endurance'],
  utility:   ['Gambit', 'Ploy', 'Insight', 'Whisper', 'Sleight'],
};
const TIER_ADJ = ['Lesser', 'Steady', 'Greater', 'Master', 'Grand', 'Peerless'];

export function abilityName(archetype, tier, rng) {
  const nouns = ARCH_NOUN[archetype] || ARCH_NOUN.combat;
  const noun = rng ? rng.pick(nouns) : nouns[0];
  const adj = TIER_ADJ[Math.min(TIER_ADJ.length - 1, tierIndex(tier) - 1)];
  return `[${adj} ${noun}]`;
}

// a stable, collision-resistant id from identity (so cooldown ledgers key cleanly).
function abilityId(classKey, tier, archetype) {
  const h = fnv1a(`${classKey || 'proc'}|${tier}|${archetype}`).toString(36);
  const key = String(classKey || 'proc').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  return `gen_${key}_t${tierIndex(tier)}_${h}`;
}

// ---- the three archetype builders ------------------------------------------
// Each returns { header, effects, grantsTags } pre-clamped; generateAbility wraps
// them in spec() and validates.

function buildCombat(tier, rng, tags) {
  // melee vs projectile: deterministic, but bias toward melee for MELEE-tagged.
  const meleeBias = tags.includes('MELEE') ? 0.7 : 0.4;
  const projectile = rng.frac() > meleeBias;

  const dmg = round1(scalePow(34, 1.18, tier, 8, LIMITS.amount));
  const cd  = round1(scaleLin(5, 2.2, tier, 1, LIMITS.cooldown));

  if (projectile) {
    const speed = round1(scaleLin(16, 4, tier, 4, LIMITS.speed));
    const range = round1(scaleLin(9, 1.5, tier, 3, LIMITS.range));
    const effects = [effect('damage', { amount: clampAmt(dmg), tags: ['CAST', 'MELEE'] })];
    // tier 2+ projectiles also slow on hit (the chained secondary)
    if (tierIndex(tier) >= 2) {
      effects.push(effect('slow', {
        amount: 0.5, dur: clampDur(round1(scaleLin(2, 0.6, tier, 0.5, LIMITS.dur))),
        when: 'on_hit', tags: ['FROST'],
      }));
    }
    return {
      header: {
        target: 'enemy', range, cooldown: clampCd(cd),
        area: { kind: 'self' }, delivery: { kind: 'projectile', speed },
      },
      effects,
      grantsTags: ['CAST', 'ATTACK', 'POWER'],
    };
  }

  // melee swing: short reach, instant; cone at higher tiers (a cleave).
  const cone = tierIndex(tier) >= 3;
  const area = cone
    ? { kind: 'cone', r: clampR(round1(scaleLin(2.6, 0.3, tier, 0.5, LIMITS.areaR))), deg: 100 }
    : { kind: 'self' };
  const effects = [effect('damage', { amount: clampAmt(dmg), tags: ['MELEE', 'FORCE'] })];
  if (tierIndex(tier) >= 2) {
    effects.push(effect('knockback', {
      amount: round1(scaleLin(1.2, 0.4, tier, 0, 8)), when: 'on_hit', tags: ['FORCE'],
    }));
  }
  return {
    header: {
      target: 'enemy', range: 2.6, cooldown: clampCd(cd),
      area, delivery: { kind: 'instant' },
    },
    effects,
    grantsTags: ['ATTACK', 'MELEE', 'POWER'],
  };
}

function buildDefensive(tier, rng, tags) {
  const cd = round1(scaleLin(14, 3, tier, 1, LIMITS.cooldown));
  // heal-leaning for HEAL/ENDURANCE, shield-leaning otherwise
  const healLean = tags.includes('HEAL') || tags.includes('ENDURANCE');
  const wantHeal = healLean ? rng.frac() < 0.65 : rng.frac() < 0.35;

  const shieldAmt = round1(scalePow(22, 1.16, tier, 5, LIMITS.amount));
  const shieldDur = clampDur(round1(scaleLin(5, 1, tier, 1, LIMITS.dur)));
  const effects = [];
  if (wantHeal) {
    effects.push(effect('heal', {
      amount: clampAmt(round1(scalePow(28, 1.18, tier, 5, LIMITS.amount))),
      when: 'caster_hp_below', tags: ['RESTORE'],
    }));
  }
  effects.push(effect('shield', { amount: clampAmt(shieldAmt), dur: shieldDur, tags: ['WARD'] }));
  return {
    header: {
      target: 'self', range: 0, cooldown: clampCd(cd),
      area: { kind: 'self' }, delivery: { kind: 'instant' },
    },
    effects,
    grantsTags: ['DEFEND', 'SURVIVE', 'RESOLVE'],
  };
}

function buildUtility(tier, rng, tags) {
  const cd = round1(scaleLin(9, 2, tier, 1, LIMITS.cooldown));
  const social = tags.some((t) =>
    ['PERSUADE', 'DECEIVE', 'CHARM', 'GOSSIP', 'LEAD', 'TRADE', 'PROFIT', 'HAGGLE', 'BARTER'].includes(t));

  // deceive/charm -> plant_belief; insight-y -> scry; otherwise a control op (slow/stun)
  const deceptive = tags.includes('DECEIVE') || tags.includes('CHARM') || tags.includes('PERSUADE');
  const range = round1(scaleLin(6, 0.5, tier, 1, LIMITS.range));

  if (deceptive) {
    // social attack: amount sign chosen by tag (charm helps, deceive hurts)
    const mag = tags.includes('CHARM') || tags.includes('PERSUADE')
      ? -round1(scaleLin(0.3, 0.08, tier, 0, 1))
      :  round1(scaleLin(0.4, 0.08, tier, 0, 1));
    const r = clampR(round1(scaleLin(4, 0.6, tier, 0, LIMITS.areaR)));
    return {
      header: {
        target: 'any', range, cooldown: clampCd(cd),
        area: tierIndex(tier) >= 2 ? { kind: 'circle', r } : { kind: 'self' },
        delivery: { kind: 'instant' },
      },
      effects: [effect('plant_belief', { amount: Math.max(-1, Math.min(1, mag)), tags: ['PERSUADE'] })],
      grantsTags: ['SOCIAL', 'PERSUADE', 'CHARM'],
    };
  }

  if (social && rng.frac() < 0.5) {
    // a scry (read-the-room) utility
    return {
      header: {
        target: 'any', range, cooldown: clampCd(cd),
        area: { kind: 'self' }, delivery: { kind: 'instant' },
      },
      effects: [effect('scry', { amount: 0, tags: ['INSIGHT'] })],
      grantsTags: ['SOCIAL', 'INSIGHT', 'OBSERVE'],
    };
  }

  // a control op: slow or stun a foe, scaling duration with tier.
  const useStun = rng.frac() < 0.4 && tierIndex(tier) >= 2;
  const dur = clampDur(round1(scaleLin(2, 0.7, tier, 0.5, LIMITS.dur)));
  const effects = useStun
    ? [effect('stun', { amount: 0, dur, when: 'on_hit', tags: ['CONTROL'] })]
    : [effect('slow', { amount: 0.5, dur, tags: ['CONTROL'] })];
  return {
    header: {
      target: 'enemy', range: round1(Math.min(range, 8)), cooldown: clampCd(cd),
      area: { kind: 'self' }, delivery: { kind: 'instant' },
    },
    effects,
    grantsTags: ['SOCIAL', 'CONTROL', 'CUNNING'],
  };
}

// ---- public API -------------------------------------------------------------
// generateAbility({ classKey, name, tags }, tier) -> a VALID AbilitySpec, or null
// if (defensively) the build failed validate(). Deterministic per (classKey,tier).
export function generateAbility(cls, tier) {
  const classKey = cls?.classKey ?? cls?.key ?? 'proc';
  const tags = Array.isArray(cls?.tags) ? cls.tags : [];
  const t = tierIndex(tier);

  const archetype = classifyArchetype(tags);
  const rng = stream(seedFor(classKey, t, 1));

  let body;
  if (archetype === 'combat') body = buildCombat(t, rng, tags);
  else if (archetype === 'defensive') body = buildDefensive(t, rng, tags);
  else body = buildUtility(t, rng, tags);

  const out = spec({
    id: abilityId(classKey, t, archetype),
    name: abilityName(archetype, t, stream(seedFor(classKey, t, 2))),
    classKey,
    tier: t,
    header: body.header,
    effects: body.effects,
    grantsTags: body.grantsTags,
  });

  // the trust boundary — never hand back a spec that doesn't validate.
  if (!validate(out)) return null;
  return out;
}
