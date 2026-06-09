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
import type { Agent, EntityId, ActionEvent } from '../../types/sim.js';

// simulation.js is a later cluster — typed as the minimal read surface used here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any; /* Simulation — ported in a later cluster */

/** A quest reward purse. */
export interface QuestReward { gold: number; xp: number; rep: number; }

/** The type-specific target payload (loose — fields vary by quest type). */
export interface QuestTarget {
  commodity?: string;
  qty?: number;
  monsterFaction?: string;
  count?: number;
  relics?: number;
  place?: string;
  killerId?: EntityId;
  killerName?: string;
  fallenId?: EntityId;
  fallenName?: string;
  [k: string]: unknown;
}

/** The args the Quest constructor accepts. */
export interface QuestSpec {
  type: string;
  giverId: EntityId;
  title: string;
  desc?: string;
  target: QuestTarget;
  reward?: Partial<QuestReward>;
  personal?: boolean;
}

// commodities a "deliver" radiant quest may ask for (raw goods the player can
// gather or buy — not tools/potions, which are scarcer).
const DELIVER_GOODS = ['food', 'wood', 'ore', 'herb'];

// quest lifecycle states
export const QUEST_STATE = { offered: 'offered', active: 'active', done: 'done', failed: 'failed' } as const;

let _qid = 1;

export class Quest {
  id: number;
  type: string;
  giverId: EntityId;
  title: string;
  desc: string;
  target: QuestTarget;
  reward: QuestReward;
  state: string;
  progress: number;
  acceptedAt: number;
  personal: boolean;
  // transient flags written elsewhere on the board
  _playerSlew?: boolean;

  // type: 'fetch' | 'hunt' | 'recover'
  // target: type-specific payload (see QuestBoard synthesis below)
  // reward: { gold, xp, rep }
  constructor({ type, giverId, title, desc, target, reward, personal }: QuestSpec) {
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
    // PERSONAL goals (a vendetta) are satisfied only by the giver's OWN agency, so
    // they're posted as an ASSIST ("help me"), never a delegable "do it for me" —
    // and the future NPC favour-economy may never have another NPC take them.
    this.personal = !!personal;
  }

  get active(): boolean   { return this.state === QUEST_STATE.active; }
  get finished(): boolean { return this.state === QUEST_STATE.done || this.state === QUEST_STATE.failed; }
  get delegable(): boolean { return !this.personal; }   // can someone OTHER than the giver settle it?
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

  // --- vendetta (PERSONAL): an outmatched griever begging help against a named foe -
  avengeReward: { gold: 50, xp: 30, rep: (REP?.deeds?.QUEST_DONE?.personal ?? 0.25) * 2.2 },
  avengeOnlyNamed: true,    // only post when the killer is a NAMED nemesis/warlord (a boss)
                            //   the griever can't bring down alone — else they avenge it solo

  // --- radiant generation (always-on, level-scaled, repeatable) ------------
  radiantFloor: 3,          // keep at least this many offers posted at all times
  goldPerLevel: 2,          // reward gold added per point of player total level
  xpPerLevel: 1,            // reward xp added per point of player total level
  bountyCount: 3,           // base monsters a radiant bounty asks for
  bountyReward: { gold: 20, xp: 12, rep: REP?.deeds?.QUEST_DONE?.personal ?? 0.25 },
  deliverQty: 3,            // units a radiant deliver quest asks for
  deliverReward: { gold: 14, xp: 6, rep: REP?.deeds?.QUEST_DONE?.personal ?? 0.25 },
  delveReward: { gold: 40, xp: 24, rep: (REP?.deeds?.QUEST_DONE?.personal ?? 0.25) * 1.6 },
};

interface Grievance { commodity: string; qty: number; t: number; }

export class QuestBoard {
  sim: Sim;
  offers: Quest[];
  active: Quest[];
  _acc: number;
  _hungerStreak: Map<EntityId, number>;
  _grievance: Map<EntityId, Grievance>;
  _postedFor: Set<EntityId>;
  _off: (() => void) | null;
  _player?: Agent | null;
  _done?: Quest[];

  constructor(sim: Sim) {
    this.sim = sim;
    this.offers = [];        // synthesised, not-yet-accepted Quests
    this.active = [];        // accepted by the player
    this._acc = 0;           // refresh throttle accumulator
    this._hungerStreak = new Map();   // giverId -> ticks gone hungry
    this._grievance = new Map();      // victimId -> { commodity, qty, t } from combat
    this._postedFor = new Set();      // giverIds with a live offer/active (no dupes)

    // a robbed agent is the seed of a 'recover' quest — listen for combat-driven
    // loss deeds on the shared bus (the sim emits ROBBED via onCombatEvents).
    this._off = bus.on((ev: ActionEvent) => this._onDeed(ev));
  }

  dispose(): void { if (this._off) this._off(); }

  // ---- deed intake ---------------------------------------------------------
  _onDeed(ev: ActionEvent): void {
    if (!ev) return;
    if (ev.verb === 'ROBBED' && ev.targetId != null) {
      // victim lost goods to an aggressor; record the grievance to mint a quest
      const c = (ev.tags && ev.tags[0]) || 'food';
      this._grievance.set(ev.targetId, { commodity: c, qty: Math.max(1, (ev.magnitude | 0) || 1), t: ev.t });
    }
  }

  // ---- synthesis (throttled) ----------------------------------------------
  // Called every 6Hz tick by the sim; only re-synthesises every refreshEvery s.
  refresh(dt = 0): void {
    this._acc += dt;
    if (this._acc < QUEST.refreshEvery) return;
    this._acc = 0;
    this._rebuildPostedSet();
    this._synthFetch();
    this._synthHunt();
    this._synthRecover();
    this._synthVendetta();  // PERSONAL: only when a griever is outmatched (see below)
    this._synthRadiant();   // top the board up with repeatable, scaled offers
    // trim to maxOffers, keeping the freshest
    if (this.offers.length > QUEST.maxOffers) this.offers = this.offers.slice(-QUEST.maxOffers);
    // clear any offer whose giver has died / left
    this.offers = this.offers.filter((q) => {
      const g = this.sim.agentsById.get(q.giverId);
      return g && g.alive;
    });
  }

  _rebuildPostedSet(): void {
    this._postedFor.clear();
    for (const q of this.offers) this._postedFor.add(q.giverId);
    for (const q of this.active) this._postedFor.add(q.giverId);
  }

  _townsfolk(): Agent[] {
    // companions following the player don't post notices — they're with you
    return this.sim.agents.filter((a: Agent) => a.alive && a.autonomous && !a.inParty && a.faction === 'townsfolk');
  }

  _post(quest: Quest): void {
    // mark the giver so a "seekHelp" behaviour can read it (agent.js, optional)
    const g = this.sim.agentsById.get(quest.giverId);
    if (g) g.openOffer = quest;
    this.offers.push(quest);
    this._postedFor.add(quest.giverId);
    // tags:[] -> earns NO XP. Only QUEST_DONE should grant XP, else agents are
    // incentivised to spam-open quests. (Offering/accepting/failing aren't deeds.)
    bus.emit({ actorId: quest.giverId, verb: 'QUEST_OFFERED', tags: [], magnitude: 1, t: this.sim.time });
  }

  // FETCH: a townsperson the market keeps failing to feed. We track how long
  // their hunger has sat below threshold; once they've been hungry for a stretch
  // (the auction isn't clearing food to them), post a bring-me-food contract.
  _synthFetch(): void {
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
  _synthHunt(): void {
    const monstersAlive = this.sim.agents.some((m: Agent) => m.alive && m.faction === MONSTER.faction);
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
  _synthRecover(): void {
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

  // VENDETTA (PERSONAL): a townsperson who GRIEVES a slain loved one (a high-salience
  // witnessed_death whose killer still lives) wants vengeance — but vengeance is
  // satisfied only by THEIR OWN hand, so it is NOT a delegable "do it for me" bounty.
  // The griever pursues the killer themselves (deriveGoals' avenge goal). It surfaces
  // as a quest ONLY when they're OUTMATCHED — the killer is a NAMED nemesis/warlord
  // (a boss) they cannot bring down alone — and then it's a personal ASSIST ("help me
  // face them"), completed only if the GRIEVER lives to see the foe fall.
  _synthVendetta(): void {
    for (const a of this._townsfolk()) {
      if (this._postedFor.has(a.id)) continue;
      if (!a.memory || !a.memory.stm) continue;
      let killerId: EntityId | undefined, fallenId: EntityId | undefined;
      try {
        const eps = [...a.memory.stm.items(), ...a.memory.mtm.items(), ...a.memory.ltm.items()];
        for (const e of eps) {
          if (e && e.kind === 'witnessed_death' && (e.salience || 0) >= 0.7 && e.byId != null) {
            const k = this.sim.agentsById.get(e.byId);
            if (k && k.alive && k.faction !== 'townsfolk') { killerId = e.byId; fallenId = e.withId; break; }
          }
        }
      } catch { /* memory shapes vary — never throw on synth */ }
      if (killerId == null) continue;
      const killer = this.sim.agentsById.get(killerId);
      // outmatched test: only beg help against a NAMED boss the griever can't best
      // alone (a higher-level nemesis/warlord). Otherwise they settle it themselves.
      const named = !!(killer.nemesis || killer.warlord || killer.epithet);
      if (QUEST.avengeOnlyNamed && !named) continue;
      if (this._lvlOf(killer) < this._lvlOf(a)) continue;   // a stronger avenger needs no help
      const fallen = (this.sim.agentsById.get(fallenId) || {}).name || 'their kin';
      this._post(new Quest({
        type: 'avenge', giverId: a.id, personal: true,
        title: `Avenge ${fallen}`,
        desc: `${killer.name} slew ${fallen} — ${a.name} burns for vengeance but cannot face them alone. Help bring ${killer.name} down; ${a.name} will stand with you.`,
        target: { killerId, killerName: killer.name, fallenId, fallenName: fallen },
        reward: QUEST.avengeReward,
      }));
    }
  }

  _lvlOf(a: Agent | null | undefined): number { return (a && a.progression && a.progression.totalLevel) || 0; }

  // RADIANT: unlike the emergent synths above (which fire only when an agent is
  // genuinely stuck), this keeps a baseline of repeatable contracts on the board
  // forever, scaled to the player's level. It's how the board never runs dry —
  // bounties on the monsters, deliveries for the market, and delves into the
  // dungeons the DungeonManager scattered in the wilds.
  _synthRadiant(): void {
    if (this.offers.length >= QUEST.radiantFloor) return;
    const folk = this._townsfolk().filter((a) => !this._postedFor.has(a.id));
    while (this.offers.length < QUEST.radiantFloor && folk.length) {
      const giver = folk.splice((Math.random() * folk.length) | 0, 1)[0];
      const q = this._mintRadiant(giver);
      if (q) this._post(q); else break;
    }
  }

  _playerLevel(): number {
    const p = this.sim.player;
    return (p && p.progression && p.progression.totalLevel) || 0;
  }
  _scale(base: Partial<QuestReward>): QuestReward {
    const l = this._playerLevel();
    return {
      gold: (base.gold || 0) + Math.round(l * QUEST.goldPerLevel),
      xp: (base.xp || 0) + Math.round(l * QUEST.xpPerLevel),
      rep: base.rep || 0,
    };
  }

  _mintRadiant(giver: Agent): Quest | null {
    const dungeons = this.sim.dungeons;
    const dungeonsExist = dungeons && dungeons.entrances && dungeons.entrances.length;
    const monstersAlive = this.sim.agents.some((m: Agent) => m.alive && m.faction === MONSTER.faction);
    const roll = Math.random();

    if (dungeonsExist && roll < 0.4) {
      const place = dungeons.entrances[(Math.random() * dungeons.entrances.length) | 0].name;
      return new Quest({
        type: 'delve', giverId: giver.id,
        title: `Recover a relic from ${place}`,
        desc: `${giver.name} will pay well for a relic dragged out of ${place}. Bring one back.`,
        target: { relics: 1, place },
        reward: this._scale(QUEST.delveReward),
      });
    }
    if (monstersAlive && roll < 0.75) {
      const count = QUEST.bountyCount + Math.floor(this._playerLevel() / 8);
      return new Quest({
        type: 'bounty', giverId: giver.id,
        title: `Bounty: ${count} ${MONSTER.name}s`,
        desc: `${giver.name} posts a standing bounty — slay ${count} ${MONSTER.name}s, wherever you find them.`,
        target: { monsterFaction: MONSTER.faction, count },
        reward: this._scale(QUEST.bountyReward),
      });
    }
    const c = DELIVER_GOODS[(Math.random() * DELIVER_GOODS.length) | 0];
    return new Quest({
      type: 'deliver', giverId: giver.id,
      title: `Deliver ${QUEST.deliverQty} ${c} to ${giver.name}`,
      desc: `${giver.name} will buy ${QUEST.deliverQty} ${c} on the spot — gather it and bring it over.`,
      target: { commodity: c, qty: QUEST.deliverQty },
      reward: this._scale(QUEST.deliverReward),
    });
  }

  // ---- player interaction --------------------------------------------------
  accept(quest: Quest, player: Agent): boolean {
    if (!quest || quest.state !== QUEST_STATE.offered) return false;
    quest.state = QUEST_STATE.active;
    quest.acceptedAt = this.sim.time;
    quest.progress = 0;
    this._player = player;
    this.offers = this.offers.filter((q) => q !== quest);
    this.active.push(quest);
    bus.emit({ actorId: player.id, verb: 'QUEST_ACCEPTED', tags: [], magnitude: 1,
      targetId: quest.giverId, t: this.sim.time });
    return true;
  }

  // hunt progress: the sim calls this when the PLAYER kills a monster
  // (onCombatEvents -> dead event whose attacker is the player & target a monster).
  bumpHunt(monsterFaction: string): void {
    // count kills toward EVERY live hunt (offered or accepted): the deed is
    // real whether or not the player formally took the contract.
    for (const q of [...this.offers, ...this.active]) {
      if ((q.type !== 'hunt' && q.type !== 'bounty') || q.finished) continue;
      if (q.target.monsterFaction !== monsterFaction) continue;
      q.progress = Math.min(q.target.count || 0, q.progress + 1);
    }
  }

  // vendetta credit: the sim calls this when the PLAYER deals a killing blow to ANY
  // agent. If that agent was the named foe of a posted vendetta, mark it player-slain
  // so completion (beside the surviving griever) reads as a vengeance YOU delivered.
  bumpVendetta(victimId: EntityId): void {
    for (const q of [...this.offers, ...this.active]) {
      if (q.type !== 'avenge' || q.finished) continue;
      if (q.target.killerId === victimId) q._playerSlew = true;
    }
  }

  // ---- per-tick completion detection (called on the 6Hz loop) --------------
  tick(): void {
    const player: Agent | null = this._player || this.sim.player;
    if (!player) return;
    // Completion is recognised for OFFERED quests too — a giver rationally
    // compensates anyone who did the deed (even unintentionally), because over
    // repeated play a proven helper is worth more than a stranger. Acceptance is
    // now optional (it just tracks the quest in the log). Every payout is a
    // co-located transaction from the giver's own purse.
    for (const q of [...this.offers, ...this.active]) {
      if (q.finished) continue;
      const giver = this.sim.agentsById.get(q.giverId);
      if (!giver || !giver.alive) { this._fail(q, 'giver lost'); continue; }
      const near = player.pos.distanceTo(giver.pos) <= QUEST.recoverNearDist;

      if (q.type === 'fetch' || q.type === 'recover' || q.type === 'deliver') {
        const c = q.target.commodity || 'food', qty = q.target.qty || 0;
        const held = Math.floor(player.inventory[c] || 0);
        q.progress = qty ? Math.min(1, held / qty) : 0;
        if (held >= qty && near) {
          // hand the goods over and let the giver pay for them (a trade). If the
          // giver was desperate for food, the player's delivery is a `succoured`
          // kindness — recorded BEFORE we sate its hunger, so it can grow into a
          // repay(player) goal. Guarded via sim.recordSuccoured.
          if (c === 'food' && this.sim && this.sim.recordSuccoured) this.sim.recordSuccoured(giver, player.id);
          player.inventory[c] -= qty;
          giver.inventory[c] = (giver.inventory[c] || 0) + qty;
          if (c === 'food') giver.needs.hunger = Math.min(1, giver.needs.hunger + 0.4);
          this._complete(q, player, giver);
        }
      } else if (q.type === 'hunt' || q.type === 'bounty') {
        // killed the monsters anywhere; collect from the grateful giver in person
        if (q.progress >= (q.target.count || 0) && near) this._complete(q, player, giver);
      } else if (q.type === 'delve') {
        // dragged a relic out of a dungeon; hand it over near the giver. relics is a
        // running count at runtime (number); the shared Agent type carries it loosely.
        const need = q.target.relics || 1;
        const have = Math.floor((player.relics as number | undefined) || 0);
        q.progress = Math.min(1, have / need);
        if (have >= need && near) { (player as unknown as { relics: number }).relics = have - need; this._complete(q, player, giver); }
      } else if (q.type === 'avenge') {
        // PERSONAL vendetta: satisfied only if the foe FALLS while the griever still
        // lives to see it (the giver-lost guard above already fails it if they died
        // first — a vengeance that came too late). If the PLAYER struck the killer
        // down, it's a fulfilled vendetta → reward, claimed beside the grateful giver.
        const killer = this.sim.agentsById.get(q.target.killerId);
        if (killer && killer.alive) { q.progress = 0; continue; }   // still out there
        if (q._playerSlew) { q.progress = 1; if (near) this._complete(q, player, giver); }
        else { this.offers = this.offers.filter((x) => x !== q); this.active = this.active.filter((x) => x !== q); }   // the town avenged it without you — retire quietly
      }
    }
  }

  _complete(q: Quest, player: Agent, giver?: Agent | null): void {
    q.state = QUEST_STATE.done;
    q.progress = 1;
    giver = giver || this.sim.agentsById.get(q.giverId);
    const r = q.reward;
    // The giver PAYS FROM ITS OWN PURSE — no money is minted, so the closed
    // economy stays intact. It compensates a proven helper as a forward-looking
    // investment, but can only ever pay what it can afford; the rest of the debt
    // rides on the standing bump below (goodwill it will repay another way).
    const pay = giver ? Math.min(r.gold || 0, Math.max(0, Math.floor(giver.gold))) : 0;
    if (pay > 0 && giver) { giver.gold -= pay; player.gold += pay; }
    // Progression.addXP is invoked with an attribution opts object (runtime-tolerant;
    // the signature treats the 2nd arg loosely) — call through a loose view.
    const addXP = player.progression && player.progression.addXP;
    if (r.xp && typeof addXP === 'function') {
      (addXP as (amount: number, opts?: unknown) => void).call(player.progression, r.xp, { reason: 'quest', tags: [q.type] });
    }
    if (giver) giver.openOffer = null;
    // a completed quest is a reputation-bearing deed: the giver + nearby
    // townsfolk who see it warm to the player (witnessDeed moves standing +
    // does the faction rollup).
    if (giver) this.sim.reputation?.witnessDeed?.(this.sim.agents, 'QUEST_DONE', giver.pos, this.sim.time, giver.id);
    bus.emit({ actorId: player.id, verb: 'QUEST_DONE', tags: [q.type], magnitude: r.rep || 1,
      targetId: q.giverId, t: this.sim.time });
    this.offers = this.offers.filter((x) => x !== q);
    this.active = this.active.filter((x) => x !== q);
    this._done = this._done || [];
    this._done.push(q);
  }

  _fail(q: Quest, _why: string): void {
    q.state = QUEST_STATE.failed;
    const giver = this.sim.agentsById.get(q.giverId);
    if (giver) giver.openOffer = null;
    bus.emit({ actorId: (this._player || this.sim.player)?.id ?? -1, verb: 'QUEST_FAILED',
      tags: [], magnitude: 1, targetId: q.giverId, t: this.sim.time });
    this.active = this.active.filter((x) => x !== q);
  }

  // look up a live offer/active quest by id (NPC bounty-hunters resolve the job they
  // read in the Gazette).
  byId(id: number): Quest | null {
    for (const q of this.offers) if (q.id === id) return q;
    for (const q of this.active) if (q.id === id) return q;
    return null;
  }

  // an NPC committed to a quest — PIN it (offers -> active) so board churn (the
  // maxOffers trim) can't yank the job out from under the hunter mid-hunt. The
  // player can still complete it too (a race); the giver-died/finished checks still
  // apply. Idempotent.
  claimForNpc(q: Quest | null | undefined): void {
    if (!q) return;
    const i = this.offers.indexOf(q);
    if (i >= 0) { this.offers.splice(i, 1); q.state = QUEST_STATE.active; this.active.push(q); }
  }

  // an NPC (not the player) settled a quest — the same closed-economy payout as the
  // player path: the giver pays what it can from its OWN purse, no minting. Used by
  // the Bounties subsystem when a bounty-hunter's killing blow completes the job.
  completeByNpc(q: Quest | null | undefined, npc: Agent): void {
    if (!q || !npc || q.finished) return;
    q.state = QUEST_STATE.done; q.progress = 1;
    const giver = this.sim.agentsById.get(q.giverId);
    const r = q.reward || ({} as QuestReward);
    const pay = giver ? Math.min(r.gold || 0, Math.max(0, Math.floor(giver.gold))) : 0;
    if (pay > 0 && giver) { giver.gold -= pay; npc.gold += pay; }
    const addXP = npc.progression && npc.progression.addXP;
    if (r.xp && typeof addXP === 'function') {
      (addXP as (amount: number, opts?: unknown) => void).call(npc.progression, r.xp, { reason: 'bounty', tags: [q.type] });
    }
    if (giver) giver.openOffer = null;
    bus.emit({ actorId: npc.id, verb: 'QUEST_DONE', tags: [q.type], magnitude: r.rep || 1, targetId: q.giverId, t: this.sim.time });
    this.offers = this.offers.filter((x) => x !== q);
    this.active = this.active.filter((x) => x !== q);
    this._done = this._done || []; this._done.push(q);
  }
}
