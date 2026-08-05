#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { brandedWindowsArtifactBrand } from "./windows-artifact-names.mjs";

const SOURCE_DIR = resolve(process.env.DESKTOP_ASSET_DIR || "assets");
const BRANDS_DIR = resolve(process.env.DESKTOP_BRANDS_DIR || "brands");
const OUTPUT_DIR = resolve(process.env.DESKTOP_SERVER_UPLOAD_DIR || "desktop-server-upload");
const VERSION_TAG = (process.env.DESKTOP_VERSION_TAG || "").trim();
const RELEASE_CHANNEL = (process.env.DESKTOP_RELEASE_CHANNEL || "stable").trim().toLowerCase();
const FEED_BASE_URL = requiredHttpsUrl(
  process.env.DESKTOP_FEED_BASE_URL || "https://ai.fengchiyun.com/downloads",
);

if (!VERSION_TAG) throw new Error("DESKTOP_VERSION_TAG is required (for example v0.6.9)");
if (!new Set(["stable", "canary"]).has(RELEASE_CHANNEL)) {
  throw new Error(`DESKTOP_RELEASE_CHANNEL must be stable or canary, got ${RELEASE_CHANNEL}`);
}

function requiredHttpsUrl(value) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error(`Desktop feed URL must use https: ${value}`);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

function publicUrl(relativePath) {
  const url = new URL(FEED_BASE_URL);
  url.pathname = `${url.pathname}/${relativePath.replaceAll("\\", "/")}`;
  return url.toString();
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function platformFor(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".msi")) return "windows";
  if (lower.endsWith(".dmg")) {
    return /arm64|aarch64|apple[._ -]?silicon/iu.test(lower) ? "macos-arm64" : "macos-x64";
  }
  if (lower.endsWith(".deb") || lower.endsWith(".appimage")) return "linux";
  return null;
}

function labelFor(platform) {
  return {
    windows: "Windows installer",
    "macos-arm64": "macOS Apple Silicon DMG",
    "macos-x64": "macOS Intel DMG",
    linux: "Linux installer",
  }[platform] || platform;
}

function matchesBrandAsset(fileName, brand, version) {
  const artifactBrand = brandedWindowsArtifactBrand(fileName, version);
  if (artifactBrand !== null) return artifactBrand === brand.artifactBrandName;
  return [brand.productName, brand.appName, brand.appNameEn, brand.id]
    .map(normalized)
    .filter(Boolean)
    .some((needle) => normalized(fileName).includes(needle));
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function copyInto(phase, relativePath, sourcePath) {
  const destination = join(OUTPUT_DIR, phase, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);
}

async function writeInto(phase, relativePath, contents) {
  const destination = join(OUTPUT_DIR, phase, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function readBrands() {
  const names = (await readdir(BRANDS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(BRANDS_DIR, name), "utf8"))));
}

async function main() {
  const files = (await readdir(SOURCE_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile()
      && entry.name !== "builder-debug.yml"
      && !entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error(`No desktop release assets found under ${SOURCE_DIR}`);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  const brands = await readBrands();
  const version = VERSION_TAG.replace(/^v/iu, "");
  const publishedAt = new Date().toISOString();
  const uploaded = new Set();

  for (const brand of brands) {
    const channelRoot = RELEASE_CHANNEL === "stable" ? brand.id : `${brand.id}/canary`;
    const brandFiles = files.filter((fileName) => matchesBrandAsset(fileName, brand, version));
    if (brandFiles.length === 0) {
      throw new Error(`No release assets matched brand ${brand.id} (${brand.productName})`);
    }

    const assets = {};
    for (const fileName of brandFiles) {
      const sourcePath = join(SOURCE_DIR, fileName);
      const versionedPath = `${channelRoot}/releases/v${version}/${fileName}`;
      await copyInto("immutable", versionedPath, sourcePath);
      uploaded.add(fileName);

      const platform = platformFor(fileName);
      if (!platform) continue;
      if (assets[platform]) {
        throw new Error(
          `Multiple ${platform} installers matched brand ${brand.id}: ${assets[platform].fileName}, ${fileName}`,
        );
      }
      const [{ size }, sha256] = await Promise.all([stat(sourcePath), sha256File(sourcePath)]);
      const versionedUrl = publicUrl(versionedPath);
      assets[platform] = {
        label: labelFor(platform),
        platform,
        fileName,
        size,
        sha256,
        url: versionedUrl,
        versionedUrl,
      };
    }

    const manifest = `${JSON.stringify({
      version: VERSION_TAG,
      semver: version,
      publishedAt,
      channel: RELEASE_CHANNEL,
      updatedAt: publishedAt,
      assets,
    }, null, 2)}\n`;
    await writeInto("immutable", `${channelRoot}/releases/v${version}/latest.json`, manifest);
    const channelManifest = RELEASE_CHANNEL === "stable"
      ? `${brand.id}/latest.json`
      : `${brand.id}/canary.json`;
    await writeInto("mutable", channelManifest, manifest);
  }

  if (files.includes("checksums.txt")) {
    const checksumPath = join(SOURCE_DIR, "checksums.txt");
    await copyInto("immutable", `checksums/v${version}/checksums.txt`, checksumPath);
    await copyInto("mutable", "checksums/latest/checksums.txt", checksumPath);
  }

  const unmatched = files.filter((fileName) => !uploaded.has(fileName) && fileName !== "checksums.txt");
  if (unmatched.length > 0) {
    console.warn(`Assets not matched to a brand (kept out of brand feeds): ${unmatched.join(", ")}`);
  }
  console.log(`Prepared Linux server upload tree under ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(`[desktop-server-upload] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
