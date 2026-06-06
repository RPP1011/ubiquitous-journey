// PartyHUD: a small self-injecting panel listing the player's companions with a
// live health bar each. Mirrors the QuestLog's self-styling approach (no
// index.html edits). Read-only — recruiting/dismissing happens in dialogue.

import { TUNE } from '../constants.js';

const PANEL_ID = 'partyHud';

export class PartyHUD {
  constructor() {
    this.party = null;
    this._sig = '';
    this._injectStyles();
    this._build();
  }

  setParty(p) { this.party = p; this._sig = ''; }

  _build() {
    let el = document.getElementById(PANEL_ID);
    if (!el) { el = document.createElement('div'); el.id = PANEL_ID; document.body.appendChild(el); }
    this.el = el;
  }

  _injectStyles() {
    if (document.getElementById('partyHudStyles')) return;
    const s = document.createElement('style');
    s.id = 'partyHudStyles';
    s.textContent = `
      #${PANEL_ID} { position: fixed; left: 16px; bottom: 64px; width: 196px; z-index: 6;
        display: none; flex-direction: column; gap: 5px; pointer-events: none;
        font-family: "Segoe UI", system-ui, sans-serif; }
      #${PANEL_ID} .ph-head { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase;
        color: #9aa6b2; margin-bottom: 1px; }
      #${PANEL_ID} .ph-row { background: rgba(10,13,18,.8); border: 1px solid rgba(255,255,255,.12);
        border-radius: 6px; padding: 5px 8px; }
      #${PANEL_ID} .ph-name { font-size: 12px; color: #e8e2cf; display: flex; justify-content: space-between; }
      #${PANEL_ID} .ph-name .cls { color: #8fb6e0; font-size: 10px; }
      #${PANEL_ID} .ph-bar { height: 5px; background: rgba(255,255,255,.12); border-radius: 3px;
        overflow: hidden; margin-top: 4px; }
      #${PANEL_ID} .ph-bar i { display: block; height: 100%; background: linear-gradient(#cf3b2c,#7d241a); }
    `;
    document.head.appendChild(s);
  }

  render() {
    const members = this.party ? this.party.members : [];
    if (!members.length) { this.el.style.display = 'none'; this._sig = ''; return; }
    this.el.style.display = 'flex';

    // signature keyed on roster + each member's hp bucket, to avoid thrashing DOM
    const sig = members.map((m) => `${m.id}:${Math.round(m.fighter.health)}`).join(',');
    if (sig === this._sig) return;
    this._sig = sig;

    const rows = members.map((m) => {
      const frac = Math.max(0, m.fighter.health / TUNE.maxHealth) * 100;
      const cls = m.progression && m.progression.primaryClass && m.progression.primaryClass();
      const tag = cls ? `${cls.name} ${cls.level}` : (m.profession || '');
      return `<div class="ph-row">
        <div class="ph-name"><span>${m.name}</span><span class="cls">${tag}</span></div>
        <div class="ph-bar"><i style="width:${frac}%"></i></div>
      </div>`;
    }).join('');
    this.el.innerHTML = `<div class="ph-head">Party (${members.length})</div>${rows}`;
  }
}
