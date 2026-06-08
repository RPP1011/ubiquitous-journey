// The journalism layer: the world history feed (js/sim/chronicle.js), the town
// newspaper (js/sim/gazette.js), and the bounty labour market (js/sim/bounties.js).

import type { EntityId } from './core.js';

/** The chronicle beat kinds the UI colour-codes by (chronicle.js BEAT). */
export type BeatKind =
  | 'death' | 'kill' | 'vendetta' | 'prodigy' | 'fortune' | 'raid' | 'birth'
  | 'mentor' | 'faith' | 'watch' | 'patrician' | 'legend' | 'union' | 'build'
  | 'note' | (string & {});

/** One chronicle beat — a timestamped, name-phrased line in the world history feed. */
export interface Beat {
  seq: number;
  kind: BeatKind;
  subjectId: EntityId | null;
  text: string;
  t: number;
  arc?: { id: string; title: string };
}

/** A Gazette story brief — the structured "interview" a (template/LLM) article is framed from. */
export interface StoryBrief {
  kind: string;                 // 'person'|'opportunity'|'obituary'|…
  subjectId?: EntityId;
  subjectName?: string;
  given?: string;
  epithet?: string | null;
  dateline?: string;
  originTown?: number | null;
  bio?: string[];
  memories?: string[];
  relations?: Record<string, unknown>;
  beats?: unknown[];
  drive?: string | null;
  role?: string | null;
  faith?: string | null;
  calling?: string | null;
  level?: number;
  risen?: string | null;
  ambition?: string | null;
  mood?: string | null;
  hearsay?: unknown;
  questId?: EntityId | null;    // opportunity briefs carry the advertised quest
  t: number;
  [k: string]: unknown;
}

/** A filed Gazette article (a brief + its rendered body). */
export interface Article {
  brief: StoryBrief;
  headline?: string;
  body?: string;
  t?: number;
  [k: string]: unknown;
}

/** A bounty-hunter assignment flagged onto an agent (bounties.js — `agent.bounty`). */
export interface Bounty {
  questId: EntityId;
  type: string;                 // 'hunt'|'avenge'|…
  faction: string | null;
  killerId: EntityId | null;
  count: number;
  got: number;
  toward: { x: number; z: number };
  giverId: EntityId;
  expire: number;
}
