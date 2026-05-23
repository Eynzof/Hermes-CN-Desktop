#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.log(`Usage: node scripts/stage-bundled-runtime.mjs [options]

Downloads a released hermes-agent-cn runtime zip + signed manifest and stages
it under static/bundled-runtime/ so Tauri bundles it into the installer.

Options:
  --repo <owner/repo>      Runtime release repo (default: Eynzof/hermes-agent-cn)
  --tag <tag|latest>      Runtime release tag, or latest (default: latest)
  --channel <name>        Manifest channel name (default: stable)
  --platform <name>       Runtime platform (default: win32)
  --arch <name>           Runtime arch (default: x64)
  --out <dir>             Output dir (default: static/bundled-runtime)
  --expand-artifact       Extract the zip into a runtime tree and do not stage the zip
  --keep-existing         Do not delete old staged runtime files first
`);
}

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = argValue("--repo", process.env.HERMES_RUNTIME_REPO ?? "Eynzof/hermes-agent-cn");
const tag = argValue("--tag", process.env.HERMES_RUNTIME_TAG ?? "latest");
const channel = argValue("--channel", process.env.HERMES_RUNTIME_CHANNEL ?? "stable");
const platform = argValue("--platform", process.env.HERMES_RUNTIME_PLATFORM ?? "win32");
const arch = argValue("--arch", process.env.HERMES_RUNTIME_ARCH ?? "x64");
const outDir = resolve(repoRoot, argValue("--out", "static/bundled-runtime"));
const expandArtifact = hasFlag("--expand-artifact");
const keepExisting = hasFlag("--keep-existing");

const runtimeName = `hermes-agent-cn-runtime-${platform}-${arch}`;
const manifestName = `${channel}-${platform}-${arch}.json`;
const zipName = `${runtimeName}.zip`;
const baseUrl = tag === "latest"
  ? `https://github.com/${repo}/releases/latest/download`
  : `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function downloadWithCurl(url, timeoutMs) {
  const tmpDownloadDir = mkdtempSync(join(tmpdir(), "hermes-runtime-download-"));
  const tmpDownloadPath = join(tmpDownloadDir, "download");
  try {
    const result = spawnSync("curl", [
      "-L",
      "--fail",
      "--connect-timeout",
      "15",
      "--max-time",
      String(Math.ceil(timeoutMs / 1000)),
      "-H",
      "User-Agent: hermes-agent-cn-desktop-runtime-stager",
      "-o",
      tmpDownloadPath,
      url,
    ], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`curl failed with exit code ${result.status}: ${result.stderr || result.stdout}`);
    }
    return readFileSync(tmpDownloadPath);
  } finally {
    rmSync(tmpDownloadDir, { recursive: true, force: true });
  }
}

async function download(url, timeoutMs, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`download: ${url}${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ""}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": "hermes-agent-cn-desktop-runtime-stager",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`${url} -> HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error?.name === "AbortError") {
        lastError = new Error(`${url} -> timed out after ${Math.round(timeoutMs / 1000)}s`);
      } else {
        lastError = error;
      }
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) {
      await sleep(1000 * attempt);
    }
  }
  console.warn(`fetch failed after ${attempts} attempt(s), falling back to curl: ${lastError?.message ?? lastError}`);
  return downloadWithCurl(url, timeoutMs);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function cleanOutputDir() {
  mkdirSync(outDir, { recursive: true });
  if (keepExisting) return;
  for (const name of readdirSync(outDir)) {
    if (name === ".gitkeep") continue;
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
}

function expandRuntimeZip(zipBytes) {
  const tmpZipPath = join(outDir, `.${zipName}.download`);
  const expandedRuntimeDir = join(outDir, runtimeName);
  rmSync(expandedRuntimeDir, { recursive: true, force: true });
  writeFileSync(tmpZipPath, zipBytes);
  try {
    const result = spawnSync("unzip", ["-q", tmpZipPath, "-d", outDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `unzip failed with exit code ${result.status}: ${result.stderr || result.stdout}`,
      );
    }
  } finally {
    rmSync(tmpZipPath, { force: true });
  }
  if (!existsSync(expandedRuntimeDir)) {
    throw new Error(`expanded runtime root was not created: ${expandedRuntimeDir}`);
  }
  return expandedRuntimeDir;
}

cleanOutputDir();
const manifestBytes = await download(`${baseUrl}/${manifestName}`, 120_000);
const manifest = JSON.parse(manifestBytes.toString("utf8"));

if (manifest.schemaVersion !== 2) {
  throw new Error(`unexpected schemaVersion ${manifest.schemaVersion}`);
}
if (manifest.platform !== platform || manifest.arch !== arch) {
  throw new Error(`manifest is for ${manifest.platform}-${manifest.arch}, expected ${platform}-${arch}`);
}
if (manifest.channel !== channel) {
  throw new Error(`manifest channel is ${manifest.channel}, expected ${channel}`);
}

const zipBytes = await download(`${baseUrl}/${zipName}`, 15 * 60_000);
const actualSha = sha256(zipBytes);
if (actualSha !== String(manifest.sha256).toLowerCase()) {
  throw new Error(`sha256 mismatch for ${zipName}: expected ${manifest.sha256}, got ${actualSha}`);
}

writeFileSync(join(outDir, manifestName), manifestBytes);
const artifactPath = expandArtifact
  ? expandRuntimeZip(zipBytes)
  : join(outDir, zipName);
if (!expandArtifact) {
  writeFileSync(artifactPath, zipBytes);
}
writeFileSync(join(outDir, "README.generated.txt"), [
  "Generated by scripts/stage-bundled-runtime.mjs.",
  `repo=${repo}`,
  `tag=${tag}`,
  `stagingMode=${expandArtifact ? "expanded" : "zip"}`,
  `macosFrameworkLayout=${expandArtifact && platform === "darwin" ? "signed-native" : "native"}`,
  `runtimeVersion=${manifest.runtimeVersion}`,
  `kernelVersion=${manifest.kernelVersion}`,
  `runtimeFlavor=${manifest.runtimeFlavor}`,
  `runtimeRevision=${manifest.runtimeRevision}`,
  `sourceRepo=${manifest.sourceRepo}`,
  `sourceCommit=${manifest.sourceCommit}`,
  `sha256=${manifest.sha256}`,
  "",
].join("\n"));

console.log(`staged bundled runtime ${manifest.runtimeVersion} at ${outDir}`);
console.log(`artifact: ${artifactPath}`);
console.log(`manifest: ${join(outDir, manifestName)}`);
