//! The parallel `perceive` (docs/architecture/22 §4, §5 — the `PerceptionView`). Each agent reads
//! the frozen `Perceivable` surface (shared, via the grid's 3×3 query) and writes ONLY its own
//! belief table (`par_iter_mut`). No cross-entity writes ⇒ no races ⇒ bit-identical across `rayon`
//! core counts (M=1 ≡ M=8).
//!
//! UPSERT + decay (not clear-and-rebuild): beliefs PERSIST across ticks so gossip/relationships can
//! accrue on them. Un-refreshed beliefs fade; the cap-`BELIEF_CAP` eviction is a deterministic
//! streaming top-K by (confidence, id) — independent of neighbour-iteration order.

use rayon::prelude::*;

use crate::components::{BeliefTable, Perceivable, PersonBelief, BELIEF_CAP, VISION};
use crate::world::World;

const DECAY: f32 = 0.97; // per-tick confidence fade for un-refreshed beliefs.

pub fn perceive(world: &mut World) {
    let tick = world.tick;
    let World {
        ref pos,
        ref grid,
        ref mut beliefs,
        ..
    } = *world;

    let r2 = VISION * VISION;

    beliefs.par_iter_mut().enumerate().for_each(|(i, bt)| {
        let my_id = i as u32;
        let x = pos[i][0];
        let z = pos[i][1];

        // 1. fade everything (the unseen forget); refresh below overwrites in-range ones.
        for b in 0..bt.len as usize {
            bt.bodies[b].confidence = (bt.bodies[b].confidence as f32 * DECAY) as u16;
        }
        // 2. upsert each in-range neighbour (exact reject on the grid superset).
        grid.for_near(x, z, |p| {
            if p.id == my_id {
                return;
            }
            let dx = x - p.x;
            let dz = z - p.z;
            let d2 = dx * dx + dz * dz;
            if d2 > r2 {
                return;
            }
            let conf = ((1.0 - (d2.sqrt() / VISION)).clamp(0.0, 1.0) * 65535.0) as u16;
            upsert(bt, p, conf, tick);
        });
    });
}

/// Insert-or-update a belief about `p`. Observed fields refresh; `standing`/`flags` (relationship,
/// set by gossip/social) are PRESERVED. When full, a streaming replace-the-weakest by (conf, id).
#[inline]
fn upsert(bt: &mut BeliefTable, p: &Perceivable, conf: u16, tick: u32) {
    if let Some(idx) = bt.find(p.id) {
        let b = &mut bt.bodies[idx];
        b.last_x = p.x;
        b.last_z = p.z;
        b.confidence = conf;
        b.faction = p.faction;
        b.level = p.level;
        b.notoriety = p.notoriety;
        b.threat = p.threat;
        b.last_tick = tick;
        return;
    }
    let fresh = PersonBelief {
        subject: p.id,
        last_x: p.x,
        last_z: p.z,
        confidence: conf,
        faction: p.faction,
        level: p.level,
        notoriety: p.notoriety,
        threat: p.threat,
        last_tick: tick,
        standing: 0,
        flags: 0,
        _pad: 0,
    };
    let len = bt.len as usize;
    if len < BELIEF_CAP {
        bt.subjects[len] = p.id;
        bt.bodies[len] = fresh;
        bt.len += 1;
        return;
    }
    // full: find the weakest (lowest conf, ties -> highest id) and replace iff the newcomer beats it.
    let mut worst = 0usize;
    for k in 1..BELIEF_CAP {
        let bk = &bt.bodies[k];
        let bw = &bt.bodies[worst];
        if bk.confidence < bw.confidence
            || (bk.confidence == bw.confidence && bk.subject > bw.subject)
        {
            worst = k;
        }
    }
    let bw = &bt.bodies[worst];
    if conf > bw.confidence || (conf == bw.confidence && p.id < bw.subject) {
        bt.subjects[worst] = p.id;
        bt.bodies[worst] = fresh;
    }
}

/// Brute-force O(n²) reference: the ids within VISION of agent `i` (the grid-superset correctness gate).
pub fn in_range_reference(world: &World, i: usize) -> Vec<u32> {
    let r2 = VISION * VISION;
    let (x, z) = (world.pos[i][0], world.pos[i][1]);
    let mut out = Vec::new();
    for j in 0..world.n {
        if j == i {
            continue;
        }
        let dx = x - world.pos[j][0];
        let dz = z - world.pos[j][1];
        if dx * dx + dz * dz <= r2 {
            out.push(j as u32);
        }
    }
    out.sort_unstable();
    out
}
