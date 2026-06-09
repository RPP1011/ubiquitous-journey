// DIRECTOR / ARCS — multi-beat stories the director authors across time: set-up →
// escalation → climax → resolution. Unlike a lone trope (one beat, then gone), an arc
// is a SHAPED story; each per-kind stepper returns the arc to keep, or null to drop it
// (it dissolves gracefully if a principal dies/leaves). Completed arcs are filed as
// SAGAS the Gazette threads into a single feature. Free functions over `d`.
import { DIRECTOR, SIM } from '../simconfig.js';
import { BEAT } from '../chronicle.js';
import { rand, clamp } from './util.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dir = any;   // the Director instance (thin shell — director.ts). `arc`/`saga`/`a` are
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;    // file-local freeform drama records / Agents. Opaque on purpose; the
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Arc = any;   // behaviour is unchanged and fully guarded.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Saga = any;


// the title each arc kind reads under in the chronicle — so its scattered beats
// (set-up → escalation → climax) thread together as one named tale instead of
// disconnected log lines. A new arc kind without an entry just falls back to 'A Tale'.
const ARC_TITLE: Record<string, string> = {
  reckoning:  'The Reckoning',
  tyrantFall: "The Tyrant's Fall",
  spyWeb:     "The Spy's Web",
  romance:    'Star-Crossed',
  accused:    'The Wrongly Accused',
};

// step active multi-beat stories toward their climax. A dispatcher over per-kind
// steppers; each fires when its scheduled moment arrives.
export function _advanceArcs(d: Dir): void {
  if (!d._arcs || !d._arcs.length) return;
  const now = d.sim.time, keep = [];
  for (const arc of d._arcs) {
    if (!arc) continue;
    // stamp a stable identity + title once, so every beat this arc files can be
    // threaded together in the feed (assigned here, the single chokepoint all six
    // arc-creation sites flow through, rather than at each scattered push).
    if (arc.id == null) { arc.id = (d._arcSeq = (d._arcSeq || 0) + 1); arc.title = ARC_TITLE[arc.kind] || 'A Tale'; }
    let next = null;
    try {
      if (now < arc.nextAt) next = arc;                        // not yet due — hold
      else if (arc.kind === 'reckoning') next = d._stepReckoning(arc, now);
      else if (arc.kind === 'tyrantFall') next = d._stepTyrantFall(arc, now);
      else if (arc.kind === 'spyWeb') next = d._stepSpyWeb(arc, now);
      else if (arc.kind === 'romance') next = d._stepRomance(arc, now);
      else if (arc.kind === 'accused') next = d._stepAccused(arc, now);
    } catch { next = null; /* an arc must never break the tick */ }
    if (next) keep.push(next);
  }
  d._arcs = keep;
}

// record a completed arc as a SAGA — a structured retrospective the Gazette threads
// into a single feature article, so the player reads the whole shaped story at once
// instead of stitching scattered beats from the feed. Bounded ring; deduped by sig.
export function _recordSaga(d: Dir, saga: Saga): void {
  const S = (d._sagas = d._sagas || []);
  saga.t = d.sim.time;
  saga.sig = `saga:${saga.sagaKind}:${saga.key || ''}:${Math.floor(d.sim.time)}`;
  S.push(saga);
  while (S.length > 12) S.shift();
}

// duelists/principals must be unencumbered to stage an arc climax.
export function _arcFree(d: Dir, a: Ag): boolean {
  return a && a.alive && !a.watch && !a.reporter && !a.bounty && !a.inParty &&
    !a.expedition && !a.caravanRun && !a.bodyguardOf && a._duelWith == null && !a.nemesis && !a.warlord;
}

// THE RECKONING — a betrayal → sworn vengeance → a duel to settle it.
export function _stepReckoning(d: Dir, arc: Arc, now: number): Arc | null {
  const A = d.sim.agentsById.get(arc.wronged), L = d.sim.agentsById.get(arc.betrayer);
  if (!A || !A.alive || !L || !L.alive) return null;           // a principal is gone — dissolve
  if (arc.stage === 1) {
    // ESCALATION: the fresh wrong hardens into a sworn, durable rivalry.
    if (A.rivalId == null && L.rivalId == null) { A.rivalId = L.id; L.rivalId = A.id; }
    d._note(BEAT.VENDETTA, A.id, `${A.name}, wronged by ${L.name}, has sworn the betrayal will be answered — and means to settle it.`, arc);
    arc.stage = 2; arc.nextAt = now + rand(34, 56); return arc;
  }
  // CLIMAX: a duel — the payoff of a tracked story bypasses the spontaneous duel's
  // one-at-a-time cap (the supervisor handles concurrent duels); it waits only on the
  // two principals being free, and retries while the sworn grudge still holds.
  if (A.rivalId === L.id && L.rivalId === A.id && d._arcFree(A) && d._arcFree(L)) {
    d._enlistDuelist(A); d._enlistDuelist(L);
    A._duelWith = L.id; L._duelWith = A.id;
    d._note(BEAT.VENDETTA, A.id, `The bad blood between ${A.name} and ${L.name} comes to a head — they meet to settle the betrayal with steel.`, arc);
    d._recordSaga({ sagaKind: 'reckoning', key: `${A.id}-${L.id}`, a: A.name, l: L.name, rel: arc.rel || 'one who trusted them' });
    return null;
  }
  if ((arc.tries = (arc.tries || 0) + 1) < 6 && A.rivalId === L.id && L.rivalId === A.id) { arc.nextAt = now + rand(20, 34); return arc; }
  return null;   // give up — the standing duel trope may still resolve the lingering rivalry
}

// THE TYRANT'S FALL — a gouging producer → the town's resentment hardens → a champion
// either brings them DOWN (a duel, dark) or shames them into RELENTING (redemption,
// warm). A tonal FORK on the tyrant's conscience: the remorseless are challenged; the
// ones with a shred of shame make amends and lower their prices.
export function _stepTyrantFall(d: Dir, arc: Arc, now: number): Arc | null {
  const M = d.sim.agentsById.get(arc.tyrant);
  if (!M || !M.alive) return null;
  const folk = d.sim.agents.filter((a: any) => a.alive && a.autonomous && a.faction === 'townsfolk' && a !== M);
  const near = folk.filter((a: any) => a.pos && M.pos && a.pos.distanceTo(M.pos) <= (DIRECTOR.tropes.proximity || 26) * 2.2);
  if (arc.stage === 1) {
    // ESCALATION: the muttering hardens into open resentment.
    for (const C of d._shuffle(near).slice(0, 4)) d._sour(C, M, 0.18);
    d._note(BEAT.VENDETTA, M.id, `The town's anger at ${M.name}'s gouging for ${M._trade || 'their goods'} has hardened into open resentment.`, arc);
    arc.stage = 2; arc.nextAt = now + rand(40, 60); return arc;
  }
  // CLIMAX: it takes a BOLD soul to stand up to a tyrant — pick the gutsiest capable
  // townsperson nearby (highest risk_tolerance). Boldness is durable, unlike a soured
  // standing that decays over the ~100s before the climax (which left earlier champions
  // null). If no one near is brave/able enough, the tyrant gets off with merely relenting.
  let champ = null, bold = 0.5;
  for (const C of near) {
    if (!d._arcFree(C) || d._lvl(C) < 2) continue;
    const rt = (C.personality && C.personality.risk_tolerance) ?? 0.5;
    if (rt > bold) { bold = rt; champ = C; }
  }
  const remorseless = ((M.personality && M.personality.altruism) ?? 0.5) < 0.5;
  if (remorseless && champ && d._arcFree(M)) {
    // THE FALL: the champion rises to bring the tyrant to account — a duel.
    if (M.rivalId == null && champ.rivalId == null) { M.rivalId = champ.id; champ.rivalId = M.id; }
    if (M.rivalId === champ.id && champ.rivalId === M.id) {
      d._enlistDuelist(M); d._enlistDuelist(champ);
      M._duelWith = champ.id; champ._duelWith = M.id;
      d._note(BEAT.LEGEND, champ.id, `${champ.name} has had enough of ${M.name}'s gouging — they rise to bring the tyrant to account, blade in hand.`, arc);
      d._recordSaga({ sagaKind: 'tyrantFall', key: `${M.id}`, tyrant: M.name, champ: champ.name, outcome: 'fall', trade: M._trade || 'goods' });
      return null;
    }
    if ((arc.tries = (arc.tries || 0) + 1) < 5) { arc.nextAt = now + rand(20, 34); return arc; }
    return null;
  }
  // REDEMPTION: faced with the town's fury, the tyrant relents — lowers prices, makes
  // amends. The town softens; a token gift to the most-wronged (a TRANSFER, no mint).
  for (const C of near) { d._warm(C, M, 0.22); if (C.priceBeliefs && M._trade && C.priceBeliefs[M._trade] != null) C.priceBeliefs[M._trade] = +(C.priceBeliefs[M._trade] / (DIRECTOR.tropes.tyrantPriceMul || 1.15)).toFixed(2); }
  const victim = champ || near[0];
  if (victim) { const g = Math.min(10, Math.max(0, Math.floor(M.gold || 0))); if (g > 0) { M.gold -= g; victim.gold += g; } }
  d._note(BEAT.FORTUNE, M.id, `Faced with the town's anger, ${M.name} has relented — lowering their prices and making amends for the gouging.`, arc);
  d._recordSaga({ sagaKind: 'tyrantFall', key: `${M.id}`, tyrant: M.name, outcome: 'redeem', trade: M._trade || 'goods' });
  return null;
}

// THE SPY'S WEB — a slow-burn MYSTERY: a disguised infiltrator → suspicion WHISPERS
// gather around them → the cover is torn away (revelation) → the town hunts the traitor.
export function _stepSpyWeb(d: Dir, arc: Arc, now: number): Arc | null {
  const intr = d.sim.intrigue;
  const spy = d.sim.agentsById.get(arc.spyId);
  if (!spy || !spy.alive || !spy.disguiseFaction) return null;   // gone, or already exposed elsewhere
  if (arc.stage === 1) {
    // SUSPICION: a wary neighbour starts to wonder about the newcomer (a planted doubt,
    // low-confidence so it fades if the spy lies low — but the whisper is out).
    const vis = (SIM && SIM.visionRange) || 22;
    const obs = d.sim.agents.find((a: any) => a.alive && a.autonomous && a.faction === 'townsfolk' && a !== spy && a.pos && spy.pos && a.pos.distanceTo(spy.pos) <= vis);
    if (obs) d._plant(obs, spy.id, { suspicion: 0.5 });
    d._note(BEAT.VENDETTA, spy.id, `Folk have begun to whisper that ${spy.name} is not quite what they seem.`, arc);
    arc.stage = 2; arc.nextAt = now + rand(34, 54); return arc;
  }
  // REVELATION: the cover is torn away — the town sees the traitor at last.
  if (intr && intr._unmask) {
    try { intr._unmask(spy, d.sim._ctx ? d.sim._ctx() : { agents: d.sim.agents, time: d.sim.time }); } catch { /* never throw */ }
  }
  d._recordSaga({ sagaKind: 'spyWeb', key: `${spy.id}`, spy: spy.name });
  return null;
}

// THE WRONGLY ACCUSED — a false rumour brands an innocent; it spreads (escalation),
// then the TRUTH prevails (their name is cleared) — or, if cut down first, comes too
// late (a tragedy narrated in combatEvents). The deepest expression of the belief
// primitive: NPCs act on what they BELIEVE, and a lie can cost an innocent everything.
export function _stepAccused(d: Dir, arc: Arc, now: number): Arc | null {
  const B = d.sim.agentsById.get(arc.b);
  if (!B || !B.alive) return null;     // a death mid-slander is narrated as tragedy in combatEvents
  if (arc.stage === 1) {
    // ESCALATION: the slander hardens and spreads wider through the town.
    const folk = d.sim.agents.filter((a: any) => a.alive && a.autonomous && a.faction === 'townsfolk' && a !== B);
    for (const O of d._shuffle(folk).slice(0, 5)) d._plant(O, B.id, { suspicion: 0.4, dStanding: -0.2 });
    d._note(BEAT.VENDETTA, B.id, `The whispers against ${B.name} have hardened into open suspicion — neighbours cross the street, and old friends keep their distance.`, arc);
    arc.stage = 2; arc.nextAt = now + rand(34, 52); return arc;
  }
  // EXONERATION: the truth prevails — the slander is lifted town-wide, the name cleared.
  for (const a of d.sim.agents) {
    if (!a.alive || !a.autonomous || a.faction !== 'townsfolk' || a === B || !a.beliefs || !a.beliefs.get) continue;
    const bel = a.beliefs.get(B.id);
    if (!bel) continue;
    bel.suspicion = Math.max(0, (bel.suspicion || 0) - 0.5);
    bel.standing = clamp((bel.standing || 0) + 0.35, -1, 1);
    bel.hostile = false;
  }
  B._accusedAt = null;
  d._note(BEAT.FORTUNE, B.id, `The rumour against ${B.name} is exposed for the baseless slander it always was — their name is cleared, though such a wound is slow to heal.`, arc);
  d._recordSaga({ sagaKind: 'accused', key: `${B.id}`, accused: B.name, outcome: 'exonerated' });
  return null;
}

// THE STAR-CROSSED LOVERS — a forbidden courtship across a feud → the obstacle (kin's
// disapproval) → a fork on the lovers' NERVE: bold hearts WED (and the union heals the
// feud, via lineage._wed); timid ones bow to the old hatred and part, heartbroken.
export function _stepRomance(d: Dir, arc: Arc, now: number): Arc | null {
  const A = d.sim.agentsById.get(arc.a), B = d.sim.agentsById.get(arc.b);
  const clear = () => { if (A) A._courtingId = null; if (B) B._courtingId = null; };
  if (!A || !A.alive || !B || !B.alive || A.mateId != null || B.mateId != null) { clear(); return null; }   // gone or wed to another
  if (arc.stage === 1) {
    // OBSTACLE: the feud bears down — kin scowl, the town gossips.
    d._note(BEAT.VENDETTA, A.id, `Tongues wag and kin scowl: a child of House ${arc.hA} and a child of House ${arc.hB}, courting in defiance of the old hatred.`, arc);
    arc.stage = 2; arc.nextAt = now + rand(34, 52); return arc;
  }
  // RESOLUTION: does love defy the feud, or does the feud win?
  const nerve = (((A.personality && A.personality.risk_tolerance) ?? 0.5) + ((B.personality && B.personality.risk_tolerance) ?? 0.5)) / 2;
  if (nerve >= (DIRECTOR.tropes.starCrossedResolve ?? 0.52) && d.sim.lineage && d.sim.lineage._wed) {
    try { d.sim.lineage._wed(A, B); } catch { /* never throw */ }    // a union — and lineage._wed HEALS the feud + narrates it
    d._recordSaga({ sagaKind: 'romance', key: `${A.id}-${B.id}`, a: A.name, b: B.name, hA: arc.hA, hB: arc.hB, outcome: 'union' });
  } else {
    // HEARTBREAK: the old hatred proves the stronger.
    d._sour(A, B, 0.2); d._sour(B, A, 0.2);   // the bitterness of a love forsworn
    d._note(BEAT.VENDETTA, A.id, `The old hatred proved stronger than young love — ${A.name} and ${B.name} have parted, kept asunder by the feud of Houses ${arc.hA} and ${arc.hB}.`, arc);
    d._recordSaga({ sagaKind: 'romance', key: `${A.id}-${B.id}`, a: A.name, b: B.name, hA: arc.hA, hB: arc.hB, outcome: 'heartbreak' });
  }
  clear();
  return null;
}

// catch a freshly-disguised spy the INSTANT it appears (a frequent tick-scan beats the
// intrigue system's own abrupt random unmask), so the exposure gets the slow-burn arc
// treatment — suspicion, then revelation — instead of a bolt from the blue.
export function _seedSpyWebs(d: Dir): void {
  if (!DIRECTOR.tropes.spyWebArc) return;
  const intr = d.sim.intrigue;
  if (!intr || !intr.spies) return;
  for (const s of intr.spies) {
    if (s && s.alive && s.disguiseFaction && !s._spyArc) {
      s._spyArc = true;
      (d._arcs || (d._arcs = [])).push({ kind: 'spyWeb', spyId: s.id, stage: 1, nextAt: d.sim.time + rand(22, 40) });
    }
  }
}
