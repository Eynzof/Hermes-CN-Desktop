import test from "node:test";
import assert from "node:assert/strict";
import {
  releaseMutationSql,
  sqlValue,
  validateReleaseChannel,
} from "./hot-update-control.mjs";
import { selectD1DatabaseIdentifier } from "./d1-database.mjs";

test("D1 name resolves to the UUID required by Wrangler without a config file", () => {
  const uuid = "4742bc7a-340f-4dab-ac72-20336451c059";
  const databases = [{ uuid, name: "hermes-desktop-hot-update-staging" }];
  assert.equal(selectD1DatabaseIdentifier(uuid, databases), uuid);
  assert.equal(
    selectD1DatabaseIdentifier("hermes-desktop-hot-update-staging", databases),
    uuid,
  );
  assert.throws(() => selectD1DatabaseIdentifier("missing", databases), /找不到 D1 database/);
});

test("SQL quoting does not permit string breakout", () => {
  assert.equal(sqlValue("a'b"), "'a''b'");
});

test("promotion is audited and starts from an explicit percent", () => {
  const sql = releaseMutationSql("promote", "desktop-0.8.1-windows-x86_64", 5, {
    actor: "tester",
    workflowUrl: "https://github.com/run/1",
  });
  assert.match(sql, /status = 'published', rollout_percent = 5/);
  assert.match(sql, /INSERT INTO release_events/);
  assert.match(sql, /'tester'/);
});

test("pause and revoke always force rollout to zero", () => {
  assert.match(releaseMutationSql("pause", "release-1"), /rollout_percent = 0/);
  assert.match(releaseMutationSql("revoke", "release-1"), /rollout_percent = 0/);
});

test("invalid percentage is rejected", () => {
  assert.throws(() => releaseMutationSql("set-percent", "release-1", 101), /0–100/);
});

test("D1 registration requires a published release with the matching channel kind", () => {
  assert.doesNotThrow(() =>
    validateReleaseChannel({ isDraft: false, isPrerelease: true }, "canary"),
  );
  assert.doesNotThrow(() =>
    validateReleaseChannel({ isDraft: false, isPrerelease: false }, "stable"),
  );
  assert.throws(
    () => validateReleaseChannel({ isDraft: true, isPrerelease: true }, "prototype"),
    /仍是 draft/,
  );
  assert.throws(
    () => validateReleaseChannel({ isDraft: false, isPrerelease: true }, "stable"),
    /stable/,
  );
  assert.throws(
    () => validateReleaseChannel({ isDraft: false, isPrerelease: false }, "beta"),
    /prerelease/,
  );
});
