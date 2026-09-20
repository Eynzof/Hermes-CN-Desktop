#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHANNELS = ["stable", "canary", "beta", "prototype"];
const MAX_UPDATER_BYTES = 480 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function releasePolicy(env) {
  const policy = {
    environment: env.RELEASE_ENVIRONMENT,
    channel: env.INPUT_CHANNEL,
    windowsSigning: env.WINDOWS_SIGNING,
    controlEndpoint: env.HOT_UPDATE_CONTROL_ENDPOINT,
    mirrorOrigin: env.HOT_UPDATE_MIRROR_ORIGIN?.replace(/\/$/, ""),
  };
  assert(["production", "staging"].includes(policy.environment), "必须明确选择 production / staging");
  assert(CHANNELS.includes(policy.channel), "更新渠道无效");
  assert(["none", "authenticode"].includes(policy.windowsSigning), "Windows 签名模式无效");
  assert(policy.channel !== "stable" || policy.environment === "production", "stable 禁止使用 staging");
  for (const key of ["controlEndpoint", "mirrorOrigin"]) {
    assert(policy[key], `缺少 ${key}，不允许回落到 staging`);
    const url = new URL(policy[key]);
    assert.equal(url.protocol, "https:", `${key} 必须 HTTPS`);
    assert(!url.username && !url.password && !url.search && !url.hash, `${key} 不能包含凭据或查询参数`);
    if (policy.environment === "production") {
      assert(!url.hostname.split(/[.-]/).includes("staging"), `production 禁止使用 staging ${key}`);
    }
    if (key === "mirrorOrigin") assert.equal(url.pathname, "/", "mirrorOrigin 必须是 origin");
  }
  assert(policy.controlEndpoint.includes("/v1/check/"), "controlEndpoint 必须使用 /v1/check/ 路径");
  for (const token of ["channel", "target", "arch", "current_version"]) {
    assert(policy.controlEndpoint.includes(`{{${token}}}`), `controlEndpoint 缺少 {{${token}}}`);
  }
  const tag = env.RELEASE_TAG || env.INPUT_TAG;
  assert(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag), "release tag 无效");
  if (policy.channel === "stable") assert(/^v\d+\.\d+\.\d+$/.test(tag), "stable 不能使用预发布版本");
  if (env.RELEASE_ACTION === "promote") {
    assert.equal(policy.channel, "stable", "只有 stable 可以提升 GitHub latest");
  }
  return policy;
}

export function parseChecksums(text) {
  const files = new Map();
  for (const line of text.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  (?:\.\/)?([0-9A-Za-z][0-9A-Za-z._-]*)$/.exec(line);
    assert(match && !files.has(match[2]) && match[2] !== "checksums.txt", "checksums.txt 名称或格式无效");
    files.set(match[2], match[1]);
  }
  assert(files.has("release-record.json"), "checksums.txt 缺少 release-record.json");
  return files;
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyCandidate(root, env) {
  const checksums = readFileSync(path.join(root, "checksums.txt"));
  assert(/^[a-f0-9]{64}$/.test(env.CANDIDATE_SHA256), "必须提供已验收 checksums.txt 的 SHA256");
  assert.equal(digest(checksums), env.CANDIDATE_SHA256, "候选包指纹发生变化，必须重新验收");
  const files = parseChecksums(checksums.toString("utf8"));
  assert.deepEqual(readdirSync(root).sort(), [...files.keys(), "checksums.txt"].sort(), "资产与验收清单不一致");
  for (const [name, hash] of files) assert.equal(await hashFile(path.join(root, name)), hash, `${name} SHA256 不一致`);
  const record = JSON.parse(readFileSync(path.join(root, "release-record.json"), "utf8"));
  assert.equal(record.githubReleaseTag, env.RELEASE_TAG, "候选 tag 不一致");
  assert.equal(record.githubReleaseTag, `v${record.desktopVersion}`, "候选版本不一致");
  assert(/^[a-f0-9]{40}$/.test(record.desktopSha), "候选源码 SHA 无效");
  assert.deepEqual(record.releasePolicy, releasePolicy(env), "不能更改已构建候选的渠道、环境、签名或下载源");
  return record;
}

export function verifyStage(record, release, env) {
  assert.equal(release.isPrerelease, record.releasePolicy.channel !== "stable", "Release 的预发布状态不一致");
  assert.equal(release.targetCommitish, record.desktopSha, "Release 必须固定到已构建的源码 SHA");
  if (env.RELEASE_ACTION === "promote") assert.equal(release.isDraft, false, "必须先执行 publish 并验证公开镜像");
}

async function finalize(root, env) {
  const recordPath = path.join(root, "release-record.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.releasePolicy = releasePolicy(env);
  assert.equal(record.desktopSha, env.RELEASE_SHA, "产物来源与固定源码 SHA 不一致");
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const temp = mkdtempSync(path.join(tmpdir(), "hermes-release-signature-"));
  try {
    const config = JSON.parse(readFileSync("tauri.conf.json", "utf8"));
    const publicKey = path.join(temp, "updater.pub");
    writeFileSync(publicKey, Buffer.from(config.plugins.updater.pubkey, "base64"));
    for (const asset of record.assets) {
      const file = path.join(root, asset.fileName);
      const size = statSync(file).size;
      assert(size > 0 && size <= MAX_UPDATER_BYTES, `${asset.fileName} 超过 480 MiB 闸门或为空`);
      const signature = path.join(temp, "updater.sig");
      writeFileSync(signature, Buffer.from(readFileSync(path.join(root, asset.signatureFile), "utf8").trim(), "base64"));
      const verification = spawnSync("minisign", ["-V", "-p", publicKey, "-m", file, "-x", signature], { encoding: "utf8" });
      assert.equal(verification.status, 0, `${asset.fileName} 的 Tauri 签名与客户端公钥不匹配: ${verification.stderr || verification.error || ""}`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  for (const name of readdirSync(root).filter((name) => name.startsWith("release-fragment-"))) rmSync(path.join(root, name));
  const names = readdirSync(root).filter((name) => name !== "checksums.txt").sort();
  const checksums = [];
  for (const name of names) {
    assert(statSync(path.join(root, name)).size <= MAX_UPDATER_BYTES, `${name} 超过镜像 480 MiB 限制`);
    checksums.push(`${await hashFile(path.join(root, name))}  ${name}`);
  }
  writeFileSync(path.join(root, "checksums.txt"), `${checksums.join("\n")}\n`);
}

async function fetchHash(url, expected, { mirror = false } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  assert.equal(response.status, 200, `${url} HTTP ${response.status}`);
  if (mirror) assert.equal(response.headers.get("x-mirror-upstream"), "github", "镜像未返回 GitHub 来源标识");
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  assert.equal(hash.digest("hex"), expected, `${url} 下载 SHA256 不一致`);
}

async function verifyDownloads(root, env) {
  const record = await verifyCandidate(root, env);
  const files = parseChecksums(readFileSync(path.join(root, "checksums.txt"), "utf8"));
  const mirror = record.releasePolicy.mirrorOrigin;
  for (const [name, hash] of files) {
    const suffix = `${encodeURIComponent(record.githubReleaseTag)}/${encodeURIComponent(name)}`;
    await fetchHash(`https://github.com/${env.GITHUB_REPOSITORY}/releases/download/${suffix}`, hash);
    await fetchHash(`${mirror}/${suffix}`, hash, { mirror: true });
  }
  for (const asset of record.assets) {
    const url = `${mirror}/${encodeURIComponent(record.githubReleaseTag)}/${encodeURIComponent(asset.fileName)}`;
    const response = await fetch(url, { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 206, "镜像必须支持 Range 206");
    assert.match(response.headers.get("content-range") || "", /^bytes 0-1023\/\d+$/);
    assert.equal((await response.arrayBuffer()).byteLength, 1024, "Range 内容大小错误");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, root = "release-assets", releasePath] = process.argv.slice(2);
  try {
    if (action === "validate") releasePolicy(process.env);
    else if (action === "finalize") await finalize(root, process.env);
    else if (action === "verify") await verifyCandidate(root, process.env);
    else if (action === "verify-stage") verifyStage(
      JSON.parse(readFileSync(path.join(root, "release-record.json"), "utf8")),
      JSON.parse(readFileSync(releasePath, "utf8")), process.env,
    );
    else if (action === "verify-downloads") await verifyDownloads(root, process.env);
    else throw new Error(`未知发布阶段: ${action}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
