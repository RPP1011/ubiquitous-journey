//! FAN-OUT UNIT: wilderness expeditions (NPC adventuring companies). Ports the SPIRIT of
//! `js/sim/expeditions.ts` — a renowned captain rallies a brave company, marches OUT into the
//! monster-haunted wilds, hunts, and returns in triumph (foes slain) or broken (comrades lost).
//!
//! SIMPLIFIED PORT (doc 22 §"port the spirit"): the TS module's headline arc is the DUNGEON DELVE
//! (`_descend`/`_advanceDelve`/`_endDelve`) — teleport the party to an isolated underground pocket
//! at a deep Y offset and loose the horrors of the deep. The Rust port has NO dungeon substrate
//! (no Y-axis world, no teleport, no `_underground` pin), so the delve is DROPPED on purpose. What
//! remains is the WILDERNESS expedition the TS code already supports as its non-delve branch: march
//! to a ring beyond town, fight a few tougher Monster "horrors" spawned there, and return. The
//! mapping to the TS methods this mirrors:
//!   `_maybeForm`     → `maybe_form`   (throttle + cooldown + cap + a worthy captain + bonded followers)
//!   `_form`          → `form`         (captain + followers band-follow, march to the wilderness ring)
//!   `_advance`       → `advance`      (out→hunt on arrival [spawns horrors], hunt→return on timer/loss)
//!   `_end`           → `end`          (restore survivors, log a chronicle Beat + a kill tally)
//!   `_forgeComrades` → `forge_comrades` (survivors who marched home warm toward each other)
//! Dropped with a note: `_descend`/`_advanceDelve`/`_endDelve`/`_spawnHorror`-at-depth/`_foldExplore`
//! (no EXPLORE deed spine here) and the loyalty/retreat divergence (delve-only in the TS).
//!
//! BEHAVIOURAL PARITY, determinism may diverge: this is a SERIAL society pass ⇒ trivially M-invariant
//! (M=1 ≡ M=N). All randomness is `world.sim_rng` in fixed company/id order; no HashMap iteration, no
//! float reduce. CONSERVATION: spawned horrors are `Faction::Monster` via `World::spawn_agent` ⇒ 0
//! gold (never mints); a finished company's horrors are left to die in combat / be marked dead — never
//! despawned (despawn isn't supported; the TS `_despawnHorror` has no analogue).

use crate::components::{Beat, Company, Faction, Goal, Personality, Profession, MAX_COMPANY, MAX_HORRORS};
use crate::world::World;

// ── throttle / cadence (the TS `EXPEDITION.*` tuning) ──
/// Consider expeditions only on this tick cadence (the `_acc >= tickEvery` throttle).
const TICK_EVERY: u32 = 8;
/// Min ticks between mustering two companies (`formEvery`).
const FORM_EVERY: u32 = 600;
/// Per-attempt probability a company actually musters when otherwise eligible (`formChance`).
const FORM_CHANCE: f32 = 0.5;
/// At most this many companies afield at once (`maxActive`).
const MAX_ACTIVE: usize = 1;
/// Don't drain a struggling town — muster only when there are folk to spare (`minTownPop`).
const MIN_TOWN_POP: usize = 18;

// ── who may go (the `_brave` / captain / follower gates) ──
/// A captain needs some renown — this minimum total level (`captainMinLevel`).
const CAPTAIN_MIN_LEVEL: u8 = 5;
/// Courage gate: a follower (or captain fallback) needs at least this risk_tolerance (`recruitRisk`).
const RECRUIT_RISK: f32 = 0.5;
/// Company size: captain + up to `PARTY_SIZE - 1` followers (`partySize`).
const PARTY_SIZE: usize = 3;

// ── the march + the hunt ──
/// The wilderness ring (fraction of the arena clamp) the company marches to (`targetRing`).
const TARGET_RING: f32 = 0.78;
const ARENA_CLAMP: f32 = crate::world::REGION_R;
/// Arrival tolerance: within this distance of the ring point counts as "there" (TS `< 14`).
const ARRIVE_DIST: f32 = 16.0;
/// Home-arrival tolerance on the return leg (TS `< 20`).
const HOME_DIST: f32 = 22.0;
/// How long the hunt lasts once the company reaches the wilds, in TICKS (`huntSecs`).
const HUNT_TICKS: u32 = 320;
/// How many horrors lurk at the hunt site (`delveMonsters`/`huntMonsters`).
const HUNT_HORRORS: usize = 3;
/// Threat cue stamped on a horror (so it perceives as dangerous and townsfolk fear it).
const HORROR_THREAT: u16 = 9000;
/// A horror is tougher than a base monster — extra starting health (the `monsterHpMul` spirit).
const HORROR_HEALTH: f32 = 160.0;

/// Belief warming granted pairwise to survivors who march home together (`comradeWarm`, i16 quant).
const COMRADE_WARM: i16 = 4000;

/// BeatKinds (interned; disjoint from chronicle 0/1, director 2/10/11/12). Mirrors the TS `_note`.
const BEAT_EXPEDITION_OUT: u8 = 20; // a company set out (subject = captain, magnitude = members).
const BEAT_EXPEDITION_END: u8 = 21; // a company resolved (subject = captain, magnitude = horrors slain).

// company.phase values.
const PHASE_OUT: u8 = 0;
const PHASE_HUNT: u8 = 1;
const PHASE_RETURN: u8 = 2;

pub fn tick(world: &mut World) {
    // Throttle (the `_acc` accumulator, in ticks).
    world.expeditions.acc += 1;
    if world.expeditions.acc < TICK_EVERY {
        return;
    }
    world.expeditions.acc = 0;

    // Advance every company afield first (id-stable order = the roster order they were pushed in).
    advance_all(world);
    // Then maybe muster a new one.
    maybe_form(world);
}

// ── ADVANCE (mirror `_advance`) ────────────────────────────────────────────────────────────────

/// Step each company through its phases. We index by position and may remove resolved companies, so
/// we collect end-actions and apply them after the walk (no aliasing of `world.expeditions`).
fn advance_all(world: &mut World) {
    let n = world.expeditions.companies.len();
    let mut ended: Vec<(usize, EndHow)> = Vec::new(); // (company index, how) — applied after the walk
    for ci in 0..n {
        match advance_one(world, ci) {
            Some(how) => ended.push((ci, how)),
            None => {}
        }
    }
    // Resolve ended companies high-index-first so earlier removals don't shift later indices.
    for &(ci, how) in ended.iter().rev() {
        end(world, ci, how);
    }
}

/// What ended a company (drives `end`'s chronicle + tally).
#[derive(Clone, Copy)]
enum EndHow {
    Home,        // the survivors reached town again.
    CaptainLost, // the captain fell afield (a doomed expedition).
}

/// Advance one company by index; returns `Some(how)` if it resolved this tick (the caller ends it).
fn advance_one(world: &mut World, ci: usize) -> Option<EndHow> {
    let c = world.expeditions.companies[ci];
    let cap = c.captain as usize;
    // The captain fell — a doomed expedition (resolved from the survivors' side, like the TS).
    if cap >= world.n || !world.alive[cap] {
        return Some(EndHow::CaptainLost);
    }
    let now = world.tick;
    let cap_pos = world.pos[cap];

    match c.phase {
        PHASE_OUT => {
            // Reached the wilds? Loose the horrors and begin the hunt.
            if dist2(cap_pos, c.target) < ARRIVE_DIST * ARRIVE_DIST {
                begin_hunt(world, ci, now);
            }
            None
        }
        PHASE_HUNT => {
            let losses = company_fallen(world, ci) > 0;
            let timed_out = now >= world.expeditions.companies[ci].hunt_until;
            let cleared = horrors_left(world, ci) == 0;
            if timed_out || losses || cleared {
                // Turn for home: the captain leads the band back to the town center.
                let c = &mut world.expeditions.companies[ci];
                c.phase = PHASE_RETURN;
                c.target = world.town_center;
                set_band_goal(world, ci, Goal::Wander { to: world.town_center });
            }
            None
        }
        PHASE_RETURN => {
            if dist2(cap_pos, world.town_center) < HOME_DIST * HOME_DIST {
                Some(EndHow::Home)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Reached the wilds: spawn the horrors, set the whole band on a Fight at the first horror, and seed
/// every member's hostile belief about every horror (and vice-versa) so combat resolves BOTH ways —
/// the same belief-seeded spark the director's FEUD uses. Horrors carry 0 gold (`spawn_agent`).
fn begin_hunt(world: &mut World, ci: usize, now: u32) {
    let site = world.expeditions.companies[ci].target;
    // Spawn the horrors near the hunt site (deterministic offsets from sim_rng, in fixed order).
    let mut horror_ids = [-1i32; MAX_HORRORS];
    let mut nh = 0usize;
    for _ in 0..HUNT_HORRORS.min(MAX_HORRORS) {
        let a = world.sim_rng.next_f32() * std::f32::consts::TAU;
        let r = world.sim_rng.next_f32() * 12.0;
        let pos = [site[0] + r * a.cos(), site[1] + r * a.sin()];
        let id = world.spawn_agent(pos, Faction::Monster, Profession::None);
        world.threat[id] = HORROR_THREAT;
        world.combat[id].health = HORROR_HEALTH;
        // a tougher body fights from the front; idle Wander keeps it near the site until it's struck.
        world.goal[id] = Goal::Wander { to: site };
        horror_ids[nh] = id as i32;
        nh += 1;
    }
    {
        let c = &mut world.expeditions.companies[ci];
        c.phase = PHASE_HUNT;
        c.hunt_until = now + HUNT_TICKS;
        c.horrors = horror_ids;
        c.n_horrors = nh as u8;
    }
    // Seed the mutual hostility: each member ↔ each horror. A located, hostile belief lets the Fight
    // goal land its strike (combat needs a belief about the target) and lets the horror fight back.
    let members = company_members(world, ci);
    let first_horror = horror_ids[0];
    for &m in &members {
        let m = m as usize;
        if m >= world.n || !world.alive[m] {
            continue;
        }
        for k in 0..nh {
            let h = horror_ids[k] as u32;
            world.sour_belief(m, h, 16_000, true); // member fears the horror
            world.sour_belief(h as usize, m as u32, 16_000, true); // horror hunts the member
        }
        // every member sets out to fight the first horror; combat re-targets the nearest believed
        // hostile once that one falls (`nearest_hostile`), so the band mops up the rest.
        if first_horror >= 0 {
            world.goal[m] = Goal::Fight { target: first_horror as u32, to: site };
        }
    }
}

// ── END (mirror `_end`) ──────────────────────────────────────────────────────────────────────────

/// Resolve a company: restore survivors to civilian goals, forge comrade bonds on a clean homecoming,
/// log a Beat with the kill tally, update the stats, and drop the company from the roster.
fn end(world: &mut World, ci: usize, how: EndHow) {
    let c = world.expeditions.companies[ci];
    let cap = c.captain;
    let members = company_members(world, ci);
    let slain = horrors_slain(world, ci);
    world.expeditions.slain += slain;

    // Survivors (still alive) vs fallen.
    let survivors: Vec<u32> = members.iter().copied().filter(|&m| (m as usize) < world.n && world.alive[m as usize]).collect();
    let fallen = members.len() - survivors.len();

    // Shared peril forges bonds among those who made it home together (the TS `_forgeComrades`).
    if matches!(how, EndHow::Home) && survivors.len() >= 2 {
        forge_comrades(world, &survivors);
    }

    // Restore every member to civilian life: drop the band-follow + reset to Idle (decide re-plans).
    for &m in &members {
        let m = m as usize;
        if m >= world.n {
            continue;
        }
        world.band_leader[m] = crate::components::NO_BAND;
        if world.alive[m] {
            world.goal[m] = Goal::Idle;
        }
    }

    // Tell the tale + tally (the TS `_note` + `stats`).
    let lost_all = matches!(how, EndHow::CaptainLost) || survivors.is_empty();
    if lost_all || fallen > 0 {
        world.expeditions.losses += 1;
    } else {
        world.expeditions.triumphs += 1;
    }
    world.chronicle.push(Beat {
        t: world.tick,
        kind: BEAT_EXPEDITION_END,
        subject: cap,
        magnitude: slain as i32,
    });

    // Drop the resolved company from the afield roster.
    world.expeditions.companies.remove(ci);
}

// ── FORM (mirror `_maybeForm` + `_form`) ─────────────────────────────────────────────────────────

/// Raise a new company when warranted: off cooldown, under the cap, a worthy captain + a couple of
/// brave, bonded souls to follow. All rolls via `sim_rng` in fixed id order ⇒ deterministic.
fn maybe_form(world: &mut World) {
    if world.expeditions.companies.len() >= MAX_ACTIVE {
        return;
    }
    let now = world.tick;
    if now.saturating_sub(world.expeditions.last_form) < FORM_EVERY && world.expeditions.last_form != 0 {
        return;
    }
    if world.sim_rng.next_f32() > FORM_CHANCE {
        return;
    }
    if town_pop(world) < MIN_TOWN_POP {
        return;
    }

    // A captain of some renown: highest-level eligible townsperson (deterministic: level then id).
    let Some(cap) = pick_captain(world) else { return };

    // FELLOWSHIP: followers are the bravest unbanded townsfolk near the captain (the bond substrate is
    // thin in Rust — belief standing — so we gate on courage + standing toward the captain, the
    // `recruitRisk`/`bond` spirit). Deterministic: sort by (−standing, id).
    let followers = pick_followers(world, cap);
    if followers.is_empty() {
        return;
    }

    form(world, cap, &followers);
}

/// Muster the company: captain + followers band-follow, and the band marches to a wilderness ring.
fn form(world: &mut World, cap: usize, followers: &[usize]) {
    let mut members = [-1i32; MAX_COMPANY];
    members[0] = cap as i32;
    let mut nm = 1usize;
    for &f in followers {
        if nm >= MAX_COMPANY {
            break;
        }
        world.band_leader[f] = cap as i32; // follow the captain (the warband path)
        members[nm] = f as i32;
        nm += 1;
    }

    // Choose the adventure point on the outer ring (deterministic angle from sim_rng).
    let ang = world.sim_rng.next_f32() * std::f32::consts::TAU;
    let r = ARENA_CLAMP * TARGET_RING;
    let target = [world.town_center[0] + r * ang.cos(), world.town_center[1] + r * ang.sin()];

    let company = Company {
        captain: cap as u32,
        phase: PHASE_OUT,
        target,
        started_at: world.tick,
        hunt_until: 0,
        kills_at0: 0,
        horrors: [-1; MAX_HORRORS],
        n_horrors: 0,
        members,
        n_members: nm as u8,
    };
    world.expeditions.companies.push(company);
    world.expeditions.mounted += 1;
    world.expeditions.last_form = world.tick;

    // March: the whole band heads for the ring (Wander toward the target; the captain leads, the
    // followers band-follow via their band_leader — locomotion/decide carry them along).
    for i in 0..nm {
        let m = members[i] as usize;
        world.goal[m] = Goal::Wander { to: target };
    }

    world.chronicle.push(Beat {
        t: world.tick,
        kind: BEAT_EXPEDITION_OUT,
        subject: cap as u32,
        magnitude: nm as i32,
    });
}

/// SHARED PERIL FORGES BONDS: survivors who march home together warm toward each other pairwise
/// (the TS `_forgeComrades`). Serial society write ⇒ deterministic. Belief-only — the group machinery
/// may then find them; we don't mint a named fellowship.
fn forge_comrades(world: &mut World, survivors: &[u32]) {
    for &a in survivors {
        for &b in survivors {
            if a != b {
                world.warm_belief(a as usize, b, COMRADE_WARM);
            }
        }
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/// The company's member ids (captain first), as a small vec (≤ MAX_COMPANY).
fn company_members(world: &World, ci: usize) -> Vec<u32> {
    let c = &world.expeditions.companies[ci];
    c.members[..c.n_members as usize].iter().map(|&m| m as u32).collect()
}

/// How many of a company's members are dead (the loss probe).
fn company_fallen(world: &World, ci: usize) -> usize {
    let c = &world.expeditions.companies[ci];
    c.members[..c.n_members as usize]
        .iter()
        .filter(|&&m| (m as usize) < world.n && !world.alive[m as usize])
        .count()
}

/// How many of a company's spawned horrors are still alive.
fn horrors_left(world: &World, ci: usize) -> usize {
    let c = &world.expeditions.companies[ci];
    c.horrors[..c.n_horrors as usize]
        .iter()
        .filter(|&&h| h >= 0 && (h as usize) < world.n && world.alive[h as usize])
        .count()
}

/// How many of a company's spawned horrors are dead (the kill tally — the ground-truth observer read
/// that stands in for the TS `_killCount` over `life.monsterKills`, which has no Rust analogue).
fn horrors_slain(world: &World, ci: usize) -> u32 {
    let c = &world.expeditions.companies[ci];
    c.horrors[..c.n_horrors as usize]
        .iter()
        .filter(|&&h| h >= 0 && (h as usize) < world.n && !world.alive[h as usize])
        .count() as u32
}

/// Set every living member's goal (used when the band turns for home).
fn set_band_goal(world: &mut World, ci: usize, goal: Goal) {
    let members = company_members(world, ci);
    for m in members {
        let m = m as usize;
        if m < world.n && world.alive[m] {
            world.goal[m] = goal;
        }
    }
}

/// Living town population (the prosperity gate).
fn town_pop(world: &World) -> usize {
    (0..world.n).filter(|&i| world.alive[i] && world.faction[i] == Faction::Townsfolk as u8).count()
}

/// May `i` go afield: alive, townsfolk, not already in someone's band, not itself leading a company.
fn is_brave(world: &World, i: usize) -> bool {
    world.alive[i]
        && world.faction[i] == Faction::Townsfolk as u8
        && world.band_leader[i] == crate::components::NO_BAND
        && !is_active_captain(world, i)
}

/// Is `i` currently leading a company afield? (a captain doesn't also follow / re-muster).
fn is_active_captain(world: &World, i: usize) -> bool {
    world.expeditions.companies.iter().any(|c| c.captain as usize == i)
}

/// Pick the captain: highest-level brave townsperson clearing the renown bar (level then id tie-break).
fn pick_captain(world: &World) -> Option<usize> {
    let mut best: Option<(u8, usize)> = None;
    for i in 0..world.n {
        if !is_brave(world, i) || world.level[i] < CAPTAIN_MIN_LEVEL {
            continue;
        }
        // a worthy captain is bold (risk_tolerance) OR simply renowned (level alone clears the gate).
        match best {
            Some((bl, _)) if world.level[i] <= bl => {}
            _ => best = Some((world.level[i], i)),
        }
    }
    best.map(|(_, i)| i)
}

/// Pick up to PARTY_SIZE-1 followers: brave, unbanded townsfolk who regard the captain well (or are
/// simply bold), sorted by (−standing-toward-captain, id) for an order-independent pick.
fn pick_followers(world: &World, cap: usize) -> Vec<usize> {
    let want = PARTY_SIZE.saturating_sub(1).max(1);
    let mut cands: Vec<(i32, usize)> = Vec::new(); // (−standing-as-i32, id) for a stable ascending sort
    for i in 0..world.n {
        if i == cap || !is_brave(world, i) {
            continue;
        }
        let p: &Personality = &world.personality[i];
        let standing = standing_toward(world, i, cap as u32);
        // courage OR a warm regard for the captain qualifies (the `recruitRisk` / bond override).
        if p.risk_tolerance >= RECRUIT_RISK || standing >= 4000 {
            cands.push((-(standing as i32), i));
        }
    }
    cands.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    cands.into_iter().take(want).map(|(_, i)| i).collect()
}

/// `observer`'s believed standing toward `subject` (i16 quant), or 0 if no belief is held.
fn standing_toward(world: &World, observer: usize, subject: u32) -> i16 {
    let bt = &world.beliefs[observer];
    match bt.find(subject) {
        Some(idx) => bt.bodies[idx].standing,
        None => 0,
    }
}

#[inline]
fn dist2(a: [f32; 2], b: [f32; 2]) -> f32 {
    let dx = a[0] - b[0];
    let dz = a[1] - b[1];
    dx * dx + dz * dz
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::GoalKind;
    use crate::world::World;

    /// Force-eligible a town: enough bold, high-level, unbanded townsfolk to muster a company.
    fn seed_adventurers(w: &mut World) {
        for i in 0..w.n.min(30) {
            w.faction[i] = Faction::Townsfolk as u8;
            w.alive[i] = true;
            w.level[i] = 8;
            w.band_leader[i] = crate::components::NO_BAND;
            w.personality[i].risk_tolerance = 0.9;
            w.goal[i] = Goal::Idle;
        }
    }

    /// A company forms (a captain + followers band-follow) and is set marching toward the wilds.
    #[test]
    fn a_company_forms_and_marches() {
        let mut w = World::spawn(0xE2BED, 40);
        seed_adventurers(&mut w);
        // drive formation directly (deterministic; the roll uses sim_rng) until it fires.
        let mut formed = false;
        for _ in 0..200 {
            maybe_form(&mut w);
            if !w.expeditions.companies.is_empty() {
                formed = true;
                break;
            }
        }
        assert!(formed, "a company should muster from a town full of bold high-level folk");
        let c = w.expeditions.companies[0];
        assert!(c.n_members >= 2, "a company is a captain + at least one follower");
        // every member is marching (Wander) toward the wilderness ring, captain leads, followers band.
        let cap = c.captain as usize;
        assert_eq!(w.goal[cap].kind(), GoalKind::Wander, "the captain marches to the wilds");
        for k in 1..c.n_members as usize {
            let f = c.members[k] as usize;
            assert_eq!(w.band_leader[f], cap as i32, "followers band-follow the captain");
            assert_eq!(w.goal[f].kind(), GoalKind::Wander, "followers march too");
        }
        assert_eq!(w.expeditions.mounted, 1, "the muster is tallied");
    }

    /// The march reaches the wilds, horrors spawn (0 gold), and the company eventually returns home —
    /// survivors restored to civilian life, a chronicle Beat logged, gold conserved throughout.
    #[test]
    fn company_marches_hunts_and_returns() {
        let mut w = World::spawn(0xE2BED, 40);
        seed_adventurers(&mut w);
        let gold_before = w.total_gold();
        for _ in 0..200 {
            maybe_form(&mut w);
            if !w.expeditions.companies.is_empty() {
                break;
            }
        }
        assert!(!w.expeditions.companies.is_empty(), "need a company afield to test the arc");
        let cap = w.expeditions.companies[0].captain as usize;

        // teleport the captain to the wilds target so `advance` trips the out→hunt transition (we test
        // the state machine, not locomotion — locomotion is exercised by the soak).
        let target = w.expeditions.companies[0].target;
        w.pos[cap] = target;
        advance_all(&mut w);
        assert_eq!(w.expeditions.companies[0].phase, PHASE_HUNT, "arrival begins the hunt");
        let nh = w.expeditions.companies[0].n_horrors as usize;
        assert!(nh > 0, "horrors should be loosed at the hunt site");
        for k in 0..nh {
            let h = w.expeditions.companies[0].horrors[k] as usize;
            assert_eq!(w.faction[h], Faction::Monster as u8, "a horror is a Monster");
            assert_eq!(w.econ[h].gold, 0, "a spawned horror carries 0 gold (no minting)");
        }

        // time out the hunt, then bring the captain home so the company resolves.
        let until = w.expeditions.companies[0].hunt_until;
        w.tick = until + 1;
        advance_all(&mut w); // hunt→return
        assert_eq!(w.expeditions.companies[0].phase, PHASE_RETURN, "timeout turns the band home");
        w.pos[cap] = w.town_center;
        advance_all(&mut w); // return→end
        assert!(w.expeditions.companies.is_empty(), "the company resolves on homecoming");
        assert_eq!(w.band_leader[cap], crate::components::NO_BAND, "the captain is a civilian again");

        // a Beat was logged and gold is conserved (horrors are 0-gold; nobody minted).
        assert!(
            w.chronicle.iter().any(|b| b.kind == BEAT_EXPEDITION_END),
            "an expedition-end Beat should be logged"
        );
        assert_eq!(w.total_gold(), gold_before, "expeditions must not change total gold");
    }

    /// A lost captain resolves the company from the survivors' side (a doomed expedition).
    #[test]
    fn a_lost_captain_resolves_the_company() {
        let mut w = World::spawn(0xE2BED, 40);
        seed_adventurers(&mut w);
        for _ in 0..200 {
            maybe_form(&mut w);
            if !w.expeditions.companies.is_empty() {
                break;
            }
        }
        assert!(!w.expeditions.companies.is_empty(), "need a company afield");
        let cap = w.expeditions.companies[0].captain as usize;
        w.alive[cap] = false; // the captain falls
        advance_all(&mut w);
        assert!(w.expeditions.companies.is_empty(), "a fallen captain ends the expedition");
        assert!(w.expeditions.losses >= 1, "a doomed expedition is tallied as a loss");
    }

    /// Determinism: the full sim including the expeditions society pass is M-invariant (M=1 ≡ M=N).
    #[test]
    fn society_expeditions_m_invariant() {
        use crate::hash::world_hash;
        use crate::{in_pool, run_sim};
        let h1 = in_pool(1, || world_hash(&run_sim(0x6120, 1200, 80)));
        let h4 = in_pool(4, || world_hash(&run_sim(0x6120, 1200, 80)));
        assert_eq!(h1, h4, "expeditions society pass must be M-invariant");
    }
}
