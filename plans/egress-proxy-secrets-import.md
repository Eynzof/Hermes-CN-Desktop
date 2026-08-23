# Egress Proxy / Secrets / Import — Python → TypeScript Rewrite Plan

## 1. Summary

This plan covers three related backend features that are currently **CLI-only** in the Python
runtime and have **no desktop UI today**:

1. **`hermes egress`** — iron-proxy credential-injection egress firewall. A pinned Go binary
   (`iron-proxy` v0.39.0) is auto-installed, a long-lived CA is generated, a `proxy.yaml` is
   rendered with per-provider allowlists + a `secrets` transform that swaps opaque proxy tokens
   for real API credentials, and a managed subprocess (pidfile + nonce + startup grace) is
   launched. Docker sandboxes talk to it via `HTTPS_PROXY`; the sandbox never holds real keys.
2. **`hermes secrets`** — Bitwarden Secrets Manager (`bws` CLI, auto-installed v2.0.0), 1Password
   (`op` CLI, never auto-installed), and a plugin-style command secret source, all behind a
   `SecretSource` registry that applies secrets into the process environment at startup with an
   encrypted disk cache.
3. **`hermes import-agent`** (+ small `hermes migrate xai`) — migrate Claude Code (`~/.claude`)
   / Codex CLI (`~/.codex`) instructions, permissions, MCP servers, memories, and skills into
   Hermes, with a mandatory preview phase and **secrets never imported**; `hermes migrate xai`
   is a config.yaml rewrite (retired xAI models) with backup.

Desktop end-state: the Tauri webview runs the agent in-process (TypeScript), Rust stays for
OS-level capabilities. For these features: TS services own orchestration/config logic; new Rust
Tauri commands own binary download/verify/extract, subprocess lifecycle, CA generation, and
filesystem/`.env`/cache persistence. No part of this feature is wired through the WS link today
(no `/api/egress|secrets|import-agent` surface), so the rewrite is greenfield — the only
WS/REST surface to freeze is `/api/env` + `/api/config` used by the settings UI.

## 2. Current Python implementation

### 2.1 Egress proxy (`hermes egress`)

- `agent/proxy_sources/iron_proxy.py` (2k lines, the core module):
  - Constants: `_IRON_PROXY_VERSION = "0.39.0"`, release base URL + `checksums.txt` with detached
    GPG signature, `_MGMT_API_KEY_ENV`, `_MGMT_PORT_OFFSET = 2`, `_DEFAULT_TUNNEL_PORT = 9090`,
    `_DEFAULT_ALLOWED_HOSTS` (OpenRouter/OpenAI/Anthropic/Gemini/xAI/Mistral/Groq/Together/DeepSeek/Nous),
    `_BEARER_PROVIDERS` (env → hosts, Authorization), `_HEADER_AUTH_PROVIDERS` (Anthropic `x-api-key`,
    Azure `api-key`, Gemini `x-goog-api-key`, with `aliases` collapsing into one rule),
    `_NON_BEARER_PROVIDERS` (AWS SigV4, GCP Vertex — warn-only), `_DEFAULT_UPSTREAM_DENY_CIDRS`
    (loopback, IMDS/link-local, RFC1918, IPv4-mapped IPv6, CGNAT, RFC2544),
    `_PROXY_SUBPROCESS_ENV_ALLOWLIST` + `_PROXY_SUBPROCESS_ENV_STRIP` (proxy vars stripped).
  - Binary install: managed `<hermes_home>/bin/iron-proxy` or PATH; pinned tar.gz download,
    best-effort GPG verify of `checksums.txt`, SHA-256 verify, data-filter tar extract, atomic
    rename 0o755. **Raises on Windows** — no native Windows binary as of v0.39.0.
  - CA: `ensure_ca_cert` via host `openssl` (genrsa 4096 + req -x509, 10-year, CN=hermes iron-proxy
    CA) into `<hermes_home>/proxy/ca.{crt,key}`, 0o600 key staged before rename.
  - Config: `build_proxy_config` renders the v0.39 YAML schema: `dns` (disabled loopback),
    `proxy.tunnel_listen` (CONNECT/MITM on tunnel_port), `http_listen` port+1, `https_listen`
    ephemeral, `upstream_deny_cidrs`, `metrics` pinned `127.0.0.1:0`, `management.listen` port+2
    with `api_key_env`, `tls.ca_*`, `transforms: [allowlist(domains), secrets]`; each secrets rule:
    `source:{type: env, var: REAL_ENV}`, `replace.proxy_value`, `match_headers`, `match_query: true`,
    `match_body: false`, `require: true` (fail-closed), `rules:[host]`.
  - Mappings: `mint_proxy_token` (prefix + SHA-256 of 32 urandom bytes), `discover_provider_mappings`,
    `merge_mappings` (preserve tokens by default, `rotate=True` re-mints), `write_mappings` →
    `proxy/mappings.json` (`{version:1, tokens:[{proxy_token, env_name, upstream_hosts,
    match_headers, alias_env_names}]}`), `load_mappings` tolerant of corrupt JSON.
  - Lifecycle: `start_proxy` builds a **minimal env** (allowlist; strips proxy vars; injects
    `HERMES_IRON_PROXY_MGMT_KEY` + per-start nonce), spawns `iron-proxy -config <path>`, pidfile
    O_EXCL/O_NOFOLLOW, polls the configured bind host (5s grace, kills on failure); `_pid_alive`
    nonce/cmdline/`ps` defense; `reload_proxy` POSTs Bearer to loopback `/v1/reload`; `get_status`
    returns `ProxyStatus{enabled,binary_path,binary_version,config_path,ca_cert_path,pid,listening,
    tunnel_port,warnings}`; `stop_proxy` SIGTERM→SIGKILL.
  - Bitwarden rotation mode: `refresh_secrets_from_bitwarden=True` re-fetches via `bws secret list`
    and injects into the child env (the rotation guarantee).
- `hermes_cli/proxy_cli.py` (903 lines): `hermes egress {install,setup,start,stop,restart,reload,
  status,disable,config}`. Setup wizard: install → CA → mint tokens (env discovery falls back to
  loading `~/.hermes/.env`, or `--from-bitwarden` pulls key names from BSM and **fails loud** on
  unreachable BW) → write config/mappings/management.token → enable. Guards: `--rotate-tokens`
  requires typing `rotate` when a tty and backs up `mappings.json.rotated-<ts>`; re-setup **never**
  silently downgrades `credential_source: bitwarden → env` (needs explicit `--no-bitwarden`);
  `cmd_start` refuses to start when `credential_source=bitwarden` but `secrets.bitwarden` is
  disabled/missing/tokenless (unless `proxy.allow_env_fallback`).

### 2.2 Secrets (`hermes secrets`)

- `agent/secret_sources/base.py` — `SecretSource` ABC: `fetch(cfg, home_path) -> FetchResult`,
  `is_enabled`, `override_existing`, `protected_env_vars`, `config_schema`, `remediation`;
  `set_source_environment`/`get_source_environment` (profile-scoped env isolation),
  `run_secret_cli` helper, `ErrorKind` enum, `is_valid_env_name`, `scrub_ansi`.
- `agent/secret_sources/registry.py` — `register_source` (builtin + plugin sources),
  `apply_all(secrets_cfg, home_path, ...)` ordered by enabled sources, `SourceReport`/`ApplyReport`,
  timeout-wrapped fetches (`_fetch_with_timeout`), profile alias support.
- `agent/secret_sources/_cache.py` — `DiskCache` (file TTL cache) + `CachedFetch`.
- `agent/secret_sources/bitwarden.py` — `_BWS_VERSION = "2.0.0"`, `install_bws` (zip download +
  SHA-256 from `bws-sha256-checksums-<ver>.txt`, safe zip extract, Windows/macOS universal/linux
  asset names), `fetch_bitwarden_secrets(access_token, project_id, server_url, cache_ttl, use_cache)`
  via `bws secret list --output json`; **encrypted disk cache** (AES key derived from token
  fingerprint; cache never contains plaintext), stale-cache fallback on network error, skipped on
  auth failure; `_env_loader` calls BSM when `secrets.bitwarden.enabled` at startup.
- `agent/secret_sources/onepassword.py` — `find_op` (never auto-installed), `_validate_references`
  (op:// syntax + env-name validation), `fetch_onepassword_secrets` via `op read`, fingerprint-keyed
  cache (token + references), `apply_onepassword_secrets` with skip/override/token-var guard,
  `OnePasswordSource` implementation.
- `agent/secret_sources/command.py` — `CommandSource`: user-defined CLI helper
  (`secrets.command.<name>.command`), dotenv-blob parse (`unquote_dotenv_value`,
  `parse_secret_output`, `parse_dotenv_map`), hard timeout, **logging never leaks command/secret**,
  failure degrades to empty (non-blocking startup).
- `hermes_cli/secrets_cli.py` (745 lines) — `hermes secrets bitwarden {setup,status,token,sync,
  disable,install}`; masked token prompt; non-interactive guard; region presets (US/EU/self-hosted
  via `--server-url`/`BWS_SERVER_URL`); `sync --apply` exports into current shell.
- `hermes_cli/onepassword_secrets_cli.py` (543 lines) — `hermes secrets onepassword
  {setup,status,token,set,remove,sync,disable}`; `op whoami` verification; token stored in `.env`.
- Config shape in `~/.hermes/config.yaml`: `secrets.bitwarden.{enabled, access_token_env, project_id,
  server_url, cache_ttl_seconds, override_existing, auto_install}`, `secrets.onepassword.{enabled,
  account, service_account_token_env, binary_path, env: {VAR: op://…}, cache_ttl_seconds,
  override_existing}`, `secrets.command.*`.

### 2.3 Import-agent + migrate

- `hermes_cli/agent_import.py` (1024 lines) — detect → parse → map → apply with mandatory preview
  and per-item records (imported/skipped/conflict/error). `SUPPORTED_AGENTS = ("claude-code","codex")`.
  - Claude: `CLAUDE.md` → `memories/MEMORY.md` entries; `settings.json permissions.allow` →
    `config.yaml command_allowlist` (via `claude_rule_to_command_pattern`: `Bash(...)` → glob,
    `:*` → `*`, blanket `Bash` → None); `permissions.deny` → `approvals.deny`; `mcpServers`
    (from `~/.claude.json` preferred, then settings.json) → `mcp_servers`; `skills/*/SKILL.md` →
    `skills/claude-code-imports/`; slash-commands reported skipped.
  - Codex: `AGENTS.md` → memory entries; `config.toml [mcp_servers.*]` → `mcp_servers`;
    `memories/*.md` → memory entries; `skills/*` → `skills/codex-imports/`.
  - Secrets never imported: `_SECRET_KEY_RE` (API[_-]?KEY/TOKEN/SECRET/PASSWORD/AUTH/…), credential
    filenames (`.credentials.json`, `auth.json`, `credentials.json`), MCP env/header sanitize
    (`sanitize_mcp_env`), report `stripped_secrets`.
  - Memory merge: `extract_markdown_entries` (headings/bullets/paragraphs; skips code blocks +
    tables), `parse_existing_memory_entries` (split on `ENTRY_DELIMITER = "\n§\n"` only),
    `merge_entries(existing, incoming, MEMORY_CHAR_LIMIT=20000)` with dedupe by normalized text,
    `backup_memory_file` → `MEMORY.md.bak.<ts>`; atomic YAML writes (`load_yaml_file` refuses
    unreadable/unparseable config — `ConfigReadError`).
  - CLI: `import_agent_command` auto-detects `~/.claude`/`~/.codex`, preview phase → confirm
    (`--yes` for non-tty) → apply → `print_import_report`.
- `hermes_cli/migrate.py` + `hermes_cli/xai_retirement.py` — `hermes migrate xai [--apply]
  [--no-backup]`: scan config.yaml for retired xAI models, dry-run default, timestamped backup,
  in-place rewrite. Small standalone scope.

### 2.4 Docs

- `website/docs/reference/cli-commands.md`: `hermes secrets` L441–459, `hermes migrate` L462–481,
  `hermes egress` L655–714, `hermes import-agent` listed L93.

## 3. Target TypeScript design

### 3.1 Module layout (in-process, no Python backend)

```
web/src/lib/egress/
  egress-types.ts          // ProxyStatus, TokenMapping, ProviderSpec ports
  egress-config.ts         // build iron-proxy YAML config (dict) from mappings + config.yaml
  egress-mappings.ts       // mint/discover/merge/load/write mappings.json
  egress-service.ts        // orchestrates setup/start/stop/restart/reload/status/disable via IPC
web/src/lib/secrets/
  secret-source.ts         // SecretSource interface + FetchResult + registry (port of base.py/registry.py)
  bitwarden.ts             // bws discovery/install/fetch/cache logic
  onepassword.ts           // op reference validation + resolve + apply
  command-source.ts        // CommandSource dotenv-blob helper port
  secret-cache.ts          // cache key/fingerprint/TTL helpers (storage via Rust IPC)
web/src/lib/import-agent/
  import-types.ts          // ImportItem/ImportReport/Summary (port of record/build_report)
  import-parsers.ts        // markdown extractor, rule mapper, secret regex, dotenv/TOML/JSON parsers
  import-memory.ts         // merge_entries + ENTRY_DELIMITER + MEMORY_CHAR_LIMIT + backup
  import-importer.ts       // AgentImporter detect→parse→map→apply (dry-run flag)
  import-command.ts        // CLI-like orchestration invoked from the settings UI
web/src/routes/settings-egress-section.tsx     // egress status/setup UI
web/src/routes/settings-secrets-section.tsx    // Bitwarden/1Password/command-source setup UI
web/src/routes/settings-import-agent-section.tsx // preview→confirm→apply→report UI
src/commands/egress.rs       // Tauri: install_binary, ensure_ca, spawn/stop/status/reload, port probe
src/commands/secret_cli.rs   // Tauri: bws/op subprocess calls, cache read/write/clear
src/commands/import_agent.rs // Tauri: fs read/write/copy/atomic-write for import targets
src/egress.rs                // Rust core: download/verify/extract, pidfile, env allowlist, CA (rcgen)
src/secret_cache.rs          // Rust core: encrypted DiskCache port
src/import_agent.rs          // Rust core: fs helpers (atomic write, backups, skill copy)
```

### 3.2 Egress service

TS owns provider tables (`_BEARER_PROVIDERS`, `_HEADER_AUTH_PROVIDERS`, `_NON_BEARER_PROVIDERS`,
`_DEFAULT_ALLOWED_HOSTS`, `_DEFAULT_UPSTREAM_DENY_CIDRS`) as a single typed constant module, so the
setup UI can enumerate/select providers. `egress-config.ts` renders the exact v0.39 YAML shape from
`build_proxy_config` (verified against `test_iron_proxy.py` `test_build_proxy_config_custom_allowed_hosts`).
Rust `egress.rs` owns: binary download (pinned version + checksums + best-effort gpg), extraction,
atomic install, `openssl`/`rcgen` CA generation, subprocess spawn with the allowlist/strip env,
pidfile + nonce + port-liveness poll, stop (graceful→kill), and the loopback management API client.
TS `egress-service.ts` exposes typed methods (`install`, `setup`, `start`, `stop`, `restart`,
`reload`, `status`, `disable`, `configPath`) that map 1:1 to `ProxyStatus`/`TokenMapping` and to
`proxy_cli.py` semantics (preserve tokens unless rotate; refuse silent credential_source downgrade;
Bitwarden refresh at start). The status UI polls `status` like `hermes egress status`.

### 3.3 Secrets service

`secret-source.ts` ports the `SecretSource` ABC + registry (`apply_all`, source ordering, timeout,
`protected_env_vars`, remediation). `bitwarden.ts` ports: discovery/install (`bws` v2.0.0),
`fetch_bitwarden_secrets` (server_url env, `BWS_ACCESS_TOKEN`), encrypted-cache semantics
(fingerprint key, stale fallback, skip on auth failure). `onepassword.ts` ports reference
validation + `fetch`/`apply` with token-var guard. `command-source.ts` ports the dotenv-blob
helper (unquote, parse, timeout, no-leak logging). Token storage goes to the OS keychain via a new
Rust `credential_store_set/get/delete` Tauri command (per `plans/credential-pools.md` L183
precedent; fallback `FileTokenStorage` = `.env` write via existing Rust `dotenvy`+atomic write).
The settings UI replaces the interactive wizards with forms; `sync` becomes a "test fetch / preview"
button reusing `fetch(..., use_cache=false)`.

### 3.4 Import-agent service

`import-importer.ts` ports `AgentImporter` 1:1: same item record shape, dry-run/execute flag,
`load_yaml_file` refusal semantics, memory merge/backup, rule mapping, `sanitize_mcp_env`, skills
copy. Rust `import_agent.rs` supplies filesystem primitives (read/write/atomic YAML/copy with
`<name>.bak.<ts>` backups) so the TS importer stays pure. The UI follows `settings-coding-agents.tsx`
(detection card) + kimi-code's migration-screen pattern: detect → category plan → preview table →
confirm → apply → per-item report (imported/conflict/skipped/error + `stripped_secrets` list).
`hermes migrate xai` is ported as a tiny config-rewrite utility (`import-agent` repo or
`web/src/lib/config-migrate.ts`) reusing `use-config` write path + backup; can be deferred to
phase 3 without blocking the main feature.

## 4. Data models & persistence

- **Egress** (all under `<hermes_home>/proxy/`, dir 0o700):
  - `ca.crt` (0o644), `ca.key` (0o600), `proxy.yaml` (0o600; embeds proxy tokens),
    `mappings.json` (0o600; `{version:1, tokens:[{proxy_token, env_name, upstream_hosts,
    match_headers, alias_env_names}]}` — keep the version field for forward-compat),
    `management.token` (0o600), `iron-proxy.pid` + `iron-proxy.nonce`, `iron-proxy.log` (0o600),
    `audit.log` (pre-created 0o600; reserved).
  - `config.yaml` `proxy.*`: `enabled, tunnel_port, credential_source (env|bitwarden), auto_install,
    enforce_on_docker, extra_allowed_hosts, upstream_deny_cidrs, allow_env_fallback`.
- **Secrets** — `config.yaml` `secrets.bitwarden.*` / `secrets.onepassword.*` / `secrets.command.*`
  (shapes in §2.2); tokens in `.env` (or keychain once `credential_store` lands); disk caches under
  `<hermes_home>/cache/` with fingerprint-keyed encrypted payloads (Bitwarden) and reference-map
  fingerprints (1Password). On first TS run, **clear the Python-written cache** (re-key) rather
  than trying to decrypt Python-format entries.
- **Import-agent** — no new durable state; targets are `memories/MEMORY.md` (§-delimited + `.bak.<ts>`
  backup), `config.yaml` (merged sections), `skills/<category>/<name>` copies. Migration is
  idempotent via normalized-text dedupe + conflict-skip. No schema bump: all config fields are
  additive; `mappings.json` stays version 1.

## 5. Third-party library strategy

| Python dependency / capability | TS / Rust equivalent | Evidence (kimi-code or Desktop) |
|---|---|---|
| `subprocess` (bws/op/iron-proxy/openssl/gpg) | Rust `std::process::Command` behind Tauri IPC (child spawning already exists for runtime/pty) | Desktop `src/commands/terminal.rs`, `src/commands/runtime_manager.rs`; kimi-code uses node-pty (`apps/kimi-code/src/native`) but Desktop keeps child mgmt in Rust |
| HTTP download + SHA-256 | Rust `reqwest` + `sha2` (binary verify), TS `fetch`/`crypto.subtle.digest` for token fingerprints | Desktop `web/src/lib/transport.ts`; Python `hashlib` parity via Web Crypto (`plans/credential-pools.md` L179) |
| tar.gz / zip extract (iron-proxy, bws) | Rust `tar`+`flate2` / `zip` crates (atomic rename, traversal-safe member pick) | No kimi-code equivalent; new Rust deps (Desktop Cargo.toml has none today) |
| GPG verify of checksums | Keep calling `gpg` binary (best-effort, same semantics as `_verify_checksums_signature`) | from scratch in `src/egress.rs` |
| CA generation (`openssl` CLI) | Rust `rcgen` crate (pure-Rust X.509 CA; alternative: keep `openssl` subprocess) | No kimi-code equivalent; new Rust dep — recommended `rcgen` to stay in-process |
| YAML read/write (`PyYAML`) | `js-yaml` (TS) + `serde_yaml` (Rust, if needed) | kimi-code `packages/agent-core/src/skill/parser.ts`, `src/profile/load.ts`, `agent-core-v2/src/_base/text/frontmatter.ts` all `import { load } from 'js-yaml'` |
| TOML (codex `config.toml`) | `smol-toml` | kimi-code `packages/migration-legacy/src/steps/config.ts` L2 (`parse as parseToml` from `smol-toml`) |
| dotenv (.env load, python-dotenv semantics) | **No TS equivalent in kimi-code** — Desktop already has Rust `dotenvy` (`src/env_file.rs` `read_env_file_vars`); expose via Tauri, or port a small TS parser for previews | Desktop `src/env_file.rs` L65 `dotenvy::from_path_iter` |
| Bitwarden Secrets Manager | **No TS SDK in kimi-code** (0 grep hits for bitwarden). Port: shell out to pinned `bws` CLI via Rust commands (install/verify same as Python; token env, `secret list --output json`); direct HTTP Bitwarden SM API is a fallback but loses bws auth/session behavior | kimi-code has none — explicit no-equivalent risk |
| 1Password (`op` CLI, `op://` refs) | **No TS equivalent** (0 grep hits for 1password/onepassword/`op://`). Shell out to user-installed `op` via Rust commands (`read`, `whoami`, token env) | kimi-code has none — explicit no-equivalent risk |
| Secret storage | Rust `keyring` crate via Tauri `credential_store_*`; fallback `FileTokenStorage` (.env) | `plans/credential-pools.md` L183 (no keyring plugin in Cargo.toml today; `src/connection.rs` reserves `"encoding":"keyring"`) |
| File locks (cross-process) | `proper-lockfile` for TS; Rust flock/atomic-write for cache files | kimi-code `packages/oauth` uses `proper-lockfile` (credential-pools.md L175); `src/env_file.rs` atomic write pattern |
| Import preview/write/backup pattern | Port `packages/migration-legacy` pattern (detect → plan → preview → apply, atomic-write, marker, report) | kimi-code `packages/migration-legacy/src/{detect,atomic-write,prompt,report,run-migration,marker}.ts` + `apps/kimi-code/src/migration/migration-screen.ts` |
| Claude Code / Codex import | **No importer code in kimi-code** — equivalent is the `/import-from-cc-codex` skill (`packages/agent-core/src/skill/builtin/import-from-cc-codex.md`): instructions/skills/MCP only, never credentials, preview-then-write, marker blocks | kimi-code skill doc (prompt-driven, not code) — port the *policy*, write our own TS engine |

**No-TS-equivalent risks (explicit)**: Bitwarden/1Password SDKs, egress/iron-proxy management,
CA generation, and binary download/verify are all absent from kimi-code; they are built from
scratch on the Rust side (safe subprocess + crates) with TS as the thin orchestrator. The
`import-from-cc-codex` skill proves the *policy* but gives no engine — the TS importer is a fresh port of `agent_import.py`.

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (verified by reading):
- **`web/src/hooks/use-env.ts`** (`useEnvVars/useSetEnv/useDeleteEnv/useRevealEnv` →
  `/api/env`) — existing `.env` editing surface; `packages/protocol/src/hermes-api.ts` already
  defines `EnvVarInfo` (L651), `EnvVarsResponse` (L669), `RevealEnvResponse` (L672). The secrets
  UI builds on this for "store token to .env" and sync previews.
- **`web/src/hooks/use-config.ts`** (`useConfig/useConfigSchema/useSaveConfig`) — read/write
  `config.yaml` sections `proxy.*`, `secrets.*`; **`web/src/lib/config-translations.ts` already
  translates `secrets.bitwarden.*` fields (L315–321)** — extend with `secrets.onepassword.*`,
  `proxy.*`.
- **`web/src/hooks/use-skills.ts`**, **`web/src/hooks/use-coding-agents.ts`** +
  **`src/commands/coding_agents.rs`** (`coding_agents_check` — detects claude/codex install +
  login without reading tokens) — detection card for the import-agent section.
- **Settings section pattern**: `web/src/routes/settings.tsx` + `settings-oauth-section.tsx`,
  `settings-models-section.tsx` (env var editing at L604+, `useEnvVars/useSetEnv`), and
  `settings-coding-agents.tsx` — new `settings-egress-section.tsx`, `settings-secrets-section.tsx`,
  `settings-import-agent-section.tsx` follow the same `SettingsSection` shape.
- **Rust**: `src/commands/environment.rs` (`environment_check`), `src/environment.rs`,
  `src/env_file.rs` (dotenvy + `RESERVED_KEYS`; new `secret_cli.rs`/`egress.rs` must keep the
  reserved-key + NUL-skip rules when writing `.env`), `src/state.rs`, `src/error.rs`,
  `src/path_resolver.rs` (PATH refresh for bws/op discovery), `src/process/runtime.rs` (spawn/env
  hygiene patterns), `packages/protocol/src/channels.ts` (WS channels — untouched by this feature).

New Tauri commands to add: `egress_install/ensure_ca/spawn_proxy/stop_proxy/reload_proxy/
proxy_status`, `secret_cli_run` (bws/op with scrubbed env + token injection),
`secret_cache_read/write/clear`, `credential_store_set/get/delete` (keyring), and
`import_agent_fs_*` (read/write/atomic-write/copy/backup). Register in `src/commands/mod.rs`
and the web bridge (`web/src/lib/tauri-bridge.ts`).

## 7. Removing the WebSocket dependency (migration path)

- **Today**: egress/secrets/import-agent are CLI-only; the desktop only touches their config
  through `/api/config` (generic `use-config`) and `.env` through `/api/env` (REST, routed by
  `web/src/lib/transport.ts`; the WS `gateway-client.ts` is used for live session/tool events,
  not these settings).
- **Freeze surface now**: `EnvVarInfo/EnvVarsResponse/RevealEnvResponse` (hermes-api.ts) and the
  `/api/config` GET/PUT contract used by `use-config` — these are the only WS/REST APIs this
  feature depends on; keep them byte-stable while the in-process services land.
- **Phase A**: keep backend calls; add TS services (`egress-service`, secrets registry,
  `import-importer`) that consume Rust IPC directly for new UI, leaving `/api/env` + `/api/config`
  as-is.
- **Phase B**: swap `use-env.ts` + `use-config.ts` behind an in-process adapter: Rust reads/writes
  `.env` (dotenvy) and `config.yaml` (serde_yaml/atomic write) with the same schema; `use-config`
  keeps its hook API so `settings.tsx` sections don't change.
- **Phase C**: delete the Python REST/WS paths (`/api/env`, `/api/config`, `/api/skills` toggle)
  once no caller remains; egress/secrets/import-agent never had a WS path, so their cutover is
  additive — no parallel-server window needed.

## 8. Migration phases & task breakdown

1. **P0 — Foundations (Rust)**: `src/egress.rs` (pinned download+checksum+gpg, tar extract,
   rcgen CA, env allowlist/strip, pidfile/nonce, spawn/poll/stop), `src/secret_cache.rs`
   (encrypted DiskCache + clear-on-first-run), `src/import_agent.rs` (atomic write/backup/copy),
   new Tauri commands + bridge types. Tests: Rust unit (checksum mismatch, perms 0o600, env strip,
   traversal-safe extract).
2. **P1 — TS services**: `egress-config/mappings/service` (build config, discover/merge/load/write,
   status), secrets `base/registry/bitwarden/onepassword/command` + `secret-cache`, import-agent
   parsers/importer/command. Vitest parity ports of the Python unit tests (§10).
3. **P2 — Settings UI**: `settings-egress-section.tsx` (status/setup/start/stop/reload/rotate),
   `settings-secrets-section.tsx` (Bitwarden + 1Password + command source forms, test-fetch,
   token store to keychain/.env), `settings-import-agent-section.tsx` (detect → preview → apply →
   report). Extend `config-translations.ts` for `secrets.onepassword.*`, `proxy.*`.
4. **P3 — Config/env in-process cutover**: adapter behind `use-config`/`use-env`; keep hook API;
   migrate `/api/env` + `/api/config` to Rust IPC; delete REST/WS paths.
5. **P4 — Optional**: `hermes migrate xai` TS port (`web/src/lib/config-migrate.ts` +
   backup), Windows egress status page (see risk 2), parity E2E with real iron-proxy on macOS/Linux
   CI, docs update.

## 9. Risks & open questions

1. **No TS equivalent for Bitwarden/1Password** — kimi-code has zero bitwarden/1password code.
   We shell out to `bws`/`op` CLI via Rust commands (matches Python behavior, including
   auth/session semantics and Windows flags). Direct HTTP SM/Connect APIs are possible but
   introduce a second auth path; open question: should `bws` remain auto-installed (v2.0.0 zip)
   and `op` remain user-installed, as today?
2. **iron-proxy has no native Windows binary (v0.39)** — Python raises on Windows. Desktop is
   Windows-first, so the egress section must degrade gracefully: status shows "unavailable on
   Windows — run in WSL/Linux host" and setup is disabled; `egress.rs` still supports macOS/Linux
   and WSL2 guests. Open question: do we invest in WSL2 proxy wiring or defer egress UI on Windows?
3. **Import-agent parity** — `extract_markdown_entries`, `merge_entries`, and the secret regex
   are subtle; TS port must be fixture-tested against Python output (shared fixture approach like
   `cli-delegation.test.ts` + `test_cli_delegation_classifier.py`). Risk of silent divergence in
   dedupe/overflow behavior.
4. **Encrypted cache cross-implementation** — Python derives AES keys from token fingerprints;
   Rust/TS crypto stack won't share keys. Mitigation: clear the Python cache on first TS run
   (acceptable one-time re-fetch) and document the re-key.
5. **kimi-code "egress/proxy" grep noise** — searched `D:/kimi-code` for egress/iron-proxy:
   matches were false positives (substring/token-folding artifacts in tests/changelogs); verified
   content greps find no egress firewall implementation. `apps/kimi-code/src/utils/proxy.ts` does
   **not exist**; kimi-code "proxy" code is HTTP-client proxy config only.
6. **`hermes migrate` scope** — tiny (xai retirement) but couples config rewrite + backup
   semantics; decide in P4 whether to include or mark out-of-scope-for-desktop (recommend include
   as P4 since `use-config` + backup already exist).
7. **Test-file path drift** — spec listed `tests/hermes_cli/test_import*.py`; actual files are
   `tests/hermes_cli/test_agent_import.py` and unrelated `tests/test_import_accelerator.py`;
   parity tests should target `test_agent_import.py`.

## 10. Test strategy

- **Vitest unit (ports of Python tests)**:
  - Egress: mint-token prefix/length (`test_iron_proxy.py` L52), build-config allowed_hosts + deny
    CIDRs + no `audit_path` on v0.39 (L82/L129), mappings roundtrip headers/aliases + corrupt JSON
    (L465/L156), subprocess-env allowlist/strip (L315), management-token persistence (L493),
    reload bearer POST + 401/422 handling (L513), merge_mappings preserve/rotate, credential_source
    no-silent-downgrade (`test_iron_proxy_cli.py` L85/L298).  - Secrets: Bitwarden asset names + install + server_url env + cache-key mismatch refetch +
    encrypted-cache-no-plaintext + stale fallback + no-fallback-on-auth-failure
    (`test_bitwarden_secrets.py` L79–503); 1Password validation/fetch/cache fingerprint/apply
    never-overrides-token-var (`test_onepassword_secrets.py` L62–277); command source
    unquote/timeout/no-leak/apply/registry (`test_command_secret_source.py` L101–263);
    secret-source registry conformance + remediation + profile isolation
    (`tests/secret_sources/` conformance/error_remediation/profile_secrets/registry).
  - Import: detection, rule mapping, secret regex, markdown extractor, dry-run writes nothing,
    dry-run==real-run item parity, claude/codex flows, secrets never imported
    (`tests/hermes_cli/test_agent_import.py` L185–306).
- **Rust unit**: env_file.rs already covered; new: binary checksum/gpg verify, tar/zip traversal
  rejection, CA perms 0o600, pidfile O_EXCL/nonce, secret cache encryption roundtrip, `.env`
  write with RESERVED_KEYS + NUL skip.
- **Integration**: fake `bws`/`op`/helper executables on PATH (mirroring monkeypatched CLI tests)
  driven through Tauri command harness; verify token env scrubbing and `NO_COLOR`/`BWS_SERVER_URL`
  propagation.
- **E2E (Playwright)**: settings-egress status/setup with mocked binary; secrets setup + sync
  preview; import-agent detect→preview→apply→report; assert no secret values appear in DOM.
  **Parity E2E**: if iron-proxy binary available (macOS/Linux CI), port
  `test_iron_proxy_e2e.py` (Authorization swap L66, x-api-key swap L189, management reload L276)
  as a Rust/TS integration test against the real binary.
- **Protocol tests**: extend `packages/protocol` Zod schemas (`ProxyStatus`, `SecretSourceStatus`,
  `ImportReport`) with schema tests mirroring `EnvVarInfo` style.

## 11. Reference links

- Core: `D:/hermes-agent-cn/agent/proxy_sources/iron_proxy.py`, `hermes_cli/{proxy_cli,secrets_cli,onepassword_secrets_cli,agent_import,migrate}.py`,
  `agent/secret_sources/{base,registry,_cache,bitwarden,onepassword,command}.py`,
  `website/docs/reference/cli-commands.md` (L441–459, L462–481, L655–714)
- Tests: `tests/test_iron_proxy{,_cli,_e2e}.py`, `test_bitwarden_secrets.py`, `test_onepassword_secrets.py`,
  `test_command_secret_source.py`, `tests/secret_sources/`, `tests/hermes_cli/test_agent_import.py`
- kimi-code: `packages/agent-core/src/skill/builtin/import-from-cc-codex.md`;
  `packages/migration-legacy/src/{detect,atomic-write,prompt,report,marker,run-migration,steps/config,steps/mcp,steps/skills}.ts`;
  `apps/kimi-code/src/migration/{detect-pending,migration-screen,badge}.ts`;
  `packages/migration-legacy/package.json` (`smol-toml`), `packages/agent-core/src/skill/parser.ts` (`js-yaml`)
- Desktop: `web/src/lib/{transport,tauri-bridge,gateway-client,cli-delegation,config-translations}.ts`,
  `web/src/hooks/{use-env,use-config,use-skills,use-coding-agents}.ts`,
  `web/src/routes/settings.tsx` + `settings-{models,coding-agents,oauth}-section.tsx`,
  `packages/protocol/src/hermes-api.ts` (L649–675), `src/commands/{environment,coding_agents}.rs`,
  `src/env_file.rs`, `src/environment.rs`, `src/process/runtime.rs`, `src/state.rs`, `src/error.rs`
- Related plans: `plans/credential-pools.md` (keyring precedent L183), `plans/subscription-proxy.md`
  (related-but-distinct inbound OAuth proxy), `plans/_INDEX.md` (entry 66)
