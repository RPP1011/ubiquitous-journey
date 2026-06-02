// Fighter: a combat actor (player or enemy) wrapping a KayKit character.
// Owns the animation mixer, the directional-combat state machine, weapon-tip
// sampling for hit detection, health, and a billboarded health bar.

import * as THREE from 'three';
import { AnimationMixer, AnimationClip, LoopOnce, LoopRepeat } from 'three';
import { DIR, ATTACK_CLIP, ATTACK_REVERSE, CLIP, TUNE, MODEL_YAW_OFFSET } from './constants.js';
import { createCharacterInstance } from './assets.js';

const _tip = new THREE.Vector3();
const _origin = new THREE.Vector3();

export class Fighter {
  constructor(characterKey, { isPlayer = false } = {}) {
    const inst = createCharacterInstance(characterKey);
    this.root = inst.root;                 // THREE.Group placed in the world
    this.model = inst.model;
    this.animations = inst.animations;
    this.weaponNode = inst.weaponNode;
    this.weaponTipLocal = inst.weaponTipLocal;
    this.height = inst.height;
    this.isPlayer = isPlayer;

    this.mixer = new AnimationMixer(this.model);
    this.actions = new Map();
    this.current = null;                   // current looping (locomotion/block) action

    this.state = 'idle';                   // idle|ready|attack|recover|block|stagger|dead
    this.dir = DIR.RIGHT;                  // chosen attack direction
    this.blockDir = DIR.RIGHT;
    this.attackAction = null;
    this.dur = 0.6;
    this.reverse = false;        // current swing plays the clip backwards
    this.hasHit = false;
    this.recoverTimer = 0;
    this.staggerTimer = 0;

    this.health = TUNE.maxHealth;
    this.alive = true;

    // When set, a player melee swing routes its damage through this AbilitySpec's
    // damage op (combat.js) instead of flat TUNE.damage. Cleared after one hit.
    // Always defined so ability-less / professionless fighters are safe.
    this.pendingSpec = null;

    this.targetYaw = 0;
    this.moveSpeed = 0;                    // set by controller each frame

    this._playLoop(CLIP.idle, 0);
    if (!isPlayer) this._buildHealthBar();
  }

  // --- animation helpers ----------------------------------------------------
  _action(name) {
    let a = this.actions.get(name);
    if (!a) {
      const clip = AnimationClip.findByName(this.animations, name);
      if (!clip) { console.warn('missing clip', name); return null; }
      a = this.mixer.clipAction(clip);
      this.actions.set(name, a);
    }
    return a;
  }

  _playLoop(name, fade = 0.18) {
    const next = this._action(name);
    if (!next || next === this.current) return;
    // fade out any lingering one-shot (attack/hit) so it doesn't blend on top
    if (this.attackAction && this.attackAction !== next) {
      this.attackAction.fadeOut(fade);
      this.attackAction = null;
    }
    next.reset();
    next.setLoop(LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.fadeIn(fade);
    next.play();
    if (this.current) this.current.fadeOut(fade);
    this.current = next;
  }

  _startSwingClip(dir) {
    const act = this._action(ATTACK_CLIP[dir]);
    if (!act) return;
    const reverse = !!ATTACK_REVERSE[dir];
    this.reverse = reverse;
    if (this.attackAction && this.attackAction !== act) this.attackAction.fadeOut(0.06);
    if (this.current) { this.current.fadeOut(0.08); this.current = null; }
    act.reset();
    act.setLoop(LoopOnce, 1);
    act.clampWhenFinished = true;
    act.enabled = true;
    act.setEffectiveWeight(1);
    act.setEffectiveTimeScale(reverse ? -1 : 1);
    this.dur = act.getClip().duration;
    // hold a cocked / wind-up pose: near the clip start (or end, if reversed)
    act.time = reverse ? this.dur * (1 - TUNE.windupHold) : this.dur * TUNE.windupHold;
    act.paused = true;
    act.play();
    this.attackAction = act;
  }

  // --- combat intents (called by controllers) -------------------------------
  canAct() { return this.alive && (this.state === 'idle' || this.state === 'recover' || this.state === 'block'); }

  ready(dir) {
    if (!this.canAct()) return;
    this.state = 'ready';
    this.dir = dir;
    this._startSwingClip(dir);
  }

  aim(dir) {                 // change chosen direction while still winding up
    if (this.state !== 'ready' || dir === this.dir) return;
    this.dir = dir;
    this._startSwingClip(dir);
  }

  release() {
    if (this.state !== 'ready') return;
    this.state = 'attack';
    this.hasHit = false;
    if (this.attackAction) this.attackAction.paused = false;
  }

  startBlock(dir) {
    if (!this.alive || this.state === 'attack' || this.state === 'stagger') return;
    this.blockDir = dir;
    if (this.state !== 'block') {
      this.state = 'block';
      this._playLoop(CLIP.block, TUNE.blockFade);
    }
  }

  stopBlock() {
    if (this.state === 'block') { this.state = 'idle'; this._playLoop(CLIP.idle); }
  }

  // --- being hit ------------------------------------------------------------
  // returns 'blocked' | 'hit' | 'dead'
  takeHit(damage, attackDir) {
    if (!this.alive) return 'dead';
    if (this.state === 'block' && this.blockDir === attackDir) return 'blocked';

    this.health = Math.max(0, this.health - damage);
    this._updateHealthBar();
    if (this.health <= 0) { this._die(); return 'dead'; }

    this.state = 'stagger';
    this.staggerTimer = TUNE.staggerTime;
    const a = this._action(CLIP.hit);
    if (a) {
      if (this.current) { this.current.fadeOut(0.06); this.current = null; }
      if (this.attackAction) this.attackAction.fadeOut(0.06);
      a.reset(); a.setLoop(LoopOnce, 1); a.clampWhenFinished = false;
      a.enabled = true; a.setEffectiveWeight(1); a.fadeIn(0.06); a.play();
      this.attackAction = a;   // tracked so it's faded out on the next loop
    }
    return 'hit';
  }

  _die() {
    this.alive = false;
    this.state = 'dead';
    if (this.current) this.current.fadeOut(0.15);
    if (this.attackAction) this.attackAction.fadeOut(0.1);
    const a = this._action(CLIP.death);
    if (a) {
      a.reset(); a.setLoop(LoopOnce, 1); a.clampWhenFinished = true;
      a.enabled = true; a.setEffectiveWeight(1); a.fadeIn(0.1); a.play();
    }
    if (this.healthBar) this.healthBar.visible = false;
  }

  // --- hit sampling ---------------------------------------------------------
  isHitActive() {
    if (this.state !== 'attack' || this.hasHit || !this.attackAction) return false;
    const t = this.attackAction.time;
    return t >= TUNE.activeStart * this.dur && t <= TUNE.activeEnd * this.dur;
  }

  // world-space points along the weapon (tip + handle origin)
  weaponPoints() {
    if (!this.weaponNode) {
      this.root.getWorldPosition(_origin);
      _tip.copy(_origin);
      return [_tip, _origin];
    }
    this.weaponNode.updateWorldMatrix(true, false);
    _origin.setFromMatrixPosition(this.weaponNode.matrixWorld);
    _tip.copy(this.weaponTipLocal).applyMatrix4(this.weaponNode.matrixWorld);
    return [_tip, _origin];
  }

  torsoCenter(out) {
    this.root.getWorldPosition(out);
    out.y += this.height * 0.55;
    return out;
  }

  // --- per-frame ------------------------------------------------------------
  setFacing(yaw) { this.targetYaw = yaw + MODEL_YAW_OFFSET; }
  setMoving(speed) { this.moveSpeed = speed; }

  update(dt) {
    // smooth yaw toward target facing
    let d = this.targetYaw - this.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.root.rotation.y += d * Math.min(1, TUNE.turnSpeed * dt);

    switch (this.state) {
      case 'attack': {
        const t = this.attackAction ? this.attackAction.time : (this.reverse ? 0 : this.dur);
        const ended = this.reverse ? (t <= 1e-3) : (t >= this.dur - 1e-3);
        if (ended) { this.state = 'recover'; this.recoverTimer = TUNE.recover; }
        break;
      }
      case 'recover':
        this.recoverTimer -= dt;
        if (this.recoverTimer <= 0) { this.state = 'idle'; this._applyLocomotion(); }
        break;
      case 'stagger':
        this.staggerTimer -= dt;
        if (this.staggerTimer <= 0) { this.state = 'idle'; this._applyLocomotion(); }
        break;
      case 'idle':
        this._applyLocomotion();
        break;
      // ready / block: hold current pose; dead: nothing
    }

    this.mixer.update(dt);
    if (this.healthBar) this._faceHealthBar();
  }

  _applyLocomotion() {
    if (this.state !== 'idle') return;
    if (this.moveSpeed > TUNE.moveSpeed * 1.2) this._playLoop(CLIP.run);
    else if (this.moveSpeed > 0.15) this._playLoop(CLIP.walk);
    else this._playLoop(CLIP.idle);
  }

  // --- health bar (enemies) -------------------------------------------------
  _buildHealthBar() {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 20;
    this._hbCanvas = canvas;
    this._hbCtx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.0, 0.16, 1);
    sprite.position.y = this.height + 0.35;
    sprite.renderOrder = 999;
    this.healthBar = sprite;
    this.root.add(sprite);
    this._updateHealthBar();
  }

  _updateHealthBar() {
    if (!this._hbCtx) return;
    const ctx = this._hbCtx, w = 128, h = 20;
    const frac = Math.max(0, this.health / TUNE.maxHealth);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = frac > 0.4 ? '#cf3b2c' : '#e0a020';
    ctx.fillRect(2, 2, (w - 4) * frac, h - 4);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
    this.healthBar.material.map.needsUpdate = true;
  }

  _faceHealthBar() {
    // Sprites already billboard; nothing needed, kept for clarity/extension.
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
