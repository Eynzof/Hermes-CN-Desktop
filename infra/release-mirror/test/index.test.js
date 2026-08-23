import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  githubAssetUrl,
  MAX_ASSET_BYTES,
  parseMirrorRoute,
  responseSize,
  stagingFaultResponse,
} from "../src/index.js";

test("accepts only version tags and a single safe asset segment", () => {
  assert.deepEqual(parseMirrorRoute("/v0.8.1/Hermes_0.8.1_x64.nsis.zip"), {
    tag: "v0.8.1",
    asset: "Hermes_0.8.1_x64.nsis.zip",
    immutable: true,
  });
  assert.equal(parseMirrorRoute("/v0.8.1/a/b.zip"), null);
  assert.equal(parseMirrorRoute("/main/file.zip"), null);
  assert.equal(parseMirrorRoute("/v0.8.1/asset+build.zip"), null);
  assert.equal(parseMirrorRoute("/v0.8.1/https%3A%2F%2Fevil.example"), null);
});

test("builds only the fixed GitHub repository URL", () => {
  assert.equal(
    githubAssetUrl({ tag: "v0.8.1", asset: "asset.zip" }),
    "https://github.com/Eynzof/Hermes-CN-Desktop/releases/download/v0.8.1/asset.zip",
  );
});

test("reads full object size from a range response", () => {
  assert.equal(responseSize(new Headers({ "content-range": "bytes 0-99/12345" })), 12345);
  assert.equal(responseSize(new Headers({ "content-length": "99" })), 99);
});

test("never forwards Range or cache validators to the GitHub origin", async () => {
  const originalFetch = globalThis.fetch;
  const observed = [];
  globalThis.fetch = async (url, init) => {
    observed.push({ url, init });
    return init.method === "HEAD"
      ? new Response(null, { headers: { "content-length": "15" } })
      : new Response("complete-object", { headers: { "content-length": "15" } });
  };
  try {
    const response = await worker.fetch(
      new Request("https://mirror.example/v0.8.1/asset.zip", {
        headers: { range: "bytes=0-4", "if-none-match": "stale-etag" },
      }),
      { ENVIRONMENT: "test" },
    );
    assert.equal(observed.length, 2);
    for (const call of observed) {
      assert.equal(call.init.headers.get("range"), null);
      assert.equal(call.init.headers.get("if-none-match"), null);
    }
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-mirror-upstream"), "github");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an upstream object larger than the release gate", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, { headers: { "content-length": String(MAX_ASSET_BYTES + 1) } });
  try {
    const response = await worker.fetch(
      new Request("https://mirror.example/v0.8.1/asset.zip"),
      { ENVIRONMENT: "test" },
    );
    assert.equal(response.status, 413);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not cache GitHub errors as immutable version assets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  try {
    const response = await worker.fetch(
      new Request("https://mirror.example/v0.8.1/missing.zip"),
      { ENVIRONMENT: "test" },
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "public, max-age=0, s-maxage=60");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a GitHub response without a trustworthy full size", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null);
  try {
    const response = await worker.fetch(
      new Request("https://mirror.example/v0.8.1/asset.zip"),
      { ENVIRONMENT: "test" },
    );
    assert.equal(response.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("staging fault injection is exact and never active outside staging", async () => {
  const route = { tag: "v0.8.1-prototype.1.2", asset: "update.nsis.zip" };
  const env = {
    ENVIRONMENT: "staging",
    STAGING_FAULT_TAG: route.tag,
    STAGING_FAULT_ASSET: route.asset,
    STAGING_FAULT_STATUS: "503",
  };
  const response = stagingFaultResponse(env, route);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-hermes-staging-fault"), "503");
  assert.equal(stagingFaultResponse({ ...env, ENVIRONMENT: "production" }, route), null);
  assert.equal(stagingFaultResponse({ ...env, STAGING_FAULT_TAG: "v0.8.1" }, route), null);
  assert.equal(stagingFaultResponse({ ...env, STAGING_FAULT_ASSET: "other.zip" }, route), null);
  assert.equal(stagingFaultResponse({ ...env, STAGING_FAULT_STATUS: "500" }, route), null);
});

test("rejects credentials at the public download boundary", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("credentialed download must not reach GitHub");
  };
  try {
    for (const headers of [
      { authorization: "Bearer secret" },
      { cookie: "session=secret" },
    ]) {
      const response = await worker.fetch(
        new Request("https://mirror.example/v0.8.1/asset.zip", { headers }),
        { ENVIRONMENT: "test" },
      );
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
