// Agent decision layer — the utility scorer that settles each tick's goal from
// BELIEFS ONLY (never ground truth: the epistemic split). Extracted from Agent
// as free functions over a passed agent instance. decide scores survival /
// economic / social / plan-step candidates (incl. the flee Schmitt band that
// kills the old flee<->work limit-cycle), tilts them by ambition + group
// cohesion, and commits the winner; decideParty is the companion override.
// Behaviour-preserving: verbatim bodies of the old Agent methods. No cycles —
// imports config, pure helpers, motivation, and the occupation chooser.

import { SIM, WEIGHT, ECON, COMMODITIES, GROUP_TYPES, LEGEND, SOCIAL, COMFORT, NOVELTY, BUILD, ESTEEM as WEALTH, ROMANCE, MOTIVE, ALMS, GRANARY, MIGRATE, QUIRK, DUEL, factionHostile } from '../simconfig.js';
import { rng } from '../rng.js';
import { updateAmbition, ambitionFavor, ambitionWantsFight, deriveGoals, pruneGoals } from '../motivation.js';
import { chooseOccupation, laborValue } from './occupation.js';
import { arbitrate, shadowCheck } from '../motivation/arbitrate.js';
import { qualifyHome, isUnhoused } from '../construction.js';
import { foldGoalDwell } from '../signals.js';
import { STAGE, REASON } from '../trace.js';
import type { Agent, CognitionCtx, Goal, EntityId, Stage, Reason, PlanStep } from '../../../types/sim.js';
import type { Vector3 } from 'three';

// trace.js infers STAGE/REASON members as plain `string`; retype for Trace.note.
const STAGE_T = STAGE as Record<string, Stage>;
const REASON_T = REASON as Record<string, Reason>;
// simconfig.js GROUP_TYPES inferred without an index signature (allowJs).
const GROUP_TYPES_T = GROUP_TYPES as Record<string, { cohesion?: string; combatant?: boolean; pull?: number } | undefined>;

/** A scored utility candidate (decide's deliberation), spread into the chosen goal. */
interface Candidate { kind: string; score: number; [k: string]: unknown }

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

// QUIRKS — a stable behavioural tic, DERIVED at read time (no spawn write). The quirk is a pure
// function of the agent's id + personality, so both the live arbiter (arbitrate) and the reference
// oracle (scoreAndSelect) call quirkOf()/quirkMul() and get FLOAT-IDENTICAL multipliers (the S2
// parity tripwire). Reads ONLY own id + own personality — the epistemic split is untouched (a quirk
// shapes how an agent weighs ITS OWN candidates). Gentle by design (the median-preserving lesson):
// a tic colours a soul, it does not remake it. Cached on _quirk once derived (stable for the agent's
// life — id + personality never change). Non-townsfolk / no-trait agents get 'plain' (a no-op row).
const QUIRK_KINDS = ['haggler', 'loner', 'showoff', 'homebody', 'busybody'] as const;
export function quirkOf(a: Agent): string {
  const cached = (a as Agent & { _quirk?: string })._quirk;
  if (cached != null) return cached;
  let q = 'plain';
  try {
    const P = a.personality || {};
    // Only a townsperson carries a tic (monsters/the player stay plain — the freeze-lesson guard
    // also means professionless combatants are unaffected by the gentle social/economic shaping).
    if (a.faction === 'townsfolk') {
      const risk = P.risk_tolerance ?? 0.5, soc = P.social_drive ?? 0.5;
      const ambn = P.ambition ?? 0.5, cur = P.curiosity ?? 0.5;
      const hi = QUIRK.pickThresh;
      // A DETERMINISTIC tie-break among the traits that cross their bar: hash the id to pick one
      // of the eligible quirks, so the SAME agent always wears the SAME tic (no RNG, no spawn read).
      const eligible: string[] = [];
      if (soc <= QUIRK.lonerThresh) eligible.push('loner');
      if (ambn >= hi) eligible.push('haggler');          // the deal-driven haggle harder
      if (risk >= hi) eligible.push('showoff');          // the bold play to a crowd
      if (cur <= QUIRK.lonerThresh) eligible.push('homebody');   // the incurious stay near the hearth
      if (soc >= hi) eligible.push('busybody');          // the gregarious are everywhere
      if (eligible.length > 0) {
        // stable hash of the id string → an index into the eligible set (id is fixed for life).
        const s = String(a.id);
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        q = eligible[(((h % eligible.length) + eligible.length) % eligible.length)];
      }
    }
  } catch { q = 'plain'; }
  (a as Agent & { _quirk?: string })._quirk = q;
  return q;
}
// the gentle per-(quirk, candidate-kind) multiplier (1 when the quirk doesn't touch that kind).
export function quirkMul(quirk: string, kind: string): number {
  const row = (QUIRK.mul as Record<string, Record<string, number>>)[quirk];
  return (row && row[kind]) ?? 1;
}
void QUIRK_KINDS;   // documents the closed quirk set (the showoff act-linger reads 'showoff' too)

// WEALTH RECOGNITION CHANNEL (docs/architecture/12 §6) — belief-only esteem: an agent that BELIEVES
// a non-suspect local is prosperous nudges its OWN standing toward them. Personality-gated WITH the
// envious mirror (review 6): the deferential/social WARM toward believed wealth (they court patronage);
// the proud-and-self-serving COOL (resentment of the parvenu). Reads ONLY the agent's own beliefs
// (believedWealth·wealthConf) and writes only its own standing — inside the epistemic split. Bounded
// by the belief table; guarded; never throws on the tick.
export function recognizeWealth(a: Agent): void {
  try {
    const store = (a.beliefs as unknown as { map?: Map<EntityId, { believedWealth?: number; wealthConf?: number; suspicion?: number; standing: number }> });
    if (!store || !store.map) return;
    const P = (a.personality || {}) as { altruism?: number; ambition?: number; social_drive?: number };
    const altru = P.altruism ?? 0.5, ambn = P.ambition ?? 0.5, soc = P.social_drive ?? 0.5;
    const envious = ambn > 0.55 && altru < 0.45;        // proud + self-serving → resents the rich
    for (const b of store.map.values()) {
      if (!b) continue;
      const mass = (b.believedWealth || 0) * (b.wealthConf || 0);
      if (mass < WEALTH.recognizeMin) continue;
      if ((b.suspicion || 0) > WEALTH.suspectGate) continue;   // a believed-suspect earns no deference
      if (envious) b.standing = Math.max(-1, b.standing - WEALTH.envyCool * mass);
      else if (altru > 0.4 || soc > 0.5) b.standing = Math.min(1, b.standing + WEALTH.deferWarm * mass);
    }
  } catch { /* never throw on the tick */ }
}

// EMERGENT DUEL ELECTION (own-belief only) — the honour-duel the agent picks for ITSELF, vs the
// Director's storyteller-chosen one. An unencumbered, not-timid townsperson that holds a CONFIDENT,
// LATCHED-HOSTILE, DEEPLY-SOURED belief about a nearby rival may (rarely) issue a challenge: set its
// OWN _duelWith + enlist itself (the same combatant/canWork flip + _duelStart the Director's
// _enlistDuelist applies, inlined so we don't reach into the director module). The READ is the
// agent's own belief (hostile/standing/lastPos/confidence) — the epistemic split holds; truth (combat)
// resolves the fight; the Director's _superviseDuels/_resolveDuel CLOSES the feud (unlatch + wary
// respect). Two rivals who each latched the other both elect → a real MUTUAL duel. One duel at a time
// per agent; throttled; never starts while otherwise committed. Guarded; never throws on the tick.
export function maybeElectDuel(a: Agent, ctx: CognitionCtx): void {
  try {
    if (!DUEL.enabled || !a.autonomous || a._duelWith != null) return;
    if (a.faction !== 'townsfolk') return;                       // monsters/raiders don't duel for honour
    // unencumbered: not already pulled into another role/commitment (mirror _tropeDuel's `free`).
    // A soul raising its own home (a committed build site) is encumbered too — it has a roof to
    // finish before it takes up a grudge with steel (and this keeps a duel from derailing the
    // time-critical build commitment — the same care the scorer's build-guard takes).
    if (a.inParty || a.reporter || a.bounty || a.spy || a.expedition || a.caravanRun ||
        a.arbitrage || a._held || a.guardianOf != null || a.bodyguardOf != null ||
        a.avengerOf != null || a.nemesis || a.warlord || a._buildSiteId != null) return;
    const P = a.personality || {};
    if ((P.risk_tolerance ?? 0.5) < DUEL.riskMin) return;        // only the not-timid challenge
    // throttle: at most one election attempt per cooldown window (own-state stamp).
    const now = ctx.time || 0;
    if (a._duelChallengedAt != null && now - a._duelChallengedAt < (DUEL.challengeEvery || 10)) return;
    a._duelChallengedAt = now;
    if (rng() >= DUEL.chance) return;                            // rare — a tic, not a brawl pit
    // find my bitterest believed rival in reach: latched-hostile, standing at/below the deep-feud bar,
    // confidently known, and near where I BELIEVE it is. Belief-only — no roster read.
    let rivalId: EntityId | null = null, worst = DUEL.standingAt + 1e-9;
    for (const b of a.beliefs.all()) {
      if (b.subjectId === a.id || b.placeKind) continue;
      if (!b.hostile || !b.lastPos) continue;                    // must be a LATCHED-hostile rival
      if ((b.confidence || 0) < DUEL.confMin) continue;          // confidently known
      if ((b.standing ?? 0) > DUEL.standingAt) continue;         // deeply soured (a feud, not a spat)
      if (a.pos.distanceTo(b.lastPos) > DUEL.range) continue;    // within challenge reach
      if ((b.standing ?? 0) < worst) { worst = b.standing ?? 0; rivalId = b.subjectId; }
    }
    if (rivalId == null) return;
    // ELECT: enlist MYSELF for the duel (the Director's _enlistDuelist effect, inlined — own-state
    // only). The existing _duelWith→fight branch picks it up this very tick; _superviseDuels resolves.
    a._duelRestore = { combatant: a.combatant, canWork: a.canWork };
    a._duelStart = now;
    a.combatant = true; a.canWork = false;
    a._duelWith = rivalId;
  } catch { /* never throw on the tick */ }
}

export function decide(a: Agent, ctx: CognitionCtx): void {
  a._rpgNow = ctx.time;   // stamp sim time for this tick's emitted deeds
  if (!a.alive || a.controlled) return;
  // CAPTIVE (the rescue arc): a held captive makes no decisions — it idles where it's held until a
  // rescuer frees it. We still let its beliefs perceive/decay (that runs before decide) so it can
  // be SEEN as a captive and, once freed, perceive `_freedBy` and warm. Clear any stale goal.
  if (a._held) { a.goal = null; return; }
  // REASONING-COST (Phase 3, measurement only): this tick ran decide(). Own-scalar write,
  // read truth-side in depthMetrics — never inside cognition. A tick decide() is SKIPPED
  // (amortized by LOD) leaves the scheduler-zeroed 0, which is the measured win.
  a._decideCalls = 1;
  // GOAL-DWELL telemetry (the behaviorCollapse measure): charge time-in-goal off the goal committed
  // by the PREVIOUS decide tick — read here at the top, so EVERY commit path (the scorer below AND the
  // early-return role branches: reporter/duel/avenger/spy/bounty/arbitrage/expedition/caravan/party)
  // is measured uniformly with one call. foldGoalDwell only charges on a kind CHANGE, so this folds the
  // whole living roster's dwell, not the thin trace-ring subset goalBudgetOf sampled. Pure observer/
  // telemetry: an own-scalar write, NEVER read back to drive a decision (the epistemic split holds).
  if (a.goal && a.goal.kind) foldGoalDwell(a, a.goal.kind, ctx.time);
  recognizeWealth(a);   // belief-only esteem: defer to (or envy) the believed-rich (§12 §6)

  // SCHEMA GOAL DWELL-LOCK (anti-thrash): a high-priority schema response (flee/fight set
  // directly by reason()) stamps a short min-dwell lock so a one-tick belief flicker (the
  // triggering belief decays for a tick, then gossip re-raises it) doesn't let decide
  // immediately override it back to comfort/work — eliminating the flee<->comfort thrash.
  // Honour the lock only while it holds AND the locked goal is still set. Reads a.* +
  // ctx.time only (scan-clean). Empty in Step 1 (no schema sets a lock until the catalogue
  // lands), so this is dead code with the empty catalogue — byte-stable.
  if (a._schemaGoalLock && ctx.time < a._schemaGoalLock.until &&
      a.goal && a.goal.kind === a._schemaGoalLock.kind) {
    // STILL maintain the goal stack while the lock holds: derive new goals from memory and
    // PRUNE satisfied/expired ones (so e.g. an avenge goal still POPS the tick its quarry dies,
    // even if a schema momentarily locked the active goal to a disposition). The lock only
    // suppresses re-SCORING/overriding the committed goal, never the bookkeeping. Guarded.
    try { deriveGoals(a, ctx); pruneGoals(a, ctx); } catch { /* never throw on the tick */ }
    return;
  }

  // THE REPORTER: a gazetteer doesn't work, fight, or plan — it pursues the story.
  // The Reporter subsystem sets a.reporterTarget; act.js walks the body there. This
  // override wins over every other role so the press always keeps to its beat.
  if (a.reporter) { a.goal = { kind: 'reporter' }; return; }

  // EMERGENT DUEL ELECTION (own-belief): an unencumbered agent that BELIEVES a nearby rival is
  // latched-hostile AND deeply soured may ELECT a 1v1 duel — setting its OWN _duelWith and enlisting
  // itself (combatant/canWork flip + _duelStart) exactly as the Director's _enlistDuelist does. The
  // read is BELIEF-ONLY (the epistemic split); the existing _duelWith→fight branch below drives the
  // body; the Director's _superviseDuels/_resolveDuel CLOSES the feud (unlatch + wary respect) on a
  // low-HP yield or timeout, and combatEvents handles a death. Two rivals who both latched each other
  // each elect (the feud is symmetric) → a genuine MUTUAL duel. Runs BEFORE the scorer, so it never
  // perturbs the S2 arbitrate≡oracle parity. Set on own-state only — no roster handle is touched.
  maybeElectDuel(a, ctx);

  // DUEL OF HONOUR: a 1v1 LOCK — a duelist seeks and fights only its opponent, with no
  // flee and no economic distraction (we return before those candidates are scored).
  // The opponent's liveness is answered by the resolver (no roster handle in cognition);
  // combatStep navigates off the belief (lastPos / inferred destination) and re-acquires.
  if (a._duelWith != null && a.autonomous) {
    if (ctx.resolver && ctx.resolver.isLiveAgent(a._duelWith)) { a.goal = { kind: 'fight', targetId: a._duelWith }; return; }
  }

  // THE AVENGER: an NPC whose kin the PLAYER murdered — a relentless personal nemesis.
  // Where a fleeting grudge decays, the avenger HUNTS the player at any range with no
  // flee and no economic distraction, until one of them falls. The Director keeps the
  // grudge hot (so it never cools) and narrates the vendetta + files it as a saga.
  if (a.avengerOf != null && a.autonomous) {
    if (ctx.resolver && ctx.resolver.isLiveAgent(a.avengerOf)) { a.goal = { kind: 'fight', targetId: a.avengerOf }; return; }
  }

  // THE BUTCHER'S SHADOW: the street empties before a known killer. A FEARFUL townsperson
  // (low nerve) gives a notoriously violent player a wide berth — a visible bubble of
  // unease around an infamous reputation. Bounded (only the timid, only up close, only
  // a true villain) so it unsettles the town without emptying it. The bold are unmoved.
  if (LEGEND && LEGEND.enabled && a.autonomous && a.faction === 'townsfolk' &&
      a.guardianOf == null && !a.inParty && !a.combatant && a.personality &&
      a.personality.risk_tolerance < (LEGEND.fearRisk || 0.42)) {
    // BELIEF-GATED FEAR: read my OWN belief about the player (a scalar id, never a live
    // handle). I only dread a villain I've actually SEEN (a confident belief carrying its
    // notoriety, written by perception) and that I believe is right beside me. An NPC who
    // never laid eyes on the player feels nothing.
    const pb = ctx.playerId != null ? a.beliefs.get(ctx.playerId) : null;
    if (pb && pb.confidence >= SIM.actOnBeliefMin && (pb.notoriety || 0) >= (LEGEND.villainAt || 0.66) &&
        a.pos.distanceTo(pb.lastPos) < (LEGEND.fearRange || 9)) { a.goal = { kind: 'flee', fromId: ctx.playerId! }; return; }
  }

  // BOUNTY-HUNTER: a townsperson who answered a Gazette bounty hunts its quarry —
  // the named foe (a vendetta) or the nearest of the bounty's faction. Fights when
  // close; else marches toward the threat zone the notice named.
  if (a.bounty && a.autonomous) {
    const b = a.bounty;
    // NAMED quarry: navigate off my BELIEF of it (lastPos / inferred destination). If I
    // hold a confident belief I close to fight (combatStep re-acquires by sight); else I
    // march toward where I last believed it / the notice's threat zone.
    if (b.killerId != null) {
      const bel = a.beliefs.get(b.killerId);
      if (bel && bel.confidence >= SIM.actOnBeliefMin && a.pos.distanceTo(bel.lastPos) <= SIM.visionRange) {
        a.goal = { kind: 'fight', targetId: b.killerId };
      } else {
        const toward = bel ? { x: bel.lastPos.x, z: bel.lastPos.z } : b.toward;
        a.goal = { kind: 'bounty', toward };
      }
      return;
    }
    // FACTION bounty: the execution layer scans for the nearest VISIBLE foe of the bounty's
    // faction (vision-gated; returns a belief-style snapshot, never the live object). With
    // one in sight I fight it; else I march toward the notice's named threat zone.
    const ref = (ctx.resolver && b.faction) ? ctx.resolver.nearestVisibleOfFaction(a, b.faction) : null;
    if (ref) a.goal = { kind: 'fight', targetId: ref.id };
    else a.goal = { kind: 'bounty', toward: b.toward };
    return;
  }

  // ARBITRAGE HAULER: a trader carrying surplus to a town where the Gazette says it's
  // dear. It FLEES an imminent threat on the road (a lone hauler is vulnerable), else
  // presses on toward the dear market to sell.
  if (a.arbitrage && a.autonomous) {
    const foe = a._nearestHostile(ctx);
    if (!a.combatant && foe && a.pos.distanceTo(foe.pos) <= (ECON.caravanFleeRange != null ? ECON.caravanFleeRange : 6)) a.goal = { kind: 'flee', fromId: foe.id };
    else a.goal = { kind: 'arbitrage' };
    return;
  }

  // advance this agent's longer-term ambition (progress / completion / revenge)
  updateAmbition(a, ctx);

  // goal stack: derive new intentions from memory, drain satisfied/expired
  // ones, then ensure the TOP goal holds a valid cached plan over beliefs.
  // (deriveGoals is a Phase-3 stub; pruneGoals + planning are live.)
  deriveGoals(a, ctx);
  pruneGoals(a, ctx);
  const planStep = a._currentPlanStep(ctx);

  // Companions don't run the economic/needs scheduler: they fight whatever's
  // believed-hostile near them or the leader, otherwise they follow the leader.
  if (a.inParty) { a._decideParty(ctx); return; }

  // SPY (intrigue): an infiltrator under cover doesn't openly hunt — it SCOUTS
  // toward the town core to whisper a planted rumour, then EXFILTRATES to its
  // camp. The Intrigue subsystem does the actual planting (and flips phase);
  // decide just routes the body to a `spy` goal. Cover holds UNLESS a believed-
  // hostile is right on top of it (then it drops cover and fights — combat is
  // truthful regardless). Guarded: only fires for an agent that holds a spy state.
  if (a.spy && a.autonomous) {
    // an infiltrator keeps its COVER: it BLENDS IN among the faction it's
    // disguised as (it walks the town peacefully, never striking the very people
    // it's framing — that would blow the disguise and get it mobbed in the dense
    // core). It only drops cover when a NON-cover hostile (e.g. a frontier
    // monster) is right on top of it; otherwise it keeps MOVING to scout/exfil.
    // Combat, when it happens, is truthful (true faction), preserving the split.
    let foeId = null, fd = Infinity;
    for (const b of a.beliefs.all()) {
      if (b.confidence < SIM.actOnBeliefMin || !a.considerHostile(b)) continue;
      if (b.lastFaction === a.disguiseFaction) continue;   // don't fight my cover
      // BELIEF-ONLY: judge "cornered" off where I BELIEVE the threat is (lastPos), never a
      // live read. combat (truthful) still resolves who is actually struck if I do fight.
      const d = a.pos.distanceTo(b.lastPos);
      if (d < fd) { fd = d; foeId = b.subjectId; }
    }
    if (foeId != null && fd <= SIM.arriveDist + 1.6) {
      a.goal = { kind: 'fight', targetId: foeId };   // cornered by a real threat
    } else {
      a.goal = { kind: 'spy', phase: a.spy.phase };   // scout / exfil (act.js moves)
    }
    return;
  }

  // ADVENTURING EXPEDITION — a captain leading a company out to hunt the wilds
  // (driven by the Expeditions subsystem). Cut down a foe in our path, else march
  // toward the objective. Followers band-FOLLOW the captain via the warband path.
  if (a.expedition) {
    const foe = a._nearestHostile(ctx);
    if (foe && a.pos.distanceTo(foe.pos) <= SIM.visionRange) a.goal = { kind: 'fight', targetId: foe.id };
    else a.goal = { kind: 'expedition' };
    return;
  }

  // CARAVAN: a dispatched trader walks the long trade road (out to a distant point,
  // then home). It FLEES an imminent threat (a chance to reach the watch/town), else
  // presses on with its load — and the bandits on the road try to run it down.
  if (a.caravanRun && a.autonomous) {
    const foe = a._nearestHostile(ctx);
    // a laden caravan PRESSES ON through the danger and only scatters once a raider
    // is nearly on top of it (a much tighter range than the usual dangerRange) — so
    // the ambush actually springs from near point-blank and lands blows, instead of
    // the caravan bolting from 12m out and trivially outrunning the chase.
    const flee = (ECON.caravanFleeRange != null) ? ECON.caravanFleeRange : 6;
    if (!a.combatant && foe && a.pos.distanceTo(foe.pos) <= flee) a.goal = { kind: 'flee', fromId: foe.id };
    else a.goal = { kind: 'caravan' };
    return;
  }

  // SELECTION (docs/architecture/17 P1): the utility scorer is now its own function (`scoreAndSelect`)
  // so it can be re-hosted as motivation rows (arbitrate) behind a shadow check. The role-guard
  // early-returns + side-effecting passes above stay here (the pre-phase, §5). decide() owns the
  // COMMIT (a.goal + the occupation tail); scoreAndSelect is the pure selection.
  // SELECTION (docs/architecture/17 P1, SWAPPED): the row-based arbiter is now authoritative. The
  // former inline scorer survives as `scoreAndSelect` (a pure REFERENCE ORACLE) and the shadow check
  // re-verifies arbitrate ≡ oracle tick-for-tick (a permanent regression net, flipped on by the soak
  // shadow test). a.goal still holds the prev goal here — the hysteresis input both read.
  const winner: Goal = arbitrate(a, ctx, planStep);
  shadowCheck(a, ctx, planStep, winner.kind);
  a.goal = winner;
  // REASONING-COST hysteresis (Phase 3): stamp the time the committed goal.kind last CHANGED, so the
  // LOD relevance gate can keep a just-re-deliberated agent at full fidelity for a short window.
  if (winner.kind !== a._prevGoalKind) { a._lastGoalChangeAt = ctx.time; a._prevGoalKind = winner.kind; }
  // emergent occupation: when we settle on WORK, decide WHAT to make this stint (belief-priced,
  // proximity- and ambition-weighted, opportunity-gated). Stored on a._trade; belief-only; guarded.
  if (winner.kind === 'work') chooseOccupation(a, ctx);
}

// SCORE & SELECT (docs/architecture/17 P1) — decide()'s utility scorer, extracted VERBATIM so it can be
// re-hosted as motivation rows (arbitrate) behind a shadow check. Pure selection: reads beliefs/own-
// state (+ the `planStep` decide already computed — never re-running the side-effecting passes), writes
// only own telemetry (_decideCands + the trace), returns the winning goal. The body is unchanged from
// the former inline scorer, so this is behaviour-preserving (the existing soak/limit-cycle gates prove it).
// Kept post-swap as a PURE REFERENCE ORACLE (no telemetry/commit side-effects) — arbitrate is the live
// scorer; the shadow check re-runs this and asserts they pick the same kind (the permanent equivalence
// net, §17 P1). Telemetry (_decideCands + the BEHAVIOUR_WON trace) lives in arbitrate now.
export function scoreAndSelect(a: Agent, ctx: CognitionCtx, planStep: PlanStep | null): Goal {
  const P = a.personality;
  const inv = a.inventory;

  const cand: Candidate[] = [];
  // REASONING-COST (Phase 3): count utility candidates actually scored this tick (only the
  // ones that survive the score>0 gate, off the hot string path). Committed to a._decideCands
  // just before the goal commit below. The early-return role branches (reporter/duel/avenger/
  // spy/bounty/arbitrage/expedition/caravan/party) return before this, keeping the
  // scheduler-zeroed 0 — correct (they ran O(beliefs) work, captured by _schemaFireCount,
  // but no utility scoring).
  let _nCand = 0;
  const push = (kind: string, score: number, extra?: Record<string, unknown>): void => {
    if (score > 0) { _nCand++; cand.push({ kind, score, ...extra }); }
  };

  // survival first: act on a BELIEVED-hostile nearby (beliefs, not truth). A
  // Schmitt band kills the old flee<->work pacing limit-cycle: a threat is in
  // "danger" range within dangerRange, but once an agent is already committed
  // to flee/fight it stays committed until the threat is beyond the larger
  // safeRange — so it doesn't trot back to its work site next to a foe and
  // immediately re-flee. Fleeing is only triggered when actually in danger;
  // a distant remembered threat doesn't send anyone running.
  const enemy = a._nearestHostile(ctx);
  let inDanger = false;
  if (enemy) {
    const dist = a.pos.distanceTo(enemy.pos);
    const committed = a.goal?.kind === 'flee' || a.goal?.kind === 'fight';
    inDanger = dist <= SIM.dangerRange || (committed && dist <= SIM.safeRange);
    // renown-seekers and the vengeful stand and fight even if they're civilians;
    // hunters/monsters pursue at any range (fight isn't danger-gated).
    const brave = a.combatant || ambitionWantsFight(a);
    // a TERRITORIAL predator (monster lair / camp member) won't engage a foe beyond
    // its leash from home — so it harries townsfolk who venture to the frontier but
    // never chases one into the village to raze it (the structural anti-massacre
    // rule; director RAIDERS have no homeAnchor, so they still assault the town).
    const tethered = a.homeAnchor && a.homeAnchor.distanceTo(enemy.pos) > (a.leashR || 50);
    if (brave && !tethered)
      push('fight', WEIGHT.fight * (0.4 + P.risk_tolerance) + a.mood.anger, { targetId: enemy.id });
    if (!a.combatant && inDanger)
      push('flee', WEIGHT.flee * (1.2 - P.risk_tolerance) + a.mood.fear + 0.5, { fromId: enemy.id });
  }

  // economic / life scheduling (every townsperson — occupation is emergent now).
  // SUPPRESSED while in danger: nobody works/rests/socialises beside a threat.
  if (a.canWork && !inDanger) {
    // SURVIVAL BEFORE COMMERCE: an agent that's genuinely hungry and is carrying food
    // EATS — it doesn't haul goods to market on an empty stomach. Without this, the
    // logistics `market` urge out-scored `eat` and the whole town stockpiled food yet
    // starved (hunger ~0), which also suppressed births (lineage needs fed parents).
    const hungry = inv.food > 0.05 && a.needs.hunger < (ECON.eatUrgent || 0.4);
    if (inv.food > 0.05)
      push('eat', hungry ? WEIGHT.eat * 1.8 : Math.pow(1 - a.needs.hunger, 1.5) * WEIGHT.eat);
    if (!hungry) {
      const goldNeed = clamp01(1 - a.gold / 30);
      // overstock of WHATEVER it's currently making damps the urge to keep at it
      const made = a._trade ? (inv[a._trade] || 0) : 0;
      const overstock = clamp01(made / ECON.maxStack);
      // EFFECTIVE VALUE OF LABOUR, weighed against THIS agent's OWN values. When the
      // best trade's net margin is thin (a glutted market), the WEALTH motive to work
      // shrinks toward nothing — so a leisure-valuing soul tips to rest/socialise/wander
      // instead of toiling for free. But the AMBITIOUS keep at it via an ambition-scaled
      // intrinsic floor, so the dropout is personality-graded, not a town-wide cutoff.
      // In a HEALTHY economy lv≈1 and this reduces to the old (0.5+0.5·goldNeed) term —
      // behaviour only changes once labour stops paying. Belief-only; never throws.
      const lv = laborValue(a);                                  // 0..1 effective value of labour
      const wealthMotive = (0.5 + 0.5 * goldNeed) * lv;          // pay-driven, scaled by real value
      const motive = Math.max(ECON.workIntrinsicFloor * P.ambition, wealthMotive);
      // MOOD COLOURS IDLE LIFE (own-state, slow-decaying): GRIEF makes work listless and pulls
      // the bereaved away from company (withdrawal); PRIDE/JOY make a soul seek an audience and
      // spend its good cheer socialising; chronic LONELINESS pulls toward others. So the same
      // agent visibly lives a good week differently from a bad one. Bounded, never negative.
      const md = a.mood;
      const listless = 1 - 0.4 * (md.grief || 0);
      const socialMood = Math.max(0.2, 1 + 0.6 * (md.pride || 0) + 0.5 * (md.joy || 0) + 0.7 * (md.loneliness || 0) - 0.6 * (md.grief || 0));
      push('work', WEIGHT.work * (0.4 + P.ambition) * motive * (1 - 0.7 * overstock) * listless);
      push('rest', Math.pow(1 - a.needs.energy, 1.5) * WEIGHT.rest);
      // SOCIALISE = seek out a believed-friend (belief-only target). A known friend
      // is a stronger pull than a generic market trip — heading to a face you like is
      // what makes the town feel social rather than a crowd of strangers at a stall.
      const friend = pickSocialTarget(a);
      const friendPull = friend != null ? 1.25 : 1;
      push('socialize', (1 - a.needs.social) * (0.5 + P.social_drive) * WEIGHT.socialize * friendPull * socialMood,
        friend != null ? { withId: friend } : undefined);

      // COURT (docs/architecture/12 §8) — the Star-Crossed ENACTMENT: an agent with a chosen
      // sweetheart (`_courtingId`, set by the romance trope / the authoring API) that it BELIEVES is
      // reachable seeks it out and lingers (fillCourt + the on-arrival warm in act). Own-state
      // (_courtingId) + own-belief (the partner's lastPos) — no roster read; the bolder court more
      // readily (the same nerve _stepRomance reads). A strong pull, but scored below survival.
      if (a._courtingId != null) {
        const lb = a.beliefs.get(a._courtingId);
        if (lb && lb.confidence >= SIM.actOnBeliefMin) {
          push('court', (0.5 + (P.risk_tolerance || 0)) * ROMANCE.weight, { subjectId: a._courtingId });
        }
      }

      // SIGHTSEE — driven by the NOVELTY need (a distinct drive in the decomposed need-
      // space). Boredom builds until a curious soul takes in a fresh sight; because it's
      // a real, growing deficit it fires PERIODICALLY (not never), giving leisure genuine
      // variety. Scaled by the deficit × curiosity, amplified by the leisure valve when
      // labour is cheap. It doesn't out-pull URGENT comfort/hunger (a desperate soul isn't
      // bored) — it claims ordinary idle time, which the comfort de-monopolisation now frees.
      if (NOVELTY.enabled && a.needs.novelty < NOVELTY.seekBelow)
        push('sightsee', (1 - a.needs.novelty) * WEIGHT.sightsee * (0.4 + P.curiosity) * (0.7 + 0.5 * (1 - lv)));


      // MARKET TRIP (logistics): trade only clears AT a market now, so a producer must
      // HAUL its load in to SELL — or come to BUY a pressing need (food/a tool). The
      // overstock that damps `work` is exactly the signal to take the load to market.
      let sellLoad = 0;
      for (const c of COMMODITIES) sellLoad += a.sellQty(c);
      const outOfFood = (inv.food || 0) < 1;
      const outOfTool = (inv.tool || 0) < 1 && a.gold >= 2;
      if (sellLoad >= ECON.haulLoad || outOfFood || outOfTool) {
        const urgency = Math.min(2, sellLoad / (ECON.haulLoad || 5)) + (outOfFood ? 0.8 : 0) + (outOfTool ? 0.5 : 0);
        push('market', WEIGHT.market * (0.6 + urgency));
      }

      // COMFORT: seek home/tavern when comfort dips. An unhoused agent is capped
      // low, so this is a recurring pull until it builds (or visits a tavern).
      // Belief-free: reads only my own need + that a comfort source exists in the
      // world (nearestComfortSource is an execution helper, ground truth — fine).
      // HYSTERESIS: start seeking comfort below `seekBelow`, but once committed keep
      // at it until `satisfiedAt` — and while actually AT the source, multiply the
      // pull by `dwellBoost` so a market/social urge can't yank me away half-restored
      // (without this the need limit-cycles around the unhoused/seek cap).
      const seeking = a.goal && a.goal.kind === 'comfort';
      const comfortCeil = seeking ? COMFORT.satisfiedAt : COMFORT.seekBelow;
      if (COMFORT.enabled && a.needs.comfort < comfortCeil) {
        // base comfort pull from the deficit (urgent when critically low) — shared by
        // BOTH the home/tavern seek and the sightsee alternative, so they truly compete.
        let cBase = (1 - a.needs.comfort) * WEIGHT.comfort;
        // A MOVER ENDURES THE ROAD (MIGRATE): a live journey intent damps the routine comfort
        // pull — the journey-tracker probe watched the old town's tavern yank a migrant home
        // over and over until the clock lapsed. The emergency boost below still punches through.
        if (a._migrating) cBase *= (MIGRATE.roadHardship || 0.55);
        // A STARVING BODY DOESN'T CARE ABOUT A SOFT BED: critical hunger damps the comfort pull
        // hard, so the survival plan (forage/buy, the sate goal) can claim the body — the
        // residual-death probe found agents comfort-dwelling at home, a field 30m away, with a
        // live sate goal the comfort emergency kept out-scoring.
        if (a.needs.hunger < (ECON.nibbleBelow || 0.25)) cBase *= 0.3;
        // COMFORT EMERGENCY: when comfort runs critically low it becomes urgent like
        // hunger — a near-survival pull that out-ranks a routine market/plan haul, so
        // the agent actually goes home instead of grinding the market into the ground.
        if (a.needs.comfort < (COMFORT.urgentBelow || 0)) cBase *= (COMFORT.urgentBoost || 1);
        const src = nearestComfortSource(a, ctx);
        if (src) {
          // strong, linear pull: a low-comfort agent commits to heading home rather
          // than being out-pulled by a market/plan urge (WEIGHT.comfort carries it).
          let cs = cBase;
          if (seeking) {
            // already on my way home: stick with it (don't get yanked off mid-walk),
            // and once AT the source dwell hard until topped up (the limit-cycle fix).
            cs *= (a.pos.distanceTo(src.pos) <= (SIM.arriveDist || 1.5) + 1)
              ? (COMFORT.dwellBoost || 1) : (COMFORT.seekBoost || 1);
          }
          push('comfort', cs, { toPos: { x: src.pos.x, z: src.pos.z }, srcKind: src.kind });
        }
      }

      // BUILD A HOME: a chronically-uncomfortable, wealthy, unhoused townsperson
      // commissions a private home. The ROI gate (qualifyHome — reads ONLY this
      // agent's own state, so the epistemic split holds) is the demand test; the
      // candidate is pulled in only when it passes, so WEIGHT.build needn't be high.
      if (BUILD.enabled && qualifyHome(a, ctx)) {
        // Past the strict ROI gate the agent genuinely NEEDS a home — make it a
        // decisive pull with a HIGH FLOOR (ambition only sweetens it). Without the
        // floor a low-ambition qualifier was out-pulled by a routine market trip and
        // never committed, so the build only happened for ambitious agents (flaky).
        push('build', WEIGHT.build * (1.4 + 0.4 * P.ambition));
      } else if (BUILD.enabled && a._buildSiteId != null && isUnhoused(a)) {
        // already committed to a site AND still believe I need a home → keep building it (an
        // even stronger, sticky pull so the project finishes instead of being abandoned for a
        // market trip). Phase 2a: gated on isUnhoused too — debt #1's retirement opened a
        // one-tick gap where a just-finished owner (not yet having PERCEIVED its home) could
        // commission a SECOND site; once it discovers its home (housed) it must drop that
        // stale commitment rather than keep raising a home it no longer needs. The site
        // itself is abandoned by BuildSites.tick's no-progress timer (truth-side cleanup).
        push('build', WEIGHT.build * 1.8);
      }
    }
  }
  // SURVIVAL PROVISIONING for the professionless: the whole scheduler above is canWork-gated
  // (production should be), but EATING never should have been — a watch guard or warband fighter
  // (canWork=false, profession null) still has a stomach and a purse. It EATS what it carries,
  // and when its pack runs empty it goes to MARKET to BUY food with whatever coin its wages/
  // bounties/loot brought in (runMarket serves any townsperson at the stalls; wantQty('food')
  // already wants the shortfall). A coinless, foodless soul has no candidate here — it must earn
  // or beg or it starves (hunger is lethal now: drainNeeds). Townsfolk only — monsters keep no
  // economy (the freeze lesson). Reads only own state; never throws.
  if (!a.canWork && !inDanger && a.faction === 'townsfolk' && a.autonomous) {
    const hungry = inv.food > 0.05 && a.needs.hunger < (ECON.eatUrgent || 0.4);
    if (inv.food > 0.05)
      push('eat', hungry ? WEIGHT.eat * 1.8 : Math.pow(1 - a.needs.hunger, 1.5) * WEIGHT.eat);
    // urgency rides the ACTUAL hunger deficit: a fed-but-foodless soul scores ~0.4 (loses to a
    // live plan/ambition — provisioning can wait), a starving one ~1.6 (out-ranks everything
    // routine). A flat out-of-food bonus here once beat WEIGHT.plan and yanked agents off
    // mid-plan to go shopping while fed.
    if ((inv.food || 0) < 1 && a.gold >= 1)
      push('market', WEIGHT.market * (0.4 + 1.2 * (1 - a.needs.hunger)));
  }
  // BEGGING (alms): a DESTITUTE hungry townsperson — no food to eat, no coin to buy — has one
  // candidate left short of crime: beg at the market, where the crowd (and charity) is. The act
  // is VISIBLE (the beg arm solicits via the resolver; bystanders perceive a plea and decide for
  // THEMSELVES off altruism/kin — features/alms.js), so whether the town feeds its poor emerges
  // from who its people are. Hunger-gated: nobody begs on a comfortable stomach. Any faction's
  // townsperson; canWork doesn't matter — a broke labourer begs as surely as a broke guard.
  if (!inDanger && a.townsperson && a.faction === 'townsfolk' && a.autonomous &&
      (inv.food || 0) < 0.05 && (a.gold || 0) < 1 && a.needs.hunger < (ECON.eatUrgent || 0.45)) {
    push('beg', ALMS.begWeight * (0.5 + (1 - a.needs.hunger)));
    // THE PUBLIC LARDER (granary): the same destitution, but the CIVIC answer first — if I know
    // my town raised a granary (the static-map `larder` Place the finished building registers,
    // discovered geography exactly like the tavern's hearth), go draw a meal there. Ranked a
    // hair above beg so the larder wins the tie; begging is for when it is bare too — the act
    // arm stamps my OWN bare-larder memory (_granaryEmptyUntil) on a failed draw, and the trip
    // is suppressed while that memory holds. Own state + static map only (epistemic split holds).
    if (a._granaryEmptyUntil == null || ctx.time >= a._granaryEmptyUntil) {
      const lp = ctx.map && ctx.map.nearest(['larder'], a.pos, a.townId);
      if (lp) {
        let gw = ALMS.begWeight * (0.5 + (1 - a.needs.hunger)) + (GRANARY.drawBump || 0.05);
        // EMERGENCY ROOM: a STARVING destitute (hunger inside the survival-nibble band) takes
        // the larder OVER a live forage plan — at beg-tier weight the WEIGHT.plan candidate
        // always won, and the probe watched dying paupers march past a stocked larder toward
        // a cross-map field (21 destitute starved ~83m from town, 1 meal served). Pitched
        // over plan, under the danger tier; a bare larder still falls back via _granaryEmptyUntil.
        if (a.needs.hunger < (ECON.nibbleBelow || 0.25)) gw = Math.max(gw, GRANARY.urgentWeight || 1.6);
        push('granary', gw, { toPos: { x: lp.pos.x, z: lp.pos.z } });
      }
    }
  }
  // SOFT AVOIDANCE — "cross the street" (docs/architecture/13 §3 snubsFelt). A merely-SUSPECTED,
  // soured-but-NOT-hostile neighbour I believe is close earns a FAINT, low-priority berth (a mild
  // steer-away short of fleeing). Suppressed in danger (real flee/fight wins) and scored low so it
  // never out-pulls work/market/survival — a wisp of social discomfort, not panic. Belief-only
  // (suspicion/standing/hostile/lastPos — my OWN belief), so the epistemic split holds. The `avoid`
  // goal carries `around` = where I BELIEVE the suspect is; fillAvoid pushes me off it as a repulsor.
  let avoiding = false;
  if (!inDanger) {
    const avoidPos = pickSuspectToAvoid(a);
    if (avoidPos) { push('avoid', SOCIAL.avoidWeight, { around: avoidPos }); avoiding = true; }
  }
  if (!inDanger) push('wander', WEIGHT.wander * (0.6 + P.curiosity));

  // EMIGRATION JOURNEY (MIGRATE): an uprooting migrant marches for its new home town — the
  // own-state intent features/migrate.js stamped after the agent weighed a land-is-cheap
  // rumour for ITSELF. Pitched ABOVE a held plan even with its incumbent stickiness (the poor
  // — exactly who emigrates — chronically hold a money plan that otherwise out-scores the road
  // forever); urgent eat/flee/comfort-emergency still preempt — survival first, the march
  // resumes next tick. Settlement is the deriver's arrival watch (resolver.relocate), never here.
  if (!inDanger && a._migrating) push('migrate', WEIGHT.migrate, { toPos: { x: a._migrating.x, z: a._migrating.z } });

  // longer-term motivation tilts the short-term utility toward its preferred
  // action (e.g. an ambitious agent values 'work' more, a wanderer 'wander').
  for (const c of cand) c.score *= ambitionFavor(a, c.kind);

  // QUIRK TIC (gentle): the agent's stable behavioural tic shapes its OWN candidate weights — applied
  // IDENTICALLY here and in arbitrate's ROW table (both call quirkOf/quirkMul → float-identical, the
  // S2 parity net). Pushed after the ambitionFavor loop (the ambition/cohesion order is preserved).
  // SKIP while a `build` candidate is on the table: commissioning/raising a home is a fragile, time-
  // critical commitment (a quirk's gentle comfort/market boost could out-compete build and slip the
  // project — the median-preserving lesson: a tic must not derail a life decision). Both scorers apply
  // the SAME guard, so S2 parity holds.
  const building = cand.some((c) => c.kind === 'build');
  if (!building) {
    const quirk = quirkOf(a);
    for (const c of cand) c.score *= quirkMul(quirk, c.kind);
  }

  // AMBITION-ACTIVITY (Phase B1): when no enemy/opportunity is in sight, an agent pursues its
  // ambition's standing ACTIVITY (work my craft / march to the frontier / take in the sights /
  // seek my kin) instead of aimless wander — the candidate that out-scores the tiny wander floor.
  // Pushed AFTER the ambitionFavor loop (so it is NOT double-scaled by the per-kind favor — it is
  // ALREADY the ambition's own expression) and CLAMPED below WEIGHT.plan, so a live memory-derived
  // plan (avenge/repay/seek_fortune) ALWAYS out-ranks the standing activity — the goal stack owns
  // specific intentions, the ambition activity only fills genuinely-idle time. Survival/urgent needs
  // (eat/flee/emergency-comfort) still out-score it (they are pitched higher). Scaled by the matching
  // OWN personality drive, so the bold seek glory hardest, the ambitious work hardest, etc. Own-state
  // only (topAmbitionGoal/ambitionDrive read a._ambitionIntent + a.personality), epistemic split holds.
  // YIELDS to a live soft-avoid: a suspect-unease berth ("cross the street") pre-empts marching off
  // to one's ambition — the activity resumes the moment the suspect is out of mind. BOREDOM
  // COMPETES ON SCORE, never as a gate: an earlier hard `bored` yield DEADLOCKED — an agent whose
  // sightsee outing keeps getting interrupted (a frontier fighter, every trip cut short) never
  // refills novelty, sat "bored" forever, and the suppressed ambition candidate let idle time fall
  // through to aimless wander (the trace found drifters with novelty PINNED at 0 and a stamped
  // intent they never lived). Now the deficit-scaled sightsee candidate (above) simply out-scores
  // a half-hearted soul's activity and loses to a driven one — wander stays the LAST resort:
  // survival first (inDanger), then plans/needs, then the ambition activity vs the outing on
  // merit. DRIVE-PROPORTIONAL (floor in config, not a flat 0.6): the candidate spans
  // ~[W·floor .. W·(floor+1)], so a half-hearted soul still drifts to leisure while a driven
  // one genuinely lives its ambition — personality VISIBLY orders who pursues what, hardest.
  if (!inDanger && !avoiding) {
    const ak = topAmbitionGoal(a);
    // NO CAMPAIGN WITHOUT RATIONS: the frontier march is a map-length trip from food — a fighter
    // with an empty pack provisions FIRST (the market/forage candidates win this window) and
    // marches after. The residual-death probe found glory-seekers starving 200m+ from a field
    // with a full purse they never spent.
    const provisioned = !(ak && ak.kind === 'seek_glory' && (inv.food || 0) < 1);
    if (ak && provisioned)
      push(ak.kind, Math.min(WEIGHT.ambition * (MOTIVE.ambitionDriveFloor + ambitionDrive(a)), WEIGHT.plan - 0.05), ak.extra);
  }

  // PLAN STEP candidate: the top goal's current primitive is a STRONGLY-weighted
  // candidate, NOT a dictator — survival/needs (flee, eat) can still out-score it
  // and interrupt; the plan stays on the stack and resumes when it wins again
  // (docs §2/§4.4). Pushed after the ambition tilt so it isn't double-scaled.
  if (planStep) push('plan', WEIGHT.plan, { step: planStep });

  // LOOSE GROUPS LIVE THEIR BOND (Phase B2): membership pulls members toward the group's LIFE,
  // not a token socialise nudge. A CIRCLE gathers — its socialise pull is the per-type config
  // `pull`, and a member with no chosen friend converges ON the believed anchor (the shared spot
  // every member knows: its OWN belief of its OWN bandLeaderId, the resolveLeaderRef pattern —
  // no roster read; the anchor itself, bandLeaderId null, stays put as the gathering point). A
  // GUILD works its shared trade — the work candidate gets the pull (the craft IS the bond) and
  // the old fraternise nudge stays. Tuning lives in GROUP_TYPES[type].pull (config, not logic).
  const gt = a.groupType ? GROUP_TYPES_T[a.groupType] : null;
  if (gt && !a.inParty && gt.cohesion === 'loose') {
    const pull = gt.pull || 1.6;
    // THE GUILDHALL: a fellowship that raised a hall gathers THERE — a person is a wandering
    // target; the hall is the fixed point the group can actually share. Own-state stamp
    // (groupHallId, written by the execution side like groupName) + my OWN place-belief of
    // that building (discovered BY SIGHT, the homeBeliefId pattern — a hall I've never laid
    // eyes on, or believe razed, or whose belief has decayed stale, pulls nothing). The
    // socialize candidate carries the believed hall position (fillSocialize honours toPos);
    // with no hall the circle converges on the believed anchor exactly as before.
    const hb = (a.groupHallId != null) ? a.beliefs.get(a.groupHallId) : null;
    const hallPos = (hb && hb.sheltered !== false && hb.lastPos && hb.confidence >= SIM.actOnBeliefMin)
      ? { x: hb.lastPos.x, z: hb.lastPos.z } : null;
    for (const c of cand) {
      if (c.kind === 'socialize') {
        c.score *= (a.groupType === 'circle' ? pull : 1.6);
        if (hallPos) { c.toPos = hallPos; c.withId = null; }
        else if (a.groupType === 'circle' && c.withId == null && a.bandLeaderId != null) {
          const ab = a.beliefs.get(a.bandLeaderId);
          if (ab && ab.confidence >= SIM.actOnBeliefMin) c.withId = a.bandLeaderId;
        }
      } else if (c.kind === 'work' && a.groupType === 'guild') c.score *= pull;
    }
  }

  const prevKind = a.goal ? a.goal.kind : undefined;
  let best: Candidate | undefined = cand[0];
  for (const c of cand) {
    const eff = c.kind === prevKind ? c.score * 1.18 : c.score;
    const bestEff = best && best.kind === prevKind ? best.score * 1.18 : (best ? best.score : -Infinity);
    if (eff > bestEff) best = c;
  }
  void _nCand;   // counted for parity with arbitrate; telemetry write lives there now (oracle is pure)
  const winner: Goal = best ? (best as unknown as Goal) : { kind: a.canWork ? 'work' : 'wander' };
  return winner;
}

// AMBITION-ACTIVITY (Phase B1) — the standing-activity intent the ambition_goals feature stamps
// on own-state (a._ambitionIntent) for the agent's CURRENT ambition: work (wealth/mastery) /
// seek_glory (renown) / sightsee (wanderlust) / socialize (belonging). Four reuse an existing
// MEASURED behaviour; seek_glory is the one new march-to-the-frontier kind (the fight candidate
// fires on contact). Returns the activity kind + the extra its steer-fill needs (socialize carries
// the believed friend to seek). Own-state ONLY — reads a._ambitionIntent + (for socialize) the
// agent's own believed-friend; no roster read. null only for the no-ambition case. A 'work' commit
// also runs chooseOccupation (the goal-commit tail below already does this for any winning 'work').
// The stamped intent arrives already ACTIONABLE — the deriver (ambition_goals.ts) resolves the
// non-worker 'work' fallback at stamp time, so every reader sees one live kind.
export function topAmbitionGoal(a: Agent): { kind: string; extra?: Record<string, unknown> } | null {
  const kind = (a as Agent & { _ambitionIntent?: string | null })._ambitionIntent;
  if (!kind) return null;
  if (kind === 'socialize') {
    const friend = pickSocialTarget(a);                  // own-belief friend for fillSocialize (-> market fallback)
    return { kind: 'socialize', extra: friend != null ? { withId: friend } : undefined };
  }
  return { kind };
}

// The personality DRIVE behind the agent's ambition — the matching OWN trait (own-state only),
// so the candidate scales with how strongly this agent WANTS its ambition: the bold seek glory
// hardest, the curious journey hardest, the ambitious pursue their craft hardest, the social
// seek kin hardest. Defaults to a mid drive for an unmapped ambition. Never throws.
export function ambitionDrive(a: Agent): number {
  const P = a.personality || {};
  switch (a.ambition ? a.ambition.kind : '') {
    case 'renown':     return P.risk_tolerance ?? 0.5;
    case 'wanderlust': return P.curiosity ?? 0.5;
    case 'wealth':     return P.ambition ?? 0.5;
    case 'mastery':    return P.ambition ?? 0.5;
    case 'belonging':  return P.social_drive ?? 0.5;
    default:           return 0.5;
  }
}

// Pick the friend this agent would most like to spend time with — the dearest
// believed-friend, lightly discounted by how far away I BELIEVE they are (so I
// drift to a near-and-dear face, not trek across town past hazards). Belief-only
// (reads my BeliefStore's standing/lastPos, never ground truth) — I head for where
// I THINK they are, and may find an empty spot if they've moved (then I re-choose).
// Returns a subjectId, or null when I know no friend yet (caller falls back to the
// market, the town's gathering place). Never throws — guarded for the freeze lesson.
export function pickSocialTarget(a: Agent): EntityId | null {
  let best: EntityId | null = null, bestScore = -Infinity;
  for (const b of a.beliefs.all()) {
    if (b.hostile || b.standing < SOCIAL.friendStanding || b.confidence < SOCIAL.knownConf) continue;
    const d = a.pos.distanceTo(b.lastPos);
    const score = b.standing - d * SOCIAL.distancePenalty;
    if (score > bestScore) { bestScore = score; best = b.subjectId; }
  }
  return best;
}

// SOFT AVOIDANCE target (docs/architecture/13 §3 snubsFelt) — the nearest believed-SUSPECT I'd
// give a wide berth: suspicion at/above the soft bar, standing cool (NOT a friend), NOT yet hostile
// (a hostile is the survival flee's business, not this faint wariness), confidently known, and within
// avoidRange of where I BELIEVE it is. Reads ONLY my OWN beliefs (suspicion/standing/hostile/lastPos/
// confidence) — the epistemic split holds. Returns the suspect's believed pos ({x,z}) to steer OFF,
// or null when no one unsettles me. Guarded; never throws (the freeze lesson).
export function pickSuspectToAvoid(a: Agent): { x: number; z: number } | null {
  try {
    let best: { x: number; z: number } | null = null, bestD = Infinity;
    for (const b of a.beliefs.all()) {
      if (b.subjectId === a.id || b.placeKind) continue;          // not myself, not a place-belief
      if (b.hostile) continue;                                    // a hostile is the flee's job, not this
      if ((b.suspicion || 0) < SOCIAL.avoidSuspicion) continue;   // not suspect enough to unsettle me
      if ((b.standing || 0) > SOCIAL.avoidStanding) continue;     // a warm acquaintance gets no berth
      if (b.confidence < SIM.actOnBeliefMin || !b.lastPos) continue;
      const d = a.pos.distanceTo(b.lastPos);
      if (d > SOCIAL.avoidRange) continue;                        // only a near suspect crosses my street
      if (d < bestD) { bestD = d; best = { x: b.lastPos.x, z: b.lastPos.z }; }
    }
    return best;
  } catch { return null; }
}

// nearest comfort source for the comfort goal — now BELIEF-BACKED (debt #2 retired). The
// agent's OWN home counts ONLY while it BELIEVES it intact AND that belief is still fresh
// enough to act on: a stale-intact home-belief whose confidence has decayed below the act-on
// threshold (because perception stopped re-confirming it — the home was razed and despawned)
// is no longer trusted, so the agent reroutes to a tavern. This is what self-corrects the
// fully-ruined/despawned home case via belief DECAY (no percept to learn from), bounding the
// homecoming so it never loops toward a vanished home forever. The fallback is a STATIC
// shelter/rest Place from the shared mental map (a tavern/rest site) — never a live read.
// Returns { pos, kind } or null. Guarded; never throws.
export function nearestComfortSource(a: Agent, ctx: CognitionCtx): { pos: Vector3; kind: string } | null {
  try {
    const hb = a.homeBeliefId != null ? a.beliefs.get(a.homeBeliefId) : null;
    if (hb && hb.sheltered !== false && hb.lastPos && hb.confidence >= SIM.actOnBeliefMin)
      return { pos: hb.lastPos, kind: 'home' };                 // believed-intact, still-fresh home
    // BELIEVED-BEST SOURCE (the homeless path): among the places I KNOW OF — my own
    // place-beliefs, never the roster — weigh what I've FELT there (benefitFelt, stamped by
    // experience in act.ts) against the kind's cultural prior (everyone knows what a tavern
    // is for; a shrine is solace only to its OWN faithful), discounted by distance. A place
    // I believe razed (sheltered=false, learned by sight) is skipped — beliefs can do what
    // the static map can't. Falls back to the static tavern/rest Place when I know nothing.
    const priors = (COMFORT.kindPrior || {}) as Record<string, number>;
    const myGod = (a as { faith?: string }).faith;
    let best: { pos: Vector3; kind: string } | null = null, bestS = 0;
    for (const pb of a.beliefs.all()) {
      if (!pb.placeKind || pb.sheltered === false || !pb.lastPos) continue;
      if (pb.confidence < SIM.actOnBeliefMin) continue;
      let prior = 0;
      if (pb.placeKind === 'tavern') prior = priors.tavern ?? 1;
      else if (pb.placeKind === 'shrine' && pb.placeGod && myGod === pb.placeGod) prior = priors.shrine ?? 0.65;
      else continue;                                            // halls/granaries are not rest stops
      const q = Math.max(pb.benefitFelt || 0, prior);
      const dx = pb.lastPos.x - a.pos.x, dz = pb.lastPos.z - a.pos.z;
      const s = q / (1 + Math.sqrt(dx * dx + dz * dz) / (COMFORT.sourceRange || 40));
      if (s > bestS) { bestS = s; best = { pos: pb.lastPos, kind: pb.placeKind } }
    }
    if (best) return best;
    const t = ctx.map && ctx.map.nearest(['shelter', 'rest'], a.pos, a.townId);
    return t ? { pos: t.pos, kind: 'tavern' } : null;           // STATIC tavern/rest Place
  } catch { return null; }
}

// companion decision: defend the leader. Engage a believed-hostile within
// vision of me OR of the leader; otherwise keep formation (goal 'follow').
export function decideParty(a: Agent, ctx: CognitionCtx): void {
  // The leader handle: for the PLAYER-led party, a documented controlled-leader exception
  // supplies ctx.partyLeader (the execution layer reads it). For an NPC band, resolve the
  // leader off MY belief about it (confidence-gated lastPos) — no roster.
  const leader = a._leader(ctx);                 // controlled-party leader handle, or null
  const lbel = (!leader && a.bandLeaderId != null) ? a.beliefs.get(a.bandLeaderId) : null;
  const leaderLive = leader ? leader.alive : !!(lbel && lbel.confidence >= SIM.actOnBeliefMin); // EPISTEMIC-OK: controlled party leader (known mechanic)
  // a banded agent whose leader is gone (dead/disbanded) — or whose track of it has decayed
  // below the act-on threshold — has no one to follow. Rather than camping aimless `wander`
  // until the band dissolves (the single biggest pool of drift the behaviour trace surfaced:
  // lost followers spent ~half their LIVES wandering), it falls back to its OWN ambition's
  // standing activity (Phase B1, own-state intent) and lives its life; following resumes the
  // moment it re-perceives the leader (or truth-side prune dissolves a dead leader's band).
  if (!leaderLive) {
    const ak = topAmbitionGoal(a);
    a.goal = ak ? { kind: ak.kind, ...(ak.extra || {}) } : { kind: 'wander' };
    if (a.goal.kind === 'work') chooseOccupation(a, ctx);   // same commit tail as the scorer
    return;
  }
  const pgt = a.groupType ? GROUP_TYPES_T[a.groupType] : null;
  const combatant = pgt ? pgt.combatant : true;   // player party + warbands fight; hearths flee
  // enemy is a belief-style REF (id + pos) — either my nearest believed-hostile or the
  // leader's-fight scan result; never a live roster object.
  let enemy: { id: EntityId; pos: { x: number; z: number } } | null = a._nearestHostile(ctx);
  // a fighting band also picks up an enemy the leader is tangling with, even beyond my own
  // sight, so the group converges on the leader's fight. The execution layer performs this
  // vision-gated scan around the leader and returns a belief-style ref (never the object).
  if (!enemy && combatant && ctx.resolver) {
    const ref = ctx.resolver.enemyNearLeader(a, leader);
    if (ref) enemy = ref;
  }
  if (enemy && !combatant) {
    // HEARTH SHELTERS TOGETHER (Phase B2): homebodies don't scatter — flee TO the shelter
    // nearest where I believe my hearth-mate (the leader) is, so the pair converges on ONE
    // refuge. Own belief (lbel.lastPos / the controlled-leader handle) + the STATIC map —
    // the same reads this function already makes; fillFlee honours toPos as the refuge.
    // No known shelter → plain flight away from the threat, exactly as before.
    if (a.groupType === 'hearth' && ctx.map) {
      try {
        const lp = leader ? leader.pos : (lbel ? lbel.lastPos : null);
        const safe = lp ? ctx.map.nearest(['shelter', 'rest'], lp, a.townId) : null;
        if (safe) { a.goal = { kind: 'flee', fromId: enemy.id, toPos: { x: safe.pos.x, z: safe.pos.z } }; return; }
      } catch { /* never throw on the tick */ }
    }
    a.goal = { kind: 'flee', fromId: enemy.id }; return;   // hearth runs
  }
  // even on the march, a safe-but-starving companion stops to eat (it has no economic
  // scheduler of its own, so without this band members slowly starved).
  if (!enemy && (a.inventory.food || 0) > 0.05 && a.needs.hunger < (ECON.eatUrgent || 0.4)) { a.goal = { kind: 'eat' }; return; }
  a.goal = enemy ? { kind: 'fight', targetId: enemy.id } : { kind: 'follow' };
}
