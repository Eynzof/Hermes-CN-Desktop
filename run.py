#!/usr/bin/env python3
"""
run.py — Start Hermes Agent CN Desktop against the REAL embedded backend
(Hard FFI, zero HTTP).

The backend runs *inside* the Tauri process: the embedded CPython interpreter
loads the REAL Core package (``hermes_backend/hermes_embedded``) and serves
every REST route through the real ``hermes_cli.web_server`` FastAPI app and
every gateway JSON-RPC method through the real ``tui_gateway.server``
dispatcher. No hermes dashboard subprocess, no dashboard port (no 9120 /
8644 / 8645 listeners), no connection.json. REST goes through native IPC →
Rust api_request → FFI registry → in-process app dispatch; Gateway events
flow through the in-memory Rust-backed transport.

This script is the dev convenience wrapper around `pnpm tauri:dev` with
HERMES_DESKTOP_EMBEDDED_PYTHON=1 (+ payload resolution), plus stale
connection.json removal so bootstrap takes the Managed → in-process path.

Launch mode selection
---------------------
- run.py ALWAYS launches the embedded in-process runtime whenever the payload
  resolves: HERMES_DESKTOP_EMBEDDED_PAYLOAD override or
  ``<core>/hermes_embedded`` (the merged real package). No hermes dashboard
  subprocess is spawned and nothing listens on the dashboard port (9120) — so
  a stale or broken dev-runtime venv can never again fail startup with
  「dashboard exited before ready」.
- Pass --real-backend to opt into the legacy managed path instead: install
  the Core checkout into dev-runtime and spawn the real `hermes dashboard`
  subprocess on 9120 over HTTP/WS.

Usage:
    python run.py                                    # Real embedded backend (zero HTTP)
    python run.py --source C:/dev/Hermes-CN-Core     # Override Core checkout path
    python run.py --backend hermes_backend           # Relative paths work too
    python run.py --backend hermes_backend --real-backend   # Real dashboard subprocess on 9120
    python run.py --skip-prereqs                     # Skip pnpm / Core source checks
    python run.py --help                             # Show full help

Requirements:
    - Hermes-CN-Core checkout with the merged ``hermes_embedded`` package at
      ../Hermes-CN-Core (or ./hermes_backend, or set HERMES_CN_CORE / --source)
    - pnpm installed and dependencies installed (pnpm install)
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from signal import SIGINT, SIGTERM, SIG_IGN, signal
from subprocess import Popen
import shutil

# ── Paths ───────────────────────────────────────────────────────────────────

DESKTOP_ROOT = Path(__file__).parent.resolve()


def _resolve_core_root(source_arg: str | None = None) -> Path:
    """Resolve Hermes-CN-Core path: CLI --source > HERMES_CN_CORE > default sibling."""
    if source_arg:
        return Path(source_arg).resolve()
    return Path(os.environ.get("HERMES_CN_CORE", DESKTOP_ROOT.parent / "Hermes-CN-Core")).resolve()


# ── Globals ─────────────────────────────────────────────────────────────────

processes: list[Popen] = []
_connection_json_path: Path | None = None  # Track connection.json for cleanup
_cleaning_up: bool = False  # Prevent re-entrant cleanup


# ── Helpers ─────────────────────────────────────────────────────────────────


def eprint(*args, **kwargs) -> None:
    print(*args, file=sys.stderr, **kwargs)


def check_prerequisites(core_root: Path) -> None:
    """Verify the prerequisites for embedded dev: Core source + pnpm."""
    errors: list[str] = []

    if not (core_root / "pyproject.toml").is_file():
        errors.append(
            f"Hermes-CN-Core source not found at {core_root}.\n"
            f"    Set HERMES_CN_CORE / use --source, or clone it to: {core_root}"
        )

    if not shutil.which("pnpm"):
        errors.append(
            "pnpm not found in PATH.\n"
            "  Install: npm install -g pnpm  (or: corepack enable && corepack prepare pnpm@latest --activate)"
        )

    if errors:
        eprint("❌ Prerequisites not met:")
        for err in errors:
            eprint(f"  • {err}")
        sys.exit(1)


def dev_runtime_root() -> Path:
    """Return the desktop dev runtime root directory.

    Mirrors devRuntimeRoot() from scripts/tauri-dev-managed.mjs.
    """
    env_root = os.environ.get("HERMES_DESKTOP_RUNTIME_ROOT")
    if env_root:
        return Path(env_root).resolve()

    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "cn.org.hermesagent.desktop" / "dev-runtime"


def remove_connection_json() -> None:
    """Remove connection.json from the dev runtime root.

    In embedded mode the desktop must NOT attach to an HTTP backend (Local /
    Remote connection.json would force exactly that); deleting any stale file
    lets bootstrap take the Managed → in-process EmbeddedPython path.
    """
    global _connection_json_path
    path = _connection_json_path or (dev_runtime_root() / "connection.json")
    if path.is_file():
        try:
            path.unlink(missing_ok=True)
            eprint(f"🧹 Removed {path} (embedded mode must not attach over HTTP)")
        except Exception as e:
            eprint(f"⚠️  Failed to remove {path}: {e}")
    _connection_json_path = None


def has_embedded_payload(root: Path) -> bool:
    """A directory is a usable embedded payload when it exposes api.py."""
    return (root / "api.py").is_file()


def resolve_embedded_payload(core_root: Path) -> tuple[Path | None, str]:
    """Resolve the embedded Python payload root and where it came from.

    The payload is the REAL backend package (the merged ``hermes_embedded``
    inside the Core checkout). Resolution order:

    1. HERMES_DESKTOP_EMBEDDED_PAYLOAD — explicit override. A missing api.py
       here is a HARD error: the user configured a payload on purpose, and
       silently swapping in a fallback would mask a broken checkout.
    2. ``<core>/hermes_embedded`` — the Core-side real package.

    There is no bundled demo fallback anymore: the desktop repo no longer
    carries a ``hermes_embedded`` package.

    Returns ``(payload_root, origin)`` with origin in
    ``{"override", "core", ""}`` (empty means "nothing found").
    """
    override = os.environ.get("HERMES_DESKTOP_EMBEDDED_PAYLOAD")
    if override:
        p = Path(override).resolve()
        if not has_embedded_payload(p):
            eprint(
                f"❌ HERMES_DESKTOP_EMBEDDED_PAYLOAD points to {p}, but no api.py was found under it.\n"
                f"    Fix the path or unset the variable."
            )
            sys.exit(1)
        return p, "override"
    core_pkg = core_root / "hermes_embedded"
    if has_embedded_payload(core_pkg):
        return core_pkg, "core"
    return None, ""


def run_embedded_dev(pnpm_exe: str, core_root: Path, payload: Path, payload_origin: str) -> None:
    """Launch the Tauri desktop dev app with the REAL embedded backend (Hard FFI, zero HTTP).

    No hermes dashboard subprocess, no HTTP listener (no dashboard port), no
    connection.json: the real Core package is embedded inside the Rust process
    and every REST/Gateway call goes through the FFI surface. This requires the
    Tauri shell, so we run `pnpm tauri:dev` (scripts/tauri-dev-managed.mjs),
    which already honors HERMES_DESKTOP_EMBEDDED_PYTHON /
    HERMES_DESKTOP_EMBEDDED_PAYLOAD.
    """
    remove_connection_json()

    embedded_env = {
        **os.environ,
        "HERMES_DESKTOP_EMBEDDED_PYTHON": "1",
        "HERMES_DESKTOP_EMBEDDED_PAYLOAD": str(payload),
        # Make scripts/install-local-runtime.mjs (invoked by tauri:dev) use the
        # same Core checkout we resolved, instead of its own sibling default.
        "HERMES_AGENT_CN_SOURCE": str(core_root),
        "PYTHONIOENCODING": "utf-8",
        # The embedded package reports the REAL Core version via FFI, which
        # can legitimately differ from the desktop bundle's baked
        # EXPECTED_BACKEND_VERSION. Skip the strict gate in dev only.
        "VITE_HERMES_SKIP_VERSION_CHECK": "1",
    }
    eprint("🚀 Starting Tauri dev with the REAL embedded backend (Hard FFI, zero HTTP)...")
    eprint(f"   Payload:  {payload} ({payload_origin})")
    eprint(f"   Backend:  in-process real Core (no HTTP listener, no dashboard port, no connection.json)")
    proc = Popen(
        [pnpm_exe, "tauri:dev"],
        env=embedded_env,
        cwd=str(DESKTOP_ROOT),
    )
    processes.append(proc)


def run_real_backend_dev(pnpm_exe: str, core_root: Path) -> None:
    """Launch Tauri dev against the REAL managed-runtime backend.

    Opt-in via --real-backend (embedding is the unconditional default).
    scripts/install-local-runtime.mjs installs THIS Core checkout into
    dev-runtime (via HERMES_AGENT_CN_SOURCE) and bootstrap spawns the real
    hermes dashboard subprocess on 9120 over HTTP/WS.

    HERMES_DESKTOP_EMBEDDED_PYTHON is pinned to "0" — the documented opt-out
    (src/embedded/mod.rs EMBEDDED_DISABLE_ENV). Merely unsetting it would not
    be enough: resolve_payload_root also scans the Core checkout for
    hermes_embedded and would re-embed. The payload override var is dropped as
    well so the real launch cannot inherit a stale override.
    """
    env = dict(os.environ)
    env.pop("HERMES_DESKTOP_EMBEDDED_PAYLOAD", None)
    env["HERMES_DESKTOP_EMBEDDED_PYTHON"] = "0"
    env["PYTHONIOENCODING"] = "utf-8"
    # scripts/install-local-runtime.mjs must install THIS Core checkout into
    # dev-runtime, not its own sibling default.
    env["HERMES_AGENT_CN_SOURCE"] = str(core_root)

    remove_connection_json()

    eprint("🚀 Starting Tauri dev against the REAL managed-runtime backend...")
    eprint(f"   Core:     {core_root}")
    proc = Popen(
        [pnpm_exe, "tauri:dev"],
        env=env,
        cwd=str(DESKTOP_ROOT),
    )
    processes.append(proc)


def cleanup(signum=None, frame=None) -> None:
    """Terminate all child processes and clean up connection.json.

    Safe to call multiple times (re-entry is prevented).
    Does not call sys.exit() — the caller is responsible for that.
    """
    global processes, _connection_json_path, _cleaning_up

    if _cleaning_up:
        return
    _cleaning_up = True

    # Ignore further signals during cleanup to prevent re-entry
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)

    eprint("\n⏹️  Shutting down...")

    # ── Remove connection.json ────────────────────────────────────────
    if _connection_json_path and _connection_json_path.is_file():
        try:
            _connection_json_path.unlink(missing_ok=True)
            eprint(f"🧹 Removed {_connection_json_path}")
        except Exception as e:
            eprint(f"⚠️  Failed to remove {_connection_json_path}: {e}")

    # ── Graceful terminate ────────────────────────────────────────────
    for proc in processes:
        if proc.poll() is None:
            proc.terminate()

    # Wait a moment for graceful shutdown
    for proc in processes:
        try:
            proc.wait(timeout=5)
        except Exception:
            pass

    # ── Force-kill any survivors ──────────────────────────────────────
    survivors = [p for p in processes if p.poll() is None]
    if survivors:
        for proc in survivors:
            try:
                proc.kill()
                proc.wait(timeout=3)
            except Exception:
                pass
        eprint(f"💀 Force-killed {len(survivors)} remaining process(es)")

    eprint("✅ Done.")


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run Hermes Agent CN Desktop against the REAL embedded backend (Hard FFI, zero HTTP)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python run.py                              # REAL embedded backend (zero HTTP)\n"
            "  python run.py --source C:/dev/Hermes-CN-Core\n"
            "  python run.py --backend hermes_backend     # explicit Core checkout to embed\n"
            "  python run.py --backend hermes_backend --real-backend  # dashboard subprocess on 9120\n"
            "\n"
            "Environment:\n"
            "  HERMES_CN_CORE              Path to Hermes-CN-Core repo (default: ../Hermes-CN-Core)\n"
            "  HERMES_DESKTOP_EMBEDDED_PYTHON=1  Enables the embedded runtime (set automatically;\n"
            "                              pinned to 0 only by the --real-backend opt-in)\n"
            "  HERMES_DESKTOP_EMBEDDED_PAYLOAD   Payload root override (default: <Core>/hermes_embedded)\n"
            "  HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL=1  Skip re-installing the dev runtime\n"
        ),
    )
    parser.add_argument(
        "--source",
        default=None,
        help="Path to Hermes-CN-Core backend repo (default: ../Hermes-CN-Core, or HERMES_CN_CORE env var)",
    )
    parser.add_argument(
        "--backend",
        default=None,
        help="Deprecated alias for --source. The embedded real backend is the default either way;\n"
        "add --real-backend to launch the managed-runtime dashboard subprocess instead",
    )
    parser.add_argument(
        "--real-backend",
        action="store_true",
        help="Opt into the REAL managed-runtime path even though embedding is available:\n"
        "install the selected Core checkout into dev-runtime and spawn the real hermes\n"
        "dashboard subprocess on port 9120 (HTTP/WS). Without this flag run.py always\n"
        "launches the embedded in-process runtime (zero HTTP)",
    )
    parser.add_argument(
        "--embedded",
        action="store_true",
        help="Deprecated no-op: embedded Python mode is now the default",
    )
    parser.add_argument(
        "--skip-prereqs",
        action="store_true",
        help="Skip prerequisite checks (pnpm / Core source)",
    )

    args = parser.parse_args()

    core_root = _resolve_core_root(args.source or args.backend)

    if not args.skip_prereqs:
        check_prerequisites(core_root)

    # Find pnpm executable (Windows may have pnpm.cmd instead of pnpm.exe)
    pnpm_exe = shutil.which("pnpm.cmd") or shutil.which("pnpm") or "pnpm"

    # Signal handlers that convert SIGINT/SIGTERM to KeyboardInterrupt
    # so the try/finally in __main__ always catches them and runs cleanup().
    def _signal_to_keyboard_interrupt(signum, frame):
        raise KeyboardInterrupt()
    signal(SIGINT, _signal_to_keyboard_interrupt)
    signal(SIGTERM, _signal_to_keyboard_interrupt)

    payload, payload_origin = resolve_embedded_payload(core_root)

    if getattr(args, "real_backend", False):
        # Explicit --real-backend opt-in: the legacy managed path — install
        # the Core checkout into dev-runtime and spawn the real hermes
        # dashboard subprocess (HTTP/WS on 9120).
        run_real_backend_dev(pnpm_exe, core_root)
        launched = "managed-real-backend"
    elif payload is not None:
        # The real in-process backend: <core>/hermes_embedded is the merged
        # package that drives the real web_server + tui_gateway via FFI.
        run_embedded_dev(pnpm_exe, core_root, payload, payload_origin)
        launched = "embedded-real"
    else:
        eprint(
            "❌ Embedded mode requires the real hermes_embedded package inside the Core checkout: set "
            "HERMES_DESKTOP_EMBEDDED_PAYLOAD, or have ../Hermes-CN-Core/hermes_embedded (or the --source "
            "checkout) with api.py present."
        )
        sys.exit(1)

    eprint("─" * 50)
    if launched == "managed-real-backend":
        eprint("   Mode:     REAL managed runtime (hermes dashboard subprocess)")
        eprint(f"   Backend:  {core_root} over HTTP/WS (dashboard on port 9120)")
        eprint("   Chat:     wired to the actual Hermes agent")
    else:
        eprint("   Mode:     Embedded Python runtime (Hard FFI, zero HTTP)")
        eprint(f"   Payload:  {payload}")
        eprint("   Backend:  REAL Core in-process (web_server REST + tui_gateway via FFI)")
    eprint("   Frontend: Tauri dev window (Vite on 9545 via pnpm tauri:dev)")
    eprint("   Press Ctrl+C to stop.")
    eprint("─" * 50)

    # Wait for the dev app to exit (KeyboardInterrupt propagates to __main__).
    while True:
        for proc in list(processes):
            ret = proc.poll()
            if ret is not None:
                eprint(f"⚠️  Process exited with code {ret}")
                cleanup()
                sys.exit(ret if ret else 0)
        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise  # Let SystemExit propagate normally
    except BaseException:
        cleanup()
        raise
    finally:
        # Ensure cleanup runs on any exit path (Ctrl+C, exception, normal return)
        cleanup()
