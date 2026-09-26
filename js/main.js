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
import { TUNE } from './constants.js';
import { createSession } from './app/session.js';
import { CombatDirector } from './app/combat/encounter.js';
import { COMBAT } from './app/combat/rules.js';
import { EncounterView } from './ui/encounterView.js';
import { terrainHeight } from './arena.js';
import { ABILITY_CATALOG } from './rpg/abilities/catalog.js';
import { DungeonManager } from './world/dungeonManager.js';
import { boot } from './boot.js';
import { Hud } from './ui/hud.js';
import { PlayerControls } from './playerControls.js';

// ---- renderer / scene / camera / input -------------------------------------
const { renderer, scene, camera, orbitCam, input, commander } = boot();

let dungeonMgr = null;             // built per-world in buildWorld()
let session = null;                // the app-layer Session (js/app/session.ts) for the current run
let combat = null;                 // CombatDirector: opens turn-based encounters around the player's fights
let playback = 0;                  // real seconds left in the current round's playback
const encView = new EncounterView();

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
  if (session) { session.dispose(); session = null; }

  // SEEDED DETERMINISM (opt-in): `?seed=<n>` in the URL arms the shared PRNG so the run
  // reproduces (same seed → same routed stochastic stream). No param ⇒ seed undefined ⇒
  // the PRNG stays unseeded (rng() === Math.random()), the default non-deterministic world.
  const _seedParam = new URLSearchParams(location.search).get('seed');
  const _seed = _seedParam == null ? undefined : (Number(_seedParam) | 0);
  // Starter loadout so keys 1-4 have something to cast. Mix a melee spec (arms
  // the next swing), a projectile, a self spec and an AoE so every cast path is
  // exercised. Guarded: missing catalog ids are skipped.
  const abilities = ['power_strike', 'frost_bolt', 'second_wind', 'whirlwind']
    .map((id) => ABILITY_CATALOG[id]).filter(Boolean);
  const pf = new Fighter('knight', { isPlayer: true });
  session = createSession({ scene, seed: _seed, player: { fighter: pf, spawn: { x: 0, z: 8 }, abilities } });
  game.world = session.world;
  game.sim = session.sim;
  game.playerFighter = pf;
  // the player's swing lands only on the body they were ordered to attack, so peaceful
  // villagers aren't friendly-fire pass-through once you choose a victim.
  session.playerStrikeGate = (tgt) => commander.targetFighter === tgt;
  session.onRunEnd((summary) => { encView.close(); showRunOver(summary); });
  combat = new CombatDirector(session);
  encView.close();

  // dungeons: scatter cave-mouth portals in the wilds and expose the manager to
  // the quest board so it can mint "delve" radiant quests against real dungeons.
  dungeonMgr = new DungeonManager(scene, game.sim);
  dungeonMgr.placeEntrances();
  game.sim.dungeons = dungeonMgr;

  commander.attach(session.player, game.sim);   // you drive this one body, point-and-click

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

const _esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// The run is over (the player's body died). Nothing carries over; R begins a new run.
function showRunOver(summary) {
  game.state = 'over';
  const mins = Math.floor(summary.t / 60), secs = Math.floor(summary.t % 60);
  const beats = summary.beats.slice(-8).map((b) => `<li>${_esc(b.text)}</li>`).join('');
  setOverlay(`<h1 class="lose">YOU HAVE FALLEN</h1>
    <p>Your story ended after ${mins}m ${secs}s.</p>
    ${beats ? `<p>The town will remember:</p><ul style="text-align:left;font-size:13px">${beats}</ul>` : ''}
    <p><span class="key">R</span> to begin a new life.</p>`);
  showOverlay();
}

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

// ---- turn-based encounters (js/app/combat) ---------------------------------
encView.onReady = () => {
  const enc = combat && combat.encounter;
  if (!enc || enc.phase !== 'declare') return;
  enc.resolve();
  playback = COMBAT.playbackSec;
  encView.render();
  session.checkRunEnd();
};
encView.onContinue = () => {
  combat.clear();
  encView.close();
  if (session.player) session.player.goal = { kind: 'idle' };   // don't chase a foe who fled or yielded
  if (game.state === 'encounter') game.state = 'playing';
};

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

    if (game.state === 'playing' || game.state === 'dialogue') {
      const playing = game.state === 'playing';
      if (playing) {
        stage = 'commander';     commander.update(dt, game.sim._ctx());
        // keep the player inside dungeon walls (overrides the arena clamp while below)
        stage = 'dungeon.collide'; if (dungeonMgr && dungeonMgr.active) dungeonMgr.collidePlayer(game.playerFighter.root.position);
      }
      // The canonical frame lives in the Session. In dialogue the player is frozen but the
      // social sim keeps running behind the modal, and no blows resolve.
      const events = session.step(dt, {
        combat: playing,
        stage: stageFn,
        afterSimUpdate: () => {
          if (!playing) return;
          if (dungeonMgr) dungeonMgr.update(dt);
          // settle the PLAYER onto the terrain surface too (the commander moves it in
          // x/z without re-grounding, so it would float on the hills). Overworld only —
          // while below, the dungeon owns the player's deep y, so we leave it alone.
          if (game.playerFighter && !(dungeonMgr && dungeonMgr.active)) {
            const p = game.playerFighter.root.position;
            try { p.y = terrainHeight(p.x, p.z); } catch { /* never throw on the frame */ }
          }
        },
        beforeCombat: () => scene.updateMatrixWorld(true),
      });
      if (playing) {
        for (const ev of events) if (ev.target === game.playerFighter && ev.type !== 'blocked') hud.flashHurt();
        stage = 'castInput';     controls.pollCastKeys();
        stage = 'gather';        controls.pollGather(dt);
        if (hud.hpFill) hud.hpFill.style.width = `${Math.max(0, (game.playerFighter.health / TUNE.maxHealth) * 100)}%`;
        // the player's side came to blows: switch to a turn-based encounter
        stage = 'combat.watch';
        const enc = game.state === 'playing' && combat ? combat.watch() : null;
        if (enc) { game.state = 'encounter'; if (session.player) session.player.goal = { kind: 'idle' }; encView.open(enc); }
      }
    } else if (game.state === 'encounter') {
      const enc = combat.encounter;
      if (enc && enc.phase === 'playback') {
        // the world outside the bubble lives through the round (roundSec of sim time, shown in playbackSec)
        const scaled = dt * COMBAT.roundSec / COMBAT.playbackSec;
        for (let k = 0; k < 3; k++) session.step(scaled / 3, { stage: stageFn, beforeCombat: () => scene.updateMatrixWorld(true) });
        playback -= dt;
        if (playback <= 0) { enc.finishPlayback(); encView.render(); }
      } else if (game.sim) {
        stage = 'fighter.update'; for (const f of game.sim.fighters) f.update(dt);
        scene.updateMatrixWorld(true);
      }
      if (hud.hpFill) hud.hpFill.style.width = `${Math.max(0, (game.playerFighter.health / TUNE.maxHealth) * 100)}%`;
    } else {
      // paused / start / over: the sim is frozen, bodies keep animating (as before), no blows
      if (game.sim) { stage = 'fighter.update'; for (const f of game.sim.fighters) f.update(dt); }
      scene.updateMatrixWorld(true);
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
