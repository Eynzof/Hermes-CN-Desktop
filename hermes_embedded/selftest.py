"""Self-test for the embedded FFI surface — run with:

    python -m hermes_embedded.selftest

Verifies the Rust ↔ Python contract pieces that can be checked without a Rust
process: FFI surface version, unified handle_rpc dispatch, and the
RustBridgeTransport write/close semantics.
"""

from __future__ import annotations

import json
import sys

from .api import FFI_SURFACE_VERSION, get_version, handle_rpc
from .rust_transport import RustBridgeTransport

EXPECTED_RUST_FFI_SURFACE_VERSION = "0.2.0"  # src/embedded/mod.rs::FFI_SURFACE_VERSION


def main() -> int:
    failures: list[str] = []

    if FFI_SURFACE_VERSION != EXPECTED_RUST_FFI_SURFACE_VERSION:
        failures.append(
            f"ffi_surface_version mismatch: python={FFI_SURFACE_VERSION} "
            f"rust={EXPECTED_RUST_FFI_SURFACE_VERSION}"
        )

    if get_version() != "0.8.0-rc4":
        failures.append("get_version() returned an unexpected value")

    result = handle_rpc("get_version", "{}", "{}")
    if result != "0.8.0-rc4":
        failures.append(f"handle_rpc('get_version') -> {result!r}")

    result = handle_rpc("prompt.submit", json.dumps({"text": "hi"}), json.dumps({"hermesHome": "/x"}))
    if not isinstance(result, dict) or not result.get("accepted"):
        failures.append(f"handle_rpc('prompt.submit') -> {result!r}")

    try:
        handle_rpc("definitely.not.a.method", "{}", "{}")
        failures.append("handle_rpc accepted an unknown method")
    except ValueError:
        pass

    frames: list[dict] = []
    transport = RustBridgeTransport(frames.append)
    if transport.write({"type": "message", "payload": {"text": "hi"}}) is not True:
        failures.append("transport.write did not return True")
    if transport.write("plain string frame") is not True:
        failures.append("transport.write(string) did not return True")
    transport.close()
    if transport.write({"type": "x"}) is not False:
        failures.append("transport.write after close did not return False")
    if len(frames) != 2:
        failures.append(f"transport delivered {len(frames)} frames, expected 2")

    if failures:
        print("FAIL:", *failures, sep="\n  - ", file=sys.stderr)
        return 1
    print(
        f"OK: hermes_embedded selftest passed "
        f"(ffi_surface_version={FFI_SURFACE_VERSION})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
