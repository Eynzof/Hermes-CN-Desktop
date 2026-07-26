#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const SOURCE_ROOT = resolve(process.env.RUNTIME_SYNC_DIR || "runtime-sync");
const CHANNEL = (process.env.CHANNEL || "stable").trim() || "stable";
const FEED_BASE_URL = requiredUrl(
  process.env.RUNTIME_FEED_BASE_URL ||
    "https://huanxing.tos-cn-beijing.volces.com/package/Hermes-CN-Core/runtime",
);

function requiredUrl(value) {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:") {
    throw new Error(`TOS feed URL must use https: ${value}`);
  }
  return parsed;
}

function contentTypeFor(fileName) {
  switch (extname(fileName).toLowerCase()) {
    case ".json":
      return "application/json; charset=utf-8";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function publicUrl(relativePath) {
  const url = new URL(FEED_BASE_URL);
  const basePath = url.pathname.replace(/\/+$/u, "");
  const objectPath = relativePath.split(sep).join("/");
  url.pathname = `${basePath}/${objectPath}`;
  return url;
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
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
          "cache-control": objectPath.startsWith(`${CHANNEL}/`)
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
      return;
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

async function main() {
  const channelRoot = join(SOURCE_ROOT, CHANNEL);
  const releasesRoot = join(SOURCE_ROOT, "releases");
  const channelFiles = (await filesUnder(channelRoot))
    .filter((file) => /\.(json|zip)$/u.test(file));
  if (channelFiles.length === 0) {
    throw new Error(`No runtime feed files found under ${channelRoot}`);
  }

  // Keep immutable release objects first, then stable zips, and manifests last.
  // This prevents clients from observing a new manifest before its zip exists.
  for (const filePath of await filesUnder(releasesRoot)) {
    await upload(filePath, relative(SOURCE_ROOT, filePath));
  }
  for (const filePath of channelFiles.filter((file) => file.endsWith(".zip"))) {
    await upload(filePath, relative(SOURCE_ROOT, filePath));
  }
  for (const filePath of channelFiles.filter((file) => file.endsWith(".json"))) {
    await upload(filePath, relative(SOURCE_ROOT, filePath));
  }
  await upload(join(SOURCE_ROOT, "summary.json"), "sync-summary.json");
}

main().catch((error) => {
  console.error(`[TOS] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
