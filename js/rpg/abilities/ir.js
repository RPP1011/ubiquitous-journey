// Ability IR: a small DATA-ONLY intermediate representation for abilities. An
// AbilitySpec is the single source of truth — it is never code, never eval'd, so
// the same shape can be hand-authored (catalog.js), procedurally generated
// (generate.js), or emitted by an LLM and run through validate() before use.
//
// Shape (the spec's 5 orthogonal dimensions folded into header + effects):
//   {
//     id, name, classKey, tier,
//     header: { target, range, cooldown, castTime, area, delivery },
//     effects: [ { op, amount, dur, chance, when, tags } ],   // Effect + Trigger + Tags
//     grantsTags: [string]    // behavior tags the *cast* itself contributes
//   }
//
//   header.area     = { kind:'self'|'circle'|'cone'|'line', r?, deg?, len? }   (Area)
//   header.delivery = { kind:'instant'|'projectile'|'zone', speed?, radius? }  (Delivery)
//   header.target   = 'self'|'enemy'|'ally'|'any'                              (who range scans)
//   effect.op       = damage|heal|stun|slow|knockback|dash|shield|plant_belief|scry  (Effect)
//   effect.when     = null|'on_hit'|'on_kill'|'target_hp_below'|'caster_hp_below'     (Trigger)
//   effect.amount   = number used by the op (damage N, heal N, knockback meters …)
//   effect.dur      = seconds (stun/slow/shield duration)
//   effect.chance   = 0..1 gate on the effect (defaults 1)
//   effect.tags     = [string] elemental/flavour tags ([FIRE:60] -> 'FIRE')

// ---- whitelists (the trust boundary; validate() rejects anything outside) ----
export const EFFECT_OPS = [
  'damage', 'heal', 'stun', 'slow', 'knockback', 'dash', 'shield',
  'plant_belief', 'scry',
];
export const AREA_KINDS = ['self', 'circle', 'cone', 'line'];
export const DELIVERY_KINDS = ['instant', 'projectile', 'zone'];
export const TARGET_KINDS = ['self', 'enemy', 'ally', 'any'];
export const TRIGGERS = [null, 'on_hit', 'on_kill', 'target_hp_below', 'caster_hp_below'];

// hard numeric ceilings so a generated/LLM spec can't produce a nuke
export const LIMITS = {
  amount:   200,   // damage / heal / knockback magnitude
  dur:      12,    // stun/slow/shield seconds
  range:    30,    // target scan radius (meters)
  cooldown: 120,   // seconds
  castTime: 6,
  areaR:    14,    // circle/cone radius, line length
  effects:  6,     // max effects per ability
  speed:    60,    // projectile speed
};

const isNum = (x) => typeof x === 'number' && isFinite(x);
const inRange = (x, lo, hi) => isNum(x) && x >= lo && x <= hi;

// ---- builder helpers (keep authored specs terse + consistent) ---------------
export function effect(op, opts = {}) {
  return {
    op,
    amount: opts.amount ?? 0,
    dur:    opts.dur ?? 0,
    chance: opts.chance ?? 1,
    when:   opts.when ?? null,
    tags:   opts.tags ? opts.tags.slice() : [],
  };
}

export function spec(o) {
  const h = o.header || {};
  return {
    id:       o.id,
    name:     o.name || o.id,
    classKey: o.classKey || null,
    tier:     o.tier ?? 1,
    header: {
      target:   h.target   || 'enemy',
      range:    h.range    ?? 2.4,
      cooldown: h.cooldown ?? 4,
      castTime: h.castTime ?? 0,
      area:     h.area     || { kind: 'self' },
      delivery: h.delivery || { kind: 'instant' },
    },
    effects:    (o.effects || []).map((e) => (e.op ? e : effect(e.opName, e))),
    grantsTags: o.grantsTags ? o.grantsTags.slice() : [],
  };
}

// True if this ability lands through the player's melee swing (so combat.js can
// route the existing weapon hit through the spec's damage op) rather than firing
// instantly. Melee = enemy-targeted, instant delivery, self/short reach.
export function isMelee(s) {
  return s.header.target === 'enemy'
    && s.header.delivery.kind === 'instant'
    && s.header.area.kind !== 'circle'
    && s.header.range <= 3.0;
}

// ---- validate(): the WHITELIST trust boundary -------------------------------
// Returns true only for a fully well-formed, in-bounds, data-only spec. Anything
// generated (procedural or LLM) MUST pass this before it can be cast.
export function validate(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.id !== 'string' || !s.id) return false;
  const h = s.header;
  if (!h || typeof h !== 'object') return false;

  if (!TARGET_KINDS.includes(h.target)) return false;
  if (!inRange(h.range, 0, LIMITS.range)) return false;
  if (!inRange(h.cooldown, 0, LIMITS.cooldown)) return false;
  if (!inRange(h.castTime, 0, LIMITS.castTime)) return false;

  if (!validateArea(h.area)) return false;
  if (!validateDelivery(h.delivery)) return false;

  if (!Array.isArray(s.effects) || s.effects.length === 0) return false;
  if (s.effects.length > LIMITS.effects) return false;
  for (const e of s.effects) if (!validateEffect(e)) return false;

  if (s.grantsTags && !Array.isArray(s.grantsTags)) return false;
  return true;
}

function validateArea(a) {
  if (!a || !AREA_KINDS.includes(a.kind)) return false;
  if (a.kind === 'circle') return inRange(a.r, 0, LIMITS.areaR);
  if (a.kind === 'cone')   return inRange(a.r, 0, LIMITS.areaR) && inRange(a.deg, 0, 360);
  if (a.kind === 'line')   return inRange(a.len, 0, LIMITS.areaR);
  return true; // self
}

function validateDelivery(d) {
  if (!d || !DELIVERY_KINDS.includes(d.kind)) return false;
  if (d.kind === 'projectile') return inRange(d.speed, 0, LIMITS.speed);
  if (d.kind === 'zone')       return inRange(d.radius, 0, LIMITS.areaR);
  return true; // instant
}

function validateEffect(e) {
  if (!e || !EFFECT_OPS.includes(e.op)) return false;
  if (!inRange(e.amount, -LIMITS.amount, LIMITS.amount)) return false;
  if (!inRange(e.dur, 0, LIMITS.dur)) return false;
  if (!inRange(e.chance, 0, 1)) return false;
  if (!TRIGGERS.includes(e.when ?? null)) return false;
  if (e.tags && !Array.isArray(e.tags)) return false;
  return true;
}
