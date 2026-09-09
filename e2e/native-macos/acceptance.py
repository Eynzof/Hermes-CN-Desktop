"""Launch and collect evidence for an isolated, signed native macOS build.

UI actions remain native; snapshots never invoke updater commands or fake results.
"""
import argparse
import hashlib
import json
import os
import plistlib
import sqlite3
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["launch", "snapshot"])
parser.add_argument("--app", type=Path, required=True)
parser.add_argument("--root", type=Path, required=True, help="Independent acceptance runtime")
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--fixture", type=Path)
parser.add_argument("--port", type=int, default=19120)
args = parser.parse_args()
app, root = args.app.resolve(), args.root.resolve()
home = root / "hermes-home"
exe = app / "Contents/MacOS/hermes-agent-cn-desktop"


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
with (app / "Contents/Info.plist").open("rb") as stream:
    info = plistlib.load(stream)
evidence = {"app": str(app), "runtimeRoot": str(root), "desktopSha256": sha(exe),
            "bundleVersion": info["CFBundleShortVersionString"], "signatureVerified": True}

if args.action == "launch":
    if subprocess.run(["lsof", "-tiTCP:" + str(args.port), "-sTCP:LISTEN"], capture_output=True).stdout.strip():
        raise SystemExit("Acceptance port is occupied; inspect its owner before starting")
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("HERMES_", "TAURI_"))
           and key.lower() not in {"https_proxy", "http_proxy", "all_proxy", "no_proxy", "ssl_cert_file"}}
    env.update(HERMES_DESKTOP_RUNTIME_ROOT=str(root), HERMES_HOME=str(home),
               HERMES_DESKTOP_API_PORT=str(args.port), HERMES_NO_ANALYTICS="1")
    if args.fixture:
        fixture = args.fixture.resolve()
        invite = json.loads((fixture / "invitation.json").read_text())
        metadata = json.loads((fixture / "metadata.json").read_text())
        bypass = "api.deepseek.com,localhost,127.0.0.1,::1"
        env.update(HTTPS_PROXY=f"http://127.0.0.1:{metadata['port']}", NO_PROXY=bypass, no_proxy=bypass,
                   HERMES_UPDATE_CHANNEL=invite["channel"], HERMES_UPDATE_DEVICE_ID=invite["deviceId"],
                   HERMES_SHELL_UPDATE_TOKEN=invite["token"], HERMES_SHELL_UPDATE_ENDPOINT=invite["endpoint"])
        bundle = fixture / "ca-bundle.pem"
        if bundle.exists():
            env["SSL_CERT_FILE"] = str(bundle)
    root.mkdir(parents=True, exist_ok=True)
    with (root / "native-app.log").open("ab") as log:
        process = subprocess.Popen([str(exe)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
    evidence["pid"] = process.pid
else:
    evidence["processes"] = [line for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,command="], text=True).splitlines()
                             if str(exe) in line or str(root / "versions") in line]
    for name in ["current.json", "software-update.json", "update-activity/activity.json"]:
        path = root / name
        if path.exists():
            # Only safe state fields; candidate URLs and internal headers are omitted.
            value = json.loads(path.read_text())
            if name == "software-update.json":
                value = value["state"]
                value = {key: value[key] for key in ["phase", "currentVersion", "error", "completedAt", "checkedAt"] if key in value}
            evidence[name] = value
    evidence["dataHashes"] = {str(path.relative_to(home)): sha(path)
                              for path in [home / ".env", home / "config.yaml"] if path.exists()}
    database = home / "state.db"
    if database.exists():
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            db.row_factory = sqlite3.Row
            evidence["sessions"] = [dict(row) for row in db.execute(
                "SELECT id, model, input_tokens, output_tokens, billing_provider, billing_base_url, message_count "
                "FROM sessions ORDER BY started_at")]
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
print(f"Saved {args.action} evidence: {args.output}")
