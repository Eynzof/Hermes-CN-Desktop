import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const MIB = 1024 * 1024;

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

export function tosUploadOptionsFromEnv(env = process.env) {
  return {
    attempts: positiveInteger(env.TOS_UPLOAD_ATTEMPTS, 6, "TOS_UPLOAD_ATTEMPTS"),
    fileConcurrency: positiveInteger(env.TOS_FILE_CONCURRENCY, 3, "TOS_FILE_CONCURRENCY"),
    multipartThreshold: positiveInteger(
      env.TOS_MULTIPART_THRESHOLD_MB,
      32,
      "TOS_MULTIPART_THRESHOLD_MB",
    ) * MIB,
    partConcurrency: positiveInteger(
      env.TOS_PART_CONCURRENCY,
      4,
      "TOS_PART_CONCURRENCY",
    ),
    partSize: positiveInteger(env.TOS_PART_SIZE_MB, 16, "TOS_PART_SIZE_MB") * MIB,
    multipartRequired: env.TOS_MULTIPART_REQUIRED === "1",
  };
}

export async function mapLimit(items, concurrency, worker) {
  const limit = positiveInteger(concurrency, 1, "concurrency");
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );
  return results;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

class HttpStatusError extends Error {
  constructor(statusCode, detail, url) {
    super(`HTTP ${statusCode}${detail ? `: ${detail}` : ""} (${url})`);
    this.name = "HttpStatusError";
    this.statusCode = statusCode;
  }
}

function isRetryable(error) {
  if (!(error instanceof HttpStatusError)) return true;
  return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(label, operation, options) {
  const attempts = options.attempts ?? 6;
  const retryBaseMs = options.retryBaseMs ?? 15_000;
  const retryMaxMs = options.retryMaxMs ?? 120_000;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) break;
      const delay = Math.min(retryBaseMs * 2 ** (attempt - 1), retryMaxMs);
      options.log?.(
        `${label} failed (attempt ${attempt}/${attempts}): ${error?.message || error}; retrying`,
      );
      if (delay > 0) await sleep(delay);
    }
  }

  throw lastError;
}

function requestFor(url) {
  if (url.protocol === "http:") return httpRequest;
  if (url.protocol === "https:") return httpsRequest;
  throw new Error(`Unsupported upload URL protocol: ${url.protocol}`);
}

function requestOnce(url, { method, headers = {}, body = null, bodyFactory = null }) {
  return new Promise((resolve, reject) => {
    let responseBody = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };

    const request = requestFor(url)(url, { method, headers }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (responseBody.length < 64 * 1024) responseBody += chunk;
      });
      response.on("aborted", () => finish(new Error(`TOS response aborted for ${url}`)));
      response.on("error", (error) => finish(error));
      response.on("end", () => finish(null, {
        body: responseBody,
        headers: response.headers,
        statusCode: response.statusCode || 0,
      }));
    });

    request.on("error", (error) => finish(error));
    if (bodyFactory) {
      const source = bodyFactory();
      source.on("error", (error) => request.destroy(error));
      source.pipe(request);
    } else {
      request.end(body);
    }
  });
}

function ensureSuccess(response, url) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new HttpStatusError(response.statusCode, response.body.trim(), url);
  }
  return response;
}

function xmlUnescape(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlTag(body, tag) {
  const match = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "iu"));
  return match ? xmlUnescape(match[1].trim()) : null;
}

async function singlePut(filePath, url, metadata, options, size) {
  await withRetry(`Upload ${metadata.objectPath}`, async () => {
    const response = await requestOnce(url, {
      method: "PUT",
      headers: {
        "cache-control": metadata.cacheControl,
        "content-length": String(size),
        "content-type": metadata.contentType,
      },
      bodyFactory: () => createReadStream(filePath),
    });
    ensureSuccess(response, url);
  }, options);
}

async function createMultipartUpload(url, metadata, options) {
  const initiateUrl = new URL(url);
  initiateUrl.search = "uploads";
  const response = await withRetry(`Initialize multipart ${metadata.objectPath}`, async () => {
    const result = await requestOnce(initiateUrl, {
      method: "POST",
      headers: {
        "cache-control": metadata.cacheControl,
        "content-length": "0",
        "content-type": metadata.contentType,
      },
    });
    return ensureSuccess(result, initiateUrl);
  }, options);
  const uploadId = xmlTag(response.body, "UploadId");
  if (!uploadId) {
    throw new Error(`TOS multipart response did not contain UploadId (${initiateUrl})`);
  }
  return uploadId;
}

async function uploadPart(filePath, url, uploadId, part, options) {
  const partUrl = new URL(url);
  partUrl.searchParams.set("partNumber", String(part.partNumber));
  partUrl.searchParams.set("uploadId", uploadId);
  return await withRetry(`Upload ${part.objectPath} part ${part.partNumber}`, async () => {
    const response = await requestOnce(partUrl, {
      method: "PUT",
      headers: {
        "content-length": String(part.length),
        "content-type": "application/octet-stream",
      },
      bodyFactory: () => createReadStream(filePath, { start: part.start, end: part.end }),
    });
    ensureSuccess(response, partUrl);
    const etag = response.headers.etag;
    if (!etag) throw new Error(`TOS part ${part.partNumber} response did not contain ETag`);
    return { etag, partNumber: part.partNumber };
  }, options);
}

async function completeMultipartUpload(url, uploadId, parts, metadata, options) {
  const completeUrl = new URL(url);
  completeUrl.searchParams.set("uploadId", uploadId);
  const body = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<CompleteMultipartUpload>",
    ...parts.map((part) =>
      `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`),
    "</CompleteMultipartUpload>",
  ].join("");
  await withRetry(`Complete multipart ${metadata.objectPath}`, async () => {
    const response = await requestOnce(completeUrl, {
      method: "POST",
      headers: {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/xml",
      },
      body,
    });
    ensureSuccess(response, completeUrl);
  }, options);
}

async function abortMultipartUpload(url, uploadId) {
  const abortUrl = new URL(url);
  abortUrl.searchParams.set("uploadId", uploadId);
  try {
    await requestOnce(abortUrl, { method: "DELETE" });
  } catch {
    // Best effort only; preserve the original multipart error.
  }
}

async function multipartPut(filePath, url, metadata, options, size, uploadId) {
  const parts = [];
  for (let start = 0, partNumber = 1; start < size; start += options.partSize, partNumber += 1) {
    const end = Math.min(start + options.partSize, size) - 1;
    parts.push({
      end,
      length: end - start + 1,
      objectPath: metadata.objectPath,
      partNumber,
      start,
    });
  }

  try {
    const uploaded = await mapLimit(parts, options.partConcurrency, (part) =>
      uploadPart(filePath, url, uploadId, part, options));
    await completeMultipartUpload(url, uploadId, uploaded, metadata, options);
    return uploaded.length;
  } catch (error) {
    await abortMultipartUpload(url, uploadId);
    throw error;
  }
}

export async function uploadFileToTos({
  cacheControl,
  contentType,
  filePath,
  objectPath,
  url,
}, overrides = {}) {
  const defaults = tosUploadOptionsFromEnv();
  const options = { ...defaults, ...overrides };
  const { size } = await stat(filePath);
  const metadata = { cacheControl, contentType, objectPath };

  if (size < options.multipartThreshold || size === 0) {
    await singlePut(filePath, url, metadata, options, size);
    return { mode: "single", parts: 1, size };
  }

  let uploadId;
  try {
    uploadId = await createMultipartUpload(url, metadata, options);
  } catch (error) {
    if (options.multipartRequired) throw error;
    options.log?.(
      `Multipart is unavailable for ${objectPath}; falling back to single PUT: ${error?.message || error}`,
    );
    await singlePut(filePath, url, metadata, options, size);
    return { mode: "single-fallback", parts: 1, size };
  }

  const partCount = await multipartPut(filePath, url, metadata, options, size, uploadId);
  return { mode: "multipart", parts: partCount, size };
}
