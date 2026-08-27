#!/usr/bin/env python3
"""
run.py — Start Hermes Agent CN Desktop in embedded Python mode (Hard FFI, zero HTTP).

The desktop backend runs *inside* the Tauri process via the embedded CPython
FFI surface: no hermes dashboard subprocess, no dashboard port (no 9120 /
8644 / 8645 listeners), no connection.json. REST goes through native IPC →
Rust api_request → FFI registry; Gateway flows through the in-memory
Rust-backed transport.

This script is the dev convenience wrapper around `pnpm tauri:dev` with
HERMES_DESKTOP_EMBEDDED_PYTHON=1 (+ payload resolution), plus stale
connection.json removal so bootstrap takes the Managed → in-process path.

Usage:
    python run.py                                    # Embedded Python runtime (zero HTTP)
    python run.py --source C:/dev/Hermes-CN-Core     # Override Core checkout path
    python run.py --skip-prereqs                     # Skip pnpm / Core source checks
    python run.py --help                             # Show full help

Requirements:
    - Hermes-CN-Core at ../Hermes-CN-Core (or set HERMES_CN_CORE / use --source)
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


def embedded_payload_root(core_root: Path) -> Path | None:
    """Resolve the embedded Python payload root.

    Prefer the user's explicit HERMES_DESKTOP_EMBEDDED_PAYLOAD, then the Core
    checkout's hermes_embedded package, then the desktop repo's self-contained
    reference package (the same fallback install-local-runtime.mjs uses).
    """
    override = os.environ.get("HERMES_DESKTOP_EMBEDDED_PAYLOAD")
    if override:
        p = Path(override).resolve()
        if (p / "api.py").is_file() or (p / "hermes_embedded" / "api.py").is_file():
            return p
        eprint(f"⚠️  HERMES_DESKTOP_EMBEDDED_PAYLOAD points to {p}, but no api.py found under it")
    for candidate in (core_root / "hermes_embedded", DESKTOP_ROOT / "hermes_embedded"):
        if (candidate / "api.py").is_file():
            return candidate
    return None


def run_embedded_dev(pnpm_exe: str, core_root: Path) -> None:
    """Launch the Tauri desktop dev app in embedded Python mode (Hard FFI, zero HTTP).

    No hermes dashboard subprocess, no HTTP listener (no dashboard port), no
    connection.json: the Python backend is embedded inside the Rust process and
    every REST/Gateway call goes through the FFI surface. This requires the
    Tauri shell, so we run `pnpm tauri:dev` (scripts/tauri-dev-managed.mjs),
    which already honors HERMES_DESKTOP_EMBEDDED_PYTHON /
    HERMES_DESKTOP_EMBEDDED_PAYLOAD.
    """
    payload = embedded_payload_root(core_root)
    if payload is None:
        eprint(
            "❌ Embedded mode requires a hermes_embedded payload: set "
            "HERMES_DESKTOP_EMBEDDED_PAYLOAD, or have ../Hermes-CN-Core/hermes_embedded "
            "or ./hermes_embedded with api.py present."
        )
        sys.exit(1)

    remove_connection_json()

    embedded_env = {
        **os.environ,
        "HERMES_DESKTOP_EMBEDDED_PYTHON": "1",
        "HERMES_DESKTOP_EMBEDDED_PAYLOAD": str(payload),
        # Make scripts/install-local-runtime.mjs (invoked by tauri:dev) use the
        # same Core checkout we resolved, instead of its own sibling default.
        "HERMES_AGENT_CN_SOURCE": str(core_root),
        "PYTHONIOENCODING": "utf-8",
    }
    eprint("🚀 Starting Tauri dev in embedded Python mode (Hard FFI, zero HTTP)...")
    eprint(f"   Payload:  {payload}")
    eprint(f"   Backend:  in-process (no HTTP listener, no dashboard port, no connection.json)")
    proc = Popen(
        [pnpm_exe, "tauri:dev"],
        env=embedded_env,
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
        description="Run Hermes Agent CN Desktop in embedded Python mode (Hard FFI, zero HTTP)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python run.py                              # Embedded Python runtime (zero HTTP)\n"
            "  python run.py --source C:/dev/Hermes-CN-Core\n"
            "\n"
            "Environment:\n"
            "  HERMES_CN_CORE              Path to Hermes-CN-Core repo (default: ../Hermes-CN-Core)\n"
            "  HERMES_DESKTOP_EMBEDDED_PYTHON=1  Enables the embedded runtime (set automatically)\n"
            "  HERMES_DESKTOP_EMBEDDED_PAYLOAD   Payload root override (default: <Core>/hermes_embedded, else ./hermes_embedded)\n"
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
        help="Deprecated alias for --source",
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

    run_embedded_dev(pnpm_exe, core_root)
    eprint("─" * 50)
    eprint("   Mode:     Embedded Python runtime (Hard FFI, zero HTTP)")
    eprint("   Backend:  in-process (no HTTP listener, no dashboard port)")
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
