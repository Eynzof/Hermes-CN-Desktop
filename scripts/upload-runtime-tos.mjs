#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  mapLimit,
  tosUploadOptionsFromEnv,
  uploadFileToTos,
} from "./tos-upload.mjs";
import { signedManifestRequiresObject } from "./tos-object-layout.mjs";

const SOURCE_ROOT = resolve(process.env.RUNTIME_SYNC_DIR || "runtime-sync");
const CHANNEL = (process.env.CHANNEL || "stable").trim() || "stable";
const FEED_BASE_URL = requiredUrl(
  process.env.RUNTIME_FEED_BASE_URL ||
    "https://huangxingpackage.tos-cn-hongkong.volces.com/package/Hermes-CN-Core/runtime",
);
const UPLOAD_OPTIONS = tosUploadOptionsFromEnv();

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
  const url = publicUrl(objectPath);
  const result = await uploadFileToTos({
    cacheControl: objectPath.startsWith(`${CHANNEL}/`)
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
}

async function main() {
  const channelRoot = join(SOURCE_ROOT, CHANNEL);
  const releasesRoot = join(SOURCE_ROOT, "releases");
  const channelFiles = (await filesUnder(channelRoot))
    .filter((file) => /\.(json|zip)$/u.test(file));
  if (channelFiles.length === 0) {
    throw new Error(`No runtime feed files found under ${channelRoot}`);
  }

  // Upload immutable release zips before any manifest can make them visible.
  // Parallelism is bounded so a runner cannot open an unbounded number of
  // multipart connections when all platform artifacts are present.
  const releaseFiles = await filesUnder(releasesRoot);
  const releaseZips = releaseFiles.filter((file) => file.endsWith(".zip"));
  const releaseMetadata = releaseFiles.filter((file) => !file.endsWith(".zip"));
  await mapLimit(releaseZips, UPLOAD_OPTIONS.fileConcurrency, (filePath) =>
    upload(filePath, relative(SOURCE_ROOT, filePath)));
  await mapLimit(releaseMetadata, UPLOAD_OPTIONS.fileConcurrency, (filePath) =>
    upload(filePath, relative(SOURCE_ROOT, filePath)));

  // A channel zip is only required when a signed manifest explicitly points
  // at that mutable object. Current manifests point at releases/<version>/,
  // so uploading the same large zip under stable/ or canary/ is normally waste.
  const channelManifests = channelFiles.filter((file) => file.endsWith(".json"));
  const signedArtifactUrls = new Set();
  for (const manifestPath of channelManifests) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.artifactUrl) {
      signedArtifactUrls.add(new URL(String(manifest.artifactUrl)).toString());
    }
  }
  const requiredChannelZips = channelFiles.filter((file) => {
    if (!file.endsWith(".zip")) return false;
    const objectPath = relative(SOURCE_ROOT, file);
    const required = signedManifestRequiresObject(
      signedArtifactUrls,
      publicUrl(objectPath).toString(),
    );
    if (!required) console.log(`Skipped duplicate channel zip: ${objectPath}`);
    return required;
  });
  await mapLimit(requiredChannelZips, UPLOAD_OPTIONS.fileConcurrency, (filePath) =>
    upload(filePath, relative(SOURCE_ROOT, filePath)));
  await mapLimit(channelManifests, UPLOAD_OPTIONS.fileConcurrency, (filePath) =>
    upload(filePath, relative(SOURCE_ROOT, filePath)));
  await upload(join(SOURCE_ROOT, "summary.json"), "sync-summary.json");
}

main().catch((error) => {
  console.error(`[TOS] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
