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
//! wild = reckless, etc.), `recruit` (a deep god offers a boon — a catalog ability — as a signing bonus
//! to win a goal-aligned follower, who converts and keeps it), and `collect_tithes` (a contracted
//! follower pays an ongoing tithe scaled by boon-strength x greed; gold → shrine_fund, conserved).
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
        if !god.active || !in_domain(world, i, &god) {
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

// ── CONTRACTS / RECRUITMENT: a god grants a boon as a SIGNING BONUS to win a follower whose goal serves
// it. The follower keeps the boon. Cost (an ongoing tithe) scales with the boon's strength x the god's
// greed, discounted by how well the follower serves the god — an aligned follower is cheap (its deeds pay).
pub const RECRUIT_EVERY: u32 = 120;
const RECRUIT_MIN_DEPTH: u16 = 4;
const RECRUIT_PER_POWER: u32 = 1400; // a god recruits one per this much power...
const RECRUIT_CAP: usize = 2; // ...up to this many per pass.
const FIT_MIN: f32 = 7.5; // a candidate must score at least this to be worth courting.
const FIT_MAX: f32 = 16.0; // fitness at/above this = full alignment (the cheapest contract).
const POWER_PER_FIT: f32 = 14.0; // boon strength per fitness point.
pub const TITHE_EVERY: u32 = 30;
const TITHE_DIVISOR: i64 = 4000;
const BEAT_CONTRACT: u8 = 72;
const BOON_SECOND_AT: u16 = 160; // a contract this strong invests a SECOND domain ability.
const BOON_BESPOKE_AT: u16 = 130; // ...and at least this strong + a shared grand goal earns a bespoke boon.
const BESPOKE_MASTERY: f32 = 0.85; // a craft god firms an aspiring smith's recipe to (at least) this.

/// A catalog ability the god of `domain` can grant, picked to fit the candidate (a small per-domain pool).
fn pool_ability(domain: u8, w: &World, i: usize) -> Option<u16> {
    use crate::abilities::*;
    let lvl = w.level[i];
    Some(match domain {
        DOMAIN_WAR => {
            if lvl >= 8 {
                ID_POWER_STRIKE
            } else if w.personality[i].aggression > 0.6 {
                ID_WHIRLWIND
            } else {
                ID_CLEAVING_BLOW
            }
        }
        DOMAIN_WILD_SITE => if w.personality[i].aggression > 0.5 { ID_WHIRLWIND } else { ID_FROST_BOLT },
        DOMAIN_DEATH => ID_FROST_BOLT,
        DOMAIN_DREAD => ID_PLANT_RUMOR,
        DOMAIN_FORTUNE => ID_HAGGLE,
        DOMAIN_CRAFT => ID_MASTER_CRAFT,
        DOMAIN_COMFORT | DOMAIN_SETTLEMENT => ID_SECOND_WIND,
        _ => return None,
    })
}

/// A SECOND ability a god of `domain` invests in a strong recruit (distinct from the primary pool).
fn secondary_ability(domain: u8) -> Option<u16> {
    use crate::abilities::*;
    Some(match domain {
        DOMAIN_WAR => ID_SECOND_WIND,     // a holy warrior who endures
        DOMAIN_WILD_SITE => ID_WHIRLWIND, // a fanatic who flails
        DOMAIN_DEATH => ID_EXPOSE_WEAKNESS,
        DOMAIN_DREAD => ID_READ_MIND,
        DOMAIN_FORTUNE => ID_SILVER_TONGUE,
        DOMAIN_CRAFT => ID_SECOND_WIND, // endurance to keep at the forge
        DOMAIN_COMFORT | DOMAIN_SETTLEMENT => ID_SILVER_TONGUE,
        _ => return None,
    })
}

/// Does god `domain` share candidate `i`'s GRAND GOAL (its ambition)? Such a soul gets a bespoke boon —
/// the god directly advances the very thing it already wants.
fn shares_grand_goal(domain: u8, ambition: u8) -> bool {
    use crate::components::{AMB_MASTERY, AMB_RENOWN, AMB_WANDERLUST, AMB_WEALTH};
    matches!(
        (domain, ambition),
        (DOMAIN_CRAFT, AMB_MASTERY)
            | (DOMAIN_WAR, AMB_RENOWN)
            | (DOMAIN_WILD_SITE, AMB_WANDERLUST)
            | (DOMAIN_FORTUNE, AMB_WEALTH)
    )
}

/// Grant candidate `i` the BOONS of a contract with god `g` at the given `power` — a signing bonus the
/// follower keeps. A bigger contract (a god that wants the soul more) grants more: the primary domain
/// ability always; a SECOND ability for a strong boon; and a BESPOKE boon when the follower's grand goal is
/// one the god shares — directly advancing it (a craft god firms an aspiring smith's mastery; a war god
/// grants its apex strike). Conserved: abilities + recipe skill only, never minted gold. Deterministic.
fn grant_boons(w: &mut World, i: usize, g: &God, power: u16) {
    use crate::abilities::*;
    if let Some(a) = pool_ability(g.domain, w, i) {
        add_ability(&mut w.progression[i], a);
    }
    if power >= BOON_SECOND_AT {
        if let Some(a) = secondary_ability(g.domain) {
            add_ability(&mut w.progression[i], a);
        }
    }
    if power >= BOON_BESPOKE_AT && shares_grand_goal(g.domain, w.ambition[i]) {
        match g.domain {
            // The smith's grand goal IS mastery; the god simply grants it (firms the recipe to master).
            DOMAIN_CRAFT => {
                if let Some(good) = crate::world::prof_good(w.profession[i]) {
                    w.recipe[i][good] = w.recipe[i][good].max(BESPOKE_MASTERY);
                }
            }
            // A renown-seeking warrior, a wanderer, a wealth-seeker get the apex tool for their road.
            DOMAIN_WAR => add_ability(&mut w.progression[i], ID_POWER_STRIKE),
            DOMAIN_WILD_SITE => add_ability(&mut w.progression[i], ID_FROST_BOLT),
            DOMAIN_FORTUNE => add_ability(&mut w.progression[i], ID_EXPOSE_WEAKNESS),
            _ => {}
        }
    }
}

/// How much god `g` WANTS candidate `i` — how well its nature (behaviour profile), goal (ambition), and
/// strength serve the god's domain. Higher = courted harder, cheaper + stronger boon.
fn fitness(w: &World, i: usize, g: &God) -> f32 {
    use crate::tags::Tag;
    let p = w.personality[i];
    let bp = &w.progression[i].behavior_profile;
    let lvl = w.level[i] as f32;
    let bt = |t: Tag| bp[t as usize];
    let mut s = match g.domain {
        DOMAIN_WAR => bt(Tag::Melee) + bt(Tag::Kill) + bt(Tag::Risk) + p.aggression * 6.0 + lvl * 0.3,
        DOMAIN_WILD_SITE => p.risk_tolerance * 6.0 + p.aggression * 4.0,
        DOMAIN_DEATH => bt(Tag::Kill) * 1.5 + p.aggression * 3.0,
        DOMAIN_DREAD => p.aggression * 2.0 + bt(Tag::Deceive) * 2.0,
        DOMAIN_FORTUNE => w.wealth[i] as f32 / 6000.0 + bt(Tag::Trade) + bt(Tag::Profit) + p.ambition * 6.0,
        DOMAIN_CRAFT => {
            if w.profession[i] == g.domain_param as u8 {
                let good = crate::world::prof_good(w.profession[i]).unwrap_or(0);
                w.recipe[i][good] * 8.0 + bt(Tag::Crafting) + p.ambition * 3.0
            } else {
                0.0
            }
        }
        DOMAIN_COMFORT => p.altruism * 7.0,
        DOMAIN_SETTLEMENT => {
            if (w.town[i] as i16) == g.home_town {
                lvl * 0.4 + p.social_drive * 3.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    };
    s += match (g.domain, w.ambition[i]) {
        (DOMAIN_FORTUNE, x) if x == crate::components::AMB_WEALTH => 5.0,
        (DOMAIN_CRAFT, x) if x == crate::components::AMB_MASTERY => 5.0,
        (DOMAIN_WILD_SITE, x) if x == crate::components::AMB_WANDERLUST => 4.0,
        _ => 0.0,
    };
    s
}

/// How OPEN candidate `i` is to a divine bargain — desperation (poverty/fear/grief/hunger) + ambition,
/// less contentment (joy). A desperate or ambitious soul takes a costly deal; a content one refuses.
fn openness(w: &World, i: usize) -> f32 {
    let p = w.personality[i];
    let m = w.mood[i];
    let poverty = (1.0 - w.wealth[i] as f32 / 60000.0).max(0.0);
    let hungry = (1.0 - w.needs[i].hunger).max(0.0);
    (poverty + m.fear + m.grief + hungry) * 2.0 + (p.ambition + p.risk_tolerance) * 3.0 - m.joy * 2.0
}

/// RECRUIT: each god courts the candidates it most wants (uncontracted; scored by fitness), offering a boon
/// as a signing bonus. A candidate accepts if its openness covers the cost (boon strength x greed, minus
/// alignment); on accept it CONVERTS to the god and keeps the boon. Serial ⇒ deterministic.
pub fn recruit(world: &mut World) {
    if world.tick % RECRUIT_EVERY != 0 || world.gods.is_empty() {
        return;
    }
    for gi in 0..world.gods.len() {
        let g = world.gods[gi];
        if !g.active || g.depth < RECRUIT_MIN_DEPTH {
            continue;
        }
        let gid = (gi + 1) as u16;
        let cap = ((g.power() / RECRUIT_PER_POWER) as usize).clamp(1, RECRUIT_CAP);
        let mut cands: Vec<(f32, usize)> = Vec::new();
        for i in 0..world.n {
            if !is_faithful_candidate(world, i) || world.contract_god[i] != 0 || world.faith[i] as u16 == gid {
                continue;
            }
            let fit = fitness(world, i, &g);
            if fit >= FIT_MIN {
                cands.push((fit, i));
            }
        }
        cands.sort_by(|a, b| {
            b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1))
        });
        let mut made = 0usize;
        for (fit, i) in cands {
            if made >= cap {
                break;
            }
            let power = (fit * POWER_PER_FIT).clamp(10.0, u16::MAX as f32) as u16;
            let alignment = (fit / FIT_MAX).min(1.0);
            let cost = power as f32 * (g.greed as f32 / 255.0) * (1.0 - alignment);
            if openness(world, i) >= cost {
                world.contract_god[i] = gid;
                world.contract_power[i] = power;
                world.faith[i] = gid as u8;
                grant_boons(world, i, &g, power);
                world.chronicle.push(crate::components::Beat {
                    t: world.tick,
                    kind: BEAT_CONTRACT,
                    subject: i as u32,
                    magnitude: gid as i32,
                });
                made += 1;
            }
        }
    }
}

// ── RELIEF: the temple's accumulated tithes (shrine_fund) flow back out as alms to the neediest faithful.
// A god has an interest in keeping its flock alive (a starved believer is lost power), so the pantheon
// redistributes: the rich faithful are taxed (tithe), the destitute faithful are relieved. Gold-conserved
// (shrine_fund → believer gold), so faith becomes a counter-cyclical buffer over the marginal economy.
pub const RELIEF_EVERY: u32 = 60;
const RELIEF_NEED_GOLD: i64 = 150; // a believer below this gold is in need.
const RELIEF_GRANT: i64 = 120; // alms paid per needy believer per pass.

/// Disburse shrine_fund as alms to the destitute faithful (lowest first by roster order). Serial ⇒
/// deterministic; conserved (fund → gold). Stops when the fund is empty.
pub fn divine_relief(world: &mut World) {
    if world.tick % RELIEF_EVERY != 0 || world.shrine_fund <= 0 {
        return;
    }
    for i in 0..world.n {
        if world.shrine_fund <= 0 {
            break;
        }
        if !is_faithful_candidate(world, i) || world.faith[i] == 0 {
            continue;
        }
        if world.econ[i].gold < RELIEF_NEED_GOLD {
            let grant = RELIEF_GRANT.min(world.shrine_fund);
            world.econ[i].gold += grant;
            world.shrine_fund -= grant;
        }
    }
}

/// Contracted followers pay an ongoing TITHE to their god (gold → shrine_fund, conserved), scaled by the
/// boon's strength and the god's greed. A generous god (greed 0) takes nothing. If the god has DIED, the
/// bargain lapses (the boon is kept). Serial ⇒ deterministic.
pub fn collect_tithes(world: &mut World) {
    if world.tick % TITHE_EVERY != 0 {
        return;
    }
    for i in 0..world.n {
        let cg = world.contract_god[i] as usize;
        if cg == 0 || cg > world.gods.len() {
            continue;
        }
        if !world.gods[cg - 1].active {
            world.contract_god[i] = 0;
            continue;
        }
        let greed = world.gods[cg - 1].greed as i64;
        let tithe = (world.contract_power[i] as i64 * greed) / TITHE_DIVISOR;
        let pay = tithe.min(world.econ[i].gold);
        if pay > 0 {
            world.econ[i].gold -= pay;
            world.shrine_fund += pay;
        }
    }
}

/// Seed a starting flock in every town: a BOOT_FLOCK to the town's OWN patron god (each town has one),
/// a WILD_CULT_FLOCK to a wild god, and a small cult to each other god.
fn bootstrap(world: &mut World) {
    let nt = world.town_centers.len().max(1);
    // god id for each town (its own settlement patron).
    let town_god = town_god_ids(world, nt);
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
        if town_n[t] < BOOT_FLOCK && town_god[t] != NO_GOD {
            world.faith[i] = town_god[t];
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

// ── BIRTH & DEATH: gods are made and unmade by belief ──
pub const FAITH_LIFE_EVERY: u32 = 60;
const PANTHEON_CAP: usize = 48; // hard ceiling on the registry (recycle dead slots before growing past it).
const BIRTH_IN_DOMAIN: usize = 40; // a forgotten condition-domain reborn once this many faithless are in it.
const BEAT_GOD_BORN: u8 = 70;
const BEAT_GOD_DIED: u8 = 71;

/// god id (1-based) of each town's OWN active settlement patron — NO_GOD if it has none (e.g. died).
fn town_god_ids(world: &World, nt: usize) -> Vec<u8> {
    let mut m = vec![NO_GOD; nt];
    for (gi, g) in world.gods.iter().enumerate() {
        if g.active && g.domain == DOMAIN_SETTLEMENT && g.home_town >= 0 && (g.home_town as usize) < nt {
            m[g.home_town as usize] = (gi + 1) as u8;
        }
    }
    m
}

/// A god DIES: it is forgotten. Its slot goes inert (recyclable), its remaining believers lapse to
/// faithless, and the death is chronicled. `gi` is the 0-based registry index.
fn kill_god(world: &mut World, gi: usize) {
    let gid = (gi + 1) as u8;
    for i in 0..world.n {
        if world.faith[i] == gid {
            world.faith[i] = NO_GOD; // its faithful are bereft
        }
    }
    let g = &mut world.gods[gi];
    g.active = false;
    g.believers = 0;
    g.breadth = 0;
    g.depth = 0;
    world.chronicle.push(crate::components::Beat {
        t: world.tick,
        kind: BEAT_GOD_DIED,
        subject: gid as u32,
        magnitude: world.gods[gi].domain as i32,
    });
}

/// Bring a NEW god into being — recycling the first inert slot, or appending if there is room. Returns the
/// 1-based id, or NO_GOD if the pantheon is full of living gods.
fn birth_god(world: &mut World, god: God) -> u8 {
    let slot = world.gods.iter().position(|g| !g.active);
    let gi = match slot {
        Some(s) => {
            world.gods[s] = god;
            s
        }
        None if world.gods.len() < PANTHEON_CAP => {
            world.gods.push(god);
            world.gods.len() - 1
        }
        None => return NO_GOD,
    };
    world.chronicle.push(crate::components::Beat {
        t: world.tick,
        kind: BEAT_GOD_BORN,
        subject: (gi + 1) as u32,
        magnitude: world.gods[gi].domain as i32,
    });
    (gi + 1) as u8
}

/// Make and unmake gods by belief (serial society pass): a settlement god DIES when its town empties out
/// and is BORN anew if a dead town refills; a condition god dies when forgotten (believers gone) and is
/// reborn from belief when its domain teems with the faithless but has no patron. So the pantheon is open.
pub fn birth_and_death(world: &mut World) {
    if world.tick % FAITH_LIFE_EVERY != 0 || world.gods.is_empty() {
        return;
    }
    let nt = world.town_centers.len().max(1);
    let mut pop = vec![0usize; nt];
    for i in 0..world.n {
        if world.alive[i] && world.faction[i] == Faction::Townsfolk as u8 {
            pop[(world.town[i] as usize).min(nt - 1)] += 1;
        }
    }
    // DEATH — a settlement god whose town has died out, and any condition god whose believers are gone.
    for gi in 0..world.gods.len() {
        let g = world.gods[gi];
        if !g.active {
            continue;
        }
        let dead = match g.domain {
            DOMAIN_SETTLEMENT => g.home_town >= 0 && pop[(g.home_town as usize).min(nt - 1)] == 0,
            DOMAIN_WILD_SITE => false, // wild gods endure at their lair
            _ => g.believers == 0, // a forgotten condition god dies
        };
        if dead {
            kill_god(world, gi);
        }
    }
    // BIRTH — a populated town with no patron (refounded) gets a new settlement god.
    for t in 0..nt {
        if pop[t] == 0 {
            continue;
        }
        let has = world.gods.iter().any(|g| g.active && g.domain == DOMAIN_SETTLEMENT && g.home_town == t as i16);
        if !has {
            let greed = (world.faith_rng.next_f32() * world.faith_rng.next_f32() * 200.0) as u8;
            let seat = Some(world.town_centers[t]);
            birth_god(
                world,
                God {
                    domain: DOMAIN_SETTLEMENT,
                    breadth: pop[t].min(u16::MAX as usize) as u16,
                    depth: 2,
                    seat,
                    home_town: t as i16,
                    domain_param: 0,
                    believers: 0,
                    active: true,
                    greed,
                },
            );
        }
    }
    // BIRTH — a condition domain that teems with the faithless but has no living god coalesces one.
    let cond: &[(u8, u16)] = &[
        (DOMAIN_WAR, 0),
        (DOMAIN_DREAD, 0),
        (DOMAIN_COMFORT, 0),
        (DOMAIN_FORTUNE, 0),
        (DOMAIN_DEATH, 0),
    ];
    for &(domain, param) in cond {
        if world.gods.iter().any(|g| g.active && g.domain == domain) {
            continue; // already served
        }
        let mut probe = God { domain, breadth: 0, depth: 1, seat: None, home_town: -1, domain_param: param, believers: 0, active: true, greed: 0 };
        let n_in: usize = (0..world.n)
            .filter(|&i| is_faithful_candidate(world, i) && world.faith[i] == NO_GOD && in_domain(world, i, &probe))
            .count();
        if n_in >= BIRTH_IN_DOMAIN {
            probe.greed = (world.faith_rng.next_f32() * world.faith_rng.next_f32() * 200.0) as u8;
            birth_god(world, probe);
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
            g.active && g.domain != DOMAIN_SETTLEMENT && g.domain != DOMAIN_WILD_SITE
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
        // ANCHORED gods (a town patron, a wild lair) smoulder — their last believers are protected so a
        // dip doesn't extinguish them. CONDITION gods are NOT protected: they can lapse fully to nothing
        // and DIE (birth_and_death then clears the slot), to be reborn from belief later.
        let anchored = matches!(world.gods[g - 1].domain, DOMAIN_SETTLEMENT | DOMAIN_WILD_SITE);
        if anchored && live[g] <= SMALL_GOD_AT {
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
    fn a_settlement_god_dies_when_its_town_dies_out() {
        let mut w = World::spawn(0x60D, 600);
        let gid = w
            .gods
            .iter()
            .position(|g| g.active && g.domain == DOMAIN_SETTLEMENT && g.home_town == 0)
            .map(|p| (p + 1) as u8)
            .expect("town 0 has a patron god");
        // the town dies out — every one of its residents falls.
        for i in 0..w.n {
            if w.town[i] == 0 && w.faction[i] == Faction::Townsfolk as u8 {
                w.alive[i] = false;
            }
        }
        w.tick = FAITH_LIFE_EVERY; // align the cadence
        birth_and_death(&mut w);
        // the town-0 settlement god is GONE (its death is chronicled). Its slot may have been recycled
        // into a newly-born god, so assert by IDENTITY (no active settlement god for the dead town), not
        // by the slot's flag.
        let has_town0_god =
            w.gods.iter().any(|g| g.active && g.domain == DOMAIN_SETTLEMENT && g.home_town == 0);
        assert!(!has_town0_god, "a town's god dies when the town dies out");
        assert!(
            w.chronicle.iter().any(|b| b.kind == BEAT_GOD_DIED && b.subject == gid as u32),
            "the god's death is chronicled"
        );
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
