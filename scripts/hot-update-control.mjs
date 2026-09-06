#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveD1DatabaseIdentifier } from "./d1-database.mjs";

const FIXED_REPOSITORY = "Eynzof/Hermes-CN-Desktop";
const RESTRICTED_RINGS = new Set(["prototype", "canary", "beta"]);
const ALL_CHANNELS = new Set([...RESTRICTED_RINGS, "stable"]);
const ACTIONS = new Set(["promote", "set-percent", "pause", "revoke"]);
const SAFE_ID = /^[0-9A-Za-z._-]{1,128}$/;
const SAFE_ASSET_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,254}$/;
const MAX_ASSET_BYTES = 480 * 1024 * 1024;

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [rawKey, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) {
      options[rawKey] = inline;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options[rawKey] = argv[index + 1];
      index += 1;
    } else {
      options[rawKey] = true;
    }
  }
  return { positional, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 --${name}`);
  return value.trim();
}

export function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SQL number 无效");
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function shell(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} 失败：${result.stderr?.trim() || result.stdout?.trim() || result.status}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function workflowUrl() {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repository && runId ? `${server}/${repository}/actions/runs/${runId}` : null;
}

const resolvedDatabases = new Map();

function resolvedDatabase(database) {
  if (!resolvedDatabases.has(database)) {
    resolvedDatabases.set(database, resolveD1DatabaseIdentifier(database, shell));
  }
  return resolvedDatabases.get(database);
}

function actor() {
  return process.env.GITHUB_ACTOR || process.env.USER || process.env.USERNAME || "local-operator";
}

function context(options) {
  const database = required(options, "database");
  const remote = options.remote === true;
  if (options.production === true && process.env.HERMES_ALLOW_PRODUCTION_HOT_UPDATE !== "1") {
    throw new Error("production 控制面需要 HERMES_ALLOW_PRODUCTION_HOT_UPDATE=1");
  }
  return { database, remote, dryRun: options["dry-run"] === true };
}

function executeD1(sql, options, json = false) {
  const ctx = context(options);
  if (ctx.dryRun) {
    process.stdout.write(`${sql}\n`);
    return "";
  }
  const database = resolvedDatabase(ctx.database);
  const args = [
    "exec",
    "wrangler",
    "d1",
    "execute",
    database,
    ctx.remote ? "--remote" : "--local",
    "--command",
    sql,
  ];
  if (json) args.push("--json");
  return shell("pnpm", args);
}

function queryD1(sql, options) {
  if (options["dry-run"] === true) return [];
  const batches = JSON.parse(executeD1(sql, options, true));
  return batches.flatMap((batch) => batch.results ?? []);
}

function releaseStateJson(alias = "releases") {
  return `json_object('status', ${alias}.status, 'rolloutPercent', ${alias}.rollout_percent)`;
}

export function releaseMutationSql(action, releaseId, percent, audit = {}) {
  if (!ACTIONS.has(action)) throw new Error(`未知 release 操作：${action}`);
  if (!SAFE_ID.test(releaseId)) throw new Error("release ID 无效");
  const actorValue = audit.actor ?? actor();
  const workflow = audit.workflowUrl ?? workflowUrl();
  let update;
  let eligible;
  let afterState;
  if (action === "promote") {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new Error("promote percent 必须为 0–100 整数");
    }
    eligible = "status IN ('draft', 'paused', 'published')";
    afterState = JSON.stringify({ status: "published", rolloutPercent: percent });
    update = `UPDATE releases SET status = 'published', rollout_percent = ${percent}, published_at = COALESCE(published_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ${sqlValue(releaseId)} AND status IN ('draft', 'paused', 'published');`;
  } else if (action === "set-percent") {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new Error("set-percent percent 必须为 0–100 整数");
    }
    eligible = "status = 'published'";
    afterState = JSON.stringify({ status: "published", rolloutPercent: percent });
    update = `UPDATE releases SET rollout_percent = ${percent} WHERE id = ${sqlValue(releaseId)} AND status = 'published';`;
  } else if (action === "pause") {
    eligible = "status IN ('draft', 'published', 'paused')";
    afterState = JSON.stringify({ status: "paused", rolloutPercent: 0 });
    update = `UPDATE releases SET status = 'paused', rollout_percent = 0 WHERE id = ${sqlValue(releaseId)} AND status IN ('draft', 'published', 'paused');`;
  } else {
    eligible = "status != 'revoked'";
    afterState = JSON.stringify({ status: "revoked", rolloutPercent: 0 });
    update = `UPDATE releases SET status = 'revoked', rollout_percent = 0 WHERE id = ${sqlValue(releaseId)} AND status != 'revoked';`;
  }
  return `INSERT INTO release_events (release_id, action, actor, workflow_url, before_state, after_state)
SELECT id, ${sqlValue(action)}, ${sqlValue(actorValue)}, ${sqlValue(workflow)},
       ${releaseStateJson()}, ${sqlValue(afterState)}
FROM releases WHERE id = ${sqlValue(releaseId)} AND ${eligible};
${update}`;
}

function createDevice(options) {
  const id = required(options, "id");
  const ring = required(options, "ring");
  const endpoint = required(options, "endpoint");
  if (!SAFE_ID.test(id)) throw new Error("device id 无效");
  if (!RESTRICTED_RINGS.has(ring)) throw new Error("device ring 必须是 prototype / canary / beta");
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:" || !endpointUrl.pathname.includes("/v1/check/")) {
    throw new Error("endpoint 必须是 Cloudflare /v1/check/ HTTPS 地址");
  }
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  executeD1(
    `INSERT INTO devices (id, token_sha256, ring, status) VALUES (${sqlValue(id)}, ${sqlValue(tokenHash)}, ${sqlValue(ring)}, 'active');`,
    options,
  );
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, endpoint, channel: ring, deviceId: id, token }, null, 2)}\n`,
  );
}

function disableDevice(options) {
  const id = required(options, "id");
  if (!SAFE_ID.test(id)) throw new Error("device id 无效");
  executeD1(
    `UPDATE devices SET status = 'disabled' WHERE id = ${sqlValue(id)} AND status = 'active';`,
    options,
  );
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function downloadReleaseAsset(tag, name, directory) {
  shell("gh", [
    "release",
    "download",
    tag,
    "--repo",
    FIXED_REPOSITORY,
    "--pattern",
    name,
    "--dir",
    directory,
    "--clobber",
  ]);
  return path.join(directory, name);
}

function validateRecord(record, tag) {
  if (record?.schemaVersion !== 1 || record.githubReleaseTag !== tag) {
    throw new Error("release-record.json schema 或 tag 无效");
  }
  if (tag !== `v${record.desktopVersion}`) throw new Error("Desktop 版本与 GitHub tag 不一致");
  for (const field of ["desktopSha", "coreSha", "bundledRuntimeTag", "bundledCoreVersion", "bundledRuntimeVersion"]) {
    if (typeof record[field] !== "string" || !record[field]) throw new Error(`release record 缺少 ${field}`);
  }
  if (!Array.isArray(record.assets) || record.assets.length === 0) {
    throw new Error("release record 没有 updater assets");
  }
}

export function validateReleaseChannel(releaseView, channel) {
  if (releaseView.isDraft) throw new Error("GitHub Release 仍是 draft，不能注册到 D1");
  if (channel === "stable" && releaseView.isPrerelease) {
    throw new Error("stable 不能注册 GitHub prerelease");
  }
  if (RESTRICTED_RINGS.has(channel) && !releaseView.isPrerelease) {
    throw new Error(`${channel} 必须注册为 GitHub prerelease`);
  }
}

function insertReleaseSql(release, audit) {
  const fields = [
    "id", "sequence", "channel", "version", "target", "arch", "bundle_type",
    "artifact_key", "file_name", "signature", "sha256", "size",
    "bundled_core_version", "bundled_runtime_version", "runtime_revision", "notes",
    "pub_date", "status", "rollout_percent", "github_release_tag", "github_asset_url",
    "mirror_url", "desktop_sha", "core_sha", "bundled_runtime_tag",
  ];
  const values = fields.map((field) => sqlValue(release[field])).join(", ");
  return `INSERT INTO releases (${fields.join(", ")}) VALUES (${values});
INSERT INTO release_events (release_id, action, actor, workflow_url, before_state, after_state)
VALUES (${sqlValue(release.id)}, 'register-draft', ${sqlValue(audit.actor)}, ${sqlValue(audit.workflowUrl)}, NULL, ${sqlValue(JSON.stringify({ status: "draft", rolloutPercent: 0 }))});`;
}

function registerDraft(options) {
  const tag = required(options, "tag");
  const channel = required(options, "channel");
  const mirrorOrigin = required(options, "mirror-origin").replace(/\/$/, "");
  if (!ALL_CHANNELS.has(channel)) throw new Error("channel 无效");
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error("tag 无效");
  const releaseView = JSON.parse(
    shell("gh", [
      "release", "view", tag, "--repo", FIXED_REPOSITORY,
      "--json", "tagName,isDraft,isPrerelease,publishedAt,createdAt,body,assets",
    ]),
  );
  if (releaseView.tagName !== tag) throw new Error("GitHub Release tag 不匹配");
  validateReleaseChannel(releaseView, channel);
  const directory = mkdtempSync(path.join(tmpdir(), "hermes-hot-update-"));
  try {
    const recordFile = downloadReleaseAsset(tag, "release-record.json", directory);
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    validateRecord(record, tag);
    const knownAssets = new Map(releaseView.assets.map((asset) => [asset.name, asset]));
    const selected = record.assets.filter((asset) =>
      (!options.target || asset.target === options.target) &&
      (!options.arch || asset.arch === options.arch),
    );
    if (selected.length === 0) throw new Error("release record 没有匹配 target/arch 的资产");
    const audit = { actor: actor(), workflowUrl: workflowUrl() };
    const statements = [];
    for (const [index, asset] of selected.entries()) {
      if (!SAFE_ID.test(asset.releaseId) || !SAFE_ASSET_NAME.test(asset.fileName)) {
        throw new Error("release record 的 releaseId/fileName 无效");
      }
      const signatureFile = asset.signatureFile || `${asset.fileName}.sig`;
      if (!knownAssets.has(asset.fileName) || !knownAssets.has(signatureFile)) {
        throw new Error(`GitHub Release 缺少 ${asset.fileName} 或 ${signatureFile}`);
      }
      const file = downloadReleaseAsset(tag, asset.fileName, directory);
      const signaturePath = downloadReleaseAsset(tag, signatureFile, directory);
      const size = statSync(file).size;
      if (size <= 0 || size > MAX_ASSET_BYTES) throw new Error(`${asset.fileName} 超过 480 MiB 闸门`);
      const sha256 = sha256File(file);
      if (knownAssets.get(asset.fileName).size !== size) throw new Error(`${asset.fileName} size 与 GitHub 不一致`);
      const release = {
        id: asset.releaseId,
        sequence: Date.now() * 100 + index,
        channel,
        version: record.desktopVersion,
        target: asset.target,
        arch: asset.arch,
        bundle_type: asset.bundleType,
        artifact_key: `${tag}/${asset.fileName}`,
        file_name: asset.fileName,
        signature: readFileSync(signaturePath, "utf8").trim(),
        sha256,
        size,
        bundled_core_version: record.bundledCoreVersion,
        bundled_runtime_version: record.bundledRuntimeVersion,
        runtime_revision: record.runtimeRevision,
        notes: releaseView.body || "",
        pub_date: releaseView.publishedAt || releaseView.createdAt,
        status: "draft",
        rollout_percent: 0,
        github_release_tag: tag,
        github_asset_url: `https://github.com/${FIXED_REPOSITORY}/releases/download/${tag}/${encodeURIComponent(asset.fileName)}`,
        mirror_url: `${mirrorOrigin}/${encodeURIComponent(tag)}/${encodeURIComponent(asset.fileName)}`,
        desktop_sha: record.desktopSha,
        core_sha: record.coreSha,
        bundled_runtime_tag: record.bundledRuntimeTag,
      };
      statements.push(insertReleaseSql(release, audit));
    }
    executeD1(statements.join("\n"), options);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function releaseStatus(options) {
  const id = required(options, "id");
  const rows = queryD1(
    `SELECT id, channel, version, target, arch, status, rollout_percent, github_release_tag, github_asset_url, mirror_url, sha256, size, bundled_core_version, bundled_runtime_version, runtime_revision, desktop_sha, core_sha, bundled_runtime_tag FROM releases WHERE id = ${sqlValue(id)};`,
    options,
  );
  if (options["dry-run"] !== true && rows.length !== 1) throw new Error(`release 不存在：${id}`);
  if (rows.length) process.stdout.write(`${JSON.stringify(rows[0], null, 2)}\n`);
}

function verifyReleaseMutation(action, id, percent, options) {
  if (options["dry-run"] === true) return;
  const rows = queryD1(
    `SELECT status, rollout_percent FROM releases WHERE id = ${sqlValue(id)};`,
    options,
  );
  if (rows.length !== 1) throw new Error(`release 不存在或操作未生效：${id}`);
  const expected = action === "revoke"
    ? { status: "revoked", rollout_percent: 0 }
    : action === "pause"
      ? { status: "paused", rollout_percent: 0 }
      : { status: "published", rollout_percent: percent };
  if (rows[0].status !== expected.status || rows[0].rollout_percent !== expected.rollout_percent) {
    throw new Error(`release 操作未达到期望状态：${JSON.stringify(rows[0])}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArgs(argv);
  const [subject, action] = positional;
  if (subject === "device" && action === "create") return createDevice(options);
  if (subject === "device" && action === "disable") return disableDevice(options);
  if (subject === "release" && action === "register-draft") return registerDraft(options);
  if (subject === "release" && action === "status") return releaseStatus(options);
  if (subject === "release" && ACTIONS.has(action)) {
    const id = required(options, "id");
    const percent = options.percent === undefined ? undefined : Number(options.percent);
    executeD1(releaseMutationSql(action, id, percent), options);
    verifyReleaseMutation(action, id, percent, options);
    return;
  }
  throw new Error(
    "用法：device create|disable；release register-draft|promote|set-percent|pause|revoke|status",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`hot-update-control: ${error.message}\n`);
    process.exitCode = 1;
  }
}
