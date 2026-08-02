#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  mapLimit,
  sha256File,
  tosUploadOptionsFromEnv,
  uploadFileToTos,
} from "./tos-upload.mjs";
import { desktopArtifactObjectPaths } from "./tos-object-layout.mjs";
import { brandedWindowsArtifactBrand } from "./windows-artifact-names.mjs";

const SOURCE_DIR = resolve(process.env.DESKTOP_ASSET_DIR || "assets");
const BRANDS_DIR = resolve(process.env.DESKTOP_BRANDS_DIR || "brands");
const VERSION_TAG = (process.env.DESKTOP_VERSION_TAG || "").trim();
const SELECTED_BRAND = (process.env.DESKTOP_BRAND || "").trim();
const RELEASE_CHANNEL = (process.env.DESKTOP_RELEASE_CHANNEL || "stable").trim().toLowerCase();
const OMIT_SOURCE_URL = process.env.DESKTOP_OMIT_SOURCE_URL === "1";
const TOS_BASE_URL = requiredHttpsUrl(
    process.env.DESKTOP_TOS_BASE_URL || "https://huanxing.tos-cn-beijing.volces.com/package/hermesagent",
);
const REPOSITORY = process.env.GITHUB_REPOSITORY || "Eynzof/Hermes-CN-Desktop";
const UPLOAD_OPTIONS = tosUploadOptionsFromEnv();

if (!VERSION_TAG) throw new Error("DESKTOP_VERSION_TAG is required (for example v0.6.3)");
if (!new Set(["stable", "canary"]).has(RELEASE_CHANNEL)) {
  throw new Error(`DESKTOP_RELEASE_CHANNEL must be stable or canary, got ${RELEASE_CHANNEL}`);
}

function requiredHttpsUrl(value) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error(`TOS URL must use https: ${value}`);
  return url;
}

function contentTypeFor(fileName) {
  switch (extname(fileName).toLowerCase()) {
    case ".json": return "application/json; charset=utf-8";
    case ".exe": return "application/vnd.microsoft.portable-executable";
    case ".dmg": return "application/x-apple-diskimage";
    case ".deb": return "application/vnd.debian.binary-package";
    case ".zip": return "application/zip";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function publicUrl(objectPath) {
  const url = new URL(TOS_BASE_URL);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}/${objectPath.split(sep).join("/")}`;
  return url;
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function encodedFileName(fileName) {
  return encodeURIComponent(fileName).replace(/%2F/gu, "/");
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

async function upload(filePath, objectPath) {
  const url = publicUrl(objectPath);
  const result = await uploadFileToTos({
    cacheControl: objectPath.endsWith("latest.json") || objectPath.endsWith("canary.json")
      ? "no-cache, no-store, must-revalidate"
      : "public, max-age=31536000, immutable",
    contentType: contentTypeFor(filePath),
    filePath,
    objectPath,
    url,
  }, {
    ...UPLOAD_OPTIONS,
    log: (message) => console.warn(message),
  });
  console.log(
    `Uploaded ${relative(process.cwd(), filePath)} -> ${url} (${result.mode}, ${result.parts} part${result.parts === 1 ? "" : "s"})`,
  );
  return url.toString();
}

async function readBrands() {
  const names = (await readdir(BRANDS_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  const brands = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(BRANDS_DIR, name), "utf8"))),
  );
  if (!SELECTED_BRAND) return brands;
  const selected = brands.filter((brand) => brand.id === SELECTED_BRAND);
  if (selected.length !== 1) {
    throw new Error(`DESKTOP_BRAND does not match exactly one brand config: ${SELECTED_BRAND}`);
  }
  return selected;
}

async function main() {
  const files = (await readdir(SOURCE_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile()
      && entry.name !== "builder-debug.yml"
      && !entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error(`No desktop release assets found under ${SOURCE_DIR}`);

  const brands = await readBrands();
  const version = VERSION_TAG.replace(/^v/iu, "");
  const now = new Date().toISOString();
  const uploaded = new Set();

  for (const brand of brands) {
    const channelRoot = RELEASE_CHANNEL === "stable" ? brand.id : `${brand.id}/canary`;
    const brandFiles = files.filter((fileName) => matchesBrandAsset(fileName, brand, version));
    if (brandFiles.length === 0) {
      throw new Error(`No release assets matched brand ${brand.id} (${brand.productName})`);
    }

    const assets = {};
    const assetEntries = await mapLimit(
      brandFiles,
      UPLOAD_OPTIONS.fileConcurrency,
      async (fileName) => {
        const filePath = join(SOURCE_DIR, fileName);
        const [versionedPath] = desktopArtifactObjectPaths({ channelRoot, fileName, version });
        const [{ size }, sha256] = await Promise.all([
          stat(filePath),
          sha256File(filePath),
          upload(filePath, versionedPath),
        ]);
        uploaded.add(fileName);

        const platform = platformFor(fileName);
        if (!platform) return null;
        const versionedUrl = publicUrl(versionedPath).toString();
        return [platform, {
          label: labelFor(platform),
          platform,
          fileName,
          size,
          sha256,
          url: versionedUrl,
          versionedUrl,
          ...(!OMIT_SOURCE_URL ? {
            sourceUrl: `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(VERSION_TAG)}/${encodedFileName(fileName)}`,
          } : {}),
        }];
      },
    );
    for (const entry of assetEntries.filter(Boolean)) {
      assets[entry[0]] = entry[1];
    }

    const manifest = {
      repository: REPOSITORY,
      version: VERSION_TAG,
      semver: version,
      publishedAt: now,
      channel: RELEASE_CHANNEL,
      ...(!OMIT_SOURCE_URL ? {
        sourceUrl: `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(VERSION_TAG)}`,
      } : {}),
      updatedAt: now,
      assets,
    };
    const manifestFileName = RELEASE_CHANNEL === "stable"
      ? `${brand.id}-latest.json`
      : `${brand.id}-canary.json`;
    const manifestPath = join(SOURCE_DIR, manifestFileName);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const latestManifestPath = RELEASE_CHANNEL === "stable"
      ? `${brand.id}/latest.json`
      : `${brand.id}/canary.json`;
    await Promise.all([
      upload(manifestPath, latestManifestPath),
      upload(manifestPath, `${channelRoot}/releases/v${version}/latest.json`),
    ]);
  }

  if (files.includes("checksums.txt")) {
    const checksumPath = join(SOURCE_DIR, "checksums.txt");
    await Promise.all([
      upload(checksumPath, "checksums/latest/checksums.txt"),
      upload(checksumPath, `checksums/v${version}/checksums.txt`),
    ]);
  }

  const unmatched = files.filter((fileName) => !uploaded.has(fileName) && fileName !== "checksums.txt");
  if (unmatched.length > 0) {
    console.warn(`Assets not matched to a brand (kept out of brand feeds): ${unmatched.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(`[TOS] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
