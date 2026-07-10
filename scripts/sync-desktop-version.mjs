#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

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

const desktopVersion = requireDesktopVersion();
const desktopTag = `v${desktopVersion}`;
const changed = [];

function updateText(relativePath, updater) {
  const before = readText(relativePath);
  const after = updater(before);
  if (after === before) return;
  changed.push(relativePath);
  if (!checkOnly) writeText(relativePath, after);
}

function updateJson(relativePath, updater) {
  const value = readJson(relativePath);
  updater(value);
  updateText(relativePath, () => stableJson(value));
}

function replaceOrThrow(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`Cannot find ${label}`);
  }
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
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

if (changed.length > 0) {
  if (checkOnly) {
    console.error(`Desktop version is not synchronized with package.json (${desktopVersion}):`);
    for (const file of changed) console.error(`- ${file}`);
    process.exit(1);
  }
  console.log(`Synchronized desktop version ${desktopVersion}:`);
  for (const file of changed) console.log(`- ${file}`);
} else {
  console.log(`Desktop version ${desktopVersion} is already synchronized.`);
}
