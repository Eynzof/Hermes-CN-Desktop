import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { releasePolicy, parseChecksums, verifyCandidate, verifyStage } from "./desktop-release-policy.mjs";

const env = {
  RELEASE_ENVIRONMENT: "production", INPUT_CHANNEL: "stable", WINDOWS_SIGNING: "none",
  HOT_UPDATE_CONTROL_ENDPOINT: "https://hot-update.hermesagent.org.cn/v1/check/{{channel}}/{{target}}/{{arch}}/{{current_version}}",
  HOT_UPDATE_MIRROR_ORIGIN: "https://hot-update-download.hermesagent.org.cn",
  RELEASE_TAG: "v0.9.0",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

test("stable permits no Windows system certificate while retaining its explicit policy", () => {
  assert.equal(releasePolicy(env).windowsSigning, "none");
  assert.equal(releasePolicy({ ...env, WINDOWS_SIGNING: "authenticode" }).windowsSigning, "authenticode");
});

test("production never falls back to an empty endpoint, a staging mirror or staging environment", () => {
  assert.throws(() => releasePolicy({ ...env, HOT_UPDATE_CONTROL_ENDPOINT: "" }), /controlEndpoint/);
  assert.throws(() => releasePolicy({ ...env, HOT_UPDATE_MIRROR_ORIGIN: "https://hot-update-download-staging.hermesagent.org.cn" }), /staging/);
  assert.throws(() => releasePolicy({ ...env, RELEASE_ENVIRONMENT: "staging" }), /stable/);
  assert.throws(() => releasePolicy({ ...env, RELEASE_TAG: "v0.9.0-rc.4" }), /预发布/);
});

test("canary preserves staging support but cannot become GitHub latest", () => {
  const canary = { ...env, RELEASE_ENVIRONMENT: "staging", INPUT_CHANNEL: "canary", RELEASE_TAG: "v0.9.1-rc.1" };
  assert.equal(releasePolicy(canary).channel, "canary");
  assert.throws(() => releasePolicy({ ...canary, RELEASE_ACTION: "promote" }), /stable/);
});

test("checksums reject duplicate or escaping paths", () => {
  const sum = "a".repeat(64);
  assert.throws(() => parseChecksums(`${sum}  ../secret\n`), /格式/);
  assert.throws(() => parseChecksums(`${sum}  release-record.json\n${sum}  release-record.json\n`), /格式/);
});

test("candidate verification pins every downloaded byte and built environment to the accepted fingerprint", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-candidate-policy-"));
  try {
    const record = { githubReleaseTag: "v0.9.0", desktopVersion: "0.9.0", desktopSha: "a".repeat(40), releasePolicy: releasePolicy(env) };
    writeFileSync(path.join(root, "release-record.json"), JSON.stringify(record));
    writeFileSync(path.join(root, "installer.exe"), "final installer bytes");
    const checksums = ["installer.exe", "release-record.json"]
      .map((name) => `${hash(readFileSync(path.join(root, name)))}  ${name}\n`).join("");
    writeFileSync(path.join(root, "checksums.txt"), checksums);
    const accepted = { ...env, CANDIDATE_SHA256: hash(checksums) };
    assert.deepEqual(await verifyCandidate(root, accepted), record);
    await assert.rejects(verifyCandidate(root, { ...accepted, CANDIDATE_SHA256: "0".repeat(64) }), /指纹/);
    await assert.rejects(verifyCandidate(root, { ...accepted, WINDOWS_SIGNING: "authenticode" }), /不能更改/);
    writeFileSync(path.join(root, "extra.exe"), "unchecked");
    await assert.rejects(verifyCandidate(root, accepted), /清单不一致/);
    rmSync(path.join(root, "extra.exe"));
    writeFileSync(path.join(root, "installer.exe"), "replaced installer");
    await assert.rejects(verifyCandidate(root, accepted), /SHA256/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishing accepts pinned drafts and promotion requires a public release", () => {
  const record = { desktopSha: "a".repeat(40), releasePolicy: releasePolicy(env) };
  const draft = { isDraft: true, isPrerelease: false, targetCommitish: record.desktopSha };
  verifyStage(record, draft, { RELEASE_ACTION: "publish" });
  assert.throws(() => verifyStage(record, draft, { RELEASE_ACTION: "promote" }), /publish/);
  assert.throws(() => verifyStage(record, { ...draft, targetCommitish: "main" }, { RELEASE_ACTION: "publish" }), /源码 SHA/);
  verifyStage(record, { ...draft, isDraft: false }, { RELEASE_ACTION: "promote" });
});
