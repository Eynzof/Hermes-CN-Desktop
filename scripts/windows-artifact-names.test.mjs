import assert from "node:assert/strict";
import test from "node:test";
import {
  tauriDefaultWindowsInstallerName,
  windowsArchLabel,
  windowsInstallerName,
} from "./windows-artifact-names.mjs";

test("creates branded Windows installer names", () => {
  assert.equal(
    windowsInstallerName({ artifactBrandName: "Huanxing", version: "0.3.24", arch: "x64" }),
    "Hermes-Huanxing-0.3.24_x64-setup.exe",
  );
  assert.equal(
    windowsInstallerName({ artifactBrandName: "FrogClaw", version: "0.6.5", arch: "arm64" }),
    "Hermes-FrogClaw-0.6.5_arm64-setup.exe",
  );
});

test("maps Rust Windows targets to artifact architecture labels", () => {
  assert.equal(windowsArchLabel("x86_64-pc-windows-msvc"), "x64");
  assert.equal(windowsArchLabel("aarch64-pc-windows-msvc"), "arm64");
});

test("preserves the Tauri default name for locating the original installer", () => {
  assert.equal(
    tauriDefaultWindowsInstallerName({
      productName: "HuanxingHermes Desktop",
      version: "0.6.5",
      arch: "x64",
    }),
    "HuanxingHermes Desktop_0.6.5_x64-setup.exe",
  );
});

test("rejects unsafe brand fragments", () => {
  assert.throws(
    () => windowsInstallerName({ artifactBrandName: "../Huanxing", version: "0.6.5" }),
    /Invalid artifact brand name/u,
  );
});
