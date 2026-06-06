// Gazette panel: the town NEWSPAPER, surfaced in-game. Renders the bounded ring of
// Articles the roaming Reporter filed about newsworthy souls — headline, dateline,
// a template/llm source chip, and the body — most-recent-first. Self-injecting +
// signature-cached like the Chronicle panel; reads the live sim each frame. Toggles
// with J. READ-ONLY over sim state. The optional LLM enrichment (js/ai/press.js)
// swaps an article's prose in place; this panel just shows whatever's published.

import { startPress } from '../ai/press.js';

const PANEL_ID = 'gazettePanel';

export class GazettePanel {
  constructor(getSim) {
    this.getSim = getSim || (() => null);
    this.visible = false;
    this._sig = '';
    this._injectStyles();
    this._build();
  }

  toggle() { this.visible ? this.hide() : this.show(); }
  show() {
    this.visible = true; this.el.style.display = 'block'; this._sig = ''; this.render();
    // first time the reader opens the paper, start the optional LLM press pump
    // (browser-only; no-ops unless the LLM is enabled — see js/ai/press.js).
    if (!this._press) { try { this._press = startPress(this.getSim); } catch { /* */ } }
  }
  hide() { this.visible = false; this.el.style.display = 'none'; }

  _build() {
    let el = document.getElementById(PANEL_ID);
    if (!el) { el = document.createElement('div'); el.id = PANEL_ID; document.body.appendChild(el); }
    this.el = el; this.el.style.display = 'none';
  }

  _injectStyles() {
    if (document.getElementById('gazettePanelStyles')) return;
    const s = document.createElement('style');
    s.id = 'gazettePanelStyles';
    s.textContent = `
      #${PANEL_ID} { position: fixed; right: 16px; top: 16px; width: 416px; max-height: 86vh; overflow-y: auto;
        z-index: 8; color: #2a2017; font: 13px Georgia, "Times New Roman", serif; pointer-events: auto;
        border-radius: 3px; box-shadow: 0 14px 48px rgba(0,0,0,.62), 0 1px 0 rgba(255,255,255,.25) inset;
        /* aged newsprint: a warm parchment wash with faint foxing at the edges */
        background:
          radial-gradient(120% 80% at 50% -10%, rgba(120,96,54,.10), rgba(120,96,54,0) 60%),
          radial-gradient(60% 50% at 110% 110%, rgba(96,72,40,.16), rgba(96,72,40,0) 70%),
          linear-gradient(180deg, #efe6cf, #e7dcc0 60%, #e1d4b4);
        border: 1px solid #b9a87f; }
      #${PANEL_ID}::-webkit-scrollbar { width: 9px; }
      #${PANEL_ID}::-webkit-scrollbar-thumb { background: #b9a87f; border-radius: 4px; }
      #${PANEL_ID} .gz-mast { position: sticky; top: 0; z-index: 2; padding: 9px 16px 7px; text-align: center;
        background: linear-gradient(180deg,#efe6cf,#ece1c6); border-bottom: 3px double #6b5836; }
      #${PANEL_ID} .gz-title { font-family: "Georgia","Times New Roman",serif; font-weight: 900; letter-spacing: .5px;
        font-size: 27px; line-height: 1.02; color: #20180f; text-shadow: 0 1px 0 rgba(255,255,255,.4);
        font-variant: small-caps; }
      #${PANEL_ID} .gz-edition { display: flex; justify-content: space-between; align-items: baseline; margin-top: 5px;
        font-size: 9.5px; letter-spacing: 1.5px; text-transform: uppercase; color: #6b5b3c;
        border-top: 1px solid #9c8a63; border-bottom: 1px solid #9c8a63; padding: 2px 1px; }
      #${PANEL_ID} .gz-edition .hot { border: 1px solid #8a7850; border-radius: 2px; padding: 0 4px; font-family: system-ui; letter-spacing: 0; }
      #${PANEL_ID} .gz-body { padding: 11px 16px 16px; }
      /* the front-page lead */
      #${PANEL_ID} .gz-lead { padding-bottom: 11px; margin-bottom: 4px; border-bottom: 2px solid #7d6a45; }
      #${PANEL_ID} .gz-kicker { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #8a5a2a; font-weight: bold; margin-bottom: 3px; }
      #${PANEL_ID} .gz-lead-hl { font-size: 22px; font-weight: 900; line-height: 1.12; color: #1c140c; margin-bottom: 6px; }
      #${PANEL_ID} .gz-lead-body { font-size: 13.5px; line-height: 1.56; color: #2a2017; text-align: justify; }
      #${PANEL_ID} .gz-lead-body::first-letter { float: left; font-size: 3.1em; line-height: .74; font-weight: 900;
        padding: 5px 7px 0 0; color: #5a3a18; font-family: Georgia, serif; }
      /* section rubric */
      #${PANEL_ID} .gz-rubric { display: flex; align-items: center; gap: 9px; margin: 13px 0 7px;
        font-size: 10.5px; letter-spacing: 2.5px; text-transform: uppercase; color: #5a4a2c; font-weight: bold; }
      #${PANEL_ID} .gz-rubric::before, #${PANEL_ID} .gz-rubric::after { content: ""; flex: 1; height: 0; border-top: 1px solid #a8966c; }
      /* secondary stories */
      #${PANEL_ID} .gz-art { padding: 8px 0 9px; border-bottom: 1px solid rgba(110,90,55,.28); }
      #${PANEL_ID} .gz-art:last-child { border-bottom: none; }
      #${PANEL_ID} .gz-hl { font-size: 14.5px; font-weight: bold; color: #1c140c; line-height: 1.22; margin-bottom: 3px; }
      #${PANEL_ID} .gz-meta { font-size: 9.5px; color: #7a6a47; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
      #${PANEL_ID} .gz-txt { color: #33281b; line-height: 1.5; font-size: 12.5px; text-align: justify; }
      #${PANEL_ID} .chip { border: 1px solid #9c8a63; border-radius: 2px; padding: 0 4px; margin-left: 7px; color: #6b5b3c; }
      #${PANEL_ID} .chip.llm { color: #6a3f8a; border-color: #a07fc0; }
      #${PANEL_ID} .empty { color: #7a6a47; font-style: italic; padding: 14px 2px; text-align: center; }
    `;
    document.head.appendChild(s);
  }

  // section order + rubric for the lower fold, keyed by the brief's desk kind.
  static SECTIONS = [
    { keys: ['obituary'],    rubric: 'In Memoriam' },
    { keys: ['saga'],        rubric: 'Sagas of the Realm' },
    { keys: ['event'],       rubric: 'Of Note' },
    { keys: ['person'],      rubric: 'From the Towns' },
    { keys: ['threat'],      rubric: 'On the Roads' },
    { keys: ['market'],      rubric: 'The Market' },
    { keys: ['opportunity'], rubric: 'Notices & Bounties' },
  ];

  _kicker(a) {
    const k = (a.brief && a.brief.kind) || 'person';
    return ({ obituary: 'In Memoriam', saga: 'A Saga', event: 'Dispatch', threat: 'Peril', market: 'Market', opportunity: 'Notice' }[k]) || (a.dateline || 'the town');
  }

  _chip(a) {
    if (a.source === 'llm') return '<span class="chip llm">filed</span>';
    const k = (a.brief && a.brief.kind) || 'person';
    const lbl = (k === 'market' || k === 'threat' || k === 'opportunity') ? 'wire' : (k === 'event' || k === 'saga') ? 'dispatch' : 'notice';
    return `<span class="chip">${lbl}</span>`;
  }

  _ts(t) { const m = Math.floor(t / 60), s = Math.round(t % 60); return `${m}:${String(s).padStart(2, '0')}`; }

  render() {
    if (!this.visible) return;
    try {
      const sim = this.getSim();
      const gaz = sim && sim.gazette;
      const arts = gaz ? gaz.recent(40) : [];     // newest-first

      const sig = (arts.length ? `${arts[0].id}:${arts.length}:${arts[0].source}` : '0');
      if (sig === this._sig) return;
      this._sig = sig;

      let inner;
      if (!arts.length) {
        inner = `<div class="empty">No news yet — the gazetteer is out looking for a story.</div>`;
      } else {
        const lead = arts[0];
        const rest = arts.slice(1);
        // lead story — the front page
        let html = `<div class="gz-lead">
            <div class="gz-kicker">${this._esc((this._kicker(lead) || '').toUpperCase())}</div>
            <div class="gz-lead-hl">${this._esc(lead.headline)}</div>
            <div class="gz-lead-body">${this._esc(lead.body)}</div>
            <div class="gz-meta" style="margin-top:6px">${this._esc((lead.dateline || 'the town').toUpperCase())} · ${this._ts(lead.t)}${this._chip(lead)}</div>
          </div>`;
        // remaining stories, grouped under section rubrics (each newest-first)
        for (const sec of GazettePanel.SECTIONS) {
          const items = rest.filter((a) => sec.keys.includes((a.brief && a.brief.kind) || 'person'));
          if (!items.length) continue;
          html += `<div class="gz-rubric">${sec.rubric}</div>`;
          html += items.map((a) => `<div class="gz-art">
              <div class="gz-hl">${this._esc(a.headline)}</div>
              <div class="gz-meta">${this._esc((a.dateline || 'the town').toUpperCase())} · ${this._ts(a.t)}${this._chip(a)}</div>
              <div class="gz-txt">${this._esc(a.body)}</div>
            </div>`).join('');
        }
        inner = html;
      }

      const edNo = arts.length ? arts[0].id : 0;
      this.el.innerHTML =
        `<div class="gz-mast">
           <div class="gz-title">The Hearsay Gazette</div>
           <div class="gz-edition"><span>No. ${edNo}</span><span>Price · One Copper</span><span class="hot">J</span></div>
         </div>` +
        `<div class="gz-body">${inner}</div>`;
    } catch (e) {
      if (!this._erred) { console.warn('GazettePanel render failed', e); this._erred = true; }
    }
  }

  _esc(s) {
    return String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  }
}
