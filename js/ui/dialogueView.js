// DialogueView: the DOM modal that renders a DialogueSession. It self-injects
// its own CSS + a root node at construction (no index.html edits required), so
// the integrator only has to open()/close() it. Options are clickable buttons;
// number keys 1..9 select, Esc/Q leave. The greeting is tinted by how the NPC
// feels about the player (standing). Sim keeps ticking behind the modal; the
// integrator freezes player control by setting game.state = 'dialogue'.

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
  constructor() {
    this.isOpen = false;
    this.session = null;
    this.onClose = null;        // optional callback when the modal closes
    this._injectCss();
    this._build();
    this._key = (e) => this._onKey(e);
  }

  _injectCss() {
    if (document.getElementById('dlg-css')) return;
    const s = document.createElement('style');
    s.id = 'dlg-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'dlg'; el.className = 'hidden';
    el.innerHTML =
      `<div class="dlg-name"></div>` +
      `<div class="dlg-say"></div>` +
      `<div class="dlg-opts"></div>` +
      `<div class="dlg-foot">number keys to choose · <b>Esc</b> to leave</div>`;
    document.body.appendChild(el);
    this.el = el;
    this.nameEl = el.querySelector('.dlg-name');
    this.sayEl = el.querySelector('.dlg-say');
    this.optsEl = el.querySelector('.dlg-opts');
  }

  open(session) {
    this.session = session;
    this.isOpen = true;
    this.el.classList.remove('hidden');
    this._say(session.greeting(), 'neutral');
    this._renderHeader();
    this._renderOpts();
    window.addEventListener('keydown', this._key, true);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.session = null;
    this.el.classList.add('hidden');
    window.removeEventListener('keydown', this._key, true);
    if (this.onClose) this.onClose();
  }

  _say(text, tone) {
    this.sayEl.textContent = text;
    this.sayEl.className = 'dlg-say' + (tone === 'good' ? ' good' : tone === 'bad' ? ' bad' : '');
  }

  _renderHeader() {
    const s = this.session.standing();
    const col = s > 0.1 ? '#7fd18a' : s < -0.1 ? '#e36f6f' : '#9aa6b2';
    const word = s > 0.35 ? 'friendly' : s > 0.1 ? 'warm' : s < -0.35 ? 'hostile' : s < -0.1 ? 'cold' : 'neutral';
    this.nameEl.innerHTML = `${this.session.npc.name}<span class="stand" style="color:${col}">${word}</span>`;
  }

  _renderOpts() {
    const opts = this.session.options();
    this._opts = opts;
    this.optsEl.innerHTML = opts.map((o, i) => {
      const n = i + 1;
      const leave = o.kind === 'leave' ? ' leave' : '';
      return `<button class="dlg-opt${leave}" data-id="${o.id}" data-i="${i}">` +
        `<span class="num">${n}</span><span>${o.label}</span></button>`;
    }).join('');
    this.optsEl.querySelectorAll('.dlg-opt').forEach((b) =>
      b.addEventListener('click', () => this._pick(b.dataset.id)));
  }

  _pick(id) {
    const res = this.session.choose(id);
    if (res) this._say(res.text, res.tone);
    if (this.session.over) {
      // give the player a beat to read the parting line, then close
      this.optsEl.innerHTML = '';
      setTimeout(() => this.close(), 650);
      return;
    }
    this._renderHeader();
    this._renderOpts();
  }

  _onKey(e) {
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
