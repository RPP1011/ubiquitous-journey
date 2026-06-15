//! server — the authoritative backend half of the render-only split (docs/architecture/22 §6, doc 20).
//! It owns the `sim-core` world, advances it, and projects each tick into a render-facing
//! `protocol::WorldSnapshot` the frontend draws. Cross-language, deterministic, and (for now)
//! dependency-free: the transport is raw length-prefixed TCP framing (a WebSocket/HTTP layer via
//! axum/tokio is the next, deps-required step — this is the substrate it wraps).
//!
//! The snapshot is the EPISTEMIC-SPLIT boundary: it carries only what the renderer may SEE (positions,
//! factions, the current goal kind, health) — never belief tables / cognition. The frontend cannot
//! leak ground truth an NPC shouldn't act on.

use std::io::Write;

use protocol::{AgentView, WorldSnapshot};
use sim_core::world::World;

/// Project the authoritative world into a render-facing snapshot (the double-buffer's render copy).
pub fn snapshot(world: &World) -> WorldSnapshot {
    let mut agents = Vec::with_capacity(world.n);
    for i in 0..world.n {
        agents.push(AgentView {
            id: i as u32,
            x: world.pos[i][0],
            z: world.pos[i][1],
            health: world.combat[i].health,
            faction: world.faction[i],
            goal_kind: world.goal[i].kind() as u8,
            level: world.level[i],
            alive: world.alive[i] as u8,
        });
    }
    WorldSnapshot { tick: world.tick, agents }
}

/// Serve snapshot frames to connecting clients over raw TCP: each frame is `[u32 len][len bytes]`.
/// One client at a time (a render view); the sim advances one tick per frame sent. Blocking + dep-free
/// — a WS bridge (or axum upgrade) wraps this length-prefixed stream later. Loops until the client
/// disconnects, then awaits the next.
pub fn serve(addr: &str, mut world: World) -> std::io::Result<()> {
    let listener = std::net::TcpListener::bind(addr)?;
    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        loop {
            world.tick();
            let frame = snapshot(&world).to_bytes();
            if stream.write_all(&(frame.len() as u32).to_le_bytes()).is_err()
                || stream.write_all(&frame).is_err()
            {
                break; // client gone — wait for the next connection
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_projects_the_world_and_roundtrips() {
        let mut w = World::spawn(0x5E2, 32);
        for _ in 0..20 {
            w.tick();
        }
        let snap = snapshot(&w);
        assert_eq!(snap.tick, w.tick);
        assert_eq!(snap.agents.len(), w.n);
        // the projection matches the authoritative columns…
        assert_eq!(snap.agents[3].faction, w.faction[3]);
        assert_eq!(snap.agents[3].goal_kind, w.goal[3].kind() as u8);
        assert_eq!(snap.agents[3].x, w.pos[3][0]);
        // …and survives the wire format.
        assert_eq!(WorldSnapshot::from_bytes(&snap.to_bytes()), Some(snap));
    }
}
