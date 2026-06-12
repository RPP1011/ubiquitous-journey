// THE ARC / SAGA REGISTRY — THE SPINE (docs/architecture/12 §3). A generic completed-arc
// ledger any emergent loop opens → appends → closes, surfaced to the chronicle/Gazette and
// assertable in tests. It generalises the Director's `_recordSaga` (which only filed at the END,
// lived on the Director, and kept no beat trail) into an open→escalate→close lifecycle owned by
// the Simulation as `sim.sagas`, into which `_recordSaga` is folded — one ledger the Gazette reads.
//
// The shape mirrors the obligations/experience pure-helper stores: a small bounded record-keeper,
// every method GUARDED (never throws on the tick) and BOUNDED (maxOpen/maxClosed/maxBeats), with a
// self-throttled lazy-expiry sweep — no heavy per-tick pass (the freeze lesson).
//
// LAYERING (review 1): this store is a PURE LEDGER. closeArc is UNCONDITIONAL — it never reaches
// into agents' cognition state to decide whether to close (that would livelock enforceMaxOpen/sweep,
// which both call closeArc to GUARANTEE _open shrinks). Caller-specific logic (the mutual-feud
// guard, the pop-reason discriminator) lives at the call site that motivates it, not in here.

import { ARCS } from './simconfig.js';
import { BEAT } from './chronicle.js';
import type { Arc, ArcOpenOpts, SagaStore as ISagaStore } from '../../types/sim.js';
import type { EntityId } from '../../types/core.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;   // the owning Simulation (wave-2 .js cluster); read read-only + fully guarded.

// the title each emergent arc kind reads under in the chronicle/Gazette (threads its chapters).
export const ARC_TITLE: Record<string, string> = {
  vendetta:     'The Vendetta',
  ragsToRiches: 'Rags to Riches',
  warband:      'The Warband',
  rescue:       'The Rescue',
  burnedVeteran:'The Burned Veteran',
  dynasty:      'The Dynasty',
  outlaw:       'The Outlaw',
};

// the chronicle BEAT kind each arc kind files its open/round/close notes under.
const ARC_BEAT: Record<string, string> = {
  vendetta:     BEAT.VENDETTA,
  ragsToRiches: BEAT.RISE,
  warband:      BEAT.MUSTER,
  rescue:       BEAT.RESCUE,
  burnedVeteran:BEAT.RETIRE,
  dynasty:      BEAT.MENTOR,
  outlaw:       BEAT.LEGEND,
};

// arcKey — the canonical, order-normalised identity of a story (§3.4). SYMMETRIC kinds (vendetta)
// sort their ids so either party's derive opens the SAME arc; asymmetric kinds (rescue keyed on the
// victim) leave the authored order. This is the load-bearing dedup: openArc is idempotent on key.
const SYMMETRIC = new Set(['vendetta', 'dynasty', 'romance']);
export function arcKey(kind: string, ...ids: Array<EntityId | string | number>): string {
  const parts = ids.map((x) => String(x));
  if (SYMMETRIC.has(kind)) parts.sort();
  return `${kind}:${parts.join(':')}`;
}

export class SagaStore implements ISagaStore {
  sim: Sim;
  _open: Map<string, Arc>;
  _closed: Arc[];
  _seq: number;
  _lapsedAt: Map<string, number>;

  constructor(sim: Sim) {
    this.sim = sim;
    this._open = new Map();    // key -> open arc (dedup + fast find); bounded ARCS.maxOpen
    this._closed = [];         // ring of completed arcs (cap ARCS.maxClosed) — what the Gazette/UI read
    this._seq = 0;             // monotonic arcId
    this._lapsedAt = new Map();// key -> sim-time of its last LAPSED close (the re-open refractory;
                               //   kept beside the ring because the bounded ring evicts — a churned
                               //   entry must not amnesty the refractory). Bounded: pruned on insert.
  }

  _now(): number { try { return (this.sim && this.sim.time) || 0; } catch { return 0; } }

  _nameOf(id: unknown): string {
    if (id == null) return 'someone';
    try { const a = this.sim && this.sim.agentsById && this.sim.agentsById.get(id); return (a && a.name) || 'someone'; }
    catch { return 'someone'; }
  }

  // file a chronicle note for this arc (guarded; the chronicle threads it by arcId/title).
  _note(arc: Arc, text: string): void {
    try {
      if (!text || !this.sim || !this.sim.chronicle) return;
      const kind = ARC_BEAT[arc.kind] || 'note';
      this.sim.chronicle.note(kind, arc.principals[0], text, { id: String(arc.arcId), title: ARC_TITLE[arc.kind] || 'A Tale' });
    } catch { /* never throw on the tick */ }
  }

  // the most recent CLOSED arc on a key — for the re-ignition back-link ("the feud rekindles").
  _lastClosed(key: string): Arc | null {
    for (let i = this._closed.length - 1; i >= 0; i--) if (this._closed[i].key === key) return this._closed[i];
    return null;
  }

  findArc(key: string): Arc | null { return this._open.get(key) || null; }

  // OPEN → IDEMPOTENT on key (re-open is a no-op, returning the live arc). A fresh open stamps a
  // parentArcId back-link to the most recent closed arc on the same key (display-only). Bounded:
  // enforceMaxOpen evicts an INCUMBENT (never the newborn) via close.
  openArc(opts: ArcOpenOpts): Arc | null {
    try {
      if (!opts || !opts.key || !opts.kind) return null;
      const live = this._open.get(opts.key);
      if (live) return live;
      const now = this._now();
      // LAPSED-REOPEN REFRACTORY: a tale that just PETERED OUT (closed 'lapsed') must rest before
      // the same key re-opens — without it, every re-derive of the same grudge re-files the same
      // vendetta the moment the goal lapses (the 50-belief trace: 228 of 366 closed arcs were
      // vendetta:lapsed — grudge churn, not stories). A FULFILLED/celebrated close is untouched:
      // re-ignition after a real ending is the designed parentArcId feature.
      const lap = this._lapsedAt.get(opts.key);
      if (lap != null && now - lap < (ARCS.lapsedReopenSecs || 240)) return null;
      const prior = this._lastClosed(opts.key);
      const arc: Arc = {
        arcId: ++this._seq,
        kind: opts.kind,
        key: opts.key,
        principals: Array.isArray(opts.principals) ? opts.principals.slice(0, 4) : [],
        beats: [],
        rounds: 0,
        openedAt: now,
        closedAt: null,
        outcome: null,
        expiry: now + (opts.expiry ?? ARCS.openTtl),
        meta: { ...(opts.meta || {}), parentArcId: prior ? prior.arcId : undefined },
      };
      this._open.set(opts.key, arc);
      this._enforceMaxOpen(arc);
      if (opts.text) this.appendBeat(opts.key, 'open', opts.text);
      return arc;
    } catch { return null; }
  }

  // LAZY-OPEN escalation round — open the arc ON its FIRST real round, never eagerly. This is the
  // muster-flicker fix (docs/architecture/12 §3.5): a warband arc opened at muster and closed before
  // ANY follower rode / any march committed is NOISE, not a tale — so we DON'T open until the first
  // escalation. openArc is idempotent on key, so re-rounds just append. Returns the (now-open) arc.
  appendRound(opts: ArcOpenOpts, text?: string): Arc | null {
    try {
      if (!opts || !opts.key) return null;
      if (!this._open.get(opts.key)) this.openArc(opts);   // idempotent open on the first round only
      return this.appendBeat(opts.key, 'round', text);
    } catch { return null; }
  }

  // APPEND an escalation chapter. A `round` re-ARMS expiry (a slow feud must outlive an open-and-shut
  // one) and files a THROTTLED chronicle note. Bounded trail.
  appendBeat(key: string, tag: string, text?: string): Arc | null {
    try {
      const arc = this._open.get(key);
      if (!arc || arc.closedAt != null) return null;
      const now = this._now();
      arc.beats.push({ t: now, tag, text: text || '' });
      if (tag === 'round') {
        arc.rounds += 1;
        arc.expiry = now + ARCS.openTtl;                                  // re-arm the TTL on every fresh blow
        if (text && now - (arc._lastNote ?? -Infinity) >= ARCS.roundNoteGap) { arc._lastNote = now; this._note(arc, text); }
      } else if ((tag === 'open' || tag === 'close') && text) {
        this._note(arc, text);
      }
      while (arc.beats.length > ARCS.maxBeats) arc.beats.shift();
      return arc;
    } catch { return null; }
  }

  // TOUCH — re-arm a living tale's TTL WITHOUT filing a beat (the fellowship-endures fix): a
  // stable group that simply stopped recruiting is NOT a petered-out story, so its keeper touches
  // the arc while the principals still stand and only real dissolution ('disbanded') or genuine
  // quiet after they're gone files an ending. No beat, no note, no round — just the expiry.
  touchArc(key: string): Arc | null {
    try {
      const arc = this._open.get(key);
      if (!arc || arc.closedAt != null) return null;
      arc.expiry = this._now() + ARCS.openTtl;
      return arc;
    } catch { return null; }
  }

  // CLOSE — UNCONDITIONAL (review 1): always closes + moves to the _closed ring, so eviction/sweep
  // can never be declined. Caller-specific guards (mutual-feud) live at the call site, not here.
  closeArc(key: string, outcome: string, text?: string): Arc | null {
    try {
      const arc = this._open.get(key);
      if (!arc) return null;
      const now = this._now();
      arc.closedAt = now;
      arc.outcome = outcome;
      if (outcome === 'lapsed') {
        this._lapsedAt.set(key, now);
        // bounded: drop entries past the refractory (cheap full prune only when the map grows)
        if (this._lapsedAt.size > 256)
          for (const [k, t] of this._lapsedAt) if (now - t >= (ARCS.lapsedReopenSecs || 240)) this._lapsedAt.delete(k);
        // A NEVER-ESCALATED TALE FILES NO TALE (the warband-muster precedent): a lapsed arc with
        // ZERO rounds was a derive-flicker — a grudge that never came to a single blow — and
        // retaining it floods the ring/Gazette with non-stories (the 50-belief trace: most of the
        // vendetta:lapsed monoculture was 0-round). It still armed the refractory above, so the
        // same grudge cannot immediately re-file; it simply leaves no history.
        if (arc.rounds === 0) { this._open.delete(key); return arc; }
      }
      if (text) { arc.beats.push({ t: now, tag: 'close', text }); this._note(arc, text); }
      this._open.delete(key);
      arc.sig = `arc:${arc.kind}:${arc.key}:${Math.floor(now)}`;          // Gazette dedup sig (matches _recordSaga's)
      this._closed.push(arc);
      while (this._closed.length > ARCS.maxClosed) this._closed.shift();
      return arc;
    } catch { return null; }
  }

  // bounded _open: evict the WEAKEST INCUMBENT (fewest-rounds, then nearest-expiry) via close —
  // never the just-opened arc (a new story always gets a seat), never a silent drop (review 2/4).
  _enforceMaxOpen(justOpened?: Arc, capOverride?: number): void {
    try {
      const cap = capOverride ?? (ARCS.maxOpen || 64);
      while (this._open.size > cap) {
        let victim: Arc | null = null;
        for (const arc of this._open.values()) {
          if (justOpened && arc === justOpened) continue;
          if (!victim || arc.rounds < victim.rounds || (arc.rounds === victim.rounds && arc.expiry < victim.expiry)) victim = arc;
        }
        if (!victim) break;                                              // only the newborn left — leave it (cap+1, transient)
        this.closeArc(victim.key, 'crowded_out');
      }
    } catch { /* never throw */ }
  }

  // fresh closed arcs (within maxAge sim-seconds), newest-first — what the Gazette reads.
  recentClosed(maxAgeSecs: number = ARCS.gazetteFreshSecs): Arc[] {
    const now = this._now();
    const out: Arc[] = [];
    for (let i = this._closed.length - 1; i >= 0; i--) {
      const a = this._closed[i];
      if (now - (a.closedAt || 0) > maxAgeSecs) break;                   // _closed is push-ordered ⇒ older below
      out.push(a);
    }
    return out;
  }

  // SWEEP — the self-throttled world pass (sim.sagas.sweep). Lapses every open arc past its expiry
  // (graceful dissolve + freeze backstop). UNCONDITIONAL close, so a stale-but-live goal can't block it.
  sweep(now: number): void {
    try {
      if (now - (this._lastSweep ?? -Infinity) < (ARCS.sweepSecs || 0)) return;
      this._lastSweep = now;
      let expired: string[] | null = null;
      for (const [key, arc] of this._open) { if (now >= arc.expiry) (expired || (expired = [])).push(key); }
      if (expired) for (const key of expired) this.closeArc(key, 'lapsed');
    } catch { /* never throw on the tick */ }
  }

  _lastSweep?: number;
}
