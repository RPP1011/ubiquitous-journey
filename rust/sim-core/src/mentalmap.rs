//! The MentalMap (the Rust port of `js/sim/mentalmap.ts`) — a shared, read-only, STATIC registry of
//! places queried by AFFORDANCE (`affords('exit'|'conceal'|'safe'|'crowd'|'resource'|'comfort')`),
//! never by scanning the roster. Built once from the static geography at worldgen; the cognition layer
//! (reasoning schemas, steer-fills, comfort/refuge selection, `inferDestination`) reasons over it.
//!
//! Read-only after build ⇒ identical across runs and thread counts by construction, so it carries no
//! per-agent state and is not part of the determinism hash (nothing mutates it).

/// Affordance bits — what a place is good FOR (a place can afford several). Mirrors the TS affordance
/// tags the schema vocabulary's `nearKnown`/`fleeTo`/`hide`/`avoid` query.
pub const AFF_EXIT: u16 = 1 << 0; // a way out of town (gate / arena edge)
pub const AFF_CONCEAL: u16 = 1 << 1; // somewhere to hide
pub const AFF_SAFE: u16 = 1 << 2; // a refuge (hearth / guarded core)
pub const AFF_CROWD: u16 = 1 << 3; // a gathering place (market)
pub const AFF_RESOURCE: u16 = 1 << 4; // a work/resource node (field/mine/forest)
pub const AFF_COMFORT: u16 = 1 << 5; // a comforting place (home/tavern/shrine)

/// One static location (an immutable snapshot — pos + what it affords + which town owns it).
#[derive(Clone, Copy, Debug)]
pub struct Place {
    pub kind: u8,
    pub x: f32,
    pub z: f32,
    pub affords: u16,
    pub town: u16,
}
impl Place {
    /// OR-semantics: does this place afford ANY of the queried affordance bits?
    #[inline]
    pub fn affords(&self, mask: u16) -> bool {
        self.affords & mask != 0
    }
}

/// The static places registry.
#[derive(Clone, Debug, Default)]
pub struct MentalMap {
    pub places: Vec<Place>,
}

impl MentalMap {
    /// Build once from the static geography: the market (a crowd + a measure of safety), each work
    /// site (a resource node), and the town centre (a comforting, safe hearth). The arena rim is an
    /// exit/conceal escape. Extended as more POI kinds land (forests/mines/gates/shrines).
    pub fn build(market: [f32; 2], work_sites: &[[f32; 2]], town_center: [f32; 2], arena: f32) -> MentalMap {
        let mut places = Vec::with_capacity(work_sites.len() + 6);
        places.push(Place { kind: 0, x: market[0], z: market[1], affords: AFF_CROWD | AFF_SAFE, town: 0 });
        places.push(Place {
            kind: 1,
            x: town_center[0],
            z: town_center[1],
            affords: AFF_COMFORT | AFF_SAFE,
            town: 0,
        });
        for s in work_sites {
            places.push(Place { kind: 2, x: s[0], z: s[1], affords: AFF_RESOURCE, town: 0 });
        }
        // four cardinal arena-rim escapes (exit + concealment beyond the town band).
        for (dx, dz) in [(1.0f32, 0.0f32), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
            places.push(Place {
                kind: 3,
                x: dx * arena * 0.95,
                z: dz * arena * 0.95,
                affords: AFF_EXIT | AFF_CONCEAL,
                town: 0,
            });
        }
        MentalMap { places }
    }

    /// The nearest place affording ANY of `mask` within `range` of `from` (deterministic: closest, then
    /// lowest index). `None` when no known place qualifies.
    pub fn nearest(&self, mask: u16, from: [f32; 2], range: f32) -> Option<&Place> {
        let r2 = range * range;
        let mut best: Option<(usize, f32)> = None;
        for (i, p) in self.places.iter().enumerate() {
            if !p.affords(mask) {
                continue;
            }
            let dx = p.x - from[0];
            let dz = p.z - from[1];
            let d2 = dx * dx + dz * dz;
            if d2 > r2 {
                continue;
            }
            match best {
                Some((_, bd)) if d2 >= bd => {}
                _ => best = Some((i, d2)),
            }
        }
        best.map(|(i, _)| &self.places[i])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_by_affordance() {
        let m = MentalMap::build([10.0, 0.0], &[[0.0, 0.0], [50.0, 50.0]], [0.0, 0.0], 590.0);
        // a CROWD query near origin finds the market at (10,0).
        let c = m.nearest(AFF_CROWD, [0.0, 0.0], 1000.0).expect("a crowd place");
        assert!((c.x - 10.0).abs() < 1e-3, "market is the crowd place");
        // a RESOURCE query finds the nearer work site.
        let r = m.nearest(AFF_RESOURCE, [1.0, 1.0], 1000.0).expect("a resource place");
        assert!((r.x).abs() < 1e-3 && (r.z).abs() < 1e-3, "nearest work site at origin");
        // an out-of-range query finds nothing.
        assert!(m.nearest(AFF_EXIT, [0.0, 0.0], 1.0).is_none(), "no exit within 1m");
    }

    #[test]
    fn affordance_is_or_semantics() {
        let p = Place { kind: 0, x: 0.0, z: 0.0, affords: AFF_CROWD | AFF_SAFE, town: 0 };
        assert!(p.affords(AFF_SAFE));
        assert!(p.affords(AFF_CROWD | AFF_EXIT), "OR: matches if ANY bit is afforded");
        assert!(!p.affords(AFF_EXIT | AFF_RESOURCE));
    }
}
