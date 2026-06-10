#!/usr/bin/env node
/**
 * Install a signed release DMG into /Applications without picking up a stale
 * mounted volume. Verifies bundled runtime metadata before copying.
 *
 * Usage:
 *   node scripts/install-release-dmg.mjs --tag v0.3.3-beta.2
 *   node scripts/install-release-dmg.mjs --dmg /path/to/Hermes.Agent.CN.Desktop_0.3.2_aarch64.dmg
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

function usage() {
  console.log(`Usage: node scripts/install-release-dmg.mjs [options]

Options:
  --tag <tag>          GitHub release tag (default: v0.3.3-beta.2)
  --dmg <path>         Local .dmg path (skips download)
  --expected-runtime <ver>  Expected bundled runtimeVersion (optional check)
  --help`);
}

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function dmgAssetName() {
  if (platform() !== "darwin") throw new Error("install-release-dmg currently supports macOS only");
  return arch() === "arm64"
    ? "Hermes.Agent.CN.Desktop_0.3.2_aarch64.dmg"
    : "Hermes.Agent.CN.Desktop_0.3.2_x64.dmg";
}

function detachHermesVolumes() {
  const info = spawnSync("hdiutil", ["info"], { encoding: "utf8" });
  if (info.status !== 0) return;
  for (const line of info.stdout.split("\n")) {
    const match = line.match(/\/Volumes\/Hermes Agent CN Desktop[^\s]*/);
    if (match) {
      spawnSync("hdiutil", ["detach", match[0], "-quiet"], { stdio: "ignore" });
    }
  }
}

function mountDmg(dmgPath) {
  detachHermesVolumes();
  run("hdiutil", ["attach", dmgPath, "-nobrowse", "-quiet"]);
  const info = spawnSync("hdiutil", ["info"], { encoding: "utf8" });
  const blocks = info.stdout.split("================================================");
  for (const block of blocks) {
    if (!block.includes(dmgPath)) continue;
    const match = block.match(/\/Volumes\/Hermes Agent CN Desktop[^\n]*/);
    if (match) return match[0].trim();
  }
  throw new Error(`could not find mount point for ${dmgPath}`);
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

const tag = argValue("--tag", "v0.3.3-beta.2");
const expectedRuntime = argValue("--expected-runtime");
let dmgPath = argValue("--dmg");

if (!dmgPath) {
  const tmp = mkdtempSync(join(tmpdir(), "hermes-release-dmg-"));
  dmgPath = join(tmp, dmgAssetName());
  const url = `https://github.com/Eynzof/Hermes-CN-Desktop/releases/download/${encodeURIComponent(tag)}/${dmgAssetName()}`;
  console.log(`download: ${url}`);
  run("curl", ["-L", "--fail", "-o", dmgPath, url]);
}

if (!existsSync(dmgPath)) throw new Error(`DMG not found: ${dmgPath}`);

spawnSync("osascript", ["-e", 'quit app "Hermes Agent CN Desktop"'], { stdio: "ignore" });

const volume = mountDmg(dmgPath);
const appSrc = join(volume, "Hermes Agent CN Desktop.app");
const readme = join(appSrc, "Contents/Resources/bundled-runtime/README.generated.txt");
if (!existsSync(readme)) throw new Error(`missing bundled-runtime README in DMG: ${readme}`);
const readmeText = readFileSync(readme, "utf8");
console.log(readmeText.trim());

if (expectedRuntime) {
  const match = readmeText.match(/^runtimeVersion=(.+)$/m);
  const actual = match?.[1]?.trim();
  if (actual !== expectedRuntime) {
    throw new Error(`bundled runtime mismatch: expected ${expectedRuntime}, got ${actual ?? "(missing)"}`);
  }
}

const appDest = "/Applications/Hermes Agent CN Desktop.app";
rmSync(appDest, { recursive: true, force: true });
run("ditto", [appSrc, appDest]);
run("hdiutil", ["detach", volume, "-quiet"]);

const version = run("defaults", ["read", join(appDest, "Contents/Info.plist"), "CFBundleShortVersionString"]);
console.log(`installed Hermes Agent CN Desktop ${version} -> ${appDest}`);
console.log("open with: open -a \"Hermes Agent CN Desktop\"");