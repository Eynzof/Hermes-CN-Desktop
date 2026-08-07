#!/usr/bin/env python3
"""Self-contained dummy OpenAI backend for the MemOS E2E harness.

Runs WanderMemory's OWN ``tests/dummy_openai_backend.DummyOpenAIBackend`` with
the dry-run suite's ``scripted_responder`` (``tests/test_memory_remote_dryrun.py``)
so the real MemOS backend gets deterministic memory-extraction / collision /
chat replies with no real LLM involved. Falls back to the default responder
("Hello, world!") when the scripted one cannot be imported (e.g. a checkout
without the dry-run test module).

Prints ``DUMMY_LLM_PORT=<port>`` on stdout once the backend is listening, then
blocks forever (the harness kills it on shutdown).

Usage::

    python dummy-memos-backend.py <WANDER_MEMORY_DIR>
    # or set WANDER_MEMORY_DIR in the environment
"""
from __future__ import annotations

import os
import sys
import time

WANDER_MEMORY_DIR = os.environ.get("WANDER_MEMORY_DIR") or (sys.argv[1] if len(sys.argv) > 1 else ".")
# The memos package writes its log dir (<cwd>/.memos/logs) on import — chdir
# into the checkout so logs land there (gitignored) instead of the e2e dir.
os.chdir(WANDER_MEMORY_DIR)
sys.path.insert(0, WANDER_MEMORY_DIR)
sys.path.insert(0, os.path.join(WANDER_MEMORY_DIR, "tests"))

from dummy_openai_backend import DummyOpenAIBackend, default_responder  # noqa: E402

try:
    from test_memory_remote_dryrun import scripted_responder  # noqa: E402

    responder = scripted_responder
except Exception as exc:  # pragma: no cover - defensive fallback
    print(
        f"[dummy-memos-backend] scripted_responder unavailable ({exc}); "
        "using the default responder",
        file=sys.stderr,
    )
    responder = default_responder

backend = DummyOpenAIBackend(responder=responder).start()
print(f"DUMMY_LLM_PORT={backend.port}", flush=True)
while True:
    time.sleep(1)
