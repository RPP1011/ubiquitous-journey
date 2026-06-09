// MARKET ARBITRAGE — agents EXPLOIT the Gazette's price reports. A trader standing
// near a market reads that a good is DEAR in another town, and if it's holding a
// surplus of that good, it sets out to HAUL it there and sell at the better price.
// Because trade is localized (it clears AT a market, see market.js), simply BEING at
// the dear town's market with the goods earns the higher clearing price — the profit
// is emergent, not minted. Crossing the wilds is a real risk (a lone hauler can be
// ambushed), tying arbitrage to the same road danger as caravans.
//
// Deterministic + headless-safe (Math.random + state). Reuses the goal/act path (an
// `arbitrage` goal decide.js routes + act.js walks) and the existing market auction.

import { ARBITRAGE, ECON } from './simconfig.js';
import type { ArbitrageState, FullCtx, EntityId } from '../../types/sim.js';

// The (still-.js) Simulation is reached into loosely (agents/towns/gazette/world/
// chronicle + a wide untyped tail), so a precise type would be all-optional noise.
type Sim = any;   // js Simulation — justified loose type
type Ag = any;    // js Agent off the roster — justified loose type

// Per-good arbitrage picture: which towns the good runs DEAR in vs GLUTted in.
interface GoodInfo { dear: Set<number>; glut: Set<number>; }

export class Arbitrage {
  sim: Sim;
  _acc: number;
  _readAcc: number;
  stats: { taken: number; sold: number; gaveUp: number };

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this._readAcc = 0;
    this.stats = { taken: 0, sold: 0, gaveUp: 0 };
  }

  _haulers(): Ag[] { return this.sim.agents.filter((a: Ag) => a && a.alive && a.arbitrage); }

  tick(ctx: FullCtx | null, dt: number): void {
    try {
      if (!this.sim._spawned || !ARBITRAGE || !ARBITRAGE.enabled) return;
      this._acc += dt;
      if (this._acc < (ARBITRAGE.tickEvery || 3)) return;
      const step = this._acc; this._acc = 0;
      for (const a of this._haulers()) this._supervise(a, step);
      this._readAcc += step;
      if (this._readAcc >= (ARBITRAGE.readEvery || 9)) { this._readAcc = 0; this._readingRound(); }
    } catch { /* never throw on the tick */ }
  }

  // a hauler that has sold its load (or run out of time, or whose dear town vanished)
  // gives up the run and returns to ordinary town life.
  _supervise(a: Ag, step: number): void {
    const ar = a.arbitrage; if (!ar) return;
    const sim = this.sim;
    if (sim.time > ar.expire || !sim.towns || !sim.towns[ar.destTownId]) { this._finish(a); return; }
    const left = a.sellQty(ar.good);
    if (left < 1) { this._finish(a); return; }                 // whole load offloaded
    // once AT the dear market, give it a bounded dwell to sell what the market will
    // take — a high price BELIEF doesn't guarantee hungry buyers, so it sells what it
    // can and heads home rather than waiting out the clock on a bad tip.
    if (a.pos.distanceTo(ar.destPos) <= (ECON.marketRange || 18)) {
      ar.dwell = (ar.dwell || 0) + step;
      if (ar.dwell >= (ARBITRAGE.sellDwell || 14)) this._finish(a);
    }
  }

  // settle the run: a profit if it offloaded ANY surplus at the dear market (it sold
  // above its home price), else a wasted trip (a bad tip — realistic).
  _finish(a: Ag): void {
    const ar = a.arbitrage; if (!ar) { return; }
    const sold = (ar.startSurplus || 0) - a.sellQty(ar.good);
    if (sold >= 1) this.stats.sold++; else this.stats.gaveUp++;
    a.arbitrage = null;
  }

  _readingRound(): void {
    const sim = this.sim;
    if (this._haulers().length >= (ARBITRAGE.maxConcurrent || 2)) return;
    // read the recent MARKET reports into a per-good picture: where each good runs
    // DEAR (a place to sell) and where it's GLUTTED (a place to flee with surplus).
    const arts = (sim.gazette && sim.gazette.recent) ? sim.gazette.recent(20) : [];
    const info: Record<string, GoodInfo> = {};   // good -> { dear:Set<townId>, glut:Set<townId> }
    const seen = new Set<string>();
    for (const art of arts) {
      const b = art.brief; if (!b || b.kind !== 'market' || b.originTown == null) continue;
      const k = `${b.originTown}:${b.good}:${b.wanted ? 'd' : 'g'}`; if (seen.has(k)) continue; seen.add(k);
      const inf = info[b.good] || (info[b.good] = { dear: new Set(), glut: new Set() });
      (b.wanted ? inf.dear : inf.glut).add(b.originTown);
    }
    if (!Object.keys(info).length) return;

    const r2 = (ARBITRAGE.readRange || 22) ** 2;
    const minS = ARBITRAGE.minSurplus || 3;
    for (const a of sim.agents) {
      if (this._haulers().length >= (ARBITRAGE.maxConcurrent || 2)) break;
      if (!this._eligible(a)) continue;
      if (!this._nearAMarket(a, r2)) continue;
      // find a good this trader holds in surplus, and a town worth hauling it to:
      // somewhere it's DEAR (best), or ANY other town if it's glutted right here.
      let pick: { good: string; destTownId: number } | null = null;
      for (const good in info) {
        if (a.sellQty(good) < minS) continue;     // real sellable surplus (over the keep-reserve)
        const inf = info[good];
        let dest: number | null = null;
        // ONLY haul to a town with REAL unmet demand for this good (buyers > sellers)
        // — chasing a mere glut elsewhere is futile when every town oversupplies.
        for (const td of inf.dear) if (td !== a.townId) { dest = td; break; }
        if (dest != null && sim.towns && sim.towns[dest]) { pick = { good, destTownId: dest }; break; }
      }
      if (!pick) continue;
      if (Math.random() > (ARBITRAGE.takeChance || 0.5)) continue;
      this._take(a, pick);
    }
  }

  _eligible(a: Ag): boolean {
    return a && a.alive && a.autonomous && a.faction === 'townsfolk' &&
      !a.arbitrage && !a.bounty && !a.watch && !a.reporter && !a.inParty && !a.expedition && !a.caravanRun && !a.spy;
  }

  _nearAMarket(a: Ag, r2: number): boolean {
    try {
      const m = this.sim.world && this.sim.world.nearest ? this.sim.world.nearest('market', a.pos) : null;
      return !!m && a.pos.distanceToSquared(m.pos) <= r2;
    } catch { return false; }
  }

  _take(a: Ag, edge: { good: string; destTownId: number }): void {
    const sim = this.sim;
    const dest = sim.towns[edge.destTownId];
    const arb: ArbitrageState = { good: edge.good, destTownId: edge.destTownId, destPos: dest.center, startSurplus: a.sellQty(edge.good), dwell: 0, expire: sim.time + (ARBITRAGE.ttl || 150) };
    a.arbitrage = arb;
    this.stats.taken++;
    this._note(a.id, `${a.name} read of dear ${edge.good} in ${dest.name || 'another town'} and set out to sell there.`);
  }

  _release(a: Ag, gaveUp: boolean): void {
    if (!a) return;
    a.arbitrage = null;
    if (gaveUp) this.stats.gaveUp++;
  }

  _note(id: EntityId, text: string): void { try { if (this.sim.chronicle && this.sim.chronicle.note) this.sim.chronicle.note('press', id, text); } catch { /* */ } }

  dispose(): void { for (const a of this._haulers()) this._release(a, false); }
}
