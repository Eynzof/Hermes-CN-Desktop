# Event Hooks (4 Systems) — Python → TypeScript Rewrite Plan

## 1. Summary

Port Hermes' four hook systems from the Python backend (`D:/hermes-agent-cn`) into the
in-process TypeScript runtime of `D:/Hermes-CN-Desktop`, so lifecycle customization works
with no Python backend / WebSocket link:

| System | Registered via | Runs in (Python) | TS goal |
|---|---|---|---|
| Gateway hooks | `HOOK.yaml` + `handler.py` in `~/.hermes/hooks/` | Gateway only | `HOOK.yaml` + `hook.ts` (ESM), in-process registry |
| Plugin hooks | `ctx.register_hook()` in a plugin's `register(ctx)` | CLI + Gateway | `PluginContext.registerHook()` in a TS plugin contract |
| Shell hooks | `hooks:` block in `~/.hermes/config.yaml` → shell scripts | CLI + Gateway | same YAML config; subprocess via Rust Tauri IPC (`hook_spawn`) |
| Outbound webhooks | `hooks.outbound:` list in `~/.hermes/config.yaml` | CLI + Gateway | same config; in-process bounded queue + HMAC-SHA256 delivery |

Key design decisions:
1. **Keep the Python wire formats verbatim** — shell-hook stdin/out JSON, outbound POST body +
   headers (`X-Hermes-*`), and the `HOOK.yaml` manifest shape — so existing user scripts and
   receiver integrations keep working during migration and parity tests are mechanical.
2. **Gateway/plugin "handler.py is Python" is the one contract that must change**: TS handlers
   become `hook.ts` / plugin TS modules loaded via dynamic `import()`. This is the biggest
   user-visible break and is called out in Risks (§9).
3. **Tauri webview has no Node**: subprocess spawning (shell hooks) and any non-fetch HTTP
   (outbound webhooks) delegate to Rust Tauri commands; the TS layer owns parsing, aggregation,
   consent, queueing, and signing (Web Crypto HMAC).
4. **One shared in-process dispatcher** mirrors Python: plugin callbacks run first (in-process),
   then shell hooks (subprocess), then outbound webhooks (async notify-only queue) — preserving
   the documented precedence ("Python block decisions win ties").

Scope clarification: `tests/cli/test_cli_extension_hooks.py` covers **TUI subclass extension
hooks** (`_get_extra_tui_widgets`, `_register_extra_tui_keybindings`, `_build_tui_layout_children`)
— unrelated to the 4 event-hook systems; it is listed for completeness but not ported here.
`tests/gateway/test_webhook_*.py` and `tests/hermes_cli/test_webhook_cli.py` test the **inbound**
webhook platform (`hermes_cli/webhook.py`, `gateway/platforms/webhook.py`), tracked by plan
`webhooks-platform` (#94 in `plans/_INDEX.md`); only `tests/agent/test_outbound_webhooks.py`
covers the outbound side in scope here.

## 2. Current Python implementation

### 2.1 Gateway hooks — `D:/hermes-agent-cn/gateway/hooks.py` (229 lines)
- `HookRegistry` scans `HOOKS_DIR = ~/.hermes/hooks`; each subdir must contain `HOOK.yaml`
  (`name`, `description`, `events[]`) and `handler.py` with a top-level `handle(event_type, context)`
  (sync or async). `_register_builtin_hooks()` is an empty extension point
  (`gateway/builtin_hooks/__init__.py` is a stub docstring).
- `discover_and_load()` registers handlers per event; module is pre-registered in `sys.modules`
  before `exec_module` so Pydantic forward refs resolve.
- `emit()` fires exact-match handlers then wildcard `base:*` (e.g. `command:*`); errors are caught
  and logged, never blocking. `emit_collect()` returns non-`None` return values (decision-style
  hooks like `command:<name>` policies).
- Events (docs §"Available Events"): `gateway:startup`, `session:start/end/reset/compress`,
  `agent:start/step/end`, `reaction:added/removed`, `command:*` — with documented context keys
  (platform/user_id/chat_id/thread_id/chat_type/session_id/message; `agent:end` adds response/model/provider).

### 2.2 Plugin hooks — `D:/hermes-agent-cn/hermes_cli/plugins.py` (~5,877 lines)
- `VALID_HOOKS` (line 155) is the authoritative event set (~30 events): `pre_tool_call`,
  `post_tool_call`, `transform_terminal_output`, `transform_tool_result`, `transform_llm_output`,
  `pre_llm_call`, `post_llm_call`, streaming observers (`on_stream_start/delta/end`,
  `on_interim_message`), `pre_verify`, `pre_api_request`, `post_api_request`, `api_request_error`,
  `on_session_start/end/finalize/reset`, `on_skill_lifecycle`, `subagent_start/stop`,
  `pre_gateway_dispatch`, `gateway_platform_event`, `pre_approval_request`, `post_approval_response`,
  kanban lifecycle observers, etc.
- `PluginContext.register_hook(hook_name, callback)` (line 2770) validates against `VALID_HOOKS`
  and appends to `PluginManager._hooks[hook_name]`; `register_system_prompt_section` (line 2795)
  is the cache-safe bounded prompt-section API (separate contract, ported as a follow-on).
- `PluginManager.invoke_hook(hook_name, **kwargs)` (line 4562): per-callback try/except, filters
  kwargs to the callback's declared signature (`**kwargs` gets everything), injects
  `telemetry_schema_version="hermes.observer.v1"` except for `gateway_platform_event`, returns
  non-`None` results in registration order. Category semantics: observers ignore returns;
  transforms take the first valid string (empty string accepted for tool/terminal transforms but
  **not** for `transform_llm_output`); directive/control consume documented shapes (first valid
  `block`/`approve` wins for `pre_tool_call`, first valid continue/block-stop for `pre_verify`,
  context joined for `pre_llm_call`).
- `plugins/plugin_utils.py` ships `lazy_singleton` / `SingletonSlot` (thread-safe lazy singletons
  for plugin authors) — a concurrency-support lib, not a hook mechanism itself.

### 2.3 Shell hooks — `D:/hermes-agent-cn/agent/shell_hooks.py` (1,123 lines) + `hermes_cli/hooks.py`
- `ShellHookSpec(event, command, matcher, timeout, fail_closed)` parsed from the `hooks:` YAML
  block; `matcher` regex only honored for `pre_tool_call`/`post_tool_call`; timeout default 60s,
  clamped to [1, 300].
- `register_from_config(cfg, accept_hooks=...)`: first-use consent per `(event, command)` pair
  persisted to `~/.hermes/shell-hooks-allowlist.json` (approvals array; `approved_at`,
  `script_mtime_at_approval`); escape hatches `--accept-hooks`, `HERMES_ACCEPT_HOOKS=1`,
  `hooks_auto_accept: true`; `HERMES_SAFE_MODE=1` skips registration. Idempotent set
  `(event, matcher, command)`; `re_register_config_hooks()` re-wires after plugin force-reload.
- `_spawn()`: `split_command_line(os.path.expanduser(command))`, `shell=False`, stdin=JSON,
  timeout → `kill_process_tree` (`taskkill /T` on Windows, process group on POSIX),
  `windows_hide_flags()`; result dict `{returncode, stdout, stderr, timed_out, elapsed_seconds, error}`.
- Wire stdin: `{hook_event_name, tool_name, tool_input, session_id, cwd, extra}` (event kwargs
  minus `tool_name/args/session_id/parent_session_id`). stdout JSON: `{"action":"block","message":…}`
  / Claude-Code `{"decision":"block","reason":…}` / `{"context": "…"}` for `pre_llm_call`;
  exit code 2 = block (blocking-capable events only, `_BLOCKING_EVENTS = {pre_tool_call}`);
  fail-open default, `fail_closed: true` inverts spawn-error/timeout/non-JSON on `pre_tool_call`.
- `hermes_cli/hooks.py` — `hermes hooks list|test|revoke|doctor` CLI: `_DEFAULT_PAYLOADS` synthetic
  payloads per event, `run_once()` shares `_spawn`+`_evaluate_result` so test == production,
  doctor checks exec bit / allowlist / mtime drift / JSON smoke test.

### 2.4 Outbound webhooks — `D:/hermes-agent-cn/agent/outbound_webhooks.py` (569 lines)
- `WebhookTarget(url, events, name, secret, matcher, timeout)` parsed from `hooks.outbound:`;
  `matcher` honored only for `pre_tool_call`/`post_tool_call`; timeout [1, 60]; `secret_env`
  (preferred) > inline `secret`; malformed entries warn-and-skip.
- Registers notify-only callbacks on the same `PluginManager._hooks` (idempotent per
  `(event, url)`), so every `invoke_hook()` site fans out with zero call-site changes.
- Delivery: bounded in-process queue (256) + single daemon worker thread; `_serialize_payload`
  produces `{hook_event_name, tool_name, tool_input, session_id, cwd, extra, delivery_id, timestamp}`
  (RFC3339 UTC `Z`); headers `Content-Type`, `User-Agent: Hermes-Agent-Outbound-Webhook`,
  `X-Hermes-Event`, `X-Hermes-Delivery`, `X-Hermes-Signature-256: sha256=<hmac-sha256 hexdigest>`
  when a secret is set; `_NoRedirectHandler` refuses 3xx; retry once with 1s backoff on
  connection errors/5xx, no retry on 4xx; `atexit` drain (5s); `HERMES_SAFE_MODE` skips.

### 2.5 Docs — `D:/hermes-agent-cn/website/docs/user-guide/features/hooks.md` (1,871 lines)
Authoritative catalog: plugin-hook payload fields per event, shell-hook schema + wire protocol +
consent model + worked examples (auto-format, block, context inject, subagent log), outbound
wire format + signature verification + delivery semantics.

## 3. Target TypeScript design

Proposed module layout — new `packages/hooks/` in the Desktop monorepo (sibling of
`packages/protocol` / `packages/shared-ui`), since it is framework code shared by the agent
runtime, the settings UI, and (later) Rust-free tests:

```
packages/hooks/src/
  types.ts            # HookEventName union (port VALID_HOOKS + gateway:*), HookContext,
                      # HookResult, HookDef, ShellHookSpec, WebhookTarget (zod-validated)
  event-bus.ts        # in-process pub/sub Emitter (kimi-code EventService pattern)
  registry.ts         # GatewayHookRegistry: discover ~/.hermes/hooks/*, HOOK.yaml + hook.ts
                      # dynamic import, wildcard command:*, emit()/emitCollect()
  plugin-manager.ts   # PluginManager + PluginContext.registerHook() + invokeHook() aggregators
  shell-hooks.ts      # parse hooks: config, allowlist, runHook() via Rust hook_spawn,
                      # evaluateResult() (fail-open/fail-closed/exit-2/context-inject)
  outbound-webhooks.ts# parse hooks.outbound:, bounded queue, HMAC via Web Crypto, delivery
  config.ts           # js-yaml load of ~/.hermes/config.yaml hooks blocks
  index.ts            # public API (invokeHook, registerHook, HookRegistry, registerFromConfig)
```

In-process data flow (no Python):

```
agent turn runner / gateway lifecycle points
        │  invokeHook(event, ctx)                       (same call sites as Python)
        ▼
  PluginManager.discoverAndLoad() → registerHook(event, cb)   [in-process, ordered]
        │
        ├─► plugin callbacks (sync/async, first-valid-block / first-string-win aggregators)
        ├─► shell-hooks: matcher gate → Rust `hook_spawn` (stdin JSON, timeout, tree-kill)
        │        └─ evaluateResult → block/context/None (same wire semantics)
        └─► outbound-webhooks: enqueue delivery (notify-only, never blocks the loop)
                 └─ background worker → HMAC sign → fetch / Rust external_request
```

- `HookEventName` is a Zod union generated from the ported `VALID_HOOKS` list plus the
  `gateway:*`/`session:*`/`agent:*`/`command:*` namespaced events; unknown events warn-and-skip
  exactly like `_parse_hooks_block`.
- `invokeHook` mirrors `PluginManager.invoke_hook`: per-callback try/catch, kwarg filtering,
  `telemetrySchemaVersion` envelope, non-null result list. Transform/directive aggregation is
  explicit helper `firstString(results, {allowEmpty})` and `firstBlock(results)` so tests can
  assert parity with the Python loop sites (`run_agent.py` transform walk, `model_tools.py`
  `transform_tool_result`, permission gate for `pre_tool_call`).
- Gateway hook registry is separate (gateway-only, matching Python); in the desktop standalone
  the messaging-platform adapters may be out of scope — see Risks §9.

## 4. Data models & persistence

| Artifact | Python location | TS location | Notes |
|---|---|---|---|
| `hooks:` + `hooks.outbound:` config | `~/.hermes/config.yaml` | same file, parsed by `packages/hooks/config.ts` (js-yaml) | schema unchanged; desktop settings UI edits via existing config abstraction |
| Gateway hook dirs | `~/.hermes/hooks/<name>/{HOOK.yaml, handler.py}` | `~/.hermes/hooks/<name>/{HOOK.yaml, hook.ts}` | `hook.ts` exports `handle(eventType, ctx)` (sync/async); manifest keys unchanged |
| Shell-hook allowlist | `~/.hermes/shell-hooks-allowlist.json` (`approvals[]`) | same path + schema | `{event, command, approved_at, script_mtime_at_approval}` |
| Registered handlers | `PluginManager._hooks: Dict[str, List[Callable]]` | in-memory `Map<HookEventName, Handler[]>` | no persistence |
| Outbound queue | in-memory `queue.Queue(maxsize=256)` + worker thread | in-memory bounded queue + async worker | delivery log optionally `~/.hermes/logs/outbound-webhooks.jsonl` |
| Loaded hook metadata | `HookRegistry._loaded_hooks` | in-memory `GatewayHookInfo[]` (name/description/events/path) | surfaced by `use-hooks` for the settings UI |

No SQLite/IndexedDB needed for hooks themselves; a delivery-history UI would reuse
`packages/minidb`-style embedded storage (already planned for other Desktop features) or a JSONL
log. No breaking schema migrations: the Python wire shapes are the frozen contract.

## 5. Third-party library strategy

| Python dependency | TS equivalent | kimi-code evidence |
|---|---|---|
| `yaml` (config/manifest) | `js-yaml` | `packages/agent-core/src/profile/load.ts:4`, `src/skill/parser.ts:4` (`import { load as loadYaml } from 'js-yaml'`); `packages/agent-core/package.json:88` `"js-yaml": "^4.1.1"` |
| `subprocess` + `shlex` + process-tree kill | **Rust `std::process::Command` via new Tauri command `hook_spawn`**; TS-side semantics ported from Node spawn | kimi-code `packages/agent-core/src/session/hooks/runner.ts`: `node:child_process.spawn`, `shell:true`, `windowsHide`, timeout → `taskkill /T` tree kill (exact Windows strategy Python's `kill_process_tree` uses). Desktop webview has no Node → delegate spawn to Rust; reuse `src/commands/terminal.rs` process handling + `hermes_cli/_subprocess_compat.py` split_command_line semantics |
| `hmac` / `hashlib` (signing) | Web Crypto `crypto.subtle.importKey('raw')` + `sign('HMAC')` (async); `node:crypto.createHmac` when host is Node | kimi-code uses `node:crypto` (`agent/turn/index.ts:1 createHash`, `agent/context/projector.ts:1`, `utils/fs.ts randomBytes`); webview lacks `node:crypto` so use WebCrypto |
| `urllib.request` (outbound HTTP) | `fetch` / `undici` with `redirect: 'error'` (never follow 3xx), or Rust `external_request` (`src/commands/api_proxy.rs`) | kimi-code `packages/agent-core/src/utils/proxy.ts` imports `undici` (`package.json:102 "undici": "^7.27.1"`) |
| `threading` + `queue.Queue` (worker) | in-process bounded queue class + single async worker (setImmediate loop); fire-and-forget with pending-set | kimi-code `HookEngine.fireAndForgetTrigger()` + `pendingTriggers` (`session/hooks/engine.ts:51-66`) |
| `re` matcher | JS `RegExp` (`fullmatch` parity via anchored regex; fallback literal equality) | kimi-code `session/hooks/engine.ts:133-140` `new RegExp(pattern).test(value)` |
| `orjson`/`json` | `JSON.parse` / `JSON.stringify` | trivial |
| `dataclasses` | TS interfaces + `zod` schemas | kimi-code `session/hooks/types.ts` interfaces; `runner.ts:45-58` `z.looseObject` |
| `importlib` dynamic handler/plugin load | `import()` of `hook.ts` / plugin ESM modules with an idempotent loader | no direct kimi-code equivalent (kimi-code uses a DI singleton registry) → implement from scratch, sketch: `loadHookModule(dir): Promise<{handle: Handler}>` |
| `plugin_utils.lazy_singleton` / `SingletonSlot` | plain `getInstance()` + `reset()`; JS single-threaded event loop makes double-checked locking unnecessary | no TS equivalent needed — note in docs for plugin authors |

**No TS equivalent found (implement from scratch):**
1. Outbound webhook dispatcher — kimi-code has **no webhook client**: repo-wide grep for
   "webhook" only matched `pnpm-lock.yaml` and a skill-authoring doc (inbound service
   authoring), not an event-push implementation.
2. Python plugin format (`plugin.yaml` + `__init__.py` + `register(ctx)`) → define a TS plugin
   contract (`plugin.yaml` + `index.ts` exporting `register(ctx)`); kimi-code plugins are a
   different mechanism.
3. Gateway `HOOK.yaml` + `handler.py` → `HOOK.yaml` + `hook.ts`; dynamic module loading is our
   own `loadHookModule`.

## 6. Integration with existing Hermes-CN-Desktop frontend

- `web/src/routes/settings.tsx` — add a "Hooks" section (settings already hosts General / Cron /
  Models / MCP / etc.; cron UI is the closest pattern: `useCronJobs`/`useCreateCronJob` +
  `section-shell.tsx`). The PRD cut "触发器/Webhooks" sub-pages for v2 (D4, `docs/desktop-prd/01-prd.md`)
  — this plan flips those disabled entries to enabled with the hooks management UI.
- New React hooks in `web/src/hooks/`: `use-hooks.ts` (loaded gateway-hook list),
  `use-shell-hooks.ts` (list / consent status / `test` / `doctor` / `revoke`, porting
  `hermes hooks` CLI behavior to API/IPC calls), `use-outbound-webhooks.ts` (CRUD on
  `hooks.outbound:` + "test delivery").
- `web/src/lib/transport.ts` — keep the single transport layer for config reads/writes during
  migration; in-process `packages/hooks/config.ts` becomes the ultimate owner after WS removal.
- Event plumbing: today lifecycle events arrive over `web/src/lib/gateway-client.ts` →
  `web/src/hooks/use-gateway.ts` (GatewayEvent → jotai atoms). During migration the in-process
  `EventBus` publishes the same GatewayEvent-shaped messages so `use-gateway`'s subscription
  bridge (`GatewaySubscriber.applyGatewayEvent`) keeps working unchanged; later the WS client is
  deleted. `web/src/lib/connection-auth-events.ts` shows the existing
  `window.dispatchEvent`/`hermes:*` event convention for app-level events.
- Rust: new `src/commands/hooks.rs` (`hook_spawn`: stdin JSON, timeout, capture stdout/stderr,
  tree-kill — modeled on `src/commands/notify.rs`'s `spawn_blocking` and `terminal.rs`'s process
  handling) and optional `outbound_deliver` command reusing `src/commands/api_proxy.rs`
  `external_request` when webview fetch is CORS-blocked. Register in `main.rs`
  `generate_handler!` (60 commands today).
- `packages/protocol` — add Zod schemas for `HookInfo`, `ShellHookStatus`, `OutboundWebhookTarget`
  and the `hook_spawn` IPC request/result types.

## 7. Removing the WebSocket dependency (migration path)

**API surface to freeze during migration** (so both backends can serve the same UI/tests):
1. `hooks:` + `hooks.outbound:` YAML schema (exact key names, clamping rules, reserved
   `output_spill`/`outbound` sub-keys).
2. Shell-hook stdin JSON (`hook_event_name/tool_name/tool_input/session_id/cwd/extra`) and stdout
   directive shapes (`action|decision`, `context`, exit code 2, fail-closed message prefix).
3. Outbound POST body + `X-Hermes-*` headers + HMAC verification recipe (docs §"Verify the
   signature").
4. `HOOK.yaml` manifest keys (`name/description/events`) and event names.

Phases:
- **A (today, backend-backed)**: settings UI reads/writes the `hooks:` block via existing
  `useConfig`/`useSaveConfig` REST; gateway lifecycle events consumed over WS; shell
  hooks/outbound webhooks still execute in Python.
- **B (in-process module behind same interface)**: implement `packages/hooks` and the Rust
  `hook_spawn` bridge; the in-process agent turn runner (or, during dual-run, a shim that
  subscribes to WS and re-emits onto `EventBus`) calls `invokeHook`; UI switches to the new
  management API; wire formats unchanged.
- **C (delete WS/REST path)**: drop `gateway-client.ts` WS usage, `ws_proxy.rs`, and the
  Python-side hook REST endpoints; `packages/hooks/config.ts` becomes the config source of truth.

## 8. Migration phases & task breakdown

- **P0 — Foundations**: port `VALID_HOOKS` → `HookEventName` Zod union; `EventBus` (Emitter +
  onDidPublish, dispose); `types.ts` (`HookDef`, `HookResult`, `ShellHookSpec`, `WebhookTarget`).
- **P1 — Plugin hooks**: `PluginManager` + `PluginContext.registerHook` + `invokeHook` with
  kwargs filtering, error isolation, aggregators (`firstBlock`, `firstString`, context join);
  system-prompt-section API as follow-on.
- **P2 — Shell hooks**: config parser (js-yaml), allowlist file read/write, Rust `hook_spawn`,
  `evaluateResult` parity (fail-open/fail-closed/exit-2/matcher/timeout), `reRegisterConfigHooks`.
- **P3 — Gateway hooks**: `GatewayHookRegistry` (HOOK.yaml + `hook.ts` discovery, wildcard
  `command:*`, `emit`/`emitCollect`, error isolation); decide gateway-only scope for desktop.
- **P4 — Outbound webhooks**: target parser, bounded queue + async worker, Web Crypto HMAC,
  delivery policy (retry once, 4xx no-retry, no redirects, timeout clamp), test-delivery hook.
- **P5 — Settings UI + CLI parity**: `settings.tsx` Hooks section; `use-hooks` /
  `use-shell-hooks` / `use-outbound-webhooks`; Rust commands `hooks_list`/`hooks_test`/
  `hooks_revoke`/`hooks_doctor` (or TS-side equivalents calling `packages/hooks`).
- **P6 — WS removal**: switch UI to in-process bus; delete `gateway-client.ts`/`ws_proxy.rs`
  paths; freeze + document the API surface from §7.

## 9. Risks & open questions

1. **`handler.py` → `hook.ts` is a breaking user contract.** Existing gateway hooks are Python
   files; they cannot run in TS. Open question: accept `handler.ts`/`handler.js` only, or keep a
   Python subprocess shim (contradicts the no-Python end state)? Recommend hook.ts with a
   documented migration path; the desktop may not need gateway hooks at all if messaging
   platform adapters are out of scope (see 5).
2. **Python plugins → TS plugin contract undefined.** No kimi-code equivalent for
   `plugin.yaml` + `register(ctx)`; must define `PluginContext` surface (registerHook,
   registerTool, registerSystemPromptSection) before P1.
3. **Tauri webview has no Node**: shell-hook subprocesses and (if CORS blocks fetch) outbound
   HTTP must go through Rust IPC. `pre_llm_call` stdin can be large (`conversation_history`) —
   open question: Tauri IPC payload limits / streaming stdin; may need a payload cap or a Rust-
   side reader.
4. **Web Crypto HMAC is async** — sign inside the queue worker (before enqueue of the bytes),
   never on the invoke path; matches Python's "never block the loop" rule.
5. **Gateway-only hooks**: Python gateway hooks fire for messaging platforms (Telegram/Discord/
   Slack/WhatsApp/Teams). Desktop standalone may not run those adapters; decide whether
   `gateway:startup`, `agent:*`, `command:*` map onto the in-process runtime events or are
   documented as N/A.
6. **Consent model has no TTY in desktop**: `--accept-hooks`/`HERMES_ACCEPT_HOOKS` don't exist
   in a GUI; must build an inline consent dialog and honor `hooks_auto_accept: true`; mtime-drift
   warning needs a UI surface (or reuse the doctor panel).
7. **No TS equivalent found for outbound webhooks** (kimi-code has no webhook client) — the
   dispatcher is built from scratch; keep the GitHub-style signature exactly so receivers'
   existing verification code works.
8. **Scope trap**: `tests/gateway/test_webhook_*.py` + `test_webhook_cli.py` are the **inbound**
   webhook platform (separate plan `webhooks-platform`); do not reuse them as outbound parity
   tests.

## 10. Test strategy

Vitest unit tests (in `packages/hooks/__tests__/` and `web/src/hooks/*.test.ts`), mirroring the
Python parity files:

| Python parity source | TS test |
|---|---|
| `tests/gateway/test_hooks.py` | `hook-registry.test.ts` — discovery, skip-no-events, wildcard, async/sync handler, error isolation, `emitCollect` returns |
| `tests/test_transform_llm_output_hook.py` + `tests/test_transform_tool_result_hook.py` | `plugin-hooks-transform.test.ts` — first non-empty string wins, empty-string rules, exception isolation, kwarg payload shape, post_tool_call stays observational, transform order |
| `tests/agent/test_shell_hooks.py`, `test_shell_hooks_consent.py`, `test_shell_hooks_tree_kill.py` | `shell-hooks.test.ts` — payload schema, matcher regex, exit-2 block, fail-closed matrix, timeout/tree-kill (Rust integration), allowlist write/read, idempotent registration |
| `tests/hermes_cli/test_hooks_cli.py` | `hooks-cli.test.ts` — list consent status, synthetic payload shape, revoke, doctor mtime drift |
| `tests/agent/test_outbound_webhooks.py` | `outbound-webhooks.test.ts` — config parse/clamp, matcher gate, payload shape + delivery_id/timestamp, HMAC verify (Web Crypto), retry/4xx/redirect/queue-bounds — against a local `http.createServer` (Python uses `HTTPServer`) |

Integration: Rust `tests/` for `hook_spawn` with `wiremock`/`tempfile` (per `AGENTS.md` test
conventions: no real network, no fixed paths; `#[serial_test::serial]` for env-dependent tests).
Playwright E2E: settings Hooks section — create shell hook, consent dialog, `hooks test` output,
outbound target CRUD + "test delivery" against a local fake receiver. Parity check script:
run the same fixture payloads through Python `run_once` and TS `runHook` and diff the parsed
directive, for each event in `_DEFAULT_PAYLOADS`.

## 11. Reference links

- Core: `gateway/hooks.py`, `gateway/builtin_hooks/__init__.py`, `hermes_cli/plugins.py`,
  `hermes_cli/hooks.py`, `agent/shell_hooks.py`, `agent/outbound_webhooks.py`,
  `plugins/plugin_utils.py`, `hermes_cli/_subprocess_compat.py`
- Docs: `website/docs/user-guide/features/hooks.md`
- Tests: `tests/gateway/test_hooks.py`, `tests/agent/test_shell_hooks*.py`,
  `tests/agent/test_outbound_webhooks.py`, `tests/hermes_cli/test_hooks_cli.py`,
  `tests/test_transform_llm_output_hook.py`, `tests/test_transform_tool_result_hook.py`,
  `tests/cli/test_cli_extension_hooks.py` (TUI hooks — out of scope note)
- kimi-code TS: `packages/agent-core/src/session/hooks/{types,engine,runner,user-prompt,index}.ts`,
  `packages/agent-core/src/services/event/eventService.ts`,
  `packages/agent-core/src/agent/turn/index.ts`,
  `packages/agent-core/src/agent/permission/policies/pre-tool-call-hook.ts`,
  `packages/agent-core/package.json` (js-yaml ^4.1.1, undici ^7.27.1, zod ^4.3.6),
  `packages/kap-server/src/middleware/{auth,rateLimit}.ts`
- Desktop: `web/src/routes/settings.tsx`, `web/src/hooks/use-gateway.ts`, `web/src/hooks/use-cron.ts`,
  `web/src/lib/transport.ts`, `web/src/lib/gateway-client.ts`, `web/src/lib/connection-auth-events.ts`,
  `src/commands/notify.rs`, `src/commands/terminal.rs`, `src/commands/api_proxy.rs`,
  `src/commands/mod.rs`, `docs/desktop-prd/01-prd.md` (D4 webhooks-cut decision),
  `plans/_INDEX.md` (event-hooks #35, webhooks-platform #94)
