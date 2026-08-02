import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  desktopArtifactObjectPaths,
  signedManifestRequiresObject,
} from "./tos-object-layout.mjs";
import { mapLimit, sha256File, uploadFileToTos } from "./tos-upload.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}/bucket/object.bin`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function withTempFile(bytes, run) {
  const root = await mkdtemp(join(tmpdir(), "hermes-tos-upload-test-"));
  const filePath = join(root, "artifact.bin");
  try {
    await writeFile(filePath, bytes);
    await run(filePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("mapLimit bounds file concurrency and preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 10;
  });

  assert.equal(peak, 2);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test("desktop assets have one immutable object and no latest binary copy", () => {
  assert.deepEqual(desktopArtifactObjectPaths({
    channelRoot: "fengchihermes",
    fileName: "Hermes-Fengchi-0.6.9_x64-setup.exe",
    version: "0.6.9",
  }), ["fengchihermes/releases/v0.6.9/Hermes-Fengchi-0.6.9_x64-setup.exe"]);
});

test("channel runtime zips are retained only when a signed manifest needs them", () => {
  const signed = new Set([
    "https://bucket.example/runtime/releases/0.19.0-cn.7/runtime.zip",
  ]);
  assert.equal(
    signedManifestRequiresObject(
      signed,
      "https://bucket.example/runtime/stable/runtime.zip",
    ),
    false,
  );
  assert.equal(
    signedManifestRequiresObject(
      signed,
      "https://bucket.example/runtime/releases/0.19.0-cn.7/runtime.zip",
    ),
    true,
  );
});

test("sha256File hashes without loading the whole file", async () => {
  await withTempFile(Buffer.from("Hermes\n"), async (filePath) => {
    assert.equal(
      await sha256File(filePath),
      "e8a6e32094432e8c602c3e0576d9dae9addc1c09df402dbe8a24ad00adcec5bf",
    );
  });
});

test("uploads large files as concurrent multipart requests", async () => {
  const source = Buffer.from("abcdefghijklmnop");
  const receivedParts = new Map();
  const partAttempts = new Map();
  let activeParts = 0;
  let peakParts = 0;
  let completeBody = "";

  await withServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.search === "?uploads") {
      response.writeHead(200, { "content-type": "application/xml" });
      response.end("<InitiateMultipartUploadResult><UploadId>upload-123</UploadId></InitiateMultipartUploadResult>");
      return;
    }
    if (request.method === "PUT" && url.searchParams.has("partNumber")) {
      activeParts += 1;
      peakParts = Math.max(peakParts, activeParts);
      const body = await requestBody(request);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeParts -= 1;
      const partNumber = Number(url.searchParams.get("partNumber"));
      const attempt = (partAttempts.get(partNumber) ?? 0) + 1;
      partAttempts.set(partNumber, attempt);
      if (partNumber === 2 && attempt === 1) {
        response.writeHead(503);
        response.end("retry this part");
        return;
      }
      receivedParts.set(partNumber, body);
      response.writeHead(200, { etag: `\"part-${partNumber}\"` });
      response.end();
      return;
    }
    if (request.method === "POST" && url.searchParams.get("uploadId") === "upload-123") {
      completeBody = (await requestBody(request)).toString("utf8");
      response.writeHead(200);
      response.end("<CompleteMultipartUploadResult />");
      return;
    }
    response.writeHead(500);
    response.end("unexpected request");
  }, async (url) => {
    await withTempFile(source, async (filePath) => {
      const result = await uploadFileToTos({
        cacheControl: "public, max-age=31536000, immutable",
        contentType: "application/octet-stream",
        filePath,
        objectPath: "releases/v1/artifact.bin",
        url: new URL(url),
      }, {
        attempts: 2,
        multipartRequired: true,
        multipartThreshold: 8,
        partConcurrency: 2,
        partSize: 4,
        retryBaseMs: 0,
      });

      assert.equal(result.mode, "multipart");
      assert.equal(result.parts, 4);
    });
  });

  assert.equal(peakParts, 2);
  assert.equal(partAttempts.get(1), 1);
  assert.equal(partAttempts.get(2), 2);
  assert.equal(partAttempts.get(3), 1);
  assert.equal(partAttempts.get(4), 1);
  assert.deepEqual(Buffer.concat([...receivedParts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bytes]) => bytes)), source);
  assert.match(completeBody, /<PartNumber>4<\/PartNumber><ETag>&quot;part-4&quot;<\/ETag>/u);
});

test("falls back to a streaming single PUT when multipart is not allowed", async () => {
  const source = Buffer.from("multipart fallback");
  let uploaded = null;

  await withServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.search === "?uploads") {
      response.writeHead(403);
      response.end("multipart denied");
      return;
    }
    if (request.method === "PUT" && !url.search) {
      uploaded = await requestBody(request);
      response.writeHead(200);
      response.end();
      return;
    }
    response.writeHead(500);
    response.end("unexpected request");
  }, async (url) => {
    await withTempFile(source, async (filePath) => {
      const result = await uploadFileToTos({
        cacheControl: "public, max-age=31536000, immutable",
        contentType: "application/octet-stream",
        filePath,
        objectPath: "releases/v1/artifact.bin",
        url: new URL(url),
      }, {
        attempts: 2,
        multipartRequired: false,
        multipartThreshold: 1,
        partConcurrency: 2,
        partSize: 4,
        retryBaseMs: 0,
      });

      assert.equal(result.mode, "single-fallback");
    });
  });

  assert.deepEqual(uploaded, source);
});
