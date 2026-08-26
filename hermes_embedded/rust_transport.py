"""RustBridgeTransport — the Python side of the embedded gateway transport
(refactor_report.md §3.3 / Phase 3, §4 Phase 4 延伸).

Implements the same Transport Protocol as ``tui_gateway.transport.Transport``
(write(obj) -> bool, close()) so ``tui_gateway.server.dispatch`` can run against
it with zero changes to Core. The only difference from StdioTransport /
WSTransport: instead of writing to a process pipe or a WebSocket, ``write``
pushes structured frames into the Rust process through the embedded sink
callback, and the Rust side fans them out to the WebView as
``gateway-ws-message`` events.

In the production Core repo the sink is a pyo3 callback; in the reference
package the sink is any callable accepting a JSON-serializable object.
"""

from __future__ import annotations

import json
from typing import Any, Callable

# Import is guarded so the reference package works standalone (outside Core).
try:  # pragma: no cover - exercised only inside Hermes-CN-Core
    from tui_gateway.transport import Transport as _BaseTransport
except ImportError:  # pragma: no cover
    class _BaseTransport:  # type: ignore[no-redef]
        """Fallback Protocol definition when Core's tui_gateway is absent."""

        def write(self, obj: Any) -> bool:  # pragma: no cover
            raise NotImplementedError

        def close(self) -> None:  # pragma: no cover
            raise NotImplementedError


class RustBridgeTransport(_BaseTransport):
    """Transport that pushes frames into the embedding Rust process.

    Attributes:
        sink: callable(event_dict) -> bool. Receives each frame as a dict with
            ``{"type": ..., "payload": ...}`` (the JSON-RPC event shape the
            webview relay shim already understands).
    """

    def __init__(self, sink: Callable[[dict[str, Any]], bool], connection_id: str = "embedded"):
        self._sink = sink
        self._connection_id = connection_id
        self._closed = False

    @property
    def connection_id(self) -> str:
        return self._connection_id

    def write(self, obj: Any) -> bool:
        """Push one frame to Rust. Returns True when a subscriber received it.

        ``obj`` is whatever the dispatcher hands over (a dict for events, e.g.
        ``{"type": "message", "payload": {...}}``); the payload is upgraded
        from "string JSON frames" to a structured dict per Phase 4 延伸.
        """
        if self._closed:
            return False
        if isinstance(obj, str):
            try:
                obj = json.loads(obj)
            except (TypeError, ValueError):
                obj = {"type": "message", "payload": {"text": obj}}
        if not isinstance(obj, dict):
            obj = {"type": "message", "payload": obj}
        # A sink that returns None (e.g. a list.append in tests) still delivered
        # the frame; only an explicit False means "failed to deliver".
        return self._sink(obj) is not False

    def close(self) -> None:
        self._closed = True

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"<RustBridgeTransport connection_id={self._connection_id!r} closed={self._closed}>"
