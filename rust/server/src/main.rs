//! The backend entry point. `server [seed] [n] [addr?]`:
//!   - with an addr (e.g. `127.0.0.1:8088`): serve snapshot frames over raw TCP (one render client).
//!   - without: headless — advance 200 ticks and print the final frame stats (a smoke check).

use sim_core::world::World;

fn parse_seed(s: &str) -> Option<u64> {
    if let Some(hex) = s.strip_prefix("0x") {
        u64::from_str_radix(hex, 16).ok()
    } else {
        s.parse().ok()
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seed = args.get(1).and_then(|s| parse_seed(s)).unwrap_or(0x00C0_0D19);
    let n = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(300usize);
    let world = World::spawn(seed, n);

    match args.get(3) {
        Some(addr) => {
            eprintln!("server: serving snapshot frames on {addr} (seed=0x{seed:x}, n={n})");
            if let Err(e) = server::serve(addr, world) {
                eprintln!("server: serve error: {e}");
                std::process::exit(1);
            }
        }
        None => {
            let mut world = world;
            for _ in 0..200 {
                world.tick();
            }
            let frame = server::snapshot(&world).to_bytes();
            println!(
                "headless: tick={} agents={} frame_bytes={} (pass `addr` to serve over TCP)",
                world.tick,
                world.n,
                frame.len()
            );
        }
    }
}
