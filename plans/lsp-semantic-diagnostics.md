# LSP (Semantic Diagnostics) — Python → TypeScript Rewrite Plan

## 1. Summary

Port the Python LSP layer (`D:/hermes-agent-cn/agent/lsp/`) into the Desktop
TypeScript monorepo so post-write semantic lint for `write_file`/`patch` runs
in-process without the managed Python runtime / WebSocket link. Real language
servers (pyright, tsserver via `typescript-language-server`, gopls,
rust-analyzer, clangd, and the full 27-entry registry) are spawned lazily as
background subprocesses; their `textDocument/publishDiagnostics` feed a
**delta baseline** filter so the agent only sees errors introduced by the
current edit. The feature is **git-workspace gated** (no spawn outside a git
worktree), **lazy-spawned**, and **idle-reaped** (default 600s). The TS side
implements the full LSP client protocol over stdio (JSON-RPC), while Rust owns
process spawn/stdin/stdout and streams bytes over Tauri IPC — the webview
cannot spawn processes directly. `hermes lsp` CLI becomes an in-app settings /
command-palette surface plus Rust-managed binary install.

Key design decisions:

- **Protocol logic in TypeScript** (`web/src/lib/lsp/`), process lifecycle in
  Rust (`src/commands/lsp.rs` + `src/process/`), mirroring the README end-state
  ("Rust stays for OS-level capabilities … invoked via Tauri IPC").
- Use npm `vscode-jsonrpc` / `vscode-languageserver-protocol` for framing +
  types instead of re-writing `agent/lsp/protocol.py`; the Python docstring
  explicitly names `vscode-jsonrpc/node` as its TS equivalent.
- Port the manager state machine **exactly**: one client per
  `(server_id, workspace_root)`, broken-set for failed spawns, version-tagged
  diagnostic freshness (anti ghost-diagnostics), baseline snapshot before
  write + range-shifted delta after, idle reaper with a 30s floor.
- kimi-code has **no LSP client** (verified: zero source imports); the client
  is designed from scratch, but `diff` (used by kimi-code) replaces
  `difflib.SequenceMatcher` for line-shift.

## 2. Current Python implementation

Source of truth under `D:/hermes-agent-cn/agent/lsp/` (10 modules):

| Module | Role |
|---|---|
| `protocol.py` | Content-Length JSON-RPC 2.0 framer (orjson; `encode_message`, `read_message`, `classify_message`, error codes). |
| `client.py` | Async `LSPClient` per `(server_id, workspace_root)`: spawn + initialize, `open_file`/`save_file` (didOpen/didChange/didSave + `workspace/didChangeWatchedFiles` touch-file dance), wait-for-fresh-diagnostics (push+pull, `PUSH_DEBOUNCE=0.15`), version-tagged `_DocState` freshness, `ContentModified` retry (3× 0.5/1/2s), graceful shutdown. |
| `manager.py` | `LSPService` singleton over a background asyncio loop: `enabled_for`, `snapshot_baseline`, `get_diagnostics_sync(delta=True, line_shift=…)`, `_get_or_spawn` (lazy, broken-set), idle reaper (`DEFAULT_IDLE_TIMEOUT=600`, `MIN_IDLE_TIMEOUT=30`), `get_status`. |
| `servers.py` | `SERVERS` registry — **27 ServerDefs** (pyright, typescript, vue/svelte/astro, gopls, rust-analyzer, clangd, bash/yaml/lua, intelephense, ocaml-lsp, dockerfile-ls, terraform-ls, dart, haskell, julia, clojure-lsp, nixd, zls, gleam, elixir-ls, prisma, kotlin, jdtls, powershell-PSES); extension→languageId map; per-server spawn builders + root resolvers (nearest-root markers / exclude markers). |
| `workspace.py` | Git-workspace gate (`find_git_worktree`, `resolve_workspace_for_file`) + `nearest_root` marker walk with exclude semantics; path cache. |
| `range_shift.py` | `build_line_shift(pre, post)` via `difflib.SequenceMatcher.get_opcodes()`; `shift_baseline` remaps pre-edit diagnostics into post-edit coordinates before the delta set-difference. |
| `reporter.py` | Severity-filtered `<diagnostics file=…>` block (ERROR-only default, 20/file, 4000 chars, HTML-escaped + field-capped anti-prompt-injection sanitizer). |
| `eventlog.py` | Deduplicated INFO/WARNING logging (`hermes.lint.lsp`); `reset_announce_caches` for tests. |
| `install.py` | `INSTALL_RECIPES` (npm/go/manual) + `try_install` into `<HERMES_HOME>/lsp/bin/`; `detect_status` for the CLI. |
| `cli.py` | `hermes lsp {status|list|install|install-all|restart|which}` — `status --json` shape is the frozen introspection surface. |

Integration point (NOT `tools/file_tools.py`, which only documents the field):
`D:/hermes-agent-cn/tools/file_operations.py`:

- `WriteResult.lsp_diagnostics: Optional[str]` (line ~372/2647) and
  `PatchResult` equivalents (line ~2812).
- `_snapshot_lsp_baseline(path)` (line ~3100) — called BEFORE the write.
- `_maybe_lsp_diagnostics(path, pre_content, post_content)` (line ~3123) — called
  AFTER the write only when the syntax tier was clean; builds the line-shift,
  calls `svc.get_diagnostics_sync(path, delta=True, line_shift=…)`, formats via
  `report_for_file` + `truncate("LSP diagnostics introduced by this edit:\n"+block)`.
- `_lsp_local_only()` gates on non-local backends (Docker/Modal/SSH skip LSP).

Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/lsp.md` (301 lines —
architecture, supported-language table, config YAML, perf characteristics).

## 3. Target TypeScript design

Module layout under `D:/Hermes-CN-Desktop/web/src/lib/lsp/` (mirrors the
Python modules one-to-one):

```
web/src/lib/lsp/
  types.ts          // Diagnostic, Range, ServerDef, SpawnSpec, LspConfig (zod)
  protocol.ts       // thin re-export/wrappers over vscode-jsonrpc framing (or use lib directly)
  client.ts         // LspClient: spawn/initialize/didOpen/didChange/didSave/wait/shutdown
  manager.ts        // LspService: lazy spawn, broken set, delta baseline, idle reaper
  servers.ts        // 27-entry registry + spawn spec builders + root resolvers
  workspace.ts      // git-worktree gate + nearestRoot (calls Rust git command)
  range-shift.ts    // buildLineShift(pre, post) via npm `diff`
  reporter.ts       // <diagnostics file=…> formatter + sanitizer
  eventlog.ts       // dedup'd structured logging to existing app logger
  config.ts         // load lsp.* from config.yaml via existing config libs
  process-transport.ts // ProcessTransport interface: Rust IPC bridge impl + MockProcessTransport for tests
  cli.ts            // in-app "hermes lsp" surface (status/list/install/restart/which)
```

Rust additions in `D:/Hermes-CN-Desktop/src/`:

- `src/commands/lsp.rs` — Tauri commands: `lsp_spawn(serverId, root, cmd, env,
  cwd, initOptions)` → `{processKey}`; `lsp_write_stdin(processKey, bytesBase64)`;
  `lsp_shutdown(processKey)` (graceful shutdown+exit then TERM/KILL);
  `lsp_probe_binary(name)` (staging dir + PATH, Windows suffix handling);
  `lsp_install(pkgId)` (npm/go install into `<HERMES_HOME>/lsp/bin`, port of
  `install.py`); `lsp_status()`.
- `src/process/lsp.rs` (or extend `src/process/`) — owns the `std::process::Child`
  with piped stdin/stdout/stderr; a tokio task reads stdout bytes and forwards
  them to the TS side over a Tauri **event** (`lsp:stdout:<processKey>`) or a
  Tauri `Channel`; stderr drains to the app log. Mirrors Python's
  `start_new_session=True` (process group) and `windows_hide_flags()`
  (`CREATE_NO_WINDOW`) + `.cmd`/`.bat` shim wrapping (`_win_wrap_cmd`).
- `src/supervisor.rs` pattern reuse for crash-loop guard (optional: treat
  repeated spawn failures as broken-set entries instead of respawning).

Data flow (in-process, no Python):

```
write_file (TS file tool)
  ├─ pre:  LspService.snapshotBaseline(path)      # open + wait, store diags
  ├─ write atomically
  └─ post: if syntax clean → LspService.getDiagnosticsSync(path, delta, lineShift)
               → client.openFile + saveFile + waitForDiagnostics (fresh only)
               → filter baseline (range-shifted) → reporter → lsp_diagnostics field
```

`LspClient` runs on the JS event loop; all per-process I/O is async over the
Rust transport. The transport exposes a `ReadableStream<Uint8Array>`-like
interface so the client is fully testable in vitest with a mock transport that
speaks the same framed JSON-RPC.

### Key state machine (port faithfully from `manager.py`)

- `clients: Map<"serverId\0root", LspClient>` + `lastUsed` timestamps.
- `broken: Set<"serverId\0root">` — never retried for process lifetime;
  cleared by `restart`.
- `spawning: Map<key, Promise<LspClient|null>>` — dedupe concurrent spawns.
- `deltaBaseline: Map<absPath, Diagnostic[]>` + `lineShift` remap.
- `_DocState {version, text, push, pull, pushVersion, pullVersion}` — a result
  is fresh iff its version tag ≥ current doc version (kills ghost diagnostics).
- Idle reaper: interval `min(60, idleTimeout)`; reaps `now - lastUsed > idleTimeout`
  (floor 30s; 0 disables); shutdown is `shutdown` request → `exit` → TERM → KILL.

## 4. Data models & persistence

No SQLite/IndexedDB persistence — LSP state is process-lifetime in-memory (same
as Python). Models:

```ts
interface Diagnostic {
  severity: 1|2|3|4; code?: string|number; source?: string;
  message: string; range: { start: {line:number; character:number};
                            end: {line:number; character:number} };
}
interface LspConfig {
  enabled: boolean; waitMode: "document"|"full"; waitTimeout: number;
  installStrategy: "auto"|"manual"|"off"; idleTimeout: number;
  servers: Record<string, {disabled?: boolean; command?: string[]; env?: Record<string,string>;
                           initializationOptions?: unknown}>;
}
```

Zod schemas live in `packages/protocol/src/lsp.ts` (new) so Rust, web, and the
future agent-core can share `Diagnostic`, `WriteResult` (extended with optional
`lsp_diagnostics: string|null`), and the `hermes lsp status --json` payload
(`{service:{enabled,wait_mode,wait_timeout,install_strategy,clients[],broken[],disabled_servers[]},
registry:[{server_id,extensions,description,binary_status}]}`).

Config is read from the existing `config.yaml` (Desktop already edits it via
`web/src/lib/config-update.ts` / `update-config.ts`); defaults match `lsp.md`.
No migrations needed; the `lsp:` block is additive.

## 5. Third-party library strategy

| Python dep/feature | TS equivalent | Evidence |
|---|---|---|
| `protocol.py` framer (orjson framing) | **`vscode-jsonrpc`** (npm, ^8.x) + `vscode-languageserver-protocol` for message types | Python docstring: "This module replaces what `vscode-jsonrpc/node` would do in a TypeScript implementation." kimi-code source has NO direct use, but a stale `dist-web` bundle contains `vscode-jsonrpc@8.2.0` + `vscode-languageserver-types@3.17.5` (not in `pnpm-lock.yaml` → transitive artifact, still proves availability). |
| `difflib.SequenceMatcher` (range_shift) | npm **`diff`** (use `diffLines`/`diffArrays` opcodes → build piecewise line map) | kimi-code `apps/vscode/package.json` + `apps/kimi-code/package.json` both depend on `diff` (`^8.0.2` / `^8.0.2`). |
| `orjson` (compact JSON) | built-in `JSON.stringify` (compact by default) | n/a |
| `asyncio` subprocess / background loop | Rust `std::process::Command` + tokio reader task; TS native async | Desktop `src/commands/git.rs` (Stdio::piped pattern), `src/commands/hot_update.rs`; Tauri `invoke` + event `Channel` (`web/src/lib/tauri-bridge.ts`). |
| `shutil.which` / PATH probe | Rust probe command `lsp_probe_binary` (checks `<HERMES_HOME>/lsp/bin` + PATH + `.cmd/.exe/.bat` suffixes) | port of `install.py:_existing_binary` |
| `threading` + `asyncio.run_forever` | single-threaded JS event loop (no port needed) | n/a |
| `html.escape` sanitizer | small hand-rolled `escapeHtml` + field caps (port `reporter.py:_sanitize_field` verbatim) | no dep needed |
| `argparse` CLI | settings route + command palette (`web/src/routes/settings.tsx`, `web/src/lib/builtin-commands.ts`) | existing Desktop UI patterns |

**No TS equivalent found (from-scratch):** the LSP *client* itself —
kimi-code has no language-server integration (`grep` for
`vscode-languageserver`, `LanguageServer`, `tsserver`, `gopls`, `pyright` in
source: 0 hits). We build `LspClient` on top of `vscode-jsonrpc`; only the
framing layer is reused, all LSP semantics (initialize handshake, didOpen/
didChange/didSave + watched-files touch, push+pull wait loop, version
freshness, ContentModified retry) are ported from `client.py`. Also from
scratch: the Rust↔webview byte-pipe transport (no existing Tauri command
streams raw child stdout into JS today).

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Tauri IPC**: `web/src/lib/tauri-bridge.ts` (`invokeCommand`) for
  `lsp_spawn`/`lsp_write_stdin`/`lsp_shutdown`/`lsp_probe_binary`/`lsp_install`;
  new `packages/protocol/src/channels.ts` entries for `lsp:stdout:<key>`
  events (or a typed `Channel` payload).
- **Git gate**: reuse `src/commands/git.rs` (60+ git commands; `git rev-parse
  --show-toplevel` equivalent) — add one command `git_worktree_root(path)` for
  the workspace gate, or implement the `.git` upward walk in TS against a small
  `fs`-capable Rust command; keep Python's cwd-first-then-file resolution.
- **File tools**: the desktop has **no web-side file tools yet** (verified:
  no `write_file` in `web/src`); the plan assumes the in-process file-tools
  port (separate plan) provides `write_file`/`patch` and calls
  `LspService.snapshotBaseline`/`getDiagnosticsSync` exactly like
  `file_operations.py`. Result schema in `packages/protocol/src/hermes-api.ts`
  gains `lsp_diagnostics`.
- **Settings UI**: `web/src/routes/settings.tsx` LSP section (enabled,
  wait_mode, wait_timeout, idle_timeout, per-server command/env/init
  overrides, install buttons); `web/src/lib/config-update.ts` writes the
  `lsp:` block.
- **Status surface**: `hermes lsp status` parity → in-app "LSP" panel driven
  by `lsp_status()` (active clients, broken pairs, per-server install status);
  optional `web/src/lib/cli-delegation.ts`-style handling if the Python CLI
  still exists during migration.

## 7. Removing the WebSocket dependency (migration path)

Today `write_file`/`patch` execute in the managed Python runtime; the web app
sees results over the WS JSON-RPC gateway (`web/src/lib/gateway-client.ts`).
Freeze this API surface during migration:

1. `WriteResult.lsp_diagnostics` / `PatchResult.lsp_diagnostics` field (string
   `<diagnostics>` block or null) — both the WS payload and the in-process
   result MUST serialize identically.
2. `lint.status|output` semantics (syntax tier) — LSP layer only runs when the
   syntax tier is clean; keep this invariant.
3. `hermes lsp status --json` payload shape (`cli.py:_cmd_status`) — used by
   the settings panel and any automation.

Phases:

- **P1** Implement TS `LspService` + Rust transport + mock transport; run it
  side-by-side in the dashboard (status panel only); keep Python path serving
  tool calls.
- **P2** In-process file tools (write_file/patch) call the TS LSP layer behind
  the same `LspService` interface; WS path still exists for other features.
- **P3** Delete the WS/REST path for file tools (and Python LSP usage); managed
  runtime no longer needed for semantic diagnostics.

## 8. Migration phases & task breakdown

1. **P0 — foundation**: `packages/protocol/src/lsp.ts` (zod schemas);
   `web/src/lib/lsp/protocol.ts` (vscode-jsonrpc integration); Rust
   `src/commands/lsp.rs` spawn/write/shutdown + stdout event streaming;
   `process-transport.ts` + `MockProcessTransport`; vitest fixtures porting
   `_mock_lsp_server.py` → `tests/lsp/_mock_lsp_server.ts` (scripts:
   clean/errors/crash/slow/stale/slow_push).
2. **P1 — client**: `client.ts` port (initialize, doc sync, touch-file dance,
   push+pull wait, freshness, ContentModified retry, shutdown); unit tests
   mirroring `test_client_e2e.py`, `test_stale_diagnostics.py`,
   `test_protocol.py`.
3. **P2 — service**: `manager.ts` (lazy spawn, broken set, delta baseline +
   `range-shift.ts`, idle reaper, status); tests mirroring `test_service.py`,
   `test_broken_set.py`, `test_lifecycle.py`, `test_delta_key.py`,
   `test_workspace.py`, `test_backend_gate.py`.
4. **P3 — registry + install**: `servers.ts` (27 ServerDefs + spawn builders +
   root resolvers); Rust `lsp_probe_binary`/`lsp_install` (npm/go staging into
   `<HERMES_HOME>/lsp/bin`); tests for `test_powershell_server.py`,
   `test_install_and_lint_fixes.py`, `test_shell_linter_lsp_skip.py`.
5. **P4 — tool wiring**: `file_tools.ts` post-write hook; `reporter.ts` +
   `eventlog.ts`; `WriteResult.lsp_diagnostics` rendering; tests mirroring
   `test_diagnostics_field.py`, `test_reporter.py`, `test_eventlog.py`.
6. **P5 — UI/CLI**: settings LSP panel; in-app status/list/install/restart;
   `lsp.md`-style help text; E2E.

## 9. Risks & open questions

- **No TS equivalent found (highest risk)**: kimi-code has no LSP client; we
  build the client from scratch on `vscode-jsonrpc`. Porting the freshness
  model incorrectly re-introduces ghost diagnostics — this is the main
  correctness risk; cover with `stale`/`slow_push` parity tests.
- **Webview cannot spawn processes**: all stdio goes through Rust IPC; adds
  backpressure/ordering concerns. Rust must stream raw stdout bytes without
  mangling binary-safe JSON (`Channel<Vec<u8>>` base64 or raw bytes); Python's
  `start_new_session` + `CREATE_NO_WINDOW` + `.cmd` wrapping must be reproduced
  on Windows or tsserver/pyright `.cmd` shims flash console windows / get
  killed by process-group sweeps.
- **Binary management**: `install.py` (npm/go install into Hermes-owned
  staging) must be re-implemented in Rust or delegated to the managed runtime
  during migration; PATH detection differs on Windows (`.cmd/.exe/.bat`).
- **Per-server quirks**: PSES (PowerShell) bootstrap bundle discovery, clangd
  args, typescript-language-server's `typescript` peer dependency — port the
  exact `servers.py` builders.
- **Test-spec discrepancy**: the task mentioned `tests/hermes_cli/test_lsp*.py`;
  verified **no such files exist** in Core — parity tests must come from the 14
  `tests/agent/lsp/` files + the mock server only.
- **Open question**: where should in-process file tools live (this plan assumes
  a separate file-tools port); confirm the `diff` opcode mapping matches
  `SequenceMatcher` delete/replace semantics for range-shift edge cases.

## 10. Test strategy

- **Vitest unit** (`web/src/lib/lsp/__tests__/`): framer round-trip
  (`test_protocol.py`), workspace gate + nearestRoot (`test_workspace.py`),
  broken set (`test_broken_set.py`), delta key / range-shift
  (`test_delta_key.py`), reporter sanitization + caps (`test_reporter.py`),
  eventlog dedup (`test_eventlog.py`), idle reaper thresholds
  (`test_lifecycle.py`).
- **Integration with mock server** (`tests/lsp/_mock_lsp_server.ts`, Node
  script with MOCK_LSP_SCRIPT env): drive `LspClient`/`LspService` through a
  `MockProcessTransport`; cover clean/errors/crash/slow/stale/slow_push —
  parity for `test_client_e2e.py`, `test_stale_diagnostics.py`,
  `test_service.py`, `test_install_and_lint_fixes.py`, `test_backend_gate.py`.
- **Rust tests** for `lsp.rs`: spawn/probe/install on Windows suffixes,
  `.cmd` shim wrap, stdout streaming, shutdown TERM→KILL.
- **Playwright E2E**: dashboard write_file on a `.py` fixture in a git
  workspace surfaces `<diagnostics file=…>` with only NEW errors; settings
  panel status/install flow; `lsp.enabled:false` falls back to syntax-only.
- **Parity**: one vitest file per Python `tests/agent/lsp/test_*.py` (14),
  asserting identical outcomes on the shared mock-server script.

## 11. Reference links

- Core: `D:/hermes-agent-cn/agent/lsp/{protocol,client,manager,servers,workspace,range_shift,reporter,eventlog,install,cli}.py`
- Core tools: `D:/hermes-agent-cn/tools/file_operations.py` (lines ~2600–3190)
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/lsp.md`
- Tests: `D:/hermes-agent-cn/tests/agent/lsp/` (14 test files + `_mock_lsp_server.py`)
- kimi-code: `apps/vscode/package.json`, `apps/kimi-code/package.json`
  (npm `diff` evidence; no LSP client — verified by source grep + pnpm-lock)
- Desktop: `src/commands/git.rs`, `src/process/`, `src/supervisor.rs`,
  `web/src/lib/tauri-bridge.ts`, `web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts`, `packages/protocol/src/{hermes-api,channels}.ts`,
  `web/src/routes/settings.tsx`, `web/src/lib/config-update.ts`
- LSP spec: `https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/`
- npm: `vscode-jsonrpc`, `vscode-languageserver-protocol`, `diff`
