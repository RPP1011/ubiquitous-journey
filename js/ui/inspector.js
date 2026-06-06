// Inspector: look at an agent and press F to pin a panel showing their
// profession, gold, inventory, needs, and PRICE BELIEFS — the economic mind.

import * as THREE from 'three';
import { PROFESSIONS, COMMODITIES, BASE_PRICE, PLAYER_COLOR, FACTIONS, GROUP_TYPES } from '../sim/simconfig.js';
import { ambitionText } from '../sim/motivation.js';
import { memoryPhrase } from '../sim/memory.js';
import { agentBiography } from '../sim/biography.js';
import { provenanceTag } from '../sim/beliefs.js';

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

export class Inspector {
  constructor(panelEl, camera, sim = null) {
    this.el = panelEl;
    this.camera = camera;
    this.sim = sim;   // optional Simulation, for reputation 'thinks of you' line
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
    const prof = a.controlled ? 'visitor' : this._occupation(a);
    const head = `<div class="hdr" style="color:${hex(color)}">${a.name}
      <span class="sub">${prof}${a.controlled ? '' : ' · ' + Math.round(a.gold) + ' gold'}</span></div>`;

    if (a.controlled) return head + `<div class="goal">walking the market</div>
      <div class="foot">${this.pinned ? 'pinned · F to release' : 'look + press F to pin'}</div>`;

    // STORY: the composed biography — who this soul became (house, calling, deeds,
    // bonds), so the player can follow an individual among the named cast. Read-only.
    let storySec = '';
    if (this.sim) {
      const story = agentBiography(a, this.sim);
      if (story.length) storySec = `<div class="sec">Story</div>` +
        story.map((l) => `<div class="goal" style="color:#cdbb88">${l}</div>`).join('');
    }

    const goal = `<div class="goal">doing: <b>${a.goal.kind}</b></div>`;

    // goal stack + current plan: the structured intentions on the agent's stack
    // and the primitive sequence the planner synthesised for the top one
    // ("repay X → goto market, buy food, goto X, give food"). Read-only.
    let goalSec = '';
    if (Array.isArray(a.goals) && a.goals.length) {
      const top = a.goals[a.goals.length - 1];
      // plan-less goals (grief) have no actionable atoms — they're dispositions that
      // simply run their course, so we show "mourning…" instead of a primitive list.
      const planless = top && Array.isArray(top.atoms) && top.atoms.length === 0;
      const planTxt = (top && top.plan && top.plan.steps && top.plan.steps.length)
        ? top.plan.steps.map((s, i) => {
            // planner steps are { name, place|good|item|to|target }; `place` is a
            // POI-kind string or a { subjectId } target.
            let tag;
            if (s.name === 'goto') {
              tag = typeof s.place === 'string' ? s.place
                : (s.place && s.place.subjectId != null ? this._name(s.place.subjectId) : '');
            } else {
              tag = s.good || s.item
                || (s.to != null ? this._name(s.to) : (s.target != null ? this._name(s.target) : ''));
            }
            const cur = (i === (top.step || 0)) ? '▸' : '';
            return `${cur}${s.name}${tag ? ' ' + tag : ''}`;
          }).join(' → ')
        : (planless ? (top.kind === 'grieve' ? 'mourning…' : 'biding…') : '(planning…)');
      const goalLabel = (g) => `${g.kind}${g.subjectId != null ? ' ' + this._name(g.subjectId) : (g.place ? ' ' + g.place : '')}`;
      goalSec = `<div class="sec">Goals (${a.goals.length})</div>` +
        a.goals.slice().reverse().map((g, i) =>
          `<div class="brow"><span class="bn">${i === 0 ? '★ ' : ''}${goalLabel(g)}</span></div>`).join('') +
        `<div class="goal">plan: ${planTxt}</div>`;
    }

    // longer-term motivation: the arc this agent is living, with progress
    let ambition = '';
    const at = ambitionText(a);
    if (at) {
      const col = at.revenge ? '#e36f6f' : '#e0c46a';
      ambition = `<div class="sec">Ambition</div>` +
        `<div class="brow"><span class="bn" style="color:${col}">${at.label}</span>` +
        `<span class="bc">${Math.round(at.progress * 100)}%</span></div>`;
    }

    // social group: which band/guild/circle this agent belongs to (or leads)
    let group = '';
    if (this.sim) {
      const gtLabel = (k) => (k && GROUP_TYPES[k] ? GROUP_TYPES[k].label : 'band');
      if (a.bandLeaderId != null) {
        const L = this.sim.agentsById.get(a.bandLeaderId);
        group = `<div class="goal">${gtLabel(a.groupType)} with <b>${L ? L.name : '?'}</b></div>`;
      } else {
        const fol = this.sim.agents.filter((x) => x.alive && x.bandLeaderId === a.id).length;
        if (fol) group = `<div class="goal">leads a ${gtLabel(a.groupType)} of <b>${fol}</b></div>`;
      }
    }

    // relationships digest: strongest allies / rivals by belief-standing
    const relAll = [...a.beliefs.all()].filter((b) => Math.abs(b.standing) > 0.12);
    let relSec = '';
    if (relAll.length) {
      const relRow = (b) => {
        const sc = b.standing > 0 ? '#7fd18a' : '#e36f6f';
        return `<div class="brow"><span class="bn">${this._name(b.subjectId)}</span>` +
          `<span class="bc" style="color:${sc}">${b.standing > 0 ? '+' : ''}${b.standing.toFixed(2)}</span></div>`;
      };
      const allies = relAll.filter((b) => b.standing > 0).sort((x, y) => y.standing - x.standing).slice(0, 3).map(relRow).join('');
      const rivals = relAll.filter((b) => b.standing < 0).sort((x, y) => x.standing - y.standing).slice(0, 3).map(relRow).join('');
      relSec = `<div class="sec">Relationships</div>${allies}${rivals}`;
    }

    // "Life so far": the agent's most formative episodic memories, in plain words
    let bio = '';
    if (a.memory && a.memory.salient) {
      const eps = a.memory.salient(4);
      if (eps.length) {
        bio = `<div class="sec">Life so far</div>` + eps.map((e) => {
          const c = e.valence >= 0 ? '#7fd18a' : '#e36f6f';
          return `<div class="brow"><span class="bn">${memoryPhrase(e, (id) => this._name(id))}</span>` +
            `<span class="bc" style="color:${c}">${Math.round(e.salience * 100)}</span></div>`;
        }).join('');
      }
    }

    // RPG: top classes (level-sorted). Present for every agent incl. monsters
    // and the player once they accrue behavior; empty until a class is granted,
    // so guard the no-class case.
    let classes = '';
    if (a.progression && a.progression.topClasses) {
      const top = a.progression.topClasses(3);
      if (top.length) {
        classes = `<div class="sec">Classes (lv ${a.progression.totalLevel})</div>` +
          top.map((c) => `<div class="brow"><span class="bn">${c.name}</span>` +
            `<span class="bc">Lv ${c.level}</span>` +
            `<span class="bs">${Math.round(c.xp)} xp</span></div>`).join('');
      }
    }

    // Behavior profile: the dominant weighted deed-tags that EARNED the class(es).
    // A procedural name is built from the top two tags (top -> base noun, second ->
    // adjective prefix), so the ★-marked pair is literally what caused a prefixed
    // class like [Verdant Tiller]. These weights come from the agent's ActionEvents.
    let behavior = '';
    if (a.progression && a.progression.behavior_profile) {
      const bp = a.progression.behavior_profile;
      const tags = Object.keys(bp).sort((x, y) => bp[y] - bp[x]).slice(0, 6);
      if (tags.length) {
        behavior = `<div class="sec">Behavior (drives class)</div>` +
          tags.map((t, i) => `<div class="brow"><span class="bn">${i < 2 ? '★ ' : ''}${t}</span>` +
            `<span class="bc">${bp[t].toFixed(1)}</span></div>`).join('');
      }
    }

    // reputation: what this NPC thinks of YOU, and its faction's wholesale view.
    let repSec = '';
    if (this.sim && this.sim.reputation && this.sim.reputation.playerId != null) {
      const rep = this.sim.reputation;
      const s = rep.standing(a);
      const label = rep.describe(a);
      const sc = s > 0.05 ? '#7fd18a' : s < -0.05 ? '#e36f6f' : '#9aa6b2';
      const fs = rep.factionStanding(a.faction);
      const fl = FACTIONS[a.faction] ? FACTIONS[a.faction].label : a.faction;
      repSec = `<div class="sec">Thinks of you</div>` +
        `<div class="brow"><span class="bn">${label}</span>` +
        `<span class="bc" style="color:${sc}">${s > 0 ? '+' : ''}${s.toFixed(2)}</span></div>` +
        `<div class="brow"><span class="bn">${fl} faction</span>` +
        `<span class="bc">${fs > 0 ? '+' : ''}${fs.toFixed(2)}</span></div>`;
    }

    const needs = `<div class="sec">Needs</div>
      ${this._bar('hunger', a.needs.hunger, '#7fd18a')}
      ${this._bar('energy', a.needs.energy, '#6fb7ff')}
      ${this._bar('social', a.needs.social, '#c79bff')}
      ${this._bar('comfort', a.needs.comfort ?? 1, '#e0b15a')}`;

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
      // provenance: how garbled this belief is — first-hand vs a much-retold rumour.
      // A hostility that CURDLED from gossip (rumorBorn) is flagged as a false feud,
      // so the player can see a grudge the agent holds on nothing but hearsay.
      const prov = provenanceTag(b);
      const provCol = (b.hops || 0) <= 0 ? '#7f9a7f' : (b.hops || 0) >= 3 ? '#d39a6b' : '#b0a070';
      const flags = [
        b.hostile ? `<span class="host">${b.rumorBorn ? 'feud (rumour)' : 'hostile'}</span>` : '',
        Math.abs(b.standing) > 0.05
          ? `<span style="color:${b.standing > 0 ? '#7fd18a' : '#e36f6f'}">${b.standing > 0 ? '+' : ''}${b.standing.toFixed(2)}</span>` : '',
        `<span style="color:${provCol};font-style:italic;opacity:.85">${prov}</span>`,
      ].filter(Boolean).join(' ');
      return `<div class="brow"><span class="bn">${subj}</span>
        <span class="bf" style="color:${fac ? hex(fac.color) : '#888'}">${fac ? fac.label : '?'}</span>
        <span class="bc">${Math.round(b.confidence * 100)}%</span>
        <span class="bflags">${flags}</span></div>`;
    }).join('');
    if (!brows) brows = '<div class="empty">knows of no-one yet</div>';
    const beliefSec = `<div class="sec">Believes (${beliefs.length})</div>${brows}`;

    return head + storySec + goal + goalSec + ambition + group + classes + behavior + repSec + relSec + bio + needs + inv + prices + beliefSec +
      `<div class="foot">${this.pinned ? 'pinned · F to release' : 'look + press F to pin'}</div>`;
  }

  _name(id) {
    const a = this.agents.find((x) => x.id === id);
    return a ? a.name : '#' + id;
  }

  // An agent's EMERGENT occupation line: its primary class (what it has become),
  // else "making <good>" (what it's doing now), else a profession label (legacy
  // fixtures), else its faction. Guarded — read-only.
  _occupation(a) {
    if (a.faction === 'monster') return FACTIONS[a.faction]?.label || 'creature';
    const pc = a.progression && a.progression.primaryClass && a.progression.primaryClass();
    if (pc) return pc.name;
    if (a._trade) return 'making ' + a._trade;
    if (a.profession && PROFESSIONS[a.profession]) return PROFESSIONS[a.profession].label;
    return FACTIONS[a.faction]?.label || 'townsperson';
  }
}
