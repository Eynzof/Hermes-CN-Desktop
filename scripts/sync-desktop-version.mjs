#!/usr/bin/env node
// Sync the desktop shell version (root package.json) out to every place that
// must carry it: web/ + packages/* package.json, tauri.conf.json, Cargo.toml,
// Cargo.lock, READMEs, docs, and the release workflow. The backend/kernel
// version is a separate contract sourced from the managed runtime record.
//
// Usage:
//   node scripts/sync-desktop-version.mjs            # sync from package.json
//   node scripts/sync-desktop-version.mjs --check    # verify only, exit 1 on drift
//
// The core logic is exported so scripts/sync-release-version.mjs can drive the
// same writes for the unified cross-repo version bump.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pathOf(relativePath) {
  return resolve(repoRoot, relativePath);
}

function readText(relativePath) {
  return readFileSync(pathOf(relativePath), "utf8");
}

function writeText(relativePath, content) {
  writeFileSync(pathOf(relativePath), content);
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireDesktopVersion() {
  const pkg = readJson("package.json");
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json version is not a valid desktop SemVer: ${JSON.stringify(pkg.version)}`);
  }
  return version;
}

function replaceOrThrow(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`Cannot find ${label}`);
  }
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
}

/**
 * Apply the desktop version to every location that mirrors it.
 *
 * @param {object} options
 * @param {string} [options.version]  Version to use; when omitted, the current
 *                                    package.json version is used (legacy CLI
 *                                    behavior).
 * @param {boolean} [options.write]   When false, only collect what WOULD change
 *                                    without touching the filesystem (--dry-run).
 * @returns {Promise<{version: string, changed: string[], pending: string[]}>}
 */
export async function syncDesktopVersion({ version, write = true } = {}) {
  const desktopVersion = version?.trim() || requireDesktopVersion();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(desktopVersion)) {
    throw new Error(`desktop version is not a valid SemVer: ${JSON.stringify(desktopVersion)}`);
  }
  const desktopTag = `v${desktopVersion}`;
  const changed = [];
  const pending = [];
  const record = (relativePath, actuallyChanged) => {
    if (write) {
      if (actuallyChanged) changed.push(relativePath);
    } else if (actuallyChanged) {
      pending.push(relativePath);
    }
  };

  const updateText = (relativePath, updater) => {
    const before = readText(relativePath);
    const after = updater(before);
    if (after === before) return;
    record(relativePath, true);
    if (write) writeText(relativePath, after);
  };

  const updateJson = (relativePath, updater) => {
    const value = readJson(relativePath);
    updater(value);
    updateText(relativePath, () => stableJson(value));
  };

  if (version?.trim()) {
    // Version was supplied: bump the root package.json itself.
    updateJson("package.json", (pkg) => {
      pkg.version = desktopVersion;
    });
  }

  for (const relativePath of [
    "web/package.json",
    "packages/protocol/package.json",
    "packages/shared-ui/package.json",
  ]) {
    updateJson(relativePath, (pkg) => {
      pkg.version = desktopVersion;
    });
  }

  updateJson("tauri.conf.json", (config) => {
    config.version = desktopVersion;
  });

  updateText("Cargo.toml", (text) => replaceOrThrow(
    text,
    /(^\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
    `$1"${desktopVersion}"`,
    "Cargo.toml [package].version",
  ));

  updateText("Cargo.lock", (text) => replaceOrThrow(
    text,
    /(\[\[package\]\]\r?\nname = "hermes-agent-cn-desktop"\r?\nversion = )"[^"]+"/,
    `$1"${desktopVersion}"`,
    "Cargo.lock hermes-agent-cn-desktop package version",
  ));

  function syncReadme(text, currentVersionLabelPattern) {
    let next = replaceOrThrow(text, currentVersionLabelPattern, `$1${desktopTag}$2`, "README current desktop version");
    next = next.replace(
      /(Hermes\.Agent\.CN\.Desktop_)[^_]+(_aarch64\.dmg)/g,
      `$1${desktopVersion}$2`,
    );
    next = next.replace(
      /(Hermes\.Agent\.CN\.Desktop_)[^_]+(_x64\.dmg)/g,
      `$1${desktopVersion}$2`,
    );
    next = next.replace(
      /(Hermes\.Agent\.CN\.Desktop_)[^_]+(_x64-setup\.exe)/g,
      `$1${desktopVersion}$2`,
    );
    return next;
  }

  updateText("README.md", (text) => syncReadme(text, /(当前版本是 `)v[^`]+(`)/));
  updateText("README.en-US.md", (text) => syncReadme(text, /(Current release: `)v[^`]+(`)/));

  updateText("docs/macos-signing-and-notarization.md", (text) => text.replace(
    /(Hermes Agent CN Desktop_)[^_]+(_aarch64\.dmg)/g,
    `$1${desktopVersion}$2`,
  ));

  updateText("docs/managed-runtime.md", (text) => {
    let next = text.replace(
      /git tag v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?; git push origin v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g,
      `git tag ${desktopTag}; git push origin ${desktopTag}`,
    );
    next = next.replace(
      /releases\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g,
      `releases/${desktopTag}`,
    );
    return next;
  });

  updateText(".github/workflows/release-desktop.yml", (text) => {
    let next = text.replace(/(tags matching `v\*` \(e\.g\. `)v[^`]+(`\))/g, `$1${desktopTag}$2`);
    next = next.replace(/(Tag name to associate the build with \(e\.g\. )v[^)]+(\))/g, `$1${desktopTag}$2`);
    return next;
  });

  return { version: desktopVersion, changed, pending };
}

// CLI entry (kept behavior-identical to the original script).
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const checkOnly = process.argv.includes("--check");
  const result = await syncDesktopVersion({ write: !checkOnly });
  if (result.pending.length > 0 || result.changed.length > 0) {
    if (checkOnly) {
      console.error(`Desktop version is not synchronized with package.json (${result.version}):`);
      for (const file of result.pending) console.error(`- ${file}`);
      process.exit(1);
    }
    console.log(`Synchronized desktop version ${result.version}:`);
    for (const file of result.changed) console.log(`- ${file}`);
  } else {
    console.log(`Desktop version ${result.version} is already synchronized.`);
  }
}
