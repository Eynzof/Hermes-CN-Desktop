import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  corruptTauriSignature,
  prepareSinglePlatformRelease,
} from "./prepare-single-platform-release.mjs";

test("corrupts one base64 character without changing signature length", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-signature-test-"));
  try {
    const signature = path.join(root, "update.sig");
    writeFileSync(signature, "QUJDRA==\n");
    const result = corruptTauriSignature(signature);
    assert.notEqual(result.original, result.corrupted);
    assert.equal(result.original.length, result.corrupted.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalizes one Windows fragment and checksums the corrupted signature", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-single-release-"));
  try {
    const updater = "Hermes_0.8.1_x64-setup.nsis.zip";
    const signature = `${updater}.sig`;
    writeFileSync(path.join(root, updater), "updater-bytes");
    writeFileSync(path.join(root, signature), "QUJDRA==\n");
    writeFileSync(path.join(root, "installer.exe"), "installer-bytes");
    writeFileSync(
      path.join(root, "release-fragment-win32-x64.json"),
      JSON.stringify({
        schemaVersion: 1,
        desktopVersion: "0.8.1-prototype.1.1",
        desktopSha: "desktop-sha",
        coreSha: "core-sha",
        githubReleaseTag: "v0.8.1-prototype.1.1",
        bundledRuntimeTag: "runtime-v0.20.0-cn.9",
        bundledCoreVersion: "0.20.0",
        bundledRuntimeVersion: "0.20.0-cn.9",
        runtimeRevision: 9,
        runtimeManifestSchemaVersion: 2,
        assets: [{
          releaseId: "desktop-test-windows-x86_64",
          target: "windows",
          arch: "x86_64",
          bundleType: "nsis",
          fileName: updater,
          signatureFile: signature,
        }],
      }),
    );

    const result = prepareSinglePlatformRelease(root, { corruptSignature: true });
    assert.equal(result.releaseId, "desktop-test-windows-x86_64");
    assert.equal(result.corruptSignature, true);
    const record = JSON.parse(readFileSync(path.join(root, "release-record.json"), "utf8"));
    assert.equal(record.runtimeManifestSchemaVersion, undefined);
    assert.notEqual(readFileSync(path.join(root, signature), "utf8"), "QUJDRA==\n");
    const checksums = readFileSync(path.join(root, "checksums.txt"), "utf8");
    assert.match(checksums, new RegExp(`  ${signature}\\n`));
    assert.doesNotMatch(checksums, /checksums\.txt/);
    assert.doesNotMatch(checksums, /release-fragment/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
