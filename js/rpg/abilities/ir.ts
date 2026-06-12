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
//   effect.op       = damage|heal|stun|slow|knockback|dash|shield|plant_belief|scry
//                     |trade_edge|craft_boost                                       (Effect)
//   effect.when     = null|'on_hit'|'on_kill'|'target_hp_below'|'caster_hp_below'     (Trigger)
//   effect.amount   = number used by the op (damage N, heal N, knockback meters …)
//   effect.dur      = seconds (stun/slow/shield duration)
//   effect.chance   = 0..1 gate on the effect (defaults 1)
//   effect.tags     = [string] elemental/flavour tags ([FIRE:60] -> 'FIRE')

import type {
  EffectOp, AreaKind, DeliveryKind, TargetKind, Trigger,
  AbilityArea, AbilityDelivery, AbilityEffect, EffectOpts,
  AbilityHeader, AbilitySpec,
} from '../../../types/sim.js';

// ---- whitelists (the trust boundary; validate() rejects anything outside) ----
// Typed as wide string|null arrays so `.includes(unknownValue)` narrows at the call
// sites in validate() — the elements are still exactly the IR union members.
export const EFFECT_OPS: readonly EffectOp[] = [
  'damage', 'heal', 'stun', 'slow', 'knockback', 'dash', 'shield',
  'plant_belief', 'scry',
  'trade_edge', 'craft_boost',   // economy: caster-side windows (haggle / master_craft)
];
export const AREA_KINDS: readonly AreaKind[] = ['self', 'circle', 'cone', 'line'];
export const DELIVERY_KINDS: readonly DeliveryKind[] = ['instant', 'projectile', 'zone'];
export const TARGET_KINDS: readonly TargetKind[] = ['self', 'enemy', 'ally', 'any'];
export const TRIGGERS: readonly Trigger[] = [null, 'on_hit', 'on_kill', 'target_hp_below', 'caster_hp_below'];

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

const isNum = (x: unknown): x is number => typeof x === 'number' && isFinite(x);
const inRange = (x: unknown, lo: number, hi: number): boolean => isNum(x) && x >= lo && x <= hi;
// membership test that accepts an unknown candidate against a readonly whitelist.
const includes = (arr: readonly unknown[], x: unknown): boolean => arr.includes(x);

// The loose authoring shapes accepted by the builders (validate() is the real gate).
type EffectInput = EffectOpts & { op?: EffectOp; opName?: EffectOp };
interface SpecInput {
  id: string;
  name?: string;
  classKey?: string | null;
  tier?: number;
  header?: Partial<AbilityHeader>;
  effects?: EffectInput[];
  grantsTags?: string[];
}

// ---- builder helpers (keep authored specs terse + consistent) ---------------
export function effect(op: EffectOp, opts: EffectOpts = {}): AbilityEffect {
  return {
    op,
    amount: opts.amount ?? 0,
    dur:    opts.dur ?? 0,
    chance: opts.chance ?? 1,
    when:   opts.when ?? null,
    tags:   opts.tags ? opts.tags.slice() : [],
  };
}

export function spec(o: SpecInput): AbilitySpec {
  const h: Partial<AbilityHeader> = o.header || {};
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
    effects:    (o.effects || []).map((e) => (e.op ? (e as AbilityEffect) : effect(e.opName as EffectOp, e))),
    grantsTags: o.grantsTags ? o.grantsTags.slice() : [],
  };
}

// True if this ability lands through the player's melee swing (so combat.js can
// route the existing weapon hit through the spec's damage op) rather than firing
// instantly. Melee = enemy-targeted, instant delivery, self/short reach.
export function isMelee(s: AbilitySpec): boolean {
  return s.header.target === 'enemy'
    && s.header.delivery.kind === 'instant'
    && s.header.area.kind !== 'circle'
    && s.header.range <= 3.0;
}

// ---- validate(): the WHITELIST trust boundary -------------------------------
// Returns true only for a fully well-formed, in-bounds, data-only spec. Anything
// generated (procedural or LLM) MUST pass this before it can be cast.
export function validate(s: unknown): s is AbilitySpec {
  if (!s || typeof s !== 'object') return false;
  const sp = s as Record<string, unknown>;
  if (typeof sp.id !== 'string' || !sp.id) return false;
  const h = sp.header as Record<string, unknown> | undefined;
  if (!h || typeof h !== 'object') return false;

  if (!includes(TARGET_KINDS, h.target)) return false;
  if (!inRange(h.range, 0, LIMITS.range)) return false;
  if (!inRange(h.cooldown, 0, LIMITS.cooldown)) return false;
  if (!inRange(h.castTime, 0, LIMITS.castTime)) return false;

  if (!validateArea(h.area)) return false;
  if (!validateDelivery(h.delivery)) return false;

  if (!Array.isArray(sp.effects) || sp.effects.length === 0) return false;
  if (sp.effects.length > LIMITS.effects) return false;
  for (const e of sp.effects) if (!validateEffect(e)) return false;

  if (sp.grantsTags && !Array.isArray(sp.grantsTags)) return false;
  return true;
}

function validateArea(a: unknown): a is AbilityArea {
  if (!a || typeof a !== 'object') return false;
  const ar = a as Record<string, unknown>;
  if (!includes(AREA_KINDS, ar.kind)) return false;
  if (ar.kind === 'circle') return inRange(ar.r, 0, LIMITS.areaR);
  if (ar.kind === 'cone')   return inRange(ar.r, 0, LIMITS.areaR) && inRange(ar.deg, 0, 360);
  if (ar.kind === 'line')   return inRange(ar.len, 0, LIMITS.areaR);
  return true; // self
}

function validateDelivery(d: unknown): d is AbilityDelivery {
  if (!d || typeof d !== 'object') return false;
  const dl = d as Record<string, unknown>;
  if (!includes(DELIVERY_KINDS, dl.kind)) return false;
  if (dl.kind === 'projectile') return inRange(dl.speed, 0, LIMITS.speed);
  if (dl.kind === 'zone')       return inRange(dl.radius, 0, LIMITS.areaR);
  return true; // instant
}

function validateEffect(e: unknown): e is AbilityEffect {
  if (!e || typeof e !== 'object') return false;
  const ef = e as Record<string, unknown>;
  if (!includes(EFFECT_OPS, ef.op)) return false;
  if (!inRange(ef.amount, -LIMITS.amount, LIMITS.amount)) return false;
  if (!inRange(ef.dur, 0, LIMITS.dur)) return false;
  if (!inRange(ef.chance, 0, 1)) return false;
  if (!includes(TRIGGERS, ef.when ?? null)) return false;
  if (ef.tags && !Array.isArray(ef.tags)) return false;
  return true;
}
