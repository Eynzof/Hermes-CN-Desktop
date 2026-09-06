Embedded Python Runtime (In-process CPython + Hard FFI)

> Status: experimental, opt-in development path. The Python FFI surface lives in the Hermes-CN-Core
> repo (the desktop repo's old self-contained reference package was deleted);
> it drives the REAL Core handlers — no canned demo responses.

What this is

The desktop normally spawns a PyInstaller hermes subprocess and talks to
its FastAPI dashboard over loopback HTTP/WebSocket (REST proxy + WS relay).
The experimental mode replaces that transport with in-process embedding + C FFI:

```text
Tauri / Rust → PyO3 / CPython → hermes_embedded → Core REST + Gateway handlers
```

In embedded mode there is zero HTTP between Rust and Python: no
9120/8644/8645 listeners, no proxy pass, no TCP WebSocket relay. REST routes
map to FFI entries (src/embedded/ffi.rs); each one drives the REAL
hermes_cli.web_server FastAPI application through an in-process ASGI call.
Gateway JSON-RPC frames flow through the real tui_gateway.server dispatcher
with an in-memory Rust-backed transport. Remote Hermes Agent and
attach-to-external local modes keep their HTTP/WS paths (external processes
cannot be embedded).

Where the Python side lives

The `hermes_embedded` package lives in the Hermes-CN-Core checkout
(e.g. ../Hermes-CN-Core/hermes_embedded, or the in-repo hermes_backend/
checkout). The desktop repo no longer carries a package — the old reference
implementation (canned 「（嵌入式演示模式）…」 replies) was merged into Core and
replaced with real delegation.

| File (in Core) | Role |
|---|---|
| hermes_embedded/api.py | Full FFI surface: REST routers → real app, gateway methods → real tui_gateway.server, handle_rpc unified entry |
| hermes_embedded/rust_transport.py | RustBridgeTransport: event frames → Rust bridge; long-handler responses resolve pending FFI slots; per-connection registry |
| hermes_embedded/asgi_dispatch.py | In-process ASGI driver for web_server.app (no sockets); pins HERMES_HOME / HERMES_PROFILE / HERMES_DASHBOARD_SESSION_TOKEN |
| hermes_embedded/selftest.py | python -m hermes_embedded.selftest — contract + real-app + real-gateway checks |

Architecture

| Layer | File | Role |
|---|---|---|
| Lifecycle / payload | src/embedded/mod.rs, src/process/python_runtime.rs | locate payload, init/finalize interpreter, status, HERMES_DESKTOP_EMBEDDED_PYTHON=0 opt-out |
| FFI call wrapper | src/embedded/call.rs | Python::attach → import → call → json → serde_json::Value; PyErr → AppError::EmbeddedPython; installs the bridge module |
| Python → Rust bridge | src/embedded/bridge.rs | `_hermes_desktop_bridge.publish_event` in sys.modules; routes gateway frames into the event bus + `gateway-ws-message` |
| FFI registry | src/embedded/ffi.rs | REST route/method → Python function map + 100% coverage gate |
| Event bus | src/embedded/events.rs | structured events → broadcast + gateway-ws-message emit |
| Gateway transport | src/embedded/transport.rs | EmbeddedGatewaySession: JSON-RPC frame dispatch, response emit, gateway.connect/disconnect lifecycle |
| REST dispatch | src/embedded/api.rs | api_request embedded branch: local intercepts stay in Rust, everything else goes FFI |
| Python side | <Core>/hermes_embedded/ | real delegation package (see above) |

How the real delegation works

REST
    `handle_rpc("handle_env", ...)` → asgi_dispatch builds a synthetic ASGI
    scope (with the session-token header) and calls web_server.app directly —
    every mounted web_routers.* APIRouter included. The response body is
    returned through the FFI boundary; binary media responses are wrapped as
    data URLs. No socket is created anywhere on this path.

Gateway
    `handle_rpc("session.create" | "prompt.submit" | ...)` →
    tui_gateway.server.dispatch(req, transport) — the exact entry the
    dashboard WebSocket uses. Inline handlers return their response;
    long handlers (session.list/resume, model.options, complete.*, ...) write
    it through the transport and the pending FFI slot resolves. Agent turn
    events stream to the WebView through the Rust bridge in real time, so
    prompt.submit returns the real `{"status":"streaming"}` and the desktop
    never synthesizes stub turns.

Connection lifecycle
    `gateway.connect` / `gateway.disconnect` (called by Rust on webview
    gateway open/close) mirror tui_gateway.ws.handle_ws: bind the per-
    connection transport, register it for global broadcasts, emit
    `gateway.ready`; on close, unregister + release wake state + reap the
    connection's sessions.

Feature model

The pyo3 backend is behind the optional embedded-python cargo feature (NOT in
default features — it links libpython, which CI runners without Python dev
headers should not be forced to do):

```toml
[features]
default = []
embedded-python = ["dep:pyo3"]

[dependencies]
pyo3 = { version = "0.29", features = ["auto-initialize"], optional = true }
```

EmbeddedPython::ensure_started returns false (and the app falls back to the
subprocess managed runtime) when:
- HERMES_DESKTOP_EMBEDDED_PYTHON=0 is set,
- no payload is found, or
- the interpreter fails to start / the FFI surface version mismatches.

Payload

Payload resolution order (resolve_payload_root):

1. HERMES_DESKTOP_EMBEDDED_PAYLOAD (explicit override; run.py --embedded sets it)
2. static/embedded-python (staged Tauri resource)
3. static/bundled-runtime/<platform>-<arch>/_internal
4. a hermes_embedded package next to the desktop source (Core checkout)

The Python-side package must define ffi_surface_version; it is checked
against the Rust FFI_SURFACE_VERSION ("0.2.0") at startup, exactly like
EXPECTED_BACKEND_VERSION. The embedded get_version returns the REAL
hermes_cli.__version__, so dev launches via run.py set
VITE_HERMES_SKIP_VERSION_CHECK=1 when the baked desktop constant lags the
Core checkout being embedded.

Frontend contract

- get_runtime_config returns embedded: true and apiBaseUrl:
  "embedded://local" (placeholder; no socket is bound).
- transport.ts forces native IPC (hermesDesktop.request) in embedded mode.
- gateway-socket-path.ts forces the Rust relay in embedded mode (no ws://
  exists); gateway-relay-socket.ts is unchanged.
- runtime.isEmbedded() exposes the flag to UI code.

CI gates

rust-test.yml:
- default job: cargo test (no --all-features), FFI coverage test, and the
  no-http deny grep over src/embedded/ (asgi|uvicorn|reqwest|tungstenite
  must be empty — success criteria 8).
- embedded job: checks out Hermes-CN-Core (main), installs Core into the
  job interpreter (pip install -e), runs hermes_embedded.selftest from the
  Core checkout + cargo check/test --features embedded-python against the
  real payload (HERMES_DESKTOP_EMBEDDED_PAYLOAD).

Verification (local)

- python -m hermes_embedded.selftest   # from the Core checkout
- PYO3_PYTHON and PYTHONPATH must point at an interpreter where the Core
  dependencies are installed; `run.py --embedded` injects both automatically.
- cargo test --features embedded-python --test embedded_python -- --test-threads=1
- cargo test                            # default suite (embedded architecture)

Not yet implemented (documented follow-ups)

- Real PyInstaller _internal payload production end-to-end. Release installers
  continue to use the managed runtime until this is verified on every platform.
- Free-threaded CPython 3.14 runtime verification (the bridge uses
  Python::attach + std::sync::OnceLock — no GIL-as-sync-primitive
  assumption — but a free-threaded build matrix has not been exercised).
- Playwright embedded E2E suite (needs a real Core embedding harness).
- The Phase 2 in-process ASGI bridge (src/embedded/asgi.rs) is intentionally
  not implemented in Rust — the Python-side asgi_dispatch covers the same
  need inside the FFI surface, and src/embedded/ stays zero-HTTP by gate.
