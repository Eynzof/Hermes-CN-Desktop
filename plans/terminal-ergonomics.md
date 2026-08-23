# Terminal Ergonomics — Python → TypeScript Rewrite Plan

## 1. Summary

Port the Hermes-CN fork's "terminal ergonomics" surface (FORK_NOTES.zh-CN.md **P-061**,
`D:/hermes-agent-cn/features_report.md` line 170) from the Python gateway into the
in-process TypeScript agent runtime of Hermes-CN-Desktop:

- **Pattern waiting** — blocking `wait_for_pattern`/`process(action='wait', pattern=...)`
  regex wait on *new* output, returns `status='matched'` while the process keeps running.
- **Inactivity timeout** — a silent-but-alive process yields partial output early
  (default 120 s when a pattern is set).
- **Output export** — bounded in-memory capture + full-log spill file (foreground), and
  `output_path`/`'auto'` export of the accumulated buffer (background).
- **Foreground-timeout promotion** — `promote_on_timeout` keeps an over-timeout command
  alive and adopts it as a managed background session instead of killing it (exit 124).
- **Interactive persistent shells** — `mode='interactive'` starts `bash -i` /
  `pwsh -NoLogo -NoExit` on a PTY.
- **Session continuation** — `terminal(command=..., process_id=<session_id>)` writes a
  command to a live session's stdin and returns only the *new* output
  (`since_chars` cursor semantics).

The desktop already owns the terminal PTY (`src/commands/terminal.rs`, portable-pty) and
the xterm.js mirror (`web/src/components/console/embedded-terminal.tsx`). This plan puts a
TS `TerminalManager` + `TerminalWaitService` in the webview so the agent can wait, promote,
continue, and export without any WebSocket round-trip to the Python runtime.

## 2. Current Python implementation

Source of truth (all under `D:/hermes-agent-cn`):

| Concern | File(s) | Key behavior (verified by reading) |
|---|---|---|
| Tool schema + dispatch | `tools/terminal_tool.py` (4349 lines) | `terminal_tool()` signature: `background`, `timeout`, `pty`, `notify_on_complete`, `watch_patterns`, `token_kill`, `max_lines`, `mode`, `interactive`, `promote_on_timeout`, `wait_for_pattern`, `inactivity_timeout`, `process_id`. `TERMINAL_SCHEMA` (line 4219) advertises the same params; `FOREGROUND_MAX_TIMEOUT=600` cap; `_normalize_terminal_mode()` maps kimi aliases (`run/execute/foreground/fg/background/bg/async/detach/interactive/repl/shell`); `_interactive_shell_command()` returns `bash -i` / `pwsh -NoLogo -NoExit` / `powershell -NoLogo -NoExit`; `_continue_background_session()` (line 2740) = `submit_stdin` + `wait(since_chars=baseline, pattern=..., inactivity_timeout=...)`. |
| Blocking pattern wait | `tools/process_registry.py::wait()` (line 2240) | Loops with 1 s `completion_event` poll; compiles regex once (`re.compile`); scans *new* text between `scan_cursor` and buffer length; statuses: `exited`, `matched` (`wait_matched=true`, `matched_pattern`), `output` (since_chars, no pattern → return on first new output), `timeout` (`inactivity_timeout=true` when silent for N s), `interrupted` (user interrupt), `timeout` with `timeout_note`; clamps cursor when the 200 KB window wraps. |
| Inactivity default | `tools/process_registry.py` line 77 | `_DEFAULT_INACTIVITY_TIMEOUT` (120 s) applied when `pattern` set but `inactivity_timeout` omitted. |
| Background buffer / export | `tools/process_registry.py` | `ProcessSession.output_buffer` rolling 200 KB window (`MAX_OUTPUT_CHARS`), `_buffer_append()` sets `_buffer_overflowed`; `read_log(..., output_path=path|'auto')` (line 2151) + `_export_output()` (line 2215) writes full buffer to file, returns `full_output_path`, `output_total_chars`, `output_truncated`; `poll(offset=N)` (line 2067) returns new lines + `total_lines` + `exit_code_meaning`. |
| Foreground→background promotion | `tools/terminal_tool.py` lines 3589–3742 + `tools/environments/base.py` | `prepare_adopt_local()` creates an unregistered session up front; `_session_sink` warms its buffer while streaming; `env.execute(..., wait_for_pattern=..., promote_callback=...)`; `BaseEnvironment._wait_for_process` scans chunks with a 4096-char rolling tail for cross-chunk matches; on pattern hit or timeout the live Popen is adopted via `registry.adopt_local()` and the tool returns `{status:"promoted", session_id, timed_out|pattern_matched, matched_pattern, elapsed_seconds}`; without a promote callback, timeout still kills (exit 124). |
| Foreground spill/truncation | `tools/environments/base.py` (top) | `BoundedOutputCollector(max_chars, spill_path)` tees the full stream to a spill file (cap 5 000 000 chars); foreground result carries `full_output_path`, `output_total_chars`, `output_truncated`, `elapsed_seconds`, `wait_matched`, `original_path`. |
| Desktop UI tools (WS-bridged) | `tools/read_terminal_tool.py`, `tools/read_window_tool.py`, `tools/close_terminal_tool.py`, `tools/terminal_output_stream.py` | `read_terminal`/`read_window_below` route through the tui_gateway blocking-prompt bridge (`terminal.read.request`/`window.read.request`, see `tui_gateway/server.py` lines 3357/6017); `close_terminal` calls `process_registry.request_close_terminal()` → `on_close` sink → `terminal.close` event (tab-only, process keeps running); `terminal_output_stream.py` is a lightweight sink broker for streaming foreground chunks to the UI. |
| Interactive stdin | `tools/process_registry.py::submit_stdin()` (line 2664) | Appends `\r\n` on a Windows PTY (ConPTY cooked input) else `\n`. |

### Data flow today (desktop session)

```
LLM ──> terminal_tool (Python, gateway) ──> env.execute / process_registry
                                              │
read_terminal ──> tui_gateway blocking bridge ──> WS ──> xterm.js buffer (renderer)
close_terminal ──> on_close sink ──> WS "terminal.close" ──> renderer tab
terminal(background=true) ──> mirrored as read-only tab (status stack)
```

## 3. Target TypeScript design

In-process modules under `D:/Hermes-CN-Desktop/web/src/` (agent runs in the Tauri
webview; Rust `src/commands/terminal.rs` stays as the OS PTY owner):

- **`web/src/services/terminal/types.ts`** — `TerminalSession` mirror of
  `ProcessSession`: `{id, command, status: 'running'|'exited'|'promoted'|'lost',
  exitCode, outputBuffer (rolling 200 KB string), bufferOverflowed, sinceCursor,
  completionEvent (Promise/EventTarget), startedAt, commandPreview, ptyHandleRef}`.
  `TerminalWaitResult` union mirroring Python statuses
  (`exited | matched | output | timeout | interrupted | not_found | error`).
- **`web/src/services/terminal/terminalManager.ts`** — owns all sessions. Backend is an
  interface (`TerminalBackend`) with one real implementation that wraps the existing Tauri
  IPC (`window.hermesDesktop.terminalStart/Write/Resize/Close/onTerminalOutput`,
  `web/src/lib/runtime.ts` + `tauri-bridge.ts`) and a fake in-memory backend for vitest.
  It feeds every `terminal-output` chunk into the session ring buffer via
  `appendOutput()` (sets overflow flag) and resolves `completionEvent` on `exit`.
- **`web/src/services/terminal/waitService.ts`** — the port of
  `process_registry.wait()`: `wait(sessionId, {timeout, pattern?, inactivityTimeout?,
  sinceChars?}) → Promise<TerminalWaitResult>`. Implements the scan-cursor loop with
  `AbortController`-based cancellation (user interrupt), cross-chunk regex matching over a
  rolling 4096-char tail, inactivity timer, and cursor-clamp on window wrap.
- **`web/src/services/terminal/promotion.ts`** — foreground→background adoption. On
  `promote_on_timeout`/`wait_for_pattern` the tool creates a pre-registered session, streams
  chunks into it (`output_callback`), and if the wait fires timeout/pattern the *running*
  Rust child is NOT closed; the session transitions to `running` in the manager and the
  tool returns `{status:"promoted", sessionId, ...}`. Rust needs one new capability: a
  "detach without kill" IPC (`terminal_detach`) so the webview can stop owning the pty
  reader while the process lives (or keep the reader and simply stop waiting — see §9).
- **`web/src/services/terminal/export.ts`** — `exportOutput(sessionId, path | 'auto')`
  writing the full accumulated buffer to disk (Rust `tauri-plugin-fs`/`std::fs` write via a
  new IPC `terminal_export`), returning `{fullOutputPath, outputTotalChars,
  outputTruncated}`; foreground bounded capture with head/tail window + optional spill file.
- **`web/src/tools/terminal.ts` / `web/src/tools/process.ts`** — tool adapters exposing
  the *same* JSON schema as `TERMINAL_SCHEMA`/`PROCESS_SCHEMA` but calling the TS services.
  `process(action=...)` maps to manager methods: `list/poll/log/wait/kill/write/submit/close`.
- **`web/src/tools/readTerminal.ts` / `closeTerminal.ts`** — since agent + xterm live in the
  same webview, `read_terminal` reads the live xterm buffer (scrollback lines) directly and
  `close_terminal` drops the mirrored tab without touching the process.

Pseudocode of the continuation path (matches `_continue_background_session`):

```
async function continueSession(processId, command, {timeout, waitForPattern, inactivityTimeout}) {
  const session = manager.get(processId);
  if (!session) return error("No background process with session_id ...");
  if (session.exited) return error("Process ... already exited ...");
  const baseline = session.outputBuffer.length;
  await manager.submitStdin(processId, command);       // \r\n on Windows PTY
  return redact(await waitService.wait(processId, {
    timeout, pattern: waitForPattern, inactivityTimeout, sinceChars: baseline,
  }));
}
```

## 4. Data models & persistence

- **In-memory session state** (primary, mirrors `ProcessSession`): the fields in §3 plus
  `watchPatterns` (rate-limited 1/15 s per session), `notifyOnComplete` flag,
  `completionConsumed` set, and `detached`/`lost` flags for app-restart recovery.
- **Output durability**: full logs live on disk under the runtime temp dir
  (mirror `_get_session_temp_dir()` → `{runtime}/tmp/terminal/`) as
  `<sessionId>_output.txt`; a small JSON sidecar `<sessionId>.json` persists
  `{id, command, startedAt, exitCode?, completionReason, bufferOverflowed,
  outputTotalChars}` so a reopened app can list/recover sessions (Rust SQLite is already
  available; a JSON file is enough for design). The 200 KB in-memory window remains
  authoritative for live waits; export reads the disk copy when present.
- **Schema migrations**: new only — a `terminal_sessions` table (if SQLite is chosen) or a
  JSON manifest; no migration of existing WS-era records needed because sessions are
  ephemeral by contract (`HERMES_SESSION_KEY` scope, cleanup on app exit like
  `_start_cleanup_thread()`).
- **Protocol**: extend `web/src/lib/runtime.ts` types (`TerminalStartInput/Result`,
  `TerminalEventPayload`) with `terminalDetach`, `terminalExport`, and a
  `terminal.read` direct-buffer shape; keep `packages/protocol` free of new schemas until
  the WS path is deleted (see §7).

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence in `D:/kimi-code` |
|---|---|---|
| `portable-pty` (Rust) / `ptyprocess` / `pywinpty` | **Already owned**: Rust `portable-pty` in `D:/Hermes-CN-Desktop/src/commands/terminal.rs`; node-pty is kimi's equivalent | `packages/agent-core/src/services/terminal/terminalService.ts` `NodePtyTerminalBackend` (spawn shell, onData/onExit/write/resize/kill); `apps/kimi-code/src/native` hosts the node-pty wiring |
| PTY session read/replay (attach, seq cursor) | `TerminalService.attach({sinceSeq})` frame replay — kimi analog of our `since_chars` cursor for UI attach | `terminalService.ts` lines 113–127 (`replay = buffer.filter(frame => frameSeq(frame) > sinceSeq)`) |
| Foreground timeout → keep alive (promote) | **`autoBackgroundOnTimeout`** — kimi's exact analog: foreground task that hits its deadline is detached to background (re-armed `detachTimeoutMs`) instead of killed | `packages/agent-core/src/tools/builtin/shell/bash.ts` lines 158–163, 383–390, 414–435; `packages/agent-core/src/agent/background/index.ts` `RegisterBackgroundTaskOptions.autoBackgroundOnTimeout` |
| Rolling buffer + full-log persistence / export | `BackgroundManager` ring buffer (1 MiB) + disk `output.log` at `<sessionDir>/tasks/<id>/output.log`; `TaskOutputTool` returns `output_path`, `outputTruncated`, `fullOutputAvailable` | `packages/agent-core/src/agent/background/index.ts` lines 128–151, 184–201; `packages/agent-core/src/tools/background/task-output.ts` lines 36–78, 105–134 |
| `threading.Event` wait loop / interrupts | TS `AbortController` + `EventTarget`/`ControlledPromise` polling (kimi's `waitForForegroundRelease` uses `ControlledPromise`) | `packages/agent-core/src/agent/background/index.ts` (`foregroundRelease?: ControlledPromise<...>`); `packages/agent-core/src/utils/promise.ts` |
| `re` regex | Native `RegExp` (JS syntax differs: `(?P<name>)` → `(?<name>)`, lookbehind ok) — **thin shim** `compilePattern()` with try/catch → `error` result | no kimi analog needed; kimi uses zod + literal matching |
| `orjson`/`json` | Native `JSON` | n/a |

**No TS equivalent found (implement from scratch — the core of this feature):**

1. **Blocking pattern wait** (`wait_for_pattern` / `process(action='wait', pattern=...)`).
   kimi-code has *push* notifications (`watch_patterns` analog is absent too; kimi's
   background completion is notification-only) but no blocking regex wait with
   `status='matched'` while the process runs.
2. **Inactivity timeout early-return** — no `DEFAULT_INACTIVITY_TIMEOUT` equivalent.
3. **Session continuation via stdin + new-output cursor** (`process_id` + `since_chars`
   returning only new output as a *tool result*). kimi's `TerminalService.write()` can send
   input, and attach replays frames, but no tool composes "write → wait for new output →
   return only new output".
4. **Desktop UI tools** (`read_terminal`, `close_terminal`, foreground output streaming
   sink) — kimi's TUI reads its own task output; no analog for reading another embedded
   terminal's buffer or closing a mirror tab without killing.

These four get `web/src/services/terminal/waitService.ts` + `promotion.ts` + the tool
adapters designed from scratch, with parity tests against the Python behavior.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse**: `web/src/components/console/embedded-terminal.tsx` (xterm.js widget with
  `runCommand/close/hasTerminal` imperative handle and `TerminalStatus` lifecycle),
  `web/src/routes/console.tsx` (Console route driving it), `web/src/lib/tauri-bridge.ts`
  (`terminalStart/terminalWrite/terminalResize/terminalClose/onTerminalOutput` + event
  `terminal-output`), `web/src/lib/runtime.ts` (`TerminalEventPayload`, `TerminalStartResult`),
  Rust `src/commands/terminal.rs` (spawn/read/write/resize/close, `TerminalSession`,
  reader thread → `terminal-output` events).
- **Add**: a read-only "agent terminal tab" stack mirroring `terminal(background=true)`
  sessions (Python today mirrors these via `terminal.close` events; the TS manager emits the
  same event shape so the existing tab component can stay), plus toolbar actions for
  `close_terminal` (drop tab) and "export output" (download/`terminal_export`).
- **Rust additions (small)**: `terminal_detach` (stop mirroring without killing) and
  `terminal_export` (write buffer to a user path). Both reuse existing session map + writer
  plumbing; no new crate (portable-pty already present).
- **Watch pattern UI**: background `watch_patterns` notifications keep the same event shape
  as today (`terminal-output`/completion events) so the status stack and watcher turn
  trigger don't change.

## 7. Removing the WebSocket dependency (migration path)

Frozen interface during migration = the JSON tool schemas
(`TERMINAL_SCHEMA` params: `command/mode/interactive/process_id/background/timeout/
promote_on_timeout/wait_for_pattern/inactivity_timeout/workdir/pty/notify_on_complete/
watch_patterns/token_kill/max_lines`; `PROCESS_SCHEMA` params: `action/session_id/data/
timeout/pattern/inactivity_timeout/block/output_path/offset/limit`) and the result fields
(`status/session_id/wait_matched/matched_pattern/elapsed_seconds/output_total_chars/
output_truncated/full_output_path/hint/exit_code_meaning`). Models depend on these exact
strings, so the WS era and in-process era are interchangeable.

- **Phase A (today)**: Python backend + WS; TS adapter delegates to gateway-client.
- **Phase B**: implement `TerminalManager`/`WaitService` in-process behind an interface
  identical to the tool schema; add a `runtime: 'inprocess' | 'ws'` switch in the tool
  registry (`web/src/lib/transport.ts`).
- **Phase C**: flip desktop-sourced sessions to in-process; delete
  `terminal.read.request/respond`, `window.read.request/respond`, `terminal.close`
  WS handlers in `tui_gateway/server.py` usage; `read_terminal` reads the xterm buffer
  directly.
- **Phase D**: remove the Python-side `desktop_ui` toolset registration for desktop
  sessions and the WS JSON-RPC route; Rust stays as pure OS-capability layer.

## 8. Migration phases & task breakdown

1. **Schema freeze + parity test harness** — port the 23 tests from
   `tests/tools/test_terminal_process_llm_ergonomics.py` to vitest as the contract.
2. **TerminalBackend + TerminalManager** — session registry, ring buffer, completion event,
   `submitStdin` (Windows `\r\n`), `kill`, `poll(offset)`, `readLog(export)`.
3. **WaitService** — pattern/inactivity/since_chars loop; cross-chunk rolling tail;
   interrupt via AbortController.
4. **Promotion + interactive + continuation** — `promote_on_timeout`, `mode='interactive'`
   default shell, `process_id` continuation; Rust `terminal_detach`.
5. **Tool adapters** — `terminal`/`process`/`read_terminal`/`close_terminal` on the TS
   services; `read_window_below` via existing native window enumeration IPC (Rust), not WS.
6. **UI mirror + export** — read-only tabs, close-tab-only action, output export action.
7. **Cutover & WS deletion** — flip `runtime: 'inprocess'`, remove WS paths, gate by
   `HERMES_DESKTOP_TERMINAL=1` env parity.

## 9. Risks & open questions

- **No TS equivalent for the core surface** (pattern wait, inactivity, continuation): the
  design is a from-scratch port. JS `RegExp` differs from Python `re` (named groups,
  flags, lookbehind); we must reject invalid/unsupported patterns at schema time with the
  same "Invalid regex pattern" error string.
- **Rust pty ownership on promotion**: keeping a Rust child alive after the webview "stops
  waiting" requires either a detach IPC or keeping the reader thread attached and only
  dropping the wait — decide in Phase 4 (open question).
- **Backpressure / memory**: the 200 KB rolling window + 5 MB spill cap must be mirrored
  exactly to preserve `output_truncated` semantics; kimi's 1 MiB ring is not parity.
- **Windows ConPTY**: stdin line endings (`\r\n`) and kill-tree semantics (`taskkill /T /F`)
  are load-bearing — copy `submit_stdin`/`kill_process` behavior.
- **Interrupt semantics**: a user message must abort a wait with `status='interrupted'`
  (Python polls `tools.interrupt.is_interrupted`); TS needs an app-level abort signal wired
  from the chat input, not just per-call timeouts.
- **`tests/run_agent/test_terminal*.py` does not exist** in `D:/hermes-agent-cn`
  (features_report cites it; actual run_agent terminal coverage is in
  `test_interactive_interrupt.py`, `test_empty_terminal_reasoning_surface.py`, etc.) —
  parity tests must target the tool-level tests that do exist.
- **Watch-pattern rate limit** (1/15 s, auto-disable after strikes) is subtle; keep as a
  unit-test-only surface initially.

## 10. Test strategy

- **Vitest unit (parity)**: port `tests/tools/test_terminal_process_llm_ergonomics.py`
  (23 tests) — pattern match while running / exit-without-match / invalid regex; inactivity
  early-return + default cap; `since_chars` new-output-only; `read_log` export
  (`output_path` + `'auto'`) + truncation metadata; `poll(offset)` + `exit_code_meaning`;
  adoption E2E with a real child process (timeout-promote stays alive & killable; pattern
  promote; no-callback still kills 124); mode normalization aliases; interactive shell
  command; real session continuation (stdin `hello` → only new output); error paths;
  schema-surface assertions (`TERMINAL_SCHEMA`/`PROCESS_SCHEMA` params present).
- **Vitest unit (extra)**: cross-chunk regex match (4096-char boundary), cursor clamp on
  window wrap, watch-pattern rate limiting, Windows `\r\n` submit, redaction of process
  results (`_redact_process_result` parity).
- **Integration**: `Bash`/`process` against a real portable-pty-backed backend in vitest
  (node `child_process` stand-in) + Rust unit tests for `terminal_detach`/`terminal_export`.
- **Playwright E2E**: Console route — interactive shell, run command, continuation tab,
  close-tab-without-kill, export output, interrupt aborts a wait.
- **Parity sources**: `tests/tools/test_terminal_process_llm_ergonomics.py` (read fully);
  also `tests/tools/test_terminal_tool.py`, `test_terminal_timeout_output.py`,
  `test_terminal_foreground_timeout_cap.py`, `test_terminal_truncation_spill.py` (confirmed
  to exist; reuse their assertions where behavior overlaps).

## 11. Reference links

- `D:/hermes-agent-cn/FORK_NOTES.zh-CN.md` — P-061 (lines 799–821), P-013 (param aliases)
- `D:/hermes-agent-cn/features_report.md` — line 170 "Terminal ergonomics"
- `D:/hermes-agent-cn/tools/terminal_tool.py` — schema, promotion, continuation
- `D:/hermes-agent-cn/tools/process_registry.py` — wait/read_log/poll/submit_stdin,
  `PROCESS_SCHEMA` (line 3356)
- `D:/hermes-agent-cn/tools/environments/base.py` — `BoundedOutputCollector`, spill,
  `_wait_for_process` promotion hooks
- `D:/hermes-agent-cn/tools/read_terminal_tool.py`, `read_window_tool.py`,
  `close_terminal_tool.py`, `terminal_output_stream.py` — desktop_ui WS-bridged tools
- `D:/hermes-agent-cn/tui_gateway/server.py` — blocking-prompt bridge
  (`terminal.read.request/respond`, `window.read.request/respond`)
- `D:/hermes-agent-cn/tests/tools/test_terminal_process_llm_ergonomics.py` — parity source
- `D:/kimi-code/packages/agent-core/src/services/terminal/terminalService.ts`,
  `terminal.ts` — node-pty + attach/sinceSeq replay
- `D:/kimi-code/packages/agent-core/src/tools/builtin/shell/bash.ts` —
  autoBackgroundOnTimeout, timeout caps, background metadata
- `D:/kimi-code/packages/agent-core/src/agent/background/index.ts`,
  `src/tools/background/task-output.ts` — ring buffer, output.log persistence, output_path
- `D:/Hermes-CN-Desktop/src/commands/terminal.rs` — portable-pty spawn/read/write/close
- `D:/Hermes-CN-Desktop/web/src/components/console/embedded-terminal.tsx`,
  `web/src/routes/console.tsx`, `web/src/lib/runtime.ts`, `web/src/lib/tauri-bridge.ts`
