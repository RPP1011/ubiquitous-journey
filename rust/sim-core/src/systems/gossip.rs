//! FAN-OUT UNIT: gossip. Port the spirit of `js/sim/agent/perception.ts` `gossipBeliefs`
//! (belief spread + relationship accrual between nearby agents).
//!
//! WHAT THIS IMPLEMENTS (parallel, own-write into `world.beliefs`, cross-READ from `world.beliefs_prev`):
//! - The scheduler has already snapshotted beliefs into `beliefs_prev` (the frozen read set). For
//!   each agent i, find the LOWEST-id nearby partner within `TALK_RANGE` (grid 3×3 superset + exact
//!   reject), then merge that partner's `beliefs_prev[partner]` cells into `beliefs[i]`:
//!     * a third-party belief the partner holds MORE confidently than I do replaces my cell (I adopt
//!       the better-sourced opinion). I never gossip about myself or about the partner-as-subject via
//!       the third-party merge.
//!     * If I hold no belief about that third party yet, I adopt it ONLY when I have a free table slot
//!       — gossip never EVICTS an existing (perception-sourced, in-range) belief to make room. That
//!       keeps the grid-superset gate intact: an in-range neighbour I perceived this tick is never
//!       displaced by hearsay about someone far away.
//! - Accrue a small positive `standing` toward the peacefully-chatted partner (the relationship EMA),
//!   but only from a non-negative baseline — proximity alone never melts a real grudge.
//!
//! DETERMINISM (the hard gate): we read others ONLY from `beliefs_prev` (the frozen snapshot) and
//! write ONLY `beliefs[i]` (own row) — disjoint by construction, so `par_iter_mut` is race-free and
//! M=1 ≡ M=N. The partner is chosen by an explicit lowest-id tie-break, never grid-iteration order.

use rayon::prelude::*;

use crate::components::{BeliefTable, PersonBelief, BELIEF_CAP};
use crate::world::World;

/// Chat range: agents within this distance can overhear each other (a fraction of VISION).
const TALK_RANGE: f32 = 12.0;
/// Relationship EMA step toward a peacefully-chatted partner (quantized i16 standing units).
const AFFINITY_GAIN: i16 = 64;
/// Cap on affinity built from mere proximity (a fraction of the i16 range).
const AFFINITY_CAP: i16 = 8192;

pub fn gossip(world: &mut World) {
    let World {
        ref pos,
        ref grid,
        ref facts_prev,
        ref mut facts,
        ..
    } = *world;

    let r2 = TALK_RANGE * TALK_RANGE;

    // doc 25: load my beliefs + the partner's frozen snapshot as scratch tables (the codec), run the
    // EXACT merge+affinity logic, store mine back. Reads only `facts_prev` (frozen) + own `facts[i]`.
    facts.par_iter_mut().enumerate().for_each(|(i, fs)| {
        let mut bt = fs.to_belief_table();
        let my_id = i as u32;
        let x = pos[i][0];
        let z = pos[i][1];

        // 1. pick the LOWEST-id partner within talk range (explicit deterministic tie-break —
        //    never "first in grid order"). The grid 3×3 block is a superset; reject by exact dist.
        let mut partner: Option<u32> = None;
        grid.for_near(x, z, |p| {
            if p.id == my_id || p.flags & 1 == 0 || p.id >= crate::world::PERCEPT_ID_BASE {
                return; // skip self, the dead (bit0), and mind-less PERCEPTS (you can't gossip with a prop).
            }
            let dx = x - p.x;
            let dz = z - p.z;
            if dx * dx + dz * dz > r2 {
                return;
            }
            partner = Some(match partner {
                Some(cur) => cur.min(p.id),
                None => p.id,
            });
        });
        let partner = match partner {
            Some(p) => p,
            None => return, // nobody to chat with this tick.
        };

        let src = facts_prev[partner as usize].to_belief_table();

        // 2. adopt the partner's better-sourced third-party beliefs (never about me or the partner).
        for k in 0..src.len as usize {
            let sb = &src.bodies[k];
            let subj = sb.subject;
            if subj == my_id || subj == partner {
                continue;
            }
            // ANIMACY: you don't pass on hearsay about a mind-less PROP (belief flag bit2) — gossip is
            // social news about PEOPLE. (Each agent still perceives props first-hand.)
            if sb.flags & 0x04 != 0 {
                continue;
            }
            merge_belief(&mut bt, sb);
        }

        // 3. relationship EMA: a peaceful chat builds a little familiarity toward the partner, but
        //    only from a non-negative baseline (a real grudge persists; proximity doesn't melt it).
        if let Some(idx) = bt.find(partner) {
            let b = &mut bt.bodies[idx];
            let hostile = b.flags & 1 != 0;
            if !hostile && b.standing >= 0 {
                b.standing = (b.standing.saturating_add(AFFINITY_GAIN)).min(AFFINITY_CAP);
            }
        }
        fs.mirror_core_from(&bt);
    });
}

/// Merge one of the partner's beliefs (`sb`) about a third party into my table `bt`.
/// - If I already hold it: adopt iff the partner is MORE confident (replace observed fields; keep my
///   own `standing`/`flags` — my relationship to that third party is mine, not the teller's).
/// - If I don't: insert ONLY when there's a free slot. Gossip never evicts an existing belief
///   (which keeps perception's in-range subjects intact for the grid-superset gate).
#[inline]
fn merge_belief(bt: &mut BeliefTable, sb: &PersonBelief) {
    // PROVENANCE: a retold rumour is one HOP further from the source and trusted LESS — its confidence
    // fades a notch per relay (the "Hearsay" theme: third-hand news is shakier than what you saw). I
    // weigh the FADED confidence against what I already hold, so first-hand knowledge wins over a rumour.
    const RUMOUR_FADE: f32 = 0.85; // confidence retained per relay hop
    let told_conf = (sb.confidence as f32 * RUMOUR_FADE) as u16;
    let told_hops = sb.hops.saturating_add(1);
    if let Some(idx) = bt.find(sb.subject) {
        let b = &mut bt.bodies[idx];
        if told_conf > b.confidence {
            b.last_x = sb.last_x;
            b.last_z = sb.last_z;
            b.confidence = told_conf;
            b.faction = sb.faction;
            b.level = sb.level;
            b.notoriety = sb.notoriety;
            b.threat = sb.threat;
            b.last_tick = sb.last_tick;
            b.hops = told_hops; // I now hold this third-hand
            // standing/flags are MINE (my relationship to this third party), not the teller's.
        }
        return;
    }
    let len = bt.len as usize;
    if len < BELIEF_CAP {
        let mut fresh = *sb;
        fresh.confidence = told_conf; // adopt at the faded, hop-attenuated confidence
        fresh.hops = told_hops;
        fresh.standing = 0; // a hearsay subject starts neutral for me — I inherit no relationship.
        fresh.flags = 0;
        bt.subjects[len] = sb.subject;
        bt.bodies[len] = fresh;
        bt.len += 1;
    }
    // table full: do NOT evict — gossip yields to perception's in-range beliefs.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::PersonBelief;

    /// PROVENANCE: a rumour fades as it's retold. A first-hand belief (hops 0) relayed once is adopted at
    /// a HIGHER hop count and LOWER confidence; first-hand knowledge always trumps an incoming rumour.
    #[test]
    fn a_retold_rumour_fades_and_counts_a_hop() {
        let mut bt = BeliefTable::default();
        // a partner tells me, first-hand (hops 0), about a third party at high confidence.
        let told = PersonBelief { subject: 9, confidence: 50_000, hops: 0, ..Default::default() };
        merge_belief(&mut bt, &told);
        let ix = bt.find(9).expect("I adopted the hearsay");
        assert_eq!(bt.bodies[ix].hops, 1, "what I heard is now one hop from the source");
        assert!(bt.bodies[ix].confidence < 50_000, "a retold rumour is trusted less than the telling");

        // first-hand knowledge trumps a rumour: a faint relay must NOT overwrite my confident sighting.
        let mut bt2 = BeliefTable::default();
        bt2.subjects[0] = 9;
        bt2.bodies[0] = PersonBelief { subject: 9, confidence: 60_000, hops: 0, ..Default::default() };
        bt2.len = 1;
        merge_belief(&mut bt2, &told); // told (50k → ~42k faded) < my 60k first-hand
        assert_eq!(bt2.bodies[0].confidence, 60_000, "my first-hand belief survives a weaker rumour");
        assert_eq!(bt2.bodies[0].hops, 0, "and stays first-hand");
    }
}
