# Profiles — Python → TypeScript Rewrite Plan

## 1. Summary

Profiles give users multiple **fully isolated Hermes instances** on one machine: each profile is a
self-contained `HERMES_HOME` directory carrying its own `config.yaml`, `.env`, memory (`memories/`),
sessions, skills, cron jobs, gateway state and logs. The `default` profile is the legacy `~/.hermes`
root — zero migration. A second surface is the **multi-user API server** (`gateway.multiplex_profiles`):
one shared HTTP listener routes `/p/<profile>/v1/...` requests to the matching profile with
per-profile bearer keys. A third surface is **portability**: `/export`/`/import` (also
`hermes profile export|import`) pack a profile into a credential-stripped `.tar.gz`; **profile
distributions** (`hermes profile install|update|info`) publish a profile as a git repo whose
`distribution.yaml` declares which paths are distribution-owned vs user-owned.

In the end-state TypeScript architecture the React webview hosts the agent runtime in-process, so
"profile" becomes an **in-process directory scoping primitive**: every profile-scoped subsystem
(config, sessions, memory, skills, cron) resolves its paths through one `getProfileHome(name)`
function (the TS analog of Python's `hermes_constants.get_hermes_home()`), and the multi-user API
server becomes an in-process request router over per-profile "homes". Rust stays for OS-level pieces
that already exist: profile switching with fault recovery (`src/commands/profiles.rs`), ZIP backup
(`src/commands/backup.rs`), file dialogs and (for distributions) git transport (`src/commands/git.rs`).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **Core profile ops — `hermes_cli/profiles.py` (~2400 lines).**
  - Layout: named profiles live under `_get_profiles_root()` = default home `/ profiles`; `default`
    is the root itself (`get_profile_dir()`, `_get_default_hermes_home()`).
  - Name rules: `_PROFILE_ID_RE = ^[a-z0-9][a-z0-9_-]{0,63}$`, `normalize_profile_name()` (title-case
    → lowercase, `Default` → `default`), `validate_profile_name()`, reserved names + hermes
    subcommand collision (`_RESERVED_NAMES`, `_HERMES_SUBCOMMANDS`).
  - Wrapper aliases: `create_wrapper_script()` writes `~/.local/bin/<alias>` (`hermes -p <profile> "$@"`,
    `.bat` on Windows); `build_alias_map()` reverse-scans wrapper files once (perf guard
    `_WRAPPER_READ_LIMIT`); `remove_wrapper_script()` verifies content before unlink (traversal-safe).
  - Sticky active profile: `active_profile` file at root; `get/set_active_profile(_name)`;
    `_apply_profile_override` in `hermes_cli/main.py` re-reads it at startup (guarded by
    `HERMES_DESKTOP_MANAGED=1` and `HERMES_S6_SUPERVISED_CHILD=1`, per
    `tests/hermes_cli/test_apply_profile_override.py`).
  - Creation/clone: `create_profile()` bootstraps `_PROFILE_DIRS` (memories, sessions, skills, skins,
    logs, plans, workspace, cron, home); `--clone` copies `_CLONE_CONFIG_FILES`
    (`config.yaml`, `.env`, `SOUL.md`) + `memories/MEMORY.md`, `memories/USER.md`; `--clone-all`
    copytree minus `_CLONE_ALL_HISTORY_EXCLUDE_ROOT` / `_CLONE_ALL_DEFAULT_EXCLUDE_ROOT`;
    `--no-skills` writes `.no-bundled-skills` marker. Fresh profiles get a placeholder owner-only `.env`
    (`backfill_profile_envs()`).
  - Listing/serving: `ProfileInfo` dataclass (name, path, is_default, gateway_running, model,
    provider, has_env, skill_count, alias_path/alias_name, distribution_*, description,
    description_auto via `profile.yaml`); `list_profiles()`; **`profiles_to_serve(multiplex,
    profile_allowlist)`** is the single chokepoint the gateway uses to decide which profiles to serve.
  - Delete/rename: `delete_profile()` stops gateway/backends and rmtree-with-retry; `rename_profile()`
    also rewrites Honcho host blocks (`_migrate_honcho_profile_host`).
  - **Export/import:**
    - `export_profile(name, output_path, extra_files)` — default profile uses root allow-list
      `_DEFAULT_EXPORT_INCLUDE_ROOT`; named profiles drop only `{auth.json, .env}`; `extra_files`
      (e.g. `desktop.json` from the desktop app) is staged; `_scrub_export_secrets()` force-redacts
      secret-shaped strings in text files (`_EXPORT_REDACT_SUFFIXES`); `_make_profile_archive()`
      writes **GNU-format** tar.gz (not PAX — macOS Finder rejects PAX fractional mtimes).
    - `import_profile(archive_path, name)` — inspects top-level dirs (`_inspect_profile_archive_roots`),
      rejects `default`, refuses existing names, `_safe_extract_profile_archive()` blocks path escapes
      (`_normalize_profile_archive_parts`) and non-file members.
  - Isolation: `resolve_profile_env(profile_name)`; the profile override is a **ContextVar**
    (`set_hermes_home_override` / `reset_hermes_home_override` in `hermes_constants`) — see
    `tests/test_profile_isolation_runtime.py` (skills_hub, gateway cache dir, rich_sent_store, async
    worker threads must follow the override).
- **Distributions — `hermes_cli/profile_distribution.py` (781 lines).**
  - `distribution.yaml` manifest: `DistributionManifest` (name, version, description,
    `hermes_requires` semver check, `env_requires`, `distribution_owned`, source, installed_at);
    `EnvRequirement`; defaults `DEFAULT_DIST_OWNED = SOUL.md, config.yaml, mcp.json, skills, cron,
    distribution.yaml`; `USER_OWNED_EXCLUDE` (credentials, DBs, memories, sessions, logs, local/).
  - `plan_install()` (staging: git clone or local dir; symlink rejection; version check);
    `install_distribution()` (bootstrap user dirs + `_copy_dist_payload` with `preserve_config=False`);
    `update_distribution()` (re-pull from recorded `source:`, preserve user config unless
    `--force-config`); `describe_distribution()`; `.env.template` → `.env.EXAMPLE`.
- **Config — `hermes_cli/config.py`.** Per-profile `config.yaml`/`.env` under the active home;
  `save_env_value` denylist includes `HERMES_HOME`/`HERMES_PROFILE`/`HERMES_CONFIG`/`HERMES_ENV`
  (runtime-location vars never writable from the dashboard); cache invalidation on mtime; atomic
  writes; corrupt-config `.bak` snapshot.
- **CLI/docs surface.** `hermes profile list|use|create|delete|show|alias|rename|export|import|
  install|update|info` (`website/docs/reference/cli-commands.md` §hermes profile,
  `website/docs/reference/profile-commands.md`); `/export` `/import` chat commands live in
  `hermes_cli/cli_commands_mixin.py::_handle_export/_handle_import_command` and are CLI-only
  (`website/docs/reference/slash-commands.md`). Multi-user API: `website/docs/user-guide/features/
  api-server.md` §Multi-profile routing — `/p/<profile>/…` prefixes, per-profile `API_SERVER_KEY`
  from the profile's `.env` (named prefix rejects the default key, fails closed), `API_SERVER_MODEL_NAME`
  defaults to profile name on `/v1/models`.

## 3. Target TypeScript design

Module layout under `web/src` (in-process, no Python backend):

```
web/src/lib/profiles/
  home.ts        # getProfileHome(name), profilesRoot(), defaultHome(), isDefault() — mirrors hermes_constants
  registry.ts    # list/create/rename/delete/clone — directory + profile.yaml CRUD
  active.ts      # read/write active_profile sticky; hydrate atom; mirrors _apply_profile_override guard
  validate.ts    # NAME_RE, normalize, reserved names, alias collision (calls Rust where check PATH)
  export.ts      # exportProfile(name, dest, extraFiles) — stage → scrub → archive
  import.ts      # importProfile(archive, name) — inspect roots → safe extract → move
  distribution.ts# readManifest/planInstall/install/update/info — git via Rust, ownership rules in TS
  router.ts      # in-process multi-profile API router (/p/<profile>/, per-profile auth, allowlist)
  redact.ts      # secret scrubbing for export (thin port of agent.redact.redact_sensitive_text)
web/src/stores/ui.ts      # activeProfileAtom, managementProfileAtom, profileSwitchingAtom (already exist)
packages/protocol/src/hermes-api.ts  # extend Zod schemas: ProfileExport/Import, DistributionManifest
```

Core interfaces (pseudocode):

```ts
interface ProfileHome { name: string; root: PathLike; isDefault: boolean; }
function getProfileHome(name: string): ProfileHome;         // "default" → root, else root/profiles/<name>
function getActiveProfile(): string;                        // read <root>/active_profile
class ProfileRegistry {
  list(): Promise<ProfileSummary[]>;
  create(req: ProfileCreateRequest): Promise<ProfileCreateResponse>;   // clone/cloneAll/noSkills
  rename(oldName: string, newName: string): Promise<void>;
  delete(name: string, opts: { force: boolean }): Promise<void>;
  setActive(name: string): Promise<void>;                   // sticky write (web) — Rust switchProfile handles restart
}
class ProfileExporter { export(name: string, dest: Path, extra?: Record<string,string>): Promise<Path>; }
class ProfileImporter { import(archive: Path, name?: string): Promise<ProfileHome>; }
class DistributionService {
  plan(source: string): Promise<InstallPlan>;               // git URL or local dir → manifest + preview
  install(plan: InstallPlan, opts: { alias?: boolean; force?: boolean }): Promise<ProfileHome>;
  update(name: string, opts: { forceConfig?: boolean }): Promise<InstallPlan>;
  info(name: string): Promise<DistributionInfo>;
}
```

Data flow in the end state: the agent runtime is constructed **per request** (or per long-lived
session) with `home = getProfileHome(requestedProfile)`; every subsystem (config loader, memory,
skills hub, cron scheduler, session store, gateway state) is constructed with that home, exactly as
`AIAgent(gateway_session_key=...)` and the `set_hermes_home_override` ContextVar scope a Python turn.
The multi-user API server is a small router: `router.handle(req, profile)` resolves profile from
`/p/<name>/` prefix (or `X-Hermes-Profile` header / `profiles_to_serve` allowlist), verifies that
profile's own bearer key, then runs the turn in that profile's home. Cron stays per-profile: the
in-process scheduler reads `getProfileHome(job.profile)` **at tick time** (parity with
`tests/cron/test_cron_profile_isolation.py`).

## 4. Data models & persistence

- **Source of truth = file system** (same as Python): `<root>/profiles/<name>/` directories with
  `config.yaml`, `.env`, `SOUL.md`, `memories/`, `sessions/`, `skills/`, `cron/`, `logs/`,
  `profile.yaml` (description/description_auto), optional `distribution.yaml`. `default` = `<root>`.
- **Sticky active**: `<root>/active_profile` plain file (write removes the file for `default`).
  Rust `src/commands/profiles.rs` already implements `read/write_active_profile_sticky` — keep it as
  the authority; the TS `active.ts` reads it through IPC or the fs bridge.
- **Summary cache (read model)**: Desktop UI SQLite (`web/src/stores/ui-store.ts` / Rust `ui_store.rs`)
  can cache `ProfileSummary[]` + `{active, current}` for fast boot, but it is a cache — the registry
  re-scans directories and invalidates like today's React-Query `["profiles"]` key.
- **Sessions/state.db**: each profile owns its own SQLite (or minidb) DB under its home; the in-process
  session store must be constructed with the profile home, never a module-level global (parity with
  the Python import-time-frozen-constant hazard in `tests/test_profile_isolation_runtime.py`).
- **Export archive**: `.tar.gz` (GNU-style, integer mtimes) containing one top-level `<name>/`
  directory; archive manifest not required — root dir name is the inferred name on import (mirrors
  `_inspect_profile_archive_roots`). Desktop extras (`desktop.json`) staged as `extraFiles`.
- **Distribution**: `distribution.yaml` parsed into a typed `DistributionManifest` (Zod); ownership
  rules (`distribution_owned` vs `USER_OWNED_EXCLUDE`) are constants in TS; `.env.EXAMPLE` written on
  install; `source:` + `installed_at:` recorded back into the manifest.
- **Schema migration**: profile directories carry no schema version of their own; config.yaml version
  migration stays a per-profile config concern (TS `config-migration.ts` already exists in the app).

## 5. Third-party library strategy

| Python dependency / behavior | TS equivalent | Evidence |
|---|---|---|
| `HERMES_HOME` path scoping (`hermes_constants.get_hermes_home`) | Build from scratch: `profiles/home.ts` `getProfileHome()`; borrow kimi-code's **single-home pattern** `resolveKimiHome()` → `config/path.ts` (`KIMI_CODE_HOME` anchors config.toml, sessions, session_index.jsonl, workspaces.json, mcp.json, credentials, logs, plugins) and extend it to N homes | `D:/kimi-code/packages/agent-core/src/config/path.ts`, `src/session/store/session-store.ts` (`join(homeDir,'sessions')`), `src/services/config/configService.ts` |
| `yaml.safe_load` (PyYAML) for `config.yaml` / `distribution.yaml` | `js-yaml` (^4.1.1) + `zod` (^4.3.6) validation | `D:/kimi-code/packages/agent-core/src/profile/load.ts` (`import { load as loadYaml } from 'js-yaml'`, `RawAgentProfileSchema.safeParse`) |
| `tarfile` GNU-format export/import (`profiles.py`) | npm `tar` (^7.5.13) for .tar.gz read/write with symlink support; safe-extract loop reimplemented in TS (no path escapes, reject non-regular members) | `D:/kimi-code/packages/agent-core/package.json` (`tar: ^7.5.13`), used in `src/tools/support/rg-locator.ts` (`import { extract as extractTar } from 'tar'`) |
| `shutil.copytree` ignore filters / clone | Node `fs.cp` with filter + `ignore` npm package (already a kimi-code dep, ^5.3.2) | `D:/kimi-code/packages/agent-core/package.json` (`ignore: ^5.3.2`) |
| `subprocess git clone` for distributions | Reuse Rust `src/commands/git.rs` via IPC (Tauri) — git stays OS-level; no pure-TS git lib needed | `D:/Hermes-CN-Desktop/src/commands/git.rs` |
| Secret redaction (`agent.redact.redact_sensitive_text(force=True)`) | **No TS equivalent found** — implement `profiles/redact.ts` from scratch (regex + entropy heuristics port); parity-tested against Python fixtures | kimi-code has no redaction module |
| `~/.local/bin` wrapper scripts (POSIX sh / Windows .bat) | **No TS equivalent** — on Windows generate `.bat` from TS; on POSIX keep a tiny Rust command or skip (Desktop users launch via the app, wrappers remain CLI-side); keep Rust `switch_profile` as the restart mechanism | `D:/Hermes-CN-Desktop/src/commands/profiles.rs` |
| Multi-profile API routing + per-profile bearer keys | **No kimi-code equivalent** (kimi-code is a single-user CLI with no HTTP API server); build `profiles/router.ts` from scratch reusing the existing `web/src/lib/transport.ts` `X-Hermes-Profile` stub + `gateway-client.ts` WS | `D:/Hermes-CN-Desktop/web/src/lib/transport.ts` lines 13–46 |
| Subagent/role persona (SOUL.md, description, role routing) | kimi-code's `profile/` system IS the closest TS match — YAML role profiles with `extends` inheritance, tools allowlist, modelPreference, system-prompt renderers. Reuse its loader/resolver shape for the persona part of a profile (not for instance isolation) | `D:/kimi-code/packages/agent-core/src/profile/{types,load,resolve}.ts` |

**kimi-code has no equivalent of isolated multi-instance profiles** — its `profile/` module means
"subagent role definition", not "separate HERMES_HOME". We borrow its home-anchoring + agent-file
discovery + YAML/Zod patterns and build the multi-home registry/router from scratch.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse now:** `web/src/routes/profiles.tsx` (list/create/rename/model/description/soul/delete
  dialogs), `web/src/routes/profile-builder.tsx` (5-step wizard: identity/model/skills/hub/MCP),
  `web/src/hooks/use-profiles.ts` (all queries/mutations + `resolveBootstrapProfile` one-shot
  hydration + `PROFILE_AWARE_QUERY_KEYS` invalidation list), `web/src/components/profiles/*`
  (ProfileCard, dialogs, scope banner), `web/src/components/sidebar/profile-selector.tsx`,
  `web/src/components/profile-switch-overlay.tsx`, Jotai stores `activeProfileAtom`,
  `managementProfileAtom`, `profileSwitchingAtom`.
- **Reuse Rust:** `src/commands/profiles.rs` `switch_profile` (stop + respawn dashboard with new
  HERMES_HOME, `Recovered`/`Down` fault recovery) — the electron-restart switch path stays;
  `src/commands/backup.rs` ZIP backup/restore for the existing "backup" UX; `src/commands/git.rs` for
  distribution clone/fetch; file dialogs (`src/commands/file_dialogs.rs`) for export/import pickers.
- **Gap to fill in UI:** profile **export/import** entry points (⌘K → Export/Import profile…, profile
  card menu, settings) — currently only the Rust backup path exists, not the `/export`-equivalent
  `.tar.gz` UI; distribution **install/update/info** screens (manifest preview, env_requires form,
  update button with `--force-config`); multi-profile **API server** management in settings (per-profile
  `API_SERVER_*` env editor, port/key, `/p/<profile>/` URL copy). `routes/settings.tsx` already hosts
  cron (profile-scoped via `cronJobProfile(job)`) and runtime fields — add the API-server section there.

## 7. Removing the WebSocket dependency (migration path)

Today the Desktop calls Python: REST `/api/profiles*` (list/create/delete/rename/soul/model/
description/setup-command/active) + WS JSON-RPC for runtime. Migration is phased and keeps the
REST surface frozen so old and new code interoperate:

1. **Phase A — facade**: create `web/src/lib/profiles/` in-process module exposing the same functions
   the hooks use today (list/create/delete/rename/setActive/…), initially implemented by calling the
   REST endpoints (thin wrapper). All existing React code is unchanged; the facade becomes the only
   importer of `/api/profiles`.
2. **Phase B — read path in-process**: `registry.list()` and `active.ts` switch to direct fs/IPC
   reads (Rust fs bridge) while writes still go to REST. Profile-scoped runtime data (config, soul,
   env, skills, sessions, cron) moves to in-process stores constructed from `getProfileHome()` —
   the WS `X-Hermes-Profile`/`/p/<profile>/` calls are replaced by direct in-process routing.
3. **Phase C — write path in-process**: create/rename/delete/export/import/distribution mutate the
   fs through the TS registry; Rust `switch_profile` keeps owning the dashboard respawn.
4. **Phase D — delete WS/REST**: remove `/api/ws` + `/api/profiles*` client code; keep the frozen
   interface (`ProfileRegistry` methods, `ActiveProfile{active,current}`, `ProfileSummary` Zod) as the
   stable contract for the agent core host.

Frozen API surface during migration: `GET /api/profiles`, `GET /api/profiles/active` (returning
`{active, current}`), `POST /api/profiles`, `PATCH/DELETE /api/profiles/{name}`, `PUT /model`,
`PUT /description`, `POST /describe-auto`, `GET/PUT /soul`, `GET /setup-command`, plus the new
`POST /api/profiles/{name}/export` / `POST /api/profiles/import` (to be replaced by in-process
archive handling in Phase C).

## 8. Migration phases & task breakdown

- **P0 — foundations**: `home.ts` + `validate.ts` + `active.ts`; port `_PROFILE_DIRS` bootstrap,
  name normalization/validation, `active_profile` read/write. Parity tests vs `test_profiles.py`
  (normalize/validate, default home, active sticky, env placeholder, clone filters).
- **P1 — registry CRUD**: `registry.ts` create/clone/clone-all/no-skills/rename/delete/list
  (gateway_running probe via Rust or pid file), `profile.yaml` description persistence
  (atomic write, keep-unknown-fields semantics from `test_write_profile_meta`). Wire into
  `use-profiles.ts` facade (Phase A).
- **P2 — isolation plumbing**: thread `getProfileHome()` through config/soul/env/skills/sessions/
  cron stores; runtime isolation tests equivalent to `test_profile_isolation_runtime.py` and
  `test_cron_profile_isolation.py` (tick-time home resolution; async worker context).
- **P3 — export/import**: `export.ts`/`import.ts` + `redact.ts`; GNU tar.gz write/read via `tar`;
  desktop.json `extraFiles`; safe-extract + root inspection; UI entries (⌘K, card menu, settings).
  Parity tests vs `TestExportImport` (default allow-list, `.env` excluded, broken symlinks survive,
  import refuses existing/`default`, path-escape rejection).
- **P4 — distributions**: `distribution.ts` manifest parse (js-yaml+Zod), `plan/install/update/info`,
  ownership rules, env_requires → `.env.EXAMPLE`, git via Rust `git.rs`; UI wizard for install +
  update button. Parity vs `profile_distribution.py` semantics (`USER_OWNED_EXCLUDE`, `--force-config`,
  symlink rejection, semver check).
- **P5 — multi-user API router**: `router.ts` `/p/<profile>/` prefix + per-profile bearer key check
  (fails closed), allowlist, `/v1/models` advertises profile name; settings UI for per-profile
  `API_SERVER_*`; keep WS for streaming until Phase D.
- **P6 — cleanup**: delete WS/REST profile paths, drop `X-Hermes-Profile` stub, remove `web/src/lib/`
  profile REST helpers; document frozen contract.

## 9. Risks & open questions

- **No TS equivalent for multi-instance profile isolation** (biggest gap). kimi-code's "profile" is a
  role/subagent file, not a separate home; we must build the registry + ContextVar-like scoping from
  scratch. Risk: module-level path globals re-leak (the exact bug class in
  `test_profile_isolation_runtime.py`) — mitigate with a lint rule banning `getProfileHome()`-derived
  constants at import time and mandatory runtime-isolation tests.
- **Archive parity**: Python writes GNU tar.gz (longlink extensions, symlinks preserved); Node `tar`
  must round-trip Python-produced archives (esp. macOS "Error 94" PAX issue) and vice versa. Add a
  cross-format fixture test early. The existing Rust `backup.rs` ZIP path is a parallel format — keep
  it only for the "backup" UX or migrate it to tar.gz to avoid two archive formats.
- **Secret scrubbing parity**: `agent.redact.redact_sensitive_text(force=True)` has no TS equivalent;
  a from-scratch redactor risks false negatives/positives. Mitigate: shared fixture corpus from Python
  tests, conservative rules, and never scrub on live files (stage first).
- **Windows specifics**: wrapper `.bat` generation, `%LOCALAPPDATA%` hermes root, file byte-range
  locks during export (already handled by Rust `backup.rs` skip/warn logic — reuse that strategy),
  case-insensitive profile names.
- **Cron/multi-user isolation under one process**: per-profile cron ticker and per-request API turns
  must not share module singletons; requires disciplined DI of `ProfileHome`.
- **Open questions**: keep `hermes profile` CLI as the authority and have TS only mirror it, or move
  ownership into TS? Do we adopt tar.gz for all exports (dropping ZIP backup format)? Where does
  per-profile secret storage live in TS (OS keychain vs profile `.env`)?

## 10. Test strategy

- **Unit (vitest)**: `profiles/home.test.ts` (path resolution, default vs named, Docker-style
  HERMES_HOME), `validate.test.ts` (name/alias rules incl. traversal), `registry.test.ts`
  (bootstrap dirs, clone filters, `.no-bundled-skills`, rename updates sticky, delete refusal of
  default), `export.test.ts`/`import.test.ts` (allow-list, secret exclusion, symlink survival,
  safe-extract path escapes, infer name, refuse existing/`default`), `distribution.test.ts`
  (manifest parse, ownership rules, preserve-config on update, env_requires → `.env.EXAMPLE`,
  semver checks).
- **Isolation runtime (vitest + agent-core harness)**: port `test_profile_isolation_runtime.py`
  (skills hub, cache dirs, async workers resolve the active profile) and
  `test_cron_profile_isolation.py` (cron store + ticker anchor at profile home).
- **Parity tests vs Python**: golden fixtures exported by `hermes profile export` (small archive)
  imported by TS and vice versa; redaction corpus; clone-all exclusion sets.
- **Integration**: React-Query hooks against an in-memory registry (existing
  `use-profiles.test.ts` pattern); Tauri IPC mocks for `switch_profile`/`git`/file dialogs
  (`tauri-bridge.test.ts` pattern).
- **E2E (Playwright)**: profile create → switch (restart overlay) → data scoped to new profile;
  export → import as new name → desktop.json overlay applied; distribution install → update keeps
  memories/sessions. Docker gateway parity is out of scope for the desktop (per `tests/docker/
  test_profile_gateway.py`), but the `switch_profile` fault-recovery contract is covered by Rust
  unit tests already in `src/commands/profiles.rs`.

## 11. Reference links

- Python: `D:/hermes-agent-cn/hermes_cli/profiles.py`, `hermes_cli/profile_distribution.py`,
  `hermes_cli/config.py`, `hermes_cli/cli_commands_mixin.py` (`/export`,`/import`), `hermes_constants.py`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/api-server.md` (§Multi-profile routing),
  `website/docs/reference/cli-commands.md` (§hermes profile),
  `website/docs/reference/profile-commands.md`, `website/docs/user-guide/profiles.md` (§How it works,
  §Sharing), `website/docs/user-guide/profile-distributions.md`, `website/docs/reference/slash-commands.md`
- Tests: `D:/hermes-agent-cn/tests/hermes_cli/test_profiles.py`,
  `tests/hermes_cli/test_apply_profile_override.py`, `tests/test_profile_isolation_runtime.py`,
  `tests/cron/test_cron_profile_isolation.py`, `tests/docker/test_profile_gateway.py`
- TS reference: `D:/kimi-code/packages/agent-core/src/profile/` (types/load/resolve,
  agentfile/discovery, agentfile/paths, agentfile/roots), `src/agent/config/index.ts`,
  `src/services/config/configService.ts`, `src/config/path.ts`, `src/session/store/session-store.ts`,
  `src/tools/support/rg-locator.ts` (tar usage), `packages/agent-core/package.json`
- Desktop: `D:/Hermes-CN-Desktop/web/src/routes/profiles.tsx`, `web/src/routes/profile-builder.tsx`,
  `web/src/routes/settings.tsx`, `web/src/hooks/use-profiles.ts`, `web/src/lib/transport.ts`,
  `web/src/lib/tauri-bridge.ts`, `web/src/stores/ui.ts`, `packages/protocol/src/hermes-api.ts`,
  `src/commands/profiles.rs`, `src/commands/backup.rs`, `src/commands/git.rs`
