#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const SOURCE_DIR = resolve(process.env.DESKTOP_ASSET_DIR || "assets");
const BRANDS_DIR = resolve(process.env.DESKTOP_BRANDS_DIR || "brands");
const VERSION_TAG = (process.env.DESKTOP_VERSION_TAG || "").trim();
const TOS_BASE_URL = requiredHttpsUrl(
    process.env.DESKTOP_TOS_BASE_URL || "https://huanxing.tos-cn-beijing.volces.com/package/hermesagent",
);
const REPOSITORY = process.env.GITHUB_REPOSITORY || "Eynzof/Hermes-CN-Desktop";

if (!VERSION_TAG) throw new Error("DESKTOP_VERSION_TAG is required (for example v0.6.3)");

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

async function upload(filePath, objectPath) {
  const body = await readFile(filePath);
  const url = publicUrl(objectPath);
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          "cache-control": objectPath.includes("/latest/") || objectPath.endsWith("latest.json")
            ? "no-cache, no-store, must-revalidate"
            : "public, max-age=31536000, immutable",
          "content-length": String(body.byteLength),
          "content-type": contentTypeFor(filePath),
        },
        body,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      console.log(`Uploaded ${relative(process.cwd(), filePath)} -> ${url}`);
      return url.toString();
    } catch (error) {
      lastError = error;
      if (attempt < 6) {
        const delay = Math.min(15 * 2 ** (attempt - 1), 120) * 1000;
        console.warn(`Upload failed for ${objectPath} (attempt ${attempt}/6): ${error?.message || error}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      }
    }
  }
  throw new Error(`Upload failed for ${objectPath} after 6 attempts: ${lastError?.message || lastError}`);
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
    .filter((entry) => entry.isFile() && entry.name !== "builder-debug.yml")
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error(`No desktop release assets found under ${SOURCE_DIR}`);

  const brands = await readBrands();
  const version = VERSION_TAG.replace(/^v/iu, "");
  const now = new Date().toISOString();
  const uploaded = new Set();

  for (const brand of brands) {
    const needles = [brand.productName, brand.appName, brand.appNameEn, brand.id]
      .map(normalized)
      .filter(Boolean);
    const brandFiles = files.filter((fileName) => needles.some((needle) => normalized(fileName).includes(needle)));
    if (brandFiles.length === 0) {
      throw new Error(`No release assets matched brand ${brand.id} (${brand.productName})`);
    }

    const assets = {};
    for (const fileName of brandFiles) {
      const filePath = join(SOURCE_DIR, fileName);
      const latestPath = `${brand.id}/latest/${fileName}`;
      const versionedPath = `${brand.id}/releases/v${version}/${fileName}`;
      await upload(filePath, latestPath);
      await upload(filePath, versionedPath);
      uploaded.add(fileName);

      const platform = platformFor(fileName);
      if (!platform) continue;
      const body = await readFile(filePath);
      assets[platform] = {
        label: labelFor(platform),
        platform,
        fileName,
        size: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
        url: publicUrl(`${brand.id}/latest/${fileName}`).toString(),
        versionedUrl: publicUrl(`${brand.id}/releases/v${version}/${fileName}`).toString(),
        sourceUrl: `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(VERSION_TAG)}/${encodedFileName(fileName)}`,
      };
    }

    const manifest = {
      repository: REPOSITORY,
      version: VERSION_TAG,
      semver: version,
      publishedAt: now,
      sourceUrl: `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(VERSION_TAG)}`,
      updatedAt: now,
      assets,
    };
    const manifestPath = join(SOURCE_DIR, `${brand.id}-latest.json`);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await upload(manifestPath, `${brand.id}/latest.json`);
    await upload(manifestPath, `${brand.id}/releases/v${version}/latest.json`);
  }

  if (files.includes("checksums.txt")) {
    const checksumPath = join(SOURCE_DIR, "checksums.txt");
    await upload(checksumPath, `checksums/latest/checksums.txt`);
    await upload(checksumPath, `checksums/v${version}/checksums.txt`);
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
