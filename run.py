#!/usr/bin/env python3
"""
run.py — Start Hermes Agent CN Desktop with existing backend.

Starts the backend (hermes dashboard) and frontend (Vite dev server)
concurrently. Cleans up both processes on exit.

Usage:
    python run.py                          # Default: port 9120 backend, 9545 frontend
    python run.py --backend-port 9119      # Custom backend port
    python run.py --no-browser             # Don't open browser automatically
    python run.py --backend-only           # Only start the backend
    python run.py --frontend-only           # Only start the frontend
    python run.py --help                   # Show full help

Requirements:
    - Hermes-CN-Core at ../Hermes-CN-Core (or set HERMES_CN_CORE env var)
    - Hermes-CN-Core venv at ../Hermes-CN-Core/.venv with `hermes` installed
    - pnpm installed and dependencies installed (pnpm install)
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import webbrowser
from pathlib import Path
from signal import SIGINT, SIGTERM, SIG_IGN, signal
from subprocess import PIPE, Popen
from typing import NoReturn
import shutil
import atexit

# ── Paths ───────────────────────────────────────────────────────────────────

DESKTOP_ROOT = Path(__file__).parent.resolve()


def _resolve_core_root(backend_arg: str | None = None) -> Path:
    """Resolve Hermes-CN-Core path: CLI arg > env var > default sibling."""
    if backend_arg:
        return Path(backend_arg).resolve()
    return Path(os.environ.get("HERMES_CN_CORE", DESKTOP_ROOT.parent / "Hermes-CN-Core")).resolve()


def _resolve_venv_paths(core_root: Path) -> tuple[Path, Path]:
    """Return (hermes_exe, python_exe) for the given core root.

    Platform-dependent venv layout:
      Windows: .venv\\Scripts\\hermes.exe / python.exe
      macOS/Linux: .venv/bin/hermes / python3
    """
    if sys.platform == "win32":
        scripts_dir = "Scripts"
        hermes_name = "hermes.exe"
        python_name = "python.exe"
    else:
        scripts_dir = "bin"
        hermes_name = "hermes"
        python_name = "python3"
    hermes = core_root / ".venv" / scripts_dir / hermes_name
    python = core_root / ".venv" / scripts_dir / python_name
    return hermes, python


# Defaults — may be overridden in main() after CLI parsing
CORE_ROOT = _resolve_core_root()
VENV_HERMES, VENV_PYTHON = _resolve_venv_paths(CORE_ROOT)

# ── Defaults ────────────────────────────────────────────────────────────────

DEFAULT_BACKEND_PORT = 9120   # Desktop convention (avoids conflict with global agent on 9119)
DEFAULT_FRONTEND_PORT = 9545  # Vite dev server (strictPort)

# ── Globals ─────────────────────────────────────────────────────────────────

processes: list[Popen] = []
_connection_json_path: Path | None = None  # Track connection.json for cleanup
_cleaning_up: bool = False  # Prevent re-entrant cleanup


# ── Helpers ─────────────────────────────────────────────────────────────────


def eprint(*args, **kwargs) -> None:
    print(*args, file=sys.stderr, **kwargs)


def check_prerequisites(core_root: Path | None = None, venv_hermes: Path | None = None) -> None:
    """Verify that all required tools and paths exist."""
    errors: list[str] = []

    cr = core_root or CORE_ROOT
    vh = venv_hermes or VENV_HERMES

    if not cr.is_dir():
        errors.append(
            f"Hermes-CN-Core not found at {CORE_ROOT}.\n"
            f"    Set HERMES_CN_CORE env var or clone it to: {cr}"
        )
    elif not vh.is_file():
        venv_pip_path = ".venv\\Scripts\\pip" if sys.platform == "win32" else ".venv/bin/pip"
        errors.append(
            f"hermes CLI not found at {VENV_HERMES}.\n"
            f"    Run: cd {cr} && python -m venv .venv && {venv_pip_path} install -e ."
        )
    else:
        # Quick smoke-test: check hermes is runnable
        import subprocess as sp

        result = sp.run(
            [str(vh), "--version"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        if result.returncode != 0:
            errors.append(f"hermes CLI exists but failed to run:\n  {result.stderr.strip()}")

    # Check pnpm
    import shutil
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


def find_free_port(preferred: int) -> int:
    """Try the preferred port; if occupied, find a free one."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    # Port occupied — let OS assign one
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]





def _find_pid_on_port_windows(port: int) -> str | None:
    """Find PID listening on the given port on Windows using netstat."""
    import subprocess as sp
    result = sp.run(
        ["netstat", "-ano"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
    )
    if result.returncode != 0:
        return None

    for line in result.stdout.splitlines():
        parts = line.strip().split()
        # Look for lines like:
        #   TCP    127.0.0.1:9545    0.0.0.0:0    LISTENING    12345
        #   TCP    [::1]:9545        [::]:0        LISTENING    26452
        #   TCP    0.0.0.0:9545      0.0.0.0:0    LISTENING    12345
        #   TCP    [::]:9545         [::]:0        LISTENING    12345
        if len(parts) >= 5 and "LISTENING" in parts[3]:
            local_addr = parts[1]
            if "]:" in local_addr:
                addr_port = local_addr.split("]:")[-1]
            elif ":" in local_addr:
                addr_port = local_addr.rsplit(":", 1)[-1]
            else:
                continue
            if addr_port.isdigit() and int(addr_port) == port:
                return parts[4]
    return None


def _find_pid_on_port_macos(port: int) -> str | None:
    """Find PID listening on the given port on macOS using lsof."""
    import subprocess as sp
    try:
        result = sp.run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        # lsof -ti returns one PID per line; take the first
        return result.stdout.strip().splitlines()[0]
    except (FileNotFoundError, Exception):
        return None


def _find_pid_on_port_linux(port: int) -> str | None:
    """Find PID listening on the given port on Linux using ss."""
    import subprocess as sp
    import re
    try:
        # ss -tlnp shows listening TCP sockets with PID
        result = sp.run(
            ["ss", "-tlnp", f"sport = :{port}"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        if result.returncode != 0:
            return None
        # Parse output: LISTEN 0 128 127.0.0.1:9545 0.0.0.0:* users:(("node",pid=12345,fd=18))
        for line in result.stdout.splitlines():
            m = re.search(r'pid=(\d+)', line)
            if m:
                return m.group(1)
        return None
    except (FileNotFoundError, Exception):
        return None


def _kill_pid(pid: str, port: int) -> bool:
    """Kill a process by PID using platform-appropriate tools."""
    import subprocess as sp
    try:
        if sys.platform == "win32":
            sp.run(["taskkill", "/F", "/PID", pid], capture_output=True, timeout=10)
        else:
            sp.run(["kill", "-9", pid], capture_output=True, timeout=10)
        eprint(f"🧹 Killed stale process (PID {pid}) on port {port}")
        time.sleep(0.5)  # Give OS time to release the port
        return True
    except Exception:
        return False


def kill_process_on_port(port: int) -> bool:
    """Find and kill the process listening on the given port.

    Platform detection:
      Windows: netstat + taskkill
      macOS:   lsof + kill
      Linux:   ss + kill

    Returns True if a process was found and killed, False if the port was free.
    """
    import socket

    # First check if port is actually occupied (check both IPv4 and IPv6)
    port_occupied = False
    for family, addr in [(socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")]:
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.bind((addr, port))
        except OSError:
            port_occupied = True
            break
    if not port_occupied:
        return False

    # Port is occupied — find the PID using the platform-appropriate tool
    try:
        if sys.platform == "win32":
            pid = _find_pid_on_port_windows(port)
        elif sys.platform == "darwin":
            pid = _find_pid_on_port_macos(port)
        else:
            # Linux and other Unix-likes
            pid = _find_pid_on_port_linux(port)

        if pid is None:
            return False

        return _kill_pid(pid, port)
    except Exception:
        return False


def _kill_hermes_processes_windows() -> None:
    """Kill existing hermes.exe / hermes python processes on Windows."""
    import subprocess as sp

    # Kill any existing hermes.exe processes
    try:
        result = sp.run(
            ["tasklist", "/FI", "IMAGENAME eq hermes.exe", "/FO", "CSV"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines()[1:]:  # Skip CSV header
                parts = line.strip().split(",")
                if len(parts) >= 2:
                    pid = parts[1].strip('"')
                    try:
                        sp.run(["taskkill", "/F", "/PID", pid], capture_output=True, timeout=10)
                        eprint(f"🧹 Killed existing hermes.exe (PID {pid})")
                    except Exception:
                        pass
    except Exception:
        pass

    # Also kill any python processes running hermes_cli
    try:
        result = sp.run(
            ["wmic", "process", "where", 'name="python.exe"', "get", "ProcessId,CommandLine", "/format:csv"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                if "hermes_cli" in line.lower() or "hermes" in line.lower():
                    parts = line.split(",")
                    if len(parts) >= 2:
                        pid = parts[1].strip()
                        if pid and pid != "ProcessId":
                            try:
                                sp.run(["taskkill", "/F", "/PID", pid], capture_output=True, timeout=10)
                                eprint(f"🧹 Killed hermes python process (PID {pid})")
                            except Exception:
                                pass
    except Exception:
        pass


def _kill_hermes_processes_unix() -> None:
    """Kill existing hermes processes on macOS/Linux using pgrep/pkill."""
    import subprocess as sp

    # Kill hermes dashboard/gateway processes
    try:
        result = sp.run(
            ["pgrep", "-f", "hermes"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            for pid in result.stdout.strip().splitlines():
                pid = pid.strip()
                if pid:
                    try:
                        sp.run(["kill", "-9", pid], capture_output=True, timeout=10)
                        eprint(f"🧹 Killed existing hermes process (PID {pid})")
                    except Exception:
                        pass
    except Exception:
        pass

    # Kill python processes running hermes_cli
    try:
        result = sp.run(
            ["pgrep", "-f", "hermes_cli"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            for pid in result.stdout.strip().splitlines():
                pid = pid.strip()
                if pid:
                    try:
                        sp.run(["kill", "-9", pid], capture_output=True, timeout=10)
                        eprint(f"🧹 Killed hermes python process (PID {pid})")
                    except Exception:
                        pass
    except Exception:
        pass


def cleanup_hermes_state() -> None:
    """Remove stale Hermes state (port-locks, gateway.pid, processes.json)
    that might prevent a new dashboard from starting.
    """
    # Kill existing hermes processes (platform-specific)
    if sys.platform == "win32":
        _kill_hermes_processes_windows()
    else:
        _kill_hermes_processes_unix()

    # Remove stale port-lock files (Windows: LOCALAPPDATA; macOS/Linux: XDG_DATA_HOME or ~/.local/share)
    if sys.platform == "win32":
        hermes_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "hermes"
    elif sys.platform == "darwin":
        hermes_data = Path.home() / "Library" / "Application Support" / "hermes"
    else:
        hermes_data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "hermes"
    port_locks_dir = hermes_data / ".port-locks"
    if port_locks_dir.is_dir():
        for lock_file in port_locks_dir.iterdir():
            try:
                lock_file.unlink(missing_ok=True)
                eprint(f"🧹 Removed stale port-lock: {lock_file.name}")
            except Exception:
                pass

    # Remove gateway.pid and processes.json
    for f in ["gateway.pid", "processes.json"]:
        p = hermes_data / f
        if p.is_file():
            try:
                p.unlink(missing_ok=True)
                eprint(f"🧹 Removed stale state file: {f}")
            except Exception:
                pass

    time.sleep(0.5)  # Give OS time to release resources


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


def write_connection_json(backend_port: int) -> Path | None:
    """Write connection.json so the desktop uses Local mode (attach to existing backend).

    Returns the path written, or None on failure.
    """
    global _connection_json_path
    try:
        runtime_root = dev_runtime_root()
        runtime_root.mkdir(parents=True, exist_ok=True)
        conn_path = runtime_root / "connection.json"
        content = {
            "version": 2,
            "mode": "local",
            "local": {"url": f"http://127.0.0.1:{backend_port}"},
        }
        import json
        conn_path.write_text(json.dumps(content, indent=2), encoding="utf-8")
        _connection_json_path = conn_path
        eprint(f"🔗 Wrote connection.json → {conn_path} (mode=local, url={content['local']['url']})")
        return conn_path
    except Exception as e:
        eprint(f"⚠️  Failed to write connection.json: {e}")
        return None


def wait_for_backend(port: int, timeout: float = 30.0) -> bool:
    """Poll the dashboard health endpoint until it responds."""
    import urllib.error
    import urllib.request

    url = f"http://127.0.0.1:{port}/"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.5)
    return False


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
    global CORE_ROOT, VENV_HERMES, VENV_PYTHON

    parser = argparse.ArgumentParser(
        description="Run Hermes Agent CN Desktop (backend + frontend)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python run.py                          # Default run\n"
            "  python run.py --backend-port 9119      # Custom backend port\n"
            "  python run.py --no-browser             # Headless mode\n"
            "  python run.py --backend-only           # Backend only\n"
            "\n"
            "Environment:\n"
            "  HERMES_CN_CORE        Path to Hermes-CN-Core repo (default: ../Hermes-CN-Core)\n"
            "  HERMES_DASHBOARD_ORIGIN  Backend URL for Vite proxy (default: http://127.0.0.1:{port})"
        ),
    )
    parser.add_argument(
        "--backend-port",
        type=int,
        default=DEFAULT_BACKEND_PORT,
        help=f"Backend dashboard port (default: {DEFAULT_BACKEND_PORT})",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not open browser automatically",
    )
    parser.add_argument(
        "--backend-only",
        action="store_true",
        help="Only start the backend (no frontend)",
    )
    parser.add_argument(
        "--frontend-only",
        action="store_true",
        help="Only start the frontend (no backend)",
    )
    parser.add_argument(
        "--backend",
        default=None,
        help="Path to Hermes-CN-Core backend repo (overrides HERMES_CN_CORE env var, e.g. C:/dev/Hermes-CN-Core)",
    )
    parser.add_argument(
        "--skip-prereqs",
        action="store_true",
        help="Skip prerequisite checks (useful in scripts)",
    )

    args = parser.parse_args()

    # Resolve core root: CLI arg takes precedence
    CORE_ROOT = _resolve_core_root(args.backend)
    VENV_HERMES, VENV_PYTHON = _resolve_venv_paths(CORE_ROOT)

    # Record the original working directory before any path overrides.
    # Ensures the backend process inherits the user's shell cwd rather than
    # CORE_ROOT (which causes TERMINAL_CWD to point at the Core repo instead
    # of the directory the user actually launched from).
    _original_cwd = os.getcwd()

    if not args.skip_prereqs:
        check_prerequisites(core_root=CORE_ROOT, venv_hermes=VENV_HERMES)

    # Find pnpm executable (Windows may have pnpm.cmd instead of pnpm.exe)
    pnpm_exe = shutil.which("pnpm.cmd") or shutil.which("pnpm") or "pnpm"

    # Signal handlers that convert SIGINT/SIGTERM to KeyboardInterrupt
    # so the try/finally in __main__ always catches them and runs cleanup().
    def _signal_to_keyboard_interrupt(signum, frame):
        raise KeyboardInterrupt()
    signal(SIGINT, _signal_to_keyboard_interrupt)
    signal(SIGTERM, _signal_to_keyboard_interrupt)

    backend_port = args.backend_port

    # ── Clean up stale Hermes state ────────────────────────────────────
    # Kill any existing hermes processes and remove port-locks to ensure
    # the new dashboard can start (hermes CLI refuses to start when
    # another instance is detected via port-locks / gateway.pid).
    if not args.frontend_only:
        cleanup_hermes_state()

    # ── Port Conflict Resolution ────────────────────────────────────────
    # If the preferred backend port is occupied, try to kill the stale
    # process first. If that fails, fall back to a free port.
    was_killed = kill_process_on_port(backend_port)
    if not was_killed:
        # Check if port is actually free; if not, find a free one
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", backend_port))
            except OSError:
                free_port = find_free_port(backend_port)
                if free_port != backend_port:
                    eprint(f"⚠️  Port {backend_port} in use. Falling back to port {free_port}.")
                    backend_port = free_port

    dashboard_origin = os.environ.get(
        "HERMES_DASHBOARD_ORIGIN", f"http://127.0.0.1:{backend_port}"
    )

    # ── Start Backend ───────────────────────────────────────────────────
    if not args.frontend_only:
        eprint(f"🔧 Starting backend (hermes dashboard) on port {backend_port}...")
        backend_env = {
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            "HERMES_DASHBOARD_TUI": "1",
            "HERMES_DASHBOARD_ORIGIN": dashboard_origin,
        }

        proc = Popen(
            [
                str(VENV_HERMES),
                "dashboard",
                "--no-open",        # Don't open browser
                "--port", str(backend_port),
                "--host", "127.0.0.1",
            ],
            env=backend_env,
            # Use the user's original cwd (not CORE_ROOT), so TERMINAL_CWD
            # points at the directory the user actually launched from.
            cwd=_original_cwd,
        )
        processes.append(proc)

        # Wait for backend to be ready
        eprint("⏳ Waiting for backend to be ready...")
        if not wait_for_backend(backend_port, timeout=60):
            eprint("❌ Backend failed to start within 60 seconds. Check logs above.")
            cleanup()
            sys.exit(1)
    else:
        eprint("ℹ️  Skipping backend start (--frontend-only)")

    # ── Write connection.json for Desktop Local mode ────────────────
    # Tell the desktop Tauri app to attach to our backend instead of
    # spawning its own managed runtime dashboard.
    if not args.backend_only:
        write_connection_json(backend_port)

    # ── Frontend Port Conflict Resolution ────────────────────────────
    # If the preferred frontend port is occupied, kill the stale process.
    kill_process_on_port(DEFAULT_FRONTEND_PORT)

    # ── Start Frontend ──────────────────────────────────────────────────
    if not args.backend_only:
        eprint(f"🚀 Starting frontend (Vite dev server) on port {DEFAULT_FRONTEND_PORT}...")
        frontend_env = {
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            "HERMES_DASHBOARD_ORIGIN": dashboard_origin,
        }

        proc = Popen(
            [pnpm_exe, "web:dev"],
            env=frontend_env,
            cwd=str(DESKTOP_ROOT),
        )
        processes.append(proc)

        # ── Open Browser ────────────────────────────────────────────────
        if not args.no_browser:
            frontend_url = f"http://localhost:{DEFAULT_FRONTEND_PORT}"
            eprint(f"🌐 Opening browser at {frontend_url} ...")
            webbrowser.open(frontend_url)
    else:
        eprint("ℹ️  Skipping frontend start (--backend-only)")

    eprint("─" * 50)
    if not args.backend_only and not args.frontend_only:
        eprint(f"   Backend:  http://127.0.0.1:{backend_port}")
        eprint(f"   Frontend: http://localhost:{DEFAULT_FRONTEND_PORT}")
    elif args.backend_only:
        eprint(f"   Backend:  http://127.0.0.1:{backend_port}")
    elif args.frontend_only:
        eprint(f"   Frontend: http://localhost:{DEFAULT_FRONTEND_PORT}")
    eprint("   Press Ctrl+C to stop.")
    eprint("─" * 50)

    # Wait for either process to exit
    # KeyboardInterrupt propagates out → atexit fires cleanup()
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