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
