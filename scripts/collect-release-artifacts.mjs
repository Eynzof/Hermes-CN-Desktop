#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeReleaseAssetName } from "./release-artifact-name.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少 --${name}`);
  return process.argv[index + 1];
}

function filesUnder(root) {
  if (!statSync(root).isDirectory()) return [root];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return entry.name.endsWith(".app") ? [] : filesUnder(full);
    return entry.isFile() ? [full] : [];
  });
}

const platform = option("platform");
const arch = option("arch");
const target = option("target");
const runtimeTag = option("runtime-tag");
const desktopSha = option("desktop-sha");
const outputIndex = process.argv.indexOf("--output");
const output = path.resolve(outputIndex >= 0 && process.argv[outputIndex + 1]
  ? process.argv[outputIndex + 1]
  : "release-assets");
const desktopPackage = JSON.parse(readFileSync("package.json", "utf8"));
const runtimeManifest = JSON.parse(
  readFileSync(`static/bundled-runtime/stable-${platform}-${arch}.json`, "utf8"),
);

const suffixes = {
  // Tauri v2 signs and distributes the final NSIS executable itself.
  win32: [".exe", ".exe.sig"],
  darwin: [".dmg", ".app.tar.gz", ".app.tar.gz.sig"],
  // Tauri selects the installer by the running Linux bundle type.
  linux: [".deb", ".deb.sig", ".AppImage", ".AppImage.sig"],
}[platform];
if (!suffixes) throw new Error(`不支持 release platform：${platform}`);

const bundleRoot = path.resolve("target", target, "release", "bundle");
const candidates = filesUnder(bundleRoot).filter((file) => suffixes.some((suffix) => file.endsWith(suffix)));
const portableRoot = path.resolve("target", "portable");
try {
  candidates.push(...filesUnder(portableRoot).filter((file) => file.endsWith(".zip")));
} catch {
  // Linux intentionally has no portable zip beyond AppImage.
}

mkdirSync(output, { recursive: true });
const destinations = new Set();
for (const source of candidates) {
  const sourceName = path.basename(source);
  // Tauri names both Mac architectures <product>.app.tar.gz. Keep signed bytes
  // intact while giving each archive/signature a distinct GitHub asset name.
  const releaseName = platform === "darwin"
    ? sourceName.replace(/\.app\.tar\.gz(\.sig)?$/, `_${desktopPackage.version}_${arch}.app.tar.gz$1`)
    : sourceName;
  const fileName = safeReleaseAssetName(releaseName);
  if (destinations.has(fileName)) throw new Error(`release asset 规范化后重名：${fileName}`);
  destinations.add(fileName);
  const destination = path.join(output, fileName);
  if (statSync(source).size <= 0) throw new Error(`release asset 为空：${source}`);
  cpSync(source, destination);
}

const updaterFormats = {
  win32: [{ suffix: ".exe", target: "windows", bundleType: "nsis" }],
  darwin: [{ suffix: ".app.tar.gz", target: "darwin", bundleType: "app" }],
  linux: [
    { suffix: ".AppImage", target: "linux", bundleType: "appimage" },
    { suffix: ".deb", target: "linux-deb", bundleType: "deb" },
  ],
}[platform];
const updaterArch = arch === "arm64" ? "aarch64" : "x86_64";
const collectedNames = readdirSync(output);
const assets = updaterFormats.map(({ suffix, target: updaterTarget, bundleType }) => {
  const updater = collectedNames.find((name) => name.endsWith(suffix));
  if (!updater || !collectedNames.includes(`${updater}.sig`)) {
    throw new Error(`缺少 ${platform}/${arch} ${bundleType} updater 包或 .sig`);
  }
  return {
    releaseId: `desktop-${desktopPackage.version}-${updaterTarget}-${updaterArch}`,
    target: updaterTarget,
    arch: updaterArch,
    bundleType,
    fileName: updater,
    signatureFile: `${updater}.sig`,
  };
});
const fragment = {
  schemaVersion: 1,
  desktopVersion: desktopPackage.version,
  desktopSha,
  coreSha: runtimeManifest.sourceCommit,
  githubReleaseTag: `v${desktopPackage.version}`,
  bundledRuntimeTag: runtimeTag,
  bundledCoreVersion: runtimeManifest.kernelVersion,
  bundledRuntimeVersion: runtimeManifest.runtimeVersion,
  runtimeRevision: runtimeManifest.runtimeRevision,
  runtimeManifestSchemaVersion: runtimeManifest.schemaVersion,
  assets,
};
writeFileSync(
  path.join(output, `release-fragment-${platform}-${arch}.json`),
  `${JSON.stringify(fragment, null, 2)}\n`,
);
