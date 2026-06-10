// Fighter: a combat actor (player or enemy) wrapping a KayKit character.
// Owns the animation mixer, the directional-combat state machine, weapon-tip
// sampling for hit detection, health, and a billboarded health bar.

import * as THREE from 'three';
import { AnimationMixer, AnimationClip, LoopOnce, LoopRepeat } from 'three';
import { DIR, ATTACK_CLIP, ATTACK_REVERSE, CLIP, TUNE, MODEL_YAW_OFFSET } from './constants.js';
import { createCharacterInstance } from './assets.js';
import type { Fighter as IFighter, FighterState, FighterDir } from '../types/sim.js';
import type { AbilitySpec, Agent } from '../types/sim.js';

const _tip = new THREE.Vector3();
const _origin = new THREE.Vector3();

// The vendored three.module.js is un-typed JS; these minimal views recover exactly
// the animation/scene-graph surface this state machine touches (getter-installed
// members tsc can't see). They add nothing at runtime.
interface AnimAction {
  time: number;
  paused: boolean;
  enabled: boolean;
  clampWhenFinished: boolean;
  reset(): AnimAction;
  play(): AnimAction;
  stop(): AnimAction;
  fadeIn(d: number): AnimAction;
  fadeOut(d: number): AnimAction;
  setLoop(mode: unknown, reps: number): AnimAction;
  setEffectiveWeight(w: number): AnimAction;
  setEffectiveTimeScale(s: number): AnimAction;
  getClip(): { duration: number };
}
interface MixerLike {
  clipAction(clip: unknown): AnimAction;
  update(dt: number): void;
  stopAllAction(): void;
}
// A fighter's root Group: the transform surface + world-position sampling + scene wiring.
interface RootNode {
  position: THREE.Vector3;
  rotation: { x: number; y: number; z: number };
  getWorldPosition(out: THREE.Vector3): THREE.Vector3;
  add(child: object): void;
  removeFromParent(): void;
}
// The weapon node carried by the character instance (world-matrix sampling for hit points).
interface WeaponNode {
  matrixWorld: THREE.Matrix4;
  updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
}
// A billboarded health-bar sprite (visible toggle + its material's texture upload flag).
interface HealthBarSprite {
  visible: boolean;
  material: { map: { needsUpdate: boolean } };
}

export class Fighter implements IFighter {
  root: RootNode;
  model: object;
  animations: unknown[];
  weaponNode: WeaponNode | null;
  weaponTipLocal: THREE.Vector3;
  height: number;
  isPlayer: boolean;
  mixer: MixerLike;
  actions: Map<string, AnimAction>;
  current: AnimAction | null;
  state: FighterState;
  dir: FighterDir;
  blockDir: FighterDir;
  attackAction: AnimAction | null;
  dur: number;
  reverse: boolean;
  hasHit: boolean;
  recoverTimer: number;
  staggerTimer: number;
  health: number;
  alive: boolean;
  pendingSpec: AbilitySpec | null;
  targetYaw: number;
  moveSpeed: number;
  agent?: Agent;
  healthBar?: HealthBarSprite;
  _hbCanvas?: HTMLCanvasElement;
  _hbCtx?: CanvasRenderingContext2D | null;

  constructor(characterKey: string, { isPlayer = false }: { isPlayer?: boolean } = {}) {
    const inst = createCharacterInstance(characterKey);
    this.root = inst.root as RootNode;     // THREE.Group placed in the world
    this.model = inst.model;
    this.animations = inst.animations;
    this.weaponNode = inst.weaponNode as unknown as WeaponNode | null;
    this.weaponTipLocal = inst.weaponTipLocal;
    this.height = inst.height;
    this.isPlayer = isPlayer;

    this.mixer = new AnimationMixer(this.model) as unknown as MixerLike;
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
  _action(name: string): AnimAction | null {
    let a = this.actions.get(name);
    if (!a) {
      const clip = AnimationClip.findByName(this.animations as never, name);
      if (!clip) { console.warn('missing clip', name); return null; }
      a = this.mixer.clipAction(clip);
      this.actions.set(name, a);
    }
    return a;
  }

  _playLoop(name: string, fade = 0.18): void {
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

  _startSwingClip(dir: FighterDir): void {
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
  canAct(): boolean { return this.alive && (this.state === 'idle' || this.state === 'recover' || this.state === 'block'); }

  ready(dir: FighterDir): void {
    if (!this.canAct()) return;
    this.state = 'ready';
    this.dir = dir;
    this._startSwingClip(dir);
  }

  aim(dir: FighterDir): void {                 // change chosen direction while still winding up
    if (this.state !== 'ready' || dir === this.dir) return;
    this.dir = dir;
    this._startSwingClip(dir);
  }

  release(): void {
    if (this.state !== 'ready') return;
    this.state = 'attack';
    this.hasHit = false;
    if (this.attackAction) this.attackAction.paused = false;
  }

  startBlock(dir: FighterDir): void {
    if (!this.alive || this.state === 'attack' || this.state === 'stagger') return;
    this.blockDir = dir;
    if (this.state !== 'block') {
      this.state = 'block';
      this._playLoop(CLIP.block, TUNE.blockFade);
    }
  }

  stopBlock(): void {
    if (this.state === 'block') { this.state = 'idle'; this._playLoop(CLIP.idle); }
  }

  // --- being hit ------------------------------------------------------------
  // returns 'blocked' | 'hit' | 'dead'
  takeHit(damage: number, attackDir: FighterDir): 'blocked' | 'hit' | 'dead' {
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

  _die(): void {
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

  // CAPTIVE (the rescue arc): un-kill a just-defeated body — used when a lethal blow is converted
  // to a CAPTURE (combatEvents) instead of a death. Restore liveness + a clamped health, stop the
  // death animation, and resume idle locomotion. Mirrors headlessFighter.revive on the visual side.
  revive(health: number): void {
    this.alive = true;
    this.state = 'idle';
    this.health = Math.max(1, Math.min(TUNE.maxHealth, health || TUNE.maxHealth));
    this.staggerTimer = 0; this.recoverTimer = 0; this.hasHit = false;
    this.moveSpeed = 0;
    const d = this._action(CLIP.death);
    if (d) d.fadeOut(0.1);
    this._playLoop(CLIP.idle, 0.1);
    if (this.healthBar) this.healthBar.visible = true;
  }

  // --- hit sampling ---------------------------------------------------------
  isHitActive(): boolean {
    if (this.state !== 'attack' || this.hasHit || !this.attackAction) return false;
    const t = this.attackAction.time;
    return t >= TUNE.activeStart * this.dur && t <= TUNE.activeEnd * this.dur;
  }

  // world-space points along the weapon (tip + handle origin)
  weaponPoints(): [THREE.Vector3, THREE.Vector3] {
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

  torsoCenter(out: THREE.Vector3): THREE.Vector3 {
    this.root.getWorldPosition(out);
    out.y += this.height * 0.55;
    return out;
  }

  // --- per-frame ------------------------------------------------------------
  setFacing(yaw: number): void { this.targetYaw = yaw + MODEL_YAW_OFFSET; }
  setMoving(speed: number): void { this.moveSpeed = speed; }

  update(dt: number): void {
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

  _applyLocomotion(): void {
    if (this.state !== 'idle') return;
    if (this.moveSpeed > TUNE.moveSpeed * 1.2) this._playLoop(CLIP.run);
    else if (this.moveSpeed > 0.15) this._playLoop(CLIP.walk);
    else this._playLoop(CLIP.idle);
  }

  // --- health bar (enemies) -------------------------------------------------
  _buildHealthBar(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 20;
    this._hbCanvas = canvas;
    this._hbCtx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    // Sprite transform members are getter-installed on the vendored JS (tsc can't see them).
    const sx = sprite as unknown as {
      scale: { set(x: number, y: number, z: number): void };
      position: { y: number };
      renderOrder: number;
    };
    sx.scale.set(1.0, 0.16, 1);
    sx.position.y = this.height + 0.35;
    sx.renderOrder = 999;
    this.healthBar = sprite as unknown as HealthBarSprite;
    this.root.add(sprite);
    this._updateHealthBar();
  }

  _updateHealthBar(): void {
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
    if (this.healthBar) this.healthBar.material.map.needsUpdate = true;
  }

  _faceHealthBar(): void {
    // Sprites already billboard; nothing needed, kept for clarity/extension.
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
