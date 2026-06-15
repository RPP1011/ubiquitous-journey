//! Per-entity deterministic RNG (docs/architecture/22 §4). Each entity owns its own stream,
//! seeded off a STABLE spawn id (never a recycled slot), so parallel draws are independent and
//! reproducible regardless of how `rayon` splits the work — the foundation of M=1 ≡ M=8.
//!
//! splitmix64: tiny (one u64 of state), fast, well-distributed, and trivially copyable so it can
//! live inline in a component column.

#[derive(Clone, Copy, Debug)]
pub struct DeterministicRng {
    state: u64,
}

impl DeterministicRng {
    /// Seed a fresh stream. `world_seed` mixes the global run seed; `id` is the stable entity id.
    #[inline]
    pub fn seed(world_seed: u64, id: u64) -> Self {
        // mix the two so distinct (seed,id) pairs give well-separated streams
        let s = world_seed
            .wrapping_mul(0x9E3779B97F4A7C15)
            .wrapping_add(id.wrapping_mul(0xD1B54A32D192ED03))
            .wrapping_add(0x2545F4914F6CDD1D);
        DeterministicRng { state: s }
    }

    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    /// A float in [0, 1) with 24 bits of mantissa — deterministic across platforms (no transcendental).
    #[inline]
    pub fn next_f32(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32) / ((1u32 << 24) as f32)
    }

    /// A float in [-1, 1).
    #[inline]
    pub fn next_signed(&mut self) -> f32 {
        self.next_f32() * 2.0 - 1.0
    }
}
