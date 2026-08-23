# Terminal Backends (7) — Python → TypeScript Rewrite Plan

## 1. Summary

Feature: the **terminal execution backend abstraction** — one terminal tool with seven interchangeable
execution environments: `local`, `docker` (persistent container), `ssh`, `singularity` (Apptainer),
`modal`, `daytona`, `vercel_sandbox`. In Python this is `tools/terminal_tool.py` (dispatcher + tool
entry) over `tools/environments/base.py` (`BaseEnvironment` — spawn-per-call `bash -c` with a login
shell snapshot, CWD markers, interrupt/timeout handling) and seven backend modules. Today the Desktop
app reaches this only through the managed Python runtime (REST `/api/ws` + WS JSON-RPC) except the
Console route, which already has a **native local PTY in Rust** (`src/commands/terminal.rs`,
`portable-pty`).

Target: a pure-TypeScript **terminal backend service** in `web/src` that (a) keeps the existing Rust
local PTY for the interactive Console, (b) adds `TerminalBackend` implementations for the six non-local
backends behind one interface, and (c) exposes the same spawn-per-call `execute()` surface the agent
loop uses so the WebSocket link to the Python runtime can be removed. The plan intentionally reuses the
kimi-code terminal architecture (`TerminalBackend` / `TerminalProcess` / attach-replay service) as the
TS shape, extends it with the Python `BaseEnvironment` execution contract (snapshot/CWD persistence,
timeouts, interrupts, background), and ports each backend with the least-surprise transport.

Key decisions:
- **Local stays in Rust.** `portable-pty` already implements the interactive local terminal; TS only
  binds it via `window.hermesDesktop.terminalStart` (existing `tauri-bridge.ts`). No `node-pty` in the
  webview.
- **Remote/cloud backends get a shared `TerminalBackend` that supports two modes**: interactive session
  (pty-ish stream rendered by existing xterm.js) and non-interactive `execute()` (the agent-tool path).
- **SSH is the only backend with a kimi-code TS precedent**: `packages/kaos/src/ssh.ts` (`SSHKaos`) on
  top of npm `ssh2` ^1.17.0, with SFTP file ops. It is Node-only, so on Tauri we route it through Rust
  (`ssh2` crate) or a Node sidecar — see §5.
- **Docker/Singularity are CLI passthroughs** (faithful port of Python's `subprocess`-driven behavior),
  implemented as Rust child-process commands, not browser-side libs.
- **Modal/Daytona/Vercel have no TS SDK in kimi-code** (verified); they are implemented from scratch as
  REST clients in the Rust layer (or TS fetch against their public HTTP APIs), with snapshot/file-sync
  semantics ported from Python.

## 2. Current Python implementation

Source of truth files (all under `D:/hermes-agent-cn`):

- **Dispatcher / tool entry**: `tools/terminal_tool.py` — `terminal_tool()` tool function, env/config
  selection via `TERMINAL_ENV` or `terminal.backend`, `_create_environment(env_type, image, cwd,
  timeout, ssh_config, container_config, local_config, task_id, host_cwd)` factory (~line 1908) mapping
  config keys (`container_cpu/memory/disk/persistent`, `docker_volumes/forward_env/env/extra_args/
  network/run_as_host_user/mount_cwd_to_workspace/shm_size`, `modal_mode`) to backend constructors,
  `cleanup_vm()`, sudo rewriting (`_transform_sudo_command`, `_rewrite_real_sudo_invocations`),
  interactive sudo password prompts, dangerous-command approval (via `tools/approval.py`), disk-usage
  warning, `is_persistent_env()`.
- **Base contract**: `tools/environments/base.py` — `BaseEnvironment(ABC)` with `execute()` (spawn →
  `_run_bash()` → `_wait_for_process()` with interrupt poll + timeout), `init_session()` (captures login
  shell env/functions/aliases into a snapshot file, re-sourced before every command; CWD persists via
  in-band `__HERMES_CWD_<session>__` stdout markers), `_run_bash()` abstract, `cleanup()` abstract,
  `ProcessHandle` protocol, `_ThreadedProcessHandle` (wraps blocking SDK calls in a thread with an
  optional `cancel_fn`), `EnvironmentConnectionError` (→ `status: "degraded"` tool result),
  `_BoundedOutputCollector` (40/60 head-tail window + optional disk spill), `get_sandbox_dir()`.
- **Backends** (`tools/environments/`):
  - `local.py` — `LocalEnvironment`: spawn-per-call `bash -c` / PowerShell on Windows
    (`powershell_session.py`, `process_pwsh.py`, `pwsh_fix.py`), env blocklist + `build_subprocess_env`,
    MSYS/Cygwin path translation, `_resolve_safe_cwd`.
  - `docker.py` — `DockerEnvironment`: CLI subprocess (`find_docker()`, `docker run -d sleep infinity`,
    `docker exec`), cgroup resource limits (`--cpus`, `--memory`, `--pids-limit`, `--shm-size`,
    `--storage-opt`), persistent bind mounts `{sandbox}/docker/{task_id}/{home,workspace}`, tmpfs
    non-persistent mode, orphan-container reaper, session-scoped isolation (`_session_scoped`), egress
    proxy args, `run_as_host_user` security args.
  - `ssh.py` — `SSHEnvironment`: spawn-per-call `ssh … bash -c` with ControlMaster/ControlPersist
    (disabled on Windows — no Unix sockets), `FileSyncManager` sync of `~/.hermes` via `scp`, remote
    home detection.
  - `singularity.py` — `SingularityEnvironment`: `apptainer`/`singularity` CLI, SIF build/cache
    (`_get_or_build_sif`), `--containall --no-home`, overlay-dir persistence, instance lifecycle.
  - `modal.py` — `ModalEnvironment`: Modal Python SDK (`Sandbox.create.aio("sleep","infinity")`),
    `_AsyncWorker` event-loop thread, snapshot restore (`modal_snapshots.json`, legacy key migration),
    credential/skills/cache mounts, bulk upload via base64→tar→stdin pipeline, cancel =
    `sandbox.terminate`. Plus `managed_modal.py` (`ManagedModalEnvironment`, Nous Tool Gateway HTTP
    RPC, selected by `modal_mode: managed|direct|auto` via `tools/tool_backend_helpers.py`).
  - `daytona.py` — `DaytonaEnvironment`: `daytona` Python SDK (`Daytona().create(
    CreateSandboxFromImageParams)`, `sandbox.process.exec`, `sandbox.fs.upload_file(s)/download_file`),
    persistent sandbox resume by name/labels, disk capped at 10 GB, stop-on-interrupt.
  - `vercel_sandbox.py` — `VercelSandboxEnvironment`: `vercel` Python SDK, auth gates
    (VERCEL_TOKEN+PROJECT_ID+TEAM_ID or OIDC), runtimes `node24/node22/python3.13`, disk fixed at
    51200 MB, snapshot store `vercel_sandbox_snapshots.json`, transient-error retry, status polling.
  - `file_sync.py` — `FileSyncManager` (upload `~/.hermes` credentials/skills/cache, `sync_back()` via
    tar archive), `modal_utils.py` (stdin heredoc wrapping), `_process_bash_command.py`, `bash_fix.py`,
    `windows_env.py`.
- **Docs**: `website/docs/user-guide/features/tools.md` — "Terminal Backends" (§56–206): backend table,
  config, non-interactive shell init guidance, Docker persistent-container semantics, SSH env creds,
  Singularity, Modal setup, Vercel auth + snapshot semantics, container resource/security hardening.

Data flow (Python): `terminal_tool(command, cwd, timeout, background, task_id, ...)` → config/env →
`_create_environment()` → `BaseEnvironment.execute()` → `_run_bash()` (subprocess or SDK) →
`_wait_for_process()` (interrupt/timeout/activity heartbeat) → bounded output + exit code JSON envelope.

## 3. Target TypeScript design

Module layout (all under `D:/Hermes-CN-Desktop/web/src` unless noted):

- `lib/terminal/` — new in-process backend service:
  - `types.ts` — `TerminalEnvType` (`'local'|'docker'|'ssh'|'singularity'|'modal'|'daytona'|
    'vercel_sandbox'`), `TerminalBackend`, `TerminalProcess`, `TerminalResult`, `TerminalSession`,
    `TerminalFrame`, `EnvConfig` (per-backend config), `TerminalExecuteOptions`.
  - `factory.ts` — port of `_create_environment`: `createBackend(kind, config, taskId)` returns a
    `TerminalBackend`; unknown/misconfigured kinds raise a structured error with retry hint.
  - `service.ts` — `TerminalService`: session registry (port of kimi-code `TerminalService.records`),
    frame buffer + attach/replay for interactive sessions, and `execute()` for the agent-tool path
    (port of `BaseEnvironment.execute`).
  - `shell/session-snapshot.ts` — port of `init_session` snapshot sourcing + CWD marker parsing for
    remote backends; `shell/wrap-command.ts` — sudo rewrite, heredoc stdin, env injection.
  - `file-sync.ts` — port of `FileSyncManager` (tar archive build/upload, sync-back).
  - `process-handle.ts` — TS `ThreadedProcessHandle` equivalent (wrap blocking REST/SDK calls with
    cancel + stdout pipe).
  - `config.ts` — read backend config from desktop settings (Jotai store + existing config libs).
- Rust (`src/commands/`): `terminal_env.rs` — new Tauri commands `terminal_env_exec(kind, options)`,
  `terminal_env_create_session(...)`, `terminal_env_cleanup(kind, taskId)`; keeps local handled by the
  existing `terminal_start`.

Sketch of the key interfaces (signatures only — no implementation):

```ts
type TerminalEnvType = 'local' | 'docker' | 'ssh' | 'singularity' | 'modal' | 'daytona' | 'vercel_sandbox';

interface TerminalProcess {              // kimi-code parity, extended
  readonly onData: Event<string>;
  readonly onExit: Event<{ exitCode: number | null }>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface TerminalResult {
  output: string;                        // bounded 40/60 head-tail, like _BoundedOutputCollector
  exitCode: number;
  truncated?: boolean;
  spillPath?: string;                    // when output spilled to disk
  degraded?: { reason: string; retryHint: string }; // EnvironmentConnectionError parity
}

interface TerminalBackend {
  readonly kind: TerminalEnvType;
  createSession(opts: { cwd: string; shell?: string; cols?: number; rows?: number }): Promise<TerminalProcess>;
  execute(opts: TerminalExecuteOptions): Promise<TerminalResult>;
  cleanup(): Promise<void>;
}

interface TerminalService {
  execute(kind: TerminalEnvType, cmd: string, opts?: TerminalExecuteOptions): Promise<TerminalResult>;
  create(kind: TerminalEnvType, opts: CreateTerminalRequest): Promise<Terminal>;
  attach/list/get/write/resize/close(...): ...;   // kimi-code ITerminalService parity
}
```

Data flow (target): agent tool call or Console "new backend session" → `TerminalService` →
`factory.createBackend(kind, config, taskId)` → backend-specific transport:
- local: `window.hermesDesktop.terminalStart` (Rust `portable-pty`) — unchanged;
- docker/singularity: Rust `terminal_env_exec` shells to `docker`/`apptainer` CLI (exact port of
  Python's subprocess calls) and returns bounded output;
- ssh: Rust `ssh2` session (or Node sidecar) — exec channel for `execute`, PTY channel for interactive;
- modal/daytona/vercel: Rust REST clients (or TS `fetch`) against the vendor HTTP APIs, with
  `ThreadedProcessHandle`-style cancellation, snapshot store JSON.

## 4. Data models & persistence

- **Interactive session records** stay in-memory (`Map<sessionKey, TerminalRecord>`), exactly like
  kimi-code `TerminalService.records`: terminal metadata, `TerminalProcess`, sink map, bounded frame
  buffer (default 2000 frames), `nextSeq`, closed flag. No DB persistence — sessions die with the app,
  matching Python's "cloud sandbox does not survive Hermes exit" semantics.
- **Backend config**: JSON under the existing desktop settings store (reuse `web/src/lib/config-update.ts`
  pattern); keys mirror Python config (`container_cpu/memory/disk/persistent`, `docker_volumes`,
  `docker_forward_env`, `ssh_host/user/key`, `modal_mode`, `vercel_runtime`, `daytona_image`, ...).
- **Remote sandbox/snapshot metadata**: JSON store keyed by `task_id`, porting
  `modal_snapshots.json`, `vercel_sandbox_snapshots.json`, and singularity overlay/SIF cache paths.
  Versions the store (e.g. `{version: 1, snapshots: {...}}`) to allow future schema migration; no
  SQLite needed for this feature (README allows JSON for feature state; SQLite stays for chat/session
  history).
- **CWD persistence**: remote backends reuse the in-band `__HERMES_CWD_<session>__` marker contract
  (parse from output, no extra storage). Local CWD comes from the Rust terminal session.
- No new `@hermes/protocol` message types needed for the agent path (reuse `TerminalResult` envelope);
  add `backend`/`kind` fields to `TerminalStartResult` for Console UI.

## 5. Third-party library strategy

| Python dependency / mechanism | TS equivalent | Evidence (kimi-code) |
|---|---|---|
| `subprocess` + local PTY (local backend) | Keep Rust `portable-pty` via existing Tauri IPC; TS shim only | `apps/kimi-code/src/native/` + `packages/agent-core-v2/src/os/backends/node-local/hostTerminalService.ts` use `node-pty` — but node-pty is a Node native addon, **cannot run in the Tauri webview**; Desktop already solved this in Rust (`src/commands/terminal.rs`) |
| `ssh`/`scp` CLI (ssh backend) | npm `ssh2` (Node-only) → route via Rust `ssh2` crate or Node sidecar; port `SSHKaos` exec/SFTP semantics | **Found**: `packages/kaos/package.json` `"ssh2": "^1.17.0"`; `packages/kaos/src/ssh.ts` (`SSHKaos`, exec channels + SFTP); tests `test/ssh.test.ts`, `test/e2e/ssh-mock.test.ts` |
| `docker` CLI (docker backend) | Rust child-process passthrough to `docker` CLI (faithful port of Python `subprocess.run(["docker", ...])`); npm `dockerode` exists but is Node-only and unused by kimi-code | **No kimi-code equivalent** — grep of kimi-code package.json found no `dockerode`; dockerode would need a Node sidecar, so prefer Rust CLI passthrough |
| `apptainer`/`singularity` CLI | Rust child-process passthrough; HPC/Linux-only — mark "out of scope for Windows desktop standalone" with stub returning a clear unsupported error | No kimi-code equivalent (verified) |
| `modal` Python SDK | Implement from scratch: Rust/TS REST client to Modal public HTTP API (sandbox create/exec/terminate, snapshot image restore) | No kimi-code equivalent (verified); Modal has no official TS SDK in kimi-code's deps |
| `daytona` Python SDK | Implement from scratch: REST client to Daytona API (create/resume sandbox, exec, fs upload/download, stop) | No kimi-code equivalent (verified) |
| `vercel` Python SDK | Implement from scratch: REST client to Vercel Sandbox API with `VERCEL_TOKEN`+`PROJECT_ID`+`TEAM_ID` or OIDC; snapshot create/restore | No kimi-code equivalent (verified) |
| `xterm.js` (UI rendering) | Already present: `@xterm/xterm ^6.0.0`, `@xterm/addon-fit`, `@xterm/addon-web-links` in `web/package.json` | kimi-code TUI uses its own renderer; Desktop already uses xterm.js (`web/src/components/console/embedded-terminal.tsx`) |
| `bash` snapshot/CWD marker, sudo rewrite, output bounding | TS modules written from scratch (pure string/stream logic), ported from `base.py`/`local.py`/`terminal_tool.py` | kimi-code has shell-exec abstraction `@moonshot-ai/kaos` (`packages/kaos/src/kaos.ts` — `Kaos` interface with `exec`/`execWithEnv`, fs ops, `local.ts` via `node:child_process`, `ssh.ts` via ssh2); port its `Kaos` interface shape for the agent-tool path |

**Verified "no TS equivalent found" list** (grep across kimi-code `package.json` + source): `node-pty`
in webview (only Rust portable-pty usable), `dockerode`, cloud SDKs for Modal/Daytona/Vercel. Only
`ssh2` (kaos) and `xterm`-adjacent deps exist. See §9 for risk detail.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse**: `web/src/routes/console.tsx` + `web/src/components/console/embedded-terminal.tsx`
  (xterm.js lifecycle: open → start → stream → cleanup). Extend `EmbeddedTerminalProps` with
  `backend?: TerminalEnvType` and render a backend selector in the Console header; keep
  `TerminalPurpose` behavior for gateway setup/status.
- **Reuse**: `web/src/lib/tauri-bridge.ts` — existing `terminalStart/terminalWrite/terminalResize/
  terminalClose/terminalOpenExternal` + `onTerminalOutput`. Add `terminalEnvExec`, `terminalEnvSession`
  shims for the new Rust commands.
- **Reuse**: `web/src/lib/runtime.ts` types (`TerminalStartResult`, `TerminalEventPayload`); extend
  with `backend`/`kind` + `TerminalEnvConfig`.
- **Rust**: `src/commands/terminal.rs` stays for local; add `src/commands/terminal_env.rs` for
  docker/ssh/singularity/cloud transports (child-process exec, ssh2 sessions, REST). Share
  `AppState`/error handling (`src/error.rs`).
- **Settings**: surface backend config through existing settings libs (`web/src/lib/config-update.ts`,
  settings routes) so `terminal.backend` and per-backend credentials are editable without touching
  Python config.
- `packages/protocol/` — add zod schemas for `TerminalEnvType`, `TerminalExecuteInput/Result` to keep
  the IPC surface typed.

## 7. Removing the WebSocket dependency (migration path)

1. **Freeze the API surface** the agent loop uses today over WS/REST: `terminal.execute` envelope
   `{backend, command, cwd?, timeout?, stdin?, background?, env?, taskId?}` → `{output, exitCode,
   truncated?, degraded?}`. Document it in `@hermes/protocol`; the Python gateway keeps serving it
   during migration.
2. **Phase A — in-process behind same interface**: implement `TerminalService.execute()` in TS (local
   via Rust IPC; docker/ssh/cloud per §3). The Desktop UI switches its tool-call path to the new
   service while the Python path remains for CLI/messaging users.
3. **Phase B — flag flip**: Desktop stops sending `terminal` tool calls over WS; delete the WS
   `terminal.*` RPC handling and the REST `/api/ws` dependency for terminal. Interactive Console never
   used WS for local; cloud backends use the new Rust IPC only.
4. **Cleanup**: remove `terminal` section from `web/src/lib/gateway-client.ts` terminal methods; keep
   `cleanup_vm`-equivalent (`TerminalService.cleanup(kind, taskId)`) on app exit / backend switch.

## 8. Migration phases & task breakdown

- **P1 — Abstraction + local passthrough**: `types.ts`, `factory.ts`, `TerminalService` skeleton,
  local backend → existing `terminalStart`; config parsing; vitest for factory/config mapping.
- **P2 — Docker**: Rust `terminal_env_exec` CLI passthrough (`docker run -d`, `docker exec`, orphan
  reaper, session-scoped containers, resource args, persistent bind mounts); parity with
  `test_docker_environment.py` + `test_docker_session_isolation.py`.
- **P3 — SSH**: Rust `ssh2` (or Node sidecar) exec + SFTP `FileSyncManager` port; ControlMaster-free
  (Windows); parity with `test_ssh`-style flow and `SSHKaos` behavior.
- **P4 — Cloud backends**: Modal REST client + snapshot store (`test_modal_snapshot_isolation.py`,
  `test_modal_bulk_upload.py` parity); Daytona REST client (`test_daytona_terminal.py` parity); Vercel
  REST client + snapshot store (`test_vercel_sandbox_environment.py` parity). Managed Modal mode
  (Nous Tool Gateway) recorded as optional/stretch.
- **P5 — Singularity**: Rust CLI passthrough; Linux-only; Windows stub with clear "unsupported on
  desktop" message.
- **P6 — Console UI + agent loop swap**: backend selector in `console.tsx`, xterm streaming for cloud
  sessions, freeze envelope, flag flip, delete WS path.

## 9. Risks & open questions

- **node-pty in Tauri webview — NOT possible.** kimi-code's `NodePtyTerminalBackend` and
  `HostTerminalService` import `node-pty`, a native Node addon; the Tauri webview (browser context)
  cannot load it. Mitigation already in place: local PTY lives in Rust (`portable-pty`). Do not port
  node-pty; keep the Rust boundary.
- **dockerode in browser context — NOT usable.** Docker's npm client is Node-only (TCP/HTTP to the
  daemon socket); it cannot run in the webview. Either run it in a Node sidecar or (recommended) shell
  out to the `docker` CLI from Rust — the latter is the exact port of Python's behavior and needs no
  new dependency.
- **ssh2 in browser context — NOT usable directly.** `SSHKaos` proves npm `ssh2` is a solid Node
  implementation, but the webview cannot use it. Plan routes SSH through Rust (`ssh2` crate) or a Node
  sidecar; interactive PTY-over-SSH (channel PTY request + resize) is the riskiest piece — full-screen
  TUI apps over cloud exec streams may degrade. Open question: sidecar vs Rust crate.
- **No official TS SDKs for Modal/Daytona/Vercel Sandbox** (verified absent from kimi-code). REST
  clients must be written from scratch against vendor APIs that change; snapshot/`ARG_MAX`-style
  upload limits (Modal 64 KB exec-arg, 2 MB/16 MB stdin buffers) must be re-verified from docs.
  Managed Modal mode (Nous Tool Gateway) is a Python-specific RPC — either port the protocol or drop
  managed mode on desktop.
- **Interactive semantics for cloud backends**: Python cloud backends are spawn-per-call/non-TTY;
  Vercel docs explicitly say snapshots don't preserve live sandboxes or detached processes. Interactive
  xterm sessions over REST exec are approximate — align user expectations (show "remote exec" badge,
  not a full PTY).
- **Vercel disk constraint**: `container_disk` must stay 51200 MB; config must reject other values
  (parity with `_check_vercel_sandbox_requirements`).
- **Singularity on Windows**: essentially unusable (HPC Linux tool); plan records it as a stub for
  desktop, not a full port.

## 10. Test strategy

- **vitest unit** (no external services):
  - `factory.test.ts` — config → backend mapping, unknown/malformed config errors (parity with
    `_create_environment` branches and `_check_vercel_sandbox_requirements`).
  - `session-snapshot.test.ts` — snapshot bootstrap command shape, CWD marker parse, env-exclusion
    regex (`_export_dump_excluding_session_vars` parity).
  - `wrap-command.test.ts` — sudo rewrite (`_transform_sudo_command` parity: `printf sudo`, `grep -n
    sudo`, leading env assignment), heredoc stdin wrapping (`modal_utils` parity).
  - `bounded-output.test.ts` — `_BoundedOutputCollector` 40/60 head-tail + truncation notice parity.
  - `file-sync.test.ts` — tar building for bulk upload (parity with `test_modal_bulk_upload.py`).
  - `cloud-rest.test.ts` — mocked `fetch`/Rust-IPC request builders for Modal/Daytona/Vercel; transient
    retry/backoff parity (`_retry_vercel_call`).
  - `service.test.ts` — record registry, attach/replay `sinceSeq`, exit frame (kimi-code
    `terminalService.test.ts` pattern).
- **Integration (opt-in env vars, mirror Python tests)**: docker (real daemon) — `test_docker_environment`
  and `test_docker_session_isolation` parity; ssh — mock ssh server (kimi-code has
  `test/e2e/ssh-mock.test.ts` precedent); daytona — `DAYTONA_API_KEY` (parity with
  `test_daytona_terminal.py`); modal — `MODAL_TOKEN_ID/SECRET` (parity with `test_modal_terminal.py` +
  `test_modal_snapshot_isolation.py`); vercel — `VERCEL_TOKEN/PROJECT_ID/TEAM_ID` (parity with
  `test_vercel_sandbox_environment.py`).
- **Playwright E2E**: Console backend selector, xterm.js render + resize + close for local and one
  mocked remote backend; error banner on degraded backend (`EnvironmentConnectionError` → degraded
  result rendering).

## 11. Reference links

- Python source: `D:/hermes-agent-cn/tools/terminal_tool.py`,
  `D:/hermes-agent-cn/tools/environments/{base,local,docker,ssh,singularity,modal,managed_modal,
  daytona,vercel_sandbox,file_sync,modal_utils,_process_bash_command,bash_fix}.py`,
  `D:/hermes-agent-cn/tools/approval.py`, `D:/hermes-agent-cn/tools/tool_backend_helpers.py`.
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/tools.md` §"Terminal Backends".
- Tests: `D:/hermes-agent-cn/tests/tools/test_terminal_tool.py`, `test_docker_environment.py`,
  `test_docker_session_isolation.py`, `test_modal_bulk_upload.py`, `test_modal_snapshot_isolation.py`,
  `test_vercel_sandbox_environment.py`; `tests/integration/test_daytona_terminal.py`,
  `test_modal_terminal.py`.
- TS reference: `D:/kimi-code/packages/agent-core/src/services/terminal/{terminal,terminalService}.ts`,
  `D:/kimi-code/packages/agent-core-v2/src/os/{interface/terminal.ts,
  backends/node-local/hostTerminalService.ts}`, `D:/kimi-code/packages/agent-core/src/tools/builtin/shell/bash.ts`,
  `D:/kimi-code/packages/kaos/src/{kaos,local,ssh}.ts`, `D:/kimi-code/packages/kaos/package.json`
  (ssh2 ^1.17.0), `D:/kimi-code/apps/kimi-code/package.json` (node-pty ^1.1.0).
- Desktop: `D:/Hermes-CN-Desktop/src/commands/terminal.rs`, `web/src/routes/console.tsx`,
  `web/src/components/console/embedded-terminal.tsx`, `web/src/lib/tauri-bridge.ts`,
  `web/src/lib/runtime.ts`, `web/package.json` (`@xterm/xterm ^6.0.0`).
