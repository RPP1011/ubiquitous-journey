// DIRECTOR / CARAVANS — trade-road runs the bandits prey on. A trader is sent on a
// long LOOP (out to another town / a far point, then home) carrying a staple, with
// hired GUARD/PORTER escorts (warband fights, hearth flees) and a bandit AMBUSH sprung
// on the road between towns. A waylaid caravan loses its cargo (that good grows scarce);
// one that returns brings a windfall (plenty). Supply lines become worth defending.
// Free functions over the Director instance `d`.
import * as THREE from 'three';
import { rng } from '../rng.js';
import { DIRECTOR } from '../simconfig.js';
import { BEAT } from '../chronicle.js';
import { rand } from './util.js';
import { isHomeBuilder } from '../construction.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dir = any;   // the Director instance (thin shell — see director.ts). Opaque on
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;    // purpose: a large freeform drama surface; behaviour is unchanged.


// DISPATCH A CARAVAN — one caravan on the road at a time.
export function _tropeCaravan(d: Dir): boolean {
  if (d._caravans.some((c: any) => c && c.alive && c.caravanRun)) return false;
  const C = DIRECTOR.caravan || {};
  const folk = d._townsfolkAlive().filter((a: any) =>
    !a.inParty && !a.expedition && !a.caravanRun && !a.watch && !a.reporter && !isHomeBuilder(a) &&
    a.goal && a.goal.kind !== 'fight');
  const trader = d._shuffle(folk)[0];
  if (!trader) return false;
  const goods = C.goods || ['ore'];
  const good = goods[(rng() * goods.length) | 0];
  // home = the trader's own town; destination = ANOTHER town (a real trade route)
  // if the world has more than one, else a far point on the open road (legacy).
  const now = d.sim.time;
  const alerted = (t: any) => t && t._alertUntil != null && now < t._alertUntil;
  // a caravan WON'T set out from a town on alert (a Gazette threat advisory) — the
  // roads are too dangerous; trade waits for the warning to pass (channel 2).
  if (trader.townId != null && d.sim.towns && alerted(d.sim.towns[trader.townId])) return false;
  const home = trader.townAnchor ? trader.townAnchor.clone() : new THREE.Vector3(0, 0, 0);
  const towns = (d.sim.towns || []).filter((t: any) => t.center.distanceToSquared(home) > 1 && !alerted(t));
  let dest;
  if (towns.length) {
    dest = d._shuffle(towns)[0].center.clone();
  } else {
    const ang = rand(0, Math.PI * 2), dist = C.dist || 46;
    dest = new THREE.Vector3(home.x + Math.cos(ang) * dist, 0, home.z + Math.sin(ang) * dist);
  }
  trader.caravanRun = { phase: 'out', target: dest, dest, home, good, startedAt: d.sim.time };
  d._caravans.push(trader);
  // a caravan is a GROUP: recruit hired ESCORTS from idle townsfolk of the trader's
  // own town standing nearby — GUARDS (band-follow + fight the ambush) and PORTERS
  // (band-follow + flee). They reuse the warband/hearth follow path (decideParty).
  const pool = d._shuffle(folk.filter((a: any) =>
    a !== trader && a.townId === trader.townId && a.pos.distanceTo(trader.pos) <= (C.recruitR || 26)));
  const nG = C.guards ?? 2, nP = C.porters ?? 2;
  const guards = pool.slice(0, nG);
  const porters = pool.slice(nG, nG + nP);
  trader._caravanEscorts = [];
  for (const g of guards) d._enlistEscort(g, trader, 'guard', good);
  for (const p of porters) d._enlistEscort(p, trader, 'porter', good);
  // spring the ambush ON THE ROAD between the two towns (beyond either town's
  // defences) so it actually intercepts the caravan as it travels.
  const apos = home.clone().lerp(dest, C.ambushAt || 0.62);
  const n = C.ambushers || 3;
  for (let i = 0; i < n; i++) {
    const r = d._spawnRaider(apos.x + rand(-7, 7), apos.z + rand(-7, 7));
    if (r) {
      r.speedMul = C.speedMul || 1.2; r._raidExpire = d.sim.time + (C.ttl || 30);
      // TETHER the bandits to the ambush site: they run the caravan down on the road
      // but break off (the territorial leash) before they reach the town — so an
      // ambush is a ROAD hazard, not a town assault. A caravan that flees far enough
      // toward home shakes them; one caught out on the road is lost.
      r.homeAnchor = apos.clone(); r.leashR = C.leashR || 18;
      d._raiders.push(r);
    }
  }
  const esc = trader._caravanEscorts.length;
  const escTxt = esc
    ? ` with ${guards.length} guard${guards.length === 1 ? '' : 's'} and ${porters.length} porter${porters.length === 1 ? '' : 's'}`
    : '';
  d._note(BEAT.RAID, trader.id, `${trader.name} sets out with a caravan of ${good}${escTxt} — and bandits lie in wait on the road.`);
  return true;
}

// flag a townsperson as a caravan ESCORT: a band-follower of the trader. Guards
// fight (warband), porters flee (hearth) — reusing decideParty's follow/fight/flee.
// Restores cleanly on disband. Mirrors expeditions._form's warband enlistment.
export function _enlistEscort(d: Dir, a: Ag, leader: Ag, role: string, good: string): void {
  if (!a || !leader) return;
  a._caravanRestore = { combatant: a.combatant, canWork: a.canWork, goal: a.goal, bandLeaderId: a.bandLeaderId, inParty: a.inParty, groupType: a.groupType };
  a.caravanEscort = { leaderId: leader.id, role, good };
  a.bandLeaderId = leader.id;
  a.inParty = true;
  a.combatant = (role === 'guard');         // guards hold the line; porters do not
  a.canWork = false;                         // on the road, not at a trade
  a.groupType = (role === 'guard') ? 'warband' : 'hearth';   // warband fights, hearth flees
  leader._caravanEscorts.push(a);
}

// release a caravan's escorts back to civilian life (run ended: home, lost, or TTL).
export function _disbandEscorts(d: Dir, trader: Ag): void {
  if (!trader || !trader._caravanEscorts) return;
  for (const a of trader._caravanEscorts) {
    if (!a) continue;
    const r = a._caravanRestore;
    a.caravanEscort = null;
    a._caravanRestore = null;
    if (r) { a.bandLeaderId = r.bandLeaderId; a.inParty = r.inParty; a.combatant = r.combatant; a.canWork = r.canWork; a.groupType = r.groupType; }
    else { a.bandLeaderId = null; a.inParty = false; a.groupType = null; }
  }
  trader._caravanEscorts = null;
}

// advance dispatched caravans: out → return on reaching the far point; home safe →
// a windfall (the good gets cheaper). A loss is handled in combatEvents (death).
export function _advanceCaravans(d: Dir): void {
  if (!d._caravans || !d._caravans.length) return;
  const C = DIRECTOR.caravan || {};
  const keep = [];
  for (const t of d._caravans) {
    if (!t || !t.alive || !t.caravanRun) { d._disbandEscorts(t); continue; }   // dead/cleared — release escorts
    const R = t.caravanRun;
    const home = R.home || new THREE.Vector3(0, 0, 0);
    if (d.sim.time - R.startedAt > (C.runTTL || 120) && R.phase !== 'return') { R.phase = 'return'; R.target = home; }
    if (R.phase === 'out' && t.pos.distanceTo(R.dest) < 12) { R.phase = 'return'; R.target = home; }
    else if (R.phase === 'return' && t.pos.distanceTo(home) < 16) {
      d._caravanWindfall(t, R.good);                // home safe — plenty
      d._disbandEscorts(t);                         // escorts go home
      t.caravanRun = null;
      continue;
    }
    keep.push(t);
  }
  d._caravans = keep;
}

export function _caravanWindfall(d: Dir, trader: Ag, good: string): void {
  let touched = 0;
  for (const w of d.sim.agents) {
    if (touched >= 8) break;
    if (!w.alive || w.controlled || w.faction !== 'townsfolk' || !w.priceBeliefs || w.priceBeliefs[good] == null) continue;
    w.priceBeliefs[good] = +(w.priceBeliefs[good] * ((DIRECTOR.caravan && DIRECTOR.caravan.windfallMul) || 0.86)).toFixed(2);
    touched++;
  }
  d._note(BEAT.FORTUNE, trader.id, `${trader.name}'s caravan returned laden — ${good} is plentiful in the town.`);
}
