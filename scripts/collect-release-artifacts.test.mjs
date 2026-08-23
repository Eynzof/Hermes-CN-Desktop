import test from "node:test";
import assert from "node:assert/strict";
import { safeReleaseAssetName } from "./release-artifact-name.mjs";

test("normalises Tauri product names into one safe GitHub path segment", () => {
  assert.equal(
    safeReleaseAssetName("Hermes Agent CN Desktop_0.8.1_x64-setup.nsis.zip"),
    "Hermes_Agent_CN_Desktop_0.8.1_x64-setup.nsis.zip",
  );
});

test("rejects a name that has no safe asset characters", () => {
  assert.throws(() => safeReleaseAssetName("热更新"), /无法安全规范化/);
});

test("normalises URL-reserved build metadata instead of requiring percent encoding", () => {
  assert.equal(safeReleaseAssetName("Hermes_0.8.1+build.zip"), "Hermes_0.8.1_build.zip");
});
