// The RPG event spine. Every meaningful deed in the sim (a landed blow, a kill,
// a sale, a forged tool, a persuasion) is published here as an ActionEvent.
// Progression listens to route XP/class-matching; abilities/quests/reputation
// can subscribe too. Synchronous, fan-out, dependency-free.

import { sanitizeTags } from './tags.js';
import type { ActionEvent, ActionEventSpec, EventBus as IEventBus } from '../../types/sim.js';

// ActionEvent shape (the shared contract — keep field names stable):
//   { actorId:number, verb:string, tags:string[], magnitude:number,
//     targetId?:number, t:number }
// Use makeEvent to normalise tags + default magnitude/time.
export function makeEvent({ actorId, verb, tags = [], magnitude = 1, targetId, t, allies }: ActionEventSpec): ActionEvent {
  return {
    actorId,
    verb,
    tags: sanitizeTags(tags),
    magnitude,
    targetId,
    t: t ?? 0,
    allies,
  };
}

type Listener = (ev: ActionEvent) => void;

// A minimal synchronous event bus: emit() fans an event to every subscriber in
// registration order. on() returns an unsubscribe fn. Listener errors are
// caught so one bad subscriber can't break the sim loop.
class EventBus implements IEventBus {
  _fns: Listener[];

  constructor() { this._fns = []; }

  on(fn: Listener): () => void {
    this._fns.push(fn);
    return () => { const i = this._fns.indexOf(fn); if (i >= 0) this._fns.splice(i, 1); };
  }

  off(fn: Listener): void { const i = this._fns.indexOf(fn); if (i >= 0) this._fns.splice(i, 1); }

  emit(ev: ActionEvent): void {
    // iterate a snapshot so a listener may safely unsubscribe during dispatch
    const fns = this._fns;
    for (let i = 0; i < fns.length; i++) {
      try { fns[i](ev); }
      catch (e) { console.warn('event listener error', e); }
    }
  }

  clear(): void { this._fns.length = 0; }
}

// The single shared bus instance. Import { bus } everywhere.
export const bus = new EventBus();

// Convenience: build + emit in one call. Returns the normalised event.
export function emit(spec: ActionEventSpec): ActionEvent {
  const ev = makeEvent(spec);
  bus.emit(ev);
  return ev;
}
