# TUI — Python → TypeScript Rewrite Plan

## 1. Summary

The Hermes terminal UI (TUI) is the original full-screen REPL: multi-line
editing, slash-command completion, session history, interrupt redirection,
streaming tool output, focus view, busy indicators, status bar, skins, and a
subagent overlay tree. Unlike most features in this repo, **the Desktop does not
port the TUI pixel-for-pixel — it replaces the terminal with React UI**
(chat composer + message timeline + status bar + subagent panel), and the
embedded xterm.js Console (`web/src/routes/console.tsx`) keeps a *real* terminal
for `hermes` CLI operations.

This plan therefore does two things:
1. Documents the Python TUI (CLI + `tui_gateway` JSON-RPC/SSE/WS transport) and
   the existing TS TUI (`D:/hermes-agent-cn/ui-tui/`, an Ink-based client that
   is itself the closest port source).
2. Maps each TUI feature to its React equivalent, and records **already
   implemented vs missing** in `D:/Hermes-CN-Desktop/web/src`.

The gateway protocol (RPC methods + event names) is the API surface to freeze;
the React UI already consumes it over `/api/ws` (see
`web/src/stores/subagents.ts` header: payload fields verified against
`tui_gateway/server.py` `_on_tool_progress`).

## 2. Current Python implementation

### 2.1 REPL core (`D:/hermes-agent-cn/cli.py`, 886 KB)

- `hermes_cli/` package holds the REPL: `prompt_toolkit`-based input,
  `SlashCommandCompleter` (imported by `tui_gateway/methods_complete.py` from
  `hermes_cli.commands`), `/focus` handler in `hermes_cli/focus_view.py`
  (`FOCUS_CONFIG_KEY`, `FOCUS_STATUSBAR_LABEL`, `effective_tool_progress_mode`,
  `focus_statusbar_segment`), indicator styles in `hermes_constants.py`
  (`INDICATOR_STYLES`, `DEFAULT_INDICATOR_STYLE`), skins via `resolve_skin`
  (`tui_gateway/server.py`).
- Docs: `D:/hermes-agent-cn/README.md` line 21 advertises the TUI feature set;
  `website/docs/user-guide/features/delegation.md` documents the subagent model
  the overlay tree renders.

### 2.2 Gateway (`D:/hermes-agent-cn/tui_gateway/`)

- `entry.py` — stdio dispatch loop (JSON-RPC over stdout; signal/SIGPIPE
  hardening, MCP discovery, sidecar `WsPublisherTransport` via
  `HERMES_TUI_SIDECAR_URL`).
- `server.py` — session registry, `_emit(event, sid, payload)`, busy-submit
  queue, interrupt redirection ("Modes: `interrupt` (default) → redirect the
  live turn…", ~line 7878), focus-view config (~line 11403), `resolve_skin`.
- `transport.py` — `Transport` protocol, `StdioTransport`, `TeeTransport`
  (stdio + WS sidecar).
- `ws.py` / `sse.py` — WebSocket / SSE transports used by the dashboard and
  Desktop over `/api/ws` (the dependency this plan removes).
- Methods split: `methods_prompt.py` (`prompt.submit`, `clipboard.paste`,
  `image.attach*`, `pdf.attach`, `file.attach`, `image.detach`,
  `input.detect_drop`, `prompt.background`, `preview.restart`,
  `clarify.respond`, `terminal.read.respond`), `methods_complete.py`
  (`paste.collapse`, `complete.path`, `complete.slash`, `model.options` /
  `model.save_key` / `model.disconnect`), `methods_session.py`
  (`session.create/list/resume/activate/delete/title/history/undo/compress/
  save/close/branch/interrupt/redirect/steer/status`,
  `subagent.interrupt` (→ `tools.delegate_tool.interrupt_subagent`),
  `subagent.steer`, `delegation.status/pause`, `spawn_tree.save/list/load`),
  `methods_tools.py` (`process.*`, `reload.mcp/env`, `commands.catalog`,
  `cli.exec`, `command.resolve/dispatch`, `slash.exec`, `shell.exec`,
  `tools.list/show/configure`, `toolsets.list`, `skills.manage/reload`,
  `plugins.manage`, `cron.manage`, `browser.manage`), `methods_config.py`
  (`config.get`, `setup.status`, `setup.runtime_check`, `projects.*`).
- `render.py` — Python-side render bridge into `agent.rich_output`
  (`format_response`, `render_diff`, `StreamingRenderer`); returns `None` when
  absent so the TS client falls back to its own `markdown.tsx`.
- `slash_fuzzy.py` — description-aware fuzzy scoring (ported from
  grok-cli `src/ui/slash-menu.ts`; mirrored client-side in
  `ui-tui/src/app/slash/fuzzyScore.ts`).
- `slash_worker.py`, `cli_delegation.py`, `event_publisher.py`,
  `loop_noise.py`, `synthetic_turn.py`, `turn_marker.py`, `method_ctx.py`,
  `compute_host.py`, `host_supervisor.py`, `git_probe.py`, `project_tree.py`.

### 2.3 Event stream (frozen wire surface)

`message.start` / `message.delta` / `message.complete`, `reasoning.delta`,
`thinking.delta`, `tool.start` / `tool.complete` / `tool.generating` /
`tool.output_risk`, `moa.reference/aggregating/phase`, `approval.request`,
`status.update`, `session.info`, `error`, `notification.clear`, `subagent.*`
(spawn_requested / start / thinking / tool / progress / complete),
`gateway.stderr`, `voice.transcript`. Types mirrored in
`ui-tui/src/gatewayTypes.ts`.

## 3. Target TypeScript design

React replaces the terminal screen; the gateway JSON-RPC client shape already
exists in two places to reuse:
- `D:/hermes-agent-cn/ui-tui/src/gatewayClient.ts` + `gatewayTypes.ts`
  (canonical TS protocol, stdio/WS agnostic).
- `D:/Hermes-CN-Desktop/web/src/lib/gateway-client.ts` (WS JSON-RPC) +
  `web/src/lib/transport.ts` (HTTP routing/auth) + `web/src/lib/tauri-bridge.ts`.

Target module layout under `web/src`:

| TUI feature (Python/ink) | React target module |
| --- | --- |
| Multi-line editor (textInput.tsx, lib/editor.ts) | `components/chat/goose-composer.tsx` (+ new `lib/editor-keys.ts`) |
| Slash completion (complete.slash, slash_fuzzy.py) | `lib/composer-skills.ts`, `lib/builtin-commands.ts`, `lib/composer-mentions.ts` |
| Input history (lib/history.ts) | NEW `hooks/useInputHistory.ts` + `lib/input-history.ts` |
| Interrupt redirect (session.interrupt/redirect, subagent.steer) | composer `onStop` + NEW `lib/interrupt.ts` (queue/steer modes) |
| Streaming tool output (message.delta, tool.*, render.py) | `components/chat/message-timeline.tsx`, `markdown-renderer.tsx`, `tool-activity.ts` |
| Focus view (/focus, hermes_cli/focus_view.py) | NEW `components/chat/focus-view-toggle.tsx` + `stores/ui` flag |
| Busy indicators (INDICATOR_STYLES, tui_status_indicator) | `message-skeleton.tsx`, `stall-notice.tsx`, `LoadingIndicator` |
| Status bar (tui_statusbar) | `components/app-shell/app-status-bar.tsx` |
| Skins (/skin, resolve_skin) | `routes/advanced.tsx` ThemeRoute + `@hermes/shared-ui` useTheme |
| Subagent overlay tree (subagentTree.ts, agentsOverlay.tsx) | `components/chat/subagent-panel.tsx` + `stores/subagents.ts` |

Data flow stays: React component → Jotai store → gateway-client → (today) WS to
Python `tui_gateway`; the goal is to swap the WS tail for an in-process runtime
behind the same client interface (section 7).

## 4. Data models & persistence

- **Prompt history**: TUI stores multiline entries in `~/.hermes/.hermes_history`
  (`ui-tui/src/lib/history.ts`, `+`-prefixed lines, cap 1000). React equivalent
  should reuse the same file via Tauri fs commands, or IndexedDB; keep the
  format so switching surfaces shares history.
- **Sessions**: Python persists to SQLite `state.db` (`hermes_sqlite.py`,
  `hermes_state_schema.py`); Desktop already browses sessions via
  `web/src/hooks/use-sessions.ts` + `web/src/routes/history.tsx` (archive/
  delete/pin/rename/export) — reuse, do not duplicate. See separate
  `plans/sqlite-fts5-session-search.md` / `plans/session-lifecycle.md`.
- **Subagent tree**: in-memory event fold (`web/src/stores/subagents.ts`
  `reduceSubagentList`, `buildSubagentTree`, `markUnfinishedInterrupted`;
  `ui-tui/src/lib/subagentTree.ts` for rollups/sparkline). Optional durable
  snapshots already exist server-side: `spawn_tree.save/list/load` RPCs — add
  a React viewer later.
- **Skins**: `HermesSkin` JSON in `@hermes/shared/skin` (`gatewayTypes.ts`
  `GatewaySkin`); desktop theme config persisted via
  `hydrateThemeAtom` / `DEFAULT_THEME_CONFIG` (`web/src/app.tsx`).

## 5. Third-party library strategy (most important)

| Python dependency | TS equivalent (evidence) | Status |
| --- | --- | --- |
| `prompt_toolkit` (Document, SlashCommandCompleter, FormattedText) | No 1:1 lib. kimi-code: `packages/pi-tui/src/autocomplete.ts` (`AutocompleteProvider`, `CombinedAutocompleteProvider` — slash commands + `fd` file path completion, `fuzzyFilter`); `apps/kimi-code/src/tui/commands/complete-args.ts`, `registry.ts`. Core already ported scoring to `ui-tui/src/app/slash/fuzzyScore.ts` + `lib/fuzzy.ts`. Desktop has its own candidate model (`lib/composer-skills.ts`). | port/adapt |
| `rich` / `agent.rich_output` (format_response, StreamingRenderer, render_diff) | `marked` (pi-tui dependency `marked@18.0.5`); kimi `components/media/code-highlight.ts` (`cli-highlight`), `diff-preview.ts`; Core `ui-tui/src/components/streamingMarkdown.tsx`. Desktop `markdown-renderer.tsx` already streams. | implemented (verify diff parity) |
| readline editing (kill-line, kill-to-start, word nav) | kimi `pi-tui`: `kill-ring.ts`, `word-navigation.ts`, `keys.ts`, `keybindings.ts`, `undo-stack.ts`; `EditorComponent` contract in `editor-component.ts`. Core `ui-tui/src/lib/editor.ts` + `textInput.tsx` (grapheme stops, lineNav, killLineStart/End). React `<textarea>` needs a thin keybinding shim. | missing in composer |
| prompt history | kimi `EditorComponent.addToHistory`; Core `ui-tui/src/lib/history.ts`, `hooks/useInputHistory.ts`. | missing in composer |
| interrupt redirection (session.interrupt/redirect, subagent.steer, busy modes) | kimi `editor-keyboard.ts` `onCtrlC` cancel chain + `controllers/queue-pane` (queue); Hermes-specific `BusyInputMode = 'interrupt'\|'queue'\|'steer'` (`ui-tui/src/app/interfaces.ts`) has no kimi counterpart for steer. | partial / from scratch |
| streaming tool output | kimi `controllers/streaming-ui.ts` (delta batching, streaming tool args), `components/messages/tool-call.ts`, `shell-execution.ts`; Core `ui-tui/src/app/turnStore.ts`, `components/streamingAssistant.tsx`; Desktop `tool-activity.ts`, `subagent-panel.tsx` stream lines. | implemented (expand per-tool) |
| focus view | No kimi equivalent found (kimi has no reduced-output mode). Port `focus_view.py` semantics (suppress tool-progress lines, status-bar segment, prompt-cache invariant) from scratch. | missing |
| status bar / indicators | kimi `components/chrome/footer.ts`, `status-panel.tsx`, `usage-panel.tsx`; Desktop `app-status-bar.tsx`. Indicator *styles* (kaomoji etc.) are Hermes-specific (`hermes_constants.INDICATOR_STYLES`). | partial |
| skins | kimi `theme/theme.ts` (singleton + `setPalette`), `colors.ts`, `custom-theme-loader.ts`, `theme-schema.json`; Desktop `/theme` route + shared-ui themes; separate `plans/skins-themes.md`. | partial |
| subagent tree | kimi `components/messages/agent-swarm-progress.tsx`, `controllers/subagent-activity-store.ts`, `subagent-event-handler.ts`, `dialogs/tasks-browser.ts`, `agent-activity-viewer.ts`; Core `ui-tui/src/app/agentsOverlay.tsx`; Desktop `subagent-panel.tsx`. | implemented (overlay viewer missing) |
| embedded terminal (Console) | `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` (Desktop `embedded-terminal.tsx`); kimi devDep `@xterm/headless`; Rust native pty via Tauri (see `plans/terminal-backends.md`). | implemented |

"No TS equivalent found" → build from scratch: `focus_view` semantics,
`tui_status_indicator` style presets, `/busy` mode control, spawn-tree viewer.

## 6. Integration with existing Hermes-CN-Desktop frontend

Reuse (already implemented):
- Composer editing/completion: `web/src/components/chat/goose-composer.tsx`
  (multi-line textarea, Shift/Ctrl+Enter submit via `lib/composer-submit-shortcut.ts`,
  slash token `lib/composer-skills.ts`, builtin commands
  `lib/builtin-commands.ts`, mentions `lib/composer-mentions.ts`, attachments,
  model picker, voice).
- Streaming: `web/src/components/chat/message-timeline.tsx` +
  `markdown-renderer.tsx` + `message-adapter.ts` (dedup of interrupted live
  messages, `finishReason: "interrupted"`), `tool-activity.ts`,
  `skill-invocation-message.tsx`.
- Busy: `message-skeleton.tsx`, `stall-notice.tsx` (onInterrupt reuses
  composer Stop → `session.interrupt`), `LoadingIndicator`.
- Status bar: `components/app-shell/app-status-bar.tsx` (gateway/model/context/
  kernel/UI versions/running count/24H errors/today tokens).
- Subagents: `components/chat/subagent-panel.tsx` + `stores/subagents.ts` +
  `stores/cli-delegations.ts` + `cli-delegation-card.tsx`.
- Sessions: `routes/history.tsx`, `hooks/use-sessions.ts`.
- Skins/themes: `routes/advanced.tsx` ThemeRoute, `@hermes/shared-ui` useTheme,
  `app-shell/app-status-bar.tsx` theme toggle.
- Console: `routes/console.tsx` + `components/console/embedded-terminal.tsx`
  (Tauri IPC `terminalStart/Write/Resize/Close/onTerminalOutput`).

Missing (new work, design only):
1. Composer input-history recall (Up/Down when not in a picker).
2. Readline-style editing shims (kill-line/kill-to-start/word nav/undo) if
   parity with TUI keybindings is desired.
3. Focus-view toggle wired to `display.focus_view` (`methods_config.py:322`,
   `methods_tools.py:664`).
4. `/busy` queue/steer mode UI + queued-message display (port
   `ui-tui/src/components/queuedMessages.tsx` / kimi queue-pane).
5. Per-tool live output expansion + diff rendering parity.
6. Subagent overlay viewer with keyboard nav + `spawn_tree` snapshot UI.
7. Status-bar subagent HUD (sparkline `widthByDepth`, focus segment
   `FOCUS_STATUSBAR_LABEL`).

## 7. Removing the WebSocket dependency (migration path)

Freeze the wire contract now (it is already implicitly frozen by both clients):
- RPC request surface (section 2.2 method list) — Desktop calls these over
  `/api/ws` via `web/src/lib/gateway-client.ts`.
- Event names + payload shapes (section 2.3) — consumed by
  `web/src/stores/subagents.ts`, chat stores, and `createGatewayEventHandler`.

Phases:
1. **Today**: React UI over WS to Python `tui_gateway` (`/api/ws`); the embedded
   Console keeps a native PTY (`terminal-backends.md`).
2. **Interface swap**: implement an in-process `GatewayClient`-compatible
   transport (same methods/events) hosting the agent runtime in TS; the React
   stores and components change nothing.
3. **Delete WS/REST path**: drop `tui_gateway.ws`/`sse.py` usage, `transport.py`
   WS sidecar, and Dashboard `/api/ws` + `/api/pty` for the chat surface.
   Keep stdio `entry.py` for the standalone `hermes --tui` CLI and the Console
   route.

The TUI itself is explicitly **out of scope for the desktop standalone** — the
React UI replaces it; `cli.py` + `ui-tui/` remain the terminal product.

## 8. Migration phases & task breakdown

1. **Parity inventory (P0)**: complete the React/TUI mapping table above in code
   comments; add integration tests asserting each TUI feature's React anchor.
2. **Composer gaps (P1)**: input-history hook; readline key shims; verify slash
   fuzzy ranking matches `slash_fuzzy.py` tiers (exact 0 / prefix 1 / substring 2
   / description +3) using `tests/cli/test_prefix_matching.py` and
   `tests/tui_gateway/test_slash_fuzzy.py` as parity fixtures.
3. **Turn UX (P1)**: focus-view toggle; busy-mode (queue/steer) controls;
   queued-message display; per-tool output expansion + diff rendering
   (`tests/cli/test_tool_progress_scrollback.py`,
   `test_transformed_stream_output.py`, `test_stream_partial_line_flush.py`).
4. **Observability (P2)**: subagent overlay viewer + spawn-tree snapshot UI;
   status-bar subagent HUD.
5. **Skin parity (P2)**: consume `HermesSkin` in desktop theme route
   (cross-ref `plans/skins-themes.md`).
6. **WS removal (P3)**: in-process transport swap, then delete WS path
   (section 7).

## 9. Risks & open questions

- **No TS equivalent found**: focus view (kimi has none); `tui_status_indicator`
  style presets; `/busy` steer mode; spawn-tree viewer — must be designed from
  scratch; parity tests come only from Python.
- **Prompt-history format**: sharing `~/.hermes/.hermes_history` across TUI and
  React needs a Tauri fs shim and locking (concurrent writers).
- **Composer vs terminal keybindings**: users on the webview expect browser
  textarea behavior; forcing readline kill-keys may conflict with IME/paste.
- **Streaming renderer parity**: `agent.rich_output` streaming markdown/diff is
  Python-side; TS `markdown-renderer.tsx` must be fuzz-tested against
  `render.py` output (tests: `test_render.py`, `test_stream_delta_think_tag.py`).
- **Interrupt races**: desktop currently relies on `message-adapter.ts` dedup;
  porting queue/steer modes must re-verify `tests/cli/test_interrupt_ack_race.py`,
  `test_interrupt_drain_regression.py`, `test_cli_interrupt_subagent.py`.
- **Skin contract drift**: `HermesSkin` (`@hermes/shared/skin`) vs desktop theme
  config; keep one source of truth.

## 10. Test strategy

- **Vitest unit**: port pure functions from `ui-tui` (`lib/history.ts`,
  `lib/subagentTree.ts`, `app/slash/fuzzyScore.ts`, `lib/editor.ts`) and Python
  parity fixtures (`tui_gateway/test_slash_fuzzy.py`, `test_render.py`).
- **Component tests**: composer pickers (`goose-composer.test.tsx` exists),
  subagent panel (`subagent-panel.test.tsx` exists), stall notice, focus toggle.
- **Integration**: gateway-client event fold vs `tests/tui_gateway/`
  (`test_protocol.py`, `test_delegation_session_lifecycle.py`,
  `test_cli_delegation_events.py`, `test_subagent_child_mirror.py`) and
  `tests/cli/` UX tests (`test_cli_status_bar.py`, `test_cli_status_bar_goal.py`,
  `test_cli_background_status_indicator.py`, `test_focus_view.py`,
  `test_cli_skin_integration.py`, `test_cli_shift_enter_newline.py`,
  `test_ctrl_enter_newline.py`, `test_cli_light_mode.py`).
- **Playwright E2E**: composer → stream → stop → subagent panel → status bar on
  the desktop app; Console route quick-command smoke.
- **Parity gate**: run the Python CLI suite (`tests/cli/`, 107 files,
  `tests/test_tui_entry_mcp_owner.py`) as the behavioral oracle; every React
  feature must name the Python test it mirrors.

## 11. Reference links

- Python: `D:/hermes-agent-cn/cli.py`; `tui_gateway/{entry,server,transport,ws,sse,methods_prompt,methods_complete,methods_session,methods_tools,methods_config,render,slash_fuzzy,slash_worker,cli_delegation}.py`; `hermes_cli/focus_view.py`, `hermes_cli/commands.py`; `hermes_constants.py`; `website/docs/user-guide/features/delegation.md`, `README.md`.
- TS TUI (port source): `D:/hermes-agent-cn/ui-tui/src/{app,components,hooks,lib,theme}/*`, `packages/hermes-ink/`.
- kimi-code: `D:/kimi-code/apps/kimi-code/src/tui/{controllers/editor-keyboard.ts,controllers/streaming-ui.ts,controllers/subagent-activity-store.ts,components,commands,theme}`; `D:/kimi-code/packages/pi-tui/src/{autocomplete.ts,editor-component.ts,keybindings.ts,kill-ring.ts,paste-burst.ts,undo-stack.ts,word-navigation.ts,tui.ts}`.
- Desktop: `D:/Hermes-CN-Desktop/web/src/routes/console.tsx`, `components/console/embedded-terminal.tsx`, `components/chat/*`, `components/app-shell/app-status-bar.tsx`, `stores/subagents.ts`, `stores/cli-delegations.ts`, `lib/gateway-client.ts`, `routes/history.tsx`, `routes/advanced.tsx`.
- Related plans: `plans/skins-themes.md`, `plans/subagent-delegation.md`, `plans/session-lifecycle.md`, `plans/sqlite-fts5-session-search.md`, `plans/terminal-backends.md`.
