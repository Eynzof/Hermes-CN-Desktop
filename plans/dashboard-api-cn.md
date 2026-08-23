# Dashboard API for CN Desktop — Python → TypeScript Rewrite Plan

## 1. Summary

The CN desktop frontend (`web/`) depends on a set of fork-only (P-002/P-004/P-005/P-008/
P-025/P-055/P-056/P-059) and upstream dashboard REST endpoints served by the managed
Python runtime (`hermes_cli/web_server.py` + `web_routers/profiles.py` +
`memory_oauth.py` + `web_git.py`): attachment upload, workspace fs listing, MCP summary,
active-profile get/set, authenticated media (data-URL + streaming with Range up to 4 GiB),
memory-provider runtime status, cached provider OAuth status, and request hardening
(pagination bounds, magic-byte image validation). All are already consumed by desktop
hooks/transport today. This plan designs their **in-process TS/Rust replacements** so the
Python REST layer for these routes can eventually be deleted along with the WS link
(Dashboard `/api/ws`).

Design decisions:
- **Rust (Tauri command / custom protocol) owns anything touching the local filesystem**:
  fs listing (`fs_list`), attachment upload (direct write to `HERMES_HOME/uploads/<sid>`),
  and large media streaming (`stream_media_file` via a registered URI scheme that parses
  `Range`), because the webview cannot read/write the host disk and Python's `_fs_path`
  / `_resolve_media_path` hardening must be preserved 1:1.
- **TS modules own config-derived summaries**: MCP server summary (read `config.yaml`,
  no secrets), active-profile sticky read/write (thin wrapper over the existing Rust
  `profiles.rs` helpers), memory-provider status aggregation, and OAuth provider status
  enumeration (credential-file sniffing + cached probe results behind a `lib/oauth-status.ts`).
- **Frozen wire schemas stay identical** (`packages/protocol/src/hermes-api.ts` already has
  `AttachmentUploadResult`, `FsEntry/FsListResponse`, `ActiveProfileResponse`,
  `McpServersResponse`, `MemoryProviderRuntimeStatusResponse`, `OAuthProvidersResponse`),
  so hooks swap `fetchJSON` → local client with no component changes.

## 2. Current Python implementation

Sources under `D:/hermes-agent-cn`:

| Endpoint | Location | Behavior |
|---|---|---|
| `POST /api/upload` | `web_server.py:2957` (`upload_attachment`) | multipart `file` + `session_id` → `HERMES_HOME/uploads/<session_id>/`; 50 MiB cap (`_UPLOAD_MAX_BYTES` :435), session regex `^[A-Za-z0-9_-]{1,160}$`, unique filename (`_safe_upload_filename` :533, `_unique_upload_path` :619), returns `{ok, filename, path, size, mime_type}`. P-002 (fork-only, regressed before → 405; test `test_web_server_upload.py`). |
| `GET /api/fs/list` | `web_server.py:3271` (`fs_list`) | `path` → `{entries:[{name,path,isDirectory}]}` sorted dirs-first; HTTP-200 soft errors `{entries:[], error: ENOENT|ENOTDIR|EACCES}`; skips `_FS_READDIR_HIDDEN` (:2008); path hardening via `_fs_path` (:2171) — `file:` URL decode, `~` expand, `resolve(strict=False)`, NUL reject. P-004 (now converged upstream, camelCase shape). |
| `GET /api/mcp-servers` | `web_server.py:15031` | reads `config.yaml["mcp_servers"]`, returns `{summary:{total,enabled}, servers:[{name,enabled}]}` — deliberately **no** command/args/env (secrets). P-005. |
| `GET/PUT/POST /api/profiles/active` | `web_routers/profiles.py:739/765` | GET returns `{name, active, current}` (P-008 compat: `name` mirrors sticky `active` for desktop's `ActiveProfileResponse`); PUT/POST calls `hermes_cli.profiles.set_active_profile` → writes `~/.hermes/active_profile`. Only affects next launch. |
| `GET /api/media` | `web_server.py:2583` | auth-gated base64 data URL; allowlist `_MEDIA_CONTENT_TYPES`; image/video 25 MiB caps; `_resolve_media_path` (:2354) enforces media roots / shared gateway delivery policy, reparse-point + hardlink + symlink checks (`_reject_media_link_components`, `_open_media_file` :2443). P-059. |
| `GET /api/media/file` | `web_server.py:2613` | streaming video, single byte-range (`_parse_media_range` :2491), `_VIDEO_MEDIA_STREAM_MAX_BYTES = 4 GiB` (:1994), 64 KiB chunks (`_iter_media_file`), 206/200 with `Content-Range`, `Accept-Ranges`, `_ClosingStreamingResponse` closes fd on disconnect. P-059. |
| `GET /api/memory/providers/{name}/status` | `web_server.py:6870` | `_load_memory_provider(name).get_runtime_status()` (optional hook, P-055), merged over a common snapshot shape `{provider, active, configured, reachable, healthy, endpoint, console_url, version, checked_at, error, details}`; unknown name → 404; probe failure degrades to `{configured, reachable:false, healthy:false, error}`. |
| `GET /api/providers/oauth` | `web_server.py:10954` | enumerates `provider_catalog()`, per-provider status via `_resolve_provider_status` (PKCE files, credential pool, env); concurrent `asyncio.to_thread`, 20s per-profile in-process TTL cache, `refresh=true` escape hatch, cache invalidated on connect/disconnect (P-025). |
| `GET /api/memory/providers/{provider}/oauth/start\|status` | `memory_oauth.py` | convention-based dispatch to `plugins.memory.<provider>.oauth_flow` (`start_loopback_flow_background` / `get_flow_status`); profile-scoped via `set_hermes_home_override`. |
| Hardening | `web_server.py:12938` (`limit_n = max(1, min(int(limit), 100))`); `:2868` `_CHAT_IMAGE_MAGIC` + `_decode_chat_image_upload` (:2894) | session-search pagination bounded 1..100; image upload must pass magic-byte validation even if filename claims an image (P-056). |

Docs: `FORK_NOTES.zh-CN.md` P-002 (upload), P-004 (fs/list), P-005 (mcp summary), P-008
(active profile), P-025 (oauth status cache/threading), P-055 (memory status hook), P-056
(request hardening), P-059 (media data-URL + Range streaming).

## 3. Target TypeScript design

Module layout under `D:/Hermes-CN-Desktop` (webview + Rust; no Python backend):

- `src/commands/fs.rs` (new) — `#[tauri::command] fs_list(path)` returning
  `{ entries: FsEntry[] } | { entries: [], error: "ENOENT"|"ENOTDIR"|"EACCES"|... }`.
  Port `_fs_path` 1:1: NUL reject, `file://` decode (`url2pathname` equivalent), `~`
  expand, `resolve(strict=false)` via `std::fs::canonicalize`-with-prefix fallback,
  `follow_symlinks=false` dir check, hidden-name filter (`.`, `..`, `.DS_Store`,
  `desktop.ini`), dirs-first case-insensitive sort, and a hard cap of 5000 entries
  (P-004 contract) — if over, truncate and include `error: "EACCES"`-style soft signal
  or a new `truncated` flag kept behind the frozen schema.
- `src/commands/media_file.rs` (new) — Tauri v2 **custom URI scheme** (e.g.
  `hermes-media://file?path=...&range=...`) registered via `register_uri_scheme_protocol`.
  Handler reuses `preview.rs`'s caps and ported `_resolve_media_path` checks: absolute
  path, extension allowlist, media-root or (local-only) gateway delivery policy, reject
  reparse points/symlinks/hardlinks, `Range` single-range parse (`start`, `suffix`,
  clamp `end`), 206/200 headers, 64 KiB stream chunks, 4 GiB cap. Also a small
  `media_data_url(path)` command for the ≤25 MiB base64 image/video path (replaces
  `GET /api/media`).
- `src/commands/upload.rs` (extend existing `api_proxy.rs`) — add
  `upload_file_local(session_id, name, mime, bytes)` that **writes directly** to
  `HERMES_HOME/uploads/<session_id>/` using the same sanitize/unique-name logic, 50 MiB
  cap, and returns `AttachmentUploadResult` JSON shape; keep `upload_file` (HTTP proxy)
  only for remote/attached mode.
- `web/src/lib/dashboard-local.ts` (new) — unified local client exposing
  `listFs(path)`, `uploadAttachment(sessionId, file)`, `getMcpSummary()`,
  `getActiveProfile()/setActiveProfile(name)`, `getMemoryProviderStatus(name)`,
  `getOAuthProviders({refresh})`, `mediaDataUrl(path)`, `mediaFileUrl(path)` with the
  exact Promise types from `packages/protocol`. It branches:
  `runtime.getConnectionMode() === "managed" ? local impl : fetchJSON(...)`, so remote
  gateways keep the REST path until deletion.
- `web/src/lib/mcp-summary.ts` — read `config.yaml` via the existing config loader /
  `rust` `read_config` command; parse `mcp_servers` names + `enabled` (default true),
  return the frozen `McpServersResponse`. Never forward `command/args/env`.
- `web/src/lib/active-profile.ts` — calls Rust `read_active_profile_sticky` /
  `write_active_profile_sticky` (already in `src/commands/profiles.rs:64-88`); current
  profile = the managed `HERMES_HOME` base the app already knows; returns
  `{name, active, current}`.
- `web/src/lib/oauth-status.ts` — per-provider status resolvers reading the same
  credential stores Python reads (`~/.hermes/.anthropic_oauth.json`,
  credential-pool `auth.json`, env vars, claude-code external rows) behind
  `getOAuthProviders()`; results cached 20s per profile with `refresh=true` override
  (P-025 semantics), all probes run off the UI thread (`Promise.all`).
- `web/src/lib/memory-status.ts` — `getMemoryProviderStatus(name)` returns the frozen
  snapshot shape; `active` comes from `config.yaml["memory"]["provider"]`; `configured/
  reachable/healthy/...` from a per-provider health probe interface (see §9 risk).
- `web/src/lib/image-magic.ts` — port `_CHAT_IMAGE_MAGIC` (PNG/JPEG/GIF/BMP/WebP) to
  TS; used by upload/chat-image paths (P-056) before any bytes touch disk.
- Hooks: `use-fs-list.ts`, `use-mcp-servers.ts`, `use-profiles.ts`,
  `use-oauth-providers.ts`, `use-memory.ts`, `lib/transport.ts::uploadAttachmentFile`
  all switch to `dashboard-local.ts` under managed mode; no component changes.

Data flow (managed mode): webview → `window.hermesDesktop.*` (tauri-bridge) → Rust
command/custom protocol → local disk/config → typed result → Jotai/React Query caches.
No HTTP round-trip to the Python dashboard.

## 4. Data models & persistence

- No new persistence beyond what exists. Files written are exactly the Python layouts:
  `HERMES_HOME/uploads/<session_id>/<unique-name>` (upload), `HERMES_HOME/active_profile`
  (profile sticky, already handled by `profiles.rs`), `config.yaml` `mcp_servers` /
  `memory.provider` (read-only for summaries), credential stores (read-only for OAuth
  status).
- Wire models stay in `packages/protocol/src/hermes-api.ts`:
  `AttachmentUploadResult` (:1460), `FsEntry` (:1483) + `FsListResponse` (:1497),
  `McpServersResponse` (:744), `ActiveProfileResponse` (:1147), `MemoryProviderRuntimeStatusResponse`,
  `OAuthProvidersResponse` (already used by `use-oauth-providers.ts`). The `FsEntry`
  transform already normalizes `is_dir`/`isDirectory` — keep it so both upstream and
  fork shapes parse.
- In-process caches replace Python's `_oauth_status_cache`: per-profile 20s TTL in a
  module-level Map keyed `profile → {providers, at}`; invalidated on local
  connect/disconnect events (reuse `connection-auth-events.ts`).
- No schema migrations required (frozen shapes only).

## 5. Third-party library strategy

| Python dependency/behavior | TS equivalent | Evidence |
|---|---|---|
| FastAPI multipart upload | `@tauri-apps/plugin-http` / direct Rust `reqwest::multipart` (already in `api_proxy.rs:1087`) or plain Rust fs write | `D:/kimi-code/packages/kap-server/src/routes/files.ts:1,64` uses `@fastify/multipart` for `POST /files` and streams to `IFileService`; desktop can skip HTTP entirely with a Rust command. |
| `os.scandir` fs listing | `node:fs/promises` `readdir({withFileTypes:true})` in TS, or Rust `std::fs::read_dir`; kimi-code proves the TS algorithm | `D:/kimi-code/packages/agent-core/src/services/fs/fsService.ts:97-160` (`list`: hidden filter, sort, limit/depth bounds, truncation). |
| path containment (`_fs_path`, `_resolve_managed_path`) | `fsPathSafety.ts::resolveSafePath` | `D:/kimi-code/packages/agent-core/src/services/fs/fsPathSafety.ts:38-74` (dotdot, absolute, symlink-escape checks). Desktop's `preview.rs:145 resolve_within_root` is the Rust precedent. |
| RFC 7233 Range streaming | `httpRange.ts::parseRangeHeader` + `Readable` stream | `D:/kimi-code/packages/kap-server/src/lib/httpRange.ts:15-49`; used by `sessionMedia.ts:89-97` and `fs.ts:533-549`; `files.ts:251-274` has a second parser for parity tests. |
| image magic-byte validation | `image-mime.ts::parseImageMeta` (PNG/JPEG/GIF/WebP sniff + dimensions) | `D:/kimi-code/apps/kimi-code/src/utils/image/image-mime.ts:20-172`; Python additionally supports BMP (`_CHAT_IMAGE_MAGIC` :2868) — extend TS with a `BM` check (from scratch, trivial). |
| `subprocess git` (`web_git.py`) | `git-status.ts` + kimi `GitService` | `D:/kimi-code/apps/kimi-code/src/utils/git/git-status.ts`; desktop already has `src/commands/git.rs`. Out of primary scope (no git endpoint in this feature) but confirms strategy. |
| OAuth PKCE/device-code flows (`packages/oauth`) | `packages/oauth` + `kap-server/src/routes/oauth.ts` (login/poll/logout) | `D:/kimi-code/packages/kap-server/src/routes/oauth.ts:56-203`; `IOAuthService` in agent-core. Desktop's status endpoint only *reads* credential state — implement as TS sniffers (§3), flows already have a desktop path via `use-oauth-providers.ts` mutations. |
| FastAPI async cache (oauth TTL) | module-level Map + `Promise.all` (P-025 semantics) | kimi-code has no cache; simple TS from scratch, parity-tested. |
| Config YAML parsing | existing desktop config tooling (`web/src/lib/config-update.ts`, Rust `read_config` commands) | Desktop repo; no new YAML dep needed — mcp summary and memory status read the same config the app already loads. |

**No-TS-equivalent findings**: (1) memory-provider runtime status hook
(`plugins.memory.<provider>.get_runtime_status`) — provider internals are Python plugin
code (OpenViking/Hindsight); kimi-code has no memory-provider concept; see §9. (2) exact
Hermes credential-file layouts for `GET /api/providers/oauth` status
(`~/.hermes/.anthropic_oauth.json`, credential pool, CN provider env vars) — kimi-code's
`IOAuthService` uses its own store, so the TS status resolver must be written from
scratch against the documented files. (3) BMP magic-byte check absent in kimi-code's
`image-mime.ts` (small from-scratch addition).

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (do not rewrite):
- Hooks already consuming these endpoints: `web/src/hooks/use-fs-list.ts` (`/api/fs/list`),
  `use-mcp-servers.ts` (`/api/mcp-servers`), `use-profiles.ts:54-61` (`/api/profiles/active`),
  `use-oauth-providers.ts:12-27` (`/api/providers/oauth`), `use-memory.ts:179-193`
  (`/api/memory/providers/{name}/status`).
- Transport: `web/src/lib/transport.ts:353` `uploadAttachmentFile` already prefers
  `window.hermesDesktop.uploadFile` (Rust) and only falls back to XHR `POST /api/upload`
  — flip the managed-mode default to the direct-write Rust command; `runtime.ts:673`
  profiles branch; `tauri-bridge.ts` is the IPC shim.
- Rust: `src/commands/api_proxy.rs:1069` `upload_file_impl` (multipart client + size
  caps `ensure_upload_*`); `src/commands/profiles.rs:64-88` `write/read_active_profile_sticky`
  (direct in-process replacement for active-profile); `src/commands/preview.rs` caps
  (512 KiB text, 8 MiB image, 16 MiB data URL) and `resolve_within_root` — extend for
  media streaming; `src/commands/ws_proxy.rs` remains the WS relay until removal.
- Protocol: `packages/protocol/src/hermes-api.ts` schemas listed in §4; add `MediaFileUrl`
  or reuse existing media helpers if present (`web/src/lib/message-images.ts`).
- Components: workspace-picker modal (`components/composer/workspace-picker/...`),
  command palette (`components/command-palette/command-palette.tsx:105`), health grid
  (`components/panel/health-grid.tsx`), settings OAuth section — all consume hooks, so
  they stay untouched.

## 7. Removing the WebSocket dependency (migration path)

Phase A (keep backend calls today): hooks continue to call Python REST; add
`dashboard-local.ts` behind the same interface with managed-mode detection.

Phase B (in-process behind same interface): managed mode routes each frozen API through
the TS/Rust module; remote/attached mode still uses `fetchJSON` (same wire schemas).
- Freeze the API surface: `AttachmentUploadResult`, `FsListResponse`, `McpServersResponse`,
  `ActiveProfileResponse` (incl. P-008 `name`), `MemoryProviderRuntimeStatusResponse`,
  `OAuthProvidersResponse`, media `data_url` + `Range`/206 semantics. Add parity tests
  before deleting any Python route.
- Keep the media custom protocol auth-free but local-only (Tauri webview), mirroring
  Python's `_local_dashboard_request` semantics.

Phase C (delete Python REST layer): once every consumer is local and no remote mode is
shipped, delete `POST /api/upload`, `GET /api/fs/list`, `GET /api/mcp-servers`,
`GET/PUT/POST /api/profiles/active`, `GET /api/media`, `GET /api/media/file`,
`GET /api/memory/providers/{name}/status`, `GET /api/providers/oauth`, and
`memory_oauth.py` routes; then the dashboard `/api/ws` + REST link can go with them.

## 8. Migration phases & task breakdown

1. **Foundation**: `dashboard-local.ts` skeleton + mode branching; frozen schema snapshot
   tests in `packages/protocol` (vitest).
2. **fs/list**: Rust `fs_list` command (port `_fs_path`, hidden filter, sort, 5000 cap);
   `use-fs-list.ts` + workspace-picker/command-palette switch. Parity vs
   `test_web_server_upload.py`-style fs tests + kimi `rest/fs.ts` bounds.
3. **Upload**: direct-write `upload_file_local`; magic-byte validation
   (`lib/image-magic.ts`, P-056); keep remote proxy path. Port `test_web_server_upload.py`
   cases (route-shape, session-id regex, 50 MiB, unique filename).
4. **Active profile**: TS wrapper over `profiles.rs` sticky helpers; port P-008 response
   shape incl. `name` mirror; `use-profiles.ts` switch.
5. **MCP summary**: `lib/mcp-summary.ts` reading config; `use-mcp-servers.ts` switch;
   assert no command/args/env leak (P-005).
6. **Media**: custom protocol `hermes-media://` + `media_data_url` command; port
   `_parse_media_range`, extension allowlist, link/reparse rejection, 4 GiB cap, 64 KiB
   chunks; Playwright/component test for video seek (Range 206).
7. **OAuth status**: `lib/oauth-status.ts` sniffers + 20s cache + invalidation (P-025);
   `use-oauth-providers.ts` switch; port `test_dashboard_admin_endpoints.py`-style shape.
8. **Memory status**: `lib/memory-status.ts` + probe interface (§9); `use-memory.ts`
   switch; degrade-to-unhealthy on probe failure (P-055).
9. **Hardening sweep**: pagination bounds on any remaining local paginated calls (1..100
   Python parity; kimi-code `rest/fs.ts` 1..1000 for fs lists); magic-byte enforcement in
   all image write paths; `test_web_server_session_search.py` parity for bounds.
10. **Deletion**: remove Python routes + WS link per §7 Phase C; update
    `desktop-release-preflight`/skill docs.

## 9. Risks & open questions

- **Memory-provider status (highest risk)**: `get_runtime_status()` is Python plugin
  internals (OpenViking/Hindsight aggregates health/queues/models). No kimi-code or npm
  equivalent. Options: (a) keep a thin Python subprocess RPC just for this endpoint —
  violates "delete REST"; (b) TS probes (config presence + HTTP endpoint ping +
  `ps`-style process check) returning the same snapshot with reduced fidelity; (c) port
  providers to TS later. Open question: is reduced fidelity acceptable for the health
  grid? Recommend (b) with `details: null` and `error` explaining "local probe only".
- **OAuth status parity**: Hermes credential file layouts are fork-specific; TS sniffers
  must match Python's `_resolve_provider_status` exactly or the Models page will show
  stale login states. Needs a fixture-driven parity suite.
- **BMP magic bytes**: kimi-code `image-mime.ts` lacks BMP; from-scratch `BM` check is
  trivial but must be covered by tests.
- **4 GiB video streaming in Tauri custom protocol**: verify Tauri v2 URI-scheme handler
  supports streaming (async reader) and client abort; if the protocol buffers, fall back
  to a Rust `stream_media_range` command returning `Uint8Array` chunks over IPC.
- **`fs/list` 5000-entry cap**: upstream converged shape has no `parent`; existing
  components already derive parent client-side (`lib/preview-rail.ts:168`,
  workspace-picker modal comment) — keep that behavior; do not re-add `parent`.
- **`/api/media` data-URL path still uses base64 over IPC** — cap at 25 MiB (Python
  parity) and prefer the streaming protocol for anything above the 8 MiB image cap.

## 10. Test strategy

- **Vitest unit**: `dashboard-local` mode branching; `image-magic` (all signatures +
  fake filename P-056); `mcp-summary` (enabled default, secret redaction P-005);
  `oauth-status` cache TTL/invalidation (P-025); `active-profile` shape incl. `name`
  (P-008); `httpRange` parser vs `_parse_media_range` cases (suffix, clamp, multi-range
  reject, unsatisfiable).
- **Rust unit (cargo test)**: `fs_list` hidden/sort/cap + `_fs_path` hardening (NUL,
  `..`, `file:` URL, symlink escape); upload sanitize/unique-name/session-regex; media
  path rejection (reparse point, hardlink, non-allowlist ext, 4 GiB cap).
- **Parity vs Python tests**: port `test_web_server_upload.py` (upload shape +
  405-regression becomes "local command exists"), `test_web_server_session_search.py`
  (pagination bounds 1..100 + merge order), `test_dashboard_admin_endpoints.py`
  (memory status shape), and fs/media fixture tests; keep Python tests green until Phase C.
- **Playwright E2E**: workspace picker lists a fixture dir; composer paste/drop image
  persists under `uploads/`; preview rail video seeks with `Range` (206); Models page
  OAuth list renders after simulated connect; health grid MCP count matches config.
- **WS host parity** (`test_ws_client_host.py`) is tracked by the WS-removal plan; only
  note here that `dashboard-local` must not re-introduce `0.0.0.0` dialing.

## 11. Reference links

- Python: `D:/hermes-agent-cn/hermes_cli/web_server.py`, `web_routers/profiles.py`,
  `memory_oauth.py`, `web_git.py`; docs `FORK_NOTES.zh-CN.md` P-002/P-004/P-005/P-008/
  P-025/P-055/P-056/P-059; tests `tests/hermes_cli/test_web_server_upload.py`,
  `test_web_server_session_search.py`, `test_dashboard_admin_endpoints.py`,
  `tests/dashboard/test_ws_client_host.py`.
- kimi-code: `packages/kap-server/src/routes/fs.ts`, `files.ts`, `sessionMedia.ts`,
  `oauth.ts`, `lib/httpRange.ts`, `protocol/rest-fs.ts`, `rest-file.ts`,
  `packages/protocol/src/rest/fs.ts`; `packages/agent-core/src/services/fs/fsService.ts`,
  `fsPathSafety.ts`; `apps/kimi-code/src/utils/image/image-mime.ts`,
  `apps/kimi-code/src/utils/git/git-status.ts`.
- Desktop: `web/src/lib/transport.ts`, `lib/runtime.ts`, `lib/workspaces.ts`,
  `lib/preview-rail.ts`, `lib/message-images.ts`; `web/src/hooks/use-fs-list.ts`,
  `use-mcp-servers.ts`, `use-profiles.ts`, `use-oauth-providers.ts`, `use-memory.ts`;
  `src/commands/api_proxy.rs`, `preview.rs`, `profiles.rs`, `ws_proxy.rs`;
  `packages/protocol/src/hermes-api.ts`.
