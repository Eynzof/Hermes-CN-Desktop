# Desktop — Electron desktop app / headless backend / desktop_ui + project toolsets / Projects — Python → TypeScript Rewrite Plan

> **Scope note (recorded decision):** the Electron desktop shell in `Hermes-CN-Core/apps/desktop/` was **already replaced** by the Tauri app in `Hermes-CN-Desktop` (see `AGENTS.md`: "用 Tauri v2 + React 构建的独立桌面应用，替代原 Electron 壳"). This plan therefore does **not** re-port the Electron shell. It records the port of the remaining **feature surface**: (1) the `hermes serve` headless-backend decision (keep the Python managed runtime vs in-process TS serve), (2) the desktop-only `desktop_ui` toolset, (3) the `project` toolset, and (4) first-class **Projects** (named multi-folder workspaces) into the existing Tauri frontend.

## 1. Summary

- **Feature being ported:** the "Desktop" product feature — an app shell + a headless JSON-RPC backend (`hermes serve`) + desktop-gated agent tools (`desktop_ui`, `project`) + the Projects data model (per-profile SQLite `projects.db`, named multi-folder workspaces with a primary repo, session grouping by cwd prefix, repo discovery, git worktree lanes).
- **What changes:** the Tauri React frontend (`web/`) gains a typed Projects client + multi-folder Project CRUD/tree UI, replacing the current client-side "workspaces" model (`web/src/lib/workspaces.ts` + `ui-store` keys). The `desktop_ui` tool events become renderer actions already native to the Tauri app (preview pane, terminal pane, pane reveal) — the agent keeps emitting events through the Python gateway; the renderer maps them to existing UI.
- **Backend decision (recorded):** **keep the Python managed runtime** (`hermes serve` headless, port 9120, `HERMES_DESKTOP_MANAGED=1`) for this feature. The agent loop, model/tool runtime, and sessions stay in Python; the WS link (`/api/ws` JSON-RPC via `web/src/lib/gateway-client.ts`) stays for now. **In-process TS serve is explicitly out of scope** for this feature (it requires porting the whole agent loop — kimi-code proves a TS loop exists, but that is a separate cross-cutting plan). The migration path below still freezes the Projects RPC surface so a later in-process port can swap the transport behind the same interface.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

### 2.1 Electron shell (reference only — replaced)
- `apps/desktop/` — Electron app (electron/ main process: `backend-child.ts`, `backend-command.ts`, `backend-probes.ts`, `git-worktree-ops.ts`, `git-repo-scan.ts`, `active-runtime-state.ts`; `src/` React renderer). Superseded by the Tauri app; read for behavioral parity only (worktree ops, repo scan, backend health).
- `apps/bootstrap-installer/` — installer UI for the managed runtime; equivalent responsibility already lives in Desktop's `src/commands/runtime_manager.rs` + `web/src/routes/managed-runtime-panel.tsx`.
- `hermes_cli/subcommands/gui.py` — `hermes desktop|gui` launcher (build/launch Electron). **Obsolete** for the Tauri app; keep parser for CLI compat or mark deprecated.

### 2.2 Headless backend (`hermes serve`)
- `hermes serve` == `hermes dashboard --no-open` equivalent: headless JSON-RPC/WebSocket gateway, never opens a browser (docs `website/docs/reference/cli-commands.md` § `hermes serve`). The desktop app launches its own `hermes serve`; runtimes older than `serve` fall back to `dashboard --no-open` (`website/docs/user-guide/desktop.md`).
- Managed-runtime markers: `HERMES_DESKTOP_MANAGED=1` (`hermes_cli/main.py`, `hermes_cli/gateway.py`), `HERMES_DESKTOP_CHILD_PID` (`hermes_cli/dashboard_procs.py`), default port **9120** (`tests/test_desktop_managed.py`, `AGENTS.md`).

### 2.3 Projects backend
- `hermes_cli/projects_db.py` — per-profile SQLite store at `$HERMES_HOME/projects.db`. Schema (lines 57–96):
  - `projects(id p_<hex>, slug UNIQUE, name, description, icon, color, board_slug, primary_path, created_at, archived)`
  - `project_folders(project_id, path, label, is_primary, added_at, PK(project_id,path))`
  - `project_meta(key,value)`; `discovered_repos(root PK, label, last_seen)`
  - CRUD: `create_project`, `list_projects`, `get_project`, `update_project`, `add_folder`, `remove_folder`, `set_primary`, `archive_project`, `restore_project`, `delete_project`, `set_active`/`get_active_id`, `record_discovered_repos`/`list_discovered_repos`, `project_for_path` (longest-prefix ownership), `branch_name_for`.
- `hermes_cli/projects_cmd.py` — `hermes project create|list|show|add-folder|remove-folder|rename|set-primary|use|archive|restore|bind-board` CLI (docs `cli-commands.md` § `hermes project`).
- `tui_gateway/server.py` (lines 11942–12037) — JSON-RPC: `projects.list/get/create/update/add_folder/remove_folder/set_primary/archive/delete/set_active/for_cwd`.
- `tui_gateway/methods_config.py` (lines 19–158) — `projects.discover_repos`, `projects.record_repos`, `projects.tree`, `projects.project_sessions`.
- `tui_gateway/project_tree.py` — authoritative project → repo → lane → session tree builder (`build_tree`, `NO_PROJECT_ID="__no_project__"`, `_FolderIndex` longest-prefix matching, kanban lane collapse, worktree folding); `tui_gateway/git_probe.py` — bounded git root probing + TTL cache.

### 2.4 Desktop-only toolsets
- `tools/desktop_ui.py` — renderer-event bridge: `set_emitter(fn(sid,event,payload))`, `available()`, `emit(event,payload)`; routes by `HERMES_UI_SESSION_ID` so events land on the owning window. Tools: `tools/focus_pane_tool.py` (`pane.reveal`, panes chat/files/terminal/review/sessions), `open_preview_tool.py` (`preview.open` + URL normalizer), `read_preview_tool.py`, `read_terminal_tool.py`, `close_terminal_tool.py`, `read_window_tool.py` (`window.below`), `react_to_message_tool.py` (`chat.react`). Gated by `HERMES_DESKTOP=1` (`check_*_requirements`), toolset `desktop_ui` (docs `toolsets-reference.md` line 74).
- `tools/project_tools.py` — toolset `project` (docs line 75): `project_list`, `project_create` (name + optional path → create + set active + re-anchor session cwd via `set_project_workspace_callback`), `project_switch` (by id/slug/name). GUI-sessions only; never on CLI/messaging/cron.

### 2.5 Data flow today
1. User creates a Project in the sidebar/renderer → renderer calls gateway RPC (or `hermes project create`) → `projects_db` write → `projects.tree` returns grouped tree → renderer paints sidebar.
2. Agent runs `project_create`/`project_switch` tool → Python `_apply_workspace(task_id, primary, name)` re-anchors the live session cwd → `desktop_ui.emit` style events update the sidebar.
3. Repo discovery: native crawl happens client-side (Electron `git-repo-scan.ts`); result POSTs to `projects.record_repos`; reads via `projects.discover_repos` (cached in `discovered_repos`).

## 3. Target TypeScript design

### 3.1 Backend decision (recorded)
- **Keep the Python managed runtime (`hermes serve`) as the backend for this feature.** Rationale: the `project` tools and `desktop_ui` tools execute inside the Python agent loop (session cwd re-anchoring, emitter bridge) — there is no TS agent loop in Desktop yet; kimi-code's `packages/agent-core/src/loop/` proves one *can* be built, but porting the agent loop + 200+ tools is a separate feature. The Projects *data layer + UI* is what this plan ports; it is transport-agnostic behind one interface so the WS link can later be deleted feature-by-feature (see §7).

### 3.2 Module layout (under `Hermes-CN-Desktop`)
```
packages/protocol/src/projects.ts      # Zod schemas: Project, ProjectFolder, ProjectTree, ProjectLane,
                                       # ProjectsTreeResponse, ProjectSessionsResponse, RepoDiscoveryPayload
web/src/lib/projects.ts                # ProjectsClient interface + RpcProjectsClient (gateway WS)
                                       # + IpcProjectsClient (Tauri commands) + repo-scan client
web/src/hooks/use-projects.ts          # TanStack Query hooks (list/tree/detail/mutations, invalidation)
web/src/lib/projects-migration.ts      # one-time migration of old ui-store workspaceProjects → projects.db
web/src/components/projects/project-tree.tsx   # repo → lane tree for sidebar/detail
web/src/components/projects/folder-editor.tsx # multi-folder + primary picker UI
src/commands/projects.rs               # (Phase B) Tauri commands: local projects.db CRUD via rusqlite
src/commands/repo_scan.rs              # (Phase B) native folder/git discovery scan
```

### 3.3 Interfaces
```ts
interface ProjectsClient {
  list(): Promise<ProjectsListResponse>;                 // projects.list
  get(id: string): Promise<Project | null>;              // projects.get
  create(input: { name: string; folders?: string[]; primaryPath?: string; use?: boolean }): Promise<Project>;
  update(id: string, patch: Partial<Pick<Project,"name"|"description"|"icon"|"color">>): Promise<Project>;
  addFolder(id: string, path: string, opts?: { label?: string; isPrimary?: boolean }): Promise<Project>;
  removeFolder(id: string, path: string): Promise<Project>;
  setPrimary(id: string, path: string): Promise<Project>;
  archive(id: string, restore?: boolean): Promise<ProjectsListResponse>;
  delete(id: string): Promise<ProjectsListResponse>;
  setActive(id: string | null): Promise<{ activeId: string | null }>;
  forCwd(cwd: string): Promise<{ project: Project | null; cwd: string; branch: string }>;
  tree(previewLimit?: number, sessionLimit?: number): Promise<ProjectsTreeResponse>;  // projects.tree
  projectSessions(projectId: string): Promise<{ project: ProjectTreeNode | null }>;  // projects.project_sessions
  recordRepos(repos: Array<{ root: string; label?: string }>, policy?: unknown): Promise<RepoDiscoveryResponse>;
}
```
- In-process (end-state) impl: `IpcProjectsClient` calls Tauri commands backed by `src/commands/projects.rs` + local `desktop-ui.sqlite` (schema copied from `projects_db.py`). Remote mode always keeps `RpcProjectsClient` (backend owns the DB).
- `desktop_ui` tool events: no new backend code needed in Tauri. The Python gateway already delivers agent tool events; the renderer subscribes (like `Events.StreamEvent` in kimi-code) and maps `pane.reveal` → existing sidebar/panel actions, `preview.open` → existing preview route (`src/commands/preview.rs`), `chat.react` → message reaction UI. The Python `tools/desktop_ui.py` emitter target changes from Electron main-process IPC to the gateway WS event push (already how Tauri receives gateway events).

## 4. Data models & persistence

- **Phase A (parity, no new store):** backend-owned `projects.db` remains the single source of truth; frontend reads/writes via the frozen `projects.*` RPCs. Local fs data (picker paths, scan results) is passed to `projects.record_repos`.
- **Phase B (local ownership, managed mode):** copy the schema verbatim into Rust SQLite (`desktop-ui.sqlite` already exists via `src/ui_store.rs`; `rusqlite 0.32 bundled` already in `Cargo.toml`). Tables: `projects`, `project_folders`, `project_meta`, `discovered_repos`; keep additive-migration helper (`_add_column_if_missing` equivalent).
- **Schema parity notes:**
  - id `p_<8 hex>`; slug `^[a-z0-9][a-z0-9\-_]{0,63}$` unique (kebab, `-2` suffix on collision); name is display-only.
  - Folder paths normalized to absolute, separator-normalized, no trailing slash; `is_primary` marks the primary repo; create with `primary_path` inserts it first into `project_folders`.
  - `archived` is recoverable (restore); `set_active(None)` clears.
  - Session→project membership: longest-prefix match of session `cwd` under a project folder (`_FolderIndex` / `project_for_path`); Windows case/slash identity folding required.
- **Frontend migration:** `web/src/lib/workspaces.ts` currently persists `WorkspaceProject[]` (path/name/createdAt/updatedAt) + pinned + session-map in `ui-store` (`hermes-cn-ui.workspaceProjects`, `pinnedWorkspaceProjects`, `sessionWorkspaces`). One-time migration: seed `projects.create` per existing path (name = folder basename, primary = path), keep pinning as local UI metadata keyed by project id, drop the session-map in favor of backend `cwd` (already the precedence rule in `resolveSessionWorkspace`).

## 5. Third-party library strategy

| Python dependency / capability | TS / Rust equivalent | Evidence |
|---|---|---|
| `sqlite3` (projects.db) | **Rust `rusqlite 0.32` bundled** — already in `Cargo.toml:61`; `src/ui_store.rs` opens `desktop-ui.sqlite` with WAL-ish pragmas. Pure-TS alternative exists (kimi-code `packages/minidb`, embedded DB engine) but is unnecessary here. | `Cargo.toml`, `src/ui_store.rs`; `D:/kimi-code/packages/minidb/src/*` |
| JSON-RPC over WS (gateway `projects.*`) | **Keep** `web/src/lib/gateway-client.ts` `request(method, params)` — the exact pattern used by `web/src/hooks/use-gateway.ts` (`getGatewayClient().request("session.title", …)`). | `web/src/lib/gateway-client.ts:318`, `web/src/hooks/use-gateway.ts` |
| `orjson` serialization | TS native `JSON` + Zod validation in `packages/protocol` (existing pattern, e.g. `hermes-api.ts`). | `packages/protocol/` |
| `argparse` CLI (`hermes project`) | **No TS equivalent needed** — the desktop UI replaces the CLI surface. Keep the Python CLI for headless/remote hosts (docs parity). | — |
| `subprocess git` probing (`tui_gateway/git_probe.py`, Electron `git-repo-scan.ts`) | **Rust shell-git already exists**: `src/commands/git.rs` (`git_worktree_list/add/remove`, `git_branch_list/switch`, `git_repo_status`). Add a bounded folder walker in Rust for discovery (mirror `git-repo-scan.ts` behavior) and POST to `projects.record_repos`. | `src/commands/git.rs:1594–1661`; `apps/desktop/electron/git-repo-scan.ts` |
| Emitter bridge (`tools/desktop_ui.py`) | Tauri event system + existing gateway event stream. Webview ↔ host RPC shim already exists as `web/src/lib/tauri-bridge.ts` (`window.hermesDesktop`); it is the analogue of kimi-code's `apps/vscode/shared/bridge.ts` (Methods/Events RPC + broadcast). | `web/src/lib/tauri-bridge.ts`, `web/src/lib/runtime.ts:448`; `D:/kimi-code/apps/vscode/shared/bridge.ts`, `KimiWebviewProvider.ts` |
| Preview pane / terminal pane | **Already native**: `src/commands/preview.rs`, `src/commands/terminal.rs`, `web/src/routes/` render panes; `preview.open`/`pane.reveal` map to existing UI actions — no third-party lib. | `src/commands/preview.rs`, `src/commands/terminal.rs` |
| Workspace registry (kimi-code analog) | `IWorkspaceRegistry` (`workspaceRegistry.ts`) is the closest TS analog: `list/get/createOrTouch/update/delete/resolveRoot/findWorkspaceIdByRoot/resolveAliasWorkDirs`. **It is single-root; multi-folder + primary + slug has no kimi-code equivalent → implement from scratch** in `src/commands/projects.rs` (Phase B) / `web/src/lib/projects.ts`. | `D:/kimi-code/packages/agent-core/src/services/workspace/workspaceRegistry.ts` |
| Workdir RPC (`GetRegisteredWorkDirs`/`SetWorkDir`/`BrowseWorkDir`) | kimi-code session handler shows the single-folder workdir UX; our `projects.for_cwd` + `projects.set_active` + session cwd re-anchor supersede it. | `D:/kimi-code/apps/vscode/src/handlers/session.handler.ts:44–71` |
| Path identity folding | `areSameFsPath`/`isFsPathInsideOrEqual`/`isWorkspacePathContained` in kimi-code `apps/vscode/src/utils/fs-path.ts`, `workspace-path.ts`; Desktop already has `web/src/lib/paths.ts` (`shortenPath`). | kimi-code `apps/vscode/src/utils/fs-path.ts`; `web/src/lib/paths.ts` |

**No-TS-equivalent risks:** (1) multi-folder Projects with a designated primary repo and slug identity — kimi-code only has single-root workspaces; must be implemented from scratch. (2) `projects.tree`'s project→repo→lane→session tree with kanban collapse and worktree folding — no TS tree builder exists in kimi-code; port the *shape* from `tui_gateway/project_tree.py` (pure function, easy to port) rather than the Python internals. (3) `desktop_ui` "read terminal / read window below" tools rely on Electron main-process OS APIs; Tauri equivalents must be built on `src/commands/terminal.rs` / new native commands (window-below needs platform APIs — see risks).

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse (unchanged):**
  - `web/src/lib/gateway-client.ts` + `web/src/hooks/use-gateway.ts` — transport for `projects.*` RPCs (Phase A).
  - `web/src/lib/tauri-bridge.ts` + `web/src/lib/runtime.ts` `hermesDesktop` interface — IPC shim; add new method shapes there.
  - `web/src/routes/projects.tsx`, `web/src/routes/project-detail.tsx` — extend, don't replace: keep session aggregation, stats, pinning; switch data source from `workspaces.ts` to `use-projects`.
  - `web/src/hooks/use-worktrees.ts` + `web/src/components/projects/worktree-panel.tsx` — repo-level git surface (unchanged, keyed by project primary/folder path).
  - `src/commands/file_dialogs.rs` (`pick_directory`, `create_workspace_project`), `src/commands/git.rs`, `src/commands/preview.rs`, `src/ui_store.rs` (persistence precedent).
- **Replace / migrate:** `web/src/lib/workspaces.ts` (client-side model) → thin adapter over `ProjectsClient`; keep `subscribeWorkspaceChanges` semantics for backward compat, re-emit on project mutations.
- **New Rust:** `src/commands/projects.rs` (Phase B CRUD + local DB), `src/commands/repo_scan.rs` (bounded discovery), register in `src/commands/mod.rs` + `src/main.rs` `generate_handler!`; `src/tray.rs` optional quick-switch later.
- **Remote mode:** projects stay backend-owned; `RpcProjectsClient` used; fs-dependent UI (picker, worktree panel, open-in-finder) already guarded by `runtime.isRemote()` in `project-detail.tsx` — keep that guard.

## 7. Removing the WebSocket dependency (migration path)

**Frozen API surface** (the contract that must not change during migration — documented in `packages/protocol/src/projects.ts`):
`projects.list`, `projects.get`, `projects.create`, `projects.update`, `projects.add_folder`, `projects.remove_folder`, `projects.set_primary`, `projects.archive`, `projects.delete`, `projects.set_active`, `projects.for_cwd`, `projects.tree`, `projects.project_sessions`, `projects.discover_repos`, `projects.record_repos`.

Phases:
1. **Phase A — WS parity (this feature's default):** frontend calls the frozen RPCs over `/api/ws`; Rust handles only local fs (pickers, open-in-finder, git). Ships the full Projects UX against the Python managed runtime. Nothing is removed yet.
2. **Phase B — local IPC transport (managed mode):** `src/commands/projects.rs` implements the same method set over Tauri IPC with `desktop-ui.sqlite`. Introduce `ProjectsClient` with `RpcProjectsClient` (remote) and `IpcProjectsClient` (managed) — same pattern as `web/src/lib/transport.ts` (HTTP routing: native IPC vs fetch). Managed mode stops calling `projects.*` over WS; remote mode keeps RPC.
3. **Phase C — delete WS path (managed only):** drop the `projects.*` WS calls from the managed client; keep the RPC handler in the Python gateway for remote/cloud clients and for the Python CLI. Later, when the agent loop is ported to TS (separate plan), `desktop_ui`/`project` toolset handlers become in-process tool implementations and the `/api/ws` link for this feature is removed entirely.
- **Recorded decision:** this plan does **not** choose in-process TS serve yet; the Python managed runtime stays because agent-loop execution (project tool cwd re-anchoring, desktop_ui emitter) is Python-side. The frozen RPC surface above is the seam that makes the future swap safe.

## 8. Migration phases & task breakdown

1. **P1 Protocol & client** — Zod schemas (`packages/protocol/src/projects.ts`); `web/src/lib/projects.ts` `RpcProjectsClient`; `web/src/hooks/use-projects.ts` (list/tree/detail/mutations + invalidation); unit tests for client + schemas.
2. **P2 Frontend UI** — extend `projects.tsx`/`project-detail.tsx` to multi-folder (folder list, primary marker, add/remove/set-primary, rename, archive/restore); render `projects.tree` (project→repo→lane) in sidebar/detail; keep stats aggregation + pinning; add `folder-editor.tsx`, `project-tree.tsx`; migrate `workspaces.ts` consumers to `use-projects`; `projects-migration.ts` one-time seed.
3. **P3 Native commands** — `src/commands/projects.rs` (CRUD + local DB, rusqlite; WAL; additive columns); `src/commands/repo_scan.rs` (bounded discovery, policy-compliant with `desktop.repo_scan_*` config); register commands; Rust unit tests.
4. **P4 Transport swap** — `IpcProjectsClient`; `ProjectsClient` factory by `runtime.getConnectionMode()`; wire into `tauri-bridge.ts`/`runtime.ts` types; remove managed-mode `projects.*` WS calls.
5. **P5 desktop_ui toolset adapter** — renderer subscription to gateway tool events (`pane.reveal`, `preview.open`, `chat.react`, terminal read/close); map to existing panels; keep Python emitter contract (`HERMES_UI_SESSION_ID` routing for multi-window).
6. **P6 Cleanup** — delete obsolete Electron references in Core docs/CLI help (`hermes gui` deprecation note), keep Python `projects_cmd.py` for headless use; parity tests pass.

## 9. Risks & open questions

- **No TS equivalent for multi-folder Projects** — single-root workspace registry in kimi-code only; multi-folder + primary + slug must be built from scratch (Rust/TS). Keep the frozen RPC surface so Python behavior stays the reference.
- **Dual-store consistency (Phase B)** — Rust `desktop-ui.sqlite` vs Python `projects.db` may diverge during transition; mitigate: single writer (managed = Rust after Phase B, remote = Python), one-time backfill, `projects.record_repos` still written through the backend for shared discovery cache. Open question: should the Rust store stay read-only bridge to `$HERMES_HOME/projects.db` instead of a second DB? (Recommend: in managed mode, have Rust own a **copy** only after confirming no cross-device sync; otherwise bridge.)
- **Remote mode** must keep RPC forever — Projects UI degrades to path strings on remote backends (already the case today via `runtime.isRemote()`).
- **`desktop_ui` OS-probing tools** (`read_window_tool` window-below, `read_terminal` scrollback) need Tauri platform APIs that do not exist yet (`src/commands/terminal.rs` covers pty; window-below requires platform-specific win/mac APIs). Mark those two tools as "not ported" or gate behind new native commands.
- **Multi-window event routing** — `HERMES_UI_SESSION_ID` must map to the correct Tauri WebView; today's `gateway-client.ts` is per-window WS; confirm session ownership routing before `chat.react`/`pane.reveal` land in the wrong window.
- **Kanban binding** (`board_slug`, `bind-board`) — projects bind to kanban boards for deterministic worktrees; out of scope here (kanban is a separate plan) but the schema must keep `board_slug` + `branch_name_for` parity.
- **Old ui-store data** — `workspaceProjects`/`sessionWorkspaces` migration is one-time; dropping the session-map changes workspace resolution for legacy sessions (must keep backend-`cwd` precedence).

## 10. Test strategy

- **Vitest (web):** `projects.ts` client (mock `GatewayClient`), Zod schema validation, `use-projects` invalidation, migration shim (`projects-migration`), tree flattening utils. Parity: port the invariants of `tests/tui_gateway/test_project_tree.py` (lane ids, worktree folding, NO_PROJECT bucket, scoped_session_ids) as pure TS unit tests over fixture sessions.
- **Rust integration (`tests/`):** `projects.rs` CRUD + schema (mirror `tests/hermes_cli/test_projects_cli.py`, `test_projects_db.py`), longest-prefix `project_for_path`, slug uniqueness, archive/restore, WAL pragmas; repo scan bounded-depth + policy (mirror `tests/tui_gateway/test_projects_rpc.py` `discover/record` gating); use `tempfile::TempDir`, `serial_test` for env-dependent tests (AGENTS.md Rust conventions).
- **Parity/contract tests:** freeze the RPC payload shapes from Python (`projects.tree`, `projects.project_sessions`, `projects.list`) into `packages/protocol` fixtures and assert the TS client decodes them unchanged (guards the WS contract during Phase B/C).
- **Playwright E2E:** create project (picker + multi-folder add), sidebar tree renders repo→lane, enter project, rename/archive/delete, worktree panel still works; run against real Core backend + fake model (existing `e2e/` harness).
- **Keep Python tests green** — Core `tests/tools/test_desktop_ui.py`, `test_project_tools.py`, `tests/tui_gateway/test_projects_rpc.py`, `tests/hermes_cli/test_projects_*`, `tests/test_desktop_managed.py` remain the reference behavior; do not modify them in this port.

## 11. Reference links

- Core: `D:/hermes-agent-cn/hermes_cli/projects_db.py`, `projects_cmd.py`, `subcommands/gui.py`; `tui_gateway/server.py` (projects.* RPCs), `methods_config.py`, `project_tree.py`, `git_probe.py`; `tools/desktop_ui.py`, `tools/project_tools.py`, `tools/focus_pane_tool.py`, `open_preview_tool.py`; `apps/desktop/electron/*` (behavioral reference), `apps/bootstrap-installer/`.
- Docs: `D:/hermes-agent-cn/website/docs/reference/cli-commands.md` (§ `hermes project`, `hermes serve`), `website/docs/reference/toolsets-reference.md` (lines 74–75), `website/docs/user-guide/desktop.md`.
- Tests: `D:/hermes-agent-cn/tests/tui_gateway/test_project_tree.py`, `test_projects_rpc.py`; `tests/tools/test_desktop_ui.py`; `tests/hermes_cli/test_projects_cli.py`, `test_projects_db.py`; `tests/test_desktop_electron_pin.py`, `tests/test_desktop_managed.py`.
- Desktop: `D:/Hermes-CN-Desktop/web/src/routes/projects.tsx`, `project-detail.tsx`; `web/src/lib/workspaces.ts`, `gateway-client.ts`, `tauri-bridge.ts`, `runtime.ts`; `web/src/hooks/use-worktrees.ts`; `src/commands/file_dialogs.rs`, `git.rs`, `preview.rs`, `ui_store.rs`, `tray.rs`, `Cargo.toml`.
- kimi-code TS reference: `D:/kimi-code/apps/vscode/shared/bridge.ts`, `src/KimiWebviewProvider.ts`, `src/handlers/session.handler.ts`, `workspace.handler.ts`, `webview-ui/src/App.tsx`, `src/utils/fs-path.ts`, `workspace-path.ts`; `packages/agent-core/src/services/workspace/workspaceRegistry.ts`, `src/loop/`; `packages/minidb/`.
