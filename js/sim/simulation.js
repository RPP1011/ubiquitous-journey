// Simulation manager: spawns the professions, runs the fixed-rate decision pass
// and the market double-auction, and tracks emergent average prices. Peaceful —
// no combat — so the human can wander a working market town.

import * as THREE from 'three';
import { Fighter } from '../fighter.js';
import { Agent } from './agent.js';
import { PROFESSIONS, ROSTER, COMMODITIES, ECON, SIM, NAMES, MONSTER, factionHostile } from './simconfig.js';
import { ARENA_RADIUS } from '../arena.js';

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
    }

    for (const a of this.agents) a.act(dt, ctx);
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

        s.a.applySell(c, price);
        b.a.applyBuy(c, price);
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
    for (const ev of events) {
      const A = ev.attacker.agent, T = ev.target.agent;
      if (!A || !T) continue;
      if (ev.type === 'blocked') continue;
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
