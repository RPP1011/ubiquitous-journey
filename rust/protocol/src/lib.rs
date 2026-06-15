//! protocol — the dependency-free wire format for the backend→frontend snapshot (docs/architecture/22
//! §6 + doc 20, the render-only frontend split). The `server` serializes a `WorldSnapshot` of the
//! authoritative `sim-core` world each tick (the double-buffer's render-facing copy); the Three.js
//! frontend deserializes the SAME little-endian layout via a `DataView`. Hand-rolled framing (no serde,
//! no codegen) keeps this buildable offline and the JS reader trivial.
//!
//! IMPORTANT (the epistemic-split boundary, docs/architecture/02): a snapshot is what the renderer may
//! SEE — positions, factions, the current goal kind, health. It deliberately carries NO belief tables /
//! cognition state, so the wire format can never leak ground-truth an NPC shouldn't act on. The
//! inspector "read an NPC's mind" view is a SEPARATE, explicitly-requested query, not part of the frame.

/// Frame magic ("SIM1") — guards against desync / wrong-version frames.
pub const MAGIC: u32 = 0x5349_4D31;

/// Bytes per serialized `AgentView` (id+x+z+health = 4×4, then 4 packed u8s).
pub const AGENT_BYTES: usize = 4 + 4 + 4 + 4 + 4;
/// Bytes of the frame header (magic + tick + agent count).
pub const HEADER_BYTES: usize = 4 + 4 + 4;

/// The render-facing view of one agent — exactly what the frontend draws.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AgentView {
    pub id: u32,
    pub x: f32,
    pub z: f32,
    pub health: f32,
    pub faction: u8,
    pub goal_kind: u8,
    pub level: u8,
    pub alive: u8, // 1 alive, 0 dead (kept as a byte for the packed tail / JS DataView)
}

/// One world snapshot — a frame the frontend renders.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct WorldSnapshot {
    pub tick: u32,
    pub agents: Vec<AgentView>,
}

impl WorldSnapshot {
    /// Serialize to a little-endian frame: `[MAGIC u32][tick u32][n u32]` then `n` × `AgentView`
    /// (`id,x,z,health` as LE 4-byte fields, then `faction,goal_kind,level,alive` bytes).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_BYTES + self.agents.len() * AGENT_BYTES);
        out.extend_from_slice(&MAGIC.to_le_bytes());
        out.extend_from_slice(&self.tick.to_le_bytes());
        out.extend_from_slice(&(self.agents.len() as u32).to_le_bytes());
        for a in &self.agents {
            out.extend_from_slice(&a.id.to_le_bytes());
            out.extend_from_slice(&a.x.to_le_bytes());
            out.extend_from_slice(&a.z.to_le_bytes());
            out.extend_from_slice(&a.health.to_le_bytes());
            out.push(a.faction);
            out.push(a.goal_kind);
            out.push(a.level);
            out.push(a.alive);
        }
        out
    }

    /// Deserialize a frame. `None` on a bad magic, a truncated buffer, or a count that overruns.
    pub fn from_bytes(buf: &[u8]) -> Option<WorldSnapshot> {
        if buf.len() < HEADER_BYTES {
            return None;
        }
        if u32::from_le_bytes(buf[0..4].try_into().ok()?) != MAGIC {
            return None;
        }
        let tick = u32::from_le_bytes(buf[4..8].try_into().ok()?);
        let n = u32::from_le_bytes(buf[8..12].try_into().ok()?) as usize;
        if buf.len() < HEADER_BYTES + n * AGENT_BYTES {
            return None;
        }
        let mut agents = Vec::with_capacity(n);
        let mut o = HEADER_BYTES;
        for _ in 0..n {
            let id = u32::from_le_bytes(buf[o..o + 4].try_into().ok()?);
            let x = f32::from_le_bytes(buf[o + 4..o + 8].try_into().ok()?);
            let z = f32::from_le_bytes(buf[o + 8..o + 12].try_into().ok()?);
            let health = f32::from_le_bytes(buf[o + 12..o + 16].try_into().ok()?);
            let (faction, goal_kind, level, alive) = (buf[o + 16], buf[o + 17], buf[o + 18], buf[o + 19]);
            agents.push(AgentView { id, x, z, health, faction, goal_kind, level, alive });
            o += AGENT_BYTES;
        }
        Some(WorldSnapshot { tick, agents })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips() {
        let snap = WorldSnapshot {
            tick: 4242,
            agents: vec![
                AgentView { id: 0, x: 1.5, z: -2.25, health: 100.0, faction: 0, goal_kind: 1, level: 7, alive: 1 },
                AgentView { id: 9, x: -40.0, z: 12.0, health: 0.0, faction: 1, goal_kind: 8, level: 3, alive: 0 },
            ],
        };
        let bytes = snap.to_bytes();
        assert_eq!(bytes.len(), HEADER_BYTES + 2 * AGENT_BYTES);
        assert_eq!(WorldSnapshot::from_bytes(&bytes), Some(snap));
    }

    #[test]
    fn rejects_bad_frames() {
        assert!(WorldSnapshot::from_bytes(&[]).is_none());
        assert!(WorldSnapshot::from_bytes(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_none()); // bad magic
        // a valid header claiming 5 agents but no agent bytes → truncated → None.
        let mut hdr = Vec::new();
        hdr.extend_from_slice(&MAGIC.to_le_bytes());
        hdr.extend_from_slice(&1u32.to_le_bytes());
        hdr.extend_from_slice(&5u32.to_le_bytes());
        assert!(WorldSnapshot::from_bytes(&hdr).is_none());
    }

    #[test]
    fn empty_snapshot_roundtrips() {
        let snap = WorldSnapshot { tick: 0, agents: vec![] };
        assert_eq!(WorldSnapshot::from_bytes(&snap.to_bytes()), Some(snap));
    }
}
