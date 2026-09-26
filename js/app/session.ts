// The APPLICATION layer's entry point: one game session over the behaviour engine.
//
// The engine (js/sim, js/rpg) never imports anything under js/app; the frontend (main.js, js/ui)
// talks to the engine through a Session. A Session owns the canonical frame step — the order
// main.js, the headless suites and the scenario harness previously each hand-copied:
//
//   sim.update → [afterSimUpdate hook] → fighter.update → [beforeCombat hook]
//     → resolveCombat(gate) → sim.onCombatEvents → run-end check
//
// and the run lifecycle (a run ENDS when the player's body dies, or when the app calls end()).
//
// ONE SESSION PER PROCESS. The deed bus, the rng stream and the sim config are process-wide
// singletons (see the lifecycle audit), so two live sessions would cross-route each other's
// events. createSession asserts no other session is live; dispose() releases the slot.

import { World } from '../sim/world.js';
import { Simulation } from '../sim/simulation.js';
import { resolveCombat } from '../combat.js';
import { setSeed } from '../sim/rng.js';
import type { Fighter, CombatEvent } from '../../types/sim.js';

/** The slice of a Three.Scene the sim touches (a `{add(){},remove(){}}` stub runs headless). */
export interface SceneLike { add(o: unknown): void; remove(o: unknown): void; }

/** Builds a combat body. Browser default is the visual Fighter; headless passes HeadlessFighter. */
export type MakeFighter = (model: string, o?: { isPlayer?: boolean }) => unknown;

export interface SessionOptions {
  scene: SceneLike;
  makeFighter?: MakeFighter;
  /** Arms the shared deterministic rng stream for this run. Omit for the platform Math.random. */
  seed?: number;
  /** Townsfolk per town (tests/benches build small worlds). Omit for the ROSTER default. */
  townsfolkPerTown?: number;
  /** Add a player body. Omit (or null) for a headless world with no player — runs never end by death. */
  player?: { fighter: unknown; spawn?: { x: number; z: number }; abilities?: readonly unknown[] } | null;
}

export type RunEndReason = 'death' | 'ended';

/** What the app shows when a run ends. Built from truth-side logs (chronicle) — display only. */
export interface RunSummary {
  reason: RunEndReason;
  t: number;
  beats: ReadonlyArray<{ t: number; kind: string; text: string }>;
}

export interface StepOptions {
  /** false ⇒ bodies animate but no blows resolve (e.g. a dialogue modal is open). Default true. */
  combat?: boolean;
  /** Runs right after sim.update (frontend: dungeon streaming, player terrain grounding). */
  afterSimUpdate?: () => void;
  /** Runs after fighters update, before blows resolve (frontend: scene.updateMatrixWorld). */
  beforeCombat?: () => void;
  /** Crash-surface hook: called with each stage name as the step enters it. */
  stage?: (name: string) => void;
}

export interface Session {
  readonly sim: Simulation;
  readonly world: World;
  /** The player's agent, or null in a playerless world. */
  readonly player: ReturnType<Simulation['addPlayer']> | null;
  readonly runState: 'running' | 'ended';
  readonly summary: RunSummary | null;
  /**
   * The player's strike gate: which body the player's swing may damage. NPC swings always use
   * the sim's ground-truth isHostile. Default null ⇒ the player hits anything they swing at.
   * The frontend sets this to "only the body I ordered an attack on".
   */
  playerStrikeGate: ((target: Fighter) => boolean) | null;
  /** Advance one frame. Returns the combat events resolved this frame (possibly empty). */
  step(dt: number, opts?: StepOptions): CombatEvent[];
  /** Subscribe to the run ending. Returns an unsubscribe fn. Fires once per run. */
  onRunEnd(fn: (s: RunSummary) => void): () => void;
  /** Check whether the player has died outside a step (e.g. during a turn-based resolution). */
  checkRunEnd(): void;
  /** End the run now (quit / abandon). No-op if already ended. */
  end(): void;
  /** Tear the world down: sim subsystems + bus subscriptions, every body, the world. */
  dispose(): void;
}

const SUMMARY_BEATS = 12;

let _live: Session | null = null;

export function createSession(opts: SessionOptions): Session {
  if (_live) throw new Error('createSession: another session is still live — dispose() it first');

  if (opts.seed !== undefined) setSeed(opts.seed);
  const world = new World(opts.scene as never);
  const sim = new Simulation(opts.scene as never, world as never,
    opts.makeFighter ? { makeFighter: opts.makeFighter as never } : {});
  sim.spawn(opts.townsfolkPerTown === undefined ? {} : { townsfolkPerTown: opts.townsfolkPerTown });

  let player: Session['player'] = null;
  if (opts.player) {
    const body = opts.player.fighter as Fighter;
    const at = opts.player.spawn ?? { x: 0, z: 8 };
    body.root.position.set(at.x, 0, at.z);
    opts.scene.add(body.root);
    player = sim.addPlayer(body as never);
    for (const ab of opts.player.abilities ?? []) player.grantAbility(ab as never);
  }

  let runState: Session['runState'] = 'running';
  let summary: RunSummary | null = null;
  const endFns: Array<(s: RunSummary) => void> = [];
  let disposed = false;

  const finish = (reason: RunEndReason): void => {
    if (runState === 'ended') return;
    runState = 'ended';
    let beats: RunSummary['beats'] = [];
    try { beats = sim.chronicle.recent(SUMMARY_BEATS).map((b) => ({ t: b.t, kind: b.kind, text: b.text })); }
    catch { /* summary is best-effort display; never throw out of the step */ }
    summary = { reason, t: sim.time, beats };
    for (const fn of endFns.slice()) {
      try { fn(summary); } catch (e) { console.warn('onRunEnd listener error', e); }
    }
  };

  const session: Session = {
    sim, world, player,
    get runState() { return runState; },
    get summary() { return summary; },
    playerStrikeGate: null,

    step(dt: number, so: StepOptions = {}): CombatEvent[] {
      if (disposed) throw new Error('Session.step after dispose()');
      const stage = so.stage ?? (() => {});
      stage('sim.update');      sim.update(dt);
      if (so.afterSimUpdate) { stage('afterSimUpdate'); so.afterSimUpdate(); }

      const fighters = sim.fighters as unknown as Fighter[];
      stage('fighter.update');  for (const f of fighters) f.update(dt);
      if (so.beforeCombat) { stage('beforeCombat'); so.beforeCombat(); }

      let events: CombatEvent[] = [];
      if (so.combat !== false) {
        stage('resolveCombat');
        const pf = player ? (player.fighter as unknown as Fighter) : null;
        const gate = session.playerStrikeGate;
        const isHostile = (atk: Fighter, tgt: Fighter): boolean =>
          atk === pf && gate ? gate(tgt) : sim.isHostile(atk as never, tgt as never);
        // bodies inside a turn-based encounter are resolved by the encounter, never by real-time blows
        const live = fighters.filter((f) => !(f.agent && (f.agent as { _encounter?: number | null })._encounter != null));
        events = resolveCombat(live, isHostile, sim._ctx() as never);
        if (events.length) { stage('onCombatEvents'); sim.onCombatEvents(events as never); }
      }

      session.checkRunEnd();
      return events;
    },

    checkRunEnd() { if (runState === 'running' && player && !player.alive) finish('death'); },

    onRunEnd(fn) {
      endFns.push(fn);
      return () => { const i = endFns.indexOf(fn); if (i >= 0) endFns.splice(i, 1); };
    },

    end() { finish('ended'); },

    dispose() {
      if (disposed) return;
      disposed = true;
      endFns.length = 0;
      try { sim.dispose(); } catch (e) { console.warn('sim.dispose failed', e); }
      for (const a of sim.agents) { try { (a.fighter as { dispose?: () => void }).dispose?.(); } catch { /* keep tearing down */ } }
      try { world.dispose(); } catch (e) { console.warn('world.dispose failed', e); }
      if (_live === session) _live = null;
    },
  };

  _live = session;
  return session;
}
