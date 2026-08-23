# Slash Commands — Python → TypeScript Rewrite Plan

## 1. Summary

Feature: the **central slash-command dispatcher** shared by CLI and messaging — a single
`COMMAND_REGISTRY` that drives parsing, prefix matching, autocomplete, busy-mode semantics,
and per-surface availability for commands like `/new`, `/model`, `/personality`, `/compress`,
`/skills`, `/plugins`, `/goal`, `/moa`, `/council`, `/heartbeat`, `/handoff`, `/egress`,
`/browser`, `/paste`, `/voice`, `/wake`, `/yolo`, `/approvals`, `/insights`, `/suggestions`,
`/blueprint`, `/curator`, `/kanban`, `/reload-mcp` (full list in
`D:/hermes-agent-cn/website/docs/reference/slash-commands.md`).

Today all slash semantics live in Python: `hermes_cli/commands.py` is the single source of
truth, `cli.py` implements REPL prefix matching, `gateway/run.py` + `gateway/slash_commands.py`
implement the messaging surface and busy (Guard-1/Guard-2) dispatch, and the TUI gateway
exposes `command.dispatch`, `command.resolve`, `commands.catalog`, `complete.slash` over WS
JSON-RPC — which is what the Desktop app calls today (`web/src/hooks/use-gateway.ts`).

Target: a pure-TypeScript **in-process slash-command engine** inside `web/src` that (a) **freezes
the WS `command.dispatch` contract** so the migration is staged, (b) **ports the registry +
prefix matching + busy-mode semantics** into TS with parity tests, and (c) classifies every
command as **local-now** vs **backend-until-its-feature-plan-lands**. The Desktop keeps a thin
`command.dispatch` transport during migration; as each feature plan (session-lifecycle,
context-compression, model-switching, skills, plugins, mcp, …) lands, its commands flip to local
handlers and the WS path shrinks until it can be deleted.

## 2. Current Python implementation

Source of truth files (all under `D:/hermes-agent-cn`):

- **`hermes_cli/commands.py`** — `@dataclass(frozen=True) CommandDef`: `name`, `description`,
  `category`, `aliases`, `args_hint`, `subcommands`, `cli_only`, `gateway_only`,
  `gateway_config_gate`, `busy_policy` ∈ {`dispatch`, `reject`, `interrupt_then_dispatch`},
  `busy_handler` (special mid-run handler key), `execute` (string key into
  `hermes_cli.slash_exec.EXECUTORS`). `COMMAND_REGISTRY` is a flat list of ~80 `CommandDef`
  grouped by category comment blocks (Session / Configuration / Tools & Skills / Info / Exit).
  Derived lookups rebuilt at import: `_COMMAND_LOOKUP` (name+alias → def),
  `resolve_command(name)` (lowercase + `lstrip("/")`), `COMMANDS` (flat dict), `SUBCOMMANDS`
  (explicit + pipe-hint extraction via `_PIPE_SUBS_RE`), `GATEWAY_KNOWN_COMMANDS`,
  `ACTIVE_SESSION_BYPASS_COMMANDS`, `is_interrupt_then_dispatch`,
  `should_bypass_active_session` (any resolvable slash command bypasses the message queue),
  `_resolve_config_gates` (config-gated commands like `/verbose`, `/skills`),
  `gateway_help_lines()`, plugin commands via lazy `_iter_plugin_command_entries()`, Telegram
  menu helpers (`telegram_bot_commands`, 32-char sanitize, priority menu).
- **`cli.py`** — `HermesCLI.process_command` (line ~10184): alias resolution → pre-command
  plugin hook → canonical dispatch → skill-command dispatch (`skill_commands`,
  `skill_bundles`, stacked skills) → **prefix matching** (line ~10886): `all_known =
  COMMANDS ∪ skill_commands ∪ skill_bundles`; `matches = [c for c in all_known if
  c.startswith(typed_base)]`; if >1 prefer exact match, else prefer **unique shortest match**
  (`/qui` → `/quit` wins over `/quint-pipeline`); exactly 1 → expand to full name and redispatch
  preserving args; >1 → `Ambiguous command … Did you mean …`; 0 → `Unknown command`.
  Path guard `_is_leading_slash_command_like` (first whitespace-delimited word must not contain
  a second `/`) so pasted paths like `/Users/foo.md` are prompts, not commands.
- **`hermes_cli/slash_exec.py`** — registry-owned thin-slice execution: `CommandContext`
  (`surface`, `args`, `options`, `config_get`), `CommandReply` (`text`, `data`, `format`),
  `EXECUTORS = {version, egress, profile, bundles, gateway_help, gateway_commands}`,
  `run_execute`/`execute_command`. Invariant (tested): output depends only on `args`/`options`,
  never `surface` — surfaces apply only their own decoration.
- **`gateway/slash_commands.py`** (+ `gateway/run.py`) — `GatewaySlashCommandsMixin` with
  `_handle_*_command` handlers (reset, stop, model, queue, steer, goal, …); Guard 1 routes
  `interrupt_then_dispatch` commands through cancel-handoff; Guard 2
  `_dispatch_busy_slash_command` implements `busy_policy` + per-command `busy_handler` table
  (start/new/stop/queue/steer/goal/model/moa/egress/…).
- **`tui_gateway/methods_tools.py`** — the WS RPC surface the Desktop consumes:
  - `commands.catalog` — registry-backed metadata: `pairs` (all `/cmd` + description), `canon`
    (alias → canonical map), `categories`, `sub`, `skills`, `skill_count`, `warning`;
    hides `_TUI_HIDDEN` and `gateway_only` commands, merges `_TUI_EXTRA`, `quick_commands`.
  - `command.resolve` — `{canonical, description, category}` or error 4011 unknown.
  - `command.dispatch` — params `{session_id, name, arg}`; quick_commands (exec/alias), plugin
    handlers, skill bundles (`{type:"send", message, notice, display}`), skill commands
    (`{type:"skill", message, name, display}`), then /queue (type send), /learn, /init, /moa,
    /focus, /retry, … — returns `_ok` with a **loose** result `{type, message, output, name,
    target, notice, display}` or `_err(rid, code, msg)` (4xxx param/state, 5xxx internal).
  - `slash.exec` — busy-gated idle-only worker; skill/bundle/pending-input commands reroute to
    `command.dispatch`.
- **`tui_gateway/methods_complete.py` + `slash_fuzzy.py`** — `complete.slash` returns
  `{items:[{text, display, meta, kind:"command"|"skill"}], replace_from?}` using
  prompt_toolkit `SlashCommandCompleter` + description-aware fuzzy tiers (exact 0, prefix 1,
  substring 2, description words 3+, lower wins; `slash_fuzzy.py` is itself a port of
  grok-cli's TS fuzzyScore). `complete.path` for path arguments.
- **Docs** — `website/docs/reference/slash-commands.md`: full command list, permissions split
  (`allow_admin_from` / `user_allowed_commands`, always-allowed `/help`+`/whoami`), CLI vs
  messaging surface notes. Not needed for desktop standalone (no messaging users), but the
  registry fields (`gateway_only`, `cli_only`) document surface availability.

Command → effect map (subset the plan must classify):

| Command | Category | Busy policy | Surface | Effect |
|---|---|---|---|---|
| `/new` `/reset [name] [now]` | Session | interrupt_then_dispatch | both | rotate session id + history |
| `/compress [here N\|topic]` | Session | (backend 4009 while running) | both | manual compaction |
| `/model` | Config | reject (busy_handler model) | both | session/global model switch |
| `/personality` | Config | reject | both | personality overlay |
| `/goal` / `/subgoal` | Session | dispatch (busy_handler goal) | both | persistent goal loop |
| `/heartbeat` | Session | dispatch | both | session-scoped recurring prompt |
| `/moa` `/council` | Session | reject | both | one-shot model ensemble |
| `/skills` | Tools & Skills | — | cli+config gate | skill search/install/manage |
| `/plugins` | Tools & Skills | — | cli_only | plugin list/status |
| `/yolo` `/approvals` | Config | dispatch | both | approval-mode toggle |
| `/egress` | Session | dispatch (execute=egress) | both | Docker egress status |
| `/handoff` | Session | — | cli_only | hand session to messaging (out of scope) |
| `/paste` `/voice` `/wake` `/browser` | Info/Config | — | cli_only | clipboard / voice / wake-word / browser CDP |
| `/insights` `/suggestions` `/blueprint` `/curator` `/kanban` | Info/Tools | — | both/cli | analytics / automation helpers / board |
| `/reload-mcp` | Tools & Skills | — | both | reload MCP servers from config |

## 3. Target TypeScript design

Module layout (all under `D:/Hermes-CN-Desktop/web/src/lib/slash-commands/`):

- `types.ts` — `CommandDef` TS interface mirroring the Python dataclass:
  ```ts
  export type BusyPolicy = "dispatch" | "reject" | "interrupt_then_dispatch";
  export interface CommandDef {
    name: string;                    // canonical, no slash
    description: string;
    category: "Session" | "Configuration" | "Tools & Skills" | "Info" | "Exit";
    aliases?: readonly string[];
    argsHint?: string;
    subcommands?: readonly string[];
    cliOnly?: boolean;               // Desktop = local-UI only, never backend
    gatewayOnly?: boolean;           // messaging-only → hidden on desktop
    busyPolicy?: BusyPolicy;         // default "reject"
    busyHandler?: string;            // key into BUSY_HANDLERS
    execute?: ExecutorKey;           // key into EXECUTORS (local thin-slice)
    local?: LocalHandlerKey;         // NEW: key into LOCAL_HANDLERS (desktop-native)
    backendUntil?: string;           // NEW: feature plan slug that owns this command
  }
  export interface CommandResult {   // superset of the frozen WS contract (see §4)
    type: "exec" | "send" | "skill" | "plugin" | "alias" | "notice" | "navigate";
    message?: string; output?: string; name?: string; target?: string;
    notice?: string; display?: string; error?: { code: number; message: string };
  }
  ```
- `registry.ts` — `COMMAND_REGISTRY: readonly CommandDef[]` (hand-ported from
  `hermes_cli/commands.py`, only non-`gateway_only` desktop-relevant entries; keep
  `cliOnly`/`gatewayOnly` markers), plus `_COMMAND_LOOKUP` map, `resolveCommand(name)`
  (case-insensitive, lstrip `/`), `resolveAlias`, `SUBCOMMANDS`, `gatewayHelpLines()`.
- `parse.ts` — `parseSlashInput(text): {name,args}|null`: port of
  `composer-skills.parseLeadingSlashCommand` aligned with kimi-code `parse.ts` (reject a name
  containing `/` unless it is namespaced `plugin:name`; desktop keeps the `/skill <name>`
  namespace from `composer-skills.ts` — registry resolution treats that as a `skill` intent).
- `resolve.ts` — `resolveSlashInput({input, skillNames, bundleKeys, pluginCommands,
  isBusy, isCompacting}): SlashIntent` where
  `SlashIntent = builtin | skill | bundle | plugin-command | local | backend | blocked |
  invalid | message` — port of `cli.py` prefix matching + kimi-code `resolve.ts` availability:
  1. exact `resolveCommand` (name/alias) → builtin;
  2. skill namespace (`/skill <name>`) and bare skill/bundle keys → skill/bundle;
  3. plugin namespaced (`pluginId:name` or quick_commands alias) → plugin;
  4. **prefix matching** (when the token is not exact): candidates =
     registry names+aliases ∪ skills ∪ bundles; prefer exact, then **unique shortest**;
     exactly 1 → expand and resolve; >1 → `ambiguous` (suggest list); 0 → `unknown`;
  5. busy gate: apply `busyPolicy` (reject → `blocked`; dispatch → run; interrupt →
     cancel then run) — mirror `should_bypass_active_session` (recognized commands never go
     to the plain-message queue).
- `runner.ts` — `class SlashCommandRunner { dispatch(name,args,ctx): Promise<CommandResult> }`
  with `LOCAL_HANDLERS` (desktop-native: `compress` → existing `session.compress` RPC wrapper;
  navigation/`navigate`; `version`/`profile`/`egress`/`help`/`commands` thin-slice executors)
  and a `backend` fallback that calls the frozen `command.dispatch` RPC through
  `use-gateway.ts` `dispatchCommand`. `BUSY_HANDLERS` maps `busyHandler` keys to the
  desktop equivalents (queue → `stores/composer-queue.ts` enqueue; steer → inject-after-tool;
  stop/new → `cancel()` + session rotation).
- `executors.ts` — port of `slash_exec.EXECUTORS` (surface-invariant `CommandContext` →
  `CommandReply`); used by both local rendering and (during migration) to normalize backend
  `command.dispatch` output.
- `completions.ts` — port of `complete.slash`: prefix filter + `slash_fuzzy.py` tier scoring
  (exact 0 / prefix 1 / substring 2 / description 3+), `kind: "command"|"skill"|"bundle"`,
  subcommand completion from `argsHint`/`subcommands` (kimi-code `complete-args.ts` pattern).
- `index.ts` — public facade consumed by composer + submit paths (see §6).

Data flow (target): composer input → `parseSlashInput` → `resolveSlashInput` (registry + busy
gate) → `SlashCommandRunner.dispatch` → local handler mutating in-process stores/atoms, or
backend fallback via `command.dispatch` → `CommandResult` → composer/submit path. No WS round
trip for local commands; backend fallback uses the same `CommandResult` shape.

## 4. Data models & persistence

- **Registry is code, not data**: `COMMAND_REGISTRY` is a static TS array (single source of
  truth for names/aliases/categories/args/subcommands/busy policy/availability). No SQLite
  table. Rebuild derived maps at module load exactly like `_build_command_lookup()`.
- **Dynamic layers** (in-memory, refreshed like today's `useSkills`/`usePlugins` queries):
  `skillCommands: Map<string, SkillInfo>` (from `commands.catalog` today, from the in-process
  skill store after `plans/skills-system.md`), `bundleKeys: Set<string>`,
  `pluginCommands: Map<string, {body,description}>` (kimi-code `plugin-commands.ts` shape),
  `quickCommands` (user config). Merged into the resolver universe for prefix matching.
- **Persistence**: none new. Config-gated availability (`gateway_config_gate` for `/verbose`,
  `/skills`; `display.busy_input_mode` from `test_busy_input_mode_command.py`) reads through
  the existing config layer (`web/src/hooks/use-config.ts`, `lib/config-update.ts`).
  `quick_commands`/`user_allowed_commands` stay in backend `config.yaml` until a config-store
  plan lands — read via `commands.catalog.warning`/REST.
- **WS contract freeze** (`packages/protocol/src/hermes-api.ts`): upgrade the loose
  `CommandDispatchResult` (`{type?,message?,name?,output?,target?}` passthrough) to a strict
  discriminated union:
  ```ts
  export const CommandDispatchParams = z.object({ session_id: z.string(), name: z.string(), arg: z.string() });
  export const CommandDispatchResult = z.discriminatedUnion("type", [
    z.object({ type: z.literal("exec"), output: z.string() }),
    z.object({ type: z.literal("send"), message: z.string(), notice: z.string().optional() }),
    z.object({ type: z.literal("skill"), message: z.string(), name: z.string().optional(), display: z.string().optional() }),
    z.object({ type: z.literal("plugin"), output: z.string() }),
    z.object({ type: z.literal("alias"), target: z.string() }),
    z.object({ type: z.literal("navigate"), to: z.string() }),          // desktop-local only
  ]).passthrough();
  ```
  Freeze also `command.resolve`, `commands.catalog`, `complete.slash`, `complete.path`
  request/response shapes (they already have Zod items; add `catalog` schema). Core
  `_err(rid, code, msg)` envelope maps to `CommandResult.error {code,message}`.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / plan |
|---|---|---|
| `prompt_toolkit` (Completer, AutoSuggest, Document) | **From scratch**: small `completions.ts` prefix + fuzzy scorer; kimi-code's terminal completer uses `@moonshot-ai/pi-tui` `AutocompleteItem`/`SlashCommand` (`apps/kimi-code/src/tui/commands/registry.ts`, `complete-args.ts`) — pi-tui is terminal-oriented, not React; only the item shape is reused. `slash_fuzzy.py` itself is a port of grok-cli TS fuzzyScore, so the algorithm is TS-native | Implement tiers: exact 0, prefix 1, substring 2, description-word 3+ |
| `Rich` (CLI markup/columns) | None needed — desktop renders `CommandReply.text` as markdown via existing `components/chat/markdown-renderer.tsx`; keep `format: "plain"\|"markdown"` hint | executors emit plain canonical text |
| `shlex` (arg parsing in handlers) | Simple whitespace split; `CommandContext.args` stays the raw string; each local handler re-parses like Core | kimi-code passes raw `args` string through `ParsedSlashInput` (`types.ts`) |
| `agent/i18n` `t()` (help/commands strings) | Desktop zh-first translation maps following `lib/config-translations.ts` / `lib/skill-translations.ts` pattern; new `slash-commands/i18n.ts` | No npm i18n lib needed |
| Python dataclasses / frozensets | TS interfaces + `ReadonlyMap`/`Set`; derive `SUBCOMMANDS` from explicit `subcommands` + pipe-hint regex | direct port of `_PIPE_SUBS_RE` |
| (none for prefix matching — pure stdlib) | `resolve.ts` from scratch | port of `cli.py` algorithm + kimi-code `resolve.ts` availability gate |

**No TS equivalent found risks**: (1) prompt_toolkit's document-model autocomplete (caret-aware
inline completion in a terminal) has no React counterpart — the desktop composer already owns
caret tracking (`composer-skills.ts` `LeadingSlashToken`), so we reuse that instead of
porting prompt_toolkit; (2) Rich's full terminal layout is CLI-only and out of scope for the
desktop standalone; (3) Core's `_pending_input` queue mechanic is REPL-internal — the desktop
uses `stores/composer-queue.ts` + `useQueuedPrompts`, so `/queue` maps to that rather than a
Python port.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **`web/src/lib/builtin-commands.ts` (READ — today's de-facto desktop registry)**: currently
  only `/compress` (+ alias `/compact`) plus the `/skill` namespace; keep its public API
  (`isBuiltinComposerCommandToken`, `parseBuiltinComposerCommand`, `filterComposerCommands`,
  `ComposerCommandCandidate`) as a thin re-export over the new central registry so
  `goose-composer.tsx` and its tests do not break; the internal `BUILTIN_ALIASES`/`CommandSpec`
  tables are replaced by `COMMAND_REGISTRY` filtered to `local` handlers.
- **`web/src/lib/composer-skills.ts`** — parser stays (`parseLeadingSlashCommand`,
  `resolveComposerSkillCommand`, `/skill` namespace); `resolve.ts` consumes it for the
  `skill` intent instead of hard-coding in submit paths.
- **`web/src/hooks/use-gateway.ts`** — `dispatchCommand(sessionId, name, arg)` becomes the
  **backend transport** implementation of `SlashCommandRunner`; freeze its request to
  `{session_id, name, arg}` and parse with the new strict `CommandDispatchResult`.
  `completeSlash`/`completePath` remain backend RPCs during migration and become optional once
  `completions.ts` + in-process skill store land.
- **`web/src/routes/detail.tsx` + `web/src/hooks/use-create-and-send-session.ts`** — replace the
  ad-hoc `resolveComposerSkillCommand` → `dispatchCommand` special case and
  `parseBuiltinComposerCommand("/compress")` branch with one call to
  `SlashCommandRunner.dispatch`; the runner returns `{type:"skill", message}` → `transportText`
  (existing pattern), `{type:"exec", output}` → notice/transcript, `{type:"navigate"}` →
  router.
- **Busy handling** — `detail.tsx` currently queues *all* input when `runtimeIsBusy`; Core
  semantics (`should_bypass_active_session`) say recognized slash commands must NOT be queued —
  they dispatch under their `busyPolicy` (reject with a busy message, dispatch, or interrupt).
  `onSend` must call `resolveSlashInput` before the queue check and route slash intents to the
  runner.
- **Composer palette** — `goose-composer.tsx` `slashToken`/`builtinSlash`/`skillToken` wiring
  switches from `builtin-commands.ts` tables to `registry.ts` + `completions.ts`
  (categories, subcommand hints, `/skill` namespace preserved).
- **`web/src/lib/command-palette.ts`** — the Ctrl+K palette stays navigation-only; its
  `keywords` entries already mirror several slash names (`/history`, `/skills`, `/models`,
  `/kanban`, …). Optionally add a "slash command" group that executes local commands (e.g.
  `/compress`) via the runner — non-goal for this plan, listed as follow-up.
- **Rust** — none required for this plan; OS-only commands (`/paste`, `/voice`, `/wake`,
  `/browser`, `/terminal`) remain backend/cli_only until their own feature plans
  (`vision-image-paste.md`, `voice-mode.md`, `wake-word.md`, `browser-automation.md`) add
  Tauri IPC.

## 7. Removing the WebSocket dependency (migration path)

Phased, with the **RPC surface frozen first**:

- **Phase 0 — freeze + mirror**: pin `command.dispatch` params/result (strict Zod union, §4),
  `command.resolve`, `commands.catalog`, `complete.slash`, `complete.path`; write parity tests
  against the live backend. Port `COMMAND_REGISTRY` + parser + prefix resolver + busy resolver
  as pure TS (no I/O) — backend remains authoritative for execution.
- **Phase 1 — local-first dispatcher**: introduce `SlashCommandRunner` behind the same
  `dispatch(name,args,ctx)` interface. Local handlers land first where Desktop already owns the
  data: `compress` (existing `session.compress` RPC wrapper in `use-gateway.ts` +
  `runManualCompress` in `detail.tsx`), `version`/`profile`/`egress`/`help`/`commands`
  (thin-slice executors backed by build-info/status REST data), navigation commands. Everything
  else falls through to backend `command.dispatch` unchanged. Busy semantics enforced
  client-side (fix the queue bypass mismatch).
- **Phase 2 — flip per feature plan**: as `plans/session-lifecycle.md` (new/clear/resume/
  sessions/title/branch/retry/undo/stop/queue/steer), `context-compression-prompt-caching.md`
  (compress), `model-switching.md` (model), `personality-soul.md` (personality),
  `goals-ralph-loop.md` (goal/subgoal), `session-heartbeat.md` (heartbeat),
  `mixture-of-agents.md` (moa/council), `skills-system.md` + `skills-slash-commands-stacking.md`
  (skills/bundles), `plugins.md` (plugins/reload-skills), `mcp.md` (reload-mcp),
  `reasoning-fast-approvals-yolo.md` (yolo/approvals/reasoning/fast), `observability.md`
  (insights/usage), `cron-scheduled-tasks.md` + `automation-helpers.md` (cron/suggestions/
  blueprint), `curator.md`, `kanban-multi-agent-board.md`, `egress-proxy-secrets-import.md`
  (egress), `voice-mode.md`/`wake-word.md`/`vision-image-paste.md`/`browser-automation.md`
  (voice/wake/paste/browser) land, flip their `backendUntil` marker → local handler and delete
  the `command.dispatch` fallback for that name. `/handoff`, `/export`, `/import`, `/skin`,
  `/pet`, `/subscription`, `/topup`, `/platforms`, `/platform`, `/copy`, `/image`, `/debug`,
  `/config`, `/tools`, `/toolsets`, `/cron`, `/journey`, `/redraw`, `/indicator`,
  `/statusbar`, `/battery`, `/timestamps`, `/verbose`, `/focus`, `/footer` are marked
  `cli_only`/out-of-scope for the desktop standalone and recorded as such (README rule).
- **Phase 3 — delete WS**: when every desktop-relevant command is local, remove
  `command.dispatch`/`complete.slash`/`commands.catalog` from `gateway-client.ts` transport and
  eventually the WS link itself (end-state per plans/README). The frozen RPC surface is the
  seam that makes each flip safe.

## 8. Migration phases & task breakdown

1. **Registry parity** — port `CommandDef` + full `COMMAND_REGISTRY` (desktop-relevant slice,
   ~60 commands) + derived lookups; vitest mirroring `test_commands_execute.py` (every
   `execute`/`local` key resolves; surface-invariant text).
2. **Parser + resolver parity** — `parse.ts`, `resolve.ts`; vitest mirroring
   `test_cli_prefix_matching.py` (unique prefix, ambiguous, shortest-match, exact-wins,
   skill-prefix, path guard) + kimi-code resolve availability cases.
3. **Protocol freeze** — Zod discriminated union for `CommandDispatchResult`; params schema;
   `commands.catalog` schema; backend contract test (RPC against managed runtime in e2e).
4. **Runner shell + local handlers** — `runner.ts`, `executors.ts`, local handlers for
   compress/version/profile/egress/help/commands/navigate; backend fallback wired to
   `dispatchCommand`; busy-policy enforcement in `detail.tsx`/`use-create-and-send-session.ts`.
5. **Composer integration** — `builtin-commands.ts` re-export over registry; `goose-composer.tsx`
   palette + submit switch to runner; `completions.ts` fuzzy port.
6. **Feature flips** — one PR per owning feature plan flipping `backendUntil` → `local` (see §7
   Phase 2), each with its own parity tests.
7. **WS teardown** — drop RPCs from transport; delete WS dependency (end-state).

## 9. Risks & open questions

- **Contract looseness**: Core `command.dispatch` returns many shapes (`exec`, `send`, `skill`,
  `plugin`, `alias`, bundles with `notice`+`display`) with no strict schema; freezing it
  requires a Core-side audit of `tui_gateway/methods_tools.py` handlers before TS can rely on a
  discriminated union — do this in Phase 0 with e2e coverage, not assumption.
- **Busy mismatch**: desktop queues all input while busy; Core never queues recognized slash
  commands (`should_bypass_active_session`). Porting the policy changes user-visible behavior
  (mid-run `/model` currently would be silently queued/erased in the Desktop) — high priority
  parity fix.
- **Naming divergence**: Core exposes skills as bare `/<skill>` (and bundles `/<slug>`),
  kimi-code uses `skill:<name>` (and `pluginId:name`), Desktop uses the `/skill <name>`
  namespace. Registry must map all three intents without shadowing builtins; the
  `/q` alias is `/queue` in Core but exit in kimi-code — copy Core, not kimi-code.
- **No TS equivalent found**: prompt_toolkit completion engine (from-scratch `completions.ts`,
  kimi-code only proves the pi-tui item shape); Rich CLI markup (skip — markdown renderer);
  `_pending_input` REPL queue (map to `stores/composer-queue.ts`).
- **Dynamic layers offline**: skills/bundles/plugins/quick-commands come from the backend
  catalog today; until `skills-system.md`/`plugins.md` land, prefix matching against dynamic
  commands is unavailable when WS is down — document as a known offline gap.
- **Open questions**: (a) should `/command` unknown tokens become an error notice or a plain
  prompt on Desktop? Core CLI errors, kimi-code sends as message, Core gateway treats unknown
  as message — pick per-surface; (b) keep the `/skill` namespace or migrate to bare
  `/<skill>` for full Core parity? (c) `test_chat_q_exit_clear.py` covers the CLI `-q` flag
  (single-query exit summary), not slash `/q` — no desktop equivalent; do not port as a slash
  test, but preserve the `/q`→`/queue` alias mapping.

## 10. Test strategy

- **Vitest unit (parity with Core)**:
  - `registry.test.ts` — mirror `tests/hermes_cli/test_commands_execute.py` invariants
    (executor/local keys exist; unmigrated commands have none) + alias/`resolveCommand`
    case-insensitivity + `SUBCOMMANDS` pipe-hint extraction.
  - `resolve.test.ts` — mirror `tests/cli/test_cli_prefix_matching.py`:
    `/con`→config unique prefix; `/re` ambiguous suggestions; `/test-skill-xy` skill prefix;
    `/qui` shortest-match over `/quint-pipeline`; tied-shortest ambiguous; exact name wins;
    pasted-path guard.
  - `busy.test.ts` — mirror `tests/cli/test_busy_input_mode_command.py`: registry contains
    `busy` with `args_hint "[queue|steer|interrupt|status]"` + category Configuration; busy
    policy mapping (reject → blocked, dispatch → run, interrupt → cancel-then-run);
    recognized slash commands bypass the composer queue.
  - `completions.test.ts` — fuzzy tiers vs `tui_gateway/slash_fuzzy.py` golden cases
    (description-word match, substring merge, `kind` labels).
  - `executors.test.ts` — surface-invariant text for fixed `CommandContext` (mirror
    `test_commands_execute.py` SURFACES loop).
- **Integration**: protocol Zod parse tests for the frozen `command.dispatch` union;
  `use-gateway.ts` `dispatchCommand` unit with mocked `GatewayClient`.
- **Playwright E2E**: composer `/` palette (exact/prefix/subcommand ranking), `/compress`
  local execution, `/skill <name>` backend dispatch producing `transportText`, busy-state
  command handling (reject vs queue), backend `commands.catalog` hydration.
- **Backend parity harness** (optional, e2e only): run the same `resolveSlashInput` corpus
  against live `complete.slash`/`command.dispatch` and assert intent agreement — the frozen
  contract is the assertion target.

## 11. Reference links

- Core: `D:/hermes-agent-cn/hermes_cli/commands.py`, `hermes_cli/slash_exec.py`, `cli.py`
  (process_command ~10184, prefix block ~10886), `gateway/run.py`, `gateway/slash_commands.py`,
  `tui_gateway/methods_tools.py`, `tui_gateway/methods_complete.py`, `tui_gateway/slash_fuzzy.py`,
  `website/docs/reference/slash-commands.md`
- Core tests: `tests/cli/test_cli_prefix_matching.py`, `tests/cli/test_busy_input_mode_command.py`,
  `tests/cli/test_chat_q_exit_clear.py` (CLI `-q` flag — N/A for desktop), `tests/hermes_cli/test_commands_execute.py`
- kimi-code TS: `packages/acp-server/src/slash.ts`, `apps/kimi-code/src/tui/commands/{registry,dispatch,resolve,parse,types,skills,plugin-commands,complete-args}.ts`
- Desktop: `web/src/lib/builtin-commands.ts`, `web/src/lib/composer-skills.ts`,
  `web/src/lib/command-palette.ts`, `web/src/hooks/use-gateway.ts`,
  `web/src/routes/detail.tsx`, `web/src/hooks/use-create-and-send-session.ts`,
  `web/src/components/chat/goose-composer.tsx`, `packages/protocol/src/hermes-api.ts`
- Sibling plans: `plans/session-lifecycle.md`, `plans/context-compression-prompt-caching.md`,
  `plans/skills-system.md`, `plans/skills-slash-commands-stacking.md`, `plans/plugins.md`,
  `plans/model-switching.md`, `plans/goals-ralph-loop.md`, `plans/mixture-of-agents.md`,
  `plans/curator.md`, `plans/kanban-multi-agent-board.md`, `plans/mcp.md`
