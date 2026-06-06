// Agent decision layer — the utility scorer that settles each tick's goal from
// BELIEFS ONLY (never ground truth: the epistemic split). Extracted from Agent
// as free functions over a passed agent instance. decide scores survival /
// economic / social / plan-step candidates (incl. the flee Schmitt band that
// kills the old flee<->work limit-cycle), tilts them by ambition + group
// cohesion, and commits the winner; decideParty is the companion override.
// Behaviour-preserving: verbatim bodies of the old Agent methods. No cycles —
// imports config, pure helpers, motivation, and the occupation chooser.

import { SIM, WEIGHT, ECON, COMMODITIES, GROUP_TYPES, LEGEND, SOCIAL, COMFORT, BUILD, factionHostile } from '../simconfig.js';
import { updateAmbition, ambitionFavor, ambitionWantsFight, deriveGoals, pruneGoals } from '../motivation.js';
import { chooseOccupation } from './occupation.js';
import { qualifyHome, BUILD_KIND } from '../construction.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function decide(a, ctx) {
  a._rpgNow = ctx.time;   // stamp sim time for this tick's emitted deeds
  if (!a.alive || a.controlled) return;

  // THE REPORTER: a gazetteer doesn't work, fight, or plan — it pursues the story.
  // The Reporter subsystem sets a.reporterTarget; act.js walks the body there. This
  // override wins over every other role so the press always keeps to its beat.
  if (a.reporter) { a.goal = { kind: 'reporter' }; return; }

  // DUEL OF HONOUR: a 1v1 LOCK — a duelist seeks and fights only its opponent, with no
  // flee and no economic distraction (we return before those candidates are scored).
  if (a._duelWith != null && a.autonomous) {
    const foe = ctx.agentsById.get(a._duelWith);
    if (foe && foe.alive) { a.goal = { kind: 'fight', targetId: foe.id }; return; }
  }

  // THE AVENGER: an NPC whose kin the PLAYER murdered — a relentless personal nemesis.
  // Where a fleeting grudge decays, the avenger HUNTS the player at any range with no
  // flee and no economic distraction, until one of them falls. The Director keeps the
  // grudge hot (so it never cools) and narrates the vendetta + files it as a saga.
  if (a.avengerOf != null && a.autonomous) {
    const foe = ctx.agentsById.get(a.avengerOf);
    if (foe && foe.alive) { a.goal = { kind: 'fight', targetId: foe.id }; return; }
  }

  // THE BUTCHER'S SHADOW: the street empties before a known killer. A FEARFUL townsperson
  // (low nerve) gives a notoriously violent player a wide berth — a visible bubble of
  // unease around an infamous reputation. Bounded (only the timid, only up close, only
  // a true villain) so it unsettles the town without emptying it. The bold are unmoved.
  if (LEGEND && LEGEND.enabled && a.autonomous && a.faction === 'townsfolk' &&
      a.guardianOf == null && !a.inParty && !a.combatant && a.personality &&
      a.personality.risk_tolerance < (LEGEND.fearRisk || 0.42)) {
    const p = ctx.player;
    if (p && p.alive && (p.notoriety || 0) >= (LEGEND.villainAt || 0.66) &&
        a.pos.distanceTo(p.pos) < (LEGEND.fearRange || 9)) { a.goal = { kind: 'flee', fromId: p.id }; return; }
  }

  // BOUNTY-HUNTER: a townsperson who answered a Gazette bounty hunts its quarry —
  // the named foe (a vendetta) or the nearest of the bounty's faction. Fights when
  // close; else marches toward the threat zone the notice named.
  if (a.bounty && a.autonomous) {
    const b = a.bounty;
    let target = null;
    if (b.killerId != null) target = ctx.agentsById.get(b.killerId);
    else {
      let bd = Infinity;
      for (const o of ctx.agents) {
        if (!o.alive || o.controlled || o.faction !== b.faction) continue;
        const d = a.pos.distanceTo(o.pos);
        if (d < bd) { bd = d; target = o; }
      }
    }
    if (target && target.alive && a.pos.distanceTo(target.pos) <= SIM.visionRange) a.goal = { kind: 'fight', targetId: target.id };
    else a.goal = { kind: 'bounty', toward: (target && target.alive) ? { x: target.pos.x, z: target.pos.z } : b.toward };
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
    let foe = null, fd = Infinity;
    for (const b of a.beliefs.all()) {
      if (b.confidence < SIM.actOnBeliefMin || !a.considerHostile(b)) continue;
      if (b.lastFaction === a.disguiseFaction) continue;   // don't fight my cover
      const o = ctx.agentsById.get(b.subjectId);
      if (!o || !o.alive) continue;
      const d = a.pos.distanceTo(o.pos);
      if (d < fd) { fd = d; foe = o; }
    }
    if (foe && fd <= SIM.arriveDist + 1.6) {
      a.goal = { kind: 'fight', targetId: foe.id };   // cornered by a real threat
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

  const cand = [];
  const push = (kind, score, extra) => { if (score > 0) cand.push({ kind, score, ...extra }); };

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
    const committed = a.goal.kind === 'flee' || a.goal.kind === 'fight';
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
      push('work', WEIGHT.work * (0.4 + P.ambition) * (0.5 + 0.5 * goldNeed) * (1 - 0.7 * overstock));
      push('rest', Math.pow(1 - a.needs.energy, 1.5) * WEIGHT.rest);
      // SOCIALISE = seek out a believed-friend (belief-only target). A known friend
      // is a stronger pull than a generic market trip — heading to a face you like is
      // what makes the town feel social rather than a crowd of strangers at a stall.
      const friend = pickSocialTarget(a);
      const friendPull = friend != null ? 1.25 : 1;
      push('socialize', (1 - a.needs.social) * (0.5 + P.social_drive) * WEIGHT.socialize * friendPull,
        friend != null ? { withId: friend } : undefined);

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
        const src = nearestComfortSource(a, ctx);
        if (src) {
          // strong, linear pull: a low-comfort agent commits to heading home rather
          // than being out-pulled by a market/plan urge (WEIGHT.comfort carries it).
          let cs = (1 - a.needs.comfort) * WEIGHT.comfort;
          // COMFORT EMERGENCY: when comfort runs critically low it becomes urgent like
          // hunger — a near-survival pull that out-ranks a routine market/plan haul, so
          // the agent actually goes home instead of grinding the market into the ground.
          if (a.needs.comfort < (COMFORT.urgentBelow || 0)) cs *= (COMFORT.urgentBoost || 1);
          if (seeking) {
            // already on my way home: stick with it (don't get yanked off mid-walk),
            // and once AT the source dwell hard until topped up (the limit-cycle fix).
            cs *= (a.pos.distanceTo(src.pos) <= (SIM.arriveDist || 1.5) + 1)
              ? (COMFORT.dwellBoost || 1) : (COMFORT.seekBoost || 1);
          }
          push('comfort', cs, { toPos: { x: src.pos.x, z: src.pos.z } });
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
      } else if (BUILD.enabled && a._buildSiteId != null) {
        // already committed to a site → keep building it (an even stronger, sticky
        // pull so the project finishes instead of being abandoned for a market trip).
        push('build', WEIGHT.build * 1.8);
      }
    }
  }
  if (!inDanger) push('wander', WEIGHT.wander * (0.6 + P.curiosity));

  // longer-term motivation tilts the short-term utility toward its preferred
  // action (e.g. an ambitious agent values 'work' more, a wanderer 'wander').
  for (const c of cand) c.score *= ambitionFavor(a, c.kind);

  // PLAN STEP candidate: the top goal's current primitive is a STRONGLY-weighted
  // candidate, NOT a dictator — survival/needs (flee, eat) can still out-score it
  // and interrupt; the plan stays on the stack and resumes when it wins again
  // (docs §2/§4.4). Pushed after the ambition tilt so it isn't double-scaled.
  if (planStep) push('plan', WEIGHT.plan, { step: planStep });

  // loose social groups (guild/circle) pull their members together to socialise
  if (a.groupType && !a.inParty && GROUP_TYPES[a.groupType] &&
      GROUP_TYPES[a.groupType].cohesion === 'loose')
    for (const c of cand) if (c.kind === 'socialize') c.score *= 1.6;

  let best = cand[0];
  for (const c of cand) {
    const eff = c.kind === a.goal.kind ? c.score * 1.18 : c.score;
    const bestEff = best.kind === a.goal.kind ? best.score * 1.18 : best.score;
    if (eff > bestEff) best = c;
  }
  a.goal = best || { kind: a.canWork ? 'work' : 'wander' };

  // emergent occupation: when we settle on WORK, decide WHAT to make this stint
  // (belief-priced, proximity- and ambition-weighted, opportunity-gated). Stored
  // on a._trade and produced by act()/_produce. Belief-only inputs; guarded.
  if (a.goal.kind === 'work') chooseOccupation(a, ctx);
}

// Pick the friend this agent would most like to spend time with — the dearest
// believed-friend, lightly discounted by how far away I BELIEVE they are (so I
// drift to a near-and-dear face, not trek across town past hazards). Belief-only
// (reads my BeliefStore's standing/lastPos, never ground truth) — I head for where
// I THINK they are, and may find an empty spot if they've moved (then I re-choose).
// Returns a subjectId, or null when I know no friend yet (caller falls back to the
// market, the town's gathering place). Never throws — guarded for the freeze lesson.
function pickSocialTarget(a) {
  let best = null, bestScore = -Infinity;
  for (const b of a.beliefs.all()) {
    if (b.hostile || b.standing < SOCIAL.friendStanding || b.confidence < SOCIAL.knownConf) continue;
    const d = a.pos.distanceTo(b.lastPos);
    const score = b.standing - d * SOCIAL.distancePenalty;
    if (score > bestScore) { bestScore = score; best = b.subjectId; }
  }
  return best;
}

// nearest comfort source for the comfort goal: the agent's OWN home always
// counts, else any finished tavern (ground truth via the BuildSites lookup — an
// execution helper, not a belief read). Guarded; null when none exists.
function nearestComfortSource(a, ctx) {
  try {
    if (a.home) return a.home;                       // own home always counts
    const bs = ctx.buildSites; if (!bs) return null;
    return bs.nearest(BUILD_KIND.TAVERN, a.pos);     // else any tavern
  } catch { return null; }
}

// companion decision: defend the leader. Engage a believed-hostile within
// vision of me OR of the leader; otherwise keep formation (goal 'follow').
export function decideParty(a, ctx) {
  const leader = a._leader(ctx);
  // a banded agent whose leader is gone (dead/disbanded) has no one to follow —
  // it reverts to wandering rather than assuming the player or chasing a null.
  if (!leader || !leader.alive) { a.goal = { kind: 'wander' }; return; }
  const gt = a.groupType ? GROUP_TYPES[a.groupType] : null;
  const combatant = gt ? gt.combatant : true;   // player party + warbands fight; hearths flee
  let enemy = a._nearestHostile(ctx);
  // a fighting band also picks up an enemy the leader is tangling with, even
  // beyond my own sight, so the group converges on the leader's fight.
  if (!enemy && combatant && leader && leader.alive) {
    let bd = SIM.visionRange * SIM.visionRange;
    for (const o of ctx.agents) {
      if (o === a || o === leader || !o.alive || o.controlled || o.inParty) continue;
      if (!factionHostile(a.faction, o.faction)) continue;
      const d = leader.pos.distanceToSquared(o.pos);
      if (d < bd) { bd = d; enemy = o; }
    }
  }
  if (enemy && !combatant) { a.goal = { kind: 'flee', fromId: enemy.id }; return; }  // hearth runs
  // even on the march, a safe-but-starving companion stops to eat (it has no economic
  // scheduler of its own, so without this band members slowly starved).
  if (!enemy && (a.inventory.food || 0) > 0.05 && a.needs.hunger < (ECON.eatUrgent || 0.4)) { a.goal = { kind: 'eat' }; return; }
  a.goal = enemy ? { kind: 'fight', targetId: enemy.id } : { kind: 'follow' };
}
