// The MODEL INTERPRETER for write-ins: text → Intent, using a small local model (LiquidAI
// LFM2.5-350M on vLLM, OpenAI-compatible) with SCHEMA-CONSTRAINED decoding.
//
// The model sees a compact manifest of this field (short ids for every unit and prop, the verbs
// with one-line meanings) and must answer in a JSON schema whose fields are ENUMS of those ids —
// it cannot invent a target, a prop or a magnitude. What the rules can't express comes back as
// `verb: "unsupported"` with a short description, which feeds the support queue.
//
// The deterministic resolver (writein.resolveIntents) still decides legality, placement and odds.
// Everything here fails soft: no endpoint, a timeout or a bad answer → null, and the regex
// interpreter's reading stands.

import { getConfig, type LlmConfig } from '../../ai/llm.js';
import { VERBS, type Intent, type Verb } from './writein.js';
import type { Battle, Unit } from './battle.js';

const VERB_HELP: Record<Verb, string> = {
  attack: 'hit/strike/shoot a foe (target)', shove: 'push a foe (target, optional hazard fire|ledge) or a heavy prop (prop, toward)',
  kick: 'kick a heavy prop (prop) — a brazier spills fire, a barrel rolls, a table/cart tips into cover (toward = a foe it should hit)',
  hew: 'chop a tree / smash wooden gear (prop); a felled tree falls toward "toward" (a foe, or cover)',
  throw: 'throw a light prop (prop) at a foe (target)', ignite: 'set a flammable prop (prop) on fire', douse: 'put out fire with water',
  pickup: 'pick up a light prop (prop)', grab: "steal a foe's purse (target)", subdue: 'beat a foe down to take them alive (target)', trip: 'sweep a foe\'s legs so they fall (target)', disarm: 'knock a foe\'s weapon away (target)',
  aid: 'heal/bandage/revive (ally, or "self")', free: 'cut a bound captive loose (ally)', guard: 'protect an ally (ally)',
  defend: 'brace / hold ground', overwatch: 'wait and strike whoever comes into reach', block: 'stand in the way so a foe cannot get past (to an ally or place)', hide: 'slip into brush / tall grass, hidden from archers', use: 'set off one of the place\'s set-pieces (piece)', escape: 'flee the fight',
  intimidate: 'frighten a foe (target) — waving fire at beasts works well', taunt: 'provoke a foe into coming for you (target)',
  bluff: 'deceive a foe (target) with a claim: look_behind | reinforcements | turncoat (subject = the accused foe)',
  rally: 'call your side together', parley: 'talk the fight down / offer or demand surrender', move: 'reposition only (dest)',
};

interface Ref { id: Unit['id'] | string; kind: 'unit' | 'prop' }

/** The field as the model sees it, with short ids (U1, P3) mapped back to real ones. */
export function manifest(b: Battle, u: Unit): { text: string; refs: Map<string, Ref>; foes: string[]; friends: string[]; props: string[] } {
  const refs = new Map<string, Ref>();
  const lines: string[] = [];
  const foes: string[] = [], friends: string[] = [], props: string[] = [];
  let i = 1;
  for (const x of b.units) {
    if (x === u || !(x.out === null || x.out === 'downed')) continue;
    const k = `U${i++}`; refs.set(k, { id: x.id, kind: 'unit' });
    (x.side === u.side ? friends : foes).push(k);
    lines.push(`${k} ${x.agent.name} — ${x.side === u.side ? 'ally' : 'foe'}${x.bound ? ', bound captive' : ''}${x.out === 'downed' ? ', downed' : ''}, ${Math.abs(x.x - u.x) + Math.abs(x.z - u.z)} tiles away`);
  }
  let j = 1;
  for (const p of b.map.props.values()) {
    const k = `P${j++}`; refs.set(k, { id: p.id, kind: 'prop' }); props.push(k);
    const tags = [p.weight === 0 ? 'light' : p.weight === 1 ? 'heavy' : 'fixed', p.flammable ? 'flammable' : '', p.fireSource ? 'on fire' : '', p.liquid ? 'water' : '', p.climbable ? 'climbable' : ''].filter(Boolean).join(', ');
    lines.push(`${k} ${p.name} (${tags}), ${Math.abs(p.x - u.x) + Math.abs(p.z - u.z)} tiles away`);
  }
  return { text: lines.join('\n'), refs, foes, friends, props };
}

export function schema(m: ReturnType<typeof manifest>): object {
  const e = (xs: string[], extra: string[] = []) => ({ enum: [...xs, ...extra, 'none'] });
  return {
    type: 'object', additionalProperties: false,
    required: ['verb', 'target', 'ally', 'prop', 'toward', 'hazard', 'claim', 'subject', 'dest', 'unsupported'],
    properties: {
      verb: { enum: [...VERBS, 'unsupported'] },
      target: e(m.foes), ally: e(m.friends, ['self']), prop: e(m.props), toward: e(m.foes, ['cover']),
      hazard: { enum: ['fire', 'ledge', 'none'] }, claim: { enum: ['look_behind', 'reinforcements', 'turncoat', 'none'] },
      subject: e(m.foes), dest: { enum: ['onto', 'behind-prop', 'behind-foe', 'high', 'none'] },
      unsupported: { type: 'string', maxLength: 48 },
    },
  };
}

function prompt(m: ReturnType<typeof manifest>): string {
  return [
    'You turn a player\'s combat command into ONE JSON action for a tactics game. Use only the ids listed. Use "none" for fields that do not apply.',
    'If the command needs something the verbs below cannot do (e.g. digging, carrying a person, hiding, disguises, trip, disarm, bribes), answer verb "unsupported" and describe the missing ability in a few words in "unsupported".',
    'Verbs:',
    ...VERBS.map((v) => `- ${v}: ${VERB_HELP[v]}`),
    'On this field:',
    m.text,
    'Examples:',
    '"kick the brazier into Garrick" -> {"verb":"kick","prop":"<brazier id>","toward":"<Garrick id>",...}',
    '"cut down the tree for cover" -> {"verb":"hew","prop":"<tree id>","toward":"cover",...}',
    '"throw Elsie over my shoulder and run" -> {"verb":"unsupported","unsupported":"carry a person",...}',
  ].join('\n');
}

/** Ask the model. Null on any failure (the regex reading stands). */
export async function interpretLLM(b: Battle, u: Unit, raw: string, cfgOver: Partial<LlmConfig> = {}): Promise<{ intents: Intent[]; unsupported: string | null } | null> {
  let cfg: LlmConfig;
  try { cfg = { ...getConfig(), ...cfgOver }; } catch { return null; }
  if (!cfg.endpoint) return null;
  const m = manifest(b, u);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(cfg.timeoutMs, 4000));
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const res = await fetch(cfg.endpoint, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({
        model: cfg.model, temperature: 0, max_tokens: 160, stream: false,
        messages: [{ role: 'system', content: prompt(m) }, { role: 'user', content: raw }],
        response_format: { type: 'json_schema', json_schema: { name: 'intent', schema: schema(m), strict: true } },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt: string = data?.choices?.[0]?.message?.content ?? '';
    const o = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    return decode(o, m, u);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** Validate a model answer against the manifest and turn it into an Intent. */
export function decode(o: Record<string, unknown>, m: ReturnType<typeof manifest>, u: Unit): { intents: Intent[]; unsupported: string | null } | null {
  const verb = o.verb as string;
  if (verb === 'unsupported') return { intents: [], unsupported: String(o.unsupported || 'something the rules lack').slice(0, 60) };
  if (!(VERBS as readonly string[]).includes(verb)) return null;
  const id = (k: unknown, kind: 'unit' | 'prop') => { const r = typeof k === 'string' ? m.refs.get(k) : undefined; return r && r.kind === kind ? r.id : undefined; };
  const I: Intent = { verb: verb as Verb, score: 5 };
  I.target = id(o.target, 'unit') as Unit['id'] | undefined;
  if (o.ally === 'self') { I.self = true; I.ally = u.id; } else I.ally = id(o.ally, 'unit') as Unit['id'] | undefined;
  I.prop = id(o.prop, 'prop') as string | undefined;
  I.toward = o.toward === 'cover' ? 'cover' : (id(o.toward, 'unit') as Unit['id'] | undefined);
  if (o.hazard === 'fire' || o.hazard === 'ledge') I.hazard = o.hazard;
  if (o.claim === 'look_behind' || o.claim === 'reinforcements' || o.claim === 'turncoat') I.claim = o.claim;
  I.subject = id(o.subject, 'unit') as Unit['id'] | undefined;
  if (typeof o.dest === 'string' && ['onto', 'behind-prop', 'behind-foe', 'high'].includes(o.dest)) { I.dest = o.dest as Intent['dest']; I.destProp = I.prop; I.destFoe = I.target; }
  return { intents: [I], unsupported: null };
}
