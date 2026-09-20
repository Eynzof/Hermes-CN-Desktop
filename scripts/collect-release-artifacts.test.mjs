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

test("collects the Tauri v2 AppImage bytes and requires its matching signature", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-collect-release-linux-"));
  try {
    const target = "x86_64-unknown-linux-gnu";
    const bundle = path.join(root, "target", target, "release", "bundle", "appimage");
    const runtime = path.join(root, "static", "bundled-runtime");
    const output = path.join(root, "release-assets");
    const fileName = "Hermes Agent CN Desktop_0.9.0_amd64.AppImage";
    mkdirSync(bundle, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.9.0" }));
    writeFileSync(path.join(bundle, fileName), "final-appimage-bytes");
    writeFileSync(path.join(bundle, `${fileName}.sig`), "tauri-appimage-signature");
    writeFileSync(path.join(runtime, "stable-linux-x64.json"), JSON.stringify({
      schemaVersion: 2,
      sourceCommit: "core-sha",
      kernelVersion: "0.21.0",
      runtimeVersion: "0.21.0-cn.15",
      runtimeRevision: 15,
    }));
    const args = [collector, "--platform", "linux", "--arch", "x64", "--target", target,
      "--runtime-tag", "runtime-v0.21.0-cn.15", "--desktop-sha", "desktop-sha", "--output", output];
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const fragment = JSON.parse(readFileSync(path.join(output, "release-fragment-linux-x64.json"), "utf8"));
    const asset = fragment.assets[0];
    assert.equal(asset.bundleType, "appimage");
    assert.equal(asset.fileName, "Hermes_Agent_CN_Desktop_0.9.0_amd64.AppImage");
    assert.equal(asset.signatureFile, `${asset.fileName}.sig`);
    assert.equal(readFileSync(path.join(output, asset.fileName), "utf8"), "final-appimage-bytes");
    assert.equal(readFileSync(path.join(output, asset.signatureFile), "utf8"), "tauri-appimage-signature");

    rmSync(output, { recursive: true });
    rmSync(path.join(bundle, `${fileName}.sig`));
    const unsigned = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.notEqual(unsigned.status, 0);
    assert.match(unsigned.stderr, /缺少 linux\/x64 updater 包或 \.sig/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
