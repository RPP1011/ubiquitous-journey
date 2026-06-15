// Theory-of-Mind party combat coordination (docs/architecture/19). The suite grows with the
// build order: Step 1 here proves the FOUNDATION + safety BEFORE any behaviour —
//   F1  bandCombatState returns the right vision-gated snapshot (allies / foes / attackerCount /
//       strikingId), the read the whole cascade is built on;
//   F2  it is split-safe (belief-style snapshots, no live object) and freeze-safe (unbanded → null;
//       an ability-less monster band + a professionless member never throw).
// Behavioural cases (focus-fire C1, spread C2, protect C3/C4, allied-strength C5, combos C6–C11)
// land as their build steps do, all on the FeatureStage fixture (shared with recruit.mjs).
import { FeatureStage } from './_stage.mjs';
import { COORD } from '../../js/sim/simconfig.js';
import { EFFECTS, applyExpose, exposeActive } from '../../js/rpg/abilities/effects.js';
import { spec as mkSpec, effect as mkEffect } from '../../js/rpg/abilities/ir.js';
import { ABILITY_CATALOG } from '../../js/rpg/abilities/catalog.js';
import { comboRoleOf, accrueAllyRole, believedRole } from '../../js/sim/coordination.js';
import { tryComboSetup, comboHold } from '../../js/sim/agent/act.js';

// band `a` to leader `L` exactly as Party.recruit / joinBand do (the flags decideParty branches on).
function band(a, L) {
  a.inParty = true; a.combatant = true; a.groupType = 'warband'; a.bandLeaderId = L.id;
  return a;
}
// band `a` to `L` AND seed a's belief that L is alive, so decideParty's leaderLive gate passes for an
// NPC band (no controlled partyLeader) and the coordination cascade actually runs.
function join(st, a, L) { band(a, L); st.believe(a, L); return a; }
// force ONE deterministic decision for `a` (the NPC-band cognition ctx; no frame loop / combat drift).
function decideOnce(st, a) { a.decide(st.sim._cognitionCtx()); return a.goal; }
const hp = (a, frac) => { a.fighter.health = (a.fighter.maxHealth || 100) * frac; };

export function coordTest(ok, helpers) {
  // ── F1: the band snapshot is correct ───────────────────────────────────────────────────────
  {
    const st = new FeatureStage(helpers);
    try {
      // leader + 2 companions (townsfolk warband) vs 2 monsters, positions hand-placed so the
      // inferred strike targets are unambiguous: leader+comp1 both on foe1, comp2 on foe2.
      const L = st.add('Cap', 0, 0, { combatant: true });
      const c1 = band(st.add('C1', 1, 0, { combatant: true }), L);
      const c2 = band(st.add('C2', 1, 2, { combatant: true }), L);
      const f1 = st.add('F1', 2.4, 0, { faction: 'monster' });
      const f2 = st.add('F2', 3, 2, { faction: 'monster' });

      const view = st.ctx().resolver.bandCombatState(c1, L);
      ok(!!view, 'coord F1: bandCombatState returns a view for a banded member');
      const allies = view ? view.allies : [];
      const foes = view ? view.foes : [];
      ok(allies.length === 2, `coord F1: sees both band-mates (leader + peer) as allies (got ${allies.length})`);
      ok(foes.length === 2, `coord F1: sees both engaging foes (got ${foes.length})`);

      const rf1 = foes.find((f) => f.id === f1.id);
      const rf2 = foes.find((f) => f.id === f2.id);
      ok(rf1 && rf1.attackerCount === 2, `coord F1: foe1 has 2 attackers (leader+comp1) (got ${rf1 && rf1.attackerCount})`);
      ok(rf2 && rf2.attackerCount === 1, `coord F1: foe2 has 1 attacker (comp2) (got ${rf2 && rf2.attackerCount})`);

      const leaderRef = allies.find((m) => m.id === L.id);
      ok(leaderRef && leaderRef.strikingId === f1.id, 'coord F1: the leader is inferred to be striking foe1 (proximity, not a goal read)');
      ok(leaderRef && typeof leaderRef.hpFrac === 'number' && leaderRef.hpFrac > 0, 'coord F1: an ally ref carries a health fraction');
      // a belief-style snapshot, never the live object: the ref is a plain {id,pos,...}, not an Agent.
      ok(leaderRef && typeof leaderRef.pos === 'object' && !('fighter' in leaderRef) && !('beliefs' in leaderRef),
        'coord F1: ally refs are belief-style snapshots, not live roster objects (the split holds)');
    } finally { st.dispose(); }
  }

  // ── F2: freeze-safe + split-safe edges ─────────────────────────────────────────────────────
  {
    const st = new FeatureStage(helpers);
    try {
      // (a) an UNBANDED agent → null (no band to coordinate).
      const solo = st.add('Solo', 0, 0, {});
      ok(st.ctx().resolver.bandCombatState(solo, null) === null, 'coord F2: an unbanded agent gets null (nothing to coordinate)');

      // (b) an ability-less MONSTER band + a professionless member → no throw, no foes seen by an
      //     all-monster band (monsters aren't hostile to their own faction).
      const mL = st.add('Ogre', 40, 40, { faction: 'monster', combatant: true });
      const mC = band(st.add('Whelp', 41, 40, { faction: 'monster', combatant: true }), mL);
      let threw = false, view = null;
      try { view = st.ctx().resolver.bandCombatState(mC, mL); } catch { threw = true; }
      ok(!threw, 'coord F2: an ability-less monster band never throws (the freeze lesson)');
      ok(view && view.foes.length === 0, 'coord F2: a monster band sees no foes among its own kind');
    } finally { st.dispose(); }
  }

  // ── C1: FOCUS-FIRE — the band collapses onto ONE foe even when a member is adjacent to another ──
  {
    const st = new FeatureStage(helpers); const save = COORD.maxPerFoe; COORD.maxPerFoe = 9;   // isolate focus from spread
    try {
      const L = st.add('Cap', 0, 0, { combatant: true });
      const c1 = join(st, st.add('C1', 2.2, 0, { combatant: true }), L);   // beside foe1
      const c2 = join(st, st.add('C2', 6, 0, { combatant: true }), L);     // beside foe2, far from foe1
      const f1 = st.add('F1', 1, 0, { faction: 'monster' });               // leader + c1 already on it
      const f2 = st.add('F2', 7, 0, { faction: 'monster' });               // c2 is right next to it
      const g1 = decideOnce(st, c1), g2 = decideOnce(st, c2);
      ok(g1.kind === 'fight' && g1.targetId === f1.id, `coord C1: c1 fights the band's foe (got ${g1.kind}:${g1.targetId})`);
      ok(g2.kind === 'fight' && g2.targetId === f1.id,
        `coord C1: c2 ABANDONS the foe beside it to focus-fire the band's target (got ${g2.kind}:${g2.targetId}, foe2=${f2.id})`);
    } finally { COORD.maxPerFoe = save; st.dispose(); }
  }

  // ── C2: SPREAD — once a foe is saturated (maxPerFoe), the surplus member peels to the free foe ──
  {
    const st = new FeatureStage(helpers); const save = COORD.maxPerFoe; COORD.maxPerFoe = 2;   // foe1 (leader+c1) is full
    try {
      const L = st.add('Cap', 0, 0, { combatant: true });
      join(st, st.add('C1', 2.2, 0, { combatant: true }), L);              // L + c1 = 2 on foe1 (== cap)
      const c2 = join(st, st.add('C2', 6, 0, { combatant: true }), L);
      st.add('F1', 1, 0, { faction: 'monster' });
      const f2 = st.add('F2', 7, 0, { faction: 'monster' });
      const g2 = decideOnce(st, c2);
      ok(g2.kind === 'fight' && g2.targetId === f2.id,
        `coord C2: c2 PEELS to the unattended foe rather than pile a 3rd attacker onto a full one (got ${g2.kind}:${g2.targetId})`);
    } finally { COORD.maxPerFoe = save; st.dispose(); }
  }

  // ── C3: PROTECT — a leader dropped below protectHpFrac with an attacker → cover by hitting it ──
  {
    const st = new FeatureStage(helpers);
    try {
      const L = st.add('Cap', 0, 0, { combatant: true }); hp(L, 0.3);     // beleaguered leader
      const c1 = join(st, st.add('C1', 2, 0, { combatant: true }), L);    // in reach of foeA
      const fa = st.add('FA', 1.2, 0, { faction: 'monster' });            // the leader's attacker
      st.add('FB', 3, 0, { faction: 'monster' });                         // a foe c1 would otherwise pick
      const g = decideOnce(st, c1);
      ok(g.kind === 'fight' && g.targetId === fa.id,
        `coord C3: c1 covers the wounded leader by striking ITS attacker, not the nearer foe (got ${g.kind}:${g.targetId})`);
    } finally { st.dispose(); }
  }

  // ── C4: PROTECT (interpose) — out of reach, the defender takes a 'protect' goal toward the gap ──
  {
    const st = new FeatureStage(helpers);
    try {
      const L = st.add('Cap', 0, 0, { combatant: true }); hp(L, 0.3);
      const c1 = join(st, st.add('C1', 6, 0, { combatant: true }), L);    // far from the attacker
      const fa = st.add('FA', 1.2, 0, { faction: 'monster' });
      const g = decideOnce(st, c1);
      ok(g.kind === 'protect' && g.targetId === fa.id && !!g.toPos,
        `coord C4: an out-of-reach defender interposes (goal 'protect' + toPos), not a bare fight (got ${g.kind}, toPos=${!!g.toPos})`);
    } finally { st.dispose(); }
  }

  // ── C5: ALLIED-STRENGTH — a hurt member solo-FLEES a foe it believes strong, but PRESSES backed up ──
  {
    const seedStrong = (m, foe, ststage) => { ststage.believe(m, foe); const b = m.beliefs.get(foe.id); b.believedThreat = 60; b.believedLevel = 12; b.confidence = 1; };
    // (a) alone → flee
    {
      const st = new FeatureStage(helpers);
      try {
        const L = st.add('Cap', 50, 50, { combatant: true });            // out of sight (no allied backing)
        const c1 = join(st, st.add('C1', 0, 0, { combatant: true }), L); hp(c1, 0.3);
        const foe = st.add('F', 1.5, 0, { faction: 'monster' }); seedStrong(c1, foe, st);
        const g = decideOnce(st, c1);
        ok(g.kind === 'flee', `coord C5a: a hurt, outmatched, UNBACKED member breaks off (got ${g.kind})`);
      } finally { st.dispose(); }
    }
    // (b) backed up → press
    {
      const st = new FeatureStage(helpers);
      try {
        const L = st.add('Cap', 50, 50, { combatant: true });
        const c1 = join(st, st.add('C1', 0, 0, { combatant: true }), L); hp(c1, 0.3);
        join(st, st.add('C2', 1, 1, { combatant: true }), L);            // two hale comrades beside me
        join(st, st.add('C3', -1, 1, { combatant: true }), L);
        const foe = st.add('F', 1.5, 0, { faction: 'monster' }); seedStrong(c1, foe, st);
        const g = decideOnce(st, c1);
        ok(g.kind === 'fight', `coord C5b: the SAME hurt member PRESSES the attack with two allies beside it (got ${g.kind})`);
      } finally { st.dispose(); }
    }
  }

  // ── C6: OPENING (§8a) — the band pivots onto a foe an ally just CC'd, over a closer un-CC'd one ──
  {
    const st = new FeatureStage(helpers);
    try {
      const L = st.add('Cap', 50, 50, { combatant: true });               // out of sight (doesn't skew attackers)
      const c1 = join(st, st.add('C1', 0, 0, { combatant: true }), L);
      st.add('Near', 1, 0, { faction: 'monster' });                       // closer, NOT controlled
      const ccd = st.add('Far', 4, 0, { faction: 'monster' });            // farther, but STAGGERED (an opening)
      ccd.fighter.state = 'stagger'; ccd.fighter.staggerTimer = 5;
      const g = decideOnce(st, c1);
      ok(g.kind === 'fight' && g.targetId === ccd.id,
        `coord C6: c1 exploits the OPEN window — pivots onto the CC'd foe over the nearer one (got ${g.kind}:${g.targetId}, ccd=${ccd.id})`);
    } finally { st.dispose(); }
  }

  // ── C7: the EXPOSE op (§9) — opens a window; the next damage is ×exposeAmp and CONSUMES it ──
  {
    const tf = { alive: true, state: 'idle', staggerTimer: 0 };
    const target = { pos: { x: 0, y: 0, z: 0 }, fighter: tf };
    const caster = { pos: { x: 1, y: 0, z: 0 }, fighter: { alive: true, root: { rotation: { y: 0 } } } };
    EFFECTS.expose({ op: 'expose', amount: 1.5, dur: 4, chance: 1, when: null, tags: [] }, caster, target, { time: 0 });
    ok(exposeActive(tf, 0) === true, 'coord C7: expose opens a window on the target');
    ok(applyExpose(tf, 10, 0) === 15, `coord C7: the next hit is amplified ×1.5 (got ${applyExpose({ ...tf }, 10, 0)} on a fresh copy)`);
    ok(exposeActive(tf, 0) === false, 'coord C7: the window is CONSUMED by the landing hit (one-shot)');
    ok(applyExpose(tf, 10, 0) === 10, 'coord C7: a second hit is un-amplified (window already spent)');
  }

  // ── C8: EXPOSE is hostile-only — an area cast never opens a window on a same-faction ally ──
  {
    const st = new FeatureStage(helpers);
    try {
      const caster = st.add('Caster', 0, 0, { combatant: true });
      const ally = st.add('Ally', 1, 0, { combatant: true });           // same faction (townsfolk)
      const foe = st.add('Foe', 1.5, 0, { faction: 'monster' });
      const aoe = mkSpec({
        id: 't_aoe_expose', name: '[T]', classKey: null, tier: 1,
        header: { target: 'any', range: 6, cooldown: 0, area: { kind: 'circle', r: 6 }, delivery: { kind: 'instant' } },
        effects: [mkEffect('expose', { amount: 1.5, dur: 4 })], grantsTags: [],
      });
      st.ctx().resolver.cast(aoe, caster);
      const now = st.sim.time;
      ok(exposeActive(foe.fighter, now), 'coord C8: the foe IS exposed by the area cast');
      ok(!exposeActive(ally.fighter, now), 'coord C8: the same-faction ally is NOT exposed (HOSTILE_OPS friendly-fire guard)');
    } finally { st.dispose(); }
  }

  // ── C9: CAPABILITY (§10) — comboRoleOf reads EFFECT OPS; accrual crosses then decays; the witness fires ──
  {
    ok(comboRoleOf(ABILITY_CATALOG.frost_bolt) === 'control', 'coord C9: a slow spec reads as a CONTROL role');
    ok(comboRoleOf(ABILITY_CATALOG.power_strike) === 'burst', 'coord C9: a heavy-damage spec reads as a BURST role');
    ok(comboRoleOf(ABILITY_CATALOG.expose_weakness) === 'control', 'coord C9: the expose setup reads as CONTROL');
    const w = { _allyRole: undefined };
    accrueAllyRole(w, 7, 'control', 0, 0.4);
    ok(believedRole(w, 7, 0) === 'control', 'coord C9: accrued belief crosses roleMinConf → believedRole control');
    ok(believedRole(w, 7, 99999) === 'none', 'coord C9: it DECAYS below threshold over time (use it or lose it)');
    // the live bus witness: a band-mate accrues a capability belief from a seen cast.
    const st = new FeatureStage(helpers);
    try {
      const L = st.add('Cap', 0, 0, { combatant: true });
      const caster = join(st, st.add('Caster', 0, 0, { combatant: true }), L);
      const witness = join(st, st.add('Witness', 1, 0, { combatant: true }), L);   // band-mate, in vision
      st.add('Foe', 2, 0, { faction: 'monster' });                                  // a target so frost_bolt fires
      caster.abilities.set('frost_bolt', ABILITY_CATALOG.frost_bolt);
      st.ctx().resolver.cast(ABILITY_CATALOG.frost_bolt, caster);
      const bag = witness._allyRole && witness._allyRole.get(caster.id);
      ok(bag && bag.control > 0, `coord C9: the band-mate WITNESS accrued a control-capability belief from the seen cast (got ${bag && bag.control})`);
    } finally { st.dispose(); }
  }

  // ── C10: COMBO SETUP (§8b) — a controller, believing an adjacent ally is a burster, opens a window ──
  {
    const st = new FeatureStage(helpers);
    try {
      const L = st.add('Cap', 0, 0, { combatant: true });
      const M = join(st, st.add('Ctrl', 0, 0, { combatant: true }), L);     // the controller
      const A = join(st, st.add('Burst', 5, 0, { combatant: true }), L);    // the burst ally, on the foe
      const F = st.add('Foe', 6, 0, { faction: 'monster' });
      M.abilities.set('expose_weakness', ABILITY_CATALOG.expose_weakness);
      accrueAllyRole(M, A.id, 'burst', 0, 0.6);                             // M believes A is a burster
      const fired = tryComboSetup(M, st.ctx());
      ok(fired === true, 'coord C10: a controller SETS UP — casts its control spec for the believed-burst ally');
      ok(exposeActive(F.fighter, st.sim.time), 'coord C10: the setup opened a combo window on the foe');
    } finally { st.dispose(); }
  }

  // ── C11: WRONG-PREDICTION SAFETY (§8c) — a burst member's hold TIMES OUT and it attacks (no deadlock) ──
  {
    const st = new FeatureStage(helpers);
    try {
      const L = st.add('Cap', 0, 0, { combatant: true });
      const B = join(st, st.add('Burst', 0, 0, { combatant: true }), L);
      const A = join(st, st.add('Ctrl', 5, 0, { combatant: true }), L);     // band-mate on the foe
      const F = st.add('Foe', 6, 0, { faction: 'monster' });
      accrueAllyRole(B, A.id, 'control', 0, 0.6);                           // B believes A will open the foe
      const base = st.sim._cognitionCtx();
      const at = (t) => ({ ...base, time: t });
      ok(comboHold(B, at(0), F) === true, 'coord C11: a burster HOLDS for a control ally about to open the foe');
      ok(comboHold(B, at(0.7), F) === false, `coord C11: the hold times out within comboHoldMax and it attacks (no deadlock)`);
    } finally { st.dispose(); }
  }
}
