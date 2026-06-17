//! Faith / gods (`systems/faith.rs`). A god is sustained by belief (`believers`); its functional power is
//! breadth x depth (components::God). The pantheon has many DOMAINS: SETTLEMENT (a town's residents) and
//! WILD_SITE (the wild) plus seatless condition/activity gods (WAR/DREAD/COMFORT/FORTUNE/CRAFT/DEATH),
//! in-domain by STATE not place. `world.gods` is the registry; `faith[i]` (1-based) is agent `i`'s god.
//!
//! Recruitment passes (serial society phase ⇒ M-invariant):
//! - BOOTSTRAP: seed every town a patron-god flock + a wild cult + a small cult to each other god.
//! - WILD CLAIM: a soul out in the wild may convert to the nearest wild god (steals any faith).
//! - DOMAIN DRAW: a faithless soul living an experience is drawn to that experience's god (a fighter→war,
//!   the rich→fortune, a smith→the forge) — a condition god's niche.
//! - SPREAD: a faithless townsperson adopts the locally dominant neighbour faith.
//! - DOUBT: believers lapse; crowding lifts the rate; a small god's last believers are protected; wild
//!   faith lapses slow in the wild, fast in town.
//!
//! Then DYNAMICS (breadth = in-domain count, depth drifts with the flock — gods migrate on the grid),
//! `effects` (depth-scaled, mood-only ⇒ economy-safe: war = resolve, comfort consoles, town defends,
//! wild = reckless, etc.), and `contracts` (a deep god grafts its domain ability onto its champions).
//!
//! Determinism: serial; rolls use a dedicated `world.faith_rng` so faith never perturbs the economy's
//! `sim_rng`. No gold minted; the only spawns are wilderness monsters (via the lair effect, conserved).

use crate::components::{
    Faction, God, GoalKind, DOMAIN_COMFORT, DOMAIN_CRAFT, DOMAIN_DEATH, DOMAIN_DREAD, DOMAIN_FORTUNE,
    DOMAIN_SETTLEMENT, DOMAIN_WAR, DOMAIN_WILD_SITE, MAX_VISION, NO_GOD,
};
use crate::world::World;

const TICK_EVERY: u32 = 3; // ticks between passes.
const BOOT_FLOCK: usize = 14; // believers seeded to each town's patron town-god at bootstrap.
const WILD_CULT_FLOCK: usize = 4; // believers seeded to a wild god in each town at bootstrap (so wild
                                  // faith has a foothold and its rise doesn't depend on a lucky first claim).
const CONVERT_RANGE: f32 = 10.0; // a neighbour within this counts toward a local flock.
const CONVERT_RANGE2: f32 = CONVERT_RANGE * CONVERT_RANGE;
// The grid's 3x3 query is only a superset of CONVERT_RANGE if the range fits one cell.
const _: () = assert!(CONVERT_RANGE <= MAX_VISION, "convert range must fit the grid cell (MAX_VISION)");
const CONVERT_CHANCE: f32 = 0.05; // base per-pass chance a faithless soul adopts a nearby faith.
const POWER_CONVERT_BONUS: f32 = 0.04; // + this per sqrt(flock) (sub-linear bandwagon).
const CONVERT_CHANCE_MAX: f32 = 0.9;
const DOUBT_CHANCE: f32 = 0.012; // base per-pass chance a believer lapses.
const CROWD_DOUBT_AT: f32 = 70.0; // flock size at which crowding ~doubles the lapse rate.
const SMALL_GOD_AT: usize = 1; // <= this many believers => protected (the last believers don't lapse).

// Wild-god claiming.
const WILD_EDGE: f32 = 250.0; // beyond this of every town centre, a soul counts as out in the wild.
const WILD_EDGE2: f32 = WILD_EDGE * WILD_EDGE;
const CLAIM_BASE: f32 = 0.02; // base per-pass claim chance out in the wild (with no flock).
const CLAIM_POWER_BONUS: f32 = 0.012; // + per sqrt(flock).
const CLAIM_CHANCE_MAX: f32 = 0.5;
// Wild-god faith holds in the wild but lapses fast in town, so it stays a transient minority in town
// (only the freshly-claimed carry it back) while town gods keep the towns.
const WILD_LAPSE_OUT: f32 = 0.3; // lapse multiplier out in the wild (slow).
const WILD_LAPSE_TOWN: f32 = 2.5; // lapse multiplier inside a town (fast).

/// Living townsfolk are the only candidates for belief (monsters/raiders have no faith).
#[inline]
fn is_faithful_candidate(w: &World, i: usize) -> bool {
    w.alive[i] && w.faction[i] == Faction::Townsfolk as u8
}

/// Per-god believer tally over the live townsfolk roster. `power[g]` = believers of god id `g`
/// (1-based; slot 0 = NO_GOD is unused). Length = `gods.len() + 1`.
fn tally(w: &World) -> Vec<usize> {
    let mut power = vec![0usize; w.gods.len() + 1];
    for i in 0..w.n {
        if !is_faithful_candidate(w, i) {
            continue;
        }
        let g = w.faith[i] as usize;
        if g != NO_GOD as usize && g <= w.gods.len() {
            power[g] += 1;
        }
    }
    power
}

pub fn tick(world: &mut World) {
    if world.tick % TICK_EVERY != 0 || world.gods.is_empty() {
        return;
    }
    let any = (0..world.n).any(|i| is_faithful_candidate(world, i));
    if !any {
        return;
    }

    let power = tally(world);
    let total: usize = power[1..].iter().sum();
    if total == 0 {
        bootstrap(world);
    } else {
        wild_claim(world, &power);
        domain_draw(world, &power);
        spread(world, &power);
        doubt(world, &power);
    }

    // DYNAMICS: believers sustain a god; its BREADTH = how many are in its domain right now (the active
    // reach), and its DEPTH (manipulation strength) drifts with the flock. So power = breadth x depth
    // tracks belief AND how active the domain is, and a god migrates on the grid as both change.
    let n_gods = world.gods.len();
    let mut bel = vec![0u32; n_gods + 1];
    let mut indom = vec![0u32; n_gods + 1];
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) {
            continue;
        }
        let g = world.faith[i] as usize;
        if g == NO_GOD as usize || g > n_gods {
            continue;
        }
        bel[g] += 1;
        if in_domain(world, i, &world.gods[g - 1]) {
            indom[g] += 1;
        }
    }
    for (gi, g) in world.gods.iter_mut().enumerate() {
        let b = bel[gi + 1];
        g.believers = b;
        // breadth = active reach. For most domains that is the in-domain count; a WILD god's reach is
        // flock-based (bel/4) so its power is stable (the lair effect reads it) rather than swinging with
        // how many happen to be in the wild this instant.
        g.breadth = if g.domain == DOMAIN_WILD_SITE {
            (b / 4).min(u16::MAX as u32) as u16
        } else {
            indom[gi + 1].min(u16::MAX as u32) as u16
        };
        let depth_target = match g.domain {
            DOMAIN_SETTLEMENT => (b / 110).clamp(2, 8) as u16, // wide, shallow
            DOMAIN_WILD_SITE => if b > 0 { (8 + b / 40).clamp(8, DEPTH_MAX as u32) as u16 } else { 1 }, // narrow, deep
            _ => if b > 0 { (3 + b / 45).clamp(3, DEPTH_MAX as u32) as u16 } else { 1 },
        };
        if g.depth < depth_target {
            g.depth += 1;
        } else if g.depth > depth_target {
            g.depth -= 1;
        }
    }
}

// ── DOMAINS: who is "in" a god's domain, and what worship DOES there (depth-scaled, mood-only) ──
const EFFECT_EVERY: u32 = 3;
const DEPTH_MAX: u16 = 14;
const FORTUNE_RICH: u32 = 40_000; // wealth_cue above this counts as in the Fortune god's domain.
const WILD_RESOLVE: f32 = 0.9; // wild faith floors anger this high (reckless aggression).
const TOWN_RESOLVE: f32 = 0.42; // town faith gives courage to DEFEND (a struck believer crosses 0.5 → fights).
const TOWN_JOY: f32 = 0.55;

/// Is agent `i` currently within `god`'s domain? (Belief sustains the god; this is its active REACH.)
fn in_domain(w: &World, i: usize, god: &God) -> bool {
    match god.domain {
        DOMAIN_SETTLEMENT => (w.town[i] as i16) == god.home_town,
        DOMAIN_WILD_SITE => {
            let p = w.pos[i];
            w.town_centers.iter().all(|c| (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) > WILD_EDGE2)
        }
        DOMAIN_WAR => matches!(w.goal[i].kind(), GoalKind::Fight),
        DOMAIN_DREAD => w.mood[i].fear > 0.25,
        DOMAIN_COMFORT => w.mood[i].grief > 0.15,
        DOMAIN_FORTUNE => w.wealth[i] as u32 > FORTUNE_RICH,
        DOMAIN_CRAFT => w.profession[i] == god.domain_param as u8,
        _ => false, // DOMAIN_DEATH and any unhandled kind: no per-agent reach
    }
}

/// Apply each god's effect (depth-scaled) to the faithful who are CURRENTLY in its domain. Mood-only ⇒
/// economy-safe (it colours the fight/flee reflex + disposition, never food/work). Serial ⇒ deterministic;
/// floors are re-applied each pass so mood-decay can't erase them while the faith holds.
pub fn effects(world: &mut World) {
    if world.tick % EFFECT_EVERY != 0 || world.gods.is_empty() {
        return;
    }
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) {
            continue;
        }
        let g = world.faith[i] as usize;
        if g == NO_GOD as usize || g > world.gods.len() {
            continue;
        }
        let god = world.gods[g - 1];
        if !in_domain(world, i, &god) {
            continue;
        }
        let frac = god.depth as f32 / DEPTH_MAX as f32;
        let m = &mut world.mood[i];
        match god.domain {
            DOMAIN_WILD_SITE => {
                m.anger = m.anger.max(WILD_RESOLVE * frac);
                m.fear *= 1.0 - 0.5 * frac;
            }
            DOMAIN_SETTLEMENT => {
                m.joy = m.joy.max(TOWN_JOY * frac);
                m.anger = m.anger.max(TOWN_RESOLVE * frac);
                m.fear *= 1.0 - 0.25 * frac;
            }
            DOMAIN_WAR => {
                // in_domain = already fighting, so this only deepens an existing fight (no new combat
                // pulled out of nowhere): relentless resolve + pride.
                m.anger = m.anger.max(0.7 * frac);
                m.pride = m.pride.max(0.4 * frac);
            }
            DOMAIN_DREAD => {
                // a mild dread (kept small: a strong fear floor would rout the faithful off their work
                // and starve the marginal economy). Just enough to fray nerves.
                m.fear = m.fear.max(0.3 * frac);
            }
            DOMAIN_COMFORT => {
                m.grief *= 1.0 - frac; // consoles the bereaved
                m.fear *= 1.0 - 0.5 * frac;
                m.joy = m.joy.max(0.4 * frac);
            }
            DOMAIN_FORTUNE => {
                m.pride = m.pride.max(0.5 * frac); // smug, harmless (a market edge is a future hook)
            }
            DOMAIN_CRAFT => {
                m.pride = m.pride.max(0.4 * frac); // a proud craftsman (a yield bonus is a future hook)
            }
            _ => {}
        }
    }
}

// ── CONTRACTS: a deep god grafts its domain's ability onto its strongest believers (champions/prophets)
const CONTRACT_DEPTH: u16 = 5; // a god at least this deep can grant a contract.
const CONTRACT_CHAMPIONS: usize = 3; // up to this many believers per god are gifted.
pub const CONTRACT_EVERY: u32 = 90;

/// The ability a god of `domain` grants its champions (the catalog spec that fits its nature).
fn domain_ability(domain: u8) -> Option<u16> {
    use crate::abilities::*;
    Some(match domain {
        DOMAIN_SETTLEMENT => ID_SECOND_WIND, // a protector: self-heal + shield
        DOMAIN_WILD_SITE => ID_WHIRLWIND,    // a berserk fanatic
        DOMAIN_WAR => ID_POWER_STRIKE,       // a holy warrior
        DOMAIN_DREAD => ID_PLANT_RUMOR,      // a fearmonger
        DOMAIN_COMFORT => ID_SECOND_WIND,    // a healer
        DOMAIN_FORTUNE => ID_HAGGLE,         // a blessed dealmaker
        DOMAIN_CRAFT => ID_MASTER_CRAFT,     // a master artisan
        DOMAIN_DEATH => ID_FROST_BOLT,       // a reaper
        _ => return None,
    })
}

/// Grant each sufficiently-DEEP god's strongest believers (level desc, id asc) its domain ability — they
/// become champions/prophets who then wield it via the autocaster. Serial ⇒ deterministic; idempotent.
pub fn contracts(world: &mut World) {
    if world.tick % CONTRACT_EVERY != 0 || world.gods.is_empty() {
        return;
    }
    for gi in 0..world.gods.len() {
        let god = world.gods[gi];
        if god.depth < CONTRACT_DEPTH {
            continue;
        }
        let aid = match domain_ability(god.domain) {
            Some(a) => a,
            None => continue,
        };
        let gid = (gi + 1) as u8;
        let mut champs: Vec<(u8, usize)> = Vec::new();
        for i in 0..world.n {
            if is_faithful_candidate(world, i)
                && world.faith[i] == gid
                && !world.progression[i].abilities.iter().any(|&a| a == aid)
            {
                champs.push((world.level[i], i));
            }
        }
        champs.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        for &(_, i) in champs.iter().take(CONTRACT_CHAMPIONS) {
            crate::abilities::add_ability(&mut world.progression[i], aid);
        }
    }
}

/// Seed a starting flock in every town (not just town 0): a BOOT_FLOCK to the town's patron town-god (the
/// pantheon rotates by town so faiths spread out), plus a WILD_CULT_FLOCK to a wild god.
fn bootstrap(world: &mut World) {
    let nt = world.town_centers.len().max(1);
    let town_gods: Vec<u8> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.domain == DOMAIN_SETTLEMENT)
        .map(|(gi, _)| (gi + 1) as u8)
        .collect();
    let wild_gods: Vec<u8> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.domain == DOMAIN_WILD_SITE)
        .map(|(gi, _)| (gi + 1) as u8)
        .collect();
    // every OTHER god (war/dread/comfort/fortune/craft/death) gets a small starting cult too, so the
    // whole pantheon contends; spread/claim then grow whichever the world feeds.
    let other_gods: Vec<u8> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.domain != DOMAIN_SETTLEMENT && g.domain != DOMAIN_WILD_SITE)
        .map(|(gi, _)| (gi + 1) as u8)
        .collect();
    if town_gods.is_empty() {
        return;
    }
    let other_per_town = other_gods.len() * 2; // ~2 believers of each other-god seeded per town
    let mut town_n = vec![0usize; nt];
    let mut wild_n = vec![0usize; nt];
    let mut other_n = vec![0usize; nt];
    let mut other_rot = 0usize;
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) || world.faith[i] != NO_GOD {
            continue;
        }
        let t = (world.town[i] as usize).min(nt - 1);
        if town_n[t] < BOOT_FLOCK {
            world.faith[i] = town_gods[t % town_gods.len()];
            town_n[t] += 1;
        } else if !wild_gods.is_empty() && wild_n[t] < WILD_CULT_FLOCK {
            world.faith[i] = wild_gods[t % wild_gods.len()];
            wild_n[t] += 1;
        } else if !other_gods.is_empty() && other_n[t] < other_per_town {
            world.faith[i] = other_gods[other_rot % other_gods.len()];
            other_rot += 1;
            other_n[t] += 1;
        }
    }
}

/// DOMAIN-DRIVEN CONVERSION: a FAITHLESS soul living an experience is drawn to the god of that experience
/// — a fighter to the war god, the frightened to the dread god, the rich to fortune, the bereaved to
/// comfort, a tradesman to his craft's patron. So a condition/activity god recruits from its own domain
/// (the niche the generic neighbour-spread can't give it). Settlement + wild gods recruit by their own
/// passes; this covers the rest. Chance rises with the god's power. Deterministic (id order + faith_rng).
fn domain_draw(world: &mut World, power: &[usize]) {
    let meta: Vec<(usize, f32)> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| {
            g.domain != DOMAIN_SETTLEMENT && g.domain != DOMAIN_WILD_SITE && g.domain != NO_GOD
        })
        .map(|(gi, _)| (gi + 1, power[gi + 1] as f32))
        .collect();
    if meta.is_empty() {
        return;
    }
    let mut conv: Vec<(usize, u8)> = Vec::new();
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) || world.faith[i] != NO_GOD {
            continue; // only the unaffiliated are drawn (no faith-stealing here)
        }
        for &(gid, flock) in &meta {
            if in_domain(world, i, &world.gods[gid - 1]) {
                let chance = (CLAIM_BASE + flock.sqrt() * CLAIM_POWER_BONUS).min(CLAIM_CHANCE_MAX);
                if world.faith_rng.next_f32() < chance {
                    conv.push((i, gid as u8));
                }
                break; // one draw per soul (the lowest-id domain it qualifies for)
            }
        }
    }
    for (i, g) in conv {
        world.faith[i] = g;
    }
}

/// A believer out in the wild (beyond every town's edge) may convert to the nearest wild god (chance
/// rises with the god's power). It can take the faithless and the town-faithful alike. This is how wild
/// faith first appears; the convert then carries it home where it can spread.
fn wild_claim(world: &mut World, power: &[usize]) {
    let seats: Vec<(usize, [f32; 2], f32)> = world
        .gods
        .iter()
        .enumerate()
        .filter(|(_, g)| g.domain == DOMAIN_WILD_SITE)
        .map(|(gi, g)| (gi + 1, g.seat.unwrap_or([0.0, 0.0]), power[gi + 1] as f32))
        .collect();
    if seats.is_empty() {
        return;
    }
    let mut claims: Vec<(usize, u8)> = Vec::new();
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) {
            continue;
        }
        let p = world.pos[i];
        let in_wild = world
            .town_centers
            .iter()
            .all(|c| (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) > WILD_EDGE2);
        if !in_wild {
            continue;
        }
        // nearest wild-god seat (closest, then lowest id).
        let mut best: Option<(usize, f32, f32)> = None;
        for &(gid, home, flock) in &seats {
            let dx = p[0] - home[0];
            let dz = p[1] - home[1];
            let d2 = dx * dx + dz * dz;
            match best {
                Some((_, bd, _)) if d2 >= bd => {}
                _ => best = Some((gid, d2, flock)),
            }
        }
        let Some((gid, _, flock)) = best else { continue };
        if world.faith[i] as usize == gid {
            continue;
        }
        let chance = (CLAIM_BASE + flock.sqrt() * CLAIM_POWER_BONUS).min(CLAIM_CHANCE_MAX);
        if world.faith_rng.next_f32() < chance {
            claims.push((i, gid as u8));
        }
    }
    for (i, g) in claims {
        world.faith[i] = g;
    }
}

/// Each faithless townsperson may adopt the locally dominant faith among its near neighbours. Decide
/// against the frozen faith column, then apply, so neighbour reads are order-independent.
fn spread(world: &mut World, power: &[usize]) {
    let n_gods = world.gods.len();
    let mut adoptions: Vec<(usize, u8)> = Vec::new();
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) || world.faith[i] != NO_GOD {
            continue;
        }
        let mut local = vec![0usize; n_gods + 1];
        let [x, z] = world.pos[i];
        world.grid.for_near(x, z, |p| {
            let j = p.id as usize;
            if j == i || j >= world.n || p.flags & 1 == 0 {
                return; // self, a percept (id >= n), or the dead.
            }
            let g = world.faith[j] as usize;
            if g == NO_GOD as usize || g > n_gods {
                return;
            }
            let dx = p.x - x;
            let dz = p.z - z;
            if dx * dx + dz * dz <= CONVERT_RANGE2 {
                local[g] += 1;
            }
        });
        let mut best_god: u8 = NO_GOD;
        let mut best_n = 0usize;
        for g in 1..=n_gods {
            if local[g] > best_n {
                best_n = local[g];
                best_god = g as u8;
            }
        }
        // one roll per eligible agent (drawn before the no-neighbour early-out, so draw count is stable).
        let roll = world.faith_rng.next_f32();
        if best_god == NO_GOD {
            continue;
        }
        let flock = power[best_god as usize] as f32;
        let chance = (CONVERT_CHANCE + flock.sqrt() * POWER_CONVERT_BONUS).min(CONVERT_CHANCE_MAX);
        if roll < chance {
            adoptions.push((i, best_god));
        }
    }
    for (i, g) in adoptions {
        world.faith[i] = g;
    }
}

/// Believers lapse to NO_GOD at random. Crowding raises the rate for a large god; a small god's last
/// believers are protected (running live count). Wild-god faith lapses slowly in the wild, fast in town.
fn doubt(world: &mut World, power: &[usize]) {
    let n_gods = world.gods.len();
    let mut live: Vec<usize> = power.to_vec();
    for i in 0..world.n {
        if !is_faithful_candidate(world, i) {
            continue;
        }
        let g = world.faith[i] as usize;
        if g == NO_GOD as usize || g > n_gods {
            continue;
        }
        if live[g] <= SMALL_GOD_AT {
            continue;
        }
        let mut lapse = DOUBT_CHANCE * (1.0 + power[g] as f32 / CROWD_DOUBT_AT);
        if world.gods[g - 1].domain == DOMAIN_WILD_SITE {
            let p = world.pos[i];
            let in_town = world
                .town_centers
                .iter()
                .any(|c| (p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) <= WILD_EDGE2);
            lapse *= if in_town { WILD_LAPSE_TOWN } else { WILD_LAPSE_OUT };
        }
        if world.faith_rng.next_f32() < lapse {
            world.faith[i] = NO_GOD;
            live[g] -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Faction, NO_GOD};
    use crate::hash::world_hash;
    use crate::world::World;

    fn power_of(w: &World, g: u8) -> usize {
        (0..w.n)
            .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8 && w.faith[i] == g)
            .count()
    }

    #[test]
    fn worldgen_seats_town_and_wild_gods() {
        let w = World::spawn(0x60D5, 5000);
        let town = w.gods.iter().filter(|g| g.domain == DOMAIN_SETTLEMENT).count();
        let wild = w.gods.iter().filter(|g| g.domain == DOMAIN_WILD_SITE).count();
        assert!(town >= 1, "town gods are seated in the towns");
        assert!(wild >= 1, "wild gods are seated at wilderness sites");
    }

    #[test]
    fn bootstrap_then_faith_takes_hold() {
        let mut w = World::spawn(0x_FA17, 400);
        let town_ids: Vec<u8> = w
            .gods
            .iter()
            .enumerate()
            .filter(|(_, g)| g.domain == DOMAIN_SETTLEMENT)
            .map(|(gi, _)| (gi + 1) as u8)
            .collect();
        assert_eq!(town_ids.iter().map(|&g| power_of(&w, g)).sum::<usize>(), 0);
        for _ in 0..240 {
            w.tick();
        }
        let total: usize = town_ids.iter().map(|&g| power_of(&w, g)).sum();
        assert!(total >= BOOT_FLOCK, "a town faith must take hold (got {total} believers)");
    }

    #[test]
    fn a_wild_god_claims_a_soul_in_the_wild() {
        let mut w = World::spawn(0x6104, 400);
        let (gid, seat) = w
            .gods
            .iter()
            .enumerate()
            .find(|(_, g)| g.domain == DOMAIN_WILD_SITE)
            .map(|(gi, g)| (gi + 1, g.seat.unwrap_or([0.0, 0.0])))
            .expect("a wild god is seated");
        let stray = (0..w.n)
            .find(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8)
            .unwrap();
        w.pos[stray] = seat; // out in the wild at the god's seat
        w.faith[stray] = NO_GOD;
        let mut power = vec![0usize; w.gods.len() + 1];
        power[gid] = 30; // an existing flock, so the claim chance is meaningful
        let mut claimed = false;
        for _ in 0..400 {
            wild_claim(&mut w, &power);
            if w.faith[stray] as usize == gid {
                claimed = true;
                break;
            }
        }
        assert!(claimed, "a soul out in the wild near a wild god is claimed");
    }

    #[test]
    fn a_dominant_faith_spreads_to_a_neighbour() {
        let mut w = World::spawn(0x_C0FFEE, 60);
        for i in 0..w.n {
            w.faith[i] = NO_GOD;
        }
        let towns: Vec<usize> = (0..w.n)
            .filter(|&i| w.alive[i] && w.faction[i] == Faction::Townsfolk as u8)
            .take(12)
            .collect();
        assert!(towns.len() >= 6, "need a handful of townsfolk for the cluster");
        let target = *towns.last().unwrap();
        for &i in &towns {
            w.pos[i] = [0.0, 0.0];
        }
        let g1 = w.gods.iter().position(|g| g.domain == DOMAIN_SETTLEMENT).map(|p| (p + 1) as u8).unwrap();
        for &i in &towns[..towns.len() - 1] {
            w.faith[i] = g1;
        }
        w.build_surface();
        let power = tally(&w);
        assert!(power[g1 as usize] >= 5, "the local flock must be sizable");
        let mut converted = false;
        for _ in 0..200 {
            spread(&mut w, &power);
            if w.faith[target] == g1 {
                converted = true;
                break;
            }
        }
        assert!(converted, "a faithless soul amid a dominant flock should convert");
    }

    #[test]
    fn faith_is_deterministic() {
        let run = || {
            let mut w = World::spawn(0x_DEED, 300);
            for _ in 0..150 {
                w.tick();
            }
            world_hash(&w)
        };
        assert_eq!(run(), run(), "faith must be run-to-run deterministic");
    }
}
