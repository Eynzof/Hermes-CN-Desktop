# Embedded Python Runtime (In-process CPython + Hard FFI)

> Status: implementation milestone (refactor_report.md Phase 0/1 + Phase 4 延伸
> scaffolding). Design doc: `refactor_report.md`.

## What this is

The desktop previously spawned a PyInstaller `hermes` subprocess and talked to
its FastAPI dashboard over loopback HTTP/WebSocket (REST proxy + WS relay).
This refactor replaces that transport with **in-process embedding + C FFI**:

```text
BEFORE:  Rust ──spawn──▶ hermes.exe ──HTTP/WS(9120)──▶ Rust proxy ──▶ WebView
AFTER:   Rust ──embed CPython──▶ hermes_embedded.api ──pyo3 FFI──▶ WebView
```

In embedded mode there is **zero HTTP** between Rust and Python: no
`9120/8644/8645` listeners, no reqwest proxy pass, no tokio-tungstenite relay.
REST routes map to FFI entries (`src/embedded/ffi.rs`) and Gateway JSON-RPC
frames flow through an in-memory Rust-backed transport
(`src/embedded/transport.rs`). Remote Hermes Agent and attach-to-external
`local` modes keep their HTTP/WS paths (external processes cannot be embedded).

## Architecture

| Layer | File | Role |
|---|---|---|
| Lifecycle / payload | `src/embedded/mod.rs`, `src/process/python_runtime.rs` | locate payload, init/finalize interpreter, status, `HERMES_DESKTOP_EMBEDDED_PYTHON=0` opt-out |
| FFI call wrapper | `src/embedded/call.rs` | `Python::attach` → import → `call1` → `json.dumps` → `serde_json::Value`; PyErr → `AppError::EmbeddedPython` |
| FFI registry | `src/embedded/ffi.rs` | REST route/method → Python function map + 100% coverage gate |
| Event bus | `src/embedded/events.rs` | structured PyDict→serde events → broadcast + `gateway-ws-message` emit |
| Gateway transport | `src/embedded/transport.rs` | `EmbeddedGatewaySession`: JSON-RPC frame dispatch, response emit, session.resume semantics |
| REST dispatch | `src/embedded/api.rs` | `api_request` embedded branch: local intercepts stay in Rust, everything else goes FFI |
| Python side | `hermes_embedded/` | `api.py` (full FFI surface + `handle_rpc`), `rust_transport.py` (Transport Protocol), `selftest.py` |

## Feature model

The pyo3 backend is behind the optional `embedded-python` cargo feature (NOT in
default features — it links libpython, which CI runners without Python dev
headers should not be forced to do):

```bash
# Default build/tests: embedded architecture with stub backend
cargo test

# Real interpreter (requires CPython 3.14 + PYO3_PYTHON or python3 on PATH)
cargo test --features embedded-python --test embedded_python
python -m hermes_embedded.selftest
```

`EmbeddedPython::ensure_started` returns `false` (and the app falls back to the
subprocess managed runtime) when:
- `HERMES_DESKTOP_EMBEDDED_PYTHON=0` is set,
- no payload is found, or
- the interpreter fails to start / the FFI surface version mismatches.

## Payload

The embedded runtime reuses the PyInstaller payload the managed runtime already
ships (`static/bundled-runtime/…zip → _internal`). Payload resolution order
(`resolve_payload_root`):

1. `HERMES_DESKTOP_EMBEDDED_PAYLOAD` (explicit dev override)
2. `static/embedded-python` (staged Tauri resource)
3. `static/bundled-runtime/<platform>-<arch>/_internal`
4. a `hermes_embedded` package next to the desktop source (dev spike, repo root)

The Python-side package must define `ffi_surface_version`; it is checked
against the Rust `FFI_SURFACE_VERSION` at startup, exactly like
`EXPECTED_BACKEND_VERSION` (report §8 success criteria 11).

## Frontend contract

- `get_runtime_config` returns `embedded: true` and `apiBaseUrl:
  "embedded://local"` (placeholder; no socket is bound).
- `transport.ts` forces native IPC (`hermesDesktop.request`) in embedded mode.
- `gateway-socket-path.ts` forces the Rust relay in embedded mode (no `ws://`
  exists); `gateway-relay-socket.ts` is unchanged.
- `runtime.isEmbedded()` exposes the flag to UI code.

## CI gates

`rust-test.yml`:
- default job: `cargo test` (no `--all-features`), FFI coverage test, and the
  **no-http deny** grep over `src/embedded/` (`asgi|uvicorn|reqwest|tungstenite`
  must be empty — success criteria 8).
- embedded job: installs `python3-dev`, runs `hermes_embedded.selftest` +
  `cargo check/test --features embedded-python`.

## Current status / not yet implemented

Implemented in this milestone:
- Full `src/embedded/` architecture: lifecycle (`mod.rs`), unified FFI call
  wrapper (`call.rs`), typed hot-path wrappers (`rpc.rs`), FFI registry +
  coverage gate (`ffi.rs`), structured event bus (`events.rs`), in-memory
  gateway transport (`transport.rs`), REST dispatch (`api.rs`), payload
  management (`src/process/python_runtime.rs`).
- Frontend version gate in embedded mode: `get_backend_version` IPC command +
  `version-check.ts` reads the Core version from Python (no HTTP), aligned with
  `EXPECTED_BACKEND_VERSION` (criterion 3 + 11).
- FFI coverage gate compares against the concrete proxy-pass route list
  (`PROXY_PASS_ROUTES`, criterion 9) with a CI step.
- Staging: `scripts/stage-bundled-runtime.mjs --embedded-payload` +
  `scripts/stage-embedded-payload.mjs` produce `static/embedded-python/`;
  dev scripts (`tauri-dev-managed.mjs`, `install-local-runtime.mjs`) support
  embedded mode via `HERMES_DESKTOP_EMBEDDED_PYTHON=1`;
  `release-desktop.yml` stages the payload in the release build.

Not yet implemented (documented follow-ups):
- Real PyInstaller `_internal` payload production end-to-end (the payload
  layout is staged; the interpreter runs against the reference `hermes_embedded`
  package in dev).
- Core `hermes_cli` / `tui_gateway` integration: the reference
  `hermes_embedded` package in this repo is self-contained; production usage
  should import the real Core handlers (Core-side `pyproject.toml` packaging,
  `tui_gateway` stdio/cwd audit, real-backend E2E suite are out of this repo).
- Free-threaded CPython 3.14 runtime verification (the bridge uses
  `Python::attach` + `std::sync::OnceLock` — no GIL-as-sync-primitive
  assumption — but a free-threaded build matrix has not been exercised).
- Playwright embedded E2E suite (needs a real Core embedding harness).
- The Phase 2 in-process ASGI bridge (`src/embedded/asgi.rs`,
  `hermes_embedded/asgi_bridge.py`) is intentionally **not** implemented — per
  report §3.7/Phase 6A it is a migration tool that the Hard FFI end-state
  deletes; this repo implements the terminal state directly.
