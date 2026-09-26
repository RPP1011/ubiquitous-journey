// Tabletop combat: a turn-structured ENCOUNTER that opens around the player's fights.
//
// Structure (simultaneous declare, then ordered resolve — "phased rounds"):
//   DECLARE   the world is paused. The player declares (menu or write-in). If the moment is
//             HIGH STAKES, the player also declares for each companion. Everyone else — calm-
//             moment companions, allies, foes — chooses its own action from its OWN beliefs.
//   RESOLVE   defend/guard land first, then everyone in initiative order. Checks are d20 +
//             a derived stat vs a DC read from ground truth (the execution side of the split).
//             Every blow is routed through sim.onCombatEvents, so witnesses, reputation,
//             vendettas, notoriety and XP react exactly as they do to real-time melee.
//   PLAYBACK  the world outside the bubble runs `roundSec` of sim time; bodies inside hold.
//
// Roles:
//   player     you.
//   companion  your party. Independent by default; under your command when stakes are high.
//              A companion whose opinion of you has soured may ignore an order.
//   ally       a bystander who chose to fight on your side, from its own beliefs (it believes a
//              foe is hostile, or it is fond of you). Never under your command.
//   foe        anyone fighting your side — including bystanders who join because they believe
//              YOU are the villain here.
//
// The epistemic split holds: an NPC's choices (join? whom to strike? flee?) read its own
// beliefs, mood and personality; the resolution of what actually happens reads truth.

import * as THREE from 'three';
import { EFFECTS } from '../../rpg/abilities/effects.js';
import { TUNE } from '../../constants.js';
import { rng } from '../../sim/rng.js';
import type { Agent } from '../../../types/sim.js';
import type { Session } from '../session.js';
import { COMBAT, check, chance, sheetOf, type Sheet, type Stat } from './rules.js';
import { TARGETING, VERB_LABEL, VERB_STAT, validateIntent, type EntityRef, type Intent } from './intent.js';
import { parseWriteIn, type Manifest, type Reading } from './parse.js';

export type Role = 'player' | 'companion' | 'ally' | 'foe';
export type Side = 'us' | 'them';
export type Out = null | 'downed' | 'dead' | 'fled' | 'yielded' | 'captured';
export type Outcome = 'victory' | 'defeat' | 'escaped' | 'truce' | 'timeout';

export interface Combatant {
  agent: Agent;
  role: Role;
  side: Side;
  sheet: Sheet;
  init: number;
  out: Out;
  morale: 'steady' | 'shaken' | 'broken';
  defending: boolean;
  guardedBy: Combatant | null;
  exposed: boolean;
  loseAction: boolean;
  tauntedBy: Combatant | null;
  turnedOn: Combatant | null;       // a successful "turncoat" bluff: this one now hunts that one
  lastHitBy: Combatant | null;
  lastTarget: Combatant | null;
  readyRound: Map<string, number>;  // ability id -> first round it may be used again
  bluffHeat: number;                // failed bluffs make this listener harder to fool
  deathSaves: { ok: number; fail: number };   // a downed PLAYER's tabletop death saves
}

export interface LogLine { round: number; kind: 'hit' | 'miss' | 'social' | 'move' | 'join' | 'morale' | 'info' | 'end'; text: string; actorId?: EntityRef; }

export interface Preview { intent: Intent; label: string; stat: Stat | null; dc: number | null; chance: number | null; note: string; }

const DIR = 'DOWN' as const;
const hpFrac = (c: Combatant): number => Math.max(0, c.agent.fighter.health) / TUNE.maxHealth;
const planar = (a: THREE.Vector3, b: THREE.Vector3): number => Math.hypot(a.x - b.x, a.z - b.z);
const nameOf = (c: Combatant | null | undefined): string => (c ? (c.agent.controlled ? 'you' : c.agent.name) : 'someone');
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export class Encounter {
  readonly id: number;
  readonly session: Session;
  members: Combatant[] = [];
  round = 1;
  phase: 'declare' | 'playback' | 'over' = 'declare';
  outcome: Outcome | null = null;
  highStakes = false;
  stakesReason = '';
  log: LogLine[] = [];
  private declared = new Map<EntityRef, Intent>();
  private tricks = new Map<string, number>();     // write-in novelty: trick key -> times used
  private rallied = false;
  private center = new THREE.Vector3();

  constructor(session: Session, id: number, initiator: Agent, target: Agent) {
    this.session = session;
    this.id = id;
    const player = session.player;
    if (player) this.add(player, 'player');
    // who is on which side at the moment of first contact (truth: who is attacking whom)
    const initSide: Side = this.isOurs(initiator) ? 'us' : 'them';
    if (!this.has(initiator)) this.add(initiator, initSide === 'us' ? 'ally' : 'foe');
    if (!this.has(target)) this.add(target, initSide === 'us' ? 'foe' : 'ally');
    for (const m of this.partyMembers()) if (!this.has(m)) this.add(m, 'companion');
    this.recenter();
    this.recruit(true);
    this.note('info', `Combat! ${this.roster('them')} ${this.them().length > 1 ? 'stand' : 'stands'} against ${this.roster('us')}.`);
    this.assessStakes();
  }

  // --------------------------------------------------------------------------------------
  // membership

  private partyMembers(): Agent[] {
    const p = (this.session.sim as { party?: { members?: Agent[] } }).party;
    return (p && p.members ? p.members : []).filter((m) => m && m.alive && !m._held &&
      (!this.session.player || planar(m.pos, this.session.player.pos) <= COMBAT.joinRadius));
  }

  private isOurs(a: Agent): boolean {
    return a.controlled || !!a.inParty;
  }

  has(a: Agent): boolean { return this.members.some((c) => c.agent === a); }
  get(id: EntityRef): Combatant | undefined { return this.members.find((c) => c.agent.id === id); }
  active(): Combatant[] { return this.members.filter((c) => c.out === null && c.agent.alive); }
  us(): Combatant[] { return this.active().filter((c) => c.side === 'us'); }
  them(): Combatant[] { return this.active().filter((c) => c.side === 'them'); }
  opponents(c: Combatant): Combatant[] { return this.active().filter((o) => o.side !== c.side); }
  friends(c: Combatant): Combatant[] { return this.active().filter((o) => o.side === c.side); }
  downed(side: Side): Combatant[] { return this.members.filter((o) => o.side === side && o.out === 'downed' && o.agent.alive); }

  private add(a: Agent, role: Role): Combatant {
    const sheet = sheetOf(a);
    const c: Combatant = {
      agent: a, role, side: role === 'foe' ? 'them' : 'us', sheet,
      init: check(sheet.finesse, 0).total, out: null, morale: 'steady',
      defending: false, guardedBy: null, exposed: false, loseAction: false,
      tauntedBy: null, turnedOn: null, lastHitBy: null, lastTarget: null,
      readyRound: new Map(), bluffHeat: 0, deathSaves: { ok: 0, fail: 0 },
    };
    a._encounter = this.id;
    try { a.fighter.stopBlock(); a.fighter.setMoving(0); } catch { /* stub bodies */ }
    this.members.push(c);
    return c;
  }

  private release(c: Combatant): void {
    if (c.agent._encounter === this.id) c.agent._encounter = null;
  }

  private recenter(): void {
    const act = this.active();
    if (!act.length) return;
    this.center.set(0, 0, 0);
    for (const c of act) this.center.add(c.agent.pos);
    this.center.multiplyScalar(1 / act.length);
  }

  private roster(side: Side): string {
    const xs = this.active().filter((c) => c.side === side).map((c) => nameOf(c));
    if (!xs.length) return 'no one';
    return xs.length === 1 ? cap(xs[0]) : `${cap(xs.slice(0, -1).join(', '))} and ${xs[xs.length - 1]}`;
  }

  /**
   * Bystanders decide, from their OWN beliefs, whether to wade in and on which side.
   * Runs at the start of every round, so a fight draws in the town as word spreads.
   */
  private recruit(opening = false): void {
    const sim = this.session.sim;
    const us = this.us(), them = this.them();
    for (const a of sim.agents as Agent[]) {
      if (!a.alive || a.controlled || a._held || a._encounter != null) continue;
      const dist = planar(a.pos, this.center);
      if (dist > COMBAT.joinRadius) continue;
      // at first contact, anyone already standing in the fray commits without hesitation
      const gate = opening && dist <= COMBAT.engageRadius ? 1 : null;
      if (a.inParty) { this.join(a, 'companion'); continue; }
      const b = (id: EntityRef) => a.beliefs.get(id);
      const hostileTo = (xs: Combatant[]) => xs.some((x) => { const bb = b(x.agent.id); return !!bb && (bb.hostile || bb.standing < -0.5); });
      const fondOf = (xs: Combatant[]) => xs.some((x) => { const bb = b(x.agent.id); return !!bb && bb.standing > COMBAT.allyJoin.fondness; });
      const brave = sheetOf(a).nerve >= COMBAT.allyJoin.courage * 6 || a.combatant;
      if (!brave) continue;
      const againstUs = hostileTo(us) && !hostileTo(them);
      const againstThem = hostileTo(them) || (fondOf(us) && this.rallied);
      if (againstUs && rng() < (gate ?? 0.6)) this.join(a, 'foe');
      else if (againstThem && !againstUs && rng() < (gate ?? (this.rallied ? 0.85 : 0.5))) this.join(a, 'ally');
    }
    this.rallied = false;
  }

  private join(a: Agent, role: Role): void {
    const c = this.add(a, role);
    if (this.round > 1 || role === 'ally') {
      const why = role === 'ally' ? 'comes to your aid' : role === 'companion' ? 'is at your side' : 'joins against you';
      this.note('join', `${cap(nameOf(c))} ${why}.`, a.id);
    }
  }

  // --------------------------------------------------------------------------------------
  // stakes + command

  /** High stakes put companions under the player's command for the round. */
  private assessStakes(): void {
    const S = COMBAT.highStakes;
    const reasons: string[] = [];
    const p = this.members.find((c) => c.role === 'player' && c.out === null);
    if (p && hpFrac(p) < S.playerHp) reasons.push('you are badly hurt');
    const fallingCompanion = this.us().find((c) => c.role === 'companion' && hpFrac(c) < S.companionHp);
    if (fallingCompanion) reasons.push(`${fallingCompanion.agent.name} is about to fall`);
    const power = (xs: Combatant[]) => xs.reduce((s, c) => s + hpFrac(c) * (1 + c.sheet.might * 0.25), 0);
    if (power(this.them()) > power(this.us()) * S.odds) reasons.push('you are outmatched');
    const named = this.them().find((c) => c.agent.epithet);
    if (S.namedFoe && named) reasons.push(`${named.agent.name} is no common foe`);
    const hasCompanions = this.us().some((c) => c.role === 'companion');
    this.highStakes = hasCompanions && reasons.length > 0;
    this.stakesReason = reasons.join('; ');
  }

  /** Combatants waiting on the player's input this round (player first, then commanded companions). */
  pendingDeclarers(): Combatant[] {
    if (this.phase !== 'declare') return [];
    return this.active().filter((c) =>
      (c.role === 'player' || (c.role === 'companion' && this.highStakes)) && !this.declared.has(c.agent.id));
  }

  // --------------------------------------------------------------------------------------
  // declaring

  manifestFor(c: Combatant): Manifest {
    const entry = (o: Combatant) => ({
      id: o.agent.id, name: o.agent.name || 'someone',
      aliases: [o.agent.faction, (o.agent as { profession?: string | null }).profession, o.agent.epithet,
        o.agent.faction === 'monster' ? 'beast' : null, o.agent.faction === 'bandit' ? 'brigand' : null]
        .filter((x): x is string => typeof x === 'string' && x.length > 0),
    });
    return {
      selfId: c.agent.id,
      currentTargetId: c.lastTarget && c.lastTarget.out === null ? c.lastTarget.agent.id : (this.opponents(c)[0]?.agent.id ?? null),
      foes: this.opponents(c).map(entry),
      allies: [...this.friends(c), ...this.downed(c.side)].filter((o) => o !== c).map(entry),
      abilities: [...(c.agent.abilities?.values?.() ?? [])].map((s) => ({ id: s.id, name: s.name })),
    };
  }

  /** Parse a write-in for a declarer. Ranked readings; the UI shows the first as the confirm chip. */
  readWriteIn(c: Combatant, text: string): Reading[] {
    return parseWriteIn(text, this.manifestFor(c));
  }

  /** The DC and odds of an intent, for the confirm chip. Reads truth (it is the GM's ruling). */
  preview(c: Combatant, intent: Intent): Preview {
    const t = intent.targetId != null ? this.get(intent.targetId) : undefined;
    const stat = intent.verb === 'ability' ? 'might' : VERB_STAT[intent.verb];
    const dc = this.dcFor(c, intent, t);
    const mod = stat ? c.sheet[stat] + this.trickMod(intent, false) : 0;
    const tn = t ? ` → ${nameOf(t)}` : '';
    let label = `${VERB_LABEL[intent.verb]}${tn}`;
    if (intent.verb === 'ability' && intent.abilityId) label = `${c.agent.abilities.get(intent.abilityId)?.name || 'Ability'}${tn}`;
    if (intent.verb === 'bluff' && intent.claim) label += ` (${intent.claim.replace('_', ' ')})`;
    let note = '';
    if (intent.verb === 'improvise') note = this.trickMod(intent, false) > 0 ? 'a fresh trick (+2)' : 'they have seen this before';
    if (intent.verb === 'ability' && intent.abilityId && (c.readyRound.get(intent.abilityId) ?? 0) > this.round) note = 'not ready yet';
    return { intent, label, stat, dc, chance: dc == null || !stat ? null : chance(mod, dc), note };
  }

  /** Declare an action for a combatant the player controls. Returns an error string on refusal. */
  declare(c: Combatant, intent: Intent): string | null {
    if (this.phase !== 'declare') return 'not accepting orders now';
    if (!validateIntent(intent)) return 'that is not an action';
    const need = TARGETING[intent.verb];
    const t = intent.targetId != null ? this.get(intent.targetId) : undefined;
    if (need === 'foe' && (!t || t.side === c.side || t.out !== null)) return 'choose a foe';
    if (need === 'ally' && (!t || t.side !== c.side || (t.out !== null && !(intent.verb === 'aid' && t.out === 'downed')))) return 'choose an ally';
    if (intent.verb === 'ability') {
      if (!intent.abilityId || !c.agent.abilities.has(intent.abilityId)) return 'you do not know that ability';
      if ((c.readyRound.get(intent.abilityId) ?? 0) > this.round) return 'that ability is not ready';
    }
    // A companion with a soured opinion of you may ignore the order (its own belief decides).
    if (c.role === 'companion') {
      const b = c.agent.beliefs.get(this.session.player?.id ?? -1);
      if ((b && b.standing < -0.2) || c.morale === 'broken') {
        this.declared.set(c.agent.id, this.chooseFor(c));
        this.note('social', `${c.agent.name} ignores your order.`, c.agent.id);
        return null;
      }
    }
    this.declared.set(c.agent.id, intent);
    return null;
  }

  // --------------------------------------------------------------------------------------
  // NPC choice — reads the chooser's OWN beliefs, mood and personality

  chooseFor(c: Combatant): Intent {
    const foes = this.opponents(c);
    const P = (c.agent.personality || {}) as Record<string, number>;
    const live = (x: Combatant | null) => (x && x.out === null && x.agent.alive ? x : null);
    if (live(c.turnedOn)) return { verb: 'strike', targetId: c.turnedOn!.agent.id };
    if (live(c.tauntedBy) && c.tauntedBy!.side !== c.side) return { verb: 'strike', targetId: c.tauntedBy!.agent.id };
    if (!foes.length) return { verb: 'defend' };
    if (hpFrac(c) < 0.4 && ((c.agent.inventory as Record<string, number> | undefined)?.potion || 0) >= 1) return { verb: 'aid', targetId: c.agent.id };
    const fallen = this.downed(c.side)[0];
    if (fallen && (P.altruism || 0) > 0.35 && rng() < 0.7) return { verb: 'aid', targetId: fallen.agent.id };
    if ((P.altruism || 0) > 0.6) {
      const ward = this.friends(c).find((f) => f !== c && hpFrac(f) < 0.35 && !f.guardedBy);
      if (ward) return { verb: 'guard', targetId: ward.agent.id };
    }
    // whom: whoever last hurt me, else the weakest foe I can see (focus fire), sticky to my last target
    const seen = foes.filter((f) => c.agent.beliefs.get(f.agent.id) || planar(f.agent.pos, c.agent.pos) < 12);
    const pool = seen.length ? seen : foes;
    let t = live(c.lastHitBy) && c.lastHitBy!.side !== c.side ? c.lastHitBy! : null;
    if (!t && live(c.lastTarget) && c.lastTarget!.side !== c.side && rng() < 0.6) t = c.lastTarget!;
    if (!t) t = pool.reduce((m, f) => (hpFrac(f) < hpFrac(m) ? f : m), pool[0]);
    // silver tongues talk; the angry and the bold hit
    if (c.sheet.presence > c.sheet.might && rng() < 0.35) {
      return rng() < 0.5 ? { verb: 'intimidate', targetId: t.agent.id } : { verb: 'bluff', targetId: t.agent.id, claim: 'look_behind' };
    }
    const ready = [...(c.agent.abilities?.values?.() ?? [])].find((s) =>
      (c.readyRound.get(s.id) ?? 0) <= this.round && s.effects.some((e) => e.op === 'damage'));
    if (ready && rng() < 0.6) return { verb: 'ability', abilityId: ready.id, targetId: t.agent.id };
    if (c.sheet.finesse > c.sheet.might + 1 && !t.exposed && rng() < 0.3) return { verb: 'feint', targetId: t.agent.id };
    return { verb: 'strike', targetId: t.agent.id };
  }

  // --------------------------------------------------------------------------------------
  // resolution

  private defenseOf(t: Combatant): number {
    return COMBAT.baseDefense + t.sheet.finesse + (t.defending ? COMBAT.defendBonus : 0) +
      (t.guardedBy && t.guardedBy.out === null ? COMBAT.guardBonus : 0) - (t.exposed ? 4 : 0) - (t.loseAction ? 2 : 0);
  }

  private trickKey(intent: Intent): string | null {
    if (intent.verb !== 'improvise' || !intent.flourish) return null;
    const words = intent.flourish.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4).sort();
    return words.slice(0, 3).join('+') || null;
  }

  private trickMod(intent: Intent, consume: boolean): number {
    const k = this.trickKey(intent);
    if (!k) return 0;
    const n = this.tricks.get(k) || 0;
    if (consume) this.tricks.set(k, n + 1);
    return n === 0 ? COMBAT.novelBonus : -COMBAT.staleTrickPenalty * n;
  }

  private dcFor(c: Combatant, intent: Intent, t: Combatant | undefined): number | null {
    const bl = t ? t.agent.beliefs.get(c.agent.id) : undefined;
    switch (intent.verb) {
      case 'strike': case 'improvise': case 'ability': return t ? this.defenseOf(t) : null;
      case 'shove': return t ? 10 + t.sheet.might + (t.defending ? 2 : 0) : null;
      case 'trip': case 'feint': return t ? 10 + t.sheet.finesse : null;
      case 'bluff': {
        if (!t) return null;
        let dc = 10 + Math.round(t.sheet.nerve / 2) + Math.round((bl?.suspicion || 0) * 8) + t.bluffHeat;
        if (intent.claim === 'reinforcements') dc += this.us().length >= this.them().length ? -1 : 2;
        if (intent.claim === 'turncoat' && intent.subjectId != null) {
          const bs = t.agent.beliefs.get(intent.subjectId);   // the listener's OWN view of the accused
          dc += bs ? Math.round(bs.standing * 6 - bs.suspicion * 4) : 2;
        }
        return dc;
      }
      case 'intimidate': return t ? 10 + t.sheet.nerve + (t.morale === 'steady' ? 1 : -2) - Math.round((bl?.notoriety || 0) * 4) : null;
      case 'taunt': return t ? 10 + Math.round(t.sheet.nerve / 2) - Math.round(((t.agent.mood && t.agent.mood.anger) || 0) * 4) : null;
      case 'rally': return 12;
      case 'aid': return 11;
      case 'flee': return 8 + this.opponents(c).length * 2;
      case 'parley': {
        const foes = this.opponents(c);
        const lead = foes.reduce((m, f) => Math.max(m, f.sheet.nerve), 0);
        const mood = foes.reduce((s, f) => s + (f.agent.beliefs.get(c.agent.id)?.standing || 0), 0) / Math.max(1, foes.length);
        const odds = this.them().length / Math.max(1, this.us().length);
        return 10 + lead + Math.round((odds - 1) * 4) - Math.round(mood * 5);
      }
      default: return null;
    }
  }

  /** Close the gap to a target (movement is free within a round). Truth-side body placement. */
  private closeTo(c: Combatant, t: Combatant): void {
    const a = c.agent.pos, b = t.agent.pos;
    const d = planar(a, b);
    const face = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    try { c.agent.fighter.root.rotation.y = face; } catch { /* stub */ }
    if (d > 2.2) {
      const k = (d - 1.7) / d;
      a.x += (b.x - a.x) * k; a.z += (b.z - a.z) * k;
    }
  }

  private swing(c: Combatant): void {
    try { c.agent.fighter.ready(DIR); c.agent.fighter.release(); } catch { /* cosmetic */ }
  }

  /** Apply damage through the block-aware body and route the result through the engine's fold. */
  private wound(c: Combatant, t: Combatant, amount: number): 'hit' | 'dead' | 'blocked' {
    const tf = t.agent.fighter;
    if (!tf.alive) return 'dead';
    const dmg = Math.max(1, Math.round(amount));
    if (t.side === 'us' && dmg >= tf.health && this.us().some((o) => o !== t)) {
      tf.health = 0.5;   // alive, but out of the fight until someone gets them up
      t.out = 'downed'; t.lastHitBy = c;
      this.session.sim.onCombatEvents([{ type: 'hit', attacker: c.agent.fighter, target: tf, point: t.agent.pos.clone() }] as never);
      return 'hit';
    }
    const res = tf.takeHit(dmg, DIR);
    t.lastHitBy = c;
    this.session.sim.onCombatEvents([{ type: res, attacker: c.agent.fighter, target: tf, point: t.agent.pos.clone() }] as never);
    if (res === 'dead' || !t.agent.alive) {
      t.out = t.agent._held ? 'captured' : 'dead';
      this.release(t);
      return 'dead';
    }
    if (t.agent._held) { t.out = 'captured'; this.release(t); }
    return res;
  }

  private strikeDamage(c: Combatant, t: Combatant, crit: boolean, mul = 1): number {
    let d = COMBAT.damageBase * (0.75 + 0.08 * c.sheet.might) * (0.85 + rng() * 0.3) * mul;
    if (crit) d *= COMBAT.critMul;
    if (t.exposed) { d *= COMBAT.exposeMul; t.exposed = false; }
    return d;
  }

  private redirectGuard(t: Combatant): Combatant {
    const g = t.guardedBy;
    if (g && g.out === null && g.agent.alive && rng() < 0.5) {
      this.note('move', `${cap(nameOf(g))} steps in front of ${nameOf(t)}.`, g.agent.id);
      return g;
    }
    return t;
  }

  private resolveOne(c: Combatant, intent: Intent): void {
    if (c.out !== null || !c.agent.alive) return;
    if (c.loseAction) { c.loseAction = false; this.note('miss', `${cap(nameOf(c))} ${c.agent.controlled ? 'are' : 'is'} off balance and loses the moment.`, c.agent.id); return; }
    let t = intent.targetId != null ? this.get(intent.targetId) : undefined;
    const needFoe = TARGETING[intent.verb] === 'foe' || (intent.verb === 'ability' && t);
    if (needFoe && (!t || t.out !== null || !t.agent.alive)) {
      // the declared target fell or fled before this turn: swing at the nearest other foe
      const alt = this.opponents(c).sort((x, y) => planar(x.agent.pos, c.agent.pos) - planar(y.agent.pos, c.agent.pos))[0];
      if (!alt) return;
      t = alt;
    }
    if (t && t.side !== c.side) c.lastTarget = t;
    const who = cap(nameOf(c));
    const flair = intent.flourish ? ` — "${intent.flourish}"` : '';
    const stat = VERB_STAT[intent.verb];
    const roll = (dc: number, extra = 0) => check((stat ? c.sheet[stat] : 0) + extra, dc);

    switch (intent.verb) {
      case 'strike': case 'improvise': {
        t = this.redirectGuard(t!);
        this.closeTo(c, t); this.swing(c);
        const extra = intent.verb === 'improvise' ? Math.max(c.sheet.finesse, c.sheet.might) - c.sheet.finesse + this.trickMod(intent, true) : 0;
        const r = roll(this.defenseOf(t), extra);
        if (!r.ok) { this.note('miss', `${who} ${intent.verb === 'improvise' ? 'tries something' + flair + ' — but' : 'swings at ' + nameOf(t) + ' and'} misses.`, c.agent.id); break; }
        const res = this.wound(c, t, this.strikeDamage(c, t, r.crit, intent.verb === 'improvise' ? 0.8 : 1));
        if (intent.verb === 'improvise' && res !== 'dead') { t.exposed = true; if (r.crit) t.loseAction = true; }
        this.note('hit', `${who} ${intent.verb === 'improvise' ? 'pull' + (c.agent.controlled ? '' : 's') + ' it off' + flair + ' —' : 'hit' + (c.agent.controlled ? '' : 's')} ${nameOf(t)}${r.crit ? ' (critical!)' : ''}${res === 'dead' ? `, and ${nameOf(t)} ${t.out === 'captured' ? 'is taken captive' : 'falls'}` : res === 'blocked' ? ' but it is turned aside' : ''}.`, c.agent.id);
        break;
      }
      case 'ability': {
        const spec = intent.abilityId ? c.agent.abilities.get(intent.abilityId) : undefined;
        if (!spec) return;
        c.readyRound.set(spec.id, this.round + Math.max(1, Math.ceil((spec.header.cooldown || 0) / COMBAT.roundSec)));
        const hostile = spec.effects.some((e) => e.op === 'damage' || e.op === 'stun' || e.op === 'expose' || e.op === 'slow' || e.op === 'knockback');
        const ctx = { time: this.session.sim.time };
        if (!hostile || !t) {
          for (const e of spec.effects) if (!e.when) (EFFECTS as Record<string, (e: unknown, a: Agent, t: Agent | null, ctx: unknown) => boolean>)[e.op]?.(e, c.agent, c.agent, ctx);
          this.note('hit', `${who} ${c.agent.controlled ? 'use' : 'uses'} ${spec.name}.`, c.agent.id);
          break;
        }
        const area = spec.header.area;
        const targets = area && area.kind !== 'self' && 'r' in area && area.r > 2.5
          ? this.opponents(c).filter((o) => planar(o.agent.pos, t!.agent.pos) <= area.r)
          : [this.redirectGuard(t)];
        if (spec.header.range <= 3) this.closeTo(c, targets[0]);
        this.swing(c);
        const parts: string[] = [];
        for (const tt of targets) {
          const r = check(Math.max(c.sheet.might, c.sheet.presence) + 1, this.defenseOf(tt));
          if (!r.ok) { parts.push(`${nameOf(tt)} evades`); continue; }
          let fell = false;
          for (const e of spec.effects) {
            if (e.when && e.when !== 'on_hit') continue;
            if (e.op === 'damage') {
              const amt = (e.amount || COMBAT.damageBase) * (r.crit ? COMBAT.critMul : 1) * (tt.exposed ? COMBAT.exposeMul : 1);
              tt.exposed = false;
              if (this.wound(c, tt, amt) === 'dead') { fell = true; break; }
            } else {
              (EFFECTS as Record<string, (e: unknown, a: Agent, t: Agent | null, ctx: unknown) => boolean>)[e.op]?.(e, c.agent, tt.agent, ctx);
              if (e.op === 'stun') tt.loseAction = true;
              if (e.op === 'expose') tt.exposed = true;
            }
          }
          parts.push(fell ? `${nameOf(tt)} falls` : `${nameOf(tt)} is hit`);
        }
        this.note('hit', `${who} ${c.agent.controlled ? 'unleash' : 'unleashes'} ${spec.name}: ${parts.join(', ')}.`, c.agent.id);
        break;
      }
      case 'defend':
        c.defending = true;
        this.note('move', `${who} ${c.agent.controlled ? 'brace' : 'braces'}.`, c.agent.id);
        break;
      case 'guard':
        if (t && t !== c) { t.guardedBy = c; this.closeTo(c, t); this.note('move', `${who} ${c.agent.controlled ? 'cover' : 'covers'} ${nameOf(t)}.`, c.agent.id); }
        break;
      case 'shove': {
        this.closeTo(c, t!);
        const r = roll(this.dcFor(c, intent, t)!);
        if (r.ok) { t!.loseAction = true; t!.defending = false; this.wound(c, t!, 6); try { EFFECTS.knockback({ op: 'knockback', amount: 2 } as never, c.agent, t!.agent, null); } catch { /* */ } this.note('hit', `${who} ${c.agent.controlled ? 'shove' : 'shoves'} ${nameOf(t)} off balance${flair}.`, c.agent.id); }
        else this.note('miss', `${who} ${c.agent.controlled ? 'try' : 'tries'} to shove ${nameOf(t)}, who holds firm.`, c.agent.id);
        break;
      }
      case 'trip': case 'feint': {
        this.closeTo(c, t!);
        const r = roll(this.dcFor(c, intent, t)!);
        if (r.ok) { t!.exposed = true; t!.defending = false; this.note('hit', `${who} ${intent.verb === 'trip' ? 'sweep' : 'feint'}${c.agent.controlled ? '' : 's'}${flair ? flair : ''} — ${nameOf(t)} is wide open.`, c.agent.id); }
        else { if (r.fumble) c.exposed = true; this.note('miss', `${cap(nameOf(t))} reads ${nameOf(c)}'s ${intent.verb}${r.fumble ? ' and punishes the opening' : ''}.`, c.agent.id); }
        break;
      }
      case 'bluff': this.resolveBluff(c, t!, intent, roll); break;
      case 'intimidate': {
        const r = roll(this.dcFor(c, intent, t)!);
        const b = t!.agent.beliefs.get(c.agent.id);
        if (r.ok) {
          t!.morale = t!.morale === 'steady' ? 'shaken' : 'broken';
          if (t!.agent.mood) t!.agent.mood.fear = Math.min(1, (t!.agent.mood.fear || 0) + 0.35);
          if (b) b.believedThreat = Math.max(b.believedThreat || 0, 0.8);
          this.note('social', `${who} ${c.agent.controlled ? 'terrify' : 'terrifies'} ${nameOf(t)}${flair}. ${cap(nameOf(t))} is ${t!.morale}.`, c.agent.id);
        } else this.note('miss', `${cap(nameOf(t))} is not impressed by ${nameOf(c)}.`, c.agent.id);
        break;
      }
      case 'taunt': {
        const r = roll(this.dcFor(c, intent, t)!);
        if (r.ok) { t!.tauntedBy = c; t!.defending = false; if (t!.agent.mood) t!.agent.mood.anger = Math.min(1, (t!.agent.mood.anger || 0) + 0.3); this.note('social', `${cap(nameOf(t))} takes ${nameOf(c)}'s bait${flair} and turns on ${c.agent.controlled ? 'you' : 'them'}.`, c.agent.id); }
        else this.note('miss', `${cap(nameOf(t))} ignores the taunt.`, c.agent.id);
        break;
      }
      case 'rally': {
        const r = roll(12);
        if (r.ok) {
          this.rallied = true;
          for (const f of this.friends(c)) { if (f.morale !== 'broken') f.morale = 'steady'; if (f.agent.mood) f.agent.mood.fear = Math.max(0, (f.agent.mood.fear || 0) - 0.2); }
          this.note('social', `${who} ${c.agent.controlled ? 'rally' : 'rallies'} ${c.side === 'us' ? 'your side' : 'their side'}${flair}. Onlookers take notice.`, c.agent.id);
        } else this.note('miss', `${who} ${c.agent.controlled ? 'call' : 'calls'} out, but no one answers.`, c.agent.id);
        break;
      }
      case 'aid': {
        const w = t && t.side === c.side ? t : c;
        if (w.out === 'downed') {
          const r = roll(10);
          if (r.ok) { w.out = null; w.deathSaves = { ok: 0, fail: 0 }; w.agent.fighter.health = Math.min(TUNE.maxHealth, 15 + c.sheet.finesse * 3); this.note('move', `${who} ${c.agent.controlled ? 'haul' : 'hauls'} ${nameOf(w)} back to ${w.agent.controlled ? 'your' : 'their'} feet.`, c.agent.id); }
          else this.note('miss', `${who} ${c.agent.controlled ? "can't" : "can't"} rouse ${nameOf(w)}.`, c.agent.id);
          break;
        }
        const inv = c.agent.inventory as Record<string, number> | undefined;
        if (inv && (inv.potion || 0) >= 1) {
          inv.potion -= 1;   // a real potion leaves a real inventory (conserved)
          w.agent.fighter.health = Math.min(TUNE.maxHealth, w.agent.fighter.health + 45);
          this.note('move', `${who} ${c.agent.controlled ? 'pour' : 'pours'} a potion into ${w === c ? (c.agent.controlled ? 'yourself' : 'themself') : nameOf(w)}.`, c.agent.id);
        } else {
          const r = roll(11);
          if (r.ok) { w.agent.fighter.health = Math.min(TUNE.maxHealth, w.agent.fighter.health + 12 + c.sheet.finesse * 2); this.note('move', `${who} ${c.agent.controlled ? 'bind' : 'binds'} ${w === c ? 'a wound' : nameOf(w) + "'s wound"}.`, c.agent.id); }
          else this.note('miss', `${who} ${c.agent.controlled ? 'fumble' : 'fumbles'} the bandage.`, c.agent.id);
        }
        try { (w.agent.fighter as { _updateHealthBar?: () => void })._updateHealthBar?.(); } catch { /* */ }
        break;
      }
      case 'flee': {
        const r = roll(this.dcFor(c, intent, undefined)!);
        if (r.ok) {
          c.out = 'fled'; this.release(c);
          if (c.agent.mood) c.agent.mood.fear = Math.min(1, (c.agent.mood.fear || 0) + 0.5);
          this.note('move', `${who} ${c.agent.controlled ? 'break' : 'breaks'} away and ${c.agent.controlled ? 'flee' : 'flees'}.`, c.agent.id);
        } else this.note('miss', `${who} ${c.agent.controlled ? 'try' : 'tries'} to break away but ${c.agent.controlled ? 'are' : 'is'} cut off.`, c.agent.id);
        break;
      }
      case 'parley': {
        const r = roll(this.dcFor(c, intent, undefined)!);
        if (r.ok) {
          for (const f of this.opponents(c)) {
            const b = f.agent.beliefs.get(c.agent.id);
            if (b) { b.hostile = false; b.standing = Math.max(b.standing, -0.3); }
            f.out = 'yielded'; this.release(f);
          }
          this.note('social', `${who} ${c.agent.controlled ? 'talk' : 'talks'} them down${flair}. Weapons lower.`, c.agent.id);
          if (c.side === 'us') this.outcome = 'truce';
        } else this.note('miss', `${who} ${c.agent.controlled ? 'try' : 'tries'} to parley; no one is listening.`, c.agent.id);
        break;
      }
    }
  }

  private resolveBluff(c: Combatant, t: Combatant, intent: Intent, roll: (dc: number, extra?: number) => ReturnType<typeof check>): void {
    const who = cap(nameOf(c));
    const r = roll(this.dcFor(c, intent, t)!);
    const b = t.agent.beliefs.get(c.agent.id);
    if (!r.ok) {
      t.bluffHeat += 2;
      if (b) b.suspicion = Math.min(1, (b.suspicion || 0) + 0.3);
      this.note('miss', `${cap(nameOf(t))} doesn't buy it — and trusts ${nameOf(c)} a little less.`, c.agent.id);
      return;
    }
    switch (intent.claim) {
      case 'reinforcements':
        t.morale = t.morale === 'steady' ? 'shaken' : 'broken';
        if (t.agent.mood) t.agent.mood.fear = Math.min(1, (t.agent.mood.fear || 0) + 0.3);
        this.note('social', `${cap(nameOf(t))} believes help is coming for ${c.side === 'us' ? 'you' : 'them'} and falters.`, c.agent.id);
        break;
      case 'turncoat': {
        const s = intent.subjectId != null ? this.get(intent.subjectId) : undefined;
        if (!s) break;
        // plant a belief the listener KEEPS after the fight — and may gossip
        const bs = t.agent.beliefs.get(s.agent.id);
        if (bs) { bs.hostile = true; bs.standing = Math.max(-1, bs.standing - 0.6); bs.suspicion = Math.min(1, bs.suspicion + 0.5); }
        else t.agent.beliefs.plant(s.agent.id, { faction: s.agent.faction, pos: s.agent.pos, tick: this.session.sim.time, hostile: true, suspicion: 0.6, confidence: 0.6 });
        t.turnedOn = s;
        this.note('social', `${who} ${c.agent.controlled ? 'convince' : 'convinces'} ${nameOf(t)} that ${nameOf(s)} is a traitor. ${cap(nameOf(t))} rounds on ${nameOf(s)}!`, c.agent.id);
        break;
      }
      case 'surrender_terms':
        this.resolveOne(c, { verb: 'parley', flourish: intent.flourish });
        break;
      default:
        t.loseAction = true; t.exposed = true;
        this.note('social', `${cap(nameOf(t))} looks — and ${nameOf(c)} ${c.agent.controlled ? 'have' : 'has'} an opening.`, c.agent.id);
    }
  }

  /** The downed player rolls a death save each round: three failures and the fall is final. */
  private deathSaves(): void {
    for (const c of this.members) {
      if (c.out !== 'downed' || c.role !== 'player' || !c.agent.alive || c.deathSaves.ok >= 3) continue;
      const r = check(0, 10);
      if (r.crit) { c.out = null; c.agent.fighter.health = 10; this.note('move', 'You drag yourself up, somehow.', c.agent.id); continue; }
      if (r.ok) c.deathSaves.ok++; else c.deathSaves.fail += r.fumble ? 2 : 1;
      if (c.deathSaves.ok >= 3) { c.deathSaves = { ok: 3, fail: c.deathSaves.fail }; this.note('info', 'You are stable, but out of the fight.', c.agent.id); }
      else if (c.deathSaves.fail >= 3) this.kill(c);
      else this.note('info', `You cling on (${c.deathSaves.ok} saves, ${c.deathSaves.fail} failures).`, c.agent.id);
    }
  }

  private kill(c: Combatant): void {
    const killer = c.lastHitBy;
    c.agent.fighter.health = 0.5;
    c.agent.fighter.takeHit(1e6, DIR);
    if (killer) this.session.sim.onCombatEvents([{ type: 'dead', attacker: killer.agent.fighter, target: c.agent.fighter, point: c.agent.pos.clone() }] as never);
    c.out = 'dead'; this.release(c);
  }

  /** End-of-round nerve: the badly hurt, the shaken and the outnumbered may break and run. */
  private morale(): void {
    const lostShare = (side: Side) => {
      const all = this.members.filter((m) => m.side === side);
      return all.length ? all.filter((m) => m.out === 'dead' || m.out === 'captured').length / all.length : 0;
    };
    for (const c of this.active()) {
      if (c.role === 'player') continue;
      const pressed = hpFrac(c) < COMBAT.moraleBreakHp || c.morale !== 'steady' || lostShare(c.side) >= 0.5;
      if (!pressed) continue;
      const r = check(c.sheet.nerve, COMBAT.moraleDC + (c.morale === 'shaken' ? 2 : 0) + (c.morale === 'broken' ? 20 : 0));
      if (r.ok) continue;
      c.out = 'fled'; c.morale = 'broken'; this.release(c);
      if (c.agent.mood) c.agent.mood.fear = Math.min(1, (c.agent.mood.fear || 0) + 0.6);
      this.note('morale', `${cap(nameOf(c))}'s nerve breaks — ${c.role === 'foe' ? 'they flee' : 'they run from the fight'}.`, c.agent.id);
    }
  }

  /**
   * Resolve the round: fill every undeclared combatant from its own choice, order, apply.
   * Leaves the encounter in 'playback' (or 'over'); call finishPlayback() after the world has
   * advanced roundSec.
   */
  resolve(): void {
    if (this.phase !== 'declare') return;
    const act = this.active();
    for (const c of act) if (!this.declared.has(c.agent.id)) this.declared.set(c.agent.id, this.chooseFor(c));
    for (const c of act) { c.defending = false; c.guardedBy = null; }
    const fast = (i: Intent) => i.verb === 'defend' || i.verb === 'guard';
    const order = [...act].sort((a, b) => b.init - a.init);
    for (const c of order) { const i = this.declared.get(c.agent.id)!; if (fast(i)) this.resolveOne(c, i); }
    for (const c of order) {
      const i = this.declared.get(c.agent.id)!;
      if (!fast(i)) this.resolveOne(c, i);
      if (this.outcome) break;
    }
    for (const c of this.members) { if (c.tauntedBy && !this.declared.has(c.agent.id)) c.tauntedBy = null; }
    this.declared.clear();
    this.deathSaves();
    if (!this.outcome) this.morale();
    this.checkEnd();
    this.phase = this.outcome ? 'over' : 'playback';
    if (this.outcome) this.finish();
  }

  /** The world has advanced; open the next round's declarations (bystanders may join now). */
  finishPlayback(): void {
    if (this.phase !== 'playback') return;
    // anyone who wandered/was knocked out of the fight has left it
    this.recenter();
    for (const c of this.active()) {
      if (planar(c.agent.pos, this.center) > COMBAT.leaveRadius) { c.out = 'fled'; this.release(c); }
    }
    this.round++;
    this.recruit();
    this.checkEnd();
    if (this.outcome) { this.phase = 'over'; this.finish(); return; }
    this.assessStakes();
    this.phase = 'declare';
    for (const c of this.members) { if (c.tauntedBy && c.tauntedBy.out !== null) c.tauntedBy = null; if (c.turnedOn && c.turnedOn.out !== null) c.turnedOn = null; }
    if (this.highStakes) this.note('info', `High stakes (${this.stakesReason}): your companions await your orders.`);
  }

  private checkEnd(): void {
    if (this.outcome) return;
    const p = this.members.find((c) => c.role === 'player');
    if (p && (!p.agent.alive || p.out === 'dead' || p.out === 'captured')) this.outcome = 'defeat';
    else if (!this.us().length && this.downed('us').length) this.outcome = 'defeat';
    else if (p && p.out === 'fled') this.outcome = 'escaped';
    else if (!this.them().length) this.outcome = 'victory';
    else if (!this.us().length) this.outcome = 'defeat';
    else if (this.round > COMBAT.maxRounds) this.outcome = 'timeout';
  }

  /** Release every body and fold the fight's social aftermath into beliefs. */
  private finish(): void {
    const player = this.session.player;
    for (const c of this.members) {
      if (c.out === 'downed' && c.agent.alive) {
        if (this.outcome === 'victory' || this.outcome === 'truce') { c.out = null; c.agent.fighter.health = Math.max(c.agent.fighter.health, 10); }
        else this.kill(c);
      }
      this.release(c);
      // fighting side by side builds regard (the ally's OWN belief about you)
      if (player && c.role === 'ally' && c.agent.alive) {
        const b = c.agent.beliefs.get(player.id);
        if (b) b.standing = Math.min(1, b.standing + 0.15);
      }
    }
    const fallen = this.members.filter((c) => c.side === 'them' && (c.out === 'dead' || c.out === 'captured')).map((c) => c.agent.name);
    const allies = this.members.filter((c) => c.role === 'ally').map((c) => c.agent.name);
    const verdict: Record<Outcome, string> = { victory: 'Victory', defeat: 'Defeat', escaped: 'You escaped', truce: 'A truce', timeout: 'The fight petered out' };
    this.note('end', `${verdict[this.outcome!]} after ${this.round} round${this.round === 1 ? '' : 's'}.`);
    try {
      if (player && (fallen.length || allies.length)) {
        const withAllies = allies.length ? `, fighting beside ${allies.join(', ')}` : '';
        const slain = fallen.length ? ` ${fallen.join(', ')} fell.` : '';
        this.session.sim.chronicle.note('battle', player.id, `A fight broke out${withAllies}.${slain}`);
      }
    } catch { /* narration is best-effort */ }
  }

  private note(kind: LogLine['kind'], text: string, actorId?: EntityRef): void {
    this.log.push({ round: this.round, kind, text, actorId });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
  }
}

// ------------------------------------------------------------------------------------------

/**
 * Watches the live world and opens an Encounter when the player's side comes to blows.
 * Fights that don't involve the player stay real-time.
 */
export class CombatDirector {
  readonly session: Session;
  encounter: Encounter | null = null;
  private nextId = 1;

  constructor(session: Session) { this.session = session; }

  /** Call each frame while no encounter runs. Returns the encounter if one opened. */
  watch(): Encounter | null {
    if (this.encounter && this.encounter.phase !== 'over') return this.encounter;
    const p = this.session.player;
    if (!p || !p.alive) return null;
    const ours = [p, ...(((this.session.sim as { party?: { members?: Agent[] } }).party?.members) || [])].filter((a) => a && a.alive);
    // (a) the player has chosen a victim and closed on it
    if (p.goal && p.goal.kind === 'fight' && p.goal.targetId != null) {
      const t = this.session.sim.agentsById.get(p.goal.targetId) as Agent | undefined;
      if (t && t.alive && !t._held && planar(t.pos, p.pos) <= COMBAT.engageRadius) return this.begin(p, t);
    }
    // (b) someone has come for the player's side
    for (const a of this.session.sim.agents as Agent[]) {
      if (!a.alive || a.controlled || a._held || a._encounter != null) continue;
      const g = a.goal;
      if (!g || g.kind !== 'fight' || g.targetId == null) continue;
      const victim = ours.find((o) => o.id === g.targetId);
      if (victim && planar(a.pos, victim.pos) <= COMBAT.engageRadius) return this.begin(a, victim);
    }
    return null;
  }

  begin(initiator: Agent, target: Agent): Encounter {
    this.encounter = new Encounter(this.session, this.nextId++, initiator, target);
    return this.encounter;
  }

  /**
   * Headless driver: resolve the current round and advance the world roundSec, stepping the
   * session at `dt`. The frontend does the same thing spread over real frames.
   */
  advance(dt = 1 / 30): void {
    const e = this.encounter;
    if (!e || e.phase !== 'declare') return;
    e.resolve();
    if ((e.phase as string) !== 'playback') return;
    const n = Math.ceil(COMBAT.roundSec / dt);
    for (let i = 0; i < n; i++) this.session.step(dt);
    e.finishPlayback();
  }

  /** Drop a finished encounter (the frontend calls this once it has shown the result). */
  clear(): void { if (this.encounter && this.encounter.phase === 'over') this.encounter = null; }
}
