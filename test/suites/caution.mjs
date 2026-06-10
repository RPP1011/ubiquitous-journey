// ---- outcome-conditioned caution, always-live (docs/architecture/11) ---------------------------
// The burned-hand half of regret: a per-agent, per-strategy signed surcharge — written when a
// watched theft-shaped act falls short / wastes a journey / nearly kills you, eroded by time and by
// success, read inside `cost` beside confidenceSurcharge. Tests the STORE math + CLASSIFICATION +
// ATTRIBUTION + the PLANNER read + the BOUNDS directly (deterministic), plus an end-to-end frame-loop
// integration proving the emit chain (act.ts emit site → handler → store) writes a real burn — and
// the §8 regression that an unwatched combat verb is never burned.
import { FeatureStage } from './_stage.mjs';
import { goalSteal } from '../../js/sim/planner.js';
import {
  recordBurn, recordWindfall, feltSurcharge, classifyYield, decayed, expKey,
} from '../../js/sim/experience.js';
import { CAUTION } from '../../js/sim/simconfig.js';

export function cautionTest(ok, helpers) {
  {
    const now = 1000;
    const mk = () => ({ _actExperience: new Map(), personality: { risk_tolerance: 0.5 }, beliefs: null });

    // C1 — a thin cache CLASSIFIES as shortfall, and a shortfall BURNS the strategy (s > 0).
    ok(classifyYield(50, 8) === 'shortfall', 'C1: a thin cache (8 of 50) classifies as shortfall');
    {
      const a = mk();
      recordBurn(a, expKey('burgle'), 'shortfall', 0, now);
      ok((a._actExperience.get('burgle')?.s ?? 0) > 0, 'C1: a shortfall burns the burgle strategy (s > 0)');
    }

    // C2 — the EMPTY cache classifies the SAME as the thin one (shortfall), not silent, not waste.
    ok(classifyYield(50, 0) === 'shortfall', 'C2: an empty cache (0 of 50) classifies as shortfall — same class as thin');

    // C3 — the burn REDIRECTS: a burned strategy reads dearer than an unburned substitute, so the
    //      planner's min-cost comparison prefers the substitute (burgle burned ⇒ loot looks cheaper).
    {
      const a = mk();
      for (let i = 0; i < 6; i++) recordBurn(a, 'burgle', 'shortfall', 0, now);   // push burgle toward cap
      const burned = feltSurcharge(a, 'burgle', {}, now);
      const fresh = feltSurcharge(a, 'loot', {}, now);
      ok(burned > fresh && fresh === 0, `C3: a burned strategy is priced dearer than a fresh substitute (burgle ${burned.toFixed(2)} > loot ${fresh})`);
    }

    // C4 — DECAY restores the appetite: after ~3 half-lives the surcharge is a quarter or less.
    {
      const a = mk();
      recordBurn(a, 'burgle', 'shortfall', 0, now);
      const fresh = feltSurcharge(a, 'burgle', {}, now);
      const old = feltSurcharge(a, 'burgle', {}, now + 3 * CAUTION.halfLife);
      ok(old < fresh / 4 && old >= 0, `C4: decay erodes the burn toward 0 (${fresh.toFixed(2)} -> ${old.toFixed(2)} after 3 half-lives)`);
    }

    // C5 — the NEUTRAL band is silent: a mildly-disappointing 70% night writes nothing.
    ok(classifyYield(50, 35) === 'neutral', 'C5: a 70%-of-expectation night is neutral (no write)');

    // C6 — WINDFALL embolds, but shallowly: genuine success writes a NEGATIVE entry, clamped to capDiscount.
    {
      const a = mk();
      ok(classifyYield(50, 60) === 'windfall', 'C6: a haul at/above expectation is a windfall');
      for (let i = 0; i < 20; i++) recordWindfall(a, 'burgle', now);
      const s = a._actExperience.get('burgle').s;
      ok(s < 0 && s >= -CAUTION.capDiscount, `C6: windfall embolds shallowly (s=${s.toFixed(2)} in [${-CAUTION.capDiscount}, 0))`);
    }

    // C7 — ATTRIBUTION: the same shortfall burns LESS when the belief was confident (bad luck) than
    //      when it was a knowing gamble.
    {
      const a = mk();
      recordBurn(a, 'sure', 'shortfall', 0.9, now);    // confident-and-wrong ⇒ mostly luck
      recordBurn(a, 'gamble', 'shortfall', 0.2, now);  // knew little ⇒ a real lesson
      const sure = a._actExperience.get('sure').s, gamble = a._actExperience.get('gamble').s;
      ok(sure < gamble, `C7: a confident failure burns less than a gamble (conf0.9 ${sure.toFixed(2)} < conf0.2 ${gamble.toFixed(2)})`);
    }

    // C8 — DESPERATION override: a fully-burned strategy stays FINITE (≤ cap), never infeasible, so a
    //      widened/desperate search can still select it (no timidity lock).
    {
      const a = { _actExperience: new Map(), personality: { risk_tolerance: 0 }, beliefs: null };
      for (let i = 0; i < 50; i++) recordBurn(a, 'burgle', 'peril', 0, now);   // hammer it
      const s = feltSurcharge(a, 'burgle', {}, now);
      ok(Number.isFinite(s) && s <= CAUTION.cap, `C8: a fully-burned strategy is finite (s=${s.toFixed(2)} ≤ cap ${CAUTION.cap}) — no timidity lock`);
    }

    // C12 — BOUNDS. |s| clamps; the store evicts past maxKeys.
    {
      const a = mk();
      for (let i = 0; i < 100; i++) recordBurn(a, 'burgle', 'peril', 0, now);
      ok(a._actExperience.get('burgle').s <= CAUTION.cap, 'C12: burn clamps to cap');
      for (let i = 0; i < CAUTION.maxKeys + 6; i++) recordBurn(a, 'k' + i, 'shortfall', 0, now + i);
      ok(a._actExperience.size <= CAUTION.maxKeys, `C12: the store is bounded at maxKeys (${a._actExperience.size} ≤ ${CAUTION.maxKeys})`);
    }

    // ── INTEGRATION (the emit chain): a real heist on a near-empty mark, driven through the frame
    //    loop, writes a burn into the thief's store — proving act.ts emit site → handler → store. ──
    {
      const st = new FeatureStage(helpers);
      const thief = st.add('Pinch', 0, 0, { personality: { altruism: 0.2, risk_tolerance: 0.8 } });
      const mark = st.add('Skint', 8, 0);
      st.strip(thief);
      for (const k in thief.needs) thief.needs[k] = 1;
      mark.gold = 4;                                   // a near-empty mark: realized ≪ believed haul
      st.believe(thief, mark);
      thief.pushGoal(goalSteal(mark.id, 50), st.ctx());   // believed haul 50, actual ≤ 4 ⇒ shortfall
      st.run(() => {
        const e = thief._actExperience && thief._actExperience.get('burgle');
        const er = thief._actExperience && thief._actExperience.get('rob');
        return (e && e.s > 0) || (er && er.s > 0);
      }, { maxFrames: 4000, pin: [[mark, 8, 0]], refresh: [[thief, mark]] });
      const burned = ['burgle', 'rob'].some((k) => (thief._actExperience?.get(k)?.s ?? 0) > 0);
      ok(burned, `C-int: a real heist on a near-empty mark burned the thief's strategy (burgle=${(thief._actExperience?.get('burgle')?.s ?? 0).toFixed(2)}, rob=${(thief._actExperience?.get('rob')?.s ?? 0).toFixed(2)})`);
      // §8 REGRESSION: no combat verb was ever burned — `attack` is NOT watched.
      ok(!(thief._actExperience && thief._actExperience.has('attack')), 'C11: a combat verb (attack) is never burned — not in the watched set (§8 regression)');
      st.dispose();
    }
  }
}
