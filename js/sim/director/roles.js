// DIRECTOR / ROLES — the special agent-role machinery the director enlists, keeps
// alive, and stands down: BODYGUARDS (shield a charge), DUELISTS (settle a feud with
// steel), and the player-woven roles — the PROTÉGÉ (a youth who follows a famous
// player), the GRATEFUL guardian (one the player saved), the AVENGER (a personal
// nemesis kept hunting), and the LEGEND (the player's fame/infamy decaying + narrated).
// All reuse the warband/hearth follow path; each role enlists with a restore-blob so it
// can be cleanly stood down. Free functions over the Director instance `d`.
import { DIRECTOR, AVENGER, GRATEFUL, LEGEND, PROTEGE } from '../simconfig.js';
import { TUNE } from '../../constants.js';
import { BEAT } from '../chronicle.js';
import { grantEpithet } from '../combatEvents.js';
import { clamp } from './util.js';

// THE BODYGUARD (LOYALTY/SACRIFICE — the SHIELD verb): a brave soul is sworn to
// shadow and shield an endangered or notable charge. It reuses the warband band-
// follow path (bandLeaderId = charge → follow + fight threats near the charge), so
// the protection is emergent; the drama is the guard laying down their life (the
// sacrifice beat fires from combatEvents on a guard's death while the charge lives).
export function _tropeBodyguard(d, folk) {
  const T = DIRECTOR.tropes;
  if (d.sim.agents.filter((a) => a.alive && a.bodyguardOf != null).length >= (T.bodyguardMax || 2)) return false;
  // a CHARGE worth guarding: a hero (epithet) or someone MARKED by a rivalry/vendetta —
  // notable or endangered, and not already a fighter.
  const charges = folk.filter((a) => !a.combatant && !a.watch && !a.bodyguardOf && (a.epithet || a.rivalId != null));
  for (const C of d._shuffle(charges)) {
    if (d.sim.agents.some((g) => g.bodyguardOf === C.id)) continue;   // already has a guard
    const guard = d._shuffle(folk).find((a) =>
      a !== C && a.bodyguardOf == null && !a.watch && !a.reporter && !a.inParty && !a.expedition && !a.caravanRun && !a.bounty && !a.spy &&
      a.personality && a.personality.risk_tolerance >= (T.bodyguardRisk || 0.55) && a.pos.distanceTo(C.pos) <= (T.proximity || 26) * 1.5);
    if (!guard) continue;
    d._enlistBodyguard(guard, C);
    d._note(BEAT.WATCH, guard.id, `${guard.name} has sworn to stand guard over ${C.name}.`);
    return true;
  }
  return false;
}

export function _enlistBodyguard(d, g, charge) {
  g._bgRestore = { combatant: g.combatant, canWork: g.canWork, inParty: g.inParty, bandLeaderId: g.bandLeaderId, groupType: g.groupType };
  g.bodyguardOf = charge.id;
  g.bandLeaderId = charge.id;     // shadow + defend the charge (the warband follow path)
  g.inParty = true; g.combatant = true; g.canWork = false; g.groupType = 'warband';
}

export function _freeBodyguard(d, g) {
  if (!g) return;
  const r = g._bgRestore;
  g.bodyguardOf = null; g._bgRestore = null;
  if (r) { g.combatant = r.combatant; g.canWork = r.canWork; g.inParty = r.inParty; g.bandLeaderId = r.bandLeaderId; g.groupType = r.groupType; }
  else { g.inParty = false; g.bandLeaderId = null; g.combatant = false; g.groupType = null; }
}

// standing bodyguards: when a charge falls, the guard's duty ends (a grief beat);
// a guard who died is cleared (its sacrifice beat fired in combatEvents).
export function _superviseBodyguards(d) {
  for (const g of d.sim.agents) {
    if (!g || g.bodyguardOf == null) continue;
    if (!g.alive) { g.bodyguardOf = null; continue; }
    const charge = d.sim.agentsById.get(g.bodyguardOf);
    if (!charge || !charge.alive) {
      d._note(BEAT.VENDETTA, g.id, `${g.name}, sworn to guard ${charge ? charge.name : 'their charge'}, could not save them.`);
      d._freeBodyguard(g);
    }
  }
}

export function _enlistDuelist(d, a) {
  a._duelRestore = { combatant: a.combatant, canWork: a.canWork };
  a._duelStart = d.sim.time;
  a.combatant = true; a.canWork = false;
}
export function _freeDuelist(d, a) {
  if (!a) return; const r = a._duelRestore;
  a._duelWith = null; a._duelRestore = null;
  if (r) { a.combatant = r.combatant; a.canWork = r.canWork; }
}

// resolve a duel: CLOSE the feud (unlatch hostility + warm to wary respect + clear
// the rivalry) and stand both down. (A death is handled in combatEvents.)
export function _resolveDuel(d, victor, yielder, satisfied) {
  for (const [x, y] of [[victor, yielder], [yielder, victor]]) {
    if (x.beliefs && x.beliefs._ensure) { const bel = x.beliefs._ensure(y.id); bel.hostile = false; bel.standing = clamp(Math.max(bel.standing, -0.1), -1, 1); }
    if (x.rivalId === y.id) x.rivalId = null;
  }
  d._freeDuelist(victor); d._freeDuelist(yielder);
  if (satisfied) d._note(BEAT.LEGEND, victor.id, `${victor.name} has bested ${yielder.name} in single combat — honour is satisfied, and their long feud is laid to rest.`);
}

// watch active duels: a yield at low HP (or a timeout) ends it; a death is handled
// in combatEvents (it stands the survivor down + a blood beat).
export function _superviseDuels(d) {
  const maxH = (TUNE && TUNE.maxHealth) || 100;
  for (const a of d.sim.agents) {
    if (!a || a._duelWith == null) continue;
    if (!a.alive) { a._duelWith = null; continue; }
    const b = d.sim.agentsById.get(a._duelWith);
    if (!b || !b.alive) { d._freeDuelist(a); continue; }
    if (a.id > b.id) continue;     // each pair once
    const ha = (a.fighter && a.fighter.health != null) ? a.fighter.health : maxH;
    const hb = (b.fighter && b.fighter.health != null) ? b.fighter.health : maxH;
    const victor = ha >= hb ? a : b, yielder = ha >= hb ? b : a;
    if (Math.min(ha, hb) / maxH <= (DIRECTOR.tropes.duelHpYield || 0.35)) d._resolveDuel(victor, yielder, true);
    else if (d.sim.time - (a._duelStart || d.sim.time) > (DIRECTOR.tropes.duelTTL || 55)) d._resolveDuel(victor, yielder, false);
  }
}

// THE DUEL OF HONOR (CONFLICT — the DUEL goal): two bitter rivals meet for binding
// single combat. Unlike a feud (which only festers or is brokered) a duel RESOLVES
// it: a yield at low HP closes the feud with wary respect (both live), a death ends
// it in blood. One duel at a time; not the player; not a nemesis/warlord.
export function _tropeDuel(d, folk) {
  if (d.sim.agents.some((a) => a.alive && a._duelWith != null)) return false;   // one at a time
  // free = not otherwise committed (a combatant CAN duel — a warrior settles it with steel).
  const free = (a) => a && !a.watch && !a.reporter && !a.bounty && !a.inParty &&
    !a.expedition && !a.caravanRun && !a.bodyguardOf && a._duelWith == null && !a.nemesis && !a.warlord;
  const cands = folk.filter((a) => a.rivalId != null && free(a));
  for (const A of d._shuffle(cands)) {
    const B = d.sim.agentsById.get(A.rivalId);
    if (!B || !B.alive || B.rivalId !== A.id || !free(B)) continue;
    if (A.townId != null && B.townId != null && A.townId !== B.townId) continue;   // same town
    d._enlistDuelist(A); d._enlistDuelist(B);
    A._duelWith = B.id; B._duelWith = A.id;
    d._note(BEAT.VENDETTA, A.id, `A duel of honour: ${A.name} and ${B.name}, long rivals, have met to settle their feud with steel.`);
    return true;
  }
  return false;
}

// THE PROTÉGÉ — a famous player inspires a green youth to follow and LEARN. Reuses the
// warband path (bandLeaderId = the player) so the protégé shadows + fights at the
// player's side; gains accelerated XP; and after surviving long enough at a hero's
// side, GRADUATES — comes into their own as a hero, a legacy of the player's fame.
export function _superviseProtege(d) {
  if (!PROTEGE || !PROTEGE.enabled) return;
  const p = d.sim.player;
  let live = 0;
  for (const a of d.sim.agents) {
    if (!a || a.protegeOf == null) continue;
    if (!a.alive) { a.protegeOf = null; continue; }       // death is narrated in combatEvents
    if (!p || !p.alive || a.protegeOf !== p.id) { d._endProtege(a, 'orphaned'); continue; }
    live++;
    if (a.progression && a.progression.addNarrativeXP) { try { a.progression.addNarrativeXP(PROTEGE.xpPerTick || 0.12, d.sim.time); } catch { /* */ } }
    if (d.sim.time - (a._protegeSince || 0) > (PROTEGE.graduateSecs || 160)) d._endProtege(a, 'graduated');
  }
  // recruit: a famous player draws ONE green admirer at a time.
  if (live === 0 && p && p.alive && (p.fame || 0) >= (PROTEGE.fameAt || 0.5)) {
    let best = null, bestRen = -1;
    for (const a of d.sim.agents) {
      if (!a.alive || !a.autonomous || a.faction !== 'townsfolk' || a.protegeOf != null) continue;
      if (a.inParty || a.guardianOf != null || a.bodyguardOf != null || a.avengerOf != null || a.combatant || a._duelWith != null) continue;
      if (((a.progression && a.progression.totalLevel) || 0) > (PROTEGE.maxLevel || 6)) continue;   // only the green
      const ren = (a.ambition && a.ambition.kind === 'renown') ? 1 : 0;   // glory-hungry youths first
      if (ren > bestRen) { bestRen = ren; best = a; }
    }
    if (best) d._enlistProtege(best, p);
  }
}
export function _enlistProtege(d, g, player) {
  g._protegeRestore = { combatant: g.combatant, canWork: g.canWork, inParty: g.inParty, bandLeaderId: g.bandLeaderId, groupType: g.groupType };
  g.protegeOf = player.id; g._protegeSince = d.sim.time;
  g.bandLeaderId = player.id; g.inParty = true; g.combatant = true; g.canWork = false; g.groupType = 'warband';
  try { const b = g.beliefs._ensure(player.id); b.hostile = false; b.standing = 1; b.confidence = Math.max(b.confidence || 0, 0.85); } catch { /* */ }
  if (d.sim.chronicle && d.sim.chronicle.note) d.sim.chronicle.note('fortune', g.id, `Young ${g.name}, dazzled by the traveller's deeds, has taken to following in their shadow — hungry to learn the trade of heroes.`);
}
export function _freeProtege(d, g) {
  if (!g) return; const r = g._protegeRestore;
  g.protegeOf = null; g._protegeRestore = null;
  if (r) { g.combatant = r.combatant; g.canWork = r.canWork; g.inParty = r.inParty; g.bandLeaderId = r.bandLeaderId; g.groupType = r.groupType; }
  else { g.inParty = false; g.bandLeaderId = null; g.combatant = false; g.canWork = true; g.groupType = null; }
}
export function _endProtege(d, a, why) {
  if (why === 'graduated') {
    try { grantEpithet(d.sim, a, 'hero'); } catch { /* */ }   // the player's fame seeds a NEW hero
    if (d.sim.chronicle && d.sim.chronicle.note) d.sim.chronicle.note('legend', a.id, `${a.name}, once a green youth who trailed the traveller, has become a warrior of note in their own right — a hero made in a hero's shadow.`);
    d._recordSaga({ sagaKind: 'protege', key: `${a.id}`, protege: a.name, outcome: 'graduated' });
  }
  d._freeProtege(a);
}

// THE LEGEND — fade the player's notoriety/fame slowly (infamy lingers but isn't
// eternal: reform and the town forgets), and NARRATE the milestones as the realm comes
// to name the traveller a villain or hail them a hero. Latched so each fires once.
export function _superviseLegend(d) {
  if (!LEGEND || !LEGEND.enabled) return;
  const p = d.sim.player; if (!p) return;
  const k = (LEGEND.decayPerTick ?? 0.99955);
  if (p.notoriety) p.notoriety *= k;
  if (p.fame) p.fame *= k;
  const note = (t, arc) => { if (d.sim.chronicle && d.sim.chronicle.note) d.sim.chronicle.note('legend', p.id, t, arc); };
  // CRESCENDO: a reputation is EARNED across many deeds, so narrate it RISING — the town
  // first murmurs, then talks openly, then anoints. The 0.66 saga lands as the climax of
  // a thread the player watched build, not a title sprung from nowhere. Each beat threads
  // under one named story (arcId) so the rise reads as a single arc in the feed. Latched.
  const fameArc = { id: 'legend-fame', title: "A Hero's Rising" };
  const infamyArc = { id: 'legend-infamy', title: "A Villain's Shadow" };
  const noto = p.notoriety || 0, fame = p.fame || 0;

  if (noto >= (LEGEND.villainAt || 0.66) && !p._legVillain) {
    p._legVillain = true;
    note(`The traveller is named a villain of the realm — folk speak the name with a shudder and bar their doors at dusk.`, infamyArc);
    d._recordSaga({ sagaKind: 'legend', key: 'villain', kind: 'villain' });
  } else if (noto >= 0.5 && !p._legInfamy2) {
    p._legInfamy2 = true;
    note(`Mothers now hush their children with the traveller's name — a dread that has spread well past this town.`, infamyArc);
  } else if (noto >= (LEGEND.dreadAt || 0.33) && !p._legDread) {
    p._legDread = true;
    note(`Word spreads that the traveller is not to be crossed — a dangerous sort, best given a wide berth.`, infamyArc);
  }

  if (fame >= (LEGEND.heroAt || 0.66) && !p._legHero) {
    p._legHero = true;
    note(`The traveller is hailed a hero of the realm — folk name their children for deeds like these.`, fameArc);
    d._recordSaga({ sagaKind: 'legend', key: 'hero', kind: 'hero' });
  } else if (fame >= 0.5 && !p._legFame2) {
    p._legFame2 = true;
    note(`The taverns are full of the traveller's deeds — every retelling burnishes the tale a little brighter.`, fameArc);
  } else if (fame >= (LEGEND.dreadAt || 0.33) && !p._legFame1) {
    p._legFame1 = true;
    note(`Folk have begun to trade tales of the traveller's doings — a name worth knowing, they say.`, fameArc);
  }
}

// THE GRATEFUL (player woven IN, warm mirror) — a townsperson the player saved becomes
// a loyal GUARDIAN: it reuses the bodyguard/warband path (bandLeaderId = the player) so
// _decideParty makes it shadow and defend the player, no new behaviour needed. The
// bond is kept warm against decay and bounded by a TTL, then a grateful farewell.
export function _enlistGuardian(d, g, player, savedFrom) {
  g._guardRestore = { combatant: g.combatant, canWork: g.canWork, inParty: g.inParty, bandLeaderId: g.bandLeaderId, groupType: g.groupType };
  g.guardianOf = player.id; g._guardSince = d.sim.time; g.guardSavedFrom = savedFrom; g._guardRepaid = false;
  g.bandLeaderId = player.id; g.inParty = true; g.combatant = true; g.canWork = false; g.groupType = 'warband';
  try { const b = g.beliefs._ensure(player.id); b.hostile = false; b.standing = 1; b.confidence = Math.max(b.confidence || 0, 0.85); } catch { /* never throw */ }
  if (d.sim.chronicle && d.sim.chronicle.note) d.sim.chronicle.note('fortune', g.id, `${g.name}, saved from ${savedFrom} by the traveller, has sworn to watch their back a while in thanks.`);
}
export function _freeGuardian(d, g) {
  if (!g) return; const r = g._guardRestore;
  g.guardianOf = null; g._guardRestore = null;
  if (r) { g.combatant = r.combatant; g.canWork = r.canWork; g.inParty = r.inParty; g.bandLeaderId = r.bandLeaderId; g.groupType = r.groupType; }
  else { g.inParty = false; g.bandLeaderId = null; g.combatant = false; g.canWork = true; g.groupType = null; }
}
export function _superviseGrateful(d) {
  if (!GRATEFUL || !GRATEFUL.enabled) return;
  const player = d.sim.player;
  for (const a of d.sim.agents) {
    if (!a || a.guardianOf == null) continue;
    if (!a.alive) { a.guardianOf = null; continue; }     // death is narrated in combatEvents
    if (!player || !player.alive || a.guardianOf !== player.id) { d._endGuardian(a, 'parted'); continue; }
    try { const b = a.beliefs._ensure(player.id); b.hostile = false; b.standing = Math.max(b.standing, 0.8); } catch { /* never throw */ }
    if (d.sim.time - (a._guardSince || 0) > (GRATEFUL.ttl || 150)) d._endGuardian(a, 'farewell');
  }
}
export function _endGuardian(d, a, why) {
  const savedFrom = a.guardSavedFrom || 'death', repaid = !!a._guardRepaid;
  if (why === 'farewell') {
    const player = d.sim.player, gift = Math.min((GRATEFUL.gift || 6), Math.max(0, Math.floor(a.gold || 0)));
    if (player && gift > 0) { a.gold -= gift; player.gold += gift; }   // a parting token (TRANSFER, no mint)
    if (d.sim.chronicle && d.sim.chronicle.note) d.sim.chronicle.note('fortune', a.id, `${a.name}, their debt to the traveller paid in loyal service, takes their leave with a token of thanks.`);
    d._recordSaga({ sagaKind: 'grateful', key: `${a.id}`, guardian: a.name, savedFrom, outcome: repaid ? 'repaid' : 'farewell' });
  }
  d._freeGuardian(a);
}

// THE AVENGER (player woven IN) — keep each personal nemesis HUNTING. The grudge a
// player earns by murder would otherwise cool in ~90s (belief-decay / forgiveness-
// drift) and the avenger drift back to market; here we re-stamp the hostility every
// tick so the hunt never fades, bound it with a TTL (so an unreachable player isn't
// hunted forever), and file the vendetta as a saga when it ends.
export function _superviseAvengers(d) {
  if (!AVENGER || !AVENGER.enabled) return;
  const player = d.sim.player;
  for (const a of d.sim.agents) {
    if (!a || a.avengerOf == null) continue;
    if (!a.alive) { a.avengerOf = null; continue; }     // death is narrated in combatEvents
    if (!player || !player.alive || a.avengerOf !== player.id) { d._endAvenger(a, 'fade'); continue; }
    // keep the grudge HOT so decay/forgiveness never cools the hunt.
    try { const b = a.beliefs._ensure(player.id); b.hostile = true; b.standing = -1; b.confidence = Math.max(b.confidence || 0, 0.85); } catch { /* never throw */ }
    if (d.sim.time - (a._avengerSince || 0) > (AVENGER.ttl || 240)) d._endAvenger(a, 'unslaked');
  }
}
export function _endAvenger(d, a, why) {
  const victim = a.avengerVictim || 'their kin';
  a.avengerOf = null; a.combatant = false;
  if (why === 'unslaked' && d.sim.chronicle && d.sim.chronicle.note) {
    d.sim.chronicle.note('vendetta', a.id, `${a.name}'s thirst to avenge ${victim} fades, unslaked — the traveller has outrun the reckoning, for now.`);
    d._recordSaga({ sagaKind: 'avenger', key: `${a.id}`, avenger: a.name, victim, outcome: 'unslaked' });
  }
}
