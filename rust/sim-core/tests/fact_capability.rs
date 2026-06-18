//! Integration gate for the doc-25 fact-store capability: a real sim run must actually MINT open
//! `FA_OWES_ME` debt facts (the urchin steal → rob → owe path fires end-to-end), and the run stays
//! deterministic. Proves the fact store is LIVE in the sim, not just unit-tested in isolation.

use sim_core::components::FA_OWES_ME;
use sim_core::hash::world_hash;
use sim_core::in_pool;
use sim_core::world::World;

fn run_and_count_debts(seed: u64, n: usize, frames: u32) -> (usize, u64) {
    in_pool(1, || {
        let mut w = World::spawn(seed, n);
        for _ in 0..frames {
            w.step_timing();
        }
        let debts: usize = (0..w.n)
            .map(|i| w.facts[i].facts.iter().filter(|f| f.attr == FA_OWES_ME).count())
            .sum();
        (debts, world_hash(&w))
    })
}

#[test]
fn robberies_mint_debt_facts_in_a_real_run() {
    // a populated region over time produces some crime (the strict steal gate eventually fires for a
    // poor+bold+uncaring agent beside a believed-rich mark), and each robbery mints a debt belief.
    let (debts, _) = run_and_count_debts(0xC00D19, 600, 4000);
    assert!(
        debts > 0,
        "expected at least one FA_OWES_ME debt fact to be minted over the run (got {debts})"
    );
}

#[test]
fn the_fact_capability_run_is_deterministic() {
    // same seed → identical final hash (which now folds the fact store) across runs.
    let (_, h1) = run_and_count_debts(0xC00D19, 400, 1500);
    let (_, h2) = run_and_count_debts(0xC00D19, 400, 1500);
    assert_eq!(h1, h2, "the fact-store-folded world hash must be run-to-run deterministic");
}
