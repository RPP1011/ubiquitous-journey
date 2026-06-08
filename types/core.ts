// Core primitives shared by every type module. No imports — these are the atoms.

/** An entity id. Agents use numbers; percepts/buildings use namespaced strings (e.g. 'B:3'). */
export type EntityId = number | string;

/** A ground-plane point (x/z); y is cosmetic and reasoned-around. */
export interface Vec2Like { x: number; z: number; }

/** A positional snapshot handed back by the execution resolver — NOT a live agent. */
export interface PosSnapshot { x: number; y: number; z: number; alive?: boolean; }

/** A minimal vision-gated reference (id + pos) — never the live roster object. */
export interface AgentRef { id: EntityId; pos: PosSnapshot; }
