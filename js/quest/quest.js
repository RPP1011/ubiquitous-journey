// Emergent quests: instead of authored content, the QuestBoard reads the REAL
// running simulation and synthesises offers from agents that are genuinely stuck
// — a townsperson the market can't feed (fetch), a monster believed to be near
// the village (hunt), or someone robbed in combat (recover). Accepting one wires
// the player into the agent's actual problem; completion is detected from the
// same ground-truth the sim already tracks (inventory, deeds, proximity), so a
// quest is just a contract layered over emergent state — no scripted triggers.

import { REP } from '../sim/reputation.js';
import { bus } from '../rpg/events.js';
import { MONSTER, SIM } from '../sim/simconfig.js';

// quest lifecycle states
export const QUEST_STATE = { offered: 'offered', active: 'active', done: 'done', failed: 'failed' };

let _qid = 1;

export class Quest {
  // type: 'fetch' | 'hunt' | 'recover'
  // target: type-specific payload (see QuestBoard synthesis below)
  // reward: { gold, xp, rep }
  constructor({ type, giverId, title, desc, target, reward }) {
    this.id = _qid++;
    this.type = type;
    this.giverId = giverId;
    this.title = title;
    this.desc = desc || '';
    this.target = target;
    this.reward = Object.assign({ gold: 0, xp: 0, rep: 0 }, reward || {});
    this.state = QUEST_STATE.offered;
    this.progress = 0;          // 0..1 for the log; hunt counts kills here
    this.acceptedAt = 0;
  }

  get active()   { return this.state === QUEST_STATE.active; }
  get finished() { return this.state === QUEST_STATE.done || this.state === QUEST_STATE.failed; }
}

// How the board behaves. Tunables live here so the integrator can dial them.
export const QUEST = {
  refreshEvery: 4.0,        // seconds between board refreshes (throttled)
  maxOffers: 4,             // standing offers on the board at once
  fetchNeedThresh: 0.32,    // hunger below this counts as "going hungry"
  fetchStuckTicks: 24,      // ticks hungry-without-relief before a fetch is posted
  fetchQty: 3,              // food units a fetch quest asks for
  fetchReward: { gold: 14, xp: 6, rep: REP?.deeds?.QUEST_DONE?.personal ?? 0.25 },
  huntCount: 2,             // monsters a hunt quest asks the player to slay
  huntReward: { gold: 22, xp: 12, rep: (REP?.deeds?.QUEST_DONE?.personal ?? 0.25) * 1.4 },
  recoverReward: { gold: 18, xp: 10, rep: (REP?.deeds?.QUEST_DONE?.personal ?? 0.25) * 1.2 },
  recoverNearDist: 3.0,     // how close to the giver the recovered goods return
  expireAfter: 0,           // 0 = offers persist until taken or state changes
};

export class QuestBoard {
  constructor(sim) {
    this.sim = sim;
    this.offers = [];        // synthesised, not-yet-accepted Quests
    this.active = [];        // accepted by the player
    this._acc = 0;           // refresh throttle accumulator
    this._hungerStreak = new Map();   // giverId -> ticks gone hungry
    this._grievance = new Map();      // victimId -> { commodity, qty, t } from combat
    this._postedFor = new Set();      // giverIds with a live offer/active (no dupes)

    // a robbed agent is the seed of a 'recover' quest — listen for combat-driven
    // loss deeds on the shared bus (the sim emits ROBBED via onCombatEvents).
    this._off = bus.on((ev) => this._onDeed(ev));
  }

  dispose() { if (this._off) this._off(); }

  // ---- deed intake ---------------------------------------------------------
  _onDeed(ev) {
    if (!ev) return;
    if (ev.verb === 'ROBBED' && ev.targetId != null) {
      // victim lost goods to an aggressor; record the grievance to mint a quest
      const c = (ev.tags && ev.tags[0]) || 'food';
      this._grievance.set(ev.targetId, { commodity: c, qty: Math.max(1, ev.magnitude | 0 || 1), t: ev.t });
    }
  }

  // ---- synthesis (throttled) ----------------------------------------------
  // Called every 6Hz tick by the sim; only re-synthesises every refreshEvery s.
  refresh(dt = 0) {
    this._acc += dt;
    if (this._acc < QUEST.refreshEvery) return;
    this._acc = 0;
    this._rebuildPostedSet();
    this._synthFetch();
    this._synthHunt();
    this._synthRecover();
    // trim to maxOffers, keeping the freshest
    if (this.offers.length > QUEST.maxOffers) this.offers = this.offers.slice(-QUEST.maxOffers);
    // clear any offer whose giver has died / left
    this.offers = this.offers.filter((q) => {
      const g = this.sim.agentsById.get(q.giverId);
      return g && g.alive;
    });
  }

  _rebuildPostedSet() {
    this._postedFor.clear();
    for (const q of this.offers) this._postedFor.add(q.giverId);
    for (const q of this.active) this._postedFor.add(q.giverId);
  }

  _townsfolk() {
    return this.sim.agents.filter((a) => a.alive && !a.controlled && a.faction === 'townsfolk');
  }

  _post(quest) {
    // mark the giver so a "seekHelp" behaviour can read it (agent.js, optional)
    const g = this.sim.agentsById.get(quest.giverId);
    if (g) g.openOffer = quest;
    this.offers.push(quest);
    this._postedFor.add(quest.giverId);
    bus.emit({ actorId: quest.giverId, verb: 'QUEST_OFFERED', tags: [quest.type], magnitude: 1, t: this.sim.time });
  }

  // FETCH: a townsperson the market keeps failing to feed. We track how long
  // their hunger has sat below threshold; once they've been hungry for a stretch
  // (the auction isn't clearing food to them), post a bring-me-food contract.
  _synthFetch() {
    for (const a of this._townsfolk()) {
      const hungry = a.needs.hunger < QUEST.fetchNeedThresh && (a.inventory.food || 0) < 0.5;
      const n = (this._hungerStreak.get(a.id) || 0);
      this._hungerStreak.set(a.id, hungry ? n + 1 : 0);
      if (this._postedFor.has(a.id)) continue;
      if (hungry && n + 1 >= QUEST.fetchStuckTicks) {
        this._post(new Quest({
          type: 'fetch', giverId: a.id,
          title: `Bring food to ${a.name}`,
          desc: `${a.name} is going hungry — the market won't sell them food. Bring ${QUEST.fetchQty} food.`,
          target: { commodity: 'food', qty: QUEST.fetchQty },
          reward: QUEST.fetchReward,
        }));
        this._hungerStreak.set(a.id, 0);
      }
    }
  }

  // HUNT: a townsperson who currently BELIEVES a monster is near (a confident
  // hostile belief about a monster-faction subject). The fear is emergent from
  // the ToM layer; we turn it into a bounty.
  _synthHunt() {
    const monstersAlive = this.sim.agents.some((m) => m.alive && m.faction === MONSTER.faction);
    if (!monstersAlive) return;
    for (const a of this._townsfolk()) {
      if (this._postedFor.has(a.id)) continue;
      let scared = false;
      for (const b of a.beliefs.all()) {
        if (b.confidence < SIM.actOnBeliefMin) continue;
        if (b.lastFaction === MONSTER.faction || b.hostile) {
          const subj = this.sim.agentsById.get(b.subjectId);
          if (subj && subj.alive && subj.faction === MONSTER.faction) { scared = true; break; }
        }
      }
      if (scared) {
        this._post(new Quest({
          type: 'hunt', giverId: a.id,
          title: `Slay the ${MONSTER.name}s near ${a.name}`,
          desc: `${a.name} has spotted ${MONSTER.name}s prowling close. Slay ${QUEST.huntCount}.`,
          target: { monsterFaction: MONSTER.faction, count: QUEST.huntCount },
          reward: QUEST.huntReward,
        }));
        return;   // one hunt bounty on the board at a time is plenty
      }
    }
  }

  // RECOVER: an agent robbed in combat (a grievance deed). They want their goods
  // back — completion is "player holds the lost commodity AND is near the giver".
  _synthRecover() {
    for (const [victimId, g] of this._grievance) {
      if (this._postedFor.has(victimId)) continue;
      const v = this.sim.agentsById.get(victimId);
      if (!v || !v.alive || v.controlled) { this._grievance.delete(victimId); continue; }
      this._post(new Quest({
        type: 'recover', giverId: victimId,
        title: `Recover ${v.name}'s ${g.commodity}`,
        desc: `${v.name} was robbed of ${g.qty} ${g.commodity}. Bring it back to them.`,
        target: { commodity: g.commodity, qty: g.qty },
        reward: QUEST.recoverReward,
      }));
      this._grievance.delete(victimId);
    }
  }

  // ---- player interaction --------------------------------------------------
  accept(quest, player) {
    if (!quest || quest.state !== QUEST_STATE.offered) return false;
    quest.state = QUEST_STATE.active;
    quest.acceptedAt = this.sim.time;
    quest.progress = 0;
    this._player = player;
    this.offers = this.offers.filter((q) => q !== quest);
    this.active.push(quest);
    bus.emit({ actorId: player.id, verb: 'QUEST_ACCEPTED', tags: [quest.type], magnitude: 1,
      targetId: quest.giverId, t: this.sim.time });
    return true;
  }

  // hunt progress: the sim calls this when the PLAYER kills a monster
  // (onCombatEvents -> dead event whose attacker is the player & target a monster).
  bumpHunt(monsterFaction) {
    for (const q of this.active) {
      if (q.type !== 'hunt' || q.state !== QUEST_STATE.active) continue;
      if (q.target.monsterFaction !== monsterFaction) continue;
      q.progress = Math.min(q.target.count, q.progress + 1);
    }
  }

  // ---- per-tick completion detection (called on the 6Hz loop) --------------
  tick() {
    const player = this._player || this.sim.player;
    if (!player) return;
    for (const q of this.active.slice()) {
      if (q.state !== QUEST_STATE.active) continue;
      const giver = this.sim.agentsById.get(q.giverId);
      if (!giver || !giver.alive) { this._fail(q, 'giver lost'); continue; }

      if (q.type === 'fetch' || q.type === 'recover') {
        const c = q.target.commodity, qty = q.target.qty;
        const held = Math.floor(player.inventory[c] || 0);
        // fetch completes on hand-off near the giver; recover too (return the goods)
        const near = player.pos.distanceTo(giver.pos) <= QUEST.recoverNearDist;
        q.progress = Math.min(1, held / qty);
        if (held >= qty && near) {
          // transfer the goods to the giver and pay out
          player.inventory[c] -= qty;
          giver.inventory[c] = (giver.inventory[c] || 0) + qty;
          if (c === 'food') giver.needs.hunger = Math.min(1, giver.needs.hunger + 0.4);
          this._complete(q, player);
        }
      } else if (q.type === 'hunt') {
        if (q.progress >= q.target.count) this._complete(q, player);
      }
    }
  }

  _complete(q, player) {
    q.state = QUEST_STATE.done;
    q.progress = 1;
    const r = q.reward;
    if (r.gold) player.gold += r.gold;
    if (r.xp && player.progression && typeof player.progression.addXP === 'function') {
      player.progression.addXP(r.xp, { reason: 'quest', tags: [q.type] });
    }
    const giver = this.sim.agentsById.get(q.giverId);
    if (giver) giver.openOffer = null;
    // a completed quest is a reputation-bearing deed: the giver + nearby
    // townsfolk who see it warm to the player (witnessDeed moves standing +
    // does the faction rollup).
    if (giver) this.sim.reputation?.witnessDeed?.(this.sim.agents, 'QUEST_DONE', giver.pos, this.sim.time, giver.id);
    bus.emit({ actorId: player.id, verb: 'QUEST_DONE', tags: [q.type], magnitude: r.rep || 1,
      targetId: q.giverId, t: this.sim.time });
    this.active = this.active.filter((x) => x !== q);
    this._done = this._done || [];
    this._done.push(q);
  }

  _fail(q, _why) {
    q.state = QUEST_STATE.failed;
    const giver = this.sim.agentsById.get(q.giverId);
    if (giver) giver.openOffer = null;
    bus.emit({ actorId: (this._player || this.sim.player)?.id ?? -1, verb: 'QUEST_FAILED',
      tags: [q.type], magnitude: 1, targetId: q.giverId, t: this.sim.time });
    this.active = this.active.filter((x) => x !== q);
  }
}
