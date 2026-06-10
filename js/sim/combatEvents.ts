// Combat-outcome folding, extracted from Simulation as a free function over the
// sim instance (orchestration vs. mechanics split).
//
// Fold combat outcomes back into beliefs: being struck reveals an aggressor
// (latched hostile) and stirs anger/fear; witnesses notice too. Also emits the
// RPG combat deeds (melee/kill/block), advances player hunt bounties + loot,
// rolls up witnessed deeds into reputation, and records the victim/witness
// narrative beats.

import { bus, makeEvent as makeEventRaw } from '../rpg/events.js';
import { rng } from './rng.js';
import { RPG } from '../rpg/rpgconfig.js';
import { TUNE } from '../constants.js';
import { SIM, MONSTER, EPITHETS, DIRECTOR, AVENGER, GRATEFUL, LEGEND, CAPTIVE, factionHostile } from './simconfig.js';
import { setHouseFeud, areHousesFeuding } from './houses.js';
import { arcKey } from './arcs.js';
import { runPlanOutcome } from './exec/registry.js';
import { foldGrievance, notePeaceBreak, foldDeed } from './signals.js';
import type { OutcomeEvt } from './exec/registry.js';
import type { CognitionCtx } from '../../types/sim.js';
import { buildObituary, obituaryWorthy } from './gazette.js';
import type { Agent, CombatEvent, ActionEvent, ActionEventSpec } from '../../types/sim.js';

// events.js is still JS — its makeEvent infers `tags: never[]` from the `tags = []` default,
// so re-type it at the seam to the shared spec (the rpg cluster ports events.js later).
const makeEvent = makeEventRaw as (spec: ActionEventSpec) => ActionEvent;

// onCombatEvents/grantEpithet fold combat outcomes back into beliefs/rep/memory — the
// EXECUTION side, operating over the live Simulation instance (roster, reputation,
// chronicle, director, …). simulation.js is a LATER cluster, so the instance is loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any; /* Simulation — ported in a later cluster */
// A resolved combat event also carries a back-ref `.id` on the prop case and a `.magnitude`
// read with a `|| 0` guard — neither on the strict CombatEvent shape, so this widens it for
// the few off-type reads (the freeze-lesson guards stay).
type CombatEv = CombatEvent & { magnitude?: number; attacker: { agent?: Agent; id?: import('../../types/sim.js').EntityId }; target: { agent?: Agent; id?: import('../../types/sim.js').EntityId } };

// Emergent heroes & villains: a combatant who distinguishes itself earns a NAME that
// then rides every future chronicle beat (a light Nemesis system). Fired once per
// agent. Guarded by the caller; pure name/chronicle effect (no gold, no truth).
export function grantEpithet(sim: Sim, a: Agent, kind: string): void {
  if (!EPITHETS || !EPITHETS.enabled || !a || a.epithet) return;
  const pool = kind === 'villain' ? EPITHETS.villainNames
    : kind === 'survivor' ? EPITHETS.survivorEpithets : EPITHETS.heroEpithets;
  if (!pool || !pool.length) return;
  const epithet = pool[(Number(a.id) || 0) % pool.length];   // deterministic, varied by id
  a.epithet = epithet;
  if (kind === 'villain') {
    a.name = epithet;                                  // a faceless raider BECOMES the dread name
    // a NEMESIS persists: it won't withdraw with its wave, and it's a tougher boss —
    // a recurring antagonist the town must field a hero to put down.
    a.nemesis = true;
    a._raidExpire = undefined;                         // exempt from the raid TTL/withdrawal
    try {
      if (a.fighter) a.fighter.health = (TUNE.maxHealth || 100) * (EPITHETS.bossHpMul || 2);
      a.threat = (a.threat || 1) * (EPITHETS.bossThreatMul || 1.4);
      a.speedMul = EPITHETS.bossSpeedMul || 1.3;       // runs down fleeing prey
    } catch { /* boosting is best-effort */ }
    if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('legend', a.id, `A raider has become a thing of dread: ${epithet}.`);
  } else {
    a.name = `${a.name} ${epithet}`;                   // keeps their name + earns the title
    const beat = kind === 'survivor'
      ? `${a.name} is spoken of in wonder — the coward Death cannot seem to catch.`
      : `${a.name} is hailed a hero of the town.`;
    if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('legend', a.id, beat);
  }
}

export function onCombatEvents(sim: Sim, events: CombatEv[]): void {
  const pid = sim.reputation.playerId;
  for (const ev of events) {
    const A = ev.attacker.agent, T = ev.target.agent;

    // SELF-ENGAGEMENT LOG (schema #6 substrate) — written on EVERY landed blow, BEFORE the
    // !A||!T person-guard, keyed on the target's id (a real agent's id, or a PROP's own id
    // — a Scarecrow IS its own body and carries `.id`). This is what lets selfEngaged('@x',3)
    // count my strikes on a scarecrow (whose belief never accrues animacy) so #6 fires. A
    // block is not a strike on the target. The attacker is always a real agent (a prop never
    // swings). Own-state write; guarded inside _logStrike; never throws.
    if (A && A._logStrike && ev.type !== 'blocked') {
      const tid = ev.target && ev.target.agent ? ev.target.agent.id : (ev.target ? ev.target.id : null);
      if (tid != null) (A._logStrike as (id: unknown, t: number) => void)(tid, sim.time);
    }
    // BLOCK ANIMACY (the prop is naturally inert — it never blocks): a real target that
    // blocked my blow is, by my own perception, acting alive. Guarded; a belief about a
    // prop is absent/untouched.
    if (ev.type === 'blocked' && A && A.beliefs) {
      const tid = ev.target && ev.target.agent ? ev.target.agent.id : (ev.target ? ev.target.id : null);
      const ab = tid != null ? A.beliefs.get(tid) : null;
      if (ab) ab.recordAnimacy('blocked');
    }

    if (!A || !T) continue;

    // CAPTURE-ON-DEFEAT (docs/architecture/10-lld §19 item 3 — the rescue arc TRIGGER). EXECUTION:
    // reads ground truth, that's fine. When a captor-faction combatant (raider/rival/beast) lands a
    // LETHAL blow on a non-combatant townsperson, with a chance the victim is CAPTURED instead of
    // killed — revived at low HP, `_held`, anchored (it idles in decide while held). We convert the
    // death by reviving T BEFORE any death machinery runs (stampSlain/vendetta/obituary), then
    // `continue` so this event neither kills nor emits a KILL deed. ALWAYS-LIVE on the mainline.
    // Guarded; never throws on the tick.
    if (ev.type === 'dead' && !T._held &&
        T.faction === 'townsfolk' && !T.combatant && !T.controlled &&
        (CAPTIVE.captorFactions || []).indexOf(A.faction) !== -1 &&
        rng() < (CAPTIVE.captureChance || 0)) {
      try {
        const maxHp = (TUNE && TUNE.maxHealth) || 100;
        if (T.fighter && (T.fighter as { revive?: (h: number) => void }).revive) {
          (T.fighter as { revive: (h: number) => void }).revive(maxHp * (CAPTIVE.reviveHpFrac || 0.35));
        }
        T._held = true; T._captorId = A.id;
        if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('vendetta', A.id, `${A.name} took ${T.name} captive.`);
      } catch { /* never throw on the tick */ }
      continue;   // not a death — skip all the death folding for this event
    }

    // RPG combat deeds (classes/XP). A landed/lethal blow is a MELEE (+RISK,
    // +KILL if lethal) deed for the attacker; a block is a DEFENSE deed for the
    // target. The combat event type is 'dead' (lethal) | 'hit' | 'blocked' —
    // there is NO 'kill' type, so KILL is tagged off 'dead'. This block also
    // reproduces the original blocked-skip (emitting DEFENSE first), so the
    // belief-nudge code below only runs for hit/dead.
    if (ev.type === 'blocked') {
      bus.emit(makeEvent({
        actorId: T.id, verb: 'block', tags: ['DEFENSE'],
        targetId: A.id, magnitude: 1, t: sim.time,
      }));
      continue;
    }
    const risk = Math.max(0, Math.min(1, (A.threat ? 0.3 : 0) + (T.threat || 0.3)));
    const tags = ev.type === 'dead' ? ['MELEE', 'KILL', 'RISK'] : ['MELEE', 'RISK'];
    bus.emit(makeEvent({
      actorId: A.id, verb: ev.type === 'dead' ? 'kill' : 'strike', tags,
      targetId: T.id, magnitude: risk, t: sim.time,
    }));

    // a NEMESIS brought down at last — a communal triumph (the recurring boss falls).
    // (A WARLORD gets the grander "war is won" beat from the director instead.)
    if (ev.type === 'dead' && T.nemesis && !T.warlord && sim.chronicle && sim.chronicle.note) {
      sim.chronicle.note('legend', A.id, `${A.name} has slain ${T.name} — the town breathes easier.`);
    }

    // THE _slain BRIDGE (epistemic split): when T dies by A's hand, stamp the sanctioned
    // out-of-sight death signal on the slayer + every avenger of T (and erase their stale
    // belief) so a vendetta closes the moment T falls — the goal layer reads `_slain`, never
    // live truth. Shared with the death sweep (sim.stampSlain). Mark it death-processed so
    // the sweep doesn't re-handle this same death next frame.
    if (ev.type === 'dead') {
      sim.stampSlain(T, A);
      if (sim._deathSeen) sim._deathSeen.add(T.id); else sim._deathSeen = new Set([T.id]);
    }

    // VENDETTA ARC — APPEND a `round`, or CLOSE on the killing blow (docs/architecture/12 §3.5). A
    // blow between an OPEN vendetta pair is an escalation chapter (named beat filed HERE, observer-
    // layer; re-arms the TTL so a slow feud outlives an open-and-shut one); the LETHAL blow that
    // settles the feud closes it 'fulfilled'. The kill IS the satisfying event, so the mutual-feud
    // guard is moot (the slain principal holds no live counterpart goal). UNCONDITIONAL close.
    // Guarded; a no-op if no arc is open for the pair (a routine camp brawl files nothing).
    if (sim.sagas && (A.faction === 'townsfolk' || T.faction === 'townsfolk')) {
      try {
        const vk = arcKey('vendetta', A.id, T.id);
        if (sim.sagas.findArc(vk)) {
          if (ev.type === 'dead') sim.sagas.closeArc(vk, 'fulfilled');
          else sim.sagas.appendBeat(vk, 'round', `${A.name} struck ${T.name}.`);
        }
      } catch { /* never throw on the tick */ }
    }
    // GRIEVANCE (docs/architecture/13 B): a directed blow folds the sparse pairwise blow ledger
    // (rounds, by-whom, inter-blow interval) — escalation slope + one-sidedness. Bounded LRU; guarded.
    foldGrievance(sim, A.id, T.id, sim.time);

    // OUTLAW arc — CLOSE 'brought_down' when a rising outlaw is slain (docs/architecture/12 §3.5 / §9).
    // The Watch (or anyone) running the bandit down ends the infamy arc. WARBAND arc — CLOSE 'routed'
    // when a war-leader with an OPEN (still-mustering) band falls before it could march. Both feed the
    // win/loss signal through PLAN_OUTCOME ([11] §8's second customer — synergy 2). Guarded.
    if (ev.type === 'dead' && sim.sagas) {
      try {
        if (sim.sagas.findArc('outlaw:' + T.id)) sim.sagas.closeArc('outlaw:' + T.id, 'brought_down', `${T.name} the outlaw was brought down at last.`);
        if (sim.sagas.findArc('warband:' + T.id)) {
          sim.sagas.closeArc('warband:' + T.id, 'routed', `${T.name}'s war-band scattered when its leader fell.`);
          runPlanOutcome(T, { time: sim.time } as unknown as CognitionCtx, { status: 'peril', step: { prim: 'attack', bind: {} } } as unknown as OutcomeEvt);   // routed ≈ peril ([11] §8)
        }
      } catch { /* never throw on the tick */ }
    }

    // lifetime tallies that feed the killer's 'renown' ambition
    if (ev.type === 'dead' && A.life) {
      A.life.kills += 1;
      foldDeed(A, 'kill', sim.time);                                   // §13 E.deedLedger (truth side)
      if (T.faction === 'townsfolk') notePeaceBreak(sim, sim.time);    // §13 D.peaceClock — a townsperson fell to violence
      if (T.faction === MONSTER.faction) A.life.monsterKills += 1;
      // EPITHETS — a foe who slays townsfolk earns a dread NEMESIS name; a
      // townsperson who fells foes is hailed a HERO. Either then rides every beat.
      try {
        if (T.faction === 'townsfolk' && factionHostile('townsfolk', A.faction)) {
          A.life.townKills = (A.life.townKills || 0) + 1;
          if (A.life.townKills >= (EPITHETS.villainKills || 3)) grantEpithet(sim, A, 'villain');
        } else if (A.faction === 'townsfolk' && factionHostile('townsfolk', T.faction)) {
          A.life.foeKills = (A.life.foeKills || 0) + 1;
          if (A.life.foeKills >= (EPITHETS.heroKills || 5)) grantEpithet(sim, A, 'hero');
        }
      } catch { /* never throw on the tick */ }
    }

    // ARC RESOLUTION — a vendetta FULFILLED. If a TOWNSPERSON slayer A carried a
    // grudge for a slain loved one whose killer was T, this kill CLOSES the arc:
    // narrate the payoff ("X avenged Y by slaying Z") + grant a storied triumph beat.
    // Restricted to townsfolk avenging a WITNESSED DEATH — not camp brawls or mere
    // reciprocal blows, which aren't vendettas, just combat.
    if (ev.type === 'dead' && A && A.autonomous && A.faction === 'townsfolk' && A.memory && A.memory.stm) {
      try {
        const eps = [...A.memory.stm.items(), ...A.memory.mtm.items(), ...A.memory.ltm.items()];
        let fallenId;
        for (const e of eps) {
          // only a death the avenger GRIEVED (kin, or a well-liked friend) counts —
          // salience encodes caring (kin 0.95 / liked-witness high; an indifferent
          // bystander logs ~0.55), so this filters out "avenging" an enemy's fall.
          if (e && e.kind === 'witnessed_death' && e.byId === T.id && (e.salience || 0) >= 0.7) { fallenId = e.withId; break; }
        }
        if (fallenId !== undefined && sim.chronicle && sim.chronicle.note) {
          const fallen = (sim.agentsById.get(fallenId) || {}).name || 'the fallen';
          sim.chronicle.note('vendetta', A.id, `${A.name} avenged ${fallen} by slaying ${T.name}.`);
          if (A.progression) { try { A.progression.addNarrativeXP(0.8, sim.time); } catch { /* never throw */ } }
        }
      } catch { /* never throw on the tick */ }
    }

    // NARRATIVE BEAT (PHASE 1): slaying a MONSTER is a storied deed — grant the
    // killer sizable, grind-immune xp keyed to the same salience the `triumph`
    // memory uses (0.6 + 0.2*magnitude). Killing a townsperson is `bloodshed`
    // (dark, not heroic) — no narrative xp; the routine MELEE/KILL deed already
    // pays its grind-decayed share via onEvent. Guarded; never throws.
    if (ev.type === 'dead' && T.faction === MONSTER.faction && A.progression) {
      try { A.progression.addNarrativeXP(0.6 + 0.2 * (ev.magnitude || 0), sim.time); } catch { /* never throw */ }
    }

    // quest hook + loot: the player slaying a monster advances hunt bounties
    // and lets the player loot the corpse — its purse (no minting) and a chance
    // of a remedy. A real transfer, so the closed economy stays intact.
    if (ev.type === 'dead' && A.controlled && T.faction === MONSTER.faction) {
      sim.quests.bumpHunt(T.faction);
      // PURSE ONLY: a slain agent's CARRIED coin transfers to the slayer. Its banked
      // STASH stays put (at home — burglable while away in Phase 4, not lootable in death).
      A.gold += Math.max(0, Math.floor(T.gold || 0)); T.gold = 0;
      // T.stash is deliberately untouched — it is not on the body.
      if (rng() < 0.5) A.inventory.potion = (A.inventory.potion || 0) + 1;
    }
    // vendetta credit: a PLAYER killing blow on ANY agent may settle a grieving
    // townsperson's vendetta (the named foe of an 'avenge' quest). Guarded.
    if (ev.type === 'dead' && A.controlled && sim.quests && sim.quests.bumpVendetta) {
      sim.quests.bumpVendetta(T.id);
    }
    // BOUNTY credit: an NPC hunter who answered a Gazette bounty advances (and may
    // complete) it with this killing blow. Guarded; gold conserved (giver pays).
    if (ev.type === 'dead' && A && A.bounty && sim.bounties && sim.bounties.creditKill) {
      sim.bounties.creditKill(A, T);
    }
    // SACRIFICE: a sworn BODYGUARD who falls while their charge still lives laid down
    // their life for another — a legend-worthy beat (the SHIELD verb's payoff).
    if (ev.type === 'dead' && T.bodyguardOf != null) {
      const charge = sim.agentsById.get(T.bodyguardOf);
      if (charge && charge.alive && sim.chronicle && sim.chronicle.note) {
        sim.chronicle.note('legend', T.id, `${T.name} fell shielding ${charge.name} — a life laid down for another.`);
      }
      T.bodyguardOf = null;
    }
    // DUEL to the death: a duelist falls — the survivor stands down, the rivalry ended
    // in blood (the rarer, lethal resolution of a duel of honour).
    if (ev.type === 'dead' && T._duelWith != null) {
      const victor = sim.agentsById.get(T._duelWith);
      if (victor && victor.alive) {
        victor._duelWith = null;
        if (victor._duelRestore) { victor.combatant = victor._duelRestore.combatant; victor.canWork = victor._duelRestore.canWork; victor._duelRestore = null; }
        if (victor.rivalId === T.id) victor.rivalId = null;
        if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('legend', victor.id, `${victor.name} has slain ${T.name} in single combat — a long rivalry ends in blood.`);
      }
      T._duelWith = null;
    }

    // IN MEMORIAM: a notable soul's death is filed to the Gazette as an obituary —
    // a life retrospective framed by how the town remembers them (which, after the
    // rumour layer, may not be who they were). Once per death; never throws (it runs
    // post-resolve, but stays guarded — the freeze lesson). Faceless mobs are skipped.
    if (ev.type === 'dead' && !T._obituaryFiled && obituaryWorthy(T)) {
      T._obituaryFiled = true;
      try { if (sim.gazette) sim.gazette.file(buildObituary(T, sim, A)); } catch { /* never throw */ }
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
      if (deed) sim.reputation.witnessDeed(sim.agents, deed, A.pos, sim.time, T.id);
    }

    // victim now knows the attacker is hostile
    const tb = T.beliefs.observe(A.id, A.faction, A.pos, sim.time, true);
    // ANIMACY: the attacker just acted alive against me (struck + harmed me) — first-hand
    // liveness evidence on the victim's belief about the aggressor (schema #6 substrate).
    tb.recordAnimacy('struck'); tb.recordAnimacy('harmedMe');
    tb.standing = Math.max(-1, tb.standing - 0.4);
    T.mood.fear = Math.min(1, T.mood.fear + 0.4);
    T.mood.anger = Math.min(1, T.mood.anger + 0.5);
    // Revenge is re-homed to the goal stack (Phase 3): the `assaulted` memory
    // below — not an ambition override — is the single source. deriveGoals reads
    // it next time the victim decides and pushes an `avenge(A)` goal.
    // the victim remembers being attacked (if it survived to remember it)
    if (T.alive && T.memory) T.memory.record({ t: sim.time, kind: 'assaulted', withId: A.id, valence: -1, salience: 0.55 });
    // NARRATIVE BEAT: SURVIVING a blow at death's door is a brush with death —
    // a storied moment. Gated by a per-agent cooldown (one award per low-HP
    // window) so a flurry of low-HP hits is a SINGLE beat, not a torrent of xp.
    // Reads ground-truth HP only for the AWARD (execution side), never for a
    // decision. Guarded; never throws on the tick.
    if (T.alive && ev.type === 'hit' && T.memory && T.progression) {
      const maxHp = (TUNE && TUNE.maxHealth) || 100;
      const frac = (T.fighter && typeof T.fighter.health === 'number') ? T.fighter.health / maxHp : 1;
      if (frac <= RPG.nearDeathHpFrac && (sim.time - ((T._lastNearDeath as number) || -1e9)) >= (RPG.nearDeathCooldownSec || 45)) {
        T._lastNearDeath = sim.time;
        try { T.memory.record({ t: sim.time, kind: 'survived', withId: A.id, valence: -1, salience: RPG.nearDeathSalience }); } catch { /* never throw */ }
        try { T.progression.addNarrativeXP(RPG.nearDeathSalience, sim.time); } catch { /* never throw */ }
      }
    }

    // THE RINCEWIND — a COWARD who cheats death by fleeing while braver folk fall. A
    // narrow escape = surviving a blow from something TERRIFYING (a named nemesis /
    // warlord, or any monster). Doesn't need a near-death hit — a coward runs before
    // it comes to that. Each flight from a named terror is a picaresque beat; enough
    // escapes earns a legend of improbable survival (cowardice, not valour). Cooldown'd.
    if (T.alive && ev.type === 'hit' && T.faction === 'townsfolk' && T.life && T.personality &&
        T.personality.risk_tolerance < (EPITHETS.cowardRisk || 0.4) &&
        (A.faction === MONSTER.faction || A.epithet || A.nemesis || A.warlord) &&
        (sim.time - ((T._lastEscape as number) || -1e9)) >= (EPITHETS.escapeCooldown || 25)) {
      T._lastEscape = sim.time;
      T.life.escapes = (T.life.escapes || 0) + 1;
      try {
        if ((A.epithet || A.nemesis) && sim.chronicle && sim.chronicle.note) {
          sim.chronicle.note('legend', T.id, `${T.name} fled ${A.name} and — somehow — lived to flee another day.`);
        }
        if (!T.epithet && T.life.escapes >= (EPITHETS.escapesForLegend || 3)) grantEpithet(sim, T, 'survivor');
      } catch { /* never throw on the tick */ }
    }
    // bystanders who can see it also mark the attacker — and remember a death,
    // grieving harder for someone they thought well of.
    for (const w of sim.agents) {
      if (w === A || w === T || !w.alive || w.controlled) continue;
      if (w.pos.distanceTo(A.pos) > SIM.visionRange) continue;
      const wb = w.beliefs.observe(A.id, A.faction, A.pos, sim.time, factionHostile(w.faction, A.faction));
      // ANIMACY: a witness SAW the aggressor strike — liveness evidence on the witness's
      // belief about it (so a witnessed brawler reads as alive, never inert).
      wb.recordAnimacy('struck');
      wb.suspicion = Math.min(1, wb.suspicion + 0.3);
      if (ev.type === 'dead' && T.faction !== MONSTER.faction && w.memory) {
        const liked = Math.max(0, w.beliefs.get(T.id)?.standing || 0);
        // withId = the fallen friend (subject of grief); byId = the killer (the
        // culprit deriveGoals avenges if it survives). Grieving harder for a liked one.
        const wsal = 0.55 + 0.4 * liked;
        w.memory.record({ t: sim.time, kind: 'witnessed_death', withId: T.id, byId: A.id, valence: -1, salience: wsal });
        // NARRATIVE BEAT: witnessing a death is formative — grind-immune xp at
        // the episode's salience (mourning a friend marks you more). Guarded.
        if (w.progression) { try { w.progression.addNarrativeXP(wsal, sim.time); } catch { /* never throw */ } }
        // seeing a FRIEND murdered turns the witness against the killer for real:
        // latch A hostile + sour standing, so the vendetta both DERIVES (avenge
        // goal) and the reactive fight path engages on the true position when the
        // killer is in sight. (Mere acquaintance: suspicion only, handled above.)
        if (liked > 0.3) { wb.hostile = true; wb.standing = Math.max(-1, wb.standing - 0.4); }
      }
    }

    // KIN AVENGE (the orphan / the widow) — a slain townsperson's family learns of
    // it WHEREVER they are (word reaches kin) and swears vengeance, so a death
    // echoes across distance and time, not just among the bystanders who saw it.
    // This is what turns the lineage kin-graph into the classic loss→revenge arc:
    // a child away at the fields when a raider cuts down a parent grows up hunting
    // the killer. Latches the killer hostile + a high-salience witnessed_death so
    // deriveGoals lifts it into an avenge goal (the vengeful fight even as civilians).
    if (ev.type === 'dead' && T.faction !== MONSTER.faction) {
      const kin = [];
      if (T.mateId != null) kin.push(T.mateId);
      if (Array.isArray(T.kinIds)) for (const id of T.kinIds) kin.push(id);
      const seen = new Set();
      for (const id of kin) {
        if (id == null || id === A.id || seen.has(id)) continue;
        seen.add(id);
        const K = sim.agentsById.get(id);
        if (!K || !K.alive || K.controlled) continue;
        const kb = K.beliefs.observe(A.id, A.faction, A.pos, sim.time, true);
        kb.hostile = true;
        kb.standing = Math.max(-1, kb.standing - 0.6);
        kb.confidence = Math.max(kb.confidence || 0, 0.7);
        K.mood.anger = Math.min(1, (K.mood.anger || 0) + 0.6);
        if (K.memory) K.memory.record({ t: sim.time, kind: 'witnessed_death', withId: T.id, byId: A.id, valence: -1, salience: 0.95 });
        if (K.progression) { try { K.progression.addNarrativeXP(0.7, sim.time); } catch { /* never throw */ } }
        if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('vendetta', K.id, `${K.name} swore vengeance on ${A.name} for ${T.name}.`);
      }
    }

    // A WRONGLY-ACCUSED INNOCENT cut down before exoneration — the truth comes too late.
    if (ev.type === 'dead' && T._accusedAt != null) {
      if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('legend', T.id, `${T.name} was hounded over a lie — cut down with their name still blackened, before the rumour could be proven the slander it was. A tragedy of hearsay.`);
      if (sim.director && sim.director._recordSaga) sim.director._recordSaga({ sagaKind: 'accused', key: `${T.id}`, accused: T.name, outcome: 'tragedy' });
      T._accusedAt = null;
    }

    // A KILLING BETWEEN HOUSES — blood spilled across house lines ignites a FEUD (the
    // classic inter-house vendetta). This is what finally FEEDS the dormant house-feud
    // machinery (inherited rivalries, star-crossed romance) from the violence that
    // already happens — and a later cross-house MARRIAGE heals it (lineage._wed), giving
    // a violence↔love cycle. Townsfolk-on-townsfolk only (the player has no house).
    if (ev.type === 'dead' && T.faction === 'townsfolk' && A && A.faction === 'townsfolk' &&
        A.house && T.house && A.house !== T.house && !areHousesFeuding(sim, A.house, T.house)) {
      setHouseFeud(sim, A.house, T.house);
      if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('vendetta', A.id, `Blood across house lines: the death of ${T.name} sets House ${T.house} against House ${A.house}.`);
    }

    // THE AVENGER — the player's deeds make ENEMIES that LAST. When the PLAYER murders
    // a townsperson, the most capable of the slain's kin doesn't just grieve and forget
    // (that grudge decays in ~90s); ONE becomes a PERSISTENT personal nemesis who hunts
    // the player down. Capped so a killing spree can't swarm them; the Director keeps
    // the grudge hot, bounds it with a TTL, narrates it, and files it as a saga.
    if (ev.type === 'dead' && A.controlled && T.faction === 'townsfolk' && AVENGER && AVENGER.enabled) {
      const liveAvengers = sim.agents.reduce((n: number, x: Agent) => n + (x.alive && x.avengerOf != null ? 1 : 0), 0);
      if (liveAvengers < (AVENGER.max || 3)) {
        const kinIds = [];
        if (T.mateId != null) kinIds.push(T.mateId);
        if (Array.isArray(T.kinIds)) for (const id of T.kinIds) kinIds.push(id);
        let best = null, bestLv = -1;
        for (const id of kinIds) {
          const K = sim.agentsById.get(id);
          if (!K || !K.alive || K.controlled || K.avengerOf != null || K.faction !== 'townsfolk') continue;
          const lv = (K.progression && K.progression.totalLevel) || 0;
          if (lv > bestLv) { bestLv = lv; best = K; }
        }
        if (best) {
          best.avengerOf = A.id; best._avengerSince = sim.time; best.avengerVictim = T.name; best.combatant = true;
          try { const b = best.beliefs.observe(A.id, A.faction, A.pos, sim.time, true); b.hostile = true; b.standing = -1; b.confidence = Math.max(b.confidence || 0, 0.85); } catch { /* never throw */ }
          if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('vendetta', best.id, `${best.name} has sworn to hunt ${A.name} down for the murder of ${T.name} — and will not rest until it is paid in blood.`);
        }
      }
    }

    // the AVENGER succeeds — the player falls to the very nemesis their murder created.
    if (ev.type === 'dead' && T.controlled && A && A.avengerOf === T.id) {
      if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('vendetta', A.id, `${A.name} has had their vengeance — ${T.name} lies dead at last, the blood-debt for ${A.avengerVictim || 'their kin'} paid in full.`);
      if (sim.director && sim.director._recordSaga) sim.director._recordSaga({ sagaKind: 'avenger', key: `${A.id}`, avenger: A.name, victim: A.avengerVictim || 'their kin', outcome: 'avenged' });
      A.avengerOf = null; A.combatant = false;
    }

    // an AVENGER cut down — the vendetta against the player dies with them.
    if (ev.type === 'dead' && T.avengerOf != null) {
      if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('vendetta', T.id, `${T.name}'s vendetta against ${A.controlled ? A.name : 'the traveller'} ends in the dust — the vengeance for ${T.avengerVictim || 'their kin'} will never come.`);
      if (sim.director && sim.director._recordSaga) sim.director._recordSaga({ sagaKind: 'avenger', key: `${T.id}`, avenger: T.name, victim: T.avengerVictim || 'their kin', outcome: 'slain' });
      T.avengerOf = null; T.combatant = false;
    }

    // THE LEGEND — the player's witnessed deeds build a durable REPUTATION the whole town
    // reads. WITNESS-GATED (the epistemic split): only a deed a townsperson SEES feeds the
    // legend — murder in an empty wood and no legend grows. Murdering townsfolk breeds
    // NOTORIETY (the town comes to fear a butcher); slaying threats breeds FAME.
    if (ev.type === 'dead' && LEGEND && LEGEND.enabled) {
      let witnessed = false;
      for (const w of sim.agents) {
        if (w === T || !w.alive || !w.autonomous || w.faction !== 'townsfolk') continue;
        if (w.pos.distanceTo(T.pos) <= SIM.visionRange) { witnessed = true; break; }
      }
      if (witnessed) {
        // NOTORIETY generalised (docs/architecture/12 §9): ANY non-monster actor's witnessed
        // townsfolk-murder breeds town-read infamy — an NPC butcher/outlaw accrues it the same way the
        // player does (feeds RECRUIT + the outlaw arc). Still witness-gated. FAME stays a PLAYER concept.
        if (T.faction === 'townsfolk' && A.faction !== MONSTER.faction) A.notoriety = Math.min(1, ((A.notoriety as number) || 0) + (LEGEND.perMurder || 0.34));
        else if (A.controlled && (T.faction === MONSTER.faction || factionHostile('townsfolk', T.faction) || T.nemesis || T.warlord)) A.fame = Math.min(1, ((A.fame as number) || 0) + (LEGEND.perHeroic || 0.2));
      }
    }

    // THE GRATEFUL — the player's GOOD deeds make friends that last (the warm mirror of
    // the Avenger). When the PLAYER slays a threat right beside an imperilled townsperson,
    // that townsperson — saved from death — becomes a loyal GUARDIAN who shadows and
    // defends the player for a time, then parts with thanks. The Director supervises.
    if (ev.type === 'dead' && A.controlled && GRATEFUL && GRATEFUL.enabled && sim.director && sim.director._enlistGuardian &&
        (T.faction === MONSTER.faction || factionHostile('townsfolk', T.faction) || T.nemesis || T.warlord || T.avengerOf != null)) {
      const liveGuards = sim.agents.reduce((n: number, x: Agent) => n + (x.alive && x.guardianOf != null ? 1 : 0), 0);
      if (liveGuards < (GRATEFUL.max || 2)) {
        let saved = null, sd = (GRATEFUL.rescueRadius || 6);
        for (const w of sim.agents) {
          if (!w.alive || !w.autonomous || w.faction !== 'townsfolk' || w.guardianOf != null || w.inParty || w.bodyguardOf != null || w.combatant) continue;
          const d = w.pos.distanceTo(T.pos);
          if (d <= sd) { sd = d; saved = w; }     // the closest imperilled soul was the one in danger
        }
        if (saved) sim.director._enlistGuardian(saved, A, T.name || 'a deadly foe');
      }
    }

    // a PROTÉGÉ cut down before their time — the hero's young follower, a promise unkept.
    if (ev.type === 'dead' && T.protegeOf != null) {
      if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('vendetta', T.id, `${T.name}, the traveller's young follower, fell before they could come into their own — a promise the world will never see kept.`);
      if (sim.director && sim.director._recordSaga) sim.director._recordSaga({ sagaKind: 'protege', key: `${T.id}`, protege: T.name, outcome: 'fallen' });
      T.protegeOf = null;
    }

    // a GRATEFUL GUARDIAN cut down — they gave their life shielding the one who saved them.
    if (ev.type === 'dead' && T.guardianOf != null) {
      if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('legend', T.id, `${T.name} fell defending the traveller who once saved them — a debt repaid in full, with their life.`);
      if (sim.director && sim.director._recordSaga) sim.director._recordSaga({ sagaKind: 'grateful', key: `${T.id}`, guardian: T.name, savedFrom: T.guardSavedFrom || 'death', outcome: 'fellDefending' });
      T.guardianOf = null;
    }
    // a guardian who lands a kill in the player's defence has begun to repay the debt.
    if (ev.type === 'dead' && A.guardianOf != null) A._guardRepaid = true;

    // CARAVAN WAYLAID (logistics) — a dispatched CARAVAN cut down on the road loses
    // its cargo, and that good grows SCARCE in the town (its price beliefs climb): a
    // real economic blow from a severed supply line. Now trade is local, supply has
    // to physically arrive — and bandits know it.
    if (ev.type === 'dead' && T.faction === 'townsfolk' && T.caravanRun) {
      const good = (T.caravanRun as { good?: string }).good || 'goods';
      const mul = (DIRECTOR.caravan && DIRECTOR.caravan.shortageMul) || 1.22;
      let touched = 0;
      for (const w of sim.agents) {
        if (touched >= 8) break;
        if (!w.alive || w.controlled || w.faction !== 'townsfolk' || !w.priceBeliefs || w.priceBeliefs[good] == null) continue;
        w.priceBeliefs[good] = +(w.priceBeliefs[good] * mul).toFixed(2);
        touched++;
      }
      T.caravanRun = null;
      if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('fortune', T.id, `${T.name}'s caravan was waylaid and lost on the road — ${good} grows scarce in the town.`);
    }

    // PARTIAL caravan loss: a hired escort (guard/porter) is cut down but the trader
    // lives — the cargo is mauled, not lost. A MILDER price bump than a full waylay,
    // and a road beat. (The escort's leader/trader still completes its run.)
    if (ev.type === 'dead' && T.caravanEscort) {
      const escort = T.caravanEscort as { good?: string; role?: string };
      const good = escort.good || 'goods';
      const mul = (DIRECTOR.caravan && DIRECTOR.caravan.partialShortageMul) || 1.07;
      let touched = 0;
      for (const w of sim.agents) {
        if (touched >= 6) break;
        if (!w.alive || w.controlled || w.faction !== 'townsfolk' || !w.priceBeliefs || w.priceBeliefs[good] == null) continue;
        w.priceBeliefs[good] = +(w.priceBeliefs[good] * mul).toFixed(2);
        touched++;
      }
      const role = escort.role === 'guard' ? 'guard' : 'porter';
      T.caravanEscort = null;
      if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('fortune', T.id, `Bandits cut down a ${role} on the road — part of the ${good} caravan is lost, and ${good} grows a little dearer.`);
    }

    // FALLEN HERO — losing a CHAMPION (an epithet-bearing townsperson) is a communal
    // blow: a mourning saga beat, and the WATCH + nearby townsfolk rally as an
    // avenging warband against the killer. The hero's death galvanises the town —
    // classically, it's what finally drags a rampaging nemesis down.
    if (ev.type === 'dead' && T.faction === 'townsfolk' && T.epithet) {
      if (sim.chronicle && sim.chronicle.note) {
        sim.chronicle.note('legend', T.id, `The town mourns ${T.name}, its champion, cut down by ${A.name}.`);
      }
      const rally2 = (SIM.visionRange * 3) ** 2;
      for (const w of sim.agents) {
        if (w === A || !w.alive || w.controlled || w.faction !== 'townsfolk') continue;
        if (!(w.watch || w.pos.distanceToSquared(T.pos) <= rally2)) continue;   // the Watch always answers; others if near
        const wb = w.beliefs.observe(A.id, A.faction, A.pos, sim.time, true);
        wb.hostile = true;
        wb.standing = Math.max(-1, wb.standing - 0.5);
        wb.confidence = Math.max(wb.confidence || 0, 0.7);
        w.mood.anger = Math.min(1, (w.mood.anger || 0) + 0.5);
        if (w.memory) w.memory.record({ t: sim.time, kind: 'witnessed_death', withId: T.id, byId: A.id, valence: -1, salience: 0.9 });
      }
    }

    // A HOUSE FALLS — when the last of a bloodline that grew across generations dies,
    // the line ends forever (the saddest dynastic beat). Only for a house that bore
    // children (a real LINE in sim._houseEverGrew), never a lone childless founder.
    if (ev.type === 'dead' && T.faction === 'townsfolk' && T.house &&
        sim._houseEverGrew && sim._houseEverGrew.has(T.house)) {
      const survives = sim.agents.some((a: Agent) => a.alive && a !== T && a.faction === 'townsfolk' && a.house === T.house);
      if (!survives) {
        sim._houseEverGrew.delete(T.house);   // don't re-announce
        if (sim.chronicle && sim.chronicle.note) {
          sim.chronicle.note('legend', T.id, `With ${T.name} dead, the line of House ${T.house} has ended.`);
        }
      }
    }
  }
}
