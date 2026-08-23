# Hermes Agent CN Desktop — Python → TypeScript Feature Rewrite Plans

> Purpose: design-only plans (NO implementation) for moving features from the Python
> backend (`D:/hermes-agent-cn`) into the TypeScript frontend monorepo
> (`D:/Hermes-CN-Desktop`), with the final goal of **removing the WebSocket link**
> to the managed Python runtime (Dashboard `/api/ws` + REST API).

Each file in this directory is **one feature = one file**. Files are named by feature
slug (`<feature-slug>.md`). This README defines the conventions every plan follows.

## Scope & non-goals

- Plans are **design documents only**. Do not implement code.
- The end-state architecture: the React web app (Tauri webview) hosts the agent runtime
  in-process (TypeScript), so no Python backend / WS link is needed. Rust (`src/`) stays
  for OS-level capabilities (file dialogs, notifications, tray, child processes,
  native terminal pty, SQLite if needed) and is invoked via Tauri IPC.
- Features that are pure CLI/TUI/installer/messaging-platform adapters may be marked
  "out of scope for desktop standalone" with a short justification, but still get a plan
  file so the port decision is recorded.

## Reference projects

- Python source of truth: `D:/hermes-agent-cn` (docs: `website/docs/user-guide/features/`,
  `website/docs/reference/`; implementation under `agent/`, `tools/`, `cron/`, `gateway/`,
  `hermes_cli/`, `plugins/`, `tui_gateway/`).
- TypeScript reference (proves which third-party libs exist in TS and how similar agent
  features are implemented): `D:/kimi-code` (Moonshot Kimi Code CLI monorepo).
  Relevant packages:
  - `packages/agent-core` — agent loop (`src/loop`, `src/agent/`), sessions
    (`src/session/`), tools (`src/tools/`), MCP (`src/mcp/`), skills (`src/skill/`,
    `src/agent/skill/`), cron (`src/agent/cron/`, `src/tools/cron/`), goals
    (`src/agent/goal/`), swarm/subagents (`src/agent/swarm/`), permission/approval
    (`src/agent/permission/`, `src/services/approval/`), compaction
    (`src/agent/compaction/`), context (`src/agent/context/`), model catalog
    (`src/services/modelCatalog/`), auth/oauth (`src/services/auth/`, `src/services/oauth/`),
    terminal (`src/services/terminal/`), fs/workspace (`src/services/fs/`, `src/services/workspace/`)
  - `packages/kap-server` — server/transport/protocol infra (OpenAI-compatible + custom)
  - `packages/acp-server`, `packages/acp-adapter` — ACP / IDE integration
  - `packages/oauth` — OAuth (PKCE, device code)
  - `packages/minidb` — embedded DB / persistence engine
  - `packages/protocol` — wire protocol types, fs/file schemas
  - `packages/telemetry` — OTLP/metrics
  - `packages/transcript`, `packages/pi-tui`, `packages/kaos`, `packages/kosong`,
    `packages/klient`, `apps/kimi-code/src/utils/*` (git, image, process, clipboard,
    history, usage), `apps/kimi-code/src/native` (node-pty etc.)
- Existing frontend integration points in `D:/Hermes-CN-Desktop`:
  - `web/src/lib/transport.ts` (HTTP routing + auth), `web/src/lib/gateway-client.ts`
    (WS JSON-RPC), `web/src/lib/tauri-bridge.ts` (Rust IPC shim)
  - `web/src/hooks/`, `web/src/routes/`, `web/src/stores/` (Jotai), `packages/protocol/`
    (Zod schemas), `packages/shared-ui/`
  - Rust side: `src/commands/*` (60 Tauri commands), `src/state.rs`, `src/error.rs`

## Mandatory plan-file template

Every `<feature-slug>.md` MUST contain the following sections (in this order):

```markdown
# <Feature Name> — Python → TypeScript Rewrite Plan

## 1. Summary
## 2. Current Python implementation
   (source files, modules, data flow; cite exact paths under D:/hermes-agent-cn)
## 3. Target TypeScript design
   (module layout under web/src or packages/*, classes/interfaces, data flow;
    describe how it runs in-process without the Python backend)
## 4. Data models & persistence
   (messages, sessions, state; SQLite/IndexedDB/JSON strategy; schema migrations)
## 5. Third-party library strategy
   (Python dependency -> TS equivalent; cite evidence from D:/kimi-code where the
    equivalent TS implementation exists; where no TS lib exists, design a thin shim)
## 6. Integration with existing Hermes-CN-Desktop frontend
   (existing routes/hooks/lib/stores/Rust commands to reuse or replace)
## 7. Removing the WebSocket dependency (migration path)
   (phased: keep backend call today -> in-process module behind same interface ->
    delete WS/REST path; identify the API surface to freeze during migration)
## 8. Migration phases & task breakdown
## 9. Risks & open questions
## 10. Test strategy
    (vitest unit, integration, Playwright E2E; parity tests vs Python behavior)
## 11. Reference links
```

## Conventions

- Write in a mix of Chinese/English acceptable to the team; headings in English.
- Cite real file paths (absolute or repo-relative). Do not invent APIs that do not exist;
  verify by reading the Core source and kimi-code source.
- "Third-party library strategy" is the most important section: for every Python lib the
  feature relies on, name the TS equivalent (with kimi-code evidence when available), or
  explicitly state "implement a TS module from scratch" and sketch its interface.
- Keep each plan focused: target 150–400 lines. Deep tables are fine.
- Do NOT write implementation code (no `.ts`/`.py` source files). Pseudocode/signatures OK.
