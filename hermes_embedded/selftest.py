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
    # The reference package must return a *completed* turn payload (not Core's
    # {"status": "streaming"}): the Rust transport turns `reply` into
    # message.start + message.complete events, otherwise the GUI hangs on the
    # optimistic "正在唤醒Hermes..." progress (python run.py).
    if result.get("status") != "complete":
        failures.append(f"handle_rpc('prompt.submit') missing status='complete': {result!r}")
    if not isinstance(result.get("reply"), str) or not result["reply"].strip():
        failures.append(f"handle_rpc('prompt.submit') missing non-empty reply: {result!r}")

    # session.create / session.resume must return the Core tui_gateway shapes
    # (tui_gateway/methods_session.py) so the desktop zod schemas
    # (SessionCreateResult / SessionResumeResult) parse — they require a
    # top-level `session_id`. The old {"session":{"id":...}} shape made the
    # workbench 发送 flow fail after the RPC response arrived.
    created = handle_rpc(
        "session.create",
        json.dumps({"cwd": "C:/dev"}),
        json.dumps({"hermesHome": "/x"}),
    )
    if not isinstance(created, dict) or not isinstance(created.get("session_id"), str):
        failures.append(f"handle_rpc('session.create') -> {created!r} (needs session_id)")
    elif created.get("stored_session_id") != created["session_id"]:
        failures.append(f"handle_rpc('session.create') missing stored_session_id: {created!r}")
    resumed = handle_rpc(
        "session.resume",
        json.dumps({"session_id": "s1"}),
        json.dumps({"hermesHome": "/x"}),
    )
    if not isinstance(resumed, dict) or resumed.get("session_id") != "s1":
        failures.append(f"handle_rpc('session.resume') -> {resumed!r} (needs session_id=s1)")

    # prompt.abort is a gateway method with NO action/method param — it must be
    # answered as an abort, never fall into the submit path and fabricate a
    # complete turn (handle_prompt can't tell them apart; the dispatch table
    # routes prompt.abort to a dedicated handler).
    aborted = handle_rpc(
        "prompt.abort",
        json.dumps({"session_id": "s1"}),
        json.dumps({"hermesHome": "/x"}),
    )
    if not isinstance(aborted, dict) or aborted.get("aborted") is not True:
        failures.append(f"handle_rpc('prompt.abort') -> {aborted!r} (needs aborted=True)")
    if aborted.get("status") == "complete":
        failures.append(f"handle_rpc('prompt.abort') must not fabricate a turn: {aborted!r}")

    # input.detect_drop must satisfy InputDetectDropResult (matched is REQUIRED
    # by the frontend zod schema); the old _noop response made parseGatewayResult
    # throw and (before the error-frame fix) tore the gateway session down.
    drop = handle_rpc(
        "input.detect_drop",
        json.dumps({"session_id": "s1", "text": "C:/dev/README.md"}),
        json.dumps({"hermesHome": "/x"}),
    )
    if not isinstance(drop, dict) or drop.get("matched") is not False:
        failures.append(f"handle_rpc('input.detect_drop') -> {drop!r} (needs matched=False)")

    # The other frontend-called gateway methods must resolve (not raise), even
    # when their handlers are shape stubs.
    for method, params in [
        ("approval.respond", {"session_id": "s1", "request_id": "r1", "choice": "approve"}),
        ("image.attach_bytes", {"session_id": "s1", "content_base64": "AAAA", "filename": "p.png"}),
        ("image.attach", {"session_id": "s1", "path": "C:/p.png"}),
        ("file.attach", {"session_id": "s1", "path": "C:/a.txt"}),
        ("session.interrupt", {"session_id": "s1"}),
        ("session.compress", {"session_id": "s1"}),
        ("session.title", {"session_id": "s1", "title": "t"}),
        ("session.usage", {"session_id": "s1"}),
        ("session.close", {"session_id": "s1"}),
        ("complete.slash", {"session_id": "s1", "text": "/"}),
        ("config.set", {"session_id": "s1"}),
        ("provider.models", {"session_id": "s1"}),
    ]:
        try:
            handle_rpc(method, json.dumps(params), json.dumps({"hermesHome": "/x"}))
        except Exception as exc:  # noqa: BLE001
            failures.append(f"handle_rpc({method!r}) raised: {exc!r}")

    # A frame without `params` must not crash the interpreter: Rust serializes
    # `Value::Null` as the JSON string "null", which json.loads turns into None.
    for method in ("session.list", "model.list", "setup.status"):
        try:
            handle_rpc(method, "null", "{}")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"handle_rpc({method!r}, 'null') raised: {exc!r}")

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
