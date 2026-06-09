// Minds browser: a clickable list of every agent. Selecting one shows its full
// panel (needs, inventory, price beliefs, and the Theory-of-Mind belief table)
// by reusing the Inspector's renderer — so you can read any agent's mind without
// physically hunting them down. Cycle with [ and ] (works under pointer-lock).

import type { Agent, EntityId } from '../../types/sim.js';
import type { Inspector } from './inspector.js';

export class MindBrowser {
  listEl: HTMLElement;
  detailEl: HTMLElement;
  inspector: Inspector;
  agents: Agent[];
  selId: EntityId | null;
  _sig: string;

  constructor(listEl: HTMLElement, detailEl: HTMLElement, inspector: Inspector) {
    this.listEl = listEl;
    this.detailEl = detailEl;
    this.inspector = inspector;
    this.agents = [];
    this.selId = null;
    this._sig = '';

    // click a row to select
    this.listEl.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const m = target ? target.closest<HTMLElement>('.m') : null;
      if (m && m.dataset.id != null) this.selId = +m.dataset.id;
    });
    // cycle selection by keyboard (usable while the cursor is locked)
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code === 'BracketLeft') this.cycle(-1);
      else if (e.code === 'BracketRight') this.cycle(1);
    });
  }

  setAgents(agents: Agent[] | null): void {
    this.agents = agents || [];
    const first = this.agents.find((a) => !a.controlled);
    this.selId = first ? first.id : (this.agents[0]?.id ?? null);
    this._sig = '';
  }

  cycle(dir: number): void {
    if (!this.agents.length) return;
    let i = this.agents.findIndex((a) => a.id === this.selId);
    if (i < 0) i = 0;
    i = (i + dir + this.agents.length) % this.agents.length;
    this.selId = this.agents[i].id;
  }

  update(): void {
    if (!this.agents.length) return;
    if (this.selId == null || !this.agents.some((a) => a.id === this.selId)) {
      const first = this.agents.find((a) => !a.controlled);
      this.selId = first ? first.id : this.agents[0].id;
    }

    // rebuild the list only when membership/aliveness/selection changes
    // (so it doesn't reset scroll position every frame)
    const sig = this.selId + '|' + this.agents.map((a) => a.id + (a.alive ? '1' : '0')).join(',');
    if (sig !== this._sig) {
      this._sig = sig;
      this.listEl.innerHTML = this.agents.map((a) => {
        const cls = `m${a.id === this.selId ? ' sel' : ''}${a.alive ? '' : ' dead'}`;
        const col = `#${a.profColor().toString(16).padStart(6, '0')}`;
        return `<div class="${cls}" data-id="${a.id}"><span class="dot" style="background:${col}"></span>${a.name}</div>`;
      }).join('');
    }

    // detail refreshes every frame so beliefs are live
    const sel = this.agents.find((a) => a.id === this.selId);
    this.detailEl.innerHTML = sel ? this.inspector.renderAgent(sel) : '';
  }
}
