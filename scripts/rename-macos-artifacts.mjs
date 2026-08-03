#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macosArchLabel, macosDmgName } from "./windows-artifact-names.mjs";

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = argValue("--target", null);
const profile = argValue("--profile", "release");
const brandId = argValue("--brand", process.env.BRAND || "huanxingcomhermes");
const arch = macosArchLabel(target || "aarch64-apple-darwin");
const releaseDir = target
  ? join(repoRoot, "target", target, profile)
  : join(repoRoot, "target", profile);
const dmgDir = join(releaseDir, "bundle", "dmg");

if (!existsSync(dmgDir)) {
  throw new Error(`macOS DMG directory not found (build first): ${dmgDir}`);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const brand = JSON.parse(readFileSync(join(repoRoot, "brands", `${brandId}.json`), "utf8"));
const desiredName = macosDmgName({
  artifactBrandName: brand.artifactBrandName,
  version: pkg.version,
  arch,
});
const desiredPath = join(dmgDir, desiredName);
const candidates = readdirSync(dmgDir)
  .filter((name) => name.toLowerCase().endsWith(".dmg") && name !== desiredName)
  .sort();

if (candidates.length > 1) {
  throw new Error(`Expected one Tauri DMG, found ${candidates.length}: ${candidates.join(", ")}`);
}

let previousName = desiredName;
if (candidates.length === 1) {
  previousName = candidates[0];
  if (existsSync(desiredPath)) rmSync(desiredPath);
  renameSync(join(dmgDir, previousName), desiredPath);
  console.log(`Renamed macOS DMG: ${previousName} -> ${desiredName}`);
} else if (!existsSync(desiredPath)) {
  throw new Error(`Expected a Tauri DMG under ${dmgDir}`);
} else {
  console.log(`macOS DMG already has the branded name: ${desiredPath}`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `dmg_path=${desiredPath}`,
      `dmg_name=${desiredName}`,
      `previous_dmg_name=${previousName}`,
      "",
    ].join("\n"),
  );
}
