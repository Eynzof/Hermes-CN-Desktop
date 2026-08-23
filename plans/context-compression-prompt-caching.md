# Context Compression & Prompt Caching — Python → TypeScript Rewrite Plan

> Feature #5 in `plans/_INDEX.md`. Design-only; NO implementation.
> Goal: port `/compress` + automatic compression + always-on 1-hour cross-session
> prefix cache for Claude (Anthropic / OpenRouter / Nous Portal) from the Python
> backend (`D:/hermes-agent-cn`) into the in-process TypeScript agent runtime
> of the desktop app, so the WS/REST compression path can be deleted.

## 1. Summary

Hermes currently compresses long conversations in Python with a dual system:
(1) the **agent-side `ContextCompressor`** (fires at `threshold` = 50% of the
main model's context window, structured LLM summarization of the middle turns
with protected head/tail), plus (2) the **gateway session-hygiene safety net**
(fixed 85%). Users can force it with `/compress` (aliases `/compact`, forms
`/compress <focus>`, `/compress here [N]`, `--preview/--dry-run`). Separately,
**Anthropic prompt caching** is always-on for Claude models on native
Anthropic, OpenRouter, and Nous Portal: request-local `cache_control`
breakpoints (static system prefix + full system prompt + last 2 messages;
TTL `5m` default / `1h` for cross-session) placed by `agent/prompt_caching.py`,
with a builder-declared stable-prefix registry in `agent/prompt_cache_boundary.py`
so skill/webhook/cron scaffolds stay cacheable across sessions.

This plan ports both into TypeScript. The compaction skeleton reuses
kimi-code's `packages/agent-core/src/agent/compaction/` design (strategy at 85%,
`FullCompaction` lifecycle, `ContextMemory.applyCompaction`, `PromptOrigin`
message provenance) as the proven TS pattern; Hermes-specific pieces — the
structured summary template, boundary alignment, tool-pair sanitization, the
4-breakpoint `cache_control` planner and the stable-prefix registry — have **no
TS equivalent in kimi-code** and are implemented from scratch (Section 5).

## 2. Current Python implementation

Source files (all under `D:/hermes-agent-cn`):

| Concern | File(s) |
|---|---|
| Context engine ABC | `agent/context_engine.py` — `ContextEngine.should_compress()/compress()/on_session_start/on_session_end`, plugin resolution via `context.engine` config |
| Default compressor | `agent/context_compressor.py` (~105K chars) — `ContextCompressor(ContextEngine)`; 4-phase `compress()`; `threshold_tokens`; `update_model()`; micro-compaction; proactive tool-result pruning |
| Compression orchestration | `agent/conversation_compression.py` (~103K chars) — `compress_context()`, `check_compression_model_feasibility`, `CompressionCommitFence` (timeout/cancel semantics), status constants (`COMPACTION_STATUS_MARKER = "Compacting context"` → gateway re-tags `kind="compacting"`) |
| Native OpenAI compaction | `agent/native_compaction.py` — gpt-5.6-only Responses `context_management=[{"type":"compaction","compact_threshold":N}]` on direct OpenAI/Codex routes |
| Prompt-cache planner | `agent/prompt_caching.py` — pure functions: `build_prompt_cache_plan`, `apply_anthropic_cache_control`, `strip_anthropic_cache_control`, `strip_anthropic_tool_cache_control`, `PromptCachePlan` |
| Stable-prefix registry | `agent/prompt_cache_boundary.py` — `register_stable_prefix/find_stable_prefix/clear_stable_prefixes` (LRU, 32 entries / 4MB chars) |
| Byte-level compression | `hermes_compress.py` — Zstandard/LZ4 wrappers (NOT the `/compress` command; used for archived session bytes) |
| `/compress` CLI helpers | `hermes_cli/partial_compress.py` — pure split/rejoin/preview logic (`extract_compress_flags`, `parse_partial_compress_args`, `summarize_compress_preview`, `split_history_for_partial_compress`, `rejoin_compressed_head_and_tail`); registry alias `/compact` in `hermes_cli/commands.py`; callers `cli.py::_manual_compress`, `gateway/run.py`/`gateway/slash_commands.py::_handle_compress_command` |
| Manual feedback | `agent/manual_compression_feedback.py` — `summarize_manual_compression` (`noop/aborted/fallback_used/headline/token_line/note`), `describe_compression_lock_skip` |
| Cache policy | `agent/agent_init.py` (prompt-cache enable + `cache_ttl` config), `agent/agent_runtime_helpers.py::anthropic_prompt_cache_policy` + `plan_cache_sections_for_destination` (native vs envelope layout; MoA/aux paths) |

Key semantics to preserve:

- **Threshold math**: `threshold_tokens = threshold × context_length(main model)`;
  tail budget `= threshold_tokens × target_ratio (0.20)`; summary budget
  `= min(context_length × 0.05, 12_000)` scaled by `content_tokens × 0.20`
  (min 2_000). Small-context floor: models < 512K floored at 0.75. Per-model
  `model_thresholds` substring overrides (longest key wins).
- **4-phase compress**: (1) prune old tool results >200 chars (LLM-free);
  (2) boundary selection — protect first 3, token-budget tail walk with
  `protect_last_n` fallback, `min_tail_user_messages`, `_align_boundary_backward/forward`
  keeps tool_call/tool_result groups intact; (3) structured summary via
  `call_llm(task="compression")` with `SUMMARY_PREFIX` ("[CONTEXT COMPACTION —
  REFERENCE ONLY]…") + `## Historical Task Snapshot` heading + iterative update
  from `_previous_summary`; (4) assembly + `_sanitize_tool_pairs` + role
  alternation pick (`_template_visible_role`), metadata key
  `_compressed_summary` (stripped on the wire, persisted for frontends).
- **In-place compaction** (default `compression.in_place: true`): same session
  id, old turns soft-archived (`active=0, compacted=1`), `session:compress`
  event carries `in_place`/`old_session_id`.
- **Cache breakpoints**: max 4 per request. Layout `system_and_2`:
  `static_system_prefix` marker + full system-prompt marker + last 2 cacheable
  non-system messages; fallback `system_and_3`. Native Anthropic puts markers
  top-level/inside content blocks; OpenRouter envelope layout only honors
  markers inside content parts (empty tool/assistant-turn messages skip).
  Tool-cache layout (`direct_native_tool_cache`) marks last tool + system
  prefix, using `_completed_transaction_endpoint_indexes` for retained
  tool-run ends. Markers are request-local only; canonical history is plain.

Docs: `website/docs/user-guide/features/overview.md` (feature card: "Built-in
cross-session 1-hour prefix cache for Claude on native Anthropic, OpenRouter,
and Nous Portal. Always-on; no configuration required.") and
`website/docs/developer-guide/context-compression-and-caching.md` (dual system,
config table, algorithm, cache strategy `system_and_3`, cache-aware patterns).

## 3. Target TypeScript design

New module: **`packages/agent-runtime/src/context/`** (kept separate from
`packages/protocol` — wire Zod schemas — and `web/src` — React), mirroring
kimi-code's `packages/agent-core/src/agent/{compaction,context,usage}` layout:

```
packages/agent-runtime/src/context/
├── types.ts                 # PromptOrigin, ContextMessage, CompactionConfig,
│                            #   CompactionResult, CompactionBeginData, CompactionSource
├── token-estimator.ts       # port kimi-code utils/tokens heuristic + Hermes rough est.
├── strategy.ts              # CompactionStrategy (kimi-code DefaultCompactionStrategy
│                            #   extended: threshold_percent, protect_last_n, target_ratio)
├── compressor.ts            # Hermes ContextCompressor port: should_compress/compress
│                            #   (4 phases), threshold resolution, boundary alignment,
│                            #   sanitize tool pairs, summary assembly + SUMMARY_PREFIX
├── summarizer.ts            # auxiliary LLM call (structured template, iterative update)
├── compaction-manager.ts    # orchestration: per-session single-flight (CommitFence analog),
│                            #   lifecycle events compaction.started/compacted/blocked
├── manual-compress.ts       # port hermes_cli/partial_compress.py pure helpers
├── prompt-cache/planner.ts  # port prompt_caching.py (4 breakpoints, layouts, strip fns)
├── prompt-cache/boundary-registry.ts  # port prompt_cache_boundary.py LRU registry
└── native-compaction.ts     # optional: gpt-5.6 Responses context_management gate
```

Key interfaces (pseudocode only):

```ts
interface ContextEngine {
  shouldCompress(promptTokens?: number): boolean;
  compress(messages, systemPrompt, opts): Promise<CompressResult>;
  onSessionStart(id: string): void;
  onSessionEnd(id: string, messages): void;
  updateModel(model: string): void;
}
interface CachePlanner {
  buildPlan(messages, tools, { cacheTtl, nativeAnthropic, staticSystemPrefix }): CachePlan;
  strip(messages, tools): { messages; tools }; // request-local canonicalization
}
interface CompactionManager {
  beginManual({ focusTopic, partial, keepLast, preview }): Promise<ManualCompressReport>;
  checkAuto(tokenCount): boolean; // threshold trigger, called at turn boundaries
  onUsageReported(usage): void;   // track API-reported tokens + cache_read/write
}
```

Data flow (post-migration, in-process): `use-gateway`/composer → `AgentRuntime`
→ `CompactionManager` → `Compressor` (summarizer via provider client) →
`CachePlanner` decorates the outbound request (request-local copies, canonical
history untouched) → provider. Compression status is emitted as local events
that map 1:1 to today's gateway events (`session:compress`, `kind="compacting"`
status marker) so `web/src` needs no UI rewiring.

## 4. Data models & persistence

- **Model message shape** (in-process): OpenAI-style
  `{ role, content: string | ContentPart[], tool_calls?, cache_control? }` +
  kimi-code `origin?: PromptOrigin` and `isError`/`toolCallDisplays` extras.
  `cache_control` is **request-local decoration only** — never persisted;
  `strip` runs before storage and before failover re-decoration (port of
  `strip_anthropic_cache_control`).
- **Compaction markers**: replace Python's underscore metadata keys
  (`_compressed_summary`, `_micro_compact_marker`) with structured `origin:
  { kind: 'compaction_summary' }` (kimi-code `ContextMessage.origin` pattern) +
  `summaryMessage: boolean`. UI filters on `origin` instead of content-prefix
  heuristics; wire sanitizers drop the field.
- **Session store**: keep current Rust SQLite (`src/commands/session_log.rs`,
  `session_archive.rs`) for archived/compacted turns; in-process live context is
  a `ContextMemory`-style array (port of kimi-code `agent/context/index.ts`)
  with `tokenCount` maintained incrementally. Migration adds columns:
  `origin`/`is_summary`, `compressed_at`, `compression_count`,
  `last_compaction_savings_tokens`; in-place mode rewrites rows `active=0,
  compacted=1` on the same `session_id` (mirror Python's `in_place` contract so
  `session_search` and session maps keep working).
- **Cache stats**: extend `SessionUsageResult` already in
  `packages/protocol/src/hermes-api.ts` (`cache_read`, `cache_write` fields
  exist) with `cache_breakpoints`, `cache_ttl`, `static_prefix_bytes`.

## 5. Third-party library strategy

Most important section. Every Python dep → TS equivalent:

| Python dependency | TS equivalent | Evidence |
|---|---|---|
| `openai` / Anthropic client (`auxiliary_client.call_llm`, adapters) | `@moonshot-ai/kosong` provider client (kimi-code's generate layer) or `@anthropic-ai/sdk` / `openai` | kimi-code `packages/agent-core/src/session/provider-manager.ts` builds `KosongProviderConfig` (`type: 'anthropic' | 'openai' | 'kimi'`); `agent/compaction/full.ts` imports `@moonshot-ai/kosong` (`GenerateResult`, `TokenUsage`, errors) |
| Token counting (`agent/model_metadata.estimate_tokens_rough`, `estimate_messages_tokens_rough`) | `estimateTokens`/`estimateTokensForMessages`/`estimateTokensForTools` from kimi-code `packages/agent-core/src/utils/tokens.ts` (heuristic: ASCII ≈4 chars/token, CJK ≈1 char/token, `MEDIA_TOKEN_ESTIMATE = 2000`, WeakMap cache) | read above; desktop `web/src/lib/context-usage.ts` already uses the same 4-chars/token heuristic |
| `xxhash`, `orjson` (telemetry/dedup) | none needed — TS `crypto`/`JSON`; `xxhashjs` optional | not present in kimi-code core |
| `sqlite3` `SessionDB` (state.db) | Rust SQLite via Tauri IPC (`src/commands/session_log.rs`) or `packages/minidb` | kimi-code `packages/minidb` is the embedded-DB engine |
| `zstandard`/`lz4` (`hermes_compress.py`) | `fzstd` / `fflate` or Node `zlib` — only if byte-level session archive compression is ported (out of core scope) | no kimi-code equivalent seen; mark optional |
| `Jinja` prompt templates | TS template literals (kimi-code uses `*.md?raw` templates) | `compaction/compaction-instruction.md?raw`, `compaction-summary-prefix.md?raw` |
| Compression strategy config | kimi-code `agent/compaction/strategy.ts` `CompactionConfig` + `DefaultCompactionStrategy` (85% trigger/block, `reservedContextSize: 50_000`, `maxOverflowCompactionAttempts: 3`) | read above |
| Compaction lifecycle | kimi-code `agent/compaction/full.ts` `FullCompaction` (`begin` manual/auto, refuse manual while turn active, `cancel`, `handleOverflowError`, `beforeStep`/`afterStep` hooks, `checkAutoCompaction` with `lastCompactedTokenCount` no-recompact guard) | read above |
| Context memory & token accounting | kimi-code `agent/context/index.ts` `ContextMemory` (`appendMessage`, `tokenCount`, `applyCompaction` single derivation point, pending tool-result sets) | read above |
| Message provenance / compaction summary | kimi-code `agent/context/types.ts` `PromptOrigin` + `agent/compaction/handoff.ts` (`compactionUserMessageDisposition`, `selectCompactionUserMessages` head/tail + elision marker) | read above |

**No TS equivalent found — implement from scratch:**

1. **Anthropic `cache_control` breakpoint planner** (`agent/prompt_caching.py`).
   kimi-code does NOT place `cache_control` markers. Its caching strategy is
   provider session-affinity only: `promptCacheKey: sessionId` →
   `metadata: { user_id: promptCacheKey }` on the Anthropic Messages wire and
   `generationKwargs: { prompt_cache_key }` for OpenAI/Kimi
   (`packages/agent-core/src/session/provider-manager.ts` lines 300–345); it
   only *keeps the cache warm* by append-only injections
   (`agent/turn/index.ts`, `agent/injection/tools-diff.ts`). The 4-breakpoint
   planner (native vs envelope layout, static-prefix split, tool-cache layout,
   ≤4 marker invariant, strip functions) must be written as a pure TS module
   with the same interface as `build_prompt_cache_plan`; parity tests come from
   `tests/agent/test_prompt_caching.py`.
2. **Stable-prefix registry** (`agent/prompt_cache_boundary.py`) — LRU of
   builder-declared prefixes (32 entries / 4MB chars) enabling the cross-session
   prefix cache; no kimi-code equivalent (kimi-code has no skill/webhook/cron
   message scaffold boundary concept).
3. **Hermes summary template & boundary alignment** — kimi-code's handoff
   keeps *user messages verbatim* head/tail and drops assistant/tool content;
   Hermes summarizes *all middle turns* into a structured
   `Goal/Progress/Decisions/Files/Next Steps` summary with role-alternation
   handling. The 4-phase algorithm is Hermes-specific; port as designed, not
   from kimi-code.

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse today (no change):

- `web/src/hooks/use-gateway.ts` — `compressSession(sessionId, focus)`
  (`session.compress` RPC), gateway event plumbing.
- `web/src/hooks/use-session-usage-polling.ts` — usage polling + `message.complete`
  updates; add cache stats rendering (fields already in `SessionUsageResult`).
- `web/src/lib/context-usage.ts` — `buildComposerContextUsage`, `contextUsagePercent/Risk`;
  swap `estimateRenderedContextTokens` char heuristic for in-process estimator later.
- `web/src/lib/compress-feedback.ts` — `formatCompressNotice` renders the Chinese
  notice from `SessionCompressResult` numeric fields; keep, feed from in-process result.
- `web/src/routes/detail.tsx` — `runManualCompress`, compression-tip follow
  (#305), session-map alias handling after in-place compaction.
- `packages/protocol/src/hermes-api.ts` — `SessionCompressParams/Result`,
  `SessionUsageResult` (extend, don't break).
- `web/src/stores/chat.ts` — `session.compress` status pinning; `src/commands/`
  Rust side unchanged for archive/log queries.

Replace over migration: the `session.compress` RPC → in-process
`CompactionManager`; `getSessionUsage` → in-process token counter; WS delivery
of `session:compress` → local event with identical payload shape.

## 7. Removing the WebSocket dependency (migration path)

Phased, with a frozen API surface during migration:

1. **Freeze interface** (already mostly stable): `SessionCompressParams`,
   `SessionCompressResult`, `SessionUsageResult`; gateway events `session:compress`,
   `message.complete`, and the status marker string `"Compacting context"`
   (`kind="compacting"`); UI consumes only these.
2. **Phase A (hybrid)**: keep `session.compress` RPC for execution; run the new
   TS `CachePlanner` request-locally at the transport boundary so cache
   breakpoints are placed in-process while the backend still owns history.
   Verify against `SessionUsageResult.cache_read/write` deltas.
3. **Phase B (in-process engine)**: `CompactionManager` behind the same
   `compressSession`-shaped function; backend call becomes telemetry/fallback
   only; `session:compress` payloads emitted locally still carry
   `in_place`/`old_session_id`.
4. **Phase C (delete)**: remove the WS/REST compression path (gateway RPC +
   `/api/usage` polling for this feature); delete `compress-feedback` backend
   coupling; Rust `ws_proxy.rs` retains only non-compression relay duties.

## 8. Migration phases & task breakdown

- **P0 — Foundations**: `types.ts`, `token-estimator.ts` (port kimi-code
  heuristic + Hermes rough estimate), `manual-compress.ts` pure helpers.
  Parity: `tests/cli/test_compress_flags.py`, `tests/cli/test_partial_compress.py`,
  `tests/cli/test_compress_here.py`.
- **P1 — Cache planner**: `prompt-cache/planner.ts` + `boundary-registry.ts`.
  Parity: `tests/agent/test_prompt_caching.py` (marker counts ≤4, native vs
  OpenRouter, strip functions, empty-block guard, copy-on-write).
- **P2 — Compressor engine**: `compressor.ts` — threshold resolution
  (`model_thresholds`, floor, cap), 4-phase compress, boundary alignment,
  tool-pair sanitization, summary assembly. Parity: `tests/agent/test_context_compressor.py`
  + the ~43 `test_compression_*.py` + `test_compressor_*.py` files (agent/gateway/
  run_agent/cli/state) as a parity matrix.
- **P3 — Orchestration**: `compaction-manager.ts` (single-flight per session =
  Python `CompressionCommitFence` analog, idle compaction, anti-thrash
  cooldown), wire UI (`detail.tsx` manual compress → in-process, cache stats).
- **P4 — Summarizer & native compaction**: `summarizer.ts` (aux LLM via
  kosong/provider client, iterative update), `native-compaction.ts` (gpt-5.6
  Responses gate; low priority for desktop).
- **P5 — Decommission WS path**; full E2E on packaged app.

## 9. Risks & open questions

- **No TS equivalent for cache_control planner** (kimi-code only uses
  session-affinity `metadata.user_id`/`prompt_cache_key`) — the 4-breakpoint
  planner + stable-prefix registry are a from-scratch port; provider quirks
  (OpenRouter rejects top-level marker on `role:tool`; native vs envelope
  layout; ≤4 breakpoints; no empty text blocks) must be pinned by parity tests.
- **"Always-on 1h" vs code default**: the overview feature card says
  "always-on 1-hour cross-session prefix cache", but `agent_init.py` defaults
  `prompt_caching.cache_ttl` to `"5m"` (configurable to `"1h"`; 1h write costs
  2× vs 5m's 1.25×). Open question: should desktop ship the `1h` default
  (feature-card wording) or mirror the 5m code default? Decide with product.
- **Cross-session prefix stability**: cache hits require byte-identical
  prefixes; any per-session variance (memory block, model switch, credential
  rotation) breaks the cross-session reuse. Keep static-prefix registry
  process-local and fall back to whole-message caching on registry eviction.
- **Model identity is part of the provider cache key** — mid-session `/model`
  switch or fallback yields zero hits (documented in developer guide §5).
- **Summary model context requirement**: aux model must fit the main model's
  window; TS summarizer needs the same feasibility probe.
- **Single-threaded commit fence**: Python's threaded timeout/cooldown commit
  maps to per-session single-flight promises + AbortController (kimi-code
  `FullCompaction` uses AbortController — good precedent); must keep the
  "two compressions never run concurrently per session" invariant.
- **In-place compaction persistence**: rewrites rows on the same session id;
  desktop's `session-map.ts`/session-map aliases and `ui-store` turn stats must
  not key on id changes.
- Native Responses compaction (gpt-5.6) may be out of scope for the desktop
  Claude-first caching story — confirm with product.

## 10. Test strategy

- **Vitest unit (parity vs Python)**: table-driven mapping of Python tests →
  TS tests: `test_prompt_caching.py` → planner tests; `test_compress_flags.py`
  / `test_partial_compress.py` / `test_compress_here.py` → manual-compress
  tests; `test_context_compressor.py` + `test_compressor_*.py` → boundary/
  pruning/sanitize/assembly tests; `test_compression_*` (anti-thrash, cooldown,
  lock, progress) → `CompactionManager` tests with fake summarizer.
- **Integration**: in-process `CompactionManager` with a mock provider client;
  assert `session:compress`-shaped events, `in_place` flag, cache plan applied
  to outbound request and canonical history untouched (copy-on-write).
- **E2E (Playwright)**: composer `/compress` (or Compress button) → compressed
  notice (`formatCompressNotice`); auto-compaction indicator on `kind="compacting"`;
  usage ring shows cache_read/cache_write; long-session regression with fake model.
- **Perf**: token estimator benchmarks against kimi-code heuristic; ensure no
  O(n²) re-estimation on long histories (WeakMap cache, incremental counts).
- Run `pnpm typecheck`, `pnpm test:unit`, `cargo check` after each phase per
  `AGENTS.md` 改完代码必做.

## 11. Reference links

- Python: `D:/hermes-agent-cn/agent/{context_engine,context_compressor,conversation_compression,native_compaction,prompt_caching,prompt_cache_boundary,manual_compression_feedback}.py`, `hermes_compress.py`, `hermes_cli/partial_compress.py`, `hermes_cli/commands.py`, `agent/agent_init.py`, `agent/agent_runtime_helpers.py`
- Docs: `website/docs/developer-guide/context-compression-and-caching.md`, `website/docs/user-guide/features/overview.md`
- Tests: `tests/agent/test_context_compressor.py`, `tests/agent/test_prompt_caching.py`, `tests/cli/test_compress_flags.py`, `tests/test_cli_manual_compress.py`, ~80 `test_*compress*.py` under `tests/{agent,gateway,run_agent,cli,state,tui_gateway,performance}`
- kimi-code: `packages/agent-core/src/agent/compaction/{index,strategy,full,micro,handoff,types,render-messages}.ts`, `src/agent/context/{index,types,projector}.ts`, `src/agent/usage/index.ts`, `src/utils/tokens.ts`, `src/session/provider-manager.ts`
- Desktop: `web/src/lib/{compress-feedback,context-usage}.ts`, `web/src/hooks/{use-session-usage-polling,use-session-turn-stats}.ts`, `web/src/routes/detail.tsx`, `web/src/hooks/use-gateway.ts`, `packages/protocol/src/hermes-api.ts`
