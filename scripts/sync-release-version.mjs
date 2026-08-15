#!/usr/bin/env node
// Unified release version bump — Desktop + Core ship ONE version number.
//
// The unified self-update flow requires the desktop shell and the backend
// kernel to be the SAME version (the landing manifest enforces it via
// `sameVersion`). This script bumps both repos in one shot:
//
//   Desktop (this repo):
//     package.json + web/packages + tauri.conf.json + Cargo.toml + Cargo.lock
//     + README/docs + release-desktop.yml + web/src/lib/build-info.ts
//     EXPECTED_BACKEND_VERSION (via the refactored sync-desktop-version.mjs)
//   Core (`--core D:/hermes-agent-cn`):
//     pyproject.toml [project].version
//     hermes_cli/__init__.py __version__
//
// Usage:
//   node scripts/sync-release-version.mjs 0.8.0 [--core D:/hermes-agent-cn]
//   node scripts/sync-release-version.mjs 0.8.0 --core D:/hermes-agent-cn --dry-run
//   node scripts/sync-release-version.mjs --check --core D:/hermes-agent-cn
//
// `--dry-run` prints what WOULD change without touching anything; `--check`
// exits 1 when either repo is out of sync (used by CI gate).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncDesktopVersion } from "./sync-desktop-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  const args = { version: undefined, core: undefined, dryRun: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--core") {
      args.core = argv[i + 1];
      i += 1;
    } else if (args.version === undefined && SEMVER_RE.test(arg)) {
      args.version = arg;
    }
  }
  return args;
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function writeText(path, content) {
  writeFileSync(path, content);
}

function replaceOrThrow(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`Cannot find ${label}`);
  }
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
}

/** Bump Core's version: pyproject.toml + hermes_cli/__init__.py __version__. */
function syncCoreVersion(coreRoot, version, { write }) {
  const changed = [];
  const pending = [];

  const pyprojectPath = resolve(coreRoot, "pyproject.toml");
  const initPath = resolve(coreRoot, "hermes_cli", "__init__.py");

  const record = (label, actuallyChanged) => {
    if (write) {
      if (actuallyChanged) changed.push(label);
    } else if (actuallyChanged) {
      pending.push(label);
    }
  };

  const apply = (path, label, updater) => {
    let text = readText(path);
    const next = updater(text);
    if (next === text) return;
    record(label, true);
    if (write) writeText(path, next);
  };

  apply(
    pyprojectPath,
    `${pathLabel(coreRoot)} pyproject.toml [project].version`,
    (text) =>
      replaceOrThrow(
        text,
        /(^\[project\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
        `$1"${version}"`,
        "pyproject.toml [project].version",
      ),
  );

  apply(
    initPath,
    `${pathLabel(coreRoot)} hermes_cli/__init__.py __version__`,
    (text) =>
      replaceOrThrow(
        text,
        /(__version__\s*=\s*["'])[^"']+(["''])/,
        `$1${version}$2`,
        "hermes_cli/__init__.py __version__",
      ),
  );

  return { changed, pending };
}

function pathLabel(path) {
  return path.includes("\\") ? path.split("\\").slice(-2).join("/") : path.split("/").slice(-2).join("/");
}

const args = parseArgs(process.argv.slice(2));

if (!args.check && !args.version) {
  console.error("Usage: node scripts/sync-release-version.mjs <version> [--core D:/hermes-agent-cn] [--dry-run] [--check]");
  process.exit(2);
}

const version = args.version;
const write = !args.dryRun && !args.check;
const failures = [];

// --- Desktop ---
let desktop;
try {
  desktop = await syncDesktopVersion({ version, write });
} catch (error) {
  failures.push(`Desktop: ${error.message}`);
  desktop = { version: version ?? "?", changed: [], pending: [] };
}
const desktopDirty = desktop.pending.length > 0 || desktop.changed.length > 0;

// --- Core (optional) ---
let core = { changed: [], pending: [] };
if (args.core) {
  const coreRoot = resolve(args.core);
  if (!readTextSafe(resolve(coreRoot, "pyproject.toml"))) {
    failures.push(`Core 目录缺少 pyproject.toml：${coreRoot}`);
  } else {
    try {
      core = syncCoreVersion(coreRoot, version ?? desktop.version, { write });
    } catch (error) {
      failures.push(`Core: ${error.message}`);
    }
  }
}
const coreDirty = core.pending.length > 0 || core.changed.length > 0;

function readTextSafe(path) {
  try {
    return readText(path);
  } catch {
    return null;
  }
}

if (args.check) {
  if (desktopDirty || coreDirty || failures.length > 0) {
    console.error(`Release version ${desktop.version} is NOT synchronized:`);
    for (const f of desktop.pending) console.error(`- desktop: ${f}`);
    for (const f of core.pending) console.error(`- core: ${f}`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log(`Release version ${desktop.version} is synchronized (desktop + core).`);
  process.exit(0);
}

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}

console.log(`Release version ${version} synced.`);
for (const f of desktop.changed) console.log(`- desktop: ${f}`);
for (const f of core.changed) console.log(`- core: ${f}`);
if (args.dryRun) {
  console.log("(--dry-run: nothing was written)");
  for (const f of desktop.pending) console.log(`- [would change] desktop: ${f}`);
  for (const f of core.pending) console.log(`- [would change] core: ${f}`);
}
