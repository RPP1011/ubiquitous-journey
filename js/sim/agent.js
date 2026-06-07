// An economic Agent: a profession, an inventory + gold, needs, and PRICE
// BELIEFS it uses to trade. Each tick it decides (utility over needs + economy)
// and acts: work at its site to produce, eat from its stock, or go to market to
// buy/sell. Price beliefs update from trades and drift toward chatting
// neighbours (gossip) — the economic belief surface.

import { nearestLandmark } from '../arena.js';
import { BeliefStore } from './beliefs.js';
import {
  PROFESSIONS, COMMODITIES, BASE_PRICE, ECON,
  SIM, COMFORT, BUILD, NOVELTY, SCHEMA, WEALTH,
  factionHostile,
} from './simconfig.js';
import { Progression } from '../rpg/progression.js';
import { assignAmbition } from './motivation.js';
import { Memory } from './memory.js';
import { plan as planGoal, PLAN, stepPrecondsHold } from './planner.js';
import * as trade from './agent/trade.js';
import * as decor from './agent/decor.js';
import * as perception from './agent/perception.js';
import * as movement from './agent/movement.js';
import * as action from './agent/act.js';
import * as decision from './agent/decide.js';
import * as occupation from './agent/occupation.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const rand = (a, b) => a + Math.random() * (b - a);

export class Agent {
  constructor(fighter, cfg) {
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
    this._attackCd = Math.random() * 1.5;
    // NPC ability cadence: a short reflex gap between cast ATTEMPTS so an NPC
    // doesn't probe its whole ability list every fixed tick. The interpreter owns
    // the real per-ability cooldown; this just paces the attempt. Staggered start.
    this._castCd = Math.random() * 1.5;

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
    this.priceBeliefs = {};
    for (const c of COMMODITIES) this.priceBeliefs[c] = +(BASE_PRICE[c] * rand(0.8, 1.2)).toFixed(2);

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
      for (const c in ECON.starterKit) this.inventory[c] = ECON.starterKit[c];
    } else if (this.profession) {
      // legacy path: an explicitly-professioned agent (test fixtures) keeps the
      // old kit so scenario tests that pass a profession still behave.
      const prof = PROFESSIONS[this.profession];
      this.inventory[prof.output] = ECON.startStock;
      this.inventory.food = Math.max(this.inventory.food, 2);
      this.inventory.tool = 1;
      if (prof.inputs) for (const c in prof.inputs) this.inventory[c] = 2;
      this._trade = prof.output;
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
    this.ambition = null;
    assignAmbition(this, 0);          // a persistent drive (no-op for the player)

    // episodic (autobiographical) memory: the salient things that happen to ME,
    // in three consolidating ring buffers. Fed from the event bus + combat hooks
    // (Simulation), read by the inspector biography. See js/sim/memory.js.
    this.memory = new Memory();

    this._buildDecor();
  }

  get pos() { return this.fighter.root.position; }
  get alive() { return this.fighter.alive; }
  // is this agent driven by the SIM (its own AI), vs a human at the controls? This
  // is the ONE legitimate player/NPC distinction in system code: an autonomous agent
  // runs the decide/act/perceive stack; a controlled one is moved by input. Systems
  // address agents by this semantic property, never by "is the player".
  get autonomous() { return !this.controlled; }

  // --- abilities (safe no-ops when the agent knows nothing) -----------------
  grantAbility(specObj) { if (specObj && specObj.id) this.abilities.set(specObj.id, specObj); }
  knowsAbility(id) { return this.abilities.has(id); }
  abilityList() { return [...this.abilities.values()]; }   // stable order for key binding

  // The agent's BELIEF about its own home (a BeliefState with placeKind:'home' + a believed
  // `sheltered`), or null if it has never perceived/learned of a home. Cognition reads ONLY
  // this belief — never a truth-side Building handle — so it acts on what it KNOWS: a stale
  // "intact" belief survives until perception (or, later, gossip) revises it. Guarded.
  homeBelief() {
    return this.homeBeliefId != null ? this.beliefs.get(this.homeBeliefId) : null;
  }

  // Total liquid wealth I own (carried purse + banked stash) — for conservation
  // summers and UI only. Cognition never reads this (it acts on the purse it can
  // spend). Own-state; guarded (stash is always 0+ on every agent from the ctor).
  totalWealth() { return (this.gold || 0) + (this.stash || 0); }

  // A townsperson's colour now emerges from WHAT IT DOES, not a birthright trade:
  // its currently-chosen good's colour, else the dominant deed-tag's good colour,
  // else its faction colour. So a town reads as a spread of trades again even
  // though nobody is born into one. Guarded — never throws.
  profColor() { return decor.profColor(this); }

  // Pick a colour from the agent's strongest production-related behaviour tag:
  // find the good whose tags it has accumulated the most of. Read-only; null if
  // it has no producing history yet.
  _dominantGoodColor() { return decor.dominantGoodColor(this); }

  drainNeeds(dt) {
    this.needs.hunger = clamp01(this.needs.hunger - SIM.hungerDrain * dt);
    this.needs.energy = clamp01(this.needs.energy - SIM.energyDrain * dt);
    this.needs.social = clamp01(this.needs.social - SIM.socialDrain * dt);
    // NOVELTY drains too (boredom builds) — relieved by sightseeing (act.sightseeStep).
    if (NOVELTY.enabled) this.needs.novelty = clamp01((this.needs.novelty ?? 1) - SIM.noveltyDrain * dt);
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
  _logStrike(targetId, now) {
    try {
      if (targetId == null) return;
      if (!this.strikeLog) this.strikeLog = new Map();
      let rec = this.strikeLog.get(targetId);
      if (rec) { rec.count += 1; return; }
      const cap = (SCHEMA && SCHEMA.strikeLogCap) || 8;
      if (this.strikeLog.size >= cap) {
        let stalestId = null, stalest = Infinity;
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
  considerHostile(b) {
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
  _nearestHostile(_ctx) {
    let best = null, bd = Infinity;
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
  perceive(ctx) { return perception.perceive(this, ctx); }

  // gossip: adopt a nearby ally's more-certain beliefs (carries standing too).
  gossipBeliefs(ctx) { return perception.gossipBeliefs(this, ctx); }

  // --- price beliefs (the economic ToM) -------------------------------------
  learnPrice(c, price, w) { return trade.learnPrice(this, c, price, w); }

  // drift toward a chatting neighbour's prices — how rumoured prices spread
  priceGossip(ctx, dt) { return trade.priceGossip(this, ctx, dt); }

  // --- trade interface (used by the market in simulation.js) ----------------
  keepOf(c) { return trade.keepOf(this, c); }
  surplus(c) { return trade.surplus(this, c); }
  hasSurplus(c) { return trade.hasSurplus(this, c); }

  // The recipe inputs of the good this agent is currently making (or null).
  _tradeInputs() { return trade.tradeInputs(this); }

  // units this agent wants to buy / can sell of c (for the standing-order book).
  // Off profession now: everyone buys food (always) + a tool/potion if they hold
  // none + the inputs for whatever good they are CURRENTLY making.
  wantQty(c) { return trade.wantQty(this, c); }
  sellQty(c) { return trade.sellQty(this, c); }
  askPrice(c) { return trade.askPrice(this, c); }
  bidPrice(c) { return trade.bidPrice(this, c); }   // can't bid more than you hold

  applyBuy(c, price) { return trade.applyBuy(this, c, price); }
  applySell(c, price) { return trade.applySell(this, c, price); }

  // --- decision -------------------------------------------------------------
  decide(ctx) { return decision.decide(this, ctx); }

  // --- emergent occupation chooser -----------------------------------------
  // Pick the good this agent will produce/gather this work stint.
  chooseOccupation(ctx) { return occupation.chooseOccupation(this, ctx); }

  // The good whose tags the agent's strongest class is built from (for the
  // mastery ambition's "reinforce my identity" bias). Read-only.
  _strongestClassGood() { return occupation.strongestClassGood(this); }

  // --- goal stack + plan caching -------------------------------------------
  // Push a goal (dedup by kind+subject/place, LIFO, depth-bounded). Returns the
  // pushed/existing goal. Never throws.
  pushGoal(goal, ctx) {
    if (!goal || !goal.kind) return null;
    if (!Array.isArray(this.goals)) this.goals = [];
    const key = (g) => `${g.kind}|${g.subjectId ?? ''}|${g.place ?? ''}`;
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
  _currentPlanStep(ctx) {
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

      // (re)plan if no cache, the step pointer ran off the end, or the next
      // step's preconditions no longer hold (market emptied, gold spent, moved).
      const needPlan = !goal.plan || !goal.plan.steps ||
        goal.step >= goal.plan.steps.length ||
        !stepPrecondsHold(this, ctx, goal.plan.steps[goal.step]);
      if (needPlan) {
        const fresh = planGoal(this, goal, ctx);
        if (!fresh) { goal._unreachable = true; return null; }   // pruneGoals drops it
        goal.plan = fresh; goal.step = 0; goal._unreachable = false;
      }
      return goal.plan.steps[goal.step] || null;
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
  _leader(ctx) {
    const pl = ctx && ctx.partyLeader;            // EPISTEMIC-OK: controlled party leader (known mechanic)
    if (pl && this.bandLeaderId === pl.id) return pl;
    return null;
  }

  _decideParty(ctx) { return decision.decideParty(this, ctx); }

  // --- act ------------------------------------------------------------------
  act(dt, ctx) { return action.act(this, dt, ctx); }

  // --- controlled execution (the single avatar the player drives) -----------
  // The controlled agent does NOT run decide()/act(); the Commander sets .goal
  // from mouse orders and calls this each frame. We reuse the very same movement
  // and combat primitives the NPC AI uses, so the body behaves consistently and
  // there's no second combat path to keep in sync.
  actControlled(dt, ctx) { return action.actControlled(this, dt, ctx); }

  // Make the agent's CHOSEN good (this._trade). Generalized off profession: a
  // crafted good (inputs present) converts inputs->output on a timer; a raw good
  // accrues over time, tool-boosted + tool-wearing. Guarded: a missing/invalid
  // trade is a no-op (never throws on the tick — the freeze lesson).
  _produce(dt) { return action.produce(this, dt); }

  _goTo(target, dt, run = false) { return movement.goTo(this, target, dt, run); }

  // settle the body onto the terrain surface so agents walk the hills, not a
  // flat plane. Overworld only (dungeon dwellers / party-followers keep their
  // own y via roam/teleport, so we skip when a roam centre or party y is owned).
  // Browser-visual + headless-harmless (height is a pure function). Guarded.
  _groundY() { return movement.groundY(this); }

  // The named place this agent is at/near (or null) — for biography/dialogue
  // flavour ("near Highcairn"). Read-only, guarded, never throws on the tick.
  nearbyLandmark(maxR = 28) {
    try { return nearestLandmark(this.pos.x, this.pos.z, maxR); } catch { return null; }
  }

  // close on a believed-hostile target and trade directional blows (reuses the
  // Fighter swing state machine, telegraphed like the old enemy AI).
  _combatStep(dt, ctx) { return action.combatStep(this, dt, ctx); }

  // --- NPC ability casting --------------------------------------------------
  // Try to bring an OFFENSIVE ability to bear on `target`, at `dist` meters.
  _tryCastAbility(target, dist, ctx) { return action.tryCastAbility(this, target, dist, ctx); }

  // Pick the best READY offensive spec for the current engagement.
  _bestOffensiveAbility(dist, now) { return action.bestOffensiveAbility(this, dist, now); }

  // A spec's offensive weight: damage plus a small credit for control effects.
  _offensivePower(spec) { return action.offensivePower(spec); }

  // --- plan-step execution (Phase 2) ---------------------------------------
  // Run the current primitive of the top goal.
  _execPlanStep(dt, ctx) { return action.execPlanStep(this, dt, ctx); }

  _execPrimitive(step, dt, ctx) { return action.execPrimitive(this, step, dt, ctx); }

  // walk to the market, then trade ONE unit of the bind good against the nearest
  // willing townsperson there (conservation-safe).
  _marketStep(step, dt, ctx) { return action.marketStep(this, step, dt, ctx); }

  // give item×n to a benefactor: walk over then MOVE the goods (no minting).
  _giveStep(b, dt, ctx) { return action.giveStep(this, b, dt, ctx); }

  // pay amt coin to a benefactor: walk over, then MOVE gold (no minting).
  _payStep(b, dt, ctx) { return action.payStep(this, b, dt, ctx); }

  // _fleeFrom / _followLeader retired (Phase 2b): flee and follow are now steer-fills
  // (fillFlee / fillFollow in agent/steer.js), motored by the single steer() executor.

  // --- decoration -----------------------------------------------------------
  _buildDecor() { return decor.buildDecor(this); }

  _updateLabel() { return decor.updateLabel(this); }

  setLabelVisible(v) { return decor.setLabelVisible(this, v); }
}
