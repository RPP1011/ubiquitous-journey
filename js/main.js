// Bootstrap: a peaceful market-town sandbox. Agents have professions, produce
// commodities, eat, and trade at the market using price beliefs that update
// from trades and spread by gossip. Look at anyone and press F to read their
// economic mind. The human just wanders and watches.
//
// main.js is the thin entry: it builds the renderer/scene (boot.js), the HUD
// (ui/hud.js) and player input (playerControls.js), owns the game-state machine
// + world build/teardown, and runs the frame loop (with its crash-surface).

import * as THREE from 'three';
import { preloadCharacters } from './assets.js';
import { Fighter } from './fighter.js';
import { resolveCombat } from './combat.js';
import { TUNE } from './constants.js';
import { World } from './sim/world.js';
import { Simulation } from './sim/simulation.js';
import { ABILITY_CATALOG } from './rpg/abilities/catalog.js';
import { DungeonManager } from './world/dungeonManager.js';
import { boot } from './boot.js';
import { Hud } from './ui/hud.js';
import { PlayerControls } from './playerControls.js';

// ---- renderer / scene / camera / input -------------------------------------
const { renderer, scene, camera, orbitCam, input, commander } = boot();

let dungeonMgr = null;             // built per-world in buildWorld()

// ---- HUD (panels + readouts) -----------------------------------------------
const hud = new Hud({
  camera,
  getSim: () => game.sim,
  getDungeonMgr: () => dungeonMgr,
});

// ---- game state ------------------------------------------------------------
const game = { state: 'start', world: null, sim: null, player: null, playerFighter: null };

// ---- player input ----------------------------------------------------------
const controls = new PlayerControls({
  game, input, camera, commander, hud,
  getDungeonMgr: () => dungeonMgr,
  togglePause: () => togglePause(),
  restart: () => restart(),
});
controls.installKeys();

function buildWorld() {
  if (dungeonMgr) { dungeonMgr.dispose(); dungeonMgr = null; }
  if (game.sim) { game.sim.dispose?.(); for (const a of game.sim.agents) a.fighter.dispose(); }
  if (game.world) game.world.dispose();

  game.world = new World(scene);
  game.sim = new Simulation(scene, game.world);
  game.sim.spawn();

  // dungeons: scatter cave-mouth portals in the wilds and expose the manager to
  // the quest board so it can mint "delve" radiant quests against real dungeons.
  dungeonMgr = new DungeonManager(scene, game.sim);
  dungeonMgr.placeEntrances();
  game.sim.dungeons = dungeonMgr;

  const pf = new Fighter('knight', { isPlayer: true });
  pf.root.position.set(0, 0, 8);
  scene.add(pf.root);
  game.playerFighter = pf;
  const playerAgent = game.sim.addPlayer(pf);
  commander.attach(playerAgent, game.sim);   // you drive this one body, point-and-click
  // Starter loadout so keys 1-4 have something to cast. Mix a melee spec (arms
  // the next swing), a projectile, a self spec and an AoE so every cast path is
  // exercised. Guarded: missing catalog ids are skipped.
  for (const id of ['power_strike', 'frost_bolt', 'second_wind', 'whirlwind']) {
    if (ABILITY_CATALOG[id]) playerAgent.grantAbility(ABILITY_CATALOG[id]);
  }

  hud.setWorld(game.sim, controls.useItem);
  // overhead follow camera (Stoneshard/Qud-ish angle), no mouse-look
  orbitCam.yaw = 0; orbitCam.pitch = 0.88; orbitCam.distance = 11; orbitCam.height = 1.1;
}

// ---- DOM (overlay / hint) --------------------------------------------------
const overlay = document.getElementById('overlay');
const hint = document.getElementById('hint');

function setOverlay(html) { overlay.innerHTML = html; }
function showOverlay() { overlay.classList.remove('hidden'); }
function hideOverlay() { overlay.classList.add('hidden'); }

function restart() {
  buildWorld();
  hideOverlay();
  game.state = 'playing';
}

// pause/resume (replaces the old pointer-lock-driven pause)
function togglePause() {
  if (game.state === 'playing') {
    game.state = 'paused';
    setOverlay(`<h1>PAUSED</h1><p><span class="key">Esc</span> or <span class="key">click</span> to resume.</p>`);
    showOverlay();
  } else if (game.state === 'paused' || game.state === 'start') {
    hideOverlay(); hint.classList.add('hidden');
    game.state = 'playing';
  }
}

overlay.addEventListener('click', () => { if (game.state !== 'dialogue') togglePause(); });

// ---- main loop -------------------------------------------------------------
const clock = new THREE.Clock();
let _frames = 0, _crashed = false;

function frame() {
  if (_crashed) return;
  _frames++;
  const dt = Math.min(clock.getDelta(), 0.05);
  let stage = 'start';
  const stageFn = (name) => { stage = name; };
  try {
    commander.enabled = (game.state === 'playing');

    if (game.state === 'playing') {
      stage = 'commander';     commander.update(dt, game.sim._ctx());
      // keep the player inside dungeon walls (overrides the arena clamp while below)
      stage = 'dungeon.collide'; if (dungeonMgr && dungeonMgr.active) dungeonMgr.collidePlayer(game.playerFighter.root.position);
      stage = 'sim.update';    game.sim.update(dt);
      stage = 'dungeon.update'; if (dungeonMgr) dungeonMgr.update(dt);
      stage = 'castInput';     controls.pollCastKeys();
      stage = 'gather';        controls.pollGather(dt);
    } else if (game.state === 'dialogue') {
      // freeze the player but keep the social sim alive behind the modal
      stage = 'sim.update';    game.sim.update(dt);
    }

    const fighters = game.sim ? game.sim.fighters : [];
    stage = 'fighter.update'; for (const f of fighters) f.update(dt);
    scene.updateMatrixWorld(true);

    if (game.state === 'playing') {
      stage = 'resolveCombat';
      // hostility gate: NPCs use ground-truth isHostile; the player's swings are
      // allowed to land only on the body they were ordered to attack, so peaceful
      // villagers aren't friendly-fire pass-through once you choose a victim.
      const isHostile = (atk, tgt) => atk === game.playerFighter
        ? commander.targetFighter === tgt
        : game.sim.isHostile(atk, tgt);
      const events = resolveCombat(fighters, isHostile, game.sim._ctx());
      if (events.length) {
        stage = 'onCombatEvents'; game.sim.onCombatEvents(events);
        for (const ev of events) if (ev.target === game.playerFighter && ev.type !== 'blocked') hud.flashHurt();
      }
      if (hud.hpFill) hud.hpFill.style.width = `${Math.max(0, (game.playerFighter.health / TUNE.maxHealth) * 100)}%`;
    }

    hud.render(game, commander.mouseNDC, stageFn);
    if (game.playerFighter) { stage = 'camera'; orbitCam.update(game.playerFighter.root.position, dt); }
    stage = 'render';     renderer.render(scene, camera);

    const n = game.sim ? game.sim.agents.length : 0;
    hud.setDebug(`state=${game.state}  t=${game.sim ? game.sim.time.toFixed(1) : '-'}  frame=${_frames}  agents=${n}`);
  } catch (err) {
    _crashed = true;
    console.error('FRAME CRASH at stage:', stage, err);
    hud.setCrash(`CRASH @ ${stage}\n${err && err.message}\n${(err && err.stack || '').split('\n').slice(1, 4).join('\n')}`);
    setOverlay(`<h1 class="lose">Runtime error</h1><p>stage: <b>${stage}</b></p><p>${err && err.message}</p><p style="font-size:11px;opacity:.7">${(err && err.stack || '').split('\n').slice(1, 5).join('<br>')}</p>`);
    showOverlay();
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- boot ------------------------------------------------------------------
const INTRO = `<h1>MARKET TOWN</h1>
  <p>You guide a single adventurer through a living town of farmers, miners and a
  smith who produce, trade and gossip on their own <i>beliefs</i>.</p>
  <p><b>Left-click</b> to move anywhere · <b>right-click</b> to attack a target.
  Hover anyone to read their mind; <span class="key">E</span> to talk.</p>
  <p style="margin-top:16px;"><span class="key">Click</span> to begin.</p>`;

setOverlay(`<h1>MARKET TOWN</h1><p>Loading…</p>`);
preloadCharacters().then(() => {
  buildWorld();
  game.state = 'start';
  setOverlay(INTRO);
  renderer.setAnimationLoop(frame);
}).catch((err) => {
  setOverlay(`<h1 class="lose">Load error</h1><p>${err.message}</p><p>Serve over http (python3 -m http.server).</p>`);
  console.error(err);
});
