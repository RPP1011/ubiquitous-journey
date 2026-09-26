// TacticsView: the DOM side of a tactical battle — turn order, the acting unit, context actions
// with odds, a WRITE-IN box, and the log. Drives NPC turns at a watchable pace. Every order goes
// through the Battle API (moveTo / act / endTurn); the view never mutates battle state itself.

import * as THREE from 'three';
import { TUNE } from '../constants.js';
import { affordances, forecast, propTraits, useIcons, verbOf, aimOf, type Affordance } from '../app/tactics/affordances.js';
import { runTurn, planTurn } from '../app/tactics/ai.js';
import { phrase } from '../app/run/autopilot.js';
import { readWriteIn, describeTrigger, resolveIntents, splitConditional, readTrigger, readyReadings, norm, type GridReading } from '../app/tactics/writein.js';
import { interpretLLM } from '../app/tactics/llmParse.js';
import { isEnabled as llmEnabled } from '../ai/llm.js';
import { explainUnmet, recordUnmet } from '../app/tactics/unmet.js';
import { key } from '../app/tactics/map.js';
import type { Action, Battle, Spot, Unit } from '../app/tactics/battle.js';
import type { BattleRender } from './battleRender.js';
import type { BattleFX } from './battleFX.js';

const CSS = `
#tac { position: fixed; right: 12px; top: 12px; bottom: 12px; width: min(400px, 94vw); display: flex; flex-direction: column; gap: 8px;
  z-index: 31; pointer-events: none; font-family: "Segoe UI", system-ui, sans-serif; color: #dfe6ee; }
#tac.hidden { display: none; }
#tac .card { pointer-events: auto; background: rgba(10,13,18,.93); border: 1px solid rgba(255,255,255,.14); border-radius: 10px; padding: 9px 11px; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
#tac .hd { display: flex; justify-content: space-between; align-items: baseline; }
#tac .hd b { font-size: 15px; } #tac .hd span { font-size: 11px; color: #8d99a6; }
#tac .stakes { font-size: 12px; color: #f0c674; margin-top: 4px; }
#tac .order { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
#tac .order span { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: rgba(255,255,255,.06); }
#tac .order .us { border-left: 3px solid #6fcf7f; } #tac .order .them { border-left: 3px solid #e07b6a; }
#tac .order .cur { background: rgba(232,200,121,.3); } #tac .order .out { opacity: .35; text-decoration: line-through; }
#tac .who { font-size: 13px; } #tac .who b { font-size: 14px; }
#tac .bar { height: 4px; background: rgba(255,255,255,.1); border-radius: 2px; margin: 4px 0; } #tac .bar i { display: block; height: 100%; background: #6fcf7f; }
#tac .st { font-size: 11px; color: #f0c674; }
#tac .grp { margin-top: 6px; } #tac .grp h5 { margin: 0 0 3px; font-size: 10px; letter-spacing: .8px; text-transform: uppercase; color: #8d99a6; }
#tac .acts { display: flex; flex-wrap: wrap; gap: 4px; }
#tac button { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.15); color: #dfe6ee; border-radius: 5px; padding: 3px 7px; font: inherit; font-size: 12px; cursor: pointer; }
#tac button:hover { background: rgba(232,200,121,.2); border-color: rgba(232,200,121,.55); }
#tac button .p { color: #f0c674; margin-left: 4px; }
#tac input { width: 100%; box-sizing: border-box; margin-top: 8px; background: rgba(0,0,0,.35); color: #eef3f8; border: 1px solid rgba(255,255,255,.2); border-radius: 6px; padding: 7px 9px; font: inherit; font-size: 13px; }
#tac .chips { display: flex; flex-direction: column; gap: 4px; margin-top: 5px; }
#tac .chip { text-align: left; } #tac .chip.alt { opacity: .8; }
#tac .err { color: #e89090; font-size: 12px; min-height: 14px; margin-top: 3px; }
#tac .row { display: flex; gap: 6px; margin-top: 8px; }
#tac .log { flex: 1; overflow-y: auto; font-size: 12px; line-height: 1.5; min-height: 80px; }
#tac .log .hit { color: #eef3f8; } #tac .log .miss { color: #9aa6b2; } #tac .log .env { color: #ffab5e; } #tac .log .social { color: #b9a3f0; }
#tac .log .join { color: #8fe39a; } #tac .log .end { color: #e8c879; font-weight: 700; } #tac .log .rd { color: #6f7b88; font-size: 10px; margin-top: 3px; }
#tac .hint { font-size: 10px; color: #6f7b88; margin-top: 5px; }
#tac .verbs { display: flex; flex-wrap: wrap; gap: 5px; }
#tac .verb { padding: 4px 8px; font-size: 13px; } #tac .verb .n { display: inline-block; min-width: 16px; margin-left: 5px; padding: 0 5px; border-radius: 8px;
  background: rgba(255,255,255,.12); font-size: 11px; text-align: center; }
#tac .verb.env { border-color: rgba(216,162,74,.6); background: rgba(216,162,74,.14); } #tac .verb.env .n { background: #d8a24a; color: #1a1206; font-weight: 700; }
#tac .verb.hot .n { background: #ff6a1a; color: #fff; }
#tac .verb.sel { background: rgba(255,224,102,.3); border-color: #ffe066; }
#tac .pick { margin-top: 6px; font-size: 12px; color: #ffe066; } #tac .pick button { margin-left: 6px; padding: 0 6px; }
#tac-marks { position: fixed; inset: 0; pointer-events: none; z-index: 30; }
#tac-marks .pm { position: absolute; transform: translate(-50%, -100%); font-size: 14px; line-height: 1; padding: 2px 4px; border-radius: 6px;
  background: rgba(10,13,18,.72); border: 1px solid rgba(242,201,76,.45); white-space: nowrap; font-family: "Segoe UI", system-ui, sans-serif; }
#tac-marks .pm.hot { border-color: #ff8c3a; box-shadow: 0 0 8px rgba(255,140,58,.6); }
#tac-tip { position: fixed; z-index: 33; pointer-events: none; max-width: 300px; background: rgba(10,13,18,.95); border: 1px solid rgba(255,255,255,.18);
  border-radius: 8px; padding: 7px 9px; font: 12px "Segoe UI", system-ui, sans-serif; color: #dfe6ee; box-shadow: 0 6px 22px rgba(0,0,0,.55); display: none; }
#tac-tip b { font-size: 13px; } #tac-tip .tr { color: #aeb8c3; font-size: 11px; margin: 2px 0 4px; } #tac-tip .u { margin-top: 2px; }
#tac-tip .u .p { color: #f0c674; } #tac-tip .u .r { color: #ff8a80; font-size: 11px; } #tac-tip .u .e { color: #ffb877; } #tac-tip .u .m { color: #7fb6ff; } #tac-tip .h { color: #6f7b88; font-size: 10px; margin-top: 4px; }
#tac-cap { position: fixed; left: calc(50% - 200px); top: 64px; transform: translateX(-50%); z-index: 32; pointer-events: none; max-width: min(760px, 70vw);
  text-align: center; font-family: "Segoe UI", system-ui, sans-serif; font-size: 22px; font-weight: 600; color: #fff; text-shadow: 0 2px 8px rgba(0,0,0,.9);
  background: rgba(8,10,14,.62); border-radius: 10px; padding: 8px 18px; transition: opacity .35s; opacity: 0; }
#tac-cap.on { opacity: 1; } #tac-cap .q { display: block; font-size: 15px; font-weight: 400; font-style: italic; color: #e8c879; margin-bottom: 2px; }
#tac-cap.env { color: #ffcf9a; } #tac-cap.social { color: #d9ccff; } #tac-cap.end { color: #e8c879; font-size: 28px; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const pct = (p: number) => `${Math.round(p * 100)}%`;

export class TacticsView {
  onEnd: ((b: Battle) => void) | null = null;
  private root: HTMLDivElement | null = null;
  private b: Battle | null = null;
  private r: BattleRender | null = null;
  private npcTimer = 0;
  private draft = '';
  private readings: GridReading[] = [];
  private err = '';
  /** Autopilot: plays the player's (and commanded companions') turns, typing write-ins visibly. */
  auto = false;
  private autoT = 0;
  private autoText: string | null = null;
  private autoPlan: ReturnType<typeof planTurn> | null = null;
  private autoUnit: Unit | null = null;
  pace = 0.65;
  private llmTimer: ReturnType<typeof setTimeout> | null = null;
  private llmUnsupported: string | null = null;
  /** Where this fight is (for the unmet-request record). */
  where = '';
  private cap: HTMLDivElement | null = null;
  private capT = 0;
  private seenLog = 0;
  private lastTyped: string | null = null;
  /** The choreographer playing this battle's cues (NPC turns and autopilot wait on it). */
  fx: BattleFX | null = null;
  /** The render camera (set by main) — for markers over objects and the hover card. */
  camera: unknown = null;
  /** What the acting unit can do this turn (recomputed when the turn state changes). */
  private aff: Affordance[] = [];
  private affKey = '';
  /** The verb you picked: its targets light up on the grid; click one to do it. */
  private verb: string | null = null;
  /** A verb button under the pointer: flash its targets. */
  private hoverVerb: string | null = null;
  /** In verb mode, the option aimed at the tile under the pointer. */
  private aimAff: Affordance | null = null;
  /** The option under the pointer: previewed on the grid. */
  private hoverAff: { to: Spot | null; action: Action } | null = null;
  private marks: HTMLDivElement | null = null;
  private markEls = new Map<string, HTMLDivElement>();
  private tip: HTMLDivElement | null = null;

  constructor() {
    if (typeof document === 'undefined') return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.root = document.createElement('div'); this.root.id = 'tac'; this.root.className = 'hidden';
    document.body.appendChild(this.root);
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    this.cap = document.createElement('div'); this.cap.id = 'tac-cap'; document.body.appendChild(this.cap);
    this.marks = document.createElement('div'); this.marks.id = 'tac-marks'; document.body.appendChild(this.marks);
    this.tip = document.createElement('div'); this.tip.id = 'tac-tip'; document.body.appendChild(this.tip);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.verb) this.setVerb(null); });
  }

  /** Recompute the turn's options when anything that matters has changed. */
  private options(): Affordance[] {
    const b = this.b, u = this.mine();
    if (!b || !u || b.outcome) { this.aff = []; this.affKey = ''; return this.aff; }
    const k = `${u.id}|${u.x},${u.z}|${u.moved}|${u.acted}|${b.round}|${b.log.length}|${b.map.props.size}`;
    if (k !== this.affKey) { this.affKey = k; this.aff = affordances(b, u); }
    return this.aff;
  }

/** The best option of a verb aimed at a tile. */
  private aimedAt(vk: string, s: Spot): Affordance | null {
    const b = this.b, u = this.mine(); if (!b || !u) return null;
    return this.options().find((a) => verbOf(u, a.action).key === vk && (() => { const t = aimOf(b, u, a.action); return !!t && t.x === s.x && t.z === s.z; })()) ?? null;
  }
  private setVerb(vk: string | null): void { this.verb = vk; this.aimAff = null; this.hoverAff = null; this.refresh(); }

  /** Screen position of a tile (or null off-screen / no camera). */
  screen(s: Spot, lift: number, onProp = true): { x: number; y: number } | null {
    if (!this.camera || !this.r) return null;
    const p = this.r.worldOf(s, lift, onProp).project(this.camera as THREE.Camera);
    if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) return null;
    return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight };
  }

  /** Markers over the objects you can use this turn, and the hover card. Per frame, cheap. */
  private overlay(busy: boolean): void {
    const b = this.b, marks = this.marks, tip = this.tip; if (!marks || !tip) return;
    const u = this.mine();
    const show = !!b && !!u && !busy && !b.outcome;
    const byProp = new Map<string, Affordance[]>();
    if (show) for (const a of this.options()) {
      if (a.subject?.kind !== 'prop') continue;
      if (a.action.kind === 'hew' && !a.catches.length && b!.map.props.get(a.subject.id)?.kind === 'tree') continue;
      (byProp.get(a.subject.id) ?? byProp.set(a.subject.id, []).get(a.subject.id)!).push(a);
    }
    for (const [id, el] of this.markEls) if (!byProp.has(id)) { el.remove(); this.markEls.delete(id); }
    const hovered = this.r?.hover ?? null;
    for (const [id, list] of byProp) {
      const p = b!.map.props.get(id) ?? (u!.carrying?.id === id ? u!.carrying : undefined); if (!p) continue;
      const at = u!.carrying?.id === id ? { x: u!.x, z: u!.z } : p;
      const sp = this.screen(at, p.kind === 'tree' ? 3.6 : 1.7);
      let el = this.markEls.get(id);
      if (!el) { el = document.createElement('div'); el.className = 'pm'; marks.appendChild(el); this.markEls.set(id, el); }
      el.textContent = useIcons(list);
      el.classList.toggle('hot', list.some((a) => a.catches.some((w) => w.side !== u!.side)));
      el.style.display = sp ? '' : 'none';
      if (sp) { el.style.left = `${sp.x}px`; el.style.top = `${sp.y}px`; }
    }
    // the hover card: what's under the pointer, and what you can do with it
    let html = '';
    let anchor: Spot | null = null;
    if (show && hovered) {
      const p = b!.map.propAt(hovered.x, hovered.z);
      const w = b!.unitAt(hovered.x, hovered.z);
      if (p) {
        const uses = this.verb ? (this.aimAff ? [this.aimAff] : []) : byProp.get(p.id) ?? [];
        html = `<b>${esc(p.name[0].toUpperCase() + p.name.slice(1))}</b><div class="tr">${esc(propTraits(b!, u, p).join(' · '))}</div>` +
          (uses.length ? uses.slice(0, 5).map((a) => this.tipLine(a)).join('') + (this.verb ? '<div class="h">click to do it</div>' : '') : '<div class="h">nothing you can do with it from here this turn</div>');
        anchor = p;
      } else if (w && w !== u) {
        const uses = this.verb ? (this.aimAff ? [this.aimAff] : []) : this.aff.filter((a) => a.subject?.kind === 'unit' && a.subject.id === w.id);
        const hp = Math.max(0, Math.round(w.agent.fighter.health / TUNE.maxHealth * 100));
        html = `<b>${esc(b!.nm(w, true))}</b><div class="tr">${w.side === u!.side ? 'with you' : `foe · ${w.tactic}`} · ${hp}% · ${esc(b!.objectiveOf(w).label)}</div>` +
          uses.slice(0, 6).map((a) => this.tipLine(a)).join('');
        anchor = w;
      }
    }
    const sp = anchor ? this.screen(anchor, 2.4) : null;
    if (html && sp) { tip.innerHTML = html; tip.style.display = 'block'; tip.style.left = `${Math.min(sp.x + 16, innerWidth - 320)}px`; tip.style.top = `${Math.max(8, sp.y - 20)}px`; }
    else tip.style.display = 'none';
  }

  private tipLine(a: Affordance): string {
    return `<div class="u">${esc(a.label)}${a.p < 1 ? ` <span class="p">${pct(a.p)}</span>` : ''}${a.steps ? ` <span class="m">· ${a.steps} step${a.steps > 1 ? 's' : ''}</span>` : ''}${a.effect ? ` — <span class="e">${esc(a.effect)}</span>` : ''}${a.risks.map((x) => `<div class="r">⚠ ${esc(x)}</div>`).join('')}</div>`;
  }

  /** Show a caption for the beat now playing (called by the choreographer). */
  showCaption(text: string, kind: string, quote: string | null): void {
    const cap = this.cap; if (!cap) return;
    cap.className = `on ${kind}`;
    cap.innerHTML = (quote ? `<span class="q">“${esc(quote)}”</span>` : '') + esc(text);
    this.capT = kind === 'end' ? 99 : 2.4;
  }

  /** (legacy) log-driven caption, used only when no choreographer is attached. */
  private caption(dt: number): void {
    if (this.fx) { this.capT -= dt; if (this.capT <= 0 && this.cap) this.cap.className = ''; return; }
    const b = this.b, cap = this.cap; if (!b || !cap) return;
    this.capT -= dt;
    if (b.log.length > this.seenLog) {
      const fresh = b.log.slice(this.seenLog);
      this.seenLog = b.log.length;
      const rank = (k: string) => ({ end: 6, env: 5, social: 4, join: 4, hit: 3, info: 3, move: 2, miss: 1 } as Record<string, number>)[k] ?? 0;
      const best = fresh.reduce((x, y) => (rank(y.kind) >= rank(x.kind) ? y : x));
      if (rank(best.kind) >= 2 || this.capT <= 0) {
        cap.className = `on ${best.kind}`;
        const q = this.lastTyped ? `<span class="q">“${esc(this.lastTyped)}”</span>` : '';
        cap.innerHTML = q + esc(best.text);
        this.lastTyped = null;
        this.capT = best.kind === 'end' ? 99 : 2.6;
      }
    }
    if (this.capT <= 0) cap.className = '';
  }

  open(b: Battle, r: BattleRender): void { this.seenLog = b.log.length; this.capT = 0; this.b = b; this.r = r; this.draft = ''; this.readings = []; this.err = ''; this.root?.classList.remove('hidden'); this.refresh(); }
  close(): void { this.verb = null; this.aimAff = null; this.hoverAff = null; for (const el of this.markEls.values()) el.remove(); this.markEls.clear(); if (this.tip) this.tip.style.display = 'none'; if (this.cap) this.cap.className = ''; this.b = null; this.r = null; this.root?.classList.add('hidden'); if (this.root) this.root.innerHTML = ''; }

  private mine(): Unit | null { const u = this.b?.current(); return u && this.b!.playerControls(u) ? u : null; }

  /** Per frame: pace NPC turns, keep highlights in sync. */
  tick(dt: number): void {
    const b = this.b; if (!b) return;
    this.fx?.update(dt);
    const busy = !!this.fx && this.fx.busy;
    const u = b.current();
    if (busy) { this.highlight(); this.overlay(true); this.caption(dt); this.r?.sync(dt); return; }
    if (!b.outcome && u && !b.playerControls(u)) {
      this.npcTimer += dt;
      if (this.npcTimer > this.pace) { this.npcTimer = 0; runTurn(b, u); this.refresh(); }
    } else this.npcTimer = 0;
    if (this.auto && !b.outcome && u && b.playerControls(u)) this.autoStep(b, u, dt);
    this.highlight();
    this.overlay(false);
    this.caption(dt);
    this.r?.sync(dt);
  }

  private autoStep(b: Battle, u: Unit, dt: number): void {
    if (this.autoUnit !== u) { this.autoUnit = u; this.autoT = 0; this.autoPlan = null; this.autoText = null; this.draft = ''; this.readings = []; }
    this.autoT += dt;
    if (!this.autoPlan && this.autoT > 0.5) {
      this.autoPlan = planTurn(b, u);
      this.autoText = phrase(b, u, this.autoPlan.action);
      this.autoT = 0;
    }
    if (!this.autoPlan) return;
    if (this.autoText) {
      const n = Math.min(this.autoText.length, Math.floor(this.autoT * 32));
      if (n > this.draft.length) { this.draft = this.autoText.slice(0, n); this.readings = readWriteIn(b, u, this.draft); this.refresh(); }
      if (n < this.autoText.length || this.autoT < this.autoText.length / 32 + 0.8) return;
      const r = this.readings[0];
      const same = r && r.action.kind === this.autoPlan.action.kind;
      this.autoUnit = null;
      if (same) { this.lastTyped = this.autoText; this.fx?.setQuote(this.autoText); this.run(u, r); if (b.current() === u) b.endTurn(u); this.refresh(); return; }
    } else if (this.autoT < 0.4) return;
    const plan = this.autoPlan;
    this.autoUnit = null; this.draft = ''; this.readings = [];
    if (plan.to) b.moveTo(u, plan.to);
    if (b.current() === u && !u.acted && u.out === null) b.act(u, plan.action);
    if (b.current() === u) b.endTurn(u);
    this.refresh();
  }

  /**
   * The model interpreter (when enabled): after a short pause in typing, ask the local model and
   * put its reading first (marked ✦). The instant regex reading is already on screen; a slow or
   * absent model changes nothing.
   */
  private askModel(b: Battle, m: Unit, text: string): void {
    if (!llmEnabled()) return;
    if (this.llmTimer) clearTimeout(this.llmTimer);
    this.llmTimer = setTimeout(async () => {
      const cond = splitConditional(text);
      const trig = cond ? readTrigger(b, m, norm(cond.when)) : null;
      const r = await interpretLLM(b, m, cond && trig ? cond.then : text);
      if (!r || this.draft !== text || this.mine() !== m) return;
      if (r.unsupported) {
        this.llmUnsupported = r.unsupported;
        if (!this.readings.length) { this.err = `Not possible: the rules don't cover ${r.unsupported} yet.`; this.refresh(); }
        return;
      }
      const rs = cond && trig ? readyReadings(b, m, trig, cond.then, r.intents, true) : resolveIntents(b, m, r.intents, true);
      if (!rs.length) return;
      const top = rs[0];
      top.label = `✦ ${top.label}`;
      this.readings = [top, ...this.readings.filter((x) => JSON.stringify(x.action) !== JSON.stringify(top.action))].slice(0, 4);
      this.err = '';
      this.refresh();
    }, 350);
  }

  /** A click on the grid: move to a reachable tile, or strike a foe you can reach. */
  clickTile(s: Spot): void {
    const b = this.b, u = this.mine(); if (!b || !u) return;
    if (this.verb) {
      // what you see lit under the pointer is what you get; else whatever is aimed at the clicked tile
      const a = this.aimAff ?? this.aimedAt(this.verb, s);
      if (a) { this.run(u, { to: a.to, action: a.action, label: a.label, p: a.p, notes: a.notes, score: 0 }); return; }
      this.setVerb(null); return;
    }
    const foe = b.unitAt(s.x, s.z);
    if (foe && foe.side !== u.side && !u.acted) {
      const a: Action = { kind: 'attack', target: foe.id };
      if (b.options(u).some((o) => o.kind === 'attack' && o.target === foe.id)) { this.err = b.act(u, a) || ''; this.refresh(); return; }
    }
    if (!(u.moved && u.acted)) { this.err = b.moveTo(u, s) || ''; this.refresh(); }
  }

  hoverTile(s: Spot | null): void { if (this.r) this.r.hover = s; }

  private highlight(): void {
    const b = this.b, r = this.r; if (!b || !r) return;
    const u = this.mine();
    r.reach.clear(); r.targets.clear(); r.path = []; r.usable.clear(); r.preview = null;
    if (!u || b.outcome) return;
    for (const a of this.options()) if (a.subject?.kind === 'prop') { const p = b.map.props.get(a.subject.id); if (p && !(p.kind === 'tree' && a.action.kind === 'hew' && !a.catches.length)) r.usable.add(key(p.x, p.z)); }
    const vk = this.verb ?? this.hoverVerb;
    this.aimAff = this.verb && r.hover ? this.aimedAt(this.verb, r.hover) : null;
    const hv = this.hoverAff ?? (this.aimAff ? { to: this.aimAff.to, action: this.aimAff.action } : null);
    const aims = new Set<string>();
    if (vk) for (const a of this.options()) if (verbOf(u, a.action).key === vk) { const t = aimOf(b, u, a.action); if (t) aims.add(key(t.x, t.z)); }
    if (vk && !hv) r.preview = { subject: aims, effect: new Set() };
    if (hv) {
      const from = hv.to ?? u;
      const f = forecast(b, u, hv.action, from);
      const subj = new Set<string>();
      const a = hv.action as Record<string, unknown>;
      const pid = (a.prop ?? (hv.action.kind === 'shove' && !b.get(a.target as Unit['id']) ? a.target : undefined)) as string | undefined;
      const pr = pid ? b.map.props.get(pid) : undefined;
      if (pr) subj.add(key(pr.x, pr.z));
      const tu = a.target != null ? b.get(a.target as Unit['id']) : undefined;
      if (tu) subj.add(key(tu.x, tu.z));
      if (hv.action.kind === 'ignite' || hv.action.kind === 'throw' || hv.action.kind === 'douse') { const at = (hv.action as { at: Spot }).at; subj.add(key(at.x, at.z)); }
      for (const k of aims) subj.add(k);
      r.preview = { subject: subj, effect: new Set(f.footprint.map((t) => key(t.x, t.z))) };
      if (hv.to) { const p = b.reachable(u).get(key(hv.to.x, hv.to.z)); if (p) r.path = p.path; }
    }
    if (!(u.moved && u.acted)) {
      const reach = b.reachable(u);
      for (const k of reach.keys()) r.reach.add(k);
      if (r.hover && !hv) { const p = reach.get(key(r.hover.x, r.hover.z)); if (p) r.path = p.path; }
    }
    if (!u.acted) for (const o of b.options(u)) if (o.kind === 'attack' || o.kind === 'ability') { const t = b.get(o.target); if (t) r.targets.add(key(t.x, t.z)); }
  }

  private run(u: Unit, reading: GridReading): void {
    const b = this.b!;
    if (this.draft.trim() && !this.auto) this.fx?.setQuote(this.draft.trim());
    if (reading.to) { const e = b.moveTo(u, reading.to); if (e) { this.err = e; this.refresh(); return; } }
    if (b.current() === u && !u.acted) this.err = b.act(u, reading.action, this.draft.trim() || undefined) || '';
    this.draft = ''; this.readings = []; this.verb = null; this.aimAff = null; this.hoverAff = null;
    this.refresh();
  }

  refresh(): void {
    const b = this.b, root = this.root; if (!b || !root) return;
    const u = b.current(), mine = this.mine();
    const hp = (x: Unit) => Math.max(0, Math.round(x.agent.fighter.health / TUNE.maxHealth * 100));
    const status = (x: Unit) => [x.out, x.burning ? 'burning' : '', x.prone ? 'prone' : '', x.exposed ? 'exposed' : '', x.defending ? 'braced' : '',
      x.overwatch ? 'overwatch' : '', x.blocking ? 'blocking' : '', x.readied ? `ready: ${describeTrigger(b, x.readied.trigger)}` : '', x.morale !== 'steady' ? x.morale : '',
      x.carrying ? `holding ${x.carrying.name}` : ''].filter(Boolean).join(' · ');

    const order = b.order.map((x) => `<span class="${x.side} ${x === u ? 'cur' : ''} ${x.out && x.out !== 'downed' ? 'out' : ''}">${esc(b.nm(x, true))}</span>`).join('');
    let body = '';
    if (b.outcome) {
      body = `<div class="who"><b>${esc(b.log[b.log.length - 1]?.text ?? 'The battle is over.')}</b></div><div class="row"><button data-x="continue">Continue</button></div>`;
    } else if (!u) {
      body = '';
    } else if (!mine) {
      const o = b.objectiveOf(u);
      const trait = u.traits && u.role === 'companion' ? ` · bravery ${u.traits.bravery.toFixed(2)} · compassion ${u.traits.compassion.toFixed(2)} · loyalty ${u.traits.loyalty.toFixed(2)}` : '';
      body = `<div class="who"><b>${esc(b.nm(u, true))}</b> <span class="st">${u.side === 'us' ? (u.role === 'companion' ? 'companion' : 'ally') : `foe · ${u.tactic}`} · ${esc(o.label)}${trait}</span></div>
        <div class="bar"><i style="width:${hp(u)}%"></i></div><div class="st">${esc(status(u))}</div>`;
    } else {
      const all = this.options();
      const verbs = new Map<string, { v: ReturnType<typeof verbOf>; n: number; hot: boolean; only: number }>();
      all.forEach((a, i) => {
        const vb = verbOf(mine, a.action);
        const e = verbs.get(vb.key) ?? verbs.set(vb.key, { v: vb, n: 0, hot: false, only: i }).get(vb.key)!;
        e.n += 1;
        if (a.catches.some((w) => w.side !== mine.side)) e.hot = true;
      });
      const btn = (e: { v: ReturnType<typeof verbOf>; n: number; hot: boolean; only: number }) => e.v.group === 'Stance'
        ? `<button class="verb" data-f="${e.only}" title="${esc(all[e.only].effect)}">${esc(e.v.name)}</button>`
        : `<button class="verb ${e.v.env ? 'env' : ''} ${e.hot ? 'hot' : ''} ${this.verb === e.v.key ? 'sel' : ''}" data-v="${esc(e.v.key)}">${e.v.icon} ${esc(e.v.name)}<span class="n">${e.n}</span></button>`;
      const groups: Record<string, string[]> = { Environment: [], Fight: [], People: [], Stance: [] };
      for (const e of verbs.values()) groups[e.v.group].push(btn(e));
      const sel = this.verb ? verbs.get(this.verb) : undefined;
      const pickHtml = sel ? `<div class="pick">${sel.v.name}: click a highlighted target (${sel.n})<button data-x="unverb">cancel</button></div>` : '';
      const chips = this.readings.map((r, i) => `<button class="chip ${i ? 'alt' : ''}" data-r="${i}">${esc(r.label)}${r.p < 1 ? `<span class="p">${pct(r.p)}</span>` : ''}${r.notes.length ? ` <i style="color:#8d99a6">· ${esc(r.notes.join(', '))}</i>` : ''}</button>`).join('');
      body = `<div class="who"><b>${esc(mine.role === 'player' ? 'Your turn' : `Command ${mine.agent.name}`)}</b> <span class="st">${mine.moved ? 'moved' : 'can move'} · ${mine.acted ? 'acted' : 'can act'}</span></div>
        <div class="bar"><i style="width:${hp(mine)}%"></i></div><div class="st">${esc(status(mine))}</div>
        ${Object.entries(groups).filter(([, v]) => v.length).map(([k, v]) => `<div class="grp"><h5>${k === 'Environment' ? 'Use the field' : k}</h5><div class="verbs">${v.join('')}</div></div>`).join('')}${pickHtml}${all.length ? '' : '<div class="st">You have acted — move, or end your turn.</div>'}
        <input id="tac-in" placeholder="Describe what ${mine.role === 'player' ? 'you do' : esc(mine.agent.name) + ' does'}… (Enter)" value="${esc(this.draft)}" autocomplete="off">
        <div class="chips">${chips}</div><div class="err">${esc(this.err)}</div>
        <div class="row">${mine.moved && !mine.acted ? '<button data-x="dash">Dash</button>' : ''}<button data-x="end">End turn</button></div>
        <div class="hint">Blue: move · red: attack · <span style="color:#d8a24a">amber: things you can use</span>. Pick a verb — the number is how many things you can do it to this turn — then click a lit target (hover one to see what happens). Or write it: "kick the brazier into Garrick", "if anyone goes for Borin, shove them".</div>`;
    }
    const lines: string[] = []; let rd = -1;
    for (const l of b.log.slice(-60)) { if (l.round !== rd) { lines.push(`<div class="rd">— round ${l.round} —</div>`); rd = l.round; } lines.push(`<div class="${l.kind}">${esc(l.text)}</div>`); }
    root.innerHTML = `<div class="card"><div class="hd"><b>Round ${b.round}</b><span>${b.outcome ? 'over' : u ? esc(b.nm(u, true)) + "'s turn" : ''}</span></div>
        ${b.highStakes && !b.outcome ? `<div class="stakes">High stakes — ${esc(b.stakesReason)}. You command your companions.</div>` : ''}
        <div class="order">${order}</div></div>
      <div class="card">${body}</div>
      <div class="card log" id="tac-log">${lines.join('')}</div>`;
    const log = root.querySelector('#tac-log'); if (log) log.scrollTop = log.scrollHeight;
    root.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((el) => el.onclick = () => {
      const m = this.mine(); if (!m) return;
      this.err = b.act(m, JSON.parse(el.dataset.a!)) || ''; this.refresh();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((el) => {
      el.onclick = () => { const m = this.mine(); const r = this.readings[+el.dataset.r!]; if (m && r) this.run(m, r); };
      el.onmouseenter = () => { const r = this.readings[+el.dataset.r!]; if (r) this.hoverAff = { to: r.to, action: r.action }; };
      el.onmouseleave = () => { this.hoverAff = null; };
    });
    root.querySelectorAll<HTMLButtonElement>('[data-f]').forEach((el) => {
      const a = this.aff[+el.dataset.f!];
      el.onclick = () => { const m = this.mine(); if (!m || !a) return; this.run(m, { to: a.to, action: a.action, label: a.label, p: a.p, notes: a.notes, score: 0 }); };
    });
    root.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((el) => {
      const vk = el.dataset.v!;
      el.onclick = () => this.setVerb(this.verb === vk ? null : vk);
      el.onmouseenter = () => { this.hoverVerb = vk; };
      el.onmouseleave = () => { this.hoverVerb = null; };
    });
        root.querySelectorAll<HTMLButtonElement>('[data-x]').forEach((el) => el.onclick = () => {
      const m = this.mine();
      if (el.dataset.x === 'continue') { this.onEnd?.(b); return; }
      if (el.dataset.x === 'unverb') { this.setVerb(null); return; }
      if (!m) return;
      if (el.dataset.x === 'end') { b.endTurn(m); this.verb = null; }
      if (el.dataset.x === 'dash') this.err = b.act(m, { kind: 'dash' }) || '';
      this.refresh();
    });
    const inp = root.querySelector<HTMLInputElement>('#tac-in');
    if (inp) {
      inp.oninput = () => {
        this.draft = inp.value; const m = this.mine();
        this.readings = m ? readWriteIn(b, m, this.draft) : [];
        this.llmUnsupported = null;
        this.err = this.draft.trim() && !this.readings.length && m ? `Not possible: ${explainUnmet(b, m, this.draft)}.` : '';
        this.refresh();
        if (m && this.draft.trim()) this.askModel(b, m, this.draft);
      };
      inp.onkeydown = (e) => {
        const m = this.mine(); if (e.key !== 'Enter' || !m) return;
        if (this.readings[0]) { this.run(m, this.readings[0]); return; }
        if (!this.draft.trim()) return;
        // can't be done — say why, and keep it: it's the list of things players want that the rules lack
        const reason = this.llmUnsupported ? `the rules don't cover ${this.llmUnsupported} yet` : explainUnmet(b, m, this.draft);
        recordUnmet(b, m, this.draft.trim(), reason, this.where);
        this.err = `Not possible: ${reason}. The GM has noted the request.`;
        this.draft = ''; this.refresh();
      };
      if (this.draft) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
  }
}
