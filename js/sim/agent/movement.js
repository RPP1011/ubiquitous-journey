// Agent locomotion — pure movement primitives extracted from Agent as free
// functions over a passed agent instance. goTo is the steering core (face the
// target, barrier-deflect toward fords, terrain-slow, arrive, clamp to arena),
// re-expressed in Phase 2b as a thin _stepAlong delegate (the shared stepping body
// that steer() also drives); groundY settles the body onto the terrain surface
// (browser-visual only). fleeFrom/followLeader RETIRED (Phase 2b) — flee/follow are
// now steer-fills. Behaviour-preserving. No cycles — config + pure arena helpers only.

import { ARENA_RADIUS, terrainHeight, barrierAt } from '../../arena.js';
import { SIM, CITY } from '../simconfig.js';
import { collideWalls, gateWaypoint } from '../walls.js';

export function goTo(a, target, dt, run = false) {
  const dx = target.x - a.pos.x, dz = target.z - a.pos.z;
  const d = Math.hypot(dx, dz);
  a.fighter.setFacing(Math.atan2(-dx, -dz));
  if (d <= SIM.arriveDist) { a.fighter.setMoving(0); groundY(a); return true; }
  const sp = run ? SIM.runSpeed : SIM.moveSpeed;
  // delegate the actual stepping (gate funnel, barrier deflect, terrain slow, arena
  // clamp, wall collision, grounding) to the shared body so goTo and steer() drive
  // the body through byte-identical code.
  _stepAlong(a, dx, dz, target, dt, sp);
  return false;
}

// THE SHARED STEPPING BODY — extracted verbatim from goTo's lines 21-89 (Phase 2b,
// the steer() substrate). Takes a movement HEADING (hx,hz — the direction the body
// wants to move, before barrier deflection) and the EFFECTIVE TARGET (effTarget —
// the destination used for the gate-waypoint funnel; facing/arrival are decided by
// the CALLER, so _stepAlong never re-faces or re-arrives). `sp` is the base speed
// BEFORE terrain slow. Used by goTo (straight-at-target), fleeFrom's synthetic
// away-point, and steer()'s resolved force heading — all share one stepper so the
// feel can never drift. NEVER throws (the freeze lesson). x/z only; y via groundY.
export function _stepAlong(a, hx, hz, effTarget, dt, sp) {
  // town walls: if a wall ring lies between us and the target, steer THROUGH the
  // nearest gate first (a waypoint just past the doorway). A chord to the gate
  // stays inside the ring, so the body funnels head-on through the opening instead
  // of clipping its edge — which is where "aim straight at an off-to-the-side
  // goal" deadlocks at a narrow gate. Once through, gateWaypoint returns null and
  // we re-lock on the real heading. Face/arrive (caller's job) stay on the real target.
  const wp = effTarget ? gateWaypoint(a.pos.x, a.pos.z, effTarget.x, effTarget.z) : null;
  if (wp) { hx = wp.x - a.pos.x; hz = wp.z - a.pos.z; }
  // movement heading: by default straight at the target/gate. If the NEXT footstep
  // would land in a water/ravine barrier, steer along it (try a left/right tangent)
  // so the agent funnels toward a ford/land-bridge instead of wading — this is what
  // turns the river/ravines into chokepoints. (Walls are handled separately, above
  // via the gate waypoint + below via collideWalls.) Guarded + bounded: if no clear
  // tangent, fall back to the straight step (heavily slowed but NEVER stuck — the
  // freeze lesson: always make some progress).
  const hl = Math.hypot(hx, hz) || 1;
  let ux = hx / hl, uz = hz / hl;
  const probe = Math.max(1.5, sp * dt * 3);
  // If the next footstep would enter a water/ravine barrier, deflect along it
  // toward a crossing. We blend the chosen tangent with the straight heading
  // (not a hard 90° turn) and LATCH the deflection side per-agent (a._barrierSide,
  // ON THE AGENT — not a stepper-local side, or fords oscillate) so the body
  // doesn't oscillate at the bank — it slides along to the nearest ford/bridge
  // and keeps net progress toward the goal. Never fully stops (freeze lesson).
  if (barrierAt(a.pos.x + ux * probe, a.pos.z + uz * probe) !== 0) {
    const tx = -uz, tz = ux;                          // left-hand perpendicular
    // choose / keep a side: prefer the latched side; else the clear one; else
    // whichever points more toward the target.
    let side = a._barrierSide || 0;
    const leftClear  = barrierAt(a.pos.x + tx * probe, a.pos.z + tz * probe) === 0;
    const rightClear = barrierAt(a.pos.x - tx * probe, a.pos.z - tz * probe) === 0;
    if (side === 0 || (side > 0 && !leftClear) || (side < 0 && !rightClear)) {
      side = leftClear ? 1 : rightClear ? -1 : (tx * ux + tz * uz >= 0 ? 1 : -1);
    }
    a._barrierSide = side;
    // blend: mostly along the bank, a little toward the goal so it still drifts
    // across at a ford rather than running parallel forever.
    let bx = side * tx + ux * 0.35, bz = side * tz + uz * 0.35;
    const bl = Math.hypot(bx, bz) || 1; ux = bx / bl; uz = bz / bl;
  } else {
    a._barrierSide = 0;                            // clear ground: reset latch
  }
  // slow terrain: actually being IN a barrier cell costs speed (a forced ford).
  const here = barrierAt(a.pos.x, a.pos.z);
  if (here === 1) sp *= SIM.waterSpeedMul;
  else if (here === 2) sp *= SIM.ravineSpeedMul;
  const step = sp * dt;
  const px = a.pos.x, pz = a.pos.z;    // last (wall-free) position, for the slide
  a.pos.x += ux * step;
  a.pos.z += uz * step;
  if (a.life) a.life.dist += step;     // feeds the 'wanderlust' ambition
  const r = Math.hypot(a.pos.x, a.pos.z);
  if (r > ARENA_RADIUS) { a.pos.x *= ARENA_RADIUS / r; a.pos.z *= ARENA_RADIUS / r; }
  collideWalls(a.pos, px, pz);         // hard town-wall stop: slide along to a gate
  // CITY building-footprint collision — OFF by default (CITY.collide false). When
  // enabled, a footprint tile reads solid: revert to the last clear position (axis-
  // separated like the dungeon/town walls). The flag short-circuits BEFORE any grid
  // lookup, so this is dead code at zero cost while disabled — it cannot perturb the
  // soak. Enabling it later requires threading a grid ref (a.sim) through at spawn.
  if (CITY.collide && a.townId != null) {
    try {
      const grid = a.sim && a.sim.cities && a.sim.cities.gridFor(a.townId);
      if (grid && grid.isSolidAt(a.pos.x, a.pos.z)) { a.pos.x = px; a.pos.z = pz; }
    } catch { /* never throw on movement */ }
  }
  groundY(a);
  a.fighter.setMoving(sp);
}

// settle the body onto the terrain surface so agents walk the hills, not a
// flat plane. Overworld only (dungeon dwellers / party-followers keep their
// own y via roam/teleport, so we skip when a roam centre or party y is owned).
// Browser-visual + headless-harmless (height is a pure function). Guarded.
export function groundY(a) {
  // browser-visual ONLY: the sim reasons purely in x/z, so terrain y is cosmetic.
  // Leaving y=0 headless keeps every distance check (gossip/combat/groups, which
  // use 3D distanceTo) identical to before — no behavioural drift on the tick.
  if (typeof document === 'undefined') return;
  if (a.roam || a.inParty || a._underground) return;   // dungeon/world-y owned elsewhere
  try { a.pos.y = terrainHeight(a.pos.x, a.pos.z); } catch { /* never throw */ }
}

// fleeFrom + followLeader RETIRED (Phase 2b, the steering substrate): every caller is
// now on steer(). flee/avoid's away-from-threat steering is the pure-repulsor path inside
// steer() (it reproduces fleeFrom's 6m synthetic away-point + radial-from-origin fallback
// exactly); follow's formation slot + teleport snap + catch-up run is fillFollow in
// steer.js. goTo STAYS (re-expressed as a thin _stepAlong delegate above) — buildStep /
// combatStep / the plan transfer verbs (give/pay/gather/market) still call it and benefit
// from the shared stepper transparently.
