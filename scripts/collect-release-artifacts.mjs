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
  win32: [".exe", ".nsis.zip", ".nsis.zip.sig"],
  darwin: [".dmg", ".app.tar.gz", ".app.tar.gz.sig"],
  linux: [".deb", ".AppImage", ".AppImage.tar.gz", ".AppImage.tar.gz.sig"],
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
  const fileName = safeReleaseAssetName(path.basename(source));
  if (destinations.has(fileName)) throw new Error(`release asset 规范化后重名：${fileName}`);
  destinations.add(fileName);
  const destination = path.join(output, fileName);
  if (statSync(source).size <= 0) throw new Error(`release asset 为空：${source}`);
  cpSync(source, destination);
}

const updaterSuffix = {
  win32: ".nsis.zip",
  darwin: ".app.tar.gz",
  linux: ".AppImage.tar.gz",
}[platform];
const updater = readdirSync(output).find((name) => name.endsWith(updaterSuffix));
if (!updater || !readdirSync(output).includes(`${updater}.sig`)) {
  throw new Error(`缺少 ${platform}/${arch} updater 包或 .sig`);
}

const updaterTarget = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
const updaterArch = arch === "arm64" ? "aarch64" : "x86_64";
const bundleType = { win32: "nsis", darwin: "app", linux: "appimage" }[platform];
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
  assets: [
    {
      releaseId: `desktop-${desktopPackage.version}-${updaterTarget}-${updaterArch}`,
      target: updaterTarget,
      arch: updaterArch,
      bundleType,
      fileName: updater,
      signatureFile: `${updater}.sig`,
    },
  ],
};
writeFileSync(
  path.join(output, `release-fragment-${platform}-${arch}.json`),
  `${JSON.stringify(fragment, null, 2)}\n`,
);
