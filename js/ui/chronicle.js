// Chronicle panel: the world's live drama feed, surfaced in-game (drama-plan §5).
// Renders the bounded ring of NOTABLE beats the Chronicle distilled off the deed
// bus — kills, deaths, vendettas, prodigies rising, fortunes, raids, births —
// most-recent-first, scrollable, colour-coded by beat KIND. Self-injecting +
// signature-cached, like the Ability Index / Class Codex; reads the live sim each
// frame. Toggles with N. READ-ONLY over sim state — it never mutates a thing.

import { BEAT } from '../sim/chronicle.js';

const PANEL_ID = 'chroniclePanel';

// colour + short label per beat kind (the legend the feed reads against).
const KIND = {
  [BEAT.DEATH]:    { col: '#e06a6a', tag: 'fallen'   },
  [BEAT.KILL]:     { col: '#e0894e', tag: 'slain'    },
  [BEAT.VENDETTA]: { col: '#d36bd0', tag: 'vendetta' },
  [BEAT.PRODIGY]:  { col: '#c9a6ff', tag: 'rising'   },
  [BEAT.FORTUNE]:  { col: '#ffd36b', tag: 'fortune'  },
  [BEAT.RAID]:     { col: '#ff7a59', tag: 'raid'     },
  [BEAT.BIRTH]:    { col: '#7fd18a', tag: 'born'     },
  [BEAT.MENTOR]:   { col: '#8fb6e0', tag: 'mentor'   },
  [BEAT.FAITH]:    { col: '#e7c35a', tag: 'faith'    },
  [BEAT.WATCH]:    { col: '#7fb0c0', tag: 'watch'    },
  [BEAT.PATRICIAN]:{ col: '#b8c0a0', tag: 'patrician'},
  [BEAT.LEGEND]:   { col: '#ffcf5a', tag: 'legend'   },
  [BEAT.UNION]:    { col: '#f2a0c0', tag: 'union'    },
  [BEAT.BUILD]:    { col: '#cda878', tag: 'built'    },
};
const DEFAULT_KIND = { col: '#9aa6b2', tag: 'event' };

export class ChroniclePanel {
  constructor(getSim) {
    this.getSim = getSim || (() => null);
    this.visible = false;
    this.mode = 'feed';            // 'feed' = live chronicle · 'saga' = the town's legends
    this._sig = '';
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
    // delegated click: the header chip flips between the live feed and the saga.
    this.el.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('c-mode')) {
        this.mode = this.mode === 'feed' ? 'saga' : 'feed';
        this._sig = ''; this.render();
      }
    });
  }

  _injectStyles() {
    if (document.getElementById('chroniclePanelStyles')) return;
    const s = document.createElement('style');
    s.id = 'chroniclePanelStyles';
    s.textContent = `
      #${PANEL_ID} { position: fixed; left: 16px; bottom: 16px; width: 372px; max-height: 62vh; overflow-y: auto;
        z-index: 8; color: #e7ddc8; font: 12px "Iowan Old Style", Georgia, serif; pointer-events: auto;
        border-radius: 4px; box-shadow: 0 12px 44px rgba(0,0,0,.66);
        background:
          radial-gradient(90% 60% at 50% -10%, rgba(214,178,94,.07), rgba(0,0,0,0) 60%),
          linear-gradient(180deg, #1b160d, #15110a 70%, #120e08);
        border: 1px solid #5c4a28; }
      #${PANEL_ID}::-webkit-scrollbar { width: 9px; }
      #${PANEL_ID}::-webkit-scrollbar-thumb { background: #5c4a28; border-radius: 4px; }
      #${PANEL_ID} .c-head { position: sticky; top: 0; z-index: 2; padding: 9px 13px 8px;
        background: linear-gradient(180deg,#1d180e,#191409); border-bottom: 2px solid #6b5836;
        display: flex; justify-content: space-between; align-items: flex-end; }
      #${PANEL_ID} .c-ttl { font-size: 16px; font-weight: 700; font-variant: small-caps; letter-spacing: 1px; color: #e9cf8e; line-height: 1; }
      #${PANEL_ID} .c-sub { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #8a7547; margin-top: 3px; }
      #${PANEL_ID} .c-head .c-mode { cursor: pointer; color: #e9cf8e; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; border: 1px solid #6b5836; border-radius: 2px; padding: 1px 5px; }
      #${PANEL_ID} .c-head .hot { color: #8a7547; border: 1px solid #5c4a28; border-radius: 2px; padding: 0 4px; font-size: 10px; margin-left: 6px; font-family: system-ui; }
      #${PANEL_ID} .c-body { padding: 5px 9px 10px; }
      #${PANEL_ID} .c-row { display: flex; gap: 8px; align-items: baseline; line-height: 1.46;
        padding: 4px 4px 4px 7px; border-left: 2px solid #6b5836; border-bottom: 1px solid rgba(214,178,94,.07); margin-top: 2px; }
      #${PANEL_ID} .c-t { color: #8a7547; font-size: 10px; width: 40px; flex: 0 0 auto; text-align: right; font-variant-numeric: tabular-nums; }
      #${PANEL_ID} .c-tag { font-size: 8.5px; text-transform: uppercase; letter-spacing: .8px; font-weight: 700; width: 54px; flex: 0 0 auto; }
      #${PANEL_ID} .c-txt { color: #ece3cf; flex: 1 1 auto; }
      #${PANEL_ID} .c-arc { display: inline-block; margin-left: 6px; font-size: 9.5px; font-style: italic;
        font-variant: small-caps; letter-spacing: .5px; color: #c79a52; white-space: nowrap; }
      #${PANEL_ID} .c-arcrow { background: linear-gradient(90deg, rgba(199,154,82,.10), rgba(199,154,82,0) 70%); }
      #${PANEL_ID} .empty { color: #8a7547; font-style: italic; padding: 10px 2px; text-align: center; }
    `;
    document.head.appendChild(s);
  }

  render() {
    if (!this.visible) return;
    try {
      const sim = this.getSim();
      const chron = sim && sim.chronicle;
      const saga = this.mode === 'saga';
      const beats = chron ? (saga ? chron.legends(80) : chron.recent(60)) : [];   // already newest-first

      // signature: redraw only when the newest beat id, the count, or the mode changed.
      const sig = (beats.length ? `${beats[0].id}:${beats.length}` : '0') + ':' + this.mode;
      if (sig === this._sig) return;
      this._sig = sig;

      const body = beats.length ? beats.map((b) => {
        const k = KIND[b.kind] || DEFAULT_KIND;
        const mins = Math.floor(b.t / 60), secs = Math.round(b.t % 60);
        const ts = `${mins}:${String(secs).padStart(2, '0')}`;
        // a beat that belongs to a tracked STORY wears its title — so the betrayal and
        // the duel that answers it read as chapters of one tale, not stray log lines.
        // The arc rows also share a left accent, so a run of them reads as a thread.
        const arc = b.arcTitle ? `<span class="c-arc">⟐ ${this._esc(b.arcTitle)}</span>` : '';
        const accent = b.arcId ? ' c-arcrow' : '';
        return `<div class="c-row${accent}" style="border-left-color:${k.col}">
          <span class="c-t">${ts}</span>
          <span class="c-tag" style="color:${k.col}">${k.tag}</span>
          <span class="c-txt">${this._esc(b.text)}${arc}</span>
        </div>`;
      }).join('') : `<div class="empty">${saga ? 'No legends yet — they are still being earned.' : "No chronicle yet — the world's story will fill in as it lives."}</div>`;

      const title = saga ? 'The Legends' : 'The Chronicle';
      const sub = saga ? `${beats.length} tales remembered` : `${beats.length} beats · the annals of the realm`;
      const chip = saga ? 'feed' : 'legends';
      this.el.innerHTML = `<div class="c-head"><span><span class="c-ttl">${title}</span><div class="c-sub">${sub}</div></span>` +
        `<span><span class="c-mode">${chip}</span><span class="hot">N</span></span></div>` +
        `<div class="c-body">${body}</div>`;
    } catch (e) {
      if (!this._erred) { console.warn('ChroniclePanel render failed', e); this._erred = true; }
    }
  }

  // beat text is built from agent names (data, not user input) but escape anyway
  // so a stray '<' in a future phrasing can never inject markup.
  _esc(s) {
    return String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  }
}
