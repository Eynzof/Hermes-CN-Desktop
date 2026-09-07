"""Run unmodified MemOS, observing the real urllib DeepSeek response bytes.

This is a test-only transport observer: original requests, TLS validation,
timeouts, response reads and exceptions are preserved. No proxy, model response
replacement or MemOS function replacement is used. Credentials are never logged.
"""
import hashlib
import json
import runpy
import sys
import tarfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path

root = Path(sys.argv[1])
source = root / "services" / "wander-memos-efea8c6b"
output = root / "reports" / "wander-model-calls.ndjson"
lock = threading.Lock()
original_urlopen = urllib.request.urlopen

# The archive came from the explicitly pinned private repository commit.
# Verify its bytes and each tracked source file before importing the service.
baseline = json.loads((root / 'native-windows' / 'wander-baseline.json').read_text(encoding='utf-8'))
archive = root / baseline['archive']
assert hashlib.sha256(archive.read_bytes()).hexdigest() == baseline['archiveSha256']
source_files = []
with tarfile.open(archive) as bundle:
    for member in bundle.getmembers():
        if not member.isfile():
            continue
        expected = hashlib.sha256(bundle.extractfile(member).read()).hexdigest()
        actual = hashlib.sha256((source / member.name).read_bytes()).hexdigest()
        assert actual == expected, f'MemOS source differs from baseline: {member.name}'
        source_files.append({'path': member.name, 'sha256': actual})
(root / 'reports' / 'wander-source-manifest.json').write_text(
    json.dumps({'sourceCommit': baseline['sourceCommit'], 'archiveSha256': baseline['archiveSha256'], 'files': source_files}, indent=2), encoding='utf-8')


def append(record):
    with lock, output.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + "\n")


def observe(request, *args, **kwargs):
    if not isinstance(request, urllib.request.Request) or request.full_url != "https://api.deepseek.com/v1/chat/completions":
        return original_urlopen(request, *args, **kwargs)
    body = json.loads(request.data)
    call_id = str(uuid.uuid4())
    append({"event": "request", "callId": call_id, "time": time.time(), "url": request.full_url,
            "model": body.get("model"), "stream": body.get("stream"),
            "messages": body.get("messages"), "requestSha256": hashlib.sha256(request.data).hexdigest()})
    try:
        response = original_urlopen(request, *args, **kwargs)
    except Exception as error:
        append({"event": "error", "callId": call_id, "time": time.time(), "type": type(error).__name__,
                "status": getattr(error, "code", None)})
        raise
    append({"event": "response", "callId": call_id, "time": time.time(), "status": response.status,
            "requestId": response.headers.get("x-request-id")})
    original_read = response.read
    buffer = b""
    ended = False

    def read(*read_args, **read_kwargs):
        nonlocal buffer, ended
        chunk = original_read(*read_args, **read_kwargs)
        buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            if not line.startswith(b"data: "):
                continue
            payload = line[6:].strip()
            if payload == b"[DONE]":
                append({"event": "done", "callId": call_id, "time": time.time()})
            else:
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                append({"event": "sse", "callId": call_id, "time": time.time(), "payload": event})
        if not chunk and not ended:
            ended = True
            append({"event": "eof", "callId": call_id, "time": time.time()})
        return chunk

    response.read = read
    return response


urllib.request.urlopen = observe
sys.path.insert(0, str(source))
sys.argv = ["src.memory", "--remote", str(root / "secrets" / "wander-remote.json"),
            "--db-path", str(root / "services" / "wander-data"),
            "--port-shift-max", "1", "--cors-origins", "http://hermesui.localhost"]
runpy.run_module("src.memory", run_name="__main__")
