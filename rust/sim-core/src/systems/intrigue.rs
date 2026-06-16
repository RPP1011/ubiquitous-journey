//! FAN-OUT UNIT: intrigue (the Theory-of-Mind DECEPTION layer). Ports the SPIRIT of
//! `js/sim/intrigue.ts` — the soul of the ToM design: agents act on what they BELIEVE, so a deceiver
//! wins by FALSIFYING BELIEFS, never ground truth. The epistemic split is the whole point — ONLY
//! beliefs (and the perceived-faction mask) are corrupted; the spy's TRUE faction is untouched, so
//! when blades actually land combat resolves truly (the unmasking is a saga-worthy reveal, not a
//! retcon). Three light mechanics, all serial (society phase ⇒ trivially M-invariant):
//!
//!   (a) ASSIGN — a fraction of the living Monster/Raider roster become infiltrators: `role = SPY`
//!       and `disguise = Townsfolk` (the apparent-faction mask). `build_surface` folds the disguise
//!       into the `Perceivable.faction` field, so a bandit spy walks the town PERCEIVED as a
//!       townsperson — fooling every observer's `perceive`, while ground-truth combat reads the true
//!       faction. This is the load-bearing deception wiring.
//!   (b) PLANT — a disguised spy near the town core that has a townsperson OBSERVER within whisper
//!       range, and a SEPARATE innocent townsperson to frame, writes a FALSE hostile belief into the
//!       observer about the innocent (a planted feud spark). Belief write only — `sour_belief`.
//!   (c) PRICE TIP — besides the social lie, the spy may inflate a nearby bystander's PRICE BELIEF for
//!       one good (information warfare: the dupe overvalues and misroutes trade; mints nothing).
//!   (d) UNMASK — a plant may be witnessed, blowing the spy's cover: drop the disguise (true faction
//!       now perceived → the town hunts the traitor) and sour every nearby townsperson against it.
//!
//! SKIPPED (noted, per the port brief): the CULTIVATE / turn-asset grooming layer (a discontented
//! local warmed into a second-order planter) and asset-exposure chaining. The plant + unmask CORE is
//! ported; cultivate is a slower grooming arc that needs a per-agent `_assetOf` link column the
//! Wave-H substrate doesn't carry yet — left for a later slice (role=ASSET sentinel exists for it).
//!
//! Determinism: SERIAL society phase ⇒ trivially M-invariant. ASSIGN is idempotent (guarded on the
//! SPY role) and runs in id order. All rolls go through `world.sim_rng` (the world-level stream, never
//! per-entity rng). No HashMap iteration / float reduce in any path. Touches no gold, never spawns —
//! spies are EXISTING camp combatants given a cover identity, not extra bodies. (No TS parity — doc 22
//! §9; the tuning below mirrors the SPIRIT of INTRIGUE, not its values.)

use crate::components::{Faction, MAX_VISION, N_COMMODITIES};
use crate::world::{World, NO_DISGUISE};

// ── role sentinels (mirror world.rs `role` column: 0 none, 1 watch, 2 spy, 3 asset) ──
const ROLE_SPY: u8 = 2;

// ── tuning (mirrors the SPIRIT of INTRIGUE in js/sim/simconfig.ts) ──
const TICK_EVERY: u32 = 4; // ticks between intrigue passes (throttle).
/// A spy must be embedded INSIDE the town core (this far from town_center) to whisper a rumour.
const CORE_RADIUS: f32 = 90.0;
/// An OBSERVER must be within this of the spy to be whispered to (talk range).
const TALK_RANGE: f32 = 6.0;
const TALK_RANGE2: f32 = TALK_RANGE * TALK_RANGE;
/// A framed innocent VICTIM must be within this of the spy (frame range).
const FRAME_RADIUS: f32 = 22.0;
const FRAME_RADIUS2: f32 = FRAME_RADIUS * FRAME_RADIUS;
// The grid 3×3 query is a superset only if both radii fit one cell (cell size = MAX_VISION). If this
// ever fails, plant/unmask would silently miss edge-of-cell neighbours.
const _: () = assert!(TALK_RANGE <= MAX_VISION, "talk range must fit the grid cell (MAX_VISION)");

/// Fraction of the living Monster/Raider roster turned into spies at assignment.
const SPY_FRACTION: f32 = 0.25;
/// Apparent faction a spy wears (the cover identity). Townsfolk = walk among trusted neighbours.
const DISGUISE_AS: u8 = Faction::Townsfolk as u8;

/// Standing drop a planted false hostile belief inflicts (a low-confidence feud spark).
const PLANT_DROP: i16 = 9_000;
/// Per-pass chance an eligible, embedded spy actually plants this pass (whispering is the rarer event).
const PLANT_CHANCE: f32 = 0.5;
/// Per-plant chance the spy ALSO whispers a bad price tip to a bystander.
const PRICE_TIP_CHANCE: f32 = 0.35;
/// A price tip INFLATES the dupe's believed price by ×16/10 = 1.6 (integer math; price is u16).
const PRICE_TIP_MULT_NUM: u32 = 16;
const PRICE_TIP_MULT_DEN: u32 = 10;
/// Per-plant chance the spy is CAUGHT in the act (cover blown → unmask).
const UNMASK_CHANCE: f32 = 0.12;
/// Wariness an observer gains when whispered to by a plant (a seed of doubt).
const SUSPICION_GAIN: u8 = 60;
/// Extra unmask chance at MAXIMUM nearby suspicion (a fully-watchful neighbourhood catches the spy).
const UNMASK_SUSPICION_BONUS: f32 = 0.5;
/// Per-tick wariness decay (suspicion fades as the unsettling moment passes).
const SUSPICION_DECAY: u8 = 1;
/// Standing drop every nearby townsperson levels at an unmasked traitor (a latched hostile belief).
const UNMASK_DROP: i16 = 30_000;
/// Vision range for who SEES an unmasking (the reveal radius).
const UNMASK_VISION: f32 = MAX_VISION;
const UNMASK_VISION2: f32 = UNMASK_VISION * UNMASK_VISION;

// Chronicle BeatKind for an unmasking (the saga reveal). director uses 2/10/11/12; this is intrigue-local.
const BEAT_UNMASK: u8 = 30;

pub fn tick(world: &mut World) {
    // Throttle — intrigue is a slow, sparse drama.
    if world.tick % TICK_EVERY != 0 {
        return;
    }
    // wariness FADES: the unsettling moment passes (suspicion decays toward calm each intrigue tick).
    for s in world.suspicion.iter_mut() {
        *s = s.saturating_sub(SUSPICION_DECAY);
    }
    // ASSIGN once the world has a camp population: idempotent (skips already-assigned spies).
    assign_spies(world);
    run_spies(world);
}

/// The highest WARINESS among living townsfolk near the spy — the neighbourhood's vigilance, which
/// scales the unmask chance. Reads the suspicion column over the grid neighbours (own to the system).
fn nearby_suspicion(world: &World, spy: usize) -> u8 {
    let [x, z] = world.pos[spy];
    let mut best = 0u8;
    world.grid.for_near(x, z, |p| {
        let j = p.id as usize;
        if j == spy || j >= world.n || p.flags & 1 == 0 || world.faction[j] != Faction::Townsfolk as u8 {
            return;
        }
        if world.suspicion[j] > best {
            best = world.suspicion[j];
        }
    });
    best
}

/// Mark a fraction of the living Monster/Raider roster as spies wearing a Townsfolk cover. Idempotent:
/// an already-SPY agent is skipped, so re-running never over-assigns. Quota is per-faction-pool, taken
/// in id order. Sets BOTH `role` and `disguise` — the disguise is what `build_surface` folds into the
/// perceived faction (the load-bearing mask).
fn assign_spies(world: &mut World) {
    // count the live camp pool (Monster + Raider) and how many are ALREADY spies.
    let mut pool = 0usize;
    let mut have = 0usize;
    for i in 0..world.n {
        if !is_camp(world, i) {
            continue;
        }
        pool += 1;
        if world.role[i] == ROLE_SPY {
            have += 1;
        }
    }
    if pool == 0 {
        return;
    }
    let want = ((pool as f32 * SPY_FRACTION) as usize).max(1);
    if have >= want {
        return; // quota already met — nothing to assign.
    }
    let mut assigned = have;
    for i in 0..world.n {
        if assigned >= want {
            break;
        }
        if !is_camp(world, i) || world.role[i] == ROLE_SPY {
            continue;
        }
        // a leaderless flat pool: take the first eligible camp members in id order (deterministic).
        world.role[i] = ROLE_SPY;
        world.disguise[i] = DISGUISE_AS; // the cover mask — perceived as a townsperson.
        assigned += 1;
    }
}

/// Each disguised spy near the town core that can find a willing observer + an innocent victim plants
/// a false feud spark; it may also salt a price belief, and may be caught (unmasked). Serial, id order.
fn run_spies(world: &mut World) {
    for i in 0..world.n {
        // a live, still-disguised spy only (an already-unmasked one is a hunted enemy, no longer spying).
        if !world.alive[i] || world.role[i] != ROLE_SPY || world.disguise[i] == NO_DISGUISE {
            continue;
        }
        // must be embedded INSIDE its OWN town's core to whisper (per-town: a spy in town 5 works town 5).
        let center = world.town_centers[(world.town[i] as usize).min(world.town_centers.len() - 1)];
        let [x, z] = world.pos[i];
        let dx = x - center[0];
        let dz = z - center[1];
        if dx * dx + dz * dz > CORE_RADIUS * CORE_RADIUS {
            continue;
        }
        // ONE plant roll per embedded spy per pass (consumed before the neighbour search so the rng
        // stream advances independently of local geometry — order-stable consumption, faith-style).
        let plant_roll = world.sim_rng.next_f32();
        if plant_roll >= PLANT_CHANCE {
            continue;
        }
        // find a townsperson OBSERVER (within talk range) and a SEPARATE innocent VICTIM (within frame
        // range) by scanning the spatial grid. Lowest id wins each slot (deterministic).
        let mut observer: Option<usize> = None;
        let mut victim: Option<usize> = None;
        world.grid.for_near(x, z, |p| {
            let j = p.id as usize;
            if j == i || j >= world.n || p.flags & 1 == 0 {
                return; // self, a mind-less PERCEPT (id ≥ n), or the dead.
            }
            // read the TRUE faction (the spy's own sanctioned ground-truth action — it knows who's a
            // townsperson; the lie is the INTENT, written only as a false belief below).
            if world.faction[j] != Faction::Townsfolk as u8 {
                return;
            }
            let ddx = p.x - x;
            let ddz = p.z - z;
            let d2 = ddx * ddx + ddz * ddz;
            if observer.is_none() && d2 <= TALK_RANGE2 {
                observer = Some(j);
            } else if victim.is_none() && d2 <= FRAME_RADIUS2 {
                victim = Some(j);
            }
        });
        let (obs, vic) = match (observer, victim) {
            (Some(o), Some(v)) if o != v => (o, v),
            _ => continue, // no willing pair this pass.
        };

        // PLANT: a FALSE hostile belief in the observer about the innocent victim (the feud spark).
        // Belief write only (serial cross-row write ⇒ deterministic) — the victim's true faction is
        // untouched, so reality still resolves correctly if it ever comes to blades.
        world.sour_belief(obs, vic as u32, PLANT_DROP, true);

        // SEED OF DOUBT: being whispered to raises the observer's WARINESS — it half-senses the plot
        // without placing it. A watchful neighbourhood will catch the spy faster (below).
        world.suspicion[obs] = world.suspicion[obs].saturating_add(SUSPICION_GAIN);

        // FALSE PRICE INTEL: maybe salt a bystander's believed price for one good (mints nothing).
        if world.sim_rng.next_f32() < PRICE_TIP_CHANCE {
            plant_price_tip(world, i);
        }

        // CAUGHT IN THE ACT: a plant may be witnessed — the cover is blown. The chance RISES with how
        // wary the most suspicious townsperson near the spy is (suspicion → vigilance → exposure).
        let watch = nearby_suspicion(world, i) as f32 / 255.0;
        if world.sim_rng.next_f32() < UNMASK_CHANCE + watch * UNMASK_SUSPICION_BONUS {
            unmask(world, i);
        }
    }
}

/// Salt the believed price of one good for the nearest townsperson bystander within frame range:
/// INFLATE it (the "it's dear" lie) so the dupe overvalues and misroutes trade. Reads the bystander's
/// OWN believed price to size a believable lie; writes only that belief (no gold, no inventory). The
/// good index is chosen via `sim_rng`; the bystander is the lowest-id townsperson in range.
fn plant_price_tip(world: &mut World, spy: usize) {
    let good = (world.sim_rng.next_f32() * N_COMMODITIES as f32) as usize % N_COMMODITIES;
    let [x, z] = world.pos[spy];
    // pick the lowest-id townsperson bystander in frame range (deterministic), excluding the spy.
    let mut dupe: Option<usize> = None;
    world.grid.for_near(x, z, |p| {
        if dupe.is_some() {
            return;
        }
        let j = p.id as usize;
        if j == spy || j >= world.n || p.flags & 1 == 0 || world.faction[j] != Faction::Townsfolk as u8 {
            return;
        }
        let ddx = p.x - x;
        let ddz = p.z - z;
        if ddx * ddx + ddz * ddz <= FRAME_RADIUS2 {
            dupe = Some(j);
        }
    });
    let Some(d) = dupe else { return };
    let cur = world.econ[d].price_belief[good];
    if cur == 0 {
        return; // only corrupt a HELD belief.
    }
    // inflate by ×1.6 (integer math), clamped to u16; a tip must INFLATE to mislead.
    let lie = ((cur as u32 * PRICE_TIP_MULT_NUM) / PRICE_TIP_MULT_DEN).min(u16::MAX as u32) as u16;
    if lie > cur {
        world.econ[d].price_belief[good] = lie;
    }
}

/// UNMASK — the spy is exposed: drop the disguise (true faction now perceived → the town hunts the
/// traitor), clear its SPY role (a hunted enemy, no longer infiltrating), and sour every nearby
/// townsperson against it (latched hostile belief). A saga-worthy beat (logged to the chronicle).
fn unmask(world: &mut World, spy: usize) {
    world.disguise[spy] = NO_DISGUISE; // cover blown — `build_surface` now shows the TRUE faction.
    world.role[spy] = 0; // no longer a spy (a hunted enemy now).

    let [x, z] = world.pos[spy];
    // collect the nearby townsfolk first (the grid closure can't also borrow &mut world.beliefs).
    let mut witnesses: Vec<usize> = Vec::new();
    world.grid.for_near(x, z, |p| {
        let j = p.id as usize;
        if j == spy || j >= world.n || p.flags & 1 == 0 || world.faction[j] != Faction::Townsfolk as u8 {
            return;
        }
        let ddx = p.x - x;
        let ddz = p.z - z;
        if ddx * ddx + ddz * ddz <= UNMASK_VISION2 {
            witnesses.push(j);
        }
    });
    for o in witnesses {
        world.sour_belief(o, spy as u32, UNMASK_DROP, true);
    }
    world.chronicle.push(crate::components::Beat {
        t: world.tick,
        kind: BEAT_UNMASK,
        subject: spy as u32,
        magnitude: 1,
    });
}

/// A live camp combatant (Monster or Raider) — the only pool spies are drawn from.
#[inline]
fn is_camp(w: &World, i: usize) -> bool {
    w.alive[i] && (w.faction[i] == Faction::Monster as u8 || w.faction[i] == Faction::Raider as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::world_hash;
    use crate::world::{World, NO_DISGUISE};

    /// SUSPICION: a wary neighbourhood is more likely to catch the spy. `nearby_suspicion` reports the
    /// most watchful townsperson near the spy, and that scales the unmask chance; suspicion decays.
    #[test]
    fn a_watchful_neighbourhood_raises_exposure() {
        let mut w = World::spawn(0x5505, 6);
        let (spy, neighbour) = (0usize, 1usize);
        w.alive[spy] = true;
        w.alive[neighbour] = true;
        w.faction[neighbour] = Faction::Townsfolk as u8;
        w.pos[spy] = [0.0, 0.0];
        w.pos[neighbour] = [3.0, 0.0];
        w.build_surface();

        assert_eq!(nearby_suspicion(&w, spy), 0, "a calm neighbourhood reports no wariness");
        w.suspicion[neighbour] = 200;
        w.build_surface();
        assert_eq!(nearby_suspicion(&w, spy), 200, "a wary neighbour's suspicion is sensed near the spy");

        // decay: wariness fades over intrigue ticks (toward calm).
        let before = w.suspicion[neighbour];
        w.tick = TICK_EVERY; // land on an intrigue tick
        tick(&mut w);
        assert!(w.suspicion[neighbour] < before, "wariness decays as the moment passes");
    }

    /// Spawn a world with a guaranteed camp member at id 0 (forced to Monster faction).
    fn world_with_camp(seed: u64, n: usize) -> World {
        let mut w = World::spawn(seed, n);
        w.faction[0] = Faction::Monster as u8;
        w.role[0] = 0;
        w.disguise[0] = NO_DISGUISE;
        w
    }

    #[test]
    fn a_spy_gets_a_disguise() {
        let mut w = world_with_camp(0x_5919, 80);
        assign_spies(&mut w);
        // at least one camp member must now be a disguised spy.
        let spies: Vec<usize> = (0..w.n).filter(|&i| w.role[i] == ROLE_SPY).collect();
        assert!(!spies.is_empty(), "intrigue must assign at least one spy from the camp pool");
        for &i in &spies {
            assert_eq!(w.disguise[i], DISGUISE_AS, "a spy wears the Townsfolk cover mask");
            assert_eq!(w.faction[i], Faction::Monster as u8, "ground-truth faction is UNCHANGED");
        }
    }

    #[test]
    fn assign_is_idempotent() {
        let mut w = world_with_camp(0x_DEADBE, 80);
        assign_spies(&mut w);
        let first: Vec<usize> = (0..w.n).filter(|&i| w.role[i] == ROLE_SPY).collect();
        assign_spies(&mut w);
        assign_spies(&mut w);
        let again: Vec<usize> = (0..w.n).filter(|&i| w.role[i] == ROLE_SPY).collect();
        assert_eq!(first, again, "re-assigning must not over-assign spies");
    }

    /// The load-bearing deception: a disguised spy is PERCEIVED (in the surface) as its cover faction,
    /// while unmasking reveals the TRUE faction. This guards the `build_surface` disguise fold.
    #[test]
    fn perceive_sees_the_mask_then_the_truth() {
        let mut w = world_with_camp(0x_FACADE, 60);
        let spy = 0usize;
        w.role[spy] = ROLE_SPY;
        w.disguise[spy] = DISGUISE_AS;

        // the surface must show the COVER faction (Townsfolk), not the true Monster faction.
        w.build_surface();
        let row = w.surface.iter().find(|p| p.id as usize == spy).expect("spy in surface");
        assert_eq!(
            row.faction,
            Faction::Townsfolk as u8,
            "a disguised spy must be PERCEIVED as its cover faction (the deception wiring)"
        );
        assert_eq!(w.faction[spy], Faction::Monster as u8, "ground truth stays Monster");

        // unmask, rebuild: the surface must now show the TRUE faction (the town can hunt it).
        unmask(&mut w, spy);
        assert_eq!(w.disguise[spy], NO_DISGUISE, "unmasking drops the cover");
        w.build_surface();
        let row = w.surface.iter().find(|p| p.id as usize == spy).expect("spy in surface");
        assert_eq!(
            row.faction,
            Faction::Monster as u8,
            "an unmasked spy must be perceived as its TRUE faction"
        );
    }

    /// A plant writes a FALSE hostile belief: co-locate a spy + a dense townsperson cluster in the
    /// core, run passes, and assert SOME observer now holds a soured/hostile belief about an innocent
    /// townsperson it would have had no grievance with otherwise (the planted feud spark).
    #[test]
    fn a_plant_sours_an_innocent() {
        let mut w = world_with_camp(0x_F00D17, 40);
        let spy = 0usize;
        w.role[spy] = ROLE_SPY;
        w.disguise[spy] = DISGUISE_AS;
        // keep the spy embedded (an unmask would end its career early): a fresh spy each pass below.
        let folk: Vec<usize> = (0..w.n)
            .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8)
            .collect();
        assert!(folk.len() >= 3, "need a few townsfolk for the cluster");
        // co-locate the spy and a small townsperson cluster at the core, all within talk/frame range.
        w.pos[spy] = w.town_center;
        for (k, &f) in folk.iter().take(5).enumerate() {
            w.pos[f] = [w.town_center[0] + 1.0 + k as f32, w.town_center[1]];
        }
        w.build_surface();

        // a planted false hostile belief = an observer holding a hostile flag about an INNOCENT
        // townsperson. Run passes; re-arm the spy each pass so an unmask can't end the experiment.
        let mut planted = false;
        for _ in 0..400 {
            w.role[spy] = ROLE_SPY; // re-arm (an unmask would otherwise retire the spy).
            w.disguise[spy] = DISGUISE_AS;
            run_spies(&mut w);
            // scan: did any townsperson observer gain a hostile belief about another townsperson?
            let hit = folk.iter().any(|&o| {
                let bt = &w.beliefs[o];
                (0..bt.len as usize).any(|ix| {
                    let b = &bt.bodies[ix];
                    let subj = b.subject as usize;
                    b.flags & 0x01 != 0
                        && subj < w.n
                        && subj != o
                        && w.faction[subj] == Faction::Townsfolk as u8
                        && b.standing < 0
                })
            });
            if hit {
                planted = true;
                break;
            }
        }
        assert!(
            planted,
            "a spy amid a townsperson cluster should plant a false hostile belief about an innocent"
        );
    }

    #[test]
    fn intrigue_is_deterministic_and_conserves_gold() {
        let run = || {
            let mut w = World::spawn(0x_51E5, 300);
            let g0 = w.total_gold();
            for _ in 0..200 {
                w.tick();
            }
            (world_hash(&w), w.total_gold(), g0)
        };
        let (h1, g1, g0a) = run();
        let (h2, g2, g0b) = run();
        assert_eq!(h1, h2, "intrigue must be run-to-run deterministic");
        assert_eq!(g1, g0a, "gold conserved across the run");
        assert_eq!(g2, g0b, "gold conserved across the run");
    }
}
