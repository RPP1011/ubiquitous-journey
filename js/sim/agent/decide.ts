// Agent decision layer — the utility scorer that settles each tick's goal from
// BELIEFS ONLY (never ground truth: the epistemic split). Extracted from Agent
// as free functions over a passed agent instance. decide scores survival /
// economic / social / plan-step candidates (incl. the flee Schmitt band that
// kills the old flee<->work limit-cycle), tilts them by ambition + group
// cohesion, and commits the winner; decideParty is the companion override.
// Behaviour-preserving: verbatim bodies of the old Agent methods. No cycles —
// imports config, pure helpers, motivation, and the occupation chooser.

import { SIM, WEIGHT, ECON, COMMODITIES, GROUP_TYPES, LEGEND, SOCIAL, COMFORT, NOVELTY, BUILD, ESTEEM as WEALTH, ROMANCE, MOTIVE, factionHostile } from '../simconfig.js';
import { updateAmbition, ambitionFavor, ambitionWantsFight, deriveGoals, pruneGoals } from '../motivation.js';
import { chooseOccupation, laborValue } from './occupation.js';
import { qualifyHome, isUnhoused } from '../construction.js';
import { foldGoalDwell } from '../signals.js';
import { STAGE, REASON } from '../trace.js';
import type { Agent, CognitionCtx, Goal, EntityId, Stage, Reason } from '../../../types/sim.js';
import type { Vector3 } from 'three';

// trace.js infers STAGE/REASON members as plain `string`; retype for Trace.note.
const STAGE_T = STAGE as Record<string, Stage>;
const REASON_T = REASON as Record<string, Reason>;
// simconfig.js GROUP_TYPES inferred without an index signature (allowJs).
const GROUP_TYPES_T = GROUP_TYPES as Record<string, { cohesion?: string; combatant?: boolean; pull?: number } | undefined>;

/** A scored utility candidate (decide's deliberation), spread into the chosen goal. */
interface Candidate { kind: string; score: number; [k: string]: unknown }

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

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
      push('work', WEIGHT.work * (0.4 + P.ambition) * motive * (1 - 0.7 * overstock));
      push('rest', Math.pow(1 - a.needs.energy, 1.5) * WEIGHT.rest);
      // SOCIALISE = seek out a believed-friend (belief-only target). A known friend
      // is a stronger pull than a generic market trip — heading to a face you like is
      // what makes the town feel social rather than a crowd of strangers at a stall.
      const friend = pickSocialTarget(a);
      const friendPull = friend != null ? 1.25 : 1;
      push('socialize', (1 - a.needs.social) * (0.5 + P.social_drive) * WEIGHT.socialize * friendPull,
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

  // longer-term motivation tilts the short-term utility toward its preferred
  // action (e.g. an ambitious agent values 'work' more, a wanderer 'wander').
  for (const c of cand) c.score *= ambitionFavor(a, c.kind);

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
    if (ak)
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
    for (const c of cand) {
      if (c.kind === 'socialize') {
        c.score *= (a.groupType === 'circle' ? pull : 1.6);
        if (a.groupType === 'circle' && c.withId == null && a.bandLeaderId != null) {
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
  a._decideCands = _nCand;   // REASONING-COST: candidates scored this tick (read truth-side)
  const winner: Goal = best ? (best as unknown as Goal) : { kind: a.canWork ? 'work' : 'wander' };
  a.goal = winner;
  // REASONING-COST hysteresis (Phase 3): stamp the time the committed goal.kind last CHANGED,
  // so the LOD relevance gate can keep a just-re-deliberated agent at full fidelity for a short
  // window (anti-thrash at the stride edge). Own-scalar writes; read truth-side in _isRelevant.
  if (winner.kind !== a._prevGoalKind) { a._lastGoalChangeAt = ctx.time; a._prevGoalKind = winner.kind; }
  // TRACE (write-only, never read back): the everyday utility-arbitration winner + its score —
  // the headline "why this behaviour and not another" beat. (The override locks above —
  // duel/avenger/butcher's-shadow/schema flee — commit before this scorer and return; the
  // schema-driven ones are already covered by SCHEMA_FIRED.) Own scores only; note() guarded.
  a.trace.note(STAGE_T.DECIDE, REASON_T.BEHAVIOUR_WON, { t: ctx.time, a: winner.kind, b: best ? +best.score.toFixed(2) : null });

  // emergent occupation: when we settle on WORK, decide WHAT to make this stint
  // (belief-priced, proximity- and ambition-weighted, opportunity-gated). Stored
  // on a._trade and produced by act()/_produce. Belief-only inputs; guarded.
  if (winner.kind === 'work') chooseOccupation(a, ctx);
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
function ambitionDrive(a: Agent): number {
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
function pickSocialTarget(a: Agent): EntityId | null {
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
function pickSuspectToAvoid(a: Agent): { x: number; z: number } | null {
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
function nearestComfortSource(a: Agent, ctx: CognitionCtx): { pos: Vector3; kind: string } | null {
  try {
    const hb = a.homeBeliefId != null ? a.beliefs.get(a.homeBeliefId) : null;
    if (hb && hb.sheltered !== false && hb.lastPos && hb.confidence >= SIM.actOnBeliefMin)
      return { pos: hb.lastPos, kind: 'home' };                 // believed-intact, still-fresh home
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
