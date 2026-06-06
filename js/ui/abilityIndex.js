// Ability Index: a browse panel for every ability that currently EXISTS in the
// world — what it does, how it's delivered, who holds it, and roughly when it
// first appeared. Abilities are minted per-agent at class tier milestones (hand-
// authored catalog specs + procedurally generated ones), so this is the window
// onto the emergent ability ecosystem. Self-injecting + signature-cached, like
// the Class Codex; reads agents off the live sim each frame. Toggles with a key.

import { isMelee } from '../rpg/abilities/ir.js';

const PANEL_ID = 'abilityIndex';

export class AbilityIndex {
  constructor(getSim) {
    this.getSim = getSim || (() => null);
    this.visible = false;
    this._sig = '';
    this._firstSeen = new Map();   // abilityId -> sim time first observed (a proxy for "when made")
    this._lastNow = 0;             // for detecting a world rebuild (time resets to 0)
    this._injectStyles();
    this._build();
  }

  toggle() { this.visible ? this.hide() : this.show(); }
  show() { this.visible = true; this.el.style.display = 'block'; this._sig = ''; this.render(); }
  hide() { this.visible = false; this.el.style.display = 'none'; }

  _build() {
    let el = document.getElementById(PANEL_ID);
    if (!el) { el = document.createElement('div'); el.id = PANEL_ID; document.body.appendChild(el); }
    this.el = el; this.el.style.display = 'none';
  }

  _injectStyles() {
    if (document.getElementById('abilityIndexStyles')) return;
    const s = document.createElement('style');
    s.id = 'abilityIndexStyles';
    s.textContent = `
      #${PANEL_ID} { position: fixed; right: 16px; top: 16px; width: 380px; max-height: 80vh; overflow-y: auto;
        z-index: 8; background: rgba(10,13,18,.95); border: 1px solid rgba(255,255,255,.16); border-radius: 8px;
        color: #dfe6ee; font: 12px "Segoe UI", system-ui, sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.6); pointer-events: auto; }
      #${PANEL_ID} .a-head { position: sticky; top: 0; padding: 9px 13px; font-size: 11px; letter-spacing: 1.5px;
        text-transform: uppercase; color: #cbd5e1; background: rgba(20,24,30,.98);
        border-bottom: 1px solid rgba(255,255,255,.12); display: flex; justify-content: space-between; }
      #${PANEL_ID} .a-head .hot { color: #6f7b88; border: 1px solid rgba(255,255,255,.15); border-radius: 3px; padding: 0 4px; font-size: 10px; }
      #${PANEL_ID} .a-body { padding: 8px 11px 12px; }
      #${PANEL_ID} .a-card { border: 1px solid rgba(255,255,255,.08); border-radius: 6px; padding: 6px 9px;
        margin-bottom: 7px; background: rgba(255,255,255,.03); }
      #${PANEL_ID} .a-name { font-weight: 700; color: #c9a6ff; }
      #${PANEL_ID} .a-name .a-cls { font-weight: 400; font-size: 10px; color: #8a96a3; text-transform: uppercase; letter-spacing: .5px; margin-left: 6px; }
      #${PANEL_ID} .a-eff { color: #f0e6cf; margin: 3px 0 1px; }
      #${PANEL_ID} .a-hdr { color: #8fb6e0; font-size: 10px; }
      #${PANEL_ID} .a-meta { color: #7c8896; font-size: 10px; margin-top: 2px; }
      #${PANEL_ID} .empty { color: #6f7b88; font-style: italic; padding: 6px 2px; }
    `;
    document.head.appendChild(s);
  }

  // every ability currently held by any agent: id -> { spec, holders[] }
  _collect() {
    const sim = this.getSim();
    const agents = sim ? sim.agents : [];
    const now = sim ? sim.time : 0;
    if (now < this._lastNow) this._firstSeen.clear();   // world rebuilt -> reset "first seen"
    this._lastNow = now;
    const map = new Map();
    for (const a of agents) {
      // a.abilities is the SUPERSET — the player's starter loadout plus every
      // class-granted ability (progression mirrors its grants onto the agent).
      const abil = a.abilities;
      if (!abil || !abil.size) continue;
      for (const [id, spec] of abil) {
        if (!spec) continue;
        let e = map.get(id);
        if (!e) { e = { spec, holders: [] }; map.set(id, e); }
        e.holders.push(a.name);
        if (!this._firstSeen.has(id)) this._firstSeen.set(id, now);
      }
    }
    return map;
  }

  // "damage 55 + knockback 3 @on_hit [FIRE]" — what the ability does
  _effectText(spec) {
    return (spec.effects || []).map((ef) => {
      let s = ef.op + (ef.amount ? ' ' + Math.round(ef.amount) : '');
      if (ef.dur) s += ' ' + ef.dur + 's';
      if (ef.when) s += ' @' + ef.when;
      if (ef.tags && ef.tags.length) s += ' [' + ef.tags.join(',') + ']';
      return s;
    }).join(' + ') || '—';
  }

  // "cone(5,90) · projectile · cd 8s · rng 12" — how it's delivered
  _headerText(spec) {
    const h = spec.header || {};
    const a = h.area || { kind: 'self' };
    const area = a.kind === 'self' ? 'self'
      : a.kind + (a.r != null ? `(${a.r}${a.deg != null ? ',' + a.deg : ''})` : a.len != null ? `(${a.len})` : '');
    const del = (h.delivery && h.delivery.kind) || 'instant';
    return `${area} · ${del} · cd ${h.cooldown}s · rng ${h.range} · ${h.target}`;
  }

  render() {
    const map = this._collect();   // always: stamps first-seen even while the panel is closed
    if (!this.visible) return;
    const rows = [...map.entries()].map(([id, e]) => ({ id, ...e, first: this._firstSeen.get(id) || 0 }))
      .sort((x, y) => (y.spec.tier || 1) - (x.spec.tier || 1) || x.first - y.first);

    const sig = rows.map((r) => r.id + ':' + r.holders.length).join(',');
    if (sig === this._sig) return;
    this._sig = sig;

    const body = rows.length ? rows.map((r) => {
      const melee = isMelee(r.spec);
      const h = r.holders;
      return `<div class="a-card">
        <div class="a-name">${r.spec.name || r.id}<span class="a-cls">${r.spec.classKey || '?'} · T${r.spec.tier || 1}</span></div>
        <div class="a-eff">${this._effectText(r.spec)}</div>
        <div class="a-hdr">${this._headerText(r.spec)} · ${melee ? 'melee (lands on swing)' : 'cast at range'}</div>
        <div class="a-meta">held by ${h.length} (${h.slice(0, 4).join(', ')}${h.length > 4 ? '…' : ''}) · first seen ${Math.round(r.first)}s</div>
      </div>`;
    }).join('') : `<div class="empty">no abilities forged yet — they appear as agents level classes to their tiers</div>`;

    this.el.innerHTML = `<div class="a-head"><span>Ability Index (${rows.length})</span><span class="hot">Y</span></div><div class="a-body">${body}</div>`;
  }
}
