// Write-in actions: free text → a ranked list of candidate Intents.
//
// Two parsers, one contract:
//   parseWriteIn  — deterministic lexicon + fuzzy name matching. Always runs, instant, headless.
//   llmParse      — optional (the default-OFF local LLM). Upgrades the top candidate when it
//                   answers in time; its output is re-validated against the same closed vocabulary
//                   and the same manifest ids, so a model can never invent a target or a magnitude.
//
// The player always sees the chosen reading (a confirm chip) before committing, which is what
// makes a misparse cheap.

import { getConfig } from '../../ai/llm.js';
import { VERBS, validateIntent, type Claim, type CombatVerb, type EntityRef, type Intent } from './intent.js';

/** What the parser may reference: only what the declaring combatant can see in this fight. */
export interface Manifest {
  selfId: EntityRef;
  currentTargetId: EntityRef | null;
  foes: ReadonlyArray<{ id: EntityRef; name: string; aliases: readonly string[] }>;
  allies: ReadonlyArray<{ id: EntityRef; name: string; aliases: readonly string[] }>;
  abilities: ReadonlyArray<{ id: string; name: string }>;
}

export interface Reading { intent: Intent; score: number; }

const LEX: Record<Exclude<CombatVerb, 'ability'>, string[]> = {
  strike: ['hit', 'strike', 'attack', 'slash', 'stab', 'swing', 'cut', 'punch', 'smash', 'bash', 'chop',
    'lunge', 'hack', 'kill', 'thrust', 'cleave', 'skewer', 'headbutt', 'pummel', 'run through'],
  defend: ['defend', 'block', 'parry', 'brace', 'dodge', 'duck', 'raise my shield', 'hold my ground', 'hold ground', 'evade'],
  guard: ['protect', 'guard', 'cover', 'stand in front of', 'shield', 'watch over', 'keep them off'],
  shove: ['shove', 'push', 'barge', 'tackle', 'slam into', 'bowl over', 'kick', 'ram', 'bodycheck', 'knock back'],
  trip: ['trip', 'sweep', 'legs', 'knock down', 'knock him down', 'knock her down', 'hook', 'topple', 'bring down'],
  feint: ['feint', 'fake', 'dummy', 'pretend to', 'misdirect', 'draw his guard', 'draw her guard'],
  bluff: ['lie', 'bluff', 'claim', 'tell', 'shout that', 'yell that', 'shout at', 'yell at', 'whisper to', 'convince', 'trick', 'deceive', 'behind you', 'behind him', 'behind her'],
  intimidate: ['threaten', 'intimidate', 'roar', 'snarl', 'glare', 'menace', 'you will die', "you'll die", 'i will kill', "i'll kill", 'scare', 'frighten', 'bellow'],
  taunt: ['taunt', 'mock', 'insult', 'jeer', 'provoke', 'come at me', 'goad', 'spit at', 'laugh at'],
  rally: ['rally', 'call for help', 'help me', 'to arms', 'guards', 'cry out', 'summon', 'inspire', 'with me', 'call out', 'shout for'],
  aid: ['heal', 'bandage', 'potion', 'tend', 'patch up', 'help up', 'drag to safety', 'first aid', 'revive'],
  improvise: ['throw', 'hurl', 'fling', 'toss', 'grab', 'use the', 'set fire', 'burn', 'douse', 'climb', 'leap', 'jump',
    'swing from', 'brazier', 'barrel', 'crate', 'torch', 'rock', 'stone', 'sand', 'dirt', 'mud', 'table', 'chair', 'rope', 'lantern', 'bucket'],
  flee: ['flee', 'run away', 'escape', 'retreat', 'withdraw', 'bolt', 'get out', 'fall back', 'run'],
  parley: ['parley', 'negotiate', 'surrender', 'yield', 'truce', 'bargain', 'bribe', 'talk', 'reason with', 'stand down', 'mercy', 'lay down'],
};

const CLAIM_LEX: Record<Claim, string[]> = {
  look_behind: ['behind you', 'behind him', 'behind her', 'behind them', 'look out', 'look there', 'over there', 'watch out'],
  reinforcements: ['guards are coming', 'reinforcements', 'the watch', 'my friends', 'soldiers', 'an army', 'more of us', 'coming'],
  turncoat: ['traitor', 'betray', 'sold you out', 'spy', 'turncoat', 'working for', 'double-cross', 'plans to kill you'],
  surrender_terms: ['surrender', 'give up', 'spare', 'let you go'],
};

const PRONOUNS = ['him', 'her', 'them', 'it', 'his', 'their', 'the brute', 'the bastard'];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

function phraseHits(text: string, phrases: readonly string[]): { score: number; at: number } {
  let score = 0, at = -1;
  for (const p of phrases) {
    const re = new RegExp(`(^| )${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
    const m = re.exec(text);
    if (m) { score += p.includes(' ') ? 2 : 1; at = Math.max(at, m.index); }
  }
  return { score, at };
}

/** Find which manifest entry the text names (full name, a name token ≥3 chars, or an alias). */
function findRef(text: string, list: Manifest['foes']): EntityRef | null {
  let best: EntityRef | null = null, bestLen = 0;
  for (const e of list) {
    const names = [e.name, ...e.name.split(/\s+/).filter((t) => t.length >= 3), ...e.aliases];
    for (const n of names) {
      const k = norm(n);
      if (!k) continue;
      if (new RegExp(`(^| )${k}s?( |$)`).test(text) && k.length > bestLen) { best = e.id; bestLen = k.length; }
    }
  }
  return best;
}

/** Every manifest entry the text names, with where it is named. */
function findAll(text: string, list: Manifest['foes']): Array<{ id: EntityRef; at: number }> {
  const out: Array<{ id: EntityRef; at: number }> = [];
  for (const e of list) {
    let at = -1;
    for (const n of [e.name, ...e.name.split(/\s+/).filter((t) => t.length >= 3)]) {
      const k = norm(n);
      const mm = k ? new RegExp(`(^| )${k}s?( |$)`).exec(text) : null;
      if (mm && (at < 0 || mm.index < at)) at = mm.index;
    }
    if (at >= 0) out.push({ id: e.id, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function parseWriteIn(raw: string, m: Manifest): Reading[] {
  const text = norm(raw);
  if (!text) return [];
  const foe = findRef(text, m.foes);
  const ally = findRef(text, m.allies);
  const pronoun = PRONOUNS.some((p) => new RegExp(`(^| )${p}( |$)`).test(text));
  const foeTarget = foe ?? (pronoun || m.foes.length === 1 ? (m.currentTargetId ?? m.foes[0]?.id ?? null) : m.currentTargetId);
  const flourish = raw.trim().slice(0, 120);

  const out: Reading[] = [];

  // Named abilities first: "frost bolt the wolf" is unambiguous.
  for (const ab of m.abilities) {
    const words = norm(ab.name).split(' ').filter((w) => w.length >= 4);
    const hit = norm(ab.name) && (text.includes(norm(ab.name)) || (words.length > 0 && words.every((w) => text.includes(w))));
    if (hit) out.push({ intent: { verb: 'ability', abilityId: ab.id, targetId: foeTarget ?? undefined, flourish, text: raw }, score: 5 });
  }

  // a stated claim ("…is a traitor", "the guards are coming") is itself evidence of a bluff
  const claimScore = (Object.keys(CLAIM_LEX) as Claim[]).reduce((s, c) => s + phraseHits(text, CLAIM_LEX[c]).score, 0);
  for (const verb of Object.keys(LEX) as Array<keyof typeof LEX>) {
    const hits = phraseHits(text, LEX[verb]);
    const score = hits.score + (verb === 'bluff' && claimScore > 0 && /(^| )(shout|yell|tell|cry|call|say|scream|whisper)/.test(text) ? 1 : 0);
    const at = hits.at;
    if (!score) continue;
    const intent: Intent = { verb, flourish, text: raw };
    let s = score + at / 1000;   // later-mentioned verbs win ties: "feint, then sweep his legs" → trip
    if (verb === 'guard' || verb === 'aid') {
      if (ally != null) { intent.targetId = ally; s += 1; }
      else if (verb === 'aid') intent.targetId = m.selfId;
      else continue;              // "guard" with no named ally reads as defend
    } else if (verb === 'bluff') {
      let claim: Claim = 'look_behind', cs = 0;
      for (const c of Object.keys(CLAIM_LEX) as Claim[]) {
        const h = phraseHits(text, CLAIM_LEX[c]).score;
        if (h > cs) { cs = h; claim = c; }
      }
      intent.claim = claim; s += cs;
      intent.targetId = foeTarget ?? undefined;
      if (claim === 'turncoat') {
        // "tell Mira that Garrick is a traitor": the accused is the foe named nearest BEFORE the
        // accusation; the listener is another named foe (else the current target).
        const named = findAll(text, m.foes);
        const accAt = Math.max(...CLAIM_LEX.turncoat.map((p) => text.indexOf(p)));
        const accused = [...named].reverse().find((n) => n.at < accAt) ?? named[named.length - 1];
        const listener = named.find((n) => n.id !== accused?.id);
        if (accused && (listener || (m.currentTargetId != null && m.currentTargetId !== accused.id))) {
          intent.subjectId = accused.id;
          intent.targetId = listener ? listener.id : (m.currentTargetId as EntityRef);
        } else intent.claim = 'look_behind';
      }
    } else if (verb === 'defend' || verb === 'rally' || verb === 'flee' || verb === 'parley') {
      // no target
    } else {
      intent.targetId = foeTarget ?? undefined;
    }
    // A kick aimed at a thing, not a person, is an improvised trick.
    if (verb === 'shove' && phraseHits(text, LEX.improvise).score > 0) s -= 0.5;
    out.push({ intent, score: s });
  }

  // Nothing recognised, but a foe was named: treat it as an improvised physical trick.
  if (!out.length && foe != null) out.push({ intent: { verb: 'improvise', targetId: foe, flourish, text: raw }, score: 0.5 });

  // de-duplicate by verb (keep best), rank, validate
  const byVerb = new Map<string, Reading>();
  for (const r of out) { const k = r.intent.verb + (r.intent.abilityId || ''); const p = byVerb.get(k); if (!p || r.score > p.score) byVerb.set(k, r); }
  return [...byVerb.values()].filter((r) => validateIntent(r.intent)).sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------------------------
// Optional LLM reading. Never throws; resolves null when disabled, slow, or invalid.

export async function llmParse(raw: string, m: Manifest): Promise<Intent | null> {
  let cfg;
  try { cfg = getConfig(); } catch { return null; }
  if (!cfg.enabled || !cfg.endpoint) return null;
  const listing = (xs: Manifest['foes']) => xs.map((x) => `${x.id}=${x.name}`).join(', ') || 'none';
  const system =
    'You convert a tabletop-RPG combat action into JSON. Reply with ONE JSON object and nothing else: ' +
    `{"verb": one of [${VERBS.join(', ')}], "targetId": id or null, "abilityId": id or null, ` +
    '"claim": one of [look_behind, reinforcements, turncoat, surrender_terms] or null, "subjectId": id or null}. ' +
    `Foes: ${listing(m.foes)}. Allies: ${listing(m.allies)}. Self: ${m.selfId}. ` +
    `Abilities: ${m.abilities.map((a) => `${a.id}=${a.name}`).join(', ') || 'none'}. ` +
    'Use only ids listed. Physical tricks with objects are "improvise".';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const res = await fetch(cfg.endpoint, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({
        model: cfg.model, max_tokens: 80, temperature: 0, stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: raw }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt: string = data?.choices?.[0]?.message?.content ?? '';
    const json = txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1);
    const o = JSON.parse(json);
    const ids = new Set<string>([String(m.selfId), ...m.foes.map((f) => String(f.id)), ...m.allies.map((a) => String(a.id))]);
    const pick = (v: unknown): EntityRef | undefined => {
      if (v == null) return undefined;
      const hit = [m.selfId, ...m.foes.map((f) => f.id), ...m.allies.map((a) => a.id)].find((x) => String(x) === String(v));
      return hit !== undefined && ids.has(String(v)) ? hit : undefined;
    };
    const intent: Intent = { verb: o.verb, targetId: pick(o.targetId), flourish: raw.trim().slice(0, 120), text: raw };
    if (o.abilityId && m.abilities.some((a) => a.id === o.abilityId)) intent.abilityId = o.abilityId;
    if (o.claim) intent.claim = o.claim;
    const subj = pick(o.subjectId); if (subj !== undefined) intent.subjectId = subj;
    return validateIntent(intent) ? intent : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
