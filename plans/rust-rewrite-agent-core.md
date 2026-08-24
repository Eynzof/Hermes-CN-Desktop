# Plan: Rewrite agent-core modules from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/agent-core/src/...` (plus closely coupled `packages/agent-tools/src/token-estimate.ts`, `packages/skill-lint/src/frontmatter.ts`, `packages/protocol/src/session-log.ts`)
- Target Rust: `src/...` (crate `hermes_agent_cn`, single Cargo crate — no new external crate)
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

After deep-reading `packages/agent-core/` (215 files, 1.4 MB), only a small set of
modules genuinely benefits from a Rust rewrite. The honest headline: **3 high-value
rewrites, 2 medium-value, 1 conditional**, everything else stays TS.

High value:

1. **Token counting** — `packages/agent-tools/src/token-estimate.ts` uses
   `js-tiktoken` (WASM port of cl100k_base). A native `tiktoken-rs` implementation
   is faster and removes the WASM encoder from the webview bundle, and lets us
   collapse at least four duplicated heuristic estimators into one implementation
   (`packages/agent-core/src/compaction/compress.ts` `estimateTokens`,
   `web/src/lib/context-references/resolve.ts` `estimateTokensRough`,
   `web/src/lib/context-usage/formatter.ts`, `web/src/lib/tools/tool-search/retrieval.ts`).
2. **Compaction planning** — `packages/agent-core/src/compaction/compress.ts`
   contains pure, CPU-bound, O(n) token scans + range selection
   (`estimateMessagesTokens`, `shouldCompress`, `selectCompressibleRange`,
   `alignBoundaryToToolPairs`, `sanitizeToolPairs`) that run on the turn hot path
   before every LLM call (`run-turn.ts`). Moving the deterministic planning to Rust
   takes the token scan off the webview JS event loop (which otherwise blocks UI
   during large-context compaction) and gives one testable implementation.
3. **SKILL.md frontmatter parsing/validation** — the hand-rolled YAML-subset parser
   is duplicated in `packages/agent-core/src/skills/loader.ts` and
   `packages/skill-lint/src/frontmatter.ts`; Rust already has `serde_yaml`. This is
     a correctness/dedupe win, not a perf win (loads happen at startup), and follows
     the planned `src/commands/skills.rs` native-skills pattern (the module does not
     exist yet — it is created by this plan's Phase 3).

Medium value:

4. **Cron scheduling** — `packages/agent-core/src/cron/schedule.ts` is explicitly a
   stub for classic 5-field cron (`approximateNext` just returns `after + 60_000`).
   Rust (already owning `src/cron_runs.rs`) can implement real expansion. Consumers:
   `cron/scheduler.ts`, `web/src/lib/slash-commands/handlers/automation.ts`.
5. **Learning memory graph** — `packages/agent-core/src/learning/graph.ts` is real
   algorithmic CPU work (O(n²) pairwise keyword scoring). Runs on demand
   (`web/src/components/chat/learning-journey-panel.tsx`), so medium value.

Conditional:

6. **Approval policy evaluation** — `packages/agent-core/src/approval/policy.ts` is
   security-critical and pure, but today the *enforcement* point is TS tool dispatch
   (`turn-step.ts` → `tool.execute`). Moving only the evaluation to Rust adds IPC
   without a security gain. Only do it as part of a native gate where the Rust
   command also authorizes tool execution.

**Not candidates (stay TS)**, with one-line reasons: LLM provider network adapters
(HTTP I/O + SSE must parse inline with the stream loop; per-chunk IPC would dominate),
`run-turn.ts`/`turn-step.ts`/`retry.ts` (orchestration over TS LLM adapters + TS tool
registry; Rust→TS callback IPC per step is worse), `moa/orchestrator.ts` + `council.ts`
(orchestration over LLM calls; vote parsing is tiny), `usage/tracker.ts` (trivial
arithmetic, UI-adjacent state), `curator/engine.ts`, `event-hooks/engine.ts`,
`goals/ralph.ts`, `plugins/registry.ts` (stateful registries/orchestration over injected
callbacks), `session-search-recall/tool.ts` (thin Zod dispatch; FTS5 core already in
Rust `state_db.rs`), `checkpoints/git-diff.ts` (provider abstraction; Rust already has
`commands/git.rs`), `learning/journey.ts`, `memory/*`, `session/store.ts`,
`skills/registry.ts|hub.ts|stacking.ts|commands.ts`, `personality/*`,
`reasoning/extract.ts`, `tool-args-parse.ts` (tiny pure helpers).

The dual-runtime constraint (browser-only dev `python run.py` runs the SAME TS with NO
Rust) means every migrated module keeps a TS fallback behind a small IPC shim until the
team explicitly gates browser-only dev.

## 2. Why rewrite (value/motivation, quantified where possible)

| Module | Value | Honest quantification |
|---|---|---|
| Token counting (`agent-tools/src/token-estimate.ts` + heuristic dupes) | Remove WASM/js-tiktoken from webview bundle; one implementation; speed | Native BPE encode is typically ~10–50× faster than WASM `js-tiktoken`, but real savings per turn are only a few ms (single count of 10k–100k chars). The bundle/consistency win is bigger than the raw speed win. |
| Compaction planning (`compaction/compress.ts`) | Offload O(n) token scan + range alignment from JS main thread; deterministic, testable | Compaction runs once per turn in `run-turn.ts`. On a 100k-token context, the TS scan blocks the webview event loop for several ms while streaming UI freezes; Rust runs it off-thread. IPC serialization cost is real (see Risks §9.3) — net win is modest but real, and it removes a class of duplicated estimators. |
| SKILL.md parsing (`skills/loader.ts` + `skill-lint/src/frontmatter.ts`) | Kill duplicated hand-rolled YAML; use `serde_yaml`; validation at a native boundary | Zero measurable runtime impact (startup-only). Value is correctness + one source of truth + planned `src/commands/skills.rs` affinity (module created by this plan, not pre-existing). |
| Cron (`cron/schedule.ts`) | Fix a known functional gap (classic 5-field cron is a +60s stub) | Small module; correctness win, not perf. |
| Learning graph (`learning/graph.ts`) | Offload O(n²) scoring off JS thread | Runs on user demand (journey panel); real CPU work on large memory stores but not hot. |
| Approval policy (`approval/policy.ts`) | Potential native enforcement point | Only valuable if enforcement also moves to Rust; otherwise IPC for no gain. |

Net: this is **not** a wholesale rewrite. If only the top-3 land, that is the
recommended scope.

## 3. Scope (in-scope / out-of-scope)

### In-scope

- `packages/agent-tools/src/token-estimate.ts` (`countTokens`, `estimateToolTokens`,
  `estimateToolSetTokens`, `estimateToolSetTokensSync`) — token counting.
- `packages/agent-core/src/compaction/compress.ts` — deterministic subset:
  `estimateTokens`, `estimateMessageTokens`, `estimateMessagesTokens`,
  `resolveCompactionConfig`, `shouldCompress`, `selectCompressibleRange`,
  `alignBoundaryToToolPairs`, `sanitizeToolPairs`, `buildConfig`. The async
  `compressSessionContext` orchestration (summarizer call, events, randomId) stays TS.
- `packages/agent-core/src/compaction/prompt-cache.ts` — `buildPromptCachePlan` (pure
  breakpoint selection; 4-breakpoint invariant) and `buildCacheKey`. The stateful
  `StablePrefixRegistry` stays TS (tiny LRU; pass the matched prefix/breakpoint hint
  into the Rust call). `cache-control.ts` attach/strip helpers stay TS (trivial
  object mutation).
- `packages/agent-core/src/skills/loader.ts` — `parseFrontmatter`,
  `validateSkillMetadata`, `normalizeMetadata`; plus the duplicate parser in
  `packages/skill-lint/src/frontmatter.ts` (route lint through the same Rust command).
- `packages/agent-core/src/cron/schedule.ts` — `parseCronExpression`, `nextRunTime`
  (proper 5-field expansion).
- `packages/agent-core/src/learning/graph.ts` — `buildMemoryGraph` pure algorithm
  (`tokenize`, `sharedKeywordScore`, `topEdges`, node/edge construction).
- (Conditional) `packages/agent-core/src/approval/policy.ts` — `DangerLevelPolicy`,
  `ToolsetPolicy`, `ToolNamePolicy`, `CompositePolicy`, `buildDefaultApprovalPolicy`
  — only with a native enforcement gate.
- Cross-cutting shared homes used by the above and by other plans:
  - `src/tokenize/` — native token counting (tiktoken-rs + heuristic fallback).
  - `src/schema/` — serde request/response types mirroring `@hermes/protocol` Zod
    schemas (esp. `protocol/src/session-search.ts`, `protocol/src/session-log.ts`);
    single home for Zod→serde validation at the IPC boundary.
  - Note: session-log parsing already has a Rust home (`src/session_log.rs`); extend
    it for `sessionLogToMessages` parity rather than creating a new module.

### Out-of-scope (explicitly)

- LLM provider network adapters (`providers/*.ts`): HTTP I/O; SSE parsing must stay
  inline with the streaming read loop — moving `processLine` to Rust would add an IPC
  round-trip per SSE chunk and be slower, and browser-only dev would still need the TS
  twin.
- `run-turn.ts`, `turn-step.ts`, `retry.ts`: keep the loop in TS; only their
  sub-computations (token counts, compaction plan, cache plan) move.
- `moa/*` (orchestration), `usage/*` (tracker), `curator/*`, `event-hooks/*`,
  `goals/*`, `plugins/*`, `cron/scheduler.ts`+`store.ts`, `checkpoints/*`,
  `session-search-recall/tool.ts`, `memory/*`, `session/*`, `personality/*`,
  `reasoning/extract.ts`, `tool-args-parse.ts`, `skills/registry|hub|stacking|commands`.
- Any UI-facing state (Jotai stores in `web/src/stores/`) and storage glue.

## 4. Current contract (TS exports, types, consumers, invariants)

### 4.1 Token counting

- `packages/agent-tools/src/token-estimate.ts` exports:
  `countTokens(text): Promise<number>`, `estimateToolTokens(def)`,
  `estimateToolSetTokens(defs)`, `estimateToolSetTokensSync(defs)`.
  Uses `getEncoding("cl100k_base")` from `js-tiktoken` (dep in
  `packages/agent-tools/package.json`), falls back to `chars/4`.
- Consumers: `packages/agent-tools/src/index.ts` re-export;
  `web/src/lib/tools/tool-search/*` (via `estimateToolSetTokensSync` for the checklist
  status line); heuristic twins in `agent-core/src/compaction/compress.ts`
  (`estimateTokens`), `web/src/lib/context-references/resolve.ts`
  (`estimateTokensRough`), `web/src/lib/context-usage/formatter.ts` (imports
  `estimateTokens` + `estimateMessagesTokens` from agent-core), and
  `web/src/lib/slash-commands/handlers/compress.ts` (imports `estimateMessagesTokens`).
- Invariant: `countTokens` returns a Promise (WASM is async-ish); UI sync path uses
  `estimateToolSetTokensSync` heuristic. Native path can be sync in Rust but must
  still expose a promise-shaped TS wrapper.

### 4.2 Compaction

- `packages/agent-core/src/compaction/index.ts` re-exports `compress.ts`,
  `prompt-cache.ts`, `cache-control.ts`, `types.ts`.
- Key exports: `estimateTokens`, `estimateMessageTokens`, `estimateMessagesTokens`,
  `shouldCompress`, `resolveCompactionConfig`, `compressSessionContext`,
  `buildPromptCachePlan`, `applyCacheControl`, `planAndApplyCacheControl`,
  `buildCacheKey`, `createStablePrefixRegistry`.
- Consumers: `run-turn.ts` (pre-turn compaction: `estimateMessagesTokens` +
  `compressSessionContext`), `turn-step.ts` (`planAndApplyCacheControl` on every
  step), `runtime/index.ts` → `runTurn`, `web/src/lib/slash-commands/handlers/compress.ts`
  (manual `/compress`), `web/src/lib/context-usage/formatter.ts` (token estimates),
  `web/src/components/chat/*` via slash handlers.
- Invariants: tool_call/tool_result pairs stay intact; protect-first-N / protect-last-N
  non-system messages; Anthropic ≤4 breakpoints; canonical `messages`/`tools` arrays
  are never mutated (shallow copies); `CompactionResult.status` ∈
  `noop | compacted | fallback | aborted`; `compression_summary` messages carry
  `origin.kind === "compaction_summary"`.

### 4.3 SKILL.md parsing

- `packages/agent-core/src/skills/loader.ts`: `parseFrontmatter(text)` →
  `{ metadata, body }`, `validateSkillMetadata(metadata)` →
  `{ metadata, warnings }`, `loadSkillFromContent`, `loadSkillPack` (uses injected
  `SkillFs` abstraction for I/O), `skillLevelGte`.
- `packages/skill-lint/src/frontmatter.ts` has its own `parseFrontmatter` (different
  shape) used by `skill-lint/src/lint.ts`.
- Consumers: `web/src/lib/skills/service.ts` (`loadSkillPack`), skills hub panel,
  `pnpm skills:lint` CLI.
- Invariants: name ≤64 chars, description ≤1024 chars (truncate + warn); `platforms`,
  `prerequisites`, `tags` as string arrays; missing name/description → warnings, not
  throws.

### 4.4 Cron

- `packages/agent-core/src/cron/schedule.ts`: `parseCronExpression(expr)` →
  `{ valid, normalized, nextAfter(after) }`, `nextRunTime(expr, after)`.
  Supports `@every Nm`, `@hourly`, `@daily`, classic 5-field (stub: +60s).
- Consumers: `cron/scheduler.ts` (job next-run), `web/src/lib/slash-commands/handlers/automation.ts`
  (validity check at line ~175).
- Invariant: `valid:false` for unknown expressions; `nextAfter` returns `number | undefined`.

### 4.5 Learning graph

- `packages/agent-core/src/learning/graph.ts`: `buildMemoryGraph(opts)` →
  `Promise<MemoryGraph>` where `opts` = `{ memoryStore, sessionStore,
  maxEdgesPerNode?, minEdgeScore? }`.
- Consumers: `learning/index.ts` re-export; `web/src/lib/slash-commands/handlers/learning.ts`,
  `web/src/components/chat/learning-journey-panel.tsx`.
- Invariant: ids `memory:{scope}:{i}` / `session:{id}`; edges capped at
  `maxEdgesPerNode` per source; weight `score.toFixed(4)`; never throws on store errors
  (empty sessions on failure).

### 4.6 Approval (conditional)

- `packages/agent-core/src/approval/policy.ts`: `DangerLevelPolicy`, `ToolsetPolicy`,
  `ToolNamePolicy`, `YoloPolicy`, `SmartPolicy`, `CompositePolicy`,
  `buildDefaultApprovalPolicy`, `dangerRank`.
- Consumers: `approval/gate.ts` (evaluates before tool execution),
  `web/src/components/chat/approval-panel.tsx` (renders ask decisions),
  `web/src/lib/slash-commands/handlers/automation.ts`.
- Invariant: deny wins over allow; hardline ≥ threshold; YOLO bypass only after
  user-deny + hardline; first non-undefined policy result wins.

## 5. Rust design (module layout, public API, serde types, state handling)

```
src/
├── tokenize/
│   ├── mod.rs            # pub fn count_tokens_batch(&[String]) -> Vec<usize>
│   │                     # pub fn estimate_tokens_heuristic(&str) -> usize (chars/4 + CJK≈1)
│   │                     # pub fn estimate_message_tokens(&Message) / estimate_messages_tokens
│   └── bpe.rs            # tiktoken-rs wrapper (cl100k_base), cached encoding
├── schema/
│   ├── mod.rs            # shared serde types re-used by agent_core commands
│   ├── message.rs        # serde mirror of agent-core Message / CompactionMessage
│   ├── tokenize.rs       # TokenizeRequest { texts: Vec<String> } / TokenizeResponse { counts }
│   ├── compaction.rs     # CompactionRequest / CompactionPlan / CachePlanRequest / CachePlan
│   ├── skills.rs         # FrontmatterRequest / FrontmatterResult / SkillMetadata / warnings
│   ├── cron.rs           # CronNextRequest { expr, after_ms } / CronNextResponse
│   └── graph.rs          # MemoryGraphRequest { memory_entries, sessions } / MemoryGraph
├── compaction/
│   ├── mod.rs            # plan_compaction(...) -> CompactionPlan (pure, no LLM, no I/O)
│   └── cache_plan.rs     # build_cache_plan(...) -> CachePlan (pure)
├── skills/               # (optional; reuses serde_yaml)
│   └── frontmatter.rs    # parse_frontmatter + validate_metadata
├── cron/                 # (optional; reuses chrono)
│   └── next_run.rs       # next_run_time(expr, after) — real 5-field expansion
├── graph/                # (optional)
│   └── memory_graph.rs   # build_memory_graph(entries, sessions, opts) -> MemoryGraph
└── commands/
    ├── agent_core.rs     # #[tauri::command] fns: agent_core_tokenize,
    │                     # agent_core_compaction_plan, agent_core_cache_plan,
    │                     # agent_core_skills_parse_frontmatter, agent_core_cron_next,
    │                     # agent_core_memory_graph_build, agent_core_approval_evaluate
    └── mod.rs            # add `pub mod agent_core;` + register in main.rs generate_handler!
```

- **Public API**: every `#[tauri::command]` is a pure function taking serde-deserialized
  JSON args and returning `AppResult<serde_json::Value>` (existing `error.rs`
  `AppError`). No new `AppState` fields are needed for the in-scope pure functions;
  the only stateful piece (stable-prefix registry) stays in TS.
- **Serde types** live in `src/schema/` and mirror `@hermes/protocol` Zod schemas
  (fields are the source of truth). Deserialization with `serde_json` provides the
  Zod→serde validation story: malformed args fail at the IPC boundary with a typed
  `AppError`, identical to how `state_db_*` commands validate today.
- **State handling**: none beyond cached `tiktoken-rs` encoding (lazy `OnceLock`).
  `StablePrefixRegistry` remains TS (LRU of prefixes) — TS resolves the matched
  prefix and passes `staticSystemPrefix` / a breakpoint hint into `agent_core_cache_plan`.
- **Message shape**: `CompactionMessage` serializes over IPC as JSON arrays
  (`role`, `content`, `toolCalls`/`tool_calls`, `toolCallId`, `summaryMessage`,
  `timestamp`, …). `src/schema/message.rs` uses `#[serde(rename_all = "camelCase")]`
  with `Option` for every field so both TS and Rust tolerate the sparse shape.
- **No new external crate** is strictly required except `tiktoken-rs` (token counting)
  and optionally `cron` (or hand-roll the 5-field expansion on `chrono`, already a dep).
  `serde_yaml`, `regex`, `chrono` already exist.

## 6. IPC / boundary (Tauri command names + args + returns; browser-only-dev fallback)

Command module: `src/commands/agent_core.rs`, registered in `src/main.rs`
`generate_handler!` (currently lines ~807–905; add alongside `commands::state_db::*`
entries).

| Command | Args (serde JSON) | Returns |
|---|---|---|
| `agent_core_tokenize` | `{ "texts": string[], "mode": "bpe"\|"heuristic" }` | `{ "counts": number[], "fallback": bool }` |
| `agent_core_compaction_plan` | `{ "messages": CompactionMessage[], "config": CompactionConfig, "modelName"?: string, "overrides"?: Record<string, Partial<CompactionConfig>> }` | `{ "status": "noop"\|"compressible", "beforeTokens", "thresholdTokens", "range"?: {start,end}, "compactSliceTokens", "budgetTokens" }` |
| `agent_core_cache_plan` | `{ "messages": Message[], "tools"?: Tool[], "provider": string, "cacheTtl"?: "5m"\|"1h", "staticSystemPrefix"?: string }` | `{ "messageBreakpoints": number[], "toolBreakpoints": number[], "breakpointCount": number, "ttlMs": number }` |
| `agent_core_skills_parse_frontmatter` | `{ "content": string }` | `{ "metadata": SkillMetadata, "body": string, "warnings": string[] }` |
| `agent_core_cron_next` | `{ "expr": string, "afterMs": number }` | `{ "valid": bool, "normalized": string, "nextAfterMs"?: number }` |
| `agent_core_memory_graph_build` | `{ "memoryEntries": [{id,content,importance,scope}], "sessions": [{id,title,preview,source,startedAt,messageCount,toolCallCount}], "maxEdgesPerNode"?, "minEdgeScore"? }` | `{ "nodes": [...], "edges": [...], "stats": {...} }` |
| `agent_core_approval_evaluate` (conditional) | `{ "request": ApprovalRequest, "policy": {...} }` | `{ "decision": "approve"\|"ask"\|"deny"\|"none", "reason"?: string }` |

**Bridge + fallback (browser-only dev):**

- New `web/src/lib/agent-core-ipc.ts` (or `packages/agent-core/src/ipc.ts`) exposes
  `callNativeAgentCore<T>(name, args, tsFallback: () => T | Promise<T>)`:
  - Tauri/packaged: `window.hermesDesktop?.agentCore?.[name]` exists → invoke and
    return; typed through `web/src/lib/runtime.ts` `HermesStateDbBridge`-style bridge
    interface (`hermesDesktop.agentCore`).
  - Browser-only dev (`python run.py`): bridge is absent → call the existing TS
    implementation directly. This is the same pattern as
    `web/src/lib/session-search/types.ts` (stateDb bridge) and
    `web/src/lib/session-store/sql.ts` (`createTauriSqlAdapter` with memory fallback).
- Each migrated TS module keeps its current implementation as the fallback; a tiny
  wrapper switches on bridge availability. Do **not** delete the TS implementation
  until browser-only dev is explicitly gated (a future decision; plan does not assume it).
- To avoid per-call overhead, batch token counting (`texts: string[]` in one invoke)
  and keep compaction/cache calls to one invoke per turn step.

## 7. Implementation phases (ordered, each shippable + testable)

- **Phase 0 — Shared foundations (S/M)**: add `src/schema/` serde types; add
  `src/tokenize/` (tiktoken-rs + heuristic); add `src/commands/agent_core.rs`
  skeleton + `generate_handler!` registration; add `web/src/lib/agent-core-ipc.ts`
  bridge with TS fallback. Ship nothing user-visible; everything behind the bridge.
- **Phase 1 — Token counting (S)**: move `agent-tools` `countTokens`/estimators to
  `agent_core_tokenize`; make `web/src/lib/tools/tool-search/*` and
  `web/src/lib/context-usage/formatter.ts` use the bridge with the existing heuristic
  as fallback; keep `estimateToolSetTokensSync` as-is for sync UI. Golden-vector
  parity (TS vs Rust cl100k counts) on CJK/emoji/multibyte fixtures.
- **Phase 2 — Compaction + cache planning (M)**: move deterministic compaction
  planning and `buildPromptCachePlan` to `agent_core_compaction_plan` /
  `agent_core_cache_plan`; `run-turn.ts` calls Rust for the plan, then still invokes
  the TS summarizer / event emission; `turn-step.ts` calls Rust for the cache plan,
  applies markers with existing TS `attach*` helpers. Golden-vector parity on
  representative conversation histories (tool-pair boundaries, head/tail protection,
  4-breakpoint budget).
- **Phase 3 — SKILL.md frontmatter/validation (M)**: add `src/skills/frontmatter.rs`
  (serde_yaml); `agent_core_skills_parse_frontmatter`; route
  `packages/agent-core/src/skills/loader.ts` `parseFrontmatter` +
  `validateSkillMetadata` and `packages/skill-lint` through the bridge (TS fallback).
  Keep `loadSkillPack`/`loadSkillFromContent` TS (I/O via injected `SkillFs`).
- **Phase 4 — Cron next-run (S/M)**: add `src/cron/next_run.rs` (proper 5-field
  expansion using `chrono` or a small hand-rolled calculator); `agent_core_cron_next`;
  route `cron/schedule.ts` `nextRunTime`/`parseCronExpression` through the bridge.
  Add fixtures covering the previously stubbed classic-cron cases.
- **Phase 5 (optional) — Learning memory graph (M/L)**: add `src/graph/memory_graph.rs`;
  `agent_core_memory_graph_build`; `learning/graph.ts` collects store data and calls
  Rust, falling back to TS. O(n²) parity tests on synthetic memory/session sets.
- **Phase 6 (optional/conditional) — Approval native gate (L)**: add
  `agent_core_approval_evaluate`; gate tool execution in `turn-step.ts` through Rust
  when available. Only if product accepts the browser-only-dev divergence (TS fallback
  remains for `python run.py`) and the IPC-per-tool-call cost.

Each phase is independently shippable: it lands behind the bridge, defaults to TS when
Rust is absent, and keeps `pnpm typecheck`, `pnpm test:unit`, `cargo check` green.

## 8. Testing strategy (Rust unit/integration; TS↔Rust parity via golden vectors; vitest parity tests)

- **Rust unit tests**: `#[cfg(test)]` inline per module (AGENTS.md convention) for
  `tokenize`, `compaction`, `cache_plan`, `frontmatter`, `next_run`, `memory_graph` —
  all pure functions, no env deps.
- **Rust integration tests** (`tests/`, crate `hermes_agent_cn`): `tests/agent_core_parity.rs`
  and `tests/agent_core_fixtures.rs` read checked-in golden JSON from
  `tests/fixtures/agent_core/*.json` and assert Rust outputs match. No HTTP (no
  wiremock needed for pure logic); `tempfile::TempDir` only if a phase adds FS-backed
  tests (not expected).
- **Golden vectors**: one shared fixture dir (e.g. `tests/fixtures/agent_core/` plus a
  mirror `packages/agent-core/src/__fixtures__/` or referenced from `web/src/lib/`):
  1. token counts (ASCII/CJK/emoji/JSON tool schemas) — generated once from current TS
     `js-tiktoken` output, checked in;
  2. compaction plans (≥20 histories incl. tool-pair straddling range edges, empty
     slices, system-only, large tail);
  3. cache plans (Anthropic/OpenAI/OpenRouter, ≤4 breakpoints, empty system prefix);
  4. frontmatter fixtures (quotes, inline lists, missing fields, truncation warnings);
  5. cron expressions (`@every`, `@hourly`, `@daily`, 5-field common patterns);
  6. memory-graph fixtures (small synthetic memory/session sets).
- **Vitest parity tests**: existing TS suites keep running against the TS fallback so
  browser-only dev is always covered. Add a small vitest suite (`agent-core-ipc.test.ts`)
  that runs the same golden fixtures through the TS implementation and asserts the TS
  fallback still matches; a CI step (`cargo test --test agent_core_parity` +
  `pnpm test:unit`) proves both sides agree on the same vectors.
- **Drift guard**: add a script `scripts/generate-agent-core-fixtures.mjs` (or a vitest
  `--update` mode) that regenerates golden JSON from the TS implementation; CI fails if
  fixtures drift from TS without an intentional update. Once Rust is source of truth
  for a module, flip the generator to assert both directions.
- **Browser-only dev**: `pnpm test:unit` (which has no Rust) is the fallback gate; add
  an explicit test that `callNativeAgentCore` with a missing bridge resolves through
  the TS fallback.

## 9. Risks & mitigations

1. **Dual-implementation drift (highest)** — TS fallback and Rust diverge.
   Mitigate: single shared golden-vector dir; both CI lanes consume it; move modules to
   Rust source-of-truth only after parity is green; keep TS as the fallback contract.
2. **IPC serialization cost** — shipping full `messages` arrays over IPC each turn can
   negate the CPU win on very large contexts. Mitigate: measure with a
   `web/src/lib/context-usage/` benchmark before Phase 2 ships; batch token counts;
   if serialization dominates, scope compaction planning to a smaller envelope (e.g.
   pre-trimmed candidate slice) or accept the win as "off the JS thread" rather than
   "total time".
3. **tiktoken-rs dependency weight/build** — new Cargo dep; BPE vocab files add binary
   size; version skew vs js-tiktoken cl100k_base. Mitigate: golden-vector parity across
   CJK/emoji/multibyte; keep the heuristic fallback; verify `pnpm tauri:build` size and
   Windows toolchain before committing.
4. **Browser-only dev regression** — new Rust paths must not break `python run.py`.
   Mitigate: bridge-absence fallback is the default; vitest runs with no Rust; gate any
   future "Rust-required" mode explicitly.
5. **serde_yaml vs hand-rolled frontmatter differences** — YAML edge cases (lists,
   quotes, comments) behave differently. Mitigate: define the Rust parser as the
   intended contract; golden fixtures encode every currently supported shape; keep TS
   fallback behavior documented as legacy until lint parity passes.
6. **Cron stub → full expansion changes semantics** — `nextRunTime` behavior changes
   for classic cron (previously always +60s). Mitigate: treat as a deliberate feature
   fix; add fixtures for each 5-field pattern; check `cron/scheduler.ts` and
   `automation.ts` consumers for assumptions.
7. **Approval native-gate scope creep** — moving evaluation without moving enforcement
   yields no security value and adds IPC. Mitigate: keep Phase 6 conditional; do not
   start until product confirms a native gate requirement.
8. **Webview bridge surface growth** — adding `hermesDesktop.agentCore` methods needs
   capability/permission review. Mitigate: follow the `stateDb` bridge pattern
   (`web/src/lib/runtime.ts`, `web/src/lib/session-search/types.ts`); keep the bridge
   narrow (7 commands max) and typed.

## 10. Effort estimate (S/M/L per phase)

| Phase | Scope | Effort |
|---|---|---|
| 0 | `src/schema/` + `src/tokenize/` + command skeleton + bridge | M |
| 1 | Token counting migration | S |
| 2 | Compaction + cache-plan planning | M |
| 3 | SKILL.md frontmatter/validation | M |
| 4 | Cron next-run (real 5-field) | S |
| 5 | Learning memory graph (optional) | M |
| 6 | Approval native gate (optional/conditional) | L |

Total recommended (Phases 0–4): ~1–1.5 engineer-weeks including tests. With
Phase 5: +2–3 days. Phase 6 alone is a separate project.
