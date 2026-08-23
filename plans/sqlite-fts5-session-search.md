# SQLite Persistence with FTS5 Session Search — Python → TypeScript Rewrite Plan

## 1. Summary

Hermes-CN-Core persists every session into a local SQLite database
(`~/.hermes/state.db`) and exposes full-text recall through three surfaces:
the `session_search` agent tool (`tools/session_search_tool.py`, 4 calling
shapes: discover / scroll / read / browse), the `SessionDB.search_messages`
API (FTS5 routing: unicode61 → CJK-bigram → trigram → LIKE fallback), and the
Dashboard REST endpoint `GET /api/sessions/search` that the desktop History UI
consumes. The desktop rewrite must keep one on-disk SQLite store (`state.db`
schema, WAL, FTS5 indexes), move the search planner (query sanitization, CJK
detection, index routing, lineage dedup) into TypeScript, and keep the agent
tool's exact response contract so the `@session:<profile>/<id>` mention
feature keeps working. Key design decision: keep SQLite in Rust via
`rusqlite` (already a dependency for `desktop-ui.sqlite`) exposed over Tauri
IPC, and implement the CJK-bigram tokenizer in TypeScript at write time
(pre-bigrammed FTS column) because SQLite's FTS5 custom C tokenizer
(`native/fts5_cjk/fts5_cjk.c`) has no portable browser/TS equivalent —
kimi-code proves the same uni/bigram algorithm in pure TS
(`packages/minidb/src/text-index/tokenize.ts`).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn` (all paths below repo-relative).

### 2.1 Store layer
- `hermes_state.py` (11.6k lines) — `SessionDB` class, `DEFAULT_DB_PATH =
  get_hermes_home() / "state.db"` (line 337; `_default_db_path` line 367).
  Core row APIs used by search: `create_session`, `append_message`,
  `get_session`, `get_session_rich_row`, `list_sessions_rich`,
  `get_anchored_view` (±window + bookends), `get_compression_tip`,
  `search_sessions_by_id`, `_execute_write` (WAL + write-lock patience),
  runtime FTS corruption self-heal.
- `hermes_sqlite.py` (280 lines) — connection shim: uses `apsw` when
  available, else stdlib `sqlite3`; exposes `connect/Error`, WAL concurrency,
  `backup()`, `interrupt()`.
- `hermes_state_common.py` — `SCHEMA_VERSION = 25`, `FTS_STORAGE_VERSION =
  1`; `FTS_SQL` (`messages_fts`, FTS5 external-content, unicode61, columns
  content/tool_name/tool_calls, content='messages'); `FTS_TRIGRAM_SQL`
  (`messages_fts_trigram_src` view excluding `role='tool'` rows +
  `messages_fts_trigram` with `tokenize='trigram'`); deferred-rebuild
  bookkeeping keys `fts_rebuild_high_water` / `fts_rebuild_progress`;
  `MAX_FTS5_QUERY_CHARS = 2048`.
- `hermes_state_schema.py` — schema DDL, FTS5-availability probe
  (`_sqlite_supports_fts5`), FTS trigger install/migration (incl.
  `AFTER UPDATE OF content, tool_name, tool_calls` narrowing, #73639).
- `hermes_state_portability.py` — profile/state.db relocation helpers
  (sampled, not fully read).

### 2.2 Search layer (`hermes_state_search.py`, 2.5k lines)
`SessionSearchMixin.search_messages(query, source_filter, exclude_sources,
role_filter, limit, offset, sort, include_inactive, fields)`:
1. `_sanitize_fts5_query` — cap 2048 chars, protect balanced quotes, strip
   FTS5-special chars, wrap hyphen/dot terms, preserve `%` only for CJK.
2. Route: non-CJK → `messages_fts MATCH` (BM25, `snippet()`); CJK →
   `messages_fts_cjk` (bigram index, when available and no lone 1-char CJK
   run) → else trigram (needs ≥3 CJK chars/token, no tool rows) → else LIKE
   substring fallback; Latin zero-result retry on cjk/trigram (#54242);
   deferred-rebuild gap supplement `_search_unindexed_gap`.
3. `_finalize_search_matches` — attaches ±1 message context, trims `content`,
   honors `fields` projection.
4. Maintenance: `fts_rebuild_status/step`, `fts_cjk_rebuild_status/step`,
   `optimize_fts_storage`, `rebuild_fts`, `_merge_fts_incrementally`,
   `_try_runtime_fts_rebuild` (corruption self-heal).
5. `search_sessions_by_id` — SQL-bounded id/prefix/substring match incl.
   `_lineage_root_id` compression-tip resolution.

### 2.3 CJK-bigram tokenizer (`native/fts5_cjk/`)
- `fts5_cjk.c` (252 lines): `cjk_unicode61` FTS5 tokenizer wrapping
  unicode61; re-emits maximal CJK runs as overlapping character bigrams
  (Lucene CJKAnalyzer semantics), lone CJK chars as unigrams; registered via
  `sqlite3_ftscjk_init` / `sqlite3_fts5_cjk_init`; built by `build.sh` to
  `~/.hermes/lib/libfts5_cjk.{so,dll}`, overridable by `HERMES_FTS5_CJK_SO`,
  disabled by `sessions.cjk_fts: false`.
- `README.md` — after install, next `SessionDB` open creates
  `messages_fts_cjk` (external-content, tool rows excluded); backfill via
  `hermes sessions optimize-storage`.

### 2.4 Agent tool (`tools/session_search_tool.py`, 1.2k lines)
- `session_search(query=..., role_filter=..., limit=..., session_id=...,
  around_message_id=..., window=..., sort=..., profile=...)` — one tool, mode
  inferred: DISCOVERY (FTS5 + lineage dedup + anchored window ±5 + bookends),
  SCROLL (window around `around_message_id`), READ (whole session), BROWSE
  (recent sessions).
- `_HIDDEN_SESSION_SOURCES = ("kanban","subagent","tool")`,
  `_DEMOTED_SESSION_SOURCES = ("cron",)` (rank demotion, #19434);
  `_DISCOVER_SCAN_LIMIT = 300`; compaction-summary prefix filtering for
  bookends; `@session:<profile>/<id>` link rendering (`_session_link`);
  `SESSION_SEARCH_SCHEMA` + `registry.register(...)`.

### 2.5 REST endpoint
- `hermes_cli/web_routers/sessions.py` — `GET /api/sessions/search?q=&limit=`
  (default 20, clamp 1..100): ID matches first via `search_sessions_by_id`,
  then prefix-wildcarded FTS matches via `search_messages`; both deduped by
  compression lineage (`compression_root` / `lineage_tip`); response shape
  `{results: [{session_id, snippet, role, source, model, session_started,
  id, title, started_at, ...}]}`.
- `hermes_cli/web_server.py` imports `search_sessions` (line 5637) and mounts
  `search_router`.

### 2.6 Docs
- `website/docs/user-guide/features/memory.md` §Session Search: state.db +
  FTS5, "~20ms FTS5 query, ~1ms scroll", no LLM.
- `website/docs/reference/tools-reference.md` — `session_search` toolset row.

## 3. Target TypeScript design

End state: no Python backend for search. `state.db` lives on disk next to the
app data dir; Rust (`src/`) owns the SQLite handle via `rusqlite` and exposes
narrow Tauri commands; TypeScript owns query planning, CJK tokenization,
ranking polish, and the agent-tool response contract.

### 3.1 Module layout (new files under web/src or packages/*)
- `packages/protocol/src/session-search.ts` — Zod schemas frozen from the
  Python/REST contract: `SessionSearchRequest`, `SearchResult`,
  `SearchResponse`, `SessionSearchToolResult` (discover/scroll/read/browse
  shapes with `bookend_start/messages/bookend_end/link`). Extend existing
  `SearchResult` (hermes-api.ts lines 415–432) rather than duplicating.
- `web/src/lib/session-search/` (in-process search engine):
  - `types.ts` — internal `SearchRow`, `CjkRun`, routing result.
  - `fts-query.ts` — port of `_sanitize_fts5_query` + `_compile_like_boolean_query`
    + prefix-wildcard builder used by `/api/sessions/search`.
  - `tokenize.ts` — port of `fts5_cjk.c` CJK classification + bigram
    emission, plus kimi-code's Latin/CJK uni+bigram `tokenize()` contract;
    shared by write path (indexing) and query path.
  - `router.ts` — port of `_search_messages_impl` routing table
    (unicode61 → cjk-bigram → trigram → LIKE) with `_contains_cjk`,
    `_has_lone_cjk_run`, `_trigram_eligible_tokens`.
  - `lineage.ts` — compression-lineage dedup (`compression_root` /
    `lineage_tip`), hidden/demoted source constants, `@session:` link
    builder/parser (reuse `web/src/lib/composer-mentions.ts`).
  - `engine.ts` — `SessionSearchEngine` class: `searchMessages`,
    `searchSessionsById`, `discover`, `scroll`, `readSession`, `browse`,
    `getAnchoredView`, `snippet` formatting; runs in the webview against
    Rust IPC (`tauri-bridge.ts`) or, during migration, against the same
    fetch path as today.
- `src/state_db.rs` (Rust) — Tauri commands behind `AppState`
  (`Mutex<AppStateInner>`): `state_db_query` (read-only SQL), `state_db_exec`
  (write with WAL busy timeout), `state_db_fts_search`,
  `state_db_search_meta` (rebuild status). Follows `src/ui_store.rs`
  (rusqlite `Connection`, `desktop-ui.sqlite`) patterns.
- `src/commands/state_db.rs` — 60-command handler registration alongside
  existing `api_proxy.rs`/`gateway.rs`.

### 3.2 Data flow (in-process, no backend)
```
webview (TS)                                Rust (Tauri IPC)              disk
history.tsx / agent tool
  → SessionSearchEngine.searchMessages
      → fts-query.ts sanitize + router.ts
          → invoke('state_db_fts_search', {sql, params})
              → rusqlite Connection (WAL) → state.db FTS5 tables
  → engine.postProcess (lineage dedup, context, snippet)
  → SearchResponse / SessionSearchToolResult to UI or agent loop
```

### 3.3 CJK bigram strategy in the webview
Because the FTS5 C tokenizer cannot be assumed available in a bundled
Rusqlite webview build (see §5), index CJK text twice:
- `messages_fts` — unicode61 over raw content (non-CJK path, unchanged).
- `messages_fts_cjk` — FTS5 table whose `content` column stores the
  **pre-bigrammed** text produced by `web/src/lib/session-search/tokenize.ts`
  (`cjk_unicode61`-equivalent: insert `\u0001`-joined bigrams inside CJK
  runs), tokenized with stock `unicode61`; query terms are bigrammed the same
  way at query time. This reproduces bigram index-speed substring semantics
  without a loadable C extension.
- `messages_fts_trigram` — stock `tokenize='trigram'`, tool rows excluded via
  a view (same as Python) for the 3+ CJK char / mixed-script path.

## 4. Data models & persistence

### 4.1 Schema (mirror Core v25)
- `schema_version` (25), `sessions` (id PK, source, model, title, started_at,
  ended_at, parent_session_id, archived, ...), `messages` (id INTEGER PK
  AUTOINCREMENT, session_id FK, role, content, tool_name, tool_calls,
  timestamp, active, compacted, observed, ...), `state_meta` (key/value) for
  `fts_rebuild_high_water`, `fts_rebuild_progress`, `fts_storage_version`,
  `fts_stale`, `fts_cjk_stale`.
- FTS virtual tables: `messages_fts` (external-content, unicode61),
  `messages_fts_trigram` + `messages_fts_trigram_src` (view, role<>'tool'),
  `messages_fts_cjk` (external-content over bigrammed column; tool rows
  excluded).
- Triggers: INSERT/DELETE/`UPDATE OF content, tool_name, tool_calls`
  mirroring `FTS_SQL`/`FTS_TRIGRAM_SQL` gated on the rebuild-watermark
  predicate.

### 4.2 Storage strategy
- Rust `rusqlite` with `features=["bundled"]` (already in Cargo.toml line 61)
  opens the same `state.db` layout; `PRAGMA journal_mode=WAL`,
  `busy_timeout`, single-writer `Mutex` per `AppState` to avoid cross-IPC
  contention; `state_meta`-driven deferred rebuild backfill ported from
  `hermes_state_search.py` (chunked `fts_rebuild_step` over `(P, H]`).
- Migration: versioned `schema_version`; FTS layout version
  `fts_storage_version=1`; on mismatch, drop/recreate FTS tables + triggers
  and set rebuild markers (same as Core's `optimize-storage`).

### 4.3 Query semantics to preserve (parity)
- Visibility: `active=1 OR compacted=1` (rewind rows hidden, #38763).
- Sort: `None`=rank, `newest`/`oldest` = timestamp ± rank tiebreaker.
- Fields projection (`id, session_id, role, snippet, timestamp, tool_name,
  source, model, session_started, context`); snippet via SQLite `snippet()`
  (FTS5) or `substr/instr` (LIKE path).
- Search-path logging: keep a TS equivalent of `_describe_search_path` for
  latency attribution.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / decision |
|---|---|---|
| stdlib `sqlite3` / `apsw` (hermes_sqlite.py) | **Rust `rusqlite` (bundled) via Tauri IPC** | Already in Desktop `Cargo.toml` line 61; `src/ui_store.rs` uses it for `desktop-ui.sqlite`. No TS SQLite binding is currently used by kimi-code. |
| SQLite FTS5 (unicode61 + trigram) | SQLite FTS5 through rusqlite | rusqlite bundles SQLite with FTS5. Trigram tokenizer ships with SQLite ≥3.34 — bundled 0.32 is fine. |
| `native/fts5_cjk` C extension (cjk_unicode61) | **No TS/npm equivalent — implement in TS** | kimi-code has NO loadable-extension equivalent; its `packages/minidb/src/text-index/tokenize.ts` implements the same Lucene-style CJK uni+bigram algorithm in pure TS (`const CJK = /[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]+/g` + bigram loop). Port that to `web/src/lib/session-search/tokenize.ts` and pre-bigram text into `messages_fts_cjk`. |
| FTS5 query grammar / BM25 ranking | FTS5 MATCH + `rank` (kept in SQL) | Same SQLite engine; `snippet()` ported verbatim. |
| Python `re` sanitizer | TS RegExp port | `_sanitize_fts5_query` is regex-based; kimi-code uses no equivalent (its text-index search quotes every term), so this is a straight port. |
| Lineage dedup / compression tips (pure Python) | TS module `lineage.ts` | No npm lib needed; port `compression_root`/`lineage_tip` walking `parent_session_id` + `end_reason='compression'`. kimi-code has no compression-lineage search dedup to reference. |
| `orjson` (tool output) | `JSON.stringify` (webview) | Trivial; no lib needed. |
| kimi-code `@moonshot-ai/minidb` custom KV + text-index | **Do NOT adopt for state.db** | kimi-code's SessionStore (`packages/agent-core/src/session/store/session-store.ts`) is file-based; its global search (`packages/kap-server/src/search/indexCore.ts`) uses MiniDb with `TEXT_INDEX_NAME {fields:['text']}` (default uni/bigram tokenizer) + `TRI_INDEX_NAME {tokenizer:'ngram'}` — proof the tokenizer algorithm works in TS, but it is a proprietary KV engine, not SQLite; reusing it would fork the state.db format. Use its tokenizer as algorithm reference only. |
| node_modules check | — | kimi-code has **no** `better-sqlite3`, `sql.js`, `wa-sqlite`, or `@sqlite.org/sqlite-wasm` (verified in root node_modules and package.json grep). So there is no proven-in-kimi-code TS SQLite/FTS5 binding; Rust rusqlite is the strongest in-repo option. |

### 5.1 "No TS equivalent found" risks
1. **FTS5 custom CJK-bigram tokenizer (cjk_unicode61) has no TS/browser
   equivalent.** SQLite FTS5 custom tokenizers are C extensions; loading a
   `.so`/`.dll` from a Tauri webview is possible via rusqlite
   `load_extension` only with `SQLITE_ENABLE_LOAD_EXTENSION` and per-platform
   build artifacts — heavy. Mitigation: pre-bigram tokenization in TS at
   write time into a stock-unicode61 FTS column (same semantics for
   indexing, slightly different highlight offsets; match behavior is
   equivalent for CJK because unicode61 folding is identity on CJK bytes).
   Verify parity with `tests/test_fts_cjk_bigram.py`.
2. **SQLite FTS5 in the webview is not proven in kimi-code** — kimi-code
   avoids SQLite entirely (minidb + fs). Our Rust-rusqlite path is an
   in-repo precedent (ui_store.rs), but the full FTS5 external-content +
   triggers + deferred rebuild pattern is new to the Desktop repo and must be
   covered by Rust integration tests.
3. **Browser-side IndexedDB FTS is a non-starter** for `state.db` parity
   (no FTS5, no snippet(), no BM25 rank in the same dialect); not adopted.

## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/hooks/use-sessions.ts` — `useSessionSearch(q)` (line 193) calls
  `GET /api/sessions/search?q=...&limit=20` via `fetchJSON`; during migration
  this hook is pointed at the in-process `SessionSearchEngine` behind the
  same `SearchResponse` schema; delete/archive mutations (lines 297–406)
  already invalidate the `["sessions-search", ...]` query keys.
- `packages/protocol/src/hermes-api.ts` — `SearchResult`/`SearchResponse`
  (lines 415–432) are the frozen wire contract; extend, don't replace.
- `packages/protocol/src/session-log.ts` — `sessionLogToMessages` remains the
  read fallback for sessions not yet migrated into the in-process store;
  `src/session_log.rs` + `src/session_archive.rs` (Rust) already proxy
  `/api/sessions`, `/api/sessions/search` and archive filtering — the Rust
  `filter_archived_from_response` logic moves into the new `state_db.rs`
  search command (or stays as a post-filter).
- `web/src/routes/history.tsx` — currently does client-side title filtering
  over `scopedSessions`; adopt `useSessionSearch` (server-side FTS) for the
  search box, preserving the existing archive/status/source filters via
  post-filtering in TS.
- `web/src/lib/composer-mentions.ts` — `@session:<profile>/<id>` token
  parsing stays; the in-process `lineage.ts` link builder must emit the same
  format.
- `web/src/lib/transport.ts` + `web/src/lib/tauri-bridge.ts` — new IPC
  commands route through the same `window.hermesDesktop` shim; no new
  transport plumbing.
- Rust: register `state_db.rs` commands in `src/main.rs`
  `generate_handler!`; store path resolution via existing `path_resolver.rs`
  / `HERMES_HOME`.

## 7. Removing the WebSocket dependency (migration path)

Search is REST-only today (no WS), but it depends on the managed Python
runtime being alive. Phases:
1. **Keep backend call** (current): `useSessionSearch` hits
   `/api/sessions/search` through `transport.ts`; nothing changes.
2. **In-process module behind same interface** (new): `SessionSearchEngine`
   implements `search(query, filters) => SearchResponse` exactly matching the
   REST response; `useSessionSearch` swaps its `queryFn` to the engine, with
   a `ENGINE_ENABLED` flag; engine falls back to the REST path when the local
   `state.db` has no rows for a profile yet (cold-start bootstrap).
3. **Write path parity**: session/message writes are mirrored into the
   in-process `state.db` (Rust commands) by the agent loop (which is the
   larger "agent runtime in TS" effort); until then the engine opens the
   same `state.db` read-only that Python writes, so search is correct even
   before writes migrate.
4. **Delete WS/REST path**: drop `/api/sessions/search` fetch + Rust proxy
   filtering for it; freeze `SearchResponse` schema at step 2 (already Zod
   validated). The `session_search` agent tool surface (JSON shapes) is
   frozen by `SESSION_SEARCH_SCHEMA` and must remain byte-compatible.

API surface frozen during migration: `SearchResult`/`SearchResponse` Zod
schemas; `/api/sessions/search` query params (`q, limit, source, sources,
exclude_sources, profile`); `session_search` tool JSON (discover/scroll/read/
browse + `link`).

## 8. Migration phases & task breakdown

- **P0 — Contract & tokenizer port (TS, test-only)**: port
  `_sanitize_fts5_query`, `tokenize.ts` (CJK uni/bigram), routing predicates
  (`_contains_cjk`, `_has_lone_cjk_run`, `_trigram_eligible_tokens`); vitest
  parity vs Python tests.
- **P1 — Rust state.db commands**: `src/state_db.rs` open/WAL/migrations +
  FTS DDL (3 indexes + triggers + deferred-rebuild markers); Tauri commands
  `state_db_fts_search` / `state_db_exec` / `state_db_search_meta`; Rust
  tests mirroring `tests/state/test_fts_runtime_rebuild.py` (corrupt
  `messages_fts_data` → self-heal) and `test_fts_update_of_narrowing.py`
  (UPDATE OF gate).
- **P2 — In-process engine**: `SessionSearchEngine` (searchMessages,
  searchSessionsById, discover/scroll/read/browse, lineage dedup, anchored
  view, context, snippet); wire `useSessionSearch` to engine behind flag.
- **P3 — Write-path mirroring**: agent-loop session/message writes land in
  `state.db` via Rust commands; `messages_fts_cjk` bigram indexing on write
  (TS tokenizer → bigrammed column).
- **P4 — Decommission**: remove `/api/sessions/search` fetch path and Rust
  proxy filter; keep REST as read-only fallback for un-migrated profiles;
  delete after N releases.

## 9. Risks & open questions

- **CJK-bigram FTS5 parity**: pre-bigrammed column + unicode61 vs C
  tokenizer — snippet offsets differ; BM25 ranking differs slightly (bigram
  token counts). Need `test_fts_cjk_bigram.py` parity harness (build real
  corpus, compare hit sets, not exact rank).
- **Bundled SQLite features**: rusqlite `bundled` must include FTS5
  (`SQLITE_ENABLE_FTS5`) — verify feature flags; trigram requires SQLite
  ≥3.34 (bundled 0.32 uses a recent SQLite, confirm in CI).
- **Loadable C extension**: decide explicitly NOT to ship `fts5_cjk` .so/.dll
  for the webview; document `HERMES_FTS5_CJK_SO`/`sessions.cjk_fts` config
  no-ops in desktop standalone.
- **state.db ownership**: Python runtime and the desktop engine may both open
  state.db during migration — WAL + `busy_timeout` + read-only engine mode
  must be proven under concurrent writers (`tests/state/test_write_lock_patience.py`).
- **Profile isolation**: `_resolve_profile_db` / `profiles/<name>/state.db`
  must be replicated in Rust path resolution.
- **Deferred rebuild UX**: `fts_rebuild_status` is surfaced by the Python
  tool payload (`_annotate_rebuild_status`); decide whether the engine
  exposes a "rebuilding" state to the UI or silently supplements via LIKE gap
  scan (port `_search_unindexed_gap`).
- **Open**: does the desktop standalone ship a fresh `state.db` (no Python
  history) or import the user's existing `~/.hermes/state.db`? Affects P3
  write-path and P4 fallback scope.

## 10. Test strategy

- **vitest unit (parity vs Python)**: port fixtures from
  `tests/test_fts_cjk_bigram.py` (Korean 2-char hits, mixed Latin+CJK,
  lone-char LIKE route, config toggle) and `test_fts_update_of_narrowing.py`
  (trigger SQL shape); golden tests for `_sanitize_fts5_query` and routing
  decisions (`_describe_search_path` equivalent).
- **Rust integration (`tests/`)**: `state_db` open/migrate/WAL; FTS5
  availability probe; corruption self-heal (mirror
  `tests/state/test_fts_runtime_rebuild.py`); disk-full / write-lock
  patience (mirror `tests/state/test_disk_full_error.py`,
  `test_write_lock_patience.py`); serial tests where env-dependent.
- **E2E Playwright**: history page search box returns the same results as
  today's `/api/sessions/search` (run against real Core backend for
  baseline, then against engine-only mode); `@session:` mention renders a
  session link after in-process search.
- **API parity**: `tests/hermes_cli/test_web_server_session_search.py`
  (note: `tests/hermes_cli/test_session_search.py` does NOT exist in Core —
  the real file is `test_web_server_session_search.py`; plan its TS
  equivalent: ID-match-before-content-match + lineage merge).

## 11. Reference links

- Core: `hermes_state.py`, `hermes_state_search.py`, `hermes_state_schema.py`,
  `hermes_state_common.py`, `hermes_sqlite.py`,
  `native/fts5_cjk/{fts5_cjk.c,README.md,build.sh}`,
  `tools/session_search_tool.py`,
  `hermes_cli/web_routers/sessions.py` (`search_sessions`),
  `website/docs/user-guide/features/memory.md`,
  `website/docs/reference/tools-reference.md`.
- Core tests: `tests/test_fts_cjk_bigram.py`,
  `tests/test_fts_update_of_narrowing.py`, `tests/state/*` (6 files),
  `tests/hermes_cli/test_web_server_session_search.py`.
- kimi-code: `packages/minidb/src/text-index/{index,tokenize}.ts`,
  `packages/minidb/src/trigram.ts`, `packages/minidb/package.json`,
  `packages/kap-server/src/search/{indexCore,searchService}.ts`,
  `packages/agent-core/src/session/store/session-store.ts`,
  `packages/agent-core/src/services/fileStore/fileStore.ts`,
  `packages/agent-core-v2/src/persistence/backends/minidb/miniDbQueryStore.ts`.
- Desktop: `packages/protocol/src/hermes-api.ts` (SearchResult/SearchResponse),
  `packages/protocol/src/session-log.ts`,
  `web/src/hooks/use-sessions.ts` (useSessionSearch),
  `web/src/routes/history.tsx`, `web/src/lib/composer-mentions.ts`,
  `web/src/lib/transport.ts`, `web/vite.config.ts`,
  `src/session_archive.rs`, `src/session_log.rs`, `src/ui_store.rs`
  (rusqlite precedent), `Cargo.toml` (rusqlite 0.32 bundled).
