#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  tauriDefaultWindowsInstallerName,
  windowsArchLabel,
  windowsInstallerName,
} from "./windows-artifact-names.mjs";

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
const ifPresent = process.argv.includes("--if-present");
const arch = windowsArchLabel(target || "x86_64-pc-windows-msvc");
const releaseDir = target
  ? join(repoRoot, "target", target, profile)
  : join(repoRoot, "target", profile);
const nsisDir = join(releaseDir, "bundle", "nsis");

if (!existsSync(nsisDir)) {
  if (ifPresent) {
    console.log(`Windows NSIS directory is not present; nothing to rename: ${nsisDir}`);
    process.exit(0);
  }
  throw new Error(`Windows NSIS directory not found (build first): ${nsisDir}`);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const tauriConf = JSON.parse(readFileSync(join(repoRoot, "tauri.conf.json"), "utf8"));
const brand = JSON.parse(readFileSync(join(repoRoot, "brands", `${brandId}.json`), "utf8"));
const desiredName = windowsInstallerName({
  artifactBrandName: brand.artifactBrandName,
  version: pkg.version,
  arch,
});
const defaultName = tauriDefaultWindowsInstallerName({
  productName: tauriConf.productName,
  version: pkg.version,
  arch,
});
const desiredPath = join(nsisDir, desiredName);
const defaultPath = join(nsisDir, defaultName);

let previousName = defaultName;
if (existsSync(desiredPath)) {
  if (existsSync(defaultPath) && defaultPath !== desiredPath) {
    rmSync(desiredPath);
    renameSync(defaultPath, desiredPath);
    console.log(`Replaced stale branded installer: ${defaultName} -> ${desiredName}`);
  } else {
    previousName = desiredName;
    console.log(`Windows installer already has the branded name: ${desiredPath}`);
  }
} else {
  if (!existsSync(defaultPath)) {
    throw new Error(`Expected Tauri NSIS installer not found: ${defaultPath}`);
  }
  renameSync(defaultPath, desiredPath);
  console.log(`Renamed Windows installer: ${previousName} -> ${desiredName}`);
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `installer_path=${desiredPath}`,
      `installer_name=${desiredName}`,
      `previous_installer_name=${previousName}`,
      "",
    ].join("\n"),
  );
}
