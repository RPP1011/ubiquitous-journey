// Quest log: a self-injecting HUD panel that lists the offers on the QuestBoard
// and the player's active quests with live progress. It styles itself inline (no
// index.html edits needed) and toggles with a key. Click an offered quest to
// accept it; active quests show a progress bar fed straight from the board's
// ground-truth completion tracking.

import { QUEST_STATE } from '../quest/quest.js';

const PANEL_ID = 'questLog';

export class QuestLog {
  constructor(player) {
    this.player = player || null;     // for accept(); can be set later via setPlayer
    this.board = null;
    this.visible = false;
    this._sig = '';
    this._injectStyles();
    this._build();
  }

  setBoard(b) { this.board = b; this._sig = ''; }
  setPlayer(p) { this.player = p; }

  toggle() { this.visible ? this.hide() : this.show(); }
  show() { this.visible = true; this.el.style.display = 'block'; this._sig = ''; this.render(); }
  hide() { this.visible = false; this.el.style.display = 'none'; }

  // ---- DOM scaffold --------------------------------------------------------
  _build() {
    let el = document.getElementById(PANEL_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = PANEL_ID;
      document.body.appendChild(el);
    }
    this.el = el;
    this.el.style.display = 'none';
    // accept an offered quest by clicking it
    this.el.addEventListener('click', (e) => {
      const row = e.target.closest('.q-offer');
      if (!row || !this.board) return;
      const q = this.board.offers.find((x) => x.id === +row.dataset.id);
      const player = this.player || this.board.sim?.player;
      if (q && player) { this.board.accept(q, player); this.render(); }
    });
  }

  _injectStyles() {
    if (document.getElementById('questLogStyles')) return;
    const s = document.createElement('style');
    s.id = 'questLogStyles';
    s.textContent = `
      #${PANEL_ID} { position: fixed; right: 16px; top: 16px; width: 300px; z-index: 6;
        background: rgba(10,13,18,.9); border: 1px solid rgba(255,255,255,.14);
        border-radius: 8px; padding: 0; color: #dfe6ee; font-size: 12px;
        backdrop-filter: blur(2px); box-shadow: 0 6px 22px rgba(0,0,0,.5); pointer-events: auto; }
      #${PANEL_ID} .q-head { padding: 8px 12px; font-size: 11px; letter-spacing: 1.5px;
        text-transform: uppercase; color: #cbd5e1; background: rgba(255,255,255,.05);
        border-bottom: 1px solid rgba(255,255,255,.1); display: flex; justify-content: space-between; }
      #${PANEL_ID} .q-head .hot { color: #6f7b88; border: 1px solid rgba(255,255,255,.15);
        border-radius: 3px; padding: 0 4px; font-size: 10px; }
      #${PANEL_ID} .q-body { padding: 8px 12px 10px; max-height: 60vh; overflow-y: auto; }
      #${PANEL_ID} .q-sec { font-size: 10px; letter-spacing: 1px; text-transform: uppercase;
        color: #8a96a3; margin: 8px 0 4px; }
      #${PANEL_ID} .q-row { border: 1px solid rgba(255,255,255,.1); border-radius: 6px;
        padding: 6px 8px; margin-bottom: 6px; background: rgba(255,255,255,.03); }
      #${PANEL_ID} .q-offer { cursor: pointer; }
      #${PANEL_ID} .q-offer:hover { background: rgba(232,200,121,.14); outline: 1px solid var(--accent, #e8c879); }
      #${PANEL_ID} .q-ttl { font-weight: 600; color: #f0e6cf; }
      #${PANEL_ID} .q-ttl .tag { font-size: 9px; text-transform: uppercase; letter-spacing: 1px;
        color: #0b0d10; background: #9aa6b2; border-radius: 3px; padding: 0 4px; margin-left: 6px; }
      #${PANEL_ID} .q-ttl .tag.hunt { background: #d77b6b; }
      #${PANEL_ID} .q-ttl .tag.fetch { background: #7fd18a; }
      #${PANEL_ID} .q-ttl .tag.recover { background: #6fb7ff; }
      #${PANEL_ID} .q-desc { color: #aeb8c2; margin: 3px 0 2px; line-height: 1.5; }
      #${PANEL_ID} .q-rew { color: #e0c46a; font-size: 11px; }
      #${PANEL_ID} .q-bar { height: 6px; background: rgba(255,255,255,.1); border-radius: 3px;
        overflow: hidden; margin-top: 5px; }
      #${PANEL_ID} .q-bar i { display: block; height: 100%; background: linear-gradient(#7fd18a,#4f9d63); }
      #${PANEL_ID} .q-hint { color: #7c8896; font-size: 11px; margin-top: 4px; }
      #${PANEL_ID} .empty { color: #6f7b88; font-style: italic; padding: 4px 0; }
    `;
    document.head.appendChild(s);
  }

  // ---- render --------------------------------------------------------------
  render() {
    if (!this.visible) return;
    const board = this.board;
    const offers = board ? board.offers : [];
    const active = board ? board.active : [];

    // cheap signature so we don't thrash innerHTML every frame (kills hover)
    const sig = offers.map((q) => q.id).join(',') + '|' +
      active.map((q) => q.id + ':' + q.progress.toFixed(2)).join(',');
    if (sig === this._sig) return;
    this._sig = sig;

    const offerHtml = offers.length
      ? offers.map((q) => this._row(q, true)).join('')
      : `<div class="empty">no notices posted</div>`;
    const activeHtml = active.length
      ? active.map((q) => this._row(q, false)).join('')
      : `<div class="empty">no quests in progress</div>`;

    this.el.innerHTML = `
      <div class="q-head"><span>Quest Log</span><span class="hot">Q</span></div>
      <div class="q-body">
        <div class="q-sec">Notices (click to accept)</div>${offerHtml}
        <div class="q-sec">Active</div>${activeHtml}
      </div>`;
  }

  _row(q, isOffer) {
    const reward = `Reward: ${q.reward.gold}g · ${q.reward.xp} xp`;
    let prog = '';
    if (!isOffer) {
      const pct = Math.round(this._progressPct(q) * 100);
      const label = q.state === QUEST_STATE.done ? 'done'
        : q.type === 'hunt' ? `${q.progress | 0}/${q.target.count} slain`
        : `${pct}%`;
      prog = `<div class="q-bar"><i style="width:${pct}%"></i></div>
        <div class="q-hint">${label}</div>`;
    } else {
      prog = `<div class="q-hint">click to accept</div>`;
    }
    return `<div class="q-row${isOffer ? ' q-offer' : ''}" data-id="${q.id}">
      <div class="q-ttl">${q.title}<span class="tag ${q.type}">${q.type}</span></div>
      <div class="q-desc">${q.desc}</div>
      <div class="q-rew">${reward}</div>
      ${prog}
    </div>`;
  }

  _progressPct(q) {
    if (q.type === 'hunt') return q.target.count ? Math.min(1, q.progress / q.target.count) : 0;
    return Math.min(1, q.progress || 0);
  }
}
