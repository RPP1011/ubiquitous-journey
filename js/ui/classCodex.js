// Class Codex: a self-injecting browse panel for the emergent class system.
// Three sections:
//   1. Classes in play   — every class CURRENTLY held by any agent (procedural or
//      templated), aggregated: how many hold it, level range, total XP.
//   2. XP by action      — the sim-wide XP-allocation telemetry (xpstats.js): which
//      action verbs earn how much XP and how often they fire.
//   3. Class templates    — the predefined class dictionary (what behaviour earns /
//      levels each), for reference.
// Reads sim.agents + xpstats each frame (signature-cached). Toggles with a key.

import { CLASS_TEMPLATES } from '../rpg/classes.js';
import { xpByVerb, xpTotal } from '../rpg/xpstats.js';

const PANEL_ID = 'classCodex';

export class ClassCodex {
  constructor() {
    this.agents = [];
    this.visible = false;
    this._sig = '';
    this._injectStyles();
    this._build();
  }

  setAgents(a) { this.agents = a || []; this._sig = ''; }
  toggle() { this.visible ? this.hide() : this.show(); }
  show() { this.visible = true; this.el.style.display = 'block'; this._sig = ''; this.render(); }
  hide() { this.visible = false; this.el.style.display = 'none'; }

  _build() {
    let el = document.getElementById(PANEL_ID);
    if (!el) { el = document.createElement('div'); el.id = PANEL_ID; document.body.appendChild(el); }
    this.el = el;
    this.el.style.display = 'none';
  }

  _injectStyles() {
    if (document.getElementById('classCodexStyles')) return;
    const s = document.createElement('style');
    s.id = 'classCodexStyles';
    s.textContent = `
      #${PANEL_ID} { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%);
        width: 460px; max-height: 78vh; overflow-y: auto; z-index: 8;
        background: rgba(10,13,18,.95); border: 1px solid rgba(255,255,255,.16);
        border-radius: 8px; color: #dfe6ee; font: 12px "Segoe UI", system-ui, sans-serif;
        box-shadow: 0 10px 40px rgba(0,0,0,.6); pointer-events: auto; }
      #${PANEL_ID} .c-head { position: sticky; top: 0; padding: 9px 13px; font-size: 11px;
        letter-spacing: 1.5px; text-transform: uppercase; color: #cbd5e1;
        background: rgba(20,24,30,.98); border-bottom: 1px solid rgba(255,255,255,.12);
        display: flex; justify-content: space-between; }
      #${PANEL_ID} .c-head .hot { color: #6f7b88; border: 1px solid rgba(255,255,255,.15);
        border-radius: 3px; padding: 0 4px; font-size: 10px; }
      #${PANEL_ID} .c-body { padding: 6px 13px 12px; column-count: 1; }
      #${PANEL_ID} .c-sec { font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase;
        color: #8a96a3; margin: 12px 0 5px; }
      #${PANEL_ID} .c-row { display: grid; grid-template-columns: 1fr auto; gap: 8px;
        align-items: center; padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
      #${PANEL_ID} .c-name { color: #f0e6cf; font-weight: 600; }
      #${PANEL_ID} .c-name.proc { color: #b07be0; }
      #${PANEL_ID} .c-meta { color: #9aa6b2; font-size: 11px; white-space: nowrap; }
      #${PANEL_ID} .c-xprow { display: grid; grid-template-columns: 92px 1fr auto; gap: 8px; align-items: center; }
      #${PANEL_ID} .c-verb { color: #cbd5e1; }
      #${PANEL_ID} .c-bar { height: 7px; background: rgba(255,255,255,.08); border-radius: 4px; overflow: hidden; }
      #${PANEL_ID} .c-bar i { display: block; height: 100%; background: linear-gradient(#e0c46a,#b8923a); }
      #${PANEL_ID} .c-n { color: #6f7b88; font-size: 10px; white-space: nowrap; }
      #${PANEL_ID} .c-tags { color: #8fb6e0; font-size: 10px; }
      #${PANEL_ID} .c-req { color: #d77b6b; font-size: 10px; }
      #${PANEL_ID} .empty { color: #6f7b88; font-style: italic; }
    `;
    document.head.appendChild(s);
  }

  // aggregate every class currently held by any agent
  _extant() {
    const m = new Map();   // key -> { key, name, proc, holders, minL, maxL, xp, levels }
    for (const a of this.agents) {
      if (!a.progression || !a.progression.classes) continue;
      for (const c of a.progression.classes.values()) {
        let e = m.get(c.key);
        if (!e) { e = { key: c.key, name: c.name, proc: c.key.startsWith('proc:'), holders: 0, minL: Infinity, maxL: 0, xp: 0, levels: 0 }; m.set(c.key, e); }
        e.holders += 1; e.levels += c.level; e.xp += c.xp;
        e.minL = Math.min(e.minL, c.level); e.maxL = Math.max(e.maxL, c.level);
      }
    }
    return [...m.values()].sort((a, b) => (b.holders - a.holders) || (b.maxL - a.maxL));
  }

  render() {
    if (!this.visible) return;
    const extant = this._extant();
    const verbs = xpByVerb();
    const total = xpTotal();
    const sig = extant.map((e) => e.key + e.holders + e.maxL).join(',') + '|' +
      verbs.map((v) => v.verb + (v.xp | 0)).join(',') + '|' + (total | 0);
    if (sig === this._sig) return;
    this._sig = sig;

    const extantHtml = extant.length ? extant.map((e) =>
      `<div class="c-row"><span class="c-name${e.proc ? ' proc' : ''}">${e.name}</span>` +
      `<span class="c-meta">×${e.holders} · Lv ${e.minL}${e.maxL !== e.minL ? '–' + e.maxL : ''} · ${Math.round(e.xp)} xp</span></div>`).join('')
      : `<div class="empty">no classes earned yet</div>`;

    const maxXp = verbs.reduce((m, v) => Math.max(m, v.xp), 1);
    const xpHtml = verbs.length ? verbs.map((v) =>
      `<div class="c-xprow"><span class="c-verb">${v.verb}</span>` +
      `<span class="c-bar"><i style="width:${Math.round((v.xp / maxXp) * 100)}%"></i></span>` +
      `<span class="c-n">${Math.round(v.xp)} xp · ×${v.n}</span></div>`).join('')
      : `<div class="empty">no XP allocated yet</div>`;

    const tmplHtml = CLASS_TEMPLATES.map((t) =>
      `<div class="c-row" style="grid-template-columns:1fr"><div>` +
      `<span class="c-name">${t.name}</span> ` +
      `<span class="c-req">needs ${t.requirements.map(([tg, n]) => `${tg}≥${n}`).join(', ')}</span><br>` +
      `<span class="c-tags">levels via ${t.score_tags.map(([tg, w]) => `${tg}·${w}`).join('  ')}</span>` +
      `</div></div>`).join('');

    this.el.innerHTML =
      `<div class="c-head"><span>Class Codex</span><span class="hot">K</span></div>` +
      `<div class="c-body">` +
      `<div class="c-sec">Classes in play (${extant.length})</div>${extantHtml}` +
      `<div class="c-sec">XP by action — ${Math.round(total)} xp total</div>${xpHtml}` +
      `<div class="c-sec">Class templates (${CLASS_TEMPLATES.length})</div>${tmplHtml}` +
      `</div>`;
  }
}
