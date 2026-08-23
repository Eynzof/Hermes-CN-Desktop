# Unified Agent Core (Agent Loop, LLM Adapters & Sessions) — Python → TypeScript Rewrite Plan

## 1. Summary

- Port the Python agent core (`D:/hermes-agent-cn`): the `AIAgent` runner
  (`run_agent.py`), its per-turn conversation loop
  (`agent/conversation_loop.py`), the provider adapters
  (`agent/{anthropic,bedrock,gemini_native,vertex,codex_responses,azure_identity}_adapter.py`),
  the unified streaming transport (`agent/chat_completion_helpers.py`), and the
  declarative provider registry (`providers/`) into a TypeScript **agent-core**
  workspace package that runs **in-process inside the Tauri webview**, so the
  same loop is reused by the desktop app (and later by CLI/messaging/TUI ports).
- One loop, many hosts: the Python runtime already runs the identical core
  across CLI, messaging gateway, TUI and desktop Dashboard. The TS port keeps
  that property: hosts talk to a single `AgentRuntime` façade and receive the
  same typed event stream, so a turn behaves identically regardless of surface.
- Sessions are the unit of sharing: a session snapshot binds model + provider
  config, enabled/disabled toolsets, skills, memory scope, and platform
  identity (`user_id`, `chat_id`, `gateway_session_key`). Resuming a session
  restores that snapshot, which is exactly what Core's `sessions` table does
  today (`hermes_state.py` `create_session` stores `model`, `model_config`,
  `parent_session_id`, `cwd`, `profile_name`).
- End state (per `plans/README.md`): the desktop no longer opens a WebSocket to
  the managed Python runtime for chat; the WS link is deleted after migration.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn` (docs `README.md`, `AGENTS.md`,
`website/docs/user-guide/features/overview.md`).

| File | Role |
|---|---|
| `run_agent.py` (8,895 lines) | `AIAgent` class (line 433); `__init__` (line 495) forwards to `agent_init.init_agent`; lazy OpenAI client proxy; `cleanup_vm/browser`; `main()` (line 8663) = `python run_agent.py` CLI entry via `fire.Fire`. |
| `agent/agent_init.py` (3,181 lines) | `init_agent(agent, ...)` (line 518): the ~90-arg constructor — provider/model/base_url/api_key, `api_mode` (`chat_completions` \| `codex_responses` \| `anthropic_messages` \| `bedrock_converse` \| `codex_app_server`), toolsets, max_iterations, callbacks (`stream_delta_callback`, `tool_progress_callback`, `status_callback`, `event_callback`, …), session identity (`platform`, `user_id`, `chat_id`, `gateway_session_key`, `session_db`, `parent_session_id`), `fallback_model`, `credential_pool`, reasoning config. |
| `agent/conversation_loop.py` (8,302 lines) | `run_conversation(agent, user_message, …)` (line 1446) — one user turn: `build_turn_context` → model calls / tool dispatch / retries / fallbacks / compression → `finalize_turn`. All provider access resolves through `_ra()` so tests can patch `run_agent.*`. |
| `agent/agent_runtime_helpers.py` (4,311 lines) | `sanitize_tool_call_arguments`, `repair_message_sequence(_with_cursor)`, `create_openai_client`, `switch_model`, `invoke_tool`, `convert_to_trajectory_format`, credential-pool recovery. |
| `agent/chat_completion_helpers.py` (4,834 lines) | Unified streaming/non-streaming API transport: `_dispatch_nonstreaming_api_request`, `should_use_direct_api_call`, stale-timeout watchdog, provider status emission. |
| `agent/anthropic_adapter.py` | OpenAI-style ↔ Anthropic Messages translation; lazy `anthropic` SDK; auth kinds (API key / OAuth setup-token / Claude Code keychain); `THINKING_BUDGET`, `ADAPTIVE_EFFORT_MAP`; `build_anthropic_client`. |
| `agent/bedrock_adapter.py` | Bedrock Converse adapter. |
| `agent/gemini_native_adapter.py` | Gemini native adapter. |
| `agent/vertex_adapter.py` | google-auth service-account / ADC; `get_vertex_credentials`, `build_vertex_base_url`, `has_vertex_credentials`. |
| `agent/codex_responses_adapter.py` | OpenAI Responses API adapter (`_derive_responses_function_call_id`, `_split_responses_tool_id`, `_summarize_user_message_for_log`). |
| `agent/azure_identity_adapter.py` | Azure identity (token credential) auth. |
| `providers/base.py`, `providers/__init__.py` | Declarative `ProviderProfile` dataclass (auth type, base_url, models_url, vision flags, `fallback_models`, hooks `prepare_messages`/`build_extra_body`/`build_api_kwargs_extras`/`fetch_models`); lazy registry discovering `plugins/model-providers/<name>/` (bundled + `$HERMES_HOME` user plugins, last-writer-wins) and legacy `providers/<name>.py`. |
| `hermes_state.py` | SQLite `state.db`; `sessions` / `messages` tables; `create_session` (line ~4126) persists model + `model_config` + `parent_session_id` + `cwd` + `profile_name`. |

Data flow (one turn):

```
host (CLI/gateway/TUI/dashboard) → AIAgent.run_conversation(user_message, …)
  → conversation_loop.run_conversation
      → build_turn_context (system prompt, preflight compression, persistence)
      → loop: chat_completion_helpers dispatch (stream/non-stream)
          → provider adapter (anthropic/openai/bedrock/gemini/codex_responses)
              → vendor SDK → vendor API
      → handle_function_call → tool result → next iteration
      → finalize_turn (transcript row, memory/skill review nudge)
```

## 3. Target TypeScript design

New workspace package `packages/agent-core` in `D:/Hermes-CN-Desktop`
(pnpm workspace, sibling of `packages/protocol`). It is host-agnostic: the
desktop webview consumes it; future CLI/messaging/TUI ports reuse the same
package, mirroring `D:/kimi-code/packages/agent-core` which is the unified
engine for Kimi Code's CLI/TUI/IDE surfaces.

Module layout (mirrors kimi-code `src/loop/` + `src/services/*` and maps 1:1 to
the Python files above):

```
packages/agent-core/src/
  loop/            ← port of agent/conversation_loop.py + chat_completion_helpers.py
    run-turn.ts      # runTurn(): convergence, max-steps, usage aggregation, abort
    turn-step.ts     # executeLoopStep(): one model call + tool dispatch
    llm.ts           # LLM / LLMChatParams / LLMChatResponse contract
    tool-call.ts, tool-scheduler.ts, tool-access.ts, tool-args-parse.ts
    retry.ts, errors.ts, events.ts, types.ts
  providers/       ← port of providers/base.py + providers/__init__.py
    profile.ts       # ProviderProfile dataclass equivalent
    registry.ts      # register_provider / get_provider_profile / list_providers
    catalog.ts       # model catalog (port of kimi-code modelCatalogService)
    anthropic.ts     # agent/anthropic_adapter.py
    openai-chat.ts   # OpenAI Chat Completions (generic chat_completions path)
    openai-responses.ts  # agent/codex_responses_adapter.py
    bedrock.ts, gemini.ts, vertex.ts, azure.ts
  session/         ← port of hermes_state.py session surface + kimi-code session store
    session-store.ts   # create/resume/archive, message append
    profile-snapshot.ts# model+tools+skills+memory+provider config bound to session
    provider-manager.ts# active provider per session
  tool/            # tool registry + executor (port of model_tools surface)
  skills/          # skills registry (progressive disclosure)
  memory/          # memory manager surface
  index.ts         # AgentRuntime façade + AgentEvent union
```

Key interfaces (signatures only; modeled on `D:/kimi-code/packages/agent-core/src/loop/llm.ts` and `types.ts`):

```ts
interface LLM {
  readonly systemPrompt: string;
  readonly modelName: string;
  chat(params: LLMChatParams): Promise<LLMChatResponse>;
}
interface LLMChatParams {
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  onTextDelta?(d: string): void;
  onThinkDelta?(d: string): void;
  onToolCallDelta?(d: ToolCallDelta): void;
  trace?: LLMRequestTraceState;
}
interface LLMChatResponse {
  toolCalls: ToolCall[];
  providerFinishReason?: FinishReason;
  usage: TokenUsage;
}
```

The `LLM` interface is the seam where Python's per-provider adapters attach:
each adapter (Anthropic/OpenAI Chat/Responses/Bedrock/Gemini/Vertex/Azure)
implements `chat()` against the vendor npm SDK and normalizes streaming parts
(text/think/tool-call deltas + usage + finish reason), exactly like
`packages/kosong/src/providers/*.ts` in kimi-code.

`AgentRuntime` (webview singleton, replaces gateway-client for chat) exposes:
`createSession`, `resumeSession`, `submitPrompt`, `interrupt`, `switchModel`,
`listModels`; emits `AgentEvent` (start/delta/complete/error/tool) that reuses
the Desktop `GatewayEvent` shape so existing reducers keep working.

## 4. Data models & persistence

- **Message** — mirrors Core `messages` table and Desktop `SessionMessage`
  (`packages/protocol/src/hermes-api.ts` line 240): `{ id, session_id, role,
  content, images?, tool_call_id?, tool_calls?, tool_name?, timestamp,
  token_count?, finish_reason?, reasoning?, reasoning_content? }`.
- **Session** — mirrors `SessionSummary` (hermes-api.ts line 164):
  `{ id, parent_session_id?, source?, user_id?, model, title, preview?, cwd?,
  started_at, ended_at?, end_reason?, message_count, tool_call_count?,
  input_tokens, output_tokens, cache_read_tokens?, reasoning_tokens?,
  estimated_cost_usd?, is_active? }` plus a new **profile snapshot**:
  `{ model, provider, api_mode, base_url, enabled_toolsets,
  disabled_toolsets, skills, memory_provider, reasoning_config,
  platform_identity }` (equivalent of Core `sessions.model_config` +
  `profile_name`).
- **Turn** — runtime-only record of one `submitPrompt`: usage, stop reason,
  steps, trace; persisted as message rows + session counters. Modeled on
  kimi-code `src/agent/records/types.ts` (`AgentRecordEvents`): a durable,
  ordered event log that can rebuild session state on resume; state records
  vs. observability records distinction should be ported.
- **Persistence strategy (two-tier)**:
  1. In-webview default: **IndexedDB** via a thin wrapper (or `minidb`-style
     JSON files under the app data dir when running in Node/Tauri context) for
     messages + session metadata; schema versioned with migration hooks.
  2. Rust SQLite bridge (Tauri IPC, `src/` keeps SQLite for OS-level data per
     `AGENTS.md`) as the durable store for large transcripts; Rust command
     `session_archive.rs` / `session_log.rs` already exist to reuse.
  - Migration: import existing `state.db` sessions/messages via a one-time
    converter (read-only access to `$HERMES_HOME/state.db` or the managed
    runtime's DB) so existing conversations survive the cutover.

## 5. Third-party library strategy

Most important section. Python dep → TS equivalent, with kimi-code evidence
(`D:/kimi-code/packages/kosong/package.json` proves the npm libs; its
`packages/kosong/src/providers/` proves the adapter pattern).

| Python dependency (Core) | TS equivalent | Evidence in kimi-code |
|---|---|---|
| `anthropic` SDK (`agent/anthropic_adapter.py`) | `@anthropic-ai/sdk ^0.95.2` | kosong `package.json` line 46; `packages/kosong/src/providers/anthropic.ts`, `anthropic-profile.ts` |
| `openai` SDK (chat_completions + codex_responses adapters) | `openai ^6.34.0` | kosong `package.json` line 48; `providers/openai-common.ts`, `openai-legacy.ts`, `openai-responses.ts` |
| Gemini native (`agent/gemini_native_adapter.py`) | `@google/genai ^1.49.0` | kosong `package.json` line 47; `providers/google-genai.ts` |
| Bedrock (`agent/bedrock_adapter.py`) | `@aws-sdk/client-bedrock-runtime` + `@aws-sdk/credential-providers` | **Not present in kimi-code** — see Risks §9 |
| Vertex (`agent/vertex_adapter.py`) | `google-auth-library` (service-account JWT → OpenAI-compat endpoint) | **Not present in kimi-code** (kosong only has `@google/genai`, not Vertex OpenAI-compat) — see Risks §9 |
| Azure identity (`agent/azure_identity_adapter.py`) | `@azure/identity` | **Not present in kimi-code** — see Risks §9 |
| `httpx`/`requests`/`urllib` (`providers/base.py` `fetch_models`) | `fetch` / `undici` | `undici ^7.27.1` in agent-core `package.json` line 102 |
| `orjson`, `pybase64` | `JSON.parse/stringify`, `btoa/atob`/`Buffer` | no third-party lib needed |
| `sqlite3` (`hermes_state.py`) | IndexedDB wrapper or Rust SQLite IPC; kimi-code uses `minidb` | `packages/minidb` (workspace); `packages/agent-core/src/session/store/session-store.ts` |
| `fire` CLI (`run_agent.py` `__main__`) | `commander`/`yargs` (CLI port only; not desktop-critical) | kimi-code CLI uses its own arg parsing |
| model catalog / provider metadata (`providers/*`, `model_metadata.py`) | port `modelCatalogService.ts` (`src/services/modelCatalog/modelCatalog.ts` + `modelCatalogService.ts`) | `IModelCatalogService`: `listModels/listProviders/getProvider/setDefaultModel/refreshProviderModels`; `toProtocolModel` maps alias → `max_context_size`/`capabilities`/`support_efforts` |
| conversation loop structure (`conversation_loop.py`) | port `src/loop/run-turn.ts` + `turn-step.ts` (`executeLoopStep`) | `packages/agent-core/src/loop/{run-turn,turn-step,tool-call,tool-scheduler,retry,events,errors}.ts` |
| message service (`agent/message_utils.py`, sanitization) | port `src/services/message/messageService.ts` + `transcript.ts` | `packages/agent-core/src/services/message/` |
| records/trajectory (`agent/trajectory.py`, runtime helpers) | port `src/agent/records/{types,persistence}.ts` | `AgentRecordEvents` event log + resume semantics |

No-TS-equivalent shims that must be designed (see §9 for full risk list):

- **Bedrock/Vertex/Azure auth**: not evidenced anywhere in kimi-code. Design a
  thin `auth.ts` shim: pluggable `CredentialProvider` interface
  (`getToken(): Promise<{apiKey?, headers?}>`) with AWS SigV4 signer (via
  `@aws-sdk/client-bedrock-runtime`), Google service-account JWT signer (via
  `google-auth-library`), and Azure `DefaultAzureCredential` (via
  `@azure/identity`). All three npm packages exist in the ecosystem; they must
  be verified against the Tauri bundler (CSP / native deps) before commit.
- **Core-only quirks** (no kimi-code equivalent): credential pools
  (`agent/credential_pool.py`), Anthropic prompt-cache control
  (`agent/prompt_caching.py`), MoA loops, codex app-server mode. Port the
  subset the desktop needs; park the rest behind `NotImplemented` capability
  flags on `ProviderProfile` (`supports_prompt_cache_key`, `api_mode`).

## 6. Integration with existing Hermes-CN-Desktop frontend

Existing pieces to **reuse** during migration:

- `web/src/lib/gateway-client.ts` — keep as the *transport adapter* (JSON-RPC
  over WS) during migration; its reconnect/session.resume orchestration is the
  behavioral spec for the in-process runtime's reconnect/resume semantics.
- `web/src/lib/gateway-delta-coalescer.ts` — reuse unchanged to coalesce
  `message.delta` into one apply per animation frame; the in-process agent
  emits the same `GatewayEvent`-shaped deltas.
- `web/src/hooks/use-gateway.ts` + `web/src/stores/chat.ts` (Jotai atoms:
  `startPromptAtom`, `applyGatewayEventAtom`, `chatRuntimeBySessionAtom`,
  `gwSessionIdAtom`) — keep the atoms; replace only the transport internals.
- `packages/protocol/src/hermes-api.ts` — the Zod schemas are the frozen wire
  contract (§7). Extend with `ProfileSnapshot`/`AgentEvent` Zod schemas for the
  in-process path.
- Rust side: keep `src/commands/*` for OS capabilities (fs, terminal pty,
  dialogs, notifications, tray); reuse `src/session_archive.rs`,
  `src/session_log.rs` for transcript persistence if SQLite-backed.

New integration surface:

- `web/src/lib/agent-runtime.ts` — singleton `AgentRuntime` backed by
  `@hermes/agent-core`; exposes the same async API the current
  `use-gateway.ts` wrapper exposes (`startPrompt`, `resumeSession`,
  `interrupt`, `switchModel`, `listModels`) so route components barely change.
- `web/src/hooks/use-agent.ts` — drop-in replacement for `use-gateway.ts`:
  subscribes to `AgentEvent` and feeds `applyGatewayEventAtom`; keeps
  `gatewayEventChangesSessionList`/`session-query-sync.ts` behavior for the
  TanStack Query session list.
- `packages/protocol` gains `AgentRuntimeEvent` Zod union (superset of
  `GatewayEvent`; start with `message.start|delta|complete|error`, `tool.*`,
  `session.*`).

## 7. Removing the WebSocket dependency (migration path)

Freeze this API surface during migration (it is what both transports must
honor):

- RPC method names: `session.create`, `session.resume`, `session.title`,
  `prompt.submit`, `model.list`, `model.switch`, `session.interrupt`,
  `session.compress`, `session.usage`.
- Event shapes: `GatewayEvent` union in `packages/protocol/src/hermes-api.ts`
  (message/tool/session events), plus the `SessionSummary`/`SessionMessage`
  schemas.
- Session identity: `session_id` mapping helpers
  (`web/src/lib/session-map.ts` `resolveGatewaySessionId` /
  `resolvePersistentSessionId`) remain the single source of truth for id
  translation.

Phases:

1. **Keep WS; build the core beside it (shadow mode).** `packages/agent-core`
   runs the same `submitPrompt` in a shadow session; compare event sequences to
   the WS stream in dev builds (`HERMES_SHADOW_AGENT=1`), no user-visible
   change.
2. **Route desktop chat through the in-process runtime.** `use-agent.ts`
   replaces `use-gateway.ts` for chat; `gateway-client.ts` stays only for
   non-chat gateway traffic and as a fallback toggle
   (`HERMES_USE_GATEWAY=1`). Feature-flag both paths; the delta coalescer and
   chat atoms are transport-agnostic so this swap is small.
3. **Delete the WS/REST chat path.** Remove `gateway-client.ts` usage from the
   chat flow; drop `/api/ws` + `session.resume` reconnect orchestration (Rust
   `ws_proxy.rs` stays only if other features need it). The managed Python
   runtime then only serves setup/health/version, and eventually is removed
   per the desktop roadmap.

## 8. Migration phases & task breakdown

- **P0 — Scaffolding**: create `packages/agent-core`; port `Message`/`Tool`/
  `ToolCall`/`TokenUsage` types; `LLM` interface + `LLMChatParams/Response`
  (kimi-code `loop/llm.ts`); `AgentEvent` union; vitest harness with a fake
  model client (echo + scripted tool calls).
- **P1 — Loop**: port `run-turn.ts`/`turn-step.ts` (max-steps, abort,
  usage aggregation), tool scheduler, error classification + retry
  (`loop/retry.ts`, `errors.ts`); parity targets:
  `tests/run_agent/test_streaming.py` (delta accumulation + tool-call
  suppression), `test_tool_call_streaming_convergence.py`,
  `test_repair_tool_call_*.py` (malformed tool args/names).
- **P2 — Adapters & providers**: port `providers/profile.ts` +
  `registry.ts`; adapters in order: `openai-chat` (generic
  `chat_completions`), `anthropic`, `openai-responses`, `gemini`; then
  `bedrock`/`vertex`/`azure` behind the `CredentialProvider` shim; model
  catalog (`catalog.ts`) with static fallback + live `/models` fetch
  (`ProviderProfile.fetch_models`).
- **P3 — Sessions**: `session-store.ts` (create/resume/append/archive),
  `profile-snapshot.ts` binding model/tools/skills/memory/provider config;
  IndexedDB/Rust-SQLite persistence; state.db import converter; session title
  + usage counters.
- **P4 — Desktop integration**: `web/src/lib/agent-runtime.ts` +
  `hooks/use-agent.ts`; wire Jotai atoms + delta coalescer; shadow mode vs WS;
  Playwright E2E against the in-process agent with the existing local fake
  model harness (`e2e/`).
- **P5 — Cutover**: remove WS chat path; freeze `EXPECTED_BACKEND_VERSION` /
  runtime checks to setup-only; delete dead transport code; optional
  CLI/messaging/TUI reuse of `packages/agent-core` (separate plans).

## 9. Risks & open questions

- **No TS equivalent found (highest risk)**:
  - `@aws-sdk/client-bedrock-runtime` (Bedrock Converse) — not present in
    kimi-code; npm lib exists but SigV4 signing + streaming event shapes must
    be ported from `agent/bedrock_adapter.py` by hand.
  - `google-auth-library` for Vertex service-account/ADC — not in kimi-code;
    kimi-code only proves `@google/genai`, so the Vertex OpenAI-compatible
    endpoint + token refresh (5-min expiry cache in `vertex_adapter.py`) has no
    reference implementation in the TS repos we studied.
  - `@azure/identity` — not in kimi-code; Azure token-credential flow must be
    designed from scratch.
  - Verify all three against the Tauri webview CSP (network + crypto APIs) and
    the Rust bundler before committing to them.
- **Scope risk**: the Python core is ~40k lines across the listed files;
  `run_agent.py`/`conversation_loop.py` are 8k+ lines each and encode years of
  provider quirks (thinking budgets, prompt-cache control, credential pools,
  MoA, codex app-server). A full byte-for-byte port is not feasible — the plan
  must freeze a "desktop parity subset" (streaming, tool-calling convergence,
  repair paths, session resume, model switch, fallback) and explicitly defer
  the rest.
- **Semantic gap**: kimi-code's `kosong` normalizes finish reasons and
  thinking, but Hermes Anthropic-specific behaviors (`THINKING_BUDGET`,
  `ADAPTIVE_EFFORT_MAP`, cache_control planning in `agent/prompt_caching.py`)
  are not modeled by kosong; our adapters must extend `LLMChatParams` without
  breaking the shared loop contract.
- **Async/interrupt semantics**: Python uses threads + `request_hard_interrupt`
  (`agent/interrupt_compat.py`); TS must map this onto `AbortSignal` +
  `AbortController` (kimi-code `run-turn.ts` already does abort checks at loop
  boundaries — port that pattern; verify parity for mid-stream interruption
  tests like `test_concurrent_interrupt.py`).
- **Session data migration**: existing users' `state.db` transcripts and
  session rows must import cleanly; schema drift between Core releases
  (`SessionMessage` uses `.passthrough()` for this reason) must be preserved in
  the TS persistence layer.
- **Open questions**: is chat the only WS consumer to move (what about
  `api_proxy.rs` REST for non-chat data)? Does the desktop need MoA/credential
  pools in the first in-process cut? Should CLI/messaging/TUI ports share
  `packages/agent-core` in this repo or a separate one?

## 10. Test strategy

- **Vitest unit** (per package):
  - Adapters: parity ports of `tests/agent/test_anthropic_adapter.py`,
    `test_bedrock_adapter.py`, `test_gemini_native_adapter.py`,
    `test_vertex_adapter.py`, `test_codex_responses_adapter.py`,
    `test_minimax_provider.py`, `test_kimi_coding_anthropic_thinking.py`,
    `test_deepseek_anthropic_thinking.py`, `test_azure_identity_adapter.py` —
    mock vendor SDK responses, assert normalized `LLMChatResponse` +
    streamed parts + usage + finish reason.
  - Loop: parity ports of `tests/run_agent/test_run_agent.py` (subset),
    `test_streaming.py` (accumulator + delta callbacks + tool-call
    suppression), `test_tool_call_streaming_convergence.py` (convergence),
    `test_repair_tool_call_arguments.py` / `test_repair_tool_call_name.py`
    (repair paths).
  - Providers: `tests/providers/test_provider_registry.py`,
    `test_provider_profiles.py`, `test_transport_parity.py` → registry
    override ordering (user plugin wins), profile field defaults, fetch_models
    fallback.
  - Sessions: create/resume round-trip, profile-snapshot restore, id mapping.
- **Integration**: shadow-mode diff harness — run the same fake-model prompt
  through WS gateway-client and in-process `AgentRuntime`; assert identical
  event sequences (deterministic fake model). SQLite/IndexedDB migration test
  with a fixture `state.db`.
- **Playwright E2E**: reuse `e2e/` (real web → fake model) with the in-process
  runtime; cover stream render (delta coalescer), tool-call convergence,
  interrupt, session resume after reload.
- **Parity matrix**: keep a table mapping each Core test file → TS test file →
  status (ported / subset / deferred) in the package README so the cutover
  gate ("all P1 parity tests green") is checkable in CI.

## 11. Reference links

- Python: `D:/hermes-agent-cn/run_agent.py`, `agent/agent_init.py`,
  `agent/conversation_loop.py`, `agent/agent_runtime_helpers.py`,
  `agent/chat_completion_helpers.py`, `agent/*_adapter.py`,
  `providers/base.py`, `providers/__init__.py`, `hermes_state.py`,
  `README.md`, `AGENTS.md`,
  `website/docs/user-guide/features/overview.md`,
  `tests/run_agent/*`, `tests/agent/*`, `tests/providers/*`.
- TS reference: `D:/kimi-code/packages/agent-core/src/loop/` (`llm.ts`,
  `types.ts`, `run-turn.ts`, `turn-step.ts`, `tool-call.ts`,
  `tool-scheduler.ts`, `retry.ts`, `events.ts`, `errors.ts`),
  `src/agent/turn/`, `src/agent/records/types.ts`,
  `src/services/modelCatalog/`, `src/services/message/`,
  `src/session/store/`, `packages/kosong/src/providers/` + `package.json`,
  `apps/kimi-code/src/cli/v2/run-v2-print.ts`.
- Desktop: `D:/Hermes-CN-Desktop/web/src/lib/gateway-client.ts`,
  `web/src/lib/gateway-delta-coalescer.ts`, `web/src/hooks/use-gateway.ts`,
  `web/src/stores/chat.ts`, `packages/protocol/src/hermes-api.ts`,
  `AGENTS.md`, `plans/README.md`.
