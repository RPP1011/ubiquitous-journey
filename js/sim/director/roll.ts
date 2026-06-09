// DIRECTOR / ROLL — the macro pacing layer: the POINTS BUDGET + weighted event
// roll (raid / opportunity / crisis / spark / trope), the dramatic TENSION/RELIEF
// rhythm, the light belief-only nudges (opportunity/crisis/spark), and the close-out
// of a favored-rise's fall. Free functions over the Director instance `d`.
import { DIRECTOR } from '../simconfig.js';
import { BEAT } from '../chronicle.js';
import { clamp } from './util.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dir = any;        // the Director instance (thin shell — see director.ts). Opaque on
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;        // purpose: a large freeform drama surface; behaviour is unchanged.


// roll the weighted event table, gently modulated by world-state.
// DRAMATIC PACING — track tension and grant a RELIEF window when a high-tension
// peak resolves (a war won, a raid wave seen off). Gives the world a breath after
// the storm: no new raids, fear lifts, and bonds form in the calm.
export function _pace(d: Dir): void {
  const P = DIRECTOR.pacing; if (!P || !P.enabled) return;
  d._tension = Math.max(0, d._tension - (P.decay || 0.06));
  const threatNow = d._raiders.length > 0 || !!d._warlord;
  // the moment a real threat clears after a high-tension peak: the town breathes.
  if (d._threatWas && !threatNow && d._tension >= (P.reliefThreshold || 0.5)
      && d._townPop() >= DIRECTOR.raid.minPop && d.sim.time >= d._reliefUntil) {
    d._enterRelief();
  }
  d._threatWas = threatNow;
}

export function _enterRelief(d: Dir): void {
  if (d.sim.time < d._reliefUntil) return;     // already breathing — don't re-fire
  const P = DIRECTOR.pacing;
  d._reliefUntil = d.sim.time + (P.reliefDuration || 45);
  d._tension = Math.max(0, d._tension - 0.6);   // the pressure releases
  d.stats.reliefs = (d.stats.reliefs || 0) + 1;
  // the pall of fear lifts over the town (a visible calm; mood feeds decide/labels).
  for (const a of d.sim.agents) {
    if (a.alive && !a.controlled && a.faction === 'townsfolk' && a.mood) a.mood.fear = 0;
  }
  d._note(BEAT.FORTUNE, -14, `With the danger passed, the townsfolk gather in relief — there is feasting, and old quarrels are set aside for a while.`);
}

export function _inRelief(d: Dir): boolean { return d.sim.time < d._reliefUntil; }

export function _roll(d: Dir, ctx: Ctx): void {
  const pop = d._townPop();
  // a dead/near-dead town: hold all events (reprieve) so it can recover.
  if (pop < DIRECTOR.minPopForEvents) return;

  // --- POINTS BUDGET: accrue (prosperity), drain on losses (mercy), then SPEND ----
  const PT = DIRECTOR.points || {};
  const lost = (d._lastPop != null) ? Math.max(0, d._lastPop - pop) : 0;   // net townsfolk lost since last roll
  d._lastPop = pop;
  d._points = Math.max(0, Math.min(PT.max || 50,
    d._points + (PT.base || 1) + (PT.perPop || 0) * Math.max(0, pop - DIRECTOR.raid.minPop) - lost * (PT.deathDrain || 0)));

  // candidate incidents the budget can AFFORD; during RELIEF the town breathes, so
  // suppress raids + crises (threats), leaving the social/positive register.
  const W = DIRECTOR.weights, C = PT.cost || {};
  const relief = d._inRelief();
  const cands = [];
  if (!relief && d._points >= (PT.raidPerRaider || 4)) cands.push({ k: 'raid', w: W.raid });
  if (d._points >= (C.opportunity || 2)) cands.push({ k: 'opportunity', w: W.opportunity });
  if (!relief && d._points >= (C.crisis || 5)) cands.push({ k: 'crisis', w: W.crisis });
  if (d._points >= (C.spark || 3)) cands.push({ k: 'spark', w: W.spark });
  if (d._points >= (C.trope || 8)) cands.push({ k: 'trope', w: W.trope || 0 });
  let total = 0; for (const c of cands) total += c.w;
  if (total <= 0) return;                 // can't afford anything yet — bank for next roll (a lull)
  let r = Math.random() * total, pick = cands[cands.length - 1];
  for (const c of cands) { if ((r -= c.w) < 0) { pick = c; break; } }
  switch (pick.k) {
    case 'raid':        return d._raid(pop);          // _raid sizes + pays from the budget
    case 'opportunity': d._points -= (C.opportunity || 2); return d._opportunity(pop);
    case 'crisis':      d._points -= (C.crisis || 5);  return d._crisis();
    case 'spark':       d._points -= (C.spark || 3);   return d._spark();
    default:            d._points -= (C.trope || 8);   return d._instigateTrope(ctx);
  }
}

// --- OPPORTUNITY: a passing rich caravan (a trader) OR a recruitable wanderer --
// Light touch: we just nudge a single existing, idle townsperson — a "wanderer"
// gets a small ambition kick (curiosity) and a "caravan" raises that agent's
// sell-side price beliefs a touch (a richer market for a while). No new bodies,
// no minted gold — the emergent systems carry it from there.
export function _opportunity(d: Dir, pop: number): void {
  const folk = d._idleTownsfolk();
  if (!folk.length) return;
  const a = folk[(Math.random() * folk.length) | 0];
  try {
    if (Math.random() < DIRECTOR.opportunity.caravanShare) {
      // caravan: a transient willingness to pay more brightens trade beliefs.
      for (const c in a.priceBeliefs) {
        a.priceBeliefs[c] = +(a.priceBeliefs[c] * DIRECTOR.opportunity.caravanPriceMul).toFixed(2);
      }
    } else if (a.personality) {
      // recruitable wanderer: a curiosity nudge biases this soul toward roaming
      // and meeting others (more belief pairs -> more emergent drama).
      a.personality.curiosity = clamp(a.personality.curiosity + DIRECTOR.opportunity.wanderCuriosity, 0, 1);
    }
    d.stats.opportunities++;
    d._sinceEvent = 0;
  } catch { /* guarded */ }
}

// --- CRISIS: a light transient scarcity nudge -------------------------------
// Raises a handful of townsfolk's price beliefs on ONE staple — a scarcity
// shock the market then tatonnements back down. Bounded, no economic mutation
// beyond beliefs (no inventory/gold change).
export function _crisis(d: Dir): void {
  const folk = d._idleTownsfolk();
  if (!folk.length) return;
  const C = DIRECTOR.crisis;
  const staples = C.staples;
  const good = staples[(Math.random() * staples.length) | 0];
  let touched = 0;
  for (const a of folk) {
    if (touched >= C.maxAffected) break;
    if (Math.random() > C.affectShare) continue;
    try {
      if (a.priceBeliefs && a.priceBeliefs[good] != null) {
        a.priceBeliefs[good] = +(a.priceBeliefs[good] * C.priceMul).toFixed(2);
        touched++;
      }
    } catch { /* guarded */ }
  }
  if (touched > 0) { d.stats.crises++; d._sinceEvent = 0; }
}

// --- SPARK: seed a feud (mutual negative standing) or a theft ---------------
// We write BELIEFS (the deception/standing layer), never ground truth — two
// townsfolk come to mistrust each other, which the existing decide/groups code
// reacts to. Guarded; a missing belief store just skips.
export function _spark(d: Dir): void {
  const folk = d._idleTownsfolk();
  if (folk.length < 2) return;
  const i = (Math.random() * folk.length) | 0;
  let j = (Math.random() * folk.length) | 0;
  if (j === i) j = (j + 1) % folk.length;
  const A = folk[i], B = folk[j];
  try {
    const drop = DIRECTOR.spark.standingDrop;
    d._sour(A, B, drop);
    // a feud is mutual; a theft is one-sided. Roll which.
    if (Math.random() < DIRECTOR.spark.feudShare) d._sour(B, A, drop);
    d.stats.sparks++;
    d._sinceEvent = 0;
  } catch { /* guarded */ }
}

// the FALL: when a favored rise's window passes, the inflated esteem sours back and
// the town wonders what it ever saw — completing the rise-and-fall arc.
export function _processFavoredFalls(d: Dir): void {
  if (!d._favored || !d._favored.length) return;
  const now = d.sim.time;
  for (const f of d._favored) {
    if (!f || !f.live || now < f.fallAt) continue;
    const up = d.sim.agentsById.get(f.id);
    for (const gid of f.by) { const G = d.sim.agentsById.get(gid); if (G) d._plant(G, f.id, { dStanding: -((DIRECTOR.tropes.riseBump || 0.4) + 0.1) }); }
    if (up && up.alive) d._note(BEAT.FORTUNE, f.id, `${up.name}'s star has fallen as fast as it rose — the town's favour was ever a fickle thing.`);
    f.live = false;
  }
  d._favored = d._favored.filter((f: any) => f && f.live);
}
