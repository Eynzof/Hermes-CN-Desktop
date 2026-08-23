import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { safeReleaseAssetName } from "./release-artifact-name.mjs";

const collector = fileURLToPath(new URL("./collect-release-artifacts.mjs", import.meta.url));

test("normalises Tauri product names into one safe GitHub path segment", () => {
  assert.equal(
    safeReleaseAssetName("Hermes Agent CN Desktop_0.8.1_x64-setup.exe"),
    "Hermes_Agent_CN_Desktop_0.8.1_x64-setup.exe",
  );
});

test("rejects a name that has no safe asset characters", () => {
  assert.throws(() => safeReleaseAssetName("热更新"), /无法安全规范化/);
});

test("normalises URL-reserved build metadata instead of requiring percent encoding", () => {
  assert.equal(safeReleaseAssetName("Hermes_0.8.1+build.zip"), "Hermes_0.8.1_build.zip");
});

test("collects the signed NSIS executable as the Windows updater asset", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-collect-release-"));
  try {
    const bundle = path.join(root, "target", "x86_64-pc-windows-msvc", "release", "bundle", "nsis");
    const runtime = path.join(root, "static", "bundled-runtime");
    mkdirSync(bundle, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.8.1-prototype.1" }));
    writeFileSync(path.join(bundle, "Hermes Agent CN Desktop_0.8.1_x64-setup.exe"), "signed-nsis");
    writeFileSync(path.join(bundle, "Hermes Agent CN Desktop_0.8.1_x64-setup.exe.sig"), "tauri-signature");
    writeFileSync(path.join(runtime, "stable-win32-x64.json"), JSON.stringify({
      schemaVersion: 2,
      sourceCommit: "core-sha",
      kernelVersion: "0.20.0",
      runtimeVersion: "0.20.0-cn.9",
      runtimeRevision: 9,
    }));

    const result = spawnSync(process.execPath, [
      collector,
      "--platform", "win32",
      "--arch", "x64",
      "--target", "x86_64-pc-windows-msvc",
      "--runtime-tag", "runtime-v0.20.0-cn.9",
      "--desktop-sha", "desktop-sha",
      "--output", "release-assets",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const fragment = JSON.parse(readFileSync(
      path.join(root, "release-assets", "release-fragment-win32-x64.json"),
      "utf8",
    ));
    assert.equal(fragment.assets[0].fileName, "Hermes_Agent_CN_Desktop_0.8.1_x64-setup.exe");
    assert.equal(fragment.assets[0].signatureFile, "Hermes_Agent_CN_Desktop_0.8.1_x64-setup.exe.sig");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
