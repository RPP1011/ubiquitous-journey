// TacticsView: the DOM side of a tactical battle — turn order, the acting unit, context actions
// with odds, a WRITE-IN box, and the log. Drives NPC turns at a watchable pace. Every order goes
// through the Battle API (moveTo / act / endTurn); the view never mutates battle state itself.

import { TUNE } from '../constants.js';
import { runTurn, planTurn } from '../app/tactics/ai.js';
import { phrase } from '../app/run/autopilot.js';
import { readWriteIn, describeTrigger, type GridReading } from '../app/tactics/writein.js';
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
  private cap: HTMLDivElement | null = null;
  private capT = 0;
  private seenLog = 0;
  private lastTyped: string | null = null;
  /** The choreographer playing this battle's cues (NPC turns and autopilot wait on it). */
  fx: BattleFX | null = null;

  constructor() {
    if (typeof document === 'undefined') return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.root = document.createElement('div'); this.root.id = 'tac'; this.root.className = 'hidden';
    document.body.appendChild(this.root);
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    this.cap = document.createElement('div'); this.cap.id = 'tac-cap'; document.body.appendChild(this.cap);
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
  close(): void { if (this.cap) this.cap.className = ''; this.b = null; this.r = null; this.root?.classList.add('hidden'); if (this.root) this.root.innerHTML = ''; }

  private mine(): Unit | null { const u = this.b?.current(); return u && this.b!.playerControls(u) ? u : null; }

  /** Per frame: pace NPC turns, keep highlights in sync. */
  tick(dt: number): void {
    const b = this.b; if (!b) return;
    this.fx?.update(dt);
    const busy = !!this.fx && this.fx.busy;
    const u = b.current();
    if (busy) { this.highlight(); this.caption(dt); this.r?.sync(dt); return; }
    if (!b.outcome && u && !b.playerControls(u)) {
      this.npcTimer += dt;
      if (this.npcTimer > this.pace) { this.npcTimer = 0; runTurn(b, u); this.refresh(); }
    } else this.npcTimer = 0;
    if (this.auto && !b.outcome && u && b.playerControls(u)) this.autoStep(b, u, dt);
    this.highlight();
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

  /** A click on the grid: move to a reachable tile, or strike a foe you can reach. */
  clickTile(s: Spot): void {
    const b = this.b, u = this.mine(); if (!b || !u) return;
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
    r.reach.clear(); r.targets.clear(); r.path = [];
    if (!u || b.outcome) return;
    if (!(u.moved && u.acted)) {
      const reach = b.reachable(u);
      for (const k of reach.keys()) r.reach.add(k);
      if (r.hover) { const p = reach.get(key(r.hover.x, r.hover.z)); if (p) r.path = p.path; }
    }
    if (!u.acted) for (const o of b.options(u)) if (o.kind === 'attack' || o.kind === 'ability') { const t = b.get(o.target); if (t) r.targets.add(key(t.x, t.z)); }
  }

  private run(u: Unit, reading: GridReading): void {
    const b = this.b!;
    if (this.draft.trim() && !this.auto) this.fx?.setQuote(this.draft.trim());
    if (reading.to) { const e = b.moveTo(u, reading.to); if (e) { this.err = e; this.refresh(); return; } }
    if (b.current() === u && !u.acted) this.err = b.act(u, reading.action, this.draft.trim() || undefined) || '';
    this.draft = ''; this.readings = [];
    this.refresh();
  }

  private label(b: Battle, u: Unit, a: Action): string {
    const T = (id: unknown) => { const t = b.get(id as Unit['id']); return t ? b.nm(t) : '?'; };
    const P = (id: string) => b.map.props.get(id)?.name ?? u.carrying?.name ?? 'it';
    switch (a.kind) {
      case 'attack': return `Attack ${T(a.target)}`;
      case 'ability': return `${u.agent.abilities.get(a.abilityId)?.name ?? 'Ability'} → ${T(a.target)}`;
      case 'shove': return b.get(a.target as Unit['id']) ? `Shove ${T(a.target)}` : `Shove ${P(String(a.target))}`;
      case 'kick': return `Kick ${P(a.prop)}`;
      case 'throw': return `Throw ${P(a.prop)} at ${b.unitAt(a.at.x, a.at.z) ? b.nm(b.unitAt(a.at.x, a.at.z)!) : 'there'}`;
      case 'ignite': return `Set ${b.map.propAt(a.at.x, a.at.z)?.name ?? 'the grass'} alight`;
      case 'douse': return 'Douse';
      case 'pickup': return `Pick up ${P(a.prop)}`;
      case 'grab': return `Grab ${T(a.target)}'s purse`;
      case 'subdue': return `Subdue ${T(a.target)}`;
      case 'aid': return a.target === u.id ? 'Patch yourself up' : `Aid ${T(a.target)}`;
      case 'guard': return `Guard ${T(a.target)}`;
      case 'social': return `${a.verb[0].toUpperCase() + a.verb.slice(1)}${a.target != null ? ' ' + T(a.target) : ''}`;
      case 'ready': return `Ready (${describeTrigger(b, a.trigger)})`;
      default: return a.kind[0].toUpperCase() + a.kind.slice(1);
    }
  }

  refresh(): void {
    const b = this.b, root = this.root; if (!b || !root) return;
    const u = b.current(), mine = this.mine();
    const hp = (x: Unit) => Math.max(0, Math.round(x.agent.fighter.health / TUNE.maxHealth * 100));
    const status = (x: Unit) => [x.out, x.burning ? 'burning' : '', x.prone ? 'prone' : '', x.exposed ? 'exposed' : '', x.defending ? 'braced' : '',
      x.overwatch ? 'overwatch' : '', x.readied ? `ready: ${describeTrigger(b, x.readied.trigger)}` : '', x.morale !== 'steady' ? x.morale : '',
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
      const opts = b.options(mine).filter((a) => !mine.acted);
      const groups: Record<string, string[]> = { Fight: [], Environment: [], People: [], Stance: [] };
      const seen = new Set<string>();
      opts.forEach((a) => {
        const lbl = this.label(b, mine, a);
        if (seen.has(lbl)) return; seen.add(lbl);
        const o = b.odds(mine, a);
        const g = ['attack', 'ability', 'subdue', 'grab'].includes(a.kind) || (a.kind === 'shove' && b.get(a.target as Unit['id'])) ? 'Fight'
          : ['kick', 'throw', 'ignite', 'douse', 'pickup', 'shove'].includes(a.kind) ? 'Environment'
          : a.kind === 'social' || a.kind === 'aid' || a.kind === 'guard' ? 'People' : 'Stance';
        groups[g].push(`<button data-a='${esc(JSON.stringify(a))}' title="${esc(o.notes.join(', '))}">${esc(lbl)}${o.p < 1 ? `<span class="p">${pct(o.p)}</span>` : ''}</button>`);
      });
      const chips = this.readings.map((r, i) => `<button class="chip ${i ? 'alt' : ''}" data-r="${i}">${esc(r.label)}${r.p < 1 ? `<span class="p">${pct(r.p)}</span>` : ''}${r.notes.length ? ` <i style="color:#8d99a6">· ${esc(r.notes.join(', '))}</i>` : ''}</button>`).join('');
      body = `<div class="who"><b>${esc(mine.role === 'player' ? 'Your turn' : `Command ${mine.agent.name}`)}</b> <span class="st">${mine.moved ? 'moved' : 'can move'} · ${mine.acted ? 'acted' : 'can act'}</span></div>
        <div class="bar"><i style="width:${hp(mine)}%"></i></div><div class="st">${esc(status(mine))}</div>
        ${Object.entries(groups).filter(([, v]) => v.length).map(([k, v]) => `<div class="grp"><h5>${k}</h5><div class="acts">${v.join('')}</div></div>`).join('')}
        <input id="tac-in" placeholder="Describe what ${mine.role === 'player' ? 'you do' : esc(mine.agent.name) + ' does'}… (Enter)" value="${esc(this.draft)}" autocomplete="off">
        <div class="chips">${chips}</div><div class="err">${esc(this.err)}</div>
        <div class="row">${mine.moved && !mine.acted ? '<button data-x="dash">Dash</button>' : ''}<button data-x="end">End turn</button></div>
        <div class="hint">Click a blue tile to move, a red one to attack. Try: "kick the brazier into Garrick", "if anyone goes for Borin, shove them".</div>`;
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
    root.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((el) => el.onclick = () => { const m = this.mine(); const r = this.readings[+el.dataset.r!]; if (m && r) this.run(m, r); });
    root.querySelectorAll<HTMLButtonElement>('[data-x]').forEach((el) => el.onclick = () => {
      const m = this.mine();
      if (el.dataset.x === 'continue') { this.onEnd?.(b); return; }
      if (!m) return;
      if (el.dataset.x === 'end') b.endTurn(m);
      if (el.dataset.x === 'dash') this.err = b.act(m, { kind: 'dash' }) || '';
      this.refresh();
    });
    const inp = root.querySelector<HTMLInputElement>('#tac-in');
    if (inp) {
      inp.oninput = () => { this.draft = inp.value; const m = this.mine(); this.readings = m ? readWriteIn(b, m, this.draft) : []; this.err = this.draft.trim() && !this.readings.length ? "The GM can't place that — name something on the field." : ''; this.refresh(); };
      inp.onkeydown = (e) => { const m = this.mine(); if (e.key === 'Enter' && m && this.readings[0]) this.run(m, this.readings[0]); };
      if (this.draft) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
  }
}
