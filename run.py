#!/usr/bin/env python3
"""
run.py — Start Hermes Agent CN Desktop with the real Core backend.

This script is a dev convenience wrapper around `pnpm tauri:dev`. The verified
managed runtime remains the default. The in-process CPython/FFI path is an
explicit experimental mode until packaged payload E2E is complete.

Launch mode selection
---------------------
- By default, install the selected Core checkout into dev-runtime and launch
  the managed `hermes dashboard` subprocess on 9120 over HTTP/WS.
- Pass --embedded to opt into the experimental in-process runtime. It resolves
  HERMES_DESKTOP_EMBEDDED_PAYLOAD or ``<core>/hermes_embedded`` and does not
  spawn a dashboard listener.

Usage:
    python run.py                                    # Managed runtime (default)
    python run.py --source C:/dev/Hermes-CN-Core     # Override Core checkout path
    python run.py --backend ../Hermes-CN-Core        # Relative paths work too
    python run.py --backend ../Hermes-CN-Core --embedded    # Experimental zero-HTTP mode
    python run.py --skip-prereqs                     # Skip pnpm / Core source checks
    python run.py --help                             # Show full help

Requirements:
    - Managed mode (default) needs a full Core checkout with pyproject.toml.
    - Embedded mode (--embedded) needs a ``hermes_embedded`` payload. run.py
      looks for it in HERMES_DESKTOP_EMBEDDED_PAYLOAD, then the --source/--backend
      argument, then ./hermes_backend/hermes_embedded, then
      ../Hermes-CN-Core/hermes_embedded.
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


def _resolve_core_source(source_arg: str | None = None) -> Path | None:
    """Resolve a full Hermes-CN-Core checkout for the managed-runtime path.

    Priority:
    1. CLI --source / --backend if it points to a checkout with pyproject.toml.
    2. HERMES_CN_CORE env var if it points to a checkout with pyproject.toml.
    3. In-repo ``hermes_backend`` checkout with pyproject.toml.
    4. Sibling ``../Hermes-CN-Core`` checkout with pyproject.toml.

    Returns ``None`` when no full Core checkout is found.  Embedded mode can
    still run from a standalone ``hermes_embedded`` payload without a full
    checkout.
    """
    if source_arg:
        p = Path(source_arg).resolve()
        return p if (p / "pyproject.toml").is_file() else None

    env = os.environ.get("HERMES_CN_CORE")
    if env:
        p = Path(env).resolve()
        if (p / "pyproject.toml").is_file():
            return p

    local = DESKTOP_ROOT / "hermes_backend"
    if (local / "pyproject.toml").is_file():
        return local

    sibling = DESKTOP_ROOT.parent / "Hermes-CN-Core"
    if (sibling / "pyproject.toml").is_file():
        return sibling

    return None


# ── Globals ─────────────────────────────────────────────────────────────────

processes: list[Popen] = []
_connection_json_path: Path | None = None  # Track connection.json for cleanup
_cleaning_up: bool = False  # Prevent re-entrant cleanup


# ── Helpers ─────────────────────────────────────────────────────────────────


def eprint(*args, **kwargs) -> None:
    print(*args, file=sys.stderr, **kwargs)


def check_prerequisites(
    core_source: Path | None, payload: Path | None, embedded_mode: bool
) -> None:
    """Verify prerequisites for the selected launch mode.

    Embedded mode only needs a ``hermes_embedded`` payload (and pnpm). The
    default managed-runtime path needs a full Core checkout with pyproject.toml.
    """
    errors: list[str] = []

    if not shutil.which("pnpm"):
        errors.append(
            "pnpm not found in PATH.\n"
            "  Install: npm install -g pnpm  (or: corepack enable && corepack prepare pnpm@latest --activate)"
        )

    if not embedded_mode:
        if core_source is None or not (core_source / "pyproject.toml").is_file():
            errors.append(
                "Real managed-runtime mode requires a Hermes-CN-Core source checkout "
                f"(pyproject.toml). Set HERMES_CN_CORE / use --source, or clone it to: "
                f"{DESKTOP_ROOT.parent / 'Hermes-CN-Core'}"
            )
    else:
        if payload is None:
            errors.append(
                "Embedded mode requires a hermes_embedded payload. Set "
                "HERMES_DESKTOP_EMBEDDED_PAYLOAD, or ensure one of these exists:\n"
                f"    - {DESKTOP_ROOT / 'hermes_backend' / 'hermes_embedded'}\n"
                f"    - {DESKTOP_ROOT.parent / 'Hermes-CN-Core' / 'hermes_embedded'}"
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


def resolve_embedded_payload(
    source_arg: str | None, core_source: Path | None
) -> tuple[Path | None, str]:
    """Resolve the embedded Python payload root and where it came from.

    The payload is the REAL backend package (``hermes_embedded``). Resolution
    order:

    1. HERMES_DESKTOP_EMBEDDED_PAYLOAD — explicit override. A missing api.py
       here is a HARD error: the user configured a payload on purpose, and
       silently swapping in a fallback would mask a broken checkout.
    2. CLI --source/--backend if it points directly at a payload directory.
    3. CLI --source/--backend Core checkout's ``hermes_embedded`` package.
    4. Resolved Core checkout's ``hermes_embedded`` package.
    5. In-repo ``hermes_backend/hermes_embedded`` package.
    6. Sibling ``../Hermes-CN-Core/hermes_embedded`` package.

    There is no bundled demo fallback anymore: the desktop repo no longer
    carries a ``hermes_embedded`` package of its own.

    Returns ``(payload_root, origin)`` with origin in
    ``{"override", "cli-payload", "cli-core", "core", "local-backend",
    "sibling-core", ""}`` (empty means "nothing found").
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

    if source_arg:
        p = Path(source_arg).resolve()
        if has_embedded_payload(p):
            return p, "cli-payload"
        core_pkg = p / "hermes_embedded"
        if has_embedded_payload(core_pkg):
            return core_pkg, "cli-core"
        # An explicit CLI path is authoritative. Falling through to a sibling
        # checkout would silently run different code from the path the caller
        # asked to exercise.
        return None, ""

    if core_source is not None:
        core_pkg = core_source / "hermes_embedded"
        if has_embedded_payload(core_pkg):
            return core_pkg, "core"

    local_pkg = DESKTOP_ROOT / "hermes_backend" / "hermes_embedded"
    if has_embedded_payload(local_pkg):
        return local_pkg, "local-backend"

    sibling_pkg = DESKTOP_ROOT.parent / "Hermes-CN-Core" / "hermes_embedded"
    if has_embedded_payload(sibling_pkg):
        return sibling_pkg, "sibling-core"

    return None, ""


def run_embedded_dev(
    pnpm_exe: str, core_source: Path | None, payload: Path, payload_origin: str
) -> None:
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
        "PYTHONIOENCODING": "utf-8",
        # The embedded package reports the REAL Core version via FFI, which
        # can legitimately differ from the desktop bundle's baked
        # EXPECTED_BACKEND_VERSION. Skip the strict gate in dev only.
        "VITE_HERMES_SKIP_VERSION_CHECK": "1",
    }
    if core_source is not None:
        # Make scripts/install-local-runtime.mjs (invoked by tauri:dev) use the
        # same Core checkout we resolved, instead of its own sibling default.
        embedded_env["HERMES_AGENT_CN_SOURCE"] = str(core_source)
    else:
        # No full Core checkout is available, but the in-process payload is
        # self-sufficient.  Skip the managed-runtime install step so that
        # tauri:dev does not fail looking for pyproject.toml.
        embedded_env["HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL"] = "1"
    eprint("🚀 Starting Tauri dev with the REAL embedded backend (Hard FFI, zero HTTP)...")
    eprint(f"   Payload:  {payload} ({payload_origin})")
    eprint(f"   Backend:  in-process real Core (no HTTP listener, no dashboard port, no connection.json)")
    proc = Popen(
        [pnpm_exe, "tauri:dev"],
        env=embedded_env,
        cwd=str(DESKTOP_ROOT),
    )
    processes.append(proc)


def run_real_backend_dev(pnpm_exe: str, core_source: Path) -> None:
    """Launch Tauri dev against the REAL managed-runtime backend.

    This is the default, verified development path.
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
    env["HERMES_AGENT_CN_SOURCE"] = str(core_source)

    remove_connection_json()

    eprint("🚀 Starting Tauri dev against the REAL managed-runtime backend...")
    eprint(f"   Core:     {core_source}")
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
        description="Run Hermes Agent CN Desktop with the real Core backend",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python run.py                              # managed runtime (default)\n"
            "  python run.py --source C:/dev/Hermes-CN-Core\n"
            "  python run.py --backend ../Hermes-CN-Core\n"
            "  python run.py --backend ../Hermes-CN-Core --embedded  # experimental zero HTTP\n"
            "\n"
            "Environment:\n"
            "  HERMES_CN_CORE              Path to Hermes-CN-Core repo (default: ./hermes_backend,\n"
            "                              then ../Hermes-CN-Core)\n"
            "  HERMES_DESKTOP_EMBEDDED_PYTHON=1  Enables the embedded runtime when --embedded is used\n"
            "  HERMES_DESKTOP_EMBEDDED_PAYLOAD   Payload root override (default: <Core>/hermes_embedded)\n"
            "  HERMES_DESKTOP_SKIP_LOCAL_RUNTIME_INSTALL=1  Skip re-installing the dev runtime\n"
        ),
    )
    parser.add_argument(
        "--source",
        default=None,
        help="Path to Hermes-CN-Core backend repo, a hermes_embedded payload directory, "
        "or omitted to use the in-repo hermes_backend checkout / ../Hermes-CN-Core fallback",
    )
    parser.add_argument(
        "--backend",
        default=None,
        help="Deprecated alias for --source. Accepts a Core checkout or, with --embedded, a payload",
    )
    parser.add_argument(
        "--real-backend",
        action="store_true",
        help="Deprecated no-op: managed runtime is the default",
    )
    parser.add_argument(
        "--embedded",
        action="store_true",
        help="Opt into the experimental embedded Python runtime (Hard FFI, zero HTTP)",
    )
    parser.add_argument(
        "--skip-prereqs",
        action="store_true",
        help="Skip prerequisite checks (pnpm / payload or Core source)",
    )

    args = parser.parse_args()

    if args.embedded and args.real_backend:
        parser.error("--embedded and --real-backend cannot be used together")

    source_arg = args.source or args.backend
    core_source = _resolve_core_source(source_arg)
    payload, payload_origin = (
        resolve_embedded_payload(source_arg, core_source)
        if args.embedded
        else (None, "")
    )

    if not args.skip_prereqs:
        check_prerequisites(core_source, payload, args.embedded)

    # Find pnpm executable (Windows may have pnpm.cmd instead of pnpm.exe)
    pnpm_exe = shutil.which("pnpm.cmd") or shutil.which("pnpm") or "pnpm"

    # Signal handlers that convert SIGINT/SIGTERM to KeyboardInterrupt
    # so the try/finally in __main__ always catches them and runs cleanup().
    def _signal_to_keyboard_interrupt(signum, frame):
        raise KeyboardInterrupt()
    signal(SIGINT, _signal_to_keyboard_interrupt)
    signal(SIGTERM, _signal_to_keyboard_interrupt)

    if not args.embedded:
        if core_source is None:
            eprint(
                "❌ Managed runtime requires a Hermes-CN-Core source checkout. "
                "Set HERMES_CN_CORE / use --source, or clone it to: "
                f"{DESKTOP_ROOT.parent / 'Hermes-CN-Core'}"
            )
            sys.exit(1)
        run_real_backend_dev(pnpm_exe, core_source)
        launched = "managed-real-backend"
    elif payload is not None:
        # The real in-process backend: the resolved hermes_embedded package
        # drives the real web_server + tui_gateway via FFI.
        run_embedded_dev(pnpm_exe, core_source, payload, payload_origin)
        launched = "embedded-real"
    else:
        eprint(
            "❌ Embedded mode requires a hermes_embedded payload. Set "
            "HERMES_DESKTOP_EMBEDDED_PAYLOAD, or ensure one of these exists:\n"
            f"    - {DESKTOP_ROOT / 'hermes_backend' / 'hermes_embedded'}\n"
            f"    - {DESKTOP_ROOT.parent / 'Hermes-CN-Core' / 'hermes_embedded'}"
        )
        sys.exit(1)

    eprint("─" * 50)
    if launched == "managed-real-backend":
        eprint("   Mode:     REAL managed runtime (hermes dashboard subprocess)")
        eprint(f"   Backend:  {core_source} over HTTP/WS (dashboard on port 9120)")
        eprint("   Chat:     wired to the actual Hermes agent")
    else:
        eprint("   Mode:     Embedded Python runtime (Hard FFI, zero HTTP)")
        eprint(f"   Payload:  {payload} ({payload_origin})")
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
