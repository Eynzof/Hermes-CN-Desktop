# Plan: Rewrite protocol modules from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/protocol/src/...`
- Target Rust: `src/...`
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

`packages/protocol` is the schema/contract layer consumed by every package and the
web UI (206+ `@hermes/protocol` import sites, plus subpath imports such as
`@hermes/protocol/mcp`). It contains 20 TS source files (~4.1k source lines,
~267 KB `src/`, plus ~3.4k lines of co-located vitest tests). A full read of the
package shows that **~95% of the code is pure Zod schema declarations with no
runtime parsing hot paths** — those must stay in TS because browser-only dev mode
(`python run.py`) runs the identical TS runtime with **no Rust at all**, and the
webview itself must continue to validate with Zod.

The honest scope for a Rust rewrite is therefore narrow and boundary-focused:

1. **Session-log parsing** (`src/session-log.ts`) — the one classic parsing win;
   it is already half-in-Rust (`src/session_log.rs` reads the raw log) and the TS
   transform is currently orphaned (no consumers outside its own test) while the
   UI's `/__hermes_session_log/` fallback and Rust's raw-log response disagree on
   shape — a real correctness/contract-drift bug to fix by consolidating read +
   parse in Rust.
2. **Gateway JSON-RPC event parsing** (`parseGatewayEvent` + `GatewayKnownEvent`)
   — the highest-frequency parsing path in the desktop app (every `/api/ws` frame
   in `web/src/lib/gateway-client.ts`), and the natural place for serde tagged
   enums at the Rust WS relay boundary.
3. **IPC-boundary serde consolidation** — the real, already-existing duplication:
   `src/state_db.rs`, `src/subscription_proxy/mod.rs`, `src/commands/{api_server,
   acp,lsp,mcp,wake_word,observability,egress_proxy,subscription_proxy,state_db}.rs`
   hand-write camelCase serde structs that duplicate `channels.ts` / `session-
   search.ts` / `subscription-proxy.ts` / `acp.ts` / `lsp.ts` / `api-server.ts`.
   These are the highest drift risk and should move into ONE shared `src/schema/`
   home with golden-fixture parity tests.
4. **Already-mirrored schema sets** (state_db/search, subscription-proxy,
   api-server status) — consolidate into `src/schema/` and lock with the same
   fixture harness.

Everything else — the large `hermes-api.ts` schema zoo, `spotify.ts`,
`meet-api.ts`, `wake.ts`, `projects.ts`, `messaging.ts`, `observability.ts`,
`egress-proxy.ts`, `tool-gateway.ts`, `document-extract.ts`, `codex-runtime.ts`,
`mcp.ts`, `acp.ts`/`lsp.ts` (schema halves) — is contract-only, parsed once per
HTTP fetch, and has no native value; rewriting them to serde would duplicate the
whole contract for zero performance gain and break the browser-only dev mode.

**Single-source-of-truth strategy:** Zod stays the contract for the web/browser.
Serde types are added **only at existing Rust boundaries** (IPC commands, api_server
request/response, subscription_proxy, state_db, WS relay, session-log read+parse).
Drift is controlled by **one shared golden-JSON fixture set** that both the vitest
suite and `tests/` Rust integration suite parse and compare, plus a CI parity gate.

## 2. Why rewrite (value/motivation, quantified where possible)

Honest cost accounting first: schema duplication between Zod and serde is a real
maintenance cost, and most protocol schemas parse once per fetch (negligible
perf). The rewrite only pays off where Rust already owns the byte stream or the
same shape is hand-duplicated today.

Verified facts that motivate the rewrite:

- **Session-log transform is orphaned and the route is shape-mismatched.**
  - `packages/protocol/src/session-log.ts` exports `sessionLogToMessages`; a
    repo-wide grep (`packages/`, `web/src/`) finds **zero consumers outside its
    own test**.
  - Rust `src/session_log.rs` (consumed by `src/commands/api_proxy.rs` for
    `/__hermes_session_log/<id>`) returns `{ session_id, raw_log }`, while the UI
    fallback `fetchSessionLogMessages` in `web/src/hooks/use-sessions.ts` parses
    that response with the **`MessagesResponse`** Zod schema (`session_id`,
    `messages`). The shapes disagree, so in the Tauri shell the fallback silently
    yields an empty `messages` list. In browser dev the TS handler
    (`web/src/lib/dashboard-handlers.ts` `sessionLogHandler`) returns a
    well-formed `MessagesResponse` from the in-process store — proving the two
    modes already diverge. Consolidating read+parse in Rust fixes the contract
    drift and deletes the dead TS function.
- **Duplicate serde/Zod structs already exist and are hand-maintained.** Direct
  twins verified by reading both sides:
  - `src/state_db.rs` `StateDbQueryRequest` / `StateDbFtsSearchRequest` /
    `StateDbSearchMeta` (camelCase serde) ↔ `session-search.ts`
    `StateDbQueryRequest` / `StateDbFtsSearchRequest` / `StateDbSearchMeta`.
  - `src/subscription_proxy/mod.rs` `UpstreamCredential` ↔
    `subscription-proxy.ts` `UpstreamCredentialSchema`.
  - `src/commands/api_server.rs` `ApiServerStatus` ↔ `api-server.ts`
    `ApiServerStatusSchema`.
  - `src/commands/acp.rs` `AcpStatus` ↔ `acp.ts` `AcpStatusSchema` (identical
    `running`/`pid` fields).
  - `src/commands/lsp.rs` / `mcp.rs` narrow structs ↔ `lsp.ts` / `mcp.ts`
    (partial overlap: process spawn/status args vs config/status schemas).
  Each twin is a future silent-drift bug: a field added to the Zod schema is not
  automatically visible to Rust and vice-versa. A shared `src/schema/` + fixture
  parity test makes the twin explicit and checked.
- **Gateway event parsing is the hottest parse path.** `parseGatewayEvent` (in
  `hermes-api.ts`, lines ~1841) is called from `web/src/lib/gateway-client.ts`
  line 309 on **every** gateway WS frame (message.delta/complete, tool.*,
  thinking.delta, etc.). Payloads are small so raw throughput is not the issue,
  but the function already implements the "try known typed events, fall back to
  raw passthrough" strategy that serde tagged enums express natively, and the
  Rust `ws_proxy.rs` relay handles the same byte stream in production. This is
  the one place native typed parsing directly serves both ends of the relay.
- **Perf honesty:** no measurable win from porting the REST schemas
  (`StatusResponse`, `SessionsResponse`, memory providers, skills, MCP catalog,
  profiles, analytics, OAuth, …). They are parsed once per fetch with small
  payloads; Zod's cost is lost in network/RPC overhead. Not rewriting them avoids
  ~70 duplicated structs and keeps Zod the single web contract.

## 3. Scope (in-scope / out-of-scope)

### In scope (this plan)

- `src/schema/` — one shared Rust module for protocol-shaped serde types used by
  commands/servers, with a documented naming/`rename_all` convention.
- Session-log parsing consolidation: extend `src/session_log.rs` (or a new
  `src/schema/session.rs` + `src/session_log.rs` parser) to produce
  `MessagesResponse`-compatible JSON natively; retire TS `sessionLogToMessages`
  only after parity is proven.
- Gateway event schema in Rust (`src/schema/gateway.rs`): serde tagged enum for
  the known `GatewayKnownEvent` set + raw fallback, usable by `ws_proxy.rs` and
  any future Rust-side dispatch.
- Consolidate the already-duplicated structs into `src/schema/`:
  `state_db.rs` (StateDb query/FTS/meta), `subscription_proxy.rs`
  (UpstreamCredential/ProxyStatus), `api_server.rs` (status + chat-completion
  request/response once the stub gains real parsing), `acp.rs`, `lsp.rs`
  (status/spawn args), `mcp.rs` (spawn args), `wake_word/`, `observability.rs`,
  `egress_proxy.rs` where Rust already exposes them.
- Golden JSON fixture harness + parity tests (vitest + `tests/` Rust) for every
  in-scope schema/parser.

### Out of scope (stays in TS)

- The `hermes-api.ts` REST schema zoo (`StatusResponse`, `SessionSummary`,
  `HermesUIMessage`, memory/skills/MCP-catalog/profiles/analytics/OAuth schemas,
  `FsEntry`, `parseGatewayEvent` TS twin, …).
- `channels.ts` — pure compile-time interface contract for `window.hermesDesktop`
  IPC (849 lines, zero runtime logic). Converting the type declarations
  themselves has no runtime value; only the *actual command structs* on the Rust
  side need serde mirroring (covered above).
- `spotify.ts`, `meet-api.ts`, `wake.ts`, `projects.ts`, `messaging.ts`,
  `observability.ts`, `egress-proxy.ts`, `tool-gateway.ts`,
  `document-extract.ts`, `codex-runtime.ts`, `mcp.ts` / `acp.ts` / `lsp.ts`
  schema halves — contract-only, no parsing hot paths.
- **Token estimation** (`packages/agent-tools/src/token-estimate.ts`): a genuine
  native candidate (tiktoken cl100k BPE), but it lives in `agent-tools`, not
  `protocol`, and a native rewrite only helps the Tauri path (browser dev must
  keep `js-tiktoken`/char-fallback). Flagged as a cross-cutting follow-up plan,
  not part of this one.
- `document-extract` constants/limits: stay in TS until extraction itself moves
  native.

## 4. Current contract (TS exports, types, consumers, invariants)

Package: `@hermes/protocol`, `main`/`types` = raw `src/index.ts`, subpath exports
`./mcp`, `./api-server`, `./acp`, `./lsp`, `./document-extract`,
`./subscription-proxy`, `./tool-gateway`, `./codex-runtime`, `./egress-proxy`,
`./observability`. Only runtime dependency: `zod`.

Exports by module (verified by reading):

| Module | Lines | Kind | Runtime logic | Rust twin today |
|---|---|---|---|---|
| `hermes-api.ts` | 2037 | Zod schemas (~100), `parseGatewayEvent`, tolerant helpers | `parseGatewayEvent` (hot), stringify/transform helpers | `commands/…` partial; `schema/gateway` planned |
| `channels.ts` | 849 | Plain TS interfaces (IPC contract), `Channels` map | none | per-command serde structs (hand-written) |
| `session-log.ts` | 68 | `sessionLogToMessages` | parse transform (dead: 0 consumers) | `src/session_log.rs` raw read only |
| `session-search.ts` | 141 | Zod: search request/response, `StateDb*` IPC payloads | none (validates Rust IPC) | `src/state_db.rs` (duplicate) |
| `spotify.ts` | 313 | Zod: token state + API shapes | none | none |
| `meet-api.ts` | 249 | Zod: Meet tool I/O + OAuth | none | none |
| `wake.ts` | 122 | Zod: wake word config/status/events | none | `wake_word/mod.rs` structs |
| `projects.ts` | 105 | Zod | none | `commands/projects.rs` partial |
| `messaging.ts` | 55 | Zod + platform list const | const only | none |
| `api-server.ts` | 49 | Zod: chat.completion request/response/chunk + status | none | `commands/api_server.rs` status; `api_server/mod.rs` stub (serde_json::Value) |
| `acp.ts` | 44 | Zod | none | `commands/acp.rs` duplicate `AcpStatus` |
| `lsp.ts` | 44 | Zod | none | `commands/lsp.rs` partial |
| `codex-runtime.ts` | 42 | Zod | none | none |
| `tool-gateway.ts` | 35 | Zod | none | none |
| `egress-proxy.ts` | 29 | Zod | none | `commands/egress_proxy.rs` partial |
| `observability.ts` | 26 | Zod | none | `commands/observability.rs` partial |
| `mcp.ts` | 62 | Zod | none | `commands/mcp.rs` partial |
| `subscription-proxy.ts` | 20 | Zod | none | `subscription_proxy/mod.rs` duplicate `UpstreamCredential` |
| `document-extract.ts` | 20 | Zod + constants + error class | constants | none |
| `index.ts` | 24 | re-exports + app types | none | — |

Consumers (verified): 206+ `@hermes/protocol` import sites across `packages/*`
and `web/src`; `web/src/lib/tauri-bridge.ts` imports IPC channel types;
`web/src/lib/gateway-client.ts` uses `parseGatewayEvent` per WS frame;
`web/src/hooks/*` parse REST responses with the Zod schemas via `fetchJSON`.

Key invariants:

- Browser-only dev (`python run.py`) must keep working with **no Rust** — any
  rewritten path needs a TS fallback (the existing dev handlers/parsers stay).
- `channels.ts` names are the stable IPC contract (`hermes_desktop:*`) — do not
  rename channels when mirroring command structs.
- Tolerant null/missing semantics are load-bearing: `.nullish()`, `.optional()`,
  `.default()`, `.passthrough()`, and explicit null-coalescing transforms
  (`NullishString`, `FsEntry` is_dir normalization, `ActiveProfileResponse`
  transform) — serde defaults differ (`Option` vs missing vs `null`), so each
  mapping must be fixture-locked, not eyeballed.
- `role` on `SessionMessage` is intentionally loose (`z.string()`) to survive
  unknown marker roles; a Rust parser must not reintroduce a strict enum at the
  session-log parse boundary.

## 5. Rust design (module layout, public API, serde types, state handling)

### 5.1 Single shared schema home: `src/schema/`

New crate module `src/schema/` (declare `pub mod schema;` in `src/lib.rs`),
**pure serde/serde_json — no Tauri, no AppState dependencies** so integration
tests can exercise it directly:

```
src/schema/
├── mod.rs              // pub mod re-exports; convention doc
├── gateway.rs          // GatewayEvent tagged enum + raw fallback + parse fn
├── session.rs          // SessionMessage, MessagesResponse (serde mirror of TS shapes)
├── session_log.rs      // session_log_to_messages(session_id, &Value) -> MessagesResponse
├── state_db.rs         // StateDbQueryRequest/FtsSearchRequest/SearchMeta (moved from state_db.rs)
├── subscription.rs     // UpstreamCredential, ProxyStatus, ProxyProvider
├── api_server.rs       // ApiServerStatus; ChatCompletionRequest/Chunk/Response (when api_server gains real parsing)
├── acp.rs              // AcpStatus, AcpSessionState (status/spawn args used by commands)
├── lsp.rs              // LspProcessStatus, LspSpawnArgs, LspServerStatus
├── mcp.rs              // McpStdioSpawnArgs, McpServerConfig (fields actually used by commands)
├── wake.rs             // Wake* status/event structs (used by commands/wake_word)
├── observability.rs    // OtelSpan/Event/TelemetryConfig (used by commands/observability)
├── egress.rs           // EgressProxyRule/Status (used by commands/egress_proxy)
└── util.rs             // tolerant helpers: nullish_string(), default_* fns,
                        // serde defaults mirroring Zod .nullish()/.default()/.passthrough()
```

Conventions (documented in `mod.rs`):

- Every struct derives `Serialize, Deserialize, Debug, Clone` (+ `PartialEq`
  where needed for tests), `#[serde(rename_all = "camelCase")]` to match the TS
  wire shape.
- Unknown fields: serde ignores unknown fields by default, matching Zod
  `.passthrough()`; **do not** add `deny_unknown_fields`.
- Null vs missing: prefer `Option<T>` + `#[serde(default)]`, and use the
  tolerant helper where the TS side coalesces null → undefined/"".
- Each module ships inline `#[cfg(test)]` unit tests (AGENTS.md convention).

Commands (`src/commands/*.rs`) then import these structs instead of declaring
their own; `src/state_db.rs` and `src/subscription_proxy/mod.rs` move their
request/credential structs here (mechanical move, tests stay green).

### 5.2 Session-log consolidation

- Extend `src/session_log.rs` (or add `src/schema/session_log.rs`) with
  `session_log_to_messages(session_id: &str, log: &serde_json::Value) ->
  Result<MessagesResponse, ...>` implementing the exact `sessionLogToMessages`
  semantics: iterate `log.messages` array, skip non-objects, loose `role`
  (user/assistant/system/tool only), `content` stringify fallback, per-message
  `id`/`session_id`/`timestamp = session_start + index`, nullable passthrough
  fields.
- `handle_session_log_request` in `src/session_log.rs` now returns
  `MessagesResponse`-shaped JSON (`{ session_id, messages, ui_messages? }`) so
  the Tauri-shell `/__hermes_session_log/` response satisfies the UI's existing
  `MessagesResponse.parse`, matching browser-dev behavior.
- Browser-dev TS handler keeps returning `MessagesResponse` from the store; after
  parity is proven, delete TS `sessionLogToMessages` and its test, and update the
  comment in `use-sessions.ts` if the fallback behavior changes.

### 5.3 Gateway event schema (Rust)

`src/schema/gateway.rs`:

- `#[serde(tag = "type")] pub enum GatewayEvent { Ready { ... }, SessionInfo { ... },
  MessageStart { ... }, MessageDelta { ... }, MessageComplete { ... },
  ThinkingDelta { ... }, ReasoningDelta { ... }, ReasoningAvailable { ... },
  StatusUpdate { ... }, ToolStart { ... }, ToolGenerating { ... },
  ToolComplete { ... }, ApprovalRequest { ... }, Error { ... }, #[serde(other)] Raw(RawGatewayEvent) }`
  mirroring `GatewayKnownEvent`; `RawGatewayEvent` = `{ type: String,
  session_id: Option<String>, payload: Value }` with passthrough semantics.
- `pub fn parse_gateway_event(value: &Value) -> Result<GatewayEvent, AppError>`
  mirroring `parseGatewayEvent`: try typed parse, fall back to raw.
- Used first by `ws_proxy.rs` for validation/logging at the relay boundary (and
  later by any Rust-side dispatch). The TS `parseGatewayEvent` remains for
  browser dev and for the webview path; both are fixture-locked.

### 5.4 Single-source-of-truth strategy (Zod vs serde)

- **Zod remains the source of truth for web-facing validation** (mandatory —
  browser-only dev has no Rust).
- **Serde structs are created only where Rust already touches the same bytes**:
  IPC command args/returns, `api_server`/`subscription_proxy` request/response,
  `state_db` queries, WS relay frames, session-log files.
- Contract changes start in `packages/protocol/src/*.ts` **and** update the
  matching `src/schema/*.rs` in the same change, verified by the shared golden
  fixture set (Section 8). No silent hand-sync: the parity gate fails on
  mismatch.
- Do **not** build a code generator in phase 1. The schema surface is small and
  stable; shared fixtures + CI parity is cheaper and less risky than a TS→serde
  generator. Revisit only if `src/schema/` grows beyond ~15 structs and drift
  events recur.

## 6. IPC / boundary (Tauri command names+args+returns; browser-only-dev fallback)

No new Tauri commands are required by this plan; it consolidates **existing**
commands' structs:

- `state_db_query` / `state_db_exec` / `state_db_fts_search` / `state_db_search_meta`
  (in `src/commands/state_db.rs`) — args/returns now come from `src/schema/state_db.rs`.
- `subscription_proxy_*` commands — `UpstreamCredential` etc. from
  `src/schema/subscription.rs`.
- `api_server_start/stop/status` — `ApiServerStatus` from `src/schema/api_server.rs`.
- `acp_status/start/stop/list_sessions` — `AcpStatus` from `src/schema/acp.rs`.
- `lsp_*`, `mcp_stdio_*`, `wake_*`, `observability_*`, `egress_proxy_*` —
  narrow structs from their schema modules.
- `/__hermes_session_log/<id>` (HTTP route via `api_proxy.rs`) — now returns
  `MessagesResponse`-compatible JSON from `schema::session_log` (keeps the same
  route and channel contract; response body shape changes to match what the UI
  already parses).
- WS relay `ws_proxy.rs` — uses `schema::gateway::parse_gateway_event` for
  validation/logging (no wire change).

Browser-only-dev fallback: every behavior behind these boundaries already has a
TS implementation (dashboard handlers, gateway-inprocess transport, session
store). The plan keeps those in place; the golden fixtures guarantee the TS
fallback and the Rust path produce identical JSON. No new fallback code is
needed for the schema moves (they are pure type consolidation), and the
session-log TS handler remains as the dev fallback until deletion.

## 7. Implementation phases (ordered, each shippable + testable)

Each phase lands with its own tests and leaves `pnpm typecheck`,
`pnpm test:unit`, and `cargo test` green. **No git write operations** — phases
are for the human to apply.

### Phase 1 — `src/schema/` skeleton + IPC struct consolidation (S)
- Create `src/schema/mod.rs`, `util.rs`, and move the duplicate structs
  (`state_db`, `subscription`, `api_server` status, `acp`, `lsp`, `mcp`,
  `wake`, `observability`, `egress`) from their command modules into schema
  modules; update `src/commands/*` imports.
- Add inline unit tests for each moved struct (serde round-trip, null vs
  missing).
- Add golden fixtures + parity tests for these structs (Section 8).

### Phase 2 — Gateway event schema + relay validation (S–M)
- `src/schema/gateway.rs` tagged enum + `parse_gateway_event`.
- Wire into `ws_proxy.rs` for parse/validation logging (no wire change).
- Golden fixtures for all 14 known event types + unknown-type raw fallback;
  vitest parity test against `parseGatewayEvent`.

### Phase 3 — Session-log read + parse consolidation (S)
- Implement `session_log_to_messages` in Rust; change `handle_session_log_request`
  to return `MessagesResponse`-compatible JSON.
- Port every vector from `packages/protocol/src/session-log.test.ts` into Rust
  unit tests and shared fixtures.
- After parity: delete TS `sessionLogToMessages` and its test; adjust the
  `use-sessions.ts` fallback comment if needed; run `python run.py` smoke
  (browser dev) to confirm the TS handler still serves the fallback.

### Phase 4 — api_server real request parsing (M)
- When `src/api_server/mod.rs` graduates from stub responses, parse
  `/v1/chat/completions` bodies into `schema::api_server::ChatCompletionRequest`
  and emit `ChatCompletionResponse`/`ChatCompletionChunk` serde structs shared
  with `subscription_proxy` passthrough validation.
- Parity fixtures for the api-server schemas (`api-server.test.ts` vectors).

### Phase 5 — (optional, separate plan) native token estimation (L)
- `packages/agent-tools/src/token-estimate.ts` → native cl100k BPE for the Tauri
  path, with `js-tiktoken` fallback for browser dev. Lives outside `protocol`;
  tracked here only as a cross-cutting follow-up.

## 8. Testing strategy

- **Rust unit tests** (AGENTS.md): inline `#[cfg(test)]` per `src/schema/*.rs`
  and `src/session_log.rs`; cover serde round-trips, tolerant null/missing
  matrix, session-log transform edge cases (non-array messages, unknown roles,
  stringify fallback, timestamp fallback).
- **Rust integration tests** (`tests/`): `tests/protocol_schema.rs` reads the
  shared golden fixtures (via `env!("CARGO_MANIFEST_DIR")`), parses each with the
  schema module, asserts normalized JSON equality; `tempfile::TempDir` for any
  FS-based session-log test; `wiremock::MockServer` only if a command handler is
  exercised over HTTP. Env-dependent tests `#[serial_test::serial]`.
- **Golden fixtures** (single source of truth for parity): new
  `tests/fixtures/protocol/*.json` at repo root — one file per schema/parser,
  containing representative cases: happy path, null-vs-missing, wrong type,
  unknown fields (passthrough), unknown enum values, empty arrays. Both suites
  read the same directory:
  - vitest: `packages/protocol/test/parity/*.test.ts` (or a new `scripts/parity-*`
    runner) loads `../../tests/fixtures/protocol/*.json`, runs the Zod schema /
    TS parser, snapshots the normalized output.
  - Rust: `tests/protocol_schema.rs` loads the same files and asserts serde
    output equals the TS snapshot (`assert_json_eq` via `pretty_assertions` /
    `serde_json` value comparison).
- **Session-log parity**: port all 15+ vectors from `session-log.test.ts` into
  shared fixtures; keep the vitest test green until Phase 3 deletion, then keep
  the fixtures as Rust tests + parity snapshots.
- **CI**: `rust-test.yml` and `web-test.yml` already run on PR; add a `parity`
  check (e.g. a script that hashes `tests/fixtures/protocol/` and fails if any
  suite hasn't consumed the current set) so a fixture update without both-suite
  updates cannot land. Add `cargo test --test protocol_schema` and
  `pnpm test:unit` parity files to the existing workflows.
- **Dev-mode verification**: after Phase 3, run `python run.py` smoke to prove
  browser-only dev still serves `/__hermes_session_log/` from the TS handler;
  after Phase 2, run `pnpm tauri:dev` and confirm WS relay logs parsed events.

## 9. Risks & mitigations (drift between Zod and serde is the big one)

| Risk | Impact | Mitigation |
|---|---|---|
| Zod↔serde semantic drift (null vs missing, `.default()` vs `Option`, `.passthrough()`, `.transform()`) | Silent behavior change on the wire | Shared golden fixtures with a null/missing/wrong-type matrix; every mapped schema gets a parity test; serde convention (`Option`+`#[serde(default)]`, ignore unknown fields) documented in `src/schema/mod.rs` |
| Browser-only dev diverges from Tauri path | UI works in `run.py` but not packaged (or vice-versa) | Keep every TS fallback; fixture parity between TS parser and Rust parser; `python run.py` smoke after each phase |
| Session-log route shape change breaks the existing fallback | History blank in packaged app | Phase 3 changes Rust to the shape the UI already parses (`MessagesResponse`), then deletes the dead TS function — no new mismatch; keep route path identical |
| Hand-maintained command structs drift again after consolidation | Recurrence of today's duplicates | All structs live in one `src/schema/`; CI parity gate; code review checklist: "protocol contract change ⇒ update Zod + `src/schema` + fixtures in one change" |
| Over-eager scope creep into the REST schema zoo | Massive duplication, ~70 structs, no perf win | Explicit out-of-scope list (Section 3); plan gate: only schemas already at a Rust boundary qualify |
| serde tagged-enum fallback for gateway events doesn't match Zod's unknown-type passthrough | Relay mis-classifies new event types | `#[serde(other)]` raw variant + fixtures for unknown types; TS `parseGatewayEvent` kept as the authoritative web behavior until parity passes |
| `channels.ts` is type-only and tempting to "port" | Zero runtime value, churn | Keep channels.ts as the TS contract; mirror only real command structs; no codegen in phase 1 |

## 10. Effort estimate (S/M/L per phase)

| Phase | Size | Estimate |
|---|---|---|
| 1 — `src/schema/` skeleton + IPC struct consolidation | S | 1–2 dev-days (mostly mechanical moves + fixtures) |
| 2 — Gateway event schema + relay validation | S–M | 2–4 dev-days (14 event variants + fallback + parity) |
| 3 — Session-log read + parse consolidation | S | 1–2 dev-days (port existing vectors; delete dead TS fn) |
| 4 — api_server real request parsing | M | 3–5 dev-days (depends on api_server work outside this plan) |
| 5 — Native token estimation (separate plan) | L | 1–2 weeks (BPE tables/encoder integration; protocol-adjacent only) |

Total core (phases 1–3): ~4–8 dev-days. Phase 4 is conditional on the api_server
roadmap; Phase 5 is a separate plan and should not block this one.

---

### Appendix — verification notes (what the author actually read)

- Read in full: `packages/protocol/package.json`, `src/index.ts`,
  `src/session-log.ts`, `src/hermes-api.ts` (head/tail + schema inventory),
  `src/session-search.ts`, `src/mcp.ts`, `src/acp.ts`, `src/lsp.ts`,
  `src/api-server.ts`, `src/codex-runtime.ts`, `src/document-extract.ts`,
  `src/egress-proxy.ts`, `src/tool-gateway.ts`, `src/subscription-proxy.ts`,
  `src/observability.ts`, `src/meet-api.ts`, `src/spotify.ts`,
  `src/projects.ts`, `src/wake.ts`, `src/messaging.ts`, `src/channels.ts`
  (structure + representative sections), `docs/typescript-runtime.md`,
  `AGENTS.md`.
- Read Rust side: `src/lib.rs` (module list), `src/session_log.rs` (full),
  `src/api_server/mod.rs` (route/body handling), `src/state_db.rs` (struct
  inventory), `src/subscription_proxy/mod.rs` (UpstreamCredential),
  `src/commands/{mcp,lsp,acp,api_server}.rs` (struct inventory), `src/main.rs`
  (generate_handler presence).
- Grepped consumers: `@hermes/protocol` (206 sites), `sessionLogToMessages`
  (0 consumers outside tests), `parseGatewayEvent` (`web/src/lib/gateway-client.ts:309`),
  `/__hermes_session_log/` (`web/src/hooks/use-sessions.ts`,
  `web/src/lib/dashboard-handlers.ts`, `src/commands/api_proxy.rs`),
  `token-estimate` (`packages/agent-tools/src/token-estimate.ts`).
- Note: `packages/protocol/src/mcp-api.ts` **does not exist** — the task list
  referenced it, but the only file is `mcp-api.test.ts`, which tests the MCP
  wire types in `hermes-api.ts`. Those stay in TS (contract-only).
