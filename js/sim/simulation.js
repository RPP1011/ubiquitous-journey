// Simulation manager: spawns the professions, runs the fixed-rate decision pass
// and the market double-auction, and tracks emergent average prices. Peaceful —
// no combat — so the human can wander a working market town.

import * as THREE from 'three';
import { Fighter } from '../fighter.js';
import { Agent } from './agent.js';
import { PROFESSIONS, ROSTER, COMMODITIES, ECON, SIM, NAMES, MONSTER, factionHostile } from './simconfig.js';
import { ARENA_RADIUS } from '../arena.js';
import { bus, makeEvent } from '../rpg/events.js';
import { Reputation, REP } from './reputation.js';
import { QuestBoard } from '../quest/quest.js';

const rand = (a, b) => a + Math.random() * (b - a);

function makePersonality() {
  return {
    risk_tolerance: rand(0.2, 0.8),
    social_drive:   rand(0.2, 0.8),
    ambition:       rand(0.3, 0.9),
    altruism:       rand(0.2, 0.8),
    curiosity:      rand(0.2, 0.8),
  };
}

export class Simulation {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.agents = [];
    this.agentsById = new Map();
    this.time = 0;
    this._acc = 0;
    this._nextId = 1;
    this._names = NAMES.slice();
    this.tradesThisTick = 0;

    // RPG event router: every ActionEvent on the bus is delivered to the actor's
    // Progression. Progression's own self-emitted level/class/ability events
    // route too, but carry tags:[] so onEvent does no XP work (intended no-op).
    // The bus snapshots its listener list per emit(), so re-entrant emits from
    // inside onEvent are safe (no recursion blow-up) and listener errors are
    // swallowed by the bus.
    this._busOff = bus.on((ev) => {
      const a = this.agentsById.get(ev.actorId);
      if (a && a.progression) a.progression.onEvent(ev, ev.t || this.time);
    });

    // RPG reputation ledger (player-only). playerId is set later in addPlayer().
    this.reputation = new Reputation(null);

    // emergent quest board: reads live sim state, mints fetch/hunt/recover offers
    this.quests = new QuestBoard(this);
  }

  // unsubscribe the bus router (call if the Simulation is ever torn down so
  // listeners don't stack and multiply XP on a fresh instance).
  dispose() {
    if (this._busOff) { this._busOff(); this._busOff = null; }
    if (this.quests && this.quests.dispose) this.quests.dispose();
  }

  _takeName() {
    if (!this._names.length) return 'Unit' + this._nextId;
    return this._names.splice((Math.random() * this._names.length) | 0, 1)[0];
  }

  spawn() {
    const origin = new THREE.Vector3();
    for (const row of ROSTER) {
      for (let i = 0; i < row.n; i++) {
        const prof = PROFESSIONS[row.profession];
        const fighter = new Fighter(prof.model, {});
        const site = this.world.nearest(prof.site, origin);
        const base = site ? site.pos : origin;
        fighter.root.position.set(base.x + rand(-2.5, 2.5), 0, base.z + rand(-2.5, 2.5));
        this.scene.add(fighter.root);
        const agent = new Agent(fighter, {
          id: this._nextId++, name: this._takeName(),
          profession: row.profession, personality: makePersonality(),
          faction: 'townsfolk',
        });
        this.agents.push(agent);
        this.agentsById.set(agent.id, agent);
      }
    }

    // monsters lurking in the wilds (a corner away from the village)
    const wilds = new THREE.Vector3(ARENA_RADIUS * 0.8, 0, -ARENA_RADIUS * 0.8);
    for (let i = 0; i < MONSTER.count; i++) {
      const fighter = new Fighter(MONSTER.model, {});
      fighter.root.position.set(wilds.x + rand(-3, 3), 0, wilds.z + rand(-3, 3));
      this.scene.add(fighter.root);
      const m = new Agent(fighter, {
        id: this._nextId++, name: `${MONSTER.name} ${i + 1}`, profession: null,
        personality: makePersonality(), faction: MONSTER.faction,
        combatant: true, threat: MONSTER.threat,
      });
      this.agents.push(m);
      this.agentsById.set(m.id, m);
    }
  }

  addPlayer(fighter) {
    const agent = new Agent(fighter, {
      id: this._nextId++, name: 'You', profession: null,
      personality: makePersonality(), controlled: true, faction: 'outsider',
    });
    this.agents.push(agent);
    this.agentsById.set(agent.id, agent);
    this.player = agent;
    this.reputation.setPlayer(agent.id);
    return agent;
  }

  get fighters() { return this.agents.map((a) => a.fighter); }
  _ctx() { return { agents: this.agents, agentsById: this.agentsById, world: this.world, time: this.time }; }

  update(dt) {
    this.time += dt;
    this.world.update(dt);
    const ctx = this._ctx();

    for (const a of this.agents) {
      if (!a.alive) { a.setLabelVisible(false); continue; }
      if (!a.controlled) a.drainNeeds(dt);
    }

    this._acc += dt;
    const step = 1 / SIM.tickHz;
    let guard = 4;
    while (this._acc >= step && guard-- > 0) {
      this._acc -= step;
      // Theory-of-Mind passes: perceive -> decay -> gossip -> decide (decisions
      // read beliefs, never ground truth).
      for (const a of this.agents) a.perceive(ctx);
      for (const a of this.agents) a.beliefs.decay(step);
      for (const a of this.agents) a.gossipBeliefs(ctx);
      for (const a of this.agents) a.decide(ctx);
      this._runMarket();
      // RPG: behavior-profile decay + class matching on the same fixed-rate tick.
      for (const a of this.agents) a.progression.tick(this.time);
      // quest board: synth offers (throttled internally) + detect completions.
      // Guarded: board is a no-op when there are no townsfolk / no player yet.
      this.quests.refresh(step);
      this.quests.tick();
    }

    for (const a of this.agents) a.act(dt, ctx);
    // reputation drifts every frame (dt seconds): faction rollups fade toward
    // neutral, personal standings drift toward each NPC's faction bias.
    this.reputation.decay(dt, this.agents);
    if (this.player) this.player._updateLabel();
  }

  // Town-wide standing-order book (the spec's posted-Bid model): every agent
  // posts asks (surplus) and bids (wants, capped by gold) from wherever it is,
  // matched cheapest-ask to highest-bid at the midpoint. Beliefs learn toward
  // the realised clearing price; unfilled orders drift toward each other
  // (decentralised tatonnement) so prices converge to competitive levels.
  _runMarket() {
    this.tradesThisTick = 0;
    const traders = this.agents.filter((a) => a.alive && !a.controlled && a.profession);
    if (traders.length < 2) return;

    for (const c of COMMODITIES) {
      const sellers = traders.filter((a) => a.sellQty(c) > 0)
        .map((a) => ({ a, ask: a.askPrice(c) })).sort((x, y) => x.ask - y.ask);
      const buyers = traders.filter((a) => a.wantQty(c) > 0 && a.gold >= 1)
        .map((a) => ({ a, bid: a.bidPrice(c) })).sort((x, y) => y.bid - x.bid);

      let i = 0, j = 0, budget = ECON.tradesPerCommodityPerTick;
      while (i < sellers.length && j < buyers.length && budget > 0) {
        const s = sellers[i], b = buyers[j];
        if (s.a === b.a) { j++; continue; }
        if (b.bid < s.ask) break;                 // no overlap left
        const price = +((b.bid + s.ask) / 2).toFixed(2);
        if (s.a.sellQty(c) < 1) { i++; continue; }
        if (b.a.gold < price) { j++; continue; }

        // RPG price favor: when the player is the counterparty, skew the clearing
        // price by the seller/buyer NPC's standing toward the player (beloved =>
        // buys cheaper, sells dearer). Capped at REP.priceFavorMax.
        let sPrice = price, bPrice = price;
        const pid = this.reputation.playerId;
        if (pid != null) {
          if (b.a.id === pid) bPrice = this.reputation.favoredPrice(price, this.reputation.standing(s.a), true);
          if (s.a.id === pid) sPrice = this.reputation.favoredPrice(price, this.reputation.standing(b.a), false);
        }
        s.a.applySell(c, sPrice);
        b.a.applyBuy(c, bPrice);
        budget--; this.tradesThisTick++;

        if (s.a.sellQty(c) < 1) i++;
        if (b.a.wantQty(c) < 1) j++;
      }

      // tatonnement: unfilled sellers mark down, unfilled buyers mark up
      for (const a of traders) {
        if (a.sellQty(c) > 0) a.learnPrice(c, a.priceBeliefs[c] * ECON.tatonnementDown, 1);
        if (a.wantQty(c) > 0 && a.gold >= 1) a.learnPrice(c, a.priceBeliefs[c] * ECON.tatonnementUp, 1);
      }
    }
  }

  // emergent "market price": population-average belief (no central authority).
  avgPrice(c) {
    let sum = 0, n = 0;
    for (const a of this.agents) {
      if (a.controlled || !a.alive) continue;
      sum += a.priceBeliefs[c]; n++;
    }
    return n ? sum / n : 0;
  }

  // What an NPC currently thinks of the player (-1..1) and a short label, for
  // the inspector / dialogue. Delegates to the reputation ledger (falls back to
  // the NPC's faction bias when it holds no personal belief yet).
  playerStanding(npcAgent) { return this.reputation.standing(npcAgent); }
  playerStandingLabel(npcAgent) { return this.reputation.describe(npcAgent); }
  factionStanding(faction) { return this.reputation.factionStanding(faction); }

  // Combat hostility predicate for resolveCombat. Decisions read beliefs; this
  // resolves who a landed blow may actually damage (ground truth + reputation).
  isHostile(attackerFighter, targetFighter) {
    const A = attackerFighter.agent, T = targetFighter.agent;
    if (!A || !T) return true;
    if (A.controlled) return true;                  // the player hits what they aim at
    if (factionHostile(A.faction, T.faction)) return true;
    // belief/standing-driven (reputation, Phase 3): a soured opinion turns hostile
    const b = A.beliefs.get(T.id);
    return !!(b && (b.hostile || b.standing < -0.6));
  }

  // Fold combat outcomes back into beliefs: being struck reveals an aggressor
  // (latched hostile) and stirs anger/fear; witnesses notice too.
  onCombatEvents(events) {
    const pid = this.reputation.playerId;
    for (const ev of events) {
      const A = ev.attacker.agent, T = ev.target.agent;
      if (!A || !T) continue;

      // RPG combat deeds (classes/XP). A landed/lethal blow is a MELEE (+RISK,
      // +KILL if lethal) deed for the attacker; a block is a DEFENSE deed for the
      // target. The combat event type is 'dead' (lethal) | 'hit' | 'blocked' —
      // there is NO 'kill' type, so KILL is tagged off 'dead'. This block also
      // reproduces the original blocked-skip (emitting DEFENSE first), so the
      // belief-nudge code below only runs for hit/dead.
      if (ev.type === 'blocked') {
        bus.emit(makeEvent({
          actorId: T.id, verb: 'block', tags: ['DEFENSE'],
          targetId: A.id, magnitude: 1, t: this.time,
        }));
        continue;
      }
      const risk = Math.max(0, Math.min(1, (A.threat ? 0.3 : 0) + (T.threat || 0.3)));
      const tags = ev.type === 'dead' ? ['MELEE', 'KILL', 'RISK'] : ['MELEE', 'RISK'];
      bus.emit(makeEvent({
        actorId: A.id, verb: ev.type === 'dead' ? 'kill' : 'strike', tags,
        targetId: T.id, magnitude: risk, t: this.time,
      }));

      // quest hook: the player slaying a monster advances any active hunt bounty.
      if (ev.type === 'dead' && A.controlled && T.faction === MONSTER.faction) {
        this.quests.bumpHunt(T.faction);
      }

      // RPG reputation: if the PLAYER is the aggressor, this is a witnessed deed.
      // Townsfolk react far more strongly than the generic belief nudge below:
      // killing a non-monster NPC is grave; attacking is bad; slaying a monster
      // earns goodwill. witnessDeed handles witnesses + faction rollup and is
      // independent of the NPC<->NPC standing nudges kept below. A mere hit on a
      // monster is neutral (no deed).
      if (A.controlled && pid != null) {
        let deed = null;
        if (T.faction === MONSTER.faction) {
          deed = ev.type === 'dead' ? 'KILLED_MONSTER' : null;
        } else {
          deed = ev.type === 'dead' ? 'KILLED_NPC' : 'ATTACKED_NPC';
        }
        if (deed) this.reputation.witnessDeed(this.agents, deed, A.pos, this.time, T.id);
      }

      // victim now knows the attacker is hostile
      const tb = T.beliefs.observe(A.id, A.faction, A.pos, this.time, true);
      tb.standing = Math.max(-1, tb.standing - 0.4);
      T.mood.fear = Math.min(1, T.mood.fear + 0.4);
      T.mood.anger = Math.min(1, T.mood.anger + 0.5);
      // bystanders who can see it also mark the attacker
      for (const w of this.agents) {
        if (w === A || w === T || !w.alive || w.controlled) continue;
        if (w.pos.distanceTo(A.pos) > SIM.visionRange) continue;
        const wb = w.beliefs.observe(A.id, A.faction, A.pos, this.time, factionHostile(w.faction, A.faction));
        wb.suspicion = Math.min(1, wb.suspicion + 0.3);
      }
    }
  }
}
