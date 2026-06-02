// An economic Agent: a profession, an inventory + gold, needs, and PRICE
// BELIEFS it uses to trade. Each tick it decides (utility over needs + economy)
// and acts: work at its site to produce, eat from its stock, or go to market to
// buy/sell. Price beliefs update from trades and drift toward chatting
// neighbours (gossip) — the economic belief surface.

import * as THREE from 'three';
import { DIR } from '../constants.js';
import { ARENA_RADIUS } from '../arena.js';
import { POI_KIND } from './world.js';
import { BeliefStore } from './beliefs.js';
import {
  PROFESSIONS, COMMODITIES, BASE_PRICE, ECON, SIM, WEIGHT, PLAYER_COLOR, SOURCE,
  FACTIONS, factionHostile,
} from './simconfig.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const rand = (a, b) => a + Math.random() * (b - a);
const DIRS = [DIR.UP, DIR.DOWN, DIR.LEFT, DIR.RIGHT];
const randDir = () => DIRS[(Math.random() * 4) | 0];
const _flee = new THREE.Vector3();

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
    this.relationships = new Map();        // otherId -> { affinity, trust }

    // combat / disposition
    this.combatant = !!cfg.combatant;      // monsters & guards fight; civilians flee
    this.threat = cfg.threat || (this.combatant ? 1 : 0.3);
    this.mood = { fear: 0, anger: 0 };     // transient, decays; gates flee/fight
    this._releaseTimer = 0;
    this._attackCd = Math.random() * 1.5;

    // needs (1 = satisfied)
    this.needs = { hunger: rand(0.5, 0.9), energy: rand(0.6, 0.95), social: rand(0.4, 0.85) };

    // economy
    this.inventory = { food: 0, wood: 0, ore: 0, tool: 0 };
    this.gold = ECON.startGold;
    this.toolWear = 0;
    this._smithTimer = 0;
    this.priceBeliefs = {};
    for (const c of COMMODITIES) this.priceBeliefs[c] = +(BASE_PRICE[c] * rand(0.8, 1.2)).toFixed(2);
    if (this.profession) {
      const prof = PROFESSIONS[this.profession];
      this.inventory[prof.output] = ECON.startStock;
      this.inventory.food = Math.max(this.inventory.food, 2);
      this.inventory.tool = 1;
      if (prof.inputs) for (const c in prof.inputs) this.inventory[c] = 2;
    }

    // professionless agents (monsters, the player) never "work"
    this.goal = { kind: this.profession ? 'work' : 'wander' };
    this.wanderTarget = null;
    this._tradeFlash = 0;

    this._buildDecor();
  }

  get pos() { return this.fighter.root.position; }
  get alive() { return this.fighter.alive; }
  profColor() {
    if (this.controlled) return PLAYER_COLOR;
    if (this.profession) return PROFESSIONS[this.profession].color;
    return FACTIONS[this.faction]?.color ?? 0xffffff;   // monsters etc.
  }

  drainNeeds(dt) {
    this.needs.hunger = clamp01(this.needs.hunger - SIM.hungerDrain * dt);
    this.needs.energy = clamp01(this.needs.energy - SIM.energyDrain * dt);
    this.needs.social = clamp01(this.needs.social - SIM.socialDrain * dt);
    this.mood.fear = Math.max(0, this.mood.fear - 0.4 * dt);
    this.mood.anger = Math.max(0, this.mood.anger - 0.3 * dt);
    if (this._tradeFlash > 0) this._tradeFlash -= dt;
  }

  // do I treat this belief's subject as hostile? (believed faction, or latched)
  considerHostile(b) {
    return !!b && (b.hostile || factionHostile(this.faction, b.lastFaction));
  }
  // nearest believed-hostile agent I'm confident enough to act on
  _nearestHostile(ctx) {
    let best = null, bd = Infinity;
    for (const b of this.beliefs.all()) {
      if (b.confidence < SIM.actOnBeliefMin || !this.considerHostile(b)) continue;
      const o = ctx.agentsById.get(b.subjectId);
      if (!o || !o.alive) continue;
      const d = this.pos.distanceTo(o.pos);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  // --- Theory-of-Mind passes (run by Simulation each 6Hz tick) ---------------
  // perceive: sight of nearby agents writes high-confidence beliefs (the player
  // is just another subject, so NPCs naturally form beliefs about you).
  perceive(ctx) {
    if (!this.alive || this.controlled) return;
    for (const o of ctx.agents) {
      if (o === this || !o.alive) continue;
      if (this.pos.distanceTo(o.pos) > SIM.visionRange) continue;
      this.beliefs.observe(o.id, o.faction, o.pos, ctx.time, false);
    }
  }

  // gossip: adopt a nearby ally's more-certain beliefs (carries standing too).
  gossipBeliefs(ctx) {
    if (!this.alive || this.controlled) return;
    for (const o of ctx.agents) {
      if (o === this || !o.alive || o.controlled) continue;
      if (this.pos.distanceTo(o.pos) > SIM.talkRange) continue;
      for (const b of o.beliefs.all()) {
        if (b.subjectId === this.id) continue;   // don't gossip about me to myself
        this.beliefs.mergeFrom(b, SOURCE.TALKED);
      }
      break;   // one conversation partner per tick
    }
  }

  // --- price beliefs (the economic ToM) -------------------------------------
  learnPrice(c, price, w) {
    let pb = this.priceBeliefs[c] + w * (price - this.priceBeliefs[c]);
    pb = Math.max(ECON.priceBounds[0], Math.min(ECON.priceBounds[1], pb));
    this.priceBeliefs[c] = +pb.toFixed(2);
  }

  // drift toward a chatting neighbour's prices — how rumoured prices spread
  priceGossip(ctx, dt) {
    if (this.controlled) return;
    for (const o of ctx.agents) {
      if (o === this || !o.alive || o.controlled) continue;
      if (this.pos.distanceTo(o.pos) > SIM.talkRange) continue;
      for (const c of COMMODITIES) {
        this.priceBeliefs[c] += (o.priceBeliefs[c] - this.priceBeliefs[c]) * ECON.priceGossip * dt;
      }
      break; // one conversation partner per tick is enough
    }
  }

  // --- trade interface (used by the market in simulation.js) ----------------
  keepOf(c) { return ECON.keep[c] ?? 0; }
  surplus(c) { return this.inventory[c] - this.keepOf(c); }
  hasSurplus(c) { return this.surplus(c) >= 1; }

  // units this agent wants to buy / can sell of c (for the standing-order book)
  wantQty(c) {
    if (this.controlled) return 0;
    if (c === 'food') return Math.max(0, ECON.keep.food - Math.floor(this.inventory.food));
    if (c === 'tool') return this.inventory.tool < 1 ? 1 : 0;
    if (this.profession === 'smith' && (c === 'wood' || c === 'ore')) return Math.max(0, 2 - Math.floor(this.inventory[c]));
    return 0;
  }
  sellQty(c) { return Math.max(0, Math.floor(this.surplus(c))); }
  askPrice(c) { return this.priceBeliefs[c]; }
  bidPrice(c) { return Math.min(this.priceBeliefs[c], this.gold); }   // can't bid more than you hold

  applyBuy(c, price) { this.inventory[c] += 1; this.gold -= price; this.learnPrice(c, price, ECON.priceLearn); this._tradeFlash = 0.6; }
  applySell(c, price) { this.inventory[c] -= 1; this.gold += price; this.learnPrice(c, price, ECON.priceLearn); this._tradeFlash = 0.6; }

  // --- decision -------------------------------------------------------------
  decide(ctx) {
    if (!this.alive || this.controlled) return;
    const P = this.personality;
    const inv = this.inventory;
    const prof = this.profession ? PROFESSIONS[this.profession] : null;

    const cand = [];
    const push = (kind, score, extra) => { if (score > 0) cand.push({ kind, score, ...extra }); };

    // survival first: act on a BELIEVED-hostile nearby (beliefs, not truth)
    const enemy = this._nearestHostile(ctx);
    if (enemy) {
      if (this.combatant)
        push('fight', WEIGHT.fight * (0.4 + P.risk_tolerance) + this.mood.anger, { targetId: enemy.id });
      else
        push('flee', WEIGHT.flee * (1.2 - P.risk_tolerance) + this.mood.fear, { fromId: enemy.id });
    }

    // economic / life scheduling (only for townsfolk with a profession)
    if (prof) {
      if (inv.food > 0.05)
        push('eat', Math.pow(1 - this.needs.hunger, 1.5) * WEIGHT.eat);
      const goldNeed = clamp01(1 - this.gold / 30);
      const overstock = clamp01(inv[prof.output] / ECON.maxStack);
      push('work', WEIGHT.work * (0.4 + P.ambition) * (0.5 + 0.5 * goldNeed) * (1 - 0.7 * overstock));
      push('rest', Math.pow(1 - this.needs.energy, 1.5) * WEIGHT.rest);
      push('socialize', (1 - this.needs.social) * (0.3 + P.social_drive) * WEIGHT.socialize);
    }
    push('wander', WEIGHT.wander * (0.6 + P.curiosity));

    let best = cand[0];
    for (const c of cand) {
      const eff = c.kind === this.goal.kind ? c.score * 1.18 : c.score;
      const bestEff = best.kind === this.goal.kind ? best.score * 1.18 : best.score;
      if (eff > bestEff) best = c;
    }
    this.goal = best || { kind: 'work' };
  }

  // --- act ------------------------------------------------------------------
  act(dt, ctx) {
    if (!this.alive || this.controlled) return;
    this.priceGossip(ctx, dt);
    const prof = this.profession ? PROFESSIONS[this.profession] : null;

    switch (this.goal.kind) {
      case 'fight': this._combatStep(dt, ctx); break;
      case 'flee':  this._fleeFrom(ctx.agentsById.get(this.goal.fromId), dt); break;
      case 'eat': {
        if (this.inventory.food > 0 && this.needs.hunger < 1) {
          const amt = ECON.eatRate * dt;
          this.needs.hunger = clamp01(this.needs.hunger + amt);
          this.inventory.food = Math.max(0, this.inventory.food - amt);
        }
        this.fighter.setMoving(0);
        break;
      }
      case 'work': {
        if (!prof) break;                       // monsters have no workplace
        const site = ctx.world.nearest(prof.site, this.pos);
        if (site && this._goTo(site.pos, dt)) this._produce(dt);
        break;
      }
      case 'rest': {
        const r = ctx.world.nearest(POI_KIND.REST, this.pos);
        if (r && this._goTo(r.pos, dt)) this.needs.energy = clamp01(this.needs.energy + SIM.restRate * dt);
        break;
      }
      case 'socialize': {
        const m = ctx.world.nearest(POI_KIND.MARKET, this.pos);
        if (m && this._goTo(m.pos, dt)) this.needs.social = clamp01(this.needs.social + SIM.socializeRate * dt);
        break;
      }
      default: {
        if (!this.wanderTarget || this.pos.distanceTo(this.wanderTarget) < 1.0) {
          const a = Math.random() * Math.PI * 2, r = Math.random() * ARENA_RADIUS * 0.7;
          this.wanderTarget = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
        }
        this._goTo(this.wanderTarget, dt);
      }
    }
    this._updateLabel();
  }

  _produce(dt) {
    const prof = PROFESSIONS[this.profession];
    const inv = this.inventory;
    this.fighter.setMoving(0);
    if (prof.inputs) {
      // smith: convert inputs -> tool
      const has = Object.keys(prof.inputs).every((c) => inv[c] >= prof.inputs[c]);
      if (has) {
        this._smithTimer += dt;
        if (this._smithTimer >= ECON.smithSecsPerTool) {
          this._smithTimer = 0;
          for (const c in prof.inputs) inv[c] -= prof.inputs[c];
          if (inv.tool < ECON.maxStack) inv.tool += 1;
        }
      }
      return;
    }
    // raw producer
    if (inv[prof.output] >= ECON.maxStack) return;
    const boosted = inv.tool >= 1;
    const gained = ECON.produceRate * (boosted ? ECON.toolBoost : 1) * dt;
    inv[prof.output] += gained;
    if (boosted) {
      // tools wear PER UNIT PRODUCED — ties tool demand to throughput, which is
      // what closes the money loop (validated via the Markov-chain analysis).
      this.toolWear += gained * ECON.toolWearPerGain;
      while (this.toolWear >= 1 && inv.tool > 0) { this.toolWear -= 1; inv.tool -= 1; }
    }
  }

  _goTo(target, dt, run = false) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    this.fighter.setFacing(Math.atan2(-dx, -dz));
    if (d <= SIM.arriveDist) { this.fighter.setMoving(0); return true; }
    const sp = run ? SIM.runSpeed : SIM.moveSpeed;
    this.pos.x += (dx / d) * sp * dt;
    this.pos.z += (dz / d) * sp * dt;
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > ARENA_RADIUS) { this.pos.x *= ARENA_RADIUS / r; this.pos.z *= ARENA_RADIUS / r; }
    this.fighter.setMoving(sp);
    return false;
  }

  // close on a believed-hostile target and trade directional blows (reuses the
  // Fighter swing state machine, telegraphed like the old enemy AI).
  _combatStep(dt, ctx) {
    const f = this.fighter;
    this._attackCd -= dt;
    const target = ctx.agentsById.get(this.goal.targetId);
    if (!target || !target.alive) { this.goal = { kind: 'wander' }; return; }
    const dx = target.pos.x - this.pos.x, dz = target.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    f.setFacing(Math.atan2(-dx, -dz));
    const reach = 2.2;
    if (dist > reach) {
      if (f.state !== 'attack' && f.state !== 'stagger') {
        const sp = SIM.runSpeed;
        this.pos.x += (dx / dist) * sp * dt; this.pos.z += (dz / dist) * sp * dt;
        const r = Math.hypot(this.pos.x, this.pos.z);
        if (r > ARENA_RADIUS) { this.pos.x *= ARENA_RADIUS / r; this.pos.z *= ARENA_RADIUS / r; }
        f.setMoving(sp);
      }
    } else {
      f.setMoving(0);
      if (this._releaseTimer > 0) {
        this._releaseTimer -= dt;
        if (this._releaseTimer <= 0 && f.state === 'ready') f.release();
      } else if (this._attackCd <= 0 && f.canAct() && f.state !== 'block') {
        f.ready(randDir());
        this._releaseTimer = 0.35 + Math.random() * 0.25;
        this._attackCd = 1.3 + Math.random() * 1.2;
      }
    }
  }

  _fleeFrom(threat, dt) {
    let ax = this.pos.x, az = this.pos.z;
    if (threat) { ax = this.pos.x - threat.pos.x; az = this.pos.z - threat.pos.z; }
    const d = Math.hypot(ax, az) || 1;
    _flee.set(this.pos.x + (ax / d) * 6, 0, this.pos.z + (az / d) * 6);
    this._goTo(_flee, dt, true);
  }

  // --- decoration -----------------------------------------------------------
  _buildDecor() {
    this.fighter.root.userData.agent = this;

    const proxy = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6),
      new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.y = (this.fighter.height || 1.8) * 0.55;
    proxy.userData.agent = this;
    this.proxy = proxy;
    this.fighter.root.add(proxy);

    this.ringMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.78, 24), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.03;
    this.ringMat.color.setHex(this.profColor());
    this.fighter.root.add(this.ring);

    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    this._lblCanvas = canvas; this._lblCtx = canvas.getContext('2d');
    this._lblTex = new THREE.CanvasTexture(canvas); this._lblTex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._lblTex, depthTest: false, transparent: true }));
    spr.scale.set(2.6, 0.65, 1);
    spr.position.y = (this.fighter.height || 1.8) + 0.65;
    spr.renderOrder = 1000;
    this.label = spr;
    this.fighter.root.add(spr);
    this._updateLabel();
  }

  _updateLabel() {
    const ctx = this._lblCtx; if (!ctx) return;
    const col = `#${this.profColor().toString(16).padStart(6, '0')}`;
    ctx.clearRect(0, 0, 256, 64);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, 256, 34);
    ctx.font = 'bold 24px sans-serif'; ctx.fillStyle = col;
    ctx.fillText(this.name, 128, 24);
    ctx.font = '19px sans-serif'; ctx.fillStyle = this._tradeFlash > 0 ? '#ffd36b' : '#dfe6ee';
    const sub = this.controlled ? 'visitor'
      : `${this.goal.kind}${this._tradeFlash > 0 ? ' · traded!' : ' · ' + Math.round(this.gold) + 'g'}`;
    ctx.fillText(sub, 128, 56);
    this._lblTex.needsUpdate = true;
  }

  setLabelVisible(v) { if (this.label) this.label.visible = v; }
}
