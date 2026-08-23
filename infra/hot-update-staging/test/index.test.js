import test from "node:test";
import assert from "node:assert/strict";
import {
  compareSemver,
  parseCheckRoute,
  rolloutBucket,
  sha256Hex,
  updaterResponse,
  validateReleaseOrigin,
} from "../src/index.js";
import worker from "../src/index.js";

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

test("check route includes an explicit authorised channel", () => {
  assert.deepEqual(
    parseCheckRoute("/v1/check/canary/windows/x86_64/0.8.0-rc7"),
    {
      channel: "canary",
      target: "windows",
      arch: "x86_64",
      currentVersion: "0.8.0-rc7",
    },
  );
  assert.equal(parseCheckRoute("/v1/check/windows/x86_64/0.8.0"), null);
  assert.equal(parseCheckRoute("/v1/check/nightly/windows/x86_64/0.8.0"), null);
});

function release(overrides = {}) {
  return {
    id: "desktop-0.8.1-windows-x86_64",
    version: "0.8.1",
    channel: "canary",
    file_name: "Hermes.Agent.CN.Desktop_0.8.1_x64-setup.nsis.zip",
    github_release_tag: "v0.8.1",
    github_asset_url:
      "https://github.com/Eynzof/Hermes-CN-Desktop/releases/download/v0.8.1/Hermes.Agent.CN.Desktop_0.8.1_x64-setup.nsis.zip",
    mirror_url:
      "https://hot-update-download-staging.hermesagent.org.cn/v0.8.1/Hermes.Agent.CN.Desktop_0.8.1_x64-setup.nsis.zip",
    signature: "signed",
    sha256: "a".repeat(64),
    size: 185_000_000,
    bundled_core_version: "0.20.0",
    bundled_runtime_version: "0.20.0-cn.9",
    runtime_revision: 9,
    notes: "candidate",
    pub_date: "2026-08-23T00:00:00Z",
    ...overrides,
  };
}

test("updater response returns Cloudflare primary and fixed GitHub fallback", () => {
  const result = updaterResponse(
    release(),
    "https://hot-update-download-staging.hermesagent.org.cn",
  );
  assert.match(result.url, /^https:\/\/hot-update-download-staging/);
  assert.match(result.metadata.githubFallbackUrl, /^https:\/\/github\.com\/Eynzof/);
  assert.equal(result.metadata.schemaVersion, 2);
  assert.equal(result.metadata.size, 185_000_000);
});

test("release origin validation prevents an open proxy", () => {
  assert.throws(
    () =>
      validateReleaseOrigin(
        release({ github_asset_url: "https://example.com/private/asset.exe" }),
        "https://hot-update-download-staging.hermesagent.org.cn",
      ),
    /invalid GitHub release origin/,
  );
  assert.throws(
    () =>
      validateReleaseOrigin(
        release({ mirror_url: "https://evil.example/proxy" }),
        "https://hot-update-download-staging.hermesagent.org.cn",
      ),
    /invalid mirror URL/,
  );
});

function fakeD1({ tokenHash, device, candidate }) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM devices")) {
            return this.values[0] === tokenHash ? device : null;
          }
          if (sql.includes("FROM releases")) return candidate;
          throw new Error(`unexpected first SQL: ${sql}`);
        },
        async run() {
          writes.push({ sql, values: this.values });
          return { success: true };
        },
      };
      return statement;
    },
  };
}

function testEnv(db) {
  return {
    UPDATES: db,
    ENVIRONMENT: "test",
    MIRROR_ORIGIN: "https://hot-update-download-staging.hermesagent.org.cn",
  };
}

const ctx = { waitUntil: () => undefined };

test("restricted channels require a token whose device ring matches", async () => {
  const token = "secret-token";
  const tokenHash = await sha256Hex(token);
  const candidate = { ...release(), rollout_percent: 100 };
  const canaryDb = fakeD1({
    tokenHash,
    device: { id: "device-1", ring: "canary", status: "active", last_seen_at: new Date().toISOString() },
    candidate,
  });
  const noToken = await worker.fetch(
    new Request("https://control.example/v1/check/canary/windows/x86_64/0.8.0"),
    testEnv(canaryDb),
    ctx,
  );
  assert.equal(noToken.status, 401);
  assert.equal(noToken.headers.get("cache-control"), "no-store");

  const authorised = await worker.fetch(
    new Request("https://control.example/v1/check/canary/windows/x86_64/0.8.0", {
      headers: { authorization: `Bearer ${token}`, "x-device-id": "device-1" },
    }),
    testEnv(canaryDb),
    ctx,
  );
  assert.equal(authorised.status, 200);
  assert.equal((await authorised.json()).metadata.releaseId, candidate.id);

  const wrongRingDb = fakeD1({
    tokenHash,
    device: { id: "device-1", ring: "beta", status: "active", last_seen_at: new Date().toISOString() },
    candidate,
  });
  const wrongRing = await worker.fetch(
    new Request("https://control.example/v1/check/canary/windows/x86_64/0.8.0", {
      headers: { authorization: `Bearer ${token}` },
    }),
    testEnv(wrongRingDb),
    ctx,
  );
  assert.equal(wrongRing.status, 401);
});

test("pause/revoke/zero rollout is represented as no candidate and returns 204", async () => {
  const token = "secret-token";
  const db = fakeD1({
    tokenHash: await sha256Hex(token),
    device: { id: "device-1", ring: "canary", status: "active", last_seen_at: new Date().toISOString() },
    candidate: null,
  });
  const response = await worker.fetch(
    new Request("https://control.example/v1/check/canary/windows/x86_64/0.8.0", {
      headers: { authorization: `Bearer ${token}` },
    }),
    testEnv(db),
    ctx,
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("stable uses an installation id instead of bearer credentials", async () => {
  const candidate = { ...release({ channel: "stable" }), rollout_percent: 100 };
  const db = fakeD1({ candidate });
  const missing = await worker.fetch(
    new Request("https://control.example/v1/check/stable/windows/x86_64/0.8.0"),
    testEnv(db),
    ctx,
  );
  assert.equal(missing.status, 401);
  const response = await worker.fetch(
    new Request("https://control.example/v1/check/stable/windows/x86_64/0.8.0", {
      headers: { "x-installation-id": "installation-0123456789abcdef" },
    }),
    testEnv(db),
    ctx,
  );
  assert.equal(response.status, 200);
});

test("client events authenticate and store only the hashed identity", async () => {
  const token = "secret-token";
  const db = fakeD1({
    tokenHash: await sha256Hex(token),
    device: { id: "device-1", ring: "canary", status: "active", last_seen_at: new Date().toISOString() },
  });
  const response = await worker.fetch(
    new Request("https://control.example/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "canary", event: "fallback", appVersion: "0.8.0" }),
    }),
    testEnv(db),
    ctx,
  );
  assert.equal(response.status, 204);
  const insert = db.writes.find((entry) => entry.sql.includes("client_update_events"));
  assert.ok(insert);
  assert.equal(insert.values[0], await sha256Hex("device-1"));
  assert.ok(!insert.values.includes(token));
});
