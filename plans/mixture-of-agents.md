# Mixture of Agents (MoA) — Python → TypeScript Rewrite Plan

## 1. Summary

MoA is a **virtual model provider** in Hermes: each named preset appears as a selectable
"model" under the `moa` provider. Selecting one makes the preset's *aggregator* the acting
model (it writes the assistant answer and emits tool calls), while the preset's *reference
models* run first in parallel and contribute advisory analysis. The feature ships three
user surfaces: persistent preset selection (`/model <preset> --provider moa`), a one-shot
`/moa <prompt>` (run once through the default preset, then restore the previous model), and
`/council <question>` (the reference models deliberate independently and the aggregator
chairs a user-facing consensus/disagreement report). This plan ports the feature into the
TypeScript desktop frontend so it can eventually run in-process without the Python/WS
backend. **No MoA/council/aggregate equivalent exists in the kimi-code TS reference** —
the MoA loop must be designed from scratch in TS, using the same LLM SDKs
(`openai`, `@anthropic-ai/sdk`, `@google/genai`) that kimi-code already uses for parallel
model calls.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`. Data flow for one MoA turn:

```
user turn → agent loop (provider=moa, model=<preset>)
  → MoAChatCompletions.create()  (agent/moa_loop.py:1893)
    1. resolve preset (hermes_cli/moa_config.py resolve_moa_preset; cached by config mtime)
    2. _reference_messages(messages)  → text-only advisory view (moa_loop.py:1003)
    3. _run_references_parallel()     → ThreadPoolExecutor(≤8) per-slot call (moa_loop.py:776)
    4. _attach_reference_guidance()   → append guidance at END of aggregator prompt (moa_loop.py:1453)
    5. _call_prepared_aggregator()    → aggregator = acting model (tools enabled, streamed)
  → tool loop continues on aggregator turns
```

Key modules (all under `D:/hermes-agent-cn`):

- **`agent/moa_loop.py`** (2450 lines) — runtime engine:
  - `MoAClient` / `MoAChatCompletions` — an OpenAI-chat-compatible facade where the
    aggregator is the acting model; `create()` runs once per tool-loop iteration,
    `prepare()` + `rebase_prepared_request()` + `_call_prepared_aggregator()` split the
    fan-out from the actual API call so context compression can reuse advisor guidance.
  - `_run_reference` — one advisor call: advisory system prompt
    (`_REFERENCE_SYSTEM_PROMPT`), context-window trim (`_trim_messages_for_reference`),
    Anthropic-style prompt-cache decoration (`_maybe_apply_moa_cache_control`),
    per-slot runtime resolution (`_slot_runtime` with 300s TTL cache), per-slot
    `reasoning_effort`, `max_tokens`, Copilot `x-initiator: user` header, and
    per-advisor cost accounting (`_RefAccounting` priced at the advisor's OWN model rate).
  - `_run_references_parallel` — fan-out via `ThreadPoolExecutor` (max 8), order-stable
    results, poll-based interrupt wait, `late_accounting_sink` for abandoned futures.
  - `_reference_messages` — advisory view: drops the system prompt, flattens tool calls to
    `[called tool: name(args)]`, folds tool results into `[tool result: …]` (4000-char
    head+tail preview), ends on a synthetic user turn (`_ADVISORY_INSTRUCTION`).
  - Fan-out cadence: `user_turn` (default), `per_iteration`, `every_n:<N>`; sha256
    signature of the advisory prefix drives a per-turn cache key.
  - `synthesis_style`: `guidance` (private context) vs `council` (chair prompt + user-facing
    report framing `[Model Council report …]`).
  - `aggregate_moa_context()` — one-shot `/moa`/`/council` path that runs references,
    synthesizes with the aggregator, and returns a labelled context block for the main loop.
  - Events relayed to frontends: `moa.reference`, `moa.progress`, `moa.phase`,
    `moa.aggregating`.
  - Privacy filter (`moa.privacy_filter`: `'' | display | full`) redacts advisor text at
    the display surface, the trace record, and (full mode) the aggregator prompt.
- **`agent/moa_trace.py`** — opt-in full-turn audit trace (`moa.save_traces`) as JSONL:
  `<hermes_home>/moa-traces/<session_id>.jsonl`; record contains each reference's FULL
  input/output + the aggregator's exact input/output (`output_location` distinguishes
  inline vs streamed capture).
- **`hermes_cli/moa_config.py`** (557 lines) — config normalization (`normalize_moa_config`,
  named presets + legacy flat form), write-time validation (`validate_moa_payload`),
  coercers (`coerce_synthesis_style`, `coerce_privacy_filter`, `_coerce_fanout`,
  `_coerce_reference_timeout`, `_clean_slot` with recursion guard), one-shot marker
  codec (`encode_moa_turn`/`decode_moa_turn`, prefix `__HERMES_MOA_TURN_V1__` +
  base64url JSON `{prompt, config}`), `resolve_moa_preset`, `exact_moa_preset_name`,
  `set_active_moa_preset`.
- **`hermes_cli/moa_cmd.py`** — `hermes moa list|configure [name]|delete <name>` terminal
  management (interactive curses pickers fall back to numbered prompts).
- **CLI one-shot wiring** (`cli.py`, verified by `tests/cli/test_moa_command.py`): `/moa`
  sets `_pending_agent_seed`, switches to `provider=moa, model=default`,
  `_pending_moa_disable_after_turn=True`, restores the previous model after one turn;
  `_normalize_moa_model("moa:<preset>") → ("moa", "<preset>")` handles `-m moa:preset`.
- **Docs**: `website/docs/user-guide/features/mixture-of-agents.md` (330 lines) and the
  `/moa` + `/council` rows in `website/docs/reference/slash-commands.md`.
- **Tests (~14 files)**: `tests/agent/test_moa_*.py` (13 files: council style, aggregator
  cache control, aggregator cost slot, cold-start cache #66793, context max tokens,
  progress, quiet reference output, reasoning effort, reference system prompt, slot api
  mode, slot max tokens, switch api mode, trace streamed capture) + `tests/cli/test_moa_command.py`.

## 3. Target TypeScript design

New in-process modules under `D:/Hermes-CN-Desktop` (no Python/WS for the chat path in
the end state). Module layout (sketched interfaces only, no implementation):

```
web/src/moa/
  config.ts          // normalizeMoaConfig, validateMoaPayload, coerce* (port of moa_config.py)
  marker.ts          // encodeMoaTurn/decodeMoaTurn (base64url JSON, __HERMES_MOA_TURN_V1__)
  llm-client.ts      // MoaLlmClient interface + per-provider adapters (openai/anthropic/google)
  provider-resolver.ts // slot → {baseUrl, apiKey, apiMode} resolution + short-TTL cache
  advisory-view.ts   // buildReferenceMessages(apiMessages) text-only advisory view
  reference-runner.ts// runReferencesParallel(slots, view) → Promise.all with concurrency cap
  guidance.ts        // attachReferenceGuidance / peelReferenceGuidance (tail injection)
  aggregator.ts      // callPreparedAggregator (streaming + tools)
  moa-facade.ts      // MoaChatCompletions-equivalent: create/prepare/rebase/create-prepared
  council.ts         // council chair prompt + report framing (guidance style)
  one-shot.ts        // runMoaOneShot(prompt, {style}) for /moa and /council
  trace.ts           // MoaTrace JSONL (Rust fs or IndexedDB)
  redact.ts          // privacy filter (emails/phones + secret shapes)
```

Interfaces (signatures only):

```ts
interface MoaSlot { provider: string; model: string; reasoning_effort?: string; max_tokens?: number; enabled?: boolean }
interface MoaPreset { reference_models: MoaSlot[]; aggregator: MoaSlot; reference_temperature?: number|null;
  aggregator_temperature?: number|null; reference_timeout?: number|null; degraded_reference_policy: "loud"|"silent";
  max_tokens: number; reference_max_tokens?: number|null; fanout: "user_turn"|"per_iteration"|`every_n:${number}`;
  synthesis_style: "guidance"|"council"; enabled: boolean }
interface MoaConfig { default_preset: string; active_preset: string; presets: Record<string, MoaPreset>;
  privacy_filter: ""|"display"|"full"; save_traces?: boolean; trace_dir?: string }

interface MoaLlmClient {                        // one per provider (OpenAI-compat core)
  chat(messages, opts: { tools?, temperature?, max_tokens?, reasoning?, signal?, stream? }):
    Promise<MoaChatResponse | AsyncIterable<MoaDelta>>;
}
interface ReferenceResult { label: string; text: string; accounting: MoaAccounting }
interface MoaFacade {
  create(req: { messages: ChatMessage[]; tools?; stream?; signal? }): Promise<Response>;
  prepare(messages): Promise<PreparedRequest>;          // fan-out once, return request
  rebasePreparedRequest(prepared, messages): PreparedRequest; // reuse guidance after compaction
  consumeReferenceUsage(): MoaAccounting;
  lastAggregatorSlot: MoaSlot | null;
  consumeAndSaveTrace(sessionId?, aggregatorOutputFallback?): void;
}
```

Flow (end state, fully in-process):

1. Composer sends the user prompt to the local agent loop (not `prompt.submit`).
2. The loop's model call goes through `MoaFacade.create()` when the active model is
   `moa:<preset>`; the facade resolves the preset, builds the advisory view, fans out
   references with `Promise.all` + a concurrency cap (mirroring `_MAX_REFERENCE_WORKERS=8`),
   emits `moa.reference`/`moa.progress`/`moa.aggregating` events (shapes already defined in
   `packages/protocol`), appends guidance at the END of the aggregator prompt (cache-safe),
   then streams the aggregator turn back into the normal chat store.
3. `/moa <prompt>` / `/council <question>` become client-side builtin commands
   (`web/src/lib/builtin-commands.ts` pattern): encode the one-shot via `marker.ts`
   (parity with the Python marker so mixed client/server turns stay compatible during
   migration), run `one-shot.ts`, restore the previous model after one turn.
4. Config editing goes through the same Zod `MoaConfigResponse` shape the panel already
   uses; the PUT /api/model/moa path is later replaced by a local config store.

## 4. Data models & persistence

- **Config** (`moa:` block of config.yaml): the normalized `MoaConfig` above.
  - Today the desktop round-trips the backend shape via
    `packages/protocol/src/hermes-api.ts` `MoaConfigResponse`/`MoaPresetConfig`/`MoaModelSlot`
    (Zod, `.passthrough()` preserves `reference_max_tokens`, `fanout`, etc.). The TS plan
    extends these schemas to fully typed fields (see §6).
  - Persistence strategy: Phase B stores config in-process (IndexedDB or a JSON file via a
    new Tauri command); end state writes the same `config.yaml` (or a desktop-owned copy)
    through Rust `src/commands/*` so credentials stay in the Rust/OS layer.
- **One-shot marker** (`__HERMES_MOA_TURN_V1__` + base64url `{prompt, config}`): stateless,
    no persistence; implement `marker.ts` with `btoa`/`atob` (webview) or `Buffer` (Rust
    sidecar/Node tests). Round-trip must be byte-parity with Python
    (`build_moa_turn_prompt`/`decode_moa_turn`) so a marker produced by the backend can be
    consumed by the TS side during migration and vice versa.
- **Trace**: port the JSONL record shape from `agent/moa_trace.py` verbatim
  (`ts`, `session_id`, `preset`, `references[]`, `aggregator{...}` with
  `output_location`). Persist via a Tauri command writing
  `<hermes_home>/moa-traces/<session_id>.jsonl`, or IndexedDB keyed by session for the
  web-only fallback. Schema is defined as a Zod type + golden-JSON parity tests.
- **Runtime (ephemeral) state**: per-turn reference cache keyed by sha256 of the advisory
  prefix (user_turn/every_n cadence), `lastAggregatorSlot`, pending usage/cost, pending
  trace — all in-memory, matching the Python facade lifecycle. No DB migration needed.
- **No schema migration**: existing persisted chat messages are untouched; MoA events
  (`moa.reference`, `moa.aggregating`) already render in the chat store and remain the
  same protocol shape.

## 5. Third-party library strategy

**Search evidence in `D:/kimi-code`**: `\bmoa\b` (case-insensitive, `*.ts`) → **no
matches**; `\bcouncil\b` → **no matches**; `aggregate` matches are unrelated (REST fs
aggregation, `aggregateError`, etc., e.g. `packages/protocol/src/rest/fs.ts`,
`packages/agent-core-v2/.../grep.ts`). **There is no MoA/council/aggregator feature in the
TS reference — the loop must be designed from scratch in TS.** The SDK evidence below shows
kimi-code already performs parallel LLM calls with the same libraries we need.

| Python dependency | TS equivalent | Evidence in kimi-code |
|---|---|---|
| `call_llm` / `auxiliary_client` (chat completions + streaming + tools) | `openai` SDK `chat.completions.create/stream` as the core; `@anthropic-ai/sdk`, `@google/genai` adapters for native routes | `packages/agent-core-v2/package.json` + `packages/kosong/package.json`: `openai ^6.34.0`, `@anthropic-ai/sdk ^0.95.2`, `@google/genai ^1.49.0`. Provider bases: `packages/agent-core-v2/src/kosong/provider/bases/openai/openai-legacy.ts`, `openai-responses.ts`, `bases/anthropic/anthropic.ts`, `bases/google-genai/google-genai.ts` |
| `ThreadPoolExecutor` reference fan-out | `Promise.all` with a small semaphore/concurrency cap (max 8) | kimi-code uses `Promise.all`/`Promise.allSettled` for parallel work throughout: `packages/agent-core/src/loop/tool-call.ts:183`, `packages/agent-core/src/session/index.ts`, `packages/agent-core/src/agent/background/index.ts` |
| `resolve_runtime_provider` (provider→base_url/api_key/api_mode) | `provider-resolver.ts` + credential store; pattern from `packages/kosong/provider/providerDefinition.ts` (`resolveProviderEndpoint`/`explainProviderEndpoint` env resolution) | cited above |
| `reasoning_effort` / `reasoning_config` | provider adapters' thinking options (OpenAI `reasoning_effort`, Anthropic `thinking`, Gemini `thinkingConfig`) | `bases/anthropic/anthropic.ts` (`AnthropicGenerationKwargs.thinking`, `ThinkingEffort` in `#/kosong/contract/provider`) |
| prompt-cache decoration (`apply_anthropic_cache_control`) | thin TS helper emitting `cache_control` content parts on Anthropic-compatible routes; OpenAI routes untouched | Anthropic SDK content-block params; pattern in `bases/anthropic/anthropic.ts` |
| `orjson` | `JSON.stringify` / `structuredClone` / Zod | — (no lib needed) |
| `pybase64` | `btoa`/`atob` or `Buffer` | — |
| `hashlib.sha256` | Web Crypto `crypto.subtle.digest("SHA-256")` / Node `crypto` | — |
| `agent.redact.redact_sensitive_text` + email/phone regexes | **implement from scratch** `web/src/moa/redact.ts` — regexes ported verbatim from `moa_loop.py` `_MOA_EMAIL_RE`/`_MOA_PHONE_RE` plus central secret patterns; no existing TS redactor found in the desktop repo | — |
| interrupt handling (`agent._interrupt_requested`) | `AbortController` + `Promise.race` per reference; in-flight HTTP cannot be force-killed (same limitation as Python) | `Promise.race` in `bases/google-genai/google-genai.ts:798` |

**Runtime constraint to flag**: kimi-code runs in Node; the desktop webview must call
provider APIs from the webview (fetch with CORS caveats) or via a Rust-side HTTP proxy /
Tauri command. Plan for a `MoaLlmClient` seam so the transport (webview fetch vs Rust
`http` plugin vs Node sidecar) is swappable; credentials never live in JS (Rust keychain /
config file).

## 6. Integration with existing Hermes-CN-Desktop frontend

Existing pieces to reuse (all verified in `D:/Hermes-CN-Desktop`):

- **Protocol**: `packages/protocol/src/hermes-api.ts` — `MoaConfigResponse`/
  `MoaPresetConfig`/`MoaModelSlot` (lines 614-647), `HermesMoaReferenceMessagePart`
  (line 376), gateway events `moa.reference`/`moa.aggregating` (lines 1657-1671). Extend
  `MoaPresetConfig` with `reference_max_tokens`, `fanout`, `synthesis_style`,
  `degraded_reference_policy`, `reference_timeout` (currently only passthrough), plus a
  top-level `privacy_filter`/`save_traces`.
- **Config UI**: `web/src/routes/settings-moa-panel.tsx` + `web/src/hooks/use-moa-config.ts`
  (`GET/PUT /api/model/moa`). Phase B adds local-first editing; keep the same Zod parse so
  either backend or local store can be the source.
- **Model picker**: `web/src/components/chat/goose-composer-model-picker.tsx` already
  buckets `MOA_PROVIDER_SLUG = "moa"` presets into a dedicated group with key `moa:<preset>`.
  End state: selection calls the local model switcher instead of a backend `/model` switch.
- **Chat rendering**: `web/src/stores/chat.ts` (lines 667-714) appends `moa_reference`
  parts and `moa_aggregating` status; `web/src/components/chat/message-adapter.ts`
  (line 531) renders them. Reuse unchanged — the in-process facade emits the same events.
- **Slash commands**: `web/src/lib/builtin-commands.ts` is the desktop-native pattern
  (currently `/compress`); add `/moa` and `/council` as builtin commands routed to
  `one-shot.ts` (do NOT send them to the backend in the end state).
- **Transport today**: `web/src/lib/gateway-client.ts` (WS JSON-RPC) +
  `web/src/hooks/use-gateway.ts` (`prompt.submit`, `command.dispatch`) + `web/src/lib/transport.ts`
  (REST). These remain during Phase A/B and are bypassed in Phase C.

## 7. Removing the WebSocket dependency (migration path)

Freeze this API surface first (it already exists in `packages/protocol`): `MoaConfigResponse`
shape, `moa.reference`/`moa.progress`/`moa.phase`/`moa.aggregating` event shapes, and the
`prompt.submit` semantics for one-shot markers.

- **Phase A (today)**: desktop sends `/moa`/`/council` text (or the encoded marker) through
  `prompt.submit`; the Python backend runs the fan-out; config edits go through
  `PUT /api/model/moa`; events arrive over WS and render as today. Zero behavior change.
- **Phase B**: implement `web/src/moa/*` behind `MoaFacade` and run it in-process for
  selected sessions ("local runtime" toggle), while still falling back to the WS path on
  error. `marker.ts` guarantees one-shot interop between client- and server-produced turns.
  Config editor switches to the local store with a one-way "sync to backend" button.
- **Phase C**: delete the WS/REST MoA path. `MoaFacade` becomes the only implementation;
  the chat store stops subscribing to `moa.*` gateway events and instead consumes the
  facade's local event emitter (same Zod payloads). Rust retains only OS capabilities
  (file dialogs, credential vault, optional HTTP proxy, trace file writes).

## 8. Migration phases & task breakdown

1. **Config & marker port** — `web/src/moa/config.ts`, `marker.ts`; extend protocol Zod
   schemas; port every `coerce_*`/`validate_moa_payload`/`normalize_moa_config` case from
   `tests/cli/test_moa_command.py` + `test_moa_council_style.py` normalization tests.
2. **LLM client seam** — `llm-client.ts` + `provider-resolver.ts` (openai/anthropic/google
   adapters; concurrency-capped `runReferencesParallel`); credential store via Tauri.
3. **Runtime engine** — `advisory-view.ts`, `guidance.ts`, `aggregator.ts`, `moa-facade.ts`
   (create/prepare/rebase/prepared path, streaming + tools, usage/cost accounting,
   `lastAggregatorSlot`, reference cache + fanout cadence, interrupt via AbortController).
4. **Council + one-shot** — `council.ts`, `one-shot.ts`; wire `/moa` and `/council` into
   `builtin-commands.ts`; restore-model semantics in the local session store.
5. **Trace & privacy** — `trace.ts`, `redact.ts`; port `save_moa_turn` record shape and the
   `display`/`full` redaction points (display emit, trace stash, aggregator input).
6. **Desktop UI parity** — extend `settings-moa-panel.tsx` for the newly typed fields
   (fanout, synthesis_style, reference_max_tokens, privacy_filter); model picker keeps the
   moa bucket but switches to the local switcher.
7. **Cutover** — swap chat path to `MoaFacade`; remove WS/REST MoA code; delete backend
   integration hooks; update docs references.

## 9. Risks & open questions

- **No TS equivalent found (explicit)**: kimi-code has zero MoA/council/aggregate code;
  only the building blocks (LLM SDKs, parallel `Promise.all`, provider registry) exist.
  The loop, advisory view, guidance tail-injection, and council prompt are net-new TS.
- **Credentials**: the biggest blocker — Python holds provider API keys in
  env/config/`auth.json`. In-process webview calls need a Rust-managed credential store;
  without it, Phase B must keep provider calls on the backend (defeats WS removal).
- **Streaming + tool-call parity**: aggregator streams with tool_calls, stale-stream
  detection, and non-streaming fallback must match Python behavior; the advisory view must
  stay byte-stable for prompt-cache reuse across iterations.
- **Provider wire-format differences**: `api_mode` (anthropic_messages vs chat_completions
  vs responses), `max_completion_tokens`, fixed/forbidden temperature, Copilot
  `x-initiator` header — the `MoaLlmClient` adapter layer must replicate `call_llm`'s
  per-model handling.
- **Interrupt semantics**: AbortController cannot kill an in-flight HTTP call; late
  accounting for abandoned references must be preserved (port `late_accounting_sink`).
- **Determinism/parity**: sha256 signatures, `every_n` turn-scoped counters, and privacy
  regexes must match Python exactly; golden fixtures needed.
- **CORS/network in webview**: provider APIs may block webview origins; plan the Rust HTTP
  proxy fallback early.
- **Cost accounting**: advisor spend must be priced per-advisor model rate (Python
  `_RefAccounting` design) — do not fold into aggregator pricing.

## 10. Test strategy

- **Vitest unit (port parity)**: mirror the ~14 Python files 1:1 —
  `test_moa_council_style` (chair prompt + report framing), marker round-trip
  (`build/decode`), config normalization/coercion (`test_moa_command` cases), advisory-view
  invariants (user-first, end-on-user, tool result folding), reference system prompt,
  slot api mode / reasoning effort / max_tokens, context-window trim, fanout cadence
  signatures, privacy redaction regexes, trace record JSON golden files.
- **Unit with mocked LLM**: `fakeChat(messages, opts)` recorder replacing `call_llm`
  (same technique as `test_moa_council_style.py` `fake_call_llm` monkeypatch) to assert
  reference/aggregator call counts, guidance placement at END of last user message, and
  council vs guidance framing.
- **Integration**: in-process `MoaFacade` against a fake provider server (local HTTP),
  covering streaming + tool calls, interrupt (AbortController), every_n cadence, and
  `prepare`/`rebasePreparedRequest` compaction reuse.
- **Playwright E2E**: settings panel preset CRUD + extended fields; model picker moa bucket;
  `/moa` and `/council` composer flow with mocked gateway/LLM events; moa_reference block
  ordering in chat.
- **Cross-runtime parity**: a script runs identical preset fixtures through the Python
  implementation and the TS implementation and diffs normalized outputs (guidance text,
  marker payload, trace JSON) — the migration gate.

## 11. Reference links

- `D:/hermes-agent-cn/agent/moa_loop.py`, `D:/hermes-agent-cn/agent/moa_trace.py`
- `D:/hermes-agent-cn/hermes_cli/moa_config.py`, `D:/hermes-agent-cn/hermes_cli/moa_cmd.py`
- `D:/hermes-agent-cn/website/docs/user-guide/features/mixture-of-agents.md`
- `D:/hermes-agent-cn/website/docs/reference/slash-commands.md` (/moa, /council rows)
- `D:/hermes-agent-cn/tests/agent/test_moa_*.py` (13), `D:/hermes-agent-cn/tests/cli/test_moa_command.py`
- `D:/kimi-code/packages/agent-core-v2/package.json`, `D:/kimi-code/packages/kosong/package.json`
- `D:/kimi-code/packages/agent-core-v2/src/kosong/provider/providerDefinition.ts`,
  `.../bases/anthropic/anthropic.ts`, `.../bases/openai/openai-legacy.ts`,
  `.../bases/google-genai/google-genai.ts`; `packages/agent-core/src/loop/tool-call.ts`
- `D:/Hermes-CN-Desktop/web/src/hooks/use-moa-config.ts`,
  `D:/Hermes-CN-Desktop/web/src/routes/settings-moa-panel.tsx`
- `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts` (MoaConfigResponse, moa events)
- `D:/Hermes-CN-Desktop/web/src/stores/chat.ts`, `web/src/components/chat/message-adapter.ts`,
  `web/src/components/chat/goose-composer-model-picker.tsx`, `web/src/lib/builtin-commands.ts`,
  `web/src/hooks/use-gateway.ts`, `web/src/lib/gateway-client.ts`, `web/src/lib/transport.ts`
