import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
const { parse } = requireWeb("yaml");
const workflow = parse(readFileSync(new URL("../.github/workflows/release-desktop.yml", import.meta.url), "utf8"));
const { preflight, build, "prepare-draft": draft, release } = workflow.jobs;
const summary = draft.steps.find(step => step.name === "Record candidate fingerprint");

test("manual mode builds and saves both artifacts without using a release credential", () => {
  const input = workflow.on.workflow_dispatch.inputs.draft_mode;
  assert.equal(input.default, "auto");
  assert.deepEqual(input.options, ["auto", "manual"]);
  assert.equal(build.needs, "preflight");
  assert.deepEqual(draft.needs, ["preflight", "build"]);
  assert.equal(draft.env.GH_TOKEN, undefined);
  const restricted = draft.steps.filter(step => step.if);
  assert.deepEqual(restricted.map(step => step.name), [
    "Create private draft from the pinned source SHA",
    "Re-download every draft asset and verify exact bytes",
  ]);
  assert.deepEqual(draft.steps.filter(step => /\bgh release\b/.test(step.run ?? "")), restricted);
  assert.deepEqual(draft.steps.filter(step => step.env?.GH_TOKEN), restricted);
  for (const step of restricted) {
    assert.equal(step.if, "inputs.draft_mode != 'manual'");
    assert.match(step.env.GH_TOKEN, /secrets\.RELEASE_TOKEN \|\| github\.token/);
  }
  assert.deepEqual(draft.steps.filter(step => step.uses?.startsWith("actions/upload-artifact"))
    .map(step => step.with.name), ["desktop-release-candidate", "desktop-release-fingerprint"]);
});

test("manual publishing, promotion and recovery fail before any release action", () => {
  const guard = preflight.steps[0];
  assert.equal(preflight.if, "inputs.action == 'build' || inputs.draft_mode == 'manual'");
  assert.equal(guard.if, "inputs.draft_mode == 'manual' && (inputs.action != 'build' || inputs.recovery_source_sha != '')");
  assert.match(guard.run, /^ *exit 1$/m);
  assert.match(release.if, /&& inputs\.draft_mode != 'manual'$/);
});

test("both modes report the digest of the same candidate file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-draft-mode-"));
  try {
    const checksums = "candidate bytes\n";
    mkdirSync(path.join(root, "release-assets"));
    writeFileSync(path.join(root, "release-assets/checksums.txt"), checksums);
    const digest = createHash("sha256").update(checksums).digest("hex");
    for (const mode of ["manual", "auto"]) {
      const log = path.join(root, mode);
      execFileSync("bash", ["-c", summary.run], {
        cwd: root, env: { ...process.env, DRAFT_MODE: mode, GITHUB_STEP_SUMMARY: log },
      });
      const lines = readFileSync(log, "utf8").split("\n");
      assert.ok(lines.includes("candidate_sha256=" + digest));
      assert.match(lines[2], mode === "manual" ? /Artifacts only, no draft created/ : /Draft only/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
