# Observability — Python → TypeScript Rewrite Plan

## 1. Summary

Port the Hermes gateway **content-free monitoring plane** into the TypeScript frontend monorepo: an
in-process monitoring emitter, gateway/cron health snapshot builders, an OTLP/HTTP exporter
(spans/metrics/logs), and the unconditional export redaction layer. The Python implementation
(`agent/monitoring/*`) is deliberately content-free — it exports gateway/platform/cron health state and
redacted operational diagnostics to an **operator-configured** OTLP endpoint, never prompts/messages/tool
payloads/session history. The desktop rewrite must preserve three invariants: (1) the hot-path invariant
(`emit()` never blocks/raises into the caller), (2) the fixed bounded vocabulary (metric names,
attribute allowlists, span/log names are enumerated and anything unlisted is dropped), and (3) fail-closed
redaction (if the redactor cannot run, the raw string is never egressed).

In-scope planes: OTLP exporter, gateway health export, cron health export, redaction. The
content-bearing planes (`plugins/observability/langfuse`, `plugins/observability/nemo_relay`,
`hermes_cli/observability/shared_metrics*` product analytics) are explicitly **out of scope for the
desktop standalone** (see §2/§9) — the desktop already has its own usage-analytics UI
(`routes/analytics.tsx` + `/api/analytics/usage`).

Key design decision: keep the Python architecture shape (emitter → subscribers → exporters) but run it
in the Tauri webview, re-derive gateway health from existing desktop state
(`web/src/lib/gateway-client.ts`, `health-grid.tsx`, `ui-store.ts`), and replace the Python OTel SDK
with a thin OTLP/HTTP exporter that adopts kimi-code's proven transport patterns (bounded queue,
retry/backoff, timeout, disk/IndexedDB outbox, 0600 file semantics).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn` (repo-relative paths below).

| File | Role |
| --- | --- |
| `agent/monitoring/emitter.py` | `MonitoringEmitter`: fire-and-forget bounded queue (max 10k, drop-oldest), daemon dispatcher thread, batch fan-out (256/batch) to fail-isolated subscribers; process singleton `get_emitter()`; `flush()`, `stats()`, `close()`. |
| `agent/monitoring/events.py` | Typed dataclasses `GatewayHealthEvent`, `GatewayDiagnosticEvent`, `CronExecutionEvent` with `to_dict()` + `ts_ns`. |
| `agent/monitoring/otlp_exporter.py` | Lazy OTel SDK (`opentelemetry-sdk` + `exporter-otlp-proto-http`); `build_exporter`, `export_batch` (event→span mapping with per-kind `keep_by_kind` allowlist + redaction + 500-char truncation), `OTLPStreamer` (emitter subscriber), `is_available/is_enabled/start_streaming`, headers resolved from env var **names** never values. |
| `agent/monitoring/gateway_health.py` | Snapshot builder `build_gateway_health_snapshot` (gauges `hermes.gateway.up/state/active_agents/busy/drainable/restart_requested`, `hermes.platform.up/degraded`), `classify_gateway_error`, `classify_exit_reason`, `emit_runtime_status_transition`, `GatewayDiagnosticLogHandler` (Python `logging.Handler` for `gateway.*` warn/error records), opaque `_safe_instance_id` = `sha256:<hex[:24]>`. |
| `agent/monitoring/gateway_health_export.py` | Orchestrator `start_gateway_health_export`: observable gauges via `MeterProvider`/`PeriodicExportingMetricReader` (default 60s), `gateway_health` spans via `OTLPStreamer` (event_filter), diagnostics as OTLP logs (`GatewayDiagnosticLogStreamer`, constant body, bounded attrs, source logger scope), snapshot thread (`logs_export_interval_seconds` default 5s), `_read_background_work_count`/`_read_background_delegations_count`, fail-open `shutdown()`. Endpoints derive `/v1/metrics`, `/v1/logs` from the configured `/v1/traces` endpoint. |
| `agent/monitoring/cron_health.py` | `build_cron_health_snapshot` (scheduler heartbeat/last-success age, catch-up count, enabled/running/overdue jobs), `project_execution_event` (opaque `sha256:` job key, bounded status/source/delivery_outcome/error_class, duration_ms), `emit_execution_state` (terminal states flush ≤1s fail-open). |
| `agent/monitoring/redaction.py` | `redact_for_export`: unconditional secrets (wraps `agent/redact.py::redact_sensitive_text(force=True)` + bearer/token/`***` shapes) then PII (email/phone/UUID); **fail-closed** (`[redaction-unavailable]` when redactor fails). |
| `agent/monitoring/policy.py` | `ensure_install_id`: stable resettable install id persisted to `config.yaml` (`monitoring.install_id`), becomes hashed `service.instance.id`. |
| `hermes_cli/observability/*` | First-party observability entry points: `observe_lifecycle`, `relay_shared_metrics` (product counters → SQLite outbox), `shared_metrics_subscriber`. **Product analytics plane — out of scope.** |
| `plugins/observability/langfuse/`, `plugins/observability/nemo_relay/` | Hook-based content-bearing trace plugins (observer hooks in `docs/observability/README.md`). **Out of scope; separate plane.** |

Docs: `docs/observability/monitoring.md` (export table, enabling YAML, alert examples, "maintaining this
plane" vocabulary checklist), `docs/observability/README.md` (observer hooks), `website/docs/user-guide/features/built-in-plugins.md`
§observability/langfuse.

Data flow today: `gateway.status.write_runtime_status` / cron scheduler / Python logging → `emitter.emit(event)`
→ dispatcher thread → subscribers (`OTLPStreamer` spans, `GatewayDiagnosticLogStreamer` logs, metric
provider) → operator OTLP collector. Nothing is persisted locally (egress path, not a store); the only
persisted value is the install id.

## 3. Target TypeScript design

New module tree under `web/src/lib/monitoring/` (plus Zod schemas in `packages/protocol`):

```
web/src/lib/monitoring/
  emitter.ts            MonitoringEmitter (bounded queue, batch fan-out, fail-isolated subscribers, singleton)
  events.ts             typed event builders (GatewayHealthEvent / GatewayDiagnosticEvent / CronExecutionEvent)
  redaction.ts          redactForExport() — fail-closed secrets+PII scrubber (port of agent/monitoring/redaction.py)
  install-id.ts         ensureInstallId() — stable pseudonymous id persisted to localStorage/IndexedDB or Rust config
  otlp-exporter.ts      OtlpSpanExporter / OtlpMetricExporter / OtlpLogExporter + encoding + transport wrapper
  transport.ts          OtlpHttpTransport — fetch + timeout + retry/backoff + IndexedDB outbox (kimi-code pattern)
  gateway-health.ts     buildGatewayHealthSnapshot(runtimeLike, {gatewayRunning, profile, installId, version})
                        + classifyGatewayError/classifyExitReason + opaque sha256 instance id (Web Crypto)
  cron-health.ts        buildCronHealthSnapshot() + projectExecutionEvent() (opaque job key, bounded enum vocabulary)
  gateway-health-export.ts  GatewayHealthExportRuntime: start/stop, metric provider, log streamer, snapshot timer
  status.ts             isEnabled()/isAvailable()/buildStatus() — `hermes monitoring status` equivalent for UI
```

Class/interface sketch (pseudocode — no implementation):

```ts
interface MonitoringEvent { event: "gateway_health"|"gateway_diagnostic"|"cron_execution"; tsNs: number; [k: string]: unknown }
type Subscriber = (batch: MonitoringEvent[]) => void;

class MonitoringEmitter {           // mirrors agent/monitoring/emitter.py
  emit(event: MonitoringEvent | { toDict(): MonitoringEvent }): void; // never throws/blocks
  subscribe(cb: Subscriber): void; unsubscribe(cb: Subscriber): void;
  flush(timeoutMs: number): Promise<void>; stats(): { queued; dispatched; dropped; subscribers };
  close(): void;
}
getMonitoringEmitter(): MonitoringEmitter;  // process-wide singleton, dormant until subscribed

interface OtlpConfig { enabled: boolean; endpoint: string; headersEnv: Record<string, string> }
interface GatewayHealthExportConfig { enabled: boolean; metricsEnabled?: boolean; diagnosticEventsEnabled?: boolean;
  warningErrorEventsEnabled?: boolean; exportIntervalSeconds?: number; logsExportIntervalSeconds?: number;
  resourceAttributes?: Record<string, string> }

function startGatewayHealthExport(config: MonitoringConfig): GatewayHealthExportRuntime; // never throws
function redactForExport(text: string | null): string | null;  // fail-closed
function buildGatewayHealthSnapshot(runtime: GatewayRuntimeLike, opts: SnapshotOpts): GatewayHealthSnapshot;
function projectCronExecution(record: CronRecord, deliveryOutcome?: string): CronExecutionEvent;
```

How it runs in-process without the Python backend:

- **Gateway health source**: the webview already tracks gateway state via `web/src/lib/gateway-client.ts`
  (JSON-RPC events) and displays it in `components/panel/health-grid.tsx` / `app-status-bar.tsx`. The
  snapshot builder consumes a normalized `GatewayRuntimeLike` (gateway_state, active_agents, platforms,
  pid, restart_requested) derived from those existing stores, plus `useActiveProfileName()` and the
  build-time `version`/`supervisionMode` (desktop = `manual`, or `container` if bundled runtime flags).
- **Cron health source**: cron gauges need a desktop-side cron registry. kimi-code proves the agent-side
  cron shape (`packages/agent-core/src/agent/cron/`, `src/tools/cron/`). Until the desktop ports cron,
  `buildCronHealthSnapshot` returns scheduler gauges only when a registry exists; otherwise the gauges
  are **omitted** (the Python design already treats each reader as best-effort — omission is valid).
- **Diagnostic logs**: no Python `logging` hierarchy in the webview. A `DiagnosticLogSink` adapter
  subscribes to the desktop's log capture (reuse `src/commands/log_export.rs` log-snapshot path) and to
  gateway-client error events, maps them to `gateway_diagnostic` events with bounded `subsystem`/
  `error_class`/`severity`, keeping rendered free text out.
- **Exporter**: runs on `setInterval` snapshot timers (mirror `PeriodicExportingMetricReader` 60s +
  snapshot thread 5s) and on emitter batch callbacks (spans/logs). OTLP/HTTP POST to the operator
  endpoint; see §5 for encoding choice.

## 4. Data models & persistence

Python rule: **monitoring is an egress path, not a store** — no event persistence. TS keeps that rule,
with two small exceptions inherited from the Python/Kimi designs:

1. **Install id** (`service.instance.id` continuity): persist `monitoring.install_id` via
   `localStorage` (webview) or, better, a Rust config write through an existing command so it survives
   app data resets — mirrors `agent/monitoring/policy.py` (config.yaml write, fail-open). Rotating =
   clearing the key.
2. **Failed-send outbox** (transport durability): kimi-code's `AsyncTransport.saveToDisk`
   (`packages/telemetry/src/transport.ts`) writes failed batches as `failed_*.jsonl` under
   `~/telemetry` with mode 0600 and retries with backoff `[1s, 4s, 16s]`, pruning after 7 days. The
   webview has no `node:fs`, so the outbox is **IndexedDB** (`telemetry/outbox`, one record per batch,
   `exported_at` timestamp, 7-day retention), or a new Rust IPC `write_monitoring_outbox(file, bytes)`
   when OS-level 0600 semantics are required. This is optional hardening; the Python exporter itself
   has no outbox (fail-open drop), so parity does not require it.

Zod schemas (new `packages/protocol/src/monitoring.ts`, re-exported from index):

- `MonitoringConfig` — `{ monitoring: { install_id?, gateway_health_export?, export: { otlp: { enabled,
  endpoint, headers_env } } } }` (exact mirror of the Python YAML shape so the config surface freezes).
- `GatewayHealthEvent` / `GatewayDiagnosticEvent` / `CronExecutionEvent` — the three event shapes with
  the Python field sets (used by emitter, redaction tests, and export mapping).
- `GatewayMetric` — `{ name, value: number, attributes: Record<string,string> }`.
- `MonitoringStatus` — `{ enabled, otlpAvailable, otlpEnabled, reason, metricsEnabled,
  diagnosticEventsEnabled, exportedCounts, installIdHashed, lastError }` (for the settings UI).

No migrations needed beyond the IndexedDB outbox version key (`hermes.observability.outbox.v1`).

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / decision |
| --- | --- | --- |
| `opentelemetry-sdk` (TracerProvider, BatchSpanProcessor, Resource), `opentelemetry-exporter-otlp-proto-http` | **Recommendation: thin OTLP/HTTP JSON exporter from scratch** (a `web/src/lib/monitoring/otlp-exporter.ts` that POSTs the OTLP JSON envelope for spans/metrics/logs via `fetch`), wrapped in a kimi-code-style transport. Alternative: official `@opentelemetry/api` + `@opentelemetry/sdk-trace-web` + `@opentelemetry/exporter-trace-otlp-http` (+ `sdk-metrics`/`exporter-metrics-otlp-http`, `sdk-logs`/`exporter-logs-otlp-http`). | **kimi-code has NO OTel SDK**: `grep opentelemetry packages/**/package.json` → zero matches. `packages/telemetry/package.json` is dependency-free (`node:crypto`, `node:fs`, `node:os`, global fetch). Its `AsyncTransport` (retry backoff, 10s timeout, 401 retry-without-token, disk outbox 0600, 7-day prune) is the proven TS egress pattern. Given the exporter must also run in a webview where `@opentelemetry/exporter-metrics-otlp-http`/logs are still experimental and protobuf transports need bundler/wasm handling, a hand-rolled OTLP/HTTP **JSON** exporter for the three small signal types is the lower-risk path; the OTel JS SDKs remain the fallback if protocol fidelity to the Python protobuf path is required. |
| `tools.lazy_deps` / optional `[otlp]` extra | Not needed — the TS exporter is always bundled; `status.ts::isAvailable()` always true. Config-gated `isEnabled()` replaces lazy-install gating. | Python lazily imports to keep the core install light; a bundled webview has no separate install step. |
| `threading`/`queue` emitter | `MonitoringEmitter` using an in-memory array + microtask/`setInterval` drain; bounded queue (e.g. 10k) drop-oldest. | kimi-code `TelemetryClient` (`client.ts`): bounded queue `MAX_QUEUE_SIZE = 1000`, drop-oldest (`slice`), attach-sink replay, `disable()` no-op — direct evidence of the TS bounded-queue pattern. Python's `_DRAIN_BATCH = 256` → batch drain loop. |
| `hashlib.sha256` (opaque instance/job keys) | `crypto.subtle.digest("SHA-256", ...)` (Web Crypto) → `sha256:<hex[:24]>`. | kimi-code uses `node:crypto.randomUUID` for event ids (`client.ts`); Web Crypto is the webview equivalent; the `sha256:` prefix format is frozen by Python tests (`test_cron_health_export.py` asserts `len == len("sha256:")+24`). |
| `agent/redact.py::redact_sensitive_text` + `agent/monitoring/redaction.py` | **Implement from scratch** `web/src/lib/monitoring/redaction.ts` — regex port (bearer, `sk-`/`ghp_`/`xox*` tokens, `***`, email, E.164-ish phone, UUID) with **fail-closed** `[redaction-unavailable]`. | **No TS equivalent found in kimi-code**: its telemetry only does `sanitizeProperties` (primitives filter, `types.ts`) and observer-payload sanitization (docs); there is no secrets/PII regex redactor. In-repo cross-language reference: Rust `src/commands/debug_bundle.rs` already implements the same family of redaction regexes (`BEARER_RE`, `LONG_TOKEN_RE`, `QUERY_TOKEN_RE`, `KEY_VALUE_SECRET_RE`) — the TS port should mirror that file's needle list for parity. |
| `gateway.status` readers, `cron.jobs`/`cron.scheduler` | Re-derive from desktop state: `web/src/lib/gateway-client.ts` + `components/panel/health-grid.tsx` + `ui-store.ts` (`UiTurnStats`, kanban/background work). Cron registry: kimi-code `packages/agent-core/src/agent/cron/` + `src/tools/cron/` shape (phase-gated). | kimi-code has agent-side cron infra to model after when the desktop ports cron; Python cron health semantics (ticker heartbeat age, grace window, catch-up counter) have no direct kimi-code equivalent — must be implemented from scratch if cron lands in desktop. |
| `threading.Timer`/snapshot thread | `setInterval` + `AbortController`; `unref()`-style cleanup via `clearInterval` on shutdown. | kimi-code `SystemMetricsCollector` (`systemMetrics.ts`) is the evidence: warmup `setTimeout` + `setInterval` sampler, `stop()` clears both — same shape as the Python snapshot thread. |
| `logging.Handler` (gateway diagnostics) | `DiagnosticLogSink` adapter over the desktop log capture (`src/commands/log_export.rs` path) + gateway-client error events. | No TS logging-Handler equivalent; `gateway.*` logger-namespace allowlist does not exist in the webview — subsystem mapping must be redefined from desktop components (risk §9). |
| `uuid` (install id) | `crypto.randomUUID()`. | kimi-code `client.ts` uses `randomUUID` for event ids. |

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse / extend (cite real files):

- `web/src/lib/transport.ts` — **not** for OTLP egress (operator endpoint is outside Hermes auth); but
  reuse its pattern for the settings-page config fetch/update if a backend config REST path exists.
- `web/src/lib/gateway-client.ts`, `components/panel/health-grid.tsx`, `app-status-bar.tsx` — gateway
  state feeds `buildGatewayHealthSnapshot`; subscription events map to lifecycle/state-change emits.
- `web/src/lib/ui-store.ts` (`UiTurnStats`) — local per-turn stats source for
  `active_agents`-like counts and for `hermes.gateway.background_work`-style derivations where
  available; the Python `process_registry`/`async_delegation` sources do not exist in the webview.
- `web/src/routes/analytics.tsx` + `web/src/hooks/use-analytics.ts` + `lib/analytics.ts` — the existing
  **usage analytics** plane (`/api/analytics/usage` REST). Keep as-is; it is product analytics, not the
  monitoring export plane. Link both in the UI under one "Monitoring & Analytics" settings group.
- `web/src/routes/settings.tsx` — add a Monitoring section: enabled toggle, endpoint URL, `headers_env`
  editor (values are env var names, never secrets), `install_id` rotate button, live
  `MonitoringStatus` display (`status.ts`).
- `packages/protocol/src/hermes-api.ts` — add `monitoring.ts` schemas (see §4); reuse `z` + existing
  export conventions (`AnalyticsResponse` at line ~853 is the pattern).
- Rust: `src/commands/debug_bundle.rs` — parity reference for redaction regexes; `src/commands/log_export.rs`
  — diagnostic log capture path; optionally add `write_monitoring_outbox` IPC for 0600 outbox files and
  read `get_runtime_config` (`commands/gateway.rs`) for version/supervision mode. `ws_proxy.rs` is
  untouched (OTLP egress is plain HTTPS from the webview, not `/api/ws`).
- CSP/tauri.conf.json: if the operator endpoint is remote, `connect-src` must allow it (dev Vite proxy
  can avoid CORS in dev; production webview needs CSP + Rust-side proxy if the webview blocks
  `ws://`/`http://` like it does for gateway sockets). Open question §9.

## 7. Removing the WebSocket dependency (migration path)

Today the exporter lives inside the Python gateway process; the desktop never routes OTLP through
`/api/ws`, so observability is already WS-free for egress. The migration is about **moving the signal
source** off the backend:

- **Phase A (today)**: backend exports directly; desktop only needs a config + status surface. Freeze
  the API surface now: the config schema (`monitoring.export.otlp.{enabled,endpoint,headers_env}`,
  `monitoring.gateway_health_export.*`), and the exported vocabulary (metric names, `keep_by_kind`
  attribute allowlists, span names `hermes.<event>`, log scope/attrs) — parity tests key off these.
- **Phase B (in-process)**: the webview builds the same events from local gateway-client/ui-store state
  and exports them with the TS exporter behind the same `startGatewayHealthExport(config)` interface
  used by the settings page. Both backend and webview exporters may run during migration; the OTLP
  vocabulary is identical, so duplicate exports are harmless (same `service.instance.id`).
- **Phase C (delete)**: desktop stops configuring the backend exporter; the backend module stays for
  CLI/`hermes gateway run` users but is no longer exercised by the desktop. The WS/REST link for
  monitoring status display is removed last, after `status.ts` fully derives from local state.

The frozen surface during migration: (1) the 16 metric names in
`gateway_health_export.py::_start_metric_provider.metric_names`; (2) the `keep_by_kind` span-attribute
allowlist in `otlp_exporter.py::_span_attrs`; (3) the `_DIAGNOSTIC_ATTRIBUTE_KEYS` log-attribute
allowlist; (4) `_RESOURCE_ATTRIBUTE_KEYS` + hashed `service.instance.id`; (5) redaction output
contract (`[email]`/`[phone]`/`[id]`/`[redacted]`/`[redaction-unavailable]`, truncation limits).

## 8. Migration phases & task breakdown

1. **P0 — Foundation & redaction** (security-critical first): `packages/protocol/src/monitoring.ts`
   schemas; `web/src/lib/monitoring/redaction.ts` (fail-closed) with the parity table from
   `tests/monitoring/test_export_redaction.py`; `emitter.ts` with `test_emitter.py` parity
   (dormant singleton, unsubscribe, hot-path fast, failing subscriber isolation).
2. **P1 — Event models + gateway health**: `events.ts`; `gateway-health.ts`
   (`buildGatewayHealthSnapshot`, `classifyGatewayError`, `classifyExitReason`, opaque sha256 ids via
   Web Crypto); wire to `gateway-client.ts`/`health-grid.tsx` state; `install-id.ts`.
3. **P2 — OTLP transport + exporter**: `transport.ts` (fetch + timeout + backoff + IndexedDB outbox),
   `otlp-exporter.ts` (OTLP/HTTP JSON spans/metrics/logs, endpoint derivation `/v1/traces` →
   `/v1/metrics`,`/v1/logs`), `gateway-health-export.ts` runtime (timers, streamers, shutdown
   deadline). Golden encoding fixtures from `scripts/observability/otel_capture_collector.py` output.
4. **P3 — Cron health projection**: `cron-health.ts`; opaque job keys, duration, bounded enums; gauges
   omitted until a desktop cron registry exists (or port kimi-code cron as prerequisite).
5. **P4 — UI**: settings Monitoring section + `status.ts`; rotate install id; outbox status.
6. **P5 — Parity + cutover**: run Python probe (`scripts/observability/gateway_health_export_probe.py`)
   and TS probe against the same capture collector, diff decoded OTLP; flip desktop to in-process
   export (Phase B), then stop configuring the backend exporter (Phase C); update docs.

## 9. Risks & open questions

- **No TS equivalent for the Python redactor** (`agent/redact.py` + `redaction.py`): kimi-code has only
  a primitives filter (`sanitizeProperties`) — no secrets/PII redactor. The TS port must be written
  from scratch and maintained as a security-critical surface; parity tests must lock the exact output
  markers. Cross-check against Rust `debug_bundle.rs` regexes to avoid divergence between the two
  redaction implementations.
- **kimi-code telemetry is NOT OTLP** — it POSTs a custom JSON event payload to
  `telemetry-logs.kimi.com/v1/event`. Its value is the transport pattern (retry/backoff/timeout/outbox),
  not protocol fidelity. OTLP encoding (JSON vs protobuf) and the webview-experimental OTel JS metric/log
  exporters are the main unknowns; the plan recommends a thin OTLP/HTTP JSON exporter but this must be
  validated against the target collector (JSON is supported by OTLP/HTTP receivers, but some
  deployments expect protobuf).
- **Webview ≠ Node**: kimi-code transport relies on `node:fs`/`node:os`/`process.cpuUsage`; the
  Tauri webview has none. Outbox/install-id persistence moves to IndexedDB or new Rust IPC; system-like
  metrics must be re-mapped to browser APIs or omitted. 0600 file semantics need a Rust command if
  required.
- **No Python logging tree in the webview**: `GatewayDiagnosticLogHandler`'s `gateway.*` logger
  allowlist has no TS counterpart; diagnostic event sources must be redefined (gateway-client error
  events, UI log capture), changing which events can ever be exported.
- **`background_work`/`background_delegations` sources don't exist in the webview**
  (`tools.async_delegation`, `tools.process_registry`): the gauges may be omitted (allowed by the
  best-effort design) but operator alert docs assume them; desktop must document the delta or derive
  equivalents from `ui-store.ts`/kanban state.
- **Cron gauges depend on a desktop cron scheduler** that does not exist yet; kimi-code's cron package
  is the model but its heartbeat-age/grace/catch-up semantics are Hermes-specific and must be
  re-implemented.
- **CSP/`connect-src`**: exporting to a remote operator endpoint from the production webview needs
  `tauri.conf.json` CSP changes or a Rust-side OTLP proxy (like `ws_proxy.rs`) if the webview blocks
  cross-origin fetch — decide before Phase B.
- **Endpoint-path derivation** (`/v1/traces` → `/v1/metrics`,`/v1/logs`) and `headers_env`
  env-var-name semantics must be preserved exactly; a collector-allowlist mismatch silently drops
  signals (documented Python failure mode).

## 10. Test strategy

- **Vitest unit (parity with Python tests)**:
  - `redaction.test.ts` ← `tests/monitoring/test_export_redaction.py`: secret stripped, bearer stripped,
    structure preserved (`platform.slack`/`auth_failed` survive), fails-closed on redactor error, plus
    Rust `debug_bundle.rs` needle parity cases.
  - `emitter.test.ts` ← `tests/monitoring/test_emitter.py`: disabled emit no-op, singleton dormant until
    subscribed, unsubscribe stops delivery, hot-path <1s for 1k emits, failing subscriber never breaks
    peers.
  - `otlp-exporter.test.ts` ← `tests/monitoring/test_otlp_exporter.py` +
    `test_gateway_health_export.py`: span name `hermes.gateway_health`, attrs allowlist + redaction +
    no `hermes.profile`, resource attrs allowlisted/sanitized (no `user.email`, hashed instance id),
    headers resolve from env-var names, streamer respects event_filter, failing exporter never breaks
    emitter.
  - `cron-health.test.ts` ← `tests/monitoring/test_cron_health_export.py`: opaque `sha256:` job key,
    duration_ms=2250, `auth_failed` classification, no `job_id`/`error`, auth-substring false positives
    (`"tokenizer crashed"` → `unknown`).
  - `install-id.test.ts` ← `test_install_id_persists_across_calls`: id survives a fresh store.
- **Transport unit**: timeout/abort, retry backoff (fake fetch), 401 retry-without-header (kimi-code
  behavior), IndexedDB outbox write/prune/retry (fake `indexedDB`).
- **Integration**: in-memory transport capture (mirror `InMemorySpanExporter`) through
  `startGatewayHealthExport` with a fake gateway-client state; golden OTLP JSON envelope fixtures from
  `scripts/observability/otel_capture_collector.py` captures; run the Python probe and the TS probe
  against one capture collector and diff decoded metric/span/log attribute sets (parity gate).
- **Playwright E2E**: settings page enables monitoring with a local capture collector, status shows
  enabled, install-id rotate changes hashed id; collector receives `hermes.gateway.up` after a mocked
  gateway state change.
- Rust tests unchanged; add `write_monitoring_outbox` unit test if the IPC is added
  (wiremock not needed — pure fs with `tempfile::TempDir`).

## 11. Reference links

Python (source of truth): `D:/hermes-agent-cn`
- `agent/monitoring/{__init__,emitter,events,otlp_exporter,gateway_health,gateway_health_export,cron_health,redaction,policy}.py`
- `hermes_cli/observability/{__init__,relay_runtime,shared_metrics,shared_metrics_contract,shared_metrics_subscriber}.py`
- `plugins/observability/langfuse/__init__.py`, `plugins/observability/nemo_relay/__init__.py`
- `docs/observability/{README,monitoring,relay-shared-metrics}.md`
- `website/docs/user-guide/features/{plugins.md,built-in-plugins.md}`, `website/docs/reference/environment-variables.md`
- `tests/monitoring/{test_otlp_exporter,test_emitter,test_gateway_health_export,test_cron_health_export,test_export_redaction}.py`, `tests/plugins/test_langfuse_plugin.py`

TypeScript reference: `D:/kimi-code`
- `packages/telemetry/{package.json,src/client.ts,src/transport.ts,src/sink.ts,src/systemMetrics.ts,src/bootstrap.ts,src/types.ts,src/remote.ts}`
- `packages/agent-core/src/agent/usage/index.ts`
- `apps/kimi-code/src/utils/usage/{usage-format.ts,debug-timing.ts}`

Desktop: `D:/Hermes-CN-Desktop`
- `web/src/lib/analytics.ts`, `web/src/hooks/use-analytics.ts`, `web/src/routes/analytics.tsx`
- `web/src/lib/gateway-client.ts`, `web/src/lib/transport.ts`, `web/src/lib/ui-store.ts`
- `web/src/components/panel/health-grid.tsx`, `web/src/components/app-shell/app-status-bar.tsx`
- `src/commands/debug_bundle.rs`, `src/commands/log_export.rs`, `src/commands/gateway.rs`
- `packages/protocol/src/hermes-api.ts`, `tauri.conf.json`
