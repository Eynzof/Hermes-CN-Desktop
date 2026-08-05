import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptDir = dirname(fileURLToPath(import.meta.url));

test("prepares immutable assets before mutable Linux server manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-desktop-server-upload-"));
  const assets = join(root, "assets");
  const brands = join(root, "brands");
  const output = join(root, "output");

  try {
    await Promise.all([mkdir(assets), mkdir(brands)]);
    await writeFile(join(brands, "fengchihermes.json"), JSON.stringify({
      id: "fengchihermes",
      appName: "HermesAgent",
      appNameEn: "HermesAgent",
      productName: "FengchiHermes Desktop",
      artifactBrandName: "Fengchi",
    }));
    await Promise.all([
      writeFile(join(assets, "Hermes-Fengchi-0.6.9_x64-setup.exe"), "windows"),
      writeFile(join(assets, "FengchiHermes.Desktop_0.6.9_aarch64.dmg"), "mac-arm"),
      writeFile(join(assets, "FengchiHermes.Desktop_0.6.9_x64.dmg"), "mac-intel"),
      writeFile(join(assets, "checksums.txt"), "checksums\n"),
    ]);

    const result = spawnSync(process.execPath, [join(scriptDir, "prepare-desktop-server-upload.mjs")], {
      encoding: "utf8",
      env: {
        ...process.env,
        DESKTOP_ASSET_DIR: assets,
        DESKTOP_BRANDS_DIR: brands,
        DESKTOP_SERVER_UPLOAD_DIR: output,
        DESKTOP_VERSION_TAG: "v0.6.9",
        DESKTOP_RELEASE_CHANNEL: "stable",
        DESKTOP_FEED_BASE_URL: "https://ai.fengchiyun.com/downloads",
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const versionRoot = join(output, "immutable", "fengchihermes", "releases", "v0.6.9");
    assert.equal(
      await readFile(join(versionRoot, "Hermes-Fengchi-0.6.9_x64-setup.exe"), "utf8"),
      "windows",
    );
    const immutableManifest = JSON.parse(await readFile(join(versionRoot, "latest.json"), "utf8"));
    const mutableManifest = JSON.parse(
      await readFile(join(output, "mutable", "fengchihermes", "latest.json"), "utf8"),
    );
    assert.deepEqual(mutableManifest, immutableManifest);
    assert.equal(immutableManifest.channel, "stable");
    assert.equal(
      immutableManifest.assets.windows.url,
      "https://ai.fengchiyun.com/downloads/fengchihermes/releases/v0.6.9/Hermes-Fengchi-0.6.9_x64-setup.exe",
    );
    assert.equal(
      await readFile(join(output, "immutable", "checksums", "v0.6.9", "checksums.txt"), "utf8"),
      "checksums\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
