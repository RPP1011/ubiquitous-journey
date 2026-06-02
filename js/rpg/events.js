// The RPG event spine. Every meaningful deed in the sim (a landed blow, a kill,
// a sale, a forged tool, a persuasion) is published here as an ActionEvent.
// Progression listens to route XP/class-matching; abilities/quests/reputation
// can subscribe too. Synchronous, fan-out, dependency-free.

import { sanitizeTags } from './tags.js';

// ActionEvent shape (the shared contract — keep field names stable):
//   { actorId:number, verb:string, tags:string[], magnitude:number,
//     targetId?:number, t:number }
// Use makeEvent to normalise tags + default magnitude/time.
export function makeEvent({ actorId, verb, tags = [], magnitude = 1, targetId, t }) {
  return {
    actorId,
    verb,
    tags: sanitizeTags(tags),
    magnitude,
    targetId,
    t: t ?? 0,
  };
}

// A minimal synchronous event bus: emit() fans an event to every subscriber in
// registration order. on() returns an unsubscribe fn. Listener errors are
// caught so one bad subscriber can't break the sim loop.
class EventBus {
  constructor() { this._fns = []; }

  on(fn) {
    this._fns.push(fn);
    return () => { const i = this._fns.indexOf(fn); if (i >= 0) this._fns.splice(i, 1); };
  }

  off(fn) { const i = this._fns.indexOf(fn); if (i >= 0) this._fns.splice(i, 1); }

  emit(ev) {
    // iterate a snapshot so a listener may safely unsubscribe during dispatch
    const fns = this._fns;
    for (let i = 0; i < fns.length; i++) {
      try { fns[i](ev); }
      catch (e) { console.warn('event listener error', e); }
    }
  }

  clear() { this._fns.length = 0; }
}

// The single shared bus instance. Import { bus } everywhere.
export const bus = new EventBus();

// Convenience: build + emit in one call. Returns the normalised event.
export function emit(spec) {
  const ev = makeEvent(spec);
  bus.emit(ev);
  return ev;
}
