#!/usr/bin/env python3
"""
run.py - Start Hermes Agent CN Desktop (frontend only, no backend).

The agent runtime now lives inside the TypeScript web app (see plans/):
there is no Python backend, no Dashboard REST service and no gateway
WebSocket to start. This script only boots the Vite dev server so you can
develop / smoke-test the web UI in a plain browser (no Tauri shell needed).

Cleanly stops the Vite process on exit (Ctrl+C / SIGTERM).

Usage:
    python run.py              # Frontend on port 9545 (auto-fallback when blocked)
    python run.py --port 8080  # Custom frontend port
    python run.py --no-browser # Don't open the browser automatically
    python run.py --help       # Show full help

Requirements:
    - pnpm installed with workspace dependencies installed (pnpm install)
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import webbrowser
from pathlib import Path
from signal import SIGINT, SIGTERM, SIG_IGN, signal
from subprocess import Popen
import shutil
import socket

# ── Paths / defaults ───────────────────────────────────────────────────────

DESKTOP_ROOT = Path(__file__).parent.resolve()

# Vite dev server (strictPort); verified at runtime - Windows may block it
# via an excluded port range (Hyper-V / WSL2 / WinNAT).
DEFAULT_FRONTEND_PORT = 9545

# ── Globals ────────────────────────────────────────────────────────────────

processes: list[Popen] = []
_cleaning_up: bool = False  # Prevent re-entrant cleanup


# ── Helpers ────────────────────────────────────────────────────────────────


def eprint(*args, **kwargs) -> None:
    print(*args, file=sys.stderr, **kwargs)


def check_prerequisites() -> None:
    """Verify that the required tool (pnpm) exists."""
    errors: list[str] = []
    if not shutil.which("pnpm"):
        errors.append(
            "pnpm not found in PATH.\n"
            "  Install: npm install -g pnpm  (or: corepack enable && corepack prepare pnpm@latest --activate)"
        )
    if errors:
        eprint("Prerequisites not met:")
        for err in errors:
            eprint(f"  - {err}")
        sys.exit(1)


def find_free_port(preferred: int) -> int:
    """Try the preferred port; if occupied, find a free one."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    # Port occupied - let the OS assign one
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def is_port_bindable(port: int) -> bool:
    """Return True if a TCP server can actually bind `port` on loopback.

    Windows reserves whole ranges of TCP ports for Hyper-V / WSL2 / WinNAT
    ("excluded port ranges" - see `netsh interface ipv4 show excludedportrange
    protocol=tcp`). Binding to a reserved port then fails with EACCES even
    though nothing is listening, and the reserved ranges move across reboots,
    so the port must be re-checked at runtime instead of being hard-coded.

    Checks both IPv4 (127.0.0.1) and IPv6 (::1) loopback because the Vite dev
    server binds every address `localhost` resolves to.
    """
    for family, addr in [(socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")]:
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.bind((addr, port))
        except OSError:
            return False
    return True


def _find_pid_on_port_windows(port: int) -> str | None:
    """Find the PID listening on the given port on Windows using netstat."""
    import subprocess as sp
    result = sp.run(
        ["netstat", "-ano"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
    )
    if result.returncode != 0:
        return None

    for line in result.stdout.splitlines():
        parts = line.strip().split()
        # Lines look like:
        #   TCP 127.0.0.1:9545 0.0.0.0:0 LISTENING 12345
        #   TCP [::1]:9545 [::]:0 LISTENING 26452
        #   TCP 0.0.0.0:9545 0.0.0.0:0 LISTENING 12345
        #   TCP [::]:9545 [::]:0 LISTENING 12345
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
    """Find the PID listening on the given port on macOS using lsof."""
    import subprocess as sp
    try:
        result = sp.run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        return result.stdout.strip().splitlines()[0]
    except (FileNotFoundError, Exception):
        return None


def _find_pid_on_port_linux(port: int) -> str | None:
    """Find the PID listening on the given port on Linux using ss."""
    import subprocess as sp
    import re
    try:
        result = sp.run(
            ["ss", "-tlnp", f"sport = :{port}"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        if result.returncode != 0:
            return None
        for line in result.stdout.splitlines():
            m = re.search(r"pid=(\d+)", line)
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
        eprint(f"Killed stale process (PID {pid}) on port {port}")
        time.sleep(0.5)  # Give the OS time to release the port
        return True
    except Exception:
        return False


def kill_process_on_port(port: int) -> bool:
    """Find and kill the process listening on the given port.

    Platform detection:
      Windows: netstat + taskkill
      macOS: lsof + kill
      Linux: ss + kill

    Returns True if a process was found and killed, False if the port was free.
    """
    # First check if the port is actually occupied (IPv4 and IPv6)
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

    try:
        if sys.platform == "win32":
            pid = _find_pid_on_port_windows(port)
        elif sys.platform == "darwin":
            pid = _find_pid_on_port_macos(port)
        else:
            pid = _find_pid_on_port_linux(port)
        if pid is None:
            return False
        return _kill_pid(pid, port)
    except Exception:
        return False


def cleanup() -> None:
    """Terminate all child processes. Safe to call multiple times."""
    global processes, _cleaning_up

    if _cleaning_up:
        return
    _cleaning_up = True

    # Ignore further signals during cleanup to prevent re-entry
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)

    eprint("\nShutting down...")

    if not processes:
        eprint("Done.")
        return

    # Graceful terminate
    for proc in processes:
        if proc.poll() is None:
            proc.terminate()

    # Wait a moment for graceful shutdown
    for proc in processes:
        try:
            proc.wait(timeout=5)
        except Exception:
            pass

    # Force-kill any survivors
    survivors = [p for p in processes if p.poll() is None]
    if survivors:
        for proc in survivors:
            try:
                proc.kill()
                proc.wait(timeout=3)
            except Exception:
                pass
        eprint(f"Force-killed {len(survivors)} remaining process(es)")

    eprint("Done.")


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run Hermes Agent CN Desktop (frontend only, no backend)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python run.py                          # Frontend on 9545\n"
            "  python run.py --port 8080              # Custom frontend port\n"
            "  python run.py --no-browser             # Headless mode\n"
            "\n"
            "Environment:\n"
            "  E2E_VITE_PORT / VITE_PORT  Frontend port (auto-detected when unset)"
        ),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_FRONTEND_PORT,
        help=f"Frontend Vite dev server port (default: {DEFAULT_FRONTEND_PORT})",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not open the browser automatically",
    )
    parser.add_argument(
        "--skip-prereqs",
        action="store_true",
        help="Skip prerequisite checks (useful in scripts)",
    )
    args = parser.parse_args()

    if not args.skip_prereqs:
        check_prerequisites()

    # Find pnpm executable (Windows may have pnpm.cmd instead of pnpm.exe)
    pnpm_exe = shutil.which("pnpm.cmd") or shutil.which("pnpm") or "pnpm"

    # Signal handlers that convert SIGINT/SIGTERM to KeyboardInterrupt
    # so the try/finally in __main__ always catches them and runs cleanup().
    def _signal_to_keyboard_interrupt(signum, frame):
        raise KeyboardInterrupt()
    signal(SIGINT, _signal_to_keyboard_interrupt)
    signal(SIGTERM, _signal_to_keyboard_interrupt)

    # ── Frontend Port Resolution ──────────────────────────────────────────
    # Windows can reserve whole ranges of TCP ports (Hyper-V / WSL2 / WinNAT
    # "excluded port ranges"); binding to a reserved port then fails with
    # EACCES even though nothing is listening, and the ranges shift across
    # reboots. Re-check the port at runtime and fall back to a free one when
    # the OS blocks it, passing the chosen port to Vite via E2E_VITE_PORT.
    frontend_port = args.port
    env_port = os.environ.get("E2E_VITE_PORT") or os.environ.get("VITE_PORT")
    if env_port:
        try:
            frontend_port = int(env_port)
        except ValueError:
            pass

    if not is_port_bindable(frontend_port):
        fallback = find_free_port(frontend_port)
        eprint(
            f"Frontend port {frontend_port} is blocked by the OS"
            f" (Windows excluded port range, usually reserved by Hyper-V/WSL2)."
            f" Falling back to port {fallback}."
        )
        frontend_port = fallback

    # If the resolved frontend port is occupied, kill the stale process.
    kill_process_on_port(frontend_port)

    # ── Start Frontend ────────────────────────────────────────────────────
    eprint(f"Starting frontend (Vite dev server) on port {frontend_port}...")
    frontend_env = {
        **os.environ,
        "PYTHONIOENCODING": "utf-8",
        "E2E_VITE_PORT": str(frontend_port),
    }

    proc = Popen(
        [pnpm_exe, "web:dev"],
        env=frontend_env,
        cwd=str(DESKTOP_ROOT),
    )
    processes.append(proc)

    # ── Open Browser ──────────────────────────────────────────────────────
    if not args.no_browser:
        frontend_url = f"http://localhost:{frontend_port}"
        eprint(f"Opening browser at {frontend_url} ...")
        webbrowser.open(frontend_url)

    eprint("-" * 50)
    eprint(f"   Frontend: http://localhost:{frontend_port}")
    eprint("   Press Ctrl+C to stop.")
    eprint("-" * 50)

    # Wait for the process to exit
    # KeyboardInterrupt propagates out -> finally runs cleanup()
    while True:
        ret = proc.poll()
        if ret is not None:
            eprint(f"Process exited with code {ret}")
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