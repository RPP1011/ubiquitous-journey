// FAITH — belief-powered gods (Discworld's *Small Gods*). The whole sim runs on a
// belief table, so a god whose POWER is literally its number of believers is a
// native fit. Each pass the faithful PROSELYTISE (convert nearby faithless souls),
// some LAPSE (doubt), and every god works MIRACLES on its flock (heal + courage)
// scaled by its power — the feedback loop that makes belief matter:
//
//     belief → power → miracles → the faithful survive & thrive → more belief
//
// A god whose flock is wiped becomes a "small god" — its single last believer never
// lapses, so the faith can smoulder and be REVIVED by a prophet (the director can
// anoint one). An agent's creed lives on `a.faith` (a god name, or falsy = none).
// Touches no gold; fully guarded (never throws/stalls the fixed tick).

import { FAITH } from './simconfig.js';
import { rng } from './rng.js';
import { TUNE } from '../constants.js';

// `sim` (the owning Simulation — wave-2, still .js) and the believer Agents (via their
// `faith` creed flag) are typed opaquely on purpose; behaviour is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;

export class Faith {
  sim: Sim;
  _acc: number;
  _macc: number;
  _booted: boolean;
  stats: Record<string, number>;
  _tier: Record<string, string>;

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this._macc = 0;
    this._booted = false;
    this.stats = { conversions: 0, miracles: 0, apostasies: 0, revivals: 0 };
    this._tier = {};          // god -> last chronicled tier ('small'|'rising'|'great')
  }

  // living, free (non-controlled) townsfolk who hold a given creed.
  believers(god: string): Ag[] {
    return this.sim.agents.filter((a: Ag) => a.alive && a.autonomous && a.faith === god);
  }
  power(god: string): number { return this.believers(god).length; }

  tick(ctx: unknown, dt: number): void {
    try {
      if (!this.sim._spawned) return;   // a real town only (not bare test sub-sims)
      if (!this._booted) this._bootstrap();
      this._acc += dt;
      if (this._acc >= FAITH.tickEvery) { this._acc = 0; this._spread(); this._doubt(); }
      this._macc += dt;
      if (this._macc >= FAITH.miracleEvery) { this._macc = 0; this._miracles(); }
    } catch { /* never throw on the tick */ }
  }

  // anoint a starting flock for each god once townsfolk exist, so several faiths
  // contend from the outset (the director revives any that later dwindle).
  // EACH GOD BOOTS IN ITS OWN TOWN (the pluralism fix): conversion is proximity-bound
  // (`convertRange`), so geography is the one moat a smaller god has — seeded into a
  // shared pool, whichever god got an early lead swept the whole map (measured twice:
  // 126/140 Blind Io, then 108/140 Om). Round-robin the pantheon across townIds and
  // each town grows its own congregation; the borders stay contested, not the heartland.
  _bootstrap(): void {
    const folk = this._faithless();
    if (!folk.length) return;                 // town not spawned yet — try next tick
    this._booted = true;
    const towns = [...new Set(folk.map((a: any) => a.townId).filter((t: unknown) => t != null))];
    const gods = FAITH.gods;
    let g = 0;
    for (const god of gods) {
      const home = towns.length ? towns[g % towns.length] : null;
      const pool = home != null ? folk.filter((a: any) => a.townId === home && !a.faith) : folk.filter((a: any) => !a.faith);
      for (let k = 0; k < (FAITH.bootFlock || 1) && k < pool.length; k++) pool[k].faith = god;
      g++;
    }
  }

  _faithless(): Ag[] {
    return this.sim.agents.filter((a: any) => a.alive && a.autonomous && a.faction === 'townsfolk' && !a.faith);
  }

  // PROSELYTISE: each believer may win one nearby faithless soul. Conversion odds
  // rise with the god's power (a thriving faith is contagious — bandwagon) — but
  // SUB-LINEARLY (√flock): each believer already rolls independently, so a linear
  // per-believer bonus made total pull ~flock² and ONE god always swept the town
  // (the Blind-Io monoculture: every digest read "keeps the faith of Blind Io").
  // √flock keeps a great god ~2-3× a small god's pull, not ~30× — the pantheon contends.
  _spread(): void {
    const range2 = (FAITH.convertRange || 6) ** 2;
    for (const god of FAITH.gods) {
      const flock = this.believers(god);
      if (!flock.length) continue;            // a dead faith can't spread itself (needs a prophet)
      const chance = Math.min(0.9, (FAITH.convertChance || 0) + Math.sqrt(flock.length) * (FAITH.powerConvertBonus || 0));
      for (const b of flock) {
        if (rng() > chance) continue;
        // nearest faithless townsperson within range
        let best = null, bd = range2;
        for (const o of this.sim.agents) {
          if (!o.alive || o.controlled || o.faith || o.faction !== 'townsfolk') continue;
          const d = b.pos.distanceToSquared(o.pos);
          if (d < bd) { bd = d; best = o; }
        }
        if (best) { best.faith = god; this.stats.conversions++; }
      }
      this._noteTier(god);
    }
  }

  // DOUBT: believers lapse at random — EXCEPT a small god's final believer, who
  // stays loyal (so the faith survives as an ember and can be revived). CROWDING
  // DOUBT (the monoculture's other half): a god grown great holds many believers in
  // name only, and the nominal lapse faster — doubt scales up with flock size past
  // `crowdDoubtAt`, the self-limiting term the runaway bandwagon lacked (Small Gods:
  // belief spread thin is belief easily lost).
  _doubt(): void {
    for (const god of FAITH.gods) {
      const flock = this.believers(god);
      if (flock.length <= (FAITH.smallGodAt || 1)) continue;   // protect the last of the faithful
      const lapse = (FAITH.doubtChance || 0) * (1 + flock.length / (FAITH.crowdDoubtAt || 25));
      for (const b of flock) {
        if (rng() < lapse) { b.faith = null; this.stats.apostasies++; }
      }
      this._noteTier(god);
    }
  }

  // MIRACLES: each god mends and heartens its flock, scaled by how many believe —
  // a great god's faithful are markedly hardier, which is WHY belief is worth
  // spreading. Uses no gold; only restores health and quells fear.
  _miracles(): void {
    const maxH = (TUNE && TUNE.maxHealth) || 100;
    for (const god of FAITH.gods) {
      const flock = this.believers(god);
      const power = flock.length;
      if (power <= 0) continue;
      const scale = Math.min(1, power / (FAITH.greatGodAt || 8));   // 0..1 by flock size
      const heal = (FAITH.miracleHeal || 0) * (0.4 + 0.6 * scale);
      // HOLY GROUND: a god's miracles work harder on faithful near its STANDING shrine
      // (the congregation's civic build, construction.shrinesFor — a razed shrine confers
      // nothing). This is WHY a flock raises one. Guarded; no shrines ⇒ no boost.
      let shrines: { pos: { x: number; z: number } }[] = [];
      try { shrines = (this.sim.buildSites && this.sim.buildSites.shrinesFor) ? this.sim.buildSites.shrinesFor(god) : []; } catch { /* */ }
      const r2 = (FAITH.shrineRange || 14) ** 2;
      const boost = FAITH.shrineMiracleBoost || 1.6;
      let worked = false;
      for (const b of flock) {
        let mul = 1;
        if (shrines.length && b.pos) {
          for (const sh of shrines) {
            const dx = b.pos.x - sh.pos.x, dz = b.pos.z - sh.pos.z;
            if (dx * dx + dz * dz <= r2) { mul = boost; break; }
          }
        }
        const f = b.fighter;
        if (f && f.alive && f.health < maxH) { f.health = Math.min(maxH, f.health + heal * mul); worked = true; }
        if (b.mood && b.mood.fear > 0) { b.mood.fear = Math.max(0, b.mood.fear - (FAITH.miracleCourage || 0) * (0.4 + 0.6 * scale) * mul); }
      }
      if (worked) this.stats.miracles++;
    }
  }

  // ANOINT a prophet (the director's Small-Gods instigator): convert a charismatic
  // soul to a god — by default the WEAKEST faith, reviving a dwindling/dead god.
  // Returns the chosen {prophet, god} or null. Guarded.
  anointProphet(agent: Ag, preferGod?: string): { god: string; reviving: boolean } | null {
    try {
      if (!agent || !agent.alive) return null;
      let god = preferGod;
      if (!god) {                                  // pick the faith most in need of a prophet
        let lo = Infinity;
        for (const g of FAITH.gods) { const p = this.power(g); if (p < lo) { lo = p; god = g; } }
      }
      if (!god) return null;
      const reviving = this.power(god) === 0;
      agent.faith = god;
      if (reviving) this.stats.revivals++;
      this._noteTier(god);
      return { god, reviving };
    } catch { return null; }
  }

  // chronicle a god crossing a tier (great / small), once per transition.
  _noteTier(god: string): void {
    try {
      const p = this.power(god);
      const tier = p >= (FAITH.greatGodAt || 8) ? 'great' : p <= (FAITH.smallGodAt || 1) ? 'small' : 'rising';
      if (this._tier[god] === tier) return;
      const was = this._tier[god];
      this._tier[god] = tier;
      const ch = this.sim.chronicle;
      if (!ch || !ch.note || was === undefined) return;   // don't announce the initial classification
      if (tier === 'great') ch.note('faith', -10, `${god} has become a great god — ${p} now keep the faith.`);
      else if (tier === 'small') ch.note('faith', -10, `${god} has dwindled to a small god — only ${p} still believe.`);
    } catch { /* never throw */ }
  }
}
