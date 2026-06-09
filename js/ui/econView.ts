// Town & Prices tab: a detailed, read-only economics view rendered from the
// per-world econstats ledger. Per-commodity rows (clearing price vs base with an
// up/down arrow, volume, believed mean ± spread, a scarcity indicator and the
// belief-vs-clearing gap) plus a short recent-trades feed. Browser-only and
// guarded; signature-cached so the DOM is only rewritten when something visibly
// changed (the dominant per-frame cost of a live HUD panel).

import { allCommodityStats, recentTrades, econTotals } from '../sim/econstats.js';
import type { EntityId } from '../../types/sim.js';

// simulation.js is a later cluster — typed as the minimal read surface used here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any; /* Simulation — ported in a later cluster */

// reuse the econstats return shapes so the view never drifts from the ledger.
type CommodityRow = NonNullable<ReturnType<typeof allCommodityStats>[number]>;
type FeedRow = ReturnType<typeof recentTrades>[number];
type Totals = ReturnType<typeof econTotals>;

const ARROW: Record<number, string> = { 1: '▲', '-1': '▼', 0: '·' };
const ARROW_COL: Record<number, string> = { 1: '#e0894e', '-1': '#7fd18a', 0: '#9aa6b2' };

// scarcity ratio -> a short word + colour. >1.15 scarce (dear), <0.85 glut (cheap).
function scarcityTag(s: number): { label: string; col: string } {
  if (s >= 1.15) return { label: 'scarce', col: '#e0894e' };
  if (s <= 0.85) return { label: 'glut', col: '#7fd18a' };
  return { label: 'steady', col: '#9aa6b2' };
}

export class EconView {
  el: HTMLElement | null;
  getSim: (() => Sim | null) | null;
  _sig: string | null;
  _nameCache: Map<EntityId, string>;
  _erred?: boolean;

  // mountEl: the tab body container to fill. getSim: () => Simulation | null
  // (so the view survives world rebuilds — it just reads whatever sim is current).
  constructor(mountEl: HTMLElement | null, getSim: (() => Sim | null) | null) {
    this.el = mountEl;
    this.getSim = getSim;
    this._sig = null;
    this._nameCache = new Map();   // id -> short name (refreshed lazily)
  }

  _nameOf(id: EntityId | undefined): string {
    if (id == null) return '?';
    const sim = this.getSim && this.getSim();
    const a = sim && sim.agentsById && sim.agentsById.get(id);
    if (a) { this._nameCache.set(id, a.name); return a.name; }
    return this._nameCache.get(id) || '?';
  }

  render(): void {
    if (!this.el) return;
    try {
      const rows = allCommodityStats();
      const feed = recentTrades(8);
      const totals = econTotals();

      // signature: only redraw when a visible number changed. Round to keep the
      // cache from thrashing on sub-pixel belief drift every frame.
      const sig = `${totals.trades}|` + rows.map((r) =>
        `${r.commodity}:${r.clearAvg.toFixed(1)}:${r.beliefMean.toFixed(1)}:${r.scarcity.toFixed(2)}:${r.volume.toFixed(0)}`
      ).join(',') + '|' + feed.map((f) => `${f.commodity}${f.price.toFixed(1)}`).join(',');
      if (sig === this._sig) return;
      this._sig = sig;

      this.el.innerHTML = this._html(rows, feed, totals);
    } catch (e) {
      // never let a HUD redraw take down the frame loop
      if (!this._erred) { console.warn('EconView render failed', e); this._erred = true; }
    }
  }

  _html(rows: CommodityRow[], feed: FeedRow[], totals: Totals): string {
    if (!rows.length) {
      return `<div class="econ-empty">No trades yet — the market hasn't cleared.
        Wander the town and watch prices form.</div>` + this._css();
    }

    const body = rows.map((r) => {
      const ar = ARROW[r.trend] || ARROW[0];
      const arc = ARROW_COL[r.trend] || ARROW_COL[0];
      const sc = scarcityTag(r.scarcity);
      const gap = r.beliefGap;
      const gapCol = gap > 0.25 ? '#e0894e' : gap < -0.25 ? '#7fd18a' : '#9aa6b2';
      const gapTxt = `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}`;
      return `<tr>
        <td class="ec-name">${r.commodity}</td>
        <td class="ec-clear"><b style="color:${arc}">${ar}</b> ${r.clearAvg.toFixed(1)}<span class="ec-base">/${r.base}</span></td>
        <td class="ec-vol">${Math.round(r.volume)}g<span class="ec-sub">×${r.n}</span></td>
        <td class="ec-bel">${r.beliefMean.toFixed(1)}<span class="ec-sub">±${r.beliefSpread.toFixed(1)}</span></td>
        <td class="ec-sc" style="color:${sc.col}">${sc.label}<span class="ec-sub">${r.scarcity.toFixed(2)}×</span></td>
        <td class="ec-gap" style="color:${gapCol}">${gapTxt}</td>
      </tr>`;
    }).join('');

    const feedHtml = feed.length ? feed.slice().reverse().map((f) =>
      `<div class="ec-feed-row"><span class="ec-fc">${f.commodity}</span>
       <span class="ec-fp">${f.price.toFixed(1)}g</span>
       <span class="ec-fn">${this._nameOf(f.sellerId)} → ${this._nameOf(f.buyerId)}</span></div>`
    ).join('') : `<div class="ec-feed-row ec-sub">awaiting trades…</div>`;

    return `
      <table class="econ-tbl">
        <thead><tr>
          <th>good</th><th>clearing</th><th>volume</th>
          <th>believed</th><th>scarcity</th><th title="belief minus clearing">gap</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="econ-totals">${totals.trades} trades · ${Math.round(totals.volume)}g turned over · ${totals.commodities} goods</div>
      <div class="econ-feed-ttl">recent trades</div>
      <div class="econ-feed">${feedHtml}</div>
      ${this._css()}`;
  }

  _css(): string {
    // scoped inline styles; injected once per redraw (cheap, cache-gated above)
    return `<style>
      .econ-tbl { width: 100%; border-collapse: collapse; font-size: 11px; color: #cbd5e1; }
      .econ-tbl th { text-align: left; font-weight: 600; color: #8a96a4; padding: 2px 4px;
        border-bottom: 1px solid rgba(255,255,255,.12); font-size: 10px; }
      .econ-tbl td { padding: 3px 4px; border-bottom: 1px solid rgba(255,255,255,.05); }
      .econ-tbl .ec-name { color: #e8e2cf; text-transform: capitalize; }
      .ec-base { color: #6f7b88; }
      .ec-sub { color: #6f7b88; margin-left: 3px; font-size: 10px; }
      .econ-totals { margin-top: 6px; font-size: 10px; color: #8a96a4; }
      .econ-feed-ttl { margin-top: 8px; font-size: 10px; color: #8a96a4;
        border-top: 1px solid rgba(255,255,255,.12); padding-top: 6px; }
      .econ-feed { margin-top: 3px; }
      .ec-feed-row { display: flex; gap: 6px; font-size: 11px; align-items: baseline; line-height: 1.5; }
      .ec-fc { width: 44px; color: #e8e2cf; text-transform: capitalize; }
      .ec-fp { width: 40px; color: #ffd36b; }
      .ec-fn { color: #8a96a4; font-size: 10px; }
      .econ-empty { font-size: 11px; color: #8a96a4; line-height: 1.5; }
    </style>`;
  }
}
