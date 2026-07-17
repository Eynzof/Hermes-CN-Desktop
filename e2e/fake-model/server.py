"""Deterministic, free, OpenAI-compatible fake model for end-to-end tests.

This is the "determinism knob" of the E2E harness. The real Core backend runs
unchanged; only the *model* it talks to is replaced by this server, so the whole
chat loop (WebSocket gateway, session lifecycle, streaming, image/vision routing)
stays real while being repeatable and costing nothing.

It speaks just enough of the OpenAI Chat Completions API for Core's "custom"
provider:

  * POST /v1/chat/completions  — streaming (SSE) and non-streaming.
  * GET  /v1/models            — some clients probe this on startup.
  * GET  /health               — readiness probe for the harness.

Vision proof: when the last user message carries an `image_url` content part,
the reply embeds the DECODED image byte count. A passing assertion on that number
proves the image bytes actually traversed frontend -> gateway -> provider, i.e.
the model genuinely "read" the image rather than the test faking it.

Run: uvicorn server:app --host 127.0.0.1 --port 8099
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()

MODEL_ID = "fake-model"


def _extract_image_bytes(content: Any) -> int:
    """Sum decoded bytes of every base64 data-URL image in a message content.

    Core sends multimodal content as a list of parts; image parts look like
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,...."}}.
    Returns 0 when there is no image (plain string content or text-only parts).
    """
    if not isinstance(content, list):
        return 0
    total = 0
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "image_url":
            continue
        url = (part.get("image_url") or {}).get("url", "")
        if "," in url:
            url = url.split(",", 1)[1]
        try:
            total += len(base64.b64decode(url))
        except Exception:
            pass
    return total


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def _reply_for(messages: list[dict[str, Any]]) -> str:
    """Deterministic reply derived from the last user message.

    - With an image: "我看到一张图片，共 <N> 字节" — N proves bytes arrived.
    - Plain text echo so a test can assert the reply matches its prompt.
    """
    last_user = next(
        (m for m in reversed(messages) if m.get("role") == "user"),
        {"content": ""},
    )
    image_bytes = _extract_image_bytes(last_user.get("content"))
    if image_bytes > 0:
        return f"我看到一张图片，共 {image_bytes} 字节。"
    text = _text_of(last_user.get("content")).strip()
    if text == "scroll-follow-e2e":
        return " ".join(f"scroll-follow-token-{index}" for index in range(300))
    # Echo a stable marker plus the prompt so specs can assert on either.
    return f"PONG: 收到「{text}」"


def _chunk(delta: dict[str, Any], finish: str | None = None) -> str:
    payload = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion.chunk",
        "created": 1,  # fixed for determinism
        "model": MODEL_ID,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/v1/models")
async def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": MODEL_ID, "object": "model", "owned_by": "e2e"}],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    messages = body.get("messages") or []
    reply = _reply_for(messages)

    if body.get("stream"):

        async def gen():
            if reply.startswith("scroll-follow-token-0"):
                await asyncio.sleep(0.25)
            yield _chunk({"role": "assistant"})
            # Stream by token so the UI exercises its streaming render path.
            for token in reply.split(" "):
                yield _chunk({"content": token + " "})
                if reply.startswith("scroll-follow-token-0"):
                    await asyncio.sleep(0.005)
            yield _chunk({}, finish="stop")
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    return JSONResponse(
        {
            "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": MODEL_ID,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": reply},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
    )
