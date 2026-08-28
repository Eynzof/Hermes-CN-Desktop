"""Comprehensive embedded-mode session conversation test — REAL DeepSeek API.

Drives the REAL ``hermes_embedded`` package exactly the way the Rust FFI layer
does (``call_handle_rpc`` -> ``handle_rpc``), over the REAL ``tui_gateway``
dispatcher + agent loop, with a REAL DeepSeek API call configured from an LLM
config file.

This is the Python-side mirror of the hard FFI (Rust->Python) conversation the
desktop app runs in embedded mode (``python run.py``): every entry point below
(``gateway.connect``, ``session.create``, ``prompt.submit``,
``gateway.disconnect``) is the same ``handle_rpc`` surface the Rust bridge
calls, and the event sink is the same ``RustBridgeTransport`` contract.

LLM config
----------
The model provider is read from ``HERMES_TEST_LLM_CONFIG`` (an absolute path
to a JSON file shaped ``{model, url, api_key, max_context_size, max_tokens,
thinking_effort, type}``). It is converted into a fresh temp hermes home
``config.yaml`` so the agent loop makes a real (paid) call against the
configured endpoint.

The test is **opt-in**: it is skipped when the config file is absent (or the
env var unset), so CI without a real API key stays green. The Core payload is
``HERMES_CN_CORE`` or the in-repo ``hermes_backend`` checkout. Run it locally
with, e.g.:

    HERMES_CN_CORE=/path/to/Hermes-CN-Core \
    HERMES_TEST_LLM_CONFIG=/path/to/llm-config.json \
        python -m unittest tests.python.test_embed_real_conversation -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

DESKTOP_ROOT = Path(__file__).resolve().parents[2]
# The embedded payload package lives in the Core checkout (the desktop repo
# no longer carries one). Prefer HERMES_CN_CORE; fall back to the in-repo
# hermes_backend checkout, then the documented sibling clone.
HERMES_BACKEND = (
    Path(os.environ["HERMES_CN_CORE"]).resolve()
    if os.environ.get("HERMES_CN_CORE")
    else (DESKTOP_ROOT / "hermes_backend").resolve()
)
# Required (no default path — never hardcode a machine-specific config file).
LLM_CONFIG = Path(os.environ.get("HERMES_TEST_LLM_CONFIG", "") or "")

# Markers the old reference/stub package used for canned replies. A real API
# reply must never contain any of these.
STUB_MARKERS = ("嵌入式演示模式", "（嵌入式演示模式）", "embedded demo")

PROMPT = (
    "Reply with a single short English sentence confirming you are a real model. "
    "Do not use any tools. Do not mention tools."
)


def build_config_yaml(cfg: dict) -> str:
    """Convert the ``{model,url,api_key,...}`` config into Core's config.yaml.

    Uses the ``custom`` provider so ``base_url`` / ``api_key`` win directly
    (same shape the e2e harness uses), and disables memory/compression so the
    turn is a single real API call.
    """
    lines = [
        "model:",
        f"  provider: custom",
        f"  default: {cfg['model']}",
        f"  base_url: {cfg['url']}",
        f"  api_key: {cfg['api_key']}",
        f"  context_length: {cfg.get('max_context_size', 200000)}",
        f"  max_tokens: {cfg.get('max_tokens', 4096)}",
    ]
    effort = cfg.get("thinking_effort")
    if effort:
        lines.append("  reasoning:")
        lines.append("    enabled: true")
        lines.append(f"    effort: {effort}")
    lines += [
        "memory:",
        "  memory_enabled: false",
        "  user_profile_enabled: false",
        "compression:",
        "  enabled: false",
        "toolsets: []",
        "",
    ]
    return "\n".join(lines)


class RealEmbedConversationTest(unittest.TestCase):
    """Real backend + hard FFI surface + real session conversation (real API)."""

    def setUp(self):
        if not LLM_CONFIG.is_file():
            self.skipTest(
                "LLM config not found (set HERMES_TEST_LLM_CONFIG to a "
                f"{'{model,url,api_key,...}'} JSON file): {LLM_CONFIG}"
            )
        if not (HERMES_BACKEND / "hermes_embedded" / "api.py").is_file():
            self.skipTest(
                f"hermes_embedded package not found under {HERMES_BACKEND} "
                "(set HERMES_CN_CORE to the Hermes-CN-Core checkout)"
            )
        self.cfg = json.loads(LLM_CONFIG.read_text(encoding="utf-8"))
        self.home = tempfile.mkdtemp(
            prefix="hermes-embed-conv-", dir=os.environ.get("TEMP")
        )
        Path(self.home, "config.yaml").write_text(
            build_config_yaml(self.cfg), encoding="utf-8"
        )
        os.environ["HERMES_HOME"] = self.home
        # Load the real package exactly like the Rust payload does.
        sys.path.insert(0, str(HERMES_BACKEND))
        from hermes_embedded import rust_transport
        from hermes_embedded.api import handle_rpc

        self.rust_transport = rust_transport
        self.handle_rpc = handle_rpc
        self.frames: list[dict] = []
        self.conn = "conn-1"
        self.ctx = json.dumps(
            {
                "hermesHome": self.home,
                "sessionToken": "embed-conv-test",
                "profile": "",
                "connectionId": self.conn,
            }
        )
        # _ensure_runtime (fired on the first handle_rpc call) resets the sink
        # to the Rust bridge or None — so bootstrap the runtime FIRST, then
        # install the collecting sink (same order the Core selftest uses).
        self.handle_rpc("get_status", "{}", self.ctx)
        self.rust_transport.set_sink(
            lambda cid, frame: self.frames.append(json.loads(frame)) or True
        )

    def tearDown(self):
        try:
            self.handle_rpc(
                "gateway.disconnect", json.dumps({"connectionId": self.conn}), self.ctx
            )
        except Exception:
            pass
        if os.environ.get("HERMES_HOME") == self.home:
            del os.environ["HERMES_HOME"]

    def _frames_of(self, ftype: str) -> list[dict]:
        return [
            f for f in self.frames if (f.get("params") or {}).get("type") == ftype
        ]

    def test_real_session_conversation_through_ffi(self):
        # 1. gateway.connect -> binds transport, emits gateway.ready
        connected = self.handle_rpc(
            "gateway.connect", json.dumps({"connectionId": self.conn}), self.ctx
        )
        self.assertEqual(connected.get("ok"), True, connected)
        self.assertTrue(
            any((f.get("params") or {}).get("type") == "gateway.ready" for f in self.frames),
            "gateway.connect must emit gateway.ready through the sink",
        )

        # 2. session.create -> real session id
        created = self.handle_rpc(
            "session.create",
            json.dumps({"cwd": self.home, "cols": 100}),
            json.dumps({**json.loads(self.ctx), "connectionId": self.conn}),
        )
        self.assertIsInstance(created, dict, created)
        sid = created.get("session_id")
        self.assertTrue(sid, f"session.create must return a session_id: {created}")

        # 3. prompt.submit -> REAL agent turn (real API call to the configured LLM)
        submitted = self.handle_rpc(
            "prompt.submit",
            json.dumps(
                {
                    "session_id": sid,
                    "text": PROMPT,
                    "queued": False,
                    "surface": "chat",
                }
            ),
            json.dumps({**json.loads(self.ctx), "connectionId": self.conn}),
        )
        self.assertEqual(submitted.get("status"), "streaming", submitted)

        # 4. Wait for message.start / message.delta / message.complete
        deadline = time.time() + 180
        complete = None
        start_seen = False
        while time.time() < deadline:
            if any((f.get("params") or {}).get("type") == "message.start" for f in self.frames):
                start_seen = True
            for f in self._frames_of("message.complete"):
                if (f.get("params") or {}).get("session_id") == sid:
                    complete = f
                    break
            if complete:
                break
            time.sleep(1.0)

        self.assertTrue(start_seen, "message.start must be emitted for the real turn")
        self.assertIsNotNone(complete, "message.complete must arrive for the real turn")

        payload = (complete.get("params") or {}).get("payload") or {}
        text = str(payload.get("text") or payload.get("content") or "").strip()
        self.assertTrue(text, "the real turn must return assistant text")
        for marker in STUB_MARKERS:
            self.assertNotIn(marker, text, "reply must come from the real API, not a stub")
        self.assertGreaterEqual(
            len(text), 2, f"reply looks too short to be real: {text!r}"
        )

        # The usage block proves a real model call happened (model id + tokens).
        usage = payload.get("usage") or {}
        self.assertEqual(usage.get("model"), self.cfg["model"], usage)
        self.assertGreaterEqual(int(usage.get("calls") or 0), 1, usage)


if __name__ == "__main__":
    unittest.main(verbosity=2)
