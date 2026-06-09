// DialogueView: the DOM modal that renders a DialogueSession. It self-injects
// its own CSS + a root node at construction (no index.html edits required), so
// the integrator only has to open()/close() it. Options are clickable buttons;
// number keys 1..9 select, Esc/Q leave. The greeting is tinted by how the NPC
// feels about the player (standing). Sim keeps ticking behind the modal; the
// integrator freezes player control by setting game.state = 'dialogue'.
//
// OPTIONAL LLM flavour: when the (default-OFF) LLM feature is enabled and the
// vLLM server is reachable, the templated greeting/response is shown IMMEDIATELY
// and then transparently swapped for a model-written line if one arrives in time
// (~3s budget). If the feature is off, the server is down, or the call fails,
// nothing here changes and the modal behaves exactly as before.

import { generateLine, isEnabled } from '../ai/llm.js';
import type { DialogueSession, DialogueOption, DialogueResult, Tone } from '../dialogue/dialogue.js';

const CSS = `
#dlg { position: fixed; left: 50%; bottom: 7%; transform: translateX(-50%);
       width: min(560px, 92vw); background: rgba(10,13,18,.94);
       border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
       box-shadow: 0 8px 40px rgba(0,0,0,.6); color: #dfe6ee; z-index: 30;
       font-family: "Segoe UI", system-ui, sans-serif; backdrop-filter: blur(3px);
       pointer-events: auto; overflow: hidden; }
#dlg.hidden { display: none; }
#dlg .dlg-name { font-size: 15px; font-weight: 700; padding: 11px 16px 0; letter-spacing: .3px; }
#dlg .dlg-name .stand { font-size: 11px; font-weight: 400; margin-left: 8px; }
#dlg .dlg-say { padding: 6px 16px 12px; font-size: 14px; line-height: 1.55; color: #eef3f8; min-height: 22px; }
#dlg .dlg-say.good { color: #8fe39a; } #dlg .dlg-say.bad { color: #e89090; }
#dlg .dlg-opts { border-top: 1px solid rgba(255,255,255,.10); padding: 8px; display: flex; flex-direction: column; gap: 5px; }
#dlg .dlg-opt { display: flex; align-items: center; gap: 9px; text-align: left; cursor: pointer;
       background: rgba(255,255,255,.05); border: 1px solid transparent; color: #dfe6ee;
       border-radius: 6px; padding: 7px 11px; font-size: 13px; font-family: inherit; }
#dlg .dlg-opt:hover, #dlg .dlg-opt.kbsel { background: rgba(232,200,121,.18); border-color: rgba(232,200,121,.5); }
#dlg .dlg-opt .num { font-size: 10px; color: #7c8896; border: 1px solid rgba(255,255,255,.18);
       border-radius: 3px; padding: 0 5px; line-height: 16px; min-width: 16px; text-align: center; }
#dlg .dlg-opt.leave { opacity: .8; }
#dlg .dlg-foot { padding: 5px 16px 9px; font-size: 10px; color: #6f7b88; }
`;

export class DialogueView {
  isOpen: boolean;
  session: DialogueSession | null;
  onClose: (() => void) | null;
  _sayToken: number;
  _situation: string | null;
  _opts: DialogueOption[];
  el!: HTMLElement;
  nameEl!: HTMLElement;
  sayEl!: HTMLElement;
  optsEl!: HTMLElement;
  _key: (e: KeyboardEvent) => void;

  constructor() {
    this.isOpen = false;
    this.session = null;
    this.onClose = null;        // optional callback when the modal closes
    this._sayToken = 0;         // bumped each time the spoken line changes; lets a
                                // slow async LLM line refuse to clobber a newer turn
    this._situation = null;
    this._opts = [];
    this._injectCss();
    this._build();
    this._key = (e: KeyboardEvent) => this._onKey(e);
  }

  _injectCss(): void {
    if (document.getElementById('dlg-css')) return;
    const s = document.createElement('style');
    s.id = 'dlg-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  _build(): void {
    const el = document.createElement('div');
    el.id = 'dlg'; el.className = 'hidden';
    el.innerHTML =
      `<div class="dlg-name"></div>` +
      `<div class="dlg-say"></div>` +
      `<div class="dlg-opts"></div>` +
      `<div class="dlg-foot">number keys to choose · <b>Esc</b> to leave</div>`;
    document.body.appendChild(el);
    this.el = el;
    this.nameEl = el.querySelector('.dlg-name') as HTMLElement;
    this.sayEl = el.querySelector('.dlg-say') as HTMLElement;
    this.optsEl = el.querySelector('.dlg-opts') as HTMLElement;
  }

  open(session: DialogueSession): void {
    this.session = session;
    this.isOpen = true;
    this._situation = null;     // greeting uses the persona's default prompt
    this.el.classList.remove('hidden');
    this._say(session.greeting(), 'neutral');   // templated line shows instantly
    this._renderHeader();
    this._renderOpts();
    window.addEventListener('keydown', this._key, true);
    // OPTIONAL: try to upgrade the greeting to an LLM-written line (no-op if the
    // feature is off / server unreachable — _say already showed the fallback).
    this._tryLlmSwap('neutral');
  }

  // Fire-and-forget LLM call for the CURRENT spoken turn. Captures the say-token
  // so a line that arrives after the player has moved on is discarded. Never
  // throws (generateLine resolves null on any failure) and never blocks the UI.
  _tryLlmSwap(_tone: Tone): void {
    let on = false;
    try { on = isEnabled(); } catch { on = false; }
    if (!on || !this.session || typeof this.session.llmPersona !== 'function') return;
    const token = this._sayToken;
    let persona;
    try { persona = this.session.llmPersona(this._situation); } catch { return; }
    Promise.resolve(generateLine(persona)).then((line: string | null) => {
      if (!line) return;                         // failure / junk -> keep fallback
      if (!this.isOpen || this._sayToken !== token) return;  // stale turn
      // swap text only; keep the tone/colour the fallback already established
      this.sayEl.textContent = line;
    }).catch(() => { /* never throws to caller */ });
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.session = null;
    this.el.classList.add('hidden');
    window.removeEventListener('keydown', this._key, true);
    if (this.onClose) this.onClose();
  }

  _say(text: string, tone: Tone): void {
    this._sayToken++;            // invalidate any in-flight LLM swap for the old line
    this.sayEl.textContent = text;
    this.sayEl.className = 'dlg-say' + (tone === 'good' ? ' good' : tone === 'bad' ? ' bad' : '');
  }

  _renderHeader(): void {
    const session = this.session;
    if (!session) return;
    const s = session.standing();
    const col = s > 0.1 ? '#7fd18a' : s < -0.1 ? '#e36f6f' : '#9aa6b2';
    const word = s > 0.35 ? 'friendly' : s > 0.1 ? 'warm' : s < -0.35 ? 'hostile' : s < -0.1 ? 'cold' : 'neutral';
    this.nameEl.innerHTML = `${session.npc.name}<span class="stand" style="color:${col}">${word}</span>`;
  }

  _renderOpts(): void {
    const session = this.session;
    if (!session) return;
    const opts = session.options();
    this._opts = opts;
    this.optsEl.innerHTML = opts.map((o, i) => {
      const n = i + 1;
      const leave = o.kind === 'leave' ? ' leave' : '';
      return `<button class="dlg-opt${leave}" data-id="${o.id}" data-i="${i}">` +
        `<span class="num">${n}</span><span>${o.label}</span></button>`;
    }).join('');
    this.optsEl.querySelectorAll<HTMLElement>('.dlg-opt').forEach((b) =>
      b.addEventListener('click', () => { if (b.dataset.id != null) this._pick(b.dataset.id); }));
  }

  _pick(id: string): void {
    const session = this.session;
    if (!session) return;
    const res = session.choose(id);
    if (res) this._say(res.text, res.tone);
    if (session.over) {
      // give the player a beat to read the parting line, then close. (We don't
      // LLM-swap a parting line — the modal is about to vanish.)
      this.optsEl.innerHTML = '';
      setTimeout(() => this.close(), 650);
      return;
    }
    this._renderHeader();
    this._renderOpts();
    // OPTIONAL: upgrade the NPC's response to this choice with an LLM line. The
    // chosen option id gives the model situational context to react to.
    this._situation = this._situationFor(id, res);
    this._tryLlmSwap(res ? res.tone : 'neutral');
  }

  // Map a chosen option id to a short situational instruction for the model, so
  // its reply fits what the player just did. Falls back to a generic reply.
  _situationFor(id: string, res: DialogueResult | null): string {
    switch (id) {
      case 'ask_rumour': return 'The traveller asks if you have heard any news lately. Share your latest rumour in your own words.';
      case 'ask_need':   return 'The traveller asks what goods you need. Tell them, in character.';
      case 'persuade':   return 'The traveller tries to persuade you. React in character to ' +
        (res && res.tone === 'good' ? 'being won over' : 'an unconvincing argument') + '.';
      case 'intimidate': return 'The traveller tries to intimidate you. React in character to ' +
        (res && res.tone === 'good' ? 'being cowed' : 'a threat that does not scare you') + '.';
      default:           return 'Respond to the traveller in one short line, in character.';
    }
  }

  _onKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    e.stopPropagation();
    if (e.code === 'Escape' || e.code === 'KeyQ') { e.preventDefault(); this.close(); return; }
    const m = /^Digit([1-9])$/.exec(e.code);
    if (m) {
      e.preventDefault();
      const i = parseInt(m[1], 10) - 1;
      const opt = this._opts && this._opts[i];
      if (opt) this._pick(opt.id);
    }
  }
}
