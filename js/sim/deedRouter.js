// The RPG event router + autobiographical-memory deed recorder, extracted from
// Simulation as free functions over the sim instance (orchestration vs.
// mechanics split). `installDeedRouter` wires the bus subscription; `recordDeed`
// turns a salient bus deed into an episode.

import { bus } from '../rpg/events.js';
import { RPG } from '../rpg/rpgconfig.js';
import { MONSTER } from './simconfig.js';

// RPG event router: every ActionEvent on the bus is delivered to the actor's
// Progression. Progression's own self-emitted level/class/ability events
// route too, but carry tags:[] so onEvent does no XP work (intended no-op).
// The bus snapshots its listener list per emit(), so re-entrant emits from
// inside onEvent are safe (no recursion blow-up) and listener errors are
// swallowed by the bus.
// Returns the unsubscribe handle (stored as sim._busOff by the caller).
export function installDeedRouter(sim) {
  return bus.on((ev) => {
    const a = sim.agentsById.get(ev.actorId);
    if (!a) return;
    if (a.progression) a.progression.onEvent(ev, ev.t || sim.time);
    if (a.memory) recordDeed(sim, a, ev);   // autobiographical memory
  });
}

// Turn a salient bus deed into an autobiographical episode (most deeds are too
// mundane to remember; record only the spikes). Combat-victim/​witness episodes
// are recorded directly in onCombatEvents where the perspective is the target.
export function recordDeed(sim, a, ev) {
  const t = ev.t || sim.time;
  let ep = null;
  switch (ev.verb) {
    case 'kill': {
      const T = ev.targetId != null ? sim.agentsById.get(ev.targetId) : null;
      const monster = T && T.faction === MONSTER.faction;
      ep = monster
        ? { t, kind: 'triumph', withId: ev.targetId, valence: 1, salience: 0.6 + 0.2 * (ev.magnitude || 0) }
        : { t, kind: 'bloodshed', withId: ev.targetId, valence: -1, salience: 0.85 };
      break;
    }
    case 'sell': case 'buy': {
      const windfall = (ev.magnitude || 1) - 1;            // bargain/profit over a mundane trade
      if (windfall > 0.4) {
        const sal = Math.min(0.9, 0.3 + windfall);
        ep = { t, kind: 'windfall', place: 'market', valence: 1, salience: sal };
        // NARRATIVE BEAT: a genuine WINDFALL (a fat bargain/profit, not the
        // routine grind-floored trade) is a storied moment. Routine TRADE deeds
        // already pay their decayed share via onEvent; this is the spike on top.
        // Windfalls are FREQUENT for a merchant, so they're discounted (mult)
        // relative to the dramatic danger/closure beats — a fat purse alone
        // shouldn't out-story a slain monster or an avenged friend.
        if (a.progression) { try { a.progression.addNarrativeXP(sal, t, RPG.narrativeWindfallMult || 1); } catch { /* never throw */ } }
      }
      break;
    }
    case 'QUEST_DONE':   ep = { t, kind: 'triumph', withId: ev.targetId, valence: 1, salience: 0.55 }; break;
    // routine level-ups aren't memorable; becoming a whole new CLASS is. The
    // emit fires right after the class is inserted, so the newest one is it.
    case 'class_gained': {
      const cls = [...a.progression.classes.values()].pop();
      ep = { t, kind: 'milestone', label: cls ? cls.name : null, valence: 1, salience: 0.7 };
      break;
    }
    case 'recruited':    ep = { t, kind: 'bond', valence: 1, salience: 0.5 }; break;
  }
  if (ep) a.memory.record(ep);
}
