"""hermes_embedded — in-process embedding entry package (refactor_report.md).

This is the Python side of the Rust ↔ Python Hard FFI surface. The desktop's
Rust process embeds CPython and calls these functions directly through the
CPython C ABI (pyo3); **no HTTP/WS is used between Rust and Python**.

Contract with the Rust bridge (src/embedded/):
- ``ffi_surface_version`` must equal the Rust ``FFI_SURFACE_VERSION``.
- REST routes map to ``handle_<router>(params: dict, ctx: dict)``.
- Gateway JSON-RPC methods map to ``handle_rpc(method, params, ctx)``.
- Events flow Rust-ward through ``RustBridgeTransport`` (rust_transport.py).

In the production Core repo this package lives under Hermes-CN-Core and imports
``hermes_cli`` / ``tui_gateway``; this copy in the desktop repo is the
self-contained reference implementation used for the Phase 0 spike and CI.
"""

from .api import (
    FFI_SURFACE_VERSION,
    ffi_surface_version,
    get_version,
    handle_rpc,
    handle_session,
    handle_prompt,
    handle_model,
    handle_skills,
    handle_tools,
    handle_mcp,
    handle_cron,
    handle_messaging,
    handle_pairing,
    handle_git,
    handle_profiles,
    handle_analytics,
    get_gateway_config,
    get_status,
    get_config,
)

__all__ = [
    "FFI_SURFACE_VERSION",
    "ffi_surface_version",
    "get_version",
    "handle_rpc",
    "handle_session",
    "handle_prompt",
    "handle_model",
    "handle_skills",
    "handle_tools",
    "handle_mcp",
    "handle_cron",
    "handle_messaging",
    "handle_pairing",
    "handle_git",
    "handle_profiles",
    "handle_analytics",
    "get_gateway_config",
    "get_status",
    "get_config",
]
