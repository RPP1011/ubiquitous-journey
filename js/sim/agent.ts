// An economic Agent: a profession, an inventory + gold, needs, and PRICE
// BELIEFS it uses to trade. Each tick it decides (utility over needs + economy)
// and acts: work at its site to produce, eat from its stock, or go to market to
// buy/sell. Price beliefs update from trades and drift toward chatting
// neighbours (gossip) — the economic belief surface.

import { nearestLandmark } from '../arena.js';
import { BeliefStore } from './beliefs.js';
import { rng } from './rng.js';
import {
  PROFESSIONS, COMMODITIES, BASE_PRICE, ECON,
  SIM, COMFORT, BUILD, NOVELTY, SCHEMA, WEALTH, RECIPES,
  factionHostile,
} from './simconfig.js';
import { Progression } from '../rpg/progression.js';
import { assignAmbition } from './motivation.js';
import { Memory } from './memory.js';
import { Trace } from './trace.js';
import { plan as planGoal, PLAN, stepPrecondsHold } from './planner.js';
import * as trade from './agent/trade.js';
import * as decor from './agent/decor.js';
import * as perception from './agent/perception.js';
import * as movement from './agent/movement.js';
import * as action from './agent/act.js';
import * as decision from './agent/decide.js';
import * as occupation from './agent/occupation.js';
import type {
  Agent as AgentShape, BeliefState, HostileRef, Goal, PlanStep, AbilitySpec,
  CognitionCtx, FullCtx, Fighter, EntityId,
} from '../../types/sim.js';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const rand = (a: number, b: number): number => a + rng() * (b - a);

// Re-typed config views (simconfig.js inferred without index signatures under allowJs).
const BASE_PRICE_T = BASE_PRICE as Record<string, number>;
const STARTER_KIT = ECON.starterKit as Record<string, number>;
const PROFESSIONS_T = PROFESSIONS as Record<string, { output: string; inputs?: Record<string, number> | null }>;

// Resolve which crafted recipes a fresh CURRENT PRODUCER is seeded with. Day-1:
// RECIPES.seedKnown:'all' ⇒ every gated recipe, so every working townsperson keeps
// crafting exactly as before (baseline-identical). Phase 4 narrows this per-lineage.
const seedRecipesFor = (out: string | null /* a producer's own output, or null */): Set<string> => {
  const set = new Set<string>();
  const gated: string[] = (RECIPES && RECIPES.gated) || [];
  if (RECIPES && RECIPES.seedKnown === 'all') for (const g of gated) set.add(g);
  // always include the agent's OWN crafted output even if seedKnown narrows later.
  if (out && gated.includes(out)) set.add(out);
  return set;
};

// The spawn config the Simulation/roster hands the constructor (loose by design).
interface AgentCfg {
  id: EntityId;
  name: string;
  profession: string | null;
  controlled?: boolean;
  personality: Record<string, number>;
  faction?: string;
  combatant?: boolean;
  threat?: number;
  townsperson?: boolean;
  [k: string]: unknown;
}

// DECLARATION MERGE: the class below merges with this interface (same name), so every
// field assigned in the constructor gets its type from the shared layer WITHOUT a per-
// field declaration — and a class instance IS structurally the shared `Agent`. The
// index tail (`[k:string]: unknown`) on AgentShape also carries the long drama/news tail.
export interface Agent extends AgentShape {}

export class Agent {
  constructor(fighter: Fighter, cfg: AgentCfg) {
    this.fighter = fighter;
    fighter.agent = this;
    this.id = cfg.id;
    this.name = cfg.name;
    this.profession = cfg.profession;     // null for the human visitor
    this.controlled = !!cfg.controlled;
    this.personality = cfg.personality;
    this.faction = cfg.faction || 'townsfolk';

    // Theory-of-Mind: what this agent believes about others (incl. the player)
    this.beliefs = new BeliefStore(this.id);
    // social-group membership: bandLeaderId points at the group's anchor (the
    // player OR another NPC); groupType is one of GROUP_TYPES. 'travel' groups set
    // inParty and reuse _decideParty; 'loose' groups only tag + bias. See groups.js.
    this.bandLeaderId = null;
    this.groupType = null;

    // combat / disposition
    this.combatant = !!cfg.combatant;      // monsters & guards fight; civilians flee
    this.threat = cfg.threat || (this.combatant ? 1 : 0.3);
    this.mood = { fear: 0, anger: 0 };     // transient, decays; gates flee/fight
    this._releaseTimer = 0;
    this._attackCd = rng() * 1.5;
    // NPC ability cadence: a short reflex gap between cast ATTEMPTS so an NPC
    // doesn't probe its whole ability list every fixed tick. The interpreter owns
    // the real per-ability cooldown; this just paces the attempt. Staggered start.
    this._castCd = rng() * 1.5;

    // needs (1 = satisfied)
    this.needs = { hunger: rand(0.5, 0.9), energy: rand(0.6, 0.95), social: rand(0.4, 0.85), comfort: rand(COMFORT.init[0], COMFORT.init[1]), novelty: rand(NOVELTY.init[0], NOVELTY.init[1]) };
    // per-field MASTERY (units of a good ever made, slow-decaying): the persistent
    // skill that gives a steep, lasting productivity edge — what makes a seasoned
    // specialist nearly impossible to out-compete in its own field. Read by occupation.js.
    this.mastery = {};

    // economy
    this.inventory = {};
    for (const c of COMMODITIES) this.inventory[c] = 0;
    this.gold = ECON.startGold;     // PURSE: carried wealth — lootable on death (unchanged field)
    // STORED WEALTH (Phase-4 prerequisite). stash = banked gold at the agent's home,
    // NOT carried, NOT lootable on death (burglable while away — Phase 4). Day-one
    // baseline-identical: WEALTH.enabled is false, so seedStash leaves it 0 everywhere
    // and the soak/econstats are byte-stable. Guarded everywhere (professionless
    // agents — player/monsters — keep stash 0 and never read it on the tick).
    this.stash = 0;
    this.toolWear = 0;
    this._smithTimer = 0;
    // CRAFT RECIPES KNOWN (own-state; read freely by cognition — no epistemic split).
    // ALWAYS a Set so the produce() gate is safe on professionless agents (monsters/
    // player get an empty Set, never undefined — the freeze lesson). Populated below
    // for current producers; Phase 4 adds/removes via teach/apprentice/shadow.
    this.recipes = new Set();
    this.priceBeliefs = {};
    for (const c of COMMODITIES) this.priceBeliefs[c] = +(BASE_PRICE_T[c] * rand(0.8, 1.2)).toFixed(2);

    // EMERGENT occupation: townsfolk are NOT born into a trade. A generic
    // townsperson (faction townsfolk, not controlled, not a monster) gets a
    // starter kit and will CHOOSE what to make each work decision (see
    // chooseOccupation). `_trade` is the good it is currently making (null until
    // it first picks). Monsters/player carry no kit and never work.
    // `townsperson` is the EMERGENT-occupation flag the Simulation sets on the
    // generic souls it spawns (it gates the starter kit + the work scheduler).
    // Test/scenario fixtures that build a bare professionless Agent leave it
    // false, so they stay inert (no kit, no auto-work) exactly as before.
    this.townsperson = !!cfg.townsperson;
    this._trade = null;
    if (this.townsperson && this.autonomous && !this.combatant) {
      for (const c in STARTER_KIT) this.inventory[c] = STARTER_KIT[c];
      this.recipes = seedRecipesFor(null);   // a working townsperson can craft any gated good today
    } else if (this.profession) {
      // legacy path: an explicitly-professioned agent (test fixtures) keeps the
      // old kit so scenario tests that pass a profession still behave.
      const prof = PROFESSIONS_T[this.profession];
      this.inventory[prof.output] = ECON.startStock;
      this.inventory.food = Math.max(this.inventory.food, 2);
      this.inventory.tool = 1;
      if (prof.inputs) for (const c in prof.inputs) this.inventory[c] = 2;
      this._trade = prof.output;
      this.recipes = seedRecipesFor(prof.output);   // born knowing at least its own craft
    }
    trade.seedStash(this);          // deterministic purse→stash split per WEALTH config (no-op while disabled)

    // RPG: class/level/XP brain — built for EVERY agent (townsfolk, monsters,
    // the player). Progression is profession-agnostic: it only ever sees the
    // ActionEvents we emit, so a null profession just produces fewer deeds.
    this.progression = new Progression(this);
    this._rpgNow = 0;          // sim time stamped each decide(); used as event t
    this._produceAccum = 0;    // emit one produce ActionEvent per WHOLE unit

    // Known abilities (id -> AbilitySpec). Empty for everyone at construction;
    // milestone grants / explicit player grants fill this. ALWAYS a Map so the
    // cast path is safe for professionless / ability-less agents (the freeze
    // lesson: never touch profession/economy assumptions for monsters/player).
    this.abilities = new Map();

    // emergent-occupation townsfolk work; explicitly-professioned fixtures also
    // work (legacy). Monsters, the player and bare professionless fixtures don't.
    this.canWork = (this.autonomous && !this.combatant && this.faction !== 'monster')
      && (this.townsperson || !!this.profession);
    this.goal = { kind: this.canWork ? 'work' : 'wander' };
    // Phase-2a buildings: the agent's home is now KNOWN ONLY THROUGH BELIEF — homeBeliefId
    // is the percept id of the building it has perceived as its own home (discovered by
    // sight, set in perception.js; null until it lays eyes on its finished home). The old
    // truth-side `this.home = Building` was the world writing cognition state (telepathy);
    // retired in Phase 2a so the agent must DISCOVER its home's loss by perception (the
    // homecoming). _buildSiteId is the build site it is committed to; _comfortLowSince the
    // chronic-low-comfort streak start (the demand signal qualifyHome reads). _buildAccum
    // batches build deeds.
    this.homeBeliefId = null;    // percept id of the building I believe is my home (belief-backed)
    this._buildSiteId = null;    // committed BuildSite id while building
    this._comfortLowSince = null;// sim-time comfort first dipped below qualify (chronic-demand streak)
    this._buildAccum = 0;        // fractional build progress awaiting a deed emit
    this.wanderTarget = null;
    this._tradeFlash = 0;

    // Goal stack (Phase 2): structured, memory-derived intentions between the
    // slow ambition and the per-tick reflex. The TOP goal is PLANNED into
    // primitives (planner.js) over BELIEFS; the current step is injected as a
    // high-priority candidate in decide() (it never dictates — reflexes can win
    // and the plan resumes). LIFO, bounded depth (PLAN.stackDepth). Each goal
    // carries a cached { plan, step } so we plan rarely and replan on failure.
    this.goals = [];
    // received-flags set by the give/pay executor: agent._repaid[toId] = true
    // when a transfer to that benefactor lands. goalRepay's predicate reads this.
    this._repaid = {};

    // SELF-ENGAGEMENT tally (lazy; null until I land my first blow) — how many times I've
    // struck each target, keyed on the TARGET id (a real agent OR an inert prop). This is
    // MY OWN action count (own-state), written by the combatEvents bridge on a landed blow
    // and read by schema #6's selfEngaged(): repeated strikes with zero observed animacy on
    // the target's belief is what lets me reason a believed-foe is actually inert. Bounded
    // to SCHEMA.strikeLogCap (evict the stalest `first`); read by nothing on the combat path.
    this.strikeLog = null;

    // lifetime tallies that feed longer-term ambitions (monster kills, distance
    // roamed, time spent socialising). Cheap counters incremented on the hot
    // path; read by motivation.js to measure ambition progress.
    this.life = { kills: 0, monsterKills: 0, dist: 0, social: 0 };
    // REASONING-COST counters (Phase 3 — measurement only; read truth-side in depthMetrics,
    // never inside cognition). Per-tick rates (_decideCalls/_decideCands/_planReplans/
    // _schemaFireCount) are zeroed by the scheduler at the start of each fixed tick and
    // overwritten by reason/decide for the agents that run; a skipped (amortized) agent
    // therefore reads 0 — the metric MEASURES the LOD win. _planDepth is a last-write-wins
    // gauge (read as a max), not a rate. All degrade to 0 if absent (the freeze lesson).
    this._decideCalls = 0;     // =1 each tick decide() runs
    this._decideCands = 0;     // # utility candidates scored this tick
    this._planReplans = 0;     // # plan (re)plans this tick
    this._planDepth = 0;       // length of the freshest plan (gauge)
    // LOD scheduling state (Phase 3 — written by the Simulation scheduler/cognition; read
    // truth-side in _isRelevant). _lodTick is the per-agent stride counter; _lastGoalChangeAt
    // + _prevGoalKind back the recent-state-change hysteresis signal.
    this._lodTick = 0;
    this._lastGoalChangeAt = 0;
    this._prevGoalKind = this.goal && this.goal.kind;
    this.ambition = null;
    assignAmbition(this, 0);          // a persistent drive (no-op for the player)

    // episodic (autobiographical) memory: the salient things that happen to ME,
    // in three consolidating ring buffers. Fed from the event bus + combat hooks
    // (Simulation), read by the inspector biography. See js/sim/memory.js.
    this.memory = new Memory();

    // REASONING TRACE: a bounded per-agent ring of *why I acted this tick*. WRITTEN BY
    // cognition (own-view), NEVER read back by a decision — read only by the UI/tests.
    // Cheap structured entries; the string is built lazily on read (traceLabel). See
    // js/sim/trace.js + docs/reasoning-traces.md.
    this.trace = new Trace();   // EPISTEMIC-OK: field init (write), not a trace read

    this._buildDecor();
  }

  get pos(): import('three').Vector3 { return this.fighter.root.position; }
  get alive(): boolean { return this.fighter.alive; }
  // is this agent driven by the SIM (its own AI), vs a human at the controls? This
  // is the ONE legitimate player/NPC distinction in system code: an autonomous agent
  // runs the decide/act/perceive stack; a controlled one is moved by input. Systems
  // address agents by this semantic property, never by "is the player".
  get autonomous(): boolean { return !this.controlled; }

  // --- abilities (safe no-ops when the agent knows nothing) -----------------
  grantAbility(specObj: AbilitySpec): void { if (specObj && specObj.id) this.abilities.set(specObj.id, specObj); }
  knowsAbility(id: string): boolean { return this.abilities.has(id); }
  abilityList(): AbilitySpec[] { return [...this.abilities.values()]; }   // stable order for key binding

  // The agent's BELIEF about its own home (a BeliefState with placeKind:'home' + a believed
  // `sheltered`), or null if it has never perceived/learned of a home. Cognition reads ONLY
  // this belief — never a truth-side Building handle — so it acts on what it KNOWS: a stale
  // "intact" belief survives until perception (or, later, gossip) revises it. Guarded.
  homeBelief(): BeliefState | null {
    return this.homeBeliefId != null ? this.beliefs.get(this.homeBeliefId) : null;
  }

  // Total liquid wealth I own (carried purse + banked stash) — for conservation
  // summers and UI only. Cognition never reads this (it acts on the purse it can
  // spend). Own-state; guarded (stash is always 0+ on every agent from the ctor).
  totalWealth(): number { return (this.gold || 0) + (this.stash || 0); }

  // A townsperson's colour now emerges from WHAT IT DOES, not a birthright trade:
  // its currently-chosen good's colour, else the dominant deed-tag's good colour,
  // else its faction colour. So a town reads as a spread of trades again even
  // though nobody is born into one. Guarded — never throws.
  profColor(): number { return decor.profColor(this); }

  // Pick a colour from the agent's strongest production-related behaviour tag:
  // find the good whose tags it has accumulated the most of. Read-only; null if
  // it has no producing history yet.
  _dominantGoodColor(): number | null { return decor.dominantGoodColor(this); }

  drainNeeds(dt: number): void {
    this.needs.hunger = clamp01(this.needs.hunger - SIM.hungerDrain * dt);
    this.needs.energy = clamp01(this.needs.energy - SIM.energyDrain * dt);
    // PERSONALITY LIVES THROUGH THE NEEDS: the social and novelty drains scale with the matching
    // trait (×0.35..×1.65, neutral 0.5 → ×1), so a gregarious soul gets lonely — and a curious one
    // bored — up to ~5× faster than its opposite. The need deficit is what FIRES the socialize/
    // sightsee candidates, so trait → need-pressure → visible habit is a structural chain
    // (score-only multipliers proved too weak: the candidate rarely existed to be scaled).
    const Pd = this.personality || {};
    this.needs.social = clamp01(this.needs.social - SIM.socialDrain * (0.35 + 1.3 * (Pd.social_drive ?? 0.5)) * dt);
    // NOVELTY drains too (boredom builds) — relieved by sightseeing (act.sightseeStep).
    if (NOVELTY.enabled) this.needs.novelty = clamp01((this.needs.novelty ?? 1) - SIM.noveltyDrain * (0.35 + 1.3 * (Pd.curiosity ?? 0.5)) * dt);
    // MASTERY does NOT drain — a learned craft stays learned. Commitment compounds over a
    // lifetime: a specialist's edge only ever grows, and a long-practised trade is a
    // permanent moat newcomers must out-WORK (not just out-wait) to rival.
    // COMFORT: a 4th need (Phase-1 buildings). An UNHOUSED agent's comfort is
    // capped LOW each tick — that ceiling is the standing demand pressure that
    // makes building a home worthwhile. A housed agent (this.home set) has no cap.
    if (COMFORT.enabled) {
      this.needs.comfort = clamp01((this.needs.comfort ?? 1) - COMFORT.drain * dt);
      // UNHOUSED CAP — now belief-backed (homeBelief): an agent that holds no believed-intact
      // home is capped low (the demand pressure). A torched home it has DISCOVERED (sheltered
      // belief flipped false by perception) re-caps it, exactly as losing the truth-side home
      // used to — but only once the agent has actually SEEN/heard of the loss.
      const hb = this.homeBelief();
      if ((!hb || hb.sheltered === false) && this.needs.comfort > COMFORT.unhousedCap)
        this.needs.comfort = COMFORT.unhousedCap;
      // chronic-demand streak: track how long comfort has sat at/below the qualify
      // line (read by qualifyHome via _comfortLowSince). Only working townsfolk bother.
      if (this.canWork && this.needs.comfort <= BUILD.qualifyComfort) {
        if (this._comfortLowSince == null) this._comfortLowSince = this._rpgNow;
      } else {
        this._comfortLowSince = null;
      }
    }
    this.mood.fear = Math.max(0, this.mood.fear - 0.4 * dt);
    this.mood.anger = Math.max(0, this.mood.anger - 0.3 * dt);
    if (this._tradeFlash > 0) this._tradeFlash -= dt;
  }

  // Record that I landed a blow on `targetId` (own-state, written by the combatEvents
  // bridge). Lazily allocates the bounded log; evicts the stalest `first` entry when over
  // SCHEMA.strikeLogCap so the table can't grow unbounded. Read only by schema #6's
  // selfEngaged() — nothing on the combat/cast path reads it, so eviction never changes
  // combat output. Guarded; never throws on the tick.
  _logStrike(targetId: EntityId | null, now: number): void {
    try {
      if (targetId == null) return;
      if (!this.strikeLog) this.strikeLog = new Map();
      const rec = this.strikeLog.get(targetId);
      if (rec) { rec.count += 1; return; }
      const cap = (SCHEMA && SCHEMA.strikeLogCap) || 8;
      if (this.strikeLog.size >= cap) {
        let stalestId: EntityId | null = null, stalest = Infinity;
        for (const [id, r] of this.strikeLog) { if (r.first < stalest) { stalest = r.first; stalestId = id; } }
        if (stalestId != null) this.strikeLog.delete(stalestId);
      }
      this.strikeLog.set(targetId, { count: 1, first: now || 0 });
    } catch { /* never throw on the tick */ }
  }

  // do I treat this belief's subject as hostile? (believed faction, or latched)
  // A belief I've REVISED to "proven inert" (schema #6 `no-threat-no-response`: I struck
  // it repeatedly and it never moved/struck/blocked/harmed me) overrides BOTH the latched
  // and the faction prior — by my own accumulated evidence it is no threat (a scarecrow, a
  // corpse, a statue), so I stop treating its bandit costume as a reason to fight. Own-
  // belief read only (the `inert` flag is written by the reasoning interpreter over my
  // beliefs); the epistemic split holds.
  considerHostile(b: BeliefState | null): boolean {
    if (!b || b.inert) return false;
    return b.hostile || factionHostile(this.faction, b.lastFaction);
  }
  // Nearest believed-hostile I'm confident enough to act on — returned as a BELIEF-
  // REFERENCE handle { id, pos, faction }, NOT the real object. This is the epistemic
  // split made total: selection AND positioning come from the belief (lastPos), never
  // ground truth, and true liveness is NOT read — a belief faded below the act threshold
  // IS "I've lost track" (perception re-confirms it or decay drops it). So an agent will
  // hunt a foe that has moved, fallen, or is really a scarecrow; reality is resolved only
  // by perception (in) and geometric combat (out), and a wrong belief simply misses.
  // `ctx` kept for signature symmetry (callers pass it); intentionally unused now.
  _nearestHostile(_ctx: CognitionCtx | null): HostileRef | null {
    let best: BeliefState | null = null, bd = Infinity;
    for (const b of this.beliefs.all()) {
      if (b.confidence < SIM.actOnBeliefMin || !this.considerHostile(b)) continue;
      const d = this.pos.distanceTo(b.lastPos);
      if (d < bd) { bd = d; best = b; }
    }
    return best ? { id: best.subjectId, pos: best.lastPos, faction: best.lastFaction, belief: best } : null;
  }

  // --- Theory-of-Mind passes (run by Simulation each 6Hz tick) ---------------
  // perceive: sight of nearby agents writes high-confidence beliefs (the player
  // is just another subject, so NPCs naturally form beliefs about you).
  perceive(ctx: FullCtx): void { return perception.perceive(this, ctx); }

  // gossip: adopt a nearby ally's more-certain beliefs (carries standing too).
  gossipBeliefs(ctx: FullCtx): void { return perception.gossipBeliefs(this, ctx); }

  // --- price beliefs (the economic ToM) -------------------------------------
  learnPrice(c: string, price: number, w: number): void { return trade.learnPrice(this, c, price, w); }

  // drift toward a chatting neighbour's prices — how rumoured prices spread
  priceGossip(ctx: CognitionCtx, dt: number): void { return trade.priceGossip(this, ctx, dt); }

  // --- trade interface (used by the market in simulation.js) ----------------
  keepOf(c: string): number { return trade.keepOf(this, c); }
  surplus(c: string): number { return trade.surplus(this, c); }
  hasSurplus(c: string): boolean { return trade.hasSurplus(this, c); }

  // The recipe inputs of the good this agent is currently making (or null).
  _tradeInputs(): Record<string, number> | null { return trade.tradeInputs(this); }

  // units this agent wants to buy / can sell of c (for the standing-order book).
  // Off profession now: everyone buys food (always) + a tool/potion if they hold
  // none + the inputs for whatever good they are CURRENTLY making.
  wantQty(c: string): number { return trade.wantQty(this, c); }
  sellQty(c: string): number { return trade.sellQty(this, c); }
  askPrice(c: string): number { return trade.askPrice(this, c); }
  bidPrice(c: string): number { return trade.bidPrice(this, c); }   // can't bid more than you hold

  applyBuy(c: string, price: number): void { return trade.applyBuy(this, c, price); }
  applySell(c: string, price: number): void { return trade.applySell(this, c, price); }

  // --- decision -------------------------------------------------------------
  decide(ctx: CognitionCtx): void { return decision.decide(this, ctx); }

  // --- emergent occupation chooser -----------------------------------------
  // Pick the good this agent will produce/gather this work stint.
  chooseOccupation(ctx: CognitionCtx): void { return occupation.chooseOccupation(this, ctx); }

  // The good whose tags the agent's strongest class is built from (for the
  // mastery ambition's "reinforce my identity" bias). Read-only.
  _strongestClassGood(): string | null { return occupation.strongestClassGood(this); }

  // --- goal stack + plan caching -------------------------------------------
  // Push a goal (dedup by kind+subject/place, LIFO, depth-bounded). Returns the
  // pushed/existing goal. Never throws.
  pushGoal(goal: Goal, ctx: CognitionCtx | FullCtx | null): Goal | null {
    if (!goal || !goal.kind) return null;
    if (!Array.isArray(this.goals)) this.goals = [];
    const key = (g: Goal): string => `${g.kind}|${g.subjectId ?? ''}|${g.place ?? ''}`;
    const k = key(goal);
    const existing = this.goals.find((g) => key(g) === k);
    if (existing) return existing;                  // dedup
    goal.bornAt = ctx ? ctx.time : 0;
    goal.plan = null; goal.step = 0;                // cached lazily on first decide
    this.goals.push(goal);
    // depth cap: drop the OLDEST/lowest (bottom of stack) so the stack drains
    while (this.goals.length > PLAN.stackDepth) this.goals.shift();
    return goal;
  }

  // Return the primitive the TOP goal currently wants executed (or null). Plans
  // lazily, caches the plan on the goal, replans when the next step lost its
  // preconditions or the cache is stale. Belief-grounded; guarded; never throws.
  _currentPlanStep(ctx: CognitionCtx): PlanStep | null {
    if (!Array.isArray(this.goals) || !this.goals.length) return null;
    const goal = this.goals[this.goals.length - 1];   // top of stack
    if (!goal) return null;
    try {
      // already satisfied? leave it for act()'s pop (predicate checked there too)
      if (typeof goal.predicate === 'function' && goal.predicate(this, ctx)) return null;

      // plan-less goals (grief) have no actionable atoms — they are dispositions
      // that simply run their course (popped by expiresAt in pruneGoals). Never
      // mark them unreachable, never inject a plan step; just let them sit.
      if (Array.isArray(goal.atoms) && goal.atoms.length === 0) return null;

      // a stack goal's `step` is the numeric pointer (PlanStep variant is only the
      // injected 'plan' candidate goal — never a goal on this.goals stack).
      let ptr = (typeof goal.step === 'number') ? goal.step : 0;
      // (re)plan if no cache, the step pointer ran off the end, or the next
      // step's preconditions no longer hold (market emptied, gold spent, moved).
      const needPlan = !goal.plan || !goal.plan.steps ||
        ptr >= goal.plan.steps.length ||
        !stepPrecondsHold(this, ctx, goal.plan.steps[ptr]);
      if (needPlan) {
        // PHASE 1 (docs/architecture/10): an UNREACHABLE numeric-threshold goal rests on a
        // brief cooldown rather than re-planning every tick — the anti-livelock the doc names.
        // The drive persists in motivation (not on the goal) and rebuilds, so the agent retries
        // when the cooldown lapses or a new lead arrives. Off (no partial plan ever) → the field
        // is never set and this is a no-op, so the path stays byte-identical.
        if (goal._cooldownUntil != null && ctx.time < goal._cooldownUntil) return null;
        const fresh = planGoal(this, goal, ctx);
        if (!fresh) { goal._unreachable = true; return null; }   // pruneGoals drops it
        goal.plan = fresh; goal.step = 0; ptr = 0; goal._unreachable = false;
        // a PARTIAL (satisfice) plan ran what it could toward the threshold; cool the goal so
        // the still-unreached target isn't hammered every tick. PLAN.partialCooldown is the rest.
        if (fresh.partial) goal._cooldownUntil = ctx.time + PLAN.partialCooldown;
        // REASONING-COST (Phase 3, measurement only): tally this replan + the fresh plan's
        // depth. Own-scalar writes; read truth-side in depthMetrics. Degrade-safe.
        this._planReplans = (this._planReplans || 0) + 1;
        this._planDepth = (fresh.steps && fresh.steps.length) || 0;
      }
      return goal.plan!.steps[ptr] || null;
    } catch { return null; }
  }

  // companion decision: defend the leader. Engage a believed-hostile within
  // vision of me OR of the leader; otherwise keep formation (goal 'follow').
  // the anchor this agent follows/defends: its band leader, set EXPLICITLY by
  // whatever banded it (Party/warband/escort). No universal fallback to the player
  // — an agent follows the player only via an explicit bandLeaderId. Null-safe.
  // The leader handle for the EXECUTION movement/defend path. The ONLY live handle
  // cognition may hold is the controlled player-led party's leader, supplied via the
  // documented ctx.partyLeader exception (a known game mechanic). For an NPC band the
  // leader is resolved off belief (decideParty / followLeader read belief.lastPos), so
  // this returns null for them and the belief path takes over. Null-safe.
  _leader(ctx: CognitionCtx): Agent | null {
    const pl = ctx && ctx.partyLeader;            // EPISTEMIC-OK: controlled party leader (known mechanic)
    // partyLeader is the shared Agent shape; at runtime it is a full Agent instance.
    if (pl && this.bandLeaderId === pl.id) return pl as Agent;
    return null;
  }

  _decideParty(ctx: CognitionCtx): void { return decision.decideParty(this, ctx); }

  // --- act ------------------------------------------------------------------
  act(dt: number, ctx: CognitionCtx): void { return action.act(this, dt, ctx); }

  // --- controlled execution (the single avatar the player drives) -----------
  // The controlled agent does NOT run decide()/act(); the Commander sets .goal
  // from mouse orders and calls this each frame. We reuse the very same movement
  // and combat primitives the NPC AI uses, so the body behaves consistently and
  // there's no second combat path to keep in sync.
  actControlled(dt: number, ctx: CognitionCtx): void { return action.actControlled(this, dt, ctx); }

  // Make the agent's CHOSEN good (this._trade). Generalized off profession: a
  // crafted good (inputs present) converts inputs->output on a timer; a raw good
  // accrues over time, tool-boosted + tool-wearing. Guarded: a missing/invalid
  // trade is a no-op (never throws on the tick — the freeze lesson).
  _produce(dt: number): void { return action.produce(this, dt); }

  _goTo(target: { x: number; z: number; y?: number }, dt: number, run = false): boolean { return movement.goTo(this, target, dt, run); }

  // settle the body onto the terrain surface so agents walk the hills, not a
  // flat plane. Overworld only (dungeon dwellers / party-followers keep their
  // own y via roam/teleport, so we skip when a roam centre or party y is owned).
  // Browser-visual + headless-harmless (height is a pure function). Guarded.
  _groundY(): void { return movement.groundY(this); }

  // The named place this agent is at/near (or null) — for biography/dialogue
  // flavour ("near Highcairn"). Read-only, guarded, never throws on the tick.
  nearbyLandmark(maxR = 28): { name: string; x: number; z: number; kind: string } | null {
    try { return nearestLandmark(this.pos.x, this.pos.z, maxR); } catch { return null; }
  }

  // close on a believed-hostile target and trade directional blows (reuses the
  // Fighter swing state machine, telegraphed like the old enemy AI).
  _combatStep(dt: number, ctx: CognitionCtx): void { return action.combatStep(this, dt, ctx); }

  // --- NPC ability casting --------------------------------------------------
  // Try to bring an OFFENSIVE ability to bear on `target`, at `dist` meters.
  _tryCastAbility(target: Agent, dist: number, ctx: CognitionCtx): boolean { return action.tryCastAbility(this, target, dist, ctx); }

  // Pick the best READY offensive spec for the current engagement.
  _bestOffensiveAbility(dist: number, now: number): AbilitySpec | null { return action.bestOffensiveAbility(this, dist, now); }

  // A spec's offensive weight: damage plus a small credit for control effects.
  _offensivePower(spec: AbilitySpec): number { return action.offensivePower(spec); }

  // --- plan-step execution (Phase 2) ---------------------------------------
  // Run the current primitive of the top goal.
  _execPlanStep(dt: number, ctx: CognitionCtx): void { return action.execPlanStep(this, dt, ctx); }

  _execPrimitive(step: PlanStep, dt: number, ctx: CognitionCtx): void { return action.execPrimitive(this, step, dt, ctx); }

  // walk to the market, then trade ONE unit of the bind good against the nearest
  // willing townsperson there (conservation-safe).
  _marketStep(step: PlanStep, dt: number, ctx: CognitionCtx): void { return action.marketStep(this, step, dt, ctx); }

  // give item×n to a benefactor: walk over then MOVE the goods (no minting).
  _giveStep(b: PlanStep['bind'], dt: number, ctx: CognitionCtx): void { return action.giveStep(this, b, dt, ctx); }

  // pay amt coin to a benefactor: walk over, then MOVE gold (no minting).
  _payStep(b: PlanStep['bind'], dt: number, ctx: CognitionCtx): void { return action.payStep(this, b, dt, ctx); }

  // _fleeFrom / _followLeader retired (Phase 2b): flee and follow are now steer-fills
  // (fillFlee / fillFollow in agent/steer.js), motored by the single steer() executor.

  // --- decoration -----------------------------------------------------------
  _buildDecor(): void { return decor.buildDecor(this); }

  _updateLabel(): void { return decor.updateLabel(this); }

  setLabelVisible(v: boolean): void { return decor.setLabelVisible(this, v); }
}
