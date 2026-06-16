//! Uniform spatial grid over the `Perceivable` surface (docs/architecture/22 §3.1, §4 rule 4).
//!
//! Each tick we counting-sort the per-agent `Perceivable` rows into CELL order (a deterministic,
//! O(n) bucket sort) so a 3×3 neighbour query reads CONTIGUOUS spans of one cache-resident array.
//! Cell size = `MAX_VISION`, so the 3×3 block is a guaranteed superset of anything in range; the
//! caller does the exact distance reject. Bucket order is deterministic (counting sort preserves
//! the input's id order within a cell) — required for M=1 ≡ M=8 and the cap-25 eviction.

use crate::components::{Perceivable, MAX_VISION};

// x,z span the grid covers; must span the whole REGION (the worldgen's source of truth) so no
// settlement's agents fall outside it. Out-of-range positions clamp into the edge cells.
const ARENA: f32 = crate::world::GRID_SPAN;

pub struct Grid {
    inv: f32,
    cols: usize, // cells per axis
    /// prefix-sum cell starts, len = cols*cols + 1.
    starts: Vec<u32>,
    /// `Perceivable` rows reordered into cell-major order (the spatially-sorted surface).
    items: Vec<Perceivable>,
    counts: Vec<u32>, // scratch reused across rebuilds (counting-sort histogram)
}

impl Grid {
    pub fn new() -> Self {
        let cell = MAX_VISION;
        let cols = (ARENA / cell).ceil() as usize + 1;
        Grid {
            inv: 1.0 / cell,
            cols,
            starts: vec![0; cols * cols + 1],
            items: Vec::new(),
            counts: vec![0; cols * cols],
        }
    }

    #[inline]
    fn cell_xz(&self, x: f32, z: f32) -> (usize, usize) {
        let half = ARENA * 0.5;
        let cx = (((x + half) * self.inv) as i64).clamp(0, self.cols as i64 - 1) as usize;
        let cz = (((z + half) * self.inv) as i64).clamp(0, self.cols as i64 - 1) as usize;
        (cx, cz)
    }

    #[inline]
    fn cell_index(&self, cx: usize, cz: usize) -> usize {
        cx * self.cols + cz
    }

    /// Counting-sort `src` (in stable id order) into cell-major order. O(n). Deterministic.
    pub fn rebuild(&mut self, src: &[Perceivable]) {
        let ncells = self.cols * self.cols;
        for c in self.counts.iter_mut() {
            *c = 0;
        }
        // 1. histogram
        for p in src {
            let (cx, cz) = self.cell_xz(p.x, p.z);
            let ci = self.cell_index(cx, cz);
            self.counts[ci] += 1;
        }
        // 2. prefix sum -> starts
        let mut acc = 0u32;
        for c in 0..ncells {
            self.starts[c] = acc;
            acc += self.counts[c];
        }
        self.starts[ncells] = acc;
        // 3. scatter (reuse counts as the per-cell write cursor)
        self.items.clear();
        self.items.resize(src.len(), src.get(0).copied().unwrap_or(Perceivable {
            id: 0, x: 0.0, z: 0.0, faction: 0, flags: 0, level: 0, _pad: 0,
            notoriety: 0, threat: 0, wealth_cue: 0, house: 0,
        }));
        let mut cursor = self.starts.clone();
        for p in src {
            let (cx, cz) = self.cell_xz(p.x, p.z);
            let ci = self.cell_index(cx, cz);
            let slot = cursor[ci] as usize;
            self.items[slot] = *p;
            cursor[ci] += 1;
        }
    }

    /// Invoke `f` on every item in the 3×3 cell block around (x,z) — a SUPERSET of items within
    /// `MAX_VISION`. Allocation-free; the caller applies the exact distance reject.
    #[inline]
    pub fn for_near<F: FnMut(&Perceivable)>(&self, x: f32, z: f32, mut f: F) {
        let (cx, cz) = self.cell_xz(x, z);
        let cols = self.cols as i64;
        for dx in -1..=1i64 {
            let nx = cx as i64 + dx;
            if nx < 0 || nx >= cols {
                continue;
            }
            for dz in -1..=1i64 {
                let nz = cz as i64 + dz;
                if nz < 0 || nz >= cols {
                    continue;
                }
                let ci = (nx as usize) * self.cols + (nz as usize);
                let s = self.starts[ci] as usize;
                let e = self.starts[ci + 1] as usize;
                for it in &self.items[s..e] {
                    f(it);
                }
            }
        }
    }
}

impl Default for Grid {
    fn default() -> Self {
        Grid::new()
    }
}
