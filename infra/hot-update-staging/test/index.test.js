import test from "node:test";
import assert from "node:assert/strict";
import { compareSemver, rolloutBucket, sha256Hex } from "../src/index.js";

test("compares stable and prototype SemVer correctly", () => {
  assert.ok(compareSemver("0.8.1-hotupdate.1", "0.8.1-hotupdate.0") > 0);
  assert.ok(compareSemver("0.8.1", "0.8.1-hotupdate.9") > 0);
  assert.ok(compareSemver("0.9.0", "0.8.99") > 0);
  assert.equal(compareSemver("v0.8.1+build.2", "0.8.1+build.1"), 0);
});

test("rejects malformed SemVer", () => {
  assert.throws(() => compareSemver("nightly", "0.8.0"), /invalid semver/);
});

test("device rollout bucket is deterministic", async () => {
  const first = await rolloutBucket("primelab-win", "prototype-0001");
  const second = await rolloutBucket("primelab-win", "prototype-0001");
  assert.equal(first, second);
  assert.ok(first >= 0 && first < 100);
});

test("sha256 uses lowercase hexadecimal", async () => {
  assert.equal(
    await sha256Hex("hermes"),
    "8cfde6efdfc4ed5ab1f6acbbd1ba49bf31932f84d0a4c090eb41c7d151e8b180",
  );
});
