// Optional LLM enrichment for the Gazette. Turns a deterministic StoryBrief (built
// headless by the Reporter, js/sim/gazette.js) into a short newspaper article, and
// SWAPS it into the already-published template article in place. Built on the same
// transport + config + discipline as js/ai/llm.js.
//
// HARD RULES (mirrors llm.js, see CLAUDE.md "freeze lesson"):
//   * NEVER on the sim tick. The pump is driven by the browser (the Gazette panel).
//   * generateArticle() resolves to { headline, body } OR null. It NEVER throws.
//     Any failure (off, server down, timeout, CORS, junk) -> null, and the
//     template article (the floor) stays. A fresh checkout behaves exactly as before.
//   * Default OFF — gated by the SAME `hearsay.llm` flag as dialogue (llmConfig).
//
// Enable from the devtools console (same handle as dialogue): llmConfig({ enabled: true }).

import { getConfig, isEnabled } from './llm.js';
import type { ChatMessage, LlmConfig } from './llm.js';
import type { StoryBrief } from '../../types/sim.js';

/** The enriched prose an article body is replaced with: a headline + body. */
export interface Prose { headline: string; body: string; }

const PRESS_MAX_TOKENS = 200;     // a headline + a few sentences (longer than a dialogue line)

// Build the chat messages from a StoryBrief. The brief is the ONLY source of truth
// handed to the model — the system prompt forbids inventing anything beyond it, so
// the epistemic split holds (the article reports the subject's testimony, not
// omniscient world truth) by construction.
function buildMessages(brief: StoryBrief): ChatMessage[] {
  const b = brief || ({} as StoryBrief);
  if (b.kind === 'obituary') return buildObituaryMessages(b);
  const hearsay = b.hearsay as { text?: string } | null | undefined;
  const bio = (b.bio || []) as string[];
  const memories = (b.memories || []) as string[];
  const beats = (b.beats || []) as string[];
  const subjLine = `${b.subjectName || 'A townsperson'}${b.epithet ? `, called "${b.epithet}"` : ''} — ${bio[0] || 'a soul of the town'}, of ${b.dateline || 'the town'}.`;
  const lines: string[] = [`SUBJECT: ${subjLine}`];
  // THE ANGLE — the throughline to build the piece around (their drive + a fresh turn).
  if (b.drive) lines.push(`THE ANGLE: this soul is ${b.drive}. Build the item around this.`);
  if (b.risen) lines.push(`FRESH TURN: they have newly risen as ${b.risen} — a development worth leading with.`);
  if (b.role) lines.push(`STANDING: ${b.role}.`);
  if (b.ambition) lines.push(`LONG AMBITION: to ${b.ambition}.`);
  if (b.faith) lines.push(`FAITH: keeps the faith of ${b.faith}.`);
  if (b.mood) lines.push(`PRESENTLY: ${b.mood}.`);
  // a rumour the subject themselves spreads — print it AS their claim, hedged by its
  // provenance (it may well be false); never assert it as fact in your own voice.
  if (hearsay && hearsay.text) lines.push(`A RUMOUR THEY REPEAT (attribute to them, do not endorse): they ${hearsay.text}.`);
  if (bio.length) lines.push(`DEEDS: ${bio.join('; ')}.`);
  if (memories.length) {
    lines.push('WHAT THEY LIVED THROUGH (their own account):');
    for (const m of memories) lines.push(` - ${m}`);
  }
  const rel = (b.relations || {}) as Record<string, unknown>;
  const rels: string[] = [];
  if (rel.spouse) rels.push(`wed to ${rel.spouse}`);
  if (rel.rival) rels.push(`rival to ${rel.rival}`);
  if (rel.kin) rels.push(`${rel.kin} of kin`);
  if (rels.length) lines.push(`RELATIONS: ${rels.join('; ')}.`);
  if (beats.length) lines.push(`RECENT TOWN BEATS: ${beats.join(' ')}`);
  lines.push('Write the item.');

  const system =
    'You are the gazetteer of a medieval market-town, writing a short, characterful ' +
    'newspaper item about one soul. Write ONLY from the facts provided — never invent ' +
    'names, deaths, or events not given; you may interpret motive and mood from them. ' +
    'Find the ANGLE: open on the throughline (their drive, or the fresh turn), then ' +
    'let their deeds and ties earn it out — characterise, do not merely list. Voice: ' +
    'vivid, wry, grounded, past tense, a touch of a storyteller. Output a HEADLINE ' +
    'line beginning "HEADLINE:" (punchy, specific, no more than ~9 words), then a ' +
    '2-4 sentence article. No markup, no lists.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
}

// An OBITUARY: same only-from-facts discipline, an elegiac register, and the
// on-theme instruction to eulogise the person the TOWN believed in — leaning into
// the gap when a name was blackened by rumour.
function buildObituaryMessages(b: StoryBrief): ChatMessage[] {
  const bio = (b.bio || []) as string[];
  const memories = (b.memories || []) as string[];
  const cause = (b.cause as string | undefined) || 'have died';
  const regardVal = (b.regard as number | undefined) || 0;
  const subjLine = `${b.subjectName || 'A townsperson'}${b.epithet ? `, called "${b.epithet}"` : ''} — ${bio[0] || 'a soul of the town'}, of ${b.dateline || 'the town'}.`;
  const lines: string[] = [`THE DECEASED: ${subjLine}`, `HOW THEY FELL: they ${cause}.`];
  if (bio.length) lines.push(`THEIR LIFE: ${bio.join('; ')}.`);
  if (memories.length) { lines.push('WHAT THEY LIVED THROUGH:'); for (const m of memories) lines.push(` - ${m}`); }
  const rel = (b.relations || {}) as Record<string, unknown>;
  const rels: string[] = [];
  if (rel.spouse) rels.push(`wed to ${rel.spouse}`);
  if (rel.kin) rels.push(`${rel.kin} of kin left behind`);
  if (rels.length) lines.push(`THEY LEAVE: ${rels.join('; ')}.`);
  const regard = regardVal > 0.25 ? 'well loved' : regardVal <= -0.25 ? 'little mourned' : 'an ordinary regard';
  lines.push(`THE TOWN'S REGARD: ${regard}${b.hounded ? ', and in their last days rumour had turned many against them (perhaps unjustly)' : ''}.`);
  lines.push('Write the obituary.');
  const system =
    'You are the gazetteer of a medieval market-town, writing a short obituary for one ' +
    'who has died. Write ONLY from the facts provided — never invent names, deaths, or ' +
    'events not given; you may interpret feeling from them. Eulogise the person the town ' +
    'BELIEVED in — and if rumour blackened them, let that gap show, gently. Voice: elegiac, ' +
    'grounded, past tense, unsentimental but humane. Output a HEADLINE line beginning ' +
    '"HEADLINE:", then a 2-4 sentence obituary. No markup, no lists.';
  return [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }];
}

// Parse the model's reply into { headline, body }, defensively. Returns null if it
// can't make a usable article (then the template stands).
function parseArticle(raw: unknown): Prose | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  // strip code fences / markdown emphasis the model might add
  text = text.replace(/```/g, '').replace(/[*_#]+/g, '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  let headline: string | null = null, bodyLines: string[] = [];
  for (const l of lines) {
    const m = /^headline\s*:\s*(.+)$/i.exec(l);
    if (m && !headline) { headline = m[1].trim(); continue; }
    bodyLines.push(l);
  }
  if (!headline) { headline = lines[0]; bodyLines = lines.slice(1); }   // no marker -> first line is the head
  headline = clean(headline, 140);
  const body = clean(bodyLines.join(' '), 600);
  if (!headline || !body) return null;
  return { headline, body };
}

function clean(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  let t = s.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (t.length > max) t = t.slice(0, max).trim();
  return t;
}

// --- the one public call ---------------------------------------------------
// Resolves to { headline, body } or null. NEVER throws.
export async function generateArticle(brief: StoryBrief): Promise<Prose | null> {
  let cfg: LlmConfig;
  try { cfg = getConfig(); } catch { return null; }
  if (!cfg.enabled || !cfg.endpoint) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const res = await fetch(cfg.endpoint, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({
        model: cfg.model,
        messages: buildMessages(brief),
        max_tokens: PRESS_MAX_TOKENS,
        temperature: cfg.temperature,
        stream: false,
      }),
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return parseArticle(raw);
  } catch {
    return null;                                       // abort / network / parse
  } finally {
    clearTimeout(timer);
  }
}

// --- the browser pump ------------------------------------------------------
// Drains the Gazette's pending queue ONE at a time and swaps LLM prose into the
// already-published article in place (by id). Browser-only; never on the tick.
// Returns a stop() handle. Safe no-op when the LLM is disabled or unavailable.
let _busy = false;

// The slice of the (still-.js) Simulation the pump reaches into — just its Gazette.
interface PressSim {
  gazette?: {
    takePendingId(): number | null;
    getById(id: number): { brief?: StoryBrief } | null;
    applyArticle(id: number, prose: Prose): boolean;
  } | null;
}

export async function pumpOnce(sim: PressSim | null | undefined): Promise<void> {
  try {
    if (_busy || !sim || !sim.gazette || !isEnabled()) return;
    const id = sim.gazette.takePendingId();
    if (id == null) return;
    const art = sim.gazette.getById(id);
    if (!art || !art.brief) return;        // evicted from the ring already — skip
    _busy = true;
    const prose = await generateArticle(art.brief);
    if (prose) sim.gazette.applyArticle(id, prose);
  } catch { /* never throw */ } finally {
    _busy = false;
  }
}

// start a periodic pump (idempotent). `getSim` returns the live sim. Returns stop().
let _interval: ReturnType<typeof setInterval> | null = null;
export function startPress(getSim: () => PressSim | null | undefined, everyMs = 1500): () => void {
  if (typeof window === 'undefined') return () => {};
  if (_interval) return () => stopPress();
  _interval = setInterval(() => {
    try { const sim = getSim && getSim(); if (sim) pumpOnce(sim); } catch { /* */ }
  }, everyMs);
  return () => stopPress();
}
export function stopPress(): void { if (_interval) { clearInterval(_interval); _interval = null; } }
