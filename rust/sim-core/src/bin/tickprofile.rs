//! tickprofile — per-phase wall-clock breakdown of a real sim tick, to answer: what fraction of a
//! tick is actually spent reading beliefs to decide? The belief-layout question (flat struct vs fact
//! store) only matters in proportion to that fraction. If the belief-touching phases are a small
//! slice of the tick, the per-read cost delta is in the noise and the simpler model wins.
//!
//!   cargo run --release --bin tickprofile [N] [frames]

use sim_core::in_pool;
use sim_core::world::World;

fn main() {
    let mut args = std::env::args().skip(1);
    let n: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(5000);
    let frames: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(200);
    let seed: u64 = 0xC00D19;
    let cores = std::thread::available_parallelism().map(|c| c.get()).unwrap_or(8);

    in_pool(cores, || {
        let mut w = World::spawn(seed, n);
        // warm up (let the world settle so phase costs are representative)
        for _ in 0..20 {
            w.step_profiled();
        }
        let mut acc = [0.0f64; 15];
        for _ in 0..frames {
            let t = w.step_profiled();
            for i in 0..15 {
                acc[i] += t[i];
            }
        }
        let whole: f64 = acc.iter().sum();
        let ms = |s: f64| s / frames as f64 * 1000.0;
        let pct = |s: f64| if whole > 0.0 { s / whole * 100.0 } else { 0.0 };

        let names = [
            "needs", "reason*", "decide*", "locomotion", "refresh_cues", "build_surface",
            "perceive†", "snapshot†", "gossip*", "combat", "abilities", "newsread", "market",
            "act", "rest",
        ];
        println!("tickprofile — N={} frames={} cores={}\n", n, frames, cores);
        println!("  whole tick: {:.4} ms/tick  ({} agents alive)\n", ms(whole), w.n);
        println!("  {:<14} {:>10} {:>8}", "phase", "ms/tick", "% tick");
        for i in 0..15 {
            println!("  {:<14} {:>10.4} {:>7.1}%", names[i], ms(acc[i]), pct(acc[i]));
        }

        let belief_read = acc[1] + acc[2] + acc[8]; // reason + decide + gossip
        let belief_write = acc[6] + acc[7]; // perceive + snapshot
        println!("\n  belief-READ phases (reason+decide+gossip):  {:.4} ms/tick  ({:.1}% of tick)", ms(belief_read), pct(belief_read));
        println!("  belief-WRITE phases (perceive+snapshot):    {:.4} ms/tick  ({:.1}% of tick)", ms(belief_write), pct(belief_write));
        println!("\n  * reads beliefs to decide   † writes/maintains beliefs");
    });
}
