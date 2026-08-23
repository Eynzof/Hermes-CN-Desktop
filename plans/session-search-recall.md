# Session Search & Recall — Python → TypeScript Rewrite Plan

## 1. Summary

Hermes-CN-Core recalls past conversations through three surfaces: the
`session_search` agent tool (`tools/session_search_tool.py`, single tool with
DISCOVER / SCROLL / READ / BROWSE shapes), the `hermes sessions` CLI
(`hermes_cli/sessions_cmd.py`), and the Dashboard REST endpoint
`GET /api/sessions/search` that the desktop History UI consumes. This plan
covers the **tool + LLM-summarized recall layer**: the tool response contract
(bookends, anchored window, `@session:` links), the ranking policy (hidden /
demoted sources, compression-lineage dedup, recency bias), the `hermes
sessions` CLI surface as it maps to the desktop, and a **new cross-session
recall summarizer** that condenses several discovered sessions into an
LLM-generated recap.

Storage is deliberately **out of scope here**: `sqlite-fts5-session-search.md`
already owns the SQLite/FTS5 persistence, CJK-bigram tokenizer, query routing,
and Rust `state_db` commands. This plan imports those as primitives and adds
what they do not cover (ranking polish, tool shapes, recap prompt, UI wiring).

Key design decisions:
1. Keep the frozen wire contracts (`SearchResult`/`SearchResponse` Zod
   schemas in `packages/protocol/src/hermes-api.ts`, and the tool's JSON
   shapes from `SESSION_SEARCH_SCHEMA`) byte-compatible; the in-process engine
   implements the same interface behind the same hook the UI already calls.
2. Port ranking as a pure TS module (`ranking.ts`) modeled on kimi-code's
   `compareRows`/`RowTopK` (score + time + key ordering) — evidence that a TS
   ranking layer exists and is production-tested, even though kimi-code's
   storage engine (minidb KV) differs from SQLite FTS5.
3. The LLM-summarized cross-session recall is **net-new**: today the Python
   tool is explicitly zero-LLM (`session_search_tool.py` docstring) and
   `session_recap.py` is deterministic. Design it as a layered stack —
   deterministic `buildRecap` port first, then an optional LLM
   `RecallSummarizer` behind a feature flag with a TTL'd cache, using
   kimi-code's compaction summarizer (`agent/compaction/full.ts`) and Python's
   `agent/title_generator.py` as the LLM-call/prompt patterns.
4. `hermes sessions` interactive actions (list/browse/delete/rename/archive/
   stats) map onto the existing desktop History route; pure maintenance
   actions (repair/recover/optimize/optimize-storage/clean-markers/
   repair-routing) are marked out of scope for desktop standalone.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn` (paths repo-relative).

### 2.1 Agent tool — `tools/session_search_tool.py` (1161 lines)
- `session_search(query, role_filter, limit, session_id, around_message_id,
  window, sort, profile)` — mode inferred from args, no explicit mode:
  - DISCOVERY (`query`): `db.search_messages` (FTS5, `_DISCOVER_SCAN_LIMIT =
    300`), then `_order_for_recall` (cron demotion #19434), lineage dedup
    (`_resolve_to_parent` / `_resolve_lineage`), title-match
    (`_title_match_result`), and per-hit `get_anchored_view(window=5,
    bookend=3)` with compaction-summary bookend filtering (#43175) and content
    caps (bookend ≤1200 chars, window ≤4000 chars, #69334).
  - SCROLL (`session_id` + `around_message_id`): `get_messages_around`, window
    clamp [1,20], current-lineage guard, lineage rebind.
  - READ (`session_id` only): whole session dump, head 20 + tail 10 when large.
  - BROWSE (no args): `list_sessions_rich(order_by_last_active=True)`.
- Constants: `_HIDDEN_SESSION_SOURCES = ("kanban","subagent","tool")`,
  `_DEMOTED_SESSION_SOURCES = ("cron",)`, `_COMPACTION_PREFIXES`.
- Helpers: `_shape_message` (ANSI strip, truncation metadata, anchor flag),
  `_session_link` (`@session:<profile>/<id>`), `_resolve_profile_db` /
  `_locate_session_db` (cross-profile read-only), `_annotate_rebuild_status`
  (FTS rebuild progress in payload).
- `SESSION_SEARCH_SCHEMA` + `registry.register(name="session_search",
  toolset="session_search", handler=..., check_fn=...)`.

### 2.2 Search primitives — `hermes_state_search.py` (mixin, ~2.5k lines)
- `SessionSearchMixin.search_messages(...)` — FTS5/CJK/trigram/LIKE routing +
  `snippet()`; full detail owned by `sqlite-fts5-session-search.md`.
- `get_anchored_view(session_id, anchor_id, window=5, bookend=3)` (line ~975) —
  ±window around anchor + bookend_start/bookend_end; used by every discovery hit.
- `list_recent_user_messages(session_id, limit)` (line ~1097) — filters legacy
  compaction handoffs (display_kind / `[CONTEXT COMPACTION` prefixes) — the
  basis for the recap "Last ask" line.
- Maintenance: `fts_rebuild_status/step`, `optimize_fts_storage`, etc.

### 2.3 CLI — `hermes_cli/sessions_cmd.py` (1232 lines)
- `cmd_sessions(args, sessions_parser)` dispatches on `args.sessions_action`:
  `repair`, `recover`, `list`, `export`, `delete`, `archive`, `prune`,
  `rename`, `retitle-skills`, `browse`, `optimize`, `clean-markers`,
  `optimize-storage`, `repair-routing`, `stats`.
- `list` renders a title/preview/workspace/last-active table from
  `list_sessions_rich`; `browse` opens an interactive picker then relaunches
  `hermes --resume <id>`; `stats` prints counts by source.

### 2.4 Deterministic recap — `hermes_cli/session_recap.py` (322 lines)
- `build_recap(messages, session_title, session_id, platform)` — pure local,
  zero LLM: recent 20-turn window, user/assistant/tool counts, top tool
  counts, recently-edited files (from `_FILE_EDIT_TOOLS`), "Last ask" /
  "Last reply" one-liners, `sanitize_display_text` for untrusted history.

### 2.5 REST endpoint — `hermes_cli/web_routers/sessions.py`
- `search_sessions(q, limit, profile, source, sources, exclude_sources)`
  (line 169): ID matches first (`search_sessions_by_id`), then
  auto-prefix-wildcarded FTS content matches; both deduped by compression
  lineage root (`compression_root` / `lineage_tip`); response
  `{results:[{session_id, snippet, role, source, model, session_started,
  id, title, started_at, ...}]}`; limit clamp 1..100.

### 2.6 Docs
- `website/docs/user-guide/features/memory.md` §Session Search — state.db +
  FTS5, "~20ms FTS5 query, ~1ms scroll", **no LLM calls**.
- `website/docs/reference/tools-reference.md` — `session_search` toolset row.

### 2.7 Tests (parity sources)
- `tests/tools/test_session_search.py` (825 lines) — schema invariants,
  browse/discover/scroll/read shapes, sort, scroll loop, shape precedence,
  links, cross-profile, cron demotion, compaction filtering, compression-
  aware discovery, rewind exclusion.
- `tests/hermes_cli/test_web_server_session_search.py` — ID-match-first +
  lineage merge for the desktop endpoint.
- `tests/test_list_recent_user_messages_handoffs.py` — handoff filtering.
- `tests/hermes_cli/test_session_recap.py` — `build_recap` golden tests.

## 3. Target TypeScript design

End state: no Python backend. `state.db` + FTS5 live behind Rust IPC (from the
FTS plan); TypeScript owns the tool contract, ranking, and the LLM recall
layer; the UI and the in-process agent call one `SessionSearchEngine`.

### 3.1 Module layout (new files; the FTS plan owns `web/src/lib/session-search/`)
- `packages/protocol/src/session-search.ts` — extend (don't duplicate)
  `SearchResult`/`SearchResponse` in `hermes-api.ts`; add
  `SessionSearchToolResult` (discover/scroll/read/browse shapes with
  `bookend_start/messages/bookend_end/link/match_message_id`),
  `SessionSearchRequest`, `RecallRequest`, `RecallResponse`.
- `web/src/lib/session-recall/engine.ts` — `SessionSearchEngine`:
  `discover(query, opts)`, `scroll(sessionId, aroundMessageId, window)`,
  `readSession(sessionId)`, `browse()`, `resolveSessionLink(value)`. Thin
  orchestration over the FTS-plan `engine.ts` primitives (searchMessages,
  getAnchoredView, getMessagesAround, listSessionsRich, lineage).
- `web/src/lib/session-recall/ranking.ts` — pure ranking policy:
  `demoteAutomation(rows)` (cron demotion), `dedupeByLineage(rows, db)`,
  `applyTemporalBias(rows, sort)` (`newest`/`oldest`), final
  `compareRecallRows` (score, time, key) modeled on kimi-code `compareRows`.
- `web/src/lib/session-recall/recap.ts` — port of `build_recap`
  (`_recent_window`, `_summarise_tool_activity`, `_truncate` with
  `sanitize_display_text`-equivalent).
- `web/src/lib/session-recall/recall-summarizer.ts` — LLM layer:
  `RecallSummarizer.summarize({query, hits})` → structured cross-session recap
  (per-session one-liner + cross-session themes + open threads); prompt
  builder `buildRecallPrompt`; TTL cache `RecallCache`.
- `web/src/lib/session-recall/links.ts` — `@session:<profile>/<id>` builder /
  parser, reusing `web/src/lib/composer-mentions.ts` token grammar.
- `web/src/hooks/use-recall.ts` — `useRecall(query)`, `useSessionRecap(id)`,
  `useRecallSummarize(results)` React Query hooks.
- `web/src/routes/history.tsx` — wire the search box to engine-backed search +
  optional "AI 回顾" (recall summary) panel.

### 3.2 Data flow (in-process, no backend)
```
history.tsx search box / agent tool call
  → useRecall(query) → SessionSearchEngine.discover
      → ranking.ts (demote cron → dedupe lineage → temporal bias)
      → session-search engine (Rust IPC → state.db FTS5)   [from FTS plan]
  → SearchResponse (frozen schema) → results list
  → (optional) RecallSummarizer.summarize({query, hits})
      → buildRecallPrompt(hits' bookends+windows) → model client
      → RecallResponse → recall panel / agent context
```

### 3.3 CLI mapping
- Interactive `hermes sessions list/browse/rename/delete/archive/stats`
  are covered by the existing History route (`history.tsx`) and its
  mutations; `browse`'s "resume" maps to the desktop's existing
  session-resume action (`useGateway().resumeSession`).
- Maintenance actions (repair/recover/optimize/optimize-storage/
  clean-markers/repair-routing) are **out of scope for desktop standalone**
  (recorded here as a port decision; Rust owns DB integrity via the FTS-plan
  `state_db` commands).

## 4. Data models & persistence

- All session/message/FTS storage: owned by `sqlite-fts5-session-search.md`
  (schema v25, `messages_fts`/`messages_fts_cjk`/`messages_fts_trigram`,
  WAL, deferred rebuild). Nothing new added here except the recall cache.
- New optional table `recall_cache` (in the same `state.db`, Rust-side):
  `(profile, query_fingerprint, lineage_fingerprint, summary, model,
  created_at, ttl_s)` — avoids re-paying LLM tokens for repeat queries.
  Alternative lighter option: in-memory `RecallCache` keyed by
  `sha256(profile|query|lineageHashes)` with TTL; persisted cache is a P3
  decision.
- Deterministic `buildRecap` output needs **no storage** (computed from
  messages on demand, like Python).
- New Zod schemas (frozen): `RecallRequest {query, limit?, mode?}`,
  `RecallResponse {query, sessions:[{session_id, title, summary,
  themes?, open_threads?}], generated_at, model?}` — this is a NEW contract
  with no Python precedent; freeze it before the LLM layer ships.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / decision |
|---|---|---|
| stdlib `sqlite3` / FTS5 (`hermes_state_search.py`) | Rust `rusqlite` via Tauri IPC (`src/state_db.rs`) | See `sqlite-fts5-session-search.md` §5; kimi-code has NO SQLite binding (uses minidb KV) — Rust rusqlite (already in `Cargo.toml`, `src/ui_store.rs`) is the in-repo precedent. |
| FTS5 BM25 `rank` + `snippet()` | kept in SQL (FTS5 through rusqlite) | Same engine; ranking post-processing in TS (`ranking.ts`) because kimi-code proves the TS-side ordering pattern, not a TS BM25. |
| `orjson` | `JSON.stringify` / structured-clone | Trivial. |
| `re` sanitizers (`_sanitize_fts5_query`, `_normalize_title_query`) | TS RegExp port | kimi-code `minidb` quotes every term (no grammar sanitizer) — straight port, parity-tested. |
| `datetime.strftime` (`_format_timestamp`) | `Intl.DateTimeFormat` / existing `web/src/lib/format.ts` (`relativeTime`, `dayLabel`) | Desktop already has the formatters (`history.tsx` imports). |
| `collections.Counter` (`session_recap.py`) | `Map<string, number>` reduce | Trivial. |
| LLM call for title upgrade (`agent/title_generator.py`) / compaction summary (`agent/context_compressor.py`) | in-process model client (agent runtime) or, during migration, backend LLM proxy | kimi-code evidence: `packages/agent-core/src/agent/compaction/full.ts` — full summarizer request lifecycle (trace, input trimming, failure handling). Desktop today has provider catalog (`web/src/lib/provider-catalog.ts`) but no in-process chat-completions client — the recall summarizer initially calls the managed Python runtime, then swaps to the in-process model client when the agent runtime migrates. |
| deterministic recap (`session_recap.py`) | `web/src/lib/session-recall/recap.ts` | No npm lib needed; port + golden tests. |
| kimi-code `@moonshot-ai/minidb` text-index / `kap-server/src/search/*` | **Reference only, do not adopt as storage** | `tokenize.ts` (CJK uni/bigram) is the algorithm source for the FTS plan; `match.ts` (`compareRows`, `RowTopK`, keyset pagination, query budgets) is the design model for `ranking.ts`; `searchService.ts` shows a worker-isolated, generation-token-pinned index — worth mimicking for the recall-cache invalidation. kimi-code's `session-store.ts` is file-based, not SQLite — do not port. |

### 5.1 "No TS equivalent found" risks
1. **LLM-summarized cross-session recall has NO Python implementation and NO
   kimi-code equivalent** (kimi-code only summarizes within a session at
   compaction time, not across search hits). The prompt (`buildRecallPrompt`)
   and the response schema are designed from scratch. Risk: quality,
   latency, token cost, prompt-injection via recalled content. Mitigations:
   deterministic `buildRecap` first, LLM layer behind a flag, TTL cache,
   content caps (reuse 1200/4000-char caps), and sanitize recalled text
   before it enters the prompt.
2. **No TS BM25 equivalent.** kimi-code ranks with TF-IDF in its own
   inverted index; there is no TS port of SQLite FTS5's BM25 `rank`. The
   plan keeps BM25 in SQL and re-implements only the *policy* layer
   (source demotion, lineage dedup, recency bias) in TS — parity must be
   asserted against `tests/tools/test_session_search.py`, not against exact
   rank floats.
3. **Session-link grammar**: `web/src/lib/composer-mentions.ts` exists
   (verified), but its tokenizer must be checked to accept the exact
   `@session:<profile>/<id>` format the Python `_session_link` emits
   (profile segment optional; ids never contain `/`). If it only handles
   bare ids, extend it — small but a compatibility trap for the mention
   feature.

## 6. Integration with existing Hermes-CN-Desktop frontend

- `packages/protocol/src/hermes-api.ts` — `SearchResult`/`SearchResponse`
  (lines 415–432) already frozen; extend with tool/recall schemas in a new
  `packages/protocol/src/session-search.ts`.
- `web/src/hooks/use-sessions.ts` — `useSessionSearch(q)` (line 193) already
  calls `/api/sessions/search?q=...&limit=20` via `fetchJSON` and
  invalidates `["sessions-search", ...]` on delete/archive (lines 297–406).
  Migration: point its `queryFn` at `SessionSearchEngine` behind an
  `ENGINE_ENABLED` flag; add `useRecall`/`useSessionRecap` in `use-recall.ts`.
- `web/src/routes/history.tsx` — today the search box does **client-side**
  filtering over `scopedSessions` (title/preview/id substring, lines 331–383,
  input at line 700). Adopt engine-backed `useSessionSearch` so message
  content is searchable, then re-apply the existing archive/status/source
  filters as TS post-filters; add the recall panel beside the results.
- `web/src/lib/transport.ts` — `fetchJSON` routes through the Rust
  `external_request` proxy today (line 258 comment); during migration the
  engine path bypasses HTTP entirely and uses `tauri-bridge.ts` IPC.
- `web/src/lib/gateway-client.ts` — WS JSON-RPC has **no search methods**
  (verified: no search/sessions matches); search is REST-only today, so the
  WS-removal story for this feature is trivial (freeze REST, swap to engine).
- `web/src/lib/composer-mentions.ts` — `@session:` mention rendering reuses
  existing token parsing; `links.ts` must emit the same format.
- Rust: FTS-plan `src/state_db.rs` commands provide search/read primitives;
  optionally add `state_db_recall_cache` read/write commands. Register in
  `src/main.rs` `generate_handler!` alongside existing commands.

## 7. Removing the WebSocket dependency (migration path)

Search is REST-only (no WS), but it depends on the managed Python runtime
being alive. Recall summarization initially also depends on Python (LLM call).

1. **Keep backend call (current)**: `useSessionSearch` hits
   `/api/sessions/search` through `transport.ts`; recall summarizer (if
   enabled) calls a backend LLM proxy endpoint.
2. **In-process engine behind same interface (new)**: `SessionSearchEngine`
   implements `search(query, filters) => SearchResponse` exactly; swap
   `useSessionSearch`'s `queryFn` behind `ENGINE_ENABLED`; engine opens the
   same `state.db` read-only (correct even before writes migrate). Freeze
   `SearchResponse` + tool JSON + `/api/sessions/search` params
   (`q, limit, source, sources, exclude_sources, profile`) here.
3. **Write-path parity**: agent-loop session/message writes land in the
   in-process `state.db` (FTS plan P3) — search and deterministic recaps then
   need no backend at all.
4. **Recall layer swap**: `RecallSummarizer` moves from the backend LLM proxy
   to the in-process model client (the larger agent-runtime effort); cache
   makes this transparent.
5. **Decommission**: drop the `/api/sessions/search` fetch + Rust proxy
   filter; keep REST as read-only fallback for un-migrated profiles; delete
   after N releases.

## 8. Migration phases & task breakdown

- **P0 — Contract + ranking port (TS, test-only)**: `packages/protocol/
  src/session-search.ts`; `ranking.ts` (demote/dedupe/temporal-bias +
  `compareRecallRows`); `links.ts`; vitest parity vs `test_session_search.py`
  ranking fixtures (cron demotion, lineage dedup, current-session exclusion).
- **P1 — Tool engine**: `engine.ts` discover/scroll/read/browse over the FTS
  plan's primitives; response shapes match `SESSION_SEARCH_SCHEMA`; parity vs
  discover bookends/window caps, scroll clamp/rebind, read head/tail.
- **P2 — Deterministic recap**: port `recap.ts` (buildRecap) + hooks; parity
  vs `test_session_recap.py` and `test_list_recent_user_messages_handoffs.py`
  (handoff filtering for "Last ask").
- **P3 — LLM recall layer (flag-gated)**: `recall-summarizer.ts` +
  `buildRecallPrompt` + `RecallCache`; backend LLM proxy first, in-process
  model client later; prompt/schema tests with a mocked model client.
- **P4 — UI integration**: history.tsx search box → engine search +
  post-filters; recall panel; `@session:` link rendering verified.
- **P5 — Decommission**: remove REST search path + proxy filter; keep
  fallback; delete after N releases.

## 9. Risks & open questions

- **Net-new LLM recall**: no Python behavior to port, no kimi-code
  cross-session recap to copy — prompt quality, latency, and cost are the
  top unknowns; deterministic-first + flag + TTL cache mitigates.
- **Ranking parity**: BM25 rank lives in SQL; `ranking.ts` only reorders.
  Verify hit-set parity (not exact order/score) against Python fixtures;
  cron-demotion and compaction-bookend filtering are the regression-prone
  parts (#19434, #43175, #69334).
- **state.db ownership**: engine reads the same DB Python writes during
  migration — WAL + read-only mode + busy_timeout must be proven (FTS plan
  §9) before P1.
- **Profile isolation**: `@session:<profile>/<id>` and `_resolve_profile_db`
  must be replicated in Rust path resolution and `links.ts`.
- **Open**: does desktop standalone ship a fresh `state.db` or import the
  user's existing `~/.hermes/state.db`? Affects P3 cache scope and P5
  fallback.
- **Open**: recall-cache persistence (SQLite table vs in-memory Map) —
  decide in P3 with a TTL policy and cache-invalidation on session
  delete/archive (reuse the existing `["sessions-search"]` invalidation).

## 10. Test strategy

- **vitest unit (parity vs Python)**:
  - Ranking: port fixtures from `tests/tools/test_session_search.py` —
    modpack 3-session dedup, cron demotion (interactive beats 8 cron hits),
    current-lineage exclusion, compression-parent discoverable, rewind rows
    hidden, compaction-summary bookend filtering, content caps.
  - Tool shapes: scroll clamp [1,20], forward-scroll loop, shape precedence
    (scroll > read > discover), read head/tail truncation, `@session:` link
    round-trip, cross-profile resolution.
  - Recap: golden tests vs `tests/hermes_cli/test_session_recap.py`; handoff
    filtering vs `tests/test_list_recent_user_messages_handoffs.py`.
  - Endpoint parity: ID-match-before-content-match + lineage merge vs
    `tests/hermes_cli/test_web_server_session_search.py`.
- **LLM recall**: mocked model client returns fixture summaries; assert
  `buildRecallPrompt` includes bookends/windows with content caps, excludes
  compaction handoffs, and that recalled text is sanitized before prompt
  assembly; cache hit/miss/TTL tests; prompt-injection fixtures (recalled
  content containing instructions).
- **Rust integration**: FTS-plan `state_db` tests cover storage; add
  `recall_cache` CRUD + TTL if persisted.
- **Playwright E2E**: history search box returns the same results as the
  backend baseline, then engine-only mode; recall panel renders and
  re-summarizes on TTL expiry; `@session:` mention in chat renders after
  in-process search.

## 11. Reference links

- Core: `tools/session_search_tool.py`,
  `hermes_state_search.py` (`get_anchored_view` ~975,
  `list_recent_user_messages` ~1097),
  `hermes_cli/sessions_cmd.py`, `hermes_cli/session_recap.py`,
  `hermes_cli/web_routers/sessions.py` (`search_sessions`),
  `agent/title_generator.py`, `agent/context_compressor.py`,
  `website/docs/user-guide/features/memory.md`,
  `website/docs/reference/tools-reference.md`.
- Core tests: `tests/tools/test_session_search.py`,
  `tests/hermes_cli/test_web_server_session_search.py`,
  `tests/test_list_recent_user_messages_handoffs.py`,
  `tests/hermes_cli/test_session_recap.py`.
- kimi-code: `packages/minidb/src/text-index/{index,tokenize}.ts`,
  `packages/kap-server/src/search/{indexCore,searchService,match}.ts`,
  `packages/kap-server/src/routes/search.ts`,
  `packages/agent-core/src/session/store/session-store.ts`,
  `packages/agent-core/src/agent/compaction/full.ts`.
- Desktop: `packages/protocol/src/hermes-api.ts`,
  `web/src/hooks/use-sessions.ts`, `web/src/routes/history.tsx`,
  `web/src/lib/composer-mentions.ts`, `web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts`,
  `plans/sqlite-fts5-session-search.md` (storage/FTS plan this plan builds on).
