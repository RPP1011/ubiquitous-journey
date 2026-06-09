// Optional LLM-flavoured NPC dialogue. Self-contained, dependency-free client
// for a vLLM OpenAI-compatible server (default LiquidAI/LFM2.5-350M). It turns a
// plain "persona" object — built from ONE NPC's beliefs + state (the epistemic
// split: never omniscient world truth) — into a single short spoken line.
//
// HARD RULES this module obeys (see CLAUDE.md "freeze lesson"):
//   * It is NEVER awaited on the simulation tick. Callers use it from the modal
//     dialogue path (user-paced) only.
//   * generateLine() resolves to a string OR null. It NEVER throws. Any failure
//     (feature off, server down, timeout, CORS, bad JSON, junk output) -> null,
//     and the caller falls back to the existing templated text. A fresh checkout
//     with no server running therefore behaves EXACTLY as before.
//   * The feature flag DEFAULTS OFF. Nothing here runs unless explicitly enabled
//     via localStorage (or by editing DEFAULTS.enabled below).
//
// Enable in-game from the browser devtools console:
//   llmConfig({ enabled: true })            // turn it on (persists in localStorage)
//   llmConfig({ enabled: false })           // turn it off again
//   llmConfig({ endpoint: 'http://localhost:8001/v1/chat/completions' })
//   llmConfig()                             // -> read current effective config
// (window.llmConfig is also exposed for convenience.)

const LS_KEY = 'hearsay.llm';

/** Effective LLM client configuration (DEFAULTS overlaid with localStorage). */
export interface LlmConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  cacheSize: number;
}

/** A chat message in the OpenAI-compatible request shape. */
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

/** The plain persona bundle the dialogue layer fills from ONE NPC's beliefs/state. */
export interface Persona {
  name?: string;
  profession?: string;
  faction?: string;
  traits?: string;
  mood?: string;
  needs?: string;
  gold?: number;
  want?: string;
  aboutPlayer?: string;
  rumour?: string;
  prompt?: string;
  [k: string]: unknown;
}

// Defaults. Endpoint port is 8001 on purpose: the game's static site is served
// by `python3 -m http.server 8000`, so vLLM must listen elsewhere to avoid a
// port clash. See docs/llm-npcs.md for the matching `vllm serve` command.
const DEFAULTS: LlmConfig = {
  enabled: false,                                            // OFF by default
  endpoint: 'http://localhost:8001/v1/chat/completions',
  model: 'LiquidAI/LFM2.5-350M',
  apiKey: '',                  // only if you started vLLM with --api-key
  timeoutMs: 3000,             // AbortController budget per request
  maxTokens: 64,               // NPC lines are short
  temperature: 0.8,
  cacheSize: 64,               // tiny LRU of recent (key -> line)
};

function readLS(): Partial<LlmConfig> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Partial<LlmConfig>) : {};
  } catch { return {}; }
}
function writeLS(obj: Partial<LlmConfig>): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}

// Effective config = DEFAULTS overlaid with whatever is in localStorage.
export function getConfig(): LlmConfig {
  return { ...DEFAULTS, ...readLS() };
}

// Read or update config. Pass a partial patch to persist it; pass nothing to
// just read. Returns the effective config either way.
export function llmConfig(patch?: Partial<LlmConfig>): LlmConfig {
  if (patch && typeof patch === 'object') {
    const next = { ...readLS(), ...patch };
    writeLS(next);
  }
  return getConfig();
}

export function isEnabled(): boolean {
  return !!getConfig().enabled;
}

// --- in-flight dedupe + tiny LRU cache -------------------------------------
const _cache = new Map<string, string>();              // key -> string (insertion-ordered = LRU)
const _inflight = new Map<string, Promise<string | null>>();  // key -> Promise<string|null>

function cacheGet(key: string): string | undefined {
  if (!_cache.has(key)) return undefined;
  const v = _cache.get(key) as string;     // bump recency
  _cache.delete(key); _cache.set(key, v);
  return v;
}
function cacheSet(key: string, val: string, limit: number): void {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, val);
  while (_cache.size > limit) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

// --- prompt construction (BELIEFS, not ground truth) -----------------------
// `persona` is a plain object the dialogue layer fills from one NPC's state.
// We only read what's handed to us; we never reach back into the sim here.
function buildMessages(persona: Persona): ChatMessage[] {
  const p = persona || {};
  const facts: string[] = [];
  if (p.profession) facts.push(`You work as a ${p.profession}.`);
  if (p.faction) facts.push(`You belong to the ${p.faction}.`);
  if (p.traits) facts.push(`Your temperament: ${p.traits}.`);
  if (p.mood) facts.push(`Right now you feel ${p.mood}.`);
  if (p.needs) facts.push(`On your mind: ${p.needs}.`);
  if (typeof p.gold === 'number') facts.push(`You have about ${p.gold} gold.`);
  if (p.want) facts.push(`You could use ${p.want}.`);
  if (p.aboutPlayer) facts.push(`Your impression of the traveller before you: ${p.aboutPlayer}.`);
  if (p.rumour) facts.push(`The latest thing you've heard: ${p.rumour}.`);

  const system =
    `You are ${p.name || 'a townsperson'}, an NPC in a medieval market-town. ` +
    `Speak ONLY as this character, in first person, in ONE short spoken line ` +
    `(under 25 words). No narration, no quotation marks, no stage directions. ` +
    `Stay in character and reflect what you believe — you are not all-knowing.\n` +
    (facts.length ? facts.join(' ') : '');

  const user = p.prompt ||
    'The traveller approaches and looks at you. Greet them in character.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Stable cache key: persona identity + situation, NOT live config.
function cacheKey(persona: Persona): string {
  const p = persona || {};
  return [p.name, p.profession, p.mood, p.aboutPlayer, p.rumour, p.want, p.prompt]
    .map((x) => (x == null ? '' : String(x))).join('|');
}

// Tidy a model line: strip wrapping quotes/whitespace, collapse to first line,
// reject empties / obvious junk. Returns a clean string, or null if unusable.
function sanitize(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  s = s.split('\n')[0].trim();                       // first line only
  s = s.replace(/^["'“‘]+|["'”’]+$/g, '').trim();  // strip quotes
  if (!s) return null;
  if (s.length > 240) s = s.slice(0, 240).trim();    // hard length cap
  return s;
}

// --- the one public call ---------------------------------------------------
// Resolves to a clean string or null. NEVER throws.
export async function generateLine(persona: Persona): Promise<string | null> {
  let cfg: LlmConfig;
  try { cfg = getConfig(); } catch { return null; }
  if (!cfg.enabled || !cfg.endpoint) return null;

  const key = cacheKey(persona);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const pending = _inflight.get(key);
  if (pending) return pending;

  const promise: Promise<string | null> = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          model: cfg.model,
          messages: buildMessages(persona),
          max_tokens: cfg.maxTokens,
          temperature: cfg.temperature,
          stream: false,
          stop: ['\n'],
        }),
      });
      if (!res || !res.ok) return null;
      const data = await res.json();
      const raw = data && data.choices && data.choices[0] &&
        data.choices[0].message && data.choices[0].message.content;
      const line = sanitize(raw);
      if (line) cacheSet(key, line, cfg.cacheSize);
      return line;
    } catch {
      return null;                                   // abort / network / parse
    } finally {
      clearTimeout(timer);
      _inflight.delete(key);
    }
  })();

  _inflight.set(key, promise);
  return promise;
}

// expose a console handle (no-op effect on the game itself)
if (typeof window !== 'undefined') {
  // window is the un-typed DOM global; attach the devtools handle via a loose view.
  try { (window as unknown as { llmConfig?: typeof llmConfig }).llmConfig = llmConfig; } catch { /* ignore */ }
}
