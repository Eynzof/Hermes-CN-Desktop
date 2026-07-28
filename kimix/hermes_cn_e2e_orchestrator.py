"""
Hermes-CN Headless E2E Testing System — Kimix Orchestrator Script
=================================================================
Spawns agents in 4 waves per the Prompt Pack (§1–§11):
  Wave 1 (parallel): A (Contract Inventory) + B (Fake LLM)
  Wave 2 (parallel): C (Backend Harness) + D (REST Tests) + E (WS Tests) + F (Frontend Components)
  Wave 3 (parallel): G (Playwright E2E) + H (Orchestration/CI)
  Wave 4:            I (Drift Detection & Governance)

Each wave starts only when the previous wave's deliverables exist and
acceptance commands pass.  Agents in the same wave run concurrently.

Usage:
    python kimix/hermes_cn_e2e_orchestrator.py --backend=C:/dev/Hermes-CN-Core
"""

from __future__ import annotations

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from kimix import *


# ═══════════════════════════════════════════════════════════════════════
# §2 — Variables — populated from __file__ + CLI arg --backend
# ═══════════════════════════════════════════════════════════════════════

# This script lives at <repo-root>/kimix/hermes_cn_e2e_orchestrator.py
# so the frontend (desktop) repo root is two dirs up from __file__.
_SCRIPT_DIR = Path(__file__).resolve().parent
_DESKTOP_DIR = _SCRIPT_DIR.parent  # kimix/ is inside Hermes-CN-Desktop

VARS: dict[str, str] = {
    "CORE_DIR":          "",   # filled from --backend CLI arg
    "DESKTOP_DIR":       str(_DESKTOP_DIR),
    "CORE_PYTHON":       "",   # computed: "{CORE_DIR}/.venv/bin/python"
    "FAKE_MODEL_PORT":   "8099",
    "DASHBOARD_PORT":    "9120",
    "VITE_PORT":         "9545",
    "DASHBOARD_TOKEN":   "e2e-token",
    "HERMES_HOME":       str(_DESKTOP_DIR / "e2e" / ".runtime" / "hermes-home"),
    "BRANCH_PREFIX":     "e2e-system/",
}


def resolve_vars(backend_dir: str) -> None:
    """Update VARS with the backend path and derived values."""
    core = Path(backend_dir).resolve()
    VARS["CORE_DIR"] = str(core)
    # Prefer .venv/Scripts/python.exe on Windows, .venv/bin/python on Unix
    venv_python = core / ".venv" / "Scripts" / "python.exe"
    if not venv_python.exists():
        venv_python = core / ".venv" / "bin" / "python"
    VARS["CORE_PYTHON"] = str(venv_python)


def fill(text: str) -> str:
    """Replace {{VAR}} placeholders with actual values from VARS."""
    for key, val in VARS.items():
        text = text.replace("{{" + key + "}}", val)
    return text


# ═══════════════════════════════════════════════════════════════════════
# §3 — Prompt P0: Global Preamble (inject into EVERY agent)
# ═══════════════════════════════════════════════════════════════════════

P0_RAW: str = """\
You are one of several coding agents building a headless end-to-end testing
system for two sibling repositories:

  BACKEND  (Python): {{CORE_DIR}}
    - FastAPI dashboard app: hermes_cli/web_server.py
      (≈232 HTTP endpoints under /api/*, plus WebSocket channels
       /api/ws, /api/pub, /api/pty, /api/events, /api/console)
    - aiohttp OpenAI-compatible API server: gateway/platforms/api_server.py
    - Entry: `hermes dashboard`; config at $HERMES_HOME/config.yaml
  FRONTEND (React 19 + Vite + TS, Tauri shell): {{DESKTOP_DIR}}
    - Web UI: web/src (routes/, components/, stores/, hooks/, lib/)
    - Unit tests: Vitest (`pnpm --filter @hermes/web test:unit`)
    - Existing E2E: e2e/ (Playwright package @hermes/e2e, fake model, harness)

HARD CONSTRAINTS — every artifact you produce must obey all of these:

1. HEADLESS ONLY. No test may open a visible window: Playwright runs with
   `headless: true` (already set in e2e/playwright.config.ts); component tests
   run in Vitest + jsdom; backend tests run in-process or against loopback
   servers. Never use `test:headed`, Xvfb-dependent flows, or Tauri window
   automation. The Tauri/Rust shell is OUT of scope — test the web UI through
   Chromium and the backend through HTTP/WS.
2. NO REAL LLM. No code path under test may reach a real inference provider.
   All model traffic goes to the deterministic fake model at
   http://127.0.0.1:{{FAKE_MODEL_PORT}}/v1 (OpenAI-compatible). Backend tests
   may additionally stub at the Python layer (patch call_llm / provider
   transport). Never require API keys: the Core conftest already strips
   *_API_KEY/*_TOKEN-style env vars — respect that hermetic contract.
3. DETERMINISM. TZ=UTC, fixed ports, fresh isolated HERMES_HOME per run, no
   wall-clock-dependent assertions, no network egress beyond loopback.
4. BEHAVIOR CONTRACTS OVER SNAPSHOTS (Core AGENTS.md rule). Assert
   relationships and invariants (a session was created; streamed deltas
   precede the completion event; bytes sent == bytes the model received),
   never freeze current values (exact model lists, literal config versions,
   full-response snapshots).
5. FUTURE-COMPATIBLE SELECTORS. In UI tests prefer role+accessible-name and
   `data-testid` (registry in e2e/testids.ts once Agent A lands it) over CSS
   classes or DOM paths. The UI is Chinese-localized: accessible names are
   Chinese (e.g. textbox 输入消息, button 发送消息). Never hardcode a Chinese
   string outside the shared locators module — import it.
6. SCRIPTABLE OUTPUT. Everything you add must be runnable non-interactively:
   one command per suite, exit code 0/1, JUnit/HTML reports, no prompts.
7. DO NOT modify production behavior to "make tests pass". You may add
   data-testid attributes and test-only seams, but any production-code change
   must be flagged in your final report under "PRODUCTION DIFFS".
8. Work on branch {{BRANCH_PREFIX}}<your-agent-name>. Touch only files under
   your OWNERSHIP list. Run your own acceptance commands before finishing.

GROUND TRUTH (verify before extending, these exist today):
- e2e/fake-model/server.py — deterministic OpenAI-compatible fake (streams
  PONG/marker replies; vision replies embed decoded image byte count).
- e2e/harness/{config.mjs,start-backend.mjs,wait.mjs,global-warmup.mjs,
  protocol-smoke.mjs} — boots real Core dashboard on :{{DASHBOARD_PORT}}
  with configYaml() pointing provider `custom` at the fake model.
- e2e/playwright.config.ts — two webServers (backend harness, Vite :{{VITE_PORT}}
  with HERMES_DASHBOARD_ORIGIN seam), serial workers, global warmup.
- e2e/specs/{chat-loop,image-paste,guide-layout,model-onboarding,
  models-cli-custom-provider,skills-provenance}.spec.ts — working examples.
- Core tests/conftest.py — hermetic invariants (credential strip, per-test
  HERMES_HOME tempdir, TZ=UTC); tests/fakes/fake_ha_server.py — pattern for
  real-loopback-server fakes; scripts/run_tests_parallel.py — per-file
  process-isolation runner.
"""


# ═══════════════════════════════════════════════════════════════════════
# §4 — Wave 1: Agent A — Contract Inventory & UI Element Registry
# ═══════════════════════════════════════════════════════════════════════

AGENT_A_RAW: str = """\
ROLE: Test-archaeologist. You produce the machine-readable inventory every
other agent codes against. No test logic — only discovery artifacts.

OWNERSHIP (create new, modify nothing else):
  {{CORE_DIR}}/tests/contracts/
  {{DESKTOP_DIR}}/e2e/contracts/
  {{DESKTOP_DIR}}/e2e/testids.ts

READ FIRST:
  {{CORE_DIR}}/hermes_cli/web_server.py (all @app.<method> decorators)
  {{CORE_DIR}}/gateway/platforms/api_server.py (_http_route_table)
  {{DESKTOP_DIR}}/web/src/routes/*.tsx, components/, app.tsx
  {{DESKTOP_DIR}}/packages/protocol/src/{hermes-api.ts,channels.ts}

MISSION:
1. BACKEND API MANIFEST. Extract every frontend-facing endpoint from the
   FastAPI dashboard (and, in a separate section, the aiohttp API server)
   into {{DESKTOP_DIR}}/e2e/contracts/backend-api.yaml. Per entry record:
   method, path, path params, request body model (Pydantic class name +
   required fields), success status, auth requirement (session token?),
   idempotency, and the handler function name. Generate it with a SCRIPT
   ({{CORE_DIR}}/tests/contracts/extract_api_manifest.py) that imports the
   FastAPI `app` object and walks `app.routes` (FastAPI self-describes via
   /openapi.json — prefer that over regex; the aiohttp table is literal code,
   parse _http_route_table). The script must be re-runnable and diff-friendly
   (sorted keys, stable order).
2. WEBSOCKET CHANNEL MANIFEST. Document the 5 WS channels (/api/ws chat
   streaming, /api/events, /api/pub, /api/console, /api/pty): handshake
   requirements, message envelope shapes (event types, required keys), and
   which UI feature consumes each (cross-reference packages/protocol/src/
   channels.ts). Output: e2e/contracts/ws-channels.yaml.
3. UI ELEMENT REGISTRY. Walk every route in web/src (chat/tasks, history,
   settings + models/oauth/moa sections, mcp, skills, cron, profiles,
   projects, memory, analytics, console, logs, kanban, guide, health, backup,
   debug, voice, environment, im-onboarding, coding-agents, advanced) and
   catalog every interactive element: buttons, text areas, inputs, selects,
   toggles, menus, dialogs, links, draggable lists, terminal widgets.
   Output e2e/contracts/ui-elements.yaml keyed by route, per element:
   stable key, element kind, current accessible name (Chinese ok), role,
   and a PROPOSED data-testid. Then create e2e/testids.ts exporting a typed
   const object `T` (e.g. T.composer.send = "composer-send") so suites
   import ids instead of strings.
4. COVERAGE MATRIX. Join 1–3 into e2e/contracts/coverage-matrix.yaml:
   route → UI elements → backend endpoints each element triggers (trace
   through hooks/ and lib/ fetch calls). Gaps allowed — mark them
   `covered_by: none` so Waves 2–3 have explicit targets.

ACCEPTANCE:
  cd {{DESKTOP_DIR}} && node -e "const y=require('yaml');..."  # all 4 YAMLs parse
  python {{CORE_DIR}}/tests/contracts/extract_api_manifest.py --check  # regenerates identical file
  Manifest counts: >= 220 REST endpoints, 5 WS channels, >= 25 routes.

NON-GOALS: writing tests, changing production logic. Adding zero
data-testid attributes in this wave — registry only.

FUTURE-COMPATIBILITY: manifests must carry a `generated_by` + `generated_at`
header and a semver `schema_version`; the extractor script is the single
source of truth, never hand-edit generated YAML.
"""


# ═══════════════════════════════════════════════════════════════════════
# §4 — Wave 1: Agent B — Deterministic Fake LLM / Magic-Mock Provider
# ═══════════════════════════════════════════════════════════════════════

AGENT_B_RAW: str = """\
ROLE: Test doubles engineer. Build the "magic-mock" that replaces every real
LLM provider, for BOTH the e2e harness (HTTP level) and Core's pytest suite
(Python level).

OWNERSHIP:
  {{DESKTOP_DIR}}/e2e/fake-model/        (extend existing server.py)
  {{CORE_DIR}}/tests/fakes/fake_llm_server.py   (new, Python reusable fake)
  {{CORE_DIR}}/tests/fakes/mock_transport.py    (new, in-process stub)

READ FIRST:
  {{DESKTOP_DIR}}/e2e/fake-model/server.py (existing deterministic fake)
  {{DESKTOP_DIR}}/e2e/harness/config.mjs (how Core is pointed at the fake)
  {{CORE_DIR}}/providers/base.py (ProviderProfile contract)
  {{CORE_DIR}}/tests/fakes/fake_ha_server.py (loopback-server fake pattern)
  {{CORE_DIR}}/tests/agent/test_context_compressor.py (call_llm patch pattern)

MISSION — three layers, one behavior spec:

1. EXTEND THE HTTP FAKE (e2e/fake-model/server.py). Keep every existing
   behavior (PONG echo, STREAM-ORDER markers, vision byte-count proof,
   /v1/models, /health) and add a PROGRAMMABLE script API:
   - POST /admin/script  { "responses": [...] } queues exact responses.
   - Behaviors to support: streaming with configurable chunk size/delay,
     tool-call responses (function calling deltas), reasoning/thinking
     blocks, multi-turn statefulness (echo-N marker per turn), error
     injection (429, 500, malformed SSE, mid-stream abort, slow drip),
     usage/token accounting fields, and a "magic-echo" default that embeds
     a hash of the request (so tests prove the request reached the model).
   - POST /admin/reset, GET /admin/requests (recorded requests for
     assert-side verification — the "magic" part: tests can later ask the
     fake exactly what it received).
   - All deterministic: no randomness unless seeded via request.
2. PYTEST LOOPBACK FAKE (tests/fakes/fake_llm_server.py). Port the same
   behavior spec to an aiohttp server following the fake_ha_server.py
   pattern (async context manager, .url property, received-request log).
   Used by Core integration tests that boot the real agent loop.
3. IN-PROCESS MOCK TRANSPORT (tests/fakes/mock_transport.py). A
   unittest.mock-compatible stub of the provider transport/call_llm layer
   with the same script API, for pure unit tests where a socket is overkill.
   Provide fixtures in tests/fakes/__init__.py: `scripted_llm` (function
   scope), and document when to use layer 2 vs 3 (integration: real socket;
   unit: in-process).

ACCEPTANCE:
  cd {{DESKTOP_DIR}}/e2e && pnpm smoke                      # existing smoke still green
  uvicorn e2e/fake-model/server:app --port {{FAKE_MODEL_PORT}} &
  curl -s .../health && scripted tool-call + error-injection round-trips pass
  cd {{CORE_DIR}} && python -m pytest tests/fakes/ -q       # self-tests green
r

NON-GOALS: implementing real provider logic, auth flows, or models.dev
catalog emulation (stub /v1/models with the configured model id only).

FUTURE-COMPATIBILITY: the behavior spec lives in
e2e/fake-model/BEHAVIOR.md; both Python and JS-facing implementations must
pass the same conformance checks (add a small conformance script
e2e/fake-model/conformance.py that runs against either implementation).
"""


# ═══════════════════════════════════════════════════════════════════════
# §5 — Wave 2: Agent C — Backend Integration Test Harness
# ═══════════════════════════════════════════════════════════════════════

AGENT_C_RAW: str = """\
ROLE: Harness builder. Give Core a hermetic, one-command way to boot the
REAL dashboard against the fake LLM and assert at the HTTP/WS boundary.

OWNERSHIP:
  {{CORE_DIR}}/tests/dashboard/           (extend; today only ws_client_host)
  {{CORE_DIR}}/tests/dashboard/conftest.py
  {{CORE_DIR}}/tests/integration/dashboard/

READ FIRST:
  {{CORE_DIR}}/tests/conftest.py (hermetic invariants — extend, don't break)
  {{CORE_DIR}}/hermes_cli/web_server.py (lifespan, middlewares, token gate)
  {{CORE_DIR}}/hermes_cli/subcommands/dashboard.py (how `hermes dashboard` boots)
  {{DESKTOP_DIR}}/e2e/harness/start-backend.mjs (env + config.yaml recipe)

MISSION:
1. `dashboard_server` pytest fixture (session-scoped): builds a temp
   HERMES_HOME, writes config.yaml with provider `custom` →
   http://127.0.0.1:{{FAKE_MODEL_PORT}}/v1 (reuse Agent B's fake; import
   tests/fakes/fake_llm_server and start it too), boots the FastAPI app
   (prefer in-process ASGI via httpx.ASGITransport for speed; provide a
   `--real-uvicorn` opt-in mode that spawns `hermes dashboard` as a
   subprocess exactly like start-backend.mjs does). Sets
   HERMES_DASHBOARD_SESSION_TOKEN={{DASHBOARD_TOKEN}} and yields an
   authenticated httpx.AsyncClient + a ws connect helper.
2. Hermetic guards: assert no env var with credential suffixes survives;
   assert the only outbound base_url in the resolved provider chain is the
   fake; fail the suite loudly if any test triggers a DNS lookup beyond
   loopback (socket guard fixture).
3. Helpers: `make_session()`, `chat_stream_collect()` (drain /api/ws or
   POST /chat/stream into ordered event list), `wait_for(predicate)`,
   snapshot-free assertions per P0 rule 4.
4. Runner integration: suite must pass under BOTH
   `python -m pytest tests/dashboard -q` and the per-file isolation runner
   scripts/run_tests_parallel.py. Document in tests/dashboard/README.md.

ACCEPTANCE:
  cd {{CORE_DIR}} && python -m pytest tests/dashboard -q --collect-only | wc -l  # fixtures import clean
  python -m pytest tests/dashboard/test_harness_selfcheck.py -q   # boots app, /api/config 200, fake model round-trip
  HERMES_TEST_REAL_UVICORN=1 python -m pytest tests/dashboard/test_harness_selfcheck.py -q  # subprocess mode green

NON-GOALS: writing the per-endpoint tests (Agent D), WS behavior tests
(Agent E), Tauri shell.

FUTURE-COMPATIBILITY: fixtures read the endpoint manifest from Agent A
(e2e/contracts/backend-api.yaml) only for PARAMETRIZATION COUNT sanity —
never hardcode endpoint lists inside the harness.
"""


# ═══════════════════════════════════════════════════════════════════════
# §5 — Wave 2: Agent D — Backend REST Contract Tests
# ═══════════════════════════════════════════════════════════════════════

AGENT_D_RAW: str = """\
ROLE: API coverage engineer. Every function the dashboard exposes to the
frontend gets at least one hermetic test; the important ones get full
behavior tests. Grouped, parametrized, and generated from the manifest.

OWNERSHIP:
  {{CORE_DIR}}/tests/dashboard/rest/
  {{CORE_DIR}}/tests/dashboard/rest/test_*.py (one file per endpoint group)

READ FIRST:
  {{DESKTOP_DIR}}/e2e/contracts/backend-api.yaml (Agent A manifest)
  {{DESKTOP_DIR}}/e2e/contracts/coverage-matrix.yaml (what the UI calls)
  {{CORE_DIR}}/hermes_cli/web_server.py handler bodies per group

MISSION — one test file per group; use Agent C fixtures; the fake LLM is
the only model. Cover, in manifest order:

1. SESSIONS & CHAT: create/list/get/patch/delete session, messages history,
   fork, POST /api/sessions/{id}/chat and /chat/stream with scripted fake
   replies; assert streamed event ordering (delta* → done) and persistence
   round-trip (message sent → appears in GET messages).
2. FILES & FS: /api/files* (list/read/download/upload/upload-stream/mkdir/
   delete), /api/fs/* (list/read-text/write-text/read-data-url/git-root/
   default-cwd) against a fixture directory tree; assert path-traversal
   rejection (../ escapes → 4xx) and upload byte-integrity.
3. GIT: status/worktrees/branches/review list+diff/stage/unstage/revert/
   commit against a temp git repo fixture (init in tmp_path); no network
   remotes — push/create-pr tests assert graceful failure with fake remote.
4. PROVIDERS & MODELS: /api/providers/validate (script the fake /v1/models),
   custom-endpoints CRUD + activate + validate, /api/model/set + /v1/models;
   assert the resolved provider base_url is always the fake.
5. PROFILES: CRUD, active profile get/set, model/description/soul updates.
6. MCP: /api/mcp/servers CRUD, enable toggle, catalog list, /test with a
   stub MCP server fixture (in-proc JSON-RPC echo); oauth flow endpoints
   assert state machine with mocked callback.
7. SKILLS: list/toggle/content write, hub install/update/uninstall against
   a local fixture hub (file:// or loopback HTTP) — never the real hub.
8. CRON: jobs CRUD, pause/resume/run (run executes against fake LLM),
   /api/cron/jobs/{id}/runs history, blueprints, delivery-targets.
9. CONFIG & ENV: /api/config get/put + raw + schema + defaults; /api/env
   get/put; /api/env/reveal gated by session token (401 without, 200 with).
10. GATEWAY CONTROL: start/stop/restart/drain status endpoints — assert
    state transitions only (stub the supervisor seam; never spawn real
    gateway subprocesses in unit mode).
11. MEMORY / LEARNING / CURATOR / ANALYTICS / OPS: enable-disable round
    trips, dump/doctor/backup/import against temp HERMES_HOME (doctor must
    not hit network — assert with socket guard).
12. SMOKE-PARAMETRIZED FULL SWEEP: one parametrized test that walks EVERY
	    manifest GET endpoint with valid auth and asserts non-5xx (documented
	    allowlist for intentional 4xx), giving 100% surface coverage even where
	    deep behavior tests don't exist yet.
13. SELF-HEALING: After writing all test files above, run the full suite for
	    your ownership area (all test_*.py under tests/dashboard/rest/). If any
	    test fails, diagnose the root cause, fix it (test or production code,
	    flagging production diffs per P0 rule 7), and re-run. Repeat until
	    every ACCEPTANCE command below exits 0. Do NOT silence or skip failing
	    tests — fix the underlying issue.

	ACCEPTANCE:
  cd {{CORE_DIR}} && python -m pytest tests/dashboard/rest -q   # green
  python scripts/run_tests_parallel.py tests/dashboard/rest     # green under isolation
  Coverage gate: every manifest endpoint referenced by ≥1 test (script
  tests/dashboard/rest/check_manifest_coverage.py exits 0).
  Socket guard proves: zero non-loopback connections during the run.

NON-GOALS: WS channels (Agent E), performance/stress, aiohttp api_server
OpenAI-compat routes (optional stretch: same harness, separate file).

FUTURE-COMPATIBILITY: tests import endpoint paths from the manifest at
	collection time where practical; behavior tests use P0 rule 4 (invariants);
	no response-body snapshots.
	"""


# §5 — Wave 2: Agent D — SELF-HEALING AFTER-BURN
# (contributes to the SELF-HEALING block in the MISSION above)
# The SELF-HEALING step is embedded in AGENT_D_RAW's MISSION bullet list.



# ═══════════════════════════════════════════════════════════════════════
# §5 — Wave 2: Agent E — Backend Realtime Channel Tests (WS/SSE)
# ═══════════════════════════════════════════════════════════════════════

AGENT_E_RAW: str = """\
ROLE: Streaming-protocol tester. Own all 5 WS channels + SSE paths the
frontend depends on, end to end against the fake LLM.

OWNERSHIP:
  {{CORE_DIR}}/tests/dashboard/ws/

READ FIRST:
  {{DESKTOP_DIR}}/e2e/contracts/ws-channels.yaml (Agent A)
  {{DESKTOP_DIR}}/packages/protocol/src/channels.ts (frontend's own protocol)
  {{CORE_DIR}}/hermes_cli/web_server.py WS handlers (/api/ws, /api/pub,
  /api/pty, /api/events, /api/console)
  {{DESKTOP_DIR}}/e2e/harness/protocol-smoke.mjs (existing browserless loop)

MISSION:
1. /api/ws CHAT LOOP: connect, send user message, collect events until
   completion; assert (a) event envelope schema per message type,
   (b) ordering: deltas arrive in order, all before the final/done event,
   (c) the fake's stream-order marker (STREAM-ORDER-BEGIN … END) arrives
   intact and in order, (d) persisted session contains exactly one
   assistant row matching the concatenated deltas, (e) a second turn on the
   same socket works. Include scripted error injection: mid-stream abort →
   channel emits error event + session stays consistent.
2. VISION PROOF LOOP: send image data-URL content part; assert fake's reply
   embeds the decoded byte count (proves bytes crossed the whole pipeline).
3. /api/events & /api/pub: subscribe, trigger a backend state change via
   REST (e.g. cron job toggle, profile switch), assert the matching event
   is broadcast with correct topic + payload schema; assert unsubscribe and
   reconnect semantics.
4. /api/console & /api/pty: assert handshake auth, basic I/O round-trip
   using a scripted command (echo/cat — no interactive shell assumptions),
   and clean teardown; PTY resize message tolerated. Mark skipped on
   platforms without pty support (Windows) with a clear reason.
5. SSE TRANSPORT (if enabled in config under test): POST + EventSource
   style stream; assert parity of event sequence with the WS path for the
   same scripted chat (transport-parity test, mirrors the spirit of
   tests/providers/test_transport_parity.py).
6. RESILIENCE: client disconnect mid-stream → server cleans run state
	   (no leaked tasks; assert via Agent C harness introspection hook);
	   reconnect with same session token resumes history reads.
7. SELF-HEALING: After writing all test files above, run the full WS suite
	   (cd {{CORE_DIR}} && python -m pytest tests/dashboard/ws -q). If any
	   test fails, diagnose the root cause, fix it (test or production code,
	   flagging production diffs per P0 rule 7), and re-run. Repeat until
	   every ACCEPTANCE command below exits 0. Do NOT silence or skip failing
	   tests — fix the underlying issue.

	ACCEPTANCE:
  cd {{CORE_DIR}} && python -m pytest tests/dashboard/ws -q    # green
  cd {{DESKTOP_DIR}}/e2e && pnpm smoke                          # existing smoke still green
  Zero flaky markers across 10 consecutive CI runs (run 10x locally, all pass).

NON-GOALS: load testing, multi-client fan-out beyond 2 concurrent sockets,
real gateway platforms (Telegram/Discord/...).

FUTURE-COMPATIBILITY: event schemas asserted structurally (keys + types +
ordering invariants), never full-payload equality; schema constants shared
via a small ws_schemas.py so protocol evolution updates one file.
"""


# ═══════════════════════════════════════════════════════════════════════
# §5 — Wave 2: Agent F — Frontend Headless Component Tests (Vitest)
# ═══════════════════════════════════════════════════════════════════════

AGENT_F_RAW: str = """\
ROLE: UI interaction engineer. Every interactive element in the web UI gets
a headless, step-by-step interaction test at the component level — buttons
press, text areas accept input, labels render, menus open, dialogs confirm —
with the backend stubbed at the fetch layer.

OWNERSHIP:
  {{DESKTOP_DIR}}/web/src/**/__tests__/e2e-layer/  (new colocated test dirs)
  {{DESKTOP_DIR}}/web/src/test-utils/              (new shared helpers)

READ FIRST:
  {{DESKTOP_DIR}}/web/package.json (vitest config, jsdom availability)
  Existing *.test.ts next to lib/ and hooks/ (house style)
  {{DESKTOP_DIR}}/e2e/contracts/ui-elements.yaml + testids.ts (Agent A)
  components/{composer,chat,settings,sidebar,top-bar,session-actions,
  command-palette,profiles,mcp,projects}/, routes/*.tsx

MISSION:
1. INFRA: add @testing-library/react + user-event (devDeps) if absent;
   create web/src/test-utils/ with: renderWithProviders() (router + query
   client + jotai stores), msw (Mock Service Worker) server preloaded with
   handlers generated from Agent A's backend-api.yaml (default 200 shapes),
   and step() helper so tests read as explicit step-by-step scripts:
   await step("user types message", () => user.type(composer(), "hello")).
2. COVERAGE: for every interactive element in ui-elements.yaml, one test
   that (a) renders it, (b) performs its primary interaction via user-event
   (click, type, keyboard, paste, drag where applicable), (c) asserts the
   triggered function call (msw intercepted request and/or store transition)
   and (d) asserts the rendered consequence (label text, disabled state,
   list update). Priority suites:
   - COMPOSER: text area input incl. multiline/IME-safe composition events,
     send button enable/disable, Enter vs Ctrl+Enter submit-shortcut matrix,
     queue panel edit/send-now/delete buttons, reasoning-effort menu,
     url dialog open/confirm/cancel, image paste (clipboard event →
     attachment chip), voice button states.
   - CHAT VIEW: message list renders user/assistant rows with correct
     data-role, streaming placeholder updates, 朗读回复 (read-aloud) button,
     code-block copy button, scroll-to-bottom behavior.
   - SIDEBAR & SESSION ACTIONS: new-chat button, session list select,
     rename inline-edit, delete confirm dialog, pin/archive.
   - SETTINGS: every toggle flips store + fires PUT; provider validate
     button shows spinner→result; model picker select; oauth start button.
   - COMMAND PALETTE: Ctrl+K opens, fuzzy filter selects, Enter executes.
   - MCP / SKILLS / CRON / PROFILES / PROJECTS routes: primary buttons,
     forms, and confirm dialogs per registry.
   - LABELS & DISPLAY: status badges, health subtitle, connection-auth
     banner — assert text from mocked store states (render correctness).
3. CONVENTIONS: jsdom + headless; no real timers where debounce involved
	   (vi.useFakeTimers with explicit advance); network only via msw; each
	   test file maps 1:1 to a component/route and lists the registry keys it
	   covers in a header comment.
4. SELF-HEALING: After writing all test files above, run the full Vitest
	   suite (cd {{DESKTOP_DIR}} && pnpm --filter @hermes/web test:unit). If
	   any test fails, diagnose the root cause, fix it (test or production code,
	   flagging production diffs per P0 rule 7), and re-run. Repeat until
	   every ACCEPTANCE command below exits 0. Do NOT silence or skip failing
	   tests — fix the underlying issue.

	ACCEPTANCE:
  cd {{DESKTOP_DIR}} && pnpm --filter @hermes/web test:unit     # all green incl. new suites
  pnpm --filter @hermes/web typecheck
  Registry coverage script (web/src/test-utils/check-registry-coverage.mjs)
  exits 0: every interactive key in ui-elements.yaml covered or explicitly
  deferred to Agent G with reason.

NON-GOALS: visual regression, pixel snapshots, real backend (that's Agent
G), Tauri APIs (mock @tauri-apps/* modules in test-utils/tauri-mock.ts).

FUTURE-COMPATIBILITY: all queries via role/accessible-name or
data-testid from e2e/testids.ts; Chinese strings only via the shared
locators module (web/src/test-utils/locators.ts) so a copy change updates
one file.
"""


# ═══════════════════════════════════════════════════════════════════════
# §6 — Wave 3: Agent G — Full-Stack Playwright E2E Suites
# ═══════════════════════════════════════════════════════════════════════

AGENT_G_RAW: str = """\
ROLE: E2E suite author. Drive the REAL web UI through headless Chromium
against the REAL Core dashboard + fake LLM — the complete GUI→backend
closed loop — expanding the existing e2e package into full route coverage.

OWNERSHIP:
  {{DESKTOP_DIR}}/e2e/specs/
  {{DESKTOP_DIR}}/e2e/pages/          (new: page objects)
  {{DESKTOP_DIR}}/e2e/fixtures/       (extend)

READ FIRST:
  Existing e2e/ package end-to-end (README, playwright.config.ts, harness/,
  specs/*) — EXTEND it, don't rewrite.
  {{DESKTOP_DIR}}/e2e/contracts/coverage-matrix.yaml (Agent A)
  web/src/routes/* and testids.ts

MISSION:
1. PAGE-OBJECT LAYER (e2e/pages/): one class per route (ChatPage,
   HistoryPage, SettingsPage, McpPage, SkillsPage, CronPage, ProfilesPage,
   ProjectsPage, MemoryPage, ConsolePage, LogsPage, GuidePage, …) exposing
   intention-revealing async methods (chat.send(text), settings.toggleEnv(),
   cron.createJob(...)) built ONLY on role/accessible-name + T.* testids.
   All Chinese accessible names centralized in e2e/pages/locators.ts.
2. SPEC SUITES (serial, deterministic, one user story each):
   - chat-loop.spec.ts + image-paste.spec.ts: keep green, refactor onto
     page objects.
   - session-lifecycle.spec: new chat → rename in sidebar → reload page →
     history restores → fork → delete → 404-safe empty state.
   - composer-deep.spec: queued messages (edit/send-now/delete), draft
     persistence across route nav, multiline paste, IME composition events,
     keyboard submit matrix, URL attach dialog.
   - streaming-ui.spec: long marker reply renders progressively (assert
     intermediate DOM states, not just final), stop-generation button
     mid-stream → partial reply persisted, auto-scroll pinned to bottom.
   - settings-roundtrip.spec: change env var → reload → persisted; theme
     toggle; font select; model picker → /api/model/set fired → badge updates.
   - provider-onboarding.spec (extend model-onboarding.spec): custom
     endpoint wizard → validate (fake /v1/models) → activate → chat works.
   - mcp.spec: add server (stub MCP) → enable toggle → test button green →
     tools listed; disable → gone from chat tool list.
   - skills.spec: toggle bundled skill, edit content, hub install from
     fixture hub, provenance badges (extend skills-provenance.spec).
   - cron.spec: create job with schedule → run now → run history row →
     pause → resume → delete; delivery-target select.
   - projects/workspaces.spec: create project, set cwd via fs browser
     dialog, worktree add/remove buttons.
   - console-logs.spec: console page streams lines via /api/console WS,
     logs page filter input + level select.
   - error-surfaces.spec: kill fake model → chat shows retryable error
     banner (not a crash); restore → retry succeeds. Backend down →
     connection-auth banner → offline-shell.
   - accessibility-smoke.spec: every page object's primary controls
     reachable by keyboard Tab order; axe-core scan with zero critical
     violations (add @axe-core/playwright).
3. HARNESS HARDENING: keep workers=1 (shared backend); add per-spec
	   HERMES_HOME namespacing if cross-test state appears; trace/video retain
	   on failure already configured — verify artifacts land in CI.
4. SELF-HEALING: After writing all spec files and page objects above, run the
	   full Playwright E2E suite (cd {{DESKTOP_DIR}} && pnpm test:e2e). If any
	   test fails, diagnose the root cause, fix it (test or production code,
	   flagging production diffs per P0 rule 7), and re-run. Repeat until
	   every ACCEPTANCE command below exits 0. Do NOT silence or skip failing
	   tests — fix the underlying issue.

	ACCEPTANCE:
  cd {{DESKTOP_DIR}} && pnpm test:e2e            # full suite green, headless
  pnpm test:e2e:smoke
  CI=true pnpm --filter @hermes/e2e test         # github reporter path green
  10 consecutive runs with zero flakes; suite wall time < 15 min.

NON-GOALS: Tauri window/Rust shell automation, real LLM runs (documented
opt-in only via harness config note that already exists), mobile viewports.

FUTURE-COMPATIBILITY: zero selectors in spec files (only in page objects);
page objects assert structure/behavior, not pixel layout; every spec tagged
@smoke/@full so CI can gate PRs on @smoke and run @full nightly.
"""


# ═══════════════════════════════════════════════════════════════════════
# §6 — Wave 3: Agent H — Orchestration, Scriptable Runner & CI Gating
# ═══════════════════════════════════════════════════════════════════════

AGENT_H_RAW: str = """\
ROLE: Release engineer for the test system. One command runs everything;
CI gates on it; reports are machine-consumable.

OWNERSHIP:
  {{DESKTOP_DIR}}/e2e/runner/          (new orchestrator)
  {{DESKTOP_DIR}}/.github/workflows/e2e.yml
  {{CORE_DIR}}/.github/workflows/  (extend tests.yml only if absent steps)
  Root package.json scripts (additive)

READ FIRST:
  e2e/harness/*, playwright.config.ts, package.json scripts
  {{CORE_DIR}}/scripts/run_tests_parallel.py

MISSION:
1. UNIFIED RUNNER (e2e/runner/run.mjs, zero-dep Node ESM):
   `node e2e/runner/run.mjs [--tier smoke|full] [--only backend|frontend|e2e]
   [--core-dir X] [--json]`. Responsibilities:
   - Pre-flight: verify {{CORE_DIR}} venv (HERMES_CORE_PYTHON override),
     pnpm deps, playwright chromium; print actionable errors, exit 2.
   - Boot order: fake model → Core dashboard (reuse harness/start-backend.mjs
     as a module) → Vite → wait-for-ready (harness/wait.mjs) → run selected
     suites in fixed order (Core pytest → Vitest → Playwright) → teardown
     with SIGTERM→SIGKILL escalation and port-release verification.
   - Per-suite junit.xml + merged summary.json (counts, durations, failed
     step names) written to e2e/.runtime/reports/<timestamp>/.
   - Idempotent: stale .runtime cleaned; ports probed and freed or failed
     fast with PID printed.
2. ROOT SCRIPTS (additive, no existing script modified):
   "test:e2e:system": "node e2e/runner/run.mjs --tier full"
   "test:e2e:system:smoke": "node e2e/runner/run.mjs --tier smoke"
3. GITHUB ACTIONS e2e.yml: matrix {os: [ubuntu-latest, windows-latest],
   tier: [smoke on PR, full nightly]}; cache pnpm + pip + playwright
   browsers; upload junit + playwright-report + traces on failure; Core
   repo checked out as sibling via actions/checkout repository=
   Eynzof/Hermes-CN-Core + pip install -e .; concurrency cancel-in-progress.
4. FLAKE QUARANTINE: runner detects repeat failures across reruns, moves
   them to e2e/.runtime/quarantine.json, exits non-zero with quarantine
   report; quarantined tests listed in summary, never silently skipped.
5. DOCS: e2e/SYSTEM.md — architecture diagram (ASCII), one-command usage,
   tier definitions, env var reference, how to add a spec (checklist).

ACCEPTANCE:
  cd {{DESKTOP_DIR}} && node e2e/runner/run.mjs --tier smoke --json   # exit 0, summary.json valid
  node e2e/runner/run.mjs --only backend                              # pytest tier only, green
  Act/Dry-run the workflow YAML (actionlint clean); a PR comment shows
  the github-reporter annotations path works.

NON-GOALS: deploying anything, test impact analysis, rewriting existing
harness scripts (import them).

FUTURE-COMPATIBILITY: runner reads suite definitions from
e2e/runner/suites.yaml (declarative: name, cwd, command, tier, timeout) —
adding a suite = 4 lines of YAML, zero JS.
"""


# ═══════════════════════════════════════════════════════════════════════
# §7 — Wave 4: Agent I — Contract Drift Detection & Suite Governance
# ═══════════════════════════════════════════════════════════════════════

AGENT_I_RAW: str = """\
ROLE: Gardener. Make the suite survive the future: when the backend adds an
endpoint or the UI renames a button, the system tells you exactly which
tests to touch — or regenerates the boring parts itself.

OWNERSHIP:
  {{DESKTOP_DIR}}/e2e/contracts/drift/          (new)
  {{DESKTOP_DIR}}/.github/workflows/drift.yml
  {{DESKTOP_DIR}}/web/eslint rules config (additive override file only)

READ FIRST:
  Agent A extractor + manifests, Agent D coverage checker,
  e2e/runner/suites.yaml

MISSION:
1. DRIFT CHECKER (e2e/contracts/drift/check.mjs): regenerates the backend
   manifest (runs Agent A extractor against the checked-out Core) and the
   UI registry, diffs against committed YAMLs, and emits:
   - endpoints added → list + suggested test stub file (auto-generate
     compilable stubs with TODO assertions into a scratch dir),
   - endpoints removed/changed → list of affected test files (via the
     manifest-referencing convention from Agent D),
   - UI elements added/renamed → affected page objects + registry keys.
   Exit 1 on drift, 0 when clean; --update flag regenerates committed
   manifests in one PR-able shot.
2. CI GATE drift.yml: runs the checker on PRs touching
   {{CORE_DIR}}/hermes_cli/web_server.py, gateway/platforms/api_server.py,
   or web/src/**; posts the diff as a PR comment; required status check.
3. SELECTOR LINT: eslint override forbidding raw CSS-selector strings and
   hardcoded Chinese literals inside e2e/specs/** and web/**/__tests__/**
   (must come from page objects / locators.ts / testids.ts). Provide the
   config + autofix hints; wire into pnpm lint.
4. TESTID BACKFILL BOT (script, not CI): scans ui-elements.yaml keys
   lacking data-testid in source, opens a single stacked diff adding
   data-testid={T.<key>} attributes to those JSX elements (mechanical codemod
   via ts-morph); human merges.
5. GOVERNANCE DOC e2e/GOVERNANCE.md: when Core adds an endpoint → run
   extractor --update → implement stub → done; when UI copy changes →
   update locators.ts → done; quarterly fake-model conformance re-check.

ACCEPTANCE:
  cd {{DESKTOP_DIR}} && node e2e/contracts/drift/check.mjs        # exit 0 on clean tree
  # add a dummy @app.get route to web_server.py → checker exits 1 and names it
  pnpm lint                                                       # selector lint active
  actionlint .github/workflows/drift.yml

NON-GOALS: auto-merging anything, runtime monitoring, mutation testing.

FUTURE-COMPATIBILITY: the checker is language-agnostic about future
channels — new WS channels land in ws-channels.yaml and get the same
diff treatment; schema_version bumps are handled by a migration note in
GOVERNANCE.md.
"""


# -- Prompt registry ---------------------------------------------------
# All raw templates are filled at call time via _compile_prompts().

_RAW_PROMPTS: dict[str, str] = {}


def _register_prompts() -> None:
    """Register all raw prompt templates into _RAW_PROMPTS dict."""
    _RAW_PROMPTS["P0"] = P0_RAW
    _RAW_PROMPTS["A"] = AGENT_A_RAW
    _RAW_PROMPTS["B"] = AGENT_B_RAW
    _RAW_PROMPTS["C"] = AGENT_C_RAW
    _RAW_PROMPTS["D"] = AGENT_D_RAW
    _RAW_PROMPTS["E"] = AGENT_E_RAW
    _RAW_PROMPTS["F"] = AGENT_F_RAW
    _RAW_PROMPTS["G"] = AGENT_G_RAW
    _RAW_PROMPTS["H"] = AGENT_H_RAW
    _RAW_PROMPTS["I"] = AGENT_I_RAW


_register_prompts()
FILLED: dict[str, str] = {}


def _compile_prompts() -> None:
    """Apply fill() to every raw prompt template and store in FILLED."""
    for key, raw in _RAW_PROMPTS.items():
        FILLED[key] = fill(raw)


# ═══════════════════════════════════════════════════════════════════════
# Orchestrator — Wave runner with parallel agents
# ═══════════════════════════════════════════════════════════════════════

_results: dict[str, bool] = {}
_lock = threading.Lock()


def _run_agent(name: str, prompt_text: str) -> None:
    """Run a single agent in its own session and record success/failure."""
    session = None
    try:
        print_info(f"[{name}] Creating session...")
        session = create_session(agent_type=SystemPromptType.Worker)
        print_info(f"[{name}] Starting work...")
        prompt(prompt_text, session=session, ensure_todo_finished=True)
        with _lock:
            _results[name] = True
        print_success(f"[{name}] Completed successfully.")
    except Exception as exc:
        with _lock:
            _results[name] = False
        print_error(f"[{name}] Failed: {exc}")
    finally:
        if session is not None:
            close_session(session)


def run_wave(
    wave_label: str,
    agents: list[tuple[str, str]],
    depends_on: list[str] | None = None,
) -> bool:
    """Run a wave of agents in parallel. Optionally check dependencies first."""
    print_info(f"\n{'='*60}")
    print_info(f"Starting {wave_label}")
    print_info(f"{'='*60}\n")

    # Verify dependencies if any
    if depends_on:
        print_info(f"Verifying dependencies: {depends_on}")
        for dep in depends_on:
            if not _results.get(dep, False):
                print_error(f"Dependency {dep} has not completed successfully. Aborting {wave_label}.")
                return False
        print_success("All dependencies satisfied.\n")

    threads: list[threading.Thread] = []
    for name, prompt_text in agents:
        t = threading.Thread(target=_run_agent, args=(name, prompt_text), daemon=True)
        t.start()
        threads.append(t)

    for t in threads:
        t.join()

    # Check results
    all_ok = True
    for name, _ in agents:
        if not _results.get(name, False):
            print_error(f"[{name}] FAILED")
            all_ok = False
        else:
            print_success(f"[{name}] PASSED")

    if all_ok:
        print_success(f"\n{wave_label} — ALL AGENTS PASSED\n")
    else:
        print_error(f"\n{wave_label} — SOME AGENTS FAILED\n")

    return all_ok


def main() -> int:
    # -- Parse CLI args --
    parser = argparse.ArgumentParser(
        description="Hermes-CN Headless E2E Testing System — Kimix Orchestrator"
    )
    parser.add_argument(
        "--backend",
        required=True,
        help="Path to the Hermes-CN-Core backend repository (e.g. C:/dev/Hermes-CN-Core)",
    )
    args = parser.parse_args()

    # -- Resolve paths – frontend from __file__, backend from CLI arg --
    resolve_vars(args.backend)
    _compile_prompts()

    # -- Initialize Kimix (Optional, you may run this in kimix cli) --
    # init(
    #     config_json=r'''
    #     {
    #         "model": "deepseek-v4-flash",
    #         "max_context_size": 1048576,
    #         "capabilities": ["thinking"],
    #         "url": "https://api.deepseek.com",
    #         "type": "openai_legacy",
    #         "api_key": "sk-xxx",
    #         "thinking_effort": "max"
    #     }
    #     ''',
    #     yolo=True,
    #     think=True,
    # )

    print_info("Hermes-CN E2E Orchestrator Starting...")
    print_info(f"Core Dir:     {VARS['CORE_DIR']}")
    print_info(f"Desktop Dir:  {VARS['DESKTOP_DIR']}")
    print_info(f"Fake Model:   :{VARS['FAKE_MODEL_PORT']}")
    print_info(f"Dashboard:    :{VARS['DASHBOARD_PORT']}")
    print_info(f"Vite:         :{VARS['VITE_PORT']}")
    print_info(f"Branch Prefix: {VARS['BRANCH_PREFIX']}")

    # ═══════════════════════════════════════════════════════════════
    # Wave 1 — Foundation Agents (parallel)
    # ═══════════════════════════════════════════════════════════════
    ok = run_wave(
        "Wave 1 — Foundation",
        [
            ("A", FILLED["P0"] + "\n\n" + FILLED["A"]),
            ("B", FILLED["P0"] + "\n\n" + FILLED["B"]),
        ],
    )
    if not ok:
        print_error("Wave 1 failed — cannot proceed.")
        return 1

    # ═══════════════════════════════════════════════════════════════
    # Wave 2 — Backend Coverage & Frontend Component (parallel)
    #   depends-on: A, B
    # ═══════════════════════════════════════════════════════════════
    ok = run_wave(
        "Wave 2 — Backend & Frontend Coverage",
        [
            ("C", FILLED["P0"] + "\n\n" + FILLED["C"]),
            ("D", FILLED["P0"] + "\n\n" + FILLED["D"]),
            ("E", FILLED["P0"] + "\n\n" + FILLED["E"]),
            ("F", FILLED["P0"] + "\n\n" + FILLED["F"]),
        ],
        depends_on=["A", "B"],
    )
    if not ok:
        print_error("Wave 2 failed — cannot proceed.")
        return 1

    # ═══════════════════════════════════════════════════════════════
    # Wave 3 — Full-Stack E2E & Orchestration (parallel)
    #   depends-on: C, D, E, F
    # ═══════════════════════════════════════════════════════════════
    ok = run_wave(
        "Wave 3 — E2E Suites & CI",
        [
            ("G", FILLED["P0"] + "\n\n" + FILLED["G"]),
            ("H", FILLED["P0"] + "\n\n" + FILLED["H"]),
        ],
        depends_on=["C", "D", "E", "F"],
    )
    if not ok:
        print_error("Wave 3 failed — cannot proceed.")
        return 1

    # ═══════════════════════════════════════════════════════════════
    # Wave 4 — Future-Compatibility Governance
    #   depends-on: G, H
    # ═══════════════════════════════════════════════════════════════
    ok = run_wave(
        "Wave 4 — Drift & Governance",
        [
            ("I", FILLED["P0"] + "\n\n" + FILLED["I"]),
        ],
        depends_on=["G", "H"],
    )
    if not ok:
        print_error("Wave 4 failed.")
        return 1

    # ═══════════════════════════════════════════════════════════════
    # §9 — Definition of Done summary
    # ═══════════════════════════════════════════════════════════════
    print_success("\n" + "=" * 60)
    print_success("ALL WAVES COMPLETE")
    print_success("=" * 60 + "\n")
    print_info("Definition of Done checklist:")
    print_info("  1. node e2e/runner/run.mjs --tier full exits 0")
    print_info("  2. Manifest coverage checkers report 100%")
    print_info("  3. Drift checker green")
    print_info("  4. 10/10 consecutive full-suite runs pass")
    print_info("  5. All reports archived per run")

    return 0


main()
