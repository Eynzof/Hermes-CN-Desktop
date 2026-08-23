# Checkpoints & Rollback — Python → TypeScript Rewrite Plan

> Feature: automatic working-directory snapshots before file changes; `/rollback`, `/snapshot`, `/diff`; `hermes checkpoints`.
> Design-only plan (NO implementation). Follows `plans/README.md` template.

## 1. Summary

Port the Python **CheckpointManager** (`D:/hermes-agent-cn/tools/checkpoint_manager.py`) into the
Hermes-CN-Desktop TypeScript stack so it can run in-process without the Python backend / WebSocket link.
Today Python takes a transparent snapshot of the working directory (once per conversation turn) before
`write_file` / `patch` / destructive `terminal` calls, storing commits in a **single shared shadow git
repo** at `~/.hermes/checkpoints/store/`; users inspect/restore via `/rollback`, preview with
`/rollback diff <N>` / `/diff session`, and manage the store with `hermes checkpoints
status|prune|clear|clear-legacy`.

The port keeps the **same on-disk store layout and git plumbing** (so Python-created and
Desktop-created checkpoints are interchangeable), moves the git subprocess work to Rust Tauri commands
(`src/commands/checkpoints.rs`, reusing the env-isolation / child-process patterns of
`src/commands/git.rs`), and implements a TS `CheckpointManager` mirroring the Python class API. The
webview gets: a checkpoint list/diff/restore panel, in-composer slash commands (`/rollback`,
`/diff session`, `/snapshot`), a settings section for `checkpoints.*` config, and a store-management
page replacing the `hermes checkpoints` CLI. `/snapshot` is a *separate* Python feature (Hermes
config/state snapshots, `hermes_cli/backup.py`) grouped under the same slash surface; it is ported as
a small sibling module or explicitly deferred (see §9).

## 2. Current Python implementation

Source files (all under `D:/hermes-agent-cn`):

- `tools/checkpoint_manager.py` (1956 lines) — core module. Key surface:
  - `CheckpointManager` class (line 703): `__init__(enabled, max_snapshots=20,
    max_total_size_mb=500, max_file_size_mb=10)`; `new_turn()` (per-turn dedup reset, line 743);
    `ensure_checkpoint(working_dir, reason)` (line 751); `list_checkpoints()` (line 785);
    `diff(working_dir, commit_hash)` (line 839); `session_diff()` (line 889, powers `/diff session`);
    `restore(working_dir, commit_hash, file_path=None)` (line 921, takes a pre-rollback snapshot
    first); `get_working_dir_for_path()` (line 978, project-root discovery via `.git`,
    `pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod`, `Makefile`, `pom.xml`, `.hg`,
    `Gemfile` markers).
  - `_take()` (line 1000): `git add -A` into a per-project index → `write-tree` →
    `commit-tree` (parent = ref tip) → `update-ref refs/hermes/<hash16>`; skips no-change and
    >50k-file dirs (`_MAX_FILES`); drops oversize files (`_drop_oversize_from_index`).
  - `_prune()` (line 1180, ref rewrite + `git gc --prune=now`) and `_enforce_size_cap()`
    (line 1247, round-robin oldest-commit drop).
  - Module functions: `prune_checkpoints()` (line 1485, orphan/stale/legacy sweep with
    orphan-allowlist confirmation binding), `maybe_auto_prune_checkpoints()` (line 1763, 24h
    `.last_prune` marker), `store_status()` (line 1834), `clear_all()` (line 1918),
    `clear_legacy()` (line 1937), `format_checkpoint_list()` (line 1336).
  - Storage layout: `~/.hermes/checkpoints/{store/ (bare git repo), .last_prune, legacy-<ts>/}`;
    per-project `refs/hermes/<hash16>`, `indexes/<hash16>`, `projects/<hash16>.json`; `xxhash.xxh64`
    of the absolute workdir → project hash; `DEFAULT_EXCLUDES` (node_modules, dist, .venv, .git, etc.).
    `_git_env()` (line 239) isolates `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` and neutralises
    global/system git config (`GIT_CONFIG_GLOBAL=<devnull>`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`)
    so user hooks/gpgsign/pinentry never fire.
- `hermes_cli/checkpoints.py` — `hermes checkpoints` subcommand: `status` (default) / `list`
  (alias) / `prune [--retention-days N --max-size-mb N --keep-orphans -f]` / `clear [-f]` /
  `clear-legacy [-f]`, with confirmation prompts and orphan-preview allowlist logic.
- Trigger points (transparent, non-tool):
  - `agent/tool_executor.py` — `_begin_tool_execution` preflight: before `write_file`/`patch`,
    `_ensure_file_checkpoint()` resolves the path through the task cwd pipeline then
    `get_working_dir_for_path()` + `ensure_checkpoint(workdir, "before <fn>")`; before `terminal`,
    `_is_destructive_command(command)` (imported from `agent/tool_dispatch_helpers.py` line 92, a
    regex heuristic: `rm`, `rmdir`, `cp`, `mv`, `sed -i`, `truncate`, `dd`, `shred`, `>`
    redirects, `git reset/clean/checkout`, …) triggers `ensure_checkpoint(cwd, ...)`.
  - `agent/conversation_loop.py` — calls `_checkpoint_mgr.new_turn()` per iteration.
  - `agent/agent_init.py` (line 1789) — constructs `CheckpointManager` from config
    (`checkpoints.enabled`, `max_snapshots`, `max_total_size_mb`, `max_file_size_mb`).
- Slash commands: `hermes_cli/cli_commands_mixin.py` — `_handle_rollback_command` (line 51:
  list / `<N>` restore + undo last turn / `diff <N>` / `<N> <file>`), `_handle_diff_command`
  (line 145: `working|staged|all|session`, `--stat`, paths), `_handle_snapshot_command`
  (line 279: Hermes config/state snapshots via `hermes_cli/backup.py` `create_quick_snapshot`,
  `list_quick_snapshots`, `restore_quick_snapshot`, `prune_quick_snapshots` — **not** filesystem
  checkpoints).
- Gateway / REST surface (what the Desktop currently talks to):
  - WS JSON-RPC `tui_gateway/methods_tools.py`: `rollback.list` (line 1243), `rollback.restore`
    (line 1273; full restore also truncates session history and bumps `history_version`),
    `rollback.diff` (line 1330, truncates diff to 4000 chars), `slash.exec` (line 1078, routes
    `/rollback`, `/diff`, `/snapshot` etc.), `command.dispatch` (line 433).
  - REST `hermes_cli/web_server.py`: `GET /api/ops/checkpoints` (line 14446, sessions+bytes),
    `POST /api/ops/checkpoints/prune` (line 14480, spawns `hermes checkpoints prune`).
- Config defaults: `hermes_cli/config_defaults.py` `checkpoints` block — `enabled: false`,
  `max_snapshots: 20`, `max_total_size_mb: 500`, `max_file_size_mb: 10`, `auto_prune: true`,
  `retention_days: 7`, `min_interval_hours: 24`.

## 3. Target TypeScript design

Runs in-process in the Tauri webview with Rust handling git/filesystem; no Python backend needed
after migration.

Module layout (new, under `D:/Hermes-CN-Desktop`):

- `web/src/lib/checkpoints/types.ts` — Zod schemas (mirrors `packages/protocol` style):
  `CheckpointInfo {hash, shortHash, timestamp, reason, filesChanged, insertions, deletions}`,
  `CheckpointListResponse {enabled, checkpoints, workdir}`, `DiffResult {success, stat, diff,
  empty?, baseline?}`, `RestoreResult {success, restoredTo, reason, directory, file?}`,
  `CheckpointStoreStatus {base, storeSizeBytes, legacySizeBytes, totalSizeBytes, projectCount,
  projects[], legacyArchives[]}`.
- `web/src/lib/checkpoints/manager.ts` — TS `CheckpointManager` mirroring the Python class:
  `newTurn()`, `ensureCheckpoint(workdir, reason)`, `listCheckpoints(workdir)`,
  `diff(workdir, hash)`, `sessionDiff(workdir)`, `restore(workdir, hash, file?)`,
  `getWorkingDirForPath(filePath)`, plus `storeStatus()`, `prune(opts)`, `clear()`. All git calls
  delegate to Rust IPC (or to the WS gateway during migration phase).
- `web/src/lib/checkpoints/git-runner.ts` — thin async wrapper over `invoke()` for the Rust
  commands below; a `GitUnavailableError`-style result type for degraded mode (like Python's
  non-fatal `ensure_checkpoint` returning `false`).
- `web/src/lib/checkpoints/destructive.ts` — TS port of `_is_destructive_command` regex
  (`agent/tool_dispatch_helpers.py`) used to decide terminal pre-checkpoint.
- `web/src/components/checkpoints/` — `CheckpointList`, `CheckpointDiffPreview`,
  `CheckpointRestoreDialog`, `CheckpointStorePanel` (status/prune/clear).
- `web/src/routes/checkpoints.tsx` — management page replacing `hermes checkpoints` CLI.

Rust (new, under `D:/Hermes-CN-Desktop/src/commands/checkpoints.rs`):

- Tauri commands: `checkpoint_list(workdir)`, `checkpoint_diff(workdir, hash)`,
  `checkpoint_restore(workdir, hash, file_path?)`, `checkpoint_ensure(workdir, reason)`,
  `checkpoint_status()`, `checkpoint_prune(retention_days, max_size_mb, keep_orphans, force)`,
  `checkpoint_clear(force)`, `checkpoint_clear_legacy(force)`, `checkpoint_new_turn()`.
- Internally: `git init --bare` (lazy), per-project index/ref handling, `git add -A`,
  `write-tree`, `commit-tree`, `update-ref`, `rev-list`, `diff --stat/--no-color`, `checkout
  <hash> -- <path>`, `gc --prune=now`; env isolation cloned from Python `_git_env` +
  `src/commands/git.rs` (`GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `CREATE_NO_WINDOW` on Windows,
  timeout + `try_wait` kill).
- Project metadata `projects/<hash>.json` read/write via serde_json (equivalent of orjson).

Data flow (in-process end state):

```
User types /rollback            React (composer/panel)
        │
        ▼
CheckpointManager (TS) ── invoke() ──► src/commands/checkpoints.rs ── git subprocess
        │                                      │
        ▼                                      ▼
   React store/event            ~/.hermes/checkpoints/store (shared bare repo)
```

Automatic snapshot trigger (end state): the in-process agent loop calls
`checkpointManager.ensureCheckpoint(workdir, "before write_file")` immediately before executing
`write`/`edit` tools and before destructive `terminal` commands, with `newTurn()` at loop start —
exact mirror of `agent/tool_executor.py` + `agent/conversation_loop.py`. During migration the same
calls happen from a WS tool-call interceptor (see §7).

## 4. Data models & persistence

- **Keep the Python store format byte-compatible** so a store created by the managed Python runtime
  (today) or by the Desktop (later) works from both sides:
  - `~/.hermes/checkpoints/store/` bare git repo (`HEAD`, `objects/`, `refs/`, `config`,
    `info/exclude` seeded with `DEFAULT_EXCLUDES`), per-project `refs/hermes/<hash16>`,
    `indexes/<hash16>`, `projects/<hash16>.json` (`{workdir, created_at, last_touch,
    workdir_parent_dev?, workdir_parent_ino?}`), `.last_prune` marker, `legacy-<ts>/` archives.
  - `<hash16>` = `xxh64(abs(workdir))[:16]` — **must match Python exactly** (see §5).
- TS data types (Zod in `packages/protocol` or `web/src/lib/checkpoints/types.ts`) per §3; wire
  shapes match the existing `rollback.list/restore/diff` JSON-RPC responses so the same frontend
  code works against both backends.
- Config: read/write the existing `~/.hermes/config.yaml` `checkpoints:` block (keys identical:
  `enabled`, `max_snapshots`, `max_total_size_mb`, `max_file_size_mb`, `auto_prune`,
  `retention_days`, `min_interval_hours`). The desktop config editor already has translations for
  these keys in `web/src/lib/config-translations.ts` (lines 47–54).
- Session-history coupling: full `/rollback <N>` must also truncate the conversation history back
  to the last user turn (Python: `rollback.restore` deletes history and bumps `history_version`;
  CLI: `undo_last()`). Persisted via the desktop's existing session store (SQLite via Rust) — this
  is the one model that is NOT part of the shadow store and must be kept in sync during restore.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / decision |
|---|---|---|
| `git` subprocess (the entire storage engine) | **System git via Rust `std::process::Command`** (no npm lib) | `D:/Hermes-CN-Desktop/src/commands/git.rs` already shells system git with env isolation, timeouts, `CREATE_NO_WINDOW`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`. kimi-code also shells system git: `packages/agent-core/src/services/fs/fsGitService.ts` uses `node:child_process` `spawn` for `git status --porcelain` / `git diff --numstat`; `apps/kimi-code/src/utils/git/git-status.ts` uses `execFile`/`spawnSync`. `isomorphic-git`/`simple-git` are **not** used by kimi-code (only `simple-git-hooks` dev tool in root `package.json`). |
| `xxhash` (`xxh64`) for project hash | Rust `xxhash-rust` crate OR tiny TS `xxh64` implementation | Must produce identical `xxh64(abs_path)[:16]` for cross-runtime store sharing. No kimi-code equivalent; implement in Rust (preferred, keeps webview lean) behind `checkpoint_project_hash(workdir)` IPC. |
| `orjson` (project meta JSON) | `serde_json` (Rust) / `JSON.stringify` (TS) | Standard; no kimi-code evidence needed. |
| `re` (destructive-command heuristic, commit-hash validation) | TS `RegExp` port of `_is_destructive_command` (`agent/tool_dispatch_helpers.py` line 92) and hex-hash check | Direct port; kimi-code uses `RegExp` liberally (e.g. `git-status.ts` `AHEAD_BEHIND_RE`). |
| `argparse` (CLI `hermes checkpoints`) | React management page + `invoke()` commands; no CLI needed in desktop standalone | Pattern matches other desktop pages (e.g. `routes/backup.tsx` wraps `hermes backup`). |
| Diff/status rendering | Reuse existing desktop diff UI (review pane) | `src/commands/git.rs` `ReviewDiffInput`/diff plumbing; `web/src` review components; kimi-code `fsGit.ts` `parseNumstat`/`parsePorcelain` show the parsing shape. |
| **Snapshot/rollback logic itself** | **Implement from scratch (TS `CheckpointManager` + Rust `checkpoints.rs`)** | **No TS equivalent found in kimi-code**: `packages/agent-core/src/agent/records/` is session-state wire-log replay (`restoreAgentRecord` rebuilds in-memory state only — never touches disk); kimi-code file tools (`src/tools/builtin/file/write.ts`, `edit.ts`) do no snapshotting (verified by grep: no `snapshot|rollback|revert|checkpoint` matches in `src/tools/builtin/file/`); `apps/kimi-code/src/utils/git/git-status.ts` only feeds a status badge. |

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse**: `web/src/lib/gateway-client.ts` `request(method, params)` for phase-1 WS calls
  (`rollback.list/restore/diff`, `slash.exec`, `command.dispatch`); `web/src/hooks/use-gateway.ts`
  (prompt submit + `command.dispatch` at lines 487/612) for slash routing;
  `web/src/lib/tauri-bridge.ts` to expose new Rust commands with a browser-dev shim;
  `web/src/lib/builtin-commands.ts` (currently only `/compress`) to register `/rollback`,
  `/diff`, `/snapshot` as client-handled commands; `web/src/lib/composer-skills.ts`
  `parseLeadingSlashCommand` for parsing; `web/src/lib/config-translations.ts` checkpoint keys for
  the settings UI (`web/src/routes/settings.tsx` imports `translateConfigField`).
- **Rust**: `src/commands/git.rs` — borrow the `command()` env-isolation / `augmented_path` /
  `CHILD_TIMEOUT` / `try_wait` patterns and the `ReviewList`/`ReviewDiff` payload shapes for the
  checkpoint diff preview; `src/commands/terminal.rs` (portable_pty) — the destructive-command
  checkpoint hook attaches where terminal sessions are spawned; `src/commands/preview.rs`
  (`read_workspace_file`) for showing a restored file after `/rollback <N> <file>`.
- **New UI**: `web/src/routes/checkpoints.tsx` (store status/prune/clear, replaces
  `hermes checkpoints` in the terminal), a chat-embedded checkpoint panel (list → diff → restore
  → toast), and a settings section for `checkpoints.*` toggles. `web/src/routes/console.tsx`
  remains as the fallback way to run `hermes checkpoints` while the Python backend exists.
- No checkpoint UI exists in `web/src` today (grep found only unrelated "snapshot" hits in runtime
  update / preview-rail code), so this is greenfield UI.

## 7. Removing the WebSocket dependency (migration path)

Freeze this API surface (the contract both backends must honour):

1. WS JSON-RPC: `rollback.list`, `rollback.restore`, `rollback.diff` request/response shapes
   (`enabled`, `checkpoints[{hash,timestamp,message}]`, `{stat,diff,rendered}`, restore result +
   `history_removed`).
2. `slash.exec` output text for `/rollback`, `/rollback diff <N>`, `/rollback <N> <file>`,
   `/diff session`, `/snapshot ...` (used by TUI; desktop chat currently routes slash text through
   `prompt.submit`).
3. REST: `GET /api/ops/checkpoints`, `POST /api/ops/checkpoints/prune`.
4. Config keys `checkpoints.*` and `~/.hermes/checkpoints/` store layout.

Phases:

- **Phase A (today, keep backend)**: Desktop calls `rollback.*` / `slash.exec` over WS; optional
  `hermes checkpoints` via console terminal; REST ops endpoints already exist.
- **Phase B (in-process behind same interface)**: Implement TS `CheckpointManager` + Rust
  `checkpoints.rs`; route `rollback.*`-shaped calls to it when the agent loop is in-process;
  keep WS path for legacy/managed sessions. Add a WS tool-call interceptor in `use-gateway.ts` so
  the desktop itself takes pre-mutation checkpoints while Python still executes tools (guarded by
  config so Python and Desktop never double-snapshot the same turn).
- **Phase C (delete WS/REST path)**: agent loop fully in-process; `rollback.*` maps directly to
  the TS module; `hermes checkpoints` replaced by the Checkpoints page + Rust store commands;
  remove `/api/ops/checkpoints` consumers from `web/src`.

## 8. Migration phases & task breakdown

- **P0 — Rust store backend**: `src/commands/checkpoints.rs` (init, ensure/list/diff/restore,
  status/prune/clear/clear-legacy, env isolation, xxh64 project hash, `DEFAULT_EXCLUDES`,
  oversize-drop, max-snapshots prune, size-cap, legacy migration, `.last_prune` auto-prune) +
  Tauri `invoke` registration + `tauri-bridge.ts` shim.
- **P1 — TS manager + trigger**: `web/src/lib/checkpoints/*` (types, manager, git-runner,
  destructive); wire `newTurn()`/`ensureCheckpoint` into the in-process loop (and WS interceptor
  in Phase B); parity of dedup (once per dir per turn), git-missing degrade, no-change skip.
- **P2 — Slash commands + chat UI**: extend `builtin-commands.ts`; `/rollback` list/diff/restore
  and `/rollback <N> <file>` flow; `/diff session` panel; `/snapshot` state-snapshot module (or
  defer, §9); history-truncation on full restore.
- **P3 — Store management UI**: `routes/checkpoints.tsx` (status table, prune with orphan
  confirmation preview, clear/clear-legacy with confirmation), settings section for
  `checkpoints.*`, auto-prune on app start.
- **P4 — Hardening + parity**: cross-runtime store compatibility test (Python-written store read
  by TS and vice versa); WS removal pass; docs updates.

## 9. Risks & open questions

- **No TS equivalent found in kimi-code** (highest risk): the entire snapshot/rollback engine must
  be implemented from scratch (TS logic + Rust git plumbing). Mitigate by porting the Python
  function-by-function and by keeping git as the storage layer (battle-tested, content-addressable,
  dedup across projects).
- **Store format compatibility**: any deviation in `xxh64` hashing, ref naming, `info/exclude`,
  or commit sequence makes Desktop/Python stores diverge. Must add a cross-implementation parity
  test using Python-produced fixtures.
- **Double-writer hazard**: while the managed Python runtime still runs agents, Desktop-initiated
  checkpoints (Phase B interceptor) could race/duplicate Python's own snapshots. Mitigate with the
  per-turn dedup set shared by both paths + config guard.
- **Git availability / platform**: same as Python — no git ⇒ transparently disabled; on Windows
  use `CREATE_NO_WINDOW` and `windows_hide_flags`-equivalent to avoid console flashes; git must be
  isolated from user config (gpgsign/pinentry) exactly like `_git_env`.
- **Session-history coupling**: `/rollback <N>` also rewinds conversation history; the desktop
  session store must implement the same `history_version` bump / last-user-turn truncation, or the
  UI will show stale context after restore.
- **`/snapshot` scope**: it is a different feature (Hermes config/state zip snapshots via
  `hermes_cli/backup.py`, not filesystem checkpoints). Decision needed: port it as part of this
  plan (small: `web/src/lib/state-snapshots.ts` + existing backup commands) or mark it
  out-of-scope for desktop standalone. Recommended: include list/create/restore via existing
  `hermes backup --quick` REST/CLI, defer `restore` confirmation UX.
- **Orphan detection on Windows**: Python uses `(st_dev, st_ino)` volume evidence; Windows
  filesystems may return zero inodes. Rust must mirror the conservative "no evidence ⇒ not
  orphan" behavior to avoid deleting projects on unmounted volumes.
- **Performance**: `git add -A` on huge dirs; reuse `_MAX_FILES` (50k), per-file size cap, and
  timeout/`try_wait` kill from `git.rs`.

## 10. Test strategy

- **Vitest unit tests** for `web/src/lib/checkpoints/*` mirroring Python parity fixtures from
  `D:/hermes-agent-cn/tests/tools/test_checkpoint_manager.py`:
  - `TestTakeCheckpoint` / `TestListCheckpoints` / `TestRealPruning` (once-per-turn dedup,
    no-change skip, max_snapshots ref rewrite + gc).
  - `TestRestore` (unknown hash, tilde path, single-file restore, pre-rollback snapshot).
  - `TestSessionDiff` (empty baseline behavior, cumulative diff).
  - `TestSecurity` (hash validation — reject `-`-prefixed / non-hex; path traversal rejection),
    `TestGitEnvIsolation` (env never inherits ambient `GIT_*`, config isolation).
  - `TestErrorResilience` (git failure never raises; missing git ⇒ disabled).
  - `TestStoreStatus` / `TestPruneCheckpoints*` / `TestClearFunctions` (status shape, orphan
    allowlist binding, clear/clear-legacy).
- **Rust unit tests** in `src/commands/checkpoints.rs`: env map contents, xxh64 project-hash
  parity against a Python-computed fixture, command arg validation, timeout/kill behavior,
  `CREATE_NO_WINDOW` on Windows.
- **Cross-runtime parity test** (P4): a Python-written store fixture under `tests/fixtures/`
  loaded by the TS/Rust implementation; assert identical `listCheckpoints`/`diff`/`restore`
  results.
- **Playwright E2E**: `/rollback` in composer → panel lists checkpoints → diff preview →
  restore → file content assertion + history truncation; checkpoints settings toggles persist to
  `config.yaml`; store page prune/clear confirmation flows.
- **Desktop test infra to reuse**: `web/src/lib/builtin-commands.test.ts`,
  `web/src/lib/tauri-bridge.test.ts` (mock `invoke`), existing vitest/Playwright setup.

## 11. Reference links

- Python: `D:/hermes-agent-cn/tools/checkpoint_manager.py`,
  `D:/hermes-agent-cn/hermes_cli/checkpoints.py`,
  `D:/hermes-agent-cn/hermes_cli/cli_commands_mixin.py` (lines 51–364),
  `D:/hermes-agent-cn/agent/tool_executor.py`, `D:/hermes-agent-cn/agent/tool_dispatch_helpers.py`
  (line 92), `D:/hermes-agent-cn/agent/agent_init.py` (line 1789),
  `D:/hermes-agent-cn/agent/conversation_loop.py`,
  `D:/hermes-agent-cn/tui_gateway/methods_tools.py` (lines 1078, 1243–1350),
  `D:/hermes-agent-cn/hermes_cli/web_server.py` (lines 14446–14487),
  `D:/hermes-agent-cn/hermes_cli/config_defaults.py` (line 493),
  `D:/hermes-agent-cn/hermes_cli/backup.py` (quick snapshots for `/snapshot`).
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/checkpoints-and-rollback.md`,
  `website/docs/user-guide/features/overview.md`,
  `website/docs/reference/slash-commands.md` (lines 42–50, 297),
  `website/docs/reference/cli-commands.md` (lines 920–956).
- Tests: `D:/hermes-agent-cn/tests/tools/test_checkpoint_manager.py`,
  `tests/hermes_cli/test_checkpoints_prune.py`,
  `tests/integration/test_checkpoint_resumption.py`.
- TS reference (kimi-code): `D:/kimi-code/packages/agent-core/src/agent/records/` (index.ts,
  types.ts, persistence.ts — session replay, NOT filesystem snapshots),
  `packages/agent-core/src/services/fs/fsGit.ts`, `fsGitService.ts`,
  `packages/agent-core/src/tools/builtin/file/write.ts`, `edit.ts`,
  `apps/kimi-code/src/utils/git/git-status.ts`.
- Desktop: `D:/Hermes-CN-Desktop/src/commands/git.rs`, `src/commands/terminal.rs`,
  `src/commands/preview.rs`, `web/src/lib/gateway-client.ts`, `web/src/lib/tauri-bridge.ts`,
  `web/src/lib/builtin-commands.ts`, `web/src/lib/config-translations.ts`,
  `web/src/hooks/use-gateway.ts`, `web/src/routes/console.tsx`, `web/src/routes/settings.tsx`.
