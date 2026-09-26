// EncounterView: the DOM panel for a turn-based fight (js/app/combat/encounter.ts).
//
// Shows both sides (HP, role, status), whose turn it is to declare (you, or a companion you
// command when stakes are high), quick-action buttons, and a WRITE-IN box: type what you do,
// see how the GM reads it ("Trip → Garrick · finesse vs DC 13 · 55%"), Enter to commit.
// Self-injects its CSS + root, like DialogueView. It never mutates the sim directly — every
// order goes through Encounter.declare(); resolution is triggered via onReady().

import { isEnabled } from '../ai/llm.js';
import { llmParse } from '../app/combat/parse.js';
import { TUNE } from '../constants.js';
import type { Combatant, Encounter, Preview } from '../app/combat/encounter.js';
import type { Intent, CombatVerb } from '../app/combat/intent.js';
import { TARGETING } from '../app/combat/intent.js';

const CSS = `
#enc { position: fixed; right: 14px; top: 14px; bottom: 14px; width: min(430px, 94vw);
  display: flex; flex-direction: column; gap: 8px; z-index: 31; pointer-events: auto;
  font-family: "Segoe UI", system-ui, sans-serif; color: #dfe6ee; }
#enc.hidden { display: none; }
#enc .card { background: rgba(10,13,18,.94); border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
  box-shadow: 0 8px 40px rgba(0,0,0,.55); padding: 10px 12px; }
#enc .hd { display: flex; justify-content: space-between; align-items: baseline; }
#enc .hd b { font-size: 15px; letter-spacing: .3px; }
#enc .hd span { font-size: 11px; color: #8d99a6; }
#enc .stakes { margin-top: 6px; font-size: 12px; color: #f0c674; }
#enc .sides { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
#enc .side h4 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: #8d99a6; }
#enc .who { display: block; width: 100%; text-align: left; background: rgba(255,255,255,.04); border: 1px solid transparent;
  border-radius: 6px; padding: 4px 6px; margin-bottom: 4px; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
#enc .who:hover { border-color: rgba(255,255,255,.25); }
#enc .who.sel { border-color: #e8c879; background: rgba(232,200,121,.14); }
#enc .who.out { opacity: .45; cursor: default; }
#enc .who .nm { display: flex; justify-content: space-between; gap: 6px; }
#enc .who .tag { font-size: 10px; color: #8d99a6; }
#enc .bar { height: 4px; background: rgba(255,255,255,.1); border-radius: 2px; margin-top: 3px; overflow: hidden; }
#enc .bar i { display: block; height: 100%; background: #6fcf7f; }
#enc .them .bar i { background: #e07b6a; }
#enc .st { font-size: 10px; color: #f0c674; }
#enc .turn { font-size: 13px; margin-bottom: 6px; }
#enc .acts { display: flex; flex-wrap: wrap; gap: 4px; }
#enc .acts button, #enc .go { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); color: #dfe6ee;
  border-radius: 5px; padding: 4px 8px; font: inherit; font-size: 12px; cursor: pointer; }
#enc .acts button:hover, #enc .go:hover { background: rgba(232,200,121,.2); border-color: rgba(232,200,121,.55); }
#enc .acts button.ab { border-color: rgba(120,170,255,.45); }
#enc input { width: 100%; box-sizing: border-box; margin-top: 8px; background: rgba(0,0,0,.35); color: #eef3f8;
  border: 1px solid rgba(255,255,255,.2); border-radius: 6px; padding: 7px 9px; font: inherit; font-size: 13px; }
#enc .chips { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
#enc .chip { text-align: left; background: rgba(232,200,121,.1); border: 1px solid rgba(232,200,121,.35); color: #eee;
  border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 12px; cursor: pointer; }
#enc .chip.alt { background: rgba(255,255,255,.04); border-color: rgba(255,255,255,.15); }
#enc .chip .odds { float: right; color: #f0c674; }
#enc .err { color: #e89090; font-size: 12px; margin-top: 4px; min-height: 14px; }
#enc .log { flex: 1; overflow-y: auto; font-size: 12px; line-height: 1.5; }
#enc .log div { padding: 1px 0; }
#enc .log .hit { color: #eef3f8; } #enc .log .miss { color: #9aa6b2; } #enc .log .social { color: #b9a3f0; }
#enc .log .join { color: #8fe39a; } #enc .log .morale { color: #f0c674; } #enc .log .end { color: #e8c879; font-weight: 700; }
#enc .log .rd { color: #6f7b88; font-size: 10px; margin-top: 4px; }
#enc .foot { font-size: 10px; color: #6f7b88; margin-top: 6px; }
`;

const QUICK: Array<[CombatVerb, string]> = [
  ['strike', 'Strike'], ['defend', 'Defend'], ['shove', 'Shove'], ['trip', 'Trip'], ['feint', 'Feint'],
  ['intimidate', 'Intimidate'], ['taunt', 'Taunt'], ['bluff', 'Bluff'], ['rally', 'Rally'],
  ['guard', 'Guard ally'], ['aid', 'Aid'], ['flee', 'Flee'], ['parley', 'Parley'],
];

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export class EncounterView {
  onReady: (() => void) | null = null;
  onContinue: (() => void) | null = null;
  private root: HTMLDivElement | null = null;
  private enc: Encounter | null = null;
  private selFoe: number | string | null = null;
  private selAlly: number | string | null = null;
  private draft = '';
  private readings: Preview[] = [];
  private error = '';
  private llmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof document === 'undefined') return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.root = document.createElement('div'); this.root.id = 'enc'; this.root.className = 'hidden';
    document.body.appendChild(this.root);
    // keystrokes inside the panel must not reach the global key map (R restarts the world!)
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean { return !!this.enc; }

  open(enc: Encounter): void {
    this.enc = enc; this.selFoe = null; this.selAlly = null; this.draft = ''; this.readings = []; this.error = '';
    this.root?.classList.remove('hidden');
    this.render();
  }

  close(): void { this.enc = null; this.root?.classList.add('hidden'); if (this.root) this.root.innerHTML = ''; }

  private actor(): Combatant | null { return this.enc ? this.enc.pendingDeclarers()[0] ?? null : null; }

  private commit(intent: Intent): void {
    const e = this.enc, c = this.actor();
    if (!e || !c) return;
    const err = e.declare(c, intent);
    this.error = err || '';
    if (!err) { this.draft = ''; this.readings = []; }
    if (!err && e.pendingDeclarers().length === 0) { this.onReady?.(); return; }
    this.render();
  }

  private quick(verb: CombatVerb): void {
    const e = this.enc, c = this.actor();
    if (!e || !c) return;
    const need = TARGETING[verb];
    const foe = this.selFoe ?? e.manifestFor(c).currentTargetId;
    const i: Intent = { verb };
    if (need === 'foe') i.targetId = foe ?? undefined;
    if (need === 'ally') i.targetId = verb === 'aid' ? (this.selAlly ?? c.agent.id) : (this.selAlly ?? undefined);
    if (verb === 'bluff') { i.claim = 'look_behind'; i.targetId = foe ?? undefined; }
    this.commit(i);
  }

  private reread(): void {
    const e = this.enc, c = this.actor();
    if (!e || !c) return;
    this.readings = this.draft.trim() ? e.readWriteIn(c, this.draft).slice(0, 3).map((r) => e.preview(c, r.intent)) : [];
    this.error = this.draft.trim() && !this.readings.length ? 'The GM can\'t make that out — try naming a verb and a target.' : '';
    // the optional LLM reading upgrades the top chip when it answers in time
    if (this.llmTimer) clearTimeout(this.llmTimer);
    if (this.draft.trim() && isEnabled()) {
      const text = this.draft, who = c;
      this.llmTimer = setTimeout(async () => {
        const i = await llmParse(text, e.manifestFor(who));
        if (i && this.enc === e && this.draft === text && this.actor() === who) {
          const p = e.preview(who, i);
          if (!this.readings.length || this.readings[0].label !== p.label) { this.readings.unshift({ ...p, note: `✦ ${p.note}`.trim() }); this.render(); }
        }
      }, 450);
    }
    this.render();
  }

  render(): void {
    const e = this.enc, root = this.root;
    if (!e || !root) return;
    const c = this.actor();
    const hp = (x: Combatant) => Math.max(0, Math.round((x.agent.fighter.health / TUNE.maxHealth) * 100));
    const status = (x: Combatant) => [x.out, x.morale !== 'steady' ? x.morale : null, x.exposed ? 'exposed' : null,
      x.defending ? 'braced' : null, x.tauntedBy ? 'taunted' : null, x.turnedOn ? `hunting ${x.turnedOn.agent.name}` : null]
      .filter(Boolean).join(' · ');
    const row = (x: Combatant) => {
      const sel = (x.side === 'them' ? this.selFoe : this.selAlly) === x.agent.id;
      const tag = x.role === 'player' ? 'you' : x.role;
      return `<button class="who ${sel ? 'sel' : ''} ${x.out && x.out !== 'downed' ? 'out' : ''}" data-id="${esc(String(x.agent.id))}" data-side="${x.side}">
        <span class="nm"><span>${esc(x.agent.controlled ? 'You' : x.agent.name)}</span><span class="tag">${tag}</span></span>
        <div class="bar"><i style="width:${hp(x)}%"></i></div><span class="st">${esc(status(x))}</span></button>`;
    };
    const us = e.members.filter((m) => m.side === 'us'), them = e.members.filter((m) => m.side === 'them');
    const phaseLbl = e.phase === 'declare' ? 'declare' : e.phase === 'playback' ? 'resolving…' : 'over';

    let control = '';
    if (e.phase === 'over') {
      control = `<div class="turn">${esc(e.log[e.log.length - 1]?.text || 'The fight is over.')}</div><button class="go" data-act="continue">Continue</button>`;
    } else if (e.phase === 'playback') {
      control = `<div class="turn">The round plays out…</div>`;
    } else if (!c) {
      control = `<div class="turn">You are down. Your side fights on…</div><button class="go" data-act="ready">Next round</button>`;
    } else {
      const commanded = c.role === 'companion';
      const abil = [...(c.agent.abilities?.values?.() ?? [])].map((s) => {
        const ready = (c.readyRound.get(s.id) ?? 0) <= e.round;
        return `<button class="ab" data-ab="${esc(s.id)}" ${ready ? '' : 'disabled title="not ready"'}>${esc(s.name)}</button>`;
      }).join('');
      const chips = this.readings.map((p, i) =>
        `<button class="chip ${i ? 'alt' : ''}" data-chip="${i}">${esc(p.label)}${p.stat ? ` · ${p.stat} vs DC ${p.dc}` : ''}${p.note ? ` · <i>${esc(p.note)}</i>` : ''}<span class="odds">${p.chance != null ? Math.round(p.chance * 100) + '%' : ''}</span></button>`).join('');
      control = `<div class="turn">${commanded ? `<b>Command ${esc(c.agent.name)}</b> — what do they do?` : '<b>Your move.</b> Pick a target on the left, then act — or write it in.'}</div>
        <div class="acts">${QUICK.map(([v, l]) => `<button data-q="${v}">${l}</button>`).join('')}${abil}</div>
        <input id="enc-in" placeholder="Describe what ${commanded ? esc(c.agent.name) + ' does' : 'you do'}… (Enter to commit)" value="${esc(this.draft)}" autocomplete="off">
        <div class="chips">${chips}</div><div class="err">${esc(this.error)}</div>`;
    }

    const lines: string[] = [];
    let lastRound = -1;
    for (const l of e.log.slice(-40)) {
      if (l.round !== lastRound) { lines.push(`<div class="rd">— round ${l.round} —</div>`); lastRound = l.round; }
      lines.push(`<div class="${l.kind}">${esc(l.text)}</div>`);
    }

    root.innerHTML = `
      <div class="card"><div class="hd"><b>Round ${e.round}</b><span>${phaseLbl}</span></div>
        ${e.highStakes && e.phase !== 'over' ? `<div class="stakes">High stakes — ${esc(e.stakesReason)}. Your companions take your orders.</div>` : ''}</div>
      <div class="card sides"><div class="side us"><h4>Your side</h4>${us.map(row).join('')}</div>
        <div class="side them"><h4>Against you</h4>${them.map(row).join('')}</div></div>
      <div class="card">${control}<div class="foot">Write-ins are read by the GM into one action; the odds show before you commit.</div></div>
      <div class="card log" id="enc-log">${lines.join('')}</div>`;

    const logEl = root.querySelector('#enc-log'); if (logEl) logEl.scrollTop = logEl.scrollHeight;
    root.querySelectorAll<HTMLButtonElement>('.who').forEach((b) => b.onclick = () => {
      const id = e.members.find((m) => String(m.agent.id) === b.dataset.id)?.agent.id ?? null;
      if (b.dataset.side === 'them') this.selFoe = id; else this.selAlly = id;
      this.render();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) => b.onclick = () => this.quick(b.dataset.q as CombatVerb));
    root.querySelectorAll<HTMLButtonElement>('[data-ab]').forEach((b) => b.onclick = () => {
      const cc = this.actor(); if (!cc) return;
      this.commit({ verb: 'ability', abilityId: b.dataset.ab, targetId: (this.selFoe ?? e.manifestFor(cc).currentTargetId) ?? undefined });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-chip]').forEach((b) => b.onclick = () => { const p = this.readings[+b.dataset.chip!]; if (p) this.commit(p.intent); });
    const cont = root.querySelector<HTMLButtonElement>('[data-act="continue"]'); if (cont) cont.onclick = () => this.onContinue?.();
    const ready = root.querySelector<HTMLButtonElement>('[data-act="ready"]'); if (ready) ready.onclick = () => this.onReady?.();
    const inp = root.querySelector<HTMLInputElement>('#enc-in');
    if (inp) {
      inp.oninput = () => { this.draft = inp.value; this.reread(); };
      inp.onkeydown = (ev) => { if (ev.key === 'Enter' && this.readings[0]) this.commit(this.readings[0].intent); };
      // keep focus + caret across re-renders
      if (this.draft) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
  }
}
