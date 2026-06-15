//! Golden hash of the full mutable world state (docs/architecture/22 §9) — the M-invariance canary.
//! FNV-1a over every column a system mutates, in stable id order. Identical across runs AND across
//! `rayon` thread counts is the hard determinism gate; it breaks the instant any system introduces
//! non-determinism (float reduce, HashMap order, slot-indexed RNG, a cross-agent race).

use crate::world::World;

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

#[inline]
fn fold(h: u64, bytes: &[u8]) -> u64 {
    let mut h = h;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

pub fn world_hash(w: &World) -> u64 {
    let mut h = FNV_OFFSET;
    h = fold(h, &(w.n as u64).to_le_bytes());
    h = fold(h, &w.tick.to_le_bytes());
    for i in 0..w.n {
        // body + needs + economy + combat + goal
        h = fold(h, &w.pos[i][0].to_bits().to_le_bytes());
        h = fold(h, &w.pos[i][1].to_bits().to_le_bytes());
        h = fold(h, &[w.alive[i] as u8]);
        let nd = &w.needs[i];
        for v in [nd.hunger, nd.energy, nd.social, nd.comfort, nd.novelty, nd.starve] {
            h = fold(h, &v.to_bits().to_le_bytes());
        }
        let e = &w.econ[i];
        h = fold(h, &e.gold.to_le_bytes());
        for q in e.inventory {
            h = fold(h, &q.to_le_bytes());
        }
        h = fold(h, &w.combat[i].health.to_bits().to_le_bytes());
        h = fold(h, &[w.goal[i].kind() as u8]);
        // Wave-3 society columns
        h = fold(h, &[w.faith[i]]);
        h = fold(h, &w.band_leader[i].to_le_bytes());
        h = fold(h, &w.house[i].to_le_bytes());
        // progression (behaviour profile + emergent classes/levels) — the M-invariance gate must
        // cover this column so any non-determinism the progression fold/match introduces is caught.
        let pr = &w.progression[i];
        for v in pr.behavior_profile {
            h = fold(h, &v.to_bits().to_le_bytes());
        }
        h = fold(h, &pr.total_level.to_le_bytes());
        h = fold(h, &pr.xp.to_le_bytes());
        h = fold(h, &[pr.n_classes]);
        h = fold(h, &pr.classes);
        // belief table (the dominant state)
        let bt = &w.beliefs[i];
        h = fold(h, &[bt.len]);
        for j in 0..bt.len as usize {
            let b = &bt.bodies[j];
            h = fold(h, &b.subject.to_le_bytes());
            h = fold(h, &b.last_x.to_bits().to_le_bytes());
            h = fold(h, &b.last_z.to_bits().to_le_bytes());
            h = fold(h, &b.confidence.to_le_bytes());
            h = fold(h, &b.standing.to_le_bytes());
            h = fold(h, &b.notoriety.to_le_bytes());
            h = fold(h, &b.threat.to_le_bytes());
            h = fold(h, &[b.faction, b.level, b.flags]);
            h = fold(h, &b.last_tick.to_le_bytes());
        }
    }
    // Wave-3 world-level observer state: the chronicle feed + the quest board.
    h = fold(h, &(w.chronicle.len() as u64).to_le_bytes());
    for bt in &w.chronicle {
        h = fold(h, &bt.t.to_le_bytes());
        h = fold(h, &[bt.kind]);
        h = fold(h, &bt.subject.to_le_bytes());
        h = fold(h, &bt.magnitude.to_le_bytes());
    }
    h = fold(h, &(w.quests.len() as u64).to_le_bytes());
    for q in &w.quests {
        h = fold(h, &[q.kind, q.done as u8]);
        h = fold(h, &q.target.to_le_bytes());
        h = fold(h, &q.count.to_le_bytes());
        h = fold(h, &q.got.to_le_bytes());
    }
    h
}
