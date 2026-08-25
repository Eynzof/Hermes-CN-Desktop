# TypeScript Runtime (`packages/`) — Architecture Overview

The Python backend (Hermes-CN-Core) has been fully rewritten in TypeScript.
The implementation lives in the `packages/` pnpm workspaces and runs
**in-process inside the web app** — no Python dashboard, no REST service and
no gateway WebSocket are required. The old design-only `plans/` documents
(110 feature plans) were removed once the rewrite landed; this document is the
living reference for the new implementation.

## Runtime modes

| Mode | Entry | Runtime |
|------|-------|---------|
| Browser-only dev | `python run.py` | Pure TS runtime: in-process gateway + local REST handlers, no backend at all |
| Desktop dev | `pnpm tauri:dev` | Same TS runtime in the Tauri webview; Rust provides OS capabilities |
| Packaged app | `pnpm tauri:build*` | Bundled web dist + Rust shell |

In-process carriers in `web/src/lib/`:

- `gateway-inprocess.ts` — implements the `GatewayTransport` contract and
  dispatches the official `/api/ws` JSON-RPC frames (session.create,
  prompt.submit, model.options, …) to local handlers instead of a socket.
- `dashboard-router.ts` / `dashboard-handlers.ts` — local-first REST layer;
  registered handlers take precedence over the remote `api_request` proxy.
- `local-agent.ts` — local turn engine (echo mode fallback, OpenAI-compatible
  remote call when a provider is configured).
- `session-store/` — in-process session store with a persistable SQL adapter.

Rust (`src/`) is retained only for OS-level capabilities the webview cannot
provide: native dialogs, tray, notifications, clipboard, PTY terminal, file
watchers, wake word. It is reached through Tauri IPC (`tauri-bridge.ts`).

## Package map

| Package | Purpose |
|---------|---------|
| `@hermes/agent-core` | Agent core: turn loop (`run-turn.ts`), LLM provider adapters (OpenAI chat/responses, Anthropic, Gemini, Bedrock, Vertex, Azure), session store, approvals, compaction, bounded memory, learning journey, usage tracking, checkpoints, skills (L0→L2), self-improvement, MoA, personality, plugins, cron, kanban, goals, event hooks, curator, batch, subagent delegation; `runtime/` exposes the `AgentRuntime` facade |
| `@hermes/agent-tools` | Tool catalog/registry/dispatch, toolsets (built-in, platform, dynamic), tool search bridge, Spotify / messaging / Home Assistant / Google Meet integrations |
| `@hermes/browser` | Browser automation: backend registry, provider, session manager, snapshotting, SSRF guard, tool handlers |
| `@hermes/credential-pool` | Credential pools with rotation strategies |
| `@hermes/dashboard` | Local dashboard router, auth, REST routes (consumed by the web app) |
| `@hermes/gateway-core` | Gateway service: adapter contract, event bus, sessions, delivery, slash-command registry |
| `@hermes/messaging-platforms` | 29 messaging platform adapters (Telegram, Discord, Slack, DingTalk, Feishu, WeCom, Weixin, QQ, …) + registry |
| `@hermes/protocol` | Zod schemas (API, MCP, ACP, LSP, …), IPC types, session log parsing |
| `@hermes/shared-ui` | Design tokens (`tokens/*.css`) + shared components/composites/hooks |
| `@hermes/skill-lint` | SKILL.md linter rules + CLI (`pnpm skills:lint`) |

Dependency direction: `protocol` ← everything; `agent-tools` ← `agent-core`;
`gateway-core` ← `messaging-platforms`. `web` consumes `agent-core`,
`agent-tools`, `dashboard`, `protocol` and `shared-ui`.

## Conventions

- All packages are private workspaces pinned to the desktop version
  (`version:sync` keeps them aligned); entry points are raw `src/index.ts`.
- Business logic belongs in `packages/*` (headless, testable); `web/` wires it
  to the UI and to Rust IPC. Do not reintroduce business logic into routes or
  components.
- Unit tests: vitest, co-located (`*.test.ts`). Run `pnpm test:unit`,
  `pnpm typecheck` after changes.

## Feature parity status (backend/runtime vs Hermes-CN-Core Python)

The desktop runtime surface spans Rust `src/` + TS `packages/` + web UI. The
full domain-by-domain matrix lives in the implementation plan
(`plans/feature-parity-with-core.md` at planning time); this section is the
single source of truth for the **P0 correctness/security items** and their
status on the current branch (v0.8.0-rc4):

| P0 item | Status | Evidence |
|---|---|---|
| `browser_snapshot` real CDP snapshot | ✅ Implemented | `src/commands/browser.rs` (CDP `/json` target discovery + `Accessibility.getFullAXTree` over WS + `build_ax_tree` → `src/browser/snapshot.rs::prepare_snapshot`); sessions recorded in `AppStateInner.browser_sessions` |
| `tools_dispatch` command referenced by `agent-tools` | ✅ Implemented | `src/commands/toolkit.rs::tools_dispatch` (file_list/read/write, file_search/grep, terminal_run, desktop_preview; honest `isError` for unsupported); registered in `src/main.rs` |
| Session-log contract drift | ✅ Already fixed | `src/session_log.rs` + `src/schema/session_log.rs` emit `MessagesResponse`; shared golden fixtures `tests/fixtures/protocol/session_log_{input,output}.json` drive both `tests/protocol_schema.rs` and `packages/protocol/src/session-log.parity.test.ts` |
| skill-lint `lintTree` real tree lint | ✅ Implemented | Rust `src/skill_lint/tree.rs` + `src/bin/skills_lint.rs`; `pnpm skills:lint` runs the Rust bin (`scripts/skill-lint.mjs`); Node fs mirror `packages/skill-lint/src/lint-tree.ts` |
| Constant-time webhook verification | ✅ Already fixed | `packages/messaging-platforms/src/webhook-secret.ts` (`crypto.timingSafeEqual`); all adapters use `constantTimeStringEqual` |
| TS catalog stub handlers | ✅ Implemented | `packages/agent-tools/src/catalog.ts` webSearch/webExtract/memoryRead/memoryWrite/imageGenerate/kanban/batchRun route to real dispatch (Rust IPC or provider APIs) with real TS fallbacks |

P1 runtime parity gaps (LLM provider breadth, auxiliary fallback chain,
provider routing controls, MCP OAuth, terminal backends, kanban dispatcher,
subagent swarm, code-execution sandboxes, web-search provider breadth,
image/video gen, TTS breadth, doc extraction, secrets managers, API-server
jobs/runs, outbound webhooks, batch resume, curator, LSP breadth) and P2 UI/UX
gaps are tracked in `docs/desktop-prd/05-feature-parity-gap.md` and
`plans/rust-rewrite-*.md`.

### P1 runtime parity additions (this branch)

New modules added for backend/runtime parity (all with vitest/unit coverage):

- **Providers**: `codex-responses`, `minimax`, `moonshot`, `lmstudio`,
  `nous-relay`, `plugin-llm` adapters + `builtin-profiles.ts`
  (`registerBuiltinProviders`) + `routing.ts` (sub-provider
  sort/whitelist/blacklist/requireParameters/priority).
- **Fallback**: `agent-core/src/fallback/` — auxiliary fallback chains
  (vision/web-extract/compression/skills-hub/mcp/approval/title/goal-judge).
- **Media**: `agent-core/src/media/{imagegen,videogen}.ts` — FAL/OpenAI/xAI/
  DeepInfra image + video provider registries, `analyzeVideo`.
- **Automation**: `kanban/dispatcher.ts` (worker lanes, claim TTL, circuit
  breaker, crash reclaim); `subagent/{swarm,worktree,stall,async-durable}.ts`;
  `code-execution/{sandbox,daemon-pool,limits}.ts`; `batch/runner.ts`
  checkpoint + content-based resume; `curator/engine.ts` pin/rollback;
  `event-hooks/outbound.ts` (HMAC-signed lifecycle webhooks).
- **Web**: `web/src/lib/voice/providers/` (11-provider TTS registry),
  `web/src/lib/web-search/` verified 8-provider breadth.
- **Protocol**: `packages/protocol/src/detect-document-type.ts` (magic-byte
  sniffing + 50MB cap) and `session-log.parity.test.ts` (shared golden
  fixtures).
- **Rust**: `tools_dispatch` (toolkit.rs), real CDP `browser_snapshot`,
  `lsp_known_servers` (~20), `terminal_backends`, `mcp_oauth_begin/apply` +
  `mcp_server_trust`, `egress_proxy_resolve_secret` (env/Bitwarden/1Password/
  command).
