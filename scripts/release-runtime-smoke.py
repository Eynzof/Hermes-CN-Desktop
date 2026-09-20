#!/usr/bin/env python3
"""Run the Core shipped inside a final desktop package without touching user data."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import signal
import subprocess
import tempfile
import time
import urllib.request


def sha256(file):
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exactly_one(paths, label):
    found = list(paths)
    if len(found) != 1:
        raise RuntimeError(f"{label}: expected one path, found {len(found)}")
    return found[0]


def smoke(args):
    app_root = args.app_root.resolve()
    archive_name = f"hermes-agent-cn-runtime-{args.platform}-{args.arch}.zip"
    archive = exactly_one(app_root.rglob(archive_name), "packaged runtime archive")
    manifest = json.loads((archive.parent / f"stable-{args.platform}-{args.arch}.json").read_text())
    if manifest["schemaVersion"] != 2:
        raise RuntimeError("packaged runtime schema must remain 2")
    archive_hash = sha256(archive)
    if archive_hash != manifest["sha256"]:
        raise RuntimeError("packaged runtime bytes do not match the bundled manifest")
    web_dist = archive.parent.parent / "dashboard" / "web_dist"
    if not (web_dist / "index.html").is_file():
        raise RuntimeError("final package has no dashboard web_dist/index.html")
    report = {
        "ok": False,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "appRoot": str(app_root),
        "archive": str(archive),
        "archiveSha256": archive_hash,
        "runtimeVersion": manifest["runtimeVersion"],
        "coreSha": manifest["sourceCommit"],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    log_path = args.output.with_suffix(".log")
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="hermes-release-smoke-") as temp:
            temp_root = Path(temp)
            # Native unzip preserves executable modes and framework symlinks.
            subprocess.run(["unzip", "-q", str(archive), "-d", str(temp_root / "runtime")], check=True)
            names = {archive_name[:-4], "hermes-agent-cn-runtime"}
            binary = exactly_one(
                (p for p in (temp_root / "runtime").rglob("hermes-agent-cn-runtime*")
                 if p.is_file() and p.name in names), "packaged Core executable",
            )
            hermes_home = temp_root / "hermes-home"
            hermes_home.mkdir()
            ready = temp_root / "ready.json"
            token = secrets.token_urlsafe(32)
            env = {
                **os.environ,
                "HERMES_HOME": str(hermes_home),
                "HERMES_DESKTOP": "1",
                "HERMES_DESKTOP_MANAGED": "1",
                "HERMES_DESKTOP_READY_FILE": str(ready),
                "HERMES_DASHBOARD_SESSION_TOKEN": token,
                "HERMES_DISABLE_LAZY_INSTALLS": "1",
                "HERMES_DASHBOARD_PREWARM_AGENT": "0",
                "HERMES_WEB_DIST": str(web_dist),
            }
            for name in ("PYTHONHOME", "PYTHONPATH"):
                env.pop(name, None)
            with log_path.open("w") as log:
                process = subprocess.Popen(
                    [str(binary), "dashboard", "--host", "127.0.0.1", "--port", "0", "--no-open"],
                    cwd=binary.parent, env=env, stdin=subprocess.DEVNULL,
                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                )
                try:
                    deadline = time.monotonic() + args.timeout
                    while not ready.exists():
                        if process.poll() is not None:
                            raise RuntimeError(f"packaged Core exited before ready: {process.returncode}")
                        if time.monotonic() >= deadline:
                            raise RuntimeError("packaged Core readiness timed out")
                        time.sleep(0.25)
                    port = json.loads(ready.read_text())["port"]
                    if not isinstance(port, int) or not 0 < port < 65536:
                        raise RuntimeError("invalid ready port")
                    for endpoint in ("health", "version"):
                        request = urllib.request.Request(
                            f"http://127.0.0.1:{port}/api/{endpoint}",
                            headers={"X-Hermes-Session-Token": token},
                        )
                        with urllib.request.urlopen(request, timeout=15) as response:
                            payload = json.load(response)
                        if payload.get("version") != manifest["kernelVersion"]:
                            raise RuntimeError(f"/{endpoint} version disagrees with packaged manifest")
                        if endpoint == "health" and payload.get("ok") is not True:
                            raise RuntimeError("packaged Core health probe failed")
                        report[endpoint] = payload
                    report["ok"] = True
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=10)
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        report["durationSeconds"] = round(time.monotonic() - started, 2)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-root", type=Path, required=True)
    parser.add_argument("--platform", choices=("darwin", "linux"), required=True)
    parser.add_argument("--arch", choices=("arm64", "x64"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=180)
    smoke(parser.parse_args())
