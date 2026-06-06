// Player input: ability cast keys (1-4), gather (G), item use (H), the
// context-sensitive talk/portal trigger (E), and the global keydown map (toggles
// + pause/restart). Reads game state through accessors and acts on the live sim;
// all wiring matches the original main.js inline handlers exactly.

import { TUNE } from './constants.js';
import { SIM } from './sim/simconfig.js';
import { castSpec } from './rpg/abilities/interpreter.js';
import { bus, makeEvent } from './rpg/events.js';
import { pickAgent } from './util/pick.js';
import { DialogueSession } from './dialogue/dialogue.js';

// player gather: which commodity each resource-node kind yields + its XP tags
const GATHER = { field: 'food', forest: 'wood', mine: 'ore', meadow: 'herb' };
const GATHER_TAGS = {
  food: ['FARMING', 'ENDURANCE'], wood: ['WOODCUT', 'ENDURANCE'],
  ore: ['MINING', 'ENDURANCE'], herb: ['FORAGE', 'ENDURANCE'],
};

// 1-4 -> the player's known-ability slots
const CAST_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

export class PlayerControls {
  // game: shared { state, sim, world, playerFighter } state object.
  // hud: the Hud facade (dialogueView, toggleTab).  getDungeonMgr/getWorld:
  // accessors that survive world rebuilds.  togglePause/restart: main's
  // game-state callbacks.
  constructor({ game, input, camera, commander, hud, getDungeonMgr, togglePause, restart }) {
    this.game = game;
    this.input = input;
    this.camera = camera;
    this.commander = commander;
    this.hud = hud;
    this._getDungeonMgr = getDungeonMgr;
    this._togglePause = togglePause;
    this._restart = restart;

    this._castHeld = new Set();
    this._gatherCd = 0;

    // returning from a conversation: resume play (cursor stays free — point & click)
    hud.dialogueView.onClose = () => {
      if (game.state === 'dialogue') game.state = 'playing';
    };
  }

  // Open a conversation with whoever is under the cursor, if within talkRange.
  // Must never throw when nothing (or a monster/dead agent) is targeted.
  tryOpenDialogue() {
    const game = this.game;
    if (game.state !== 'playing' || !game.sim || !game.sim.player) return;
    const me = game.sim.player;
    // talk to whoever is under the cursor; if none, fall back to the nearest NPC
    let npc = pickAgent(this.camera, this.commander.mouseNDC, game.sim.agents);
    if (!npc) {
      let bd = SIM.talkRange * SIM.talkRange;
      for (const a of game.sim.agents) {
        if (a === me || !a.alive) continue;
        const d = me.pos.distanceToSquared(a.pos);
        if (d < bd) { bd = d; npc = a; }
      }
    }
    if (!npc || !npc.alive || npc === me) return;
    if (me.pos.distanceTo(npc.pos) > SIM.talkRange) {
      this.commander.agent.goal = { kind: 'approach', targetId: npc.id };   // walk over first
      return;
    }
    const session = new DialogueSession(npc, me, game.sim);
    game.state = 'dialogue';
    this.hud.dialogueView.open(session);
  }

  // Edge-triggered: cast once per key press, not every frame it's held. Safe when
  // the player knows fewer than 4 abilities (slot missing -> no-op).
  pollCastKeys() {
    const game = this.game;
    if (!game.sim || !game.sim.player) return;
    const slots = game.sim.player.abilityList();
    for (let i = 0; i < CAST_CODES.length; i++) {
      const code = CAST_CODES[i];
      const down = this.input.has(code);
      if (down && !this._castHeld.has(code)) {
        this._castHeld.add(code);
        const spec = slots[i];
        if (spec) { try { castSpec(spec, game.sim.player, game.sim._ctx()); } catch (e) { console.warn('cast failed', spec.id, e); } }
      } else if (!down) {
        this._castHeld.delete(code);
      }
    }
  }

  // gather (G) from a nearby resource node
  pollGather(dt) {
    const game = this.game;
    this._gatherCd -= dt;
    if (this._gatherCd > 0 || !this.input.has('KeyG') || !game.sim || !game.sim.player || !game.world) return;
    const p = game.sim.player;
    let best = null, bd = 9;             // gather within ~3m of a resource node
    for (const poi of game.world.pois) {
      const c = GATHER[poi.kind]; if (!c) continue;
      const d = p.pos.distanceToSquared(poi.pos);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return;
    p.inventory[best] = (p.inventory[best] || 0) + 1;
    bus.emit(makeEvent({ actorId: p.id, verb: 'gather', tags: GATHER_TAGS[best], magnitude: 1, t: game.sim.time }));
    p._tradeFlash = 0.5;                 // reuse the label flash as pickup feedback
    this._gatherCd = 0.6;
  }

  // Consume a usable item. Shared by the H hotkey and clicking a slot in the
  // inventory panel, so there's one place that knows what each consumable does.
  useItem = (commodity, player) => {
    const p = player || (this.game.sim && this.game.sim.player); if (!p) return;
    if (commodity === 'potion') {
      if ((p.inventory.potion || 0) >= 1 && p.fighter.health < TUNE.maxHealth) {
        p.inventory.potion -= 1;
        p.fighter.health = Math.min(TUNE.maxHealth, p.fighter.health + 45);   // HP bar shows it
      }
    }
  };

  drinkPotion() { this.useItem('potion', this.game.sim && this.game.sim.player); }

  // Install the global keydown map. Returns nothing; mirrors the original
  // window keydown listener verbatim.
  installKeys() {
    const game = this.game;
    const hud = this.hud;
    window.addEventListener('keydown', (e) => {
      const dungeonMgr = this._getDungeonMgr();
      if (e.code === 'KeyE' && game.state === 'playing') {
        e.preventDefault();
        // E is context-sensitive: use a dungeon portal/stairs if we're on one,
        // otherwise strike up a conversation with whoever's under the cursor.
        if (dungeonMgr && game.sim && game.sim.player && dungeonMgr.tryPortal(game.sim.player)) return;
        this.tryOpenDialogue();
      }
      if (e.code === 'Escape' && (game.state === 'playing' || game.state === 'paused')) this._togglePause();
      if (e.code === 'KeyR') this._restart();
      if (e.code === 'KeyQ') hud.questLog.toggle();
      if (e.code === 'KeyB') hud.inventory.toggle();
      if (e.code === 'KeyK') hud.classCodex.toggle();
      if (e.code === 'KeyY') hud.abilityIndex.toggle();
      if (e.code === 'KeyN') hud.chronicle.toggle();
      if (e.code === 'KeyJ') hud.gazette.toggle();
      if (e.code === 'KeyH' && game.state === 'playing') this.drinkPotion();
      // UI tabs toggle on letter keys (C/T/I/M) so they never clash with the 1-4
      // ability hotbar, and work in any state — including mid-play.
      if (e.code === 'KeyC') hud.toggleTab(1);
      if (e.code === 'KeyT') hud.toggleTab(2);
      if (e.code === 'KeyI') hud.toggleTab(3);
      if (e.code === 'KeyM') hud.toggleTab(4);
    });
  }
}
