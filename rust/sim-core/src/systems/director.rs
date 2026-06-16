//! FAN-OUT UNIT: director (drama manager). Ports the SPIRIT of the `js/sim/director/*` cluster — a
//! POINTS-BUDGET TROPE ENGINE that reads world-state on a slow throttle and spends a drama budget to
//! inject situations the existing systems propagate into story. Ported to its spirit, not its 20
//! tropes (doc 22 §9). Four tropes, each chosen to LIGHT a dormant emergent loop:
//!
//!   RAID        — when the world is QUIET, spawn a wave of `Faction::Raider` on the fringe, each set
//!                 on a moving Fight at a believed-juicy townsperson. The difficulty curve + the
//!                 anti-massacre valve in one rule. Raiders carry ZERO gold (spawning never mints).
//!   FEUD        — the SPARK that ignites combat (the base sim sets no hostile beliefs, so without a
//!                 spark nobody ever fights). Seed a MUTUAL grudge in two townsfolk — a hostile belief
//!                 AND an `assaulted` memory in EACH about the other — so BOTH derive an avenge goal
//!                 (decide/planner), hunt each other down, and a real vendetta plays out. Belief/memory
//!                 only; the violence EMERGES.
//!   OPPORTUNITY — plant a `windfall` memory in a few idle townsfolk ⇒ they derive a seek-fortune goal
//!                 (sell surplus at market). Information as a resource; ties the director to the GOAP.
//!   CRISIS      — a transient scarcity nudge: raise a commodity's PRICE BELIEF across the town.
//!
//! BUDGET + PACING: points accrue with prosperity (town population) each eval and are drained by
//! deaths; a trope spends points. Tension tracks living attackers; a high-tension PEAK that resolves
//! opens a RELIEF window during which no new drama fires (the post-crisis breather).
//!
//! Determinism: SERIAL society phase ⇒ trivially M-invariant. World-level rolls via `world.sim_rng`
//! (never per-entity rng). CONSERVATION: spawned raiders carry 0 gold; no trope mints money.

use crate::components::{
    Beat, BeliefTable, Episode, EpisodeKind, Faction, Goal, PersonBelief, Profession, BELIEF_CAP,
};
use crate::world::World;

/// How often the director wakes to consider drama (it should be sparse).
const EVAL_EVERY: u32 = 120;
/// Minimum ticks between ANY two tropes (the global drama cooldown).
const TROPE_COOLDOWN: u32 = 240;
/// Minimum ticks between raids specifically.
const RAID_COOLDOWN: u32 = 360;
/// Ticks of suppressed drama after a high-tension peak resolves (the breather).
const RELIEF_TICKS: u32 = 300;
/// The world is "quiet" (ripe for a raid) when at most this many attackers are alive.
const QUIET_THRESHOLD: usize = 1;
/// Living-attacker count that counts as a tension PEAK (a resolved peak opens relief).
const TENSION_PEAK: f32 = 3.0;

/// Wave size — how many raiders descend on the town.
const WAVE_SIZE: usize = 4;
/// Raiders spawn on a ring this far beyond the town radius (the "fringe").
const TOWN_RADIUS: f32 = 180.0;
const FRINGE_MARGIN: f32 = 60.0;
/// Threat cue stamped on a freshly-spawned raider (so townsfolk perceive them as dangerous).
const RAID_THREAT: u16 = 7000;

/// Budget tuning: points per living townsperson each eval, points drained per death, and the cap.
const ACCRUE_PER_POP: i64 = 1;
const DEATH_DRAIN: i64 = 4;
const POINTS_CAP: i64 = 240;
/// Trope costs (drama spends the budget).
const COST_RAID: i64 = 60;
const COST_FEUD: i64 = 25;
const COST_OPPORTUNITY: i64 = 12;
const COST_CRISIS: i64 = 12;

/// How many idle townsfolk an OPPORTUNITY blesses with a windfall rumour.
const OPPORTUNITY_K: usize = 3;
/// Confidence stamped on a director-seeded belief (a believed grievance, not a fresh sighting).
const SEED_CONF: u16 = 55_000;
/// Salience of a seeded feud grudge / a planted windfall (drives intention priority + memory survival).
const FEUD_SALIENCE: u16 = 52_000;
const WINDFALL_SALIENCE: u16 = 40_000;

/// BeatKinds (interned; raid is shared with the chronicle's `BEAT_RAID`, the rest are director-local).
const BEAT_RAID: u8 = 2;
const BEAT_FEUD: u8 = 10;
const BEAT_OPPORTUNITY: u8 = 11;
const BEAT_CRISIS: u8 = 12;

/// A vendetta that has traded this many blows is a real, hardened feud — ripe to ESCALATE.
const ESCALATE_BEATS: u16 = 3;

/// A townsperson of this rank is a NOTABLE worth guarding (the bodyguard's principal).
const BODYGUARD_VIP_LEVEL: u8 = 8;
/// A capable protector is at least this level.
const BODYGUARD_MIN_LEVEL: u8 = 5;
/// The protector must be within this distance of the principal to be assigned.
const BODYGUARD_RANGE2: f32 = 40.0 * 40.0;
/// The `role` code for a bodyguard (mirrors `world.role`).
const ROLE_BODYGUARD: u8 = 4;

/// ENLIST BODYGUARDS (the director's bodyguard role machinery): a NOTABLE townsperson (high rank) with
/// no protector is assigned a capable, unattached nearby townsperson as a bodyguard. The assignment is
/// just `band_leader = principal` + the `ROLE_BODYGUARD` mark — so the EXISTING warband-rally (decide's
/// 2c) makes the bodyguard converge on the principal's foe IN COMBAT, with NO peacetime cost (the rally
/// is combat-only; in peace the bodyguard works its own trade). Serial id-order ⇒ deterministic.
pub fn enlist_bodyguards(world: &mut World) {
    use crate::components::NO_BAND;
    for vip in 0..world.n {
        if !world.alive[vip]
            || world.faction[vip] != Faction::Townsfolk as u8
            || world.level[vip] < BODYGUARD_VIP_LEVEL
            || world.band_leader[vip] != NO_BAND
        {
            continue; // not a free-standing notable in need of a guard
        }
        // already guarded? (someone follows this VIP) — then skip.
        if (0..world.n).any(|b| world.band_leader[b] == vip as i32 && world.role[b] == ROLE_BODYGUARD) {
            continue;
        }
        // find a capable, unattached nearby townsperson to stand guard (lowest id — deterministic).
        let vpos = world.pos[vip];
        for b in 0..world.n {
            if b == vip
                || !world.alive[b]
                || world.faction[b] != Faction::Townsfolk as u8
                || world.level[b] < BODYGUARD_MIN_LEVEL
                || world.band_leader[b] != NO_BAND
                || world.role[b] != 0
            {
                continue;
            }
            let dx = world.pos[b][0] - vpos[0];
            let dz = world.pos[b][1] - vpos[1];
            if dx * dx + dz * dz > BODYGUARD_RANGE2 {
                continue;
            }
            world.band_leader[b] = vip as i32; // follows + rallies to the principal (warband logic)
            world.role[b] = ROLE_BODYGUARD;
            break; // one guard per VIP per pass
        }
    }
}

/// ARC STEPPER (`director._advanceArcs` / `_stepReckoning`): advance open sagas toward their next beat.
/// The flagship reckoning: a long-burning personal VENDETTA between two souls of different houses
/// SPILLS into a dynastic HOUSE FEUD — the strife outgrows the two and their kin inherit it (lineage
/// then carries the grudge). Reads the SagaStore (observer) + sets a house feud (idempotent). Serial
/// id-order over the bounded registry ⇒ deterministic. The director's structured-narrative half, now
/// that the SagaStore exists for it to advance.
pub fn step_sagas(world: &mut World) {
    // Collect the escalations first (can't borrow `sagas` while mutating `house_feuds`).
    let mut feuds: Vec<(u32, u32)> = Vec::new();
    for s in &world.sagas.sagas {
        if s.status != 0 || s.kind != crate::sagas::SagaKind::Vendetta as u8 || s.beats < ESCALATE_BEATS {
            continue;
        }
        let (a, b) = (s.a as usize, s.b as usize);
        if a < world.n && b < world.n {
            let (ha, hb) = (world.house[a], world.house[b]);
            if ha != 0 && hb != 0 && ha != hb {
                feuds.push((ha, hb));
            }
        }
    }
    for (ha, hb) in feuds {
        crate::systems::houses::set_house_feud(world, ha, hb); // idempotent: a no-op if already feuding
    }
}

pub fn tick(world: &mut World) {
    // Throttle: only consider drama on the evaluation boundary.
    if world.tick == 0 || world.tick % EVAL_EVERY != 0 {
        return;
    }
    let now = world.tick;

    // ARC STEPPER: advance open sagas (a hardened vendetta spills into a house feud) before the
    // trope/raid logic, so a freshly-escalated feud is live material this same evaluation.
    step_sagas(world);
    // ROLE MACHINERY: a notable gains a bodyguard (combat-only follow ⇒ economy-safe).
    enlist_bodyguards(world);

    // ── pacing + budget bookkeeping (work on a Copy of the director state, write back at the end) ──
    let mut dir = world.director;

    let pop = town_pop(world);
    let attackers = attacker_count(world);

    // tension tracks peril; a high peak that resolves to quiet opens a relief breather.
    dir.tension = attackers as f32;
    let peak_resolved = dir.had_threat && attackers <= QUIET_THRESHOLD;
    if peak_resolved {
        dir.relief_until = now + RELIEF_TICKS;
    }
    dir.had_threat = attackers as f32 >= TENSION_PEAK;

    // budget: accrue with prosperity, drain on deaths since the last eval.
    if dir.last_pop < 0 {
        dir.last_pop = pop as i32;
    }
    let deaths = (dir.last_pop - pop as i32).max(0) as i64;
    dir.points += pop as i64 * ACCRUE_PER_POP - deaths * DEATH_DRAIN;
    dir.points = dir.points.clamp(0, POINTS_CAP);
    dir.last_pop = pop as i32;

    let quiet = attackers <= QUIET_THRESHOLD;

    // The RAID is the difficulty curve AND the anti-massacre valve, so it fires on quiet + its own
    // cooldown ALONE — it ignores the drama budget (a depopulated town can't accrue points yet still
    // needs the threat that repopulates the story) and the relief breather (relief is for manufactured
    // TOWN-side drama, not the recovery threat). Fired promptly so a victim still lives to be raided.
    if quiet && now.saturating_sub(dir.last_raid_at) >= RAID_COOLDOWN {
        do_raid(world, &mut dir, now);
    } else if !quiet {
        // A BUSY world ⇒ consider a town-side trope: gated by the relief breather, the global trope
        // cooldown, and the points budget; weighted by `sim_rng`.
        let suppressed =
            now < dir.relief_until || now.saturating_sub(dir.last_trope_at) < TROPE_COOLDOWN;
        if !suppressed {
            let r = world.sim_rng.next_f32();
            if dir.points >= COST_FEUD && r < 0.45 {
                do_feud(world, &mut dir, now);
            } else if dir.points >= COST_OPPORTUNITY && r < 0.75 {
                do_opportunity(world, &mut dir, now);
            } else if dir.points >= COST_CRISIS {
                do_crisis(world, &mut dir, now);
            }
        }
    }

    world.director = dir;
}

// ── tropes ───────────────────────────────────────────────────────────────────────────────────────

/// RAID — spawn a fringe wave set on a believed-juicy victim. Raiders carry 0 gold (conserved).
fn do_raid(world: &mut World, dir: &mut crate::components::DirectorState, now: u32) {
    let victim = wealthiest_townsperson(world);
    let victim_pos = victim.map(|v| world.pos[v as usize]).unwrap_or(world.town_center);
    let center = world.town_center;
    let mut spawned = 0usize;
    for _ in 0..WAVE_SIZE {
        let a = world.sim_rng.next_f32() * std::f32::consts::TAU;
        let r = TOWN_RADIUS + FRINGE_MARGIN + world.sim_rng.next_f32() * FRINGE_MARGIN;
        let pos = [center[0] + r * a.cos(), center[1] + r * a.sin()];
        let id = world.spawn_agent(pos, Faction::Raider, Profession::None);
        world.threat[id] = RAID_THREAT;
        world.goal[id] = match victim {
            Some(v) => Goal::Fight { target: v, to: victim_pos },
            None => Goal::Wander { to: center },
        };
        spawned += 1;
    }
    world.chronicle.push(Beat { t: now, kind: BEAT_RAID, subject: victim.unwrap_or(0), magnitude: spawned as i32 });
    // the raid is unbudgeted (the anti-massacre valve must work even at pop 0); it still arms the
    // cooldowns so it can't stack on itself.
    dir.last_trope_at = now;
    dir.last_raid_at = now;
    dir.raids += 1;
}

/// FEUD — seed a MUTUAL grudge in two townsfolk so BOTH hunt each other (the violence emerges through
/// the GOAP avenge loop). Belief + memory only — never a scripted single-victim reaction.
fn do_feud(world: &mut World, dir: &mut crate::components::DirectorState, now: u32) {
    let folk = living_townsfolk(world);
    if folk.len() < 2 {
        return;
    }
    let a = folk[(world.sim_rng.next_f32() * folk.len() as f32) as usize % folk.len()];
    // pick a distinct second principal.
    let mut b = folk[(world.sim_rng.next_f32() * folk.len() as f32) as usize % folk.len()];
    if b == a {
        b = folk[(a as usize + 1) % folk.len()].max(0); // deterministic fallback
        // ensure distinct: step through the list.
        if b == a {
            for &cand in &folk {
                if cand != a {
                    b = cand;
                    break;
                }
            }
        }
    }
    if a == b {
        return;
    }
    seed_grudge(world, a, b, now);
    seed_grudge(world, b, a, now);
    world.chronicle.push(Beat { t: now, kind: BEAT_FEUD, subject: a, magnitude: b as i32 });
    dir.points -= COST_FEUD;
    dir.last_trope_at = now;
    dir.feuds += 1;
}

/// OPPORTUNITY — plant a windfall rumour in a few townsfolk ⇒ they derive seek-fortune goals.
fn do_opportunity(world: &mut World, dir: &mut crate::components::DirectorState, now: u32) {
    let folk = living_townsfolk(world);
    if folk.is_empty() {
        return;
    }
    let mut blessed = 0usize;
    for _ in 0..OPPORTUNITY_K {
        let idx = (world.sim_rng.next_f32() * folk.len() as f32) as usize % folk.len();
        let who = folk[idx] as usize;
        world.memory[who].record(Episode {
            kind: EpisodeKind::Windfall as u8,
            place: 0,
            valence: 1,
            _pad: 0,
            with: u32::MAX,
            t: now,
            salience: WINDFALL_SALIENCE,
            _pad2: 0,
        });
        blessed += 1;
    }
    world.chronicle.push(Beat { t: now, kind: BEAT_OPPORTUNITY, subject: 0, magnitude: blessed as i32 });
    dir.points -= COST_OPPORTUNITY;
    dir.last_trope_at = now;
    dir.opportunities += 1;
}

/// CRISIS — a transient scarcity nudge: raise a commodity's believed price across the living town.
fn do_crisis(world: &mut World, dir: &mut crate::components::DirectorState, now: u32) {
    let good = (world.sim_rng.next_f32() * crate::components::N_COMMODITIES as f32) as usize
        % crate::components::N_COMMODITIES;
    let base = world.base_price[good];
    let bumped = ((base * 3) / 2).clamp(0, u16::MAX as i64) as u16;
    for i in 0..world.n {
        if world.alive[i] && world.faction[i] == Faction::Townsfolk as u8 {
            let pb = &mut world.econ[i].price_belief[good];
            if bumped > *pb {
                *pb = bumped;
            }
        }
    }
    world.chronicle.push(Beat { t: now, kind: BEAT_CRISIS, subject: good as u32, magnitude: bumped as i32 });
    dir.points -= COST_CRISIS;
    dir.last_trope_at = now;
    dir.crises += 1;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

/// Seed a one-sided grudge in `observer` toward `subject`: a hostile, located belief AND an
/// `assaulted` memory — so the observer's GOAP derives an avenge goal and hunts the subject down.
fn seed_grudge(world: &mut World, observer: u32, subject: u32, now: u32) {
    // read the subject's cues into locals first (no overlapping borrow with &mut beliefs below).
    let spos = world.pos[subject as usize];
    let sfac = world.faction[subject as usize];
    let slvl = world.level[subject as usize];

    let bt: &mut BeliefTable = &mut world.beliefs[observer as usize];
    if let Some(idx) = bt.find(subject) {
        let b = &mut bt.bodies[idx];
        b.flags |= 0x01; // hostile
        b.standing = b.standing.saturating_sub(16_000);
        if b.confidence < SEED_CONF {
            b.confidence = SEED_CONF;
        }
        b.last_x = spos[0];
        b.last_z = spos[1];
        b.last_tick = now;
    } else if (bt.len as usize) < BELIEF_CAP {
        let len = bt.len as usize;
        bt.subjects[len] = subject;
        bt.bodies[len] = PersonBelief {
            subject,
            last_x: spos[0],
            last_z: spos[1],
            confidence: SEED_CONF,
            faction: sfac,
            level: slvl,
            notoriety: 0,
            threat: 0,
            wealth: 0,
            last_tick: now,
            standing: -16_000,
            flags: 0x01,
            _pad: 0,
        };
        bt.len += 1;
    }
    // (table full ⇒ skip the belief seed; the memory grudge below still arms the intention.)

    world.memory[observer as usize].record(Episode {
        kind: EpisodeKind::Assaulted as u8,
        place: 0,
        valence: -1,
        _pad: 0,
        with: subject,
        t: now,
        salience: FEUD_SALIENCE,
        _pad2: 0,
    });
}

/// Living-townsfolk ids (deterministic order). Used by the town-side tropes.
fn living_townsfolk(world: &World) -> Vec<u32> {
    (0..world.n)
        .filter(|&i| world.alive[i] && world.faction[i] == Faction::Townsfolk as u8)
        .map(|i| i as u32)
        .collect()
}

/// Living town population (the prosperity knob for the budget).
fn town_pop(world: &World) -> usize {
    (0..world.n).filter(|&i| world.alive[i] && world.faction[i] == Faction::Townsfolk as u8).count()
}

/// Living attacker count (Raiders + Monsters) — the tension gauge / quiet probe.
fn attacker_count(world: &World) -> usize {
    world
        .alive
        .iter()
        .zip(world.faction.iter())
        .filter(|(&a, &f)| a && (f == Faction::Raider as u8 || f == Faction::Monster as u8))
        .count()
}

/// The wealthiest living townsperson's id (deterministic: highest wealth, lowest id breaks ties).
fn wealthiest_townsperson(world: &World) -> Option<u32> {
    let mut best: Option<(u16, u32)> = None;
    for i in 0..world.n {
        if !world.alive[i] || world.faction[i] != Faction::Townsfolk as u8 {
            continue;
        }
        let w = world.wealth[i];
        match best {
            Some((bw, _)) if w <= bw => {}
            _ => best = Some((w, i as u32)),
        }
    }
    best.map(|(_, id)| id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::GoalKind;
    use crate::world::World;

    /// BODYGUARD: a notable (high-rank) townsperson is assigned a capable nearby protector — band-bound
    /// to the principal (so the warband rally defends them) and marked ROLE_BODYGUARD.
    #[test]
    fn a_notable_gains_a_bodyguard() {
        use crate::components::NO_BAND;
        let mut w = World::spawn(0xB0D7, 6);
        let (vip, guard) = (0usize, 1usize);
        for i in 0..w.n {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.band_leader[i] = NO_BAND;
            w.role[i] = 0;
            w.level[i] = 1;
            w.pos[i] = [500.0, 500.0]; // everyone else far away + low-level
        }
        w.level[vip] = 9; // a notable worth guarding
        w.pos[vip] = [0.0, 0.0];
        w.level[guard] = 6; // a capable protector…
        w.pos[guard] = [5.0, 0.0]; // …nearby
        enlist_bodyguards(&mut w);
        assert_eq!(w.band_leader[guard], vip as i32, "the guard is band-bound to the principal");
        assert_eq!(w.role[guard], ROLE_BODYGUARD, "the guard wears the bodyguard mark");
        // re-running does NOT pile on a second guard (idempotent — the VIP is already guarded).
        let guards_before = (0..w.n).filter(|&b| w.band_leader[b] == vip as i32).count();
        enlist_bodyguards(&mut w);
        let guards_after = (0..w.n).filter(|&b| w.band_leader[b] == vip as i32).count();
        assert_eq!(guards_before, guards_after, "an already-guarded notable gains no second guard");
    }

    /// ARC STEPPER: a long-burning vendetta between two souls of different houses ESCALATES into a
    /// dynastic house feud (the strife outgrows the two). A short-lived vendetta does NOT.
    #[test]
    fn a_hardened_vendetta_escalates_into_a_house_feud() {
        use crate::sagas::SagaKind;
        let mut w = World::spawn(0xD7A3, 8);
        let (rival_a, rival_b) = (1usize, 2usize);
        w.house[rival_a] = 5;
        w.house[rival_b] = 9;
        // a hardened vendetta (4 blows traded) between them.
        for _ in 0..4 {
            w.sagas.open_or_touch(SagaKind::Vendetta, rival_a as u32, rival_b as u32, w.tick);
        }
        assert!(!crate::systems::houses::are_houses_feuding(&w, 5, 9), "no feud before escalation");
        step_sagas(&mut w);
        assert!(
            crate::systems::houses::are_houses_feuding(&w, 5, 9),
            "a hardened vendetta spills into a house feud"
        );

        // a fresh (single-blow) vendetta between two OTHER houses does NOT escalate.
        let mut w2 = World::spawn(0xD7A4, 8);
        w2.house[3] = 6;
        w2.house[4] = 7;
        w2.sagas.open_or_touch(SagaKind::Vendetta, 3, 4, w2.tick); // 1 beat only
        step_sagas(&mut w2);
        assert!(!crate::systems::houses::are_houses_feuding(&w2, 6, 7), "a fresh quarrel stays personal");
    }

    fn run_until_beat(w: &mut World, kind: u8, max_ticks: u32) -> bool {
        for _ in 0..max_ticks {
            w.tick();
            if w.chronicle.iter().any(|b| b.kind == kind) {
                return true;
            }
        }
        false
    }

    #[test]
    fn raid_fires_when_world_is_quiet() {
        let mut w = World::spawn(0xD11EC7, 80);
        assert!(
            run_until_beat(&mut w, BEAT_RAID, 12000),
            "director should eventually inject a raid when the world goes quiet"
        );
    }

    #[test]
    fn spawned_raiders_carry_zero_gold_and_conserve() {
        let mut w = World::spawn(0xD11EC7, 80);
        let gold_before = w.total_gold();
        assert!(run_until_beat(&mut w, BEAT_RAID, 12000), "need a raid to inspect the raiders");
        for i in 0..w.n {
            if w.faction[i] == Faction::Raider as u8 {
                assert_eq!(w.econ[i].gold, 0, "raider {i} must spawn with 0 gold (no minting)");
                assert_eq!(w.econ[i].stash, 0, "raider {i} must spawn with 0 stash");
            }
        }
        assert_eq!(w.total_gold(), gold_before, "spawning raiders must not change total gold");
    }

    #[test]
    fn raid_sets_a_moving_fight_on_a_victim() {
        let mut w = World::spawn(0xD11EC7, 80);
        assert!(run_until_beat(&mut w, BEAT_RAID, 12000), "director should inject a raid");
        let any_raider_fighting = (0..w.n).any(|i| {
            w.faction[i] == Faction::Raider as u8 && w.goal[i].kind() == GoalKind::Fight
        });
        assert!(any_raider_fighting, "raiders should be set on a moving Fight goal");
    }

    /// A FEUD seeds a mutual grudge — both principals end up holding an `assaulted` memory about the
    /// other (which the GOAP turns into a hunt).
    #[test]
    fn feud_seeds_a_mutual_grudge() {
        let mut w = World::spawn(0xFEED, 80);
        // drive a feud directly (deterministic) rather than waiting on the roll.
        let mut dir = w.director;
        do_feud(&mut w, &mut dir, 120);
        w.director = dir;
        let beat = w.chronicle.iter().find(|b| b.kind == BEAT_FEUD).expect("a feud Beat is logged");
        let a = beat.subject;
        let b = beat.magnitude as u32;
        assert_ne!(a, b, "a feud needs two distinct principals");
        assert!(w.memory[a as usize].has(EpisodeKind::Assaulted, b), "A should resent B");
        assert!(w.memory[b as usize].has(EpisodeKind::Assaulted, a), "B should resent A");
    }

    /// An OPPORTUNITY plants a windfall rumour that survives in some townsperson's memory.
    #[test]
    fn opportunity_plants_a_windfall() {
        let mut w = World::spawn(0x0FFE12, 80);
        let mut dir = w.director;
        do_opportunity(&mut w, &mut dir, 120);
        w.director = dir;
        let any_windfall = (0..w.n).any(|i| {
            w.memory[i].items[..w.memory[i].len as usize]
                .iter()
                .any(|e| e.kind == EpisodeKind::Windfall as u8)
        });
        assert!(any_windfall, "an opportunity should plant a windfall memory");
    }

    /// The budget is conserved-ish: points never run negative and stay capped.
    #[test]
    fn budget_stays_bounded() {
        let mut w = World::spawn(0xB0D6E7, 80);
        for _ in 0..6000 {
            w.tick();
            assert!(w.director.points >= 0, "drama budget must never go negative");
            assert!(w.director.points <= POINTS_CAP, "drama budget is capped");
        }
    }
}
