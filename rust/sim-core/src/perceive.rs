//! THE SPIKE (docs/architecture/22 §4, §5): the parallel `perceive`. Each agent reads the frozen
//! `prev` `Perceivable` surface (shared `&`, via the grid's 3×3 neighbour query) and writes ONLY its
//! own belief table (`&mut` via `par_iter_mut`). No cross-entity writes ⇒ no races ⇒ the result is
//! bit-identical regardless of `rayon`'s split (M=1 ≡ M=8). This is the `PerceptionView` of §5: it
//! reads truth columns and writes own beliefs — the one sanctioned truth→belief bridge.
//!
//! Determinism within an agent: candidates are collected from the grid (superset), the exact
//! distance reject is applied, and the cap-`BELIEF_CAP` table is the `BELIEF_CAP` NEAREST, ordered by
//! (distance², id) — a total order, so eviction never depends on neighbour-iteration order.

use std::cell::RefCell;
use std::cmp::Ordering;

use rayon::prelude::*;

use crate::components::{PersonBelief, BELIEF_CAP, VISION};
use crate::world::World;

#[derive(Clone, Copy)]
struct Cand {
    id: u32,
    x: f32,
    z: f32,
    d2: f32,
    faction: u8,
    level: u8,
    notoriety: u16,
    threat: u16,
}

thread_local! {
    // per-thread scratch so the parallel closure allocates nothing in steady state. Cleared each
    // call; never shared across agents ⇒ no effect on determinism.
    static CAND: RefCell<Vec<Cand>> = RefCell::new(Vec::with_capacity(512));
}

pub fn perceive(world: &mut World) {
    let tick = world.tick;
    // disjoint borrows: shared reads of the truth columns + grid, exclusive write of beliefs.
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

        CAND.with(|cc| {
            let cand = &mut *cc.borrow_mut();
            cand.clear();

            // gather the 3×3 superset, apply the EXACT in-range reject.
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
                cand.push(Cand {
                    id: p.id,
                    x: p.x,
                    z: p.z,
                    d2,
                    faction: p.faction,
                    level: p.level,
                    notoriety: p.notoriety,
                    threat: p.threat,
                });
            });

            // total order (distance², then id) ⇒ deterministic "keep the nearest BELIEF_CAP".
            cand.sort_unstable_by(|a, b| {
                a.d2
                    .partial_cmp(&b.d2)
                    .unwrap_or(Ordering::Equal)
                    .then(a.id.cmp(&b.id))
            });

            let k = cand.len().min(BELIEF_CAP);
            bt.len = k as u8;
            for j in 0..k {
                let c = cand[j];
                let dist = c.d2.sqrt();
                let conf = (1.0 - (dist / VISION)).clamp(0.0, 1.0);
                bt.subjects[j] = c.id;
                bt.bodies[j] = PersonBelief {
                    subject: c.id,
                    last_x: c.x,
                    last_z: c.z,
                    confidence: (conf * 65535.0) as u16,
                    faction: c.faction,
                    level: c.level,
                    notoriety: c.notoriety,
                    threat: c.threat,
                    last_tick: tick,
                    flags: 0,
                    _pad: [0; 3],
                };
            }
        });
    });
}

/// A brute-force O(n²) reference set: the ids within VISION of agent `i` (for the correctness gate).
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
