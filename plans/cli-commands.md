# CLI Commands — Python → TypeScript Rewrite Plan

## 1. Summary

This plan maps the full `hermes` CLI command surface (60+ top-level commands +
global flags documented in `D:/hermes-agent-cn/website/docs/reference/cli-commands.md`)
onto the Hermes-CN-Desktop Tauri app. The `hermes` terminal binary itself is
**out of scope** for the Tauri standalone: every command either becomes a React
route / hook, a Rust Tauri command, a command-palette entry, or is recorded as
"dropped / thin-wrapper" with justification. The core deliverable is a
**command registry** (`web/src/lib/commands/catalog.ts`) plus a typed
`CommandAction` dispatcher that lets each command be migrated independently from
"proxies to Python backend" → "in-process TypeScript module", which is the
migration path required to eventually remove the WebSocket/REST link to the
managed Python runtime.

Design decisions:
- One `CommandSpec` record per command with `kind`: `route` (existing React
  route), `hook` (new/updated hook), `rpc` (Rust Tauri command), `palette-only`,
  `thin-wrapper` (shell out to `hermes` binary), or `dropped` (pure terminal /
  Python-venv concern with no UI value).
- The interactive chat, `-q` one-shot, and `-z` scripted one-shot all share one
  `runSession` action; `-z` becomes a headless runner that returns a structured
  `OneShotResult` (the pure-stdout contract is a CLI-only concept).
- Reuse the existing desktop surface aggressively: ~30 routes/hooks already
  cover the settings/config/model/session/cron/kanban/project/skills/MCP/memory/
  profiles/logs/backup/analytics command families; the plan mostly wires the
  registry to them and adds hooks for the rest.
- True CLI-only / Python-venv / platform-adapter commands (messaging bridges,
  egress proxy, OSV security audit, cua-driver installer, ACP stdio, pets
  sprites, curator, lsp) are marked **dropped or thin-wrapper** — see §5 for
  "no TS equivalent found" risks.

## 2. Current Python implementation

Source of truth paths (all under `D:/hermes-agent-cn`):
- `cli.py` (19,091 lines) — monolith with the interactive chat REPL, `cmd_*`
  helpers, and most agent-session logic.
- `hermes_cli/main.py` (13,269 lines) — entry point; builds argparse; defines
  `cmd_chat`, `cmd_gateway`, `cmd_proxy`, `cmd_whatsapp`, `cmd_whatsapp_cloud`,
  `cmd_setup`, `cmd_model`, `cmd_auth`, `cmd_status`, `cmd_cron`, `cmd_kanban`,
  `cmd_project`, `cmd_hooks`, `cmd_doctor`, `cmd_security`, `cmd_approvals`,
  `cmd_dump`, `cmd_debug`, `cmd_config`, `cmd_skin`, `cmd_backup`, `cmd_import`,
  `cmd_version`, `cmd_uninstall`, `cmd_gui`, `cmd_update`, `cmd_profile`,
  `cmd_dashboard`, `cmd_completion`, `cmd_prompt_size`, `cmd_logs`,
  `cmd_console`, `cmd_memory`, `cmd_acp`, `cmd_tools`, `cmd_insights`,
  `cmd_skills`, `cmd_pairing`, `cmd_plugins`, `cmd_mcp`, `cmd_claw`, etc.
- `hermes_cli/_parser.py` (503 lines) — top-level parser + `chat` subparser;
  declares global flags `--version/-V`, `-z/--oneshot`, `--usage-file`,
  `-m/--model`, `--provider`, `--reasoning`, `-t/--toolsets`, `-r/--resume`,
  `--in`, `-c/--continue`, `-s/--skills`, plus (from docs) `--profile/-p`,
  `--worktree/-w`, `--yolo`, `--tui`, `--cli`, `--dev`.
- `hermes_cli/subcommands/` — modular parsers: `update`, `uninstall`,
  `dashboard`, `gui`, `logs`, `prompt_size`, `memory`, `acp`, `tools`,
  `insights`, `monitoring`, `skills`, `pairing`, `plugins`, `mcp`, `claw`,
  `import_agent`, `cron`, `gateway`, `auth`, `approvals`, `backup`, `config`,
  `console`, `debug`, `doctor`, `dump`, `hooks`, `login/logout`, `model`,
  `profile`, `security`, `setup`, `skin`, `slack`, `status`, `sync`, `verify`,
  `version`, `webhook`, `whatsapp`.
- Inline parser registration in `main.py` for: `moa` (~11872), `fallback`
  (~11890), `secrets` (~11924), `egress` (~11974, dispatched via
  `hermes_cli/proxy_cli.register_cli`), `migrate` (~12004), `whatsapp-cloud`
  (~12069), `checkpoints` (~12197), `bundles` (~12250), `plugins` (~12286),
  `curator` (~12321), `pets` (~12342), `journey`/`learning`/`memory-graph`
  (~12362), `computer-use` (~12393), `sessions` (~12597), `completion`
  (~13080). `lsp` registers dynamically from `agent.lsp.cli.register_subparser`
  (~12045).
- Domain modules the `cmd_*`/`subcommands` handlers delegate to:
  `hermes_cli/{config.py, skin_cmd.py, backup.py, moa_cmd.py, fallback_cmd.py,
  secrets_cli.py, send_cmd.py, webhook.py, status.py, cron.py, kanban.py,
  projects_cmd.py, hooks.py, doctor.py, security_audit.py, dump.py, debug.py,
  logs.py, console_engine.py, pairing.py, skills_hub.py, bundles.py, curator.py,
  journey.py, memory_setup.py, mcp_config.py, mcp_catalog.py, plugins.py,
  portal_cli.py, tools_config.py, pets.py, sessions_cmd.py, session_export.py,
  completion.py, update_cmd.py, uninstall.py, gateway.py, setup.py,
  setup_whatsapp_cloud.py, slack_cli.py, auth_commands.py, migrate.py,
  proxy_cli.py, oneshot.py}`.

Data flow (today): shell argv → `hermes_cli/main.py:main()` argparse dispatch →
`cmd_*` → domain module → config (`~/.hermes/config.yaml`), `.env`, SQLite
`state.db`, session store, gateway service, or agent loop (`run_agent.py`).
`--profile` is consumed **pre-argparse** (`_apply_profile_override`, sets
`HERMES_HOME`); `_BUILTIN_SUBCOMMANDS` in `main.py` (~line 10957) is the
authoritative command list, including hidden internal worker subcommands
`__slash-worker`, `__compute-host`, `__gateway-restart-watch`,
`__update-gateway-helper` (runtime-internal — out of scope).

Docs: `website/docs/reference/cli-commands.md` (1,713 lines) is the authoritative
flag/subcommand surface; global flags table (§Global options), `hermes chat`
table including `-q`, and the `hermes -z <prompt>` scripted one-shot section
(§`hermes -z`) with `--usage-file`.

Tests: `tests/hermes_cli/` (607 files; e.g. `test_commands.py`,
`test_argparse_flag_propagation.py`, `test_auth_commands.py`,
`test_approvals_command.py`, `test_backup.py`, `test_profiles.py`,
`test_uninstall_*.py`) and `tests/cli/` (107; `test_bang_shell_mode.py`,
`test_prompt_stash.py`, `test_cli_external_editor.py`, `test_update_command.py`,
`test_worktree.py`).

## 3. Target TypeScript design

Module layout under `D:/Hermes-CN-Desktop`:

```
web/src/lib/commands/
  catalog.ts        # static CommandSpec registry (source of truth for UI)
  types.ts          # CommandSpec / CommandAction / OneShotResult types
  parser.ts         # lightweight argv tokenizer + option parser (reuse tokenizeShellCommand)
  dispatch.ts       # useCliCommand(): navigate | runRpc | runHook | runThinWrapper
  one-shot.ts       # runOneShot(prompt, opts) -> OneShotResult (replaces hermes -z)
```

`CommandSpec` shape (mirrors the existing `CommandSpec` in
`web/src/lib/builtin-commands.ts`):

```ts
type CommandKind = "route" | "hook" | "rpc" | "palette-only" | "thin-wrapper" | "dropped";
interface CommandSpec {
  name: string; aliases: string[];            // e.g. "gui" -> ["desktop"]
  summary: string;                             // from cli-commands.md table
  kind: CommandKind;
  action?: { type: "navigate"; to: string }
         | { type: "rpc"; cmd: string; args: string[] }
         | { type: "hook"; hook: string }
         | { type: "thin-wrapper"; argv: string[] };
  flags: GlobalFlag[];                         // which global flags apply
  desktopRelevant: boolean;                    // false => dropped/thin-wrapper
}
```

- **Chat / one-shot**: `runSession` action used by the existing composer
  (`use-create-and-send-session`, `use-sessions`); `-z` maps to
  `one-shot.ts` which (phase 1) calls the backend session RPC and (phase 3)
  drives the in-process agent loop. `OneShotResult` =
  `{ text, sessionId, model, provider, usage?: UsageReport }` mirroring
  `--usage-file` JSON keys in the Python docs.
- **Registry consumers**: extend `command-palette.ts` groups with one
  "commands" group listing all `kind !== "dropped"` entries; extend
  `builtin-commands.ts` slash-command palette only with in-chat commands
  (existing: `/compress`; new candidates: `/moa`, `/bundles`, `/skill`).
- **Thin wrapper binary** (optional, for `update`/`uninstall`/`completion`/
  `console`): Rust command `src/commands/cli.rs` spawning `hermes <cmd>`
  via the existing `src/process/runtime.rs` managed-runtime path; webview never
  spawns `hermes` directly (no TTY).

## 4. Data models & persistence

- `CommandSpec` registry is static TS (no DB). Persist nothing new.
- Per-command state stays where it already lives today:
  - Config → `~/.hermes/config.yaml` via `use-config` + Rust
    `src/commands/config_migration.rs` / `gateway.rs`.
  - Sessions → SQLite `state.db` via `use-sessions` / `session_export.rs`.
  - Cron → `~/.hermes/cron/` + `src/commands/cron_runs.rs`.
  - Kanban → `~/.hermes/kanban.db` / `kanban/boards/<slug>/kanban.db`
    (`hermes_cli/kanban_db.py`) — port to the Rust SQLite path when the
    backend is removed.
  - Projects → per-profile project store (`hermes_cli/projects_db.py`);
    desktop already has `routes/projects.tsx` + `use-worktrees`.
  - Checkpoints → `~/.hermes/checkpoints/` shadow git store; desktop keeps it
    backend-side until phase 3, then maps to Rust `src/commands/git.rs`.
- Migration rule: the registry is the only place that decides "this command
  still hits `/api/…` REST/WS" vs "in-process"; no schema migration is needed
  for the catalog itself. `HERMES_HOME`/profile switching stays in
  `src/commands/profiles.rs` (do not re-introduce the pre-argparse env switch).

## 5. Third-party library strategy

| Python dependency / feature | TS equivalent | Evidence (kimi-code) |
|---|---|---|
| `argparse` command tree | `commander` ^13.1.0 (thin wrapper only) | `apps/kimi-code/src/cli/commands.ts` (`createProgram`, `registerXCommand(program)` pattern); `apps/kimi-code/package.json` devDeps |
| Global-option conflict validation | `validateOptions()` + `OptionConflictError` port | `apps/kimi-code/src/cli/options.ts` (prompt×yolo, agent×session conflicts) |
| `prompt_toolkit` REPL | existing React chat UI; no lib | kimi uses `@moonshot-ai/pi-tui` for TUI — not needed in webview |
| Headless one-shot `-z`/`-q` | headless session runner + `--usage-file` JSON | `apps/kimi-code/src/cli/run-prompt.ts` (`PromptOutput`, `goalExitCode`, telemetry shutdown) |
| `zipfile` backup/import | `yazl` ^3.3.1 (+ `yauzl` for read) | `apps/kimi-code/package.json` devDeps |
| PyYAML config | `yaml` npm pkg (kimi has no YAML — uses `smol-toml` ^1.6.1 for its own config; Hermes stays YAML) | `smol-toml` in `apps/kimi-code/package.json`; `packages/agent-core/src/services/config/configService.ts` for get/set/event pattern |
| OAuth (Anthropic/Codex/Nous/Spotify PKCE) | `@moonshot-ai/kimi-code-oauth` (device code) | `apps/kimi-code/src/cli/sub/login.ts` (`runLoginFlow`, `--region`); `apps/kimi-code/src/cli/sub/login-flow.ts` |
| Provider/model picker (`hermes model`, `moa`, `fallback`) | `@moonshot-ai/kimi-code-sdk` catalog + existing `use-model-options`/`use-provider-catalog`/`use-moa-config` | `apps/kimi-code/src/cli/sub/provider.ts` (`handleProviderAdd/List`, `handleCatalogList/Add`) |
| `doctor` diagnostics | `handleDoctor` deps-injection pattern (cwd/stdout/stderr/exit/fileExists/validate) | `apps/kimi-code/src/cli/sub/doctor.ts` |
| `dashboard`/`serve` | `@moonshot-ai/kap-server` + `kimi web` command | `apps/kimi-code/src/cli/sub/web/index.ts`, `sub/web/run.ts`, `rotate-token.ts` |
| ACP server | `@moonshot-ai/acp-server`, `acp-adapter` | `apps/kimi-code/src/cli/sub/acp.ts`, `acp-native.ts` |
| MCP config/catalog | `packages/agent-core/src/mcp/` (already used via `use-mcp`) | `packages/agent-core/src/mcp/` |
| Cron scheduler | `packages/agent-core/src/agent/cron/`, `src/tools/cron/` | README reference list; desktop already has `use-cron` |
| Config service | `IConfigService` get/set + `event.config.changed` | `packages/agent-core/src/services/config/configService.ts` |
| Zip/semver/chalk utils | `yazl`, `semver` ^7.7.4, `chalk` ^5.4.1 | `apps/kimi-code/package.json` |

**No TS equivalent found (risk) — dropped or thin-wrapper:**
- Messaging adapters: `whatsapp` (Baileys), `whatsapp-cloud`, `slack`,
  `send`, `pairing`, `webhook` delivery, `im-onboarding` — kimi-code has **no
  messaging-platform adapters at all**; desktop must either keep them
  backend-side (today) or drop them from standalone. Recorded as
  `dropped`/`backend-only`.
- `egress` (iron-proxy TLS-intercepting daemon) — Go/Rust binary, no TS lib;
  thin-wrapper or drop.
- `security audit` (OSV.dev scan of the Python venv + plugin requirements) —
  Python-ecosystem-specific; keep backend call or drop.
- `computer-use` (cua-driver installer) — shell script execution; implement via
  Rust child-process runner (no TS lib), or thin-wrapper.
- `lsp` (semantic diagnostics for write_file/patch) — no kimi equivalent;
  drop from standalone (or revisit in the agent-loop plan).
- `curator`, `journey`/`learning`/`memory-graph`, `portal`, `claw`,
  `import-agent`, `pets` (animated sprites) — no kimi/TS equivalent; drop or
  thin-wrapper; `pets` could be a from-scratch canvas/SVG module later.
- `console` (safe command console), `completion`, `uninstall`,
  `update` — terminal/install-level; thin-wrapper via Rust spawn, or map
  `update` to the existing desktop auto-update path (`use-app-update`,
  `desktop_update.rs`).

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (already shipped; verified file listings):
- Routes: `models.tsx` (`model`), `cron.tsx` (`cron`), `kanban.tsx`
  (`kanban`), `projects.tsx`/`project-detail.tsx` (`project`), `mcp.tsx`
  (`mcp`), `skills.tsx` (`skills`), `profiles.tsx`/`profile-builder.tsx`
  (`profile`), `logs.tsx` (`logs`), `debug.tsx` (`debug`), `backup.tsx`
  (`backup`/`import`), `memory.tsx`/`external-memory.tsx` (`memory`),
  `analytics.tsx` (`insights`), `console.tsx` (`console`), `soul.tsx`,
  `environment.tsx` (setup-ish), `settings*.tsx` (`config`/`auth`), `history.tsx`
  (`sessions`), `voice.tsx`, `im-onboarding.tsx`, `advanced.tsx`
  (`approvals`/`yolo`), `health.tsx`, `coding-agents.tsx`.
- Hooks: `use-config`, `use-moa-config`, `use-model-options`,
  `use-provider-catalog`, `use-provider-models`, `use-oauth-providers`,
  `use-cron`, `use-mcp`, `use-mcp-servers`, `use-memory`, `use-profiles`,
  `use-sessions`, `use-status`, `use-logs`, `use-yolo-mode`, `use-skills`,
  `use-worktrees`, `use-session-branch`, `use-gateway`, `use-app-update`,
  `use-hot-update-backend`, `use-runtime-update`.
- Lib: `command-palette.ts` (extend groups/actions), `builtin-commands.ts`
  (extend `BUILTIN_COMMAND_SPECS`), `cli-delegation.ts` (reuse
  `tokenizeShellCommand` for the thin-wrapper argv parser).
- Rust commands: `profiles.rs`, `yolo.rs`, `terminal.rs`, `backup.rs`,
  `log_export.rs`, `debug_bundle.rs`, `app_update.rs`/`desktop_update.rs`,
  `runtime_manager.rs`, `gateway.rs`, `memory.rs`, `session_export.rs`,
  `cron_runs.rs`, `git.rs`, `api_proxy.rs`, `ws_proxy.rs`.
- New: `web/src/lib/commands/*` registry + `useCliCommand` hook; optional Rust
  `src/commands/cli.rs` thin-wrapper spawn.

## 7. Removing the WebSocket dependency (migration path)

1. **Phase A (today, keep backend):** every `CommandSpec` action that needs
   live data resolves through `transport.ts`/`gateway-client.ts` exactly as the
   current routes do. Freeze the JSON-RPC/REST surface used by command actions
   (session create/resume, config get/set, cron CRUD, kanban CRUD, model
   catalog, skills registry, profile switch, status, logs tail, backup
   create/import).
2. **Phase B (in-process behind same interface):** `dispatch.ts` exposes
   `CommandAction.run(opts): Promise<CommandResult>`; per-command implementations
   swap from `fetch('/api/…')`/WS RPC to TS modules (config, sessions, cron,
   kanban, model catalog, skills) as the corresponding feature plans land.
   Routes/hooks change only their data source, never their UI.
3. **Phase C (delete WS/REST CLI path):** once every `kind !== "dropped"`
   command resolves in-process, remove `/api/ws` + REST CLI routes; the registry
   becomes pure TS. Keep the frozen JSON-RPC surface documented in
   `packages/protocol` so parity tests can assert no drift.

## 8. Migration phases & task breakdown

- **Phase 0 — registry:** `catalog.ts` with all 60+ commands, aliases
  (`gui`/`desktop`, `learning`/`memory-graph`, `bw`, `ls`/`rm`…), global-flag
  matrix, and `desktopRelevant` verdict; unit test asserts the name set equals
  `_BUILTIN_SUBCOMMANDS` in `hermes_cli/main.py`.
- **Phase 1 — already-covered commands:** wire palette entries for `chat`,
  `model`, `moa`, `fallback`, `config`, `sessions`, `status`, `logs`, `backup`,
  `import`, `profile`, `memory`, `insights`, `analytics` — map to existing
  routes/hooks; add `useCliCommand`.
- **Phase 2 — management commands:** `cron`, `kanban`, `project`, `webhook`,
  `hooks`, `mcp`, `skills`, `bundles`, `plugins`, `tools`, `approvals`,
  `computer-use` status — build missing hooks (`use-approvals`, `use-hooks`,
  `use-bundles`, `use-tools`, `use-webhook`) on existing routes.
- **Phase 3 — diagnostic commands:** `doctor`, `dump`, `prompt-size`, `debug`,
  `checkpoints`, `security audit` (backend-only), `migrate`, `secrets` —
  implement as hooks/RPC with `--json`-style structured output in the UI.
- **Phase 4 — thin wrapper / dropped:** `update`, `uninstall`, `version`,
  `completion`, `console`, `gateway`, `proxy`, `egress`, `lsp`, `setup`,
  `whatsapp`, `whatsapp-cloud`, `slack`, `send`, `pairing`, `skin`, `curator`,
  `journey`, `acp`, `portal`, `pets`, `claw`, `import-agent`, `dashboard`,
  `serve`, `desktop/gui` — record verdicts in catalog; implement only the
  desktop-valuable subset (e.g. `update` → desktop auto-update; `setup` →
  onboarding/`environment.tsx`).
- **Phase 5 — WS removal:** per §7.

## 9. Risks & open questions

1. **No TS equivalents** for messaging adapters (`whatsapp`, `whatsapp-cloud`,
   `slack`, `send`, `pairing`), `egress`, `security audit`, `computer-use`,
   `lsp`, `curator`, `journey`, `portal`, `pets`, `claw`, `import-agent` —
   decide per-command: backend-only today, thin-wrapper, or drop.
2. **`-z` stdout contract** ("nothing else on stdout") has no web equivalent;
   define `OneShotResult` and decide whether the UI shows tool traces (like
   `chat -q`) or hides them (like `-z`).
3. **`update`/`uninstall`/`version`** are install-level; desktop has its own
   update path (`use-app-update`, `desktop_update.rs`) for a different artifact
   (Tauri bundle vs `hermes-agent` checkout). Mapping `hermes update` to desktop
   auto-update is a product decision, not mechanical.
4. **`--profile`** is a pre-argparse `HERMES_HOME` switch in Python; the desktop
   already manages profiles in Rust (`profiles.rs`). Unify semantics before
   removing the backend.
5. **`--tui`/`--cli`/`--dev`** interface flags are meaningless in the webview;
   drop them from the catalog (record in global-flag matrix).
6. **`--worktree`** needs git + branch conventions; desktop has
   `use-worktrees`/`git.rs` but must verify parity with Python worktree naming.
7. **Plugin-registered subcommands** (`hermes <provider>` from memory plugins,
   `lsp`) are dynamic; the registry must support runtime extension (mirror
   `_BUILTIN_SUBCOMMANDS` discovery semantics).

## 10. Test strategy

- **Vitest unit:** `catalog.test.ts` asserting command/alias parity against a
  checked-in fixture extracted from `_BUILTIN_SUBCOMMANDS` and
  `cli-commands.md`; `parser.test.ts` for the thin-wrapper argv tokenizer
  (reuse `cli-delegation.test.ts` style; keep shared fixtures in sync with
  `tests/cli/test_bang_shell_mode.py` / `test_argparse_flag_propagation.py`).
- **Hook/route tests:** per-phase hooks follow the existing
  `use-cron.test.ts`/`use-moa-config.test.ts` pattern (mock
  `transport.ts`/`gateway-client.ts`).
- **Parity tests (Python behavior):** `tests/hermes_cli/test_commands.py`,
  `test_approvals_command.py`, `test_backup.py`, `tests/cli/test_worktree.py`,
  `test_update_command.py` define the behavioral contract; port the
  high-value ones as `web/src/lib/commands/*.test.ts`.
- **Playwright E2E:** command-palette → each `route` command navigates to the
  expected route; one-shot runner parity vs Python `-z` against a fake model
  (existing `e2e/` harness).
- **Rust tests:** thin-wrapper `cli.rs` uses `wiremock`/`tempfile` per
  `AGENTS.md` conventions (no real network, no fixed paths).

## 11. Reference links

- Python docs: `D:/hermes-agent-cn/website/docs/reference/cli-commands.md`
- Python impl: `D:/hermes-agent-cn/cli.py`, `hermes_cli/main.py`,
  `hermes_cli/_parser.py`, `hermes_cli/subcommands/*.py`,
  `hermes_cli/{config,backup,oneshot,moa_cmd,fallback_cmd,secrets_cli,kanban,
  projects_cmd,cron,status,logs,debug,dump,doctor,hooks,skills_hub,bundles,
  curator,mcp_config,plugins,portal_cli,pets,sessions_cmd,completion,
  update_cmd,uninstall,gateway,setup,slack_cli,auth_commands,migrate,
  proxy_cli}.py`
- Feature inventory: `D:/hermes-agent-cn/features_report.md` §6
- TS reference: `D:/kimi-code/apps/kimi-code/src/cli/commands.ts`,
  `options.ts`, `run-prompt.ts`, `run-shell.ts`, `sub/{provider,doctor,login,
  acp,web/index,export}.ts`; `packages/agent-core/src/services/config/
  configService.ts`; `apps/kimi-code/package.json`
- Desktop integration: `D:/Hermes-CN-Desktop/web/src/lib/
  {builtin-commands,command-palette,cli-delegation,transport,gateway-client,
  tauri-bridge}.ts`, `web/src/hooks/`, `web/src/routes/`, `src/commands/*.rs`
