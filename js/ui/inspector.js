// Inspector: look at an agent and press F to pin a panel showing their
// profession, gold, inventory, needs, and PRICE BELIEFS — the economic mind.

import * as THREE from 'three';
import { PROFESSIONS, COMMODITIES, BASE_PRICE, PLAYER_COLOR, FACTIONS } from '../sim/simconfig.js';

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

export class Inspector {
  constructor(panelEl, camera) {
    this.el = panelEl;
    this.camera = camera;
    this.ray = new THREE.Raycaster();
    this.center = new THREE.Vector2(0, 0);
    this.agents = [];
    this.hover = null;
    this.pinned = null;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyF') this.pinned = this.pinned ? null : this.hover;
    });
  }

  setAgents(agents) { this.agents = agents; }

  // public: render an arbitrary agent's full panel (reused by the Minds browser)
  renderAgent(a) { return a ? this._render(a) : ''; }

  _pick() {
    this.ray.setFromCamera(this.center, this.camera);
    const proxies = this.agents.filter((a) => a.alive && a.proxy).map((a) => a.proxy);
    const hits = this.ray.intersectObjects(proxies, false);
    return hits.length ? hits[0].object.userData.agent : null;
  }

  update() {
    this.hover = this._pick();
    if (this.pinned && !this.pinned.alive) this.pinned = null;
    const a = this.pinned || this.hover;
    if (!a) { this.el.innerHTML = `<div class="empty">look at a townsperson, press F to pin</div>`; return; }
    this.el.innerHTML = this._render(a);
  }

  _bar(label, v, color) {
    const pct = Math.round(v * 100);
    return `<div class="row"><span class="k">${label}</span>
      <span class="bar"><i style="width:${pct}%;background:${color}"></i></span>
      <span class="v">${pct}</span></div>`;
  }

  _render(a) {
    const color = a.profColor();
    const prof = a.controlled ? 'visitor'
      : (a.profession ? PROFESSIONS[a.profession].label : (FACTIONS[a.faction]?.label || 'creature'));
    const head = `<div class="hdr" style="color:${hex(color)}">${a.name}
      <span class="sub">${prof}${a.controlled ? '' : ' · ' + Math.round(a.gold) + ' gold'}</span></div>`;

    if (a.controlled) return head + `<div class="goal">walking the market</div>
      <div class="foot">${this.pinned ? 'pinned · F to release' : 'look + press F to pin'}</div>`;

    const goal = `<div class="goal">doing: <b>${a.goal.kind}</b></div>`;

    const needs = `<div class="sec">Needs</div>
      ${this._bar('hunger', a.needs.hunger, '#7fd18a')}
      ${this._bar('energy', a.needs.energy, '#6fb7ff')}
      ${this._bar('social', a.needs.social, '#c79bff')}`;

    const inv = `<div class="sec">Inventory</div><div class="inv">` +
      COMMODITIES.map((c) => {
        const n = c === 'food' ? a.inventory[c].toFixed(1) : Math.floor(a.inventory[c]);
        return `<span class="cell"><b>${n}</b> ${c}</span>`;
      }).join('') + `</div>`;

    const prices = `<div class="sec">Believes prices</div>` +
      COMMODITIES.map((c) => {
        const b = a.priceBeliefs[c], base = BASE_PRICE[c];
        const arrow = b > base * 1.08 ? '▲' : b < base * 0.92 ? '▼' : '·';
        const ac = b > base * 1.08 ? '#e0894e' : b < base * 0.92 ? '#7fd18a' : '#9aa6b2';
        return `<div class="brow"><span class="bn">${c}</span>
          <span class="bc">${b.toFixed(1)}g</span>
          <span class="bs" style="color:${ac}">${arrow}</span></div>`;
      }).join('');

    // the Theory-of-Mind table: what this agent believes about everyone else
    const beliefs = [...a.beliefs.all()].sort((x, y) => y.confidence - x.confidence);
    let brows = beliefs.map((b) => {
      const subj = this._name(b.subjectId);
      const fac = FACTIONS[b.lastFaction];
      const flags = [
        b.hostile ? '<span class="host">hostile</span>' : '',
        Math.abs(b.standing) > 0.05
          ? `<span style="color:${b.standing > 0 ? '#7fd18a' : '#e36f6f'}">${b.standing > 0 ? '+' : ''}${b.standing.toFixed(2)}</span>` : '',
      ].filter(Boolean).join(' ');
      return `<div class="brow"><span class="bn">${subj}</span>
        <span class="bf" style="color:${fac ? hex(fac.color) : '#888'}">${fac ? fac.label : '?'}</span>
        <span class="bc">${Math.round(b.confidence * 100)}%</span>
        <span class="bflags">${flags}</span></div>`;
    }).join('');
    if (!brows) brows = '<div class="empty">knows of no-one yet</div>';
    const beliefSec = `<div class="sec">Believes (${beliefs.length})</div>${brows}`;

    return head + goal + needs + inv + prices + beliefSec +
      `<div class="foot">${this.pinned ? 'pinned · F to release' : 'look + press F to pin'}</div>`;
  }

  _name(id) {
    const a = this.agents.find((x) => x.id === id);
    return a ? a.name : '#' + id;
  }
}
