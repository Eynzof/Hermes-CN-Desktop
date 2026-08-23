# Home Assistant (ha_* toolset) — Python → TypeScript Rewrite Plan

## 1. Summary

Port the **`homeassistant` toolset** (4 LLM-callable tools: `ha_call_service`,
`ha_get_state`, `ha_list_entities`, `ha_list_services`) from the Python backend
(`D:/hermes-agent-cn/tools/homeassistant_tool.py`) into the in-process
TypeScript runtime of Hermes-CN-Desktop. The toolset talks to a user's Home
Assistant instance over its REST API, using a Long-Lived Access Token
(`HASS_TOKEN`) and base URL (`HASS_URL`, default `http://homeassistant.local:8123`).
Tools are **capability-gated**: they are only available when `HASS_TOKEN` is set
(`check_fn=_check_ha_available`), and this gate must be preserved exactly.

Key design decisions:

1. **From-scratch TS HA client** — kimi-code has **no Home Assistant equivalent**
   (verified by search; see §5), so we design a thin REST client on native
   `fetch`, mirroring the aiohttp helpers 1:1.
2. **Security parity is the contract** — entity_id/service-name regexes, the
   blocked-domain list, and JSON-string `data` deserialization are ported
   verbatim; unit tests mirror `tests/tools/test_homeassistant_tool.py`.
3. **Network path via a new origin-locked Rust `ha_request` command** (not the
   generic `external_request`, which blocks private/LAN targets) so the default
   `http://homeassistant.local:8123` (http + LAN + `.local`) is reachable while
   keeping SSRF exposure limited to the user-configured HASS_URL origin.
4. **Env/config reuse** — `HASS_TOKEN`/`HASS_URL` are managed through the
   existing `/api/env` surface (`use-env.ts`, `settings-models-section.tsx`) and
   gain Chinese labels in `env-translations.ts`; availability gating reuses the
   `hasSecret('HASS_TOKEN')` gate defined by the sibling
   `plans/tool-categories.md` plan.
5. **The gateway WS adapter is out of scope** — `plugins/platforms/homeassistant/`
   (real-time `state_changed` event streaming) is the messaging-platform feature
   tracked by `plans/_INDEX.md` #93 (`homeassistant-messaging-platform`); this
   plan only covers the agent-callable toolset.

## 2. Current Python implementation

### 2.1 Tool module — `D:/hermes-agent-cn/tools/homeassistant_tool.py` (514 lines)

- **Config**: `_get_config()` reads `HASS_URL` (default
  `http://homeassistant.local:8123`, trailing `/` stripped) and `HASS_TOKEN` via
  `agent.secret_scope.get_secret` (profile-scoped, multiplex-safe; tests cover
  scope fallback).
- **Async REST helpers** (aiohttp, 10–15 s timeouts):
  - `_async_list_entities(domain, area)` → GET `{hass_url}/api/states`, then
    `_filter_and_summarize()` → `{"count": N, "entities": [{entity_id, state,
    friendly_name}]}` (domain prefix filter; area matches `friendly_name` or
    `attributes.area` case-insensitively).
  - `_async_get_state(entity_id)` → GET `/api/states/{entity_id}` →
    `{entity_id, state, attributes, last_changed, last_updated}`.
  - `_async_list_services(domain)` → GET `/api/services`, compacts each
    domain's services to `{description, fields{name: description}}` →
    `{"count": N, "domains": [...]}`.
  - `_async_call_service(domain, service, entity_id, data)` → POST
    `/api/services/{domain}/{service}` with `_build_service_payload()`
    (explicit `entity_id` wins over `data["entity_id"]`) →
    `_parse_service_response()` → `{success: true, service: "d.s",
    affected_entities: [{entity_id, state}]}`.
- **Security layer** (must be ported exactly):
  - `_ENTITY_ID_RE = ^[a-z_][a-z0-9_]*\.[a-z0-9_]+$` — prevents path traversal in
    `/api/states/{entity_id}`.
  - `_SERVICE_NAME_RE = ^[a-z][a-z0-9_]*$` — validated **before** the blocklist
    to stop `shell_command/../light`-style blocklist bypass in the URL.
  - `_BLOCKED_DOMAINS = {shell_command, command_line, python_script, pyscript,
    hassio, rest_command}` — HA has zero service-level ACL; safety lives here.
  - `data` may arrive as a JSON string (XML tool-calling workaround); parsed
    with `orjson`, empty string → `None`.
- **Handlers** are sync `(args, **kw) -> str`; async work is bridged by
  `_run_async()` (runs a fresh loop, or a thread when already inside a loop).
  Success = `orjson.dumps({"result": ...})`; failure = `tool_error(...)`.
- **Registration**: `tools.registry.register(name, toolset="homeassistant",
  schema, handler, check_fn=_check_ha_available, emoji="🏠")` for all four
  tools; `_check_ha_available()` = `bool(get_secret("HASS_TOKEN"))`.

### 2.2 Platform plugin — `D:/hermes-agent-cn/plugins/platforms/homeassistant/`

- `adapter.py` (604 lines): `HomeAssistantAdapter` subscribes to HA WebSocket
  `state_changed` events (auth handshake `auth_required`/`auth`/`auth_ok`,
  `subscribe_events`), applies domain/entity filters + cooldown, formats
  domain-specific messages, and sends outbound replies via REST
  `persistent_notification.create`. Also exposes `_standalone_send` (cron
  `notify.notify` sender).
- `plugin.yaml`: `requires_env: HASS_TOKEN` (password), `optional_env: HASS_URL`.
- **Out of scope here** — event push needs a persistent WS client and is the
  messaging-platform concern (sibling plan #93). This plan only reuses its
  REST notification pattern if desktop-side cron delivery is added later.

### 2.3 Docs

- `website/docs/user-guide/features/tools.md` — line 31 "Integrations" category
  lists `ha_*`; line 52 lists the `homeassistant` common toolset.
- `website/docs/reference/toolsets-reference.md`:
  - line 67: `homeassistant` → 4 tools, "Only available when `HASS_TOKEN` is set".
  - lines 96–97: `hermes-cli` includes HA tools; `hermes-acp` drops all four.
  - line 117: `hermes-homeassistant` platform = same as `hermes-cli`.
  - line 163: capability-gated tools (HA among them) require credentials even
    under `all`/`*`.

### 2.4 Tests (parity source)

- `tests/tools/test_homeassistant_tool.py` (381 lines): `TestFilterAndSummarize`,
  `TestBuildServicePayload`, `TestParseServiceResponse`, `TestHandlerValidation`,
  `TestDomainBlocklist`, `TestEntityIdValidation`, `TestCallServiceStringData`,
  `TestServiceNameValidation`, `TestCheckAvailable` (incl. multiplex secret
  scope), `TestGetHeaders`, `TestRegistration`.
- `tests/fakes/fake_ha_server.py` (301 lines): `FakeHAServer` — real
  aiohttp.web server; `ENTITY_STATES` fixture; REST routes `/api/states`,
  `/api/states/{id}`, `/api/services/persistent_notification/create`,
  `/api/services/{domain}/{service}` (mutates state for turn_on/turn_off/
  set_temperature); WS route for adapter tests.
- `tests/gateway/test_homeassistant.py` (320 lines): adapter-focused
  (formatting, filters, cooldown, send) — reference only; mostly out of scope.

## 3. Target TypeScript design

Runs fully in-process in the webview agent runtime; no Python backend and no
`asyncio` bridging (async handlers use real `await`). Module layout aligns with
the sibling `plans/tool-categories.md` (`web/src/agent/tools/...`,
`families/index.ts`, `ToolRegistry`, `availability.ts`):

```
web/src/agent/tools/families/homeassistant/
  ha-client.ts      // HassClient — REST transport, headers, errors, timeouts
  ha-security.ts    // ENTITY_ID_RE / SERVICE_NAME_RE / BLOCKED_DOMAINS / parseStringData
  ha-format.ts      // filterAndSummarize / parseServiceResponse (pure, parity-tested)
  ha-tools.ts       // 4 tool definitions: zod schemas + handlers (defineToolFamily)
  index.ts          // exports the HomeAssistantToolFamily for families/index.ts barrel
```

Key interfaces (pseudocode, not implementation):

```ts
interface HassConfig { url: string; token: string }        // url trailing "/" stripped
interface HassClient {
  listStates(filter?: { domain?: string; area?: string }): Promise<{ count: number; entities: Array<{ entity_id: string; state: string; friendly_name: string }> }>;
  getState(entityId: string): Promise<{ entity_id: string; state: string; attributes: Record<string, unknown>; last_changed?: string; last_updated?: string }>;
  listServices(domain?: string): Promise<{ count: number; domains: Array<{ domain: string; services: Record<string, { description: string; fields?: Record<string, string> }> }> }>;
  callService(domain: string, service: string, entityId?: string, data?: Record<string, unknown>): Promise<{ success: true; service: string; affected_entities: Array<{ entity_id: string; state: string }> }>;
}

// registration (mirrors Python registry.register)
defineToolFamily({
  category: "integrations",
  toolsets: ["homeassistant"],
  register: (reg) => {
    reg.register({ name: "ha_list_entities", schema: HaListEntitiesSchema, handler: handleListEntities, checkFn: isHaAvailable, emoji: "🏠" });
    reg.register({ name: "ha_get_state",     schema: HaGetStateSchema,     handler: handleGetState,     checkFn: isHaAvailable, emoji: "🏠" });
    reg.register({ name: "ha_list_services", schema: HaListServicesSchema, handler: handleListServices, checkFn: isHaAvailable, emoji: "🏠" });
    reg.register({ name: "ha_call_service",  schema: HaCallServiceSchema,  handler: handleCallService,  checkFn: isHaAvailable, emoji: "🏠" });
  },
});
```

- **Schemas**: zod objects mirroring the four Python schema dicts (same
  descriptions, `domain`/`area`/`entity_id`/`data` params; `required: []` for
  list tools, `required: ["entity_id"]` for get_state,
  `required: ["domain","service"]` for call_service). `data` stays `z.string()`
  in the schema and is JSON-parsed in the handler (XML-mode parity).
- **Availability gate**: `isHaAvailable()` = `hasSecret("HASS_TOKEN")`
  (reuses `availability.ts` from the tool-categories plan; reads the env
  snapshot, not `process.env`). The four tools remain registered in the catalog
  but are filtered out at dispatch time when the gate is closed — matching
  Python `check_fn` behavior.
- **Transport**: `HassClient` calls a Rust Tauri command `ha_request` (see §6)
  rather than raw webview `fetch`, because the default HASS_URL is
  http + LAN + `.local` and the existing `external_request` SSRF policy rejects
  private/loopback targets except `localhost` (§9 risk R1). Rust performs the
  HTTP call with `reqwest` (already a dependency in `src/commands/api_proxy.rs`),
  injecting `Authorization: Bearer <token>`.

## 4. Data models & persistence

- **No new database.** Tool results are transient strings returned to the LLM.
- **Credentials** (`HASS_TOKEN`, `HASS_URL`) persist exactly where env vars
  live today: the Python runtime's `.env` via `/api/env` (UI: `use-env.ts` →
  `useSetEnv`/`useDeleteEnv`); in the final in-process state they move to the
  Tauri app-data JSON (per `plans/tool-categories.md` §4), still exposed
  through the same env snapshot interface so `hasSecret` and the settings UI
  keep working.
- **Optional in-memory cache**: `/api/services` responses are large; cache
  `listServices()` per session with a short TTL (e.g. 60 s) and invalidate on
  profile/env change. Cache lives in memory only (no persistence), consistent
  with the sibling tool-catalog plan.
- **Protocol types**: add to `packages/protocol/src/hermes-api.ts` (or a small
  `ha-api.ts`) zod types for the Rust bridge: `HaRequestInput { url, method,
  path, body?, headers? }` / `HaRequestResult { ok, status, statusText, headers,
  body }` (mirroring `ApiRequestInput`/`ApiRequestResult` in `api_proxy.rs`).
  `EnvVarInfo` already supports arbitrary keys (`passthrough`), so no schema
  change is required for `HASS_*` env vars.

## 5. Third-party library strategy

| Python dependency (feature) | TS equivalent | Evidence / notes |
|---|---|---|
| `aiohttp` (REST client) | native `fetch` (webview) **or** Rust `reqwest` behind Tauri IPC | kimi-code `packages/agent-core/src/tools/providers/local-fetch-url.ts` builds on `globalThis.fetch` + undici `Agent`; Desktop Rust already uses `reqwest` in `src/commands/api_proxy.rs` (`EXTERNAL_HTTP_CLIENT`). We recommend the Rust path for HA due to CORS/SSRF (see §9 R1/R2). |
| `orjson` (serialization) | native `JSON.parse` / `JSON.stringify` | kimi-code serializes with built-ins throughout `packages/agent-core/src/tools/`; no lib needed. |
| `re` (validation regexes) | JS `RegExp` — same patterns verbatim | `^[a-z_][a-z0-9_]*\.[a-z0-9_]+$` and `^[a-z][a-z0-9_]*$` are ECMAScript-compatible. |
| `agent.secret_scope.get_secret` (creds) | env snapshot + `hasSecret()` gate | `plans/tool-categories.md` §3 defines `availability.ts` with `hasSecret('HASS_TOKEN')`; webview reads `/api/env` today via `use-env.ts`, later the in-process env store. |
| **Home Assistant client lib** | **implement from scratch** (`HassClient`) | **No TS equivalent found in kimi-code**: `grep -ri "home assistant\|hass\|HASS_TOKEN"` over `D:/kimi-code` returns only false positives ("hash", "has", "hassle" in snapshots/TUI copy); no `home-assistant*` dependency exists in any `package.json`. npm ecosystem does have the official `home-assistant-js-websocket`, but it is WS-centric and not used by kimi-code — not needed for a REST-only toolset; may be evaluated later for event streaming (§9 R6). |
| zod + JSON Schema (tool params) | `zod` + `z.toJSONSchema` | `@hermes/protocol` already depends on zod (`hermes-api.ts`); kimi-code `packages/agent-core/src/tools/support/input-schema.ts` shows the input-view + `additionalProperties:false` pattern to reuse. |

Explicit **no TS equivalent found** items to hand-port: (a) HA REST client —
from scratch, interface sketched in §3; (b) blocked-domain/validation logic —
verbatim port; (c) `_run_async` sync/async bridge — **not needed** (in-process
runtime is async-native).

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Settings / env UI (reuse)**: `web/src/routes/settings.tsx` (main settings
  route) composes env-backed sections; the actual env editor is
  `web/src/routes/settings-models-section.tsx` ("高级环境变量" groups for
  categories `provider`/`tool`/`messaging`/`setting`/`service`) driven by
  `web/src/hooks/use-env.ts` (`useEnvVars`/`useSetEnv`/`useDeleteEnv`/
  `useRevealEnv`, REST `/api/env`). Add `HASS_TOKEN` (password) and `HASS_URL`
  entries to `web/src/lib/env-translations.ts` (`EnvVarTranslation` record) so
  they render with Chinese labels in the `tool` group. `EnvVarInfo` schema in
  `packages/protocol/src/hermes-api.ts` (lines 649–675) already covers them.
- **Rust IPC (extend)**: new Tauri command `ha_request` in
  `src/commands/` (either a new `ha_proxy.rs` or an addition to
  `api_proxy.rs`) modeled on `external_request` (`src/commands/api_proxy.rs`
  lines 764–768, `external_request_impl` lines 986–1065): same
  `ApiRequestInput`-shaped input, 15 s timeout, no redirects. Difference: URL
  validation is **origin-locked to the configured HASS_URL** (scheme http/https;
  host must equal the HASS_URL host exactly after DNS resolution) instead of the
  https-only/public-IP rule — this is the SSRF-safe way to allow
  `http://homeassistant.local:8123` and LAN IPs.
- **Bridge**: `web/src/lib/tauri-bridge.ts` (line 256 pattern) adds
  `haRequest(input)` invoking the new command; `web/src/lib/runtime.ts` (line
  453 interface) declares it on `hermesDesktop`.
- **Tool catalog / gating**: reuse `ToolRegistry`, `dispatch.ts`,
  `availability.ts`, `use-tools.ts` from the sibling `plans/tool-categories.md`
  plan; the catalog panel shows the `homeassistant` toolset with a 🏠 badge and
  "HASS_TOKEN 已配置/未配置" availability state (line 316 of that plan already
  sketches the badge).
- **Messaging health**: `web/src/components/panel/health-grid.tsx` uses
  `useEnvVars()`; HASS_* will appear there automatically once the runtime
  reports them — no code change required beyond translations.

## 7. Removing the WebSocket dependency (migration path)

Today the agent (and therefore `ha_*` dispatch) runs in the Python runtime; the
webview only renders results over `/api/ws` + REST. The toolset itself never
needs the desktop↔runtime WS — it is a plain outbound HTTPS/HTTP client.

**Frozen API surface during migration** (identical to Python):

```ts
tool names:   ha_list_entities | ha_get_state | ha_list_services | ha_call_service
schemas:      same params/descriptions as the four *_SCHEMA dicts
result shape: { result: ... } on success; { error: string } on failure
gate:         available iff HASS_TOKEN non-empty
```

- **Phase A (keep backend)**: no Desktop code changes required for behavior —
  users configure `HASS_TOKEN`/`HASS_URL` via the existing env UI; the Python
  agent keeps calling HA. Desktop work starts as pure TS modules + tests that
  are not yet wired to the agent loop.
- **Phase B (in-process behind the same interface)**: register the TS family in
  `ToolRegistry`; the in-process agent loop dispatches `ha_*` to
  `HassClient` → `ha_request` IPC. Sessions still routed to the Python backend
  keep using the WS fallback with the same tool names/schemas. The catalog UI
  hydrates availability from the TS env snapshot instead of `/api/env` polling.
- **Phase C (delete WS/REST path)**: drop `ha_*` from Python toolset
  distributions (`toolsets.py`, `toolset_distributions.py`; docs rows for
  `hermes-cli`/`hermes-homeassistant`/`hermes-acp` in `toolsets-reference.md`);
  remove `tools/homeassistant_tool.py` and its tests; remove `ha_*` tool
  dispatch from the gateway WS/RPC surface. The gateway **adapter**
  (`plugins/platforms/homeassistant/`) stays only if the messaging-platform
  plan (#93) keeps it — independent of this toolset.

## 8. Migration phases & task breakdown

1. **M1 — Parity primitives** (`ha-security.ts`, `ha-format.ts`): port regexes,
   blocked domains, `filterAndSummarize`, `buildServicePayload`,
   `parseServiceResponse`, string-`data` parsing; vitest mirrors every class in
   `test_homeassistant_tool.py`. No network.
2. **M2 — HassClient + fake HA server**: TS `HassClient` on the `ha_request`
   abstraction (initially a swappable fetch impl); port `FakeHAServer`
   (node:http or msw) REST routes; integration tests for list/get/services/call
   incl. 401/404/500 and timeouts.
3. **M3 — Tool family + gating + settings UI**: `ha-tools.ts` registration via
   `defineToolFamily`; `isHaAvailable` gate; `env-translations.ts` entries;
   verify env editor shows HASS_* in the `tool` group.
4. **M4 — Rust `ha_request` + protocol + bridge**: origin-locked validation
   (unit tests mirroring `api_proxy.rs` tests), Tauri command, `tauri-bridge.ts`
   + `runtime.ts` + `@hermes/protocol` schemas; swap `HassClient` transport from
   fake fetch to IPC.
5. **M5 — In-process wiring + parity + cleanup**: connect to the in-process
   agent loop; golden-JSON parity fixtures vs Python outputs; Phase C deletions
   (Python tool, docs rows, WS dispatch).

## 9. Risks & open questions

- **R1 (HIGH) — SSRF policy vs LAN HA**: `external_request`
  (`src/commands/api_proxy.rs` lines 211–269) allows only https, or http only
  for `localhost`/`*.localhost`/loopback, and blocks private IPs. The default
  HASS_URL `http://homeassistant.local:8123` (http + mDNS `.local` + likely a
  private IP) is **rejected today**. Must add the origin-locked `ha_request`
  path; do **not** relax `external_request` globally. Open: allow only
  exact-host HASS_URL, or also permit a user-entered private-IP allowlist?
- **R2 (HIGH) — CORS / Private Network Access**: direct webview `fetch` to a
  LAN http host may be blocked (mixed content from https webview, PNA in
  WebView2/Chromium). Mitigation: route through Rust (`ha_request`), which is
  why the client abstraction exists. Verify HA's REST responses still carry
  CORS headers if we ever switch to direct fetch.
- **R3 (MEDIUM) — `.local` DNS resolution**: Rust `reqwest`/tokio DNS may not
  resolve mDNS `.local` names on Windows. Mitigation: docs recommend
  `HASS_URL` with an IP or a resolvable hostname; `ha_request` performs
  hostname→IP validation and can warn the user on lookup failure.
- **R4 (MEDIUM) — result-shape parity**: Python `orjson.dumps` vs JS
  `JSON.stringify` differ in key order/whitespace; LLM-visible output may
  differ slightly. Keep golden fixtures tolerant (JSON deep-equal), and keep
  the `{ result: ... }` / `{ error: ... }` envelope exact.
- **R5 (MEDIUM) — token exposure**: HASS_TOKEN flows through the webview env
  UI and the IPC payload. Keep it out of logs (Rust `AppError` must not echo
  headers/body containing the token); reuse existing redaction patterns.
- **R6 (LOW) — no TS HA equivalent in kimi-code**: entire client + security
  logic is hand-ported. `home-assistant-js-websocket` (npm) is the ecosystem
  option for future WS event streaming (adapter port #93) but is not used by
  kimi-code and is not needed for this REST toolset.
- **R7 (LOW) — blocked-domain drift**: HA integrations evolve; the six-domain
  blocklist must stay byte-identical to Python and be kept in one place
  (`ha-security.ts`) with a parity test asserting the full list.
- **Open**: should `ha_list_entities` area filtering also match a future
  `area_id` attribute (Python only matches friendly_name/`area` today)? Keep
  parity first; extend only if requested.

## 10. Test strategy

- **Vitest unit (parity)**: port the test classes from
  `tests/tools/test_homeassistant_tool.py` 1:1 — filtering/summarize,
  payload precedence (`entity_id` param over `data`), response parsing,
  missing-param validation, blocked-domain rejection (parametrized over all six
  domains), entity_id/service-name traversal rejection, JSON-string `data`
  (incl. empty-string → `None`), availability gate with/without token,
  `Authorization: Bearer` header format, registration presence (all four names).
- **Integration (fake HA server)**: port `tests/fakes/fake_ha_server.py`
  `ENTITY_STATES` fixture + REST routes to a TS fake (node:http or msw);
  exercise `HassClient` end-to-end: list → filter → get → list_services →
  call_service mutates state; auth 401, 404, forced 500, timeout.
- **Rust unit**: `ha_request` origin-locking — accept exact HASS_URL origin
  (http/https, `.local`, LAN IP), reject other hosts/private targets not in
  HASS_URL, reject path traversal, timeout mapping (mirrors existing
  `api_proxy.rs` tests).
- **Playwright E2E**: settings page shows `HASS_TOKEN`/`HASS_URL` under 工具密钥
  with Chinese labels; catalog panel shows the `homeassistant` toolset as
  available only when the env snapshot has a token; with the in-process agent
  loop, a chat message triggers `ha_list_entities` against the fake server and
  the result renders in the transcript.
- **Parity fixtures**: golden JSON comparisons of each tool's output against
  captured Python outputs (from the same fake server data) to catch envelope
  drift before Phase C.

## 11. Reference links

- Core: `D:/hermes-agent-cn/tools/homeassistant_tool.py`,
  `D:/hermes-agent-cn/plugins/platforms/homeassistant/{__init__.py,adapter.py,plugin.yaml}`
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/tools.md`,
  `D:/hermes-agent-cn/website/docs/reference/toolsets-reference.md`
- Tests/fakes: `D:/hermes-agent-cn/tests/tools/test_homeassistant_tool.py`,
  `D:/hermes-agent-cn/tests/fakes/fake_ha_server.py`,
  `D:/hermes-agent-cn/tests/gateway/test_homeassistant.py`
- Feature inventory: `D:/hermes-agent-cn/features_report.md` (line 86)
- kimi-code TS reference: `packages/agent-core/src/tools/builtin/web/fetch-url.ts`,
  `packages/agent-core/src/tools/providers/local-fetch-url.ts`,
  `packages/agent-core/src/tools/support/input-schema.ts`,
  `packages/agent-core/src/tools/store.ts`
- Desktop: `web/src/routes/settings.tsx`,
  `web/src/routes/settings-models-section.tsx`,
  `web/src/hooks/use-env.ts`, `web/src/lib/env-translations.ts`,
  `web/src/lib/tauri-bridge.ts`, `web/src/lib/runtime.ts`,
  `src/commands/api_proxy.rs`, `packages/protocol/src/hermes-api.ts`
- Sibling plans: `plans/README.md`, `plans/_INDEX.md` (#54, #93),
  `plans/tool-categories.md`, `plans/tools-toolsets.md`
