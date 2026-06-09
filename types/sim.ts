// Shared simulation types — THE BARREL (TypeScript port shared type layer).
//
// PURE TYPES — no runtime code. The per-domain modules under types/ own the real
// definitions; this file re-exports them so consumers importing from '.../types/sim.js'
// get the whole vocabulary from one specifier. Every name the Stage-1 stub exported is
// preserved (Agent, CognitionCtx, FullCtx, BeliefStore, BeliefState, Goal, World,
// MentalMap, Place, ResolverFacade, BuildSiteFacade, PosSnapshot, AgentRef) plus the rest.
//
// THE EPISTEMIC SPLIT is a compile-time guarantee here: `CognitionCtx` structurally lacks
// `agents`/`agentsById`/`player`/`buildSites` (see ./ctx.js), so a roster read from
// cognition is a typecheck error, not just a scan failure.

export type { EntityId, Vec2Like, PosSnapshot, AgentRef } from './core.js';

export type {
  BeliefState, BeliefStore, AnimacyTally, PlantOpts,
} from './beliefs.js';

export type {
  Place, MentalMap, World, Poi, Town,
} from './world.js';

export type {
  PerceptKind, Percept, Perceivable,
} from './percept.js';

export type {
  EpisodeKind, Episode, Ring, Memory,
} from './memory.js';

export type {
  GoalKind, Goal, PlanStep, PlanBind, Plan, Atom, Ambition, AmbitionSnapshot,
} from './goals.js';

export type {
  Personality, Needs, Mood, Life, HostileRef, Agent,
  SpyState, ArbitrageState, TargetState, RoamState,
} from './agent.js';

export type {
  SiteHandle, BuildSiteFacade, ResolverFacade, CognitionCtx, FullCtx,
} from './ctx.js';

export type {
  Tag, Verb, ActionEvent, ActionEventSpec, EventBus, BehaviorProfile,
} from './events.js';

export type {
  EffectOp, AreaKind, DeliveryKind, TargetKind, Trigger,
  AbilityArea, AbilityDelivery, AbilityEffect, EffectOpts,
  AbilityHeader, AbilitySpec, CatalogModule, CastCtx, EffectFn, AbilityStatus,
} from './abilities.js';

export type {
  ClassTemplate, ClassInstance, ClassGrant, Significance,
  Progression, VerbXp, ClassXp,
} from './rpg.js';

export type {
  Comparator, Subject, SubjectRef, PredNode, InferNode, RespNode,
  AuthoredSchema, NormalizedSchema, ReasonEnv, GoalDescriptor,
} from './reasoning.js';

export type {
  Stage, Reason, Verdict, TraceNoteOpts, TraceEntry, Trace,
} from './trace.js';

export type {
  Fighter, FighterState, FighterDir, CombatEvent, MakeFighter,
} from './combat.js';

export type {
  Commodity, Trade, Reputation,
} from './economy.js';

export type {
  BeatKind, Beat, StoryBrief, Article, Bounty,
} from './news.js';
