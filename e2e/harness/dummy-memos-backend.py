#!/usr/bin/env python3
"""Self-contained dummy OpenAI backend for the MemOS E2E harness.

Runs WanderMemory's own ``tests/dummy_openai_backend.DummyOpenAIBackend`` with
an E2E-local scripted responder so the real MemOS backend gets deterministic
memory-extraction, collision, keyword and chat replies without a real LLM or
WanderMemory's pytest-only development dependencies.

Prints ``DUMMY_LLM_PORT=<port>`` on stdout once the backend is listening, then
blocks forever (the harness kills it on shutdown).

Usage::

    python dummy-memos-backend.py <WANDER_MEMORY_DIR>
    # or set WANDER_MEMORY_DIR in the environment
"""
from __future__ import annotations

import json
import os
import re
import sys
import time

WANDER_MEMORY_DIR = os.environ.get("WANDER_MEMORY_DIR") or (sys.argv[1] if len(sys.argv) > 1 else ".")
# The memos package writes its log dir (<cwd>/.memos/logs) on import — chdir
# into the checkout so logs land there (gitignored) instead of the e2e dir.
os.chdir(WANDER_MEMORY_DIR)
sys.path.insert(0, WANDER_MEMORY_DIR)
sys.path.insert(0, os.path.join(WANDER_MEMORY_DIR, "tests"))

from dummy_openai_backend import DummyOpenAIBackend  # noqa: E402


def scripted_responder(last_user_text: str) -> str:
    """Return the small deterministic reply set required by the E2E flows."""
    if "memory collision resolver" in last_user_text:
        return '{"reason":"unrelated","store_new":true,"delete_indices":[],"merges":[]}'
    if "memory extractor" in last_user_text:
        marker = re.search(r"豆豆\d+", last_user_text)
        if marker:
            return json.dumps(
                [
                    {
                        "memory": f"用户养了一只叫{marker.group(0)}的猫",
                        "metadata": {"type": "fact"},
                    }
                ],
                ensure_ascii=False,
            )
        return "[]"
    if "memory search assistant" in last_user_text:
        return '["喜欢喝","茶"]'
    return "你好，我是远程记忆助手。你说的是：" + last_user_text[:40]


backend = DummyOpenAIBackend(responder=scripted_responder).start()
print(f"DUMMY_LLM_PORT={backend.port}", flush=True)
while True:
    time.sleep(1)
