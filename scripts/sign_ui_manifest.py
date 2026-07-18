#!/usr/bin/env python3
r"""Sign a Hermes CN Desktop UI hot-update manifest with Ed25519.

Ported from Hermes-CN-Core/scripts/sign_runtime_manifest.py for the UI channel
(Track B). The desktop client verifies against the same trust key it uses for
runtime updates (`HERMES_RUNTIME_UPDATE_PUBLIC_KEY_PEM(_DEFAULT)` cascade).

The canonical payload concatenated with ``\n`` matches what the Rust side
reconstructs in ``src/process/ui_update.rs::ui_signature_payload()`` — keep the
field order in sync (both sides carry order-lock tests).

``appVersionFloor`` is the safety core of the channel: the minimum desktop
shell version the bundle is compatible with. It is REQUIRED and signed — a UI
bundle that calls invoke commands an older shell doesn't have must carry a
floor above that shell, and the client refuses to serve it.

Usage:
    python scripts/sign_ui_manifest.py \
        --channel stable \
        --ui-version 0.7.1 \
        --app-version-floor 0.7.0 \
        --platform win32 \
        --arch x64 \
        --artifact-url https://github.com/.../ui-win32-x64.zip \
        --artifact-path out/ui-win32-x64.zip \
        --source-repo Eynzof/Hermes-CN-Desktop \
        --source-commit "$GITHUB_SHA" \
        --output out/stable-win32-x64.json
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import hashlib
import json
import os
import re
import sys
from pathlib import Path

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
except ImportError:
    raise SystemExit(
        "scripts/sign_ui_manifest.py needs `cryptography` (pip install cryptography)."
    )


SCHEMA_VERSION = 1

# Field order MUST match `ui_signature_payload()` in src/process/ui_update.rs.
# Any reorder here is a silent verification failure on every UI install —
# change both sides together or not at all.
PAYLOAD_FIELDS = (
    "schemaVersion",
    "channel",
    "uiVersion",
    "appVersionFloor",
    "platform",
    "arch",
    "artifactUrl",
    "sha256",
    "sourceRepo",
    "sourceCommit",
)

_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


def _sha256_hex(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_private_key() -> Ed25519PrivateKey:
    pem = os.environ.get("RUNTIME_SIGN_PRIVATE_KEY_PEM")
    if not pem:
        raise SystemExit(
            "RUNTIME_SIGN_PRIVATE_KEY_PEM is not set. The UI channel signs "
            "with the same Ed25519 trust key as the runtime channel. Never "
            "put the key on argv (it'd leak via process listings)."
        )
    pem = pem.replace("\\n", "\n").encode()
    key = load_pem_private_key(pem, password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise SystemExit("RUNTIME_SIGN_PRIVATE_KEY_PEM is not an Ed25519 key.")
    return key


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--channel", required=True, help="stable | beta | canary | ...")
    p.add_argument("--ui-version", required=True, help="UI bundle version, e.g. 0.7.1")
    p.add_argument(
        "--app-version-floor",
        required=True,
        help="minimum compatible desktop shell version (signed gate)",
    )
    p.add_argument("--platform", required=True, choices=("win32", "darwin", "linux"))
    p.add_argument("--arch", required=True, choices=("x64", "arm64"))
    p.add_argument("--artifact-url", required=True, help="HTTPS URL clients fetch")
    p.add_argument(
        "--artifact-path",
        required=True,
        type=Path,
        help="Local path to the zip — used to compute sha256",
    )
    p.add_argument("--source-repo", required=True, help="org/name slug")
    p.add_argument("--source-commit", required=True, help="commit SHA")
    p.add_argument("--output", required=True, type=Path)
    args = p.parse_args()

    for label, value in (
        ("--ui-version", args.ui_version),
        ("--app-version-floor", args.app_version_floor),
    ):
        if not _SEMVER_RE.match(value):
            # The Rust floor gate REFUSES unparseable floors (fails closed),
            # which would brick the bundle; fail fast at signing time.
            raise SystemExit(f"{label} must be semver (X.Y.Z), got {value!r}")

    if not args.artifact_path.is_file():
        raise SystemExit(f"artifact zip not found: {args.artifact_path}")

    if not args.artifact_url.startswith("https://"):
        # Rust side rejects non-https; fail fast so CI can't ship a manifest
        # the client will refuse.
        raise SystemExit(f"artifact_url must be https:, got {args.artifact_url!r}")

    sha256 = _sha256_hex(args.artifact_path)
    print(f"sha256({args.artifact_path.name}) = {sha256}", file=sys.stderr)

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "channel": args.channel,
        "uiVersion": args.ui_version,
        "appVersionFloor": args.app_version_floor,
        "platform": args.platform,
        "arch": args.arch,
        "artifactUrl": args.artifact_url,
        "sha256": sha256,
        "sourceRepo": args.source_repo,
        "sourceCommit": args.source_commit,
    }
    payload = "\n".join(str(manifest[f]) for f in PAYLOAD_FIELDS).encode()
    manifest["createdAt"] = _dt.datetime.now(_dt.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )

    key = _load_private_key()
    signature = key.sign(payload)
    manifest["signature"] = base64.standard_b64encode(signature).decode()

    # Self-check: verify with the derived public key before writing, so a
    # payload-construction bug can never ship a manifest clients reject.
    key.public_key().verify(signature, payload)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"wrote {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
