// The data-only ability IR (js/rpg/abilities/ir.js) + cast/effect surfaces. An AbilitySpec
// is never code, never eval'd — validate() is the whitelist trust boundary. The discriminated
// unions below mirror exactly what validate() enforces per kind.

import type { Agent } from './agent.js';
import type { FullCtx } from './ctx.js';

/** Effect ops (EFFECT_OPS). */
export type EffectOp =
  | 'damage' | 'heal' | 'stun' | 'slow' | 'knockback' | 'dash' | 'shield'
  | 'expose'                        // combo SETUP: a damage-amplify window (docs/architecture/19 §9)
  | 'plant_belief' | 'scry'
  | 'trade_edge' | 'craft_boost';   // economy ops: own-state windows on the CASTER

/** Area kinds (AREA_KINDS). */
export type AreaKind = 'self' | 'circle' | 'cone' | 'line';
/** Delivery kinds (DELIVERY_KINDS). */
export type DeliveryKind = 'instant' | 'projectile' | 'zone';
/** Target kinds (TARGET_KINDS) — who the range scan considers. */
export type TargetKind = 'self' | 'enemy' | 'ally' | 'any';
/** Effect trigger gate (TRIGGERS). */
export type Trigger = null | 'on_hit' | 'on_kill' | 'target_hp_below' | 'caster_hp_below';

/** The Area dimension — a real discriminated union (validate() enforces per-kind fields). */
export type AbilityArea =
  | { kind: 'self' }
  | { kind: 'circle'; r: number }
  | { kind: 'cone'; r: number; deg: number }
  | { kind: 'line'; len: number };

/** The Delivery dimension — a real discriminated union. */
export type AbilityDelivery =
  | { kind: 'instant' }
  | { kind: 'projectile'; speed: number }
  | { kind: 'zone'; radius: number };

/** One effect (Effect + Trigger + Tags). */
export interface AbilityEffect {
  op: EffectOp;
  amount: number;             // op magnitude (damage N, heal N, knockback meters …)
  dur: number;                // seconds (stun/slow/shield)
  chance: number;             // 0..1 gate (defaults 1)
  when: Trigger;
  tags: string[];             // elemental/flavour tags — NOT behaviour Tags
}

/** Options the effect() builder accepts (the loose authoring shape). */
export interface EffectOpts {
  amount?: number;
  dur?: number;
  chance?: number;
  when?: Trigger;
  tags?: string[];
}

/** The header (the 5 orthogonal dimensions minus effects). */
/** A story-state cast condition (docs 16): evaluated at cast time from the CASTER's own
 *  state/beliefs only — a commitment made mechanical (while_faithful, vs_sworn_foe, ...). */
export interface AbilityRequire { kind: string; god?: string; }

export interface AbilityHeader {
  target: TargetKind;
  range: number;
  cooldown: number;
  castTime: number;
  area: AbilityArea;
  delivery: AbilityDelivery;
  requires?: AbilityRequire[];   // story-state conditions (<=2, whitelisted in ir.ts; M1)
}

/** A complete, validated ability spec — the single source of truth. */
export interface AbilitySpec {
  id: string;
  name: string;
  classKey: string | null;
  tier: number;
  header: AbilityHeader;
  effects: AbilityEffect[];
  grantsTags: string[];       // behaviour-flavour tags the cast itself contributes
  // PROVENANCE (doc 15/16): where this was learned — a real seam, a real moment. The
  // biography/codex/obituary answer "where did you learn that?" from this. Class-milestone
  // mints may omit it (the grind path); event mints always carry it.
  origin?: { seam: string; withId?: number | string | null; t?: number; text?: string } | null;
}

/** The (optional, lazily-imported) catalog module shape Progression probes. */
export interface CatalogModule {
  ABILITY_CATALOG: Record<string, AbilitySpec>;
  CLASS_MILESTONES: Record<string, Record<number, string>>;   // classKey -> level -> abilityId
}

/** The ctx an effect/cast resolves against. The cast path reads ONLY `agents` (target
 *  resolution over the true roster) and `time` — both guarded (`ctx?.agents || []`). Typed
 *  as that minimal structural surface so the normal resolver path (FullCtx) AND the
 *  resolver-less melee/player fallback in act() (CognitionCtx, no roster) both satisfy it. */
export type CastCtx = { agents?: Agent[]; time?: number };

/** One EFFECTS-map op implementation (js/rpg/abilities/effects.js). Returns whether it landed. */
export type EffectFn = (effect: AbilityEffect, caster: Agent, target: Agent, ctx: CastCtx | null) => boolean;

/** Cooldown/readiness status of an ability (Progression.cooldowns view). */
export interface AbilityStatus {
  id: string;
  ready: boolean;
  readyAt: number;
}
