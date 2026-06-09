// NPC BOUNTY-HUNTERS — agents EXPLOIT the Gazette. A brave, free townsperson
// standing near a market "reads the paper", sees a posted COMBAT bounty (a hunt
// for monsters, or a vendetta against a named foe), and sets out to claim it —
// racing the player for the same reward. First to finish wins; the giver pays from
// its own purse (closed money loop). This makes the newspaper a live labour market.
//
// Deterministic + headless-safe (Math.random + state; no I/O). Reuses the goal/act
// path (a `bounty` goal decide.js routes + act.js walks) and the existing combat;
// completion is credited from combatEvents when a hunter's killing blow lands.
// Modeled on Watch/Reporter: a thin subsystem that flags ordinary agents.

import { BOUNTY, MONSTER } from './simconfig.js';
import { isHomeBuilder } from './construction.js';
import type { Bounty, FullCtx, EntityId } from '../../types/sim.js';

// The (still-.js) Simulation is reached into loosely (agents/quests/gazette/world/
// chronicle + a wide untyped tail), so a precise type would be all-optional noise.
type Sim = any;   // js Simulation — justified loose type
type Ag = any;    // js Agent off the roster — justified loose type (untyped news tail)

export class Bounties {
  sim: Sim;
  _acc: number;
  _readAcc: number;
  stats: { taken: number; done: number; failed: number };

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this._readAcc = 0;
    this.stats = { taken: 0, done: 0, failed: 0 };
  }

  _hunters(): Ag[] { return this.sim.agents.filter((a: Ag) => a && a.alive && a.bounty); }

  tick(ctx: FullCtx | null, dt: number): void {
    try {
      if (!this.sim._spawned || !BOUNTY || !BOUNTY.enabled) return;
      this._acc += dt;
      if (this._acc < (BOUNTY.tickEvery || 3)) return;
      const step = this._acc; this._acc = 0;
      // expire / clean up stale hunts (target gone, timed out)
      for (const a of this._hunters()) this._supervise(a);
      // periodically, townsfolk read the paper and may take fresh work
      this._readAcc += step;
      if (this._readAcc >= (BOUNTY.readEvery || 9)) { this._readAcc = 0; this._readingRound(); }
    } catch { /* never throw on the tick */ }
  }

  // a hunter whose quarry is gone, whose quest was already claimed, or who ran out
  // of time, gives up and reverts to town life.
  _supervise(a: Ag): void {
    const b = a.bounty; if (!b) return;
    const sim = this.sim;
    const quest = sim.quests && sim.quests.byId ? sim.quests.byId(b.questId) : null;
    if (!quest || quest.finished) { this._release(a, false); return; }     // someone else (or the player) got it
    if (sim.time > b.expire) { this._release(a, true); return; }            // gave up
  }

  _readingRound(): void {
    const sim = this.sim;
    if (this._hunters().length >= (BOUNTY.maxConcurrent || 2)) return;
    // the work currently advertised in the paper: recent OPPORTUNITY articles whose
    // quest is a live COMBAT contract (a hunt or a vendetta).
    const arts = (sim.gazette && sim.gazette.recent) ? sim.gazette.recent(20) : [];
    const jobs: any[] = [];
    const seen = new Set<unknown>();
    for (const art of arts) {
      const b = art.brief; if (!b || b.kind !== 'opportunity' || b.questId == null || seen.has(b.questId)) continue;
      const q = sim.quests && sim.quests.byId ? sim.quests.byId(b.questId) : null;
      if (!q || q.finished) continue;
      if (q.type === 'hunt' || q.type === 'bounty' || q.type === 'avenge') { seen.add(b.questId); jobs.push(q); }
    }
    if (!jobs.length) return;

    // a brave, free townsperson standing near a market may answer one.
    const r2 = (BOUNTY.readRange || 22) ** 2;
    for (const a of sim.agents) {
      if (this._hunters().length >= (BOUNTY.maxConcurrent || 2)) break;
      if (!this._eligible(a)) continue;
      if (!this._nearAMarket(a, r2)) continue;
      if (Math.random() > (BOUNTY.takeChance || 0.5)) continue;
      const q = jobs[(Math.random() * jobs.length) | 0];
      if (this._someoneOn(q.id)) continue;        // one NPC per job is plenty (still races the player)
      this._take(a, q);
    }
  }

  _eligible(a: Ag): boolean {
    return a && a.alive && a.autonomous && a.faction === 'townsfolk' &&
      !a.bounty && !a.watch && !a.reporter && !a.inParty && !a.expedition && !a.caravanRun && !a.spy &&
      !isHomeBuilder(a) &&   // leave home-builders to their capital project
      a.personality && a.personality.risk_tolerance >= (BOUNTY.recruitRisk || 0.62);
  }

  _nearAMarket(a: Ag, r2: number): boolean {
    try {
      const m = this.sim.world && this.sim.world.nearest ? this.sim.world.nearest('market', a.pos) : null;
      return !!m && a.pos.distanceToSquared(m.pos) <= r2;
    } catch { return false; }
  }

  _someoneOn(questId: EntityId): boolean { return this.sim.agents.some((a: Ag) => a.bounty && a.bounty.questId === questId); }

  // flag an agent as a bounty-hunter and point it at the quarry.
  _take(a: Ag, q: any): void {
    const sim = this.sim;
    const giver = sim.agentsById.get(q.giverId);
    const tgt = giver ? giver.pos : a.pos;
    const bounty: Bounty = {
      questId: q.id, type: q.type,
      faction: (q.type === 'avenge') ? null : MONSTER.faction,
      killerId: (q.type === 'avenge' && q.target) ? q.target.killerId : null,
      count: (q.target && q.target.count) || 1, got: 0,
      toward: { x: tgt.x, z: tgt.z }, giverId: q.giverId,
      expire: sim.time + (BOUNTY.ttl || 160),
    };
    a._bountyRestore = { combatant: a.combatant, canWork: a.canWork };
    a.bounty = bounty;
    a.combatant = true;        // a hunter fights (and isn't gated as a non-combatant)
    if (sim.quests && sim.quests.claimForNpc) sim.quests.claimForNpc(q);   // pin the job vs board churn
    this.stats.taken++;
    this._note(a.id, `${a.name} took up a bounty from the Gazette and set out to hunt.`);
  }

  // a hunter's killing blow landed on a valid quarry — advance, and finish the job
  // if the count is met. Called from combatEvents. Returns true if completed.
  creditKill(hunter: Ag, victim: Ag): boolean {
    try {
      const b = hunter && hunter.bounty; if (!b || !victim) return false;
      const match = b.killerId != null ? (victim.id === b.killerId) : (victim.faction === b.faction);
      if (!match) return false;
      b.got += 1;
      if (b.got < b.count) return false;
      // DONE — claim the reward (giver pays from its purse: gold conserved).
      const sim = this.sim;
      const quest = sim.quests && sim.quests.byId ? sim.quests.byId(b.questId) : null;
      if (quest && !quest.finished && sim.quests.completeByNpc) sim.quests.completeByNpc(quest, hunter);
      this.stats.done++;
      this._note(hunter.id, `${hunter.name} answered the Gazette's call and claimed the bounty.`);
      this._release(hunter, false);
      return true;
    } catch { return false; }
  }

  _release(a: Ag, gaveUp: boolean): void {
    if (!a) return;
    const r = a._bountyRestore;
    if (r) { a.combatant = r.combatant; a.canWork = r.canWork; }
    a._bountyRestore = null;
    a.bounty = null;
    if (gaveUp) this.stats.failed++;
  }

  _note(id: EntityId, text: string): void { try { if (this.sim.chronicle && this.sim.chronicle.note) this.sim.chronicle.note('press', id, text); } catch { /* */ } }

  dispose(): void { for (const a of this._hunters()) this._release(a, false); }
}
