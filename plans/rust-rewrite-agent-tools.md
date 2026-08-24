# Plan: Rewrite agent-tools modules from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/agent-tools/src/...`
- Target Rust: `src/...`
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

`packages/agent-tools` (51 TS source files, ~592 KB) is the in-process tool
registry / catalog / toolset resolver that runs **inside the webview** and must
keep working with **zero Rust** in browser-only dev mode (`python run.py`).
Only a small, well-bounded subset of this package genuinely benefits from a
native Rust implementation; the rest is either thin orchestration over TS
closures, stub registrations whose real capability already lives in Rust
commands, or stateful network SDKs that must stay in TS.

Recommended Rust scope (top candidates):

1. **Token estimation** (`src/token-estimate.ts`) — the strongest candidate:
   `js-tiktoken` (WASM) → native `tiktoken-rs` (cl100k_base BPE). Propose a
   shared Rust home `src/tokenize/` that the sibling `agent-core` plan also
   references. Caveat: the only live UI consumer today uses the **sync
   chars/4 fallback**; the async wasm path has no live consumer yet, so the
   real payoff lands when `agent-core` consumes it per-turn (prompt/tool-set
   counting).
2. **HA security guard** (`src/homeassistant/security.ts`) — small,
   deterministic, security-critical validation (entity/service regex, blocked
   domains, JSON-string `data` parsing). Move the authoritative guard into
   Rust (defense-in-depth next to `commands/ha_proxy.rs`) and keep the TS
   mirror for browser mode.
3. **Toolset resolution** (`src/toolsets.ts` + static catalog) — pure
   string/set resolution (recursive includes, cycle-safe, wildcard, disabled
   subtraction). Portable to Rust as `src/toolkit/toolsets.rs`; consumed by
   `web/src/routes/tools.tsx` and indirectly by `agent-core` via
   `model-tools.ts`.
4. **Zod→serde JSON-schema builder** (`src/catalog.ts` `objectSchema` /
   `zodToJsonSchema`) — deterministic algorithm that every tool registration
   uses; becomes a shared Rust `src/toolkit/schema.rs` (cross-cutting "schema
   home" for other plans) so Rust commands can emit/validate identical
   OpenAI-style schemas without re-implementing it.
5. **Platform toolset policy** (`src/platform-config.ts`) — pure config
   policy (composites expansion, default-off, platform restrictions,
   credential auto-enable, global disabled override). Rust already owns the
   YAML authority, so a Rust `resolve_platform_tools` is a natural central
   policy point; lower priority than 1–4.

Explicitly **out of scope** for Rust rewrite: `registry.ts` / `dispatch.ts`
(TS closure seam — Rust cannot hold TS handlers; `dispatch` already routes to
Rust IPC where needed), `categories.ts` (trivial static table), `wildcard.ts`
(9 lines, trivially small), the integration stubs
(`integrations/*` — their capability already exists in `src/commands/*`),
and the `spotify/`, `messaging/`, `meet/` network SDKs (stateful TS clients,
OAuth, FetchLike transports; browser-only dev must work).

Cross-cutting shared-Rust homes proposed (aligned with the sibling
`plans/rust-rewrite-agent-core.md`): **`src/tokenize/`** (tiktoken-rs core)
and **`src/schema/`** (shared serde mirrors, agent-core plan's home — the
agent-tools tool shapes live there as `tool.rs`; tool-specific *logic* lives
in **`src/toolkit/`** — JSON-schema builder + pure resolvers + HA guard).
Every Rust-backed feature keeps a TS fallback for browser-only dev; parity is
enforced with golden vectors.

## 2. Why rewrite (value/motivation, quantified where possible; be honest)

- **Token estimation (real, but currently front-loaded).**
  - `js-tiktoken` instantiates WASM lazily (`getEncoding("cl100k_base")`),
    every `encode()` crosses the JS/WASM boundary, and it is async.
    `tiktoken-rs` is a native BPE implementation that is typically 10–100×
    faster for short strings and removes ~1 MB of WASM + loading cost from the
    `web/` bundle. `packages/agent-tools/package.json` lists `js-tiktoken` as
    a **devDependency**, which is itself a smell: the only runtime import is
    `src/token-estimate.ts`.
  - **Honest caveat:** grep shows the async functions (`countTokens`,
    `estimateToolTokens`, `estimateToolSetTokens`) currently have **no live
    consumer outside tests**; the tools page
    (`web/src/routes/tools.tsx:17,100`) uses the sync `estimateToolSetTokensSync`
    (chars/4). The migration only pays off when `agent-core` starts counting
    prompt/tool tokens per turn (the sibling plan) — the shared `src/tokenize/`
    home is the coordination point. Until then, this phase is
    infrastructure + parity groundwork.
- **HA security guard (small code, high value).**
  - `security.ts` blocks `shell_command`, `command_line`, `python_script`,
    `pyscript`, `hassio`, `rest_command` and rejects path-traversal entity
    ids. This is the kind of check that must be enforced at the capability
    boundary (Rust `ha_proxy` command), not only in webview JS. ~60 lines;
    trivial to port and unit test; pure defense-in-depth.
- **Toolset resolution (modest, but clean).**
  - `toolsets.ts` is pure set logic with no IO; it is called on every tools
    page render and on every `getToolDefinitions` memo miss. The per-call cost
    is small (memoized in `model-tools.ts`), so the win is not CPU — it is
    **parity and single-source-of-truth**: Rust unit tests guarantee the
    static catalog and resolver match Python `toolsets.py`, and Rust-side
    commands (future `tools_dispatch`) can resolve toolsets without a TS round
    trip.
- **Zod→JSON schema builder (determinism + reuse).**
  - `catalog.ts`’s `objectSchema`/`zodToJsonSchema` is used by every tool
    registration. A Rust `src/toolkit/schema.rs` gives other plans a shared
    schema emitter and lets Rust validate tool args against the same shapes.
    Value is architectural, not hot-path.
- **Platform config policy (ownership).**
  - `platform-config.ts` already comments “the YAML authority lives in Rust”.
    Centralizing `getPlatformTools` policy in Rust aligns with
    `src/api_server/`, `src/subscription_proxy/`, `src/state_db.rs` — the
    established “move policy/hot-path to Rust, keep TS caller” pattern.
    Low CPU value; high correctness/ownership value.
- **Everything else:** no value — `registry`/`dispatch`/`model-tools` are the
  TS seam (handlers are TS closures); integrations are stubs whose real
  capability already lives in Rust commands (`subscription_proxy`, `acp`,
  `mcp`, `egress_proxy`, `ha_proxy`, `meet`, `spotify_oauth`, `messaging`,
  `observability`, `web_tools` are all in `src/commands/`); SDK packages need
  browser-only dev.

## 3. Scope (in-scope / out-of-scope)

### In-scope (Rust rewrite / mirror)
| TS module | Rust target | What moves |
|---|---|---|
| `src/token-estimate.ts` | `src/tokenize/` (new module, `src/tokenize/mod.rs` + `tiktoken.rs`) | `countTokens`, `estimateToolTokens`, `estimateToolSetTokens`, sync `chars/4` parity |
| `src/homeassistant/security.ts` | `src/toolkit/ha_security.rs` (or `src/ha_guard.rs`); wired into `commands/ha_proxy.rs` | `isValidEntityId`, `isValidServiceName`, `isBlockedDomain`, `parseStringData` |
| `src/toolsets.ts` (static catalog + resolver) | `src/toolkit/toolsets.rs` | `TOOLSETS` data, `resolveToolset`, `resolveMultipleToolsets`, `validateToolset`, `getAllToolsetKeys`, `getCategoryForToolset`, `getToolsetsByCategory`, `bundleNonCoreTools` |
| `src/catalog.ts` `objectSchema` / `zodToJsonSchema` | `src/toolkit/schema.rs` | JSON-schema builder algorithm (serde_json::Value output) |
| `src/platform-config.ts` | `src/toolkit/platform.rs` | `getPlatformTools` policy (not the config persistence helpers, which stay thin TS) |
| `src/types.ts` | `src/schema/tool.rs` (shared serde home per agent-core plan) | Serde mirrors of `ToolDefinition`, `ToolsetDef`, `ToolCategory`, `ToolConfigLike`, `ToolCallOutcome`, etc. |

### Out-of-scope (stay TS; reasons)
- `src/registry.ts`, `src/dispatch.ts`, `src/model-tools.ts` — registry holds
  TS handler closures; `dispatch.ts` already has the Rust IPC fallback path.
  **Gap found:** `dispatch.ts:62` invokes a `tools_dispatch` Rust command that
  does **not exist** in `src/` (verified: no match). If the plan ever wants
  that path live, it should be a separate `tools_dispatch` command phase, not
  a rewrite of these files.
- `src/categories.ts` — static table + Map lookups; trivial.
- `src/dynamic-toolsets/wildcard.ts` — 9 lines; the real logic is in
  `toolset-registry.ts` (dynamic/MCP/plugin state, keep TS).
- `src/integrations/*` — stub `register()` entries ("Would …" handlers); the
  capability already lives in Rust commands. Only their Zod schemas matter,
  covered by the shared schema builder.
- `src/spotify/*`, `src/messaging/*`, `src/meet/*` — stateful network SDKs
  (OAuth PKCE, FetchLike transports, credential providers, url gates). Must
  run in browser-only dev. Optionally mirror tiny pure helpers
  (`spotify/normalize.ts`, `meet/url-gate.ts`) for Rust command parity later,
  but that is not a rewrite.
- `src/dynamic-toolsets/tool-registry.ts`, `toolset-registry.ts`, `mcp.ts`,
  `custom-toolsets.ts` — dynamic registry state + IO (stdio MCP), keep TS.
- `src/homeassistant/client.ts`, `tools.ts`, `format.ts` — TS clients; only
  the security guard moves.

## 4. Current contract (TS exports, types, consumers, invariants)

### Entry point
- `packages/agent-tools/src/index.ts` re-exports: `types`, `registry`,
  `toolsets`, `catalog`, `categories`, `dispatch`, `gates`,
  `platform-config`, `platform-toolsets`, Spotify / HA / Meet bundles,
  `token-estimate`, dynamic-toolsets types + helpers, `getToolDefinitions`.
- `package.json`: package `@hermes/agent-tools`, `main/types` =
  `./src/index.ts`, subpath exports `./spotify` and `./spotify/*`.

### Key exports and live consumers (verified)
| Export | Consumers |
|---|---|
| `estimateToolSetTokensSync` | `web/src/routes/tools.tsx:17,100` (tools page “约 N tokens” status line) |
| `resolveMultipleToolsets`, `getAllToolsetKeys`, `getCategoryForTool`, `listCategories`, `registry`, `getCategory` | `web/src/routes/tools.tsx:4-17,33,36,64,75` |
| `getPlatformTools`, `getAllToolsetKeys` | `web/src/lib/tools-commands.ts:11-18,76,112,147` (slash commands) |
| `listCategories` | `web/src/lib/slash-commands/handlers/tools-category.ts:12-14,44,51` |
| `registry`, `register` | `packages/agent-core/src/memory/tool.ts:9,231`, `packages/agent-core/src/session-search-recall/tool.ts:17-18,121`, `web/src/lib/x-search/tool.ts`, `web/src/lib/web-search/tools.ts` |
| type `ToolDefinition` | `web/src/lib/tools/tool-search/{assemble,bridge,classify,tool-search,types}.ts` |
| type `ToolContext`, `ToolResult`, `ToolParameterSchema` | `web/src/lib/browser/tools.ts`, `web/src/lib/x-search/*`, `web/src/lib/web-search/*` |
| Spotify bundle | `web/src/lib/spotify.ts`, `web/src/tools/spotify/index.ts` |

### Invariants
1. **Browser-only dev must work with no Rust.** Every Rust-backed feature
   needs a TS fallback (the pattern already used by `dispatch.ts` and
   `platform-config.ts`).
2. **Registry is the single mutable source of truth** for which tools exist;
   `agent-core` and `web` import the same singleton and register side-effect
   modules into it. Rust must not own this map.
3. **Definition shape is OpenAI-function JSON** (`type: "function"`,
   `function.{name,description,parameters}`) — the serde mirror must be
   byte-identical for the same input.
4. **Toolset resolution semantics:** cycle-safe recursive includes, `all`/`*`
   wildcard excludes `workflowGate` toolsets, disabled subtraction is applied
   after union, dynamic registry toolsets resolve as empty leaves passed
   through to the registry.
5. **Platform policy order:** raw list → composite expansion → default-off →
   platform restrictions → credential auto-enable → GUI surfacing → global
   disabled override (see `platform-config.ts:96-145`).
6. **HA validation order:** service-name regex before blocklist; entity-id
   regex rejects `../` traversal; JSON-string `data` parsing matches Python
   `orjson` semantics (empty/`null`/array/scalar → `undefined`).
7. **Token counts must be stable** across TS/Rust implementations for the
   same cl100k_base encoder version (golden vectors).

## 5. Rust design (module layout, public API, serde types, state handling)

### Module layout (single crate; add modules to `src/lib.rs`)
```
src/
├── lib.rs                     # add: pub mod tokenize; pub mod toolkit; (schema via agent-core plan)
├── tokenize/                  # SHARED home (agent-core plan references this too)
│   ├── mod.rs                 # pub count_tokens, fallback_count (cl100k_base BPE)
│   └── bpe.rs                 # tiktoken-rs wrapper (agent-core plan's layout)
├── schema/                    # SHARED serde-type home per agent-core plan
│   └── tool.rs                # serde mirrors of TS types.ts (ToolDefinition, ToolsetDef, …)
└── toolkit/
    ├── mod.rs
    ├── schema.rs              # JSON-schema builder (port of objectSchema/zodToJsonSchema)
    ├── toolsets.rs            # static TOOLSETS + resolver
    ├── platform.rs            # getPlatformTools policy
    └── ha_security.rs         # HA validation guard
```
`src/commands/` gains thin `#[tauri::command]` wrappers (kept separate from
pure logic, matching `state_db.rs` / `api_server` / `subscription_proxy`):

```
src/commands/tokenize.rs       # tokenize_count, tokenize_estimate_tool_set
src/commands/toolkit.rs        # toolsets_resolve, platform_tools_resolve (later)
```
`commands/ha_proxy.rs` calls `toolkit::ha_security` before proxying.

### Public Rust API (pure, sync, no state)
```rust
// src/tokenize/mod.rs
pub fn count_tokens(text: &str) -> usize;                    // cl100k_base BPE
pub fn fallback_count(text: &str) -> usize;                  // ceil(len/4)
pub fn estimate_tool_tokens(def: &serde_json::Value) -> usize;
pub fn estimate_tool_set_tokens(defs: &[serde_json::Value]) -> usize;
pub fn estimate_tool_set_tokens_sync(defs: &[serde_json::Value]) -> usize; // fallback_count

// src/toolkit/toolsets.rs
pub fn resolve_multiple_toolsets(
    names: &[String],
    custom: &BTreeMap<String, CustomToolset>,
    disabled: &[String],
    registry_toolsets: &BTreeSet<String>,
    is_gui_session: bool,
    kanban_worker: bool,
) -> BTreeSet<String>;

// src/toolkit/platform.rs
pub fn get_platform_tools(cfg: &ToolConfigLike, platform: &str, opts: &PlatformOpts)
    -> PlatformToolsResult;

// src/toolkit/ha_security.rs
pub fn is_valid_entity_id(s: &str) -> bool;
pub fn is_valid_service_name(s: &str) -> bool;
pub fn is_blocked_domain(s: &str) -> bool;
pub fn parse_string_data(v: &serde_json::Value) -> Option<serde_json::Value>;

// src/toolkit/schema.rs
pub fn object_schema(shape: BTreeMap<String, serde_json::Value>, required: Vec<String>)
    -> serde_json::Value; // identical shape to catalog.objectSchema
```

### Serde types (`src/schema/tool.rs`, shared with agent-core plan)
Mirror `types.ts` exactly: `ToolDefinition`, `ToolParameterSchema`,
`ToolsetDef`, `CustomToolset`, `ToolCategory`, `ToolConfigLike`,
`PlatformToolsResult`, `ToolCallOutcome`. All `#[derive(Serialize, Deserialize,
Debug, Clone, PartialEq)]`; maps as `BTreeMap` for deterministic ordering.
`src/schema/` is the agent-core plan's shared serde home — tool shapes are
added there as `tool.rs` so both plans reuse the same `ToolDefinition` type.

### State handling
- **None for tokenize/toolsets/schema/ha_security** — pure functions.
- `tiktoken-rs` keeps its BPE tables in process memory (loaded once, global);
  no AppState entry needed. This is a deliberate, safe global (read-only).
- `platform.rs` is pure over the config value; the config itself stays in
  Rust state (`AppState`), so the command reads state and passes the JSON to
  the pure function.
- Toolset static data is a `const`-style table (lazy static or plain
  function-local); no mutation.

## 6. IPC / boundary (Tauri command names+args+returns; browser-only-dev fallback strategy)

### Proposed commands (added to `generate_handler!` in `src/main.rs`)
| Command | Args | Returns |
|---|---|---|
| `tokenize_count` | `{ text: string }` | `{ count: number }` |
| `tokenize_estimate_tool_set` | `{ defs: ToolDefinition[] }` | `{ total: number }` |
| `toolsets_resolve` | `{ names: string[], customToolsets?: Record<string, CustomToolset>, disabled?: string[], registryToolsets?: string[], isGuiSession?: boolean, kanbanWorker?: boolean }` | `{ tools: string[] }` |
| `platform_tools_resolve` | `{ config: ToolConfigLike, platform: string, opts?: { autoEnableCredentials?, env?, isGuiSession? } }` | `PlatformToolsResult` |
| `ha_validate_call` (or inline in `ha_request`) | `{ domain, service, entityId?, data? }` | `{ ok: boolean }` / validated payload; errors as `AppError` |

Note: the agent-core plan exposes a shared `agent_core_tokenize` command
(`{ texts: string[], mode: "bpe"|"heuristic" }`) over the same `src/tokenize/`
core. `tokenize_estimate_tool_set` adds tool-definition serialization + sum
semantics on top of that core; implement both against the same module and
share the golden vectors.

### Browser-only-dev fallback strategy
- `web/src/lib/tauri-bridge.ts` already mounts `window.hermesDesktop`; the
  web runtime checks for it before invoking (pattern in `dispatch.ts` /
  `platform-config.ts`).
- TS wrappers keep the **current behavior as fallback**:
  - `token-estimate.ts`: if `invoke("tokenize_*")` unavailable → existing
    `js-tiktoken` path (or chars/4) unchanged.
  - `toolsets.ts`: if IPC unavailable → existing pure-TS resolver unchanged.
  - `platform-config.ts` / `security.ts`: same dual-mode pattern.
- No Rust, no breakage: this is the hard invariant (AGENTS.md + 
  `docs/typescript-runtime.md`).

## 7. Implementation phases (ordered, each shippable + testable)

### Phase 1 — Shared Rust tokenize home (S–M)
- Add `tiktoken-rs = { version = "0.5" }` (cl100k_base default) to
  `Cargo.toml`; verify no existing `src/` module named `tokenize`.
- Implement `src/tokenize/` (mod.rs + bpe.rs per agent-core plan layout) +
  `src/commands/tokenize.rs`; register commands in `src/main.rs`. Keep the
  core API minimal (`count_tokens`, `fallback_count`) so the agent-core plan
  can reuse it for its `agent_core_tokenize` command.
- TS: keep `token-estimate.ts` exports; add an optional `invoke`-based fast
  path behind a `tokenizeConfig`/option (default: existing behavior) so the
  package tests stay green; wire `web/src/routes/tools.tsx` to prefer IPC
  when available.
- Tests: Rust unit tests + golden-vector corpus; vitest parity tests with a
  mocked invoke shim.
- **Coordination:** this is the `src/tokenize/` home the sibling `agent-core`
  plan also proposes (`plans/rust-rewrite-agent-core.md` §5); land it first
  and keep the raw text-counting API shared so both plans build on it.

### Phase 2 — Shared serde types + schema builder (M)
- `src/schema/tool.rs` serde mirrors (shared home per agent-core plan);
  `src/toolkit/schema.rs` port of `objectSchema`/`zodToJsonSchema` with a
  fixture-driven test set (all Zod types used in `catalog.ts`: string/
  description, number, boolean, array, object, optional, enum, default).
- No IPC needed yet (schema builder is used by Rust-side code); optional
  `schema_build` command for parity demos.
- Tests: Rust unit tests; TS parity tests comparing
  `catalog.objectSchema(z)` output against the Rust builder on the same
  fixtures.

### Phase 3 — Toolset resolver in Rust (M)
- Port `TOOLSETS` static table + resolver into `src/toolkit/toolsets.rs`.
- `toolsets_resolve` command; TS `toolsets.ts` gets an optional IPC fast path
  (fallback = existing TS resolver).
- Tests: exhaustive parity over all static toolset keys + custom/disabled
  combinations; cycle-safety and wildcard `workflowGate` exclusion tests.

### Phase 4 — Platform toolset policy in Rust (S–M)
- Port `getPlatformTools` policy to `src/toolkit/platform.rs`;
  `platform_tools_resolve` command; TS `platform-config.ts` wrapper.
- Tests: parity over the config fixtures in `platform-config.test.ts` +
  restrictions/default-off tables.

### Phase 5 — HA security guard in Rust (S)
- Port `security.ts` to `src/toolkit/ha_security.rs`; call it from
  `commands/ha_proxy.rs` before proxying (defense-in-depth; keep TS guard for
  browser mode).
- Tests: Rust unit tests reusing the security.test.ts vectors (traversal
  cases, blocked domains, `parseStringData` orjson semantics).

### Phase 6 — Optional: definition pipeline consolidation (L, likely NOT needed)
- Only if agent-core per-turn profiling shows `getToolDefinitions`/memo is a
  hotspot: move the memo + definition assembly to Rust (`tools_definitions`
  command) with the tool metadata table mirrored in Rust.
- Until profiling proves it, keep `registry.ts`/`model-tools.ts` in TS.
- Separate: implement the missing `tools_dispatch` Rust command if the
  `dispatch.ts` fallback path is ever activated.

## 8. Testing strategy (Rust unit/integration; TS↔Rust parity via golden vectors; vitest parity tests)

- **Rust unit tests** (`#[cfg(test)] mod tests` at bottom of each new module,
  per AGENTS.md) for all pure functions: tokenize counts, schema builder,
  toolset resolution, platform policy, HA guard.
- **Golden vectors** (`src/tokenize/tests/vectors` or inline):
  - A fixed corpus of strings + tool definitions (name/description/parameters
    in the exact shape used by `catalog.ts`).
  - Rust `count_tokens` must equal TS `js-tiktoken` counts for the pinned
    encoder version. Exact equality is expected for cl100k_base; if
    `tiktoken-rs` and `js-tiktoken` snapshots drift, the vector test documents
    the divergence and pins the versions (`js-tiktoken ^1.0.21` vs a fixed
    `tiktoken-rs` version).
  - Same corpus drives **vitest parity tests** that run the TS implementation
    and compare to recorded Rust outputs (committed JSON fixture).
- **TS↔Rust parity tests**: in `packages/agent-tools/src/*.test.ts`, add a
  mocked `invoke` shim returning fixture Rust results; assert the TS wrapper
  falls back and matches when IPC is absent, and uses Rust results when
  present.
- **IPC integration**: `tests/` (repo root) may add a wiremock-free Tauri
  command smoke only if a harness exists; otherwise rely on manual
  `pnpm tauri:dev` + the tools page status line.
- **Browser-only regression**: run `pnpm test:unit` (vitest) with no Rust —
  the fallback path is the tested path in CI.
- **Full gates before merge**: `pnpm typecheck`, `pnpm test:unit`,
  `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --all-features`.

## 9. Risks & mitigations

1. **BPE version skew** between `js-tiktoken` and `tiktoken-rs`
   (cl100k_base merges/ranks differ by snapshot) → golden vectors + pinned
   versions; document tolerance policy; keep TS path for browser mode.
2. **Browser-only dev regression** (Rust absent) → every Rust-backed feature
   keeps the existing TS implementation as fallback; vitest runs the fallback
   path in CI.
3. **IPC round-trip overhead for small strings** can exceed native speedup →
   batch APIs (`tokenize_estimate_tool_set` counts whole arrays in one call),
   memoize on Rust side if needed; do not add IPC for per-word counting.
4. **Registry/handler closures cannot move to Rust** → keep
   `registry.ts`/`dispatch.ts` as the TS seam; only move pure logic. Don't
   force a full catalog migration.
5. **Static data duplication** (TOOLSETS in TS and Rust) drifts → parity
   tests enumerate every static key + member; optionally generate one side
   from the other in CI (out of scope for this plan, flagged).
6. **js-tiktoken removal changes web bundle** → confirm no other consumers
   (verified: only `token-estimate.ts` imports it); remove the devDependency
   only after Phase 1 parity is green.
7. **`tools_dispatch` command doesn't exist yet** → do not activate the
   `dispatch.ts` Rust-fallback path as part of this plan; file a follow-up if
   needed.
8. **Agent-core coordination** → Phase 1 lands `src/tokenize/` first and
   exposes the API the sibling plan will consume; keep the module small and
   dependency-light.

## 10. Effort estimate (S/M/L per phase)

| Phase | Scope | Estimate |
|---|---|---|
| 1 | `src/tokenize/` + tiktoken-rs + `tokenize_*` commands + TS wrapper | S–M |
| 2 | `src/toolkit/types.rs` + `schema.rs` + parity fixtures | M |
| 3 | `src/toolkit/toolsets.rs` + `toolsets_resolve` command | M |
| 4 | `src/toolkit/platform.rs` + `platform_tools_resolve` command | S–M |
| 5 | `src/toolkit/ha_security.rs` + `ha_proxy` wiring | S |
| 6 | Definition pipeline consolidation + optional `tools_dispatch` | L (likely deferred) |

Total realistic first pass (Phases 1–5): **M–L** across the crate, each phase
independently shippable. Total if Phase 6 is included: **L+**.
