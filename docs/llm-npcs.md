# Optional: LLM-flavoured NPC dialogue (vLLM + LiquidAI/LFM2.5-350M)

This is an **opt-in, default-OFF** feature. With it enabled and a local
[vLLM](https://docs.vllm.ai/) server running, an NPC's spoken lines in the
dialogue modal can be written by a small language model speaking *as that NPC*,
from its **beliefs and state** (the epistemic split — never omniscient world
truth). With it disabled (the default) or the server unreachable, the game
behaves **exactly** as before: the existing templated dialogue is used.

Nothing about the model is bundled in the repo. The browser side stays plain
vendored ES modules served over `python3 -m http.server`; it only does `fetch`.

---

## 1. Serve the model with vLLM

vLLM is a separate Python process you run yourself (it is **not** an npm/Node
dependency of this project). LFM2.5 is a hybrid conv + GQA-attention
architecture; serve it with a **recent vLLM** (`pip install -U vllm`,
v0.6.5+ / current is fine — the LFM2 architecture is supported upstream).

```bash
pip install -U vllm
vllm serve LiquidAI/LFM2.5-350M \
  --port 8001 \
  --allowed-origins '["*"]'
```

- **Port 8001 on purpose.** The static game site is served by
  `python3 -m http.server 8000`, so vLLM must listen on a *different* port to
  avoid a clash. The client in `js/ai/llm.js` defaults to
  `http://localhost:8001/v1/chat/completions` to match.
- **No `--trust-remote-code` required** — the architecture is in vLLM/transformers
  upstream. (If your vLLM is older than LFM2 support, upgrade it.)
- **Context length** is 32k; **max output** is capped client-side to 64 tokens
  (NPC lines are short). Chat template is ChatML-like (`<|im_start|>` roles),
  handled by the server when you use `/v1/chat/completions`.
- **No API key** by default. If you start vLLM with `--api-key SECRET`, set the
  same value in the game (see §3, `apiKey`).
- The model name in requests must match what vLLM serves: `LiquidAI/LFM2.5-350M`
  (the default in the client). If you pass `--served-model-name foo`, set the
  client `model` to `foo`.

Sanity check the server independently of the game:

```bash
curl -X POST http://localhost:8001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data '{"model":"LiquidAI/LFM2.5-350M",
           "messages":[{"role":"user","content":"Say hello in one short line."}],
           "max_tokens":32}'
```

---

## 2. CORS (the cross-origin gotcha)

The game is at `http://localhost:8000`; vLLM is at `http://localhost:8001`. A
browser `fetch` between them is **cross-origin** and is blocked unless vLLM
returns CORS headers.

vLLM's OpenAI server is FastAPI/Starlette and exposes CORS flags:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--allowed-origins` | `["*"]` | origins allowed to call the API (JSON list) |
| `--allowed-methods` | `["*"]` | allowed HTTP methods (JSON list) |
| `--allowed-headers` | `["*"]` | allowed request headers (JSON list) |

The defaults already permit `*`, which is enough for our **credential-less**
`fetch` (we send no cookies). Passing `--allowed-origins '["*"]'` explicitly (as
above) makes it obvious and survives any future default change. To be strict,
lock it to the game origin instead:

```bash
vllm serve LiquidAI/LFM2.5-350M --port 8001 \
  --allowed-origins '["http://localhost:8000"]'
```

(If you ever needed credentialed requests you could **not** use `*` and would
have to name the exact origin — but this feature never sends credentials.)

No proxy is needed. If you'd rather avoid CORS entirely, put both behind one
reverse proxy so the game and `/v1/...` share an origin; the simple CORS flag
above is the recommended path.

---

## 3. Enable the feature in-game

The feature flag defaults **off**. Turn it on from the browser devtools console
(persists in `localStorage`; `window.llmConfig` is exposed by `js/ai/llm.js`):

```js
llmConfig({ enabled: true })       // turn on
llmConfig({ enabled: false })      // turn off (back to templated dialogue)
llmConfig()                        // read effective config

// override defaults if needed:
llmConfig({ endpoint: 'http://localhost:8001/v1/chat/completions' })
llmConfig({ model: 'LiquidAI/LFM2.5-350M' })
llmConfig({ apiKey: 'SECRET' })    // only if vLLM was started with --api-key
llmConfig({ timeoutMs: 3000, maxTokens: 64, temperature: 0.8 })
```

Then talk to an NPC (`E`). The templated greeting/response appears **instantly**;
if the model answers within the ~3s budget, the line is swapped in place. If the
server is down, slow, or returns junk, you simply keep the templated line.

---

## 4. How it's wired (for maintainers)

- `js/ai/llm.js` — self-contained, dependency-free client. `generateLine(persona)`
  POSTs to `/v1/chat/completions` with an `AbortController` timeout, **in-flight
  dedupe + a tiny LRU cache**, and **resolves `null` on ANY failure** (never
  throws). Config (endpoint/model/enabled/…) comes from a `DEFAULTS` const
  overlaid by `localStorage` under the key `hearsay.llm`.
- `js/dialogue/dialogue.js` — `DialogueSession.llmPersona(situation)` builds the
  persona object from **that NPC's** name/profession/faction/personality/mood/
  needs/gold/trade-want plus its **beliefs** about the player and its loudest
  rumour. Pure read; mutates nothing; only called when the flag is on.
- `js/ui/dialogueView.js` — renders the templated line first, then calls
  `_tryLlmSwap()`, which fire-and-forgets `generateLine()` and replaces the
  spoken text only if (a) a line came back and (b) the modal is still on that
  same turn (guarded by a `_sayToken`). The simulation tick is never involved.

### Invariants this respects

- **Never blocks / never throws on the sim tick.** No LLM call happens in
  `Simulation.update` / `Agent.decide` / `Agent.act`. All calls are async, from
  the user-paced modal, timeout-guarded, and fault-tolerant.
- **Graceful degradation.** Flag off, server down, timeout, CORS failure, bad
  JSON → `null` → templated fallback. A fresh checkout with no server is byte-for-
  byte the old behaviour.
- **Epistemic split.** Prompts are built from one NPC's beliefs + state, never
  from ground-truth world state.

---

## 5. Tradeoffs / risks

- **Latency / quality.** 350M is tiny and fast but can produce bland or
  off-tone lines; the 3s budget + sanitiser (first line, strip quotes, length
  cap) bound the damage, and templates remain the floor.
- **Local-only.** Defaults assume `localhost`. Exposing vLLM to a network needs
  its own auth (`--api-key`) and origin lockdown.
- **No streaming.** We request `stream:false` for simplicity; lines are short so
  a single response within 3s is the common case.
- **Cache staleness.** The client caches per (persona-situation) signature, so an
  NPC repeats a line for the same situation within a session — intentional, keeps
  it snappy and reduces server load. Reload the page to clear it.

## The Gazette (LLM-written newspaper)

The same server + the same `llmConfig({ enabled: true })` flag also powers the
**Gazette** — the town newspaper a roaming Reporter files about newsworthy
townsfolk (press `J` in-game). It reuses this client's transport/config via
`js/ai/press.js` (`generateArticle(brief)`), with the same hard contract: it
resolves to `{ headline, body }` or `null`, NEVER throws, and degrades to a
deterministic template article when the model is off/unreachable. So with no
server the Gazette still fills with serviceable template prose; turning the LLM on
upgrades each article in place (a small `template`/`filed` chip shows which is
which). No extra setup beyond the `vllm serve … --port 8001` already described
above. Articles run a touch longer than dialogue lines (~200 tokens).
