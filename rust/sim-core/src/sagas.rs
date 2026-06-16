//! The emergent-SAGA registry (the doc-12 `SagaStore` / doc-19 arc registry, ported to its spirit).
//!
//! OBSERVER LAYER (the epistemic split, docs/architecture/02): a saga is world HISTORY — it reads
//! ground truth across the roster (who struck whom, who slew whom, who freed whom) to NARRATE the
//! emergent stories the agents are living. It NEVER drives a decision; no agent reads it. It is folded
//! in the SERIAL merge (`drain_intents`) right where the combat/deed events are already visited in
//! fixed id order, so it is trivially deterministic (M=1 ≡ M=N). The director's arc STEPPERS (a
//! separate, later piece) advance open arcs; this is just the bounded registry they hang on.

/// The kind of emergent saga an arc tracks.
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SagaKind {
    Vendetta = 0,   // `a` wronged `b`; escalates with each blow; closes when one slays the other
    Rescue = 1,     // `a` freed captive `b`
    Romance = 2,    // `a` and `b` hold each other dear — a lasting bond (endures; canonical a<b)
    TyrantFall = 3, // `a` is a resented tyrant of means — the arc toward their fall
}

/// One emergent saga (a multi-beat story between two souls).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Saga {
    pub kind: u8,    // SagaKind
    pub status: u8,  // 0 open, 1 closed (resolved)
    pub beats: u16,  // escalation count (how many times it has been touched)
    pub a: u32,      // the instigator / protagonist
    pub b: u32,      // the target / antagonist
    pub opened: u32, // tick opened
    pub last: u32,   // tick last touched (for the sweep)
}

/// How many ticks a CLOSED saga lingers in the registry before the sweep drops it (so `recent_closed`
/// readers — the chronicle/gazette — can still see a just-resolved arc). ~a few in-game minutes.
const CLOSED_TTL: u32 = 1_200;
/// Bounded registry: the oldest-touched arc is evicted when full (no unbounded growth — the freeze rule).
pub const SAGA_CAP: usize = 256;

/// The bounded saga registry (a world-level observer column).
#[derive(Clone, Default)]
pub struct SagaStore {
    pub sagas: Vec<Saga>,
}

impl SagaStore {
    /// Find an OPEN arc of `kind` between `a` and `b` (direction-sensitive — a vendetta `a→b` is a
    /// distinct story from `b→a`). Returns its index.
    fn find_open(&self, kind: SagaKind, a: u32, b: u32) -> Option<usize> {
        self.sagas.iter().position(|s| {
            s.status == 0 && s.kind == kind as u8 && s.a == a && s.b == b
        })
    }

    /// OPEN a fresh arc, or TOUCH (escalate a beat on) the existing open one between `a` and `b`. The
    /// flagship lifecycle: a first wrong opens the vendetta; each later blow escalates it.
    pub fn open_or_touch(&mut self, kind: SagaKind, a: u32, b: u32, now: u32) {
        if let Some(ix) = self.find_open(kind, a, b) {
            self.sagas[ix].beats = self.sagas[ix].beats.saturating_add(1);
            self.sagas[ix].last = now;
            return;
        }
        let saga = Saga { kind: kind as u8, status: 0, beats: 1, a, b, opened: now, last: now };
        if self.sagas.len() < SAGA_CAP {
            self.sagas.push(saga);
        } else if let Some(ix) = self.oldest_touched() {
            self.sagas[ix] = saga; // evict the stalest arc
        }
    }

    /// CLOSE the open arc of `kind` between `a` and `b` (it resolved). No-op if none is open.
    pub fn close(&mut self, kind: SagaKind, a: u32, b: u32, now: u32) {
        if let Some(ix) = self.find_open(kind, a, b) {
            self.sagas[ix].status = 1;
            self.sagas[ix].last = now;
        }
    }

    /// CLOSE every open arc that `subject` is a party to (on their death): a tyrant's FALL resolves the
    /// tyrant-fall arc, a lover's death ends the romance, etc. No-op for arcs they aren't in.
    pub fn close_subject(&mut self, subject: u32, now: u32) {
        for s in self.sagas.iter_mut() {
            if s.status == 0 && (s.a == subject || s.b == subject) {
                s.status = 1;
                s.last = now;
            }
        }
    }

    /// Record a one-beat closed arc (a self-contained event like a rescue: opened + resolved at once).
    pub fn record(&mut self, kind: SagaKind, a: u32, b: u32, now: u32) {
        let saga = Saga { kind: kind as u8, status: 1, beats: 1, a, b, opened: now, last: now };
        if self.sagas.len() < SAGA_CAP {
            self.sagas.push(saga);
        } else if let Some(ix) = self.oldest_touched() {
            self.sagas[ix] = saga;
        }
    }

    /// The stalest arc (lowest `last`) — the eviction / sweep target. Deterministic tie-break by index.
    fn oldest_touched(&self) -> Option<usize> {
        self.sagas
            .iter()
            .enumerate()
            .min_by_key(|(_, s)| s.last)
            .map(|(ix, _)| ix)
    }

    /// Drop CLOSED arcs older than `CLOSED_TTL` (the sweep — runs each tick in the society phase). Open
    /// arcs persist until resolved. Retains in id order ⇒ deterministic.
    pub fn sweep(&mut self, now: u32) {
        self.sagas
            .retain(|s| s.status == 0 || now.saturating_sub(s.last) < CLOSED_TTL);
    }

    /// Count of currently-open arcs of a kind (observer telemetry — e.g. how many vendettas burn now).
    pub fn open_count(&self, kind: SagaKind) -> usize {
        self.sagas.iter().filter(|s| s.status == 0 && s.kind == kind as u8).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendetta_opens_escalates_and_closes() {
        let mut store = SagaStore::default();
        store.open_or_touch(SagaKind::Vendetta, 1, 2, 10); // first wrong
        assert_eq!(store.open_count(SagaKind::Vendetta), 1);
        store.open_or_touch(SagaKind::Vendetta, 1, 2, 20); // a later blow escalates
        assert_eq!(store.sagas[0].beats, 2, "a repeat escalates a beat, not a new arc");
        assert_eq!(store.sagas.len(), 1, "still one arc");
        store.close(SagaKind::Vendetta, 1, 2, 30); // resolved
        assert_eq!(store.open_count(SagaKind::Vendetta), 0, "the vendetta closed");
    }

    #[test]
    fn direction_matters() {
        let mut store = SagaStore::default();
        store.open_or_touch(SagaKind::Vendetta, 1, 2, 10);
        store.open_or_touch(SagaKind::Vendetta, 2, 1, 10); // the reverse is a DISTINCT story
        assert_eq!(store.open_count(SagaKind::Vendetta), 2);
    }

    #[test]
    fn sweep_drops_stale_closed_arcs() {
        let mut store = SagaStore::default();
        store.record(SagaKind::Rescue, 5, 6, 100); // a closed one-beat arc
        store.open_or_touch(SagaKind::Vendetta, 1, 2, 100); // an open one
        store.sweep(100 + CLOSED_TTL + 1);
        assert!(store.sagas.iter().all(|s| s.status == 0), "stale CLOSED arcs swept");
        assert_eq!(store.open_count(SagaKind::Vendetta), 1, "open arcs survive the sweep");
    }
}
