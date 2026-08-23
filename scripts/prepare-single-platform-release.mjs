#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function corruptTauriSignature(file) {
  const original = readFileSync(file, "utf8");
  const index = [...original]
    .map((character, offset) => ({ character, offset }))
    .reverse()
    .find(({ character }) => /[0-9A-Za-z+/]/.test(character))?.offset;
  if (index === undefined) throw new Error("Tauri signature 没有可变更的 base64 字符");
  const replacement = original[index] === "A" ? "B" : "A";
  const corrupted = `${original.slice(0, index)}${replacement}${original.slice(index + 1)}`;
  writeFileSync(file, corrupted);
  return { original, corrupted };
}

export function prepareSinglePlatformRelease(root, { corruptSignature = false } = {}) {
  const releaseRoot = path.resolve(root);
  const fragmentFiles = readdirSync(releaseRoot)
    .filter((name) => name.startsWith("release-fragment-") && name.endsWith(".json"));
  if (fragmentFiles.length !== 1) {
    throw new Error(`单平台候选必须恰好有 1 个 release fragment，实际 ${fragmentFiles.length}`);
  }

  const fragmentPath = path.join(releaseRoot, fragmentFiles[0]);
  const fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
  if (fragment.schemaVersion !== 1 || fragment.runtimeManifestSchemaVersion !== 2) {
    throw new Error("单平台候选的 release/runtime schema 无效");
  }
  if (!Array.isArray(fragment.assets) || fragment.assets.length !== 1) {
    throw new Error("单平台候选必须恰好包含 1 个 updater asset");
  }

  const asset = fragment.assets[0];
  for (const name of [asset.fileName, asset.signatureFile]) {
    if (!readdirSync(releaseRoot).includes(name)) throw new Error(`release asset 缺少 ${name}`);
  }
  if (corruptSignature) {
    corruptTauriSignature(path.join(releaseRoot, asset.signatureFile));
  }

  const record = {
    ...fragment,
    generatedAt: new Date().toISOString(),
  };
  delete record.runtimeManifestSchemaVersion;
  writeFileSync(
    path.join(releaseRoot, "release-record.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  rmSync(fragmentPath);

  const names = readdirSync(releaseRoot)
    .filter((name) => name !== "checksums.txt")
    .sort();
  const checksums = names
    .map((name) => `${sha256(path.join(releaseRoot, name))}  ${name}`)
    .join("\n");
  writeFileSync(path.join(releaseRoot, "checksums.txt"), `${checksums}\n`);

  return {
    releaseId: asset.releaseId,
    version: fragment.desktopVersion,
    tag: fragment.githubReleaseTag,
    updater: asset.fileName,
    signatureFile: asset.signatureFile,
    corruptSignature,
  };
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = prepareSinglePlatformRelease(option("root", "release-assets"), {
      corruptSignature: process.argv.includes("--corrupt-signature"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`prepare-single-platform-release: ${error.message}\n`);
    process.exitCode = 1;
  }
}
