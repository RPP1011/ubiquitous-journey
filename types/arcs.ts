// THE ARC / SAGA REGISTRY shapes (docs/architecture/12 §3). A generic completed-arc
// ledger any emergent loop opens / appends / closes — the generalisation of the
// Director's `_recordSaga`, owned by the Simulation as `sim.sagas`. Pure data here;
// the store + guarded helpers live in js/sim/arcs.ts.

import type { EntityId } from './core.js';

/** One escalation/setup/climax chapter on an arc's bounded trail. */
export interface ArcBeat { t: number; tag: string; text: string; }

/** One open-or-closed emergent arc (the belief-table shape: id / time / bounded trail). */
export interface Arc {
  arcId: number;            // monotonic, assigned at open (stable identity for chronicle/Gazette threading)
  kind: string;             // 'vendetta'|'ragsToRiches'|'warband'|'rescue'|'burnedVeteran'|'dynasty'|'outlaw'|<director kinds>
  key: string;              // the DEDUP identity (§3.4) — so two loops don't double-open one arc
  principals: EntityId[];   // the agents the arc is ABOUT (1–4); read for naming + dissolve-on-death
  beats: ArcBeat[];         // bounded trail (cap ARCS.maxBeats)
  rounds: number;           // escalation count (vendetta rounds, rags accrual steps, muster waves)
  openedAt: number;         // sim-time opened
  closedAt: number | null;  // null while open
  outcome: string | null;   // null while open; on close: 'fulfilled'|'thwarted'|'ruined'|'lapsed'|'crowded_out'|…
  expiry: number;           // open-arc TTL — swept closed('lapsed') if never resolved (freeze backstop)
  meta?: Record<string, unknown>;  // arc-kind extras the Gazette reads (parentArcId, trade, haul, …)
  sig?: string;             // the Gazette dedup sig, stamped on close (matches _recordSaga's)
  _lastNote?: number;       // throttle clock for round-beat chronicle notes
}

/** The argument bag for opening an arc. */
export interface ArcOpenOpts {
  kind: string;
  key: string;
  principals: EntityId[];
  text?: string;
  expiry?: number;
  meta?: Record<string, unknown>;
}

/** The agent-agnostic store, constructed once as sim.sagas. */
export interface SagaStore {
  openArc(opts: ArcOpenOpts): Arc | null;
  appendRound(opts: ArcOpenOpts, text?: string): Arc | null;
  appendBeat(key: string, tag: string, text?: string): Arc | null;
  closeArc(key: string, outcome: string, text?: string): Arc | null;
  findArc(key: string): Arc | null;
  recentClosed(maxAgeSecs?: number): Arc[];
  sweep(now: number): void;
  _open: Map<string, Arc>;
  _closed: Arc[];
  _seq: number;
}
