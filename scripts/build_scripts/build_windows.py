#!/usr/bin/env python3
"""
Hermes Agent CN Desktop — Windows unified build script.

Based on manual build experience:
- Requires Rust >= 1.77 (Tauri v2 lockfile version 4).
- Requires pnpm and Node.
- Windows CRLF line endings break version:check/license:check because the
  sync scripts use LF-only regexes; we enforce LF via .gitattributes.
- Builds web frontend, Rust release binary, and the Windows installer.

Usage:
    python scripts/build_scripts/build_windows.py
    python scripts/build_scripts/build_windows.py --skip-preflight
    python scripts/build_scripts/build_windows.py --tauri-bundle nsis

Exit codes:
    0  success
    1  environment or build error
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, NoReturn

# Repository root is three levels above this script:
# scripts/build_scripts/build_windows.py -> scripts/build_scripts -> scripts -> repo_root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TAURI_CONF_PATH = REPO_ROOT / "tauri.conf.json"
PACKAGE_JSON_PATH = REPO_ROOT / "package.json"
CARGO_TOML_PATH = REPO_ROOT / "Cargo.toml"

MIN_RUST_VERSION = (1, 77, 0)
REQUIRED_TOOLS = ["node", "pnpm", "cargo", "rustc"]

# Maps tool name -> absolute executable path (populated in check_environment).
TOOL_PATHS: dict[str, str] = {}


def load_json(path: Path) -> dict[str, Any]:
    """Load a JSON file."""
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def read_text(path: Path) -> str:
    """Read a text file."""
    with path.open("r", encoding="utf-8") as f:
        return f.read()


def get_desktop_version() -> str:
    """Read the desktop version from package.json."""
    return str(load_json(PACKAGE_JSON_PATH)["version"])


def get_product_name() -> str:
    """Read the product name from tauri.conf.json."""
    return str(load_json(TAURI_CONF_PATH)["productName"])


def get_cargo_package_name() -> str:
    """Read the package name from Cargo.toml."""
    text = read_text(CARGO_TOML_PATH)
    match = re.search(r'^name\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not match:
        raise RuntimeError("Cannot parse package name from Cargo.toml")
    return match.group(1)


def resolve_tool(name: str) -> str:
    """Resolve a command name to an absolute executable path.

    On Windows, Python's subprocess may pick up an extensionless shim (e.g.
    'pnpm') instead of the real 'pnpm.CMD', causing [WinError 2]. shutil.which
    returns the preferred Windows executable extension, so we use that.
    """
    if name in TOOL_PATHS:
        return TOOL_PATHS[name]
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Required tool not found: {name}")
    TOOL_PATHS[name] = path
    return path


def run(
    cmd: list[str] | str,
    *,
    cwd: Path | None = None,
    check: bool = True,
    capture: bool = False,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a shell command with logging."""
    if isinstance(cmd, str):
        shell = True
        display = cmd
    else:
        shell = False
        display = " ".join(cmd)

    print(f"\n[RUN] {display}")
    start = time.time()
    merged_env = {**os.environ, **(env or {})}
    result = subprocess.run(
        cmd,
        cwd=cwd or REPO_ROOT,
        shell=shell,
        check=False,
        capture_output=capture,
        text=True,
        env=merged_env,
    )
    elapsed = time.time() - start
    print(f"[DONE] {display} ({elapsed:.1f}s) exit={result.returncode}")
    if check and result.returncode != 0:
        if capture:
            print(result.stdout, file=sys.stderr)
            print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"Command failed: {display}")
    return result


def get_version_output(tool: str) -> str:
    """Get --version output for a tool."""
    path = resolve_tool(tool)
    try:
        return run([path, "--version"], capture=True).stdout.strip()
    except Exception as exc:
        raise RuntimeError(f"Cannot run '{tool} --version': {exc}") from exc


def parse_rust_version(version_line: str) -> tuple[int, int, int]:
    """Parse 'rustc 1.96.1 (hash date)' -> (1, 96, 1)."""
    match = re.search(r"rustc\s+(\d+)\.(\d+)\.(\d+)", version_line)
    if not match:
        raise RuntimeError(f"Cannot parse rustc version: {version_line}")
    return tuple(int(x) for x in match.groups())  # type: ignore[return-value]


def ensure_rust_version() -> None:
    """Ensure Rust is new enough; try to update via rustup if not."""
    rust_version_line = get_version_output("rustc")
    current = parse_rust_version(rust_version_line)
    print(f"[INFO] Rust version: {rust_version_line} ({current})")
    if current < MIN_RUST_VERSION:
        print(
            f"[WARN] Rust {current} is older than required {MIN_RUST_VERSION}. "
            "Attempting rustup update..."
        )
        rustup = resolve_tool("rustup")
        try:
            run([rustup, "update", "stable"])
        except Exception as exc:
            raise RuntimeError(
                f"Rust update failed. Please install Rust >= {MIN_RUST_VERSION}."
            ) from exc
        # Re-verify
        rust_version_line = get_version_output("rustc")
        current = parse_rust_version(rust_version_line)
        if current < MIN_RUST_VERSION:
            raise RuntimeError(
                f"Rust is still {current} after update. Required >= {MIN_RUST_VERSION}."
            )
    else:
        print(f"[OK] Rust {current} meets minimum {MIN_RUST_VERSION}")


def ensure_gitattributes() -> None:
    """Ensure LF .gitattributes rules exist so Windows CRLF does not break checks."""
    gitattributes = REPO_ROOT / ".gitattributes"
    required_rules = [
        "Cargo.lock text eol=lf",
        "Cargo.toml text eol=lf",
        "tauri.conf.json text eol=lf",
        "web/package.json text eol=lf",
        "packages/*/package.json text eol=lf",
        "legal/EULA.zh-CN.rtf text eol=lf",
    ]

    existing = gitattributes.read_text(encoding="utf-8") if gitattributes.exists() else ""
    missing = [rule for rule in required_rules if rule not in existing]

    if missing:
        print("[INFO] Adding LF rules to .gitattributes")
        with gitattributes.open("a", encoding="utf-8") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write("# Enforce LF for files touched by version/license sync scripts\n")
            for rule in missing:
                f.write(rule + "\n")
        # Renormalize affected files so git index matches LF working tree.
        run([resolve_tool("git"), "add", "--renormalize", "."])
    else:
        print("[OK] .gitattributes LF rules already present")


def find_nsis_compiler() -> Path | None:
    """Find the NSIS makensis compiler on Windows.

    Searches PATH first, then common installation directories derived from
    environment variables rather than hard-coded user paths.
    """
    path_exe = shutil.which("makensis")
    if path_exe:
        return Path(path_exe)

    program_files_dirs: list[Path] = []
    for env_var in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        value = os.environ.get(env_var)
        if value:
            program_files_dirs.append(Path(value))

    # Also check the root of each system drive for portable installs.
    for drive_letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        drive = Path(f"{drive_letter}:\\")
        if drive.exists():
            program_files_dirs.append(drive)

    for base in program_files_dirs:
        candidate = base / "NSIS" / "makensis.exe"
        if candidate.exists():
            return candidate
    return None


def install_dependencies() -> None:
    """Install pnpm workspace dependencies."""
    print("\n=== Installing dependencies ===")
    run([resolve_tool("pnpm"), "install"])


def run_preflight_checks() -> None:
    """Run license:check, version:check, and typecheck."""
    print("\n=== Running preflight checks ===")
    pnpm = resolve_tool("pnpm")
    run([pnpm, "run", "license:check"])
    run([pnpm, "run", "version:check"])
    run([pnpm, "run", "typecheck"])


def build_web() -> None:
    """Build web frontend for desktop."""
    print("\n=== Building web frontend ===")
    run([resolve_tool("pnpm"), "run", "web:build:desktop"])


def build_rust() -> None:
    """Build Rust release binary."""
    print("\n=== Building Rust release binary ===")
    run([resolve_tool("cargo"), "build", "--release"])


def build_tauri_bundle(bundle: str) -> None:
    """Build Tauri installer bundle (msi or nsis)."""
    print(f"\n=== Building Tauri {bundle.upper()} bundle ===")
    if bundle == "nsis":
        if not find_nsis_compiler():
            print("[WARN] NSIS (makensis) not found. Skipping NSIS bundle.")
            return
    run([resolve_tool("pnpm"), "exec", "tauri", "build", "--bundles", bundle])


def expected_msi_filename() -> str:
    """Return the expected MSI filename based on project config.

    Tauri v2 default MSI name: <productName>_<version>_<arch>_<language>.msi
    For the default x64 Windows target this is *_x64_en-US.msi.
    """
    product = get_product_name()
    version = get_desktop_version()
    return f"{product}_{version}_x64_en-US.msi"


def verify_artifacts(bundle: str) -> list[Path]:
    """Verify expected build artifacts exist."""
    print("\n=== Verifying artifacts ===")
    release_dir = REPO_ROOT / "target" / "release"
    exe_name = f"{get_cargo_package_name()}.exe"
    exe = release_dir / exe_name
    artifacts: list[Path] = []

    if not exe.exists():
        raise RuntimeError(f"Release executable not found: {exe}")
    print(f"[OK] {exe} ({exe.stat().st_size:,} bytes)")
    artifacts.append(exe)

    bundle_dir = release_dir / "bundle"
    if bundle == "msi":
        msi_dir = bundle_dir / "msi"
        expected = expected_msi_filename()
        msi = msi_dir / expected
        if not msi.exists():
            # Fallback: accept any MSI with the version in the name.
            msi_files = list(msi_dir.glob(f"*_{get_desktop_version()}*_x64_en-US.msi"))
            if not msi_files:
                raise RuntimeError(f"MSI installer not found in {msi_dir} (expected {expected})")
            msi = msi_files[0]
        print(f"[OK] {msi} ({msi.stat().st_size:,} bytes)")
        artifacts.append(msi)
    elif bundle == "nsis":
        nsis_dir = bundle_dir / "nsis"
        nsis_files = list(nsis_dir.glob("*.exe"))
        if nsis_files:
            for f in nsis_files:
                print(f"[OK] {f} ({f.stat().st_size:,} bytes)")
                artifacts.append(f)
        else:
            print("[INFO] No NSIS installer generated (tooling may be missing)")

    return artifacts


def print_summary(artifacts: list[Path], duration: float) -> None:
    """Print a final summary."""
    print("\n" + "=" * 60)
    print("BUILD SUCCESS")
    print("=" * 60)
    print(f"Total time: {duration:.1f}s")
    print("Artifacts:")
    for artifact in artifacts:
        rel = artifact.relative_to(REPO_ROOT)
        print(f"  - {rel} ({artifact.stat().st_size:,} bytes)")
    print("=" * 60)


def fail(message: str) -> NoReturn:
    """Print error and exit."""
    print(f"\n[ERROR] {message}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Hermes Agent CN Desktop (Windows)")
    parser.add_argument(
        "--tauri-bundle",
        choices=["msi", "nsis"],
        default="msi",
        help="Tauri installer bundle to produce (default: msi)",
    )
    parser.add_argument(
        "--skip-preflight",
        action="store_true",
        help="Skip license/version/typecheck preflight",
    )
    parser.add_argument(
        "--skip-tauri-bundle",
        action="store_true",
        help="Skip Tauri installer packaging",
    )
    args = parser.parse_args()

    start = time.time()
    try:
        print("=== Hermes Agent CN Desktop Build (Windows) ===")
        print(f"Repository root: {REPO_ROOT}")

        # Environment checks
        for tool in REQUIRED_TOOLS:
            resolve_tool(tool)
            version = get_version_output(tool)
            print(f"[OK] {version}")

        ensure_rust_version()
        ensure_gitattributes()
        install_dependencies()

        if not args.skip_preflight:
            run_preflight_checks()
        else:
            print("[INFO] Skipping preflight checks")

        build_web()
        build_rust()

        if not args.skip_tauri_bundle:
            build_tauri_bundle(args.tauri_bundle)
        else:
            print("[INFO] Skipping Tauri bundle")

        artifacts = verify_artifacts(
            bundle=args.tauri_bundle if not args.skip_tauri_bundle else "none"
        )
        print_summary(artifacts, time.time() - start)

    except RuntimeError as exc:
        fail(str(exc))
    except KeyboardInterrupt:
        fail("Build interrupted by user")
    except Exception as exc:
        fail(f"Unexpected error: {exc}")


if __name__ == "__main__":
    main()
