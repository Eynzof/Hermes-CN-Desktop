# Webhooks Messaging Platform Adapter — Python → TypeScript Rewrite Plan

> Port decision recorded up front: **Webhooks is a gateway-side messaging platform adapter** and is
> marked "out of scope for desktop standalone" **as an in-webview implementation** — but unlike pure
> outbound platforms (see `telegram-platform.md`), the inbound HTTP listener **cannot live in the
> Tauri webview at all** (a webview is a client, it cannot bind a TCP port or read raw request bytes
> for HMAC). The no-Python end-state therefore needs a **Rust sidecar listener** (`src/commands/`)
> that owns the socket, validates signatures/rate-limits, and forwards validated deliveries to the
> in-process TS runtime. This file records that port decision and designs the sidecar path
> (Sections 3–10). Feature scope: static + dynamic webhook routes, HMAC signature validation
> (GitHub / GitLab / Svix / generic V1+V2), per-route rate limiting, idempotency, payload filters /
> script transforms, prompt templates, `deliver_only` direct delivery, and the
> `hermes webhook subscribe|list|remove|test` management surface.

## 1. Summary

Hermes-CN-Core's webhook adapter (`gateway/platforms/webhook.py`, 1,445 lines) runs an **aiohttp
HTTP server** on port **8644** that accepts `POST /webhooks/{route_name}` from GitHub, GitLab, JIRA,
Stripe, Svix/AgentMail, etc.; validates HMAC signatures; enforces per-route rate limits and body
size caps; runs declarative filters / script transforms; renders `{dot.notation}` prompt templates;
and either dispatches an agent run (202 + fire-and-forget) or, in `deliver_only` mode, delivers the
rendered template straight to another platform (Telegram/Discord/GitHub comment/…). Routes come from
`config.yaml` (static) and `~/.hermes/webhook_subscriptions.json` (dynamic, hot-reloaded, created by
`hermes webhook subscribe`).

For the Desktop rewrite the design is:

1. **Rust sidecar owns the inbound listener** (`src/commands/webhook_listener.rs`, modeled on the
   existing hyper loopback server `src/commands/browser_companion.rs`) — binds `127.0.0.1:8644` by
   default, reads the raw body, does auth-before-body + signature-before-rate-limit + fixed-window
   rate limiting + idempotency, and replies `401/413/404/403/429/200/202` synchronously.
2. **TS owns route semantics** — route registry (static + dynamic file), event filtering, filters /
   script transforms (spawned via Rust IPC), prompt template rendering, skill injection, and the
   `PlatformAdapter`-shaped dispatch to the in-process agent runtime.
3. **Management surface** — `settings.tsx` gets a Webhooks section (the PRD D4 "disabled"
   placeholder becomes real) backed by new Rust IPC commands that mirror `hermes_cli/webhook.py`
   (subscribe/list/remove/test), because today there is **no REST API** for dynamic subscriptions —
   only a CLI that atomically writes the JSON file.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`

| Path | Role |
|---|---|
| `gateway/platforms/webhook.py` (1,445) | `WebhookAdapter(BasePlatformAdapter)` — aiohttp app, lifecycle, handlers, signature validation, rendering, delivery |
| `gateway/platforms/webhook_filters.py` (320) | `WebhookRouteProcessor` — declarative filters (`all/any/not/exists/missing/equals/contains/in/in_file/regex`) + route script transforms (`run_route_script`) |
| `hermes_cli/webhook.py` (307) | `hermes webhook subscribe/list/remove/test` — writes `~/.hermes/webhook_subscriptions.json` (0600, atomic replace via tempfile+rename) |
| `website/docs/user-guide/messaging/webhooks.md` (566) | setup (env/CLI), route schema, filters/scripts, prompt templates, delivery options, direct delivery, dynamic subscriptions, security, troubleshooting |
| `gateway/config.py` / `gateway/platforms/base.py` | `PlatformConfig` + `Platform.WEBHOOK`, `MessageEvent`/`SendResult` contracts |

Key implementation blocks (line refs verified by reading `webhook.py`):

- **Lifecycle** — `connect()` (250): reloads dynamic routes, validates every route's HMAC secret
  (required; `INSECURE_NO_AUTH` only on loopback hosts — safety rail), refuses `deliver_only` +
  `deliver=log`, port-conflict probe + `hermes_cli/port_lock.try_claim_port` shared lock, binds
  dual-stack (`DEFAULT_HOST=None`; macOS disables `SO_REUSEADDR`). `disconnect()` (370) cleans the
  runner + port lock.
- **HTTP surface** (291–301): `GET /health`, `POST /webhooks/{route_name}`, and multi-profile
  `POST /p/{profile}/webhooks/{route_name}` (only when `gateway.multiplex_profiles`).
- **Handler order** (`_handle_webhook` 619): profile resolve → route lookup (404) → profile binding
  (404, no enumeration) → `enabled:false` (403) → **auth-before-body** Content-Length cap (413) →
  read body (aiohttp `client_max_size` enforces chunked caps) → HMAC (401) → **rate limit after
  auth** (429; signature-before-rate-limit is the #12544 regression the dedicated test pins) →
  JSON/form parse (400) → event-type filter (`X-GitHub-Event` / `X-GitLab-Event` / payload
  `event_type`/`type`) → filters → script transform → prompt render → skill injection →
  idempotency key (delivery ID) → `deliver_only` sync delivery (200/502) or agent dispatch
  (202 `{status:"accepted",route,event,delivery_id}`).
- **Signature validation** (`_validate_signature` 1063, `_validate_svix_signature` 1178):
  Svix (`svix-id` + `svix-timestamp` + `svix-signature` `v1,<b64>` over `"{id}.{ts}.{body}"`,
  `whsec_` base64 keys); GitHub `X-Hub-Signature-256: sha256=<hex>`; GitLab
  `X-Gitlab-Token` (plain compare); generic V2 `X-Webhook-Signature-V2` + `X-Webhook-Timestamp`
  (HMAC-SHA256 of `"<ts>.<body>"`, ±300 s replay window, **no V1 fallback on missing timestamp** —
  downgrade-attack guard); legacy V1 `X-Webhook-Signature` (body-only, warn once per route). All
  compares use `_hmac_str_equal` (UTF-8 bytes, `hmac.compare_digest`) so hostile non-ASCII headers
  fail closed instead of raising.
- **Rate limiting / idempotency** (463–488): per-route fixed 60 s window (`rate_limit` default 30),
  `deque` of timestamps; delivery-ID cache TTL 1 h (`X-GitHub-Delivery` / `svix-id` /
  `X-Request-ID` / ms timestamp fallback); both bounded via TTL pruning.
- **Session/delivery model** (907–969): `session_chat_id = "webhook:{route}:{delivery_id}"`,
  `_delivery_info` TTL-cached (never popped on `send()` so interim status messages don't downgrade
  the final response); `on_processing_complete` closes the one-shot session (`_end_webhook_session`
  995) to avoid ghost-session DB bloat.
- **Rendering** (`_render_prompt` 1232): `{dot.notation}` into payload, `{__raw__}` dumps full JSON
  (4000 chars), dict/list values serialized + truncated 2000 chars, missing keys stay literal;
  `_render_delivery_extra` (1272) applies the same templating to `deliver_extra`.
- **Delivery** (`send` 380, `_deliver_github_comment` 1316, `_deliver_cross_platform` 1391):
  `log` default; `github_comment` shells out to `gh pr comment` (validated repo/PR to prevent CLI
  injection); cross-platform dispatch via `gateway_runner.adapters` / `_profile_adapters`, home
  channel fallback, Telegram `message_thread_id` support. `deliver_only` routes reuse the same
  helpers (`_direct_deliver` 1288). `[SILENT]` marker responses are suppressed via the shared
  autonomous-lane matcher `is_autonomous_silence_response` (also used by cron).

**Docs key behaviors** (`website/docs/user-guide/messaging/webhooks.md`): setup via
`hermes gateway setup` / env (`WEBHOOK_ENABLED`, `WEBHOOK_PORT=8644`, `WEBHOOK_SECRET`) (27–69);
route properties table (78–90); full config example (93–126); filters operators (128–162);
scripts protocol (164–189); prompt templates (191–209); forum-topic delivery (211–227); GitHub /
GitLab step-by-step (231–293); delivery table incl. `github_comment`, `log` and 17 cross-platform
targets (299–321); direct delivery + response codes `200/401/400/404/413/429/502` (325–396);
dynamic subscriptions + `webhook_subscriptions.json` hot-reload (399–446); security:
HMAC modes, secret required, `INSECURE_NO_AUTH` loopback-only, rate limit 30/min default,
idempotency 1 h, 1 MB body cap, "authenticated ≠ trusted" payload trust model (449–514);
troubleshooting (518–557); env vars (560–566).

## 3. Target TypeScript design

**Port decision (recorded):** v1 desktop keeps the adapter in the Python managed runtime (config/
status over REST/WS only, consistent with all other messaging-platform plans). The standalone
no-Python build hosts the inbound listener in **Rust**; the TS layer is the
`PlatformAdapter`-shaped controller that plugs into the future in-process gateway
(`plans/messaging-gateway-core.md`).

Proposed module layout:

```
src/commands/webhook_listener.rs   # Rust sidecar: hyper server, HMAC, rate limit, idempotency,
                                   # body cap, health; emits WebhookDelivery via Tauri event
src/commands/webhook_routes.rs     # Rust: load/merge static+dynamic routes, validate secrets,
                                   # safe bind host rule (INSECURE_NO_AUTH loopback-only),
                                   # webhook_subscriptions.json atomic 0600 write
src/commands/webhook_cli.rs        # Rust IPC: list/subscribe/remove/test (port of hermes_cli/webhook.py)

packages/webhooks/src/
  types.ts           # WebhookRoute (zod: events/secret/prompt/skills/deliver/deliver_extra/
                     # deliver_only/enabled/profile/filters/script), WebhookDelivery, status unions
  registry.ts        # RouteRegistry: static routes + hot-reload of webhook_subscriptions.json
                     # (mtime-gated, static-wins merge, empty-secret rejection)
  filters.ts         # WebhookRouteProcessor port: resolveFilterField + all/any/not/operators
  templates.ts       # renderPrompt / renderDeliveryExtra: {dot.notation} + {__raw__} + truncation
  adapter.ts         # WebhookAdapter implements PlatformAdapter: connect/disconnect/send,
                     # dispatch(event) → agent loop, [SILENT] suppression, delivery_info TTL
  script-runner.ts   # async wrapper over Rust spawn IPC (stdin JSON, timeout, ignore rules)
  index.ts           # public API (createWebhookAdapter, RouteRegistry, renderPrompt)
```

Data flow (standalone, no Python):

```
GitHub/GitLab/Svix/… ──POST──▶ Rust webhook_listener (hyper, 127.0.0.1:8644)
   1. Content-Length > cap → 413 (before reading)
   2. read raw body (byte buffer) → HMAC validate → 401 on failure
   3. rate limit fixed window → 429
   4. route lookup + profile binding + enabled → 404/403
   5. event-type filter → 200 {status:"ignored"}
   6. idempotency key check → 200 {status:"duplicate"}
   7. reply 202 {status:"accepted",...} immediately
   └─ emit WebhookDelivery{route,event,payload,delivery_id,headers} ──Tauri event──▶
packages/webhooks adapter (TS)
   filters.ts → script-runner.ts (Rust spawn) → templates.ts → skills → dispatch to agent loop
   agent response → adapter.send(chat_id, content) → delivery_info lookup →
      github_comment via Rust gh spawn | cross-platform via PlatformRegistry (other adapters)
```

Key interfaces (pseudocode — no implementation):

```ts
interface WebhookListenerHandle {
  start(host: string | null, port: number): Promise<boolean>; // false on port conflict
  stop(): Promise<void>;
  onDelivery(cb: (d: WebhookDelivery) => void): void;         // Tauri event → TS
}
interface WebhookAdapter extends PlatformAdapter {
  connect(opts?: { isReconnect?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  send(chatId: string, content: string, opts?: { replyTo?: string; metadata?: MsgMetadata }): Promise<SendResult>;
  handleDelivery(d: WebhookDelivery): Promise<void>;          // render → agent or deliver_only
  getRoutes(): WebhookRouteView[];                            // for settings UI
}
```

## 4. Data models & persistence

| Artifact | Python location | TS/Rust location | Notes |
|---|---|---|---|
| Static routes | `config.yaml` → `platforms.webhook.extra.routes` | same YAML, parsed by Rust `serde_yaml` / TS js-yaml | schema frozen (docs route-properties table) |
| Dynamic subscriptions | `~/.hermes/webhook_subscriptions.json` | same path; **Rust owns atomic 0600 write** (`webhook_routes.rs`, port of `hermes_cli/webhook.py:_save_subscriptions`) | per-route secrets live here → chmod 0600 + tempfile+rename parity; hot-reload on each POST (mtime-gated) |
| Rate-limit state | `WebhookAdapter._rate_counts: Dict[str, Deque[float]]` | Rust `HashMap<String, VecDeque<Instant>>` in the listener | fixed 60 s window, per route; bounded by prune |
| Idempotency cache | `_seen_deliveries: Dict[str, float]` TTL 3600 s | Rust `HashMap<String, Instant>` TTL 3600 s (+ optional SQLite if durable across restarts is wanted) | `X-GitHub-Delivery`/`svix-id`/`X-Request-ID`/ms fallback |
| Delivery info | `_delivery_info` TTL cache | TS `Map<chatId, DeliveryInfo>` TTL 3600 s | never popped on send (interim status parity) |
| Delivery history (optional UI) | — (not persisted in Python) | Rust `rusqlite` table `webhook_deliveries` if the settings UI shows history | Python has none → this is additive, not parity |
| Session identity | `webhook:{route}:{delivery_id}` one-shot sessions in Core state.db | in-process session store, keyed the same | `onProcessingComplete` must close the session (ghost-session parity) |

No schema migrations are needed for the frozen surface: the route config shape, the dynamic
subscriptions file shape, and the HTTP response bodies are the compatibility contract (see §7).

## 5. Third-party library strategy

| Python dependency | TS/Rust equivalent | kimi-code evidence |
|---|---|---|
| `aiohttp` (HTTP server) | **Rust `hyper` + `tokio`** — webview has no Node, so no Fastify/Express is possible; hyper is already a dependency and there is an existing loopback hyper server | kimi-code `packages/kap-server/package.json` uses `fastify: ^5.1.0` + `ws` in a Node process — pattern to emulate, but not runnable in Tauri webview; Desktop precedent: `src/commands/browser_companion.rs` (`hyper::server::conn::http1`, `tokio::net::TcpListener`, loopback bind) |
| `hmac` / `hashlib` (HMAC-SHA256) | **Rust `hmac` crate + existing `sha2 = "0.10"`** (`Cargo.toml:32`) with `Mac::verify_slice` (constant-time); base64 for Svix via existing `base64 = "0.22"` | kimi-code uses `node:crypto` (`createHmac`/`createHash`), which the webview lacks; no signature-validation lib in kimi-code — implement from scratch |
| `hmac.compare_digest` timing-safe str compare | Rust `subtle`/`verify_slice` or manual constant-time; TS test helpers use Web Crypto `crypto.subtle.importKey('raw') + sign('HMAC')` | kimi-code `packages/kap-server/src/middleware/auth.ts` uses `bcryptjs` compare for bearer tokens — different scheme, no HMAC precedent |
| Rate limiting (fixed window) | Rust in-memory `HashMap<String, VecDeque<Instant>>` (direct port of `_record_rate_limit_hit`) | kimi-code `packages/kap-server/src/middleware/rateLimit.ts` (`createAuthFailureLimiter`) proves the per-source limiter shape but is an auth-failure **ban** limiter, not a route fixed-window quota → adapt the pattern, different semantics |
| `orjson` / JSON | Rust `serde_json`; TS `JSON.parse/stringify` | trivial |
| `subprocess` (route scripts, `gh` CLI) | **Rust `std::process::Command` / `tokio::process`** via new IPC commands (webview has no Node) | kimi-code `packages/agent-core/src/session/hooks/runner.ts` uses `node:child_process.spawn` (shell, windowsHide, tree-kill) — pattern to mirror in Rust; `src/commands/terminal.rs` + `notify.rs` are the Desktop process precedents |
| `re` template substitution | JS `RegExp` `/\{([a-zA-Z0-9_.]+)\}/g` + dot-resolver module (`packages/webhooks/src/templates.ts`) | no kimi-code equivalent — implement from scratch |
| `yaml` (config) | Rust `serde_yaml` (already in `Cargo.toml:22`) / TS `js-yaml` | kimi-code `packages/agent-core/src/profile/load.ts` (`js-yaml ^4.1.1`) |
| `secrets.token_urlsafe` | Rust `getrandom` (already in `Cargo.toml:63`) → base64url | trivial |
| Port conflict + lock | Rust `std::net::TcpListener` probe + `src/process/port_lock.rs` (existing `claim_port_set`/`cleanup_stale_port_locks`) | Desktop precedent: `src/process/dashboard.rs` (dashboard port 9120, fallback range) — reuse, don't reinvent |
| `deque` / TTL caches | Rust `VecDeque` + `HashMap` with TTL prune; TS `Map` | kimi-code `rateLimit.ts` sweep timer (`unref`'d interval) is the shape |

**No TS/npm equivalent found (implement from scratch):**
1. **Inbound webhook server + signature validation** — kimi-code has **no webhook adapter at all**:
   a repo-wide grep for "webhook" only matches incidental strings in
   `packages/kap-server/src/protocol/message.ts`, `messageProjection.ts`, and TUI files; a grep for
   "notification" hits TUI/terminal notification code only. There is no GitHub/GitLab/Svix signature
   lib and no inbound HTTP route in kimi-code — the Rust listener + `hmac`-crate validation is our
   own work.
2. **Svix `whsec_` key handling** — no kimi-code precedent; base64-decode + HMAC over
   `"{id}.{ts}.{body}"` implemented in Rust from the Python spec.
3. **Route-script transforms** — Python user scripts (`~/.hermes/scripts/*.py|.sh`) executed via
   subprocess with a JSON stdin/stdout protocol; no TS equivalent possible in the webview, so they
   run through a Rust spawn command (same semantics as shell hooks in `plans/event-hooks.md`).

## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/routes/settings.tsx` — **no webhook UI exists today** (verified: zero "webhook" matches).
  The PRD cut Webhooks for v2 (`docs/desktop-prd/01-prd.md` D4, `03-feature-specs.md:560` "disabled +
  v2 暂不可用 hint", `04-backend-contract.md:312`). This plan flips those entries: add a Webhooks
  section (route list, enable/disable, secret reveal/copy, events, prompt preview, deliver target,
  `deliver_only` badge, "test delivery" button) modeled on the Cron settings pattern
  (`web/src/hooks/use-cron.ts` + `section-shell` usage).
- New React hooks: `web/src/hooks/use-webhooks.ts` (list/subscribe/remove/test/update via Rust IPC),
  `use-webhook-listener.ts` (listener running state, bound host/port, route count).
- `packages/protocol` — add Zod schemas (`hermes-api.ts` or new `webhooks.ts`): `WebhookRoute`,
  `WebhookRouteView`, `WebhookSubscriptionInput`, IPC request/result types; `channels.ts` style is
  the existing precedent.
- Rust: new `src/commands/webhook_listener.rs` (hyper server; modeled on
  `src/commands/browser_companion.rs`'s `TcpListener::bind((Ipv4Addr::LOCALHOST, …))` + hyper http1
  loop; registered in `main.rs generate_handler!` like the other 60 commands), `webhook_routes.rs`,
  `webhook_cli.rs`; reuse `src/process/port_lock.rs`, `src/commands/notify.rs` spawn patterns,
  `src/commands/api_proxy.rs` `external_request` only if TS cross-origin fetch is CORS-blocked.
- `web/src/lib/transport.ts` — unchanged for v1 (REST to managed runtime); after WS removal the
  in-process `packages/webhooks` registry becomes the source of truth; `gateway-client.ts`
  (`WebSocket` JSON-RPC) is deleted per §7.

## 7. Removing the WebSocket dependency (migration path)

**Why Rust, not webview:** a Tauri webview cannot open an inbound TCP listener (browser security
model) and cannot capture the raw request body bytes needed for HMAC-SHA256 without a server-side
socket; therefore "in-process webhook" means **Rust sidecar owns the socket** and TS owns the route
semantics. The WebSocket link disappears because agent dispatch moves from the Python gateway's WS
event stream to a direct in-process `handleDelivery()` call (or, during migration, a shim that
re-emits WS gateway events onto the same bus — the `event-hooks.md` `EventBus` pattern).

**API surface to freeze** (both backends must serve the same UI/tests):
1. HTTP surface + status codes/bodies: `GET /health`, `POST /webhooks/{route}`,
   `POST /p/{profile}/webhooks/{route}`; bodies `{status:accepted|duplicate|ignored|delivered|error,
   route, event, delivery_id}`; codes 200/202/400/401/403/404/413/429/502.
2. Signature header contracts: `X-Hub-Signature-256`, `X-Gitlab-Token`,
   `X-Webhook-Signature[-V2]` + `X-Webhook-Timestamp` (±300 s), `svix-id`/`svix-timestamp`/
   `svix-signature`; V2-missing-timestamp must NOT downgrade to V1.
3. Ordering invariant: auth-before-body → signature-before-rate-limit (bug #12544) → event filter →
   idempotency → dispatch.
4. Route config + `webhook_subscriptions.json` schemas (secret required, `INSECURE_NO_AUTH`
   loopback-only, static-wins merge, empty-secret reject).

Phases:
- **A (today, backend-backed)**: Webhooks settings section reads/writes route config and the
  subscriptions file through the managed runtime; listener stays Python; WS carries gateway events.
- **B (Rust listener + TS adapter behind same interface)**: implement `packages/webhooks` +
  `webhook_listener.rs`; dual-run shim subscribes to WS and re-emits `WebhookDelivery` onto the
  in-process bus; HTTP contract and JSON schemas unchanged.
- **C (delete WS/REST path)**: listener + registry own the surface; drop `gateway-client.ts` WS
  usage and the Python webhook REST/WS path; delete `ws_proxy.rs` as the final step.

## 8. Migration phases & task breakdown

- **P0 — Foundations**: `packages/webhooks/types.ts` (zod route schema, delivery shape, status
  unions); Rust `webhook_listener.rs` skeleton (hyper loopback bind, `/health`, port-conflict
  probe via `port_lock.rs`).
- **P1 — Signature + rate limit + body cap (Rust)**: HMAC-SHA256 (GitHub/GitLab/V1/V2/Svix),
  constant-time compare, 413/401 ordering, fixed-window rate limiter, idempotency TTL;
  `tests/` parity with `test_webhook_signature_rate_limit.py`.
- **P2 — Route registry + dynamic subscriptions**: `webhook_routes.rs` load/merge/reload +
  secret validation + `webhook_cli.rs` (subscribe/list/remove/test, 0600 atomic write); parity with
  `test_webhook_dynamic_routes.py`.
- **P3 — TS route semantics**: `filters.ts`, `templates.ts`, `script-runner.ts` (Rust spawn IPC),
  `adapter.ts` (dispatch, `delivery_info` TTL, `[SILENT]`, session close); parity with
  `test_webhook_adapter.py` + `test_webhook_integration.py`.
- **P4 — Delivery**: `github_comment` via Rust `gh` spawn (repo/PR validation), cross-platform
  dispatch to other in-process adapters, `deliver_only` sync path.
- **P5 — Settings UI**: Webhooks section + `use-webhooks.ts` + protocol schemas; replace the
  disabled D4 placeholder.
- **P6 — WS removal**: freeze §7 contract, switch UI to in-process bus, delete WS path.

## 9. Risks & open questions

1. **Rust listener is the only viable standalone path** — no TS npm equivalent exists (verified);
   if the team prefers a Node runtime instead of Rust, kimi-code's Fastify stack is the reference,
   but that contradicts the Tauri-webview end state.
2. **Port binding** — 8644 is the documented default but can collide with the dashboard port 9120
   range or the browser-companion loopback ports; must reuse `port_lock.rs` and surface the bind
   failure in the UI (Python fails fast today).
3. **Public-bind safety rail** — `INSECURE_NO_AUTH` on non-loopback must refuse startup (Python
   parity); the desktop default should be loopback-only with a firewall/forwarding hint, since a
   desktop app has no reverse proxy story.
4. **Tauri IPC payload limits / body size** — a 1 MB raw body passed Rust→TS via event could hit
   IPC message caps; mitigation: validate/parse in Rust and pass parsed JSON + raw body only when
   scripts require it; keep 413 logic fully in Rust.
5. **Cross-platform delivery is gateway-scoped** — `deliver: telegram/discord/…` requires those
   adapters, which are themselves "out of scope for desktop standalone" (see
   `telegram-platform.md`); in standalone, deliver targets initially limited to `log`,
   `github_comment`, and whatever adapters the desktop actually hosts.
6. **Skill injection** depends on the in-process skill system being ported (separate plan
   `skills-system`); until then `skills:` on routes degrades to a warning.
7. **Route scripts are Python/bash user files** — running them in Rust preserves the wire protocol
   but reintroduces a Python dependency for `.py` scripts; open question: restrict scripts to
   `.sh`/`.js` in standalone or keep a bundled Python runner (contradicts no-Python end state).
8. **Multi-profile multiplexing** (`/p/{profile}/…`) requires profile resolution in TS; keep the
   404-on-unknown-profile behavior so route enumeration stays impossible.

## 10. Test strategy

Vitest unit tests in `packages/webhooks/__tests__/` + Rust `tests/` (per `AGENTS.md`: no real
network, no fixed paths, `#[serial_test::serial]` for env-dependent cases, `wiremock` for HTTP):

| Python parity source | TS/Rust test |
|---|---|
| `tests/gateway/test_webhook_signature_rate_limit.py` | `signature-rate-limit.test.ts` + Rust `webhook_listener` tests — 401-before-429 ordering, invalid signatures do not consume quota, V2-no-timestamp does not downgrade to V1 |
| `tests/gateway/test_webhook_adapter.py` (1,742 lines) | `webhook-adapter.test.ts` — GitHub/GitLab/generic V1+V2/Svix matrix, non-ASCII hostile headers fail closed, prompt rendering dot-notation + `{__raw__}` + truncation, event filter, 404/413/429/202, idempotency, `INSECURE_NO_AUTH` loopback rule, session isolation |
| `tests/gateway/test_webhook_dynamic_routes.py` | `webhook-routes.test.ts` + Rust file tests — mtime reload, static-wins merge, empty-secret rejection, `INSECURE_NO_AUTH` skip on non-loopback |
| `tests/gateway/test_webhook_integration.py` | `webhook-integration.test.ts` — GitHub PR → rendered `MessageEvent` (chat_type webhook, chat_id `webhook:{route}:{delivery_id}`), skills injection, cross-platform delivery to a mock adapter, `gh` comment args + validation; `deliver_only` sync 200/502 |
| `tests/gateway/test_webhook_deliver_only.py`, `test_webhook_session_close.py` | `webhook-delivery.test.ts` — direct-delivery parity, TTL delivery-info retention, session close on complete |

Playwright E2E: settings Webhooks section — subscribe flow, secret reveal, test-delivery POST against
the Rust listener, listener status/bind errors. Parity script: run the same fixture payloads
(realistic GitHub PR JSON + each signature header mode) through Python `WebhookAdapter._handle_webhook`
and the Rust listener, diff status code + body + rendered prompt.

## 11. Reference links

- Core: `gateway/platforms/webhook.py`, `gateway/platforms/webhook_filters.py`,
  `hermes_cli/webhook.py`, `gateway/config.py`, `gateway/platforms/base.py`,
  `hermes_cli/port_lock.py`
- Docs: `website/docs/user-guide/messaging/webhooks.md`
- Tests: `tests/gateway/test_webhook_adapter.py`, `test_webhook_dynamic_routes.py`,
  `test_webhook_signature_rate_limit.py`, `test_webhook_integration.py`,
  `test_webhook_deliver_only.py`, `test_webhook_session_close.py`
- kimi-code TS: `packages/kap-server/src/middleware/{auth,rateLimit,hostnames,defineRoute}.ts`,
  `packages/kap-server/package.json` (fastify ^5.1.0, zod, pino, bcryptjs) — Node-hosted HTTP
  pattern; **no webhook adapter exists** (grep verified)
- Desktop: `web/src/routes/settings.tsx`, `web/src/hooks/use-cron.ts`, `web/src/lib/transport.ts`,
  `web/src/lib/gateway-client.ts`, `packages/protocol/src/{index,hermes-api,channels}.ts`,
  `src/commands/api_proxy.rs`, `src/commands/browser_companion.rs` (hyper loopback precedent),
  `src/process/dashboard.rs` (port 9120), `src/process/port_lock.rs`, `Cargo.toml`
  (hyper, sha2 0.10, base64, serde_yaml, rusqlite, getrandom),
  `docs/desktop-prd/01-prd.md` (D4 webhooks-cut), `docs/desktop-prd/03-feature-specs.md:560`
- Plans: `plans/README.md`, `plans/_INDEX.md` (webhooks-platform #94),
  `plans/event-hooks.md` (outbound webhooks + EventBus pattern), `plans/telegram-platform.md`
  (gateway-scope port-decision format), `plans/messaging-gateway-core.md`
