# End-to-end tests

These tests exercise the real chat closed loops a user cares about, through the
**real web UI** and the **real Core backend** — only the LLM is swapped for a
local, deterministic fake. That keeps the whole stack honest (WebSocket gateway,
session lifecycle, streaming, image/vision routing) while being fast, free, and
repeatable, so it can gate every PR.

## What it covers

| Loop | Spec | Asserts |
|------|------|---------|
| New chat → streamed reply → navigate to history → continue | `specs/chat-loop.spec.ts` | a session is created, the URL moves to `/tasks/:id`, the assistant reply streams in, and a follow-up turn works |
| Paste an image → the model reads it | `specs/image-paste.spec.ts` | the pasted image attaches, and the model's reply embeds the **decoded image byte count** (proof the bytes really reached the model) |

## Architecture

```
Playwright (Chromium)
   │  drives the real UI: textarea[aria-label="输入消息"], button[aria-label="发送消息"], ...
   ▼
Vite dev server  :9545   (the actual desktop frontend, unmodified)
   │  HERMES_DASHBOARD_ORIGIN redirects /api + /api/ws  ── the one seam we flip ──┐
   ▼                                                                              │
Core dashboard   :9120   `hermes dashboard` — REAL REST + /api/ws gateway + agent loop
   │  model.base_url points the "custom" provider at ...                         │
   ▼                                                                              │
Fake model       :8099   OpenAI-compatible, deterministic (e2e/fake-model/server.py)
                          • streams a "PONG: ..." reply for text
                          • for vision, replies "我看到一张图片，共 <N> 字节"
```

The only env var that moves the backend is **`HERMES_DASHBOARD_ORIGIN`**
(`web/vite.config.ts` proxies both `/api` and `/api/ws` there). Everything else
is the production code path.

The determinism knob is the **fake model** (`fake-model/server.py`). To run the
loops against a *real* LLM instead (a paid smoke test), point Core at a real
provider in `harness/config.mjs#configYaml` and loosen the assertions — the UI
flow is identical.

## Run it

```bash
pnpm install                                   # once, from the desktop repo root
pnpm --filter @hermes/e2e exec playwright install chromium

# Full browser suite (Playwright starts the backend + Vite automatically):
pnpm --filter @hermes/e2e test
pnpm --filter @hermes/e2e test:headed          # watch it click

# Fast, browserless gate — proves the backend loop at the protocol level.
# Needs the backend up first (in another terminal: `pnpm --filter @hermes/e2e backend`):
pnpm --filter @hermes/e2e smoke
```

Requirements: the **Core** repo checked out as a sibling (`../Hermes-CN-Core`)
with a working `.venv` (`fastapi`, `uvicorn`, and the agent deps). Override paths
with `HERMES_CORE_DIR` / `HERMES_CORE_PYTHON`. Runtime state is written to a fresh
`e2e/.runtime/` (gitignored) on every run.

## Cross-repo drift this caught (now fixed)

Building this surfaced a real contract drift: the desktop uploaded image
attachments via REST **`/api/upload`** (both the browser path in
`web/src/lib/transport.ts` and the native Rust `upload_file_impl` in
`src/commands/api_proxy.rs`), but Core only serves `/api/files/upload` (a
different `data_url` contract). `/api/upload` is a fork-only P-002 patch for the
*v2 web dashboard* that Core keeps dropping/restoring across upstream syncs — so
image attach silently breaks whenever it's dropped.

**Fix:** images now attach over the gateway via `image.attach_bytes` (base64 over
the WebSocket), matching Core's own `apps/desktop`. The composer sends the pasted
image's bytes directly — no REST upload, no dependency on the fragile
`/api/upload` endpoint. See `web/src/lib/composer-prompt.ts` (the `looksLikeImage`
branch) and `web/src/hooks/use-gateway.ts` (`attachImageBytes`). The image spec
therefore drives the real shipped path with no test workaround.

## Layout

```
e2e/
├── playwright.config.ts        two webServers (backend + Vite), Chromium project
├── fake-model/server.py        deterministic OpenAI-compatible model
├── harness/
│   ├── config.mjs              shared paths/ports + the Core config.yaml it writes
│   ├── start-backend.mjs       spawns fake model + Core dashboard, waits for ready
│   ├── protocol-smoke.mjs      browserless WS proof of all three loops
│   └── wait.mjs                tiny poll/readiness helpers
├── fixtures/red-square.mjs     the 1×1 PNG shared by smoke + image spec
└── specs/
    ├── chat-loop.spec.ts
    └── image-paste.spec.ts
```

## Stable selectors

The specs target accessibility roles / `data-*` (`textbox[name=输入消息]`,
`button[name=发送消息]`, `role=log`, `[data-role=assistant]`,
`span[data-kind=image][data-status=ready]`). If you rename these, update the
specs. Consider adding explicit `data-testid`s on the composer input, assistant
bubble, and rendered message image to make the suite rename-proof.
```
