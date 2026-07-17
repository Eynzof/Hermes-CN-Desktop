#!/usr/bin/env python3
"""
Hermes Agent CN Desktop — Windows unified build script.

Based on manual build experience:
- Requires Rust >= 1.77 (Tauri v2 lockfile version 4).
- Requires pnpm and Node.
- Windows CRLF line endings break version:check/license:check because the
  sync scripts use LF-only regexes; we enforce LF via .gitattributes and
  direct file conversion.
- Rust 1.96.x has a known ICE (div-by-zero in memmap2 on Windows).
  The script auto-installs Rust 1.88.0 as a fallback when the ICE is detected.
- If Rust/Cargo is missing entirely, the script auto-downloads and installs
  rustup + stable Rust.
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
import urllib.request
from pathlib import Path
from typing import Any, NoReturn

# Repository root is three levels above this script:
# scripts/build_scripts/build_windows.py -> scripts/build_scripts -> scripts -> repo_root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TAURI_CONF_PATH = REPO_ROOT / "tauri.conf.json"
PACKAGE_JSON_PATH = REPO_ROOT / "package.json"
CARGO_TOML_PATH = REPO_ROOT / "Cargo.toml"
CARGO_LOCK_PATH = REPO_ROOT / "Cargo.lock"

MIN_RUST_VERSION = (1, 77, 0)
# Rust 1.96.x has a known ICE (divide-by-zero in memmap2 on Windows).
# These versions need a fallback to 1.88.0.
RUST_BAD_VERSIONS: list[tuple[int, int, int]] = [
    (1, 96, 0),
    (1, 96, 1),
]
RUST_FALLBACK_VERSION = "1.88.0"
REQUIRED_TOOLS = ["node", "pnpm"]

# Maps tool name -> absolute executable path (populated in check_environment).
TOOL_PATHS: dict[str, str] = {}

# Files that must have LF line endings for version/license sync scripts.
LF_REQUIRED_FILES = [
    "Cargo.lock",
    "Cargo.toml",
    "tauri.conf.json",
    "web/package.json",
    "packages/protocol/package.json",
    "packages/shared-ui/package.json",
    "legal/EULA.zh-CN.rtf",
    "README.md",
    "README.en-US.md",
]


def load_json(path: Path) -> dict[str, Any]:
    """Load a JSON file."""
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def read_text(path: Path) -> str:
    """Read a text file."""
    with path.open("r", encoding="utf-8") as f:
        return f.read()


def write_text(path: Path, content: str) -> None:
    """Write a text file with UTF-8 encoding."""
    path.write_text(content, encoding="utf-8")


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


def cargo_path() -> str | None:
    """Find cargo.exe path, checking PATH and the rustup default location."""
    cargo = shutil.which("cargo")
    if cargo:
        return cargo
    # Check the standard rustup install location
    home_cargo = Path(os.environ.get("USERPROFILE", "")) / ".cargo" / "bin" / "cargo.exe"
    if home_cargo.exists():
        return str(home_cargo)
    return None


def rustup_path() -> str | None:
    """Find rustup.exe."""
    rup = shutil.which("rustup")
    if rup:
        return rup
    home_rustup = Path(os.environ.get("USERPROFILE", "")) / ".cargo" / "bin" / "rustup.exe"
    if home_rustup.exists():
        return str(home_rustup)
    return None


def run(
    cmd: list[str] | str,
    *,
    cwd: Path | None = None,
    check: bool = True,
    capture: bool = False,
    env: dict[str, str] | None = None,
    timeout: int | None = None,
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
        timeout=timeout,
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


def rust_version_tuple() -> tuple[int, int, int]:
    """Get the current Rust version as a tuple."""
    # Try rustc first, fall back to cargo for version info
    rustc = shutil.which("rustc")
    if rustc:
        line = run([rustc, "--version"], capture=True).stdout.strip()
        return parse_rust_version(line)
    # If we only have cargo, parse from cargo --version
    cargo = cargo_path()
    if cargo:
        line = run([cargo, "--version"], capture=True).stdout.strip()
        match = re.search(r"cargo\s+(\d+)\.(\d+)\.(\d+)", line)
        if match:
            return tuple(int(x) for x in match.groups())  # type: ignore[return-value]
    raise RuntimeError("Cannot determine Rust version: rustc and cargo not found")


def is_bad_rust_version(version: tuple[int, int, int]) -> bool:
    """Check if the given Rust version is known to have the memmap2 ICE."""
    for bad in RUST_BAD_VERSIONS:
        if version[:2] == bad[:2] and version >= bad:
            return True
    return False


# ---------------------------------------------------------------------------
# Rust installation & version management
# ---------------------------------------------------------------------------

def install_rust() -> None:
    """Download and install Rust via rustup if not already present."""
    print("\n=== Installing Rust ===")
    rustup_exe = Path(os.environ.get("TEMP", "C:\\Temp")) / "rustup-init.exe"

    if not rustup_exe.exists():
        url = "https://win.rustup.rs"
        print(f"[INFO] Downloading rustup-init.exe from {url} ...")
        try:
            urllib.request.urlretrieve(url, str(rustup_exe))
        except Exception as exc:
            raise RuntimeError(
                f"Failed to download rustup-init.exe: {exc}. "
                "Please install Rust manually from https://rustup.rs"
            ) from exc
        print("[OK] Downloaded rustup-init.exe")

    print("[INFO] Running rustup-init.exe (this may take a minute)...")
    result = subprocess.run(
        [str(rustup_exe), "-y", "--default-toolchain", "stable", "--profile", "minimal"],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise RuntimeError("rustup-init.exe failed. Try installing Rust manually from https://rustup.rs")

    print("[OK] Rust installed successfully via rustup")

    # Add cargo bin dir to PATH for subsequent commands in this session
    cargo_home = Path(os.environ.get("USERPROFILE", "")) / ".cargo" / "bin"
    if cargo_home.exists():
        os.environ["PATH"] = str(cargo_home) + os.pathsep + os.environ.get("PATH", "")
        # Register cargo/rustc in TOOL_PATHS cache
        for tool_name in ("cargo", "rustc", "rustup"):
            candidate = cargo_home / f"{tool_name}.exe"
            if candidate.exists():
                TOOL_PATHS[tool_name] = str(candidate)


def ensure_rust_available() -> None:
    """Ensure Rust is installed; auto-install if missing."""
    if cargo_path() and shutil.which("rustc"):
        print("[OK] Rust is already installed")
        return

    print("[INFO] Rust/Cargo is not installed. Auto-installing...")
    install_rust()

    # Verify installation
    if not cargo_path() or not shutil.which("rustc"):
        raise RuntimeError(
            "Rust installation completed but cargo/rustc still not found. "
            "Please restart your terminal and try again, or install Rust manually."
        )


def ensure_rust_version() -> None:
    """Ensure Rust is new enough; try to update via rustup if not.
    Also handles known-bad versions (e.g. 1.96.x with memmap2 ICE)
    by falling back to a known-good version.
    """
    current = rust_version_tuple()
    print(f"[INFO] Rust version: {current}")

    # Case 1: Version is too old
    if current < MIN_RUST_VERSION:
        print(
            f"[WARN] Rust {current} is older than required {MIN_RUST_VERSION}. "
            "Attempting rustup update..."
        )
        rup = rustup_path()
        if not rup:
            # Install rustup if missing but rustc/cargo exist somehow
            install_rust()
            rup = rustup_path()
        if rup:
            run([rup, "update", "stable"])
            current = rust_version_tuple()
        if current < MIN_RUST_VERSION:
            raise RuntimeError(
                f"Rust is still {current} after update. Required >= {MIN_RUST_VERSION}. "
                "Please install a newer Rust: https://rustup.rs"
            )
        print(f"[OK] Updated to Rust {current}")

    # Case 2: Known-bad version (e.g. 1.96.x with memmap2 ICE)
    elif is_bad_rust_version(current):
        print(
            f"[WARN] Rust {current} has a known ICE (Internal Compiler Error) "
            "on Windows (divide-by-zero in memmap2). "
            f"Falling back to Rust {RUST_FALLBACK_VERSION}..."
        )
        rup = rustup_path()
        if not rup:
            raise RuntimeError("rustup is required to install a fallback Rust version.")
        # Install the fallback version
        run([rup, "install", RUST_FALLBACK_VERSION])
        # Set an override for this directory
        run([rup, "override", "set", RUST_FALLBACK_VERSION])
        new_version = rust_version_tuple()
        print(f"[OK] Using Rust {new_version} (overridden for this project)")
        if is_bad_rust_version(new_version):
            raise RuntimeError(
                f"Fallback Rust {RUST_FALLBACK_VERSION} also has known ICE issues. "
                "Please manually install a working Rust version (e.g. 1.88.0)."
            )
    else:
        print(f"[OK] Rust {current} meets minimum {MIN_RUST_VERSION}")


# ---------------------------------------------------------------------------
# CRLF / line-ending fixes
# ---------------------------------------------------------------------------

def ensure_lf_line_endings() -> None:
    """Convert CRLF to LF in key files that the version/license sync scripts
    read with LF-only regexes. This complements .gitattributes rules because
    'git add --renormalize' only updates the index, not the working tree.
    """
    print("\n=== Ensuring LF line endings in key files ===")
    converted = 0
    for rel_path in LF_REQUIRED_FILES:
        full_path = REPO_ROOT / rel_path
        if not full_path.exists():
            continue
        with full_path.open("rb") as f:
            data = f.read()
        crlf_count = data.count(b"\r\n")
        if crlf_count > 0:
            data = data.replace(b"\r\n", b"\n")
            with full_path.open("wb") as f:
                f.write(data)
            print(f"  [FIX] {rel_path}: converted {crlf_count} CRLF -> LF")
            converted += 1
    if converted == 0:
        print("  [OK] All key files already have LF endings")
    else:
        print(f"  [DONE] Converted {converted} file(s)")


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
        git = shutil.which("git")
        if git:
            run([git, "add", "--renormalize", "."])
    else:
        print("[OK] .gitattributes LF rules already present")


# ---------------------------------------------------------------------------
# License sync (preflight helper)
# ---------------------------------------------------------------------------

def ensure_license_synced() -> None:
    """Run license:sync if the EULA RTF is out of date, to prevent preflight
    from failing on a stale generated file.
    """
    pnpm = resolve_tool("pnpm")
    # Quick check: run license:check; if it fails, sync then retry
    result = run([pnpm, "run", "license:check"], check=False)
    if result.returncode != 0:
        print("[INFO] License check failed. Running license:sync...")
        run([pnpm, "run", "license:sync"])
        # Verify after sync
        run([pnpm, "run", "license:check"])
    else:
        print("[OK] License RTF is up to date")


# ---------------------------------------------------------------------------
# Build steps
# ---------------------------------------------------------------------------

def install_dependencies() -> None:
    """Install pnpm workspace dependencies."""
    print("\n=== Installing dependencies ===")
    run([resolve_tool("pnpm"), "install"])


def run_preflight_checks() -> None:
    """Run license:check, version:check, and typecheck."""
    print("\n=== Running preflight checks ===")
    pnpm = resolve_tool("pnpm")
    # First ensure the license is synced so the check won't fail
    ensure_license_synced()
    run([pnpm, "run", "version:check"])
    run([pnpm, "run", "typecheck"])


def build_web() -> None:
    """Build web frontend for desktop."""
    print("\n=== Building web frontend ===")
    run([resolve_tool("pnpm"), "run", "web:build:desktop"])


def build_rust() -> None:
    """Build Rust release binary.

    If the build fails with a known ICE (Internal Compiler Error),
    automatically fall back to a known-good Rust version and retry.
    """
    print("\n=== Building Rust release binary ===")
    cargo = resolve_tool("cargo")
    try:
        run([cargo, "build", "--release"], timeout=900)
    except RuntimeError:
        # Check if the failure was an ICE in rustc
        # We need to re-run to capture the stderr for diagnosis
        result = subprocess.run(
            [cargo, "build", "--release"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=900,
        )
        stderr_lower = result.stderr.lower()

        # Detect known rustc ICE (memmap2 divide-by-zero on Windows)
        is_memmap_ice = (
            "panicked" in stderr_lower
            and "memmap2" in stderr_lower
            and "divide by zero" in stderr_lower
            and "internal compiler error" in stderr_lower
        )

        # Detect "requires rustc X.Y.Z" messages (version too old for deps)
        needs_newer_rust = re.search(
            r"requires rustc (\d+\.\d+\.\d+)",
            result.stderr,
        )

        if is_memmap_ice:
            print(
                "[WARN] Rust build failed due to a known rustc ICE "
                "(memmap2 divide-by-zero on Windows). "
                f"Falling back to Rust {RUST_FALLBACK_VERSION}..."
            )
            rup = rustup_path()
            if not rup:
                print("[ERROR] rustup not found; cannot install fallback version.")
                print(result.stderr, file=sys.stderr)
                raise RuntimeError(
                    "Build failed with rustc ICE. Install Rust 1.88.0 manually via "
                    "'rustup install 1.88.0 && rustup override set 1.88.0' and retry."
                )
            run([rup, "install", RUST_FALLBACK_VERSION])
            run([rup, "override", "set", RUST_FALLBACK_VERSION])
            print(f"[INFO] Retrying build with Rust {RUST_FALLBACK_VERSION}...")
            run([cargo, "build", "--release"], timeout=900)

        elif needs_newer_rust:
            required_ver = needs_newer_rust.group(1)
            print(
                f"[WARN] Rust is too old for some dependencies (requires {required_ver}). "
                f"Falling back to Rust {RUST_FALLBACK_VERSION}..."
            )
            rup = rustup_path()
            if rup:
                run([rup, "install", RUST_FALLBACK_VERSION])
                run([rup, "override", "set", RUST_FALLBACK_VERSION])
                print(f"[INFO] Retrying build with Rust {RUST_FALLBACK_VERSION}...")
                run([cargo, "build", "--release"], timeout=900)
            else:
                print(result.stderr, file=sys.stderr)
                raise RuntimeError(
                    f"Build failed: dependencies require Rust >= {required_ver}. "
                    "Install a newer Rust via 'rustup update stable'."
                )
        else:
            # Unknown error — re-raise
            print(result.stderr, file=sys.stderr)
            raise RuntimeError("Rust build failed (see errors above)")


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

        # Step 1: Ensure Rust is available (auto-install if missing)
        ensure_rust_available()

        # Step 2: Refresh PATH with cargo bin dir so all tools are visible
        cargo_bin = Path(os.environ.get("USERPROFILE", "")) / ".cargo" / "bin"
        if cargo_bin.exists():
            os.environ["PATH"] = str(cargo_bin) + os.pathsep + os.environ.get("PATH", "")

        # Step 3: Environment checks for tools other than Rust
        for tool in REQUIRED_TOOLS:
            resolve_tool(tool)
            version = get_version_output(tool)
            print(f"[OK] {version}")

        # Step 4: Ensure Rust version meets requirements and is not known-bad
        ensure_rust_version()

        # Step 5: Fix line endings (CRLF -> LF for key files)
        ensure_lf_line_endings()
        ensure_gitattributes()

        # Step 6: Install pnpm dependencies
        install_dependencies()

        # Step 7: Preflight checks
        if not args.skip_preflight:
            run_preflight_checks()
        else:
            print("[INFO] Skipping preflight checks")

        # Step 8: Build web frontend
        build_web()

        # Step 9: Build Rust release binary (with ICE auto-recovery)
        build_rust()

        # Step 10: Build Tauri bundle
        if not args.skip_tauri_bundle:
            build_tauri_bundle(args.tauri_bundle)
        else:
            print("[INFO] Skipping Tauri bundle")

        # Step 11: Verify artifacts
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