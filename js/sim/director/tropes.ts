// DIRECTOR / TROPES — the trope engine: the director as a light story manager. The
// trope SUBSTRATE (masters, apprentices, families, simmering dislikes) is already dense
// at any world size; what's scarce is the SPARK. So the director scans LIVE agents for a
// constellation that ALMOST forms a known trope and supplies the missing piece; the
// emergent systems then play it out and the chronicle narrates it. Each instigator
// returns true if it fired. Free functions over the Director instance `d`.
//
// NOTE: a few tropes that own a special-agent role (war/nemesis → raids.js;
// duel/bodyguard → roles.js; caravan → caravans.js) live in those modules; the
// dispatcher here reaches them through the instance delegators.
import { DIRECTOR } from '../simconfig.js';
import { BEAT } from '../chronicle.js';
import { areHousesFeuding, setHouseFeud } from '../houses.js';
import { rand, clamp } from './util.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dir = any;   // the Director instance (thin shell — director.ts). `folk`/`a`/etc. are
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;    // Agents via their long-tail drama flags; `T` is the (config-derived)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tropes = any;// tropes config block, dynamically keyed by trope name. Opaque on purpose;
                  // behaviour is unchanged and fully guarded.


// --- THE DISPATCHER: "do the most dramatic thing that's possible this moment." -----
export function _instigateTrope(d: Dir, _ctx?: unknown): void {   // _ctx: kept for the call-site signature; unused
  const T: Tropes = DIRECTOR.tropes;   // dynamically keyed by trope name below (T[flag])
  if (!T || !T.enabled) return;
  if (!d.sim._spawned) return;   // a real town only (not bare test sub-sims)
  if (d.sim.time - d._lastTropeAt < (T.cooldown || 0)) return;
  const folk = d._townsfolkAlive();
  if (folk.length < 3) return;
  // SALIENCE-DRIVEN selection: try tropes in PRIORITY order — the rare/dramatic ones
  // (a war, a duel, a sacrifice, a betrayal) FIRST so they're not lost, and the
  // reliable warm filler (reunion/miser/boast) LAST so it never crowds them out —
  // firing the FIRST whose constellation exists right now.
  const W = 'warm', D = 'dark', N = 'neutral';
  // a trope row: [config-flag name, the instigator (returns true if it fired), tone tag].
  type Row = [string, () => boolean, string];
  // TIER 1 — truly SCARCE-constellation, high-stakes tropes: tried FIRST so a rare
  // dramatic moment (a war, a duel, a sacrifice, a spy exposed) is never lost.
  const tier1: Row[] = [
    ['war', () => d._tropeWar(), D],
    ['nemesis', () => d._tropeNemesis(), D],
    ['duel', () => d._tropeDuel(folk), D],
    // star-crossed lovers up front: its constellation (unwed pair across a feud) is
    // ALWAYS available, so dead-last it was never reached; its 300s cooldown bounds it.
    ['starCrossed', () => d._tropeStarCrossed(folk), W],
    // falseWitness now SEEDS the wrongly-accused arc (always-available constellation) —
    // tier-1 reach + 300s cooldown, like the other arc seeds.
    ['falseWitness', () => d._tropeFalseWitness(folk), D],
    ['bodyguard', () => d._tropeBodyguard(folk), W],
    ['spyUnmasked', () => d._tropeSpyUnmasked(), D],
    ['unlikelyFriendship', () => d._tropeUnlikelyFriendship(folk), W],
    ['vendetta', () => d._tropeVendetta(folk, T), D],
    // a betrayal is a MAJOR beat AND the seed of the reckoning arc — it deserves
    // reliable reach (tier-2 was starved). The per-kind cooldown caps its rate.
    ['betrayal', () => d._tropeBetrayal(folk), D],
    // likewise the tyrant — seed of the tyrant's-fall arc; cooldown override caps it.
    ['tyrantMarket', () => d._tropeTyrantMarket(folk), D],
    // keep a few house feuds simmering — a SYSTEM seed; self-limited by its cap.
    ['houseFeud', () => d._tropeHouseFeud(folk), D],
  ];
  // TIER 2 — common constellations, each tagged WARM/DARK/NEUTRAL. The storyteller
  // keeps EMOTIONAL CONTRAST: it tracks a running tone and, when the feed has skewed
  // one way, tries the UNDER-represented register first this roll.
  const tier2all: Row[] = [
    ['feud', () => d._tropeFeud(folk, T), D],
    ['caravanRaid', () => d._tropeCaravan(), N],
    ['prophet', () => d._tropeProphet(folk, T), N],
    ['rivalApprentices', () => d._tropeRivalApprentices(folk, T), N],
    ['favoredRise', () => d._tropeFavoredRise(folk), D],
    ['mistakenJealousy', () => d._tropeMistakenJealousy(folk), D],
    ['reunion', () => d._tropeReunion(folk), W],
    ['miserReformed', () => d._tropeMiserReformed(folk), W],
    ['boastBackfires', () => d._tropeBoastBackfires(folk), N],
    ['prodigalReturn', () => d._tropeProdigalReturn(folk), W],
    ['debtRepaid', () => d._tropeDebtRepaid(folk), W],
    ['mentorPride', () => d._tropeMentorPride(folk), W],
  ];
  const tone = d._tone || 0;
  let tier2: Row[];
  if (tone >= 1.5) tier2 = [...d._shuffle(tier2all.filter((e) => e[2] !== W)), ...d._shuffle(tier2all.filter((e) => e[2] === W))];
  else if (tone <= -1.5) tier2 = [...d._shuffle(tier2all.filter((e) => e[2] !== D)), ...d._shuffle(tier2all.filter((e) => e[2] === D))];
  else tier2 = d._shuffle(tier2all);
  d._tone = tone * 0.85;     // decay toward neutral each roll
  // PER-KIND COOLDOWN — the decisive variety lever. Skipping any kind that fired in the
  // last `tropeKindCooldown`s forces the feed to rotate through the whole catalog.
  const now = d.sim.time, baseCd = DIRECTOR.tropeKindCooldown ?? 110;
  const cdOver = (DIRECTOR.tropeKindCooldownOverride || {}) as Record<string, number>;
  d._kindAt = d._kindAt || {};
  for (const [flag, fn, tn] of [...tier1, ...tier2]) {
    if (!T[flag]) continue;
    if (now - (d._kindAt[flag] ?? -1e9) < (cdOver[flag] ?? baseCd)) continue;   // this KIND fired recently — rotate on
    try {
      if (fn()) {
        d.stats.tropes++; d._lastTropeAt = d.sim.time; d._sinceEvent = 0;
        d._kindAt[flag] = now;
        d._tone = clamp((d._tone || 0) + (tn === W ? 1 : tn === D ? -1 : 0), -4, 4);
        return;
      }
    } catch { /* an instigator must never break the tick */ }
  }
}

// REUNION OF KIN (RECOVERY/LOSS): two long-parted townsfolk of one House recognize
// their shared blood — warmth + a memory + a chronicle beat. Once per pair.
export function _tropeReunion(d: Dir, folk: Ag[]): boolean {
  const T = DIRECTOR.tropes, now = d.sim.time;
  d._reunited = d._reunited || new Set();
  const housed = folk.filter((a) => a.house);
  for (const A of d._spotlight(housed)) {
    for (const B of housed) {
      if (B === A || B.house !== A.house) continue;
      if (Array.isArray(A.kinIds) && A.kinIds.includes(B.id)) continue;     // not already close kin
      if (A.pos.distanceTo(B.pos) > (T.proximity || 26)) continue;
      const key = A.id < B.id ? `${A.id}:${B.id}` : `${B.id}:${A.id}`;
      if (d._reunited.has(key)) continue;
      d._reunited.add(key);
      const amt = T.warmAmt || 0.25;
      d._warm(A, B, amt); d._warm(B, A, amt);
      d._remember(A, { t: now, kind: 'reunion', withId: B.id, valence: 0.5, salience: 0.5 });
      d._remember(B, { t: now, kind: 'reunion', withId: A.id, valence: 0.5, salience: 0.5 });
      d._note(BEAT.UNION, A.id, `${A.name} and ${B.name}, long-parted kin of House ${A.house}, have found one another again.`);
      return true;
    }
  }
  return false;
}

// UNLIKELY FRIENDSHIP (COMEDY/LOYALTY): two who bear each other ill will strike up a
// bond — warm ONE side to break the symmetry; gossip + proximity carry the rest.
export function _tropeUnlikelyFriendship(d: Dir, folk: Ag[]): boolean {
  const T = DIRECTOR.tropes;
  for (const A of d._spotlight(folk)) {
    if (!A.beliefs || !A.beliefs.all) continue;
    for (const b of A.beliefs.all()) {
      const B = d.sim.agentsById.get(b.subjectId);
      if (!B || !B.alive || B.controlled || B.faction !== 'townsfolk' || B === A) continue;
      if (A.townId != null && B.townId != null && A.townId !== B.townId) continue;   // same town
      // "unlikely" = real enmity OR a feud between their HOUSES.
      const enmity = b.standing < -0.15 || b.hostile;
      const houseRift = A.house && B.house && areHousesFeuding(d.sim, A.house, B.house);
      if (!enmity && !houseRift) continue;
      d._warm(A, B, (T.warmAmt || 0.25) + 0.1);
      const why = houseRift ? `across the feud between Houses ${A.house} and ${B.house}` : 'despite the bad blood between them';
      d._note(BEAT.UNION, A.id, `${A.name} and ${B.name} have struck up an unlikely friendship, ${why}.`);
      return true;
    }
  }
  return false;
}

// THE FALSE WITNESS (JUSTICE): a whispering campaign poisons an INNOCENT's name —
// plant a false ill opinion in a few neighbours; gossip spreads it (damped), decay
// heals it unless reinforced. The target's TRUTH is untouched (the epistemic split).
export function _tropeFalseWitness(d: Dir, folk: Ag[]): boolean {
  const T = DIRECTOR.tropes;
  const target = d._spotlight(folk).find((a: any) => a.faction === 'townsfolk');
  if (!target) return false;
  const near = folk.filter((a) => a !== target && a.pos.distanceTo(target.pos) <= (T.proximity || 26) * 1.5);
  if (near.length < 2) return false;
  let touched = 0;
  for (const G of d._shuffle(near)) {
    if (touched >= 3) break;
    d._plant(G, target.id, { dStanding: -(T.slanderDrop || 0.35), suspicion: 0.45, confidence: 0.5 });
    touched++;
  }
  if (touched) {
    d._note(BEAT.VENDETTA, target.id, `An ugly whisper turns the town against ${target.name} — though ${target.name} has done no wrong.`);
    // COMPOSE THE WRONGLY-ACCUSED ARC — the slander SPREADS, then the truth prevails
    // (exoneration) or comes too late (tragedy).
    if (DIRECTOR.tropes.wronglyAccused && target._accusedAt == null) {
      target._accusedAt = d.sim.time;
      (d._arcs || (d._arcs = [])).push({ kind: 'accused', b: target.id, stage: 1, nextAt: d.sim.time + rand(30, 48) });
    }
  }
  return touched > 0;
}

// THE FAVORED RISE (AMBITION): an upstart is suddenly over-credited by the town (a
// false reputation spike planted in their circle) — then FALLS as the lie fades.
export function _tropeFavoredRise(d: Dir, folk: Ag[]): boolean {
  const T = DIRECTOR.tropes, now = d.sim.time;
  d._favored = d._favored || [];
  if (d._favored.some((f: any) => f && f.live)) return false;     // one rise at a time
  const upstart = d._spotlight(folk).find((a: any) => a.faction === 'townsfolk');
  if (!upstart) return false;
  const near = folk.filter((a) => a !== upstart && a.pos.distanceTo(upstart.pos) <= (T.proximity || 26) * 1.5);
  if (near.length < 2) return false;
  const by = [];
  for (const G of d._shuffle(near)) {
    if (by.length >= 4) break;
    d._plant(G, upstart.id, { dStanding: +(T.riseBump || 0.4), confidence: 0.7 });
    by.push(G.id);
  }
  if (!by.length) return false;
  d._favored.push({ id: upstart.id, by, fallAt: now + (T.riseFallSecs || 60), live: true });
  d._note(BEAT.FORTUNE, upstart.id, `Of a sudden, ${upstart.name} is the toast of the town — though few could say quite why.`);
  return true;
}

// MISTAKEN JEALOUSY (LOVE): a poisoned whisper makes one spouse believe the other
// false — the bond cools until decay heals it or it festers to a tragic split.
export function _tropeMistakenJealousy(d: Dir, folk: Ag[]): boolean {
  const T = DIRECTOR.tropes;
  for (const A of d._spotlight(folk)) {
    if (A.mateId == null || A._jealousUntil > d.sim.time) continue;
    const B = d.sim.agentsById.get(A.mateId);
    if (!B || !B.alive || !A.beliefs || !A.beliefs._ensure) continue;
    const b = A.beliefs._ensure(B.id);
    if (!b || b.hostile) continue;
    b.standing = clamp(b.standing - (T.jealousyDrop || 0.5), -1, 1);
    b.suspicion = Math.min(1, Math.max(b.suspicion, 0.45));
    b.confidence = Math.min(1, Math.max(b.confidence, 0.3));
    A._jealousUntil = d.sim.time + 90;
    d._remember(A, { t: d.sim.time, kind: 'betrayal', withId: B.id, valence: -0.7, salience: 0.7 });
    d._note(BEAT.VENDETTA, A.id, `A poisoned whisper reaches ${A.name}: that ${B.name}, their own spouse, has been false — though there is no truth in it.`);
    return true;
  }
  return false;
}

// BETRAYAL OF A FRIEND (LOYALTY): a trusted confidant turns — one held dear becomes
// an enemy, the trust weaponized. A real shift (not a lie), and a lasting wound.
export function _tropeBetrayal(d: Dir, folk: Ag[]): boolean {
  const T = DIRECTOR.tropes;
  for (const A of d._spotlight(folk)) {
    if (A._betrayedAt) continue;
    // A betrayal cuts deepest along a DURABLE bond (kin, a mentor). Friendship is a last resort.
    const bonds = [];
    if (Array.isArray(A.kinIds)) A.kinIds.forEach((k: any) => bonds.push([k, 'their own blood']));
    if (A.masterId != null) bonds.push([A.masterId, 'the very mentor who raised them']);
    if (A.beliefs && A.beliefs.all) for (const ab of A.beliefs.all()) { if (ab.standing >= 0.5 && !ab.hostile) bonds.push([ab.subjectId, 'a friend who trusted them']); }
    for (const [lid, rel] of d._shuffle(bonds)) {
      const L = d.sim.agentsById.get(lid);
      if (!L || !L.alive || L.controlled || L.faction !== 'townsfolk' || L === A) continue;
      if (!L.beliefs || !L.beliefs._ensure) continue;
      const la = L.beliefs._ensure(A.id);                 // L turns on A
      if (la.hostile) continue;                           // already enemies — no trust left to betray
      la.standing = clamp(la.standing - (T.betrayalDrop || 0.6), -1, 1);
      la.hostile = true; la.confidence = Math.max(la.confidence, 0.7);
      if (A.beliefs && A.beliefs._ensure) { const ab = A.beliefs._ensure(L.id); ab.standing = clamp(ab.standing - 0.4, -1, 1); }   // A's wounded trust
      A._betrayedAt = d.sim.time;
      d._remember(A, { t: d.sim.time, kind: 'betrayed', withId: L.id, valence: -1, salience: 0.9 });
      d._note(BEAT.VENDETTA, A.id, `${L.name} has turned on ${A.name}, ${rel} — a bitter betrayal.`);
      // COMPOSE AN ARC: a betrayal sets a RECKONING in motion (sworn vengeance → a duel).
      if (DIRECTOR.tropes.reckoningArc) {
        (d._arcs || (d._arcs = [])).push({ kind: 'reckoning', wronged: A.id, betrayer: L.id, rel, stage: 1, nextAt: d.sim.time + rand(28, 45) });
      }
      return true;
    }
  }
  return false;
}

// THE MISER REFORMED (REDEMPTION): a hoarder is moved to give — gold flows to a needy
// neighbour (a TRANSFER, no mint), and in the giving the miser discovers belonging.
export function _tropeMiserReformed(d: Dir, folk: Ag[]): boolean {
  const T = DIRECTOR.tropes;
  const misers = folk.filter((a) => a.personality && a.personality.altruism < 0.25 && a.gold >= (T.miserGold || 40) && !a._miserReformed);
  for (const M of d._spotlight(misers)) {
    const poor = folk.find((a) => a !== M && a.gold < 8 && a.pos.distanceTo(M.pos) <= (T.proximity || 26) * 1.5);
    if (!poor) continue;
    const gift = Math.min(T.miserGift || 15, Math.max(0, Math.floor(M.gold)));
    if (gift <= 0) continue;
    M.gold -= gift; poor.gold += gift;                     // CLOSED LOOP — a transfer
    M.personality.altruism = clamp(M.personality.altruism + 0.25, 0, 1);
    M._miserReformed = true;
    d._warm(poor, M, 0.4);                                 // gratitude
    d._remember(poor, { t: d.sim.time, kind: 'succoured', withId: M.id, valence: 0.6, salience: 0.5 });
    d._note(BEAT.FORTUNE, M.id, `${M.name}, ever close-fisted, has opened their purse to ${poor.name} in need — and seems the lighter for it.`);
    return true;
  }
  return false;
}

// THE PRODIGAL'S RETURN (RECOVERY): a restless wanderer puts down roots at last,
// coming home to the kin they'd left behind — a warm reunion, once per soul.
export function _tropeProdigalReturn(d: Dir, folk: Ag[]): boolean {
  for (const A of d._spotlight(folk)) {
    if (A._prodigalArc || !(A.ambition && A.ambition.kind === 'wanderlust') || !Array.isArray(A.kinIds)) continue;
    const kin = A.kinIds.map((id: any) => d.sim.agentsById.get(id)).find((k: any) => k && k.alive && k.faction === 'townsfolk');
    if (!kin) continue;
    A._prodigalArc = true;
    d._warm(A, kin, 0.4); d._warm(kin, A, 0.4);
    d._remember(A, { t: d.sim.time, kind: 'reunion', withId: kin.id, valence: 0.6, salience: 0.6 });
    d._note(BEAT.UNION, A.id, `${A.name}, ever restless, has come home to their kin at last — and ${kin.name} welcomes them back.`);
    return true;
  }
  return false;
}

// DEBT OF HONOUR REPAID (LOYALTY): one who was helped in their need repays it in
// kind — a gift from their own purse (closed loop) and a warming of the bond.
export function _tropeDebtRepaid(d: Dir, folk: Ag[]): boolean {
  for (const A of d._spotlight(folk)) {
    if (A._debtRepaid || !A.memory || !A.memory.stm) continue;
    let saviour = null;
    try {
      const eps = [...A.memory.stm.items(), ...A.memory.mtm.items(), ...A.memory.ltm.items()];
      for (const e of eps) { if (e && e.kind === 'succoured' && e.withId != null) { const B = d.sim.agentsById.get(e.withId); if (B && B.alive && B !== A) { saviour = B; break; } } }
    } catch { /* */ }
    if (!saviour) continue;
    A._debtRepaid = true;
    const gift = Math.min(8, Math.max(0, Math.floor(A.gold || 0)));
    if (gift > 0) { A.gold -= gift; saviour.gold += gift; }     // CLOSED LOOP — a transfer
    d._warm(saviour, A, 0.3); d._warm(A, saviour, 0.2);
    d._remember(A, { t: d.sim.time, kind: 'repaid', withId: saviour.id, valence: 0.6, salience: 0.5 });
    d._note(BEAT.FORTUNE, A.id, `${A.name} has repaid their debt to ${saviour.name}, who once helped them in their need — honour is kept.`);
    return true;
  }
  return false;
}

// THE MENTOR'S PRIDE (LEGACY): a master takes quiet pride as the apprentice they
// raised comes into their own — a warm bond to set against the rival-apprentice feud.
export function _tropeMentorPride(d: Dir, folk: Ag[]): boolean {
  for (const A of d._spotlight(folk)) {
    if (A.masterId == null || A._mentorPride) continue;
    const M = d.sim.agentsById.get(A.masterId);
    if (!M || !M.alive || M.faction !== 'townsfolk') continue;
    A._mentorPride = true;
    d._warm(M, A, 0.3); d._warm(A, M, 0.3);
    d._remember(M, { t: d.sim.time, kind: 'bond', withId: A.id, valence: 0.6, salience: 0.5, rel: 'mentor' });
    d._note(BEAT.MENTOR, M.id, `${M.name} beams with quiet pride as their apprentice ${A.name} comes into their own.`);
    return true;
  }
  return false;
}

// THE SPY UNMASKED (MYSTERY): a disguised infiltrator is exposed — the town turns on
// the traitor it trusted. Activates the dormant ToM-deception core ON DEMAND.
export function _tropeSpyUnmasked(d: Dir): boolean {
  const intr = d.sim.intrigue;
  if (!intr || !intr.spies || !intr._unmask) return false;
  const spies = intr.spies.filter((s: any) => s && s.alive && s.disguiseFaction && !s._spyArc);
  if (!spies.length) return false;
  const spy = d._shuffle(spies)[0];
  if (DIRECTOR.tropes.spyWebArc) {
    // SEED THE SPY'S WEB ARC — a slow-burn mystery: suspicion WHISPERS first.
    spy._spyArc = true;
    (d._arcs || (d._arcs = [])).push({ kind: 'spyWeb', spyId: spy.id, stage: 1, nextAt: d.sim.time + rand(28, 46) });
    return true;
  }
  try { intr._unmask(spy, d.sim._ctx ? d.sim._ctx() : { agents: d.sim.agents, time: d.sim.time }); }
  catch { return false; }
  return true;
}

// THE TYRANT'S MARKET (AMBITION): a grasping producer gouges the town — customers
// resent them and believe the price dearer. Belief-only; shunned, not slain.
export function _tropeTyrantMarket(d: Dir, folk: Ag[]): boolean {
  const T = DIRECTOR.tropes;
  // a producer of a NON-FOOD staple (food gouging risks the starvation lesson) with
  // some wealth — a position to abuse.
  const tyrants = folk.filter((a) => a._trade && (a._trade === 'ore' || a._trade === 'wood' || a._trade === 'herb') && a.gold >= 20 && !a._tyrantAt);
  for (const M of d._spotlight(tyrants)) {
    const near = folk.filter((a) => a !== M && a.pos.distanceTo(M.pos) <= (T.proximity || 26) * 1.5);
    if (near.length < 3) continue;
    let touched = 0;
    for (const C of d._shuffle(near)) {
      if (touched >= 5) break;
      d._sour(C, M, T.tyrantSour || 0.35);
      d._plant(C, M.id, { suspicion: 0.5 });
      if (C.priceBeliefs && C.priceBeliefs[M._trade] != null) C.priceBeliefs[M._trade] = +(C.priceBeliefs[M._trade] * (T.tyrantPriceMul || 1.15)).toFixed(2);
      touched++;
    }
    if (!touched) continue;
    M._tyrantAt = d.sim.time;
    d._note(BEAT.VENDETTA, M.id, `${M.name} has grown grasping, gouging the town for ${M._trade} — and folk are starting to mutter against them.`);
    // COMPOSE AN ARC: the gouging sets a FALL in motion (down or shamed into amends).
    if (DIRECTOR.tropes.tyrantFallArc) {
      (d._arcs || (d._arcs = [])).push({ kind: 'tyrantFall', tyrant: M.id, stage: 1, nextAt: d.sim.time + rand(35, 55) });
    }
    return true;
  }
  return false;
}

// KEEP THE HOUSE FEUDS SIMMERING — top the world up to a few live feuds between
// sizeable houses; capped, and healed by cross-house marriage.
export function _tropeHouseFeud(d: Dir, folk: Ag[]): boolean {
  if (!DIRECTOR.tropes.houseFeud) return false;
  const houses = [...new Set(folk.map((a) => a.house).filter(Boolean))];
  let live = 0;
  for (let x = 0; x < houses.length; x++) for (let y = x + 1; y < houses.length; y++) if (areHousesFeuding(d.sim, houses[x], houses[y])) live++;
  if (live >= (DIRECTOR.tropes.houseFeudCap || 3)) return false;
  const big = d._shuffle(houses.filter((h) => folk.filter((a) => a.house === h).length >= 2));
  for (const hA of big) {
    const hB = big.find((h: any) => h !== hA && !areHousesFeuding(d.sim, hA, h));
    if (!hB) continue;
    setHouseFeud(d.sim, hA, hB);
    const voice = folk.find((a) => a.house === hA);
    if (voice) d._note(BEAT.VENDETTA, voice.id, `An old slight festers into open enmity: Houses ${hA} and ${hB} are at feud.`);
    return true;
  }
  return false;
}

// THE STAR-CROSSED LOVERS (ROMANCE) — seed a forbidden attraction across a house
// feud, then the arc plays it to a union (that HEALS the feud) or heartbreak.
export function _tropeStarCrossed(d: Dir, folk: Ag[]): boolean {
  if (!DIRECTOR.tropes.starCrossed) return false;
  const singles = folk.filter((a) => a.mateId == null && a.house && a._courtingId == null && !a.controlled);
  for (const A of d._spotlight(singles)) {
    const B = singles.find((b) => b !== A && b.house !== A.house && areHousesFeuding(d.sim, A.house, b.house));
    if (!B) continue;
    A._courtingId = B.id; B._courtingId = A.id;
    d._warm(A, B, 0.5); d._warm(B, A, 0.5);     // the spark that overcomes the old hatred
    d._note(BEAT.UNION, A.id, `Despite the bitter feud between Houses ${A.house} and ${B.house}, ${A.name} and ${B.name} have grown close — a dangerous love.`);
    (d._arcs || (d._arcs = [])).push({ kind: 'romance', a: A.id, b: B.id, hA: A.house, hB: B.house, stage: 1, nextAt: d.sim.time + rand(30, 48) });
    return true;
  }
  return false;
}

// THE BOAST BACKFIRES (COMEDY): a renown-seeker's planted fame outruns their real
// deeds — the town comes to believe a tale the boaster can't yet back.
export function _tropeBoastBackfires(d: Dir, folk: Ag[]): boolean {
  const T = DIRECTOR.tropes;
  for (const A of d._spotlight(folk)) {
    if (A._boastAt > d.sim.time) continue;
    if (!(A.ambition && A.ambition.kind === 'renown')) continue;
    const near = folk.filter((o) => o !== A && o.pos.distanceTo(A.pos) <= (T.proximity || 26) * 1.5);
    if (near.length < 2) continue;
    let touched = 0;
    for (const O of d._shuffle(near)) { if (touched >= 4) break; d._warm(O, A, T.boastFame || 0.3); touched++; }
    if (!touched) continue;
    A._boastAt = d.sim.time + 120;
    d._note(BEAT.FORTUNE, A.id, `${A.name} has been boasting of monsters slain in the deep wilds — and the town, for now, believes it.`);
    return true;
  }
  return false;
}

// RIVAL APPRENTICES — a seasoned master with two young neighbours: seed their
// mutual rivalry (the apprenticeship pass already teaches them; the rivalry makes
// them COMPETE, until one surpasses). Uses existing agents — no spawn, no scale.
export function _tropeRivalApprentices(d: Dir, folk: Ag[], T: Tropes): boolean {
  const masters = d._spotlight(folk.filter((a) => d._lvl(a) >= T.masterMinLevel));
  for (const M of masters) {
    const apps = folk.filter((a) => a !== M && d._lvl(a) <= T.apprenticeMaxLevel &&
      a.pos.distanceTo(M.pos) <= T.proximity);
    if (apps.length < 2) continue;
    const [a, b] = d._shuffle(apps);
    d._sour(a, b, T.rivalryDrop); d._sour(b, a, T.rivalryDrop);
    a.rivalId = b.id; b.rivalId = a.id;
    // tag both to the master so lineage can chronicle the payoff (surpassing).
    a.masterId = M.id; b.masterId = M.id;
    d._note(BEAT.MENTOR, M.id, `${a.name} and ${b.name} vie to be ${M.name}'s heir.`);
    return true;
  }
  return false;
}

// FEUD — deepen a simmering dislike (or, failing that, a chance proximity) between
// two townsfolk into open enmity. Prefers a pair that ALREADY mistrusts.
export function _tropeFeud(d: Dir, folk: Ag[], T: Tropes): boolean {
  let best = null, worst = 0.1;          // most-negative existing pair found so far
  let fallback = null;
  const F = d._spotlight(folk);
  for (const A of F) {
    for (const B of folk) {
      if (B === A || A.pos.distanceTo(B.pos) > T.proximity) continue;
      if (!fallback) fallback = [A, B];
      const ab = A.beliefs.get(B.id);
      if (ab && ab.standing < worst) { worst = ab.standing; best = [A, B]; }
    }
  }
  const pair = best || fallback;
  if (!pair) return false;
  const [A, B] = pair;
  d._sour(A, B, T.feudDrop); d._sour(B, A, T.feudDrop);
  // LATCH the enmity hostile: otherwise the chatting-affinity in perception rebuilds
  // their standing within a tick or two and the feud evaporates.
  const ab = A.beliefs.get(B.id), ba = B.beliefs.get(A.id);
  if (ab) ab.hostile = true;
  if (ba) ba.hostile = true;
  d._note(BEAT.VENDETTA, A.id, `A feud erupted between ${A.name} and ${B.name}.`);
  // HOUSE FEUD: if the two belong to different Houses, the quarrel becomes a feud
  // between their LINES — which their children will inherit (lineage).
  if (A.house && B.house && A.house !== B.house && !areHousesFeuding(d.sim, A.house, B.house)) {
    setHouseFeud(d.sim, A.house, B.house);
    d._note(BEAT.VENDETTA, A.id, `The feud sets Houses ${A.house} and ${B.house} against each other.`);
  }
  return true;
}

// VENDETTA — amplify a REAL grievance (a townsperson already mistrusts someone)
// into a sworn vendetta: latch the belief hostile so the avenge machinery can
// pick it up. Only fires when an actual grievance exists (never manufactured).
export function _tropeVendetta(d: Dir, folk: Ag[], T: Tropes): boolean {
  for (const A of d._spotlight(folk)) {
    if (!A.beliefs || !A.beliefs.all) continue;
    for (const b of A.beliefs.all()) {
      if (!b || (b.standing > -0.35 && !b.hostile)) continue;   // a genuine grievance only
      const K = d.sim.agentsById.get(b.subjectId);
      if (!K || !K.alive || K === A) continue;
      b.hostile = true;
      b.confidence = Math.max(b.confidence || 0, 0.6);
      d._note(BEAT.VENDETTA, A.id, `${A.name} swore vengeance on ${K.name}.`);
      return true;
    }
  }
  return false;
}

// A PROPHET RISES (Small Gods) — a charismatic soul takes up the creed of the
// faith most in need (reviving a dwindled/dead god); their proselytising spreads it.
export function _tropeProphet(d: Dir, folk: Ag[], T: Tropes): boolean {
  if (!d.sim.faith || !d.sim.faith.anointProphet) return false;
  const pool = d._spotlight(folk).sort((a: any, b: any) =>
    ((b.personality && b.personality.social_drive) || 0) - ((a.personality && a.personality.social_drive) || 0));
  const prophet = pool[0];
  if (!prophet) return false;
  const res = d.sim.faith.anointProphet(prophet);   // default: weakest/dead god
  if (!res) return false;
  d._note(BEAT.FAITH, prophet.id,
    res.reviving ? `${prophet.name} took up the forgotten prophecy of ${res.god}.`
                 : `${prophet.name} began preaching the faith of ${res.god}.`);
  return true;
}
