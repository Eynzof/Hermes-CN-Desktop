#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "release-assets");
const fragments = readdirSync(root)
  .filter((name) => name.startsWith("release-fragment-") && name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(readFileSync(path.join(root, name), "utf8")));
if (fragments.length !== 4) throw new Error(`必须有 4 个平台 release fragment，实际 ${fragments.length}`);

const first = fragments[0];
for (const fragment of fragments.slice(1)) {
  for (const field of [
    "schemaVersion",
    "desktopVersion",
    "desktopSha",
    "coreSha",
    "githubReleaseTag",
    "bundledRuntimeTag",
    "bundledCoreVersion",
    "bundledRuntimeVersion",
    "runtimeRevision",
    "runtimeManifestSchemaVersion",
  ]) {
    if (fragment[field] !== first[field]) throw new Error(`release fragment 的 ${field} 不一致`);
  }
}
if (first.runtimeManifestSchemaVersion !== 2) {
  throw new Error(`runtime manifest schema 必须为 2，当前 ${first.runtimeManifestSchemaVersion}`);
}
const assets = fragments.flatMap((fragment) => fragment.assets);
const keys = new Set(assets.map((asset) => `${asset.target}/${asset.arch}`));
for (const required of ["windows/x86_64", "darwin/aarch64", "darwin/x86_64", "linux/x86_64"]) {
  if (!keys.has(required)) throw new Error(`release record 缺少 ${required}`);
}
for (const asset of assets) {
  for (const name of [asset.fileName, asset.signatureFile]) {
    if (!readdirSync(root).includes(name)) throw new Error(`release asset 缺少 ${name}`);
  }
}

const record = {
  ...first,
  generatedAt: new Date().toISOString(),
  assets: assets.sort((a, b) => `${a.target}/${a.arch}`.localeCompare(`${b.target}/${b.arch}`)),
};
delete record.runtimeManifestSchemaVersion;
writeFileSync(path.join(root, "release-record.json"), `${JSON.stringify(record, null, 2)}\n`);
