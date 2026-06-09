// HUD facade: instantiates every UI panel + the dialogue modal, owns the
// transient DOM readouts (player stats, context prompt, debug/crash line, hurt
// flash), and exposes setWorld() to (re)wire panels to a Simulation plus
// render() to drive every panel each frame. UI stays read-only over sim state.

import { Inspector } from './inspector.js';
import { MindBrowser } from './mindbrowser.js';
import { QuestLog } from './questLog.js';
import { PartyHUD } from './partyHud.js';
import { InventoryPanel } from './inventoryPanel.js';
import { ClassCodex } from './classCodex.js';
import { EconView } from './econView.js';
import { AbilityIndex } from './abilityIndex.js';
import { ChroniclePanel } from './chronicle.js';
import { GazettePanel } from './gazette.js';
import { DialogueView } from './dialogueView.js';
import { makeTabsDraggable } from './dragtabs.js';
import { COMMODITIES } from '../sim/simconfig.js';
import type { PerspectiveCamera, OrthographicCamera } from 'three';

// simulation.js / dungeonManager.js / the game shell are later clusters — typed as
// the minimal read surfaces used here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any; /* Simulation — ported in a later cluster */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DungeonMgr = any; /* DungeonManager — ported in a later cluster */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Game = any; /* the main game shell (state machine) — ported in a later cluster */
type Cam = PerspectiveCamera | OrthographicCamera;
// the shared item-consume callback (slot click + H hotkey share one path)
type UseHandler = (commodity: string, player: import('../../types/sim.js').Agent) => void;

export interface HudOpts {
  camera: Cam;
  getSim: () => Sim | null;
  getDungeonMgr: () => DungeonMgr | null;
}

export class Hud {
  _getSim: () => Sim | null;
  _getDungeonMgr: () => DungeonMgr | null;
  inspector: Inspector;
  mind: MindBrowser;
  questLog: QuestLog;
  partyHud: PartyHUD;
  inventory: InventoryPanel;
  classCodex: ClassCodex;
  dialogueView: DialogueView;
  econView: EconView;
  abilityIndex: AbilityIndex;
  chronicle: ChroniclePanel;
  gazette: GazettePanel;
  hpFill: HTMLElement | null;
  _hurt: HTMLElement;
  _dbg: HTMLElement;
  _pstats: HTMLElement;
  _prompt: HTMLElement;

  // camera: for the inspector raycast.  getSim: () => current Simulation (survives
  // world rebuilds).  getDungeonMgr: () => current DungeonManager (or null).
  constructor({ camera, getSim, getDungeonMgr }: HudOpts) {
    this._getSim = getSim;
    this._getDungeonMgr = getDungeonMgr;

    this.inspector = new Inspector(document.getElementById('inspector') as HTMLElement, camera, null);
    this.mind = new MindBrowser(document.getElementById('mindList') as HTMLElement, document.getElementById('mindDetail') as HTMLElement, this.inspector);
    this.questLog = new QuestLog();   // self-mounts #questLog; board/player set in setWorld()
    this.partyHud = new PartyHUD();   // self-mounts #partyHud; party set in setWorld()
    this.inventory = new InventoryPanel();   // self-mounts #inventory; player set in setWorld()
    this.classCodex = new ClassCodex();      // self-mounts #classCodex; agents set in setWorld()

    // dialogue modal (self-injects its own DOM + CSS)
    this.dialogueView = new DialogueView();

    // Town & Prices tab: a live economics view rendered from the per-world
    // econstats ledger. getSim defers to whatever Simulation is current.
    this.econView = new EconView(document.getElementById('econView'), getSim);
    this.abilityIndex = new AbilityIndex(getSim);   // self-mounts #abilityIndex (toggle Y)
    this.chronicle = new ChroniclePanel(getSim);    // self-mounts #chroniclePanel (toggle N)
    this.gazette = new GazettePanel(getSim);        // self-mounts #gazettePanel (toggle J)

    // ---- transient DOM readouts -------------------------------------------
    this.hpFill = document.getElementById('hpFill');   // player health (combat is live now)

    // red hurt flash when the player takes a hit
    this._hurt = document.createElement('div');
    Object.assign(this._hurt.style, {
      position: 'fixed', inset: '0', opacity: '0', pointerEvents: 'none', transition: 'opacity .35s',
      zIndex: '5', background: 'radial-gradient(ellipse at center, rgba(180,0,0,0) 45%, rgba(180,0,0,.55) 100%)',
    });
    document.body.appendChild(this._hurt);

    // debug readout + crash surface
    this._dbg = document.createElement('div');
    Object.assign(this._dbg.style, {
      position: 'fixed', left: '8px', bottom: '8px', zIndex: '9', font: '11px monospace',
      color: '#9fe', background: 'rgba(0,0,0,.6)', padding: '4px 8px', borderRadius: '4px',
      whiteSpace: 'pre', pointerEvents: 'none', maxWidth: '90vw',
    });
    document.body.appendChild(this._dbg);

    // player readout: gold · class · carried items
    this._pstats = document.createElement('div');
    Object.assign(this._pstats.style, {
      position: 'fixed', left: '50%', bottom: '10px', transform: 'translateX(-50%)', zIndex: '6',
      font: '12px monospace', color: '#e8e2cf', background: 'rgba(0,0,0,.45)', padding: '5px 12px',
      borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'nowrap',
    });
    document.body.appendChild(this._pstats);

    // context prompt ("Press E to enter …") + transient dungeon event note
    this._prompt = document.createElement('div');
    Object.assign(this._prompt.style, {
      position: 'fixed', left: '50%', bottom: '40px', transform: 'translateX(-50%)', zIndex: '6',
      font: '13px "Segoe UI", system-ui, sans-serif', color: '#ffe9b0', background: 'rgba(0,0,0,.5)',
      padding: '5px 14px', borderRadius: '6px', pointerEvents: 'none', whiteSpace: 'nowrap',
      textAlign: 'center', display: 'none',
    });
    document.body.appendChild(this._prompt);

    makeTabsDraggable();   // drag panels by their header; a header click still collapses
  }

  // (Re)wire every panel to a freshly built world. useHandler is the shared
  // item-consume callback (so a slot click and the H hotkey share one path).
  setWorld(sim: Sim, useHandler: UseHandler): void {
    this.inspector.setAgents(sim.agents);
    this.inspector.sim = sim;   // wire reputation 'thinks of you' panel
    this.mind.setAgents(sim.agents);
    this.classCodex.setAgents(sim.agents);
    this.questLog.setBoard(sim.quests);
    this.questLog.setPlayer(sim.player);   // the Agent (board ticks against sim.player)
    this.partyHud.setParty(sim.party);
    this.inventory.setPlayer(sim.player);   // the Agent (carries inventory/gold/relics)
    this.inventory.setUseHandler(useHandler);
  }

  flashHurt(): void {
    this._hurt.style.opacity = '1';
    setTimeout(() => (this._hurt.style.opacity = '0'), 60);
  }

  // collapsible tabs: click a header, or press its number key
  toggleTab(n: number | string): void {
    const t = document.querySelector(`#tabs .tab[data-tab="${n}"]`);
    if (t) t.classList.toggle('collapsed');
  }

  setDebug(text: string): void { this._dbg.textContent = text; }
  setCrash(text: string): void { this._dbg.style.color = '#f88'; this._dbg.textContent = text; }

  _updatePrompt(game: Game): void {
    const dungeonMgr = this._getDungeonMgr();
    if (!dungeonMgr || !game.sim || !game.sim.player || game.state !== 'playing') { this._prompt.style.display = 'none'; return; }
    const line = dungeonMgr.prompt(game.sim.player);
    if (line) { this._prompt.textContent = line; this._prompt.style.display = 'block'; }
    else { this._prompt.style.display = 'none'; }
  }

  _updatePlayerStats(game: Game): void {
    const dungeonMgr = this._getDungeonMgr();
    const p = game.sim && game.sim.player;
    if (!p) { this._pstats.textContent = ''; return; }
    const inv = COMMODITIES.map((c) => {
      const n = c === 'food' ? Math.floor(p.inventory[c] || 0) : Math.floor(p.inventory[c] || 0);
      return n > 0 ? `${n} ${c}` : null;
    }).filter(Boolean).join('  ');
    const cls = p.progression && p.progression.primaryClass && p.progression.primaryClass();
    const relicN = (p.relics | 0);
    const relics = relicN > 0 ? `  ·  ${relicN} relic${relicN > 1 ? 's' : ''}` : '';
    const depth = dungeonMgr && dungeonMgr.active ? `  ·  depth ${dungeonMgr.depth}` : '';
    this._pstats.textContent = `${Math.round(p.gold)}g  ·  ${cls ? cls.name + ' Lv' + cls.level : 'no class yet'}  ·  ${inv || 'empty pack'}${relics}${depth}`;
  }

  // Per-frame panel render + readouts. `stageFn(name)` lets the caller keep its
  // crash-surface stage tracking; mirrors the original inline stage labels.
  render(game: Game, mouseNDC: { x: number; y: number }, stageFn: (name: string) => void): void {
    stageFn('inspector');  this.inspector.center.set(mouseNDC.x, mouseNDC.y); this.inspector.update();
    stageFn('mind');       this.mind.update();
    stageFn('questLog');   this.questLog.render();
    stageFn('partyHud');   this.partyHud.render();
    stageFn('inventory');  this.inventory.render();
    stageFn('classCodex'); this.classCodex.render();
    stageFn('econView');   this.econView.render();
    stageFn('abilityIndex'); this.abilityIndex.render();
    stageFn('chronicle');  this.chronicle.render();
    stageFn('gazette');    this.gazette.render();
    stageFn('pstats');     this._updatePlayerStats(game);
    stageFn('prompt');     this._updatePrompt(game);
  }
}
