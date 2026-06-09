// Inventory: a self-injecting HUD panel showing the player's carried goods as a
// grid of slots, plus gold, relics and total pack value. Mirrors the QuestLog /
// PartyHUD self-styling approach (no index.html edits) and toggles with a key.
// Reads ground truth off the player Agent's `inventory` object (keyed by
// COMMODITIES) — the same store NPCs trade against. Clicking a usable item
// (potion) consumes it through the supplied `onUse` callback so the panel never
// reaches into combat/economy logic itself; it stays a read-mostly view.

import { COMMODITIES, BASE_PRICE } from '../sim/simconfig.js';
import type { Agent } from '../../types/sim.js';

const PANEL_ID = 'inventory';

type UseHandler = (commodity: string, player: Agent) => void;

// presentation-only metadata: a glyph + one-line flavour per commodity. Anything
// not listed still renders with a neutral glyph, so adding a commodity to
// COMMODITIES never breaks this panel.
const ITEM_META = {
  food:   { icon: '🍖', desc: 'Rations. NPCs eat it; you can sell it.' },
  wood:   { icon: '🪵', desc: 'Timber felled from forests.' },
  ore:    { icon: '⛏️', desc: 'Raw ore dug from mines.' },
  tool:   { icon: '🔧', desc: 'Wears with work; smiths forge more.' },
  herb:   { icon: '🌿', desc: 'Foraged from meadows.' },
  potion: { icon: '🧪', desc: 'Click to drink — restores health.' },
};
const USABLE = new Set(['potion']);

export class InventoryPanel {
  player: Agent | null;
  onUse: UseHandler | null;
  visible: boolean;
  _sig: string;
  el!: HTMLElement;

  constructor(player?: Agent | null) {
    this.player = player || null;
    this.onUse = null;          // (commodity, player) => void; wired by main.js
    this.visible = false;
    this._sig = '';
    this._injectStyles();
    this._build();
  }

  setPlayer(p: Agent | null): void { this.player = p; this._sig = ''; }
  setUseHandler(fn: UseHandler | null): void { this.onUse = fn; }

  toggle(): void { this.visible ? this.hide() : this.show(); }
  show(): void { this.visible = true; this.el.style.display = 'block'; this._sig = ''; this.render(); }
  hide(): void { this.visible = false; this.el.style.display = 'none'; }

  // ---- DOM scaffold --------------------------------------------------------
  _build(): void {
    let el = document.getElementById(PANEL_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = PANEL_ID;
      document.body.appendChild(el);
    }
    this.el = el;
    this.el.style.display = 'none';
    // click a usable slot to consume it; hand off to the wired callback
    this.el.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const cell = target ? target.closest<HTMLElement>('.i-slot.use') : null;
      if (!cell || !this.onUse) return;
      const player = this.player;
      if (!player) return;
      const item = cell.dataset.item;
      if (item == null) return;
      this.onUse(item, player);
      this._sig = '';            // force a redraw next frame after the count drops
      this.render();
    });
  }

  _injectStyles(): void {
    if (document.getElementById('inventoryStyles')) return;
    const s = document.createElement('style');
    s.id = 'inventoryStyles';
    s.textContent = `
      #${PANEL_ID} { position: fixed; right: 16px; bottom: 16px; width: 280px; z-index: 6;
        background: rgba(10,13,18,.9); border: 1px solid rgba(255,255,255,.14);
        border-radius: 8px; padding: 0; color: #dfe6ee; font-size: 12px;
        font-family: "Segoe UI", system-ui, sans-serif;
        backdrop-filter: blur(2px); box-shadow: 0 6px 22px rgba(0,0,0,.5); pointer-events: auto; }
      #${PANEL_ID} .i-head { padding: 8px 12px; font-size: 11px; letter-spacing: 1.5px;
        text-transform: uppercase; color: #cbd5e1; background: rgba(255,255,255,.05);
        border-bottom: 1px solid rgba(255,255,255,.1); display: flex; justify-content: space-between; align-items: center; }
      #${PANEL_ID} .i-head .hot { color: #6f7b88; border: 1px solid rgba(255,255,255,.15);
        border-radius: 3px; padding: 0 4px; font-size: 10px; }
      #${PANEL_ID} .i-purse { display: flex; gap: 14px; padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,.08); }
      #${PANEL_ID} .i-purse .p { color: #aeb8c2; }
      #${PANEL_ID} .i-purse .p b { color: #e0c46a; font-size: 13px; }
      #${PANEL_ID} .i-purse .p.relic b { color: #b07be0; }
      #${PANEL_ID} .i-grid { display: grid; grid-template-columns: repeat(3, 1fr);
        gap: 6px; padding: 10px 12px; }
      #${PANEL_ID} .i-slot { position: relative; aspect-ratio: 1; border-radius: 6px;
        border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.03);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 2px; transition: background .1s, outline .1s; }
      #${PANEL_ID} .i-slot.empty { opacity: .35; }
      #${PANEL_ID} .i-slot.use { cursor: pointer; }
      #${PANEL_ID} .i-slot.use:hover { background: rgba(127,209,138,.16);
        outline: 1px solid #7fd18a; }
      #${PANEL_ID} .i-slot .glyph { font-size: 22px; line-height: 1; }
      #${PANEL_ID} .i-slot .qty { position: absolute; right: 4px; bottom: 3px;
        font-size: 11px; font-weight: 700; color: #f0e6cf;
        text-shadow: 0 1px 2px #000; }
      #${PANEL_ID} .i-slot .name { font-size: 9px; text-transform: uppercase;
        letter-spacing: .5px; color: #8a96a3; }
      #${PANEL_ID} .i-slot .val { position: absolute; left: 4px; top: 3px;
        font-size: 9px; color: #6f7b88; }
      #${PANEL_ID} .i-foot { padding: 6px 12px 9px; border-top: 1px solid rgba(255,255,255,.08);
        color: #8a96a3; font-size: 11px; display: flex; justify-content: space-between; }
      #${PANEL_ID} .i-foot b { color: #e0c46a; }
    `;
    document.head.appendChild(s);
  }

  // ---- render --------------------------------------------------------------
  render(): void {
    if (!this.visible) return;
    const p = this.player;
    if (!p) { this.el.innerHTML = `<div class="i-head"><span>Inventory</span><span class="hot">B</span></div>
      <div class="i-grid"><div class="i-slot empty"></div></div>`; return; }

    // relics is a running count at runtime (number); the shared Agent type carries
    // it loosely, so read it as a number locally for the purse line.
    const relics = ((p.relics as number | undefined) || 0) | 0;

    // signature so we don't thrash innerHTML every frame (also preserves hover)
    const sig = COMMODITIES.map((c) => this._count(p, c)).join(',') +
      `|${Math.round(p.gold)}|${relics}`;
    if (sig === this._sig) return;
    this._sig = sig;

    let packValue = 0;
    const slots = COMMODITIES.map((c) => {
      const qty = this._count(p, c);
      const meta = ITEM_META[c as keyof typeof ITEM_META] || { icon: '❔', desc: '' };
      const usable = USABLE.has(c) && qty > 0;
      const price = BASE_PRICE[c as keyof typeof BASE_PRICE] || 0;
      packValue += price * qty;
      const cls = `i-slot${qty <= 0 ? ' empty' : ''}${usable ? ' use' : ''}`;
      const title = `${c} — ${meta.desc}${price ? ` (~${price}g each)` : ''}`;
      return `<div class="${cls}" data-item="${c}" title="${title}">
        <span class="val">${price ? price + 'g' : ''}</span>
        <span class="glyph">${meta.icon}</span>
        <span class="name">${c}</span>
        <span class="qty">${qty > 0 ? qty : ''}</span>
      </div>`;
    }).join('');

    const relic = relics > 0
      ? `<span class="p relic">Relics <b>${relics}</b></span>` : '';

    this.el.innerHTML = `
      <div class="i-head"><span>Inventory</span><span class="hot">B</span></div>
      <div class="i-purse"><span class="p">Gold <b>${Math.round(p.gold)}</b></span>${relic}</div>
      <div class="i-grid">${slots}</div>
      <div class="i-foot"><span>Pack value</span><b>${Math.round(packValue)}g</b></div>`;
  }

  // food is tracked as a float (partial rations); everything else is whole units
  _count(p: Agent, c: string): number {
    const raw = p.inventory ? (p.inventory[c] || 0) : 0;
    return Math.floor(raw);
  }
}
