//! Golden hash of the full world state (docs/architecture/22 §9): the M-invariance canary. FNV-1a
//! over the deterministic columns (positions, bit-cast) + every belief table, in stable id order.
//! Identical hash across runs AND across `rayon` thread counts is the hard determinism gate.

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
        h = fold(h, &w.pos[i][0].to_bits().to_le_bytes());
        h = fold(h, &w.pos[i][1].to_bits().to_le_bytes());
        let bt = &w.beliefs[i];
        h = fold(h, &[bt.len]);
        for j in 0..bt.len as usize {
            let b = &bt.bodies[j];
            h = fold(h, &b.subject.to_le_bytes());
            h = fold(h, &b.last_x.to_bits().to_le_bytes());
            h = fold(h, &b.last_z.to_bits().to_le_bytes());
            h = fold(h, &b.confidence.to_le_bytes());
            h = fold(h, &b.notoriety.to_le_bytes());
            h = fold(h, &b.threat.to_le_bytes());
            h = fold(h, &[b.faction, b.level, b.flags]);
            h = fold(h, &b.last_tick.to_le_bytes());
        }
    }
    h
}
